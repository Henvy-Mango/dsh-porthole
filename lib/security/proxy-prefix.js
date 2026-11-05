// External prefixes describe the browser-visible mount; they never change req.url.
import { isIP } from 'node:net';

export const DEFAULT_TRUSTED_PROXIES = Object.freeze(['127.0.0.1', '::1']);

/** Canonical IP comparison, including dotted and hexadecimal IPv4-mapped IPv6. */
export function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  const value = address.trim();
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6 || value.includes('%')) return '';
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Custom arrays replace the defaults; invalid configuration never expands trust. */
export function normalizeTrustedProxies(value = DEFAULT_TRUSTED_PROXIES) {
  if (!Array.isArray(value)) throw new TypeError('trustedProxies 必须是精确 IP 地址的字符串数组');
  const addresses = value.map((entry) => {
    const address = normalizeAddress(entry);
    if (!address) throw new TypeError('trustedProxies 只接受精确 IPv4/IPv6 地址，不支持主机名、端口或网段');
    return address;
  });
  return [...new Set(addresses)];
}

/** Use the physical peer only; X-Forwarded-For is not an authority for trust. */
export function isTrustedProxy(remoteAddress, trustedProxies) {
  const address = normalizeAddress(remoteAddress);
  return address !== '' && trustedProxies.includes(address);
}

/** Only plain, single, same-site path prefixes are accepted. */
export function validateExternalPrefix(value) {
  if (typeof value !== 'string' || value.length > 200) {
    return { ok: false, error: 'X-Forwarded-Prefix 必须是单值路径，长度不超过 200 字符' };
  }
  if (value === '' || value === '/') return { ok: true, value: '' };
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(value)
    || value.startsWith('//') || value.includes('..') || /(?:^|\/)\.(?:\/|$)/.test(value)) {
    return { ok: false, error: 'X-Forwarded-Prefix 必须是合法的站内路径前缀' };
  }
  return { ok: true, value: value.replace(/\/{2,}/g, '/').replace(/\/+$/, '') };
}
