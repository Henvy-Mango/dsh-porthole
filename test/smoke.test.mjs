// test/smoke.test.mjs —— 端到端冒烟：假 DSH 上游 + 真代理 + 真鉴权
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../lib/auth/manager.js';
import { LiteProxy } from '../lib/proxy.js';
import { BridgeLiteService } from '../lib/service.js';

/** 起一个假的 DSH：记录收到的 header，回一段 HTML + 一个 /api 端点。 */
function startFakeDsh() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/api/session/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [{ id: 's1' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>DSH</title></head><body>dsh-host-marker</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
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

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 制造一份假的 ~/.dsh 凭据目录，让 cookie 注入链路真正走通。 */
async function makeFakeDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lite-'));
  await mkdir(home, { recursive: true });
  const secret = Buffer.alloc(32, 7).toString('base64url');
  await writeFile(join(home, '.credentials.yaml'), [
    'refs:',
    '  openai:',
    '    secret: {{SECRET_placeholder}}',
    'client-connection/browser-session:',
    '  payload:',
    '    secret: ' + secret,
    '',
  ].join('\n'), 'utf8');
  return { home, secret };
}

test('未开认证时：HTML/API 原样透传，且注入 loopback cookie 与 host 改写', async () => {
  const dsh = await startFakeDsh();
  const { home } = await makeFakeDshHome();
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
    const proxy = new LiteProxy({ listenPort: 0, targetPort: dsh.port, authManager: auth });
    // listenPort 0 由系统分配：先起再读实际端口
    await proxy.start().catch(() => {});
    if (!proxy.server) {
      // listen(0) 在 LiteProxy 里用的是传入端口，这里直接换随机高位端口重试
      const p = 31820 + Math.floor(Math.random() * 500);
      proxy.listenPort = p;
      await proxy.start();
    }
    const port = proxy.listenPort;

    const html = await get(port, '/');
    assert.equal(html.status, 200);
    assert.match(html.body, /dsh-host-marker/, '页面应原样透传（Lite 不做任何 HTML 注入）');
    assert.doesNotMatch(html.body, /manifest\.webmanifest/, '不应注入 PWA manifest');

    const api = await get(port, '/api/session/list');
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).sessions[0].id, 's1');

    const last = dsh.seen.at(-1);
    assert.equal(last.headers.host, `127.0.0.1:${dsh.port}`, 'Host 必须改写成回环 authority');
    assert.match(last.headers.cookie || '', /dsh-auth-/, '必须注入 DSH 原生 loopback cookie');

    await proxy.stop();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    dsh.server.close();
  }
});

test('开启认证后：远程请求被 401 拦下，密码登录后放行，token 直通 302', async () => {
  const dsh = await startFakeDsh();
  const { home } = await makeFakeDshHome();
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: true }, sessionsFile: join(home, 's.json') });
    await auth.setPassword('hunter2');
    auth.allowLoopback = false; // 模拟"这台机器不是本机"的远程设备

    const port = 32380 + Math.floor(Math.random() * 500);
    const proxy = new LiteProxy({ listenPort: port, targetPort: dsh.port, authManager: auth });
    await proxy.start();

    const blocked = await get(port, '/');
    assert.equal(blocked.status, 401, '未认证访问必须 401');
    assert.match(blocked.body, /访问密码|Access password/, '应返回登录页');

    const blockedApi = await get(port, '/api/session/list');
    assert.equal(blockedApi.status, 401);
    assert.match(blockedApi.body, /unauthorized/);

    const wrong = await post(port, '/__dsh_bridge_lite__/login', { password: 'nope' });
    assert.equal(wrong.status, 401);

    const right = await post(port, '/__dsh_bridge_lite__/login', { password: 'hunter2' });
    assert.equal(right.status, 200);
    const setCookie = right.headers['set-cookie'][0];
    assert.match(setCookie, /dsh_bridge_auth=/);

    const cookie = setCookie.split(';')[0];
    const allowed = await get(port, '/', { cookie });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /dsh-host-marker/);

    // URL token 直通：302 + 下发 cookie
    auth.allowLoopback = false;
    const tokenPass = await get(port, `/?auth=${encodeURIComponent(auth.secretToken)}`);
    assert.equal(tokenPass.status, 302);
    assert.equal(tokenPass.headers.location, '/');
    assert.match(tokenPass.headers['set-cookie'][0], /dsh_bridge_auth=/);

    await proxy.stop();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    dsh.server.close();
  }
});

test('BridgeLiteService：状态快照与 URL 计算', async () => {
  const dsh = await startFakeDsh();
  const { home } = await makeFakeDshHome();
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
    const port = 33100 + Math.floor(Math.random() * 500);
    const service = new BridgeLiteService({ dshPort: dsh.port, port, authManager: auth });
    await service.start();

    const status = await service.getStatus();
    assert.equal(status.proxy.running, true);
    assert.equal(status.proxy.port, port);
    assert.equal(status.dsh.port, dsh.port);
    assert.ok(Array.isArray(status.lan.interfaces));

    // 未开认证：URL 不带 token
    const plain = await service.getAccessUrl({ includeToken: true });
    if (plain) assert.doesNotMatch(plain, /auth=/);

    // 开认证后带 token
    await auth.setEnabled(true);
    const withToken = await service.getAccessUrl({ includeToken: true });
    if (withToken) assert.match(withToken, /auth=/);

    await service.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    dsh.server.close();
  }
});
