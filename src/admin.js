/**
 * 管理后台 API（/admin/api/*）。
 *
 * 能力：
 *   - 上游管理：CRUD、密钥单独查看、连通性测试
 *   - 日志浏览：组合筛选 + 分页 + 详情 + 流式事件明细 + 导出(jsonl/csv) + 删除
 *   - 统计概览：总量/成功率/时延/token/分布/趋势/最近错误
 *   - 运行时设置：读写 config.json 与 settings 表
 *   - 实时日志：SSE 推送新落库的请求
 *
 * 安全：config.server.adminToken 非空时，所有 /admin/api 请求都需要携带
 * `Authorization: Bearer <token>` 或 `x-admin-token: <token>`；密钥字段默认
 * 只返回掩码，需显式调用 reveal 接口才能拿到明文。
 */
import fs from 'node:fs';
import { EVENTS } from './bus.js';
import { safeJsonParse, safeJsonStringify, sendJson, sendApiError, maskSecret, clampInt } from './util.js';

const STARTED_AT = Date.now();

export function createAdminHandler({ store, config, bus, version = '0.1.0' }) {
  const routes = [
    ['GET', /^\/admin\/api\/health$/, handleHealth],
    ['GET', /^\/admin\/api\/overview$/, handleOverview],
    ['GET', /^\/admin\/api\/stats$/, handleStats],
    ['GET', /^\/admin\/api\/facets$/, handleFacets],
    ['GET', /^\/admin\/api\/settings$/, handleGetSettings],
    ['PUT', /^\/admin\/api\/settings$/, handleUpdateSettings],
    ['POST', /^\/admin\/api\/maintenance\/purge$/, handlePurge],
    ['POST', /^\/admin\/api\/maintenance\/vacuum$/, handleVacuum],
    ['GET', /^\/admin\/api\/upstreams$/, handleListUpstreams],
    ['POST', /^\/admin\/api\/upstreams$/, handleCreateUpstream],
    ['POST', /^\/admin\/api\/upstreams\/test$/, handleTestUpstream],
    ['GET', /^\/admin\/api\/upstreams\/(\d+)$/, handleGetUpstream],
    ['PUT', /^\/admin\/api\/upstreams\/(\d+)$/, handleUpdateUpstream],
    ['DELETE', /^\/admin\/api\/upstreams\/(\d+)$/, handleDeleteUpstream],
    ['POST', /^\/admin\/api\/upstreams\/(\d+)\/reveal$/, handleRevealUpstream],
    ['GET', /^\/admin\/api\/logs$/, handleListLogs],
    ['POST', /^\/admin\/api\/logs\/delete$/, handleBulkDeleteLogs],
    ['POST', /^\/admin\/api\/logs\/clear$/, handleClearLogs],
    ['GET', /^\/admin\/api\/logs\/export$/, handleExportLogs],
    ['GET', /^\/admin\/api\/logs\/(\d+)$/, handleGetLog],
    ['DELETE', /^\/admin\/api\/logs\/(\d+)$/, handleDeleteLog],
    ['GET', /^\/admin\/api\/logs\/(\d+)\/events$/, handleGetLogEvents],
    ['GET', /^\/admin\/api\/events$/, handleLiveEvents],
  ];

  return async function handleAdmin(req, res, { pathname, url }) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-max-age': '600' });
      res.end();
      return true;
    }
    if (!checkAuth(req, res, config)) return true;

    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      if (method !== req.method) continue;
      try {
        await handler({ req, res, url, params: match.slice(1), store, config, bus, version });
      } catch (err) {
        console.error(`[admin] ${req.method} ${pathname} 出错：`, err);
        if (!res.headersSent) {
          sendApiError(res, err.statusCode || 500, err.message || '内部错误', 'server_error');
        } else {
          res.end();
        }
      }
      return true;
    }

    if (pathname.startsWith('/admin/api/')) {
      sendApiError(res, 404, `未找到接口 ${req.method} ${pathname}`, 'not_found');
      return true;
    }
    return false;
  };
}

/* ------------------------------------------------------------------ *
 * 鉴权
 * ------------------------------------------------------------------ */

