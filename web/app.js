/* ==========================================================================
   OpenAI API Logger · 控制台前端
   原生 ES 模块，无构建步骤、无外部依赖。

   组织方式：
     1. 模板与格式化工具（自带 HTML 转义的 t`` 模板）
     2. 状态与请求封装
     3. 通用交互组件（toast / 弹窗 / 抽屉）
     4. 四个视图：概览、日志、上游、设置
     5. 路由与启动
   ========================================================================== */

/* ------------------------------------------------------------ 1. 工具 */

class Html extends String {}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  if (value instanceof Html) return value.toString();
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(esc).join('');
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** 默认转义所有插值的模板字符串；嵌套 t`` 的结果不会重复转义 */
function t(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += esc(values[i]) + strings[i + 1];
  return new Html(out);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const on = (el, type, handler) => el && el.addEventListener(type, handler);

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtFullTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtPercent(v) {
  if (v === null || v === undefined) return '—';
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const ENDPOINT_LABEL = {
  'chat.completions': 'chat',
  responses: 'responses',
  completions: 'completions',
  embeddings: 'embeddings',
  models: 'models',
  other: 'other',
};

const ROUTE_LABEL = {
  'header:x-upstream': '请求头 x-upstream 指定',
  'api-key-match': '按 API Key 匹配上游',
  'model-prefix': '按模型名前缀路由',
  default: '默认上游',
  'first-enabled': '首个启用上游（无默认）',
  none: '未匹配到上游',
};

function endpointBadge(endpoint) {
  const label = ENDPOINT_LABEL[endpoint] || endpoint;
  const cls = endpoint === 'chat.completions' ? 'info' : endpoint === 'responses' ? 'purple' : 'ghost';
  return t`<span class="badge ${cls}">${label}</span>`;
}

function statusBadge(log) {
  if (log.phase === 'running') return t`<span class="badge warn">进行中</span>`;
  const cls = log.ok ? 'ok' : 'err';
  return t`<span class="badge ${cls}">${log.status_code ?? '—'}</span>`;
}

function usageOf(log) {
  return {
    prompt: log.prompt_tokens,
    completion: log.completion_tokens,
    total: log.total_tokens,
    cached: log.cached_tokens,
    reasoning: log.reasoning_tokens,
  };
}

/**
 * 轻量 JSON 语法高亮。
 * 注意：必须先在「原始文本」上做词法匹配、再对每个片段转义，
 * 反过来（先转义再匹配）会把引号变成 &quot;，字符串字面量就再也匹配不到了。
 */
const JSON_TOKEN = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"\s*:?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined || text === null) return '';
  let out = '';
  let last = 0;
  JSON_TOKEN.lastIndex = 0;
  let match = JSON_TOKEN.exec(text);
  while (match !== null) {
    out += esc(text.slice(last, match.index));
    const token = match[0];
    let cls = 'n';
    if (token.startsWith('"')) cls = token.trimEnd().endsWith(':') ? 'k' : 's';
    else if (token === 'null') cls = 'nl';
    else if (token === 'true' || token === 'false') cls = 'b';
    out += `<span class="${cls}">${esc(token)}</span>`;
    last = match.index + token.length;
    match = JSON_TOKEN.exec(text);
  }
  out += esc(text.slice(last));
  return out;
}

function jsonBlock(title, value, { open = false, id = '' } = {}) {
  const body = highlightJson(value);
  const size = typeof value === 'string' ? `${value.length} 字符` : `${JSON.stringify(value ?? null).length} 字符`;
  return t`<div class="json-block">
    <div class="json-block-head">
      <strong>${title}</strong>
      <span class="muted">${size}</span>
      <span class="spacer"></span>
      <button class="btn ghost sm" data-action="copy-json" data-target="${id}">复制</button>
    </div>
    <pre class="json" id="${id}" data-open="${open ? '1' : '0'}">${new Html(body)}</pre>
  </div>`;
}

/* ------------------------------------------------------- 2. 状态与 API */

const state = {
  route: 'dashboard',
  args: [],
  token: localStorage.getItem('oal.adminToken') || '',
  live: localStorage.getItem('oal.live') === '1',
  health: null,
  overview: null,
  overviewDays: 7,
  facets: { models: [], endpoints: [], statuses: [] },
  upstreams: [],
  logs: {
    filters: { endpoint: '', model: '', upstream_id: '', ok: '', stream: '', q: '' },
    page: 0,
    limit: Number(localStorage.getItem('oal.pageSize') || 25),
    sort: 'started_at',
    order: 'desc',
    result: { total: 0, rows: [] },
  },
  settings: null,
  liveSource: null,
  liveBuffer: [],
  needsToken: false,
};

function adminHeaders() {
  const headers = {};
  if (state.token) headers['x-admin-token'] = state.token;
  return headers;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = adminHeaders();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(json?.error?.message || `HTTP ${response.status}`);
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'err' ? 5200 : 2600);
}

function handleError(err, prefix = '') {
  if (err?.status === 401) {
    state.needsToken = true;
    renderTopbarTokenHint();
    toast('需要管理令牌，请在右上角填写', 'err');
    return;
  }
  toast(`${prefix}${err.message}`, 'err');
}

/* --------------------------------------------------- 3. 通用交互组件 */

function openModal({ title, body, footer, width }) {
  const modal = $('#modal');
  modal.style.width = width || '';
  modal.innerHTML = t`
    <div class="modal-head">
      <h2>${title}</h2>
      <span class="spacer"></span>
      <button class="btn ghost sm" data-close="1">✕</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${footer}</div>`;
  $('#modal-mask').hidden = false;
}

function closeModal() {
  $('#modal-mask').hidden = true;
  $('#modal').innerHTML = '';
}

function openDrawer(content) {
  $('#drawer').innerHTML = content;
  $('#drawer').hidden = false;
  $('#drawer-mask').hidden = false;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-mask').hidden = true;
  $('#drawer').innerHTML = '';
  if (location.hash.startsWith('#/logs/')) location.hash = '#/logs';
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    toast('复制失败，请手动选择文本', 'err');
  }
}

/* --------------------------------------------------------- 4. 视图 */

/* ---- 概览 ---- */

