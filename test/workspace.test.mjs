// test/workspace.test.mjs —— 会话投影剥离（1.6）+ 工作区管理（1.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';

import { isSessionProjectionPath, stripSessionProjections } from '../lib/session-strip.js';
import { isSafeWorkspacePath, isSensitiveFolderName } from '../lib/security/path-validator.js';
import { AuthManager } from '../lib/auth/manager.js';
import { BridgeLiteService } from '../lib/service.js';
import { installRpc, BRIDGE_ENDPOINTS } from '../lib/rpc.js';

/**
 * 公共可写的临时工作区夹具：不依赖开发机上的具体用户目录，
 * 保证这些用例在 CI 或任何机器上都能跑（公开仓库的硬要求）。
 */
const wsFixture = await mkdtemp(join(tmpdir(), 'porthole-ws-'));
await mkdir(join(wsFixture, 'sub-a'), { recursive: true });
await mkdir(join(wsFixture, 'sub-b'), { recursive: true });

/** 一个必然被拦截的路径：用户主目录下的 .ssh（不存在也无妨，黑名单先于 stat）。 */
const SENSITIVE = join(homedir(), '.ssh');

// ---------------- 1.6 会话投影剥离 ----------------

const mkSessionList = (n, withProjections = true) => JSON.stringify({
  result: {
    ok: true,
    value: {
      items: Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        title: `session ${i}`,
        ...(withProjections ? { projections: { values: { contextHeaders: 'x'.repeat(1000), contextTimeline: 'y'.repeat(1000), other: 'keep' } } } : {}),
      })),
    },
  },
});

test('剥离：路径判定同时兼容斜杠与点号形式', () => {
  assert.equal(isSessionProjectionPath('/api/session/list'), true);
  assert.equal(isSessionProjectionPath('/api/session/list?foo=1'), true, '带 query 也命中');
  assert.equal(isSessionProjectionPath('/api/session.list'), true);
  assert.equal(isSessionProjectionPath('/api/session/history'), true, '兼容面保留');
  assert.equal(isSessionProjectionPath('/api/session/page'), false, '非目标端点不碰');
  assert.equal(isSessionProjectionPath('/api/workspace/list'), false);
  assert.equal(isSessionProjectionPath('/'), false);
});

test('剥离：明文 JSON 移除 contextHeaders/contextTimeline，保留其余字段', () => {
  const body = Buffer.from(mkSessionList(2));
  const { body: out, stripped } = stripSessionProjections('/api/session/list', body);
  assert.equal(stripped, true);
  const json = JSON.parse(out.toString('utf8'));
  const item = json.result.value.items[0];
  assert.equal(item.projections.values.contextHeaders, undefined);
  assert.equal(item.projections.values.contextTimeline, undefined);
  assert.equal(item.projections.values.other, 'keep', '无关字段不得误删');
  assert.equal(json.result.value.items.length, 2);
});

test('剥离：gzip 响应先解压再剥离（DSH 默认开 gzip）', () => {
  const gz = gzipSync(Buffer.from(mkSessionList(1)));
  const { body, stripped } = stripSessionProjections('/api/session/list', gz, 'gzip');
  assert.equal(stripped, true);
  const json = JSON.parse(body.toString('utf8'));
  assert.equal(json.result.value.items[0].projections.values.contextHeaders, undefined);
});

test('剥离：无投影字段时不改动（stripped=false，body 原样）', () => {
  const body = Buffer.from(mkSessionList(1, false));
  const { body: out, stripped } = stripSessionProjections('/api/session/list', body);
  assert.equal(stripped, false);
  assert.equal(out.toString('utf8'), mkSessionList(1, false), '未命中必须原样返回');
});

test('剥离：非 200 / 非 JSON / 结构不符时绝不破坏响应', () => {
  const garbage = Buffer.from('<html>not json</html>');
  const r1 = stripSessionProjections('/api/session/list', garbage);
  assert.equal(r1.stripped, false);
  assert.equal(r1.body.toString('utf8'), '<html>not json</html>');

  const wrongShape = Buffer.from(JSON.stringify({ result: { ok: true, value: { items: 'not-an-array' } } }));
  const r2 = stripSessionProjections('/api/session/list', wrongShape);
  assert.equal(r2.stripped, false);
});

