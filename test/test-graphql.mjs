// GraphQL v4 conformance self-test: mirrors sdk/conformance/checks-graphql.ts.
// Run: node --experimental-strip-types test/test-graphql.mjs
import { startServer, counter, client, prepareRepo, b64 } from './harness.mjs';

const OWNER = 'octocat';
const t = counter();
const { server, baseUrl } = await startServer(OWNER);
const api = client(baseUrl);
const anon = client(baseUrl, null);

async function gql(query, variables = {}, useAnon = false) {
  const c = useAnon ? anon : api;
  const r = await c.post('/api/graphql', { query, variables });
  return { status: r.status, body: r.json, text: r.text };
}

const VIEWER_LOGIN = `query ViewerLogin { viewer { login } }`;
const REPOSITORY_FIELDS = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id databaseId name
    owner { login }
    defaultBranchRef { name }
    viewerPermission hasIssuesEnabled
  }
}`;
const ISSUE_FIELDS = `query Issue_fields {
  Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } }
}`;
const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
  Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } }
}`;
const SEARCH_TYPE_ENUM = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } }
}`;
const OPEN_ISSUES = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title state id }
    }
  }
}`;
const ISSUE_BY_NUMBER = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title state id body }
  }
}`;
const CREATE_ISSUE = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) { issue { number id } }
}`;
const CLOSE_ISSUE = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) { issue { number id state } }
}`;
const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } }
  }
}`;
const PULL_REQUEST_FILES = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { number files(first: 10) { nodes { path } } }
  }
}`;
const PULL_REQUEST_ID = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id number } }
}`;
const CREATE_PULL_REQUEST = `mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } }
}`;
const MERGE_PULL_REQUEST = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { pullRequest { number merged state } }
}`;
const ADD_COMMENT = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) { commentEdge { node { id body } } }
}`;
const INVALID_FIELD = `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`;
const NODE_REPOSITORY = `query NodeRepository($id: ID!) {
  node(id: $id) { id ... on Repository { name nameWithOwner } }
}`;
const ISSUES_PAGE = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } }
  }
}`;

try {
  // --- viewer + repository ----------------------------------------------------
  let g = await gql(VIEWER_LOGIN);
  t.check('viewer login', g.status === 200 && g.body?.data?.viewer?.login === OWNER, g.text.slice(0, 200));

  const repo = await prepareRepo(api, OWNER, 'seed-graphql');
  const repoName = repo.name;
  g = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: repoName });
  const rf = g.body?.data?.repository;
  t.check('repository fields', g.status === 200 && (g.body?.errors ?? []).length === 0 && rf?.name === repoName && rf?.owner?.login === OWNER && rf?.defaultBranchRef?.name === 'main' && rf?.viewerPermission === 'ADMIN' && rf?.hasIssuesEnabled === true && typeof rf?.databaseId === 'number', g.text.slice(0, 300));
  t.check('repository id opaque', typeof rf?.id === 'string' && rf.id !== '' && rf.id !== String(rf.databaseId), String(rf?.id));
  const repoId = rf.id;

  // --- introspection ------------------------------------------------------------
  g = await gql(ISSUE_FIELDS);
  const issueFields = (g.body?.data?.Issue?.fields ?? []).map((f) => f.name);
  t.check('Issue introspection', ['id', 'number', 'title', 'state', 'body'].every((f) => issueFields.includes(f)), issueFields.join(','));

  g = await gql(TYPE_FIELDS);
  const prFields = (g.body?.data?.PullRequest?.fields ?? []).map((f) => f.name);
  const repoFields = (g.body?.data?.Repository?.fields ?? []).map((f) => f.name);
  t.check('PullRequest introspection', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFields.includes(f)), prFields.join(','));
  t.check('Repository introspection', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoFields.includes(f)), repoFields.join(','));

  g = await gql(SEARCH_TYPE_ENUM);
  const enumNames = (g.body?.data?.SearchType?.enumValues ?? []).map((f) => f.name);
  t.check('SearchType enum includes ISSUE', enumNames.includes('ISSUE'), enumNames.join(','));

  // --- issues: fixture 3 open + 1 closed ---------------------------------------
  const mkIssue = (title) => api.post(`/api/v3/repos/${OWNER}/${repoName}/issues`, { title, body: 'seeded body' });
  const o1 = await mkIssue('gql open 1');
  const o2 = await mkIssue('gql open 2');
  const o3 = await mkIssue('gql open 3');
  const cl = await mkIssue('gql closed');
  await api.patch(`/api/v3/repos/${OWNER}/${repoName}/issues/${cl.json.number}`, { state: 'closed' });
  const openNums = [o1.json.number, o2.json.number, o3.json.number];

  g = await gql(OPEN_ISSUES, { owner: OWNER, name: repoName, first: 10 });
  const nodes = g.body?.data?.repository?.issues?.nodes ?? [];
  const nums = nodes.map((n) => n.number);
  t.check('open issues desc, closed excluded', g.status === 200 && nums.length === 3 && nums[0] > nums[1] && nums[1] > nums[2] && !nums.includes(cl.json.number) && openNums.every((n) => nums.includes(n)) && nodes.every((n) => n.state === 'OPEN' && typeof n.id === 'string' && n.id !== ''), JSON.stringify(nums));

  g = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: repoName, number: o1.json.number });
  const byNum = g.body?.data?.repository?.issue;
  t.check('issue by number', byNum?.number === o1.json.number && byNum?.state === 'OPEN' && byNum?.title === 'gql open 1' && byNum?.body === 'seeded body' && typeof byNum?.id === 'string', g.text.slice(0, 300));

  // --- create / close issue mutations -------------------------------------------
  g = await gql(CREATE_ISSUE, { input: { repositoryId: repoId, title: 'created over graphql', body: 'seeded body' } });
  const createdNum = g.body?.data?.createIssue?.issue?.number;
  t.check('createIssue mutation', typeof createdNum === 'number' && typeof g.body?.data?.createIssue?.issue?.id === 'string', g.text.slice(0, 300));
  let r = await api.get(`/api/v3/repos/${OWNER}/${repoName}/issues/${createdNum}`);
  t.check('createIssue visible over REST', r.status === 200 && r.json.title === 'created over graphql' && r.json.state === 'open');

  const toClose = await mkIssue('closed over graphql');
  g = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: repoName, number: toClose.json.number });
  const closeId = g.body?.data?.repository?.issue?.id;
  g = await gql(CLOSE_ISSUE, { input: { issueId: closeId } });
  t.check('closeIssue mutation', g.body?.data?.closeIssue?.issue?.number === toClose.json.number && g.body?.data?.closeIssue?.issue?.state === 'CLOSED', g.text.slice(0, 300));
  r = await api.get(`/api/v3/repos/${OWNER}/${repoName}/issues/${toClose.json.number}`);
  t.check('closeIssue visible over REST', r.json.state === 'closed');

  // --- pull requests: branches via REST git/refs + contents ----------------------
  const basePath = `/api/v3/repos/${OWNER}/${repoName}`;
  async function pushBranch(branch, file, content) {
    const ref = await api.post(`${basePath}/git/refs`, { ref: `refs/heads/${branch}`, sha: repo.initialSha });
    if (ref.status !== 201) throw new Error(`branch ${branch}: ${ref.status} ${ref.text}`);
    const put = await api.put(`${basePath}/contents/${file}`, { message: `add ${file}`, content: b64(content), branch });
    if (put.status !== 201) throw new Error(`put ${file}: ${put.status} ${put.text}`);
  }
  await pushBranch('pr-head-2', 'feature.txt', 'feature content\n');
  const prRes = await api.post(`${basePath}/pulls`, { title: 'fixture pull request', body: 'seeded body', head: 'pr-head-2', base: 'main' });
  if (prRes.status !== 201) throw new Error(`create PR: ${prRes.status} ${prRes.text}`);
  const prNum = prRes.json.number;

  g = await gql(PULL_REQUESTS, { owner: OWNER, name: repoName, first: 5 });
  const prNodes = g.body?.data?.repository?.pullRequests?.nodes ?? [];
  const prNode = prNodes.find((n) => n.number === prNum);
  t.check('pullRequests list', prNode?.headRefName === 'pr-head-2' && prNode?.baseRefName === 'main' && prNode?.state === 'OPEN' && ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(prNode?.mergeable), JSON.stringify(prNodes));

  g = await gql(PULL_REQUEST_FILES, { owner: OWNER, name: repoName, number: prNum });
  const paths = (g.body?.data?.repository?.pullRequest?.files?.nodes ?? []).map((n) => n.path);
  t.check('pullRequest files', g.body?.data?.repository?.pullRequest?.number === prNum && paths.includes('feature.txt'), JSON.stringify(paths));

  // createPullRequest mutation on a fresh branch
  await pushBranch('pr-create', 'create.txt', 'create content\n');
  g = await gql(CREATE_PULL_REQUEST, { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'pr-create', title: 'created over graphql' } });
  const gqlPr = g.body?.data?.createPullRequest?.pullRequest;
  t.check('createPullRequest mutation', typeof gqlPr?.number === 'number' && gqlPr?.state === 'OPEN' && gqlPr?.headRefName === 'pr-create' && gqlPr?.baseRefName === 'main', g.text.slice(0, 300));
  r = await api.get(`${basePath}/pulls/${gqlPr.number}`);
  t.check('createPullRequest visible over REST', r.status === 200 && r.json.head.ref === 'pr-create' && r.json.base.ref === 'main');

  // mergePullRequest mutation (SQUASH) on another branch
  await pushBranch('pr-merge', 'merge.txt', 'merge content\n');
  const mergePrRes = await api.post(`${basePath}/pulls`, { title: 'merge pull request', body: 'seeded body', head: 'pr-merge', base: 'main' });
  const mergePrNum = mergePrRes.json.number;
  g = await gql(PULL_REQUEST_ID, { owner: OWNER, name: repoName, number: mergePrNum });
  const mergePrId = g.body?.data?.repository?.pullRequest?.id;
  g = await gql(MERGE_PULL_REQUEST, { input: { pullRequestId: mergePrId, mergeMethod: 'SQUASH' } });
  t.check('mergePullRequest mutation', g.body?.data?.mergePullRequest?.pullRequest?.merged === true, g.text.slice(0, 300));
  r = await api.get(`${basePath}/pulls/${mergePrNum}`);
  t.check('mergePullRequest visible over REST', r.json.merged === true && r.json.state === 'closed');

  // addComment mutation
  const commented = await mkIssue('commented over graphql');
  g = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: repoName, number: commented.json.number });
  const subjectId = g.body?.data?.repository?.issue?.id;
  g = await gql(ADD_COMMENT, { input: { subjectId, body: 'gql comment body' } });
  t.check('addComment mutation', g.body?.data?.addComment?.commentEdge?.node?.body === 'gql comment body' && typeof g.body?.data?.addComment?.commentEdge?.node?.id === 'string', g.text.slice(0, 300));
  r = await api.get(`${basePath}/issues/${commented.json.number}/comments`);
  t.check('addComment visible over REST', r.json.some((c) => c.body === 'gql comment body'));

  // --- invalid field / unauthenticated / node / unknown repo ---------------------
  g = await gql(INVALID_FIELD);
  t.check('invalid field 200 + errors naming it', g.status === 200 && Array.isArray(g.body?.errors) && g.body.errors.some((e) => e.message.includes('noSuchFieldOnViewer')), g.text.slice(0, 300));

  g = await gql(VIEWER_LOGIN, {}, true);
  t.check('unauthenticated 401', g.status === 401, `${g.status} ${g.text.slice(0, 200)}`);

  g = await gql(NODE_REPOSITORY, { id: repoId });
  t.check('node(id) round-trips repo', g.body?.data?.node?.id === repoId && g.body?.data?.node?.name === repoName && g.body?.data?.node?.nameWithOwner === `${OWNER}/${repoName}`, g.text.slice(0, 300));

  g = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: 'seed-graphql-missing' });
  t.check('unknown repository null, no errors', g.status === 200 && g.body?.data?.repository === null && (g.body?.errors ?? []).length === 0, g.text.slice(0, 300));

  // --- batching ------------------------------------------------------------------
  {
    const br = await api.post('/api/graphql', [{ query: VIEWER_LOGIN }, { query: ISSUE_FIELDS }]);
    const arr = br.json;
    t.check('batch two operations in order', br.status === 200 && Array.isArray(arr) && arr.length === 2 && arr[0]?.data?.viewer?.login === OWNER && Array.isArray(arr[1]?.data?.Issue?.fields) && arr[1].data.Issue.fields.length > 0, br.text.slice(0, 300));
  }

  // --- global id stability ---------------------------------------------------------
  {
    const a = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: repoName });
    const b = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: repoName });
    t.check('repo global id stable + opaque', a.body?.data?.repository?.id === b.body?.data?.repository?.id && a.body?.data?.repository?.id !== String(a.body?.data?.repository?.databaseId));
    const ia = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: repoName, number: o1.json.number });
    const ib = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: repoName, number: o1.json.number });
    t.check('issue global id stable + opaque', ia.body?.data?.repository?.issue?.id === ib.body?.data?.repository?.issue?.id && ia.body?.data?.repository?.issue?.id !== String(o1.json.number));
  }

  // --- cursor pagination -------------------------------------------------------------
  {
    const pagesRepo = await prepareRepo(api, OWNER, 'seed-graphql-pages');
    const pageNums = [];
    for (let i = 1; i <= 7; i += 1) {
      const c = await api.post(`/api/v3/repos/${OWNER}/${pagesRepo.name}/issues`, { title: `page ${i}`, body: 'seeded body' });
      pageNums.push(c.json.number);
    }
    const p1 = await gql(ISSUES_PAGE, { owner: OWNER, name: pagesRepo.name, first: 5, after: null });
    const conn1 = p1.body?.data?.repository?.issues;
    t.check('page 1: 5 nodes, hasNextPage, endCursor', (conn1?.nodes ?? []).length === 5 && conn1?.pageInfo?.hasNextPage === true && typeof conn1?.pageInfo?.endCursor === 'string' && conn1.pageInfo.endCursor !== '', JSON.stringify(conn1?.pageInfo));
    const p2 = await gql(ISSUES_PAGE, { owner: OWNER, name: pagesRepo.name, first: 5, after: conn1.pageInfo.endCursor });
    const conn2 = p2.body?.data?.repository?.issues;
    t.check('page 2: 2 nodes, no next page', (conn2?.nodes ?? []).length === 2 && conn2?.pageInfo?.hasNextPage === false, JSON.stringify(conn2?.pageInfo));
    const seen = new Set([...(conn1?.nodes ?? []), ...(conn2?.nodes ?? [])].map((n) => n.number));
    t.check('pages disjoint and complete', seen.size === 7 && pageNums.every((n) => seen.has(n)), JSON.stringify([...seen]));
  }
} catch (err) {
  console.log('HARNESS ERROR', err);
  t.check('no harness error', false, String(err?.stack ?? err));
} finally {
  server.close();
}

const fails = t.summary('GraphQL');
process.exit(fails === 0 ? 0 : 1);