function checkAuth(req, res, config) {
  const token = String(config.server.adminToken || '');
  if (!token) return true;
  const header = String(req.headers.authorization || '');
  const bearer = /^bearer\s+(.+)$/i.exec(header.trim());
  const provided = (bearer ? bearer[1].trim() : '') || String(req.headers['x-admin-token'] || '').trim();
  if (provided && provided === token) return true;
  sendApiError(res, 401, '需要管理令牌：请携带 Authorization: Bearer <adminToken> 或 x-admin-token。', 'invalid_request_error', {
    code: 'admin_token_required',
  });
  return false;
}

/* ------------------------------------------------------------------ *
 * 基础信息
 * ------------------------------------------------------------------ */

function handleHealth({ res, store, config, version }) {
  sendJson(res, 200, {
    ok: true,
    version,
    uptime_ms: Date.now() - STARTED_AT,
    db_file: config.paths?.dbFile ?? store.dbFile,
    upstreams: store.listUpstreams().length,
    auth: { admin: !!config.server.adminToken, proxy: !!config.server.proxyToken },
  });
}

function handleOverview({ res, store, config, url }) {
  const days = clampInt(url.searchParams.get('days'), { min: 1, max: 90, fallback: 7 });
  const stats = store.stats({ days });
  const upstreams = store.listUpstreams();
  let dbSize = null;
  try {
    dbSize = fs.statSync(store.dbFile).size;
  } catch {
    /* ignore */
  }
  sendJson(res, 200, {
    stats,
    upstreams: {
      total: upstreams.length,
      enabled: upstreams.filter((u) => u.enabled).length,
      default: upstreams.find((u) => u.is_default)?.name ?? null,
      items: upstreams.map((u) => ({
        id: u.id,
        name: u.name,
        base_url: u.base_url,
        enabled: u.enabled,
        is_default: u.is_default,
        models: u.models,
      })),
    },
    storage: { db_file: store.dbFile, db_size_bytes: dbSize },
  });
}

function handleStats({ res, store, url }) {
  const days = clampInt(url.searchParams.get('days'), { min: 1, max: 90, fallback: 7 });
  sendJson(res, 200, store.stats({ days }));
}

function handleFacets({ res, store }) {
  sendJson(res, 200, store.facets());
}

/* ------------------------------------------------------------------ *
 * 上游管理
 * ------------------------------------------------------------------ */

function upstreamView(upstream) {
  const { api_key: apiKey, ...rest } = upstream;
  return { ...rest, api_key_masked: maskSecret(apiKey), has_api_key: !!apiKey };
}

function handleListUpstreams({ res, store, url }) {
  const reveal = url.searchParams.get('reveal') === '1';
  const items = store.listUpstreams();
  sendJson(res, 200, { items: reveal ? items : items.map(upstreamView) });
}

function handleGetUpstream({ res, store, params }) {
  const upstream = store.getUpstream(Number(params[0]));
  if (!upstream) return sendApiError(res, 404, '上游不存在', 'not_found');
  sendJson(res, 200, upstreamView(upstream));
}

async function handleCreateUpstream({ req, res, store, bus }) {
  const body = await readJsonBody(req);
  try {
    const upstream = store.createUpstream(body || {});
    bus.publish(EVENTS.UPSTREAM_CHANGED, { action: 'create', id: upstream.id });
    sendJson(res, 201, upstreamView(upstream));
  } catch (err) {
    sendApiError(res, 400, err.message, 'invalid_request_error');
  }
}

async function handleUpdateUpstream({ req, res, store, bus, params }) {
  const id = Number(params[0]);
  const patch = await readJsonBody(req);
  // api_key 为 undefined / 空字符串时表示「不修改」
  if (patch && (patch.api_key === undefined || patch.api_key === '')) delete patch.api_key;
  if (patch && patch.api_key === null) patch.api_key = '';
  try {
    const upstream = store.updateUpstream(id, patch || {});
    if (!upstream) return sendApiError(res, 404, '上游不存在', 'not_found');
    bus.publish(EVENTS.UPSTREAM_CHANGED, { action: 'update', id });
    sendJson(res, 200, upstreamView(upstream));
  } catch (err) {
    sendApiError(res, 400, err.message, 'invalid_request_error');
  }
}

function handleDeleteUpstream({ res, store, bus, params }) {
  const ok = store.deleteUpstream(Number(params[0]));
  if (!ok) return sendApiError(res, 404, '上游不存在', 'not_found');
  bus.publish(EVENTS.UPSTREAM_CHANGED, { action: 'delete', id: Number(params[0]) });
  sendJson(res, 200, { ok: true });
}

