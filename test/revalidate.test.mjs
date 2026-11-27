// test/revalidate.test.mjs —— 稳定代码响应的 ETag 再验证（首页 / no-store 脚本样式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { withProxy, request } from './helpers/proxy.mjs';
import {
  isRevalidationCandidate,
  responseEtag,
  etagMatches,
  revalidationCacheControl,
  REVALIDATE_CACHE_CONTROL,
} from '../lib/revalidate.js';

const WIDGET = '/dsh-whale/widget.js';
const JS = 'application/javascript; charset=utf-8';

/** 模拟 dsh-whale-widget 的 /dsh-whale/widget.js：静态文件直出 + no-store + 无 ETag。 */
function serveWidget(res, body = 'console.log("widget-v1")', headers = {}) {
  res.writeHead(200, {
    'Content-Type': JS,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...headers,
  });
  res.end(body);
}

// ---------------- 纯函数 ----------------

test('isRevalidationCandidate 只认 GET 200 的脚本 / 样式 / 首页，且上游没有自己的 ETag', () => {
  const base = {
    method: 'GET', pathname: WIDGET, reqHeaders: {}, status: 200,
    resHeaders: { 'content-type': JS, 'cache-control': 'no-store' },
  };
  assert.ok(isRevalidationCandidate(base));
  assert.ok(isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-type': 'text/css; charset=utf-8' } }));
  assert.ok(isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-type': 'application/x-javascript' } }));
  const html = { 'content-type': 'text/html; charset=utf-8' };
  assert.ok(isRevalidationCandidate({ ...base, pathname: '/', resHeaders: html }));
  assert.ok(isRevalidationCandidate({ ...base, pathname: '/index.html', resHeaders: html }));
  // 方法 / 状态 / Range
  assert.ok(!isRevalidationCandidate({ ...base, method: 'HEAD' }));
  assert.ok(!isRevalidationCandidate({ ...base, method: 'POST' }));
  assert.ok(!isRevalidationCandidate({ ...base, status: 404 }));
  assert.ok(!isRevalidationCandidate({ ...base, status: 304 }));
  assert.ok(!isRevalidationCandidate({ ...base, reqHeaders: { range: 'bytes=0-10' } }));
  // 上游自己有校验器或分块范围
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, etag: 'W/"x"' } }));
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-range': 'bytes 0-1/2' } }));
  // 声明体积超限
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-length': String(20 * 1024 * 1024) } }));
  assert.ok(isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-length': '1024' } }));
  // 数据类响应与其它 HTML 的 no-store 原样保留
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-type': 'application/json' } }));
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-type': 'text/event-stream' } }));
  assert.ok(!isRevalidationCandidate({ ...base, resHeaders: { ...base.resHeaders, 'content-type': 'text/plain' } }));
  assert.ok(!isRevalidationCandidate({ ...base, pathname: '/some/page', resHeaders: html }));
});

test('ETag 按解码内容生成弱校验器，gzip 与明文可共享', () => {
  const etag = responseEtag(Buffer.from('abc'));
  assert.match(etag, /^W\/"[A-Za-z0-9_-]{27}"$/); // sha1 → base64url = 27 字符
  assert.equal(responseEtag(gzipSync('abc'), 'gzip'), etag);
  assert.equal(responseEtag(Buffer.from('bad gzip'), 'gzip'), null);
  assert.equal(responseEtag(gzipSync('abc'), 'gzip', 2), null);
  assert.notEqual(responseEtag(Buffer.from('abd')), etag);
  assert.ok(etagMatches(etag, etag));
  assert.ok(etagMatches(`"other", ${etag}`, etag));
  assert.ok(etagMatches([etag], etag));
  assert.ok(etagMatches(etag.slice(2), etag), 'If-None-Match 使用弱比较');
  assert.ok(!etagMatches('*', etag), '* 不算持有同一份字节');
  assert.ok(!etagMatches(undefined, etag));
  assert.ok(!etagMatches('', etag));
});

test('revalidationCacheControl：没给或 no-store/no-cache → private, no-cache；显式新鲜度策略保留', () => {
  assert.equal(revalidationCacheControl({}), REVALIDATE_CACHE_CONTROL);
  assert.equal(revalidationCacheControl({ 'cache-control': 'no-store' }), REVALIDATE_CACHE_CONTROL);
  assert.equal(revalidationCacheControl({ 'cache-control': 'no-cache' }), REVALIDATE_CACHE_CONTROL);
  assert.equal(revalidationCacheControl({ 'cache-control': 'No-Store' }), REVALIDATE_CACHE_CONTROL);
  assert.equal(revalidationCacheControl({ 'cache-control': 'public, max-age=3600' }), 'public, max-age=3600');
});

