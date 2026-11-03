// test/basepath.test.mjs —— 二级目录反代（nginx /dsh/ 之类）与回环身份防伪
//
// 背景：DSH 前端全部用相对路径（`<base href="./">`、RPC 是 `${channel}/${endpoint}`.slice(1)），
// 所以子目录在浏览器侧天然可用。真正需要适配的是本插件自己产出的**站内绝对路径**：
// 302 Location 与会话 Cookie 的 Path。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeBasePath, LiteProxy, ENDPOINT_PREFIX, AUTH_COOKIE } from '../lib/proxy.js';
import { AuthManager } from '../lib/auth/manager.js';
import { BridgeLiteService } from '../lib/service.js';

// ---- 前缀归一化 ----

test('basePath：归一化为「空 或 /xxx（无尾斜杠）」', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath(undefined), '');
  assert.equal(normalizeBasePath('/dsh'), '/dsh');
  assert.equal(normalizeBasePath('dsh'), '/dsh', '缺前导斜杠要补');
  assert.equal(normalizeBasePath('/dsh/'), '/dsh', '去尾斜杠');
  assert.equal(normalizeBasePath('//a//b//'), '/a/b', '折叠重复斜杠');
  assert.equal(normalizeBasePath('/a/../b'), '', '拒绝路径穿越');
  assert.equal(normalizeBasePath('/有中文'), '', '拒绝非白名单字符');
});

// ---- 测试用上游 ----

function startUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><base href="./"></head><body>upstream:${req.url}</body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withProxy(opts, fn) {
  const up = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'bp-'));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.credentials.yaml'),
    `client-connection/browser-session:\n  payload:\n    secret: ${Buffer.alloc(32, 5).toString('base64url')}\n`);

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: opts.authConfig ?? { enabled: false }, sessionsFile: join(home, 's.json') });
  const proxy = new LiteProxy({
    listenPort: 0,
    targetPort: up.port,
    authManager: auth,
    basePath: opts.basePath ?? '',
    allowedOrigins: () => ['http://127.0.0.1:3082'],
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

// ---- 子目录：302 Location 与 Cookie Path ----

test('子目录：扫码 token 直通后 302 回到 /dsh/ 而不是站点根', async () => {
  await withProxy({ basePath: '/dsh', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    auth.allowLoopback = false; // 模拟经由 nginx 的远程请求
    const token = auth.secretToken;

    const res = await get(proxy.listenPort, `/?auth=${encodeURIComponent(token)}`, {
      Host: 'dsh.example.com',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/dsh/', '必须带回对外前缀，否则浏览器被甩出子树');
    assert.match(res.headers['set-cookie'][0], new RegExp(`Path=/dsh;`), 'Cookie 收敛到子目录');
  });
});

test('子目录：站点根模式下 Location 与 Cookie 维持原样', async () => {
  await withProxy({ basePath: '', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    auth.allowLoopback = false;
    const res = await get(proxy.listenPort, `/?auth=${encodeURIComponent(auth.secretToken)}`, {
      Host: 'dsh.example.com',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
    assert.match(res.headers['set-cookie'][0], /Path=\/;/);
  });
});

test('子目录：登录成功下发的 Cookie 也收敛到前缀', async () => {
  await withProxy({ basePath: '/dsh', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    auth.allowLoopback = false;

    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ password: 'guest-pass' });
      const req = httpRequest({
        host: '127.0.0.1', port: proxy.listenPort, path: `${ENDPOINT_PREFIX}/login`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), Host: 'dsh.example.com' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['set-cookie'][0], /Path=\/dsh;/);
  });
});

test('登录页使用相对路径请求登录接口（根与子目录下都能命中）', async () => {
  await withProxy({ basePath: '/dsh', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    auth.allowLoopback = false;
    const res = await get(proxy.listenPort, '/', { Host: 'dsh.example.com', Accept: 'text/html' });
    assert.equal(res.status, 401);
    assert.match(res.body, /fetch\('__dsh_porthole__\/login'/, '不得带前导斜杠，否则子目录下会打到站点根');
    assert.equal(res.body.includes("fetch('/"), false, '不能出现站内绝对路径的 fetch');
  });
});

// ---- 安全：反代不得借用回环身份 ----

test('安全：经同机反代（remoteAddress=127.0.0.1）但 Host 是域名时，门禁仍然生效', async () => {
  await withProxy({ basePath: '/dsh', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    // allowLoopback 默认 true —— 这是最危险的组合：nginx 与 porthole 同机，
    // 请求来源恒为 127.0.0.1，若 Host 校验缺失就等于全站免密。
    const res = await get(proxy.listenPort, '/', { Host: 'dsh.example.com', Accept: 'text/html' });
    assert.equal(res.status, 401, '域名 Host 不得触发回环免密');
    assert.match(res.body, /访问密码|Access password/);
  });
});

test('安全：Host 为空时不享受回环免密（防 nginx 漏配 Host 导致全站敞口）', async () => {
  await withProxy({ basePath: '', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    // 用 HTTP/1.0 才能真的不带 Host（HTTP/1.1 缺失 Host 会被 Node 直接 400 拒掉，
    // 到不了业务层，也就测不到这条防线）
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.listenPort, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.0\r\nAccept: text/html\r\n\r\n');
      });
      let buf = '';
      socket.on('data', (c) => { buf += c.toString(); });
      socket.on('end', () => resolve({ status: Number(buf.split(' ')[1]), head: buf }));
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); resolve({ status: 0, head: buf }); }, 2000);
    });
    assert.equal(res.status, 401, '空 Host 必须按未授权处理（否则 nginx 漏配 Host 即全站敞口）');
  });
});

test('安全：Host=localhost 且来源回环时仍免密（本机正常使用不受影响）', async () => {
  await withProxy({ basePath: '', authConfig: { enabled: true } }, async ({ proxy, auth }) => {
    await auth.setPassword('guest-pass');
    const res = await get(proxy.listenPort, '/', { Host: '127.0.0.1:3082' });
    assert.equal(res.status, 200, '本机直连应免密');
  });
});

// ---- service 透传 ----

test('service：basePath 会被透传给代理并参与 Cookie Path', async () => {
  const up = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'bp2-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
  const svc = new BridgeLiteService({ dshPort: up.port, port: 0, authManager: auth, basePath: '/dsh/' });
  await svc.start();
  try {
    assert.equal(svc.proxy.basePath, '/dsh', '归一化后透传');
    const res = await get(svc.port, '/');
    assert.equal(res.status, 200);
  } finally {
    await svc.dispose();
    auth.dispose();
    up.server.close();
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

void AUTH_COOKIE;

// ---- 监听地址可绑定回环（前面挂 nginx 时避免绕行直连） ----

test('host：可绑定 127.0.0.1，且不会监听外部地址', async () => {
  const up = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'bp3-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
  const proxy = new LiteProxy({
    listenPort: 0, targetPort: up.port, authManager: auth, host: '127.0.0.1',
  });
  await proxy.start();
  try {
    assert.equal(proxy.host, '127.0.0.1');
    // 回环访问正常
    const res = await get(proxy.listenPort, '/');
    assert.equal(res.status, 200);
  } finally {
    await proxy.stop();
    auth.dispose();
    up.server.close();
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

test('host：默认仍是 0.0.0.0（局域网直连不被破坏）', async () => {
  const up = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'bp4-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
  const proxy = new LiteProxy({ listenPort: 0, targetPort: up.port, authManager: auth });
  await proxy.start();
  try {
    assert.equal(proxy.host, '0.0.0.0');
  } finally {
    await proxy.stop();
    auth.dispose();
    up.server.close();
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});
