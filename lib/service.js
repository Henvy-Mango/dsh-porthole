// lib/service.js —— Lite 版服务主体
//
// 职责闭环：
//   1. 持有代理（监听 0.0.0.0:<port>）；
//   2. 计算对外的局域网访问地址（多网卡最佳 IP + 端口 + 可选 ?auth=token）；
//   3. 持久化三样东西：监听端口、选中的网卡 IP、认证配置；
//   4. 可自检的诊断接口；
//   5. 远程工作区管理：浏览本机目录、把目录注册进 DSH（走宿主 workspaceRegistry）。
//
// 上游那套"隧道 / IM 平台 / 升级 / 重启 / 系统指标"不在这里。

import { listAllLanIPv4, selectLanIPv4 } from './net.js';
import { LiteProxy, validateBasePath, validateHost, DESKTOP_APP_ORIGIN } from './proxy.js';
import { request as httpRequest } from 'node:http';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat, access } from 'node:fs/promises';
import { isSafeWorkspacePath, isSensitiveFolderName } from './security/path-validator.js';

const DEFAULT_PORT = 3082;

export class BridgeLiteService {
  /**
   * @param {object} opts
   * @param {number} opts.dshPort DSH 自身回环端口
   * @param {number} [opts.port] 代理监听端口
   * @param {import('./auth/manager.js').AuthManager} opts.authManager
   * @param {(patch: object) => Promise<any>} [opts.persist]
   * @param {object} [opts.logger]
   * @param {boolean} [opts.sseKeepalive]
   * @param {object} [opts.hostCtx] DSH 插件 ctx：工作区注册与会话创建经由它完成。
   *   注意必须显式传入——上游 dsh-bridge 把这段写在 `this.ctx` 上却从未赋值，
   *   导致其 getWorkspaces/addWorkspace 实际拿不到 workspaceRegistry（静默退化）。
   */
  constructor({ dshPort, port = DEFAULT_PORT, basePath = '', host = '0.0.0.0', authManager, persist, logger, sseKeepalive = true, hostCtx = null }) {
    this.dshPort = dshPort;
    this.port = port;
    this.basePath = basePath;
    this.host = host;
    this.authManager = authManager;
    this.persist = persist;
    this.logger = logger;
    this.sseKeepalive = sseKeepalive;
    this.hostCtx = hostCtx;
    /** @type {LiteProxy|null} */
    this.proxy = null;
    this.lastError = null;
  }

  async start() {
    if (this.proxy) return;
    const proxy = new LiteProxy({
      listenPort: this.port,
      targetPort: this.dshPort,
      authManager: this.authManager,
      allowedOrigins: () => this.allowedOrigins(),
      basePath: this.basePath,
      host: this.host,
      logger: this.logger,
      sseKeepalive: this.sseKeepalive,
    });
    try {
      await proxy.start();
      this.proxy = proxy;
      // port 传 0 时由系统分配：回填实际端口，否则 getStatus / 访问地址都会显示 0
      this.port = proxy.listenPort;
      this.lastError = null;
    } catch (err) {
      this.lastError = `代理启动失败（端口 ${this.port}）：${err?.code === 'EADDRINUSE' ? '端口已被占用' : err?.message ?? err}`;
      this.logger?.error?.('dsh-porthole: %s', this.lastError);
      throw err;
    }
  }

  async stop() {
    if (!this.proxy) return;
    await this.proxy.stop();
    this.proxy = null;
  }

  async restartProxy() {
    await this.stop();
    await this.start();
  }

  /**
   * 当前应展示的局域网 IP：优先用户选中的（且本机仍存在），否则自动挑最佳。
   * @returns {string|null}
   */
  resolveLanIp() {
    // 绑定了具体地址时，对外展示就用它（否则会显示一个"能看不能连"的地址）
    if (this.host && this.host !== '0.0.0.0') return this.host;
    return selectLanIPv4();
  }

