// lib/proxy.js —— Lite 版反向代理（HTTP + WebSocket）
//
// 这是整个 lite 版的核心：把 0.0.0.0:<port> 的入站请求原样转发到 127.0.0.1:<dshPort>。
//
// 与上游 dsh-bridge 的差异（全部是有意为之）：
//   - 不做 HTML 注入（PWA manifest / viewport / polyfill 全部移除）—— 页面就是 DSH 原样；
//   - 不做移动端样式改写、不做目录选择器接管；
//   - 不做 session 投影剥离（那是为公网流量省带宽，局域网不需要）；
//   - 不做 CORS 白名单与 loopback-token 端点（没有管理员特权体系了）；
//   - 不做 SSE 保活？—— 保留。原因：局域网里经过 AP / 交换机做 NAT 或空闲回收同样会掐断
//     /events 的实时通道，代价只有每 25s 12 字节，是纯收益。

import { createServer, request as httpRequest } from 'node:http';
import {
  getDshLoopbackCookies,
  stripCookieByName,
} from './auth/dsh-native-cookie.js';
import { isLoopbackAddress, readSessionCookie } from './auth/manager.js';
import { renderLoginPage, localizeAuthError, pickLoginLang } from './auth/login-template.js';
import { isSseKeepaliveCandidate, createSseKeepalive, SSE_KEEPALIVE_INTERVAL_MS } from './sse-keepalive.js';
import { isSessionProjectionPath, stripSessionProjections } from './session-strip.js';

/**
 * 浏览器对 opaque origin（sandboxed iframe、data:、file: 等）发送的 Origin 字面量。
 * 它绝不能进入任何白名单：放行它等于放行任意来源。
 */
const OPAQUE_ORIGIN = 'null';

/** hop-by-hop 头：描述"当前这一跳"的传输语义，不能透传。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** WebSocket 101 响应只放行这几个头，避免上游注入 set-cookie 等敏感头。 */
const WS_101_ALLOW = new Set([
  'connection', 'upgrade', 'sec-websocket-accept',
  'sec-websocket-extensions', 'sec-websocket-protocol',
]);

/** 本插件自己的管理端点前缀（不会被转发给 DSH）。 */
export const ENDPOINT_PREFIX = '/__dsh_porthole__';

export const AUTH_COOKIE = 'dsh_portal_auth';

/**
 * 归一化子路径前缀（用于把门户挂在某个二级目录下，如 nginx 的 /dsh/）。
 *
 * 约定：返回 `''`（挂在站点根）或形如 `/dsh` 的串（**不带**尾斜杠）。
 * 反代侧负责剥掉前缀（`proxy_pass http://127.0.0.1:3082/;` 的尾斜杠），
 * 本插件只知道「对外我是谁」，用它来拼接重定向 Location 与 Cookie Path。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBasePath(value) {
  const r = validateBasePath(value);
  return r.ok ? r.value : '';
}

/**
 * 校验并归一化 basePath。与 normalizeBasePath 的区别：**非法值会报错**而不是静默变成根。
 * 面板保存时必须用这个——否则用户填了 `/dsh/../x` 会以为生效了，实际回落成站点根。
 *
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateBasePath(value) {
  let p = String(value ?? '').trim();
  if (!p || p === '/') return { ok: true, value: '' };
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  p = stripTrailingSlashes(p);
  if (p.includes('..')) {
    return { ok: false, error: 'basePath 不能包含 ".."（路径穿越）' };
  }
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(p)) {
    return { ok: false, error: 'basePath 只允许字母、数字与 . _ ~ - / 这些字符' };
  }
  if (p.length > 200) {
    return { ok: false, error: 'basePath 过长（上限 200 字符）' };
  }
  return { ok: true, value: p };
}

/**
 * 校验监听地址。只接受「全网卡」与「回环」两类，避免把端口暴露到意料之外的网卡。
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateHost(value) {
  const h = String(value ?? '').trim();
  if (h === '' || h === '0.0.0.0') return { ok: true, value: '0.0.0.0' };
  if (h === '127.0.0.1' || h === 'localhost') return { ok: true, value: '127.0.0.1' };
  if (h === '::' || h === '::1') return { ok: true, value: h };
  return { ok: false, error: `不支持的监听地址：${h}（可选 0.0.0.0 / 127.0.0.1 / ::1）` };
}

export function sanitizeProxyHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export function stripTrailingSlashes(value) {
  const text = String(value ?? '');
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) end -= 1;
  return text.slice(0, end);
}

/**
 * 改写请求头，让 DSH 的回环安全栅栏放行，并注入合法的 loopback 会话 cookie。
 *
 * 三件事：
 *   1. Host / Origin / Referer 改写成 127.0.0.1:<dshPort>（DSH 会校验来源）；
 *   2. 注入 DSH 原生鉴权 cookie（浏览器持有的是代理 origin 的 cookie，绑定 authority 不同，
 *      不注入则一律 401）—— 先按名剔除浏览器残留同名旧值，否则宿主"同名取第一个"会读到旧值；
 *   3. 去掉 accept-encoding —— 代理层要拿到确定性字节，压缩交给客户端与 DSH 之间的直通。
 *
 * @param {Record<string, any>} headers 入站请求头
 * @param {number} targetPort
 * @returns {{headers: Record<string, any>, cookie: {names: string[], authority: string}|null}}
 */
