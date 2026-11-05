import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../lib/auth/manager.js';
import { checkAdminAuth } from '../lib/rpc.js';

const makeAuth = (t) => {
  const auth = new AuthManager({ config: { enabled: true },
    sessionsFile: join(tmpdir(), `porthole-auth-${Math.random().toString(36).slice(2)}.json`) });
  t.after(() => auth.dispose());
  return auth;
};

test('访客密码正确放行、错误拒绝，登录会话可验证和撤销', async (t) => {
  const auth = makeAuth(t);
  await auth.setPassword('guest-pass');
  assert.equal((await auth.verifyPassword('guest-pass')).success, true);
  assert.equal((await auth.verifyPassword('wrong')).success, false);
  const session = auth.createSession();
  assert.equal(auth.validateSession(session), true);
  auth.revokeSession(session);
  assert.equal(auth.validateSession(session), false);
});

test('管理密码独立于访客密码，管理配置必须持有效令牌', async (t) => {
  const auth = makeAuth(t);
  await auth.setPassword('guest-pass');
  await auth.setAdminPassword('admin-pass');
  assert.ok(checkAdminAuth(auth, {}));
  assert.equal((await auth.unlockAdmin('guest-pass')).ok, false);
  const { adminToken } = await auth.unlockAdmin('admin-pass');
  assert.equal(checkAdminAuth(auth, { adminToken }), null);
  assert.equal(auth.getRawSecretToken(), null);
  assert.equal(auth.getRawSecretToken(adminToken), auth.secretToken);
  await auth.setAdminPassword('new-admin-pass');
  assert.equal(auth.validateAdminSession(adminToken), false);
});

test('重置扫码令牌同时吊销旧令牌和访客会话', async (t) => {
  const auth = makeAuth(t);
  const token = auth.secretToken;
  const session = auth.createSession();
  await auth.regenerateSecretToken();
  assert.equal(auth.validateSecretToken(token), false);
  assert.equal(auth.validateSecretToken(auth.secretToken), true);
  assert.equal(auth.validateSession(session), false);
});
