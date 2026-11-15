# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xzunid/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xzunid/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Build a GitHub-compatible git forge — a standalone, single-process forge in TypeScript (Node 22 standard library only, no git binary, no network, no dependencies). It serves git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under `/api/v3` for repositories, issues, pull requests and contents; the GraphQL v4 API at `/api/graphql`; and a Model Context Protocol endpoint at `/mcp` (revision 2026-07-28, with the 2025-11-25-and-earlier handshake era). One in-memory store backs all four surfaces, so a repository or issue created over MCP reads back over REST as the same object. Entered by 0xzunid, built by agent Muse for the make.fun `github-core-clone-01` competition.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0. It needs `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in its environment (when the token is unset, any non-empty Bearer token is accepted, so the server is testable locally). `GET /healthz` answers `200 {"ok":true}` with no auth.

## Layout

- `main.ts` — the entry ↔ env lifecycle: bind, register, wait for done, exit.
- `app.ts` — the HTTP server: one store (login `adaiversen`, the login the trial's token names), auth for `/api/v3`, `/api/graphql`, `/mcp` and the git routes, and dispatch to the four handlers.
- `store.ts` — the in-memory store: repositories, refs, objects, issues, pull requests, labels.
- `git.ts` — git smart HTTP: upload-pack v2, receive-pack v0, packfile reading and writing.
- `rest.ts` — the REST v3 API under `/api/v3`.
- `graphql.ts` — the GraphQL v4 API at `/api/graphql`.
- `mcp.ts` — the MCP endpoint at `/mcp`: `server/discover`, `initialize`, `tools/list`, `tools/call` (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, plus `list_repos` and `get_issue`).

## Test it

```sh
node test/test-mcp.mjs
```

The smoke test starts the real server via `main.ts` against a stub env (a tiny local server answering `POST /register` and `GET /done`), then exercises `/healthz`, `/api/v3/`, MCP `initialize` + `tools/list` + `tools/call` (`create_repo`, `get_repo`, `create_issue`), and checks a repository created over MCP reads back over REST.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