export function loopbackHeaders(headers, targetPort) {
  const authority = `127.0.0.1:${targetPort}`;
  const out = { ...headers };
  out.host = authority;

  for (const key of ['origin', 'Origin']) {
    if (out[key]) out[key] = `http://${authority}`;
  }
  for (const key of ['referer', 'Referer']) {
    if (!out[key]) continue;
    try {
      const url = new URL(out[key]);
      out[key] = `http://${authority}${url.pathname}${url.search}`;
    } catch {
      delete out[key];
    }
  }

  const dshCookies = getDshLoopbackCookies(targetPort);
  let cookie = null;
  if (dshCookies.length > 0) {
    const names = dshCookies.map((entry) => entry.slice(0, entry.indexOf('=')));
    let cleaned = out.cookie || out.Cookie || '';
    for (const name of names) cleaned = stripCookieByName(cleaned, name);
    const joined = dshCookies.join('; ');
    out.cookie = cleaned ? `${cleaned}; ${joined}` : joined;
    delete out.Cookie;
    cookie = { names, authority };
  }

  delete out['accept-encoding'];
  delete out['Accept-Encoding'];

  return { headers: out, cookie };
}

export class LiteProxy {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort 对外监听端口
   * @param {number} opts.targetPort DSH 回环端口
   * @param {AuthManager} opts.authManager
   * @param {() => string[]} [opts.allowedOrigins] 允许跨域领取 adminToken 的面板来源
   * @param {string} [opts.basePath] 对外挂载的二级目录前缀（如 '/dsh'）；'' = 站点根
   * @param {string} [opts.host] 监听地址；默认 0.0.0.0，前面挂 nginx 时可改 127.0.0.1
   * @param {object} [opts.logger]
   * @param {boolean} [opts.sseKeepalive]
   */
  constructor({ listenPort, targetPort, authManager, allowedOrigins, basePath = '', host = '0.0.0.0', logger, sseKeepalive = true }) {
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    this.authManager = authManager;
    this.allowedOrigins = allowedOrigins ?? (() => []);
    this.basePath = normalizeBasePath(basePath);
    this.host = String(host || '0.0.0.0');
    this.logger = logger;
    this.sseKeepalive = sseKeepalive !== false;
    this.server = null;
    /** @type {Set<import('node:net').Socket>} */
    this.clientSockets = new Set();
    this._cookieWarned = false;
  }

  get port() { return this.listenPort; }
  get activeConnections() { return this.clientSockets.size; }

  /**
   * 会话 Cookie 的 Path：挂在二级目录时收敛到该前缀（`/dsh`），
   * 避免同一域名下的其它应用也收到这枚令牌。站点根时仍为 `/`。
   */
  get cookiePath() {
    return this.basePath || '/';
  }

  /** 把站内绝对路径拼上对外前缀（用于 302 Location）。 */
  _publicPath(pathname) {
    const p = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
    return `${this.basePath}${p === '/' ? '/' : p}`;
  }

  _warnCookieMissing() {
    if (this._cookieWarned) return;
    this._cookieWarned = true;
    this.logger?.warn?.(
      'dsh-porthole: 未能从 ~/.dsh/.credentials.yaml 生成 loopback 会话 cookie，'
      + '经代理访问会返回 401。请确认 DSH 已正常启动过并生成该凭据文件。',
    );
  }

  /** 该 IP 是否因连续输错密码被封禁（封禁状态由 AuthManager 维护）。 */
  isBlocked(ip) {
    const rec = this.authManager?.rateLimits?.get(ip);
    return Boolean(rec?.lockUntil && rec.lockUntil > Date.now());
  }

  async start() {
    if (this.server) return;
    const server = createServer((req, res) => this._handleHttp(req, res));
    server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
    server.on('connection', (sock) => {
      this.clientSockets.add(sock);
      sock.on('close', () => this.clientSockets.delete(sock));
      sock.on('error', () => {});
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // 0.0.0.0：局域网内其它设备才连得进来
      server.listen(this.listenPort, this.host, () => {
        // listenPort 传 0 时由系统分配：回填实际端口，避免 logger 与状态面板显示 0
        const actual = server.address();
        if (actual && typeof actual === 'object') this.listenPort = actual.port;
        this.logger?.info?.('dsh-porthole: 代理已启动 %s:%d -> 127.0.0.1:%d', this.host, this.listenPort, this.targetPort);
        resolve();
      });
    });
    this.server = server;
  }

