// test/security.test.mjs —— 安全认证体系：双密码 / 管理保护 / 防篡改策略 / 应急复位 / loopback-token
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { AuthManager } from '../lib/auth/manager.js';
import { checkAdminAuth, BRIDGE_ENDPOINTS, installRpc } from '../lib/rpc.js';
import { LiteProxy } from '../lib/proxy.js';
import { BridgeLiteService } from '../lib/service.js';
import { checkEmergencyReset, applyStoredAuthConfig } from '../lib/index.js';

const tmp = () => join(tmpdir(), `dsh-lite-sec-${Math.random().toString(36).slice(2)}.json`);

function mkAuth(overrides = {}) {
  return new AuthManager({ config: overrides, sessionsFile: tmp() });
}

/** 组装真实 RPC handler（假 ctx + 假 service），用于在 RPC 边界上断言鉴权行为。 */
function makeRpc(auth, serviceOverrides = {}) {
  const service = {
    dshPort: 3080,
    getStatus: async () => ({ version: '1.0.0', auth: auth.getStatus({ masked: false }) }),
    getAccessUrl: async ({ includeToken }) => `http://192.168.1.20:3082${includeToken ? '/?auth=tok' : ''}`,
    setLanIp: async () => {},
    setPort: async () => {},
    restartProxy: async () => {},
    diagnose: async () => ({ checks: [] }),
    ...serviceOverrides,
  };
  let handler = null;
  const ctx = { connection: { rpc: { handle: (_ch, fn) => { handler = fn; return () => {}; } } } };
  installRpc(ctx, { service, authManager: auth, logger: { error: () => {} } });
  return (ep, payload) => handler(ep, payload ?? {});
}

// ---------------- checkAdminAuth ----------------

test('管理员校验：从未设密码时放行（否则新用户设不了密码）', () => {
  const auth = mkAuth({ enabled: true });
  assert.equal(checkAdminAuth(auth, {}), null);
  auth.dispose();
});

test('管理员校验：管理保护开启 + 已设密码 → 无令牌被拒', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const denied = checkAdminAuth(auth, {});
  assert.ok(denied, '应返回错误对象');
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /需要管理员权限/);
  auth.dispose();
});

test('管理员校验：持有效 adminToken 放行', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const { adminToken } = await auth.unlockAdmin('guest-pass');
  assert.equal(checkAdminAuth(auth, { adminToken }), null);
  auth.dispose();
});

test('管理员校验：管理保护关闭 → 免令牌放行', async () => {
  const auth = mkAuth({ enabled: true, adminProtection: false });
  await auth.setPassword('guest-pass');
  assert.equal(checkAdminAuth(auth, {}), null);
  auth.dispose();
});

test('管理员校验：adminPolicy=open → 免令牌放行', async () => {
  const auth = mkAuth({ enabled: true, adminPolicy: 'open' });
  await auth.setPassword('guest-pass');
  assert.equal(checkAdminAuth(auth, {}), null);
  auth.dispose();
});

test('管理员校验：local_only 即使关闭管理保护也不放行', async () => {
  const auth = mkAuth({ enabled: true, adminPolicy: 'local_only', adminProtection: false });
  await auth.setPassword('guest-pass');
  const denied = checkAdminAuth(auth, {});
  assert.ok(denied);
  assert.match(denied.error.message, /仅限电脑本机/);

  const adminToken = auth.createAdminSession();
  assert.equal(checkAdminAuth(auth, { adminToken }), null);
  auth.dispose();
});

test('管理员校验：requireConfigured 在从未设密码时拒绝高危操作', () => {
  const auth = mkAuth({ enabled: true });
  const denied = checkAdminAuth(auth, {}, { requireConfigured: true });
  assert.ok(denied);
  assert.match(denied.error.message, /请先.*设置访问密码/);
  auth.dispose();
});

// ---------------- 双密码 ----------------

test('双密码：管理密码独立于访客密码', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  await auth.setAdminPassword('admin-pass');

  assert.equal((await auth.verifyPassword('guest-pass')).success, true);
  assert.equal((await auth.unlockAdmin('guest-pass')).ok, false, '访客密码不能解锁管理');
  assert.equal((await auth.unlockAdmin('admin-pass')).ok, true, '管理密码能解锁管理');
  auth.dispose();
});

test('双密码：未设管理密码时回退用访客密码解锁', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  assert.equal(auth.hasAdminPassword, false);
  assert.equal((await auth.unlockAdmin('guest-pass')).ok, true);
  auth.dispose();
});

