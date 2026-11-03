// test/client-render.test.mjs —— 用真实 React 做服务端渲染，验证客户端 bundle 可用
//
// 覆盖：
//   1. bundle 符合 DSH 客户端加载协议，apply() 正确注册设置页章节；
//   2. 面板在「有数据 / 无数据 / 失败 / 已锁定 / 已解锁」五种状态下渲染正确且不抛错。
//
// 用 react-dom/server 而不是自造 hook 垫片：SSR 下 useState 会被真实执行一次，
// 拿到的是初始值，正好用来渲染我们注入的 initialStatus（副作用不跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** 加载 DSH 客户端 bundle，返回 { id, exports }。 */
async function loadBundle() {
  const src = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  let loaded = null;
  const win = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, exports: factory((mod) => (mod === 'react' ? React : (() => ({})))) };
      },
    },
  };
  new Function('window', `${src}\n`)(win);
  assert.ok(loaded, 'bundle 未调用 window.__ModuleLoader__.load');
  return loaded;
}

const BASE_AUTH = {
  enabled: true,
  mode: 'token_and_password',
  adminPolicy: 'password_unlock',
  adminProtection: true,
  hasPassword: true,
  hasAdminPassword: true,
  secretToken: 'dshl_abcdefgh****************',
  allowLoopback: true,
};

const FAKE_STATUS = {
  version: '1.0.0',
  dsh: { port: 3080 },
  proxy: { running: true, port: 3082, activeConnections: 3, sseKeepalive: true, error: null },
  lan: {
    ip: '192.168.1.20',
    selectedIp: '',
    interfaces: [
      { name: 'Wi-Fi', label: 'Wi-Fi (Wi-Fi 无线网卡)', address: '192.168.1.20', isVirtual: false },
      { name: 'vEthernet (WSL)', label: 'vEthernet (WSL) (虚拟网卡 / WSL / 虚拟机)', address: '172.29.16.1', isVirtual: true },
    ],
    url: 'http://192.168.1.20:3082',
  },
  auth: BASE_AUTH,
};

