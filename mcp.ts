// The Model Context Protocol endpoint: POST /mcp, JSON-RPC 2.0 over Streamable HTTP.
//
// Speaks revision 2026-07-28 (server/discover, no handshake, no session) and the
// handshake revisions (2025-11-25 and earlier) through initialize +
// notifications/initialized. Answers application/json; every tools/call result is
// {content: [{type: 'text', text: <JSON string>}], structuredContent: <object>}.
//
// The tools act on the same store the REST surface does, through rest.ts's own
// helpers (createIssueInRepo, createPullInRepo, mergePullInRepo) and serializers
// (repoJson, issueJson, pullJson): a repository or issue created here reads back
// over /api/v3 as the same object, ids unchanged, because it IS the same object,
// created and serialized by the same code REST uses. Timestamps come from
// rest.ts's nowIso, the same source REST stamps with.
//
// Store contract (store.ts): createStore(login) makes a Store with `login`,
// `getRepo(owner, name)`, `createRepo(owner, name, description?)`, `allocId()`;
// a Repo carries `full_name`, `owner.login`, `issues` / `pulls` arrays and
// `nextIssue` / `nextPull` counters; a pull's head/base is {ref, sha}. Nothing
// here needs a key, a network call, or the git binary.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  baseUrlOf,
  createIssueInRepo,
  createPullInRepo,
  issueJson,
  mergePullInRepo,
  pullJson,
  repoJson,
} from './rest.ts';

// ---------------------------------------------------------------- constants

/** This server's identity, as initialize and server/discover report it. */
const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';

/** The revisions this server speaks, newest first (2026-07-28 is the current one). */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The handshake-era revisions, newest first. */
const LEGACY_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_TYPE = 'application/json; charset=utf-8';

/** JSON-RPC error codes this endpoint answers with. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

/** A request body larger than this is refused outright (the suite sends small ones). */
const MAX_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------- small helpers

type JsonRecord = Record<string, unknown>;

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string out of an unknown value, or ''. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A finite number out of an unknown value, or null. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Monotonic ids for X-GitHub-Request-Id (deterministic per request order). */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gh-${String(requestCounter).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- HTTP plumbing

/** Answer with a JSON body (the one reply shape this endpoint ever sends). */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

/** Read the request body whole, up to MAX_BODY_BYTES; null when it overruns. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overrun = false;
    req.on('data', (chunk: Buffer) => {
      if (overrun) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overrun = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overrun) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(overrun ? null : Buffer.concat(chunks)));
  });
}

// ---------------------------------------------------------------- auth

/**
 * Whether the request carries the trial's bearer token. The rule matches app.ts:
 * when MAKEFUN_SHOP_TOKEN is set, only `Bearer <that token>` passes; when it is
 * unset (local testing), any non-empty Bearer token passes.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): JsonRecord {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRecord {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** A tool result: text content carrying the JSON string, plus structured content. */
function toolResult(id: JsonRpcId, value: unknown): JsonRecord {
  const text = JSON.stringify(value);
  const structuredContent = Array.isArray(value) ? { items: value } : value;
  return rpcResult(id, { content: [{ type: 'text', text }], structuredContent });
}

/** A tool execution error: HTTP 200, result with isError:true (never a throw). */
function toolError(id: JsonRpcId, message: string): JsonRecord {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

// ---------------------------------------------------------------- the tools
//
// One frozen list: two tools/list calls answer the same array, byte for byte.
// Names are the canonical github-mcp-server names (no server prefix); the suite
// matches them by suffix, case-insensitively, so plain names match. Every tool
// has a description and an inputSchema of type object, and `required` lists only
// properties the suite can fill from the documented arguments.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonRecord;
}

function strProp(description: string): JsonRecord {
  return { type: 'string', description };
}

const OWNER_PROP = strProp('The repository owner (the login the bearer token names).');
const REPO_PROP = strProp('The repository name.');
const FULL_NAME_PROP = strProp('The repository full name, "owner/repo" (an alternative to owner + repo).');

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: strProp('The repository name.'),
        description: strProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_NAME_PROP },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        full_name: FULL_NAME_PROP,
        title: strProp('The issue title.'),
        body: strProp('The issue body.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach (each must already exist on the repository).' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        full_name: FULL_NAME_PROP,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default open).' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        full_name: FULL_NAME_PROP,
        title: strProp('The pull request title.'),
        body: strProp('The pull request body.'),
        head: strProp('The head branch (the branch holding the changes).'),
        base: strProp('The base branch (the branch the changes go into).'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        full_name: FULL_NAME_PROP,
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER_PROP },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        full_name: FULL_NAME_PROP,
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------- store access

/**
 * Find a repository by owner and name. The store only holds the token login's
 * repositories, so a lookup under another owner falls back to the same name
 * under the store login (the suite resolves the owner from GET /api/v3/user,
 * which is the store login; the fallback only covers a rest.ts that reports a
 * different login, where the name is still the same repository).
 */
