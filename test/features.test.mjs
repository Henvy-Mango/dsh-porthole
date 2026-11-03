// test/features.test.mjs —— 附加能力：会话投影剥离 / 工作区 / 宿主兼容垫片 / 面板渲染
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';

import { isSessionProjectionPath, stripSessionProjections } from '../lib/session-strip.js';
import { isSafeWorkspacePath, isSensitiveFolderName } from '../lib/security/path-validator.js';
import { BridgeLiteService } from '../lib/service.js';
import { AuthManager } from '../lib/auth/manager.js';
import { isMissingWebServerInjectError, registerRpcChannel } from '../lib/connection-compat.js';

// ---------- 会话投影剥离 ----------

const sessionList = (withProj = true) => JSON.stringify({
  result: {
    ok: true,
    value: {
      items: [{
        id: 's1',
        ...(withProj ? { projections: { values: { contextHeaders: 'x'.repeat(500), contextTimeline: 'y'.repeat(500), keep: 1 } } } : {}),
      }],
    },
  },
});

test('剥离：命中端点移除大字段，其余字段保留', () => {
  assert.equal(isSessionProjectionPath('/api/session/list'), true);
  assert.equal(isSessionProjectionPath('/api/session/page'), false, '非目标端点不碰');

  const { body, stripped } = stripSessionProjections('/api/session/list', Buffer.from(sessionList()));
  assert.equal(stripped, true);
  const proj = JSON.parse(body.toString()).result.value.items[0].projections.values;
  assert.equal(proj.contextHeaders, undefined);
  assert.equal(proj.contextTimeline, undefined);
  assert.equal(proj.keep, 1, '无关字段不得误删');
});

test('剥离：gzip 响应先解压；异常响应原样返回', () => {
  const gz = gzipSync(Buffer.from(sessionList()));
  const { stripped } = stripSessionProjections('/api/session/list', gz, 'gzip');
  assert.equal(stripped, true);

  const garbage = Buffer.from('<html>not json</html>');
  const r = stripSessionProjections('/api/session/list', garbage);
  assert.equal(r.stripped, false);
  assert.equal(r.body.toString(), '<html>not json</html>', '解析失败必须原样返回');

  const noProj = Buffer.from(sessionList(false));
  assert.equal(stripSessionProjections('/api/session/list', noProj).stripped, false);
});

// ---------- 工作区 ----------

/** 假宿主：workspaceRegistry + sessions，与 DSH 同形状。 */
function fakeHost() {
  const workspaces = new Map();
  let seq = 0;
  return {
    workspaceRegistry: {
      async list() { return [...workspaces.values()]; },
      async create(path, title) { const id = `ws${++seq}`; workspaces.set(id, { id, path, title }); return { id }; },
    },
    sessions: { create: () => ({ id: `session-${seq}` }) },
  };
}

const mkService = (hostCtx) => new BridgeLiteService({
  dshPort: 1, port: 0, hostCtx,
  authManager: new AuthManager({ config: {}, sessionsFile: join(tmpdir(), `ws-${Date.now()}-${Math.random()}.json`) }),
});

test('工作区：真实注册进 workspaceRegistry，并可按路径排除敏感目录', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'wsfix-'));
  await mkdir(join(fixture, 'sub'), { recursive: true });
  const svc = mkService(fakeHost());

  const added = await svc.addWorkspace(fixture);
  assert.equal(added.ok, true);
  assert.equal(added.registered, true, '必须真正注册（上游因 ctx 未接线做不到）');
  assert.equal(added.title, basename(fixture));
  assert.equal((await svc.getWorkspaces()).length, 1);

  const denied = await svc.addWorkspace(join(homedir(), '.ssh'));
  assert.equal(denied.ok, false);
  assert.match(denied.error, /安全拦截/);
  await svc.authManager.dispose();
});

test('工作区：目录浏览可用，敏感目录回退而非报错', async () => {
  const svc = mkService(fakeHost());
  const home = await svc.listRemoteDirectories();
  assert.equal(home.ok, true);
  assert.ok(home.roots.length > 0 && home.breadcrumbs.length > 0);

  const sneaky = await svc.listRemoteDirectories(join(homedir(), '.ssh'));
  assert.equal(sneaky.ok, true);
  assert.notEqual(sneaky.currentPath, join(homedir(), '.ssh'), '敏感目标应回退');
  await svc.authManager.dispose();
});

