// test/unit.test.mjs —— 网卡选择、认证管理器、登录页、RPC 常量契约
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { listAllLanIPv4, selectLanIPv4, isKnownLanIp } from '../lib/net.js';
import { AuthManager, isLoopbackAddress, readSessionCookie, AUTH_COOKIE_NAME } from '../lib/auth/manager.js';
import { renderLoginPage, pickLoginLang } from '../lib/auth/login-template.js';
import { BRIDGE_ENDPOINTS, BRIDGE_RPC_CHANNEL } from '../lib/rpc.js';
import { loopbackHeaders, sanitizeProxyHeaders } from '../lib/proxy.js';

// ---------------- 网卡 ----------------

test('网卡：物理网卡应排在虚拟网卡之前', () => {
  const fake = {
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.29.16.1', netmask: '255.255.240.0', internal: false }],
    'docker0': [{ family: 'IPv4', address: '172.17.0.1', netmask: '255.255.0.0', internal: false }],
    'lo': [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  };
  const list = listAllLanIPv4(fake);
  assert.equal(list.length, 3, '回环地址必须被过滤');
  assert.equal(list[0].address, '192.168.1.20');
  assert.equal(list[0].isVirtual, false);
  assert.match(list[0].label, /Wi-Fi/);
  assert.ok(list[1].isVirtual || list[2].isVirtual);
  assert.equal(selectLanIPv4(fake), '192.168.1.20');
  assert.equal(isKnownLanIp('192.168.1.20', list), true);
  assert.equal(isKnownLanIp('10.0.0.9', list), false);
});

test('网卡：只有虚拟网卡时仍能选出一个地址', () => {
  const fake = {
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.20.0.1', netmask: '255.255.240.0', internal: false }],
  };
  assert.equal(selectLanIPv4(fake), '172.20.0.1');
});

test('网卡：family 为数字 4 的旧格式同样识别', () => {
  const fake = { eth0: [{ family: 4, address: '10.1.2.3', netmask: '255.0.0.0', internal: false }] };
  assert.equal(selectLanIPv4(fake), '10.1.2.3');
});

// ---------------- 认证 ----------------

const sessionFile = () => join(tmpdir(), `dsh-lite-test-${Math.random().toString(36).slice(2)}.json`);

test('认证：未开启时一律放行', () => {
  const auth = new AuthManager({ config: { enabled: false }, sessionsFile: sessionFile() });
  const r = auth.verifyRequest({ headers: {}, socket: { remoteAddress: '192.168.1.50' }, url: '/' });
  assert.equal(r.authenticated, true);
  auth.dispose();
});

test('认证：开启后远程请求被拦，本机回环放行', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: sessionFile() });
  await auth.setPassword('abcd1234');

  const remote = auth.verifyRequest({ headers: {}, socket: { remoteAddress: '192.168.1.50' }, url: '/' });
  assert.equal(remote.authenticated, false);

  const local = auth.verifyRequest({ headers: {}, socket: { remoteAddress: '::1' }, url: '/' });
  assert.equal(local.authenticated, true);

  // allowLoopback=false 后本机也要登录
  auth.allowLoopback = false;
  const localStrict = auth.verifyRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/' });
  assert.equal(localStrict.authenticated, false);
  auth.dispose();
});

test('认证：密码校验 + 错误密码封禁', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: sessionFile() });
  await auth.setPassword('correct-horse');

  const okRes = await auth.verifyPassword('correct-horse', '10.0.0.5');
  assert.equal(okRes.success, true);

  const badRes = await auth.verifyPassword('nope', '10.0.0.6');
  assert.equal(badRes.success, false);

  // 连续 5 次失败后封禁
  for (let i = 0; i < 5; i += 1) await auth.verifyPassword('nope', '10.0.0.7');
  assert.equal(auth.isIpBlocked('10.0.0.7'), true);
  const blocked = await auth.verifyPassword('correct-horse', '10.0.0.7');
  assert.equal(blocked.success, false, '封禁期内即使密码正确也拒绝');
  auth.dispose();
});

test('认证：改密码会吊销所有已登录会话', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: sessionFile() });
  await auth.setPassword('first-pass');
  const token = auth.createSession();
  assert.equal(auth.validateSession(token), true);

  await auth.setPassword('second-pass');
  assert.equal(auth.validateSession(token), false, '改密码必须吊销旧会话');
  auth.dispose();
});

test('认证：setPassword 空串表示清除（长度策略在 RPC 层）', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: sessionFile() });
  await auth.setPassword('abcd1234');
  assert.equal(auth.hasPassword, true);
  await auth.setPassword('');
  assert.equal(auth.hasPassword, false, '空串必须清除密码');
  auth.dispose();
});

test('认证：token 直通与 cookie 解析', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: sessionFile() });
  await auth.setPassword('abcd1234');
  auth.allowLoopback = false;

  const viaToken = auth.verifyRequest({
    headers: {}, socket: { remoteAddress: '192.168.1.9' },
    url: `/?auth=${encodeURIComponent(auth.secretToken)}`,
  });
  assert.equal(viaToken.authenticated, true);
  assert.equal(viaToken.fromToken, true);

  const badToken = auth.verifyRequest({
    headers: {}, socket: { remoteAddress: '192.168.1.9' }, url: '/?auth=wrong',
  });
  assert.equal(badToken.authenticated, false);

  const session = auth.createSession();
  const viaCookie = auth.verifyRequest({
    headers: { cookie: `foo=1; ${AUTH_COOKIE_NAME}=${session}` },
    socket: { remoteAddress: '192.168.1.9' }, url: '/',
  });
  assert.equal(viaCookie.authenticated, true);
  assert.equal(readSessionCookie(`foo=1; ${AUTH_COOKIE_NAME}=${session}`), session);
  assert.equal(readSessionCookie(''), null);

  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
  auth.dispose();
});