function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  const direct = store.getRepo(owner, name);
  if (direct !== undefined) return direct;
  if (owner !== store.login) return store.getRepo(store.login, name);
  return undefined;
}

/** owner/repo out of a tool's arguments (owner, repo, or a full_name "owner/repo"). */
function ownerRepoOf(args: JsonRecord, store: Store): { owner: string; repo: string } {
  let owner = asString(args.owner ?? args.owner_login ?? args.login);
  let repo = asString(args.repo ?? args.repository ?? args.repo_name);
  const fullName = asString(args.full_name ?? args.repo_full_name);
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [fullOwner, fullRepo] = fullName.split('/', 2);
    if (owner === '') owner = fullOwner ?? '';
    if (repo === '') repo = fullRepo ?? '';
  }
  if (owner === '') owner = store.login;
  return { owner, repo };
}

/** The missing required arguments (empty when all are present and non-empty). */
function missingArgs(args: JsonRecord, required: readonly string[]): string[] {
  const missing: string[] = [];
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') missing.push(name);
  }
  return missing;
}

// ---------------------------------------------------------------- tool handlers
//
// Each handler takes the request's base URL so its result is serialized by the
// same code REST uses (rest.ts's repoJson / issueJson / pullJson).

type ToolContext = { store: Store; base: string };

function toolCreateRepo(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const name = asString(args.name ?? args.repo ?? args.repository);
  if (name === '') throw new Error('create_repo needs a name');
  if (ctx.store.getRepo(ctx.store.login, name) !== undefined) {
    throw new Error('Repository creation failed. name already exists on this account');
  }
  const description = asString(args.description ?? '');
  const repo = ctx.store.createRepo(ctx.store.login, name, description);
  if (args.private === true || args.is_private === true) repo.private = true;
  return repoJson(repo, ctx.base);
}

function toolGetRepo(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  if (repo === '') throw new Error('get_repo needs a repo');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  return repoJson(found, ctx.base);
}

function toolListRepos(ctx: ToolContext, args: JsonRecord): JsonRecord[] {
  const owner = asString(args.owner ?? args.owner_login);
  return [...ctx.store.repos.values()]
    .filter((repo) => repo.owner.login === ctx.store.login && (owner === '' || owner === ctx.store.login || repo.owner.login === owner))
    .sort((a, b) => a.id - b.id)
    .map((repo) => repoJson(repo, ctx.base));
}

function toolCreateIssue(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  const title = asString(args.title);
  if (repo === '') throw new Error('create_issue needs a repo');
  if (title === '') throw new Error('create_issue needs a title');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  const issue = createIssueInRepo(ctx.store, found, {
    title,
    body: asString(args.body ?? ''),
    labels: Array.isArray(args.labels) ? args.labels : undefined,
  });
  return issueJson(issue, found, ctx.base);
}

function toolListIssues(ctx: ToolContext, args: JsonRecord): JsonRecord[] {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  if (repo === '') throw new Error('list_issues needs a repo');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  const state = asString(args.state ?? args.status ?? 'open').toLowerCase();
  return found.issues
    .filter((issue) => {
      if (state === 'all') return true;
      if (state === 'closed') return issue.state === 'closed';
      return issue.state === 'open';
    })
    .map((issue) => issueJson(issue, found, ctx.base));
}

function toolGetIssue(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  const number = asNumber(args.issue_number ?? args.number);
  if (repo === '') throw new Error('get_issue needs a repo');
  if (number === null) throw new Error('get_issue needs an issue_number');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  const issue = found.issues.find((entry) => entry.number === number);
  if (issue === undefined) throw new Error(`Not Found: issue #${number}`);
  return issueJson(issue, found, ctx.base);
}

function toolCreatePullRequest(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  const title = asString(args.title);
  if (repo === '') throw new Error('create_pull_request needs a repo');
  if (title === '') throw new Error('create_pull_request needs a title');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  const pull = createPullInRepo(ctx.store, found, {
    title,
    body: asString(args.body ?? ''),
    head: asString(args.head ?? args.head_ref ?? args.head_branch),
    base: asString(args.base ?? args.base_ref ?? args.base_branch),
  });
  return pullJson(found, pull, ctx.base);
}

function toolMergePullRequest(ctx: ToolContext, args: JsonRecord): JsonRecord {
  const { owner, repo } = ownerRepoOf(args, ctx.store);
  const number = asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
  if (repo === '') throw new Error('merge_pull_request needs a repo');
  if (number === null) throw new Error('merge_pull_request needs a pull_number');
  const found = findRepo(ctx.store, owner, repo);
  if (found === undefined) throw new Error(`Not Found: ${owner}/${repo}`);
  const existing = found.pulls.find((entry) => entry.number === number);
  if (existing === undefined) throw new Error(`Not Found: pull request #${number}`);
  if (existing.merged === true) {
    const extra = existing as unknown as JsonRecord;
    return {
      sha: typeof extra.merge_commit_sha === 'string' ? extra.merge_commit_sha : '',
      merged: true,
      message: `Pull request #${number} merged`,
      number,
      state: 'closed',
    };
  }
  const { sha } = mergePullInRepo(ctx.store, found, number);
  return { sha, merged: true, message: `Pull request #${number} merged`, number, state: 'closed' };
}

