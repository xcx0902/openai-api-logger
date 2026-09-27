/**
 * 端到端冒烟测试。
 *
 * 自行拉起 mock 上游 + 代理服务，覆盖：
 *   - 两种请求格式 × 流式/非流式 × 工具调用的透传与日志落库
 *   - 四种上游路由策略与 route_reason 记录
 *   - 上游错误、连接失败、超时、未配置上游等失败路径的日志与状态码
 *   - 管理后台的日志筛选/详情/事件时间线/导出、上游 CRUD 与连通性测试
 *   - 安全项：请求头脱敏、密钥只返回掩码、admin/proxy 令牌鉴权
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_PORT = Number(process.env.SMOKE_PROXY_PORT || 8790);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 9912);
const MOCK_KEY = 'sk-mock-smoke-key-0123456789';
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oal-smoke-'));

let passed = 0;
let failed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${PROXY}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? safeParse(text) : null;
  return { status: response.status, json, text, headers: response.headers };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 发一个代理请求（/v1/*），返回原始响应 */
async function proxy(pathname, { method = 'POST', body, headers = {} } = {}) {
  const response = await fetch(`${PROXY}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, text, json: safeParse(text), headers: response.headers };
}

/** 取最近一条日志的完整详情 */
async function latestLog() {
  const list = await api('/admin/api/logs?limit=1');
  const id = list.json.rows[0]?.id;
  const detail = await api(`/admin/api/logs/${id}`);
  return detail.json;
}

/** 解析 SSE 文本里的 data 负载 */
function sseData(text) {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: '))?.slice(6))
    .filter((v) => v !== undefined);
}

function waitForPort(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`等待 ${url} 超时`);
    await new Promise((r) => setTimeout(r, 150));
    return poll();
  })();
}

const children = [];
function start(args, env) {
  const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function main() {
  console.log('启动 mock 上游与代理服务…');
  start(['src/mock-upstream.js'], { MOCK_PORT: String(MOCK_PORT), MOCK_KEY });
  start(['src/server.js'], { OAL_DATA_DIR: DATA_DIR, OAL_PORT: String(PROXY_PORT) });

  await waitForPort(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
  await waitForPort(`${PROXY}/health`);
  console.log(`mock 上游 http://127.0.0.1:${MOCK_PORT}/v1  代理 ${PROXY}  数据目录 ${DATA_DIR}`);

  /* ── 上游准备 ─────────────────────────────────────────────────────── */
  section('【上游管理】');
  let mockId = null;
  let altId = null;

  await step('创建上游并只返回密钥掩码', async () => {
    const created = await api('/admin/api/upstreams', {
      method: 'POST',
      body: { name: 'mock', base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: MOCK_KEY, is_default: true, note: '冒烟测试' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.name, 'mock');
    assert.equal(created.json.api_key, undefined, '不应返回明文密钥');
    assert.equal(created.json.has_api_key, true);
    assert.ok(created.json.api_key_masked.includes('…'), `掩码格式异常：${created.json.api_key_masked}`);
    mockId = created.json.id;
  });

  await step('创建第二个上游（用于模型前缀路由）', async () => {
    const created = await api('/admin/api/upstreams', {
      method: 'POST',
      body: { name: 'alt', base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: MOCK_KEY },
    });
    assert.equal(created.status, 201);
    altId = created.json.id;
  });

  await step('探测上游 /models 连通性', async () => {
    const result = await api('/admin/api/upstreams/test', { method: 'POST', body: { id: mockId } });
    assert.equal(result.json.ok, true, `连通性测试失败：${JSON.stringify(result.json)}`);
    assert.equal(result.json.model_count, 4);
  });

  await step('连通性测试能识别错误的密钥', async () => {
    const result = await api('/admin/api/upstreams/test', {
      method: 'POST',
      body: { base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: 'sk-wrong' },
    });
    assert.equal(result.json.ok, false);
    assert.equal(result.json.status, 401);
  });

  await step('reveal 接口可单独取回明文密钥', async () => {
    const result = await api(`/admin/api/upstreams/${mockId}/reveal`, { method: 'POST' });
    assert.equal(result.json.api_key, MOCK_KEY);
  });

  await step('GET /v1/models 透传并按 models 端点入库', async () => {
    const result = await proxy('/v1/models', { method: 'GET', body: undefined });
    assert.equal(result.status, 200);
    assert.equal(result.json.data.length, 4);
    const log = await latestLog();
    assert.equal(log.endpoint, 'models');
    assert.equal(log.status_code, 200);
  });

  /* ── chat.completions ────────────────────────────────────────────── */
  section('【chat.completions】');
  let chatLogId = null;

  await step('非流式：响应透传 + 请求/响应/用量完整落库', async () => {
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-gpt-4o', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'ping test 123' }] },
      headers: { authorization: `Bearer ${MOCK_KEY}` },
    });
    assert.equal(result.status, 200);
    assert.ok(result.json.choices[0].message.content.includes('mock 上游生成'));

    const log = await latestLog();
    chatLogId = log.id;
    assert.equal(log.endpoint, 'chat.completions');
    assert.equal(log.ok, true);
    assert.equal(log.stream, false);
    assert.equal(log.model, 'mock-gpt-4o');
    assert.equal(log.upstream_name, 'mock');
    assert.equal(log.route_reason, 'api-key-match', `路由应命中 api key 匹配，实际 ${log.route_reason}`);
    assert.equal(log.request_body.messages[1].content, 'ping test 123');
    assert.equal(log.path, '/v1/chat/completions', '详情应带上请求路径（控制台详情抽屉要显示它）');
    assert.equal(log.response_body.object, 'chat.completion');
    assert.ok(log.response_text.includes('mock 上游生成'));
    assert.equal(log.prompt_tokens, result.json.usage.prompt_tokens);
    assert.equal(log.total_tokens, result.json.usage.total_tokens);
    assert.equal(log.finish_reason, 'stop');
    assert.ok(log.duration_ms >= 0);
    assert.ok(log.request_preview.includes('user: ping test 123'), `预览异常：${log.request_preview}`);
    assert.ok(log.response_headers['content-type'].includes('application/json'));
  });

  await step('请求头落库时密钥被脱敏', async () => {
    const list = await api('/admin/api/logs?limit=1');
    const detail = await api(`/admin/api/logs/${list.json.rows[0].id}`);
    const auth = detail.json.request_headers.authorization;
    assert.ok(!auth.includes(MOCK_KEY), `Authorization 未脱敏：${auth}`);
    assert.ok(auth.includes('…'), `Authorization 应为掩码格式：${auth}`);
  });

  await step('按 request_id 反查日志（控制台对话页靠它关联详情）', async () => {
    const sent = await proxy('/v1/chat/completions', {
      body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'request-id 反查专用文案' }] },
    });
    const requestId = sent.headers.get('x-logger-request-id');
    assert.ok(requestId, '成功响应应带 x-logger-request-id');

    const found = await api(`/admin/api/logs/by-request-id/${encodeURIComponent(requestId)}`);
    assert.equal(found.status, 200);
    assert.equal(found.json.request_id, requestId);

    const detail = await api(`/admin/api/logs/${found.json.id}`);
    assert.equal(detail.json.request_id, requestId, '反查到的 id 应指向同一条日志');
    assert.ok(detail.json.request_preview.includes('request-id 反查专用文案'), '反查应命中正确的请求');

    const missing = await api('/admin/api/logs/by-request-id/does-not-exist');
    assert.equal(missing.status, 404);
  });

  await step('流式：SSE 原样透传且被完整重组', async () => {
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-reasoner', messages: [{ role: 'user', content: 'stream test' }], stream: true },
    });
    assert.equal(result.status, 200);
    assert.ok(result.text.includes('data: [DONE]'), 'SSE 未包含结束标记');
    const chunks = sseData(result.text);
    assert.ok(chunks.length >= 8, `分片数量偏少：${chunks.length}`);
    const rebuilt = chunks.filter((c) => c !== '[DONE]').map((c) => JSON.parse(c));
    const streamedText = rebuilt
      .flatMap((c) => c.choices || [])
      .map((c) => c.delta?.content || '')
      .join('');
    assert.ok(streamedText.includes('我先把思路理一遍'), `客户端收到的正文异常：${streamedText}`);

    const log = await latestLog();
    assert.equal(log.stream, true);
    assert.equal(log.ok, true);
    assert.ok(log.first_token_ms !== null && log.first_token_ms >= 0, '应记录首包时延');
    assert.ok(log.event_count > 0, '应记录 SSE 事件数');
    assert.equal(log.response_text, streamedText, '重组正文应与客户端实际收到的内容一致');
    assert.ok(log.response_body._reassembled.from_stream, '响应体应带重组标记');
    assert.ok(
      log.event_count >= log.response_body._reassembled.chunks,
      `事件数（${log.event_count}）应不小于解析到的数据 chunk 数（${log.response_body._reassembled.chunks}），多出的是 [DONE] 结束标记`,
    );
    const rawEvents = await api(`/admin/api/logs/${log.id}/events`);
    assert.equal(rawEvents.json.items.at(-1).data, '[DONE]', '时间线应保留 [DONE] 结束标记');
    assert.equal(log.finish_reason, 'stop');
    assert.ok(log.total_tokens > 0, '应通过注入 include_usage 拿到用量');
    assert.ok(log.response_body.choices[0].message.reasoning_content.includes('第一步'));
  });

  await step('流式事件时间线可查询（offset_ms 单调不减）', async () => {
    const list = await api('/admin/api/logs?endpoint=chat.completions&stream=true&limit=1');
    const id = list.json.rows[0].id;
    const events = await api(`/admin/api/logs/${id}/events`);
    assert.equal(events.json.count, list.json.rows[0].event_count);
    const offsets = events.json.items.map((e) => e.offset_ms);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'offset_ms 应单调不减');
    assert.ok(events.json.items.some((e) => e.data.includes('chat.completion.chunk')));
  });

  await step('工具调用（非流式）：tool_calls 与计数入库', async () => {
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-tool-4o', messages: [{ role: 'user', content: 'weather please' }] },
    });
    assert.equal(result.json.choices[0].message.tool_calls[0].function.name, 'get_weather');
    const log = await latestLog();
    assert.equal(log.tool_calls_count, 1);
    assert.equal(log.finish_reason, 'tool_calls');
    assert.equal(log.response_body.choices[0].message.tool_calls[0].function.arguments, '{"city":"Beijing","unit":"celsius"}');
  });

  await step('工具调用（流式）：增量参数按 index 正确合并', async () => {
    await proxy('/v1/chat/completions', {
      body: { model: 'mock-tool-4o', messages: [{ role: 'user', content: 'weather please' }], stream: true },
    });
    const log = await latestLog();
    assert.equal(log.tool_calls_count, 1);
    const call = log.response_body.choices[0].message.tool_calls[0];
    assert.equal(call.id, 'call_mock_0001');
    assert.equal(call.function.name, 'get_weather');
    assert.equal(call.function.arguments, '{"city":"Beijing","unit":"celsius"}');
  });

  /* ── responses ───────────────────────────────────────────────────── */
  section('【responses】');

  await step('非流式：input/output tokens 正确映射', async () => {
    const result = await proxy('/v1/responses', {
      body: { model: 'mock-gpt-4o', input: 'hello responses', instructions: 'be brief' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.object, 'response');
    const log = await latestLog();
    assert.equal(log.endpoint, 'responses');
    assert.equal(log.model, 'mock-gpt-4o');
    assert.equal(log.prompt_tokens, result.json.usage.input_tokens);
    assert.equal(log.completion_tokens, result.json.usage.output_tokens);
    assert.equal(log.total_tokens, result.json.usage.total_tokens);
    assert.equal(log.finish_reason, 'completed');
    assert.ok(log.response_text.includes('mock 上游生成'));
    assert.ok(log.request_preview.includes('instructions: be brief'));
  });

  await step('流式：以 response.completed 为权威结果重组', async () => {
    const result = await proxy('/v1/responses', {
      body: { model: 'mock-gpt-4o', input: 'stream responses test', stream: true },
    });
    assert.ok(result.text.includes('event: response.completed'));

    const log = await latestLog();
    assert.equal(log.stream, true);
    assert.equal(log.ok, true);
    assert.ok(log.event_count >= 10, `事件数偏少：${log.event_count}`);
    assert.ok(log.response_text.includes('mock 上游生成'), '应从 completed 事件抽取正文');
    assert.ok(log.total_tokens > 0, '应记录 usage');
    assert.equal(log.finish_reason, 'completed');

    const events = await api(`/admin/api/logs/${log.id}/events`);
    const names = events.json.items.map((e) => e.event);
    assert.ok(names.includes('response.output_text.delta'));
    assert.ok(names.includes('response.completed'));
  });

  await step('流式工具调用：function_call 参数合并', async () => {
    await proxy('/v1/responses', { body: { model: 'mock-tool-4o', input: 'weather please', stream: true } });
    const log = await latestLog();
    assert.equal(log.tool_calls_count, 1);
    assert.equal(log.response_body.output[0].arguments, '{"city":"Beijing","unit":"celsius"}');
  });

  /* ── 路由策略 ────────────────────────────────────────────────────── */
  section('【上游路由】');

  await step('模型名前缀路由：剥掉前缀并记录原因', async () => {
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'alt/mock-gpt-4o', messages: [{ role: 'user', content: 'route by prefix' }] },
    });
    assert.equal(result.status, 200);
    const log = await latestLog();
    assert.equal(log.route_reason, 'model-prefix');
    assert.equal(log.upstream_name, 'alt');
    assert.equal(log.requested_model, 'alt/mock-gpt-4o');
    assert.equal(log.model, 'mock-gpt-4o');
    assert.equal(log.request_body.model, 'mock-gpt-4o', '转发体中的 model 应已剥掉前缀');
  });

  await step('x-upstream 请求头指定上游', async () => {
    await proxy('/v1/chat/completions', {
      body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'route by header' }] },
      headers: { 'x-upstream': 'alt' },
    });
    const log = await latestLog();
    assert.equal(log.route_reason, 'header:x-upstream');
    assert.equal(log.upstream_name, 'alt');
  });

  await step('默认上游兜底', async () => {
    await proxy('/v1/chat/completions', { body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'route default' }] } });
    const log = await latestLog();
    assert.equal(log.route_reason, 'default');
    assert.equal(log.upstream_name, 'mock');
  });

  /* ── 失败路径 ────────────────────────────────────────────────────── */
  section('【失败路径】');

  await step('上游 500：状态码与错误一并落库', async () => {
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-fail', messages: [{ role: 'user', content: 'should fail' }] },
    });
    assert.equal(result.status, 500);
    const log = await latestLog();
    assert.equal(log.ok, false);
    assert.equal(log.status_code, 500);
    assert.equal(log.phase, 'error');
    assert.ok(log.error.includes('mock'), `错误信息异常：${log.error}`);
  });

  await step('上游不可达：返回 502 并记录连接错误', async () => {
    const dead = await api('/admin/api/upstreams', {
      method: 'POST',
      body: { name: 'dead', base_url: 'http://127.0.0.1:1/v1', api_key: 'sk-x', is_default: true },
    });
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'unreachable' }] },
    });
    assert.equal(result.status, 502);
    assert.ok(result.headers.get('x-logger-request-id'), '失败响应同样应带 x-logger-request-id');
    const log = await latestLog();
    assert.equal(log.ok, false);
    assert.equal(log.status_code, 502);
    assert.ok(log.error.includes('无法连接上游'), `错误信息异常：${log.error}`);
    assert.equal(log.upstream_name, 'dead');
    await api(`/admin/api/upstreams/${dead.json.id}`, { method: 'DELETE' });
    await api(`/admin/api/upstreams/${mockId}`, { method: 'PUT', body: { is_default: true } });
  });

  await step('上游超时：返回 504 且日志标记超时', async () => {
    await api('/admin/api/settings', { method: 'PUT', body: { proxy: { timeoutMs: 1200 } } });
    const result = await proxy('/v1/chat/completions', {
      body: { model: 'mock-slow-4o', messages: [{ role: 'user', content: 'timeout' }] },
    });
    assert.equal(result.status, 504);
    const log = await latestLog();
    assert.equal(log.ok, false);
    assert.ok(log.error.includes('超时'), `错误信息异常：${log.error}`);
    await api('/admin/api/settings', { method: 'PUT', body: { proxy: { timeoutMs: 600000 } } });
  });

  await step('未配置上游：返回 503 并给出引导', async () => {
    const all = await api('/admin/api/upstreams');
    for (const item of all.json.items) {
      await api(`/admin/api/upstreams/${item.id}`, { method: 'DELETE' });
    }
    const result = await proxy('/v1/chat/completions', { body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'no upstream' }] } });
    assert.equal(result.status, 503);
    assert.equal(result.json.error.code, 'no_upstream');
    assert.ok(result.headers.get('x-logger-request-id'), '失败响应同样应带 x-logger-request-id');
    const log = await latestLog();
    assert.equal(log.ok, false);
    assert.equal(log.status_code, 503);

    // 复原
    const again = await api('/admin/api/upstreams', {
      method: 'POST',
      body: { name: 'mock', base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: MOCK_KEY, is_default: true },
    });
    mockId = again.json.id;
    const alt = await api('/admin/api/upstreams', {
      method: 'POST',
      body: { name: 'alt', base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: MOCK_KEY },
    });
    altId = alt.json.id;
  });

  await step('请求体非法 JSON 时上游 400 仍被记录', async () => {
    const response = await fetch(`${PROXY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    await response.text();
    const log = await latestLog();
    assert.equal(log.ok, false);
    assert.equal(log.status_code, 400);
  });

  /* ── 日志浏览 ────────────────────────────────────────────────────── */
  section('【日志浏览】');

  await step('按端点 / 流式 / 成功状态筛选', async () => {
    const byEndpoint = await api('/admin/api/logs?endpoint=responses&limit=100');
    assert.ok(byEndpoint.json.rows.length > 0);
    assert.ok(byEndpoint.json.rows.every((r) => r.endpoint === 'responses'));

    const onlyErrors = await api('/admin/api/logs?ok=false&limit=100');
    assert.ok(onlyErrors.json.rows.length >= 4);
    assert.ok(onlyErrors.json.rows.every((r) => r.ok === false));

    const onlyStream = await api('/admin/api/logs?stream=true&limit=100');
    assert.ok(onlyStream.json.rows.every((r) => r.stream === true));
  });

  await step('全文检索命中请求与响应预览', async () => {
    const result = await api('/admin/api/logs?q=ping%20test%20123&limit=10');
    assert.ok(result.json.rows.length >= 1);
    assert.ok(result.json.rows.some((r) => (r.request_preview || '').includes('ping test 123')));
  });

  await step('分页信息正确', async () => {
    const page1 = await api('/admin/api/logs?limit=3&offset=0');
    const page2 = await api('/admin/api/logs?limit=3&offset=3');
    assert.equal(page1.json.rows.length, 3);
    assert.equal(page1.json.total, page2.json.total);
    assert.notEqual(page1.json.rows[0].id, page2.json.rows[0].id);
  });

  await step('按耗时排序', async () => {
    const result = await api('/admin/api/logs?sort=duration_ms&order=desc&limit=5');
    const values = result.json.rows.map((r) => r.duration_ms).filter((v) => v !== null);
    assert.deepEqual(values, [...values].sort((a, b) => b - a));
  });

  await step('概览统计与分布数据可用', async () => {
    const overview = await api('/admin/api/overview');
    assert.ok(overview.json.stats.totals.requests > 10);
    assert.ok(overview.json.stats.totals.total_tokens > 0);
    assert.ok(overview.json.stats.by_endpoint.some((e) => e.endpoint === 'chat.completions'));
    assert.ok(overview.json.stats.by_upstream.length >= 1);
    assert.ok(overview.json.stats.trend.length >= 1);
    assert.ok(overview.json.upstreams.enabled >= 1);
    assert.ok(overview.json.storage.db_size_bytes > 0);
  });

  await step('facets 提供筛选项候选', async () => {
    const facets = await api('/admin/api/facets');
    assert.ok(facets.json.models.some((m) => m.model === 'mock-gpt-4o'));
    assert.ok(facets.json.endpoints.some((e) => e.endpoint === 'responses'));
  });

  await step('导出 JSONL：每行都是完整日志', async () => {
    const response = await fetch(`${PROXY}/admin/api/logs/export?format=jsonl&endpoint=chat.completions`);
    const text = await response.text();
    const lines = text.trim().split('\n');
    assert.ok(lines.length > 0);
    const first = JSON.parse(lines[0]);
    assert.equal(first.endpoint, 'chat.completions');
    assert.ok('request_body' in first);
  });

  await step('导出 CSV：含表头且列数一致', async () => {
    const response = await fetch(`${PROXY}/admin/api/logs/export?format=csv`);
    const text = await response.text();
    const lines = text.trim().split('\n');
    assert.ok(lines[0].startsWith('id,started_at,endpoint,model'));
    assert.ok(lines.length > 1);
  });

  /* ── 设置与安全 ──────────────────────────────────────────────────── */
  section('【设置与安全】');

  await step('读取设置：令牌只返回是否已设置', async () => {
    const result = await api('/admin/api/settings');
    assert.equal(result.json.config.server.admin_token_set, false);
    assert.equal(result.json.config.server.proxy_token_set, false);
    assert.equal(result.json.config.server.adminToken, undefined);
    assert.ok(result.json.config.logging.maxBodyChars > 0);
  });

  await step('设置代理令牌后 /v1 需要鉴权', async () => {
    await api('/admin/api/settings', { method: 'PUT', body: { server: { proxyToken: 'sk-proxy-token-xyz' } } });
    const denied = await proxy('/v1/chat/completions', { body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'blocked' }] } });
    assert.equal(denied.status, 401);
    assert.equal(denied.json.error.code, 'invalid_api_key');

    const allowed = await proxy('/v1/chat/completions', {
      body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'allowed' }] },
      headers: { authorization: 'Bearer sk-proxy-token-xyz' },
    });
    assert.equal(allowed.status, 200);
  });

  await step('设置管理令牌后 /admin 需要鉴权', async () => {
    await api('/admin/api/settings', { method: 'PUT', body: { server: { adminToken: 'admin-token-abc' } } });
    const denied = await api('/admin/api/logs?limit=1');
    assert.equal(denied.status, 401);
    assert.equal(denied.json.error.code, 'admin_token_required');

    const allowed = await api('/admin/api/logs?limit=1', { headers: { 'x-admin-token': 'admin-token-abc' } });
    assert.equal(allowed.status, 200);

    // 复原（顺带验证 null 表示清空）
    await api('/admin/api/settings', { method: 'PUT', body: { server: { adminToken: null, proxyToken: null } }, headers: { 'x-admin-token': 'admin-token-abc' } });
    const after = await api('/admin/api/settings');
    assert.equal(after.json.config.server.admin_token_set, false);
    assert.equal(after.json.config.server.proxy_token_set, false);
  });

  await step('超长请求体按上限截断并标记', async () => {
    await api('/admin/api/settings', { method: 'PUT', body: { logging: { maxBodyChars: 300 } } });
    const longText = 'x'.repeat(4000);
    await proxy('/v1/chat/completions', { body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: longText }] } });
    const log = await latestLog();
    assert.equal(log.truncated, true);
    assert.ok(log.request_body.length <= 300, `请求体未截断：${log.request_body.length}`);
    await api('/admin/api/settings', { method: 'PUT', body: { logging: { maxBodyChars: 200000 } } });
  });

  /* ── 维护 ────────────────────────────────────────────────────────── */
  section('【维护】');

  await step('删除单条日志（事件级联删除）', async () => {
    const target = await api('/admin/api/logs?stream=true&limit=1');
    const id = target.json.rows[0].id;
    const before = await api(`/admin/api/logs/${id}/events`);
    assert.ok(before.json.count > 0);
    await api(`/admin/api/logs/${id}`, { method: 'DELETE' });
    const after = await api(`/admin/api/logs/${id}`);
    assert.equal(after.status, 404);
    const events = await api(`/admin/api/logs/${id}/events`);
    assert.equal(events.json.count, 0, '事件应随日志级联删除');
  });

  await step('按条件批量删除', async () => {
    const before = await api('/admin/api/logs?limit=1');
    const deleted = await api('/admin/api/logs/delete', { method: 'POST', body: { backend: true, filters: { endpoint: 'models' } } });
    assert.ok(deleted.json.deleted >= 1);
    const after = await api('/admin/api/logs?limit=1');
    assert.ok(after.json.total < before.json.total);
  });

  await step('清理全部日志', async () => {
    const result = await api('/admin/api/logs/clear', { method: 'POST', body: {} });
    assert.ok(result.json.deleted > 0);
    const after = await api('/admin/api/logs?limit=1');
    assert.equal(after.json.total, 0);
  });

  await step('保留策略清理接口可用', async () => {
    await proxy('/v1/chat/completions', { body: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'keep me' }] } });
    const purge = await api('/admin/api/maintenance/purge', { method: 'POST', body: { days: 0 } });
    assert.equal(purge.json.deleted, 0, 'days=0 表示不清理');
    const kept = await api('/admin/api/logs?limit=1');
    assert.equal(kept.json.total, 1);
    await api('/admin/api/maintenance/vacuum', { method: 'POST', body: {} });
  });

  await step('更新与删除上游', async () => {
    const updated = await api(`/admin/api/upstreams/${altId}`, { method: 'PUT', body: { note: '改过备注', models: 'a, b ,c' } });
    assert.deepEqual(updated.json.models, ['a', 'b', 'c']);
    assert.equal(updated.json.note, '改过备注');
    const del = await api(`/admin/api/upstreams/${altId}`, { method: 'DELETE' });
    assert.equal(del.json.ok, true);
    const missing = await api(`/admin/api/upstreams/${altId}`);
    assert.equal(missing.status, 404);
  });

  await step('未知接口返回 404', async () => {
    const result = await api('/admin/api/nope');
    assert.equal(result.status, 404);
    assert.equal(result.json.error.type, 'not_found');
  });

  await step('启动时收尾上次强杀遗留的「进行中」日志', async () => {
    // 直接往库里塞一条 running 日志，模拟「上次进程被强杀」
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(DATA_DIR, 'logs.db'));
    db.prepare(
      `INSERT INTO logs (request_id, started_at, phase, endpoint, method, path)
       VALUES (?, ?, 'running', 'chat.completions', 'POST', '/v1/chat/completions')`,
    ).run('stale-running-fixture', new Date().toISOString());
    db.close();

    // 再起一个实例指向同一个数据目录，启动流程应当把这条日志收尾
    start(['src/server.js'], { OAL_DATA_DIR: DATA_DIR, OAL_PORT: String(PROXY_PORT + 1) });
    await waitForPort(`http://127.0.0.1:${PROXY_PORT + 1}/health`);

    const list = await api('/admin/api/logs?limit=200');
    const stale = list.json.rows.find((r) => r.request_id === 'stale-running-fixture');
    assert.ok(stale, '未找到测试用的遗留日志');
    assert.equal(stale.phase, 'error');
    assert.equal(stale.ok, false);
    assert.ok(stale.error.includes('进程在请求进行中退出'), `错误信息异常：${stale.error}`);
    assert.ok(stale.finished_at, '应当补上结束时间');
  });

  /* ── 汇总 ────────────────────────────────────────────────────────── */
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  return failed === 0;
}

main()
  .then((ok) => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error('\n测试执行异常：', err);
    cleanup();
    process.exit(1);
  });