test('双密码：改管理密码会吊销所有管理员解锁态', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('admin-1');
  const { adminToken } = await auth.unlockAdmin('admin-1');
  assert.equal(auth.validateAdminSession(adminToken), true);

  await auth.setAdminPassword('admin-2');
  assert.equal(auth.validateAdminSession(adminToken), false, '改管理密码必须踢掉旧解锁态');
  auth.dispose();
});

test('双密码：改访客密码不影响管理员解锁态', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-1');
  await auth.setAdminPassword('admin-1');
  const { adminToken } = await auth.unlockAdmin('admin-1');

  await auth.setPassword('guest-2');
  assert.equal(auth.validateAdminSession(adminToken), true, '访客密码与管理员是两个独立口子');
  auth.dispose();
});

test('双密码：管理员解锁连续失败会全局锁定', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('right-pass');
  for (let i = 0; i < 5; i += 1) {
    const r = await auth.unlockAdmin('wrong');
    assert.equal(r.ok, false);
  }
  const locked = await auth.unlockAdmin('right-pass');
  assert.equal(locked.ok, false);
  assert.match(locked.error, /60 秒/);
  auth.dispose();
});

test('密码：空串表示清除，长度策略在 RPC 层', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('abcd1234');
  assert.equal(auth.hasPassword, true);
  await auth.setPassword('');
  assert.equal(auth.hasPassword, false, '空串必须清除密码');
  auth.dispose();
});

// ---------------- 验证模式 ----------------

test('模式：token_only 下密码登录被拒', async () => {
  const auth = mkAuth({ enabled: true, mode: 'token_only' });
  await auth.setPassword('guest-pass');
  const r = await auth.verifyPassword('guest-pass');
  assert.equal(r.success, false);
  assert.match(r.error, /仅允许专属安全 Token/);
  auth.dispose();
});

test('模式：password_only 下 URL token 被忽略', async () => {
  const auth = mkAuth({ enabled: true, mode: 'password_only' });
  await auth.setPassword('guest-pass');
  auth.allowLoopback = false;

  const viaToken = auth.verifyRequest({
    headers: {},
    socket: { remoteAddress: '192.168.1.9' },
    url: `/?auth=${encodeURIComponent(auth.secretToken)}`,
  });
  assert.equal(viaToken.authenticated, false, '仅密码模式下 token 不该放行');

  const session = auth.createSession();
  const viaCookie = auth.verifyRequest({
    headers: { cookie: `dsh_bridge_auth=${session}` },
    socket: { remoteAddress: '192.168.1.9' },
    url: '/',
  });
  assert.equal(viaCookie.authenticated, true);
  auth.dispose();
});

test('模式：token_and_password 下 token 与密码都放行', async () => {
  const auth = mkAuth({ enabled: true, mode: 'token_and_password' });
  await auth.setPassword('guest-pass');
  auth.allowLoopback = false;
  const viaToken = auth.verifyRequest({
    headers: {},
    socket: { remoteAddress: '192.168.1.9' },
    url: `/?auth=${encodeURIComponent(auth.secretToken)}`,
  });
  assert.equal(viaToken.authenticated, true);
  assert.equal(viaToken.fromToken, true);
  auth.dispose();
});

// ---------------- 令牌保密 ----------------

test('令牌：getStatus 默认脱敏，getRawSecretToken 需管理员会话', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('admin-pass');

  const masked = auth.getStatus();
  assert.match(masked.secretToken, /\*{8,}/);
  assert.equal(auth.getStatus({ masked: false }).secretToken, auth.secretToken);

  assert.equal(auth.getRawSecretToken(), null, '无令牌不得返回原文');
  const { adminToken } = await auth.unlockAdmin('admin-pass');
  assert.equal(auth.getRawSecretToken(adminToken), auth.secretToken);
  auth.dispose();
});

test('令牌：open 策略下可直接取原文', () => {
  const auth = mkAuth({ enabled: true, adminPolicy: 'open' });
  assert.equal(auth.getRawSecretToken(), auth.secretToken);
  auth.dispose();
});

test('令牌：重置后旧 token 失效、访客会话清空', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const oldToken = auth.secretToken;
  const session = auth.createSession();

  await auth.regenerateSecretToken();
  assert.notEqual(auth.secretToken, oldToken);
  assert.equal(auth.validateSecretToken(oldToken), false);
  assert.equal(auth.validateSession(session), false);
  auth.dispose();
});