function handleRevealUpstream({ res, store, params }) {
  const upstream = store.getUpstream(Number(params[0]));
  if (!upstream) return sendApiError(res, 404, '上游不存在', 'not_found');
  sendJson(res, 200, { id: upstream.id, api_key: upstream.api_key });
}

/**
 * 连通性测试：请求上游的 /models 端点。
 * body 可以是 { id } 或 { base_url, api_key, ... }（用于保存前先试连）。
 */
async function handleTestUpstream({ req, res, store, params }) {
  const body = (await readJsonBody(req)) || {};
  let target = body;
  if (body.id) {
    const config = store.getUpstream(Number(body.id));
    if (!config) return sendApiError(res, 404, '上游不存在', 'not_found');
    target = { ...config, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== 'id')) };
    if (!body.api_key) target.api_key = config.api_key;
  }
  if (!target.base_url) return sendApiError(res, 400, '缺少 base_url', 'invalid_request_error');

  const base = String(target.base_url).replace(/\/+$/, '');
  const probeUrl = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  const headers = { accept: 'application/json', 'user-agent': 'openai-api-logger/0.1.0' };
  if (target.api_key) headers.authorization = `Bearer ${target.api_key}`;
  if (target.organization) headers['openai-organization'] = target.organization;

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(probeUrl, { method: 'GET', headers, signal: controller.signal });
    const text = await response.text();
    const json = safeJsonParse(text);
    const models = Array.isArray(json?.data) ? json.data.map((m) => m?.id).filter(Boolean) : [];
    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      probe_url: probeUrl,
      model_count: models.length,
      sample_models: models.slice(0, 20),
      error: response.ok ? null : text.slice(0, 500),
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      status: null,
      latency_ms: Date.now() - startedAt,
      probe_url: probeUrl,
      error: err?.cause?.code || err?.code || err.message,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

function logFiltersOf(url) {
  const sp = url.searchParams;
  const get = (k) => {
    const v = sp.get(k);
    return v === null || v === '' ? undefined : v;
  };
  return {
    endpoint: get('endpoint'),
    model: get('model'),
    upstream_id: get('upstream_id'),
    ok: get('ok'),
    stream: get('stream'),
    phase: get('phase'),
    status: get('status'),
    q: get('q'),
    from: get('from'),
    to: get('to'),
  };
}

function handleListLogs({ res, store, url }) {
  const filters = logFiltersOf(url);
  filters.limit = url.searchParams.get('limit') ?? 25;
  filters.offset = url.searchParams.get('offset') ?? 0;
  filters.sort = url.searchParams.get('sort') ?? 'started_at';
  filters.order = url.searchParams.get('order') ?? 'desc';
  sendJson(res, 200, store.listLogs(filters));
}

function handleGetLog({ res, store, params }) {
  const log = store.getLog(Number(params[0]));
  if (!log) return sendApiError(res, 404, '日志不存在', 'not_found');
  sendJson(res, 200, log);
}

function handleGetLogEvents({ res, store, params, url }) {
  const events = store.getLogEvents(Number(params[0]), {
    limit: url.searchParams.get('limit') ?? 2000,
    offset: url.searchParams.get('offset') ?? 0,
  });
  sendJson(res, 200, { items: events, count: events.length });
}

function handleDeleteLog({ res, store, params }) {
  const ok = store.deleteLog(Number(params[0]));
  if (!ok) return sendApiError(res, 404, '日志不存在', 'not_found');
  sendJson(res, 200, { ok: true });
}

async function handleBulkDeleteLogs({ req, res, store, url }) {
  const body = (await readJsonBody(req)) || {};
  const filters = { ...logFiltersOf(url), ...(body.filters || body) };
  const deleted = store.deleteLogs(filters);
  sendJson(res, 200, { ok: true, deleted });
}

function handleClearLogs({ res, store }) {
  const deleted = store.deleteLogs({});
  store.vacuum();
  sendJson(res, 200, { ok: true, deleted });
}

