/**
 * 存储层：基于 Node 内置 node:sqlite（零依赖）。
 * 表结构：
 *   upstreams  —— 上游 API 端点配置
 *   logs       —— 每次代理请求一行（请求 + 上游响应 + 用量 + 时延）
 *   log_events —— 流式响应的 SSE 事件明细（逐条时间线）
 *   settings   —— 运行时可调设置（KV）
 *   meta       —— 内部元数据（schema 版本等）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clampInt, nowIso, safeJsonParse, safeJsonStringify } from './util.js';

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS upstreams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  base_url      TEXT NOT NULL,
  api_key       TEXT NOT NULL DEFAULT '',
  organization  TEXT NOT NULL DEFAULT '',
  project       TEXT NOT NULL DEFAULT '',
  extra_headers TEXT NOT NULL DEFAULT '{}',
  models        TEXT NOT NULL DEFAULT '',
  use_client_key INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id          TEXT NOT NULL UNIQUE,
  upstream_request_id TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  duration_ms         INTEGER,
  first_token_ms      INTEGER,
  phase               TEXT NOT NULL DEFAULT 'running',
  endpoint            TEXT NOT NULL,
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,
  query               TEXT NOT NULL DEFAULT '',
  status_code         INTEGER,
  ok                  INTEGER NOT NULL DEFAULT 0,
  stream              INTEGER NOT NULL DEFAULT 0,
  model               TEXT,
  requested_model     TEXT,
  upstream_id         INTEGER,
  upstream_name       TEXT,
  upstream_url        TEXT,
  route_reason        TEXT,
  client_ip           TEXT,
  user_agent          TEXT,
  api_key_masked      TEXT,
  request_headers     TEXT,
  request_body        TEXT,
  request_preview     TEXT,
  request_bytes       INTEGER,
  response_headers    TEXT,
  response_body       TEXT,
  response_text       TEXT,
  response_preview    TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  total_tokens        INTEGER,
  cached_tokens       INTEGER,
  reasoning_tokens    INTEGER,
  tool_calls_count    INTEGER NOT NULL DEFAULT 0,
  finish_reason       TEXT,
  event_count         INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  truncated           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_logs_started_at   ON logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_endpoint     ON logs(endpoint);
CREATE INDEX IF NOT EXISTS idx_logs_model        ON logs(model);
CREATE INDEX IF NOT EXISTS idx_logs_upstream     ON logs(upstream_id);
CREATE INDEX IF NOT EXISTS idx_logs_phase        ON logs(phase);
CREATE INDEX IF NOT EXISTS idx_logs_ok           ON logs(ok);

CREATE TABLE IF NOT EXISTS log_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id      INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  offset_ms   INTEGER,
  event       TEXT,
  data        TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_log ON log_events(log_id, seq);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array */
function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return safeJsonStringify(value);
  return value;
}

function bindAll(args) {
  return args.map(bind);
}

/** 列表 / 实时推送用的字段集（不含大字段，保证查询与推送轻量） */
const SUMMARY_COLUMNS = `id, request_id, started_at, finished_at, duration_ms, first_token_ms, phase, endpoint,
        method, status_code, ok, stream, model, upstream_id, upstream_name, route_reason, client_ip,
        prompt_tokens, completion_tokens, total_tokens, tool_calls_count, finish_reason,
        event_count, error, request_preview, response_preview,
        length(coalesce(request_body, '')) AS request_body_len,
        length(coalesce(response_body, '')) AS response_body_len`;

export class Store {
  /**
   * @param {string} dbFile SQLite 文件路径，':' 内存模式用于测试
   */
  constructor(dbFile) {
    this.dbFile = dbFile;
    if (dbFile !== ':memory:') {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    }
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(DDL);
    this.#migrate();
    this.stmtCache = new Map();
  }

