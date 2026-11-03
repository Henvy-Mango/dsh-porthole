// lib/rpc.js —— 控制台面板 ↔ 插件服务端 的 RPC 通道
//
// 鉴权模型与上游一致：这条通道由 DSH 的 connection 服务注册，**局域网访客也能经代理调到**
// （手机打开面板时用的就是它）。因此「谁能改安全配置」不能只靠"面板只有本机看得到"这种臆测，
// 必须在服务端逐调用校验管理员身份 —— 见 checkAdminAuth。
//
// 三级门槛：
//   - 无门槛：只读状态、二维码、自检、关闭访问认证（否则"关闭保护"会被保护本身锁死）
//   - 管理员：改模式 / 改密码 / 管理保护 / 管理策略 / 重置 Token / 改端口 / 改网卡 / 重启代理
//   - 管理员 + 必须先设过密码：极高危操作（这里没有隧道/备份，故实际未使用该档）

import QRCode from 'qrcode';
import { RateLimiter } from './security/rate-limiter.js';
import { registerRpcChannel } from './connection-compat.js';

export const BRIDGE_RPC_CHANNEL = '/dsh-porthole';

export const BRIDGE_ENDPOINTS = {
  getStatus: 'getStatus',
  setLanIp: 'setLanIp',
  setPort: 'setPort',
  restartProxy: 'restartProxy',
  setProxyConfig: 'setProxyConfig',
  getQr: 'getQr',
  diagnose: 'diagnose',
  // 访问安全认证
  authGetStatus: 'authGetStatus',
  authUpdateConfig: 'authUpdateConfig',
  authRegenerateToken: 'authRegenerateToken',
  authAdminUnlock: 'authAdminUnlock',
  authAdminLock: 'authAdminLock',
  // 远程工作区管理
  listWorkspaces: 'listWorkspaces',
  listRemoteDirectories: 'listRemoteDirectories',
  addRemoteWorkspace: 'addRemoteWorkspace',
};

const rpcRateLimiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });
// 目录浏览 / 添加工作区的独立限流（对齐上游：30/min 浏览、20/min 添加）
const dirListLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 });
const dirAddLimiter = new RateLimiter({ maxRequests: 20, windowMs: 60_000 });

function ok(value) { return { ok: true, value }; }

function fail(code, message) {
  const allowed = new Set(['bad-request', 'internal', 'settings-rejected', 'unauthorized']);
  return {
    ok: false,
    error: { code: allowed.has(code) ? code : 'bad-request', message, details: { issues: [{ message }] } },
  };
}

/**
 * 管理员鉴权校验。返回 null 表示放行，否则返回应直接回给客户端的错误对象。
 *
 * 判定顺序（与上游一致）：
 *   1. `local_only` 策略最严格：即便关闭了管理保护，也绝不远程放行。
 *      这里无法区分本机/远程（代理以回环转发），防线放在 `unlockAdmin` 拒绝远程解锁，
 *      因此这一档必须有有效 adminToken 才放行。
 *   2. 管理保护被显式关闭（`adminProtection === false`）→ 放行。
 *   3. 策略为 `open` → 放行。
 *   4. 系统从未设置过任何密码 → 放行（否则新用户连密码都设不了）。
 *   5. 其余情况：必须持有效 adminToken。
 *
 * @param {import('./auth/manager.js').AuthManager} authManager
 * @param {{adminToken?: string}} payload
 * @param {{requireConfigured?: boolean}} [opts]
 * @returns {null | {ok: false, error: any}}
 */
function checkAdminAuth(authManager, payload, { requireConfigured = false } = {}) {
  if (!authManager) return null;

  if (authManager.adminPolicy === 'local_only') {
    if (payload?.adminToken && authManager.validateAdminSession(payload.adminToken)) return null;
    return fail('unauthorized', '操作已被拦截：当前策略为仅限电脑本机管理');
  }

  if (authManager.adminProtection === false) return null;
  if (authManager.adminPolicy === 'open') return null;

  const hasAnyPassword = authManager.hasAdminPassword || authManager.hasPassword;

  // 极高危操作（备份导出/导入、隧道配置等）在从未设过密码时不再静默放行，
  // 杜绝"未设密码 = 局域网内任何人都能改全部配置"的裸奔状态被直接利用。
  if (requireConfigured && !hasAnyPassword) {
    return fail('bad-request', '该操作涉及敏感配置：请先在「安全认证」中设置访问密码或管理密码后再执行');
  }
  if (!hasAnyPassword) return null;

  if (payload?.adminToken && authManager.validateAdminSession(payload.adminToken)) return null;
  return fail('unauthorized', '操作已被拦截：需要管理员权限，请先在面板输入管理密码解锁');
}

