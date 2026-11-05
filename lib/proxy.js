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
import { AUTH_COOKIE_NAME, isLoopbackAddress, readSessionCookie } from './auth/manager.js';
import { renderLoginPage, localizeAuthError, pickLoginLang } from './auth/login-template.js';
import { isSseKeepaliveCandidate, createSseKeepalive, SSE_KEEPALIVE_INTERVAL_MS } from './sse-keepalive.js';
import { isSessionProjectionPath, stripSessionProjections } from './session-strip.js';
import {
  DEFAULT_TRUSTED_PROXIES,
  normalizeTrustedProxies,
  isTrustedProxy,
  validateExternalPrefix,
} from './security/proxy-prefix.js';

/**
 * 浏览器对 opaque origin（sandboxed iframe、data:、file: 等）发送的 Origin 字面量。
 * 它绝不能进入任何白名单：放行它等于放行任意来源。
 */
const OPAQUE_ORIGIN = 'null';

/**
 * 官方桌面版（Electron）面板页面的固定来源。
 *
 * 桌面窗口加载的是 `dsh-app://app`（见桌面壳 main.js：`protocol === "dsh-app:" &&
 * hostname === "app"`），它向 `127.0.0.1:<port>` 领取 adminToken 属于跨源请求。
 *
 * 关键点：`new URL('dsh-app://app').origin` 是字符串 `"null"`（opaque），
 * 所以它**必须作为字面量**进白名单，绝不能经过任何 origin 归一化函数——
 * 否则 "null" 会被当成普通值放行，等于放行所有 sandboxed iframe / data: / file: 页面。
 *
 * 维护动作：桌面壳若更换协议名，需同步更新这里的字面量，否则桌面面板会退化为
 * 「管理类操作无反应」（拿不到 adminToken）。
 */
export const DESKTOP_APP_ORIGIN = 'dsh-app://app';

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

// 会话 cookie 名的唯一来源在 auth/manager.js，这里只做别名导出，避免两处各写一份
const AUTH_COOKIE = AUTH_COOKIE_NAME;
export { AUTH_COOKIE };

/** DSH 自带的公开 PWA 元数据与图标；只允许匿名 GET/HEAD 精确读取。 */
const PUBLIC_PWA_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg']);

/**
 * 校验监听地址。只接受「全网卡」与「回环」两类，避免把端口暴露到意料之外的网卡。
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateHost(value, availableAddresses = []) {
  const h = String(value ?? '').trim();
  if (h === '' || h === '0.0.0.0') return { ok: true, value: '0.0.0.0' };
  if (h === '127.0.0.1' || h === 'localhost') return { ok: true, value: '127.0.0.1' };
  if (h === '::' || h === '::1') return { ok: true, value: h };

  // 允许绑定到本机任意一张网卡的具体地址（类似 Clash 的「监听地址」下拉）。
  // 必须校验它确实存在于当前网卡上：绑一个不存在的地址会让 listen 直接
  // EADDRNOTAVAIL，用户只会看到「端口被占用」这种误导性错误。
  const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
  if (isIPv4 && (availableAddresses ?? []).includes(h)) {
    return { ok: true, value: h };
  }

  const options = ['0.0.0.0', '127.0.0.1', ...(availableAddresses ?? [])];
  return {
    ok: false,
    error: isIPv4
      ? `${h} 不是本机当前网卡地址（可选：${options.join(' / ')}）`
      : `不支持的监听地址：${h}（可选：${options.join(' / ')}）`,
  };
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
 * 判断一个未登录的 GET/HEAD 请求是否是「导航请求」（浏览器地址栏打开页面）。
 *
 * 用于决定「深层路径未登录」时是 302 到登录入口还是返回 401 JSON。判定偏保守：
 *   - 明确 `Accept: text/html`（浏览器地址栏默认值）→ 是；
 *   - `Sec-Fetch-Mode: navigate`（现代浏览器的导航标记）→ 是；
 *   - `Sec-Fetch-Dest: document|iframe|frame` → 是；
 *   - 其余（fetch API、XHR、SSE、Accept: application/json / text/event-stream 等）→ 否。
 *
 * 注意：这里**不**用「路径里没有点」来猜测 HTML —— 那会把 API 端点误判成导航。
 * 是否为根路径由调用方单独处理（根缺 Accept 也算登录入口）。
 *
 * @param {string} method
 * @param {string} accept
 * @param {Record<string, any>} [headers]
 * @returns {boolean}
 */