// ---------------- 解锁态失效语义 ----------------

test('解锁态：切换验证方式会吊销所有管理员令牌', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('admin-pass');
  const { adminToken } = await auth.unlockAdmin('admin-pass');
  assert.equal(auth.validateAdminSession(adminToken), true);

  await auth.setMode('password_only');
  assert.equal(auth.validateAdminSession(adminToken), false, '改模式必须踢掉旧令牌');
  auth.dispose();
});

test('解锁态：切换防篡改策略会吊销所有管理员令牌', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('admin-pass');
  const { adminToken } = await auth.unlockAdmin('admin-pass');

  await auth.setAdminPolicy('local_only');
  assert.equal(auth.validateAdminSession(adminToken), false);
  auth.dispose();
});

test('解锁态：管理员令牌会过期', async () => {
  const auth = mkAuth({ enabled: true });
  const token = auth.createAdminSession(1); // 1ms
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(auth.validateAdminSession(token), false);
  auth.dispose();
});

test('解锁态：revokeAdminSession 立即失效', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('admin-pass');
  const { adminToken } = await auth.unlockAdmin('admin-pass');
  auth.revokeAdminSession(adminToken);
  assert.equal(auth.validateAdminSession(adminToken), false);
  auth.dispose();
});

// ---------------- RPC 边界：初始化豁免（防死锁） ----------------

test('初始化豁免：首次设访客密码不需要管理员，改已存在的密码则需要', async () => {
  const auth = mkAuth({ enabled: false });
  const rpc = makeRpc(auth);

  const first = await rpc('authUpdateConfig', { password: 'first-pass' });
  assert.equal(first.ok, true, `首次设密码应成功，实际：${JSON.stringify(first.error)}`);

  const second = await rpc('authUpdateConfig', { password: 'hacked' });
  assert.equal(second.ok, false);
  assert.match(second.error.message, /需要管理员权限/);
  auth.dispose();
});

test('初始化豁免：设完访客密码后仍能设管理密码（关键死锁场景）', async () => {
  const auth = mkAuth({ enabled: false });
  const rpc = makeRpc(auth);

  await rpc('authUpdateConfig', { password: 'guest-pass' });
  // 此刻 hasAnyPassword 已为真：若管理密码初始化也被拦，用户就锁死在自己刚设的密码上
  const res = await rpc('authUpdateConfig', { adminPassword: 'admin-pass' });
  assert.equal(res.ok, true, `管理密码初始化应成功，实际：${JSON.stringify(res.error)}`);
  assert.equal((await auth.unlockAdmin('admin-pass')).ok, true);
  auth.dispose();
});

test('初始化豁免：清除已存在的密码仍然需要管理员权限', async () => {
  const auth = mkAuth({ enabled: true });
  const rpc = makeRpc(auth);
  // 先初始化，再解锁，确保后续清除动作处于"已有密码"状态
  await auth.setPassword('guest-pass');
  const { adminToken } = await auth.unlockAdmin('guest-pass');

  const denied = await rpc('authUpdateConfig', { password: '' });
  assert.equal(denied.ok, false, '无令牌清除密码必须被拒');

  const allowed = await rpc('authUpdateConfig', { password: '', adminToken });
  assert.equal(allowed.ok, true);
  assert.equal(auth.hasPassword, false);
  auth.dispose();
});