function renderDashboard() {
  const view = $('#view');
  view.innerHTML = t`<div class="empty"><strong>加载中…</strong></div>`;
  api(`/admin/api/overview?days=${state.overviewDays}`)
    .then((data) => {
      state.overview = data;
      const { stats } = data;
      const totals = stats.totals;
      view.innerHTML = t`
        <div class="stats">
          ${statCard('总请求数', fmtNum(totals.requests), `流式 ${fmtNum(totals.streamed)} 次`)}
          ${statCard('成功率', fmtPercent(totals.success_rate), `失败 ${fmtNum(totals.failed)} 次`)}
          ${statCard('平均耗时', fmtDur(totals.avg_duration_ms), `P95 ${fmtDur(totals.p95_duration_ms)}`)}
          ${statCard('平均首包', fmtDur(totals.avg_first_token_ms), '仅统计流式请求')}
          ${statCard('总 token', fmtTokens(totals.total_tokens), `输入 ${fmtTokens(totals.prompt_tokens)} / 输出 ${fmtTokens(totals.completion_tokens)}`)}
          ${statCard('今日请求', fmtNum(stats.today.requests), `今日 token ${fmtTokens(stats.today.total_tokens)}`)}
          ${statCard('上游', fmtNum(data.upstreams.enabled) + ' / ' + fmtNum(data.upstreams.total), `默认：${data.upstreams.default || '未设置'}`)}
          ${statCard('数据库', fmtBytes(data.storage.db_size_bytes), data.storage.db_file)}
        </div>

        <div class="card">
          <div class="card-head">
            <h2>近 ${state.overviewDays} 天请求趋势</h2>
            <span class="spacer"></span>
            <span class="badge info">成功</span>
            <span class="badge err">失败</span>
          </div>
          <div class="card-body">${new Html(trendBlock(stats.trend))}</div>
        </div>

        <div class="grid cols-2">
          <div class="card">
            <div class="card-head"><h2>按端点</h2></div>
            <div class="card-body">${new Html(distBlock(stats.by_endpoint, (r) => r.endpoint, (r) => `${fmtNum(r.requests)} 次 · ${fmtDur(r.avg_duration_ms)}`))}</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>按上游</h2></div>
            <div class="card-body">${new Html(distBlock(stats.by_upstream, (r) => r.upstream_name, (r) => `${fmtNum(r.requests)} 次 · ${fmtTokens(r.total_tokens)} tok`))}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>按模型（Top 20）</h2>
          </div>
          <div class="card-body">${new Html(distBlock(stats.by_model, (r) => r.model, (r) => `${fmtNum(r.requests)} 次 · ${fmtTokens(r.total_tokens)} tok · ${fmtDur(r.avg_duration_ms)}`))}</div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>最近错误</h2>
            <span class="spacer"></span>
            <button class="btn sm" data-action="goto-logs" data-ok="false">查看全部失败请求</button>
          </div>
          <div class="card-body flush">
            ${
              stats.recent_errors.length
                ? t`<div class="table-wrap"><table class="data">
                    <thead><tr><th>时间</th><th>端点</th><th>状态</th><th>上游</th><th>错误</th><th></th></tr></thead>
                    <tbody>
                      ${stats.recent_errors.map(
                        (e) => t`<tr data-action="open-log" data-id="${e.id}">
                          <td class="nowrap mono">${fmtTime(e.started_at)}</td>
                          <td>${endpointBadge(e.endpoint)}</td>
                          <td><span class="badge err">${e.status_code ?? '—'}</span></td>
                          <td class="mono">${e.upstream_name || '—'}</td>
                          <td class="preview">${e.error || e.response_preview || '—'}</td>
                          <td class="num">#${e.id}</td>
                        </tr>`,
                      )}
                    </tbody>
                  </table></div>`
                : t`<div class="empty">暂无失败请求 🎉</div>`
            }
          </div>
        </div>`;
    })
    .catch((err) => {
      view.innerHTML = t`<div class="empty"><strong>加载失败</strong>${err.message}</div>`;
      handleError(err);
    });
}

function statCard(label, value, hint) {
  return t`<div class="stat">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    <div class="hint">${hint || ''}</div>
  </div>`;
}

function trendBlock(trend) {
  if (!trend.length) return t`<div class="empty">还没有请求记录。把客户端的 base_url 指向本代理后即可看到数据。</div>`;
  const max = Math.max(...trend.map((d) => d.requests), 1);
  return t`<div class="trend">
    ${trend.map((d) => {
      const success = d.success;
      const failed = d.requests - d.success;
      const okH = Math.round((success / max) * 100);
      const errH = Math.round((failed / max) * 100);
      return t`<div class="trend-col" title="${d.day}：${d.requests} 次（失败 ${failed}），${d.total_tokens} tokens，平均 ${d.avg_duration_ms}ms">
        <div class="trend-val">${d.requests}</div>
        <div class="trend-bars">
          ${failed ? t`<div class="bar-seg err" style="height:${errH}%"></div>` : ''}
          ${success ? t`<div class="bar-seg ok" style="height:${okH}%"></div>` : ''}
        </div>
        <div class="trend-label">${d.day.slice(5)}</div>
      </div>`;
    })}
  </div>`;
}

function distBlock(rows, nameOf, valueOf) {
  if (!rows.length) return t`<div class="empty">暂无数据</div>`;
  const max = Math.max(...rows.map((r) => r.requests), 1);
  return t`<div class="bars">
    ${rows.map(
      (r) => t`<div class="bar-row">
        <span class="name" title="${nameOf(r)}">${nameOf(r) || '(空)'}</span>
        <span class="bar-track"><span class="bar-fill ${r.requests === max ? '' : 'alt'}" style="width:${Math.max(3, Math.round((r.requests / max) * 100))}%"></span></span>
        <span class="val">${valueOf(r)}</span>
      </div>`,
    )}
  </div>`;
}

/* ---- 日志 ---- */

function logQuery() {
  const f = state.logs.filters;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(f)) if (value !== '' && value !== undefined && value !== null) params.set(key, value);
  params.set('limit', String(state.logs.limit));
  params.set('offset', String(state.logs.page * state.logs.limit));
  params.set('sort', state.logs.sort);
  params.set('order', state.logs.order);
  return params.toString();
}

function renderLogs() {
  const view = $('#view');
  const f = state.logs.filters;
  view.innerHTML = t`
    <div class="card">
      <div class="filterbar">
        <div class="f"><span>端点</span>
          <select data-filter="endpoint">
            <option value="">全部</option>
            ${['chat.completions', 'responses', 'models', 'embeddings', 'completions', 'other'].map(
              (v) => t`<option value="${v}" ${f.endpoint === v ? 'selected' : ''}>${ENDPOINT_LABEL[v] || v}</option>`,
            )}
          </select>
        </div>
        <div class="f"><span>模型</span>
          <select data-filter="model">
            <option value="">全部</option>
            ${state.facets.models.map((m) => t`<option value="${m.model}" ${f.model === m.model ? 'selected' : ''}>${m.model} (${m.n})</option>`)}
          </select>
        </div>
        <div class="f"><span>上游</span>
          <select data-filter="upstream_id">
            <option value="">全部</option>
            ${state.upstreams.map((u) => t`<option value="${u.id}" ${String(f.upstream_id) === String(u.id) ? 'selected' : ''}>${u.name}</option>`)}
          </select>
        </div>
        <div class="f"><span>结果</span>
          <select data-filter="ok">
            <option value="">全部</option>
            <option value="true" ${f.ok === 'true' ? 'selected' : ''}>成功</option>
            <option value="false" ${f.ok === 'false' ? 'selected' : ''}>失败</option>
          </select>
        </div>
        <div class="f"><span>模式</span>
          <select data-filter="stream">
            <option value="">全部</option>
            <option value="true" ${f.stream === 'true' ? 'selected' : ''}>流式</option>
            <option value="false" ${f.stream === 'false' ? 'selected' : ''}>非流式</option>
          </select>
        </div>
        <div class="f"><input type="search" data-filter="q" placeholder="搜索请求 / 响应正文…" value="${f.q}" /></div>
        <button class="btn sm" data-action="reset-filters">重置</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm ${state.live ? 'on' : ''}" data-action="toggle-live">
          ${state.live ? '● 实时中' : '○ 实时'}
        </button>
        <button class="btn sm" data-action="export" data-format="jsonl">导出 JSONL</button>
        <button class="btn sm" data-action="export" data-format="csv">导出 CSV</button>
        <button class="btn sm danger" data-action="clear-logs">清空</button>
      </div>
      <div class="card-body flush" id="logs-table">
        <div class="empty">加载中…</div>
      </div>
      <div class="pager" id="logs-pager"></div>
    </div>`;
  loadLogs({ resetScroll: true });
}

