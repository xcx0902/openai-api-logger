/**
 * 请求 / 响应适配层。
 *
 * 目标：把 `/v1/chat/completions` 与 `/v1/responses` 两种格式（流式与非流式）
 * 归一化成同一种记录结构，供日志入库与 Web 展示：
 *
 *   { id, model, finishReason, text, reasoning, toolCalls, usage, responseBody, error }
 *
 * 流式场景下，本模块同时充当「重组器」：把逐条 SSE 事件重新拼成与上游非流式
 * 响应等价的完整对象，使日志里既能看到最终结果，也能看到完整时间线。
 */
import { safeJsonParse, truncateText } from './util.js';

export const ENDPOINT = {
  CHAT: 'chat.completions',
  RESPONSES: 'responses',
  COMPLETIONS: 'completions',
  EMBEDDINGS: 'embeddings',
  MODELS: 'models',
  OTHER: 'other',
};

/** 按路径判断本次请求属于哪种端点 */
export function detectEndpoint(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (p.endsWith('/chat/completions')) return ENDPOINT.CHAT;
  if (p.endsWith('/responses')) return ENDPOINT.RESPONSES;
  if (p.endsWith('/completions')) return ENDPOINT.COMPLETIONS;
  if (p.endsWith('/embeddings')) return ENDPOINT.EMBEDDINGS;
  if (p.endsWith('/models') || /\/models\/[^/]+$/.test(p)) return ENDPOINT.MODELS;
  return ENDPOINT.OTHER;
}

/* ------------------------------------------------------------------ *
 * 请求侧
 * ------------------------------------------------------------------ */

/** content 字段可能是字符串，也可能是 content part 数组 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.input_text === 'string') return part.input_text;
      if (part.type === 'image_url' || part.type === 'input_image') return '[image]';
      if (part.type === 'input_file' || part.type === 'file') return '[file]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 从请求体中提取日志友好的摘要信息：
 * model、是否流式、消息条数、工具数量，以及一段人类可读的对话预览。
 */
export function describeRequest(endpoint, body, { previewLimit = 600 } = {}) {
  const out = { model: null, stream: false, messageCount: null, toolCount: 0, preview: '' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;

  if (typeof body.model === 'string') out.model = body.model;
  out.stream = body.stream === true;
  if (Array.isArray(body.tools)) out.toolCount = body.tools.length;

  const lines = [];

  if (endpoint === ENDPOINT.CHAT || endpoint === ENDPOINT.COMPLETIONS) {
    if (typeof body.prompt === 'string') {
      lines.push(`prompt: ${body.prompt}`);
    }
    if (Array.isArray(body.messages)) {
      out.messageCount = body.messages.length;
      for (const msg of body.messages.slice(-8)) {
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role || 'unknown';
        const text = contentToText(msg.content);
        const toolNote = Array.isArray(msg.tool_calls) && msg.tool_calls.length
          ? ` [tool_calls: ${msg.tool_calls.map((t) => t?.function?.name || t?.id || 'fn').join(', ')}]`
          : '';
        const nameNote = msg.name ? ` (${msg.name})` : '';
        lines.push(`${role}${nameNote}: ${text}${toolNote}`);
      }
    }
  } else if (endpoint === ENDPOINT.RESPONSES) {
    if (typeof body.instructions === 'string' && body.instructions) {
      lines.push(`instructions: ${body.instructions}`);
    }
    if (typeof body.input === 'string') {
      lines.push(`user: ${body.input}`);
    } else if (Array.isArray(body.input)) {
      out.messageCount = body.input.length;
      for (const item of body.input.slice(-8)) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call_output') {
          lines.push(`function_call_output: ${truncateText(contentToText(item.output), 200)[0]}`);
          continue;
        }
        const role = item.role || item.type || 'item';
        lines.push(`${role}: ${contentToText(item.content) || item.text || ''}`);
      }
    }
  } else if (endpoint === ENDPOINT.EMBEDDINGS) {
    const input = body.input;
    lines.push(`input: ${Array.isArray(input) ? input.length + ' items' : input}`);
  }

  const [preview] = truncateText(lines.filter((l) => l.trim()).join('\n'), previewLimit);
  out.preview = preview;
  return out;
}