  async stop() {
    if (!this.server) return;
    for (const s of this.clientSockets) { try { s.destroy(); } catch { /* 已断开 */ } }
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.clientSockets.clear();
  }

  /**
   * 端口被占用时的自愈：换一个端口重新监听。
   * @param {number} nextPort
   */
  async restartOn(nextPort) {
    await this.stop();
    this.listenPort = nextPort;
    await this.start();
  }

  // ------------------------------------------------------------------
  // 内置端点：登录 / 登出 / 鉴权状态 / 本机特权令牌
  // ------------------------------------------------------------------
  _handleBuiltin(req, res, pathname) {
    if (pathname === `${ENDPOINT_PREFIX}/login` && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
        const clientIp = req.socket?.remoteAddress || '';
        const lang = pickLoginLang(req.headers['accept-language']);
        let verify;
        try {
          verify = await this.authManager.verifyPassword(body.password, clientIp);
        } catch {
          verify = { success: false, error: 'internal' };
        }
        if (verify.success) {
          const sessionToken = this.authManager.createSession();
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `${AUTH_COOKIE}=${sessionToken}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: localizeAuthError(verify.error || '访问密码错误', lang) }));
        }
      });
      return true;
    }

    if (pathname === `${ENDPOINT_PREFIX}/logout` && req.method === 'POST') {
      const token = readSessionCookie(req.headers?.cookie);
      this.authManager.revokeSession(token);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${AUTH_COOKIE}=; Path=${this.cookiePath}; HttpOnly; Max-Age=0`,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (pathname === `${ENDPOINT_PREFIX}/auth-status` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ...this.authManager.getPublicStatus(),
        loopback: isLoopbackAddress(req.socket?.remoteAddress || ''),
      }));
      return true;
    }

    // 本机特权令牌签发：仅限真正物理回环连接。
    //
    // 用途：电脑自己浏览器打开面板时，凭它拿到管理权限，无需反复输管理密码。
    // 安全要点（三条缺一不可）：
    //   1. 只认 remoteAddress 为回环 —— 隧道/反代转发来的流量 remoteAddress 也是回环，
    //      所以还必须叠加第 2 条；
    //   2. Host 必须是回环名 —— 外部域名解析到本机时 Host 不会是 127.0.0.1；
    //   3. 带 Origin 的浏览器请求必须命中允许来源白名单，否则直接 403 且不签发
    //      （不依赖"浏览器会因缺 ACAO 而拦下响应"这一 CORS 实现细节）。
    if (pathname === `${ENDPOINT_PREFIX}/loopback-token`) {
      let corsOrigin;
      {
        const origin = req.headers?.origin;
        // opaque origin（字面量 "null"）永不授权：它代表 sandboxed iframe / data: / file:
        if (origin && origin !== OPAQUE_ORIGIN) {
          try {
            const allowed = new Set(this.allowedOrigins?.() ?? []);
            if (allowed.has(origin)) corsOrigin = origin;
          } catch { /* 来源计算失败则不放开跨域 */ }
        }
      }
      // 用「头是否存在」而不是真值判断：空 Origin 同样是"浏览器给了来源但未获授权"
      if (Object.hasOwn(req.headers ?? {}, 'origin') && !corsOrigin) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          Vary: 'Origin',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden: origin not allowed' }));
        return true;
      }

