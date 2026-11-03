// lib/net.js —— 局域网网卡枚举与最优 IP 选择
//
// Lite 版唯一保留的"网络智能"：从 networkInterfaces() 里挑出真正能互通物理局域网的
// IPv4 地址，并对虚拟网卡（WSL / VMware / Docker / Hyper-V / VPN 隧道）大幅降权。
// 逻辑与上游 dsh-bridge 的 listAllLanIPv4 / selectLanIPv4 逐字等价（含权重与排序），
// 之所以重写而不是 import，是为了让 lite 版不引入上游 lib/index.js 的整套依赖树。

import { networkInterfaces } from 'node:os';

/** 命中任一关键词即视为虚拟网卡（大幅降权，但仍保留在列表里供用户手动切换）。 */
const VIRTUAL_KEYWORDS = [
  'vethernet', 'wsl', 'hyper-v', 'virtual', 'vmware', 'vbox', 'docker',
  'tailscale', 'zerotier', 'tap', 'tun', 'utun', 'wireguard', 'loopback', 'bridge',
  // 代理 / VPN 客户端常驻的 TUN 适配器：它们不是"同一个局域网"，
  // 选错了手机就连不上。实测 Windows 上 Mihomo 的适配器名就叫 `Mihomo`。
  'mihomo', 'clash', 'sing-box', 'singbox', 'wintun', 'nordlynx', 'proton', 'surge', 'stash',
];

const PRIVATE_RANGES = [
  { test: (a) => a.startsWith('192.168.'), score: 100 },
  { test: (a) => a.startsWith('10.'), score: 90 },
  { test: (a) => /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(a), score: 70 },
];

/**
 * 一定不是"家用/办公局域网"的地址段 —— 即使网卡名看起来像物理网卡也重罚。
 *
 * 198.18.0.0/15 是 RFC 2544 基准测试保留段，真实局域网不会用它，但 Mihomo / Clash
 * 这类代理的 TUN 适配器默认就取这个网段做 fake-ip。实测在本机出现
 * `Mihomo 198.18.0.1`，若不识别会与真网卡抢"最佳地址"。
 */
const NOT_A_LAN_RANGE = /^198\.(1[89])\./;

const WIRELESS = (n) => n.includes('wi-fi') || n.includes('wlan') || n.includes('wireless');
const WIRED = (n) => n.includes('ethernet') || n.includes('以太网') || n.includes('eth') || n.includes('en');

/**
 * 列出可用的局域网 IPv4 网卡，按推荐优先级降序。
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [interfaces]
 * @returns {Array<{name:string,label:string,address:string,netmask:string,isVirtual:boolean,score:number}>}
 */
export function listAllLanIPv4(interfaces = networkInterfaces()) {
  const list = [];

  for (const [ifname, addrs] of Object.entries(interfaces ?? {})) {
    if (!addrs) continue;
    const lower = String(ifname).toLowerCase();
    const isVirtual = VIRTUAL_KEYWORDS.some((kw) => lower.includes(kw));

    for (const addr of addrs) {
      // Node 18 起 family 为 'IPv4'；老版本为 4。两者都认，避免宿主 Node 版本影响可用性。
      const family = addr.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (addr.internal) continue;

      let score = 0;
      const priv = PRIVATE_RANGES.find((r) => r.test(addr.address));
      score += priv ? priv.score : 10;
      if (NOT_A_LAN_RANGE.test(addr.address)) score -= 200;

      if (isVirtual) {
        score -= 200;
      } else {
        score += 100;
        if (WIRELESS(lower)) score += 50;
        else if (WIRED(lower)) score += 40;
      }

      let label = ifname;
      if (isVirtual) label += ' (虚拟网卡 / WSL / 虚拟机)';
      else if (WIRELESS(lower)) label += ' (Wi-Fi 无线网卡)';
      else if (WIRED(lower)) label += ' (有线网卡)';

      list.push({ name: ifname, label, address: addr.address, netmask: addr.netmask, isVirtual, score });
    }
  }

  return list.sort((a, b) => b.score - a.score);
}

/**
 * 选出最佳默认局域网 IP。
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string|null}
 */
export function selectLanIPv4(interfaces = networkInterfaces()) {
  return listAllLanIPv4(interfaces)[0]?.address || null;
}

/**
 * 判断一个值是否是本机当前真实存在的网卡地址（用于校验持久化里的 selectedIp）。
 * @param {string} ip
 * @param {Array<{address:string}>} list
 * @returns {boolean}
 */
export function isKnownLanIp(ip, list) {
  return Boolean(ip) && list.some((i) => i.address === ip);
}