test('路径校验：系统目录 / 敏感段 / 空值拦截，真实目录放行', async () => {
  const deny = async (p) => (await isSafeWorkspacePath(p)).valid;
  assert.equal(await deny(''), false);
  assert.equal(await deny(join(homedir(), '.ssh')), false, '敏感目录');
  if (process.platform === 'win32') {
    assert.equal(await deny('C:\\Windows'), false, '系统目录');
  } else {
    assert.equal(await deny('/etc'), false);
  }
  assert.equal(isSensitiveFolderName('.env'), true);
  assert.equal(isSensitiveFolderName('projects'), false, '普通目录不得误伤');

  const tmp = await mkdtemp(join(tmpdir(), 'pv-'));
  const ok = await isSafeWorkspacePath(tmp);
  assert.equal(ok.valid, true, `临时目录应可用${ok.error ? `（${ok.error}）` : ''}`);
  assert.equal(isAbsolute(ok.path), true);
});

// ---------- 宿主兼容垫片 ----------

test('兼容垫片：命中宿主回归时接管，上游正常时空转', () => {
  const guard = () => new Error('cannot get property "webServer" without inject');
  assert.equal(isMissingWebServerInjectError(guard()), true);
  assert.equal(isMissingWebServerInjectError(new Error('other')), false);

  // 命中回归：首次抛错 → 垫片挂兜底 → 重试成功
  let attempts = 0;
  const ctx = {
    webServer: { port: 3080 },
    connection: { rpc: { handle() { attempts += 1; if (attempts === 1) throw guard(); return () => {}; } } },
    on() { return () => {}; },
  };
  registerRpcChannel(ctx, '/dsh-porthole', async () => ({}), { warn() {} });
  assert.equal(attempts, 2, '应在兜底后重试一次');

  // 上游已修复：只调一次，不挂号监听器
  let calls = 0; let onCalls = 0;
  registerRpcChannel({
    webServer: { port: 3080 },
    connection: { rpc: { handle() { calls += 1; return () => {}; } } },
    on() { onCalls += 1; return () => {}; },
  }, '/dsh-porthole', async () => ({}));
  assert.equal(calls, 1);
  assert.equal(onCalls, 0);
});

// ---------- 面板 ----------

test('面板：能渲染出局域网访问 / 安全认证 / 工作区 / 自检，且带上版本号', async () => {
  const src = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  let loaded = null;
  new Function('window', `${src}\n`)({
    __ModuleLoader__: { load({ id, factory }) { loaded = { id, exports: factory((m) => (m === 'react' ? React : () => ({}))) }; } },
  });
  assert.ok(loaded, 'bundle 未注册到 __ModuleLoader__');
  assert.equal(loaded.id, 'dsh-porthole', 'loader id 必须等于包名');

  let registered = null;
  loaded.exports.apply({
    slots: { inject: (_n, fn) => fn(), register: (def, C) => { registered = { def, C }; return () => {}; } },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  });
  assert.equal(registered.def.id, 'dsh-porthole');

  const status = {
    version: '0.0.0-test',
    basePath: '/dsh',
    host: '0.0.0.0',
    proxy: { running: true, port: 3082, activeConnections: 1, error: null },
    lan: { ip: '192.168.1.20', interfaces: [{ name: 'Wi-Fi', address: '192.168.1.20' }], url: 'http://192.168.1.20:3082/dsh/' },
    auth: { enabled: true, mode: 'token_and_password', adminPolicy: 'password_unlock', adminProtection: true, hasPassword: true, hasAdminPassword: true, secretToken: 'dshl_x****************', allowLoopback: true },
  };
  const html = renderToStaticMarkup(React.createElement(registered.C, { initialStatus: status, initialAdminToken: 'tok' }));

  for (const s of ['局域网访问', '安全认证', '工作区', '自检', '二级目录', '监听地址', '保存挂载设置']) {
    assert.ok(html.includes(s), `面板应包含「${s}」`);
  }
  assert.match(html, /192\.168\.1\.20:3082\/dsh\//, '访问地址应带前缀且以斜杠结尾');
  assert.match(html, /v0\.0\.0-test/, '页脚应显示版本号');
});
