// REST v3 API for the git forge (make.fun github-core-clone-01).
//
// Owns: GET /api/v3/ + /meta, /user/repos, /repos/{owner}/{repo} and all of its
// sub-resources (git/refs, branches, commits, contents, labels, issues, pulls).
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
//
// Auth: app.ts validates Authorization: Bearer == MAKEFUN_SHOP_TOKEN before
// calling this handler; this module re-checks the header (missing or wrong
// token -> 401) so it is safe no matter how it is wired. Pass the request
// through untouched (do not strip the Authorization header).
//
// Store contract: this module only uses the fixed Store/Repo interfaces from
// ./store.ts (imported as types only) plus the Repo's refs/objects Maps.
// Git objects are created locally here (sha1 of "type len\\0data", raw payload
// bytes in repo.objects) because git.ts had not landed when this was written;
// the format is canonical git, so the git smart-HTTP module reads the same
// objects. If git.ts later exports helpers, these local ones can be swapped
// without changing any route behaviour.
//
// Wiring note for the integrator (app.ts): call handleRest first; when it
// returns false the route is not a /api/v3 route. handleRest DOES answer
// GET /api/v3/ itself (200 + X-OAuth-Scopes) and unknown /api/v3 routes
// (404 JSON + request id, which app.ts's generic 404 lacks), so app.ts must
// not answer again after handleRest returns true.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Errors, auth, small HTTP helpers
// ---------------------------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The bearer token is valid when present and, when MAKEFUN_SHOP_TOKEN is set, equal to it. */
export function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return true;
}

export function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

