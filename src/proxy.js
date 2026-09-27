/**
 * 代理核心。
 *
 * 一次代理请求的完整生命周期：
 *   鉴权 → 读取请求体 → 解析摘要 → 选择上游 → 改写请求（model 前缀 / usage 上报）
 *   → 立刻落一条 running 日志（长连接也能在 UI 里实时看到）
 *   → 转发上游 → 边转发边解析（流式）/ 整体读取（非流式）
 *   → 回写客户端 → 补齐日志（用量、时延、首包时延、重组后的响应体、事件明细）
 *   → 通过事件总线推送给 Web 控制台
 *
 * 设计要点：
 *   - 对客户端 100% 透明：不缓冲流式响应，先 flushHeaders 再逐块透传；
 *   - 对日志尽可能完整：流式响应会被重组为与非流式等价的完整响应对象；
 *   - 失败也可观测：连接失败、超时、客户端中断、上游错误都落库并标记。
 */
import { EVENTS } from './bus.js';
import {
  ENDPOINT,
  createStreamCollector,
  describeRequest,
  detectEndpoint,
  errorMessageOf,
  normalizeNonStream,
  withUsageReporting,
} from './adapters.js';
import { createSseParser, isEventStream } from './sse.js';
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  extractIncomingKey,
  filterResponseHeaders,
  selectUpstream,
} from './upstream.js';
import {
  clampInt,
  clientIpOf,
  incomingHeadersToObject,
  maskSecret,
  readRequestBody,
  redactHeaders,
  safeJsonParse,
  safeJsonStringify,
  sendApiError,
  truncateText,
  uid,
} from './util.js';

/** 请求体硬上限：超过直接拒绝，避免内存被打爆 */
const HARD_BODY_LIMIT = 64 * 1024 * 1024;
/** 非流式响应日志上限：超过则不再解析入库 */
const MAX_LOGGED_RESPONSE_BYTES = 32 * 1024 * 1024;
/** 单个 SSE 事件落库的字符上限 */
const MAX_EVENT_DATA_CHARS = 20_000;

