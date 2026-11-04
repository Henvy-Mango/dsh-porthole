// test/core.test.mjs —— 核心链路：反向代理 / WebSocket / 门禁 / 二级目录
//
// 这是插件的存在理由，任何一条坏了都等于不可用：
//   1. HTTP 原样转发 + 注入 DSH 原生 loopback cookie（不注入则一律 401）
//   2. WebSocket 升级转发（DSH 实时通道全靠它）
//   3. 访问门禁：未认证 401、密码登录、扫码令牌直通
//   4. 二级目录：前缀剥离、严格收敛、对外地址带前缀与尾斜杠
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { LiteProxy, ENDPOINT_PREFIX, loopbackHeaders, sanitizeProxyHeaders } from '../lib/proxy.js';
import { AuthManager } from '../lib/auth/manager.js';

// ---------- 夹具 ----------

/** 假 DSH：记录收到的头，并提供一个 WS 回显端点。 */
function startUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body>upstream:${req.url}</body></html>`);
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    socket.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })));
}

/** 起一个真实代理（可选认证配置与挂载前缀）。 */
async function withProxy(opts, fn) {
  const up = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'core-'));
  await writeFile(join(home, '.credentials.yaml'),
    `client-connection/browser-session:\n  payload:\n    secret: ${Buffer.alloc(32, 7).toString('base64url')}\n`);

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: opts.authConfig ?? { enabled: false }, sessionsFile: join(home, 's.json') });
  if (opts.password) await auth.setPassword(opts.password);
  const proxy = new LiteProxy({
    listenPort: 0, targetPort: up.port, authManager: auth,
    basePath: opts.basePath ?? '',
    allowedOrigins: () => opts.origins ?? ['http://127.0.0.1:3082'],
  });
  await proxy.start();
  try {
    await fn({ proxy, auth, upstream: up });
  } finally {
    await proxy.stop();
    auth.dispose();
    up.server.close();
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
}

function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getBuf(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ---------- 1. 转发 ----------

test('转发：页面原样透传，并注入 loopback cookie + 改写 Host', async () => {
  await withProxy({}, async ({ proxy, upstream }) => {
    const res = await get(proxy.listenPort, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /upstream:\//, '响应体必须原样透传，不做 HTML 注入');

    const last = upstream.seen.at(-1);
    assert.equal(last.headers.host, `127.0.0.1:${upstream.port}`, 'Host 必须改写为回环 authority');
    assert.match(last.headers.cookie || '', /dsh-auth-/, '必须注入 DSH 原生会话 cookie');
  });
});

test('转发：hop-by-hop 头被剔除，Referer 只换 origin 保留路径', () => {
  const out = sanitizeProxyHeaders({ 'content-type': 'text/html', connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-keep': '1' });
  assert.equal(out.connection, undefined);
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(out['x-keep'], '1');

  const { headers } = loopbackHeaders({ host: '192.168.1.5:3082', referer: 'http://192.168.1.5:3082/a?b=1', 'accept-encoding': 'gzip' }, 3080);
  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.referer, 'http://127.0.0.1:3080/a?b=1');
  // 必须保留：交给 DSH 自行压缩（实测主 bundle 941 KB → 320 KB）
  assert.equal(headers['accept-encoding'], 'gzip', '不得剥掉 accept-encoding');
});

test('转发：WebSocket 升级成功；未认证时被 401 拒绝', async () => {
  await withProxy({ password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    auth.allowLoopback = false; // 模拟远程设备
    const up = await new Promise((resolve) => {
      const s = net.connect(proxy.listenPort, '127.0.0.1', () => {
        s.write(['GET /plugins/events HTTP/1.1', `Host: 127.0.0.1:${proxy.listenPort}`,
          'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
      });
      let buf = '';
      s.on('data', (c) => { buf += c.toString('latin1'); });
      s.on('error', () => {});
      setTimeout(() => { s.destroy(); resolve(Number(buf.split(' ')[1])); }, 800);
    });
    assert.equal(up, 401, '未认证的 WS 升级必须被拦');

    // 带会话后放行
    const session = auth.createSession();
    const ok = await new Promise((resolve) => {
      const s = net.connect(proxy.listenPort, '127.0.0.1', () => {
        s.write(['GET /plugins/events HTTP/1.1', `Host: 127.0.0.1:${proxy.listenPort}`,
          'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13', `Cookie: dsh_portal_auth=${session}`, '', ''].join('\r\n'));
      });
      let buf = '';
      s.on('data', (c) => { buf += c.toString('latin1'); });
      s.on('error', () => {});
      setTimeout(() => { s.destroy(); resolve(Number(buf.split(' ')[1])); }, 800);
    });
    assert.equal(ok, 101, '已认证的 WS 升级应成功');
  });
});

// ---------- 2. 门禁 ----------

test('门禁：未认证 401（返回登录页），密码登录后可访问', async () => {
  await withProxy({ password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy }) => {
    const denied = await get(proxy.listenPort, '/', { Accept: 'text/html', Host: 'dsh.example.com' });
    assert.equal(denied.status, 401);
    assert.match(denied.body, /访问密码|Access password/, '应返回登录页');

    const login = await post(proxy.listenPort, `${ENDPOINT_PREFIX}/login`, { password: 'guest-pass' }, { Host: 'dsh.example.com' });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const allowed = await get(proxy.listenPort, '/', { cookie, Host: 'dsh.example.com' });
    assert.equal(allowed.status, 200);
  });
});

test('门禁：扫码令牌 302 到干净地址，并把会话写进 Cookie', async () => {
  await withProxy({ password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    auth.allowLoopback = false;
    const res = await get(proxy.listenPort, `/?auth=${encodeURIComponent(auth.secretToken)}`, { Host: 'dsh.example.com' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/', 'token 必须从地址栏移除');
    assert.match(res.headers['set-cookie'][0], /dsh_portal_auth=/, '应下发会话 Cookie');
  });
});

test('门禁：同机反代（来源=127.0.0.1）也无法借用回环免密', async () => {
  await withProxy({ password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy }) => {
    // nginx 与 porthole 同机时来源恒为 127.0.0.1；靠 Host 判定，域名 Host 不得免密
    const res = await get(proxy.listenPort, '/', { Accept: 'text/html', Host: 'dsh.example.com' });
    assert.equal(res.status, 401);

    // 本机 Host 才免密
    const local = await get(proxy.listenPort, '/', { Host: '127.0.0.1:3082' });
    assert.equal(local.status, 200);
  });
});

test('门禁：PWA manifest 与图标可匿名 GET/HEAD，根路径和二级目录均可用', async () => {
  for (const basePath of ['', '/dsh']) {
    await withProxy({ basePath, authConfig: { enabled: true, allowLoopback: false } }, async ({ proxy, upstream }) => {
      const headers = { Host: 'dsh.example.com', 'X-Forwarded-For': '203.0.113.9' };
      for (const asset of ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg']) {
        for (const method of ['GET', 'HEAD']) {
          const path = `${asset}?v=1`;
          const res = await get(proxy.listenPort, `${basePath}${path}`, headers, method);
          assert.equal(res.status, 200, `${method} ${basePath}${path} 不应要求 Cookie`);
          assert.equal(res.headers['set-cookie'], undefined, '公开资源不得签发访问会话');
          assert.equal(upstream.seen.at(-1).url, path, '剥前缀后保留资源路径和查询参数');
          assert.equal(upstream.seen.at(-1).headers['x-forwarded-for'], '203.0.113.9', '不改变转发头策略');
          if (method === 'GET') assert.match(res.body, /upstream:/, '应返回上游资源而非登录页');
          else assert.equal(res.body, '', 'HEAD 不得返回响应体');
        }
      }
    });
  }
});

test('门禁：PWA 例外不放开页面、API、同名子路径或写请求，并遵守挂载前缀', async () => {
  await withProxy({ basePath: '/dsh', authConfig: { enabled: true, allowLoopback: false } }, async ({ proxy, upstream }) => {
    const headers = { Host: 'dsh.example.com' };
    for (const path of ['/dsh/', '/dsh/api/session/list', '/dsh/git/config', '/dsh/assets/private.svg',
      '/dsh/manifest.webmanifest/private', '/dsh/manifest.webmanifest/', '/dsh/api/manifest.webmanifest']) {
      const res = await get(proxy.listenPort, path, headers);
      assert.equal(res.status, 401, `${path} 仍须认证`);
    }
    for (const asset of ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg']) {
      const write = await post(proxy.listenPort, `/dsh${asset}`, {}, headers);
      assert.equal(write.status, 401, `POST ${asset} 仍须认证`);
      const unmounted = await get(proxy.listenPort, asset, headers);
      assert.equal(unmounted.status, 404, '公开资源也必须带挂载前缀');
    }
    assert.equal(upstream.seen.length, 0, '被拒绝的请求不得到达上游');
  });
});

// ---------- 3. 二级目录 ----------

test('二级目录：/dsh 缺尾斜杠 302 补齐，/dsh/ 正常转发', async () => {
  await withProxy({ basePath: '/dsh' }, async ({ proxy }) => {
    const noSlash = await get(proxy.listenPort, '/dsh', { Host: '127.0.0.1' });
    assert.equal(noSlash.status, 302, '缺尾斜杠应规范化');
    assert.equal(noSlash.headers.location, '/dsh/');

    const res = await get(proxy.listenPort, '/dsh/', { Host: '127.0.0.1' });
    assert.equal(res.status, 200, '/dsh/ 应可用');
    assert.match(res.body, /upstream:\/</, '应被转发到 DSH 根路径');

    const sub = await get(proxy.listenPort, '/dsh/assets/a.js', { Host: '127.0.0.1' });
    assert.match(sub.body, /upstream:\/assets\/a\.js/, '前缀必须剥掉再转发');
  });
});

test('二级目录：严格收敛——根路径 302 到前缀，其它未挂载路径 404', async () => {
  await withProxy({ basePath: '/dsh' }, async ({ proxy }) => {
    const root = await get(proxy.listenPort, '/', { Host: '127.0.0.1' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, '/dsh/');

    const other = await get(proxy.listenPort, '/api/session/list', { Host: '127.0.0.1' });
    assert.equal(other.status, 404);
  });
});

test('二级目录：防循环——带标记 Cookie 时根路径放行而非无限跳转', async () => {
  await withProxy({ basePath: '/dsh' }, async ({ proxy }) => {
    const again = await get(proxy.listenPort, '/', { Host: '127.0.0.1', Cookie: 'dsh_portal_mount=1' });
    assert.equal(again.status, 200, 'nginx 若仍在剥前缀，应降级为可访问而不是死循环');
  });
});

test('二级目录：内置端点不受严格模式限制（面板要靠它领令牌）', async () => {
  await withProxy({ basePath: '/dsh', password: 'guest-pass', authConfig: { enabled: true }, origins: ['http://127.0.0.1:3082'] }, async ({ proxy }) => {
    const res = await get(proxy.listenPort, `${ENDPOINT_PREFIX}/loopback-token`, { Host: `127.0.0.1:${proxy.listenPort}`, Origin: 'http://127.0.0.1:3082' });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).adminToken, /^[a-f0-9]{48}$/);
  });
});

// ---- 登录页与尾斜杠：都不能把人甩出二级目录 ----

test('登录页：登录接口与成功后落点都带挂载前缀', async () => {
  await withProxy({ basePath: '/dsh', password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy }) => {
    const res = await get(proxy.listenPort, '/dsh/', { Accept: 'text/html', Host: 'dsh.example.com' });
    assert.equal(res.status, 401);
    assert.match(res.body, /fetch\('\/dsh\/__dsh_porthole__\/login'/, '登录接口必须带前缀');
    assert.match(res.body, /location\.replace\("\/dsh\/"\)/, '登录成功后必须回到 /dsh/ 而不是站点根');
    assert.doesNotMatch(res.body, /location\.replace\("\/"\)/, '不得跳回站点根');
  });
});

test('登录页：站点根模式下仍是根路径', async () => {
  await withProxy({ password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy }) => {
    const res = await get(proxy.listenPort, '/', { Accept: 'text/html', Host: 'dsh.example.com' });
    assert.equal(res.status, 401);
    assert.match(res.body, /fetch\('\/__dsh_porthole__\/login'/);
    assert.match(res.body, /location\.replace\("\/"\)/);
  });
});

test('二级目录：/dsh 缺尾斜杠时 302 补斜杠（否则相对路径解析错、静态资源 404）', async () => {
  await withProxy({ basePath: '/dsh' }, async ({ proxy }) => {
    const res = await get(proxy.listenPort, '/dsh', { Host: '127.0.0.1' });
    assert.equal(res.status, 302, '应重定向到带斜杠的规范地址');
    assert.equal(res.headers.location, '/dsh/');
  });
});

test('登录：提交后能真正进入（端到端走一遍前缀下的登录）', async () => {
  await withProxy({ basePath: '/dsh', password: 'guest-pass', authConfig: { enabled: true } }, async ({ proxy }) => {
    const login = await post(proxy.listenPort, '/dsh/__dsh_porthole__/login', { password: 'guest-pass' }, { Host: 'dsh.example.com' });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /Path=\/dsh/, 'Cookie 必须收敛到前缀');

    const page = await get(proxy.listenPort, '/dsh/', { cookie: cookie.split(';')[0], Host: 'dsh.example.com' });
    assert.equal(page.status, 200, '登录后应能打开 /dsh/');
    assert.match(page.body, /upstream:\//, '应拿到 DSH 页面');
  });
});

// ---------- 4. 压缩与剥离的交互（最脆弱的一条路径） ----------

test('压缩：客户端要 gzip 时透传上游压缩，不自行解压重编码', async () => {
  const { gzipSync } = await import('node:zlib');
  const payload = gzipSync(Buffer.from('<html>hi</html>'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const home = await mkdtemp(join(tmpdir(), 'gz-'));
  await writeFile(join(home, '.credentials.yaml'), 'client-connection/browser-session:\n  payload:\n    secret: abc\n');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const proxy = new LiteProxy({ listenPort: 0, targetPort: server.address().port, authManager: new AuthManager({ config: {}, sessionsFile: join(home, 's.json') }) });
  await proxy.start();
  try {
    const res = await getBuf(proxy.listenPort, '/');
    assert.equal(res.headers['content-encoding'], 'gzip', '上游压缩应原样透传');
    assert.equal(res.body.length, payload.length, '不得被代理解压');
    assert.ok(res.body.equals(payload), '字节必须一致');
  } finally {
    await proxy.stop();
    server.close();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('压缩：session/list 为 gzip 时，剥离后必须去掉 content-encoding 并重算长度', async () => {
  const { gzipSync } = await import('node:zlib');
  // 上游返回 **gzip 压缩** 的 session/list，且带大字段
  const raw = JSON.stringify({
    result: { ok: true, value: { items: [{ id: 's1', projections: { values: { contextHeaders: 'x'.repeat(4000), contextTimeline: 'y'.repeat(4000), keep: 1 } } }] } },
  });
  const gz = gzipSync(Buffer.from(raw));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const home = await mkdtemp(join(tmpdir(), 'gz2-'));
  await writeFile(join(home, '.credentials.yaml'), 'client-connection/browser-session:\n  payload:\n    secret: abc\n');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const proxy = new LiteProxy({ listenPort: 0, targetPort: server.address().port, authManager: new AuthManager({ config: {}, sessionsFile: join(home, 's.json') }) });
  await proxy.start();
  try {
    const res = await get(proxy.listenPort, '/api/session/list');
    assert.equal(res.headers['content-encoding'], undefined, '剥离后必须声明为明文');
    assert.equal(Number(res.headers['content-length']), res.body.length, '长度必须与实际 body 一致');
    const json = JSON.parse(res.body);
    const proj = json.result.value.items[0].projections.values;
    assert.equal(proj.contextHeaders, undefined, '大字段必须被剥离');
    assert.equal(proj.keep, 1, '无关字段保留');
    assert.ok(res.body.length < raw.length, '剥离后应小于原始明文');
  } finally {
    await proxy.stop();
    server.close();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});