function handleExportLogs({ res, store, url }) {
  const format = (url.searchParams.get('format') || 'jsonl').toLowerCase();
  const filters = logFiltersOf(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const isCsv = format === 'csv';
  res.writeHead(200, {
    'content-type': isCsv ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="openai-api-logs-${stamp}.${isCsv ? 'csv' : 'jsonl'}"`,
    'cache-control': 'no-store',
  });
  if (isCsv) {
    res.write(
      `${[
        'id',
        'started_at',
        'endpoint',
        'model',
        'upstream',
        'status',
        'ok',
        'stream',
        'duration_ms',
        'first_token_ms',
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'request',
        'response',
        'error',
      ].join(',')}\n`,
    );
  }
  store.listLogsFull(filters, (row) => {
    if (isCsv) {
      res.write(
        `${[
          row.id,
          row.started_at,
          row.endpoint,
          row.model,
          row.upstream_name,
          row.status_code,
          row.ok ? 1 : 0,
          row.stream ? 1 : 0,
          row.duration_ms,
          row.first_token_ms,
          row.prompt_tokens,
          row.completion_tokens,
          row.total_tokens,
          row.request_preview,
          row.response_preview,
          row.error,
        ]
          .map(csvCell)
          .join(',')}\n`,
      );
    } else {
      res.write(`${safeJsonStringify(row)}\n`);
    }
  });
  res.end();
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

function publicConfig(config) {
  return {
    server: {
      host: config.server.host,
      port: config.server.port,
      admin_token_set: !!config.server.adminToken,
      admin_token_masked: maskSecret(config.server.adminToken),
      proxy_token_set: !!config.server.proxyToken,
      proxy_token_masked: maskSecret(config.server.proxyToken),
    },
    proxy: { ...config.proxy },
    logging: { ...config.logging },
    ui: { ...config.ui },
  };
}

function handleGetSettings({ res, config, store }) {
  sendJson(res, 200, {
    config: publicConfig(config),
    paths: { data_dir: config.paths.dataDir, config_file: config.paths.configFile, db_file: config.paths.dbFile },
    settings: store.allSettings(),
  });
}

async function handleUpdateSettings({ req, res, config, store, bus }) {
  const patch = (await readJsonBody(req)) || {};
  const next = {};
  for (const section of ['server', 'proxy', 'logging', 'ui']) {
    if (patch[section] && typeof patch[section] === 'object') next[section] = { ...patch[section] };
  }
  // token 语义：undefined/'' 表示不修改，null 表示清空，非空字符串表示设置
  if (next.server) {
    for (const key of ['adminToken', 'proxyToken']) {
      if (!(key in next.server)) continue;
      const value = next.server[key];
      if (value === undefined || value === '') delete next.server[key];
      else if (value === null) next.server[key] = '';
    }
  }
  const restartRequired = !!(next.server && ('host' in next.server || 'port' in next.server));
  config.update(next);
  bus.publish(EVENTS.SETTINGS_CHANGED, { patch: Object.keys(next) });
  sendJson(res, 200, { ok: true, config: publicConfig(config), restart_required: restartRequired });
}

/* ------------------------------------------------------------------ *
 * 维护
 * ------------------------------------------------------------------ */

async function handlePurge({ req, res, store }) {
  const body = (await readJsonBody(req)) || {};
  const days = clampInt(body.days ?? store.getSetting('retentionDays', 0), { min: 0, max: 3650, fallback: 0 });
  const deleted = days > 0 ? store.purgeOlderThan(days) : 0;
  sendJson(res, 200, { ok: true, deleted, days });
}

function handleVacuum({ res, store }) {
  store.vacuum();
  sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ *
 * 实时日志（SSE）
 * ------------------------------------------------------------------ */

function handleLiveEvents({ req, res, bus }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = bus.subscribe(EVENTS.LOG, (summary) => {
    res.write(`event: log\ndata: ${safeJsonStringify(summary)}\n\n`);
  });
  const unsubscribeUpstream = bus.subscribe(EVENTS.UPSTREAM_CHANGED, (payload) => {
    res.write(`event: upstream_changed\ndata: ${safeJsonStringify(payload)}\n\n`);
  });
  const timer = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(timer);
    unsubscribe();
    unsubscribeUpstream();
  });
}

/* ------------------------------------------------------------------ */

async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  const json = safeJsonParse(text);
  if (json === undefined) {
    const err = new Error('请求体不是合法 JSON');
    err.statusCode = 400;
    throw err;
  }
  return json;
}
