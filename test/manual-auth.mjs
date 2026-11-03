// 手工验收脚本：模拟宿主 ctx 驱动 apply()，跑通安全认证全链路
// 用法：DSH_HOME=<临时目录> node test/manual-auth.mjs <port>
import { env } from 'node:process';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 34567);
const GUEST_PW = 'guest-pass';
const ADMIN_PW = 'admin-pass';

const dsh = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head></head><body>DSH</body></html>');
});
await new Promise((r) => dsh.listen(0, '127.0.0.1', r));
const dshPort = dsh.address().port;

const logs = [];
const logger = {
  info: (fmt, ...a) => logs.push(['info', `${fmt} ${a.join(' ')}`]),
  warn: (fmt, ...a) => logs.push(['warn', `${fmt} ${a.join(' ')}`]),
  error: (fmt, ...a) => logs.push(['error', `${fmt} ${a.join(' ')}`]),
  debug: () => {},
};

let rpc = null;
const effects = [];
const ctx = {
  logger: () => logger,
  webServer: { port: dshPort },
  connection: { rpc: { handle: (ch, fn) => { rpc = { ch, fn }; return () => { rpc = null; }; } } },
  effect: (fn) => { effects.push(fn); return () => {}; },
};

const mod = await import('../lib/index.js');
mod.apply(ctx, { port });
await new Promise((r) => setTimeout(r, 400));

const call = (ep, payload = {}) => rpc.fn(ep, payload);
const show = (label, res) => console.log(
  `  ${label.padEnd(36)} → ${res.ok ? 'OK' : `拒绝(${res.error?.message})`}`,
);

console.log('=== 1. 初始状态（无密码） ===');
let st = await call('getStatus');
console.log('  auth:', JSON.stringify(st.value.auth));
show('无密码时改端口（应放行）', await call('setPort', { port }));

console.log('\n=== 2. 首次设置双密码（初始化豁免，无需解锁） ===');
show('设置访客密码', await call('authUpdateConfig', { password: GUEST_PW }));
show('设置管理密码', await call('authUpdateConfig', { adminPassword: ADMIN_PW }));
show('开启访问认证', await call('authUpdateConfig', { enabled: true }));

console.log('\n=== 3. 未解锁时的高危操作 ===');
show('改端口（应拒绝）', await call('setPort', { port }));
show('改已存在的访客密码（应拒绝）', await call('authUpdateConfig', { password: 'hacked' }));
const qrNoAdmin = await call('getQr');
console.log(`  取二维码 withToken=${qrNoAdmin.value?.withToken} dataUrl=${qrNoAdmin.value?.dataUrl}`);

console.log('\n=== 4. 管理员解锁 ===');
show('错误管理密码（应拒绝）', await call('authAdminUnlock', { password: 'wrong' }));
const unlock = await call('authAdminUnlock', { password: ADMIN_PW });
show('正确管理密码', unlock);
const adminToken = unlock.value?.adminToken;

console.log('\n=== 5. 解锁后的高危操作 ===');
show('改端口（应放行）', await call('setPort', { port, adminToken }));
show('改验证方式（会重置解锁态）', await call('authUpdateConfig', { mode: 'password_only', adminToken }));
show('用旧令牌再改端口（应拒绝）', await call('setPort', { port, adminToken }));

const u2 = await call('authAdminUnlock', { password: ADMIN_PW });
const tok2 = u2.value?.adminToken;
show('重新解锁后改防篡改策略', await call('authUpdateConfig', { adminPolicy: 'local_only', adminToken: tok2 }));
show('local_only 下再解锁（应拒绝）', await call('authAdminUnlock', { password: ADMIN_PW }));

console.log('\n=== 6. 令牌脱敏 ===');
// local_only 挡住了远程解锁；本机路径靠 loopback-token。这里回退策略继续演示。
const u3 = await call('authAdminUnlock', { password: ADMIN_PW });
const tok3 = u3.value?.adminToken;
if (tok3) {
  const masked = await call('authGetStatus');
  const raw = await call('authGetStatus', { adminToken: tok3 });
  console.log(`  未解锁 secretToken 长度 = ${masked.value?.secretToken?.length}（含掩码）`);
  console.log(`  已解锁 secretToken 长度 = ${raw.value?.secretToken?.length}（原文）`);
  console.log(`  二维码 withToken = ${(await call('getQr', { adminToken: tok3 })).value?.withToken}`);
} else {
  console.log('  （local_only 生效中，远程无法解锁——这本身即为预期防护）');
}

console.log('\n=== 日志 ===');
for (const [lvl, msg] of logs) console.log(`[${lvl}] ${msg.slice(0, 160)}`);

for (const fn of effects) await fn();
console.log('dispose OK');
dsh.close();
process.exit(0);
void env;
