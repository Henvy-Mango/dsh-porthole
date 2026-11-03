// test/connection-compat.test.mjs —— DSH connection RPC 注册回归的兼容垫片
//
// 背景：DSH ≥ 0.1.5-alpha.1 的 dsh-client-connection 在 register() 里用自己
// （缺 webServer inject）的 ctx 去取 owner.webServer，抛
// `cannot get property "webServer" without inject`，插件条目不激活。
//
// 这些用例用「会抛该错误的假 connection 服务」复现回归，并验证：
//   1. 命中时垫片接管、注册最终成功、告警只发一次；
//   2. 上游修好后（不抛错）垫片完全空转，不做任何多余动作；
//   3. 其它错误不被吞掉，照常上抛；
//   4. 临时监听器用完即摘，不残留在 ctx 上。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMissingWebServerInjectError,
  installWebServerResolutionFallback,
  registerRpcChannel,
} from '../lib/connection-compat.js';

const GUARD_ERROR = () => new Error('cannot get property "webServer" without inject');

test('isMissingWebServerInjectError：精确识别守卫错误', () => {
  assert.equal(isMissingWebServerInjectError(GUARD_ERROR()), true);
  assert.equal(isMissingWebServerInjectError(new Error('cannot get property "foo" without inject')), false);
  assert.equal(isMissingWebServerInjectError(new Error('webServer exploded')), false);
  assert.equal(isMissingWebServerInjectError('cannot get property "webServer" without inject'), false, '非 Error 实例一律否');
  assert.equal(isMissingWebServerInjectError(null), false);
});

test('垫片：命中回归时接管并成功注册，且只告警一次', () => {
  const warnings = [];
  let attempts = 0;
  const ctx = {
    webServer: { port: 3080, register: () => {} },
    // 复现回归：owner（connection 自己的 ctx）拿不到 webServer
    connection: {
      rpc: {
        handle(channel, handler) {
          attempts += 1;
          if (attempts === 1) throw GUARD_ERROR();
          return () => {};
        },
      },
    },
    on(event, listener, options) {
      assert.equal(event, 'internal/get');
      assert.deepEqual(options, { global: true });
      assert.equal(typeof listener, 'function');
      return () => {};
    },
  };

  const dispose = registerRpcChannel(ctx, '/dsh-porthole', async () => ({}), {
    warn: (msg) => warnings.push(msg),
  });

  assert.equal(attempts, 2, '应在兜底后重试一次');
  assert.equal(typeof dispose, 'function');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /connection RPC 注册回归/);
});

test('垫片：上游已修复时不介入（零告警、零重试、不挂监听器）', () => {
  const warnings = [];
  let attempts = 0;
  let onCalls = 0;
  const ctx = {
    webServer: { port: 3080 },
    connection: {
      rpc: {
        handle() {
          attempts += 1;
          return () => {};
        },
      },
    },
    on() { onCalls += 1; return () => {}; },
  };

  registerRpcChannel(ctx, '/dsh-porthole', async () => ({}), { warn: (m) => warnings.push(m) });

  assert.equal(attempts, 1, '正常路径只调一次');
  assert.equal(warnings.length, 0);
  assert.equal(onCalls, 0, '不应挂 internal/get 监听器');
});

test('垫片：非回归错误必须原样上抛，不被吞掉', () => {
  const boom = new Error('channel already registered');
  const ctx = {
    webServer: { port: 3080 },
    connection: { rpc: { handle() { throw boom; } } },
    on() { return () => {}; },
  };

  assert.throws(
    () => registerRpcChannel(ctx, '/dsh-porthole', async () => ({})),
    (err) => err === boom,
  );
});

test('兜底监听器：默认解析成功时零干预', () => {
  let captured = null;
  const ctx = {
    webServer: { port: 3080 },
    on(_e, listener) { captured = listener; return () => {}; },
  };
  installWebServerResolutionFallback(ctx);
  assert.equal(typeof captured, 'function');

  const expected = { fake: 'resolved' };
  const next = () => expected;
  const out = captured({}, 'webServer', GUARD_ERROR(), next);
  assert.equal(out, expected, '默认解析成功就返回它的结果');
});

test('兜底监听器：默认解析抛同一个守卫错误时补上 webServer', () => {
  let captured = null;
  const webServer = { port: 3080, marker: 'the-real-one' };
  const ctx = {
    webServer,
    on(_e, listener) { captured = listener; return () => {}; },
  };
  installWebServerResolutionFallback(ctx);

  const guardError = GUARD_ERROR();
  const next = () => { throw guardError; };
  const out = captured({}, 'webServer', guardError, next);
  assert.equal(out, webServer, '应补上本插件已 inject 的单例引用');
});

test('兜底监听器：默认解析抛别的错误时原样上抛', () => {
  let captured = null;
  const ctx = {
    webServer: { port: 3080 },
    on(_e, listener) { captured = listener; return () => {}; },
  };
  installWebServerResolutionFallback(ctx);

  const other = new Error('genuine failure');
  const next = () => { throw other; };
  assert.throws(() => captured({}, 'webServer', GUARD_ERROR(), next), (err) => err === other);
});

test('兜底监听器：只对 webServer 属性生效', () => {
  let captured = null;
  const ctx = {
    webServer: { port: 3080 },
    on(_e, listener) { captured = listener; return () => {}; },
  };
  installWebServerResolutionFallback(ctx);

  const sentinel = { other: true };
  const out = captured({}, 'sessions', GUARD_ERROR(), () => sentinel);
  assert.equal(out, sentinel, '非 webServer 属性直接走默认解析');
});

test('兜底监听器：ctx 上没有 webServer 时返回空操作函数', () => {
  const off = installWebServerResolutionFallback({ on() { throw new Error('不该被调用'); } });
  assert.equal(typeof off, 'function');
  assert.doesNotThrow(() => off());
});
