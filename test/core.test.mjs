import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { withProxy, request } from './helpers/proxy.mjs';

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

test('gzip 普通响应原样透传；会话投影剥离后重算编码和长度', async () => {
  const raw = JSON.stringify({ result: { ok: true, value: { items: [{ id: 's1', projections: { values: {
    contextHeaders: 'x'.repeat(4000), contextTimeline: 'y'.repeat(4000), keep: 1,
  } } }] } } });
  const compressed = gzipSync(Buffer.from(raw));
  await withProxy({ respond(req, res) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(compressed);
  } }, async ({ port }) => {
    const page = await request(port, '/');
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.deepEqual(page.buffer, compressed);
    const session = await request(port, '/api/session/list');
    assert.equal(session.headers['content-encoding'], undefined);
    assert.equal(Number(session.headers['content-length']), session.buffer.length);
    assert.deepEqual(JSON.parse(session.body).result.value.items[0].projections.values, { keep: 1 });
  });
});