async function loadLogs({ resetScroll = false } = {}) {
  try {
    const data = await api(`/admin/api/logs?${logQuery()}`);
    state.logs.result = data;
    renderLogsTable();
    if (resetScroll) $('#view').scrollTop = 0;
  } catch (err) {
    $('#logs-table').innerHTML = t`<div class="empty"><strong>加载失败</strong>${err.message}</div>`;
    handleError(err);
  }
}

function renderLogsTable({ newIds = [] } = {}) {
  const { rows, total } = state.logs.result;
  const container = $('#logs-table');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = t`<div class="empty"><strong>没有符合条件的日志</strong>调整筛选条件，或先把客户端接入代理。</div>`;
  } else {
    container.innerHTML = t`<div class="table-wrap"><table class="data">
      <thead>
        <tr>
          <th class="nowrap">时间</th>
          <th>端点</th>
          <th>模型</th>
          <th>上游</th>
          <th>状态</th>
          <th class="nowrap">耗时</th>
          <th class="nowrap">首包</th>
          <th class="nowrap">Tokens</th>
          <th>请求 / 响应</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const u = usageOf(r);
          return t`<tr data-action="open-log" data-id="${r.id}" class="${newIds.includes(r.id) ? 'new-row' : ''}">
            <td class="nowrap mono">${fmtTime(r.started_at)}</td>
            <td>${endpointBadge(r.endpoint)}${r.stream ? t`<span class="badge ghost">流</span>` : ''}</td>
            <td class="mono">${r.model || '—'}${r.route_reason === 'model-prefix' ? t`<span class="badge ghost" title="原始请求：${r.requested_model}">前缀</span>` : ''}</td>
            <td class="mono">${r.upstream_name || '—'}</td>
            <td>${statusBadge(r)}</td>
            <td class="num">${fmtDur(r.duration_ms)}</td>
            <td class="num">${r.stream ? fmtDur(r.first_token_ms) : '—'}</td>
            <td class="num" title="输入 ${u.prompt ?? '—'} / 输出 ${u.completion ?? '—'}">${fmtTokens(u.total)}</td>
            <td class="preview" title="${r.request_preview || ''}">${r.error ? `⚠ ${r.error}` : r.response_preview || r.request_preview || '—'}</td>
            <td class="num">
              <button class="btn ghost sm" data-action="delete-log" data-id="${r.id}" title="删除这条日志">✕</button>
            </td>
          </tr>`;
        })}
      </tbody>
    </table></div>`;
  }

  const pages = Math.max(1, Math.ceil(total / state.logs.limit));
  const page = state.logs.page;
  const pager = $('#logs-pager');
  if (pager) {
    pager.innerHTML = t`
      <span>共 <strong>${fmtNum(total)}</strong> 条 · 第 ${page + 1} / ${pages} 页</span>
      <span class="spacer"></span>
      <label class="f" style="display:flex;gap:6px;align-items:center">
        <span>每页</span>
        <select data-action="page-size">
          ${[10, 25, 50, 100, 200].map((n) => t`<option value="${n}" ${state.logs.limit === n ? 'selected' : ''}>${n}</option>`)}
        </select>
      </label>
      <button class="btn sm" data-action="page" data-page="0" ${page === 0 ? 'disabled' : ''}>« 首页</button>
      <button class="btn sm" data-action="page" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>‹ 上一页</button>
      <button class="btn sm" data-action="page" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>下一页 ›</button>
    `;
  }
}

async function openLogDrawer(id) {
  try {
    const log = await api(`/admin/api/logs/${id}`);
    const events =
      log.event_count > 0 ? (await api(`/admin/api/logs/${id}/events?limit=5000`)).items : [];
    renderLogDrawer(log, events);
    if (location.hash !== `#/logs/${id}`) location.hash = `#/logs/${id}`;
  } catch (err) {
    handleError(err, '读取日志失败：');
  }
}

function renderLogDrawer(log, events) {
  const u = usageOf(log);
  const tabs = [
    ['overview', '概要', ''],
    ['request', '请求', log.request_body_len ? String(log.request_body_len) : ''],
    ['response', '响应', log.response_body_len ? String(log.response_body_len) : ''],
    ['events', '流式事件', String(events.length)],
    ['raw', '原始记录', ''],
  ];
  const active = state.drawerTab && tabs.some(([k]) => k === state.drawerTab) ? state.drawerTab : 'overview';

  openDrawer(t`
    <div class="drawer-head">
      <h2>#${log.id}</h2>
      ${endpointBadge(log.endpoint)}
      ${statusBadge(log)}
      ${log.stream ? t`<span class="badge ghost">流式</span>` : ''}
      ${log.truncated ? t`<span class="badge warn" title="超过 logging.maxBodyChars，落库内容已截断">已截断</span>` : ''}
      <span class="spacer"></span>
      <button class="btn sm" data-action="copy-text" data-text="${log.request_id}">复制请求 ID</button>
      <button class="btn sm danger" data-action="delete-log" data-id="${log.id}">删除</button>
      <button class="btn ghost sm" data-action="close-drawer">✕</button>
    </div>
    <div class="tabs">
      ${tabs.map(([key, label, count]) => t`<button data-drawer-tab="${key}" class="${active === key ? 'active' : ''}">${label}${count ? t` <span class="cnt">${count}</span>` : ''}</button>`)}
    </div>
    <div class="drawer-body" id="drawer-body">${new Html(drawerTabBody(active, log, events))}</div>`);
}

function drawerTabBody(tab, log, events) {
  if (tab === 'overview') return overviewTab(log, events);
  if (tab === 'request') return requestTab(log);
  if (tab === 'response') return responseTab(log);
  if (tab === 'events') return eventsTab(events);
  return rawTab(log);
}

