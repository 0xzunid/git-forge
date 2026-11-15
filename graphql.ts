// GraphQL v4 API for the git forge (make.fun github-core-clone-01).
//
// POST /api/graphql with {"query": ..., "variables": {...}} (or a JSON array
// of operations for GitHub's operation batching). No full GraphQL engine:
// a small tokenizer + parser builds a selection AST for the documents gh and
// github-mcp-server actually send (see sdk/conformance/checks-graphql.ts),
// then a resolver dispatches on root field and type. Introspection answers
// __type/__schema for the types those documents probe.
//
// Auth: same rule as rest.ts — no (or wrong) Bearer token is exactly 401.
// An unknown field is HTTP 200 with an errors array naming it; an unknown
// repository is data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import {
  addIssueComment,
  authOk,
  baseUrlOf,
  createIssueInRepo,
  createPullInRepo,
  findRepo,
  globalId,
  issueSeqOf,
  listIssueComments,
  mergePullInRepo,
  pullFiles,
  pullMergeableState,
  readBodyText,
  resolveRef,
  setIssueState,
} from './rest.ts';

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${randomBytes(8).toString('hex')}`,
  });
  res.end(text);
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path !== '/api/graphql' || (req.method ?? 'GET') !== 'POST') return false;

  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const ctx: Ctx = { store, base: baseUrlOf(req), login: store.login };
  let text: string;
  try {
    text = await readBodyText(req);
  } catch {
    sendJson(res, 400, { message: 'Request body too large' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne(entry, ctx));
    sendJson(res, 200, results);
    return true;
  }
  sendJson(res, 200, executeOne(parsed, ctx));
  return true;
}

interface Ctx {
  store: Store;
  base: string;
  login: string;
}

function executeOne(body: unknown, ctx: Ctx): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with query and variables' }] };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  if (query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided' }] };
  }
  let doc: Document;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse query' }] };
  }
  const operation = selectOperation(doc, typeof record.operationName === 'string' ? record.operationName : undefined);
  if (operation === null) {
    return { data: null, errors: [{ message: 'No operation to execute' }] };
  }
  const errors: { message: string }[] = [];
  const data = executeOperation(doc, operation, variables, ctx, errors);
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// Global ids (opaque, stable): base64("<Kind>:<repoId>:<number>...")
// ---------------------------------------------------------------------------------------------

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const kind = parts[0];
    if (kind === undefined || kind === '' || parts.length < 2) return null;
    if (!['Repository', 'Issue', 'PullRequest', 'IssueComment'].includes(kind)) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function findRepoById(ctx: Ctx, id: number): Repo | undefined {
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue' || parsed.parts.length !== 2) return null;
  const repo = findRepoById(ctx, Number(parsed.parts[0]));
  if (repo === undefined) return null;
  const issue = repo.issues.find((entry) => entry.number === Number(parsed.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function findPullById(ctx: Ctx, id: string): { repo: Repo; pr: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.parts.length !== 2) return null;
  const repo = findRepoById(ctx, Number(parsed.parts[0]));
  if (repo === undefined) return null;
  const pr = repo.pulls.find((entry) => entry.number === Number(parsed.parts[1]));
  return pr === undefined ? null : { repo, pr };
}

// ---------------------------------------------------------------------------------------------
// Tokenizer + parser (documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]|&='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc ?? '';
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      tokens.push(raw.includes('.') || raw.includes('e') || raw.includes('E') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in query`);
  }
  return tokens;
}

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Record<string, unknown>;
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of query');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected '${value}' in query`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in query');
    if (value !== undefined && token.value !== value) throw new Error(`Expected '${value}' in query`);
    return token.value;
  }

  parseValue(variables: Record<string, unknown>): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.expectName();
      return { __variable: name };
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue(variables));
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue(variables);
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('Unexpected value in query');
  }

  parseArguments(variables: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (!this.skipPunct('(')) return args;
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(variables);
    }
    this.expectPunct(')');
    return args;
  }

  parseSelections(variables: Record<string, unknown>): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection(variables));
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(variables: Record<string, unknown>): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelections(variables) };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        return { kind: 'fragment', name, selections: [] };
      }
      throw new Error('Unexpected fragment in query');
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments(variables);
    // Directives (@include/@skip): skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      this.parseArguments(variables);
    }
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelections(variables);
    }
    return { kind: 'field', alias, name, args, selections };
  }
}