  /** 修改监听端口并持久化（下次重启生效；这里顺手热重启一次）。 */
  async setPort(nextPort) {
    if (nextPort === this.port) return;
    const prev = this.port;
    this.port = nextPort;
    await this.persist?.({ port: nextPort });
    try {
      if (this.proxy) await this.proxy.restartOn(nextPort);
    } catch (err) {
      // 新端口起不来：回滚到旧端口，避免用户把自己锁在门外
      this.logger?.error?.('dsh-porthole: 端口切换失败，回滚到 %d: %s', prev, err?.message ?? err);
      this.port = prev;
      await this.persist?.({ port: prev });
      await this.start().catch(() => {});
      throw new Error(`端口 ${nextPort} 启动失败，已回滚到 ${prev}`);
    }
  }

  /**
   * 修改反向代理的挂载配置（basePath / host）。
   *
   * 语义：
   *   - basePath 只影响本插件**未来产出**的 Location 与 Cookie Path，改完立刻生效；
   *   - host 决定监听哪张网卡，必须重新 bind，因此触发一次代理重启。
   *
   * 风险（面板会强提示）：把 basePath 改成一个 nginx 并未配置的前缀后，
   * 浏览器侧登录跳转会落到不存在的路径。救援通道是本机 `127.0.0.1` 免密访问，
   * 或直接改 `~/.dsh/dsh-porthole/config.json` 后重启宿主。
   *
   * @param {{basePath?: string, host?: string}} patch
   */
  async setProxyConfig({ basePath, host } = {}) {
    let nextBase = this.basePath;
    let nextHost = this.host;

    if (basePath !== undefined) {
      const r = validateBasePath(basePath);
      if (!r.ok) throw new Error(r.error);
      nextBase = r.value;
    }
    if (host !== undefined) {
      const r = validateHost(host, listAllLanIPv4().map((i) => i.address));
      if (!r.ok) throw new Error(r.error);
      nextHost = r.value;
    }

    const hostChanged = nextHost !== this.host;
    this.basePath = nextBase;
    this.host = nextHost;

    // basePath 立刻作用到运行中的代理（Location / Cookie Path）
    if (this.proxy) this.proxy.basePath = nextBase;

    await this.persist?.({ basePath: this.basePath, host: this.host });

    if (hostChanged && this.proxy) {
      await this.restartProxy();
    }

    this.logger?.info?.(
      'dsh-porthole: 挂载配置已更新 (basePath=%s, host=%s%s)',
      this.basePath || '(站点根)', this.host, hostChanged ? ', 已重启代理' : '',
    );
    return this.getStatus();
  }

  /**
   * 对外访问地址。
   * @param {{includeToken?: boolean}} [opts]
   * @returns {Promise<string|null>}
   */
  /**
   * 对外的展示地址（面板显示、复制、二维码都用它）。
   *
   * 统一以 `/` 结尾：这是「拿去浏览器打开的地址」，不是路径前缀。
   *   - 站点根：`http://ip:3082/`
   *   - 挂在 /dsh：`http://ip:3082/dsh/`
   * 内部前缀匹配用的 `basePath` 仍是不带尾斜杠的规范值，两者互不影响。
   *
   * @returns {string|null}
   */
  getDisplayUrl() {
    const ip = this.resolveLanIp();
    if (!ip) return null;
    return `http://${ip}:${this.port}${this.basePath}/`;
  }

  async getAccessUrl({ includeToken = false } = {}) {
    const display = this.getDisplayUrl();
    if (!display) return null;
    if (!includeToken) return display;
    // 只有"开了认证"时 token 才有意义（否则是裸奔状态，带 token 反而会误导）
    if (!this.authManager?.enabled) return display;
    // display 已以 / 结尾，直接接 query（写成 `${display}/?auth=` 会得到 //?auth=）
    return `${display}?auth=${encodeURIComponent(this.authManager.secretToken)}`;
  }