  #migrate() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
    }
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('initialized_at', nowIso());
  }

  /** 预编译语句缓存 */
  #s(sql) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * upstreams
   * ------------------------------------------------------------------ */

  listUpstreams() {
    return this.#s('SELECT * FROM upstreams ORDER BY is_default DESC, name ASC').all().map(mapUpstream);
  }

  getUpstream(id) {
    const row = this.#s('SELECT * FROM upstreams WHERE id = ?').get(bind(id));
    return row ? mapUpstream(row) : null;
  }

  findUpstreamByName(name) {
    const row = this.#s('SELECT * FROM upstreams WHERE name = ? COLLATE NOCASE').get(bind(name));
    return row ? mapUpstream(row) : null;
  }

  findUpstreamByApiKey(apiKey) {
    if (!apiKey) return null;
    const row = this.#s('SELECT * FROM upstreams WHERE api_key = ? AND api_key <> ? AND enabled = 1 LIMIT 1').get(
      bind(apiKey),
      '',
    );
    return row ? mapUpstream(row) : null;
  }

  /** 取默认上游：显式 is_default 优先，否则取第一个启用的 */
  defaultUpstream() {
    const rows = this.#s('SELECT * FROM upstreams WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1').all();
    return rows.length ? mapUpstream(rows[0]) : null;
  }

  createUpstream(input = {}) {
    const ts = nowIso();
    const record = normalizeUpstreamInput(input);
    const result = this.#s(
      `INSERT INTO upstreams (name, base_url, api_key, organization, project, extra_headers, models,
                              use_client_key, is_default, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ...bindAll([
        record.name,
        record.base_url,
        record.api_key,
        record.organization,
        record.project,
        record.extra_headers,
        record.models,
        record.use_client_key,
        record.is_default,
        record.enabled,
        record.note,
        ts,
        ts,
      ]),
    );
    const id = Number(result.lastInsertRowid);
    if (record.is_default) this.#clearOtherDefaults(id);
    return this.getUpstream(id);
  }

  updateUpstream(id, patch = {}) {
    const existing = this.getUpstream(id);
    if (!existing) return null;
    const merged = normalizeUpstreamInput({ ...toUpstreamInput(existing), ...stripUndefined(patch) }, existing);
    this.#s(
      `UPDATE upstreams SET name = ?, base_url = ?, api_key = ?, organization = ?, project = ?,
              extra_headers = ?, models = ?, use_client_key = ?, is_default = ?, enabled = ?,
              note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      ...bindAll([
        merged.name,
        merged.base_url,
        merged.api_key,
        merged.organization,
        merged.project,
        merged.extra_headers,
        merged.models,
        merged.use_client_key,
        merged.is_default,
        merged.enabled,
        merged.note,
        nowIso(),
        id,
      ]),
    );
    if (merged.is_default) this.#clearOtherDefaults(id);
    return this.getUpstream(id);
  }

  deleteUpstream(id) {
    const existing = this.getUpstream(id);
    if (!existing) return false;
    this.#s('DELETE FROM upstreams WHERE id = ?').run(bind(id));
    return true;
  }

  #clearOtherDefaults(keepId) {
    this.#s('UPDATE upstreams SET is_default = 0 WHERE id <> ?').run(bind(keepId));
  }

  /* ------------------------------------------------------------------ *
   * logs
   * ------------------------------------------------------------------ */

  /** 请求开始时先落一行（phase=running），便于 UI 实时观察长连接 */
  beginLog(entry) {
    const result = this.#s(
      `INSERT INTO logs (request_id, started_at, phase, endpoint, method, path, query, stream,
                         model, requested_model, upstream_id, upstream_name, upstream_url, route_reason,
                         client_ip, user_agent, api_key_masked, request_headers, request_body,
                         request_preview, request_bytes, truncated)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ...bindAll([
        entry.request_id,
        entry.started_at || nowIso(),
        entry.endpoint,
        entry.method,
        entry.path,
        entry.query || '',
        entry.stream,
        entry.model ?? null,
        entry.requested_model ?? null,
        entry.upstream_id ?? null,
        entry.upstream_name ?? null,
        entry.upstream_url ?? null,
        entry.route_reason ?? null,
        entry.client_ip ?? null,
        entry.user_agent ?? null,
        entry.api_key_masked ?? null,
        entry.request_headers ?? null,
        entry.request_body ?? null,
        entry.request_preview ?? null,
        entry.request_bytes ?? null,
        entry.truncated ? 1 : 0,
      ]),
    );
    return Number(result.lastInsertRowid);
  }

  /** 请求结束（成功或失败）时补齐结果字段 */
  finishLog(id, patch = {}) {
    const fields = [
      'upstream_request_id',
      'finished_at',
      'duration_ms',
      'first_token_ms',
      'phase',
      'status_code',
      'ok',
      'model',
      'response_headers',
      'response_body',
      'response_text',
      'response_preview',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'cached_tokens',
      'reasoning_tokens',
      'tool_calls_count',
      'finish_reason',
      'event_count',
      'error',
      'truncated',
    ];
    const sets = [];
    const values = [];
    for (const field of fields) {
      if (patch[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(bind(patch[field]));
    }
    if (patch.finished_at === undefined) {
      sets.push('finished_at = ?');
      values.push(bind(nowIso()));
    }
    if (!sets.length) return;
    values.push(bind(id));
    this.#s(`UPDATE logs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** 流式事件批量写入 */
  insertEvents(logId, events) {
    if (!events?.length) return 0;
    const stmt = this.#s('INSERT INTO log_events (log_id, seq, offset_ms, event, data) VALUES (?, ?, ?, ?, ?)');
    let n = 0;
    for (const ev of events) {
      stmt.run(...bindAll([logId, ev.seq, ev.offset_ms ?? null, ev.event ?? null, ev.data ?? null]));
      n += 1;
    }
    return n;
  }

  buildLogFilters(filters = {}) {
    const where = [];
    const params = [];
    const { endpoint, model, upstream_id: upstreamId, ok, stream, phase, status, q, from, to } = filters;
    if (endpoint) {
      where.push('endpoint = ?');
      params.push(endpoint);
    }
    if (model) {
      where.push('(model = ? OR model LIKE ? OR requested_model = ?)');
      params.push(model, `${model}%`, model);
    }
    if (upstreamId) {
      where.push('upstream_id = ?');
      params.push(Number(upstreamId));
    }
    if (ok !== undefined && ok !== null && ok !== '') {
      where.push('ok = ?');
      params.push(ok === 'true' || ok === true || ok === 1 || ok === '1' ? 1 : 0);
    }
    if (stream !== undefined && stream !== null && stream !== '') {
      where.push('stream = ?');
      params.push(stream === 'true' || stream === true || stream === 1 || stream === '1' ? 1 : 0);
    }
    if (phase) {
      where.push('phase = ?');
      params.push(phase);
    }
    if (status) {
      where.push('status_code = ?');
      params.push(Number(status));
    }
    if (from) {
      where.push('started_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('started_at <= ?');
      params.push(to);
    }
    if (q) {
      where.push('(request_preview LIKE ? OR response_preview LIKE ? OR response_text LIKE ? OR error LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  listLogs(filters = {}) {
    const { clause, params } = this.buildLogFilters(filters);
    const limit = clampInt(filters.limit, { min: 1, max: 500, fallback: 25 });
    const offset = clampInt(filters.offset, { min: 0, max: 10_000_000, fallback: 0 });
    const sort = SORTABLE[filters.sort] || SORTABLE.started_at;
    const direction = String(filters.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const total = this.#s(`SELECT COUNT(*) AS n FROM logs ${clause}`).get(...bindAll(params)).n;
    const rows = this.#s(
      `SELECT ${SUMMARY_COLUMNS}
       FROM logs ${clause}
       ORDER BY ${sort} ${direction}, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...bindAll([...params, limit, offset]));

    return { total, limit, offset, rows: rows.map(mapLogSummary) };
  }

  /** 单条日志的轻量摘要（用于实时推送，避免把 body 也推给前端） */
  getLogSummary(id) {
    const row = this.#s(`SELECT ${SUMMARY_COLUMNS} FROM logs WHERE id = ?`).get(bind(id));
    return row ? mapLogSummary(row) : null;
  }

  getLog(id) {
    const row = this.#s('SELECT * FROM logs WHERE id = ?').get(bind(id));
    return row ? mapLogDetail(row) : null;
  }

  getLogByRequestId(requestId) {
    const row = this.#s('SELECT * FROM logs WHERE request_id = ?').get(bind(requestId));
    return row ? mapLogDetail(row) : null;
  }

  getLogEvents(logId, { limit = 5000, offset = 0 } = {}) {
    return this.#s('SELECT seq, offset_ms, event, data FROM log_events WHERE log_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
      .all(...bindAll([logId, clampInt(limit, { min: 1, max: 20_000, fallback: 5000 }), clampInt(offset, { min: 0, fallback: 0 })]))
      .map((r) => ({ seq: r.seq, offset_ms: r.offset_ms, event: r.event, data: r.data }));
  }

  listLogsFull(filters = {}, onRow) {
    const { clause, params } = this.buildLogFilters(filters);
    const stmt = this.#s(`SELECT * FROM logs ${clause} ORDER BY id ASC`);
    for (const row of stmt.all(...bindAll(params))) onRow(mapLogDetail(row));
  }

  deleteLog(id) {
    const result = this.#s('DELETE FROM logs WHERE id = ?').run(bind(id));
    return result.changes > 0;
  }

  /** 按筛选条件批量删除；不传筛选条件时清空全部 */
  deleteLogs(filters = {}) {
    const { clause, params } = this.buildLogFilters(filters);
    const result = this.#s(`DELETE FROM logs ${clause}`).run(...bindAll(params));
    return Number(result.changes);
  }

  purgeOlderThan(days) {
    if (!days || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.#s('DELETE FROM logs WHERE started_at < ?').run(bind(cutoff));
    return Number(result.changes);
  }

  vacuum() {
    this.db.exec('VACUUM;');
  }

  /** 概览统计：总量、成功率、时延、token、分布与近 7 日趋势 */
  stats({ days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const totals = this.#s(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(ok), 0) AS success,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END), 0) AS streamed,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              CAST(COALESCE(AVG(CASE WHEN ok = 1 THEN duration_ms END), 0) AS INTEGER) AS avg_duration_ms,
              CAST(COALESCE(AVG(CASE WHEN ok = 1 THEN first_token_ms END), 0) AS INTEGER) AS avg_first_token_ms
       FROM logs`,
    ).get();

    const today = this.#s(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(ok), 0) AS success,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM logs WHERE started_at >= ?`,
    ).get(bind(todayStart.toISOString()));

    const p95 = this.#s(
      `SELECT CAST(duration_ms AS INTEGER) AS ms FROM logs
       WHERE ok = 1 AND duration_ms IS NOT NULL
       ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`,
    ).get(bind(Math.max(0, Math.floor((totals.requests || 0) * 0.95) - 1)));

    const byEndpoint = this.#s(
      `SELECT endpoint, COUNT(*) AS requests, COALESCE(SUM(ok), 0) AS success,
              CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_duration_ms,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM logs GROUP BY endpoint ORDER BY requests DESC`,
    ).all();

    const byUpstream = this.#s(
      `SELECT COALESCE(upstream_name, '(未匹配)') AS upstream_name, upstream_id,
              COUNT(*) AS requests, COALESCE(SUM(ok), 0) AS success,
              CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_duration_ms,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM logs GROUP BY upstream_id ORDER BY requests DESC LIMIT 20`,
    ).all();

    const byModel = this.#s(
      `SELECT COALESCE(model, '(unknown)') AS model, COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_duration_ms
       FROM logs GROUP BY model ORDER BY requests DESC LIMIT 20`,
    ).all();

    const byStatus = this.#s(
      `SELECT status_code, COUNT(*) AS requests FROM logs GROUP BY status_code ORDER BY requests DESC`,
    ).all();

    const trend = this.#s(
      `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS requests,
              COALESCE(SUM(ok), 0) AS success,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_duration_ms
       FROM logs WHERE started_at >= ? GROUP BY day ORDER BY day ASC`,
    ).all(bind(since));

    const errors = this.#s(
      `SELECT id, request_id, started_at, endpoint, status_code, upstream_name, error, response_preview
       FROM logs WHERE ok = 0 ORDER BY id DESC LIMIT 10`,
    ).all();

    return {
      totals: {
        requests: totals.requests,
        success: totals.success,
        failed: totals.failed,
        streamed: totals.streamed,
        success_rate: totals.requests ? Number((totals.success / totals.requests).toFixed(4)) : 0,
        total_tokens: totals.total_tokens,
        prompt_tokens: totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        avg_duration_ms: totals.avg_duration_ms,
        avg_first_token_ms: totals.avg_first_token_ms,
        p95_duration_ms: p95?.ms ?? null,
      },
      today: { requests: today.requests, success: today.success, total_tokens: today.total_tokens },
      by_endpoint: byEndpoint,
      by_upstream: byUpstream,
      by_model: byModel,
      by_status: byStatus,
      trend,
      recent_errors: errors,
    };
  }

  /**
   * 进程在请求进行中被杀掉（强杀 / 断电）会留下 phase='running' 的日志，
   * 它们在界面上会永远显示「进行中」。启动时统一收尾。
   */
  markStaleRunning(reason = '进程在请求进行中退出，该次请求结果未知') {
    const result = this.#s(
      `UPDATE logs
         SET phase = 'error', ok = 0,
             error = coalesce(error, ?),
             finished_at = coalesce(finished_at, ?)
       WHERE phase = 'running'`,
    ).run(...bindAll([reason, nowIso()]));
    return Number(result.changes);
  }

  /** 供筛选下拉框使用的去重值 */
  facets() {
    return {
      models: this.#s(
        `SELECT model, COUNT(*) AS n FROM logs WHERE model IS NOT NULL AND model <> '' GROUP BY model ORDER BY n DESC LIMIT 100`,
      ).all(),
      endpoints: this.#s('SELECT endpoint, COUNT(*) AS n FROM logs GROUP BY endpoint ORDER BY n DESC').all(),
      statuses: this.#s(
        `SELECT status_code, COUNT(*) AS n FROM logs WHERE status_code IS NOT NULL GROUP BY status_code ORDER BY status_code`,
      ).all(),
    };
  }

  /* ------------------------------------------------------------------ *
   * settings
   * ------------------------------------------------------------------ */

  getSetting(key, fallback = null) {
    const row = this.#s('SELECT value FROM settings WHERE key = ?').get(bind(key));
    if (!row) return fallback;
    const parsed = safeJsonParse(row.value);
    return parsed === undefined ? row.value : parsed;
  }

  setSetting(key, value) {
    this.#s(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(...bindAll([key, safeJsonStringify(value), nowIso()]));
    return value;
  }

  allSettings() {
    const out = {};
    for (const row of this.#s('SELECT key, value FROM settings').all()) {
      const parsed = safeJsonParse(row.value);
      out[row.key] = parsed === undefined ? row.value : parsed;
    }
    return out;
  }
}