function overviewTab(log, events) {
  const u = usageOf(log);
  const rows = [
    ['请求 ID', log.request_id],
    ['上游请求 ID', log.upstream_request_id || '—'],
    ['开始时间', fmtFullTime(log.started_at)],
    ['结束时间', fmtFullTime(log.finished_at)],
    ['总耗时', fmtDur(log.duration_ms)],
    ['首包时延', log.stream ? fmtDur(log.first_token_ms) : '非流式'],
    ['端点 / 方法', `${log.method} ${log.path}${log.query || ''}`],
    ['模型', `${log.model || '—'}${log.requested_model && log.requested_model !== log.model ? `（请求：${log.requested_model}）` : ''}`],
    ['上游', `${log.upstream_name || '—'} · ${log.upstream_url || ''}`],
    ['路由原因', ROUTE_LABEL[log.route_reason] || log.route_reason || '—'],
    ['客户端', `${log.client_ip || '—'} · ${log.user_agent || ''}`],
    ['入站密钥', log.api_key_masked || '未提供'],
    ['状态', `${log.status_code ?? '—'} · ${log.ok ? '成功' : '失败'} · ${log.phase}`],
    ['输入 / 输出 token', `${fmtNum(u.prompt)} / ${fmtNum(u.completion)}（缓存命中 ${fmtNum(u.cached)}，推理 ${fmtNum(u.reasoning)}）`],
    ['Token 合计', fmtNum(u.total)],
    ['工具调用', log.tool_calls_count ? `${log.tool_calls_count} 个` : '无'],
    ['结束原因', log.finish_reason || '—'],
    ['流式事件数', String(log.event_count || 0)],
    ['请求体大小', log.request_bytes !== null ? fmtBytes(log.request_bytes) : '—'],
  ];
  return t`
    ${log.error ? t`<div class="banner warn"><strong>错误：</strong>${log.error}</div>` : ''}
    <dl class="kv">${rows.map(([k, v]) => t`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function requestTab(log) {
  const body = log.request_body;
  const parsed = typeof body === 'object' && body !== null ? body : null;
  let rendered = '';
  if (parsed && log.endpoint === 'chat.completions' && Array.isArray(parsed.messages)) {
    rendered = t`<div class="msg-list">
      ${parsed.messages.map(
        (msg) => t`<div class="msg">
          <div class="msg-role">${msg.role}${msg.name ? ` · ${msg.name}` : ''}</div>
          <div class="msg-body">${contentText(msg.content) || '(空)'}${Array.isArray(msg.tool_calls) ? t`\n[tool_calls] ${JSON.stringify(msg.tool_calls, null, 2)}` : ''}</div>
        </div>`,
      )}
    </div>`;
  } else if (parsed && log.endpoint === 'responses') {
    const items = typeof parsed.input === 'string' ? [{ role: 'user', content: parsed.input }] : Array.isArray(parsed.input) ? parsed.input : [];
    rendered = t`<div class="msg-list">
      ${parsed.instructions ? t`<div class="msg"><div class="msg-role">instructions</div><div class="msg-body">${parsed.instructions}</div></div>` : ''}
      ${items.map(
        (item) => t`<div class="msg">
          <div class="msg-role">${item.role || item.type || 'item'}</div>
          <div class="msg-body">${contentText(item.content) || item.text || JSON.stringify(item, null, 2)}</div>
        </div>`,
      )}
    </div>`;
  }

  return t`
    ${rendered ? t`<div style="margin-bottom:14px">${new Html(rendered)}</div>` : ''}
    <div style="margin-bottom:14px">
      ${jsonBlock('请求体', typeof body === 'string' ? body : body ?? null, { id: 'json-request' })}
    </div>
    <div class="card">
      <div class="card-head"><h2>请求头（已脱敏）</h2></div>
      <div class="card-body"><dl class="kv">
        ${Object.entries(log.request_headers || {}).map(([k, v]) => t`<dt>${k}</dt><dd>${v}</dd>`)}
      </dl></div>
    </div>`;
}

function responseTab(log) {
  const toolCalls = log.response_body?.choices?.[0]?.message?.tool_calls || log.response_body?.output?.filter((o) => o.type === 'function_call') || [];
  const reasoning = log.response_body?.choices?.[0]?.message?.reasoning_content;
  return t`
    ${
      log.response_text
        ? t`<div class="msg" style="margin-bottom:14px">
            <div class="msg-role">助手输出</div>
            <div class="msg-body">${log.response_text}</div>
          </div>`
        : t`<div class="empty">没有抽取到文本输出${log.error ? `（${log.error}）` : ''}</div>`
    }
    ${reasoning ? t`<div class="msg" style="margin-bottom:14px"><div class="msg-role">推理内容</div><div class="msg-body">${reasoning}</div></div>` : ''}
    ${toolCalls.length ? t`<div class="msg" style="margin-bottom:14px"><div class="msg-role">工具调用</div><div class="msg-body">${JSON.stringify(toolCalls, null, 2)}</div></div>` : ''}
    <div style="margin-bottom:14px">
      ${jsonBlock(
        log.stream ? '响应体（由流式分片重组）' : '响应体',
        log.response_body,
        { id: 'json-response' },
      )}
    </div>
    <div class="card">
      <div class="card-head"><h2>上游响应头</h2></div>
      <div class="card-body"><dl class="kv">
        ${Object.entries(log.response_headers || {}).map(([k, v]) => t`<dt>${k}</dt><dd>${v}</dd>`)}
      </dl></div>
    </div>`;
}

function eventsTab(events) {
  if (!events.length) {
    return t`<div class="empty"><strong>没有流式事件</strong>本次请求不是流式，或捕获事件已被关闭（logging.captureStreamEvents）。</div>`;
  }
  return t`<div class="events">
    ${events.map((event) => {
      const preview = eventPreview(event);
      return t`<div class="event">
        <div class="event-head" data-action="toggle-event">
          <span class="event-seq">#${event.seq}</span>
          <span class="event-off">+${event.offset_ms ?? 0}ms</span>
          <span class="event-name">${event.event || 'data'}</span>
          <span class="event-preview">${preview}</span>
        </div>
        <div class="event-body" hidden>${new Html(highlightJson(prettyEventData(event.data)))}</div>
      </div>`;
    })}
  </div>`;
}

function prettyEventData(data) {
  try {
    return JSON.stringify(JSON.parse(data), null, 2);
  } catch {
    return data;
  }
}

function eventPreview(event) {
  try {
    const json = JSON.parse(event.data);
    const delta = json.delta ?? json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.delta?.reasoning_content;
    if (typeof delta === 'string' && delta) return delta;
    if (json.type) return json.type;
    return '';
  } catch {
    return event.data.slice(0, 120);
  }
}

function rawTab(log) {
  return t`
    <div class="banner info">
      这是该条日志在 SQLite 中的完整记录（JSON 字段已反序列化）。
      <span class="spacer"></span>
      <button class="btn sm" data-action="download-log" data-id="${log.id}">下载 JSON</button>
    </div>
    ${jsonBlock('完整日志记录', log, { id: 'json-raw' })}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.text) return part.text;
      if (part?.type === 'image_url' || part?.type === 'input_image') return '[图片]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/* ---- 上游 ---- */

function renderUpstreams() {
  const view = $('#view');
  view.innerHTML = t`<div class="empty">加载中…</div>`;
  api('/admin/api/upstreams')
    .then((data) => {
      state.upstreams = data.items;
      view.innerHTML = t`
        ${
          data.items.length === 0
            ? t`<div class="banner info">
                还没有配置上游。点右上角「新建上游」添加一个 OpenAI 兼容端点；
                也可以先 <code class="code-inline">npm run mock</code> 启动内置 mock 上游，
                把 base_url 填成 <code class="code-inline">http://127.0.0.1:9911/v1</code> 体验完整链路。
              </div>`
            : ''
        }
        <div class="up-list">
          ${data.items.map(
            (u) => t`<div class="up-card ${u.enabled ? '' : 'disabled'}">
              <div class="up-head">
                <h3>${u.name}</h3>
                ${u.is_default ? t`<span class="badge info">默认</span>` : ''}
                ${u.enabled ? t`<span class="badge ok">启用</span>` : t`<span class="badge ghost">已停用</span>`}
                ${u.use_client_key ? t`<span class="badge purple" title="转发时使用客户端自带的 API Key">透传客户端密钥</span>` : ''}
                <span class="spacer"></span>
                <span class="muted mono">#${u.id}</span>
              </div>
              <div class="up-url">${u.base_url}</div>
              <div class="up-meta">
                <span>密钥：${u.has_api_key ? u.api_key_masked : '未设置'}</span>
                ${u.organization ? t`<span>org：${u.organization}</span>` : ''}
                <span>更新时间：${fmtTime(u.updated_at)}</span>
              </div>
              ${u.models.length ? t`<div class="tag-row" style="margin-top:8px">${u.models.map((m) => t`<span class="badge ghost">${m}</span>`)}</div>` : ''}
              ${u.note ? t`<div class="note">${u.note}</div>` : ''}
              <div class="up-actions">
                <button class="btn sm" data-action="test-upstream" data-id="${u.id}">测试连通性</button>
                <button class="btn sm" data-action="edit-upstream" data-id="${u.id}">编辑</button>
                <button class="btn sm" data-action="reveal-upstream" data-id="${u.id}">查看密钥</button>
                ${u.is_default ? '' : t`<button class="btn sm" data-action="default-upstream" data-id="${u.id}">设为默认</button>`}
                <button class="btn sm" data-action="toggle-upstream" data-id="${u.id}" data-enabled="${u.enabled ? '0' : '1'}">${u.enabled ? '停用' : '启用'}</button>
                <button class="btn sm danger" data-action="delete-upstream" data-id="${u.id}">删除</button>
              </div>
            </div>`,
          )}
        </div>`;
    })
    .catch((err) => {
      view.innerHTML = t`<div class="empty"><strong>加载失败</strong>${err.message}</div>`;
      handleError(err);
    });
}

function upstreamForm(upstream = {}) {
  const u = upstream;
  return t`
    <div class="form-grid">
      <label class="field full"><span>名称 <span class="tip">必填，需唯一；也用于「模型名前缀路由」</span></span>
        <input type="text" name="name" value="${u.name || ''}" placeholder="openai" />
      </label>
      <label class="field full"><span>Base URL <span class="tip">必填，通常以 /v1 结尾</span></span>
        <input type="text" name="base_url" value="${u.base_url || ''}" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field full"><span>API Key <span class="tip">${u.id ? `留空表示不修改（当前：${u.api_key_masked || '未设置'}）` : '上游密钥'}</span></span>
        <input type="password" name="api_key" value="" placeholder="${u.id ? '留空保持不变' : 'sk-…'}" autocomplete="off" />
      </label>
      <label class="field"><span>OpenAI-Organization <span class="tip">可选</span></span>
        <input type="text" name="organization" value="${u.organization || ''}" />
      </label>
      <label class="field"><span>OpenAI-Project <span class="tip">可选</span></span>
        <input type="text" name="project" value="${u.project || ''}" />
      </label>
      <label class="field full"><span>模型白名单 <span class="tip">逗号分隔，仅作备注与展示</span></span>
        <input type="text" name="models" value="${(u.models || []).join(', ')}" placeholder="gpt-4o, gpt-4o-mini" />
      </label>
      <label class="field full"><span>额外请求头 <span class="tip">JSON 对象，会覆盖同名头</span></span>
        <textarea name="extra_headers" placeholder='{"x-custom-header": "value"}'>${u.extra_headers && Object.keys(u.extra_headers).length ? JSON.stringify(u.extra_headers, null, 2) : ''}</textarea>
      </label>
      <label class="field full"><span>备注</span>
        <input type="text" name="note" value="${u.note || ''}" />
      </label>
      <div class="full">
        <label class="check"><input type="checkbox" name="enabled" ${u.enabled === false ? '' : 'checked'} /><span>启用<span class="tip">停用后不会参与路由</span></span></label>
        <label class="check"><input type="checkbox" name="is_default" ${u.is_default ? 'checked' : ''} /><span>设为默认上游<span class="tip">未命中其它路由规则时使用</span></span></label>
        <label class="check"><input type="checkbox" name="use_client_key" ${u.use_client_key ? 'checked' : ''} /><span>透传客户端密钥<span class="tip">忽略本地上游密钥，直接用客户端请求头里的 Authorization</span></span></label>
      </div>
    </div>
    <div id="upstream-test-result"></div>`;
}

function readUpstreamForm() {
  const form = $('#modal');
  const value = (name) => $(`[name="${name}"]`, form);
  let extraHeaders = {};
  const rawHeaders = value('extra_headers').value.trim();
  if (rawHeaders) {
    try {
      extraHeaders = JSON.parse(rawHeaders);
    } catch {
      throw new Error('额外请求头不是合法 JSON');
    }
  }
  return {
    name: value('name').value.trim(),
    base_url: value('base_url').value.trim(),
    api_key: value('api_key').value,
    organization: value('organization').value.trim(),
    project: value('project').value.trim(),
    models: value('models').value.trim(),
    extra_headers: extraHeaders,
    note: value('note').value.trim(),
    enabled: value('enabled').checked,
    is_default: value('is_default').checked,
    use_client_key: value('use_client_key').checked,
  };
}

function openUpstreamModal(upstream = null) {
  const editing = !!upstream?.id;
  openModal({
    title: editing ? `编辑上游 #${upstream.id}` : '新建上游',
    width: '660px',
    body: upstreamForm(upstream || {}),
    footer: t`
      <button class="btn" data-action="test-upstream-form">测试连通性</button>
      <span class="spacer"></span>
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn primary" data-action="save-upstream" data-id="${upstream?.id || ''}">${editing ? '保存' : '创建'}</button>`,
  });
}