function requestId(): string {
  return `req-${randomBytes(8).toString('hex')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

export async function readBodyText(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a JSON request body: empty body -> {}, malformed JSON -> 400. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBodyText(req);
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Per-repo extras the fixed Store interfaces do not carry (comments, creation order).
// Keyed by Repo object identity; the store holds the same objects across calls.
// ---------------------------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface RepoExtra {
  comments: Map<number, IssueComment[]>;
  issueSeq: Map<number, number>;
  nextSeq: number;
}

const repoExtras = new WeakMap<Repo, RepoExtra>();

export function repoExtra(repo: Repo): RepoExtra {
  let extra = repoExtras.get(repo);
  if (extra === undefined) {
    extra = { comments: new Map(), issueSeq: new Map(), nextSeq: 1 };
    repoExtras.set(repo, extra);
  }
  return extra;
}

/** Creation-order sequence of an issue (stable even when timestamps tie). */
export function issueSeqOf(repo: Repo, number: number): number {
  const extra = repoExtra(repo);
  let seq = extra.issueSeq.get(number);
  if (seq === undefined) {
    seq = extra.nextSeq;
    extra.nextSeq += 1;
    extra.issueSeq.set(number, seq);
  }
  return seq;
}

// ---------------------------------------------------------------------------------------------
// Git objects, local implementations over repo.objects (canonical git format).
// ---------------------------------------------------------------------------------------------

function gitSha(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function putObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const sha = gitSha(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
}

export function parseCommitData(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const rawMessage = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let authorDate = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = line.slice(7).trim();
      const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
      if (m !== null) {
        authorName = m[1] ?? '';
        authorEmail = m[2] ?? '';
        authorDate = new Date(Number(m[3]) * 1000).toISOString();
      } else {
        // git.ts's makeCommit writes `author <name> <ts> +0000` (no email).
        const m2 = /^(.*) (\d+) [+-]\d{4}$/.exec(ident);
        if (m2 !== null) {
          authorName = m2[1] ?? '';
          authorDate = new Date(Number(m2[2]) * 1000).toISOString();
        } else {
          authorName = ident;
        }
      }
    }
  }
  if (tree === '') return null;
  return { tree, parents, message: rawMessage.replace(/\n$/, ''), authorName, authorEmail, authorDate };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function sortTreeEntries(entries: TreeEntry[]): void {
  entries.sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build nested tree objects from a flat path -> blob map; returns the root tree sha. */
export function buildTree(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
  const files: TreeEntry[] = [];
  const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
  for (const [path, value] of flat) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      files.push({ mode: value.mode, name: path, sha: value.sha });
    } else {
      const dir = path.slice(0, slash);
      let sub = dirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), value);
    }
  }
  const entries: TreeEntry[] = [...files];
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, sha: buildTree(repo, sub) });
  sortTreeEntries(entries);
  return putObject(repo, 'tree', encodeTree(entries));
}

/** Flatten a tree (recursively) into path -> {mode, sha} for blobs only. */
export function flattenTree(repo: Repo, treeSha: string, out = new Map<string, { mode: string; sha: string }>(), prefix = ''): Map<string, { mode: string; sha: string }> {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTreeData(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, out, path);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/** The tree sha of a commit sha, or null. */
export function treeOfCommit(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommitData(obj.data)?.tree ?? null;
}

/** Resolve a branch name, full ref, or commit sha to a commit sha. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return undefined;
}

/** Newest-first walk of a commit's reachable history (exact for linear histories). */
export function walkCommits(repo: Repo, tip: string): { sha: string; commit: ParsedCommit }[] {
  const out: { sha: string; commit: ParsedCommit }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommitData(obj.data);
    if (commit === null) continue;
    out.push({ sha, commit });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

function ancestorsOf(repo: Repo, tip: string): Set<string> {
  return new Set(walkCommits(repo, tip).map((entry) => entry.sha));
}

/** First common ancestor of two tips (merge base), or null when unrelated. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = ancestorsOf(repo, a);
  for (const entry of walkCommits(repo, b)) {
    if (aAncestors.has(entry.sha)) return entry.sha;
  }
  return null;
}

/** True when merging headTip into baseTip would conflict (same path changed differently on both sides). */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseTree = treeOfCommit(repo, base);
  const baseTipTree = treeOfCommit(repo, baseTip);
  const headTipTree = treeOfCommit(repo, headTip);
  if (baseTree === null || baseTipTree === null || headTipTree === null) return false;
  const m = flattenTree(repo, baseTree);
  const b = flattenTree(repo, baseTipTree);
  const h = flattenTree(repo, headTipTree);
  const paths = new Set([...m.keys(), ...b.keys(), ...h.keys()]);
  for (const path of paths) {
    const mSha = m.get(path)?.sha;
    const bSha = b.get(path)?.sha;
    const hSha = h.get(path)?.sha;
    if (bSha !== mSha && hSha !== mSha && bSha !== hSha) return true;
  }
  return false;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldSha: string | null;
  newSha: string | null;
}

/** Diff of two trees (merge-base -> head for pull-request files). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) changes.push({ path, status: 'added', oldSha: null, newSha: entry.sha });
    else if (old.sha !== entry.sha) changes.push({ path, status: 'modified', oldSha: old.sha, newSha: entry.sha });
  }
  for (const path of base.keys()) {
    if (!head.has(path)) changes.push({ path, status: 'deleted', oldSha: base.get(path)?.sha ?? null, newSha: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (text === '') return counts;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Multiset line diff: additions/deletions between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = lineCounts(oldText);
  const newCounts = lineCounts(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

function blobText(repo: Repo, sha: string | null): string {
  if (sha === null) return '';
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** The changed files of a pull request (merge-base tree -> head tree), with change counts. */
export function pullFiles(repo: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const headTip = resolveRef(repo, pr.head.ref) ?? pr.head.sha;
  const baseTip = resolveRef(repo, pr.base.ref) ?? pr.base.sha;
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  if (baseTree === null || headTree === null) return [];
  return diffTrees(repo, baseTree, headTree).map((change) => {
    const { additions, deletions } = lineDiff(blobText(repo, change.oldSha), blobText(repo, change.newSha));
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

export function pullMergeableState(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return pr.merged ? 'MERGEABLE' : 'UNKNOWN';
  const headTip = resolveRef(repo, pr.head.ref) ?? pr.head.sha;
  const baseTip = resolveRef(repo, pr.base.ref) ?? pr.base.sha;
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function makeCommitObject(repo: Repo, opts: { tree: string; parents: string[]; message: string; author: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const ident = `${opts.author} <${opts.author}@users.noreply.github.com> ${now} +0000`;
  let text = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${opts.message}\n`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Serializers (GitHub REST v3 shapes)
// ---------------------------------------------------------------------------------------------

/** Opaque Relay-style global id (never the bare numeric id). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const owner = repo.owner.login;
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  const openPulls = repo.pulls.filter((pr) => pr.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: owner, id: 0, type: 'User', html_url: `${base}/${owner}`, url: `${base}/api/v3/users/${owner}` },
    private: repo.private,
    description: repo.description ?? '',
    default_branch: repo.default_branch,
    html_url: `${base}/${owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `${base}/${owner}/${repo.name}.git`,
    git_url: `${base}/${owner}/${repo.name}.git`,
    ssh_url: `git@${new URL(base).host}:${owner}/${repo.name}.git`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    open_issues_count: openIssues + openPulls,
    has_issues: true,
    has_pull_requests: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { name: string; color?: string; description?: string }, base: string, repo: Repo): Record<string, unknown> {
  return {
    name: label.name,
    color: label.color ?? 'ededed',
    description: label.description ?? '',
    url: `${base}/api/v3/repos/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

export function issueJson(issue: Issue, repo: Repo, base: string): Record<string, unknown> {
  const owner = repo.owner.login;
  const labels = issue.labels.map((entry) => {
    const known = repo.labels.find((label) => label.name === entry.name);
    return labelJson(known ?? { name: entry.name }, base, repo);
  });
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels,
    user: { login: issue.user.login, type: 'User', html_url: `${base}/${issue.user.login}` },
    assignees: [],
    assignee: null,
    locked: false,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    comments: (repoExtra(repo).comments.get(issue.number) ?? []).length,
    comments_url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(repo: Repo, pr: PullRequest, base: string): Record<string, unknown> {
  const owner = repo.owner.login;
  const headSha = resolveRef(repo, pr.head.ref) ?? pr.head.sha;
  const baseSha = resolveRef(repo, pr.base.ref) ?? pr.base.sha;
  const extra = pr as unknown as Record<string, unknown>;
  const merged = pr.merged === true;
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    merged,
    mergeable: pullMergeableState(repo, pr) === 'MERGEABLE',
    merge_commit_sha: (extra.merge_commit_sha as string | undefined) ?? null,
    merged_at: (extra.merged_at as string | undefined) ?? null,
    closed_at: pr.state === 'closed' ? pr.updated_at : null,
    head: { ref: pr.head.ref, sha: headSha, label: `${owner}:${pr.head.ref}`, user: { login: owner } },
    base: { ref: pr.base.ref, sha: baseSha, label: `${owner}:${pr.base.ref}`, user: { login: owner } },
    user: { login: pr.user.login, type: 'User', html_url: `${base}/${pr.user.login}` },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: `${base}/${owner}/${repo.name}/pull/${pr.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commentJson(comment: IssueComment, repo: Repo, issueNumber: number, base: string): Record<string, unknown> {
  const owner = repo.owner.login;
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issueNumber, comment.id),
    body: comment.body,
    user: { login: comment.user.login, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `${base}/${owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared issue / pull-request / comment operations (also used by graphql.ts)
// ---------------------------------------------------------------------------------------------

export function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.login) return undefined;
  const repo = store.getRepo(owner, name);
  if (repo === undefined || repo.owner.login !== owner) return undefined;
  return repo;
}

export function getRepoOr404(store: Store, owner: string, name: string): Repo {
  const repo = findRepo(store, owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

export function createIssueInRepo(store: Store, repo: Repo, input: { title?: unknown; body?: unknown; labels?: unknown }): Issue {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'title is required');
  const rawLabels = Array.isArray(input.labels) ? input.labels : [];
  const labelNames: string[] = [];
  for (const entry of rawLabels) {
    if (typeof entry === 'string') labelNames.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
      labelNames.push((entry as Record<string, unknown>).name as string);
    }
  }
  for (const name of labelNames) {
    if (!repo.labels.some((label) => label.name === name)) throw new HttpError(422, `Label '${name}' does not exist`);
  }
  const issue: Issue = {
    number: repo.nextIssue,
    id: store.allocId(),
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: labelNames.map((name) => ({ name })),
    user: { login: store.login },
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: '',
    url: '',
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  const extra = repoExtra(repo);
  extra.issueSeq.set(issue.number, extra.nextSeq);
  extra.nextSeq += 1;
  return issue;
}

export function setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  issue.state = state;
  issue.updated_at = nowIso();
  return issue;
}

export function addIssueComment(store: Store, repo: Repo, issueNumber: number, body: unknown): IssueComment {
  const issue = repo.issues.find((entry) => entry.number === issueNumber);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  if (typeof body !== 'string' || body === '') throw new HttpError(422, 'body is required');
  const comment: IssueComment = {
    id: store.allocId(),
    body,
    user: { login: store.login },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const extra = repoExtra(repo);
  const list = extra.comments.get(issueNumber) ?? [];
  list.push(comment);
  extra.comments.set(issueNumber, list);
  return comment;
}

export function listIssueComments(repo: Repo, issueNumber: number): IssueComment[] {
  return repoExtra(repo).comments.get(issueNumber) ?? [];
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function createPullInRepo(store: Store, repo: Repo, input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): PullRequest {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'title is required');
  if (typeof input.head !== 'string' || input.head === '') throw new HttpError(422, 'head is required');
  const headRef = stripOwnerPrefix(input.head);
  const baseRef = typeof input.base === 'string' && input.base !== '' ? stripOwnerPrefix(input.base) : repo.default_branch;
  const headSha = resolveRef(repo, headRef);
  if (headSha === undefined) throw new HttpError(422, `Head branch '${headRef}' does not exist`);
  const baseSha = resolveRef(repo, baseRef);
  if (baseSha === undefined) throw new HttpError(422, `Base branch '${baseRef}' does not exist`);
  const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.head.ref === headRef && pr.base.ref === baseRef);
  if (existing !== undefined) throw new HttpError(422, 'A pull request already exists for this head and base');
  const pr: PullRequest = {
    number: repo.nextPull,
    id: store.allocId(),
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    user: { login: store.login },
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: '',
    url: '',
  };
  repo.nextPull += 1;
  repo.pulls.push(pr);
  return pr;
}

/** Squash-merge an open pull request onto its base branch. Throws 404 / 405. */
export function mergePullInRepo(store: Store, repo: Repo, number: number): { pr: PullRequest; sha: string } {
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (pr === undefined) throw new HttpError(404, 'Not Found');
  if (pr.state !== 'open') throw new HttpError(405, 'Pull request is already closed');
  const headTip = resolveRef(repo, pr.head.ref) ?? pr.head.sha;
  const baseTip = resolveRef(repo, pr.base.ref) ?? pr.base.sha;
  if (headTip === undefined || baseTip === undefined) throw new HttpError(405, 'Pull request cannot be merged');
  if (mergeConflicts(repo, baseTip, headTip)) throw new HttpError(405, 'Merge conflict');
  const headTree = treeOfCommit(repo, headTip);
  if (headTree === null) throw new HttpError(405, 'Pull request cannot be merged');
  const sha = makeCommitObject(repo, { tree: headTree, parents: [baseTip], message: pr.title, author: store.login });
  repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.updated_at = nowIso();
  const extra = pr as unknown as Record<string, unknown>;
  extra.merged_at = pr.updated_at;
  extra.merge_commit_sha = sha;
  repo.updated_at = nowIso();
  return { pr, sha };
}

// ---------------------------------------------------------------------------------------------
// Contents helpers
// ---------------------------------------------------------------------------------------------

interface PathLookup {
  kind: 'file' | 'dir';
  sha: string;
  size: number;
  entries?: TreeEntry[];
}

function lookupPath(repo: Repo, treeSha: string, path: string): PathLookup | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTreeData(obj.data).find((item) => item.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') {
        const dirObj = repo.objects.get(entry.sha);
        const entries = dirObj !== undefined && dirObj.type === 'tree' ? parseTreeData(dirObj.data) : [];
        return { kind: 'dir', sha: entry.sha, size: 0, entries };
      }
      const blob = repo.objects.get(entry.sha);
      return { kind: 'file', sha: entry.sha, size: blob === undefined ? 0 : blob.data.length };
    }
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  const rootObj = repo.objects.get(current);
  const entries = rootObj !== undefined && rootObj.type === 'tree' ? parseTreeData(rootObj.data) : [];
  return { kind: 'dir', sha: current, size: 0, entries };
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function contentEntryJson(repo: Repo, path: string, entry: PathLookup, base: string, branch: string): Record<string, unknown> {
  const owner = repo.owner.login;
  const name = path.split('/').pop() ?? path;
  if (entry.kind === 'dir') {
    return {
      type: 'dir',
      name,
      path,
      sha: entry.sha,
      size: 0,
      url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${encodePath(path)}`,
      html_url: `${base}/${owner}/${repo.name}/tree/${encodeURIComponent(branch)}/${encodePath(path)}`,
      git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/trees/${entry.sha}`,
      download_url: null,
    };
  }
  const blob = repo.objects.get(entry.sha);
  return {
    type: 'file',
    name,
    path,
    sha: entry.sha,
    size: entry.size,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${encodePath(path)}`,
    html_url: `${base}/${owner}/${repo.name}/blob/${encodeURIComponent(branch)}/${encodePath(path)}`,
    git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/blobs/${entry.sha}`,
    download_url: `${base}/${owner}/${repo.name}/raw/${encodeURIComponent(branch)}/${encodePath(path)}`,
    content: blob === undefined ? '' : blob.data.toString('base64'),
    encoding: 'base64',
  };
}