/* ---------------------------------------------------------------------- */

const SORTABLE = {
  started_at: 'started_at',
  duration_ms: 'duration_ms',
  total_tokens: 'total_tokens',
  first_token_ms: 'first_token_ms',
  status_code: 'status_code',
};

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function normalizeUpstreamInput(input = {}, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  if (!name) throw new Error('上游名称不能为空');
  const baseUrl = String(input.base_url ?? existing.base_url ?? '').trim();
  if (!baseUrl) throw new Error('上游 base_url 不能为空');
  let extraHeaders = input.extra_headers ?? existing.extra_headers ?? {};
  if (typeof extraHeaders === 'string') {
    extraHeaders = extraHeaders.trim() ? (safeJsonParse(extraHeaders) ?? {}) : {};
  }
  if (typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) extraHeaders = {};
  return {
    name,
    base_url: baseUrl,
    api_key: String(input.api_key ?? existing.api_key ?? ''),
    organization: String(input.organization ?? existing.organization ?? ''),
    project: String(input.project ?? existing.project ?? ''),
    extra_headers: extraHeaders,
    models: String(input.models ?? existing.models ?? ''),
    use_client_key: bool(input.use_client_key ?? existing.use_client_key) ? 1 : 0,
    is_default: bool(input.is_default ?? existing.is_default) ? 1 : 0,
    enabled: input.enabled === undefined && existing.enabled === undefined ? 1 : bool(input.enabled ?? existing.enabled) ? 1 : 0,
    note: String(input.note ?? existing.note ?? ''),
  };
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return false;
}

