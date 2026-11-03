// lib/connection-compat.js —— connection RPC 注册的宿主侧回归兼容垫片
//
// 问题（上游 dsh-client-connection 的 bug，不是本插件的声明问题）
// ---------------------------------------------------------------
// DSH 0.1.5-alpha.1 起改了插件级服务声明：
//     ≤ 0.1.3-alpha.2    inject = ["webServer", "credentials"]
//     ≥ 0.1.5-alpha.1    inject = ["credentials"]      // webServer 改为可选
// 同时把 /api 路由改用作用域注入 `ctx.inject(["webServer"], ...)`。
// 但 HostConnectionService.register() 里那一句没有同步改：
//     return owner.effect(() => owner.webServer.register(route), ...)
// 其中 `owner` 是 **connection 插件自己的 ctx**（get rpc() { const owner = this.ctx }），
// 它的 fiber 不再把 webServer 记入 inject，于是 cordis 4 的服务守卫直接抛：
//     cannot get property "webServer" without inject
//
// 实测命中版本：0.2.1-rc.5（本机 DeepSeek Harness 桌面版）。
// 表现为插件条目不激活（`1 entry did not activate`），代理与面板全都不工作。
//
// 本垫片怎么做
// ---------------------------------------------------------------
// 不改宿主代码、不猜私有方法，只走两个公开面：
//   1. 正常路径：ctx.connection.rpc.handle(channel, handler)（公开 API，上游修好后即恢复）；
//   2. 兜底路径：仅当该调用抛出 "webServer … without inject" 时，在 root 的
//      `internal/get` 瀑布事件上临时挂一个监听器 —— 先让默认解析跑，默认解析失败
//      （抛出的正是同一个 error 对象）才补上本插件已通过 inject 拿到的 webServer 引用。
//      webServer 是单例服务，语义等价；默认解析成功时零干预。
//
// 监听器只在这一次同步注册调用期间存在，返回后立即摘除（cordis 的 effect 同步执行，
// 注册完成后 owner.webServer 不再被访问），因此对宿主其余部分完全无副作用。
//
// 上游修好后本模块自动空转：首次调用不再抛错，兜底分支根本不会进入。

const MISSING_INJECT = /without inject/;

/**
 * 判断错误是否为「跨服务取属性缺 inject 作用域」的守卫错误，且对象是 webServer。
 * @param {unknown} err 捕获到的异常
 * @returns {boolean}
 */
export function isMissingWebServerInjectError(err) {
  if (!(err instanceof Error)) return false;
  return MISSING_INJECT.test(err.message) && /webServer/.test(err.message);
}

/**
 * 在 root 的 `internal/get` 瀑布事件上挂一个临时兜底：默认解析失败时提供 webServer。
 *
 * cordis 4 的 `ctx.events` 是所有子 ctx 共享的同一个实例，且 `internal/get` 派发时
 * 不带 context 过滤条件（thisArg 为 null），因此在本插件 ctx 上注册的监听器同样会对
 * connection 插件 ctx 的查找生效。监听器由 root fiber 持有，须手工摘除。
 *
 * @param {object} ctx 本插件的 ctx
 * @returns {() => void} 摘除函数
 */
export function installWebServerResolutionFallback(ctx) {
  const webServer = ctx?.webServer;
  if (webServer === undefined) return () => {};

  const listener = function (lookupCtx, prop, error, next) {
    if (prop !== 'webServer') return next();
    try {
      return next();
    } catch (err) {
      // 默认解析抛的不是本次守卫错误 → 原样上抛，绝不掩盖真实故障
      if (err !== error) throw err;
    }
    // 默认解析确认失败：补上本插件已 inject 的单例引用（语义等价）
    return webServer;
  };

  const off = ctx.on?.('internal/get', listener, { global: true });
  return typeof off === 'function' ? off : () => {};
}

/**
 * 注册 connection RPC 通道，并兼容 DSH ≥ 0.1.5-alpha.1 的 webServer 注入回归。
 *
 * @param {object} ctx 本插件的 ctx（须已 inject `connection` 与 `webServer`）
 * @param {string} channel RPC 通道名
 * @param {Function} handler 通道处理器
 * @param {object} [logger] 可选日志器
 * @returns {Function} 由 connection 服务返回的处置函数
 */
export function registerRpcChannel(ctx, channel, handler, logger) {
  try {
    return ctx.connection.rpc.handle(channel, handler);
  } catch (err) {
    if (!isMissingWebServerInjectError(err)) throw err;

    // 上游回归：owner（connection 插件自己的 ctx）解析不到 webServer。
    // 该调用在 owner.webServer 处、于 webServer.register() 之前就抛，未产生任何副作用，
    // 因此可以安全地补上兜底后重试一次。
    const dispose = installWebServerResolutionFallback(ctx);
    try {
      const registered = ctx.connection.rpc.handle(channel, handler);
      logger?.warn?.(
        'dsh-porthole: 检测到宿主 DSH 的 connection RPC 注册回归'
        + '（cannot get property "webServer" without inject）；已用 webServer 解析兜底完成通道注册。'
        + '此为宿主侧问题，插件侧垫片会在上游修复后自动空转。',
      );
      return registered;
    } finally {
      dispose();
    }
  }
}
