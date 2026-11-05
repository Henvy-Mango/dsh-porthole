import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiteProxy } from '../../lib/proxy.js';
import { AuthManager } from '../../lib/auth/manager.js';

export async function listen(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function withProxy(opts, run) {
  const home = await mkdtemp(join(tmpdir(), 'porthole-test-'));
  await writeFile(join(home, '.credentials.yaml'),
    `client-connection/browser-session:\n  payload:\n    secret: ${Buffer.alloc(32, 7).toString('base64url')}\n`);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: opts.authConfig ?? { enabled: false }, sessionsFile: join(home, 'sessions.json') });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    if (opts.respond) return opts.respond(req, res);
    if (req.url.startsWith('/bsk-observation/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ready\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html>upstream:${req.url}</html>`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  let upstream;
  let proxy;
  try {
    if (opts.password) await auth.setPassword(opts.password);
    upstream = await listen(server);
    proxy = new LiteProxy({ listenPort: 0, targetPort: upstream.port, authManager: auth,
      trustedProxies: opts.trustedProxies, allowedOrigins: () => opts.origins ?? ['http://127.0.0.1:3082'] });
    await proxy.start();
    await run({ proxy, port: proxy.listenPort, auth, upstream: { ...upstream, seen } });
  } finally {
    await proxy?.stop();
    auth.dispose();
    await upstream?.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

export function request(port, path, { method = 'GET', headers = {}, body, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { Host: 'portal.example.test', ...(payload === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      }), ...headers },
    }, (res) => {
      const chunks = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buffer.toString(), buffer });
      };
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (stream && Buffer.concat(chunks).includes('\n\n')) {
          finish();
          res.destroy();
          req.destroy();
        }
      });
      res.on('end', finish);
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error(`HTTP timeout: ${path}`)));
    req.on('error', reject);
    req.end(payload);
  });
}

export function websocket(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false, headers: {
      Host: 'portal.example.test', Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'), ...headers,
    } });
    req.on('upgrade', (res, socket) => { resolve(res.statusCode); socket.destroy(); });
    req.on('response', (res) => { resolve(res.statusCode); res.resume(); });
    req.setTimeout(2000, () => req.destroy(new Error(`WebSocket timeout: ${path}`)));
    req.on('error', reject);
    req.end();
  });
}
