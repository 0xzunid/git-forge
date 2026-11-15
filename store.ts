// Shared in-memory store for the forge: repositories, git objects, issues, pulls, labels.
// No disk I/O, no network. Every other module imports this exact interface.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Label[];
  nextIssue: number;
  nextPull: number;
}

export interface Store {
  login: string;
  repos: Map<string, Repo>;
  nextGlobalId: number;
  getRepo(owner: string, name: string): Repo | undefined;
  createRepo(owner: string, name: string, description?: string): Repo;
  deleteRepo(owner: string, name: string): void;
  allocId(): number;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createStore(login: string): Store {
  const repos = new Map<string, Repo>();
  let nextGlobalId = 1;

  const store: Store = {
    login,
    repos,
    get nextGlobalId() {
      return nextGlobalId;
    },
    set nextGlobalId(value: number) {
      nextGlobalId = value;
    },

    getRepo(owner: string, name: string): Repo | undefined {
      return repos.get(repoKey(owner, name));
    },

    createRepo(owner: string, name: string, description?: string): Repo {
      const existing = repos.get(repoKey(owner, name));
      if (existing) return existing;
      const now = new Date().toISOString();
      const repo: Repo = {
        id: nextGlobalId++,
        name,
        full_name: repoKey(owner, name),
        owner: { login: owner },
        description: description ?? '',
        private: false,
        default_branch: 'main',
        created_at: now,
        updated_at: now,
        // A new repo starts with NO commits and NO refs: the default branch
        // is 'main' but unborn until the first push / contents commit.
        refs: new Map<string, string>(),
        objects: new Map<string, GitObject>(),
        issues: [],
        pulls: [],
        labels: [],
        nextIssue: 1,
        nextPull: 1,
      };
      repos.set(repoKey(owner, name), repo);
      return repo;
    },

    deleteRepo(owner: string, name: string): void {
      repos.delete(repoKey(owner, name));
    },

    allocId(): number {
      return nextGlobalId++;
    },
  };

  return store;
}
