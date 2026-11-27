// ETag 再验证。每次先取上游当前响应，内容一致时向浏览器返回 304。
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const REVALIDATE_CACHE_CONTROL = 'private, no-cache';
export const REVALIDATE_MAX_BODY_BYTES = 16 * 1024 * 1024;

const CODE_TYPE_RE = /^(?:text\/(?:javascript|ecmascript|css)|application\/(?:x-)?(?:javascript|ecmascript))\b/i;
const HTML_TYPE_RE = /^text\/html\b/i;
const MEDIA_TYPE_RE = /^(?:(?:image|audio|video|font)\/|application\/(?:font-(?:woff2?|sfnt|ttf|otf)|vnd\.ms-fontobject|x-font-(?:ttf|otf|woff2?))\b)/i;

export function isRevalidationCandidate({
  method, pathname, reqHeaders = {}, status, resHeaders = {}, maxBytes = REVALIDATE_MAX_BODY_BYTES,
}) {
  if (method !== 'GET' || status !== 200 || reqHeaders.range) return false;
  if (resHeaders.etag !== undefined || resHeaders['content-range'] !== undefined) return false;
  if (Number(resHeaders['content-length']) > maxBytes) return false;
  const encoding = String(resHeaders['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding && encoding !== 'identity' && encoding !== 'gzip') return false;

  const type = String(resHeaders['content-type'] ?? '');
  if (pathname === '/' || pathname === '/index.html') return HTML_TYPE_RE.test(type);
  return CODE_TYPE_RE.test(type) || MEDIA_TYPE_RE.test(type);
}

// 按解码后内容生成弱校验器。gzip 和原文可共享校验器，200 仍返回上游原字节。
export function responseEtag(body, contentEncoding, maxBytes = REVALIDATE_MAX_BODY_BYTES) {
  const encoding = String(contentEncoding ?? '').trim().toLowerCase();
  let content = body;
  if (encoding === 'gzip') {
    try {
      content = gunzipSync(body, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
  }
  return `W/"${createHash('sha1').update(content).digest('base64url')}"`;
}

export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const value = etag.replace(/^W\//, '');
  const tags = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
  return tags.some((header) => header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === value));
}

export function revalidationCacheControl(headers = {}) {
  const cc = String(headers['cache-control'] ?? '');
  if (!cc || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cc)) return REVALIDATE_CACHE_CONTROL;
  return cc;
}
