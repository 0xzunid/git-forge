// Shared test harness: stub Store (fixed interface from the task) + an HTTP
// server wiring handleRest / handleGraphql. Run with:
//   node --experimental-strip-types test/test-rest.mjs
//   node --experimental-strip-types test/test-graphql.mjs
import { createServer } from 'node:http';
import { handleRest } from '../rest.ts';
import { handleGraphql } from '../graphql.ts';

export const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

/** Minimal in-memory Store implementing the fixed interface. */
export function makeStore(login) {
  const repos = new Map();
  let nextId = 1;
  return {
    login,
    repos,
    nextGlobalId: 1,
    getRepo(owner, name) {
      return repos.get(`${owner}/${name}`);
    },
    createRepo(owner, name, description = '') {
      const now = new Date().toISOString();
      const repo = {
        id: nextId,
        name,
        full_name: `${owner}/${name}`,
        owner: { login: owner },
        description: description ?? '',
        private: false,
        default_branch: 'main',
        created_at: now,
        updated_at: now,
        refs: new Map(),
        objects: new Map(),
        issues: [],
        pulls: [],
        labels: [],
        nextIssue: 1,
        nextPull: 1,
      };
      nextId += 1;
      repos.set(`${owner}/${name}`, repo);
      return repo;
    },
    deleteRepo(owner, name) {
      repos.delete(`${owner}/${name}`);
    },
    allocId() {
      const id = nextId;
      nextId += 1;
      return id;
    },
  };
}

/** Start the test server; resolves {server, baseUrl, store}. */
export async function startServer(login = 'octocat') {
  const store = makeStore(login);
  const server = createServer(async (req, res) => {
    try {
      if (await handleRest(req, res, store)) return;
      if (await handleGraphql(req, res, store)) return;
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': 'req-test-404' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: String(err?.message ?? err) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, store, baseUrl: `http://127.0.0.1:${port}` };
}

/** Tiny assertion counter. */
export function counter() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    check(name, cond, detail = '') {
      if (cond) {
        pass += 1;
      } else {
        fail += 1;
        failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
        console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
      }
    },
    summary(label) {
      console.log(`${label}: ${pass} passed, ${fail} failed`);
      if (failures.length > 0) {
        console.log('failures:');
        for (const f of failures) console.log(`  - ${f}`);
      }
      return fail;
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s.replace(/\s/g, ''), 'base64').toString('utf8');

/** fetch client bound to a base URL, with the bearer token unless told otherwise. */
export function client(baseUrl, token = TOKEN) {
  const headers = { 'content-type': 'application/json', accept: 'application/vnd.github+json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  async function call(method, path, body, raw) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    postRaw: (p, raw) => call('POST', p, undefined, raw),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
}

/** Create a repo + first contents commit; returns {name, path, defaultBranch, initialSha}. */
export async function prepareRepo(api, owner, name, filePath = 'docs/readme.md', content = 'hello world\n') {
  const created = await api.post('/api/v3/user/repos', { name, private: true, description: 'test repo' });
  if (created.status !== 201) throw new Error(`create repo ${name}: ${created.status} ${created.text}`);
  const path = `/api/v3/repos/${owner}/${name}`;
  const put = await api.put(`${path}/contents/${filePath}`, { message: 'seeded commit', content: b64(content) });
  if (put.status !== 201) throw new Error(`put contents ${name}: ${put.status} ${put.text}`);
  const got = await api.get(path);
  return { name, path, defaultBranch: got.json.default_branch, initialSha: put.json.commit.sha };
}

export { b64, unb64 };