// ---------------- 1.4 工作区管理：路径安全校验 ----------------

const BS = String.fromCharCode(92);
const W = (s) => s.split('/').join(BS);

test('路径校验：系统目录 / 敏感段 / UNC / 空值全部拦截', async () => {
  const deny = async (p) => (await isSafeWorkspacePath(p)).valid;

  // 与平台无关：敏感段黑名单在 Windows 与 POSIX 上走同一套名单
  assert.equal(await deny(W('C:/Users/x/.ssh')), false, '敏感隐藏目录');
  assert.equal(await deny(W('C:/Users/x/project/.git')), false);
  assert.equal(await deny(join(homedir(), '.ssh')), false, 'POSIX 形态的敏感目录同样拦截');
  assert.equal(await deny(''), false);
  assert.equal(await deny(null), false);

  // 平台专属的拦截面：只在对应平台上断言。
  // 跨平台写死会在 CI 上因「路径不存在」而以别的原因失败（实际踩过）。
  if (process.platform === 'win32') {
    assert.equal(await deny(W('C:/Windows')), false, 'Windows 系统目录');
    assert.equal(await deny(W('C:/Program Files/app')), false);
    assert.equal(await deny(W('//server/share')), false, 'UNC 网络共享');
  } else {
    assert.equal(await deny('/etc/passwd'), false, 'POSIX 系统目录');
    assert.equal(await deny('/proc/self/environ'), false);
  }

  assert.equal(isSensitiveFolderName('.env'), true);
  assert.equal(isSensitiveFolderName('id_rsa'), true);
  assert.equal(isSensitiveFolderName('my.projects'), false, '普通目录不得误伤');
});

test('路径校验：真实存在的普通目录通过，且返回归一化路径', async () => {
  const r = await isSafeWorkspacePath(wsFixture);
  assert.equal(r.valid, true);
  // 跨平台断言：只要求「是绝对路径」（Windows 盘符 / POSIX 根），
  // 不能写死 `C:\` —— 否则 Linux/macOS 的 CI 必挂。
  assert.equal(isAbsolute(r.path), true, '应返回绝对路径');
  assert.ok(r.realPath);
});

// ---------------- 1.4 工作区管理：service + RPC 门禁 ----------------

/** 假宿主 ctx：workspaceRegistry / sessions 与 DSH 0.2.1-rc.5 同形状。 */
function fakeHostCtx() {
  const workspaces = new Map();
  let wsSeq = 0;
  let sessionSeq = 0;
  const sessions = new Map();
  return {
    state: { workspaces, sessions },
    workspaceRegistry: {
      async list() { return [...workspaces.values()]; },
      async create(path, title) {
        const id = `ws${++wsSeq}`;
        workspaces.set(id, { id, path, title });
        return { id };
      },
      get(id) {
        const ws = workspaces.get(id);
        return ws ? { ...ws, async attachSession(sid) { ws.sessionId = sid; } } : null;
      },
    },
    sessions: {
      create(_opts, meta) {
        const id = `sess${++sessionSeq}`;
        sessions.set(id, meta);
        return { id };
      },
    },
  };
}

function makeRpc(auth, service) {
  let handler = null;
  const ctx = { connection: { rpc: { handle: (_ch, fn) => { handler = fn; return () => {}; } } } };
  installRpc(ctx, { service, authManager: auth, logger: { error: () => {}, warn: () => {} } });
  return (ep, payload) => handler(ep, payload ?? {});
}

function makeService(hostCtx) {
  return new BridgeLiteService({
    dshPort: 3080, port: 0,
    authManager: new AuthManager({ config: {}, sessionsFile: join(tmpdir(), `ws-${Math.random().toString(36).slice(2)}.json`) }),
    hostCtx,
  });
}