test('RPC：短密码被拒（长度策略在 RPC 层）', async () => {
  const auth = mkAuth({ enabled: false });
  const rpc = makeRpc(auth);
  const res = await rpc('authUpdateConfig', { password: 'abc' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /至少 4 位/);
  auth.dispose();
});

test('RPC：password_only 且无密码时不允许开启（防自我锁死）', async () => {
  const auth = mkAuth({ enabled: false });
  const rpc = makeRpc(auth);

  // 从未设过任何密码：检查本身无需管理员，守卫直接拒绝并给出可操作提示
  const denied = await rpc('authUpdateConfig', { mode: 'password_only', enabled: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /仅密码模式需要先设置访问密码/);

  // 设好密码后，改模式属于安全配置变更 → 需要管理员
  await rpc('authUpdateConfig', { password: 'guest-pass' });
  const needAdmin = await rpc('authUpdateConfig', { mode: 'password_only', enabled: true });
  assert.equal(needAdmin.ok, false);
  assert.match(needAdmin.error.message, /需要管理员权限/);

  // 解锁后可切换
  const { adminToken } = await auth.unlockAdmin('guest-pass');
  const allowed = await rpc('authUpdateConfig', { mode: 'password_only', enabled: true, adminToken });
  assert.equal(allowed.ok, true);
  assert.equal(auth.mode, 'password_only');
  auth.dispose();
});

test('RPC：未解锁取二维码只给裸地址，解锁后才带 token', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const { adminToken } = await auth.unlockAdmin('guest-pass');
  const rpc = makeRpc(auth);

  const anon = await rpc('getQr', {});
  assert.equal(anon.value.withToken, false);
  assert.equal(anon.value.dataUrl, null);

  const admin = await rpc('getQr', { adminToken });
  assert.equal(admin.value.withToken, true);
  assert.match(admin.value.dataUrl, /^data:image\/png;base64,/);
  auth.dispose();
});

test('RPC：未解锁改端口被拒，解锁后放行', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const rpc = makeRpc(auth);

  const denied = await rpc('setPort', { port: 3999 });
  assert.equal(denied.ok, false);

  const { adminToken } = await auth.unlockAdmin('guest-pass');
  const allowed = await rpc('setPort', { port: 3999, adminToken });
  assert.equal(allowed.ok, true);
  auth.dispose();
});

test('RPC：未知端点返回 bad-request', async () => {
  const auth = mkAuth({ enabled: false });
  const rpc = makeRpc(auth);
  const res = await rpc('doesNotExist', {});
  assert.equal(res.ok, false);
  assert.match(res.error.message, /未知操作/);
  auth.dispose();
});

// ---------------- 应急复位 ----------------

test('应急复位：reset-auth 文件触发全量清空并自我删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lite-reset-'));
  const resetFile = join(dir, 'reset-auth');
  await writeFile(resetFile, '');

  const auth = mkAuth({ enabled: true, mode: 'token_only', adminPolicy: 'local_only' });
  await auth.setPassword('guest-pass');
  await auth.setAdminPassword('admin-pass');
  const session = auth.createSession();

  let stored = { auth: { enabled: true, passwordHash: 'x' } };
  const didReset = await checkEmergencyReset({
    resetFile,
    authManager: auth,
    updateStoredConfig: async (fn) => { stored = fn(stored); return stored; },
    logger: { warn: () => {} },
  });

  assert.equal(didReset, true);
  assert.equal(auth.enabled, false);
  assert.equal(auth.mode, 'token_and_password');
  assert.equal(auth.adminPolicy, 'password_unlock');
  assert.equal(auth.adminProtection, true);
  assert.equal(auth.hasPassword, false);
  assert.equal(auth.hasAdminPassword, false);
  assert.equal(auth.validateSession(session), false);
  assert.equal(stored.auth, undefined, '落盘配置里的 auth 段必须被删除');

  await assert.rejects(() => access(resetFile), '标记文件必须被删除，避免每次启动都清空');
  auth.dispose();
});

test('应急复位：没有标记文件时什么都不做', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lite-noreset-'));
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('keep-me');

  const didReset = await checkEmergencyReset({
    resetFile: join(dir, 'reset-auth'),
    authManager: auth,
    updateStoredConfig: async () => {},
    logger: { warn: () => {} },
  });
  assert.equal(didReset, false);
  assert.equal(auth.hasPassword, true, '密码必须原样保留');
  auth.dispose();
});

test('配置恢复：白名单式回填全部认证字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lite-restore-'));
  const configFile = join(dir, 'config.json');

  const source = mkAuth({});
  await source.setPassword('guest-pass');
  await source.setAdminPassword('admin-pass');
  await source.setMode('password_only');
  await source.setAdminPolicy('local_only');
  const snapshot = {
    auth: {
      enabled: true,
      mode: source.mode,
      adminPolicy: source.adminPolicy,
      adminProtection: false,
      passwordHash: source.passwordHash,
      passwordSalt: source.passwordSalt,
      adminPasswordHash: source.adminPasswordHash,
      adminPasswordSalt: source.adminPasswordSalt,
      secretToken: source.secretToken,
      allowLoopback: false,
      bogusField: 'should-be-ignored',
    },
  };
  source.dispose();

  const target = mkAuth({});
  await applyStoredAuthConfig({
    authManager: target,
    configFile,
    loadStoredConfig: async () => snapshot,
    updateStoredConfig: async () => snapshot,
    logger: { info: () => {}, warn: () => {} },
  });

  assert.equal(target.enabled, true);
  assert.equal(target.mode, 'password_only');
  assert.equal(target.adminPolicy, 'local_only');
  assert.equal(target.adminProtection, false);
  assert.equal(target.hasPassword, true);
  assert.equal(target.hasAdminPassword, true);
  assert.equal(target.allowLoopback, false);
  assert.equal(target.secretToken, snapshot.auth.secretToken);
  assert.equal((await target.verifyPassword('guest-pass')).success, true, '恢复出来的哈希必须真的能登录');
  assert.equal(target.bogusField, undefined, '白名单外的字段必须被忽略');
  target.dispose();
});