async function renderSection(props) {
  const loaded = await loadBundle();
  let registered = null;
  const ctx = {
    slots: {
      inject(_name, fn) { return fn(); },
      register(def, Component) { registered = { def, Component }; return () => {}; },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  };
  loaded.exports.apply(ctx);
  assert.ok(registered, 'apply() 必须注册 settings.section');
  return { loaded, registered, html: renderToStaticMarkup(React.createElement(registered.Component, props)) };
}

test('bundle：加载协议与导出面', async () => {
  const loaded = await loadBundle();
  assert.equal(loaded.id, 'dsh-porthole', 'loader id 必须等于 package.json 的 name');
  assert.equal(loaded.exports.name, 'dsh-porthole');
  assert.deepEqual(loaded.exports.inject, ['slots', 'connection']);
  assert.equal(typeof loaded.exports.apply, 'function');
  assert.equal(typeof loaded.exports.BridgePanel, 'function');
});

test('bundle：apply() 注册设置页章节「远程访问」', async () => {
  const { registered } = await renderSection({ initialStatus: FAKE_STATUS });
  assert.equal(registered.def.id, 'dsh-porthole');
  assert.equal(registered.def.order, 10);
  assert.equal(registered.def.label(), '远程访问');
});

test('面板：有数据时渲染四块卡片并正确展示状态', async () => {
  const { html } = await renderSection({ initialStatus: FAKE_STATUS, initialAdminToken: 'tok' });

  assert.match(html, /局域网访问/);
  assert.match(html, /安全认证/);
  assert.match(html, /工作区/, '应有工作区卡片（1.4）');
  assert.match(html, /自检/, '应有自检卡片');
  // SSR 不执行 effect：浏览列表处于「读取中…」，交互按钮由客户端拉取数据后出现
  assert.match(html, /已注册/, '工作区卡片应包含已注册列表区');
  assert.match(html, /运行自检/);

  assert.match(html, /http:\/\/192\.168\.1\.20:3082/, '应展示局域网地址');
  assert.match(html, /运行中 · 0\.0\.0\.0:3082 · 3 个连接/, '应展示运行状态与连接数');
  assert.match(html, /自动选择（当前 192\.168\.1\.20）/, '网卡下拉应回显当前 IP');
  assert.match(html, /vEthernet/, '网卡列表应包含虚拟网卡');
  assert.match(html, /Wi-Fi/, '网卡列表应包含物理网卡');

  // 安全认证卡片的关键控件
  assert.match(html, /<select/, '应有验证方式/防篡改策略下拉');
  assert.match(html, /密码 \+ 扫码令牌/);
  assert.match(html, /局域网可解锁/);
  assert.match(html, /修改配置需要管理权限/);
  assert.match(html, /127\.0\.0\.1 直连不用密码/);
  assert.match(html, /已设置/, '已设密码应显示"已设置"');

  // 已移除的能力不该出现
  for (const gone of ['Cloudflare', 'cloudflared', '隧道', '微信', 'Telegram', '飞书', 'PWA']) {
    assert.doesNotMatch(html, new RegExp(gone), `面板不应再出现「${gone}」相关能力`);
  }
});

test('面板：未解锁且已设密码 → 出现管理锁定条，工作区卡片显示引导', async () => {
  const { html } = await renderSection({ initialStatus: FAKE_STATUS });
  assert.match(html, /安全配置已锁定/);
  assert.match(html, /解锁/);
  assert.match(html, /未单独设置管理密码时，输入访问密码即可/);
  assert.match(html, /解锁管理员后可在这里浏览这台电脑的目录/, '工作区卡片未解锁时给引导而非空白');
});

test('面板：已解锁 → 不出现锁定条，且显示「锁定管理」入口', async () => {
  const { html } = await renderSection({ initialStatus: FAKE_STATUS, initialAdminToken: 'tok' });
  assert.doesNotMatch(html, /安全配置已锁定/);
  assert.match(html, /锁定管理/);
});

test('面板：local_only 策略下提示改用本机访问，且不渲染密码框', async () => {
  const { html } = await renderSection({
    initialStatus: {
      ...FAKE_STATUS,
      auth: { ...BASE_AUTH, adminPolicy: 'local_only' },
    },
  });
  assert.match(html, /仅限电脑本机/);
  assert.doesNotMatch(html, /placeholder="管理密码"/);
});

test('面板：未开认证时给出明确风险提示', async () => {
  const { html } = await renderSection({
    initialStatus: {
      ...FAKE_STATUS,
      auth: { ...BASE_AUTH, enabled: false, hasPassword: false, hasAdminPassword: false, secretToken: '' },
    },
  });
  assert.match(html, /未开启 · 同网段设备可直接进入/);
});

test('面板：管理保护关闭时给出警示', async () => {
  const { html } = await renderSection({
    initialStatus: {
      ...FAKE_STATUS,
      auth: { ...BASE_AUTH, adminProtection: false },
    },
    initialAdminToken: 'tok',
  });
  assert.match(html, /已关闭 · 局域网内任何人都能改配置/);
});

test('面板：无状态时渲染加载态（不渲染完整面板）', async () => {
  const { html } = await renderSection({});
  assert.match(html, /正在读取局域网访问状态/);
  assert.doesNotMatch(html, /安全认证/);
});

test('面板：代理未运行时展示错误原因与重启入口', async () => {
  const { html } = await renderSection({
    initialStatus: {
      ...FAKE_STATUS,
      proxy: { running: false, port: 3082, activeConnections: 0, error: '端口已被占用' },
    },
    initialAdminToken: 'tok',
  });
  assert.match(html, /端口已被占用/);
  assert.match(html, /重启代理/);
});