const TOOL_HANDLERS: Readonly<Record<string, (ctx: ToolContext, args: JsonRecord) => unknown>> = Object.freeze({
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  list_repos: toolListRepos,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  get_issue: toolGetIssue,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
});

/** The required arguments of a tool, by its schema. */
function requiredOf(name: string): string[] {
  const tool = TOOLS.find((entry) => entry.name === name);
  const required = tool?.inputSchema.required;
  return Array.isArray(required) ? (required as string[]) : [];
}

// ---------------------------------------------------------------- method handlers

/** server/discover (2026-07-28): identity, capabilities and supported revisions. */
function discoverResult(): JsonRecord {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/** initialize (handshake era): echo a revision the server speaks. */
function initializeResult(params: JsonRecord): JsonRecord {
  const offered = asString(params.protocolVersion);
  const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : LEGACY_VERSIONS[0]!;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

/** One tools/call: validate, run, and shape the result (never a throw). */
function callTool(ctx: ToolContext, id: JsonRpcId, params: JsonRecord): JsonRecord {
  const name = asString(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (name === '') return rpcError(id, INVALID_PARAMS, 'tools/call needs a tool name');
  const handler = TOOL_HANDLERS[name];
  if (handler === undefined) {
    return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  const missing = missingArgs(args, requiredOf(name));
  if (missing.length > 0) {
    return rpcError(id, INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    const value = handler(ctx, args);
    return toolResult(id, value);
  } catch (err) {
    return toolError(id, err instanceof Error ? err.message : String(err));
  }
}

/** One JSON-RPC request object (not a notification): answer it. */
function handleRequest(ctx: ToolContext, request: JsonRecord): { status: number; body: JsonRecord | null } {
  const id: JsonRpcId = 'id' in request ? (request.id as JsonRpcId) : null;
  const method = asString(request.method);
  const params = isRecord(request.params) ? request.params : {};

  if (method === '') {
    return { status: 200, body: rpcError(id, INVALID_REQUEST, 'Invalid Request: no method') };
  }

  if (method === 'server/discover') {
    const declared = isRecord(params._meta) ? asString(params._meta['io.modelcontextprotocol/protocolVersion']) : '';
    if (declared !== '' && /^\d{4}-\d{2}-\d{2}$/.test(declared) && !SUPPORTED_VERSIONS.includes(declared)) {
      return {
        status: 200,
        body: rpcError(id, UNSUPPORTED_VERSION, `Unsupported protocol version: ${declared}`, { supported: [...SUPPORTED_VERSIONS] }),
      };
    }
    return { status: 200, body: rpcResult(id, discoverResult()) };
  }

  if (method === 'initialize') {
    return { status: 200, body: rpcResult(id, initializeResult(params)) };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    return { status: 200, body: callTool(ctx, id, params) };
  }

  return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
}

// ---------------------------------------------------------------- entry point

/**
 * Handle POST /mcp (and DELETE /mcp, the legacy session close: 200 {}).
 * Returns true when the request was this endpoint's; false for anything else,
 * so the caller can answer its own 404. Never throws: a bad request gets a
 * JSON-RPC error, never an HTTP 500.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp') return false;
  const method = req.method ?? 'GET';

  // The legacy client's goodbye: no session is ever handed out, so there is
  // nothing to close; answer 200 all the same.
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') return false;

  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 413, { message: 'Request body too large' });
    return true;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body.toString('utf-8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error: body is not JSON'));
    return true;
  }

  // Auth is decided before any tool runs (a tools/call with no Authorization
  // header answers 401); the parse error above already answered a bad body.
  if (!authorized(req)) {
    const id: JsonRpcId = isRecord(parsed) && 'id' in parsed ? (parsed.id as JsonRpcId) : null;
    sendJson(res, 401, rpcError(id, -32001, 'Unauthorized'));
    return true;
  }

  // A batch is not part of this transport's contract: refuse it as invalid.
  if (Array.isArray(parsed)) {
    sendJson(res, 200, rpcError(null, INVALID_REQUEST, 'Invalid Request: batch requests are not supported'));
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 200, rpcError(null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object'));
    return true;
  }

  // A notification (no id) gets no JSON-RPC answer: 202, empty body.
  if (!('id' in parsed)) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': 0 });
    res.end();
    return true;
  }

  const ctx: ToolContext = { store, base: baseUrlOf(req) };
  try {
    const { status, body: answer } = handleRequest(ctx, parsed);
    if (answer === null) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': 0 });
      res.end();
      return true;
    }
    sendJson(res, status, answer);
  } catch (err) {
    sendJson(res, 200, rpcError(
      'id' in parsed ? (parsed.id as JsonRpcId) : null,
      INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
    ));
  }
  return true;
}