function commitJson(repo: Repo, sha: string, message: string, base: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const commit = obj !== undefined ? parseCommitData(obj.data) : null;
  return {
    sha,
    message,
    author: { name: commit?.authorName ?? '', email: commit?.authorEmail ?? '', date: commit?.authorDate ?? '' },
    committer: { name: commit?.authorName ?? '', email: commit?.authorEmail ?? '', date: commit?.authorDate ?? '' },
    tree: { sha: commit?.tree ?? '' },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `${base}/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${sha}`,
    html_url: `${base}/${repo.owner.login}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function pageLinkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1 && page >= lastPage) return null;
  const base = baseUrlOf(req);
  const build = (p: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}${url.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(lastPage)}>; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;

  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const base = baseUrlOf(req);
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((part) => part !== '').map(decodeSegment);
  // segments[0] = 'api', segments[1] = 'v3', rest follows.
  const rest = segments.slice(2);

  try {
    // GET /api/v3/ — the API root (also answered by app.ts's starter route;
    // this handler runs first when wired so, and must not double-answer).
    if (rest.length === 0) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    if (rest[0] === 'meta' && rest.length === 1) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { installed_version: '1.0.0', verifiable: true });
      return true;
    }

    if (rest[0] === 'user' && rest[1] === undefined && rest.length === 1) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, {
        login: store.login,
        id: 0,
        node_id: globalId('User', store.login),
        type: 'User',
        html_url: `${base}/${store.login}`,
        url: `${base}/api/v3/users/${store.login}`,
        repos_url: `${base}/api/v3/users/${store.login}/repos`,
      });
      return true;
    }

    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        const { page, perPage } = pageParams(url);
        const owned = [...store.repos.values()]
          .filter((repo) => repo.owner.login === store.login)
          .sort((a, b) => a.id - b.id);
        const link = pageLinkHeader(req, url, page, perPage, owned.length);
        sendJson(res, 200, paginate(owned, page, perPage).map((repo) => repoJson(repo, base)), link === null ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '' || name.length > 100 || name.includes('/')) throw new HttpError(422, 'name is required');
        if (store.getRepo(store.login, name) !== undefined) throw new HttpError(422, 'Repository creation failed. name already exists on this account');
        const repo = store.createRepo(store.login, name, typeof body.description === 'string' ? body.description : '');
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
        sendJson(res, 201, repoJson(repo, base));
        return true;
      }
      throw new HttpError(404, 'Not Found');
    }

    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = rest[1] as string;
      const name = rest[2] as string;
      const tail = rest.slice(3);
      const repo = getRepoOr404(store, owner, name);

      if (tail.length === 0) {
        if (method === 'GET') {
          sendJson(res, 200, repoJson(repo, base));
          return true;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
          if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
          repo.updated_at = nowIso();
          sendJson(res, 200, repoJson(repo, base));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(owner, name);
          sendJson(res, 204, null);
          return true;
        }
        throw new HttpError(404, 'Not Found');
      }

      if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
        if (method !== 'POST') throw new HttpError(404, 'Not Found');
        const body = await readJsonBody(req);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/') throw new HttpError(422, 'ref must be refs/heads/<branch>');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        const target = repo.objects.get(sha);
        if (target === undefined || target.type !== 'commit') throw new HttpError(422, 'sha does not name a commit');
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          object: { sha, type: 'commit', url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
          url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
        });
        return true;
      }

      if (tail[0] === 'branches' && tail.length === 1) {
        if (method !== 'GET') throw new HttpError(404, 'Not Found');
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha, url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
            protected: false,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, branches);
        return true;
      }

      if (tail[0] === 'commits' && tail.length === 1) {
        if (method !== 'GET') throw new HttpError(404, 'Not Found');
        const ref = url.searchParams.get('sha') ?? repo.default_branch;
        const tip = resolveRef(repo, ref);
        if (tip === undefined) throw new HttpError(404, 'Not Found');
        const { page, perPage } = pageParams(url);
        const commits = paginate(walkCommits(repo, tip), page, perPage).map(({ sha, commit }) => ({
          sha,
          commit: {
            message: commit.message,
            author: { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate },
            committer: { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate },
          },
          author: { login: store.login },
          committer: { login: store.login },
          parents: commit.parents.map((parent) => ({ sha: parent })),
          url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${sha}`,
          html_url: `${base}/${owner}/${name}/commit/${sha}`,
        }));
        sendJson(res, 200, commits);
        return true;
      }

      if (tail[0] === 'contents') {
        const contentPath = tail.slice(1).join('/');
        if (method === 'GET') {
          const ref = url.searchParams.get('ref') ?? repo.default_branch;
          const tip = resolveRef(repo, ref);
          if (tip === undefined) throw new HttpError(404, 'Not Found');
          const treeSha = treeOfCommit(repo, tip);
          if (treeSha === null) throw new HttpError(404, 'Not Found');
          if (contentPath === '') {
            const root = lookupPath(repo, treeSha, '');
            const entries = (root?.entries ?? []).map((entry) => {
              const childPath = entry.name;
              const child = lookupPath(repo, treeSha, childPath);
              return child === null ? null : contentEntryJson(repo, childPath, child, base, ref);
            }).filter((entry): entry is Record<string, unknown> => entry !== null);
            sendJson(res, 200, entries);
            return true;
          }
          const found = lookupPath(repo, treeSha, contentPath);
          if (found === null) throw new HttpError(404, 'Not Found');
          if (found.kind === 'dir') {
            const entries = (found.entries ?? []).map((entry) => {
              const childPath = `${contentPath}/${entry.name}`;
              const child = lookupPath(repo, treeSha, childPath);
              return child === null ? null : contentEntryJson(repo, childPath, child, base, ref);
            }).filter((entry): entry is Record<string, unknown> => entry !== null);
            sendJson(res, 200, entries);
            return true;
          }
          sendJson(res, 200, contentEntryJson(repo, contentPath, found, base, ref));
          return true;
        }
        if (method === 'PUT') {
          if (contentPath === '') throw new HttpError(422, 'path is required');
          const body = await readJsonBody(req);
          const message = typeof body.message === 'string' ? body.message : '';
          if (message === '') throw new HttpError(422, 'message is required');
          if (typeof body.content !== 'string') throw new HttpError(422, 'content is required');
          const bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
          const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
          const tip = repo.refs.get(`refs/heads/${branch}`);
          const flat = tip === undefined ? new Map<string, { mode: string; sha: string }>() : flattenTree(repo, treeOfCommit(repo, tip) ?? '');
          const existing = flat.get(contentPath);
          const sha = body.sha;
          if (sha !== undefined) {
            if (existing === undefined || existing.sha !== sha) throw new HttpError(409, 'sha does not match the current blob');
          } else if (existing !== undefined) {
            throw new HttpError(422, 'sha was not supplied and the file already exists');
          }
          const isUpdate = existing !== undefined;
          const blobSha = putObject(repo, 'blob', bytes);
          flat.set(contentPath, { mode: '100644', sha: blobSha });
          const treeSha = buildTree(repo, flat);
          const commitSha = makeCommitObject(repo, { tree: treeSha, parents: tip === undefined ? [] : [tip], message, author: store.login });
          repo.refs.set(`refs/heads/${branch}`, commitSha);
          repo.updated_at = nowIso();
          sendJson(res, isUpdate ? 200 : 201, {
            content: contentEntryJson(repo, contentPath, { kind: 'file', sha: blobSha, size: bytes.length }, base, branch),
            commit: commitJson(repo, commitSha, message, base),
          });
          return true;
        }
        if (method === 'DELETE') {
          if (contentPath === '') throw new HttpError(422, 'path is required');
          const body = await readJsonBody(req);
          const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${contentPath}`;
          const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
          const tip = repo.refs.get(`refs/heads/${branch}`);
          if (tip === undefined) throw new HttpError(404, 'Not Found');
          const treeSha = treeOfCommit(repo, tip);
          if (treeSha === null) throw new HttpError(404, 'Not Found');
          const flat = flattenTree(repo, treeSha);
          const existing = flat.get(contentPath);
          if (existing === undefined) throw new HttpError(404, 'Not Found');
          if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.sha) {
            throw new HttpError(409, 'sha does not match the current blob');
          }
          flat.delete(contentPath);
          const newTree = buildTree(repo, flat);
          const commitSha = makeCommitObject(repo, { tree: newTree, parents: [tip], message, author: store.login });
          repo.refs.set(`refs/heads/${branch}`, commitSha);
          repo.updated_at = nowIso();
          sendJson(res, 200, { content: null, commit: commitJson(repo, commitSha, message, base) });
          return true;
        }
        throw new HttpError(404, 'Not Found');
      }

      if (tail[0] === 'labels' && tail.length === 1) {
        if (method === 'GET') {
          sendJson(res, 200, repo.labels.map((label) => labelJson(label, base, repo)));
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const name = typeof body.name === 'string' ? body.name : '';
          if (name === '') throw new HttpError(422, 'name is required');
          if (repo.labels.some((label) => label.name === name)) throw new HttpError(422, 'Label already exists');
          const label: Label = {
            name,
            color: typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed',
            description: typeof body.description === 'string' ? body.description : '',
          };
          repo.labels.push(label);
          sendJson(res, 201, labelJson(label, base, repo));
          return true;
        }
        throw new HttpError(404, 'Not Found');
      }

      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            const sort = url.searchParams.get('sort') ?? 'created';
            const direction = url.searchParams.get('direction') ?? 'desc';
            let list = [...repo.issues];
            if (state === 'open') list = list.filter((issue) => issue.state === 'open');
            else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
            else if (state !== 'all') throw new HttpError(422, `Invalid state '${state}'`);
            if (sort === 'created' || sort === 'updated') {
              list.sort((a, b) => {
                const diff = issueSeqOf(repo, a.number) - issueSeqOf(repo, b.number);
                return direction === 'asc' ? diff : -diff;
              });
            }
            const { page, perPage } = pageParams(url);
            const link = pageLinkHeader(req, url, page, perPage, list.length);
            sendJson(res, 200, paginate(list, page, perPage).map((issue) => issueJson(issue, repo, base)), link === null ? {} : { link });
            return true;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const issue = createIssueInRepo(store, repo, body);
            sendJson(res, 201, issueJson(issue, repo, base));
            return true;
          }
          throw new HttpError(404, 'Not Found');
        }
        const issueNumber = Number.parseInt(tail[1] as string, 10);
        if (!Number.isInteger(issueNumber)) throw new HttpError(404, 'Not Found');
        if (tail.length === 2) {
          const issue = repo.issues.find((entry) => entry.number === issueNumber);
          if (issue === undefined) throw new HttpError(404, 'Not Found');
          if (method === 'GET') {
            sendJson(res, 200, issueJson(issue, repo, base));
            return true;
          }
          if (method === 'PATCH') {
            const body = await readJsonBody(req);
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (Array.isArray(body.labels)) {
              const names: string[] = [];
              for (const entry of body.labels) {
                if (typeof entry === 'string') names.push(entry);
                else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
                  names.push((entry as Record<string, unknown>).name as string);
                }
              }
              for (const labelName of names) {
                if (!repo.labels.some((label) => label.name === labelName)) throw new HttpError(422, `Label '${labelName}' does not exist`);
              }
              issue.labels = names.map((labelName) => ({ name: labelName }));
            }
            issue.updated_at = nowIso();
            sendJson(res, 200, issueJson(issue, repo, base));
            return true;
          }
          throw new HttpError(404, 'Not Found');
        }
        if (tail[2] === 'comments' && tail.length === 3) {
          if (method === 'GET') {
            const issue = repo.issues.find((entry) => entry.number === issueNumber);
            if (issue === undefined) throw new HttpError(404, 'Not Found');
            sendJson(res, 200, listIssueComments(repo, issueNumber).map((comment) => commentJson(comment, repo, issueNumber, base)));
            return true;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const comment = addIssueComment(store, repo, issueNumber, body.body);
            sendJson(res, 201, commentJson(comment, repo, issueNumber, base));
            return true;
          }
          throw new HttpError(404, 'Not Found');
        }
        throw new HttpError(404, 'Not Found');
      }

      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            let list = [...repo.pulls];
            if (state === 'open') list = list.filter((pr) => pr.state === 'open');
            else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
            else if (state !== 'all') throw new HttpError(422, `Invalid state '${state}'`);
            list.sort((a, b) => b.number - a.number);
            const { page, perPage } = pageParams(url);
            const link = pageLinkHeader(req, url, page, perPage, list.length);
            sendJson(res, 200, paginate(list, page, perPage).map((pr) => pullJson(repo, pr, base)), link === null ? {} : { link });
            return true;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const pr = createPullInRepo(store, repo, body);
            sendJson(res, 201, pullJson(repo, pr, base));
            return true;
          }
          throw new HttpError(404, 'Not Found');
        }
        const pullNumber = Number.parseInt(tail[1] as string, 10);
        if (!Number.isInteger(pullNumber)) throw new HttpError(404, 'Not Found');
        if (tail.length === 2) {
          if (method !== 'GET') throw new HttpError(404, 'Not Found');
          const pr = repo.pulls.find((entry) => entry.number === pullNumber);
          if (pr === undefined) throw new HttpError(404, 'Not Found');
          sendJson(res, 200, pullJson(repo, pr, base));
          return true;
        }
        if (tail[2] === 'files' && tail.length === 3) {
          if (method !== 'GET') throw new HttpError(404, 'Not Found');
          const pr = repo.pulls.find((entry) => entry.number === pullNumber);
          if (pr === undefined) throw new HttpError(404, 'Not Found');
          const files = pullFiles(repo, pr).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            blob_url: `${base}/${owner}/${name}/blob/${encodeURIComponent(pr.head.ref)}/${encodePath(file.filename)}`,
            raw_url: `${base}/${owner}/${name}/raw/${encodeURIComponent(pr.head.ref)}/${encodePath(file.filename)}`,
            contents_url: `${base}/api/v3/repos/${owner}/${name}/contents/${encodePath(file.filename)}`,
          }));
          sendJson(res, 200, files);
          return true;
        }
        if (tail[2] === 'merge' && tail.length === 3) {
          if (method !== 'PUT') throw new HttpError(404, 'Not Found');
          await readJsonBody(req);
          const { pr, sha } = mergePullInRepo(store, repo, pullNumber);
          sendJson(res, 200, { sha, merged: true, message: `Pull request #${pr.number} successfully merged` });
          return true;
        }
        throw new HttpError(404, 'Not Found');
      }

      throw new HttpError(404, 'Not Found');
    }

    throw new HttpError(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return true;
    }
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
