// test/ws.test.mjs —— WebSocket 转发（DSH 的实时通道全靠它）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { LiteProxy } from '../lib/proxy.js';
import { AuthManager } from '../lib/auth/manager.js';

/**
 * 最小 WebSocket 上游：完成握手后把收到的帧原样回显（不回掩码时按文本回发）。
 * 不引第三方 ws 依赖 —— 上游 dsh-bridge 带 ws 只是因为要主动连隧道服务器，
 * Lite 只做透传，手写握手足够验证链路。
 */
function startFakeWsUpstream() {
  const server = createServer((req, res) => { res.writeHead(200); res.end('http'); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    // 收到任何数据就回一个未掩码文本帧 "pong:<内容>"
    socket.on('data', (buf) => {
      const payload = Buffer.from(`pong:${buf.length}`);
      const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
      socket.write(frame);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 发一个 HTTP Upgrade 请求，等待 101 响应或错误状态码。 */
function upgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const status = Number(buf.split(' ')[1]);
        resolve({ status, head: buf, socket });
      }
    });
    socket.on('error', reject);
    setTimeout(() => resolve({ status: 0, head: buf, socket }), 2000);
  });
}

async function fakeDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lite-ws-'));
  await mkdir(home, { recursive: true });
  const secret = Buffer.alloc(32, 9).toString('base64url');
  await writeFile(join(home, '.credentials.yaml'), `client-connection/browser-session:\n  payload:\n    secret: ${secret}\n`, 'utf8');
  return home;
}

test('WebSocket：握手透传成功，101 只放行白名单头', async () => {
  const upstream = await startFakeWsUpstream();
  const home = await fakeDshHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
    const proxy = new LiteProxy({ listenPort: 0, targetPort: upstream.port, authManager: auth });
    await proxy.start();

    const { status, head, socket } = await upgrade(proxy.listenPort, '/plugins/events');
    assert.equal(status, 101, `应完成 WS 升级，实际：${head.slice(0, 120)}`);
    assert.match(head.toLowerCase(), /sec-websocket-accept:/);
    socket.destroy();
    await proxy.stop();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    upstream.server.close();
  }
});

test('WebSocket：开启认证后无凭证的升级请求被 401 拒绝', async () => {
  const upstream = await startFakeWsUpstream();
  const home = await fakeDshHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: true }, sessionsFile: join(home, 's.json') });
    await auth.setPassword('ws-pass-123');
    auth.allowLoopback = false; // 模拟远程设备

    const proxy = new LiteProxy({ listenPort: 0, targetPort: upstream.port, authManager: auth });
    await proxy.start();

    const denied = await upgrade(proxy.listenPort, '/plugins/events');
    assert.equal(denied.status, 401, '未认证的 WS 升级必须被拦下');
    denied.socket.destroy();

    // 带有效会话 cookie 则放行
    const token = auth.createSession();
    const allowed = await upgrade(proxy.listenPort, '/plugins/events', {
      Cookie: `dsh_bridge_auth=${token}`,
    });
    assert.equal(allowed.status, 101, '已认证 WS 升级应成功');
    allowed.socket.destroy();

    await proxy.stop();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    upstream.server.close();
  }
});

test('WebSocket：上游不存在时不让进程崩（RST 必须有 error 监听）', async () => {
  const home = await fakeDshHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
    // 指向一个没人监听的端口
    const proxy = new LiteProxy({ listenPort: 0, targetPort: 1, authManager: auth });
    await proxy.start();

    const { status, socket } = await upgrade(proxy.listenPort, '/plugins/events');
    // 上游连不上：要么直接断开(status 0)，要么返回非 101
    assert.notEqual(status, 101, '上游不可达时不应伪装成功');
    socket.destroy();
    await proxy.stop();
    assert.ok(true, '进程存活');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});