test('工作区：注册 → 列表回读 → 会话已挂到工作区', async () => {
  const host = fakeHostCtx();
  const service = makeService(host);

  const add = await service.addWorkspace(wsFixture);
  assert.equal(add.ok, true);
  assert.equal(add.registered, true, '必须真正注册进 workspaceRegistry（上游因 ctx 未接线做不到）');
  assert.equal(add.workspaceId, 'ws1');
  assert.equal(add.title, basename(wsFixture), '标题默认取目录名');
  assert.ok(add.sessionId, '应创建以该目录为 cwd 的会话');
  assert.equal(add.workspaces.length, 1);

  const list = await service.getWorkspaces();
  assert.equal(list.length, 1);
  assert.equal(list[0].path, add.path);
  assert.equal(host.state.workspaces.get('ws1').sessionId, add.sessionId, 'attachSession 应生效');

  // 敏感路径被拒
  const bad = await service.addWorkspace(SENSITIVE);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /安全拦截/);
  await service.authManager.dispose();
});

test('工作区：无 hostCtx 时安全降级（registered=false，不抛异常）', async () => {
  const service = makeService(null);
  const add = await service.addWorkspace(wsFixture);
  assert.equal(add.ok, true);
  assert.equal(add.registered, false);
  assert.equal(add.workspaceId, null);
  assert.deepEqual(await service.getWorkspaces(), []);
  await service.authManager.dispose();
});

test('工作区：目录浏览返回根/盘符/面包屑/子目录，敏感项被过滤', async () => {
  const service = makeService(fakeHostCtx());
  const home = await service.listRemoteDirectories();
  assert.equal(home.ok, true);
  assert.ok(home.roots.some((r) => r.name.includes('用户主目录')));
  assert.ok(home.drives.length > 0);
  assert.ok(home.breadcrumbs.length > 0);

  // 进入一个存在的目录
  const desktop = await service.listRemoteDirectories(wsFixture);
  assert.equal(desktop.ok, true);
  assert.equal(desktop.currentPath.toLowerCase(), wsFixture.toLowerCase());

  // 敏感目标回退主目录而非报错
  const sneaky = await service.listRemoteDirectories(SENSITIVE);
  assert.equal(sneaky.ok, true);
  assert.notEqual(sneaky.currentPath.toLowerCase(), SENSITIVE.toLowerCase());

  // 子目录里不该出现 .git
  const ws = await service.listRemoteDirectories(wsFixture);
  if (ws.ok) {
    for (const e of ws.entries) assert.equal(isSensitiveFolderName(e.name), false, `不应列出敏感目录 ${e.name}`);
  }
  await service.authManager.dispose();
});

test('RPC 门禁：浏览/添加目录未设密码时必须先设密码（requireConfigured）', async () => {
  const auth = new AuthManager({ config: { enabled: true }, sessionsFile: join(tmpdir(), `ws-rpc-${Math.random().toString(36).slice(2)}.json`) });
  const rpc = makeRpc(auth, makeService(fakeHostCtx()));

  const denied = await rpc(BRIDGE_ENDPOINTS.listRemoteDirectories, { path: 'C:/' });
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /请先.*设置访问密码/);

  const deniedAdd = await rpc(BRIDGE_ENDPOINTS.addRemoteWorkspace, { path: wsFixture });
  assert.equal(deniedAdd.ok, false);

  // 设密码后仍需管理员令牌
  await auth.setPassword('guest-pass');
  const denied2 = await rpc(BRIDGE_ENDPOINTS.listRemoteDirectories, { path: 'C:/' });
  assert.equal(denied2.ok, false);
  assert.match(denied2.error.message, /需要管理员权限/);

  const { adminToken } = await auth.unlockAdmin('guest-pass');
  const allowed = await rpc(BRIDGE_ENDPOINTS.listRemoteDirectories, { path: 'C:/', adminToken });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.ok, true);

  const added = await rpc(BRIDGE_ENDPOINTS.addRemoteWorkspace, { path: wsFixture, adminToken });
  assert.equal(added.ok, true);
  assert.equal(added.value.registered, true);

  const listed = await rpc(BRIDGE_ENDPOINTS.listWorkspaces, { adminToken });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.length, 1);
  auth.dispose();
});

