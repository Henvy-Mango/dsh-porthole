import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { withProxy, request } from './helpers/proxy.mjs';
import { stripHopByHopRequestHeaders } from '../lib/proxy.js';

test('HTTP 转发保留内部路径和查询串，并注入原生 Cookie、改写回环来源', async () => {
  await withProxy({}, async ({ port, upstream }) => {
    const path = '/dsh/assets/app.js?a=1&b=%E4%B8%AD';
    const response = await request(port, path, { headers: {
      'X-Forwarded-Prefix': '/dsh', Referer: 'https://portal.example/page?q=1',
    } });
    assert.equal(response.status, 200);
    assert.equal(response.body, `<html>upstream:${path}</html>`);
    const seen = upstream.seen.at(-1);
    assert.equal(seen.url, path);
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
    assert.equal(seen.headers.referer, `http://127.0.0.1:${upstream.port}/page?q=1`);
    assert.match(seen.headers.cookie, /dsh-auth-/);
    assert.equal(seen.headers['x-forwarded-prefix'], undefined);
  });
});

test('PWA 元数据匿名可读，私有资源仍须认证', async () => {
  await withProxy({ authConfig: { enabled: true, allowLoopback: false } }, async ({ port, upstream }) => {
    const response = await request(port, '/manifest.webmanifest?v=1');
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal((await request(port, '/manifest.webmanifest/private')).status, 401);
    assert.equal(upstream.seen.length, 1);
  });
});

test('上游 gzip 原样透传；会话投影剥离后按客户端能力使用 gzip', async () => {
  const sessionPath = '/api/session/list';
  const payload = (values) => JSON.stringify({ result: { ok: true, value: { items: [{ id: 's1', projections: { values } }] } } });
  const retained = { summary: '保留的会话内容 '.repeat(400) };
  const unchanged = gzipSync(payload(retained));
  const compressed = gzipSync(payload({ ...retained, contextHeaders: 'x'.repeat(4000), contextTimeline: 'y'.repeat(4000) }));
  await withProxy({ respond(req, res) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'Origin', etag: '"upstream"' });
    res.end(req.url === `${sessionPath}?unchanged` ? unchanged : compressed);
  } }, async ({ port }) => {
    const browser = { headers: { 'Accept-Encoding': 'gzip, br' } };
    const page = await request(port, '/', browser);
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.deepEqual(page.buffer, compressed);
    const unstripped = await request(port, `${sessionPath}?unchanged`, browser);
    assert.equal(unstripped.headers['content-encoding'], 'gzip');
    assert.equal(unstripped.headers.etag, '"upstream"');
    assert.deepEqual(unstripped.buffer, unchanged);

    const gzipped = await request(port, sessionPath, browser);
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.equal(Number(gzipped.headers['content-length']), gzipped.buffer.length);
    assert.equal(gzipped.headers.vary, 'Origin, Accept-Encoding');
    assert.equal(gzipped.headers.etag, undefined);
    assert.equal(gunzipSync(gzipped.buffer).toString(), payload(retained));
    assert.ok(gzipped.buffer.length < Buffer.byteLength(payload(retained)));

    for (const acceptEncoding of ['', 'br', 'gzip;q=0, *;q=1']) {
      const plain = await request(port, sessionPath, { headers: { 'Accept-Encoding': acceptEncoding } });
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.equal(Number(plain.headers['content-length']), plain.buffer.length);
      assert.equal(plain.headers.vary, 'Origin, Accept-Encoding');
      assert.equal(plain.body, payload(retained));
    }
  });
});

test('转发给上游的请求头剔除逐跳项：Connection: close / keep-alive 不再带到上游', () => {
  const out = stripHopByHopRequestHeaders({
    host: '127.0.0.1:1', connection: 'close, X-Hop-Only', 'x-hop-only': '1', 'keep-alive': 'timeout=5',
    'proxy-connection': 'keep-alive', te: 'trailers', trailer: 'X-T', upgrade: 'websocket',
    'content-type': 'application/json', 'content-length': '2', cookie: 'a=b', 'accept-encoding': 'gzip',
  });
  assert.deepEqual(out, { host: '127.0.0.1:1', 'content-type': 'application/json', 'content-length': '2', cookie: 'a=b', 'accept-encoding': 'gzip' });
  // 请求体分帧头与业务头不动
  const keep = stripHopByHopRequestHeaders({ 'transfer-encoding': 'chunked', 'x-a': '1' });
  assert.deepEqual(keep, { 'transfer-encoding': 'chunked', 'x-a': '1' });
});

test('nginx 式客户端（Connection: close）也能复用上游长连接：多个请求走同一条连接', async () => {
  const sockets = new Set();
  await withProxy({ respond: (req, res) => { sockets.add(req.socket); serve(res, req.url); } }, async ({ port, upstream }) => {
    const paths = ['/one.js', '/two.js', '/three.js'];
    for (const p of paths) {
      const resp = await request(port, p, { headers: { Connection: 'close' } });
      assert.equal(resp.status, 200);
      assert.equal(resp.body, `body:${p}`);
    }
    assert.equal(upstream.seen.length, 3);
    // 客户端的 close 不得被转发；Node 在连接池模式下会自行给上游发 keep-alive
    assert.equal(upstream.seen.some((s) => /close/i.test(String(s.headers.connection))), false, '客户端的 Connection: close 不应带到上游');
    assert.equal(upstream.seen.some((s) => s.headers['keep-alive'] !== undefined), false, '逐跳的 Keep-Alive 头不转发');
    assert.equal(sockets.size, 1, '三个请求应复用同一条上游连接');
  });
  function serve(res, url) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`body:${url}`);
  }
});

test('复用上游连接；拿到刚被上游关闭的陈旧连接时 GET 自动重试一次', async () => {
  const sockets = new Set();
  let staleHit = false;
  await withProxy({ respond: (req, res) => {
    if (!sockets.has(req.socket)) {
      sockets.add(req.socket);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream');
      return;
    }
    // 同一条上游连接上的第二个请求：模拟「上游恰好在代理复用的瞬间关闭了空闲连接」
    // ——不回包直接 RST。没有重试时这里会让客户端拿到 502。
    staleHit = true;
    req.socket.destroy();
  } }, async ({ port }) => {
    const first = await request(port, '/plain-a.js');
    assert.equal(first.status, 200);
    const second = await request(port, '/plain-a.js');
    assert.equal(staleHit, true, '第二个请求应复用了第一条连接');
    assert.equal(sockets.size, 2, '重试应新建连接');
    assert.equal(second.status, 200);
    assert.equal(second.body, 'upstream');
  });
});
