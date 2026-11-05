import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BridgeLiteService } from '../lib/service.js';

test('注册工作区后可列出，不创建未持久化的空会话', async () => {
  const workspaces = [];
  const hostCtx = {
    workspaceRegistry: {
      list: async () => workspaces,
      create: async (path, title) => { const workspace = { id: 'ws1', path, title }; workspaces.push(workspace); return workspace; },
      get: () => ({ attachSession: () => assert.fail('注册工作区不应挂接会话') }),
    },
    sessions: { create: () => assert.fail('注册工作区不应预建内存会话') },
  };
  const service = new BridgeLiteService({ dshPort: 1, hostCtx });
  const added = await service.addWorkspace(await mkdtemp(join(tmpdir(), 'porthole-workspace-')));
  assert.equal(added.ok, true);
  assert.equal(added.registered, true);
  assert.equal(added.workspaceId, (await service.getWorkspaces())[0].id);
  assert.equal(added.sessionId, null);
});

test('客户端构建可注册设置面板，显示访问地址、认证和工作区入口', async () => {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  let plugin;
  let Panel;
  new Function('window', source)({ __ModuleLoader__: {
    load: ({ id, factory }) => { assert.equal(id, 'dsh-porthole'); plugin = factory(() => React); },
  } });
  plugin.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (def, component) => { if (def.name === 'settings.section') Panel = component; return () => {}; },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  });
  const html = renderToStaticMarkup(React.createElement(Panel, { initialAdminToken: 'test-token', initialStatus: {
    version: 'test', host: '0.0.0.0', trustedProxies: ['127.0.0.1', '::1'],
    proxy: { running: true, port: 3082, activeConnections: 0 },
    lan: { ip: '192.168.1.20', interfaces: [], url: 'http://192.168.1.20:3082/' },
    auth: { enabled: true, mode: 'token_and_password', adminPolicy: 'password_unlock', hasPassword: true },
  } }));
  for (const text of ['局域网访问', '安全认证', '工作区', '192.168.1.20:3082/', '保存监听设置', '可信前置代理']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('二级目录'));
});

test('自检的代理端口项展示实际监听地址，而非写死 0.0.0.0', async () => {
  // Bind to a specific interface address: diagnose must echo it, not "0.0.0.0".
  const service = new BridgeLiteService({ dshPort: 1, port: 0, host: '192.168.0.66' });
  // Stub a started proxy so the check reports "listening" without real IO.
  service.proxy = { host: '192.168.0.66', port: 0 };
  const { checks } = await service.diagnose();
  const proxyCheck = checks.find((c) => c.id === 'proxy');
  assert.ok(proxyCheck, 'proxy check present');
  assert.equal(proxyCheck.detail, '监听 192.168.0.66:0');

  // Default/wide bind still reads 0.0.0.0.
  const wide = new BridgeLiteService({ dshPort: 1, port: 0, host: '0.0.0.0' });
  wide.proxy = { host: '0.0.0.0', port: 0 };
  const wideCheck = (await wide.diagnose()).checks.find((c) => c.id === 'proxy');
  assert.equal(wideCheck.detail, '监听 0.0.0.0:0');
});
