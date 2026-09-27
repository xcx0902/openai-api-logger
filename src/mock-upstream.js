/**
 * 内置 mock 上游：一个最小可用的 OpenAI 兼容服务端。
 *
 * 用途：
 *   1. 本地开发 / 演示：不需要真实 API Key 就能跑通「代理 → 上游 → 日志」全链路；
 *   2. 自动化测试：可精确控制流式分片、错误码、延迟等边界行为。
 *
 * 支持端点：
 *   GET  /v1/models
 *   POST /v1/chat/completions   （流式 / 非流式，流式支持 stream_options.include_usage）
 *   POST /v1/responses          （流式 / 非流式，事件名与官方一致）
 *   POST /v1/embeddings
 *
 * 特殊控制：
 *   - 环境变量 MOCK_KEY=<key>     要求 Bearer 鉴权，否则返回 401
 *   - 环境变量 MOCK_FAIL_MODEL    命中该模型名时返回 500，用于测试错误路径
 *   - 请求头 x-mock-delay-ms:<n>  人为延迟，用于测试超时 / 首包时延
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || process.argv[2] || 9911);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const REQUIRE_KEY = process.env.MOCK_KEY || '';
const FAIL_MODEL = process.env.MOCK_FAIL_MODEL || 'mock-fail';

const MODELS = [
  { id: 'mock-gpt-4o', object: 'model', owned_by: 'mock' },
  { id: 'mock-gpt-4o-mini', object: 'model', owned_by: 'mock' },
  { id: 'mock-reasoner', object: 'model', owned_by: 'mock' },
  { id: 'mock-embedding', object: 'model', owned_by: 'mock' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));
const rid = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearer(req) {
  const m = /^bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return m ? m[1].trim() : '';
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': rid('req'),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content) return content;
    if (Array.isArray(content)) {
      const part = content.find((p) => typeof p?.text === 'string');
      if (part) return part.text;
    }
  }
  if (typeof body?.input === 'string') return body.input;
  if (Array.isArray(body?.input)) {
    for (let i = body.input.length - 1; i >= 0; i -= 1) {
      const c = body.input[i]?.content;
      if (typeof c === 'string' && c) return c;
      if (Array.isArray(c)) {
        const part = c.find((p) => typeof p?.text === 'string');
        if (part) return part.text;
      }
    }
  }
  return '';
}

function composeAnswer(body) {
  const user = lastUserText(body);
  const isReasoner = /reason/i.test(body?.model || '');
  const answer = [
    `收到你的消息（${user.length} 个字符）。`,
    isReasoner ? '我先把思路理一遍，再给出结论。' : '这是 mock 上游生成的回答，用于验证代理与日志链路。',
    `你问的是：${user.slice(0, 80)}`,
  ].join('');
  const reasoning = isReasoner ? '第一步：解析用户意图；第二步：组织语言；第三步：输出答案。' : '';
  return { answer, reasoning };
}

/** 模型名含 "tool" 时返回工具调用，用于验证 tool_calls 的增量合并 */
const TOOL_CALL = {
  id: 'call_mock_0001',
  type: 'function',
  name: 'get_weather',
  args: '{"city":"Beijing","unit":"celsius"}',
};

