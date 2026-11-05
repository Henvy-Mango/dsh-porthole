import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { withProxy, request, websocket, listen } from './helpers/proxy.mjs';
import { BridgeLiteService } from '../lib/service.js';

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

test('本地回环是可信基线：自定义数组/空数组都仍信任回环前缀，跳转不用内部域名端口', async () => {
  // All cases: loopback peer is always trusted, so /dsh is accepted regardless of config.
  for (const [trustedProxies, location] of [[undefined, '/dsh/'], [['10.9.9.9'], '/dsh/'], [[], '/dsh/']]) {
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

test('实时通道与本机令牌：WS Origin 校验、SSE 首帧、loopback-token 来源限制', async () => {
  await withProxy({ authConfig, origins: ['http://panel.example.test'] }, async ({ port, auth, upstream }) => {
    const path = '/plugins/events?cursor=7';
    // 未登录 WS 拒绝
    assert.equal(await websocket(port, path), 401);
    const session = { Cookie: `dsh_portal_auth=${auth.createSession()}` };
    // 带会话后：陌生 Origin 拒绝；同源（nginx HTTPS）/ 白名单 / 无 Origin 放行
    assert.equal(await websocket(port, path, { ...session, Origin: 'http://evil.example' }), 403);
    assert.equal(await websocket(port, path, { ...session, Origin: 'https://portal.example.test' }), 101);
    assert.equal(await websocket(port, path, { ...session, Origin: 'http://panel.example.test' }), 101);
    assert.equal(await websocket(port, path, session), 101);
    assert.equal(upstream.seen.at(-1).url, path);

    // 已登录 SSE 及时收到首帧，内部路径只剥一次、query 保留
    const front = await relay(port, '/dsh');
    try {
      const event = await request(front.port, '/dsh/bsk-observation/events?thumbnails=0', { headers: session, stream: true });
      assert.equal(event.status, 200);
      assert.equal(event.headers['content-type'], 'text/event-stream');
      assert.match(event.body, /data: ready\n\n/);
      assert.equal(upstream.seen.at(-1).url, '/bsk-observation/events?thumbnails=0');
    } finally {
      await front.close();
    }

    // loopback-token 只给白名单来源签发
    const allowed = await request(port, '/__dsh_porthole__/loopback-token', {
      headers: { Host: '127.0.0.1', Origin: 'http://panel.example.test' },
    });
    assert.equal(allowed.status, 200);
    assert.ok(JSON.parse(allowed.body).adminToken);
    const denied = await request(port, '/__dsh_porthole__/loopback-token', {
      headers: { Host: '127.0.0.1', Origin: 'http://evil.example' },
    });
    assert.equal(denied.status, 403);
    // service.allowedOrigins 必须覆盖 localhost + DSH 原生端口（本机免密入口）
    assert.ok(new BridgeLiteService({ dshPort: 3080, port: 3082 }).allowedOrigins().includes('http://localhost:3080'));
  });
});

test('桌面壳 + 绑具体网卡：Host 命中绑定地址时签发本机令牌，普通网页来源仍拒绝', async () => {
  const { listAllLanIPv4 } = await import('../lib/net.js');
  const lanIp = listAllLanIPv4()[0]?.address;
  if (!lanIp) { console.log('skip: no LAN IPv4'); return; }
  const { LiteProxy } = await import('../lib/proxy.js');
  const { AuthManager } = await import('../lib/auth/manager.js');
  const { DESKTOP_APP_ORIGIN } = await import('../lib/proxy.js');
  const auth = new AuthManager({ config: { enabled: true } });
  // Bind to the concrete LAN address, mimicking a user who set host=LAN IP.
  const proxy = new LiteProxy({ listenPort: 0, targetPort: 1, authManager: auth,
    host: lanIp, allowedOrigins: () => [`http://${lanIp}:3082`, DESKTOP_APP_ORIGIN] });
  await proxy.start();
  const url = '/__dsh_porthole__/loopback-token';
  // Connect to the bound LAN address (the shared request() helper hardcodes 127.0.0.1).
  const hit = (headers) => new Promise((resolve) => {
    const req = httpRequest({ host: lanIp, port: proxy.listenPort, path: url, method: 'GET', agent: false, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
  try {
    // 桌面壳来源 + Host=绑定地址 → 签发
    const okRes = await hit({ Host: `${lanIp}:${proxy.listenPort}`, Origin: DESKTOP_APP_ORIGIN });
    assert.equal(okRes.status, 200);
    assert.ok(JSON.parse(okRes.body).adminToken);
    // 普通网页来源（同 LAN 地址的 http origin）+ Host=绑定地址 → 仍拒绝（这不是本机特征）
    const webRes = await hit({ Host: `${lanIp}:${proxy.listenPort}`, Origin: `http://${lanIp}:${proxy.listenPort}` });
    assert.equal(webRes.status, 403);
    // 桌面壳来源但 Host 不匹配绑定地址 → 拒绝
    const badHost = await hit({ Host: `evil.example:${proxy.listenPort}`, Origin: DESKTOP_APP_ORIGIN });
    assert.equal(badHost.status, 403);
  } finally {
    await proxy.stop();
    auth.dispose();
  }
});