/* ------------------------------------------------------------------ *
 * 用量归一化
 * ------------------------------------------------------------------ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** chat/completions 用 prompt_tokens，responses 用 input_tokens，这里统一 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  let total = num(usage.total_tokens);
  if (total === null && prompt !== null && completion !== null) total = prompt + completion;
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  const reasoning = num(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
  );
  if (prompt === null && completion === null && total === null) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
  };
}

/** 从任意错误对象里取出可读的错误信息 */
export function errorMessageOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const err = value.error && typeof value.error === 'object' ? value.error : value;
    if (typeof err.message === 'string' && err.message) {
      const type = err.type || err.code;
      return type ? `${type}: ${err.message}` : err.message;
    }
    if (typeof err.code === 'string') return err.code;
    return JSON.stringify(value).slice(0, 500);
  }
  return String(value);
}

/* ------------------------------------------------------------------ *
 * chat.completions
 * ------------------------------------------------------------------ */

const CHAT_SUMMARY_KEYS = ['role', 'content', 'reasoning_content', 'refusal', 'tool_calls', 'function_call', 'annotations'];

/** 从 chat.completion 响应中抽取正文与工具调用 */
export function extractFromChatCompletion(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const message = choice?.message || {};
  const text = contentToText(message.content ?? choice?.text ?? '');
  return {
    id: json?.id ?? null,
    model: json?.model ?? null,
    created: json?.created ?? null,
    text,
    reasoning: message.reasoning_content || message.reasoning || '',
    refusal: message.refusal || '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: choice?.finish_reason ?? null,
    usage: normalizeUsage(json?.usage),
    error: json?.error ? errorMessageOf(json) : null,
  };
}

/** 流式 chat.completions 的事件重组器 */
class ChatStreamCollector {
  constructor() {
    this.id = null;
    this.model = null;
    this.created = null;
    this.text = '';
    this.reasoning = '';
    this.refusal = '';
    this.toolCalls = [];
    this.finishReason = null;
    this.usage = null;
    this.error = null;
    this.done = false;
    this.chunkCount = 0;
    this.systemFingerprint = null;
  }

  push(rawData) {
    if (rawData === '[DONE]') {
      this.done = true;
      return;
    }
    const json = safeJsonParse(rawData);
    if (!json || typeof json !== 'object') return;
    this.chunkCount += 1;
    if (json.error) this.error = errorMessageOf(json);
    if (json.system_fingerprint && !this.systemFingerprint) this.systemFingerprint = json.system_fingerprint;
    if (json.id) this.id ??= json.id;
    if (json.model) this.model ??= json.model;
    if (json.created) this.created ??= json.created;
    if (json.usage) this.usage = normalizeUsage(json.usage) || this.usage;

    for (const choice of json.choices || []) {
      if (!choice) continue;
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message;
      if (!delta) continue;
      if (typeof delta.content === 'string') this.text += delta.content;
      else if (Array.isArray(delta.content)) this.text += contentToText(delta.content);
      if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') this.reasoning += delta.reasoning;
      if (typeof delta.refusal === 'string') this.refusal += delta.refusal;
      if (Array.isArray(delta.tool_calls)) this.#mergeToolCalls(delta.tool_calls);
    }
  }

