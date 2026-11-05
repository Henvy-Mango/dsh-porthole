import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { withProxy, request, websocket, listen } from './helpers/proxy.mjs';

const authConfig = { enabled: true, allowLoopback: false };
const cookieOf = (response) => response.headers['set-cookie'][0];

// Minimal nginx stand-in: strip the external mount and overwrite its header.
async function relay(port, prefix) {
  return listen(createServer((req, res) => {
    const upstream = httpRequest({ host: '127.0.0.1', port, method: req.method,
      path: req.url.slice(prefix.length) || '/', agent: false,
      headers: { ...req.headers, 'x-forwarded-prefix': prefix },
    }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }));
}

test('只接受可信物理代理声明的前缀，跳转不使用内部 HTTP 域名或端口', async () => {
  for (const [trustedProxies, location] of [[undefined, '/dsh/'], [['10.9.9.9'], '/']]) {
    await withProxy({ authConfig: { enabled: true }, trustedProxies }, async ({ port }) => {
      const headers = { Accept: 'text/html', 'X-Forwarded-Prefix': '/dsh',
        Host: 'portal.example:9999', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '10.9.9.9' };
      const response = await request(port, '/deep/page', { headers });
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, location);
      if (trustedProxies === undefined) {
        assert.equal((await request(port, '/', { headers: { Host: '127.0.0.1' } })).status, 200);
        assert.equal((await request(port, '/')).status, 401, '反代域名不能借用回环免密');
        assert.equal((await request(port, '/', { headers: { 'X-Forwarded-Prefix': '//evil.com' } })).status, 400);
      }
    });
  }
});

test('根路径和子目录均可登录、访问、扫码直通及登出，Cookie 保持对应路径', async () => {
  await withProxy({ authConfig, password: 'guest-pass' }, async ({ port, auth }) => {
    for (const prefix of ['', '/dsh']) {
      const front = await relay(port, prefix);
      const root = `${prefix}/`;
      try {
        const page = await request(front.port, root);
        assert.equal(page.status, 401);
        assert.match(page.body, /fetch\('\.\/__dsh_porthole__\/login'/);
        assert.match(page.body, /location\.replace\("\.\/"\)/);
        const login = await request(front.port, `${root}__dsh_porthole__/login`, { method: 'POST', body: { password: 'guest-pass' } });
        assert.equal(login.status, 200);
        assert.ok(cookieOf(login).split('; ').includes(`Path=${prefix || '/'}`));
        const headers = { Cookie: cookieOf(login).split(';')[0] };
        assert.equal((await request(front.port, root, { headers })).status, 200);
        const token = await request(front.port, `${root}?auth=${auth.secretToken}&keep=1`);
        assert.equal(token.status, 302);
        assert.equal(token.headers.location, `${root}?keep=1`);
        const logout = await request(front.port, `${root}__dsh_porthole__/logout`, { method: 'POST', headers });
        assert.match(cookieOf(logout), /Max-Age=0/);
        assert.equal((await request(front.port, root, { headers })).status, 401);
      } finally {
        await front.close();
      }
    }
  });
});

test('未登录的页面导航回入口，API、SSE 和写请求返回 JSON 401', async () => {
  await withProxy({ authConfig }, async ({ port }) => {
    const prefix = { 'X-Forwarded-Prefix': '/dsh' };
    const page = await request(port, '/deep/page', { headers: { ...prefix, Accept: 'text/html' } });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/dsh/');
    for (const [path, method, accept] of [
      ['/api/session/list', 'GET', 'application/json'],
      ['/bsk-observation/events', 'GET', 'text/event-stream'],
      ['/deep/page', 'POST', 'text/html'],
    ]) {
      const response = await request(port, path, { method, headers: { ...prefix, Accept: accept } });
      assert.equal(response.status, 401);
      assert.match(response.headers['content-type'], /application\/json/);
      assert.equal(response.headers.location, undefined);
    }
  });
});

test('实时通道未登录拒绝；登录后 WebSocket 升级、SSE 收到首帧', async () => {
  await withProxy({ authConfig }, async ({ port, auth, upstream }) => {
    const path = '/plugins/events?cursor=7';
    assert.equal(await websocket(port, path), 401);
    const headers = { Cookie: `dsh_portal_auth=${auth.createSession()}` };
    assert.equal(await websocket(port, path, headers), 101);
    assert.equal(upstream.seen.at(-1).url, path);
    const front = await relay(port, '/dsh');
    try {
      const event = await request(front.port, '/dsh/bsk-observation/events?thumbnails=0', { headers, stream: true });
      assert.equal(event.status, 200);
      assert.equal(event.headers['content-type'], 'text/event-stream');
      assert.match(event.body, /data: ready\n\n/);
      assert.equal(upstream.seen.at(-1).url, '/bsk-observation/events?thumbnails=0');
    } finally {
      await front.close();
    }
  });
});