/* ---- 设置 ---- */

function renderSettings() {
  const view = $('#view');
  view.innerHTML = t`<div class="empty">加载中…</div>`;
  api('/admin/api/settings')
    .then((data) => {
      state.settings = data;
      const c = data.config;
      view.innerHTML = t`
        <div class="card">
          <div class="card-head"><h2>服务与鉴权</h2></div>
          <div class="card-body">
            <div class="banner info">
              修改监听地址或端口需要重启进程才会生效。两个令牌留空表示保持不变；填入内容即覆盖；清空请点击对应按钮。
            </div>
            <div class="form-grid">
              <label class="field"><span>监听地址 <span class="tip">需重启</span></span><input type="text" id="set-host" value="${c.server.host}" /></label>
              <label class="field"><span>端口 <span class="tip">需重启</span></span><input type="number" id="set-port" value="${c.server.port}" /></label>
              <label class="field full">
                <span>管理令牌 <span class="tip">${c.server.admin_token_set ? `已设置（${c.server.admin_token_masked}）` : '未设置：任何能访问本机端口的人都能看到日志'}</span></span>
                <input type="password" id="set-admin-token" placeholder="留空保持不变" autocomplete="off" />
              </label>
              <label class="field full">
                <span>代理令牌 <span class="tip">${c.server.proxy_token_set ? `已设置（${c.server.proxy_token_masked}）` : '未设置：客户端可使用任意 key'}</span></span>
                <input type="password" id="set-proxy-token" placeholder="留空保持不变" autocomplete="off" />
              </label>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn primary" data-action="save-server">保存</button>
              ${c.server.admin_token_set ? t`<button class="btn danger" data-action="clear-token" data-key="adminToken">清除管理令牌</button>` : ''}
              ${c.server.proxy_token_set ? t`<button class="btn danger" data-action="clear-token" data-key="proxyToken">清除代理令牌</button>` : ''}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>代理行为</h2></div>
          <div class="card-body">
            <div class="form-grid">
              <label class="field"><span>上游超时（毫秒）</span><input type="number" id="set-timeout" value="${c.proxy.timeoutMs}" /></label>
              <label class="field"><span>透传给上游的请求头 <span class="tip">逗号分隔（小写）</span></span><input type="text" id="set-forward-headers" value="${(c.proxy.forwardHeaders || []).join(', ')}" /></label>
            </div>
            <label class="check"><input type="checkbox" id="set-match-key" ${c.proxy.matchByApiKey ? 'checked' : ''} /><span>按 API Key 路由<span class="tip">入站 key 与某上游配置的 key 相同时，优先路由到该上游</span></span></label>
            <label class="check"><input type="checkbox" id="set-model-prefix" ${c.proxy.allowModelPrefix ? 'checked' : ''} /><span>允许模型名前缀路由<span class="tip">如 model 写成 <code class="code-inline">openai/gpt-4o</code> 时，转发前会剥掉 <code class="code-inline">openai/</code></span></span></label>
            <label class="check"><input type="checkbox" id="set-include-usage" ${c.proxy.includeUsageInStream ? 'checked' : ''} /><span>流式 chat 请求自动注入 include_usage<span class="tip">否则上游不会在流式响应里回报 token 用量</span></span></label>
            <label class="check"><input type="checkbox" id="set-cors" ${c.proxy.cors ? 'checked' : ''} /><span>为 /v1 开启 CORS<span class="tip">开启后任意网页都可能调用本代理消耗额度，仅在需要浏览器直连时打开</span></span></label>
            <button class="btn primary" data-action="save-proxy">保存</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>日志记录</h2></div>
          <div class="card-body">
            <label class="check"><input type="checkbox" id="set-log-bodies" ${c.logging.logBodies ? 'checked' : ''} /><span>记录请求体与响应体<span class="tip">关闭后只记录元数据、用量与预览</span></span></label>
            <label class="check"><input type="checkbox" id="set-capture-events" ${c.logging.captureStreamEvents ? 'checked' : ''} /><span>记录流式事件明细<span class="tip">逐条保存 SSE 事件，可还原完整时间线</span></span></label>
            <div class="form-grid">
              <label class="field"><span>单条 body 字符上限</span><input type="number" id="set-max-body" value="${c.logging.maxBodyChars}" /></label>
              <label class="field"><span>流式事件条数上限</span><input type="number" id="set-max-events" value="${c.logging.maxEvents}" /></label>
              <label class="field"><span>日志保留天数 <span class="tip">0 表示永久保留</span></span><input type="number" id="set-retention" value="${c.logging.retentionDays}" /></label>
              <label class="field"><span>脱敏请求头 <span class="tip">逗号分隔</span></span><input type="text" id="set-redact" value="${(c.logging.redactHeaders || []).join(', ')}" /></label>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn primary" data-action="save-logging">保存</button>
              <button class="btn" data-action="purge">立即清理过期日志</button>
              <button class="btn" data-action="vacuum">整理数据库</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>客户端接入</h2></div>
          <div class="card-body">
            <pre class="snippet"><span class="c"># 环境变量方式（openai-python / openai-node 均读取这两个变量）</span>
OPENAI_BASE_URL=<span class="g">${location.origin}/v1</span>
OPENAI_API_KEY=<span class="y">${c.server.proxy_token_set ? '你设置的代理令牌' : '任意非空字符串（本代理未开启鉴权）'}</span>

<span class="c"># 指定上游：请求头</span>
X-Upstream: <span class="y">上游名称或 ID</span>

<span class="c"># 指定上游：模型名前缀（需开启「模型名前缀路由」）</span>
model: <span class="y">上游名称/gpt-4o</span>

<span class="c"># 流式请求若不希望被注入 include_usage</span>
X-Logger-Include-Usage: <span class="y">false</span></pre>
            <div class="up-meta" style="margin-top:12px">
              <span>数据目录：<code class="code-inline">${data.paths.data_dir}</code></span>
              <span>数据库：<code class="code-inline">${data.paths.db_file}</code></span>
              <span>配置：<code class="code-inline">${data.paths.config_file}</code></span>
            </div>
          </div>
        </div>`;
    })
    .catch((err) => {
      view.innerHTML = t`<div class="empty"><strong>加载失败</strong>${err.message}</div>`;
      handleError(err);
    });
}