  #mergeToolCalls(list) {
    for (const tc of list) {
      if (!tc) continue;
      const index = Number.isInteger(tc.index) ? tc.index : this.toolCalls.length;
      let current = this.toolCalls.find((t) => t.index === index);
      if (!current) {
        current = { index, id: '', type: 'function', function: { name: '', arguments: '' } };
        this.toolCalls.push(current);
      }
      if (tc.id) current.id = tc.id;
      if (tc.type) current.type = tc.type;
      if (tc.function?.name) current.function.name += tc.function.name;
      if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
    }
  }

  finalize() {
    const usage = this.usage;
    const message = {
      role: 'assistant',
      content: this.text || null,
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.refusal) message.refusal = this.refusal;
    if (this.toolCalls.length) {
      message.tool_calls = this.toolCalls.map((t) => ({
        id: t.id,
        type: t.type,
        function: t.function,
      }));
    }
    const responseBody = {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: this.finishReason }],
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            prompt_tokens_details: usage.cached_tokens !== null ? { cached_tokens: usage.cached_tokens } : undefined,
            completion_tokens_details:
              usage.reasoning_tokens !== null ? { reasoning_tokens: usage.reasoning_tokens } : undefined,
          }
        : undefined,
      _reassembled: {
        from_stream: true,
        chunks: this.chunkCount,
        done_marker: this.done,
        system_fingerprint: this.systemFingerprint || undefined,
      },
    };
    return {
      id: this.id,
      model: this.model,
      finishReason: this.finishReason,
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: message.tool_calls || [],
      usage,
      responseBody,
      error: this.error,
    };
  }
}

/* ------------------------------------------------------------------ *
 * responses
 * ------------------------------------------------------------------ */

/** 从 Responses API 的 response 对象里抽取正文、推理与工具调用 */
export function extractFromResponseObject(response) {
  const texts = [];
  const reasonings = [];
  const toolCalls = [];
  for (const item of response?.output || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      toolCalls.push(item);
      continue;
    }
    for (const part of item.content || []) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      else if (part.type === 'refusal' && typeof part.refusal === 'string') texts.push(part.refusal);
      else if (part.type === 'reasoning_text' && typeof part.text === 'string') reasonings.push(part.text);
      else if (part.type === 'summary_text' && typeof part.text === 'string') reasonings.push(part.text);
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const s of item.summary) if (typeof s?.text === 'string') reasonings.push(s.text);
    }
  }
  return {
    id: response?.id ?? null,
    model: response?.model ?? null,
    created: response?.created_at ?? null,
    text: texts.join(''),
    reasoning: reasonings.join('\n'),
    toolCalls,
    finishReason: response?.status ?? response?.incomplete_details?.reason ?? null,
    usage: normalizeUsage(response?.usage),
    error: response?.error ? errorMessageOf(response.error) : null,
    status: response?.status ?? null,
  };
}

/** 流式 responses 的事件重组器（依赖 response.completed 给出权威结果） */
class ResponsesStreamCollector {
  constructor() {
    this.id = null;
    this.model = null;
    this.created = null;
    this.text = '';
    this.reasoning = '';
    this.toolCallArgs = new Map();
    this.eventTypes = new Set();
    this.completed = null;
    this.incomplete = null;
    this.failed = null;
    this.error = null;
    this.eventCount = 0;
  }