export function createProxyHandler({ store, config, bus }) {
  return async function handleProxyRequest(req, res, { pathname, search }) {
    const startedAt = Date.now();
    const requestId = uid();
    const endpoint = detectEndpoint(pathname);
    const incomingHeaders = incomingHeadersToObject(req.headers);
    const apiKey = extractIncomingKey(incomingHeaders);
    const { logging, proxy: proxyConfig } = config;

    if (proxyConfig.cors) applyCors(res);

    // 浏览器预检
    if (req.method === 'OPTIONS' && incomingHeaders['access-control-request-method']) {
      res.writeHead(204, { 'access-control-max-age': '600' });
      res.end();
      return;
    }

    const baseEntry = {
      request_id: requestId,
      started_at: new Date(startedAt).toISOString(),
      endpoint,
      method: req.method,
      path: pathname,
      query: search || '',
      stream: 0,
      client_ip: clientIpOf(req),
      user_agent: incomingHeaders['user-agent'] || null,
      api_key_masked: apiKey ? maskSecret(apiKey) : null,
      request_headers: redactHeaders(incomingHeaders, logging.redactHeaders || []),
      request_bytes: null,
      request_body: null,
      request_preview: null,
      model: null,
      requested_model: null,
      upstream_id: null,
      upstream_name: null,
      upstream_url: null,
      route_reason: null,
      truncated: 0,
    };

    const publish = (logId) => {
      try {
        const summary = store.getLogSummary(logId);
        if (summary) bus.publish(EVENTS.LOG, summary);
      } catch {
        /* 实时推送失败不影响主流程 */
      }
    };

    /**
     * 把本地请求 ID 写进响应头。
     *
     * 成功路径上 filterResponseHeaders 已经带了这两个头；失败路径（鉴权失败、
     * 没有可用上游、连不上上游……）走的是 sendApiError，这里补上，保证客户端
     * 无论成功失败都能拿到 x-logger-request-id，据此在日志里反查这次请求。
     */
    const markResponse = (upstreamName) => {
      if (res.headersSent || res.writableEnded) return;
      res.setHeader('x-logger-request-id', requestId);
      if (upstreamName) res.setHeader('x-logger-upstream', upstreamName);
    };

    /** 统一失败出口：落库 + 回写错误响应 */
    const fail = (status, message, { type = 'proxy_error', code = null, entry = baseEntry } = {}) => {
      let logId = null;
      try {
        logId = store.beginLog(entry);
        store.finishLog(logId, {
          phase: 'error',
          status_code: status,
          ok: 0,
          duration_ms: Date.now() - startedAt,
          error: message,
        });
      } catch (err) {
        console.error('[proxy] 写入失败日志出错：', err.message);
      }
      if (logId) publish(logId);
      markResponse();
      if (!res.headersSent && !res.writableEnded) {
        sendApiError(res, status, message, type, { code });
      } else if (!res.writableEnded) {
        res.end();
      }
    };

    // ── 1. 本地代理鉴权 ────────────────────────────────────────────────
    const proxyToken = String(config.server.proxyToken || '');
    if (proxyToken && apiKey !== proxyToken) {
      fail(401, '本地代理要求提供有效的 API Key（Authorization: Bearer <proxyToken>）。', {
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      });
      return;
    }

    // ── 2. 读取请求体 ──────────────────────────────────────────────────
    let bodyBuffer = Buffer.alloc(0);
    try {
      const read = await readRequestBody(req, HARD_BODY_LIMIT);
      bodyBuffer = read.buffer;
    } catch (err) {
      fail(err.code === 'E_TOO_LARGE' ? 413 : 400, `读取请求体失败：${err.message}`, { code: err.code || null });
      return;
    }
    const rawBodyText = bodyBuffer.length ? bodyBuffer.toString('utf8') : '';
    const bodyJson = rawBodyText ? safeJsonParse(rawBodyText) : undefined;
    const described = describeRequest(endpoint, bodyJson);

    // ── 3. 选择上游 ────────────────────────────────────────────────────
    const route = selectUpstream({
      store,
      config,
      headers: incomingHeaders,
      model: described.model,
      incomingKey: apiKey,
    });
    if (!route.upstream) {
      fail(503, '未配置可用的上游端点，请先在控制台「上游管理」中添加并启用一个上游。', { code: 'no_upstream' });
      return;
    }
    const upstream = route.upstream;
    const targetUrl = buildUpstreamUrl(upstream, pathname, search);

    baseEntry.stream = described.stream ? 1 : 0;
    baseEntry.model = route.model;
    baseEntry.requested_model = described.model;
    baseEntry.upstream_id = upstream.id;
    baseEntry.upstream_name = upstream.name;
    baseEntry.upstream_url = targetUrl;
    baseEntry.route_reason = route.reason;
    baseEntry.request_bytes = bodyBuffer.length;
    baseEntry.request_preview = described.preview;

    // ── 4. 改写转发体（模型前缀剥离 / 注入 usage 上报）──────────────────
    let forwardBuffer = bodyBuffer;
    let forwardText = rawBodyText;
    if (bodyJson && typeof bodyJson === 'object' && !Array.isArray(bodyJson)) {
      let mutated = false;
      if (route.model && route.model !== bodyJson.model) {
        bodyJson.model = route.model;
        mutated = true;
      }
      if (proxyConfig.includeUsageInStream !== false && incomingHeaders['x-logger-include-usage'] !== 'false') {
        const before = safeJsonStringify(bodyJson.stream_options);
        withUsageReporting(endpoint, bodyJson);
        if (safeJsonStringify(bodyJson.stream_options) !== before) mutated = true;
      }
      if (mutated) {
        forwardText = safeJsonStringify(bodyJson);
        forwardBuffer = Buffer.from(forwardText, 'utf8');
      }
    }

    let truncated = false;
    if (logging.logBodies && forwardText) {
      const [text, cut] = truncateText(forwardText, logging.maxBodyChars);
      baseEntry.request_body = text;
      truncated ||= cut;
    }
    baseEntry.truncated = truncated ? 1 : 0;

    const upstreamHeaders = buildUpstreamHeaders({ incomingHeaders, upstream, config, incomingKey: apiKey });

    // ── 5. 发起上游请求 ────────────────────────────────────────────────
    const timeoutMs = clampInt(proxyConfig.timeoutMs, { min: 1000, fallback: 600_000 });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error(`上游响应超时（${timeoutMs}ms）`), { code: 'E_TIMEOUT' })),
      timeoutMs,
    );

    const logId = store.beginLog(baseEntry);

    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        controller.abort(Object.assign(new Error('客户端提前断开连接'), { code: 'E_CLIENT_GONE' }));
      }
    });

    const methodHasBody = req.method !== 'GET' && req.method !== 'HEAD' && forwardBuffer.length > 0;
    let upstreamRes;
    try {
      upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: methodHasBody ? forwardBuffer : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      clearTimeout(timer);
      const timeout = err?.code === 'E_TIMEOUT';
      const gone = err?.code === 'E_CLIENT_GONE';
      const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.message || 'unknown';
      const message = timeout
        ? `上游请求超时（${timeoutMs}ms）`
        : gone
          ? '客户端提前断开连接'
          : `无法连接上游 ${upstream.base_url}：${cause}`;
      store.finishLog(logId, {
        phase: 'error',
        ok: 0,
        status_code: gone ? 499 : timeout ? 504 : 502,
        duration_ms: Date.now() - startedAt,
        error: message,
      });
      publish(logId);
      console.warn(`[proxy] ${endpoint} → ${upstream.name} 失败：${message}`);
      markResponse(upstream.name);
      if (!res.headersSent && !res.writableEnded) {
        sendApiError(res, timeout ? 504 : 502, message, 'upstream_error', {
          code: timeout ? 'upstream_timeout' : 'upstream_unreachable',
        });
      }
      return;
    }

    const status = upstreamRes.status;
    const responseContentType = upstreamRes.headers.get('content-type') || '';

    // ── 6a. 非流式：整体读取后一次性返回 ───────────────────────────────
    if (!isEventStream(responseContentType)) {
      let buffer;
      try {
        buffer = Buffer.from(await upstreamRes.arrayBuffer());
      } catch (err) {
        clearTimeout(timer);
        const message = errorMessageOf(err) || err.message;
        store.finishLog(logId, {
          phase: 'error',
          ok: 0,
          status_code: 502,
          duration_ms: Date.now() - startedAt,
          error: `读取上游响应失败：${message}`,
        });
        publish(logId);
        markResponse(upstream.name);
        if (!res.headersSent && !res.writableEnded) sendApiError(res, 502, `读取上游响应失败：${message}`, 'upstream_error');
        return;
      }
      clearTimeout(timer);

      const passthrough = filterResponseHeaders(upstreamRes.headers, { requestId, upstreamName: upstream.name });
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(status, { ...passthrough, 'content-length': buffer.length });
        res.end(buffer);
      }

      const responseText = buffer.toString('utf8');
      const json = safeJsonParse(responseText);
      const record = normalizeNonStream(endpoint, json);
      const isJson = json !== undefined;
      let storedBody = null;
      if (logging.logBodies && isJson && buffer.length <= MAX_LOGGED_RESPONSE_BYTES) {
        const [text, cut] = truncateText(safeJsonStringify(json) ?? '', logging.maxBodyChars);
        storedBody = text;
        truncated ||= cut;
      } else if (logging.logBodies && buffer.length > MAX_LOGGED_RESPONSE_BYTES) {
        truncated = true;
      }
      const [previewSource] = truncateText(record.text || record.error || responseText, 600);
      store.finishLog(logId, {
        phase: status >= 400 || record.error ? 'error' : 'done',
        status_code: status,
        ok: status >= 400 || record.error ? 0 : 1,
        duration_ms: Date.now() - startedAt,
        upstream_request_id: record.id ?? null,
        model: record.model || route.model,
        response_headers: Object.fromEntries(upstreamRes.headers.entries()),
        response_body: storedBody,
        response_text: record.text || null,
        response_preview: previewSource || null,
        prompt_tokens: record.usage?.prompt_tokens ?? null,
        completion_tokens: record.usage?.completion_tokens ?? null,
        total_tokens: record.usage?.total_tokens ?? null,
        cached_tokens: record.usage?.cached_tokens ?? null,
        reasoning_tokens: record.usage?.reasoning_tokens ?? null,
        tool_calls_count: record.toolCalls?.length ?? 0,
        finish_reason: record.finishReason ?? null,
        error: record.error ?? (status >= 400 ? truncateText(responseText, 1000)[0] : null),
        truncated: truncated ? 1 : 0,
      });
      publish(logId);
      if (status >= 400) {
        console.warn(`[proxy] ${endpoint} → ${upstream.name} 返回 ${status}`);
      }
      return;
    }

    // ── 6b. 流式：边透传边解析 ─────────────────────────────────────────
    const passthrough = filterResponseHeaders(upstreamRes.headers, { requestId, upstreamName: upstream.name });
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, passthrough);
      res.flushHeaders?.();
    }

    const collector = createStreamCollector(endpoint);
    const events = [];
    const maxEvents = clampInt(logging.maxEvents, { min: 0, fallback: 2000 });
    const decode = new TextDecoder('utf-8');
    let firstTokenMs = null;
    let streamError = null;

    const parser = createSseParser(({ event, data }) => {
      collector.push(data, event);
      if (logging.captureStreamEvents && events.length < maxEvents) {
        events.push({
          seq: events.length + 1,
          offset_ms: Date.now() - startedAt,
          event: event || null,
          data: truncateText(data, MAX_EVENT_DATA_CHARS)[0],
        });
      }
    });

    try {
      for await (const chunk of upstreamRes.body) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        const canContinue = await writeChunk(res, chunk);
        parser.push(decode.decode(chunk, { stream: true }));
        if (!canContinue) break;
      }
      parser.push(decode.decode());
      parser.flush();
    } catch (err) {
      streamError = err?.code === 'E_CLIENT_GONE' ? '客户端提前断开连接' : errorMessageOf(err) || err.message;
      try {
        parser.flush();
      } catch {
        /* ignore */
      }
    } finally {
      clearTimeout(timer);
      if (!res.writableEnded && !res.destroyed) res.end();
    }

    const record = collector.finalize();
    const ok = !streamError && !clientGone && status < 400 && !record.error ? 1 : 0;
    let storedBody = null;
    if (logging.logBodies) {
      const [text, cut] = truncateText(safeJsonStringify(record.responseBody) ?? '', logging.maxBodyChars);
      storedBody = text;
      truncated ||= cut;
    }
    const [previewSource] = truncateText(record.text || record.error || '', 600);

    store.finishLog(logId, {
      phase: ok ? 'done' : 'error',
      status_code: status,
      ok,
      duration_ms: Date.now() - startedAt,
      first_token_ms: firstTokenMs,
      upstream_request_id: record.id ?? null,
      model: record.model || route.model,
      response_headers: Object.fromEntries(upstreamRes.headers.entries()),
      response_body: storedBody,
      response_text: record.text || null,
      response_preview: previewSource || null,
      prompt_tokens: record.usage?.prompt_tokens ?? null,
      completion_tokens: record.usage?.completion_tokens ?? null,
      total_tokens: record.usage?.total_tokens ?? null,
      cached_tokens: record.usage?.cached_tokens ?? null,
      reasoning_tokens: record.usage?.reasoning_tokens ?? null,
      tool_calls_count: record.toolCalls?.length ?? 0,
      finish_reason: record.finishReason ?? null,
      event_count: events.length,
      error: streamError || record.error || (status >= 400 ? `上游返回 HTTP ${status}` : null),
      truncated: truncated ? 1 : 0,
    });
    if (logging.captureStreamEvents && events.length) {
      store.insertEvents(logId, events);
    }
    publish(logId);
  };
}

/* ---------------------------------------------------------------------- */

/** 带背压的写入；返回 false 表示客户端已断开 */
function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-expose-headers', 'x-logger-request-id,x-logger-upstream');
}