  /**
   * 允许跨域领取本机特权令牌的面板来源白名单。
   *
   * 只包含「本插件自己会生成的面板地址」：回环两种写法 + 当前生效的局域网地址。
   * 不放通配符，也不放 opaque origin（`null`）—— 否则任意网页都能借用户浏览器
   * 在回环上领走 adminToken。
   * @returns {string[]}
   */
  allowedOrigins() {
    const list = new Set();
    const pushHttp = (origin) => {
      if (!origin) return;
      try {
        const u = new URL(origin);
        if (u.protocol === 'http:' || u.protocol === 'https:') list.add(u.origin);
      } catch { /* 非法 origin 丢弃 */ }
    };
    pushHttp(`http://127.0.0.1:${this.port}`);
    pushHttp(`http://localhost:${this.port}`);
    const ip = this.resolveLanIp();
    if (ip) pushHttp(`http://${ip}:${this.port}`);
    pushHttp(`http://127.0.0.1:${this.dshPort}`);

    // 官方桌面版（Electron）的面板来源是自定义协议 `dsh-app://app`。
    // 它对 new URL().origin 来说是 opaque 的（会得到字符串 "null"），因此**必须写死字面量**，
    // 绝不能走 pushHttp：把 "null" 放进白名单等于放行任意 sandboxed iframe。
    //
    // 为什么可以放行这个字面量：Origin 由浏览器生成、网页无法伪造；普通 http(s) 页面
    // 拿不到 `dsh-app://app` 这个值。且它仍受「remoteAddress 必须是回环 + Host 必须是回环」
    // 两道闸约束，不会成为远程攻击面。
    //
    // 漏掉它的后果（桌面版实测）：面板拿不到 adminToken → 管理类控件全部禁用/无反应。
    list.add(DESKTOP_APP_ORIGIN);
    return [...list];
  }

  /**
   * 面板状态快照。
   * @param {{adminAuthValid?: boolean}} [opts] 是否已解锁管理员（决定 secretToken 是否脱敏）
   */
  async getStatus({ adminAuthValid = false } = {}) {
    const lanIp = this.resolveLanIp();
    return {
      version: this.constructor.VERSION ?? '',
      // 面板页脚展示用：升级后是否真的生效，一眼可查
      basePath: this.basePath || '',
      host: this.host || '0.0.0.0',
      dsh: { port: this.dshPort },
      proxy: {
        running: Boolean(this.proxy),
        port: this.port,
        activeConnections: this.proxy?.activeConnections ?? 0,
        sseKeepalive: Boolean(this.sseKeepalive),
        error: this.lastError,
      },
      lan: {
        ip: lanIp,
        interfaces: listAllLanIPv4(),
        // 面板顶部展示 / 复制 / 二维码用的地址：带挂载前缀，且以 / 结尾
        url: this.getDisplayUrl(),
      },
      auth: this.authManager?.getStatus({ masked: !adminAuthValid }) ?? { enabled: false },
    };
  }

  // ---------------- 远程工作区管理 ----------------

  /** 列出已注册工作区（宿主 workspaceRegistry）。 */
  async getWorkspaces() {
    try {
      const list = await this.hostCtx?.workspaceRegistry?.list?.() ?? [];
      const out = [];
      for (const ws of list ?? []) {
        if (ws && ws.path) {
          out.push({
            id: ws.id,
            title: ws.title ?? basename(ws.path),
            path: ws.path,
          });
        }
      }
      return out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    } catch (err) {
      this.logger?.warn?.('dsh-porthole: 读取工作区列表失败: %s', err?.message ?? err);
      return [];
    }
  }

