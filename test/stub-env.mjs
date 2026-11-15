// Stub contest env for the smoke test: the two routes main.ts talks to.
//   POST /register {"port": N} -> 200 (records the port)
//   GET  /done                -> {"done": false} until setDone(true), then {"done": true}
// main.ts polls /done until it answers true, then closes its server and exits 0.
// Run only from test/test-mcp.mjs; it binds 127.0.0.1 on an ephemeral port.
import { createServer } from 'node:http';

/** Start the stub env; resolves {url, port, registered, setDone, close}. */
export function startStubEnv() {
  let done = false;
  let registeredPort = null;
  const server = createServer((req, res) => {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === 'POST' && req.url === '/register') {
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
      });
      req.on('end', () => {
        try {
          registeredPort = JSON.parse(text).port ?? null;
        } catch {
          registeredPort = null;
        }
        send(200, {});
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/done') {
      send(200, { done });
      return;
    }
    send(404, { message: 'Not Found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        registered: () => registeredPort,
        setDone: (value) => {
          done = value === true;
        },
        close: () => new Promise((doneClosing) => server.close(() => doneClosing())),
      });
    });
  });
}
