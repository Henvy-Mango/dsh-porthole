// 手工验收脚本：模拟宿主 ctx 驱动 apply()，跑通 RPC 全链路
// 用法：DSH_HOME=<含 .credentials.yaml 的目录> node test/manual-host.mjs <port>
import { env } from 'node:process';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 34567);

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
console.log('env DSH_HOME =', env.DSH_HOME);
mod.apply(ctx, { port });
await new Promise((r) => setTimeout(r, 400));

console.log('RPC channel =', rpc?.ch);
const status = await rpc.fn('getStatus', {});
console.log('getStatus:', status.ok, '| running =', status.value?.proxy?.running, '| port =', status.value?.proxy?.port);
console.log('lan.url =', status.value?.lan?.url);

const diag = await rpc.fn('diagnose', {});
console.log('diagnose =', diag.value?.checks?.map((c) => `${c.id}:${c.ok ? 'OK' : (c.warnOnly ? 'WARN' : 'FAIL')}(${c.detail})`).join('\n           '));

for (const [lvl, msg] of logs) console.log(`[${lvl}] ${msg}`);

for (const fn of effects) await fn();
console.log('dispose OK');
dsh.close();
process.exit(0);