  /**
   * 把一个目录注册进 DSH 工作区（含安全校验与会话初始化）。
   * @param {string} workspacePath
   */
  async addWorkspace(workspacePath) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { ok: false, error: '缺少工作区目录路径' };
    }
    const safetyCheck = await isSafeWorkspacePath(workspacePath);
    if (!safetyCheck.valid) {
      return { ok: false, error: safetyCheck.error || '路径安全校验未通过' };
    }
    const resolved = safetyCheck.path;
    const title = basename(resolved) || resolved;
    let added = false;
    let workspaceId = null;

    // workspaceRegistry 的 API 形态随宿主版本演进过三种（create / add / register），
    // 逐个探测可用面，全部失败再报错——与上游一致，但上游因 ctx 未接线而从不走到这里。
    const registry = this.hostCtx?.workspaceRegistry;
    if (registry) {
      if (typeof registry.create === 'function') {
        try {
          const entity = await registry.create(resolved, title);
          added = true;
          workspaceId = entity?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('dsh-porthole: workspaceRegistry.create 失败: %s', e.message);
        }
      } else if (typeof registry.add === 'function') {
        try {
          const res = await registry.add({ path: resolved, title });
          added = true;
          workspaceId = res?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('dsh-porthole: workspaceRegistry.add 失败: %s', e.message);
        }
      } else if (typeof registry.register === 'function') {
        try {
          const res = await registry.register({ path: resolved, title });
          added = true;
          workspaceId = res?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('dsh-porthole: workspaceRegistry.register 失败: %s', e.message);
        }
      }
    } else {
      this.logger?.warn?.('dsh-porthole: 宿主未提供 workspaceRegistry 服务，无法注册工作区');
    }

    const list = await this.getWorkspaces();
    if (!workspaceId) {
      const match = list.find((w) => w.path === resolved
        || (w.path && w.path.toLowerCase() === resolved.toLowerCase()));
      if (match) workspaceId = match.id;
    }

    // 顺手建一个以该目录为 cwd 的会话并挂到工作区上（失败不阻断注册结果）
    let sessionId = null;
    if (this.hostCtx?.sessions && typeof this.hostCtx.sessions.create === 'function') {
      try {
        const session = this.hostCtx.sessions.create(undefined, { meta: { cwd: resolved } });
        if (session?.id) {
          sessionId = session.id;
          if (workspaceId && registry?.get) {
            const entity = registry.get(workspaceId);
            if (entity && typeof entity.attachSession === 'function') {
              await entity.attachSession(session.id).catch(() => {});
            }
          }
        }
      } catch (e) {
        this.logger?.debug?.('dsh-porthole: sessions.create 初始化会话提示: %s', e.message);
      }
    }

    return {
      ok: true,
      path: resolved,
      title,
      workspaceId,
      sessionId,
      workspaces: list,
      registered: added,
    };
  }

  /**
   * 浏览本机目录（供面板选工作区用）：常用根目录 / 盘符 / 面包屑 / 子目录列表。
   * 敏感目录与不安全符号链接一律过滤；非法目标安全回退到用户主目录。
   * @param {string} [targetPath]
   */
  async listRemoteDirectories(targetPath) {
    const isWin = process.platform === 'win32';
    const home = homedir();

    // 1. 快速访问根目录
    const roots = [{ name: '🏠 用户主目录', path: home }];
    const commonSubdirs = [
      { name: '💻 桌面', sub: 'Desktop' },
      { name: '📁 文档', sub: 'Documents' },
      { name: '📥 下载', sub: 'Downloads' },
      { name: '💡 IdeaProjects', sub: 'IdeaProjects' },
      { name: '🔨 Projects', sub: 'Projects' },
      { name: '📦 workspace', sub: 'workspace' },
      { name: '💻 code', sub: 'code' },
      { name: '💻 src', sub: 'src' },
    ];
    for (const item of commonSubdirs) {
      const fullPath = join(home, item.sub);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) roots.push({ name: item.name, path: fullPath });
      } catch { /* 不存在则不列 */ }
    }

    // 2. Windows 盘符探测
    const drives = [];
    if (isWin) {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      for (const letter of letters) {
        const driveRoot = `${letter}:\\`;
        try {
          await access(driveRoot);
          drives.push({ name: `${letter}: 盘`, path: driveRoot });
        } catch { /* 无此盘符 */ }
      }
      if (drives.length === 0) drives.push({ name: 'C: 盘', path: 'C:\\' });
    } else {
      drives.push({ name: '根目录 /', path: '/' });
    }

    // 3. 解析目标路径并安全校验
    let rawTarget = targetPath && typeof targetPath === 'string' ? targetPath.trim() : '';
    if (isWin && /^[A-Za-z]:$/.test(rawTarget)) rawTarget = `${rawTarget}\\`;
    const candidatePath = rawTarget ? resolve(rawTarget) : home;

    let currentPath = home;
    const pathCheck = await isSafeWorkspacePath(candidatePath);
    if (pathCheck.valid && pathCheck.path) currentPath = pathCheck.path;

    // 4. 子目录列表（过滤敏感目录与不安全软链接）
    const entries = [];
    let readError = null;
    try {
      const dirents = await readdir(currentPath, { withFileTypes: true });
      for (const d of dirents) {
        if (isSensitiveFolderName(d.name)) continue;

        let isDir = d.isDirectory();
        const targetEntryPath = join(currentPath, d.name);

        if (d.isSymbolicLink()) {
          try {
            const symCheck = await isSafeWorkspacePath(targetEntryPath);
            if (!symCheck.valid) continue;
            isDir = true;
          } catch {
            continue;
          }
        }

        if (isDir) {
          entries.push({ name: d.name, path: targetEntryPath, isDirectory: true });
        }
      }
    } catch (err) {
      readError = err.message;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parentPath = dirname(currentPath) !== currentPath ? dirname(currentPath) : null;

    // 5. 面包屑
    const breadcrumbs = [];
    if (isWin) {
      const match = currentPath.match(/^([A-Za-z]:)(?:\\(.*))?$/);
      if (match) {
        const driveLetter = match[1];
        const rest = match[2] || '';
        breadcrumbs.push({ name: driveLetter, path: `${driveLetter}\\` });
        if (rest) {
          let curr = `${driveLetter}\\`;
          for (const p of rest.split('\\').filter(Boolean)) {
            curr = join(curr, p);
            breadcrumbs.push({ name: p, path: curr });
          }
        }
      } else {
        breadcrumbs.push({ name: currentPath, path: currentPath });
      }
    } else {
      breadcrumbs.push({ name: '根目录 /', path: '/' });
      let curr = '/';
      for (const p of currentPath.split('/').filter(Boolean)) {
        curr = join(curr, p);
        breadcrumbs.push({ name: p, path: curr });
      }
    }

    // 6. 已注册工作区作快捷参考
    const workspaces = await this.getWorkspaces();

    return {
      ok: !readError,
      error: readError ? `读取文件夹失败: ${readError}` : undefined,
      currentPath,
      parentPath,
      breadcrumbs,
      entries: entries.slice(0, 150),
      totalEntries: entries.length,
      roots,
      drives,
      workspaces,
    };
  }

  /**
   * 局域网自检：代理端口可达性 + 上游 DSH 可达性 + 凭据可注入性。
   */
  async diagnose() {
    const checks = [];

    // 1. 上游 DSH 是否在自己声明的端口上应答
    checks.push({ id: 'upstream', label: 'DSH 服务', ...(await this._probe('127.0.0.1', this.dshPort, '/')) });

    // 2. 代理是否在监听
    checks.push({
      id: 'proxy',
      label: '局域网代理端口',
      ok: Boolean(this.proxy),
      detail: this.proxy ? `监听 0.0.0.0:${this.port}` : (this.lastError || '未启动'),
    });

    // 3. 网卡
    const ip = this.resolveLanIp();
    checks.push({
      id: 'lan',
      label: '局域网地址',
      ok: Boolean(ip),
      detail: ip ? `http://${ip}:${this.port}` : '未找到可用的局域网 IPv4 网卡',
    });

    // 4. loopback cookie 注入能力
    const { getDshLoopbackCookies } = await import('./auth/dsh-native-cookie.js');
    const cookies = getDshLoopbackCookies(this.dshPort);
    checks.push({
      id: 'cookie',
      label: 'DSH 回环凭据',
      ok: cookies.length > 0,
      detail: cookies.length > 0
        ? '已能生成 loopback 会话 cookie（远程访问不会 401）'
        : '未能生成：检查 ~/.dsh/.credentials.yaml 是否存在且含 client-connection/browser-session',
    });

    // 5. 门禁状态
    checks.push({
      id: 'auth',
      label: '访问门禁',
      ok: Boolean(this.authManager?.enabled),
      detail: this.authManager?.enabled
        ? '已开启：局域网设备需密码或扫码 token'
        : '未开启：同一局域网内任何设备都能直接进入（建议开启）',
      warnOnly: true,
    });

    return { checks, url: ip ? `http://${ip}:${this.port}` : null };
  }

  _probe(host, port, path, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const req = httpRequest({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve({ ok: true, detail: `127.0.0.1:${port} 应答 HTTP ${res.statusCode}` });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: `127.0.0.1:${port} 超时` }); });
      req.on('error', (err) => resolve({ ok: false, detail: `127.0.0.1:${port} 不可达：${err.code ?? err.message}` }));
      req.end();
    });
  }

  async dispose() {
    await this.stop();
  }
}
