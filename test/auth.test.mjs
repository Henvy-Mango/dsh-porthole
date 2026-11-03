// test/auth.test.mjs —— 访问安全认证：双密码 / 防篡改锁 / 会话 / 应急复位
//
// 只覆盖「坏了会让人进不去或被人进去」的语义，细节分支（旧哈希升级等）不在这里重复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthManager, isLoopbackAddress } from '../lib/auth/manager.js';
import { checkAdminAuth } from '../lib/rpc.js';
import { checkEmergencyReset, applyStoredAuthConfig } from '../lib/index.js';

const mkAuth = (cfg = {}) => new AuthManager({
  config: cfg,
  sessionsFile: join(tmpdir(), `auth-${Math.random().toString(36).slice(2)}.json`),
  logger: { warn() {}, error() {} },
});

test('密码：正确放行、错误拒绝、连错 5 次封禁', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');

  assert.equal((await auth.verifyPassword('guest-pass')).success, true);
  assert.equal((await auth.verifyPassword('wrong')).success, false);

  for (let i = 0; i < 5; i += 1) await auth.verifyPassword('wrong', '10.0.0.9');
  assert.equal(auth.isIpBlocked('10.0.0.9'), true, '连续失败应封禁');
  assert.equal((await auth.verifyPassword('guest-pass', '10.0.0.9')).success, false, '封禁期内正确密码也拒绝');
  auth.dispose();
});

test('令牌：重置后旧令牌失效，访客会话一并清空', async () => {
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

test('令牌：对外状态默认脱敏，原文需管理员会话', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setAdminPassword('{{SECRET_qvpnu2gd}}');

  assert.match(auth.getStatus().secretToken, /\*{8,}/, '默认必须打码');
  assert.equal(auth.getRawSecretToken(), null, '无会话不得返回原文');

  const { adminToken } = await auth.unlockAdmin('{{SECRET_qvpnu2gd}}');
  assert.equal(auth.getRawSecretToken(adminToken), auth.secretToken);
  auth.dispose();
});

test('双密码：管理密码独立，改管理密码踢掉旧解锁态', async () => {
  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  await auth.setAdminPassword('admin-pass');

  assert.equal((await auth.unlockAdmin('guest-pass')).ok, false, '访客密码不能解锁管理');
  const { adminToken } = await auth.unlockAdmin('admin-pass');
  assert.equal(auth.validateAdminSession(adminToken), true);

  await auth.setAdminPassword('admin-pass2');
  assert.equal(auth.validateAdminSession(adminToken), false, '改管理密码必须吊销旧令牌');
  auth.dispose();
});

test('校验：未设密码放行（否则设不了密码）；设了密码后需令牌', async () => {
  const auth = mkAuth({ enabled: true });
  assert.equal(checkAdminAuth(auth, {}), null, '无密码时应放行（初始化）');

  await auth.setPassword('guest-pass');
  const denied = checkAdminAuth(auth, {});
  assert.ok(denied);
  assert.match(denied.error.message, /需要管理员权限/);

  const { adminToken } = await auth.unlockAdmin('guest-pass');
  assert.equal(checkAdminAuth(auth, { adminToken }), null);
  auth.dispose();
});

test('校验：local_only 策略即使关闭管理保护也不放行远程', async () => {
  const auth = mkAuth({ enabled: true, adminPolicy: 'local_only', adminProtection: false });
  await auth.setPassword('guest-pass');
  assert.ok(checkAdminAuth(auth, {}), '远程一律拒绝');
  auth.dispose();
});

test('验证模式：token_only 禁密码登录，password_only 禁 URL 令牌', async () => {
  const t = mkAuth({ enabled: true, mode: 'token_only' });
  await t.setPassword('guest-pass');
  assert.equal((await t.verifyPassword('guest-pass')).success, false);
  t.dispose();

  const p = mkAuth({ enabled: true, mode: 'password_only' });
  await p.setPassword('guest-pass');
  p.allowLoopback = false;
  const viaToken = p.verifyRequest({
    headers: { host: 'dsh.example.com' },
    socket: { remoteAddress: '192.168.1.9' },
    url: `/?auth=${encodeURIComponent(p.secretToken)}`,
  });
  assert.equal(viaToken.authenticated, false);
  p.dispose();
});

test('回环：只认真正回环地址；请求头缺 Host 时不享受免密', async () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.9'), false);

  const auth = mkAuth({ enabled: true });
  await auth.setPassword('guest-pass');
  const noHost = auth.verifyRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/' });
  assert.equal(noHost.authenticated, false, '空 Host 不得免密（防反代漏配）');
  auth.dispose();
});

test('应急复位：reset-auth 标记一次性清空双密码与策略', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reset-'));
  const resetFile = join(dir, 'reset-auth');
  await writeFile(resetFile, '');

  const auth = mkAuth({ enabled: true, mode: 'token_only', adminPolicy: 'local_only' });
  await auth.setPassword('guest-pass');
  await auth.setAdminPassword('admin-pass');
  let stored = { auth: { enabled: true } };

  const did = await checkEmergencyReset({
    resetFile, authManager: auth,
    updateStoredConfig: async (fn) => { stored = fn(stored); return stored; },
    logger: { warn() {} },
  });

  assert.equal(did, true);
  assert.equal(auth.enabled, false);
  assert.equal(auth.hasPassword, false);
  assert.equal(auth.hasAdminPassword, false);
  assert.equal(auth.adminPolicy, 'password_unlock');
  assert.equal(stored.auth, undefined, '落盘配置的 auth 段必须删除');
  await assert.rejects(() => access(resetFile), '标记文件需自我删除，避免每次启动都清空');
  auth.dispose();
});

test('配置恢复：白名单式回填，恢复出来的哈希可登录', async () => {
  const src = mkAuth({});
  await src.setPassword('guest-pass');
  await src.setAdminPassword('admin-pass');
  const snapshot = {
    auth: {
      enabled: true, mode: 'password_only', adminPolicy: 'local_only', adminProtection: false,
      passwordHash: src.passwordHash, passwordSalt: src.passwordSalt,
      adminPasswordHash: src.adminPasswordHash, adminPasswordSalt: src.adminPasswordSalt,
      secretToken: src.secretToken, allowLoopback: false, bogus: 'ignored',
    },
  };
  src.dispose();

  const dir = await mkdtemp(join(tmpdir(), 'restore-'));
  const target = mkAuth({});
  await applyStoredAuthConfig({
    authManager: target,
    configFile: join(dir, 'config.json'),
    loadStoredConfig: async () => snapshot,
    updateStoredConfig: async () => snapshot,
    logger: { info() {}, warn() {} },
  });

  assert.equal(target.mode, 'password_only');
  assert.equal(target.adminPolicy, 'local_only');
  assert.equal(target.hasPassword, true);
  assert.equal(target.bogus, undefined, '白名单外字段不得写入');
  assert.equal((await target.verifyPassword('guest-pass')).success, true);
  target.dispose();
});
