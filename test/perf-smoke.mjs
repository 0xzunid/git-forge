// Perf smoke test: 200 sequential 1 KiB pushes + 50 concurrent shallow clones of a
// 200-commit repo, driven through the kit's GitClient, timed end to end.
//
// Run: node --experimental-strip-types test/perf-smoke.mjs

import { createServer } from 'node:http';
import { createStore } from '../store.ts';
import { handleGit } from '../git.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
} from '/home/hatch/workspace/makefun-2026-11-15/kit-github-core-clone-01/github-core-clone-01-kit/sdk/conformance/git-client.ts';

const TOKEN = 'perf-token-789';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

const store = createStore('tester');
const server = createServer(async (req, res) => {
  try {
    const handled = await handleGit(req, res, store);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(err) }));
    }
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const client = new GitClient({ baseUrl, token: TOKEN, timeoutMs: 30000 });

const local = { objects: new Map(), lookup: (oid) => local.objects.get(oid) };
function put(type, data) {
  const oid = hashObject(type, data);
  if (!local.objects.has(oid)) local.objects.set(oid, { type, data });
  return oid;
}
function commitFor(content, parents) {
  const blob = put('blob', Buffer.from(content, 'utf8'));
  const tree = put('tree', buildTree([{ mode: '100644', name: 'data.txt', oid: blob }]));
  return put('commit', buildCommit({
    tree, parents, message: 'change\n',
    author: 'Tester <tester@example.com>', committer: 'Tester <tester@example.com>',
    timestamp: 1700000000,
  }));
}

// Seed a 200-commit repo through the push path (thin packs, as the suite does).
store.createRepo('tester', 'perf', 'perf');
let tip = commitFor('x'.repeat(1024), []);
{
  const t0 = Date.now();
  const r = await client.push('tester', 'perf',
    [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }],
    { objects: [...collectReachable([tip], local.lookup)].map((oid) => local.objects.get(oid)) });
  if (!r.report?.refs[0]?.ok) throw new Error('seed push failed');
  console.log(`seed push: ${Date.now() - t0} ms`);
}
// Push commits 1..199 with proper old oids.
{
  let current = tip;
  const t0 = Date.now();
  for (let i = 1; i < 200; i++) {
    const next = commitFor(`${'y'.repeat(1023)}${i}\n`, [current]);
    const ad = await client.advertisement('tester', 'perf', 'git-receive-pack');
    const onServer = new Set();
    for (const ref of ad.refs) {
      if (!ref.oid || ref.oid === ZERO_OID) continue;
      for (const oid of collectReachable([ref.oid], local.lookup)) onServer.add(oid);
    }
    const send = [];
    for (const oid of collectReachable([next], local.lookup)) {
      if (!onServer.has(oid)) send.push(local.objects.get(oid));
    }
    const r = await client.push('tester', 'perf',
      [{ oldOid: current, newOid: next, ref: 'refs/heads/main' }], { objects: send });
    if (!r.report?.refs[0]?.ok) throw new Error(`seed push ${i} failed: ${JSON.stringify(r.report)}`);
    current = next;
  }
  console.log(`seed 199 more commits: ${Date.now() - t0} ms (${((Date.now() - t0) / 199).toFixed(1)} ms/push)`);
  tip = current;
}

// Workload 1: 200 sequential 1 KiB pushes.
{
  const t0 = Date.now();
  let current = tip;
  for (let i = 0; i < 200; i++) {
    const next = commitFor(`${'z'.repeat(1023)}${i}\n`, [current]);
    const ad = await client.advertisement('tester', 'perf', 'git-receive-pack');
    const onServer = new Set();
    for (const ref of ad.refs) {
      if (!ref.oid || ref.oid === ZERO_OID) continue;
      for (const oid of collectReachable([ref.oid], local.lookup)) onServer.add(oid);
    }
    const send = [];
    for (const oid of collectReachable([next], local.lookup)) {
      if (!onServer.has(oid)) send.push(local.objects.get(oid));
    }
    const r = await client.push('tester', 'perf',
      [{ oldOid: current, newOid: next, ref: 'refs/heads/main' }], { objects: send });
    if (!r.report?.refs[0]?.ok) throw new Error(`push ${i} failed`);
    current = next;
  }
  console.log(`200 sequential 1 KiB pushes: ${Date.now() - t0} ms`);
}

// Workload 2: 50 concurrent shallow clones (depth 1) of the 200-commit repo.
{
  const t0 = Date.now();
  const clones = await Promise.all(
    Array.from({ length: 50 }, () => client.clone('tester', 'perf', { depth: 1 })),
  );
  const bad = clones.filter((c) => c.objects.size === 0 || !c.shallow.length);
  console.log(`50 concurrent shallow clones: ${Date.now() - t0} ms (bad=${bad.length}, objects each=${clones[0].objects.size})`);
}

server.close();
console.log('perf smoke done');