/**
 * 注册 RPC 通道。
 *
 * 注意：DSH ≥ 0.1.5-alpha.1 存在 connection RPC 注册的宿主侧回归
 * （`cannot get property "webServer" without inject`）。Lite 不带那段兜底垫片，
 * 命中时插件树加载会失败并在日志里写明原文，详见 GAP-REPORT.md §4.2。
 *
 * @param {object} ctx 插件 ctx
 * @param {object} deps
 * @param {import('./service.js').BridgeLiteService} deps.service
 * @param {import('./auth/manager.js').AuthManager} deps.authManager
 * @param {object} deps.logger
 * @returns {Function} dispose
 */
export function installRpc(ctx, deps) {
  const { service, authManager, logger } = deps;

  /** 以「管理员视角」取一次服务状态。 */
  const adminStatus = async () => service.getStatus({ adminAuthValid: true });

  const handler = async (endpoint, payload = {}) => {
    if (!rpcRateLimiter.allow('rpc')) {
      return fail('bad-request', '操作过于频繁，请稍后再试');
    }
    try {
      switch (endpoint) {
        // ---------------- 只读状态 ----------------
        case BRIDGE_ENDPOINTS.getStatus: {
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          return ok(await service.getStatus({ adminAuthValid: isAdmin }));
        }

        case BRIDGE_ENDPOINTS.getQr: {
          // 二维码内嵌 secretToken，等价于一把钥匙：只有管理员能取。
          // 非管理员拿到的是不带 token 的裸地址。
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          const url = await service.getAccessUrl({ includeToken: isAdmin });
          if (!url) return ok({ url: null, dataUrl: null, withToken: false });
          const dataUrl = isAdmin
            ? await QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#1F2421', light: '#FFFFFF' } })
            : null;
          return ok({ url, dataUrl, withToken: isAdmin });
        }

        case BRIDGE_ENDPOINTS.diagnose:
          return ok(await service.diagnose());

        // ---------------- 网卡 / 端口（影响可达性，需管理员） ----------------
        case BRIDGE_ENDPOINTS.setLanIp: {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          const ip = payload.ip == null ? null : String(payload.ip).trim();
          await service.setLanIp(ip);
          return ok(await adminStatus());
        }

        case BRIDGE_ENDPOINTS.setPort: {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          const port = Number(payload.port);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return fail('bad-request', '端口必须是 1024–65535 之间的整数');
          }
          if (port === service.dshPort) {
            return fail('bad-request', '端口不能与 DSH 自身端口相同');
          }
          await service.setPort(port);
          return ok(await adminStatus());
        }

        // 挂载配置（nginx 子目录前缀 / 监听地址）：改错会失去面板访问，
        // 因此按高危处理——需要管理员，且从未设过密码时直接拒绝。
        case BRIDGE_ENDPOINTS.setProxyConfig: {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;
          const status = await service.setProxyConfig({
            basePath: payload?.basePath,
            host: payload?.host,
          });
          return ok(status);
        }

        case BRIDGE_ENDPOINTS.restartProxy: {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          await service.restartProxy();
          return ok(await adminStatus());
        }

        // ---------------- 访问安全认证 ----------------
        case BRIDGE_ENDPOINTS.authGetStatus: {
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          return ok(authManager.getStatus({ masked: !isAdmin }));
        }

        case BRIDGE_ENDPOINTS.authUpdateConfig: {
          const { enabled, mode, adminPolicy, adminProtection, password, adminPassword, allowLoopback } = payload ?? {};

          // 「首次初始化」豁免：某类密码从「未设置」变成「已设置」是初始化动作，不是篡改。
          //
          // 为什么必须有这条豁免：设完访客密码的下一毫秒 hasAnyPassword 就为真，
          // 若此时仍要求 adminToken，用户会在同一张卡片里被自己刚设的密码锁死
          // （想设管理密码 → 要求先解锁 → 解锁要用管理密码 → 还没设 → 死锁）。
          //
          // 为什么这样仍然安全：清除或修改**已存在**的密码依旧要管理员权限，
          // 攻击者无法把别人设好的密码换成自己的；而"谁先设谁得手"的窗口，
          // 在访问认证已开启时已被访客门禁挡住。
          const passwordIsBootstrap = password !== undefined && password !== '' && !authManager.hasPassword;
          const adminPasswordIsBootstrap = adminPassword !== undefined && adminPassword !== '' && !authManager.hasAdminPassword;

          // 仅切换 enabled 不需要管理权限：用户应能自由决定是否开放访问。
          // 否则"关闭访问认证"这个动作本身会被管理保护锁死
          // （死锁：关闭要先解锁，解锁要过访问认证）。
          const sensitive = mode !== undefined
            || adminPolicy !== undefined
            || adminProtection !== undefined
            || allowLoopback !== undefined
            || (password !== undefined && !passwordIsBootstrap)
            || (adminPassword !== undefined && !adminPasswordIsBootstrap);
          if (sensitive) {
            const adminErr = checkAdminAuth(authManager, payload);
            if (adminErr) return adminErr;
          }

          // 防自我锁死守卫：password_only（仅密码）模式下若从未设置任何密码，
          // 开启防护或维持该模式会把管理员锁在登录墙外
          // （无哈希可校验、密码登录被拒 → 进不去面板设密码 → 死锁）。
          // 因此：无任何密码时禁止单独开启 enabled（除非本次同请求携带 password），
          // 也禁止单独切换到 password_only（除非已设密码或本次带 password）。
          const willHaveNoPassword = !authManager.hasPassword && !authManager.hasAdminPassword
            && (password === undefined || !password);
          const nextMode = mode ?? authManager.mode;
          const nextEnabled = enabled ?? authManager.enabled;
          if (willHaveNoPassword && nextMode === 'password_only') {
            if (nextEnabled) {
              return fail('bad-request', '仅密码模式需要先设置访问密码：请先设置访客访问密码，再开启安全防护');
            }
            if (mode !== undefined) {
              return fail('bad-request', '仅密码模式需要先设置访问密码：请先设置访客访问密码后再切换');
            }
          }

          // token_only 模式同理：若连 token 都不可用（不可能，token 恒存在），无需额外守卫。
          // 但"关闭认证后又把模式设成 token_only"是安全的，放行。

          // 密码长度下限：空串=清除（允许），非空则至少 4 位。
          // 管理器本身不校验（与上游一致，保持 setPassword 语义单纯），长度策略集中在这一层。
          if (password !== undefined && password !== '' && String(password).length < 4) {
            return fail('bad-request', '访客密码至少 4 位');
          }
          if (adminPassword !== undefined && adminPassword !== '' && String(adminPassword).length < 4) {
            return fail('bad-request', '管理密码至少 4 位');
          }

          if (enabled != null) await authManager.setEnabled(enabled);
          if (mode != null) await authManager.setMode(mode);
          if (adminPolicy != null) await authManager.setAdminPolicy(adminPolicy);
          if (adminProtection != null) await authManager.setAdminProtection(adminProtection);
          if (allowLoopback != null) await authManager.setAllowLoopback(allowLoopback);
          if (password !== undefined) await authManager.setPassword(password);
          if (adminPassword !== undefined) await authManager.setAdminPassword(adminPassword);

          return ok(authManager.getStatus({ masked: false }));
        }

        case BRIDGE_ENDPOINTS.authRegenerateToken: {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          await authManager.regenerateSecretToken();
          return ok(authManager.getStatus({ masked: false }));
        }

        case BRIDGE_ENDPOINTS.authAdminUnlock: {
          const res = await authManager.unlockAdmin(payload?.password);
          if (res.ok) return ok({ adminToken: res.adminToken });
          return fail('unauthorized', res.error || '管理员密码错误');
        }

        case BRIDGE_ENDPOINTS.authAdminLock: {
          if (payload?.adminToken) authManager.revokeAdminSession(payload.adminToken);
          return ok({ locked: true });
        }

        // ---------------- 远程工作区管理 ----------------
        case BRIDGE_ENDPOINTS.listWorkspaces: {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          return ok(await service.getWorkspaces());
        }

        case BRIDGE_ENDPOINTS.listRemoteDirectories: {
          // 目录浏览能看到整台机器的文件夹结构，属高危：未设任何密码时强制先设密码
          // （上游 T2.9 的取舍：杜绝"未设密码 = 局域网内任何人都能枚举全盘目录"）。
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const clientKey = payload?.adminToken || 'dir-list';
          if (!dirListLimiter.allow(clientKey)) {
            return fail('bad-request', '目录浏览请求过于频繁，请稍后再试');
          }
          return ok(await service.listRemoteDirectories(payload?.path));
        }

        case BRIDGE_ENDPOINTS.addRemoteWorkspace: {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const clientKey = payload?.adminToken || 'dir-add';
          if (!dirAddLimiter.allow(clientKey)) {
            return fail('bad-request', '添加工作区请求过于频繁，请稍后再试');
          }
          return ok(await service.addWorkspace(payload?.path));
        }

        default:
          return fail('bad-request', `未知操作：${endpoint}`);
      }
    } catch (err) {
      logger?.error?.('dsh-porthole: RPC %s 失败: %s', endpoint, err?.stack ?? err);
      return fail('internal', err?.message ?? String(err));
    }
  };

  // 经由兼容垫片注册：DSH ≥ 0.1.5-alpha.1 的 connection 服务在 register() 里
  // 用自己（缺 webServer inject）的 ctx 去取 owner.webServer，会直接抛
  // `cannot get property "webServer" without inject`，导致本条目压根不激活。
  // 详见 lib/connection-compat.js。
  return registerRpcChannel(ctx, BRIDGE_RPC_CHANNEL, handler, logger);
}

export { checkAdminAuth, ok, fail };
