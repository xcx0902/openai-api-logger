/**
 * 通用工具函数：路径、时间、JSON、HTTP 头处理等。
 * 该模块不依赖任何第三方包。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认数据目录（数据库 / 配置 / 日志） */
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/** 返回 ISO 8601（UTC）时间字符串 */
export function nowIso() {
  return new Date().toISOString();
}

/** 生成本地请求 ID */
export function uid() {
  return crypto.randomUUID();
}

/** 稳定的短哈希，用于导出文件名等 */
export function shortHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 8);
}

/** 掩码显示密钥：sk-abcd…wxyz */
export function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 10) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** 不抛异常的 JSON 解析 */
export function safeJsonParse(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 安全序列化（遇到循环引用 / BigInt 不崩溃） */
export function safeJsonStringify(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  } catch {
    return JSON.stringify({ _error: 'unserializable' });
  }
}

/** 截断字符串（按字符），返回 [text, truncated] */
export function truncateText(text, maxChars) {
  if (typeof text !== 'string') return ['', false];
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return [text, false];
  return [text.slice(0, maxChars), true];
}

/** 递归合并普通对象（后者优先） */
export function deepMerge(base, patch) {
  if (!isPlainObject(base)) return clone(patch);
  if (!isPlainObject(patch)) return patch === undefined ? clone(base) : patch;
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深拷贝（注意不能复用 deepMerge，否则会无限递归） */
export function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clone(val);
    return out;
  }
  return v;
}

/** 解析整数，带范围限制与默认值 */
export function clampInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 拼接上游 URL：base 以 /v1 结尾时自动去掉入站路径里的 /v1 前缀，避免出现 /v1/v1 */
export function buildTargetUrl(baseUrl, pathname, search = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let p = pathname || '/';
  if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(p)) p = p.slice(3) || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return `${base}${p}${search || ''}`;
}

/** Web Headers → 普通对象（多值合并为数组） */
export function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    out[k] = out[k] === undefined ? v : `${out[k]}, ${v}`;
  }
  return out;
}

/** Node IncomingHttpHeaders → 普通对象，同名头合并 */
export function incomingHeadersToObject(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** 需要过滤掉的逐跳头（不应转发） */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** 按名单脱敏请求头 */
export function redactHeaders(headers, redactList) {
  const list = new Set(redactList.map((h) => h.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = list.has(k.toLowerCase()) ? maskSecret(v) : v;
  }
  return out;
}

/** 读取请求体，超过 hardLimit 抛错（避免内存被打爆） */
export function readRequestBody(req, hardLimit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > hardLimit) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        const err = new Error(`request body exceeds ${hardLimit} bytes`);
        err.code = 'E_TOO_LARGE';
        reject(err);
        return;
      }
      resolve({ buffer: Buffer.concat(chunks), bytes: size });
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('client aborted'), { code: 'E_ABORTED' })));
  });
}

/** 取得客户端 IP（考虑反向代理头） */
export function clientIpOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/** 从 URL 中提取查询串（含 ?） */
export function searchOf(rawUrl) {
  const idx = rawUrl.indexOf('?');
  return idx === -1 ? '' : rawUrl.slice(idx);
}

/** 统一的 JSON 响应 */
export function sendJson(res, statusCode, payload) {
  const body = safeJsonStringify(payload) ?? 'null';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** OpenAI 风格的错误响应 */
export function sendApiError(res, statusCode, message, type = 'proxy_error', extra = {}) {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      param: null,
      code: extra.code ?? null,
      ...extra,
    },
  });
}