async function handleChatCompletions(req, res, body, delayMs) {
  if (!Array.isArray(body?.messages)) {
    sendError(res, 400, "缺少必填参数 'messages'。", 'invalid_request_error', 'missing_required_parameter');
    return;
  }
  const model = body.model || 'mock-gpt-4o';
  const id = rid('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const { answer, reasoning } = composeAnswer(body);
  const wantsTools = /tool/i.test(model);
  const promptTokens = body.messages.reduce((sum, m) => sum + tokens(typeof m.content === 'string' ? m.content : ''), 0) + 4;
  const completionTokens = tokens(answer) + tokens(reasoning);

  if (body.stream !== true) {
    await sleep(delayMs);
    const message = wantsTools
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: TOOL_CALL.id, type: 'function', function: { name: TOOL_CALL.name, arguments: TOOL_CALL.args } }],
        }
      : reasoning
        ? { role: 'assistant', content: answer, reasoning_content: reasoning }
        : { role: 'assistant', content: answer };
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: wantsTools ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      system_fingerprint: 'fp_mock',
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': rid('req'),
  });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  await sleep(delayMs);
  write({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    system_fingerprint: 'fp_mock',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });

  if (wantsTools) {
    // 故意把 id / 函数名 / 参数拆到多个 chunk，验证按 index 合并的能力
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: TOOL_CALL.id, type: 'function', function: { name: TOOL_CALL.name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    });
    for (const piece of chunkText(TOOL_CALL.args, 9)) {
      write({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }],
      });
    }
  } else {
    if (reasoning) {
      for (const piece of chunkText(reasoning, 6)) {
        write({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
        });
      }
    }
    for (const piece of chunkText(answer, 8)) {
      write({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    }
  }
  write({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: wantsTools ? 'tool_calls' : 'stop' }],
  });

  if (body.stream_options?.include_usage) {
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleResponses(req, res, body, delayMs) {
  if (body?.input === undefined) {
    sendError(res, 400, "缺少必填参数 'input'。", 'invalid_request_error', 'missing_required_parameter');
    return;
  }
  const model = body.model || 'mock-gpt-4o';
  const id = rid('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  const { answer } = composeAnswer(body);
  const wantsTools = /tool/i.test(model);
  const inputTokens = tokens(JSON.stringify(body.input)) + tokens(body.instructions || '');
  const outputTokens = tokens(answer);

  const messageItem = {
    id: rid('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: answer, annotations: [] }],
  };
  const functionCallItem = {
    id: rid('fc'),
    type: 'function_call',
    status: 'completed',
    call_id: TOOL_CALL.id,
    name: TOOL_CALL.name,
    arguments: TOOL_CALL.args,
  };
  const fullResponse = {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: [wantsTools ? functionCallItem : messageItem],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  if (body.stream !== true) {
    await sleep(delayMs);
    sendJson(res, 200, fullResponse);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': rid('req'),
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  await sleep(delayMs);
  emit('response.created', {
    type: 'response.created',
    response: { ...fullResponse, status: 'in_progress', output: [] },
    sequence_number: 0,
  });
  emit('response.in_progress', { type: 'response.in_progress', response: { ...fullResponse, status: 'in_progress', output: [] } });
  if (wantsTools) {
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: functionCallItem.id, type: 'function_call', status: 'in_progress', call_id: TOOL_CALL.id, name: TOOL_CALL.name, arguments: '' },
    });
    for (const piece of chunkText(TOOL_CALL.args, 9)) {
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: functionCallItem.id,
        output_index: 0,
        delta: piece,
      });
    }
    emit('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: functionCallItem.id,
      arguments: TOOL_CALL.args,
    });
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: functionCallItem });
    emit('response.completed', { type: 'response.completed', response: fullResponse });
    res.end();
    return;
  }

  emit('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: messageItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  emit('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: messageItem.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  for (const piece of chunkText(answer, 8)) {
    emit('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: messageItem.id,
      output_index: 0,
      content_index: 0,
      delta: piece,
    });
  }
  emit('response.output_text.done', { type: 'response.output_text.done', item_id: messageItem.id, text: answer });
  emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: messageItem });
  emit('response.completed', { type: 'response.completed', response: fullResponse });
  res.end();
}

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (REQUIRE_KEY && bearer(req) !== REQUIRE_KEY) {
    sendError(res, 401, 'Incorrect API key provided.（mock 上游要求 MOCK_KEY）', 'invalid_request_error', 'invalid_api_key');
    return;
  }

  const raw = await readBody(req);
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error');
      return;
    }
  }
  // 人为延迟：请求头优先，其次看模型名是否含 slow（用于测试代理超时）
  const bodyDelay = /slow/i.test(String(body?.model || '')) ? 5000 : 0;
  const delayMs = Number(req.headers['x-mock-delay-ms'] || 0) || bodyDelay;

  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: MODELS });
    return;
  }
  if (req.method === 'POST' && pathname === '/v1/embeddings') {
    const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
    sendJson(res, 200, {
      object: 'list',
      model: body?.model || 'mock-embedding',
      data: input.map((_, i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: 8 }, () => Math.random() - 0.5) })),
      usage: { prompt_tokens: tokens(input.join(' ')), total_tokens: tokens(input.join(' ')) },
    });
    return;
  }
  if (body?.model === FAIL_MODEL) {
    sendError(res, 500, 'mock 上游被要求返回错误（MOCK_FAIL_MODEL）', 'server_error', 'mock_error');
    return;
  }
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    await handleChatCompletions(req, res, body || {}, delayMs);
    return;
  }
  if (req.method === 'POST' && pathname === '/v1/responses') {
    await handleResponses(req, res, body || {}, delayMs);
    return;
  }

  sendError(res, 404, `mock 上游没有实现 ${req.method} ${pathname}`, 'invalid_request_error', 'unknown_url');
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-upstream] listening on http://${HOST}:${PORT}/v1${REQUIRE_KEY ? ' （要求 MOCK_KEY）' : ''}`);
});
