// dsh-porthole 主插件（Host）
//
// 只做一件事：给本机 DSH 开一扇局域网门 —— 反向代理 + 扫码直连 + 访问门禁。
//
// 和上游 dsh-bridge 的关系：这是它的能力子集重写，不是 fork。
// 上游那份 lib/index.js 有 3082 行、inject 七个服务，绝大多数代码服务于
// 公网隧道 / 四家 IM 机器人 / 升级重启 / 移动端页面改写 —— 这些在 Lite 里一个都不需要。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises';

import { BridgeLiteService } from './service.js';
import { normalizeBasePath, validateBasePath, validateHost } from './proxy.js';
import { AuthManager } from './auth/manager.js';
import { installRpc } from './rpc.js';
import { installAbortSignalCompat } from './compat.js';
import { listAllLanIPv4 } from './net.js';
import { PLUGIN_NAME } from './constants.js';

const PACKAGE_JSON = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

const name = PLUGIN_NAME;

// connection：RPC 通道；webServer：取宿主端口。
// workspaceRegistry + sessions：远程工作区管理（浏览/注册目录、挂会话）需要宿主的这两个服务。
// 注意：声明 workspaceRegistry/sessions 后 apply 拿到的 ctx 才有它们；
// 上游 dsh-bridge 声明了同样的服务却把使用处写在从未赋值的 this.ctx 上（静默失效）。
const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessions'];

const CONFIG_FILE_MODE = 0o600;

/**
 * 应急复位：检测 `~/.dsh/dsh-porthole/reset-auth` 标记文件。
 *
 * 场景：用户在面板里把「仅密码模式」开到了一个自己也想不起来的密码上，
 * 或者管理密码丢了 —— 此时面板进不去，唯一的自救通道就是终端里
 * `touch ~/.dsh/dsh-porthole/reset-auth`，重启 DSH 后全量密码与策略被清空。
 *
 * 标记文件先删除再生效：复位是一次性的，避免每次启动都重复清空配置。
 *
 * @returns {Promise<boolean>} 是否执行了复位
 */
export async function checkEmergencyReset({ resetFile, authManager, updateStoredConfig, logger } = {}) {
  try {
    await unlink(resetFile);
  } catch {
    return false; // 文件不存在 = 没有复位请求，这是常态
  }
  authManager.enabled = false;
  authManager.mode = 'token_and_password';
  authManager.adminPolicy = 'password_unlock';
  authManager.adminProtection = true;
  authManager.passwordHash = '';
  authManager.passwordSalt = '';
  authManager.adminPasswordHash = '';
  authManager.adminPasswordSalt = '';
  authManager.allowLoopback = true;
  authManager.sessions.clear();
  authManager.adminSessions.clear();
  authManager.rateLimits.clear();
  authManager._adminUnlockFailures = 0;
  authManager._adminUnlockLockUntil = 0;
  await updateStoredConfig((stored) => {
    delete stored.auth;
    return stored;
  });
  logger?.warn?.(
    'dsh-porthole: [保命救急] 检测到 reset-auth 标记文件，'
    + '已重置所有访问密码、管理密码与安全策略（secretToken 保留，二维码仍然有效）',
  );
  return true;
}

/**
 * 从落盘配置恢复认证状态（应急复位优先）。
 *
 * 逐字段白名单式恢复，避免把配置里的任意字段无脑赋到实例上。
 *
 * @param {object} args
 * @param {import('./auth/manager.js').AuthManager} args.authManager
 * @param {string} args.configFile
 * @param {() => Promise<object>} args.loadStoredConfig
 * @param {(fn: (s: object) => object) => Promise<any>} args.updateStoredConfig
 * @param {object} [args.logger]
 * @param {string} [args.resetFile]
 */
export async function applyStoredAuthConfig({
  authManager, configFile, loadStoredConfig, updateStoredConfig, logger, resetFile,
} = {}) {
  const reset = resetFile ?? join(dirname(configFile), 'reset-auth');

  if (await checkEmergencyReset({ resetFile: reset, authManager, updateStoredConfig, logger })) return;

  try {
    const stored = await loadStoredConfig();
    const auth = stored?.auth;
    if (!auth) return;

    if (auth.enabled != null) authManager.enabled = Boolean(auth.enabled);
    if (['token_and_password', 'password_only', 'token_only'].includes(auth.mode)) {
      authManager.mode = auth.mode;
    }
    if (['password_unlock', 'local_only', 'open'].includes(auth.adminPolicy)) {
      authManager.adminPolicy = auth.adminPolicy;
    }
    if (auth.adminProtection != null) authManager.adminProtection = auth.adminProtection !== false;
    if (typeof auth.passwordHash === 'string') authManager.passwordHash = auth.passwordHash;
    if (typeof auth.passwordSalt === 'string') authManager.passwordSalt = auth.passwordSalt;
    if (typeof auth.adminPasswordHash === 'string') authManager.adminPasswordHash = auth.adminPasswordHash;
    if (typeof auth.adminPasswordSalt === 'string') authManager.adminPasswordSalt = auth.adminPasswordSalt;
    if (typeof auth.secretToken === 'string' && auth.secretToken) authManager.secretToken = auth.secretToken;
    if (auth.allowLoopback != null) authManager.allowLoopback = Boolean(auth.allowLoopback);

    logger?.info?.(
      'dsh-porthole: 已载入认证配置 (enabled=%s, mode=%s, adminPolicy=%s, adminProtection=%s, hasPassword=%s, hasAdminPassword=%s)',
      authManager.enabled, authManager.mode, authManager.adminPolicy,
      authManager.adminProtection, authManager.hasPassword, authManager.hasAdminPassword,
    );
  } catch (err) {
    logger?.warn?.('dsh-porthole: 读取认证配置失败，使用默认值: %s', err?.message ?? err);
  }
}

