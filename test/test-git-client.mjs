// Test harness driving the forge with the kit's own GitClient (the suite's client):
// mirrors checks-git.ts — v2 advertisement, ls-refs, clone/fetch/shallow, push reports,
// pack integrity, sideband framing, error survival.
//
// Run: node --experimental-strip-types test/test-git-client.mjs
// Exit code 0 when every check passes.

import { createServer } from 'node:http';
import { createStore } from '../store.ts';
import { handleGit } from '../git.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
} from '/home/hatch/workspace/makefun-2026-11-15/kit-github-core-clone-01/github-core-clone-01-kit/sdk/conformance/git-client.ts';

const TOKEN = 'suite-token-456';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- scenario data (fixed, deterministic) ------------------------------------
const VIEWER = { login: 'tester', name: 'Tester', email: 'tester@example.com' };
const BLOBS = [
  { path: 'README.md', content: '# demo repository\n\nThis is a test.\n' },
  { path: 'src/index.ts', content: "export const hello = 'world';\n" },
  { path: 'src/util.ts', content: 'export function add(a, b) { return a + b; }\n' },
  { path: 'docs/guide.md', content: '# guide\n\nSome documentation here.\n' },
];
const COMMITS = [
  { message: 'initial commit', epochSec: 1700000000 },
  { message: 'add feature', epochSec: 1700001000 },
  { message: 'fix bug', epochSec: 1700002000 },
  { message: 'refactor', epochSec: 1700003000 },
];

class LocalRepo {
  objects = new Map();
  refs = new Map();
  lookup = (oid) => this.objects.get(oid);
  put(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  blob(data) {
    return this.put('blob', Buffer.from(data, 'utf8'));
  }
  treeFromFiles(files) {
    const make = () => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const file of files) {
      const segments = file.path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i++) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i]);
      }
      node.files.set(segments[segments.length - 1], Buffer.from(file.data, 'utf8'));
    }
    const build = (node) => {
      const entries = [];
      for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        entries.push({ mode: '100644', name, oid: this.blob(data) });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }
  commit(files, meta, parents = []) {
    const tree = this.treeFromFiles(files);
    return this.put('commit', buildCommit({
      tree, parents,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      author: `${VIEWER.name} <${VIEWER.email}>`,
      committer: `${VIEWER.name} <${VIEWER.email}>`,
      timestamp: meta.timestamp,
    }));
  }
  tag(name, target, meta) {
    return this.put('tag', buildTag({
      object: target, type: 'commit', tag: name,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      tagger: `${VIEWER.name} <${VIEWER.email}>`, timestamp: meta.timestamp,
    }));
  }
  reachable(tips) {
    return collectReachable(tips, this.lookup);
  }
}

function sfile(i, rev = 0) {
  const b = BLOBS[i % BLOBS.length];
  return { path: b.path, data: rev === 0 ? b.content : `${b.content}\n# revision ${rev}\n` };
}
function sizedFile(i, rev, size) {
  const b = BLOBS[i % BLOBS.length];
  const unit = `${b.content}\n`;
  let body = '';
  while (Buffer.byteLength(body) < size) body += unit;
  body = Buffer.from(body, 'utf8').subarray(0, size).toString('utf8');
  return { path: b.path, data: `${body}\n# revision ${rev}\n` };
}
function meta(i, rev = 0) {
  const c = COMMITS[i % COMMITS.length];
  return { message: rev === 0 ? c.message : `${c.message}\n\nrevision ${rev}`, timestamp: c.epochSec + rev };
}
const short = (oids, max = 3) => {
  if (!oids.length) return '';
  const head = oids.slice(0, max).map((o) => o.slice(0, 8)).join(',');
  return oids.length > max ? `${head},…(${oids.length})` : head;
};

