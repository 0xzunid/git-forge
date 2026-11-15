// Smoke test for the MCP endpoint + server wiring, against the REAL server:
// starts main.ts as a child process (stub MAKEFUN_ENV_URL + MAKEFUN_SHOP_TOKEN),
// then exercises /healthz, /api/v3/, MCP initialize + tools/list + tools/call
// (create_repo / get_repo / create_issue / list_issues / create_pull_request /
// merge_pull_request), and checks a repository and an issue created over MCP
// read back over REST as the same objects. Ends by letting the stub env answer
// done:true, and requires main.ts to exit 0.
//
// Run from the repository root:
//   node test/test-mcp.mjs
// (Node 22+: main.ts runs under --experimental-strip-types, as the trial does.)
import { spawn } from 'node:child_process';
import { startStubEnv } from './stub-env.mjs';

const TOKEN = 'test-token-123';
const OWNER = 'adaiversen';
const REPO_ROOT = new URL('..', import.meta.url).pathname;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
    console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One MCP POST, mimicking the suite client (revision headers + _meta). */
async function mcp(baseUrl, body, { auth = true, raw = undefined } = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
  };
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
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

function rpc(id, method, params = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'smoke-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
        protocolVersion: '2026-07-28',
      },
    },
  };
}

async function callTool(baseUrl, id, name, args) {
  return mcp(baseUrl, rpc(id, 'tools/call', { name, arguments: args }));
}