  /**
   * 统一入口签名：push(data, eventName)
   * （chat 流没有 event 字段，responses 流两者都有，这里由 eventName 兜底）
   */
  push(rawData, eventName = null) {
    const json = safeJsonParse(rawData);
    if (!json || typeof json !== 'object') return;
    this.eventCount += 1;
    const type = eventName || json.type || '';
    this.eventTypes.add(type);

    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        this.#absorb(json.response);
        break;
      case 'response.output_text.delta':
        if (typeof json.delta === 'string') this.text += json.delta;
        break;
      case 'response.refusal.delta':
        if (typeof json.delta === 'string') this.text += json.delta;
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof json.delta === 'string') this.reasoning += json.delta;
        break;
      case 'response.function_call_arguments.delta':
        if (typeof json.delta === 'string') {
          const key = json.item_id || json.output_index || 'fn';
          this.toolCallArgs.set(key, (this.toolCallArgs.get(key) || '') + json.delta);
        }
        break;
      case 'response.output_item.done':
      case 'response.output_item.added':
        if (json.item && json.item.type === 'function_call') {
          this.#absorb(json.response);
        }
        break;
      case 'response.completed':
        this.completed = json.response || null;
        this.#absorb(json.response);
        break;
      case 'response.incomplete':
        this.incomplete = json.response || null;
        this.#absorb(json.response);
        break;
      case 'response.failed':
        this.failed = json.response || null;
        this.error = errorMessageOf(json.response?.error) || 'response.failed';
        this.#absorb(json.response);
        break;
      case 'error':
        this.error = errorMessageOf(json);
        break;
      default:
        if (json.response) this.#absorb(json.response);
        break;
    }
  }

  #absorb(response) {
    if (!response || typeof response !== 'object') return;
    if (response.id) this.id ??= response.id;
    if (response.model) this.model ??= response.model;
    if (response.created_at) this.created ??= response.created_at;
  }

  finalize() {
    const authoritative = this.completed || this.incomplete || null;
    const extracted = authoritative ? extractFromResponseObject(authoritative) : null;
    let toolCalls = extracted?.toolCalls || [];
    if (!toolCalls.length && this.toolCallArgs.size) {
      toolCalls = [...this.toolCallArgs.entries()].map(([key, args]) => ({
        type: 'function_call',
        call_id: key,
        arguments: args,
      }));
    }
    const responseBody = authoritative
      ? { ...authoritative, _reassembled: { from_stream: true, events: this.eventCount, types: [...this.eventTypes] } }
      : {
          id: this.id,
          object: 'response',
          model: this.model,
          status: this.error ? 'failed' : 'incomplete',
          output: this.text
            ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] }]
            : [],
          _reassembled: { from_stream: true, events: this.eventCount, types: [...this.eventTypes] },
        };
    return {
      id: this.id,
      model: this.model,
      finishReason: extracted?.finishReason ?? (this.error ? 'failed' : null),
      text: extracted?.text || this.text,
      reasoning: extracted?.reasoning || this.reasoning,
      toolCalls,
      usage: extracted?.usage || normalizeUsage(authoritative?.usage),
      responseBody,
      error: this.error || extracted?.error || null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

/** 创建流式重组器 */
export function createStreamCollector(endpoint) {
  if (endpoint === ENDPOINT.CHAT || endpoint === ENDPOINT.COMPLETIONS) return new ChatStreamCollector();
  return new ResponsesStreamCollector();
}

/** chat 专用：确保流式请求会上报 usage（不覆盖用户已有设置） */
export function withUsageReporting(endpoint, body) {
  if (!body || typeof body !== 'object') return body;
  if (endpoint !== ENDPOINT.CHAT) return body;
  if (body.stream !== true) return body;
  if (body.stream_options && typeof body.stream_options === 'object') {
    if (body.stream_options.include_usage === false) return body;
    body.stream_options.include_usage = true;
    return body;
  }
  body.stream_options = { include_usage: true };
  return body;
}

/** 非流式响应 → 统一记录结构 */
export function normalizeNonStream(endpoint, json) {
  if (!json || typeof json !== 'object') {
    return {
      id: null,
      model: null,
      finishReason: null,
      text: '',
      reasoning: '',
      toolCalls: [],
      usage: null,
      responseBody: json ?? null,
      error: null,
    };
  }
  if (endpoint === ENDPOINT.CHAT || endpoint === ENDPOINT.COMPLETIONS) {
    const g = extractFromChatCompletion(json);
    return {
      id: g.id,
      model: g.model,
      finishReason: g.finishReason,
      text: g.text,
      reasoning: g.reasoning,
      toolCalls: g.toolCalls,
      usage: g.usage,
      responseBody: json,
      error: g.error,
    };
  }
  if (endpoint === ENDPOINT.RESPONSES) {
    const g = extractFromResponseObject(json);
    return {
      id: g.id,
      model: g.model,
      finishReason: g.finishReason,
      text: g.text,
      reasoning: g.reasoning,
      toolCalls: g.toolCalls,
      usage: g.usage,
      responseBody: json,
      error: g.error,
    };
  }
  return {
    id: json.id ?? null,
    model: json.model ?? null,
    finishReason: null,
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: normalizeUsage(json.usage),
    responseBody: json,
    error: json.error ? errorMessageOf(json) : null,
  };
}

/** 供 UI 展示的会话摘要（不含敏感字段） */
export { CHAT_SUMMARY_KEYS };