async function main() {
  const store = createStore(VIEWER.login);
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
  const owner = VIEWER.login;

  const newClient = (gitProtocol) => new GitClient({
    baseUrl, token: TOKEN, timeoutMs: 8000, gitProtocol,
  });

  async function harness(slug) {
    const client = newClient('auto');
    const repo = `gitconf-${slug}`;
    store.createRepo(owner, repo, `git conformance for ${owner}/${repo}`);
    return { client, owner, repo, local: new LocalRepo() };
  }
  const reportFor = (result, ref) => result.report?.refs.find((e) => e.ref === ref);
  const pushFailure = (result) => {
    if (!result.report) return 'no report-status';
    if (!result.report.unpackOk) return `unpack failed: ${result.report.unpackDetail}`;
    const bad = result.report.refs.filter((e) => !e.ok);
    if (bad.length) return bad.map((e) => `${e.ref}: ${e.reason}`).join('; ');
    return `report: ${JSON.stringify(result.report.refs)}`;
  };

  async function pushRefs(h, commands, options = {}) {
    let objects = options.objects;
    if (objects === undefined && options.pack === undefined) {
      const ad = await h.client.advertisement(h.owner, h.repo, 'git-receive-pack');
      if (ad.protocol !== 0) throw new Error('receive-pack answered non-v0');
      const onServer = new Set();
      for (const ref of ad.refs) {
        if (!ref.oid || ref.oid === ZERO_OID) continue;
        for (const oid of collectReachable([ref.oid], h.local.lookup)) onServer.add(oid);
      }
      const send = [];
      const newTips = commands.filter((c) => c.newOid !== ZERO_OID).map((c) => c.newOid);
      for (const oid of collectReachable(newTips, h.local.lookup)) {
        if (onServer.has(oid)) continue;
        const object = h.local.objects.get(oid);
        if (object) send.push(object);
      }
      objects = send;
    }
    const result = await h.client.push(h.owner, h.repo, commands, { objects, pack: options.pack });
    if (result.report) {
      for (const rep of result.report.refs) {
        if (!rep.ok) continue;
        const cmd = commands.find((c) => c.ref === rep.ref);
        if (!cmd) continue;
        if (cmd.newOid === ZERO_OID) h.local.refs.delete(rep.ref);
        else h.local.refs.set(rep.ref, cmd.newOid);
      }
    }
    return result;
  }

  async function repoWithInitialCommit(slug, files) {
    const h = await harness(slug);
    const tip = h.local.commit(files ?? [sfile(0, 0)], meta(0, 0));
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
    if (reportFor(pushed, 'refs/heads/main')?.ok !== true) {
      throw new Error(`setup push failed: ${pushFailure(pushed)}`);
    }
    h.local.refs.set('refs/heads/main', tip);
    return { h, tip };
  }

  // ---- advertise-v2 ------------------------------------------------------------
  {
    const { h } = await repoWithInitialCommit('advertise-v2');
    const ad = await h.client.advertisement(h.owner, h.repo, 'git-upload-pack');
    const caps = [...ad.capabilities.keys()].sort();
    const missing = ['fetch', 'ls-refs'].filter((n) => !ad.capabilities.has(n));
    check('advertise-v2', ad.protocol === 2 && !missing.length, `protocol v${ad.protocol}; caps: ${caps.join(', ')}`);
  }

  // ---- advertise-receive-pack ---------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('advertise-receive-pack');
    const ad = await h.client.advertisement(h.owner, h.repo, 'git-receive-pack');
    const main = ad.refs.find((r) => r.name === 'refs/heads/main');
    const required = ['report-status', 'side-band-64k', 'delete-refs'];
    const missing = required.filter((n) => !ad.capabilities.has(n));
    check('advertise-receive-pack', ad.protocol === 0 && main?.oid === tip && !missing.length,
      `main=${short([main?.oid ?? 'none'])} missing=${missing.join(',')}`);
  }

  // ---- advertise-headers ---------------------------------------------------------
  {
    const { h } = await repoWithInitialCommit('advertise-headers');
    const v0Client = newClient(0);
    const v0 = await v0Client.infoRefs(h.owner, h.repo, 'git-upload-pack');
    const v2 = await h.client.infoRefs(h.owner, h.repo, 'git-upload-pack');
    const recv = await h.client.infoRefs(h.owner, h.repo, 'git-receive-pack');
    const firstLine = (raw) => {
      const p = raw.packets.find((c) => c.kind === 'data');
      return p && p.kind === 'data' ? p.payload.toString('utf8').replace(/\n$/, '') : '';
    };
    const ok = v0.status === 200 && v0.contentType?.includes('application/x-git-upload-pack-advertisement')
      && v2.status === 200 && v2.contentType?.includes('application/x-git-upload-pack-advertisement')
      && recv.status === 200 && recv.contentType?.includes('application/x-git-receive-pack-advertisement')
      && (firstLine(v0) === '# service=git-upload-pack' || firstLine(v0) === 'version 2')
      && firstLine(recv) === '# service=git-receive-pack'
      && firstLine(v2) === 'version 2';
    check('advertise-headers', ok, `v0=${firstLine(v0)} v2=${firstLine(v2)} recv=${firstLine(recv)}`);
  }

  // ---- unknown-repo-404 ------------------------------------------------------------
  {
    const { h } = await repoWithInitialCommit('unknown-repo');
    const up = await h.client.infoRefs(h.owner, `${h.repo}-missing`, 'git-upload-pack');
    const rc = await h.client.infoRefs(h.owner, `${h.repo}-missing`, 'git-receive-pack');
    const healthy = await h.client.infoRefs(h.owner, h.repo, 'git-upload-pack');
    check('unknown-repo-404', up.status === 404 && rc.status === 404 && healthy.status === 200,
      `up=${up.status} recv=${rc.status} healthy=${healthy.status}`);
  }

  // ---- ls-refs ----------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('ls-refs');
    const second = h.local.commit([sfile(1, 1)], meta(1, 0), [tip]);
    const tag = h.local.tag('v1', second, meta(2, 0));
    const pushed = await pushRefs(h, [
      { oldOid: tip, newOid: second, ref: 'refs/heads/main' },
      { oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' },
    ]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok && reportFor(pushed, 'refs/tags/v1')?.ok;
    let detail = '';
    if (ok) {
      const listed = await h.client.lsRefs(h.owner, h.repo, { symrefs: true, peel: true });
      const main = listed.refs.find((r) => r.name === 'refs/heads/main');
      const head = listed.refs.find((r) => r.name === 'HEAD');
      const tagRef = listed.refs.find((r) => r.name === 'refs/tags/v1');
      ok = listed.protocol === 2 && main?.oid === second && head?.symrefTarget === 'refs/heads/main'
        && tagRef?.oid === tag && tagRef?.peeled === second;
      detail = `main=${short([main?.oid ?? ''])} head=${head?.symrefTarget} tagPeeled=${short([tagRef?.peeled ?? ''])}`;
    } else detail = pushFailure(pushed);
    check('ls-refs', !!ok, detail);
  }

  // ---- ls-refs-prefix ----------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('ls-refs-prefix');
    const tag = h.local.tag('v1', tip, meta(1, 0));
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
    let ok = reportFor(pushed, 'refs/tags/v1')?.ok;
    let detail = '';
    if (ok) {
      const heads = await h.client.lsRefs(h.owner, h.repo, { prefixes: ['refs/heads/'] });
      const tags = await h.client.lsRefs(h.owner, h.repo, { prefixes: ['refs/tags/'] });
      const none = await h.client.lsRefs(h.owner, h.repo, { prefixes: ['refs/does-not-exist/'] });
      const problems = [];
      if (heads.rawRefs.some((r) => !r.name.startsWith('refs/heads/'))) problems.push('heads prefix leaked');
      if (!heads.refs.some((r) => r.name === 'refs/heads/main' && r.oid === tip)) problems.push('main missing');
      if (tags.rawRefs.some((r) => !r.name.startsWith('refs/tags/'))) problems.push('tags prefix leaked');
      if (!tags.refs.some((r) => r.name === 'refs/tags/v1' && r.oid === tag)) problems.push('tag missing');
      if (none.rawRefs.length !== 0) problems.push(`unmatched returned ${none.rawRefs.length}`);
      ok = !problems.length;
      detail = problems.join('; ') || `heads=${heads.refs.length} tags=${tags.refs.length} none=0`;
    } else detail = pushFailure(pushed);
    check('ls-refs-prefix', !!ok, detail);
  }

  // ---- clone-empty ---------------------------------------------------------------------
  {
    const h = await harness('clone-empty');
    const ad = await h.client.advertisement(h.owner, h.repo, 'git-upload-pack');
    const refs = ad.protocol === 2
      ? (await h.client.lsRefs(h.owner, h.repo)).refs
      : ad.refs;
    const realRefs = refs.filter((r) => r.name.startsWith('refs/'));
    const clone = await h.client.clone(h.owner, h.repo);
    check('clone-empty', realRefs.length === 0 && clone.objects.size === 0,
      `refs=${realRefs.length} objects=${clone.objects.size} pack=${clone.packBytes}`);
  }

  // ---- push-first-commit ------------------------------------------------------------------
  {
    const h = await harness('push-first-commit');
    const tip = h.local.commit([sfile(0, 0)], meta(0, 0));
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
    const after = await h.client.lsRefs(h.owner, h.repo);
    const main = after.refs.find((r) => r.name === 'refs/heads/main');
    const head = after.refs.find((r) => r.name === 'HEAD');
    check('push-first-commit', pushed.report?.unpackOk === true && reportFor(pushed, 'refs/heads/main')?.ok
      && main?.oid === tip && head?.symrefTarget === 'refs/heads/main', pushFailure(pushed));
  }

  // ---- clone-object-hashes / blob-bytes / tree-entries / commit-bytes ---------------------
  {
    const files = [sfile(0, 0), sfile(1, 0)];
    const { h, tip } = await repoWithInitialCommit('clone-object-hashes', files);
    const second = h.local.commit([sfile(0, 1), sfile(1, 0)], meta(1, 1), [tip]);
    const third = h.local.commit([sfile(0, 1), sfile(1, 2), sfile(2, 0)], meta(2, 2), [second]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const clone = await h.client.clone(h.owner, h.repo);
      const bad = [...clone.objects].filter(([oid, o]) => hashObject(o.type, o.data) !== oid);
      const expected = h.local.reachable([third]);
      const absent = [...expected].filter((oid) => !clone.objects.has(oid));
      const diff = [...expected].filter((oid) => {
        const found = clone.objects.get(oid);
        return found && (!found.data.equals(h.local.objects.get(oid).data) || found.type !== h.local.objects.get(oid).type);
      });
      ok = !bad.length && clone.objects.has(third) && !absent.length && !diff.length;
      detail = `objects=${clone.objects.size} deltas=${clone.deltaCount} bad=${bad.length} absent=${absent.length} diff=${diff.length}`;
      // commit bytes
      const cloned = clone.objects.get(third);
      const parsed = parseCommit(cloned.data);
      const meta2 = meta(2, 2);
      const expectedMsg = meta2.message.endsWith('\n') ? meta2.message : `${meta2.message}\n`;
      const commitOk = cloned.data.equals(h.local.objects.get(third).data)
        && parsed.parents.length === 1 && parsed.parents[0] === second
        && parsed.message === expectedMsg
        && parsed.author.includes(`${meta2.timestamp} +0000`)
        && parsed.author.includes(VIEWER.email);
      check('clone-commit-bytes', commitOk, `parents=${parsed.parents.length} msg=${JSON.stringify(parsed.message)}`);
      // tree entries
      const rootTree = parseCommit(clone.objects.get(third).data).tree;
      const root = clone.objects.get(rootTree);
      const names = parseTree(root.data).map((e) => e.name).sort();
      const expectedNames = [...new Set([sfile(0, 1), sfile(1, 0), sfile(2, 0)].map((f) => f.path.split('/')[0]))].sort();
      check('clone-tree-entries', JSON.stringify(names) === JSON.stringify(expectedNames),
        `root=${JSON.stringify(names)} expected=${JSON.stringify(expectedNames)}`);
    } else detail = pushFailure(pushed);
    check('clone-object-hashes', !!ok, detail);
  }

  // ---- clone-annotated-tag ------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('clone-annotated-tag');
    const tag = h.local.tag('v1', tip, meta(1, 0));
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
    let ok = reportFor(pushed, 'refs/tags/v1')?.ok;
    let detail = '';
    if (ok) {
      const clone = await h.client.clone(h.owner, h.repo);
      const cloned = clone.objects.get(tag);
      const parsed = cloned ? parseTag(cloned.data) : null;
      const listed = await h.client.lsRefs(h.owner, h.repo, { peel: true });
      const ref = listed.refs.find((e) => e.name === 'refs/tags/v1');
      ok = !!cloned && cloned.data.equals(h.local.objects.get(tag).data)
        && parsed.object === tip && parsed.type === 'commit' && parsed.tag === 'v1'
        && parsed.tagger.includes(VIEWER.email)
        && ref?.oid === tag && ref?.peeled === tip;
      detail = `parsed=${JSON.stringify(parsed && { object: short([parsed.object]), type: parsed.type, tag: parsed.tag })} peeled=${short([ref?.peeled ?? ''])}`;
    } else detail = pushFailure(pushed);
    check('clone-annotated-tag', !!ok, detail);
  }

  // ---- fetch-incremental ----------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('fetch-incremental', [sfile(0, 0), sfile(1, 0)]);
    const firstClone = await h.client.clone(h.owner, h.repo);
    const second = h.local.commit([sfile(0, 1), sfile(1, 0), sfile(2, 0)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const fetched = await h.client.fetch(h.owner, h.repo, {
        wants: [second], haves: [tip], haveObjects: firstClone.objects,
      });
      const bad = [...fetched.objects].filter(([oid, o]) => hashObject(o.type, o.data) !== oid);
      const old = h.local.reachable([tip]);
      const expectedNew = [...h.local.reachable([second])].filter((oid) => !old.has(oid));
      const missing = expectedNew.filter((oid) => !fetched.objects.has(oid));
      const extraOld = [...fetched.objects.keys()].filter((oid) => old.has(oid));
      ok = fetched.objects.has(second) && !fetched.objects.has(tip) && !bad.length && !missing.length && !extraOld.length;
      detail = `new=${fetched.objects.size} missing=${missing.length} extraOld=${extraOld.length} bad=${bad.length}`;
    } else detail = pushFailure(pushed);
    check('fetch-incremental', !!ok, detail);
  }

  // ---- fetch-nothing-new -------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('fetch-nothing-new');
    const clone = await h.client.clone(h.owner, h.repo);
    const fetched = await h.client.fetch(h.owner, h.repo, {
      wants: [tip], haves: [tip], haveObjects: clone.objects,
    });
    check('fetch-nothing-new', fetched.objects.size === 0, `delivered=${fetched.objects.size} packBytes=${fetched.packBytes}`);
  }

  // ---- fetch-shallow-depth1 -------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('fetch-shallow-depth1', [sfile(0, 0)]);
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const third = h.local.commit([sfile(2, 0)], meta(2, 2), [second]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const shallow = await h.client.clone(h.owner, h.repo, { depth: 1 });
      const commit = parseCommit(shallow.objects.get(third).data);
      const tree = shallow.objects.get(commit.tree);
      const missingBlobs = tree ? parseTree(tree.data).filter((e) => !shallow.objects.has(e.oid)) : [{ oid: 'no-tree' }];
      ok = shallow.objects.has(third) && !shallow.objects.has(second) && !shallow.objects.has(tip)
        && shallow.objects.get(third).data.equals(h.local.objects.get(third).data)
        && !!tree && !missingBlobs.length && shallow.shallow.includes(third);
      detail = `objects=${shallow.objects.size} shallow=${shallow.shallow.map((o) => o.slice(0, 8))}`;
    } else detail = pushFailure(pushed);
    check('fetch-shallow-depth1', !!ok, detail);
  }

  // ---- fetch-shallow-deepen ----------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('fetch-shallow-deepen', [sfile(0, 0)]);
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const third = h.local.commit([sfile(2, 0)], meta(2, 2), [second]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const shallow = await h.client.clone(h.owner, h.repo, { depth: 1 });
      if (!shallow.objects.has(third) || shallow.objects.has(second)) {
        ok = false; detail = 'depth-1 setup wrong';
      } else {
        const deepened = await h.client.fetch(h.owner, h.repo, {
          wants: [third], haves: [third], shallow: shallow.shallow, depth: 2, haveObjects: shallow.objects,
        });
        const parentTree = parseCommit(deepened.objects.get(second)?.data ?? Buffer.alloc(0)).tree;
        ok = deepened.objects.has(second)
          && deepened.objects.get(second).data.equals(h.local.objects.get(second).data)
          && !deepened.objects.has(tip)
          && (deepened.shallow.includes(second) || deepened.unshallow.includes(third))
          && !!deepened.objects.get(parentTree);
        detail = `shallow=${deepened.shallow.map((o) => o.slice(0, 8))} unshallow=${deepened.unshallow.map((o) => o.slice(0, 8))}`;
      }
    } else detail = pushFailure(pushed);
    check('fetch-shallow-deepen', !!ok, detail);
  }

  // ---- fetch-shallow-new-tip --------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('fetch-shallow-new-tip', [sfile(0, 0)]);
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const shallow = await h.client.clone(h.owner, h.repo, { depth: 1 });
      const third = h.local.commit([sfile(2, 0)], meta(2, 2), [second]);
      const pushedTip = await pushRefs(h, [{ oldOid: second, newOid: third, ref: 'refs/heads/main' }]);
      if (!reportFor(pushedTip, 'refs/heads/main')?.ok) {
        ok = false; detail = `tip push failed: ${pushFailure(pushedTip)}`;
      } else {
        const fetched = await h.client.fetch(h.owner, h.repo, {
          wants: [third], haves: [second], shallow: shallow.shallow, depth: 1, haveObjects: shallow.objects,
        });
        ok = fetched.objects.has(third) && !fetched.objects.has(tip) && !fetched.objects.has(second);
        detail = `objects=${fetched.objects.size}`;
      }
    } else detail = pushFailure(pushed);
    check('fetch-shallow-new-tip', !!ok, detail);
  }

  // ---- push-update-ref / create-branch / delete-branch --------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('push-update-ref');
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    const listed = await h.client.lsRefs(h.owner, h.repo);
    const clone = await h.client.clone(h.owner, h.repo);
    check('push-update-ref', pushed.report?.unpackOk === true && reportFor(pushed, 'refs/heads/main')?.ok
      && listed.refs.find((r) => r.name === 'refs/heads/main')?.oid === second && clone.objects.has(second),
      pushFailure(pushed));
  }
  {
    const { h, tip } = await repoWithInitialCommit('push-create-branch');
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/feature' }]);
    const listed = await h.client.lsRefs(h.owner, h.repo);
    const clone = await h.client.clone(h.owner, h.repo);
    check('push-create-branch', reportFor(pushed, 'refs/heads/feature')?.ok
      && listed.refs.find((r) => r.name === 'refs/heads/feature')?.oid === tip
      && clone.refs.some((r) => r.name === 'refs/heads/feature' && r.oid === tip), pushFailure(pushed));
  }
  {
    const { h, tip } = await repoWithInitialCommit('push-delete-branch');
    const created = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/feature' }]);
    let ok = reportFor(created, 'refs/heads/feature')?.ok;
    let detail = '';
    if (ok) {
      const deleted = await pushRefs(h, [{ oldOid: tip, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
      const listed = await h.client.lsRefs(h.owner, h.repo);
      const clone = await h.client.clone(h.owner, h.repo);
      ok = deleted.report?.unpackOk === true && reportFor(deleted, 'refs/heads/feature')?.ok
        && !listed.refs.some((r) => r.name === 'refs/heads/feature')
        && listed.refs.find((r) => r.name === 'refs/heads/main')?.oid === tip && clone.objects.has(tip);
      detail = pushFailure(deleted);
    } else detail = pushFailure(created);
    check('push-delete-branch', !!ok, detail);
  }

  // ---- push-non-fast-forward -------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('push-non-fast-forward');
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const sibling = h.local.commit([sfile(2, 0)], meta(2, 2), [tip]);
      const refused = await h.client.push(h.owner, h.repo,
        [{ oldOid: second, newOid: sibling, ref: 'refs/heads/main' }],
        { objects: [...h.local.reachable([sibling])].map((oid) => h.local.objects.get(oid)), });
      const report = reportFor(refused, 'refs/heads/main');
      const listed = await h.client.lsRefs(h.owner, h.repo);
      const healthy = await h.client.infoRefs(h.owner, h.repo, 'git-upload-pack');
      const clone = await h.client.clone(h.owner, h.repo);
      ok = refused.report?.unpackOk === true && !!report && !report.ok && report.reason === 'non-fast-forward'
        && listed.refs.find((r) => r.name === 'refs/heads/main')?.oid === second
        && healthy.status === 200 && clone.objects.has(second);
      detail = `report=${JSON.stringify(refused.report?.refs)}`;
    } else detail = pushFailure(pushed);
    check('push-non-fast-forward', !!ok, detail);
  }

  // ---- push-mixed-report ----------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('push-mixed-report');
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const setup = await pushRefs(h, [
      { oldOid: tip, newOid: second, ref: 'refs/heads/main' },
      { oldOid: ZERO_OID, newOid: second, ref: 'refs/heads/side' },
    ]);
    let ok = reportFor(setup, 'refs/heads/main')?.ok && reportFor(setup, 'refs/heads/side')?.ok;
    let detail = '';
    if (ok) {
      const forward = h.local.commit([sfile(2, 0)], meta(2, 2), [second]);
      const sibling = h.local.commit([sfile(3, 0)], meta(3, 3), [tip]);
      const objects = [...new Set([...h.local.reachable([forward]), ...h.local.reachable([sibling])])]
        .map((oid) => h.local.objects.get(oid));
      const mixed = await h.client.push(h.owner, h.repo, [
        { oldOid: second, newOid: forward, ref: 'refs/heads/main' },
        { oldOid: second, newOid: sibling, ref: 'refs/heads/side' },
      ], { objects });
      const mainReport = reportFor(mixed, 'refs/heads/main');
      const sideReport = reportFor(mixed, 'refs/heads/side');
      const listed = await h.client.lsRefs(h.owner, h.repo);
      ok = mixed.report?.unpackOk === true && !!mainReport?.ok && !!sideReport && !sideReport.ok
        && sideReport.reason === 'non-fast-forward' && mixed.report.refs.length === 2
        && listed.refs.find((r) => r.name === 'refs/heads/main')?.oid === forward
        && listed.refs.find((r) => r.name === 'refs/heads/side')?.oid === second;
      detail = `refs=${JSON.stringify(mixed.report?.refs)}`;
    } else detail = pushFailure(setup);
    check('push-mixed-report', !!ok, detail);
  }

  // ---- push-delete-tag ----------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('push-delete-tag');
    const tag = h.local.tag('v1', tip, meta(1, 0));
    const created = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
    let ok = reportFor(created, 'refs/tags/v1')?.ok;
    let detail = '';
    if (ok) {
      const deleted = await pushRefs(h, [{ oldOid: tag, newOid: ZERO_OID, ref: 'refs/tags/v1' }]);
      const listed = await h.client.lsRefs(h.owner, h.repo);
      ok = deleted.report?.unpackOk === true && reportFor(deleted, 'refs/tags/v1')?.ok
        && !listed.refs.some((r) => r.name === 'refs/tags/v1');
      detail = pushFailure(deleted);
    } else detail = pushFailure(created);
    check('push-delete-tag', !!ok, detail);
  }

  // ---- push-100-files --------------------------------------------------------------------------------------------------------
  {
    const h = await harness('push-100-files');
    const files = [];
    for (let i = 0; i < 100; i++) {
      const base = BLOBS[i % BLOBS.length].path;
      const round = Math.floor(i / BLOBS.length);
      const path = round === 0 ? base : base.replace(/(\.[^./]+)?$/, `.${round}$1`);
      files.push({ path, data: `${BLOBS[i % BLOBS.length].content}\nfile ${i} revision 1\n` });
    }
    const tip = h.local.commit(files, meta(0, 1));
    const pushed = await pushRefs(h, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
    let ok = pushed.report?.unpackOk === true && reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const clone = await h.client.clone(h.owner, h.repo);
      const expected = h.local.reachable([tip]);
      const missing = [...expected].filter((oid) => !clone.objects.has(oid));
      const different = [...expected].filter((oid) => {
        const f = clone.objects.get(oid);
        return f && (!f.data.equals(h.local.objects.get(oid).data) || f.type !== h.local.objects.get(oid).type);
      });
      let checked = 0;
      let pathOk = !missing.length && !different.length;
      if (pathOk) {
        const commit = parseCommit(clone.objects.get(tip).data);
        for (const file of files) {
          let oid = commit.tree;
          let found = true;
          for (const segment of file.path.split('/')) {
            const treeObject = clone.objects.get(oid);
            if (!treeObject) { found = false; break; }
            const entry = parseTree(treeObject.data).find((c) => c.name === segment);
            if (!entry) { found = false; break; }
            oid = entry.oid;
          }
          if (!found) { pathOk = false; detail = `missing path ${file.path}`; break; }
          const blob = clone.objects.get(oid);
          if (!blob || blob.type !== 'blob' || !blob.data.equals(Buffer.from(file.data, 'utf8'))) {
            pathOk = false; detail = `bytes differ for ${file.path}`; break;
          }
          checked += 1;
        }
      }
      ok = pathOk;
      detail = detail || `${checked} files byte-identical; ${expected.size} objects`;
    } else detail = pushFailure(pushed);
    check('push-100-files', !!ok, detail);
  }

  // ---- pack-integrity -----------------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('pack-integrity', [sizedFile(0, 0, 2048)]);
    const second = h.local.commit([sizedFile(0, 1, 2048)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const fetched = await h.client.fetch(h.owner, h.repo, { wants: [second], parse: false });
      if (!fetched.pack) {
        ok = false; detail = 'no pack';
      } else {
        const checksum = verifyPackChecksum(fetched.pack);
        const parsed = readPack(fetched.pack);
        const bad = [...parsed.objects].filter(([oid, o]) => hashObject(o.type, o.data) !== oid);
        ok = checksum.ok && parsed.declaredCount === parsed.entries.length
          && parsed.objects.size === parsed.declaredCount
          && (parsed.version === 2 || parsed.version === 3) && !bad.length;
        detail = `${fetched.packBytes} bytes v${parsed.version} ${parsed.declaredCount} objects ${parsed.deltaCount} deltas`;
      }
    } else detail = pushFailure(pushed);
    check('pack-integrity', !!ok, detail);
  }

  // ---- pack-deltas ----------------------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('pack-deltas', [sizedFile(0, 0, 20000)]);
    let parent = tip;
    let ok = true;
    let detail = '';
    for (let rev = 1; rev <= 3; rev++) {
      const child = h.local.commit([sizedFile(0, rev, 20000)], meta(rev, rev), [parent]);
      const pushed = await pushRefs(h, [{ oldOid: parent, newOid: child, ref: 'refs/heads/main' }]);
      if (reportFor(pushed, 'refs/heads/main')?.ok !== true) {
        ok = false; detail = `setup push ${rev} failed: ${pushFailure(pushed)}`; break;
      }
      parent = child;
    }
    if (ok) {
      const clone = await h.client.clone(h.owner, h.repo);
      const bad = [...clone.objects].filter(([oid, o]) => hashObject(o.type, o.data) !== oid);
      const expected = h.local.reachable([parent]);
      const different = [...expected].filter((oid) => {
        const f = clone.objects.get(oid);
        return f && (!f.data.equals(h.local.objects.get(oid).data) || f.type !== h.local.objects.get(oid).type);
      });
      ok = clone.objects.has(parent) && !bad.length && !different.length;
      detail = `${clone.objects.size} objects, ${clone.deltaCount} deltas, ${clone.packBytes} bytes`;
    }
    check('pack-deltas', !!ok, detail);
  }

  // ---- sideband-framing --------------------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('sideband-framing', [sizedFile(0, 0, 4096)]);
    const second = h.local.commit([sizedFile(0, 1, 4096)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = reportFor(pushed, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const packets = [];
      await h.client.fetch(h.owner, h.repo, {
        wants: [second], parse: false, observe: (packet) => packets.push(packet),
      });
      const packChunks = [];
      let sidebandPackets = 0;
      let section = '';
      let bad = '';
      for (const packet of packets) {
        if (packet.kind !== 'data') {
          if (packet.kind === 'flush' || packet.kind === 'delim') section = '';
          continue;
        }
        if (packet.raw.length > 65520) { bad = 'pkt-line too long'; break; }
        const text = packet.payload.toString('utf8');
        if (section === '') {
          if (text === 'packfile\n') { section = 'packfile'; continue; }
          if (text === 'acknowledgments\n' || text === 'shallow-info\n' || text === 'wanted-refs\n') {
            section = 'control'; continue;
          }
          const band = packet.payload[0];
          if (band !== 1 && band !== 2 && band !== 3) continue;
        } else if (section !== 'packfile') continue;
        sidebandPackets += 1;
        if (packet.payload.length < 1) { bad = 'empty sideband packet'; break; }
        const band = packet.payload[0];
        if (band === 1) packChunks.push(packet.payload.subarray(1));
        else if (band === 2) { /* progress */ }
        else if (band === 3) { bad = `sideband error: ${packet.payload.subarray(1).toString('utf8').trim()}`; break; }
        else { bad = `invalid band ${band}`; break; }
      }
      if (!bad) {
        if (sidebandPackets === 0) bad = 'no packfile sideband packets';
        else {
          const pack = Buffer.concat(packChunks);
          if (!pack.length) bad = 'no band-1 data';
          else {
            const parsed = readPack(pack);
            ok = verifyPackChecksum(pack).ok;
            detail = `${sidebandPackets} sideband packets; ${pack.length} band-1 bytes; pack ${parsed.declaredCount} objects`;
          }
        }
      }
      if (bad) { ok = false; detail = bad; }
    } else detail = pushFailure(pushed);
    check('sideband-framing', !!ok, detail);
  }

  // ---- push-sideband-report ----------------------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('push-sideband-report');
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const pushed = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    check('push-sideband-report', pushed.sideband && pushed.report?.unpackOk === true
      && reportFor(pushed, 'refs/heads/main')?.ok, `sideband=${pushed.sideband} ${pushFailure(pushed)}`);
  }

  // ---- repo-survives-errors -------------------------------------------------------------------------------------------------------------------
  {
    const { h, tip } = await repoWithInitialCommit('repo-survives-errors', [sfile(0, 0)]);
    const missing = await h.client.infoRefs(h.owner, `${h.repo}-missing`, 'git-upload-pack');
    const second = h.local.commit([sfile(1, 0)], meta(1, 1), [tip]);
    const setup = await pushRefs(h, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
    let ok = missing.status === 404 && reportFor(setup, 'refs/heads/main')?.ok;
    let detail = '';
    if (ok) {
      const sibling = h.local.commit([sfile(2, 0)], meta(2, 2), [tip]);
      await h.client.push(h.owner, h.repo,
        [{ oldOid: second, newOid: sibling, ref: 'refs/heads/main' }],
        { objects: [...h.local.reachable([sibling])].map((oid) => h.local.objects.get(oid)) });
      let malformedNote = '';
      try {
        const malformed = await h.client.postRaw(h.owner, h.repo, 'git-upload-pack',
          Buffer.from('zzzznot-a-pkt-line', 'ascii'));
        malformedNote = `HTTP ${malformed.status}`;
      } catch (err) {
        malformedNote = err.message;
      }
      const healthy = await h.client.infoRefs(h.owner, h.repo, 'git-upload-pack');
      const listed = await h.client.lsRefs(h.owner, h.repo);
      const mainTip = listed.refs.find((r) => r.name === 'refs/heads/main')?.oid;
      const clone = await h.client.clone(h.owner, h.repo);
      const bad = [...clone.objects].filter(([oid, o]) => hashObject(o.type, o.data) !== oid);
      ok = healthy.status === 200 && !!mainTip && clone.objects.has(mainTip) && !bad.length;
      detail = `malformed=${malformedNote} tip=${short([mainTip ?? ''])}`;
    } else detail = pushFailure(setup);
    check('repo-survives-errors', !!ok, detail);
  }

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