/**
 * 解析插件配置。
 * @param {object} config 宿主传入的插件配置（cordis.yml）
 */
function resolveConfig(config = {}) {
  const port = Number(config.port);
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 3082,
    // 对外挂载的二级目录前缀（nginx 子路径反代时用），空 = 站点根
    basePath: normalizeBasePath(config.basePath ?? config.publicPath ?? ''),
    // 监听地址：前面挂 nginx 时设 127.0.0.1，避免绕过 nginx 直连
    host: typeof config.host === 'string' && config.host.trim() ? config.host.trim() : '0.0.0.0',
    sseKeepalive: config.sseKeepalive !== false,
  };
}

function apply(ctx, config = {}) {
  const logger = ctx.logger(name);
  const dshPort = ctx.webServer?.port ?? config.targetPort ?? 3080;

  if (installAbortSignalCompat()) {
    logger.warn('dsh-porthole: 当前 Node %s 缺少 AbortSignal.any/timeout，已安装兼容垫片。建议升级 Node 至 22.19+ 或 24+。', process.version);
  }

  if (!dshPort) {
    logger.error('dsh-porthole: 拿不到宿主 webServer.port，局域网代理无法启动');
    return;
  }

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dataDir = join(dshHome, PLUGIN_NAME);
  const configFile = join(dataDir, 'config.json');

  // 串行化读-改-写，避免代理重启/认证保存并发时互相覆盖
  let configQueue = Promise.resolve();

  async function loadStoredConfig() {
    try {
      return JSON.parse(await readFile(configFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async function writeStoredConfig(data) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(configFile, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE });
  }

  /** 读-改-写事务：整体入队，保证并发调用严格串行。 */
  function updateStoredConfig(mutate) {
    const task = configQueue.then(async () => {
      const current = await loadStoredConfig();
      const next = (await mutate(current)) ?? current;
      await writeStoredConfig(next);
      return next;
    });
    configQueue = task.catch((err) => {
      logger.error('dsh-porthole: 配置写入失败: %s', err?.message ?? err);
    });
    return task;
  }

  // 存量文件权限收敛（Windows 上 chmod 语义不同，失败只告警）
  void (async () => {
    try {
      await chmod(configFile, CONFIG_FILE_MODE);
    } catch { /* 文件尚不存在或平台不支持，忽略 */ }
  })();

  const resolved = resolveConfig(config);

  const authManager = new AuthManager({
    config: {},
    logger,
    onPersist: (patch) => updateStoredConfig((stored) => {
      stored.auth = { ...(stored.auth ?? {}), ...patch };
      return stored;
    }),
  });

  const service = new BridgeLiteService({
    dshPort,
    port: resolved.port,
    basePath: resolved.basePath,
    host: resolved.host,
    authManager,
    logger,
    sseKeepalive: resolved.sseKeepalive,
    hostCtx: ctx,
    persist: (patch) => updateStoredConfig((stored) => Object.assign(stored, patch)),
  });
  BridgeLiteService.VERSION = PACKAGE_JSON.version ?? '';

  // 启动链：先执行应急复位检查，再读落盘配置覆盖默认值，最后起代理。
  // 失败只记日志，绝不阻断宿主启动（否则一次端口占用就把整个 dsh web 拖死）。
  void (async () => {
    await applyStoredAuthConfig({ authManager, configFile, loadStoredConfig, updateStoredConfig, logger });

    try {
      const stored = await loadStoredConfig();
      if (Number.isInteger(stored?.port) && stored.port >= 1024 && stored.port <= 65535) {
        service.port = stored.port;
      }
      // 面板里改过的挂载配置优先于 cordis.yml（否则重启后会被配置文件覆盖回去）
      if (typeof stored?.basePath === 'string') {
        const r = validateBasePath(stored.basePath);
        if (r.ok) service.basePath = r.value;
        else logger.warn('dsh-porthole: 落盘的 basePath 非法，已忽略: %s', r.error);
      }
      if (typeof stored?.host === 'string') {
        const r = validateHost(stored.host, listAllLanIPv4().map((i) => i.address));
        if (r.ok) service.host = r.value;
        else logger.warn('dsh-porthole: 落盘的 host 非法，已忽略: %s', r.error);
      }
    } catch (err) {
      logger.warn('dsh-porthole: 读取落盘配置失败，使用默认值: %s', err?.message ?? err);
    }

    try {
      await service.start();
      const url = await service.getAccessUrl();
      if (url) logger.info('dsh-porthole: 局域网访问地址 %s', url);
    } catch (err) {
      logger.error('dsh-porthole: 局域网代理启动失败: %s', err?.message ?? err);
    }
  })();

  const disposeRpc = installRpc(ctx, { service, authManager, logger });

  ctx.effect(() => async () => {
    try { disposeRpc?.(); } catch { /* 通道已关闭 */ }
    authManager.dispose();
    await service.dispose();
  }, 'dsh-porthole: stop proxy and auth');
}

export { name, inject, apply };
export { BridgeLiteService } from './service.js';
export { LiteProxy } from './proxy.js';
export { AuthManager } from './auth/manager.js';
export { selectLanIPv4, listAllLanIPv4 } from './net.js';