      const corsHeaders = {
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, Vary: 'Origin' } : { Vary: 'Origin' }),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        // 响应体含 adminToken：禁止任何缓存留存
        'Cache-Control': 'no-store',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return true;
      }

      const remote = req.socket?.remoteAddress || '';
      const host = String(req.headers?.host || '');
      const hostIsLoopback = host.startsWith('127.0.0.1')
        || host.startsWith('localhost')
        || host.startsWith('[::1]')
        || host === '';
      const isLoopback = isLoopbackAddress(remote);

      // 管理保护关闭 或 策略为 open 时，本机不需要令牌也有管理权限；
      // 这里仍按需签发，让前端逻辑统一。
      if (isLoopback && hostIsLoopback && this.authManager) {
        const adminToken = this.authManager.createAdminSession();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, adminToken }));
        return true;
      }

      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden: loopback only' }));
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------
  _handleHttp(req, res) {
    let pathname;
    try {
      pathname = stripTrailingSlashes((req.url || '/').split('?')[0]) || '/';
    } catch { pathname = '/'; }

    if (pathname.startsWith(ENDPOINT_PREFIX)) {
      if (this._handleBuiltin(req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }

    const auth = this.authManager.verifyRequest(req);

    // URL Token 直通：下发 Cookie，然后 302 到干净 URL（避免 token 留在地址栏/历史里）
    if (auth.fromToken) {
      const sessionToken = this.authManager.createSession();
      let location = '/';
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        urlObj.searchParams.delete('auth');
        urlObj.searchParams.delete('token');
        location = (urlObj.pathname || '/') + (urlObj.search || '');
      } catch { /* 用默认 '/' */ }
      res.writeHead(302, {
        // 挂在二级目录时，站内绝对路径必须补回对外前缀，否则浏览器会被甩到站点根、
        // 离开 /dsh/ 这棵子树（表现为扫码登录后 404）。
        Location: this._publicPath(location),
        'Set-Cookie': `${AUTH_COOKIE}=${sessionToken}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    if (!auth.authenticated) {
      const accept = String(req.headers.accept || '');
      const isHtml = accept.includes('text/html') || (!pathname.startsWith('/api/') && !pathname.includes('.'));
      const clientIp = req.socket?.remoteAddress || '';
      const locked = this.isBlocked(clientIp);
      if (isHtml) {
        const html = renderLoginPage({
          hasPassword: this.authManager.hasPassword,
          locked,
          error: locked ? '尝试次数过多，请 60 秒后再试' : '',
          lang: pickLoginLang(req.headers['accept-language']),
        });
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'unauthorized', message: '需要访问认证，请先登录' }));
      }
      return;
    }

    this._forwardHttp(req, res, pathname);
  }

  _forwardHttp(req, res, pathname) {
    const { headers, cookie } = loopbackHeaders(req.headers, this.targetPort);
    if (!cookie) this._warnCookieMissing();

    const proxyReq = httpRequest(
      { host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url, headers, agent: false },
      (proxyRes) => {
        // 会话投影剥离（session/list）：contextHeaders / contextTimeline 每会话可达数 MB
        // 且没有客户端 UI 读取（打开会话走 WebSocket 实时获取），剥离后传输体积降一个量级。
        // 只缓冲命中端点的 200 响应，其余一律直通，绝不碰无关流量。
        if (proxyRes.statusCode === 200 && isSessionProjectionPath(pathname)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const raw = Buffer.concat(chunks);
            const { body, stripped } = stripSessionProjections(
              pathname, raw, proxyRes.headers['content-encoding'],
            );
            const outHeaders = sanitizeProxyHeaders(proxyRes.headers);
            if (stripped) {
              // 剥离后的 body 已是明文：压缩标记必须去掉，长度必须重算，
              // 否则客户端解 gzip 会炸 / 定长解析会错位
              delete outHeaders['content-encoding'];
              delete outHeaders['transfer-encoding'];
              outHeaders['content-length'] = String(body.length);
            }
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(stripped ? body : raw);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }

        // 直通分支：剔除 hop-by-hop 头，Node 会自行生成正确的传输头
        res.writeHead(proxyRes.statusCode ?? 502, sanitizeProxyHeaders(proxyRes.headers));

        const keepalive = this.sseKeepalive && isSseKeepaliveCandidate(proxyRes.headers)
          ? createSseKeepalive({
              write: (frame) => { if (!res.writableEnded && !res.destroyed) res.write(frame); },
              intervalMs: SSE_KEEPALIVE_INTERVAL_MS,
              onWriteError: () => {},
            })
          : null;
        if (keepalive) {
          proxyRes.on('data', keepalive.poke);
          proxyRes.on('end', keepalive.stop);
          res.on('close', keepalive.stop);
        }

        proxyRes.pipe(res);
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
        void pathname;
      },
    );

    proxyReq.on('error', (err) => {
      this.logger?.error?.('dsh-porthole: 代理请求失败: %s', err.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-porthole: 无法连接 dsh web (127.0.0.1:${this.targetPort}) — ${err.message}`);
    });

    req.pipe(proxyReq);
  }

  // ------------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------------
  _handleUpgrade(req, socket, head) {
    const auth = this.authManager.verifyRequest(req);
    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized\r\n');
      socket.destroy();
      return;
    }

    const { headers, cookie } = loopbackHeaders(req.headers, this.targetPort);
    if (!cookie) this._warnCookieMissing();

    const proxyReq = httpRequest({
      host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url, headers, agent: false,
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!WS_101_ALLOW.has(k.toLowerCase())) continue;
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      const teardown = () => {
        try { proxySocket.destroy(); } catch { /* 已关闭 */ }
        try { socket.destroy(); } catch { /* 已关闭 */ }
      };
      // 上游 socket 必须有 'error' 监听者，否则一次 RST 就会变成未捕获异常打死进程
      proxySocket.on('error', teardown);
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
    });

    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(sanitizeProxyHeaders(proxyRes.headers))) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        socket.end(`${raw.join('\r\n')}\r\n\r\n`);
        proxyRes.resume();
      } catch { socket.destroy(); }
    });

    proxyReq.on('error', () => socket.destroy());
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  }
}
