/**
 * 配置层：config.json 读写 + 环境变量覆盖 + 默认值。
 * 配置里可能包含上游 API Key，因此 data/ 目录已在 .gitignore 中排除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT_DIR, deepMerge, safeJsonParse, safeJsonStringify } from './util.js';

export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    /** 非空时，/admin/api/* 必须携带 `Authorization: Bearer <adminToken>` 或 `x-admin-token` */
    adminToken: '',
    /** 非空时，本地 /v1/* 代理必须携带该 key 才能访问（客户端 api key） */
    proxyToken: '',
  },
  proxy: {
    /** 上游请求超时（毫秒） */
    timeoutMs: 600_000,
    /** 入站 key 与某个上游配置的 key 相同时，优先路由到该上游 */
    matchByApiKey: true,
    /** 允许用 `<upstreamName>/<model>` 形式的模型名前缀来指定上游（转发时会剥掉前缀） */
    allowModelPrefix: true,
    /** 透传给上游的额外请求头白名单（小写） */
    forwardHeaders: [
      'openai-organization',
      'openai-project',
      'openai-beta',
      'anthropic-version',
      'anthropic-beta',
    ],
    /**
     * 对流式 chat.completions 自动注入 stream_options.include_usage = true，
     * 以便上游在最后一个 chunk 回报 token 用量（否则日志里用量为空）。
     * 客户端可用请求头 `x-logger-include-usage: false` 单次关闭。
     */
    includeUsageInStream: true,
    /** 是否给 /v1 代理响应加上宽松 CORS 头；默认关闭，避免任意网页盗用本地代理 */
    cors: false,
  },
  logging: {
    /** 是否记录请求体 / 响应体 */
    logBodies: true,
    /** 是否记录流式响应的每个 SSE 事件 */
    captureStreamEvents: true,
    /** 单条 body 落库的字符上限，超出则截断并标记 truncated */
    maxBodyChars: 200_000,
    /** 单次流式请求最多保存的事件条数 */
    maxEvents: 2_000,
    /** 落库前需要脱敏的请求头（同时用于向 UI 展示） */
    redactHeaders: ['authorization', 'api-key', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization'],
    /** 日志保留天数，0 表示永久保留 */
    retentionDays: 0,
  },
  ui: {
    pageSize: 25,
    theme: 'light',
    liveTail: true,
  },
};

/** 解析数据目录 / 数据库文件 / 静态资源目录 */
export function resolvePaths(env = process.env) {
  const dataDir = env.OAL_DATA_DIR ? path.resolve(env.OAL_DATA_DIR) : DATA_DIR;
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    dbFile: env.OAL_DB ? path.resolve(env.OAL_DB) : path.join(dataDir, 'logs.db'),
    webDir: path.join(ROOT_DIR, 'web'),
  };
}

/**
 * 从环境变量生成配置覆盖片段。
 * 支持：OAL_HOST / OAL_PORT / OAL_ADMIN_TOKEN / OAL_PROXY_TOKEN / OAL_UPSTREAM_*
 */
export function envOverrides(env = process.env) {
  const patch = {};
  if (env.OAL_HOST) patch.server = { ...patch.server, host: env.OAL_HOST };
  if (env.OAL_PORT) patch.server = { ...patch.server, port: Number(env.OAL_PORT) || undefined };
  if (env.OAL_ADMIN_TOKEN) patch.server = { ...patch.server, adminToken: env.OAL_ADMIN_TOKEN };
  if (env.OAL_PROXY_TOKEN) patch.server = { ...patch.server, proxyToken: env.OAL_PROXY_TOKEN };
  return patch;
}

/** 首次运行时，用环境变量自动种入一个上游，方便快速体验 */
export function seedUpstreamFromEnv(env = process.env) {
  if (!env.OAL_UPSTREAM_URL) return null;
  return {
    name: env.OAL_UPSTREAM_NAME || 'default',
    base_url: env.OAL_UPSTREAM_URL,
    api_key: env.OAL_UPSTREAM_KEY || '',
    is_default: 1,
    enabled: 1,
  };
}

export class ConfigStore {
  constructor(paths = resolvePaths(), env = process.env) {
    this.paths = paths;
    this.env = env;
    this.data = deepMerge(DEFAULT_CONFIG, envOverrides(env));
    this.loadedFromDisk = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.paths.configFile, 'utf8');
      const parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = deepMerge(DEFAULT_CONFIG, deepMerge(parsed, envOverrides(this.env)));
        this.loadedFromDisk = true;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[config] 读取 ${this.paths.configFile} 失败：${err.message}，使用默认配置`);
      }
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.writeFileSync(this.paths.configFile, `${safeJsonStringify(this.data)}\n`, { mode: 0o600 });
    return this.data;
  }

  /** 深合并更新并持久化，返回最新配置 */
  update(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }

  get server() {
    return this.data.server;
  }

  get proxy() {
    return this.data.proxy;
  }

  get logging() {
    return this.data.logging;
  }

  get ui() {
    return this.data.ui;
  }
}
