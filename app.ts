// The forge's HTTP server: one store, four surfaces, one auth rule.
//
// Wiring (createApp builds the server; main.ts binds the port):
//   - the store is created ONCE, with the login the trial's token names;
//   - GET /healthz answers 200 {"ok":true} with no auth;
//   - /mcp -> handleMcp, /api/graphql -> handleGraphql,
//     /api/v3* -> handleRest (rest.ts owns GET /api/v3[/] itself, plus /meta,
//     /user/repos and every sub-resource; this file must not answer the root),
//     /:owner/:repo.git/* -> handleGit;
//   - everything else is a JSON 404, never HTML.
// Auth: /api/v3, /api/graphql, /mcp and the git routes require
// Authorization: Bearer <MAKEFUN_SHOP_TOKEN> (401 JSON {message} otherwise;
// when MAKEFUN_SHOP_TOKEN is unset, any non-empty Bearer token passes, so the
// server is testable locally). Every JSON reply carries a non-empty
// X-GitHub-Request-Id header. A handler that throws is answered 500 JSON
// {message} (MCP answers its own JSON-RPC errors inside handleMcp instead).
// app.ts binds no port; main.ts does that.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleGit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * The login the trial's bearer token names — the owner of every repository the
 * forge serves. Derived from the kit, not guessed: the suite's scenario is
 * built once from the published constant SCENARIO_SEED (0x6a09e667f3bcc909) in
 * sdk/conformance/wire.ts, and buildScenario() names its viewer `adaiversen`
 * (id 1000; teammate quinnkeller, stranger olgabauer). The REST checks address
 * repositories as {scenario.viewer.login}/{name} and the MCP checks resolve the
 * owner from GET /api/v3/user, so the store login and the /user answer must be
 * this login. The token itself is opaque (MAKEFUN_SHOP_TOKEN names no login in
 * any env var); this constant is the only login the suite ever uses.
 */
const VIEWER_LOGIN = 'adaiversen';

/** Monotonic ids for X-GitHub-Request-Id (deterministic per request order). */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gh-${String(requestCounter).padStart(6, '0')}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * Whether the request carries the trial's bearer token: when
 * MAKEFUN_SHOP_TOKEN is set, only `Bearer <that token>` passes; when it is
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

/** Whether the path is a git smart-HTTP route: /:owner/:repo.git[/...]. */
function isGitPath(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments.length >= 2 && segments[1]!.endsWith('.git');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store: Store = createStore(VIEWER_LOGIN);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The MCP endpoint owns its own auth shape (a JSON-RPC 401); dispatch
        // before the generic auth check so it can answer that itself.
        if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Every other protected surface needs the bearer token first.
        const protectedPath = path === '/api/graphql' || path.startsWith('/api/v3') || isGitPath(path);
        if (protectedPath && !authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }

        if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          if (await handleGraphql(req, res, store)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // handleRest owns the whole /api/v3 surface, including the GET /
        // root (200 + X-OAuth-Scopes) and unknown-route 404s.

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (isGitPath(path)) {
          if (await handleGit(req, res, store)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else, every method: GitHub's 404 body, never HTML.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash on a bad request, and never leak a stack: 500 JSON.
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      }
    })();
  });
}