// ---------------- loopback-token 端点 ----------------

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${headers.Host ?? `127.0.0.1:${port}`}`,
        'Connection: close',
        ...Object.entries(headers).filter(([k]) => k !== 'Host').map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let buf = '';
    socket.on('data', (c) => { buf += c.toString('utf8'); });
    socket.on('end', () => {
      const [head, ...rest] = buf.split('\r\n\r\n');
      const status = Number(head.split(' ')[1]);
      let body = rest.join('\r\n\r\n');
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        body = body.replace(/^[0-9a-f]+\r\n/i, '').replace(/\r\n0\r\n\r\n$/, '');
      }
      resolve({ status, head, body });
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve({ status: 0, head: buf, body: buf }); }, 2000);
  });
}

async function withProxy(handler) {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const service = new BridgeLiteService({ dshPort: 1, port: 0, authManager: auth });
  const proxy = new LiteProxy({
    listenPort: 0,
    targetPort: 1,
    authManager: auth,
    allowedOrigins: () => service.allowedOrigins(),
  });
  await proxy.start();
  try {
    await handler({ proxy, auth, service, port: proxy.listenPort });
  } finally {
    await proxy.stop();
    auth.dispose();
  }
}

test('loopback-token：本机 + 回环 Host 才签发', async () => {
  await withProxy(async ({ port }) => {
    const res = await rawGet(port, '/__dsh_bridge_lite__/loopback-token');
    assert.equal(res.status, 200, `应签发，实际：${res.head.slice(0, 100)}`);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.match(data.adminToken, /^[a-f0-9]{48}$/);
    assert.match(res.head, /cache-control:\s*no-store/i);
  });
});

test('loopback-token：Host 不是回环时拒绝（防反代借用回环身份）', async () => {
  await withProxy(async ({ port }) => {
    const res = await rawGet(port, '/__dsh_bridge_lite__/loopback-token', { Host: 'evil.example.com' });
    assert.equal(res.status, 403);
    assert.match(res.body, /loopback only/);
  });
});

test('loopback-token：带未授权 Origin 直接 403，且不签发', async () => {
  await withProxy(async ({ port }) => {
    const res = await rawGet(port, '/__dsh_bridge_lite__/loopback-token', {
      Origin: 'https://evil.example.com',
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /origin not allowed/);
    assert.doesNotMatch(res.body, /adminToken/);
  });
});

test('loopback-token：允许来源可跨域读取并回显 ACAO', async () => {
  await withProxy(async ({ port, service }) => {
    const allowed = service.allowedOrigins()[0];
    const res = await rawGet(port, '/__dsh_bridge_lite__/loopback-token', { Origin: allowed });
    assert.equal(res.status, 200);
    assert.match(res.head.toLowerCase(), /access-control-allow-origin:/);
  });
});

test('loopback-token：opaque origin 字面量 null 永不授权', async () => {
  await withProxy(async ({ port }) => {
    const res = await rawGet(port, '/__dsh_bridge_lite__/loopback-token', { Origin: 'null' });
    assert.equal(res.status, 403);
  });
});

test('loopback-token：白名单只含本插件自己的面板来源', async () => {
  await withProxy(async ({ service }) => {
    const origins = service.allowedOrigins();
    assert.ok(origins.length >= 2, '至少包含回环与局域网两种写法');
    for (const o of origins) {
      assert.match(o, /^http:\/\/(127\.0\.0\.1|localhost|192\.168\.|10\.|172\.)/, `可疑来源：${o}`);
      assert.notEqual(o, 'null');
      assert.notEqual(o, '*');
    }
  });
});

// ---------------- 端点表完整性 ----------------

test('端点表：认证相关端点齐备', () => {
  for (const key of ['authGetStatus', 'authUpdateConfig', 'authRegenerateToken', 'authAdminUnlock', 'authAdminLock']) {
    assert.ok(BRIDGE_ENDPOINTS[key], `缺少端点 ${key}`);
  }
});
