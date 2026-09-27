/**
 * 上游选择与转发请求构造。
 *
 * 上游匹配优先级（命中即返回，并记录 route_reason 供排查）：
 *   1. 请求头 x-upstream: <id 或 name>     —— 显式指定
 *   2. 入站 API Key 与某个上游配置的 key 相同 —— 按密钥路由
 *   3. 模型名前缀 <upstreamName>/<model>     —— 按前缀路由（转发时剥掉前缀）
 *   4. is_default = 1 的上游
 *   5. 第一个 enabled 的上游
 */
import { HOP_BY_HOP, buildTargetUrl, safeJsonParse } from './util.js';

/** 从入站请求头中取出客户端使用的 API Key */
export function extractIncomingKey(headers = {}) {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  for (const name of ['api-key', 'x-api-key']) {
    if (typeof headers[name] === 'string' && headers[name].trim()) return headers[name].trim();
  }
  return '';
}

/**
 * @returns {{upstream: object|null, reason: string, model: string|null, requestedModel: string|null}}
 */
export function selectUpstream({ store, config, headers = {}, model = null, incomingKey = '' }) {
  const requestedModel = model;
  const byIdOrName = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) return store.getUpstream(Number(raw));
    return store.findUpstreamByName(raw);
  };

  // 1. 显式请求头
  const headerChoice = byIdOrName(headers['x-upstream'] || headers['x-logger-upstream']);
  if (headerChoice && headerChoice.enabled) {
    return { upstream: headerChoice, reason: 'header:x-upstream', model: requestedModel, requestedModel };
  }

  // 2. 按 API Key 匹配
  if (config.proxy.matchByApiKey && incomingKey) {
    const byKey = store.findUpstreamByApiKey(incomingKey);
    if (byKey) return { upstream: byKey, reason: 'api-key-match', model: requestedModel, requestedModel };
  }

  // 3. 模型名前缀：<name>/<model>
  if (config.proxy.allowModelPrefix && typeof requestedModel === 'string' && requestedModel.includes('/')) {
    const slash = requestedModel.indexOf('/');
    const prefix = requestedModel.slice(0, slash);
    const rest = requestedModel.slice(slash + 1);
    const candidate = byIdOrName(prefix);
    if (candidate && candidate.enabled && rest) {
      return { upstream: candidate, reason: 'model-prefix', model: rest, requestedModel };
    }
  }

  // 4/5. 默认上游
  const fallback = store.defaultUpstream();
  if (fallback) {
    const reason = fallback.is_default ? 'default' : 'first-enabled';
    return { upstream: fallback, reason, model: requestedModel, requestedModel };
  }

  return { upstream: null, reason: 'none', model: requestedModel, requestedModel };
}

/** 拼接上游目标地址 */
export function buildUpstreamUrl(upstream, pathname, search) {
  return buildTargetUrl(upstream.base_url, pathname, search);
}

/** 构造发往上游的请求头 */
export function buildUpstreamHeaders({ incomingHeaders = {}, upstream, config, incomingKey = '' }) {
  const out = {};
  const forward = new Set((config.proxy.forwardHeaders || []).map((h) => h.toLowerCase()));

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'authorization' || lower === 'api-key' || lower === 'x-api-key') continue;
    if (lower === 'x-upstream' || lower === 'x-logger-upstream' || lower === 'x-admin-token') continue;
    if (lower === 'content-type' || lower === 'accept' || lower === 'user-agent' || forward.has(lower)) {
      out[key] = value;
    }
  }

  // 鉴权：优先上游自带 key；use_client_key 时直接透传客户端 key
  const useClientKey = upstream.use_client_key && incomingKey;
  const key = useClientKey ? incomingKey : upstream.api_key || incomingKey;
  if (key) out.authorization = `Bearer ${key}`;

  if (upstream.organization) out['openai-organization'] = upstream.organization;
  if (upstream.project) out['openai-project'] = upstream.project;
  if (!out['user-agent']) out['user-agent'] = 'openai-api-logger/0.1.0';

  // 上游自定义头优先级最高
  let extra = upstream.extra_headers;
  if (typeof extra === 'string') extra = safeJsonParse(extra) || {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }

  return out;
}

/** 上游返回头 → 客户端返回头：过滤逐跳头，并剔除因自动解压而失效的编码/长度头 */
export function filterResponseHeaders(upstreamHeaders, { requestId, upstreamName } = {}) {
  const out = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'content-encoding' || lower === 'content-length') continue;
    out[key] = value;
  }
  if (requestId) out['x-logger-request-id'] = requestId;
  if (upstreamName) out['x-logger-upstream'] = upstreamName;
  return out;
}