function toUpstreamInput(row) {
  return {
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    organization: row.organization,
    project: row.project,
    extra_headers: row.extra_headers,
    models: row.models,
    use_client_key: row.use_client_key,
    is_default: row.is_default,
    enabled: row.enabled,
    note: row.note,
  };
}

function mapUpstream(row) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    organization: row.organization,
    project: row.project,
    extra_headers: row.extra_headers || {},
    models: row.models ? String(row.models).split(',').map((s) => s.trim()).filter(Boolean) : [],
    use_client_key: !!row.use_client_key,
    is_default: !!row.is_default,
    enabled: !!row.enabled,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapLogSummary(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    first_token_ms: row.first_token_ms,
    phase: row.phase,
    endpoint: row.endpoint,
    method: row.method,
    status_code: row.status_code,
    ok: !!row.ok,
    stream: !!row.stream,
    model: row.model,
    upstream_id: row.upstream_id,
    upstream_name: row.upstream_name,
    route_reason: row.route_reason,
    client_ip: row.client_ip,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    tool_calls_count: row.tool_calls_count,
    finish_reason: row.finish_reason,
    event_count: row.event_count,
    error: row.error,
    request_preview: row.request_preview,
    response_preview: row.response_preview,
    request_body_len: row.request_body_len,
    response_body_len: row.response_body_len,
  };
}

function mapLogDetail(row) {
  const summary = mapLogSummary(row);
  return {
    ...summary,
    query: row.query,
    requested_model: row.requested_model,
    upstream_url: row.upstream_url,
    user_agent: row.user_agent,
    api_key_masked: row.api_key_masked,
    upstream_request_id: row.upstream_request_id,
    request_bytes: row.request_bytes,
    request_headers: parseMaybeJson(row.request_headers),
    request_body: parseMaybeJson(row.request_body),
    response_headers: parseMaybeJson(row.response_headers),
    response_body: parseMaybeJson(row.response_body),
    response_text: row.response_text,
    cached_tokens: row.cached_tokens,
    reasoning_tokens: row.reasoning_tokens,
    truncated: !!row.truncated,
  };
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return null;
  const parsed = safeJsonParse(value);
  return parsed === undefined ? value : parsed;
}