function numberValue(id) {
  const el = $(id);
  return el ? Number(el.value) : undefined;
}

function listValue(id) {
  const el = $(id);
  if (!el) return undefined;
  return el.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* --------------------------------------------------------- 5. 路由 */

const NAV = [
  ['dashboard', '概览', 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4Zm10-11h6V4h-6v5Z'],
  ['logs', '日志', 'M4 6h16M4 12h16M4 18h10'],
  ['upstreams', '上游', 'M12 3v6m0 6v6M5.5 12h13M4 9.5A2.5 2.5 0 0 1 6.5 7h11A2.5 2.5 0 0 1 20 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 14.5v-5Z'],
  ['settings', '设置', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2-1.2L14.6 3h-4l-.4 2.7a7.6 7.6 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7.6 7.6 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z'],
];

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = t`
    ${NAV.map(
      ([key, label, path]) => t`<a href="#/${key}" class="${state.route === key ? 'active' : ''}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}" /></svg>
        <span>${label}</span>
        ${key === 'logs' && state.logs.result.total ? t`<span class="nav-count">${fmtNum(state.logs.result.total)}</span>` : ''}
      </a>`,
    )}`;
}

const TITLES = {
  dashboard: ['概览', '请求量、成功率、时延与 token 消耗'],
  logs: ['日志', '每一次代理请求的完整请求与响应记录'],
  upstreams: ['上游', '配置 OpenAI 兼容的上游端点与路由'],
  settings: ['设置', '鉴权、代理行为、日志策略与客户端接入'],
};

function renderTopbar() {
  const [title, sub] = TITLES[state.route] || ['概览', ''];
  const actions = {
    dashboard: t`<select id="dash-days">${[1, 7, 30, 90].map((d) => t`<option value="${d}" ${state.overviewDays === d ? 'selected' : ''}>近 ${d} 天</option>`)}</select>
      <button class="btn sm" data-action="refresh">刷新</button>`,
    logs: t`<button class="btn sm" data-action="refresh">刷新</button>`,
    upstreams: t`<button class="btn primary sm" data-action="new-upstream">+ 新建上游</button>`,
    settings: t`<button class="btn sm" data-action="refresh">刷新</button>`,
  }[state.route];
  $('#topbar').innerHTML = t`
    <h1>${title}</h1>
    <span class="sub">${sub}</span>
    <span class="spacer"></span>
    ${actions || ''}
    <span id="token-hint"></span>`;
  renderTopbarTokenHint();
  on($('#dash-days'), 'change', (event) => {
    state.overviewDays = Number(event.target.value);
    renderDashboard();
  });
}

function renderTopbarTokenHint() {
  const holder = $('#token-hint');
  if (!holder) return;
  holder.innerHTML = state.needsToken
    ? t`<label class="f" style="display:flex;gap:6px;align-items:center">
        <span class="muted">管理令牌</span>
        <input type="password" id="token-input" placeholder="adminToken" style="width:150px" />
        <button class="btn sm primary" data-action="save-token">保存</button>
      </label>`
    : '';
  if (state.needsToken) {
    on($('#token-input'), 'keydown', (event) => {
      if (event.key === 'Enter') $('[data-action="save-token"]').click();
    });
  }
}

async function router() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...args] = hash.split('/');
  state.route = TITLES[name] ? name : 'dashboard';
  state.args = args;
  renderNav();
  renderTopbar();

  if (state.route === 'dashboard') renderDashboard();
  else if (state.route === 'logs') {
    if (!state.facets.models.length) await loadFacets();
    renderLogs();
    if (args[0]) openLogDrawer(args[0]);
  } else if (state.route === 'upstreams') renderUpstreams();
  else if (state.route === 'settings') renderSettings();
}