function toolText(outcome) {
  const blocks = outcome.json?.result?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function toolJson(outcome) {
  const structured = outcome.json?.result?.structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  try {
    return JSON.parse(toolText(outcome));
  } catch {
    return null;
  }
}

async function main() {
  const env = await startStubEnv();

  const child = spawn('node', ['--experimental-strip-types', 'main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: env.url,
      MAKEFUN_SHOP_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  // Wait for the "[entry] listening on port N" line (up to 10 s).
  let port = null;
  for (let i = 0; i < 100 && port === null; i += 1) {
    const match = stdout.match(/listening on port (\d+)/);
    if (match) port = Number(match[1]);
    else await sleep(100);
  }
  check('server binds and prints its port', port !== null, stdout.slice(-300));
  if (port === null) {
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
    child.kill();
    await env.close();
    process.exit(1);
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = (path, init = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
  const apiJson = async (path, init = {}) => {
    const res = await api(path, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  };

  // The stub env saw the register.
  await sleep(200);
  check('main.ts registered its port with the env', env.registered() === port, `registered=${env.registered()}`);

  // --- /healthz (no auth) -------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/healthz`);
    const json = await res.json();
    check('GET /healthz -> 200 {"ok":true}', res.status === 200 && json.ok === true, `status=${res.status}`);
  }

  // --- /api/v3/ root --------------------------------------------------------
  {
    const res = await apiJson('/api/v3/');
    check('GET /api/v3/ -> 200 + X-OAuth-Scopes', res.status === 200 && res.headers.get('x-oauth-scopes') === 'repo, read:org', `status=${res.status} scopes=${res.headers.get('x-oauth-scopes')}`);
    check('GET /api/v3/ carries X-GitHub-Request-Id', (res.headers.get('x-github-request-id') ?? '') !== '');
    const noAuth = await fetch(`${baseUrl}/api/v3/`);
    check('GET /api/v3/ without auth -> 401', noAuth.status === 401, `status=${noAuth.status}`);
  }
  {
    const res = await apiJson('/api/v3/meta');
    check('GET /api/v3/meta -> installed_version', res.status === 200 && typeof res.json?.installed_version === 'string' && res.json.installed_version !== '', `status=${res.status} body=${res.text.slice(0, 120)}`);
    const res404 = await apiJson('/api/v3/no-such-route');
    check('unknown /api/v3 route -> 404 JSON', res404.status === 404 && typeof res404.json?.message === 'string', `status=${res404.status}`);
  }

  // --- MCP: modern discover -------------------------------------------------
  {
    const out = await mcp(baseUrl, rpc('discover-1', 'server/discover'));
    const versions = out.json?.result?.supportedVersions ?? [];
    check('server/discover -> supportedVersions incl. 2026-07-28', out.status === 200 && versions.includes('2026-07-28'), `status=${out.status} body=${out.text.slice(0, 200)}`);
    check('server/discover -> serverInfo name/version', typeof out.json?.result?.serverInfo?.name === 'string' && out.json.result.serverInfo.name !== '' && typeof out.json?.result?.serverInfo?.version === 'string' && out.json.result.serverInfo.version !== '');
    check('server/discover -> capabilities.tools present', typeof out.json?.result?.capabilities?.tools === 'object' && out.json.result.capabilities.tools !== null);
  }

  // --- MCP: legacy initialize + initialized ---------------------------------
  {
    const out = await mcp(baseUrl, { jsonrpc: '2.0', id: 'initialize-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1.0.0' } } });
    check('initialize 2025-11-25 -> echoes the revision', out.status === 200 && out.json?.result?.protocolVersion === '2025-11-25', `body=${out.text.slice(0, 200)}`);
    check('initialize -> capabilities.tools present', typeof out.json?.result?.capabilities?.tools === 'object' && out.json.result.capabilities.tools !== null);
    const notified = await mcp(baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    check('notifications/initialized -> 202, no body', notified.status === 202, `status=${notified.status}`);
  }

  // --- MCP: tools/list (twice, byte-identical) ------------------------------
  let tools = [];
  {
    const first = await mcp(baseUrl, rpc(1, 'tools/list'));
    const second = await mcp(baseUrl, rpc(2, 'tools/list'));
    tools = first.json?.result?.tools ?? [];
    check('tools/list -> at least six tools', tools.length >= 6, `got ${tools.length}`);
    const names = tools.map((t) => t.name);
    for (const required of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
      check(`tools/list offers ${required}`, names.includes(required), `names=${names.join(',')}`);
    }
    check('every tool has a description + object inputSchema', tools.every((t) => typeof t.description === 'string' && t.description !== '' && t.inputSchema?.type === 'object'));
    check('two tools/list calls are byte-identical', JSON.stringify(first.json?.result?.tools) === JSON.stringify(second.json?.result?.tools));
  }

  // --- MCP: create_repo + get_repo, then REST parity -------------------------
  let repoId = null;
  {
    const created = await callTool(baseUrl, 10, 'create_repo', { name: 'mcp-smoke-repo', description: 'smoke', private: true });
    const repo = toolJson(created);
    repoId = repo?.id ?? null;
    check('tools/call create_repo -> full_name adaiversen/mcp-smoke-repo', created.status === 200 && created.json?.result?.isError !== true && repo?.full_name === `${OWNER}/mcp-smoke-repo`, `body=${created.text.slice(0, 300)}`);
    check('create_repo result has a numeric id', typeof repoId === 'number');
    const got = await callTool(baseUrl, 11, 'get_repo', { owner: OWNER, repo: 'mcp-smoke-repo' });
    check('tools/call get_repo -> same id', toolJson(got)?.id === repoId, `body=${got.text.slice(0, 200)}`);
    const rest = await apiJson(`/api/v3/repos/${OWNER}/mcp-smoke-repo`);
    check('repo created over MCP reads back over REST (same id)', rest.status === 200 && rest.json?.id === repoId, `status=${rest.status} restId=${rest.json?.id}`);
    const rest2 = await apiJson(`/api/v3/repos/${OWNER}/mcp-smoke-repo`);
    check('REST repo id stable across reads', rest2.json?.id === repoId);
  }

  // --- MCP: create_issue, then REST parity -----------------------------------
  let issueNumber = null;
  let issueId = null;
  {
    const created = await callTool(baseUrl, 12, 'create_issue', { owner: OWNER, repo: 'mcp-smoke-repo', title: 'smoke issue', body: 'from MCP' });
    const issue = toolJson(created);
    issueNumber = issue?.number ?? null;
    issueId = issue?.id ?? null;
    check('tools/call create_issue -> issue #1', created.json?.result?.isError !== true && issueNumber === 1, `body=${created.text.slice(0, 300)}`);
    const listed = await callTool(baseUrl, 13, 'list_issues', { owner: OWNER, repo: 'mcp-smoke-repo', state: 'open' });
    check('tools/call list_issues -> returns the issue', toolText(listed).includes('smoke issue') && toolText(listed).includes('"number":1'), `body=${listed.text.slice(0, 300)}`);
    const rest = await apiJson(`/api/v3/repos/${OWNER}/mcp-smoke-repo/issues/1`);
    check('issue created over MCP reads back over REST (same id/title)', rest.status === 200 && rest.json?.id === issueId && rest.json?.title === 'smoke issue', `status=${rest.status} body=${rest.text.slice(0, 200)}`);
    const rest2 = await apiJson(`/api/v3/repos/${OWNER}/mcp-smoke-repo/issues/1`);
    check('REST issue id stable across reads', rest2.json?.id === issueId);
  }

  // --- MCP: errors ------------------------------------------------------------
  {
    const unknown = await callTool(baseUrl, 14, 'no_such_tool_xyz', {});
    check('unknown tool -> -32602/-32601, never HTTP 500', unknown.status !== 500 && [-32602, -32601].includes(unknown.json?.error?.code), `status=${unknown.status} body=${unknown.text.slice(0, 200)}`);
    const missing = await callTool(baseUrl, 15, 'create_issue', {});
    check('create_issue with no args -> -32602 or isError', missing.json?.error?.code === -32602 || missing.json?.result?.isError === true, `body=${missing.text.slice(0, 200)}`);
    const bad = await mcp(baseUrl, null, { raw: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"' });
    check('malformed JSON body -> HTTP 400 with -32700', bad.status === 400 && bad.json?.error?.code === -32700, `status=${bad.status} body=${bad.text.slice(0, 200)}`);
    const noAuth = await mcp(baseUrl, rpc(16, 'tools/call', { name: 'create_issue', arguments: { owner: 'no-auth', repo: 'no-auth', title: 'x' } }), { auth: false });
    check('tools/call with no Authorization -> 401', noAuth.status === 401, `status=${noAuth.status}`);
  }

  // --- MCP: concurrent calls keep their ids -----------------------------------
  {
    await callTool(baseUrl, 17, 'create_repo', { name: 'mcp-smoke-repo-b' });
    const [left, right] = await Promise.all([
      callTool(baseUrl, 'concurrent-left', 'get_repo', { owner: OWNER, repo: 'mcp-smoke-repo' }),
      callTool(baseUrl, 'concurrent-right', 'get_repo', { owner: OWNER, repo: 'mcp-smoke-repo-b' }),
    ]);
    check('concurrent calls keep their own ids', left.json?.id === 'concurrent-left' && right.json?.id === 'concurrent-right', `left=${left.json?.id} right=${right.json?.id}`);
    check('concurrent calls answer their own repos', toolText(left).includes('mcp-smoke-repo') && toolText(right).includes('mcp-smoke-repo-b'));
  }

  // --- MCP: pull request create + merge, REST reads merged:true ---------------
  {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const created = await apiJson('/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'mcp-smoke-pr', private: true }) });
    check('REST setup: create repo for PR flow', created.status === 201, `status=${created.status} ${created.text.slice(0, 200)}`);
    const basePath = `/api/v3/repos/${OWNER}/mcp-smoke-pr`;
    const putBase = await apiJson(`${basePath}/contents/base.txt`, { method: 'PUT', body: JSON.stringify({ message: 'base commit', content: b64('base\n') }) });
    check('REST setup: base commit', putBase.status === 201, `status=${putBase.status} ${putBase.text.slice(0, 200)}`);
    const baseSha = putBase.json?.commit?.sha ?? null;
    const headName = 'mcp-head-smoke';
    let headReady = false;
    if (baseSha) {
      const ref = await apiJson(`${basePath}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${headName}`, sha: baseSha }) });
      headReady = ref.status >= 200 && ref.status < 300;
    }
    if (!headReady) {
      const putHead = await apiJson(`${basePath}/contents/head.txt`, { method: 'PUT', body: JSON.stringify({ message: 'head commit', content: b64('head\n'), branch: headName }) });
      headReady = putHead.status === 201 || putHead.status === 200;
    }
    check('REST setup: head branch exists', headReady);
    if (headReady) {
      const putHead = await apiJson(`${basePath}/contents/head.txt`, { method: 'PUT', body: JSON.stringify({ message: 'head commit', content: b64('head\n'), branch: headName }) });
      check('REST setup: head commit', putHead.status === 201 || putHead.status === 200, `status=${putHead.status} ${putHead.text.slice(0, 200)}`);
    }
    const opened = await callTool(baseUrl, 18, 'create_pull_request', { owner: OWNER, repo: 'mcp-smoke-pr', title: 'smoke pr', head: headName, base: 'main' });
    const pr = toolJson(opened);
    check('tools/call create_pull_request -> number 1', opened.json?.result?.isError !== true && pr?.number === 1, `body=${opened.text.slice(0, 300)}`);
    const read = await apiJson(`${basePath}/pulls/1`);
    const headRef = typeof read.json?.head === 'string' ? read.json.head : read.json?.head?.ref;
    const baseRef = typeof read.json?.base === 'string' ? read.json.base : read.json?.base?.ref;
    check('REST reads the PR with the same head/base', read.status === 200 && headRef === headName && baseRef === 'main', `status=${read.status} head=${headRef} base=${baseRef}`);
    const merged = await callTool(baseUrl, 19, 'merge_pull_request', { owner: OWNER, repo: 'mcp-smoke-pr', pull_number: 1 });
    check('tools/call merge_pull_request -> merged', merged.json?.result?.isError !== true && toolJson(merged)?.merged === true, `body=${merged.text.slice(0, 300)}`);
    const after = await apiJson(`${basePath}/pulls/1`);
    check('REST reads merged:true after MCP merge', after.status === 200 && after.json?.merged === true, `status=${after.status} merged=${after.json?.merged} state=${after.json?.state}`);
  }

  // --- shutdown: env says done, main.ts must exit 0 ---------------------------
  env.setDone(true);
  const code = await Promise.race([
    exited,
    sleep(10_000).then(() => 'timeout'),
  ]);
  check('main.ts exits 0 after done:true', code === 0, `exit=${code} stderr=${stderr.slice(-500)}`);
  if (code !== 0 && code !== 'timeout') {
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
  }
  if (code === 'timeout') child.kill();

  await env.close();
  console.log(`test-mcp: ${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test-mcp crashed:', err);
  process.exit(1);
});
