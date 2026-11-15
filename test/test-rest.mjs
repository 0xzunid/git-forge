// REST v3 conformance self-test: mirrors sdk/conformance/checks-rest.ts.
// Run: node --experimental-strip-types test/test-rest.mjs
import { startServer, counter, client, prepareRepo, b64, unb64 } from './harness.mjs';

const OWNER = 'octocat';
const t = counter();
const { server, store, baseUrl } = await startServer(OWNER);
const api = client(baseUrl);
const anon = client(baseUrl, null);

try {
  // --- root / meta / protocol -------------------------------------------------
  let r = await api.get('/api/v3/');
  t.check('root 200', r.status === 200, `got ${r.status}`);
  t.check('root x-oauth-scopes', (r.headers.get('x-oauth-scopes') ?? '') !== '');
  t.check('root request-id', (r.headers.get('x-github-request-id') ?? '') !== '');
  t.check('root json content-type', (r.headers.get('content-type') ?? '').includes('application/json'));

  r = await api.get('/api/v3/meta');
  t.check('meta 200 + installed_version', r.status === 200 && typeof r.json?.installed_version === 'string' && r.json.installed_version !== '', JSON.stringify(r.json));

  r = await api.get('/api/v3/user');
  t.check('get user 200 login', r.status === 200 && r.json?.login === OWNER, `${r.status} ${r.text.slice(0, 200)}`);

  r = await api.get('/api/v3/repos/octocat/never-created');
  t.check('missing repo 404 json', r.status === 404 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  r = await anon.get('/api/v3/repos/octocat/never-created');
  t.check('anon 401', r.status === 401 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  r = await api.get('/api/v3/no-such-route');
  t.check('unknown route 404 json + request-id', r.status === 404 && typeof r.json?.message === 'string' && (r.headers.get('x-github-request-id') ?? '') !== '', `${r.status} ${r.text}`);

  r = await api.postRaw('/api/v3/user/repos', '{"name":');
  t.check('malformed body 400', r.status === 400 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  // --- pagination: 30 repos at per_page=10 ----------------------------------
  const names = Array.from({ length: 30 }, (_, i) => `page-repo-${i}`);
  for (const name of names) {
    const c = await api.post('/api/v3/user/repos', { name, private: true, description: 'page' });
    t.check(`create ${name}`, c.status === 201, `${c.status} ${c.text}`);
  }
  {
    const seen = [];
    let next = `${baseUrl}/api/v3/user/repos?per_page=10`;
    let pages = 0;
    while (next !== null && pages < 20) {
      pages += 1;
      const page = await api.get(next.replace(baseUrl, ''));
      if (page.status !== 200) throw new Error(`page ${pages}: ${page.status}`);
      t.check(`page ${pages} <= 10 items`, page.json.length <= 10, `got ${page.json.length}`);
      seen.push(...page.json.map((x) => x.name));
      const link = page.headers.get('link') ?? '';
      const m = /<([^>]*)>; rel="next"/.exec(link);
      next = m ? m[1] : null;
    }
    const missing = names.filter((n) => !seen.includes(n));
    t.check('pagination reaches all 30', missing.length === 0 && new Set(seen).size === seen.length, `missing=${missing.join(',')} seen=${seen.length}`);
    t.check('pagination >= 3 pages', pages >= 3, `pages=${pages}`);
  }

  // --- repo create / patch / delete / foreign --------------------------------
  const repoA = await prepareRepo(api, OWNER, 'repo-a');
  t.check('prepareRepo default branch', repoA.defaultBranch === 'main', repoA.defaultBranch);
  r = await api.get(repoA.path);
  t.check('get repo 200 + fields', r.status === 200 && r.json.name === 'repo-a' && r.json.private === true && r.json.default_branch === 'main', JSON.stringify(r.json).slice(0, 200));

  r = await api.get('/api/v3/repos/stranger/repo-a');
  t.check('foreign owner 404', r.status === 404, `${r.status}`);

  r = await api.patch(repoA.path, { description: 'updated desc' });
  t.check('patch description 200', r.status === 200 && r.json.description === 'updated desc', JSON.stringify(r.json).slice(0, 200));
  r = await api.get(repoA.path);
  t.check('patch persists', r.json.description === 'updated desc');

  const repoDel = await prepareRepo(api, OWNER, 'repo-del');
  r = await api.del(repoDel.path);
  t.check('delete 204', r.status === 204, `${r.status}`);
  r = await api.get(repoDel.path);
  t.check('get after delete 404', r.status === 404);

  // --- contents: create / get / update / stale sha / directory / delete -----
  const repoC = await prepareRepo(api, OWNER, 'repo-contents');
  const filePath = 'docs/readme.md';
  let entry = await api.get(`${repoC.path}/contents/${filePath}`);
  t.check('get contents 200 file', entry.status === 200 && entry.json.encoding === 'base64' && unb64(entry.json.content) === 'hello world\n' && entry.json.size === 12, `${entry.status} ${entry.text.slice(0, 200)}`);
  const firstSha = entry.json.sha;

  const altPath = 'docs/readme-alt.md';
  r = await api.put(`${repoC.path}/contents/${altPath}`, { message: 'add alt', content: b64('alt content\n') });
  t.check('put new file 201', r.status === 201 && r.json.content?.sha && r.json.commit?.sha, `${r.status} ${r.text.slice(0, 200)}`);

  r = await api.put(`${repoC.path}/contents/${filePath}`, { message: 'update', content: b64('v2 content\n'), sha: firstSha });
  t.check('put update 200', r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const v2Sha = r.json.content.sha;
  t.check('update changes blob sha', v2Sha !== firstSha);

  r = await api.put(`${repoC.path}/contents/${filePath}`, { message: 'stale', content: b64('v3\n'), sha: firstSha });
  t.check('stale sha 409', r.status === 409 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  // directory listing
  await api.put(`${repoC.path}/contents/src/one.txt`, { message: 'one', content: b64('one\n') });
  await api.put(`${repoC.path}/contents/src/two.txt`, { message: 'two', content: b64('two\n') });
  await api.put(`${repoC.path}/contents/src/seed.txt`, { message: 'seed', content: b64('seed\n') });
  r = await api.get(`${repoC.path}/contents/src`);
  const listed = Array.isArray(r.json) ? r.json.map((e) => e.name) : [];
  t.check('directory listing', r.status === 200 && ['one.txt', 'two.txt', 'seed.txt'].every((n) => listed.includes(n)), `${r.status} ${JSON.stringify(listed)}`);

  // delete contents
  entry = await api.get(`${repoC.path}/contents/${filePath}`);
  r = await api.del(`${repoC.path}/contents/${filePath}`, { message: 'delete', sha: entry.json.sha });
  t.check('delete contents 200 + commit sha', r.status === 200 && /^[0-9a-f]{40}$/.test(r.json.commit.sha), `${r.status} ${r.text}`);
  r = await api.get(`${repoC.path}/contents/${filePath}`);
  t.check('get after delete 404', r.status === 404);

  // --- git-object visibility: what a clone would see -------------------------
  {
    const repo = store.getRepo(OWNER, 'repo-contents');
    const tip = repo.refs.get('refs/heads/main');
    t.check('ref main exists', typeof tip === 'string' && /^[0-9a-f]{40}$/.test(tip));
    const commit = repo.objects.get(tip);
    t.check('commit object stored', commit?.type === 'commit');
    const treeLine = commit.data.toString('utf8').split('\n')[0];
    const treeSha = treeLine.split(' ')[1];
    const tree = repo.objects.get(treeSha);
    t.check('tree object stored', tree?.type === 'tree');
    // walk: docs/readme-alt.md must be reachable with the committed bytes
    const findBlob = (treeSha2, parts) => {
      const entries = [];
      const data = repo.objects.get(treeSha2).data;
      let off = 0;
      while (off < data.length) {
        const sp = data.indexOf(0x20, off);
        const nul = data.indexOf(0x00, sp);
        entries.push({ mode: data.subarray(off, sp).toString(), name: data.subarray(sp + 1, nul).toString(), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
        off = nul + 21;
      }
      const e = entries.find((x) => x.name === parts[0]);
      if (!e) return null;
      if (parts.length === 1) return repo.objects.get(e.sha);
      return findBlob(e.sha, parts.slice(1));
    };
    const blob = findBlob(treeSha, ['docs', 'readme-alt.md']);
    t.check('blob reachable from tip with committed bytes', blob?.type === 'blob' && blob.data.toString('utf8') === 'alt content\n');
    const deleted = findBlob(treeSha, ['docs', 'readme.md']);
    t.check('deleted file absent from tip tree', deleted === null);
  }

  // --- branches / commits ------------------------------------------------------
  const repoB = await prepareRepo(api, OWNER, 'repo-branches');
  r = await api.post(`${repoB.path}/git/refs`, { ref: 'refs/heads/feature-x', sha: repoB.initialSha });
  t.check('create branch 201', r.status === 201 && r.json.ref === 'refs/heads/feature-x', `${r.status} ${r.text}`);
  r = await api.get(`${repoB.path}/branches`);
  const branchNames = r.json.map((b) => b.name);
  t.check('branches list', r.status === 200 && branchNames.includes('feature-x') && branchNames.includes('main'), JSON.stringify(branchNames));
  const feat = r.json.find((b) => b.name === 'feature-x');
  t.check('branch points at initial sha', feat?.commit?.sha === repoB.initialSha);

  r = await api.put(`${repoB.path}/contents/feature-file.txt`, { message: 'on feature', content: b64('feature\n'), branch: 'feature-x' });
  t.check('commit on branch 201', r.status === 201, `${r.status} ${r.text}`);
  const branchCommit = r.json.commit.sha;
  r = await api.get(`${repoB.path}/commits?sha=feature-x`);
  t.check('commits?sha=branch lists branch commit', r.status === 200 && r.json.some((c) => c.sha === branchCommit) && r.json.find((c) => c.sha === branchCommit)?.commit?.message === 'on feature', `${r.status} ${r.text.slice(0, 300)}`);
  r = await api.get(`${repoB.path}/commits`);
  t.check('commits on default excludes branch commit', r.status === 200 && !r.json.some((c) => c.sha === branchCommit));

  // --- labels / issues ---------------------------------------------------------
  const repoI = await prepareRepo(api, OWNER, 'repo-issues');
  r = await api.post(`${repoI.path}/labels`, { name: 'bug', color: 'ededed' });
  t.check('create label 201', r.status === 201 && r.json.name === 'bug', `${r.status} ${r.text}`);
  r = await api.post(`${repoI.path}/issues`, { title: 'bad label issue', body: 'x', labels: ['no-such-label'] });
  t.check('unknown label 422', r.status === 422 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  const mkIssue = (title) => api.post(`${repoI.path}/issues`, { title, body: 'body of ' + title, labels: ['bug'] });
  const i1 = await mkIssue('first issue');
  const i2 = await mkIssue('second issue');
  const i3 = await mkIssue('third issue');
  t.check('issue create 201 open', i1.status === 201 && i1.json.state === 'open' && i1.json.number === 1, `${i1.status} ${i1.text}`);
  t.check('issue numbers increment', i2.json.number === 2 && i3.json.number === 3, `${i2.json.number} ${i3.json.number}`);
  t.check('issue echoes title/body', i1.json.title === 'first issue' && i1.json.body === 'body of first issue');
  t.check('issue carries label', (i1.json.labels ?? []).some((l) => l.name === 'bug'));

  r = await api.get(`${repoI.path}/issues?state=open&per_page=100`);
  t.check('list open includes all three', r.status === 200 && [1, 2, 3].every((n) => r.json.some((x) => x.number === n)));
  r = await api.patch(`${repoI.path}/issues/2`, { state: 'closed' });
  t.check('patch close 200', r.status === 200 && r.json.state === 'closed', `${r.status} ${r.text}`);
  r = await api.get(`${repoI.path}/issues/2`);
  t.check('close persists', r.json.state === 'closed');
  r = await api.get(`${repoI.path}/issues?state=open&per_page=100`);
  t.check('list open excludes closed', !r.json.some((x) => x.number === 2) && r.json.some((x) => x.number === 1));
  r = await api.get(`${repoI.path}/issues?state=open&sort=created&direction=asc&per_page=100`);
  t.check('sort asc', r.json.map((x) => x.number).join(',') === '1,3', JSON.stringify(r.json.map((x) => x.number)));
  r = await api.get(`${repoI.path}/issues?state=open&sort=created&direction=desc&per_page=100`);
  t.check('sort desc', r.json.map((x) => x.number).join(',') === '3,1', JSON.stringify(r.json.map((x) => x.number)));
  r = await api.get(`${repoI.path}/issues/1`);
  t.check('get one issue', r.status === 200 && r.json.number === 1 && r.json.title === 'first issue');

  r = await api.post(`${repoI.path}/issues/1/comments`, { body: 'a comment' });
  t.check('comment create 201', r.status === 201 && r.json.id >= 1 && r.json.body === 'a comment', `${r.status} ${r.text}`);
  const commentId = r.json.id;
  r = await api.get(`${repoI.path}/issues/1/comments`);
  t.check('comments list', r.status === 200 && r.json.some((c) => c.id === commentId && c.body === 'a comment'));

  // --- pulls: create / files / merge / conflict -------------------------------
  async function preparePull(repoName, id) {
    const repo = await prepareRepo(api, OWNER, repoName);
    const head = `feature-${id}`;
    await api.post(`${repo.path}/git/refs`, { ref: `refs/heads/${head}`, sha: repo.initialSha });
    const c = await api.put(`${repo.path}/contents/change-${id}.txt`, { message: `change ${id}`, content: b64('changed content\n'), branch: head });
    const pull = await api.post(`${repo.path}/pulls`, { title: `PR ${id}`, body: 'pr body', head, base: 'main' });
    return { repo, head, number: pull.json.number, headSha: c.json.commit.sha, pull };
  }
  const fx = await preparePull('repo-pulls', 'one');
  t.check('pull create 201 open', fx.pull.status === 201 && fx.pull.json.state === 'open' && fx.pull.json.head.ref === fx.head && fx.pull.json.base.ref === 'main', `${fx.pull.status} ${fx.pull.text.slice(0, 300)}`);
  t.check('pull head sha is branch tip', fx.pull.json.head.sha === fx.headSha, `${fx.pull.json.head.sha} vs ${fx.headSha}`);
  t.check('pull base sha is initial', fx.pull.json.base.sha === fx.repo.initialSha);
  r = await api.get(`${fx.repo.path}/pulls/${fx.number}`);
  t.check('get pull 200', r.status === 200 && r.json.number === fx.number);
  r = await api.get(`${fx.repo.path}/pulls/999999999`);
  t.check('get unknown pull 404', r.status === 404);
  r = await api.get(`${fx.repo.path}/pulls/${fx.number}/files`);
  const f0 = r.json.find((f) => f.filename === 'change-one.txt');
  t.check('pull files list', r.status === 200 && f0 && ['added', 'modified', 'changed'].includes(f0.status) && f0.additions >= 1 && typeof f0.deletions === 'number' && typeof f0.changes === 'number', JSON.stringify(r.json));

  r = await api.put(`${fx.repo.path}/pulls/${fx.number}/merge`, { merge_method: 'squash' });
  t.check('merge 200', r.status === 200 && r.json.merged === true && /^[0-9a-f]{40}$/.test(r.json.sha) && typeof r.json.message === 'string', `${r.status} ${r.text}`);
  const mergeSha = r.json.sha;
  r = await api.get(`${fx.repo.path}/pulls/${fx.number}`);
  t.check('merged pull closed+merged_at+merge_commit_sha', r.json.state === 'closed' && r.json.merged === true && typeof r.json.merged_at === 'string' && r.json.merged_at !== '' && r.json.merge_commit_sha === mergeSha, JSON.stringify(r.json).slice(0, 300));
  r = await api.get(`${fx.repo.path}/commits?sha=main`);
  t.check('merge commit on default branch', r.json.some((c) => c.sha === mergeSha));
  r = await api.get(`${fx.repo.path}/contents/change-one.txt?ref=main`);
  t.check('squash content on default branch', r.status === 200 && unb64(r.json.content) === 'changed content\n', `${r.status} ${r.text.slice(0, 200)}`);
  r = await api.get(`${fx.repo.path}/pulls?state=all&per_page=100`);
  t.check('pulls state=all lists merged', r.json.some((p) => p.number === fx.number));
  r = await api.get(`${fx.repo.path}/pulls?per_page=100`);
  t.check('pulls default open excludes merged', !r.json.some((p) => p.number === fx.number));
  r = await api.put(`${fx.repo.path}/pulls/999999999/merge`, { merge_method: 'squash' });
  t.check('merge unknown 404', r.status === 404);

  // conflict: two branches change the same file differently
  const repoK = await prepareRepo(api, OWNER, 'repo-conflict');
  await api.post(`${repoK.path}/git/refs`, { ref: 'refs/heads/conf-a', sha: repoK.initialSha });
  await api.post(`${repoK.path}/git/refs`, { ref: 'refs/heads/conf-b', sha: repoK.initialSha });
  const cur = await api.get(`${repoK.path}/contents/docs/readme.md?ref=conf-a`);
  await api.put(`${repoK.path}/contents/docs/readme.md`, { message: 'a', content: b64('version A\n'), branch: 'conf-a', sha: cur.json.sha });
  const curB = await api.get(`${repoK.path}/contents/docs/readme.md?ref=conf-b`);
  await api.put(`${repoK.path}/contents/docs/readme.md`, { message: 'b', content: b64('version B\n'), branch: 'conf-b', sha: curB.json.sha });
  const pa = await api.post(`${repoK.path}/pulls`, { title: 'A', body: '', head: 'conf-a', base: 'main' });
  const pb = await api.post(`${repoK.path}/pulls`, { title: 'B', body: '', head: 'conf-b', base: 'main' });
  r = await api.put(`${repoK.path}/pulls/${pa.json.number}/merge`, { merge_method: 'squash' });
  t.check('first conflict-branch merge 200', r.status === 200, `${r.status} ${r.text}`);
  r = await api.put(`${repoK.path}/pulls/${pb.json.number}/merge`, { merge_method: 'squash' });
  t.check('conflicted merge 405', r.status === 405 && typeof r.json?.message === 'string', `${r.status} ${r.text}`);

  // --- perf smoke: 200 issue creates + 2000 sequential GET issue --------------
  const repoP = await prepareRepo(api, OWNER, 'repo-perf');
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) {
    const c = await api.post(`${repoP.path}/issues`, { title: `perf ${i}`, body: 'x' });
    if (c.status !== 201) throw new Error(`perf create ${i}: ${c.status}`);
  }
  const createMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 2000; i += 1) {
    const g = await api.get(`${repoP.path}/issues/1`);
    if (g.status !== 200) throw new Error(`perf get ${i}: ${g.status}`);
  }
  const readMs = Date.now() - t1;
  console.log(`perf smoke: 200 issue creates in ${createMs} ms; 2000 GET issue in ${readMs} ms`);
  t.check('perf smoke completes', createMs < 30000 && readMs < 30000);
} catch (err) {
  console.log('HARNESS ERROR', err);
  t.check('no harness error', false, String(err?.stack ?? err));
} finally {
  server.close();
}

const fails = t.summary('REST');
process.exit(fails === 0 ? 0 : 1);