async function loadFacets() {
  try {
    state.facets = await api('/admin/api/facets');
  } catch (err) {
    handleError(err, '读取筛选项失败：');
  }
}

async function reloadUpstreamSelect() {
  try {
    const data = await api('/admin/api/upstreams');
    state.upstreams = data.items;
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------- 6. 实时日志 */

function setLive(enabled) {
  state.live = enabled;
  localStorage.setItem('oal.live', enabled ? '1' : '0');
  if (enabled) startLive(); else stopLive();
  const button = $('[data-action="toggle-live"]');
  if (button) {
    button.classList.toggle('on', enabled);
    button.textContent = enabled ? '● 实时中' : '○ 实时';
  }
  updateConn(enabled ? '实时日志已开启' : '已连接', enabled ? 'live' : 'ok');
}

function startLive() {
  stopLive();
  const url = `/admin/api/events${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`;
  const source = new EventSource(url);
  state.liveSource = source;
  source.addEventListener('log', (event) => {
    const summary = JSON.parse(event.data);
    handleLiveLog(summary);
  });
  source.addEventListener('upstream_changed', () => {
    if (state.route === 'upstreams') renderUpstreams();
    reloadUpstreamSelect();
  });
  source.onopen = () => updateConn('实时日志已开启', 'live');
  source.onerror = () => {
    updateConn('实时连接中断，正在重试…', 'bad');
  };
}

function stopLive() {
  if (state.liveSource) {
    state.liveSource.close();
    state.liveSource = null;
  }
}

function handleLiveLog(summary) {
  if (state.route !== 'logs') return;
  const f = state.logs.filters;
  const matches =
    (!f.endpoint || f.endpoint === summary.endpoint) &&
    (!f.model || summary.model === f.model) &&
    (!f.upstream_id || String(summary.upstream_id) === String(f.upstream_id)) &&
    (f.ok === '' || String(summary.ok) === f.ok) &&
    (f.stream === '' || String(summary.stream) === f.stream) &&
    (!f.q || `${summary.request_preview || ''}${summary.response_preview || ''}`.includes(f.q));
  if (!matches) return;
  const rows = state.logs.result.rows;
  const index = rows.findIndex((r) => r.id === summary.id);
  if (index >= 0) {
    rows[index] = { ...rows[index], ...summary };
    renderLogsTable({ newIds: [summary.id] });
    return;
  }
  if (state.logs.page !== 0) return;
  rows.unshift(summary);
  if (rows.length > state.logs.limit) rows.pop();
  state.logs.result.total += 1;
  renderLogsTable({ newIds: [summary.id] });
  renderNav();
}

function updateConn(text, kind) {
  const dot = $('#conn-dot');
  const label = $('#conn-text');
  if (dot) dot.className = `dot ${kind || ''}`;
  if (label) label.textContent = text;
}

/* --------------------------------------------------------- 7. 事件绑定 */

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = Number(target.dataset.id || 0);

  try {
    switch (action) {
      case 'refresh':
        if (state.route === 'logs') {
          await loadFacets();
          await reloadUpstreamSelect();
          await loadLogs();
        } else if (state.route === 'dashboard') renderDashboard();
        else if (state.route === 'upstreams') renderUpstreams();
        else renderSettings();
        break;

      case 'goto-logs':
        state.logs.filters.ok = target.dataset.ok || '';
        state.logs.page = 0;
        location.hash = '#/logs';
        break;

      case 'reset-filters':
        state.logs.filters = { endpoint: '', model: '', upstream_id: '', ok: '', stream: '', q: '' };
        state.logs.page = 0;
        renderLogs();
        break;

      case 'page':
        state.logs.page = Math.max(0, Number(target.dataset.page));
        loadLogs({ resetScroll: true });
        break;

      case 'toggle-live':
        setLive(!state.live);
        break;

      case 'export': {
        const params = logQuery();
        const format = target.dataset.format;
        window.open(`/admin/api/logs/export?format=${format}&${params}`, '_blank');
        break;
      }

      case 'clear-logs': {
        openModal({
          title: '清空全部日志',
          body: t`<div class="banner warn"><strong>⚠ 此操作不可恢复。</strong>所有请求/响应记录与流式事件明细都会被删除，上游配置不受影响。</div>`,
          footer: t`<span class="spacer"></span><button class="btn" data-action="close-modal">取消</button>
            <button class="btn danger" data-action="confirm-clear-logs">确认清空</button>`,
        });
        break;
      }

      case 'confirm-clear-logs': {
        const result = await api('/admin/api/logs/clear', { method: 'POST', body: {} });
        closeModal();
        toast(`已删除 ${fmtNum(result.deleted)} 条日志`, 'ok');
        state.logs.page = 0;
        loadLogs();
        break;
      }

      case 'delete-log': {
        event.stopPropagation();
        await api(`/admin/api/logs/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        if (!$('#drawer').hidden && $('#drawer').innerHTML.includes(`#${id}`)) closeDrawer();
        if (state.route === 'logs') loadLogs();
        break;
      }

      case 'open-log':
        openLogDrawer(id);
        break;

      case 'download-log': {
        const log = await api(`/admin/api/logs/${id}`);
        const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `log-${id}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        break;
      }

      case 'toggle-event': {
        const body = target.nextElementSibling;
        if (body) body.hidden = !body.hidden;
        break;
      }

      case 'copy-text':
        await copyText(target.dataset.text || '', '已复制');
        break;

      case 'copy-json': {
        const el = document.getElementById(target.dataset.target);
        await copyText(el ? el.textContent : '', '已复制 JSON');
        break;
      }

      case 'close-drawer':
        closeDrawer();
        break;

      case 'close-modal':
        closeModal();
        break;

      case 'save-token': {
        const input = $('#token-input');
        state.token = input ? input.value.trim() : '';
        localStorage.setItem('oal.adminToken', state.token);
        state.needsToken = false;
        try {
          await api('/admin/api/health');
          toast('令牌已保存', 'ok');
          state.needsToken = false;
          router();
        } catch (err) {
          state.needsToken = true;
          handleError(err, '令牌无效：');
        }
        break;
      }

      case 'new-upstream':
        openUpstreamModal(null);
        break;

      case 'edit-upstream': {
        const upstream = await api(`/admin/api/upstreams/${id}`);
        openUpstreamModal({ ...upstream, models: upstream.models || [] });
        break;
      }

      case 'save-upstream': {
        const payload = readUpstreamForm();
        const editingId = target.dataset.id;
        if (editingId) {
          if (!payload.api_key) delete payload.api_key;
          await api(`/admin/api/upstreams/${editingId}`, { method: 'PUT', body: payload });
          toast('已保存', 'ok');
        } else {
          await api('/admin/api/upstreams', { method: 'POST', body: payload });
          toast('已创建', 'ok');
        }
        closeModal();
        renderUpstreams();
        reloadUpstreamSelect();
        break;
      }

      case 'test-upstream-form': {
        const payload = readUpstreamForm();
        const holder = $('#upstream-test-result');
        holder.innerHTML = t`<div class="banner info">测试中…</div>`;
        const result = await api('/admin/api/upstreams/test', { method: 'POST', body: payload });
        holder.innerHTML = result.ok
          ? t`<div class="banner info">连通成功：HTTP ${result.status}，耗时 ${result.latency_ms}ms，返回 ${result.model_count} 个模型（${result.probe_url}）</div>`
          : t`<div class="banner warn">连通失败：${result.error || `HTTP ${result.status}`}（${result.probe_url}）</div>`;
        break;
      }

      case 'test-upstream': {
        target.disabled = true;
        target.textContent = '测试中…';
        const result = await api('/admin/api/upstreams/test', { method: 'POST', body: { id } });
        target.disabled = false;
        target.textContent = '测试连通性';
        toast(result.ok ? `连通成功（${result.latency_ms}ms，${result.model_count} 个模型）` : `连通失败：${result.error || result.status}`, result.ok ? 'ok' : 'err');
        break;
      }

      case 'reveal-upstream': {
        const result = await api(`/admin/api/upstreams/${id}/reveal`, { method: 'POST' });
        openModal({
          title: '上游密钥',
          body: t`<div class="banner warn">密钥以明文显示，请勿在共享屏幕上停留过久。</div>
            <pre class="json">${result.api_key || '(未设置)'}</pre>`,
          footer: t`<span class="spacer"></span><button class="btn" data-action="copy-text" data-text="${result.api_key}">复制</button>
            <button class="btn primary" data-action="close-modal">关闭</button>`,
        });
        break;
      }

      case 'default-upstream':
        await api(`/admin/api/upstreams/${id}`, { method: 'PUT', body: { is_default: true } });
        toast('已设为默认上游', 'ok');
        renderUpstreams();
        break;

      case 'toggle-upstream':
        await api(`/admin/api/upstreams/${id}`, { method: 'PUT', body: { enabled: target.dataset.enabled === '1' } });
        renderUpstreams();
        break;

      case 'delete-upstream': {
        const upstream = state.upstreams.find((u) => u.id === id);
        openModal({
          title: '删除上游',
          body: t`<div class="banner warn"><strong>⚠ 此操作不可恢复。</strong>将删除上游「${upstream?.name || id}」及其配置（含保存的 API Key）。历史日志不会被删除。</div>`,
          footer: t`<span class="spacer"></span><button class="btn" data-action="close-modal">取消</button>
            <button class="btn danger" data-action="confirm-delete-upstream" data-id="${id}">确认删除</button>`,
        });
        break;
      }

      case 'confirm-delete-upstream':
        await api(`/admin/api/upstreams/${id}`, { method: 'DELETE' });
        closeModal();
        toast('已删除', 'ok');
        renderUpstreams();
        reloadUpstreamSelect();
        break;

      case 'save-server': {
        const payload = {
          server: {
            host: $('#set-host').value.trim(),
            port: Number($('#set-port').value),
          },
        };
        const adminToken = $('#set-admin-token').value;
        const proxyToken = $('#set-proxy-token').value;
        if (adminToken) payload.server.adminToken = adminToken;
        if (proxyToken) payload.server.proxyToken = proxyToken;
        const result = await api('/admin/api/settings', { method: 'PUT', body: payload });
        toast(result.restart_required ? '已保存，监听地址/端口需重启生效' : '已保存', 'ok');
        renderSettings();
        break;
      }

      case 'clear-token': {
        const key = target.dataset.key;
        await api('/admin/api/settings', { method: 'PUT', body: { server: { [key]: null } } });
        toast('已清除', 'ok');
        if (key === 'adminToken') {
          state.token = '';
          localStorage.removeItem('oal.adminToken');
          state.needsToken = false;
        }
        renderSettings();
        break;
      }

      case 'save-proxy':
        await api('/admin/api/settings', {
          method: 'PUT',
          body: {
            proxy: {
              timeoutMs: numberValue('#set-timeout'),
              forwardHeaders: listValue('#set-forward-headers'),
              matchByApiKey: $('#set-match-key').checked,
              allowModelPrefix: $('#set-model-prefix').checked,
              includeUsageInStream: $('#set-include-usage').checked,
              cors: $('#set-cors').checked,
            },
          },
        });
        toast('已保存', 'ok');
        renderSettings();
        break;

      case 'save-logging':
        await api('/admin/api/settings', {
          method: 'PUT',
          body: {
            logging: {
              logBodies: $('#set-log-bodies').checked,
              captureStreamEvents: $('#set-capture-events').checked,
              maxBodyChars: numberValue('#set-max-body'),
              maxEvents: numberValue('#set-max-events'),
              retentionDays: numberValue('#set-retention'),
              redactHeaders: listValue('#set-redact'),
            },
          },
        });
        toast('已保存', 'ok');
        renderSettings();
        break;

      case 'purge': {
        const days = numberValue('#set-retention') || 0;
        const result = await api('/admin/api/maintenance/purge', { method: 'POST', body: { days } });
        toast(days > 0 ? `已清理 ${fmtNum(result.deleted)} 条 ${days} 天前的日志` : '保留天数为 0，未执行清理', 'ok');
        break;
      }

      case 'vacuum':
        await api('/admin/api/maintenance/vacuum', { method: 'POST', body: {} });
        toast('数据库已整理', 'ok');
        break;

      default:
        break;
    }
  } catch (err) {
    handleError(err);
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset && el.dataset.filter) {
    state.logs.filters[el.dataset.filter] = el.value;
    state.logs.page = 0;
    loadLogs();
  }
  if (el.dataset && el.dataset.action === 'page-size') {
    state.logs.limit = Number(el.value);
    localStorage.setItem('oal.pageSize', String(state.logs.limit));
    state.logs.page = 0;
    loadLogs();
  }
});

$('#drawer-mask').addEventListener('click', closeDrawer);
// 点击弹窗外侧关闭。只在启动时绑定一次（原先写在 openModal 里，每次打开都会
// 叠加一个监听器，开着开着就会有 N 个重复回调）。
$('#modal-mask').addEventListener('click', (event) => {
  if (event.target.id === 'modal-mask') closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#modal-mask').hidden) closeModal();
  else if (!$('#drawer').hidden) closeDrawer();
});

// 抽屉内的 Tab 切换
document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-drawer-tab]');
  if (!tab) return;
  state.drawerTab = tab.dataset.drawerTab;
  const id = Number(location.hash.split('/')[2] || 0);
  if (id) openLogDrawer(id);
});

window.addEventListener('hashchange', router);

/* --------------------------------------------------------- 8. 启动 */

async function boot() {
  try {
    const health = await api('/admin/api/health');
    state.health = health;
    updateConn('已连接', 'ok');
    $('#version-text').textContent = `v${health.version}`;
  } catch (err) {
    if (err.status === 401) {
      state.needsToken = true;
      updateConn('需要令牌', 'bad');
    } else {
      updateConn('连接失败', 'bad');
    }
  }

  await Promise.all([loadFacets(), reloadUpstreamSelect()]);
  await router();

  if (state.live) {
    setLive(true);
  }
}

boot();