// ---------------- 代理集成 ----------------

test('no-store 脚本：补 ETag 并允许浏览器留副本；未变回 304，变了回 200 新内容', async () => {
  let version = 1;
  const bodyOf = (v) => `console.log("widget-v${v}")`;
  await withProxy({ respond: (req, res) => serveWidget(res, bodyOf(version)) }, async ({ port, upstream }) => {
    const first = await request(port, WIDGET, { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(first.status, 200);
    assert.equal(first.body, bodyOf(1), '首次响应字节不变');
    assert.equal(first.headers['cache-control'], REVALIDATE_CACHE_CONTROL);
    assert.equal(first.headers.vary, 'Accept-Encoding', '上游 Vary 保留');
    const etag = first.headers.etag;
    assert.match(String(etag), /^W\/"[A-Za-z0-9_-]{27}"$/);
    assert.equal(Number(first.headers['content-length']), first.buffer.length);

    // 浏览器下次开页：带 If-None-Match → 304，不带 body，但仍回源确认了最新内容
    const revalidate = await request(port, WIDGET, { headers: { 'If-None-Match': etag } });
    assert.equal(revalidate.status, 304);
    assert.equal(revalidate.buffer.length, 0);
    assert.equal(revalidate.headers.etag, etag);
    assert.equal(revalidate.headers['cache-control'], REVALIDATE_CACHE_CONTROL);
    assert.equal(upstream.seen.length, 2, '再验证必须回源，不能自己拍脑袋回 304');

    // 插件更新了文件：同样是条件请求，必须拿到新内容而不是 304
    version = 2;
    const changed = await request(port, WIDGET, { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body, bodyOf(2));
    assert.notEqual(changed.headers.etag, etag);
    assert.equal(upstream.seen.length, 3);
  });
});

test('首页：无缓存头的 index.html 也获得 ETag，重复打开回 304', async () => {
  await withProxy({}, async ({ port, upstream }) => {
    // 测试上游默认对任何路径回 text/html 200，无缓存头 —— 与 DSH 首页形态一致
    const first = await request(port, '/');
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], REVALIDATE_CACHE_CONTROL);
    assert.ok(first.headers.etag);
    const again = await request(port, '/', { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body, '');
    assert.equal(upstream.seen.length, 2, '再验证必须回源确认');
  });
});

test('上游 gzip 脚本：支持 br 的客户端也收到原 gzip 字节，304 照常', async () => {
  const gz = gzipSync(Buffer.from('console.log("gz")'.repeat(4000)));
  await withProxy({ respond: (req, res) => serveWidget(res, gz, { 'Content-Encoding': 'gzip' }) }, async ({ port }) => {
    const first = await request(port, WIDGET, { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(first.headers['content-encoding'], 'gzip');
    assert.deepEqual(first.buffer, gz);
    assert.ok(first.headers.etag);
    const again = await request(port, WIDGET, { headers: { 'Accept-Encoding': 'gzip, br', 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
  });
});

test('不碰的响应：JSON 的 no-store、上游自带 ETag、HEAD、非首页 HTML', async () => {
  await withProxy({ respond: (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"secret":1}');
    } else if (path === '/with-etag.js') {
      res.writeHead(200, { 'content-type': JS, 'cache-control': 'no-store', etag: '"upstream"' });
      res.end('console.log(1)');
    } else if (path === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>plugin page</html>');
    } else {
      serveWidget(res);
    }
  } }, async ({ port }) => {
    const json = await request(port, '/api/state');
    assert.equal(json.headers['cache-control'], 'no-store', '数据类的 no-store 必须原样保留');
    assert.equal(json.headers.etag, undefined);
    const own = await request(port, '/with-etag.js');
    assert.equal(own.headers['cache-control'], 'no-store');
    assert.equal(own.headers.etag, '"upstream"', '上游自己的校验器不改写');
    const page = await request(port, '/page');
    assert.equal(page.headers.etag, undefined, '只有首页 HTML 参与，其它 HTML 不碰');
    // HEAD 没有 body 可算摘要：原样直通
    const head = await request(port, WIDGET, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['cache-control'], 'no-store');
    assert.equal(head.headers.etag, undefined);
  });
});

test('etagRevalidate 关闭时完全维持上游的 no-store', async () => {
  await withProxy({ proxyOptions: { etagRevalidate: false }, respond: (req, res) => serveWidget(res) }, async ({ port }) => {
    const resp = await request(port, WIDGET);
    assert.equal(resp.headers['cache-control'], 'no-store');
    assert.equal(resp.headers.etag, undefined);
  });
});

test('分块响应超过缓冲上限：放弃再验证，字节原样直通', async () => {
  const chunk = Buffer.alloc(50, 0x61); // 4 块共 200 字节
  await withProxy({
    // 上限 120：前两块（100）可缓冲，第三块累计 150 超限 —— 此刻才放弃再验证
    configureProxy: (proxy) => { proxy.revalidateMaxBodyBytes = 120; },
    respond: (req, res) => {
      res.writeHead(200, { 'Content-Type': JS, 'Cache-Control': 'no-store' }); // 无 content-length → chunked
      let n = 0;
      const timer = setInterval(() => {
        res.write(chunk);
        if (++n === 4) { clearInterval(timer); res.end(); }
      }, 5);
    },
  }, async ({ port }) => {
    const resp = await request(port, WIDGET);
    assert.equal(resp.status, 200);
    assert.equal(resp.body, 'a'.repeat(200), '超限后所有字节必须完整送达');
    assert.equal(resp.headers.etag, undefined, '超限就不补校验器');
    assert.equal(resp.headers['cache-control'], 'no-store', '超限也不改缓存策略');
  });
});

test('304 响应仍透传上游的 Set-Cookie', async () => {
  let n = 0;
  await withProxy({ respond: (req, res) => serveWidget(res, 'console.log(1)', { 'Set-Cookie': [`visit=${++n}; Path=/`, 'theme=dark; Path=/'] }) }, async ({ port }) => {
    const first = await request(port, WIDGET);
    assert.deepEqual(first.headers['set-cookie'], ['visit=1; Path=/', 'theme=dark; Path=/']);
    const again = await request(port, WIDGET, { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.deepEqual(again.headers['set-cookie'], ['visit=2; Path=/', 'theme=dark; Path=/']);
  });
});

// ---------------- 静态媒体：只补校验器，不换编码 ----------------

test('no-store 静态媒体（图片/音频）：补 ETag，未变回 304，变了回 200，且不压缩', async () => {
  let version = 1;
  const bytesOf = (v) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40000, v)]); // 假 PNG 内容
  await withProxy({ respond: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(bytesOf(version).length) });
    res.end(bytesOf(version));
  } }, async ({ port, upstream }) => {
    const first = await request(port, '/dsh-whale/image.png', { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.buffer, bytesOf(1), '字节原样');
    assert.equal(first.headers['content-encoding'], undefined, '不改变上游编码');
    assert.equal(first.headers['cache-control'], REVALIDATE_CACHE_CONTROL);
    const etag = first.headers.etag;
    assert.match(String(etag), /^W\/"[A-Za-z0-9_-]{27}"$/);
    const again = await request(port, '/dsh-whale/image.png', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.buffer.length, 0);
    assert.equal(upstream.seen.length, 2, '仍回源确认');
    version = 2;
    const changed = await request(port, '/dsh-whale/image.png', { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.buffer, bytesOf(2));
  });
});

test('音频 / 字体同样参与再验证；API JSON 与未知类型仍不碰', async () => {
  await withProxy({ respond: (req, res) => {
    const path = req.url.split('?')[0];
    const type = path.endsWith('.wav') ? 'audio/wav' : path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(Buffer.alloc(9000, 7));
  } }, async ({ port }) => {
    for (const path of ['/dsh-whale/a.wav', '/x/f.woff2']) {
      const resp = await request(port, path, { headers: { 'Accept-Encoding': 'br' } });
      assert.ok(resp.headers.etag, `${path} 应有 ETag`);
      assert.equal(resp.headers['content-encoding'], undefined);
      assert.equal(resp.headers['cache-control'], REVALIDATE_CACHE_CONTROL);
    }
    for (const path of ['/x/data.json', '/x/blob.bin']) {
      const resp = await request(port, path);
      assert.equal(resp.headers.etag, undefined, `${path} 不应补 ETag`);
      assert.equal(resp.headers['cache-control'], 'no-store');
    }
  });
});