test('认证：会话跨实例持久化（宿主重启后免重登）', async () => {
  const file = sessionFile();
  const a = new AuthManager({ config: { enabled: true }, sessionsFile: file });
  await a.setPassword('persist-me');
  const token = a.createSession();
  a.dispose();

  const b = new AuthManager({ config: { enabled: true }, sessionsFile: file });
  assert.equal(b.validateSession(token), true, '会话应能从 sessions.json 恢复');
  b.dispose();
});

// ---------------- 登录页 ----------------

test('登录页：中英双语 + 无外链资源 + 未设密码提示', () => {
  const zh = renderLoginPage({ hasPassword: true, lang: 'zh' });
  assert.match(zh, /访问密码/);
  assert.doesNotMatch(zh, /https?:\/\//, '登录页不得引用任何外链');

  const en = renderLoginPage({ hasPassword: true, lang: 'en' });
  assert.match(en, /Access password/);

  const noPw = renderLoginPage({ hasPassword: false, lang: 'zh' });
  assert.match(noPw, /尚未设置访问密码/);

  assert.equal(pickLoginLang('en-US,en;q=0.9'), 'en');
  assert.equal(pickLoginLang('zh-CN,zh;q=0.9'), 'zh');
  assert.equal(pickLoginLang(''), 'zh');
});

// ---------------- 代理工具函数 ----------------

test('代理：hop-by-hop 头必须被剔除', () => {
  const out = sanitizeProxyHeaders({
    'content-type': 'text/html',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'x-custom': 'keep-me',
  });
  assert.equal(out['content-type'], 'text/html');
  assert.equal(out['x-custom'], 'keep-me');
  assert.equal(out.connection, undefined);
  assert.equal(out['transfer-encoding'], undefined);
});

test('代理：Host/Origin/Referer 改写到回环，并剥离 accept-encoding', () => {
  const { headers } = loopbackHeaders({
    host: '192.168.1.20:3082',
    origin: 'http://192.168.1.20:3082',
    referer: 'http://192.168.1.20:3082/settings?tab=1',
    'accept-encoding': 'gzip, br',
  }, 3080);
  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.origin, 'http://127.0.0.1:3080');
  assert.equal(headers.referer, 'http://127.0.0.1:3080/settings?tab=1', '只替换 origin，保留路径与查询');
  assert.equal(headers['accept-encoding'], undefined);
});

// ---------------- RPC 契约 ----------------

test('RPC：客户端常量副本与服务端不漂移', async () => {
  const clientSrc = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');
  const channelMatch = /BRIDGE_RPC_CHANNEL = '([^']+)'/.exec(clientSrc);
  assert.equal(channelMatch?.[1], BRIDGE_RPC_CHANNEL, '通道名必须一致');

  // 只解析 `const EP = { ... }` 这一块，避免误吞其他同形状的对象字面量（如 MODE_LABELS）
  const epBlock = /const EP = \{([\s\S]*?)\n\};/.exec(clientSrc);
  assert.ok(epBlock, '未能从客户端定位 EP 常量表');
  const clientEps = [...epBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(clientEps.length > 0, '未能从客户端解析出端点表');

  // 方向一：客户端引用的每个端点，服务端必须存在且同名同值
  for (const [key, value] of clientEps) {
    assert.equal(BRIDGE_ENDPOINTS[key], value, `客户端 EP.${key} 与服务端不一致`);
  }

  // 方向二：服务端不能有客户端完全不知道的端点（客户端也就调不到）
  for (const key of Object.keys(BRIDGE_ENDPOINTS)) {
    assert.ok(clientEps.some(([k]) => k === key), `服务端端点 ${key} 在客户端缺失`);
  }
});

void mkdtemp;

// ---- 无线 / VPN 虚拟网卡识别（实机回归：Mihomo 198.18.0.1 曾被当成物理网卡）----

test('网卡：代理软件 TUN 适配器必须被判为虚拟并大幅降权', () => {
  const fake = {
    WLAN: [{ family: 'IPv4', address: '192.168.1.103', netmask: '255.255.255.0', internal: false }],
    Mihomo: [{ family: 'IPv4', address: '198.18.0.1', netmask: '255.255.255.252', internal: false }],
  };
  const list = listAllLanIPv4(fake);
  const mihomo = list.find((i) => i.name === 'Mihomo');
  assert.equal(mihomo.isVirtual, true, 'Mihomo 是代理的 TUN 适配器');
  assert.ok(mihomo.score < 0, `应被重罚，实际 score=${mihomo.score}`);
  assert.match(mihomo.label, /虚拟网卡/);
  assert.equal(selectLanIPv4(fake), '192.168.1.103', '必须选真实 Wi-Fi 网卡');
});

test('网卡：RFC 2544 基准段（198.18/15）即使名字像物理网卡也降权', () => {
  const fake = {
    Ethernet: [{ family: 'IPv4', address: '198.18.0.1', netmask: '255.255.255.252', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', internal: false }],
  };
  const list = listAllLanIPv4(fake);
  assert.ok(list.find((i) => i.name === 'Ethernet').score < list.find((i) => i.name === 'Wi-Fi').score);
  assert.equal(selectLanIPv4(fake), '10.0.0.5');
});

test('网卡：common VPN 适配器名同样识别', () => {
  for (const name of ['Clash', 'sing-box', 'wintun', 'utun3', 'tailscale0']) {
    const fake = { [name]: [{ family: 'IPv4', address: '10.9.0.1', netmask: '255.255.0.0', internal: false }] };
    assert.equal(listAllLanIPv4(fake)[0].isVirtual, true, `${name} 应判为虚拟`);
  }
});