test('RPC 门禁：管理保护关闭时浏览目录也放行（与上游语义一致）', async () => {
  const auth = new AuthManager({ config: { enabled: true, adminProtection: false }, sessionsFile: join(tmpdir(), `ws-rpc2-${Math.random().toString(36).slice(2)}.json`) });
  await auth.setPassword('guest-pass');
  const rpc = makeRpc(auth, makeService(fakeHostCtx()));
  const res = await rpc(BRIDGE_ENDPOINTS.listRemoteDirectories, { path: 'C:/' });
  assert.equal(res.ok, true);
  auth.dispose();
});

void mkdtemp;

// ---- 1.6 集成：剥离必须真实发生在代理链路上 ----
import { createServer, request as httpRequest } from 'node:http';
import { LiteProxy } from '../lib/proxy.js';

function startUpstream() {
  const server = createServer((req, res) => {
    if (isSessionProjectionPath((req.url || '/').split('?')[0])) {
      const body = Buffer.from(mkSessionList(2));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>ok</html>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('代理集成：session/list 经代理后投影被剥离且 content 头被改写', async () => {
  const upstream = await startUpstream();
  const home = await mkdtemp(join(tmpdir(), 'dsh-strip-'));
  const auth = new AuthManager({ config: { enabled: false }, sessionsFile: join(home, 's.json') });
  const proxy = new LiteProxy({ listenPort: 0, targetPort: upstream.port, authManager: auth });
  await proxy.start();
  try {
    // 命中端点：剥离 + content-encoding 移除 + content-length 重算
    const hit = await get(proxy.listenPort, '/api/session/list');
    assert.equal(hit.status, 200);
    assert.equal(hit.headers['content-encoding'], undefined, '剥离后必须去掉 gzip 标记');
    assert.equal(Number(hit.headers['content-length']), hit.body.length, 'content-length 必须与实际 body 一致');
    const json = JSON.parse(hit.body.toString('utf8'));
    assert.equal(json.result.value.items[0].projections.values.contextHeaders, undefined);
    // 与「未剥离的明文原文」比较体积（不能用 gzip 后的字节比：合成夹具的高重复数据
    // gzip 后趋近于零，不具代表性；真实场景剥离的是数 MB 的系统提示 + 工具定义）
    assert.ok(hit.body.length < Buffer.from(mkSessionList(2)).length, '剥离后必须小于未剥离明文');

    // 未命中端点：原样直通
    const plain = await get(proxy.listenPort, '/');
    assert.equal(plain.status, 200);
    assert.equal(plain.body.toString('utf8'), '<html>ok</html>');
  } finally {
    await proxy.stop();
    auth.dispose();
    upstream.server.close();
  }
});

// ---- 跨平台回归：macOS 临时目录必须可用 ----
// 上游用笼统的 `/private` 前缀拦截 macOS 系统目录，导致 /private/var/folders/... 
// （macOS 上所有临时目录的真实位置）被判为敏感目录，任何临时目录都无法作为工作区。
// 该 bug 由 macOS CI 暴露，此处锁定行为。
test('路径校验：操作系统临时目录必须被放行（macOS /private 回归）', async () => {
  const r = await isSafeWorkspacePath(tmpdir());
  assert.equal(r.valid, true, `临时目录应可用，实际被拒：${r.error}`);

  // macOS 上 realpath 会把 /var → /private/var；显式断言这种形态不被笼统拦截
  if (process.platform === 'darwin') {
    const real = await isSafeWorkspacePath('/private/var/folders/x/T/porthole-probe', { allowNonExistent: true });
    assert.equal(real.valid, true, '/private/var/folders 属正常临时目录，不应被拦截');
    const rootStill = await isSafeWorkspacePath('/private/var/root/probe', { allowNonExistent: true });
    assert.equal(rootStill.valid, false, '/private/var/root 仍须拦截');
  }
});
