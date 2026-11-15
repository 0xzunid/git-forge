// Test harness for store.ts / git.ts: a minimal HTTP server using handleGit, driven by the
// real `git` CLI as a client (clone, fetch, push, shallow clone, ls-remote, tags, deletes,
// non-fast-forward refusal, mixed push, unknown repo, malformed input, auth).
//
// Run: node --experimental-strip-types test/test-git.mjs
// Exit code 0 when every check passes.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createStore } from '../store.ts';
import {
  handleGit,
  hashObject,
  putObject,
  getObject,
  makeCommit,
  makeTree,
  isAncestor,
  encodePack,
  decodePack,
} from '../git.ts';

const exec = promisify(execFile);

const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const baseEnv = {
  ...process.env,
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  no_proxy: '127.0.0.1,localhost',
  NO_PROXY: '127.0.0.1,localhost',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd, args, { auth = true } = {}) {
  const fullArgs = [
    '-c', 'user.name=Tester',
    '-c', 'user.email=tester@example.com',
    '-c', 'init.defaultBranch=main',
    ...(auth ? ['-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`] : []),
    ...args,
  ];
  try {
    const { stdout, stderr } = await exec('git', fullArgs, { cwd, env: { ...baseEnv, HOME: cwd } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function curlRaw(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', Authorization: `Bearer ${TOKEN}` },
    body,
  });
  return res.status;
}

async function main() {
  const store = createStore('tester');
  store.createRepo('tester', 'demo', 'demo repo');
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
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const remote = `${base}/tester/demo.git`;
  console.log(`server on ${base}`);

  const work = mkdtempSync(join(tmpdir(), 'forge-test-'));

  // ---- unit checks (no HTTP) -------------------------------------------------
  const repo = store.getRepo('tester', 'demo');
  const blobSha = putObject(repo, 'blob', Buffer.from('hello\n', 'utf8'));
  check('hashObject matches git blob id', blobSha === 'ce013625030ba8dba906f756967f9e9ca394464a', blobSha);
  check('getObject round-trips', getObject(repo, blobSha)?.data.toString() === 'hello\n');
  const treeSha = makeTree(repo, [{ mode: '100644', name: 'hello.txt', sha: blobSha }]);
  const c1 = makeCommit(repo, { tree: treeSha, parents: [], message: 'first', author: 'Tester <tester@example.com>' });
  const c2 = makeCommit(repo, { tree: treeSha, parents: [c1], message: 'second', author: 'Tester <tester@example.com>' });
  check('isAncestor self', isAncestor(repo, c1, c1));
  check('isAncestor parent', isAncestor(repo, c1, c2));
  check('isAncestor reverse is false', !isAncestor(repo, c2, c1));
  const pack = encodePack(new Map([[c1, getObject(repo, c1)], [blobSha, getObject(repo, blobSha)]]));
  const decoded = decodePack(pack, repo);
  check('encode/decode pack round-trip', decoded.has(c1) && decoded.has(blobSha));
  let corruptThrows = false;
  try {
    const bad = Buffer.from(pack);
    bad[bad.length - 1] ^= 0xff;
    decodePack(bad, repo);
  } catch {
    corruptThrows = true;
  }
  check('decodePack throws on corrupt trailer', corruptThrows);
  // Note: c1/c2 are unreachable objects in the store now; they do not affect the
  // HTTP tests below, which push their own commits through git.

  // ---- auth ------------------------------------------------------------------
  let r = await git(work, ['ls-remote', remote], { auth: false });
  check('unauthenticated git request is refused', r.code !== 0, `exit=${r.code}`);

  // ---- ls-remote / clone of an empty repo ------------------------------------
  r = await git(work, ['ls-remote', remote]);
  check('ls-remote on empty repo succeeds with no refs', r.code === 0 && r.stdout.trim() === '', r.stdout.trim());
  r = await git(work, ['clone', remote, 'empty-clone']);
  check('clone of empty repo succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');

  // ---- first push via real git (pack with deltas comes later) -----------------
  const src = join(work, 'src');
  await exec('mkdir', ['-p', src]);
  await git(src, ['init']);
  await git(src, ['remote', 'add', 'origin', remote]);
  writeFileSync(join(src, 'hello.txt'), 'hello world\n');
  writeFileSync(join(src, 'big.txt'), 'line of text\n'.repeat(2000));
  await git(src, ['add', '.']);
  await git(src, ['commit', '-m', 'initial commit']);
  r = await git(src, ['push', 'origin', 'main']);
  check('first push succeeds', r.code === 0, (r.stderr.trim().split('\n').pop() ?? ''));

  // ---- clone, verify bytes ----------------------------------------------------
  r = await git(work, ['clone', remote, 'clone1']);
  check('clone after push succeeds', r.code === 0, r.stderr.trim());
  const clonedHello = readFileSync(join(work, 'clone1', 'hello.txt'), 'utf8');
  check('cloned blob bytes match', clonedHello === 'hello world\n', JSON.stringify(clonedHello));
  const log1 = await git(join(work, 'clone1'), ['log', '--oneline']);
  check('clone has 1 commit', log1.stdout.trim().split('\n').length === 1, log1.stdout.trim());

  // ---- second push with a revised big file (git sends deltas) -----------------
  writeFileSync(join(src, 'big.txt'), 'line of text\n'.repeat(1999) + 'changed last line\n');
  writeFileSync(join(src, 'hello.txt'), 'hello world v2\n');
  await git(src, ['add', '.']);
  await git(src, ['commit', '-m', 'second commit']);
  r = await git(src, ['push', 'origin', 'main']);
  check('second push (delta pack) succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  r = await git(join(work, 'clone1'), ['fetch', 'origin']);
  check('incremental fetch succeeds', r.code === 0, r.stderr.trim());
  r = await git(join(work, 'clone1'), ['pull', '--ff-only', 'origin', 'main']);
  check('pull after fetch succeeds', r.code === 0, r.stderr.trim());
  check('fetched blob bytes match', readFileSync(join(work, 'clone1', 'hello.txt'), 'utf8') === 'hello world v2\n');

  // ---- v0 clone + fetch --------------------------------------------------------
  r = await git(work, ['-c', 'protocol.version=0', 'clone', remote, 'clone-v0']);
  check('v0 clone succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  check('v0 clone bytes match', readFileSync(join(work, 'clone-v0', 'hello.txt'), 'utf8') === 'hello world v2\n');

  // ---- shallow clone + deepen --------------------------------------------------
  r = await git(work, ['clone', '--depth', '1', remote, 'shallow1']);
  check('shallow clone succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  const shallowLog = await git(join(work, 'shallow1'), ['log', '--oneline']);
  check('shallow clone has exactly 1 commit', shallowLog.stdout.trim().split('\n').length === 1, shallowLog.stdout.trim());
  r = await git(join(work, 'shallow1'), ['fetch', '--deepen=1', 'origin']);
  check('deepen fetch succeeds', r.code === 0, r.stderr.trim());
  const deepLog = await git(join(work, 'shallow1'), ['log', '--oneline']);
  check('deepened clone has 2 commits', deepLog.stdout.trim().split('\n').length === 2, deepLog.stdout.trim());

  // ---- annotated tag ------------------------------------------------------------
  await git(src, ['tag', '-a', 'v1', '-m', 'release v1']);
  r = await git(src, ['push', 'origin', 'v1']);
  check('annotated tag push succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  r = await git(work, ['ls-remote', remote]);
  check('ls-remote lists tag and peeled tag', r.stdout.includes('refs/tags/v1') && r.stdout.includes('refs/tags/v1^{}'), r.stdout.trim());

  // ---- branch create / delete ----------------------------------------------------
  await git(src, ['branch', 'feature']);
  r = await git(src, ['push', 'origin', 'feature']);
  check('branch create push succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  r = await git(work, ['ls-remote', remote]);
  check('ls-remote lists feature branch', r.stdout.includes('refs/heads/feature'));
  r = await git(src, ['push', 'origin', '--delete', 'feature']);
  check('branch delete push succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  r = await git(work, ['ls-remote', remote]);
  check('feature branch gone after delete', !r.stdout.includes('refs/heads/feature'));

  // ---- non-fast-forward refusal --------------------------------------------------
  const tipBefore = (await git(work, ['ls-remote', remote])).stdout
    .split('\n').find((l) => l.includes('refs/heads/main'))?.split('\t')[0];
  const diverge = join(work, 'diverge');
  await git(work, ['clone', remote, 'diverge']);
  await git(diverge, ['reset', '--hard', 'HEAD~1']);
  writeFileSync(join(diverge, 'hello.txt'), 'divergent history\n');
  await git(diverge, ['add', '.']);
  await git(diverge, ['commit', '-m', 'divergent commit']);
  r = await git(diverge, ['push', 'origin', 'main']);
  check('non-fast-forward push is rejected', r.code !== 0 && /non-fast-forward/i.test(r.stderr), r.stderr.trim().split('\n').pop() ?? '');
  const tipAfter = (await git(work, ['ls-remote', remote])).stdout
    .split('\n').find((l) => l.includes('refs/heads/main'))?.split('\t')[0];
  check('refused push did not move the ref', tipBefore === tipAfter, `${tipBefore} vs ${tipAfter}`);

  // ---- mixed push: one ok ref, one refused ref ----------------------------------
  // `diverge` has a divergent main (refused) and a fresh branch mixed-ok (accepted);
  // one push carries both, so the server must apply one and refuse the other.
  await git(diverge, ['branch', 'mixed-ok']);
  r = await git(diverge, ['push', 'origin', 'main', 'mixed-ok']);
  const mixedOk = r.code !== 0
    && /non-fast-forward/i.test(r.stderr)
    && /mixed-ok/.test(r.stderr);
  check('mixed push reports ng for main and ok for mixed-ok', mixedOk, r.stderr.trim());
  r = await git(work, ['ls-remote', remote]);
  check('mixed push applied the ok ref', r.stdout.includes('refs/heads/mixed-ok'));
  const tipMixed = r.stdout.split('\n').find((l) => l.includes('refs/heads/main'))?.split('\t')[0];
  check('mixed push did not move the refused ref', tipMixed === tipAfter);

  // ---- tag delete -----------------------------------------------------------------
  r = await git(src, ['push', 'origin', '--delete', 'v1']);
  check('tag delete push succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  r = await git(work, ['ls-remote', remote]);
  check('tag gone after delete', !r.stdout.includes('refs/tags/v1'));

  // ---- unknown repo + malformed input, server stays up ----------------------------
  r = await git(work, ['ls-remote', `${base}/tester/nope.git`]);
  check('ls-remote on missing repo fails (404)', r.code !== 0, `exit=${r.code}`);
  const malformedStatus = await curlRaw(`${remote}/git-upload-pack`, Buffer.from('zzzznot-a-pkt-line', 'ascii'));
  check('malformed upload-pack POST answered (not a hang/crash)', malformedStatus === 400, `HTTP ${malformedStatus}`);
  r = await git(work, ['ls-remote', remote]);
  check('server still healthy after malformed input', r.code === 0 && r.stdout.includes('refs/heads/main'));

  // ---- clone still works after all of the above ------------------------------------
  r = await git(work, ['clone', remote, 'clone-final']);
  check('final clone succeeds', r.code === 0, r.stderr.trim().split('\n').pop() ?? '');
  check('final clone bytes match', readFileSync(join(work, 'clone-final', 'hello.txt'), 'utf8') === 'hello world v2\n');

  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