export function isNavigationRequest(method, accept, headers = {}) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const a = String(accept || '').toLowerCase();
  if (a.includes('application/json') || a.includes('text/event-stream')) return false;
  const mode = String(headers['sec-fetch-mode'] || '').toLowerCase();
  if (mode) return mode === 'navigate';
  if (a.includes('text/html') || a.includes('application/xhtml+xml')) return true;
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest === 'document' || dest === 'iframe' || dest === 'frame') return true;
  return false;
}

/**
 * 改写请求头，让 DSH 的回环安全栅栏放行，并注入合法的 loopback 会话 cookie。
 *
 * 三件事：
 *   1. Host / Origin / Referer 改写成 127.0.0.1:<dshPort>（DSH 会校验来源）；
 *   2. 注入 DSH 原生鉴权 cookie（浏览器持有的是代理 origin 的 cookie，绑定 authority 不同，
 *      不注入则一律 401）—— 先按名剔除浏览器残留同名旧值，否则宿主"同名取第一个"会读到旧值；
 *   3. **保留** accept-encoding。
 *
 * 关于第 3 点：上游 dsh-bridge 会把 accept-encoding 删掉，因为它需要拿到未压缩 HTML
 * 去注入 ownsHost / polyfill / PWA head。本插件完全不注入 HTML，这条约束对它不成立，
 * 删掉只会白扔 DSH 自带的 gzip —— 实测主 bundle 941 KB → 320 KB（省 66%），
 * 移动端首屏差别明显。会话投影剥离路径本身支持 gunzip（见 session-strip.js）。
 *
 * @param {Record<string, any>} headers 入站请求头
 * @param {number} targetPort
 * @returns {{headers: Record<string, any>, cookie: {names: string[], authority: string}|null}}
 */
export function loopbackHeaders(headers, targetPort) {
  const authority = `127.0.0.1:${targetPort}`;
  const out = { ...headers };
  // DSH receives internal paths; the external mount belongs to this proxy only.
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'x-forwarded-prefix') delete out[key];
  }
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

  // 有意**不删** accept-encoding：让 DSH 自己按客户端能力压缩，详见函数头注释。
  return { headers: out, cookie };
}

export class LiteProxy {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort 对外监听端口
   * @param {number} opts.targetPort DSH 回环端口
   * @param {AuthManager} opts.authManager
   * @param {() => string[]} [opts.allowedOrigins] 允许跨域领取 adminToken 的面板来源
   * @param {string} [opts.host] 监听地址；默认 0.0.0.0，前面挂 nginx 时可改 127.0.0.1
   * @param {string[]} [opts.trustedProxies] 可信前置代理的 socket.remoteAddress 白名单。
   *   默认 ['127.0.0.1','::1']（IPv4-mapped IPv6 等价）。本地回环是**不可移除的基线**，
   *   自定义数组是在基线上**追加**；空数组仍然信任本地回环。
   *   只有来自可信代理的连接才允许消费 X-Forwarded-Prefix。
   * @param {object} [opts.logger]
   * @param {boolean} [opts.sseKeepalive]
   */
  constructor({
    listenPort, targetPort, authManager, allowedOrigins, host = '0.0.0.0',
    trustedProxies = DEFAULT_TRUSTED_PROXIES, logger, sseKeepalive = true,
  }) {
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    this.authManager = authManager;
    this.allowedOrigins = allowedOrigins ?? (() => []);
    this.host = String(host || '0.0.0.0');
    /** 已归一化的可信代理地址（精确 remoteAddress 匹配，非 CIDR） */
    this.trustedProxies = normalizeTrustedProxies(trustedProxies);
    this.logger = logger;
    this.sseKeepalive = sseKeepalive !== false;
    this.server = null;
    /** @type {Set<import('node:net').Socket>} */
    this.clientSockets = new Set();
    this._cookieWarned = false;
  }

  get port() { return this.listenPort; }
  get activeConnections() { return this.clientSockets.size; }