function parseDocument(source: string): Document {
  const parser = new Parser(tokenize(source));
  const operations: Operation[] = [];
  const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
  const variables: Record<string, unknown> = {};
  while (parser.peek() !== undefined) {
    const token = parser.peek() as Token;
    if (token.kind === 'name' && token.value === 'fragment') {
      parser.next();
      const name = parser.expectName();
      parser.expectName('on');
      const typeCondition = parser.expectName();
      fragments.set(name, { typeCondition, selections: parser.parseSelections(variables) });
      continue;
    }
    let type: Operation['type'] = 'query';
    let name: string | undefined;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = token.value;
      parser.next();
      const next = parser.peek();
      if (next?.kind === 'name') name = parser.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      type = 'query';
    } else {
      throw new Error('Expected an operation in query');
    }
    // Variable definitions: ($x: Type!) — skip, values come from `variables`.
    if (parser.peek()?.kind === 'punct' && parser.peek()?.value === '(') {
      let depth = 0;
      while (parser.peek() !== undefined) {
        const t = parser.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        else if (t.kind === 'punct' && t.value === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    operations.push({ type, name, selections: parser.parseSelections(variables) });
  }
  if (operations.length === 0) throw new Error('No operation in query');
  return { operations, fragments };
}

function selectOperation(doc: Document, operationName: string | undefined): Operation | null {
  if (operationName !== undefined) {
    return doc.operations.find((op) => op.name === operationName) ?? null;
  }
  return doc.operations[0] ?? null;
}

/** Resolve $variables and {__enum} markers in a parsed argument value. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null) {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as Record<string, unknown>).__variable as string];
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>).__enum;
    }
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Schema: known fields per type (validation) and introspection data
// ---------------------------------------------------------------------------------------------

const KNOWN_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema', 'search']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name', 'url', 'avatarUrl']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'visibility', 'fork']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt', 'repository']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'headRefOid', 'baseRefOid', 'mergeCommit', 'repository']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestChangedFileEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  Ref: new Set(['name', 'id', 'target']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  CommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'createdAt', 'updatedAt', 'url', 'author']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType']),
  __Field: new Set(['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason']),
  __EnumValue: new Set(['name', 'description', 'isDeprecated', 'deprecationReason']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
  __Schema: new Set(['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', 'description']),
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'headRefOid', 'baseRefOid', 'mergeCommit', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'visibility'],
  User: ['login', 'id', 'name', 'url', 'avatarUrl'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrder: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function introspectionType(name: string): Record<string, unknown> | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      name,
      kind: 'OBJECT',
      description: '',
      fields: TYPE_FIELDS[name]?.map((field) => ({ name: field, description: '', args: [], type: { name: 'String', kind: 'SCALAR' }, isDeprecated: false, deprecationReason: null })) ?? [],
      enumValues: null,
    };
  }
  if (TYPE_ENUM_VALUES[name] !== undefined) {
    return {
      name,
      kind: 'ENUM',
      description: '',
      fields: null,
      enumValues: (TYPE_ENUM_VALUES[name] ?? []).map((value) => ({ name: value, description: '', isDeprecated: false, deprecationReason: null })),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Value builders (plain objects tagged by their GraphQL type via the resolver)
// ---------------------------------------------------------------------------------------------

interface TypedValue {
  __type: string;
  value: unknown;
}

function repoValue(ctx: Ctx, repo: Repo): TypedValue {
  return { __type: 'Repository', value: repo };
}

function issueValue(ctx: Ctx, repo: Repo, issue: Issue): TypedValue {
  return { __type: 'Issue', value: { repo, issue } };
}

function pullValue(ctx: Ctx, repo: Repo, pr: PullRequest): TypedValue {
  return { __type: 'PullRequest', value: { repo, pr } };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionResult {
  nodes: TypedValue[];
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function issueConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): ConnectionResult {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  const orderBy = (typeof args.orderBy === 'object' && args.orderBy !== null ? args.orderBy : {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let list = [...repo.issues];
  if (states !== null && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const field = orderBy.field === 'UPDATED_AT' ? 'updated' : 'created';
  list.sort((a, b) => {
    let diff: number;
    if (field === 'updated') {
      diff = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
      if (diff === 0) diff = issueSeqOf(repo, a.number) - issueSeqOf(repo, b.number);
    } else {
      diff = issueSeqOf(repo, a.number) - issueSeqOf(repo, b.number);
    }
    if (diff === 0) diff = a.number - b.number;
    return direction === 'ASC' ? diff : -diff;
  });
  return paginateConnection(list, args, (issue) => issueValue(ctx, repo, issue), (issue) => issue.number);
}

function pullConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): ConnectionResult {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  let list = [...repo.pulls];
  if (states !== null && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((pr) => {
      const state = pr.state === 'open' ? 'open' : pr.merged ? 'merged' : 'closed';
      return wanted.has(state) || wanted.has(pr.state);
    });
  } else {
    list = list.filter((pr) => pr.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  return paginateConnection(list, args, (pr) => pullValue(ctx, repo, pr), (pr) => pr.number);
}

function paginateConnection<T>(
  ordered: T[],
  args: Record<string, unknown>,
  toValue: (item: T) => TypedValue,
  toNumber: (item: T) => number,
): ConnectionResult {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : undefined;
  const afterNumber = numberFromCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => toNumber(item) === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const window = ordered.slice(start, first === undefined ? undefined : start + first);
  const endIndex = start + window.length;
  const nodes = window.map(toValue);
  return {
    nodes,
    totalCount: ordered.length,
    hasNextPage: endIndex < ordered.length,
    hasPreviousPage: start > 0,
    startCursor: window.length === 0 ? null : cursorFor(toNumber(window[0] as T)),
    endCursor: window.length === 0 ? null : cursorFor(toNumber(window[window.length - 1] as T)),
  };
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

function executeOperation(doc: Document, operation: Operation, variables: Record<string, unknown>, ctx: Ctx, errors: { message: string }[]): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    applySelection(doc, rootType, { __type: rootType, value: null }, selection, variables, ctx, errors, out);
  }
  return out;
}

function applySelection(
  doc: Document,
  parentType: string,
  parent: TypedValue,
  selection: Selection,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
  out: Record<string, unknown>,
): void {
  if (selection.kind === 'fragment') {
    if (selection.name !== undefined) {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        return;
      }
      if (fragment.typeCondition !== parentType) return;
      for (const child of fragment.selections) applySelection(doc, parentType, parent, child, variables, ctx, errors, out);
      return;
    }
    if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) return;
    for (const child of selection.selections ?? []) applySelection(doc, parentType, parent, child, variables, ctx, errors, out);
    return;
  }
  const fieldName = selection.name as string;
  const key = selection.alias ?? fieldName;
  const known = KNOWN_FIELDS[parentType];
  if (known !== undefined && !known.has(fieldName)) {
    errors.push({ message: `Cannot query field "${fieldName}" on type "${parentType}".` });
    out[key] = null;
    return;
  }
  const args = resolveArgs(selection.args ?? {}, variables);
  let resolved: TypedValue | null;
  try {
    resolved = resolveField(doc, parentType, parent, fieldName, args, ctx, errors);
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
    out[key] = null;
    return;
  }
  if (resolved === null) {
    out[key] = null;
    return;
  }
  out[key] = projectValue(doc, resolved, selection.selections ?? [], variables, ctx, errors);
}

/** Resolve one field to a typed value (or null). Throws on a mutation failure. */
function resolveField(
  doc: Document,
  parentType: string,
  parent: TypedValue,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): TypedValue | null {
  const value = parent.value;
  switch (parentType) {
    case 'Query': {
      if (fieldName === 'viewer') return { __type: 'User', value: { login: ctx.login } };
      if (fieldName === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = findRepo(ctx.store, owner, name);
        return repo === undefined ? null : repoValue(ctx, repo);
      }
      if (fieldName === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoById(ctx, Number(parsed.parts[0]));
          return repo === undefined ? null : repoValue(ctx, repo);
        }
        if (parsed.kind === 'Issue') {
          const found = findIssueById(ctx, id);
          return found === null ? null : issueValue(ctx, found.repo, found.issue);
        }
        if (parsed.kind === 'PullRequest') {
          const found = findPullById(ctx, id);
          return found === null ? null : pullValue(ctx, found.repo, found.pr);
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        const type = introspectionType(name);
        return type === null ? null : { __type: '__Type', value: type };
      }
      if (fieldName === '__schema') {
        return {
          __type: '__Schema',
          value: {
            queryType: { name: 'Query' },
            mutationType: { name: 'Mutation' },
            types: [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUM_VALUES)].map((name) => ({ name })),
          },
        };
      }
      return null;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') {
        const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const parsed = parseGlobalId(repoId);
        if (parsed === null || parsed.kind !== 'Repository') throw new Error('createIssue: unknown repositoryId');
        const repo = findRepoById(ctx, Number(parsed.parts[0]));
        if (repo === undefined) throw new Error('createIssue: unknown repositoryId');
        const issue = createIssueInRepo(ctx.store, repo, { title: input.title, body: input.body });
        return { __type: 'CreateIssuePayload', value: { repo, issue } };
      }
      if (fieldName === 'closeIssue') {
        const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
        const found = findIssueById(ctx, typeof input.issueId === 'string' ? input.issueId : '');
        if (found === null) throw new Error('closeIssue: unknown issueId');
        const issue = setIssueState(found.repo, found.issue.number, 'closed');
        return { __type: 'CloseIssuePayload', value: { repo: found.repo, issue } };
      }
      if (fieldName === 'createPullRequest') {
        const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const parsed = parseGlobalId(repoId);
        if (parsed === null || parsed.kind !== 'Repository') throw new Error('createPullRequest: unknown repositoryId');
        const repo = findRepoById(ctx, Number(parsed.parts[0]));
        if (repo === undefined) throw new Error('createPullRequest: unknown repositoryId');
        const pr = createPullInRepo(ctx.store, repo, {
          title: input.title,
          body: input.body,
          head: input.headRefName,
          base: input.baseRefName,
        });
        return { __type: 'CreatePullRequestPayload', value: { repo, pr } };
      }
      if (fieldName === 'mergePullRequest') {
        const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
        const found = findPullById(ctx, typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
        if (found === null) throw new Error('mergePullRequest: unknown pullRequestId');
        try {
          const { pr } = mergePullInRepo(ctx.store, found.repo, found.pr.number);
          return { __type: 'MergePullRequestPayload', value: { repo: found.repo, pr } };
        } catch (err) {
          throw new Error(err instanceof Error ? err.message : 'mergePullRequest failed');
        }
      }
      if (fieldName === 'addComment') {
        const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
        const found = findIssueById(ctx, typeof input.subjectId === 'string' ? input.subjectId : '');
        if (found === null) throw new Error('addComment: unknown subjectId');
        const comment = addIssueComment(ctx.store, found.repo, found.issue.number, input.body);
        return { __type: 'AddCommentPayload', value: { repo: found.repo, issue: found.issue, comment } };
      }
      return null;
    }
    case 'User': {
      const user = value as { login: string };
      if (fieldName === 'login') return { __type: 'String', value: user.login };
      if (fieldName === 'id') return { __type: 'String', value: globalId('User', user.login) };
      if (fieldName === 'name') return { __type: 'String', value: user.login };
      if (fieldName === 'url') return { __type: 'String', value: `${ctx.base}/${user.login}` };
      if (fieldName === 'avatarUrl') return { __type: 'String', value: '' };
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (fieldName) {
        case 'id': return { __type: 'String', value: globalId('Repository', repo.id) };
        case 'databaseId': return { __type: 'Int', value: repo.id };
        case 'name': return { __type: 'String', value: repo.name };
        case 'nameWithOwner': return { __type: 'String', value: repo.full_name };
        case 'owner': return { __type: 'User', value: { login: repo.owner.login } };
        case 'defaultBranchRef': {
          const ref = repo.refs.get(`refs/heads/${repo.default_branch}`);
          return ref === undefined ? null : { __type: 'Ref', value: { name: repo.default_branch, sha: ref } };
        }
        case 'viewerPermission': return { __type: 'String', value: 'ADMIN' };
        case 'hasIssuesEnabled': return { __type: 'Boolean', value: true };
        case 'description': return { __type: 'String', value: repo.description ?? '' };
        case 'url': return { __type: 'String', value: `${ctx.base}/${repo.owner.login}/${repo.name}` };
        case 'createdAt': return { __type: 'String', value: repo.created_at };
        case 'updatedAt': return { __type: 'String', value: repo.updated_at };
        case 'isPrivate': return { __type: 'Boolean', value: repo.private };
        case 'visibility': return { __type: 'String', value: repo.private ? 'PRIVATE' : 'PUBLIC' };
        case 'fork': return { __type: 'Boolean', value: false };
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueValue(ctx, repo, issue);
        }
        case 'issues': return { __type: 'IssueConnection', value: issueConnection(ctx, repo, args) };
        case 'pullRequests': return { __type: 'PullRequestConnection', value: pullConnection(ctx, repo, args) };
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pr = repo.pulls.find((entry) => entry.number === number);
          return pr === undefined ? null : pullValue(ctx, repo, pr);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      switch (fieldName) {
        case 'id': return { __type: 'String', value: globalId('Issue', repo.id, issue.number) };
        case 'number': return { __type: 'Int', value: issue.number };
        case 'title': return { __type: 'String', value: issue.title };
        case 'state': return { __type: 'String', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'body': return { __type: 'String', value: issue.body ?? '' };
        case 'createdAt': return { __type: 'String', value: issue.created_at };
        case 'updatedAt': return { __type: 'String', value: issue.updated_at };
        case 'closedAt': return { __type: 'String', value: issue.state === 'closed' ? issue.updated_at : null };
        case 'url': return { __type: 'String', value: `${ctx.base}/${repo.owner.login}/${repo.name}/issues/${issue.number}` };
        case 'author': return { __type: 'User', value: { login: issue.user.login } };
        case 'labels': return { __type: 'String', value: issue.labels.map((label) => label.name).join(',') };
        case 'comments': return { __type: 'Int', value: listIssueComments(repo, issue.number).length };
        case 'repository': return repoValue(ctx, repo);
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pr } = value as { repo: Repo; pr: PullRequest };
      switch (fieldName) {
        case 'id': return { __type: 'String', value: globalId('PullRequest', repo.id, pr.number) };
        case 'number': return { __type: 'Int', value: pr.number };
        case 'title': return { __type: 'String', value: pr.title };
        case 'state': return { __type: 'String', value: pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED' };
        case 'merged': return { __type: 'Boolean', value: pr.merged === true };
        case 'mergeable': return { __type: 'String', value: pullMergeableState(repo, pr) };
        case 'headRefName': return { __type: 'String', value: pr.head.ref };
        case 'baseRefName': return { __type: 'String', value: pr.base.ref };
        case 'headRefOid': return { __type: 'String', value: resolveRef(repo, pr.head.ref) ?? pr.head.sha };
        case 'baseRefOid': return { __type: 'String', value: resolveRef(repo, pr.base.ref) ?? pr.base.sha };
        case 'body': return { __type: 'String', value: pr.body ?? '' };
        case 'createdAt': return { __type: 'String', value: pr.created_at };
        case 'updatedAt': return { __type: 'String', value: pr.updated_at };
        case 'url': return { __type: 'String', value: `${ctx.base}/${repo.owner.login}/${repo.name}/pull/${pr.number}` };
        case 'author': return { __type: 'User', value: { login: pr.user.login } };
        case 'mergeCommit': {
          const sha = (pr as unknown as Record<string, unknown>).merge_commit_sha as string | undefined;
          return sha === undefined ? null : { __type: 'String', value: sha };
        }
        case 'files': {
          const files = pullFiles(repo, pr);
          const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : files.length;
          const nodes = files.slice(0, first).map((file) => ({ __type: 'PullRequestChangedFile', value: file }));
          return {
            __type: 'PullRequestChangedFileConnection',
            value: { nodes, totalCount: files.length, hasNextPage: first < files.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          };
        }
        case 'repository': return repoValue(ctx, repo);
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const conn = value as ConnectionResult;
      switch (fieldName) {
        case 'nodes': return { __type: 'List', value: conn.nodes };
        case 'edges': return { __type: 'List', value: conn.nodes.map((node) => ({ __type: 'Edge', value: { node, cursor: null } })) };
        case 'pageInfo': return { __type: 'PageInfo', value: { hasNextPage: conn.hasNextPage, hasPreviousPage: conn.hasPreviousPage, startCursor: conn.startCursor, endCursor: conn.endCursor } };
        case 'totalCount': return { __type: 'Int', value: conn.totalCount };
        default: return null;
      }
    }
    case 'Edge': {
      const edge = value as { node: TypedValue; cursor: string | null };
      if (fieldName === 'node') return edge.node;
      if (fieldName === 'cursor') return { __type: 'String', value: edge.cursor };
      return null;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (fieldName === 'hasNextPage') return { __type: 'Boolean', value: info.hasNextPage };
      if (fieldName === 'hasPreviousPage') return { __type: 'Boolean', value: info.hasPreviousPage };
      if (fieldName === 'startCursor') return { __type: 'String', value: info.startCursor };
      if (fieldName === 'endCursor') return { __type: 'String', value: info.endCursor };
      return null;
    }
    case 'Ref': {
      const ref = value as { name: string; sha: string };
      if (fieldName === 'name') return { __type: 'String', value: ref.name };
      if (fieldName === 'id') return { __type: 'String', value: globalId('Ref', ref.name) };
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = value as { filename: string; status: string; additions: number; deletions: number; changes: number };
      if (fieldName === 'path') return { __type: 'String', value: file.filename };
      if (fieldName === 'additions') return { __type: 'Int', value: file.additions };
      if (fieldName === 'deletions') return { __type: 'Int', value: file.deletions };
      if (fieldName === 'changeType') return { __type: 'String', value: file.status.toUpperCase() };
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (fieldName === 'issue') return issueValue(ctx, payload.repo, payload.issue);
      if (fieldName === 'clientMutationId') return { __type: 'String', value: null };
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { repo: Repo; pr: PullRequest };
      if (fieldName === 'pullRequest') return pullValue(ctx, payload.repo, payload.pr);
      if (fieldName === 'clientMutationId') return { __type: 'String', value: null };
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { repo: Repo; issue: Issue; comment: { id: number; body: string; created_at: string; updated_at: string } };
      if (fieldName === 'commentEdge') {
        return { __type: 'CommentEdge', value: { node: { __type: 'IssueComment', value: payload.comment }, cursor: null } };
      }
      if (fieldName === 'clientMutationId') return { __type: 'String', value: null };
      return null;
    }
    case 'CommentEdge': {
      const edge = value as { node: TypedValue; cursor: string | null };
      if (fieldName === 'node') return edge.node;
      if (fieldName === 'cursor') return { __type: 'String', value: edge.cursor };
      return null;
    }
    case 'IssueComment': {
      const comment = value as { id: number; body: string; created_at: string; updated_at: string };
      if (fieldName === 'id') return { __type: 'String', value: globalId('IssueComment', comment.id) };
      if (fieldName === 'body') return { __type: 'String', value: comment.body };
      if (fieldName === 'createdAt') return { __type: 'String', value: comment.created_at };
      if (fieldName === 'updatedAt') return { __type: 'String', value: comment.updated_at };
      if (fieldName === 'url') return { __type: 'String', value: '' };
      if (fieldName === 'author') return { __type: 'User', value: { login: ctx.login } };
      return null;
    }
    case '__Type': {
      const type = value as Record<string, unknown>;
      switch (fieldName) {
        case 'name': return { __type: 'String', value: type.name ?? null };
        case 'kind': return { __type: 'String', value: type.kind ?? null };
        case 'description': return { __type: 'String', value: type.description ?? null };
        case 'fields': {
          const fields = Array.isArray(type.fields) ? type.fields : [];
          return { __type: 'List', value: fields.map((field) => ({ __type: '__Field', value: field })) };
        }
        case 'enumValues': {
          const values = Array.isArray(type.enumValues) ? type.enumValues : [];
          return { __type: 'List', value: values.map((entry) => ({ __type: '__EnumValue', value: entry })) };
        }
        default: return null;
      }
    }
    case '__Field': {
      const field = value as Record<string, unknown>;
      if (fieldName === 'name') return { __type: 'String', value: field.name ?? null };
      if (fieldName === 'description') return { __type: 'String', value: field.description ?? null };
      if (fieldName === 'args') return { __type: 'List', value: [] };
      if (fieldName === 'type') return { __type: '__Type', value: field.type ?? { name: 'String', kind: 'SCALAR' } };
      if (fieldName === 'isDeprecated') return { __type: 'Boolean', value: false };
      if (fieldName === 'deprecationReason') return { __type: 'String', value: null };
      return null;
    }
    case '__EnumValue': {
      const entry = value as Record<string, unknown>;
      if (fieldName === 'name') return { __type: 'String', value: entry.name ?? null };
      if (fieldName === 'description') return { __type: 'String', value: entry.description ?? null };
      if (fieldName === 'isDeprecated') return { __type: 'Boolean', value: false };
      if (fieldName === 'deprecationReason') return { __type: 'String', value: null };
      return null;
    }
    case '__Schema': {
      const schema = value as Record<string, unknown>;
      if (fieldName === 'types') {
        const types = Array.isArray(schema.types) ? schema.types : [];
        return { __type: 'List', value: types.map((entry) => ({ __type: '__Type', value: entry })) };
      }
      if (fieldName === 'queryType') return { __type: '__Type', value: schema.queryType ?? null };
      if (fieldName === 'mutationType') return { __type: '__Type', value: schema.mutationType ?? null };
      if (fieldName === 'subscriptionType') return { __type: 'String', value: null };
      if (fieldName === 'directives') return { __type: 'List', value: [] };
      if (fieldName === 'description') return { __type: 'String', value: null };
      return null;
    }
    default:
      return null;
  }
}

/** Project a typed value through the requested sub-selections (scalars pass through). */
function projectValue(
  doc: Document,
  typed: TypedValue,
  selections: Selection[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): unknown {
  if (typed.__type === 'List') {
    const items = typed.value as TypedValue[];
    return items.map((item) => projectValue(doc, item, selections, variables, ctx, errors));
  }
  if (typed.__type === 'String' || typed.__type === 'Int' || typed.__type === 'Boolean') {
    return typed.value;
  }
  if (selections.length === 0) return typed.value;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    applySelection(doc, typed.__type, typed, selection, variables, ctx, errors, out);
  }
  return out;
}