  /** Resolve the browser-visible prefix without changing this request's internal URL. */
  _resolveMountContext(req) {
    const remote = req.socket?.remoteAddress || '';
    if (isTrustedProxy(remote, this.trustedProxies)) {
      const rawHeaders = req.rawHeaders ?? [];
      let occurrences = 0;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i].toLowerCase() === 'x-forwarded-prefix') occurrences += 1;
      }
      if (occurrences > 1) return { ok: false, error: '重复的 X-Forwarded-Prefix' };
      const raw = req.headers?.['x-forwarded-prefix'];
      if (raw !== undefined) {
        const prefix = validateExternalPrefix(raw);
        if (!prefix.ok) return prefix;
        return { ok: true, exportPrefix: prefix.value, cookiePath: prefix.value || '/' };
      }
    }
    return { ok: true, exportPrefix: '', cookiePath: '/' };
  }

  /**
   * 把站内绝对路径拼上对外前缀（用于 302 Location）。
   *
   * 输出**永远是站内绝对路径**（以单个 `/` 开头），绝不生成 `http://host:port`。
   * @param {string} pathname 站内路径（以 / 开头）
   * @param {string} exportPrefix 对外前缀（'' = 根，或 '/dsh'）
   */
  _publicPath(pathname, exportPrefix = '') {
    const raw = String(pathname ?? '');
    if (!raw.startsWith('/') || raw.startsWith('//')) {
      // 防御：拒绝协议相对/相对路径混入 Location
      return `${exportPrefix}/`;
    }
    const qIdx = raw.indexOf('?');
    const p = qIdx === -1 ? raw : raw.slice(0, qIdx);
    const query = qIdx === -1 ? '' : raw.slice(qIdx);
    const joined = `${exportPrefix}${p === '/' ? '/' : p}`;
    return `${joined || '/'}${query}`;
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
  _handleBuiltin(req, res, pathname, ctx) {
    const cookiePath = ctx.cookiePath || '/';
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
            'Set-Cookie': `${AUTH_COOKIE}=${sessionToken}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
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
        'Set-Cookie': `${AUTH_COOKIE}=; Path=${cookiePath}; HttpOnly; Max-Age=0`,
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

      // 桌面壳（Electron）的固定来源，网页无法伪造（普通 http 页面拿不到该值）。
      // 绑具体网卡时本机只能连该网卡地址（remoteAddress/Host 都是网卡 IP），
      // 与局域网远端设备无法用地址区分；但桌面壳的 Origin `dsh-app://app` 是
      // 确定的「本机」特征，故据此对「桌面壳 + Host 命中本插件绑定地址」放行。
      const originHeader = req.headers?.origin;
      const isDesktopShell = originHeader === DESKTOP_APP_ORIGIN;
      const boundHost = this.host && this.host !== '0.0.0.0' ? this.host : '';
      const hostMatchesBound = boundHost !== ''
        && (host === boundHost || host.startsWith(`${boundHost}:`));

      // 管理保护关闭 或 策略为 open 时，本机不需要令牌也有管理权限；
      // 这里仍按需签发，让前端逻辑统一。
      if (((isLoopback && hostIsLoopback) || (isDesktopShell && hostMatchesBound)) && this.authManager) {
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
    // 计算本请求的对外上下文（纯请求级，绝不变异实例/req.url）。
    // 不可信头忽略；可信但非法前缀 → 400（HTTP）。
    const ctx = this._resolveMountContext(req);
    if (!ctx.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'bad-request', message: '非法的代理前缀' }));
      return;
    }

    // nginx owns prefix stripping; forward its internal URL unchanged.
    const upstreamUrl = req.url || '/';
    let pathname;
    try {
      pathname = stripTrailingSlashes((upstreamUrl || '/').split('?')[0]) || '/';
    } catch { pathname = '/'; }

    if (pathname.startsWith(ENDPOINT_PREFIX)) {
      if (this._handleBuiltin(req, res, pathname, ctx)) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }

    const auth = this.authManager.verifyRequest(req);

    // manifest 加载默认不携带凭据，已登录的浏览器也可能不发送门户 Cookie。
    // 精确匹配内部原路径；尾斜杠或同名子路径不能借此绕过认证。
    if ((req.method === 'GET' || req.method === 'HEAD')
      && PUBLIC_PWA_PATHS.has(upstreamUrl.split('?')[0])) {
      this._forwardHttp(req, res, pathname, upstreamUrl);
      return;
    }

    // URL Token 直通：下发 Cookie，然后 302 到干净 URL（避免 token 留在地址栏/历史里）
    if (auth.fromToken) {
      const sessionToken = this.authManager.createSession();
      let location = '/';
      try {
        // 清理内部 URL 的令牌，再补一次可信代理声明的外部前缀。
        const urlObj = new URL(upstreamUrl, 'http://localhost');
        urlObj.searchParams.delete('auth');
        urlObj.searchParams.delete('token');
        location = (urlObj.pathname || '/') + (urlObj.search || '');
      } catch { /* 用默认 '/' */ }
      res.writeHead(302, {
        // 站内绝对路径 + 对外前缀；绝不生成 http://host:port
        Location: this._publicPath(location, ctx.exportPrefix),
        'Set-Cookie': `${AUTH_COOKIE}=${sessionToken}; Path=${ctx.cookiePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    if (!auth.authenticated) {
      this._handleUnauthenticated(req, res, pathname, ctx);
      return;
    }

    this._forwardHttp(req, res, pathname, upstreamUrl);
  }

  /**
   * 未登录请求的响应决策。
   *
   * 固定登录入口 = 外部应用根（如 /dsh/，内部 /）。
   *   - 根路径 GET/HEAD：返回 401 登录 HTML（缺 Accept 也按导航处理）；
   *   - 深层 GET/HEAD 且明确 Accept:text/html 或导航请求：302 到登录入口；
   *   - 其它（API、非 HTML fetch、SSE、POST 等）：401 JSON。
   * 全部只产生站内绝对 Location，不生成 http://内部:端口，也不从 Host/Origin 构造跳转。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname 已剥前缀的内部路径（尾斜杠已归一）
   * @param {{exportPrefix: string, cookiePath: string}} ctx
   */
  _handleUnauthenticated(req, res, pathname, ctx) {
    const method = req.method || 'GET';
    const isRead = method === 'GET' || method === 'HEAD';
    const isRoot = pathname === '/';

    if (!isRead) {
      // 写请求（POST 等）一律 401 JSON，绝不跳转、绝不返回 HTML
      this._writeJson(res, 401, { error: 'unauthorized', message: '需要访问认证，请先登录' });
      return;
    }

    const accept = String(req.headers?.accept || '');
    const isApi = /^\/(?:api|bsk-observation|plugins)(?:\/|$)/.test(pathname);
    const isNav = !isApi && (isNavigationRequest(method, accept, req.headers)
      || (isRoot && !accept && !req.headers?.['sec-fetch-mode']));

    if (isRoot && isNav) {
      // 固定登录入口：401 + 登录 HTML
      const clientIp = req.socket?.remoteAddress || '';
      const locked = this.isBlocked(clientIp);
      const html = renderLoginPage({
        hasPassword: this.authManager.hasPassword,
        locked,
        error: locked ? '尝试次数过多，请 60 秒后再试' : '',
        lang: pickLoginLang(req.headers['accept-language']),
      });
      res.writeHead(401, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (isNav) {
      // 深层导航：302 到固定登录入口（应用根）。只针对站内路径，避免被外部前缀带偏。
      const entry = ctx.exportPrefix ? `${ctx.exportPrefix}/` : '/';
      res.writeHead(302, { Location: entry, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // API / 非 HTML fetch / SSE 等
    this._writeJson(res, 401, { error: 'unauthorized', message: '需要访问认证，请先登录' });
  }

  _writeJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  _forwardHttp(req, res, pathname, upstreamUrl = req.url) {
    const { headers, cookie } = loopbackHeaders(req.headers, this.targetPort);
    if (!cookie) this._warnCookieMissing();

    const proxyReq = httpRequest(
      { host: '127.0.0.1', port: this.targetPort, method: req.method, path: upstreamUrl, headers, agent: false },
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
    // 与 HTTP 相同的对外上下文；WS 上非法前缀同样 400（升级握手阶段）
    const ctx = this._resolveMountContext(req);
    if (!ctx.ok) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad proxy prefix\r\n');
      socket.destroy();
      return;
    }

    const auth = this.authManager.verifyRequest(req);
    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized\r\n');
      socket.destroy();
      return;
    }

    // CSWSH 纵深防御：浏览器发起的升级请求若带 Origin，必须满足以下之一：
    //   1. Origin 与本次请求的 Host 同源（覆盖 nginx 外部域名 / HTTPS / 局域网 IP）；
    //   2. 命中面板来源白名单（覆盖 dsh-app://app 与跨端口面板场景）。
    // 缺失 Origin 一律放行（ws 库 / 命令行 / 隧道转发等非浏览器客户端通常不带）。
    const origin = req.headers?.origin;
    if (origin) {
      let allowed = [];
      try { allowed = this.allowedOrigins?.() ?? []; } catch { allowed = []; }
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === String(req.headers?.host || ''); } catch { /* opaque/invalid */ }
      if (origin === OPAQUE_ORIGIN || (!sameOrigin && !allowed.includes(origin))) {
        this.logger?.warn?.(`dsh-porthole: 拒绝来源不明的 WebSocket 升级请求 (Origin=${origin})`);
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden\r\n');
        socket.destroy();
        return;
      }
    }

    const { headers, cookie } = loopbackHeaders(req.headers, this.targetPort);
    if (!cookie) this._warnCookieMissing();

    const proxyReq = httpRequest({
      host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url || '/', headers, agent: false,
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
