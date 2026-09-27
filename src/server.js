/**
 * 入口：HTTP 服务器与路由分发。
 *
 *   /admin/api/*   → 管理后台 API
 *   /  /admin/*    → Web 控制台（单页应用，前端 hash 路由）
 *   /static/*      → 静态资源
 *   /health        → 健康检查
 *   其它一切路径    → 透明代理到上游（含 /v1/chat/completions、/v1/responses、
 *                    /v1/models，以及各家兼容实现的自定义路径）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ConfigStore, resolvePaths, seedUpstreamFromEnv } from './config.js';
import { Store } from './db.js';
import { bus } from './bus.js';
import { createAdminHandler } from './admin.js';
import { createProxyHandler } from './proxy.js';
import { VERSION } from './version.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = Number(argv[++i]);
    else if (arg === '--host' || arg === '-H') out.host = argv[++i];
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`openai-api-logger —— 本地 OpenAI 兼容代理 + 请求日志系统

用法：
  node src/server.js [选项]

选项：
  -p, --port <端口>      监听端口（默认取 config.json，初始 8787）
  -H, --host <地址>      监听地址（默认 127.0.0.1）
      --data-dir <目录>  数据目录（数据库与配置，默认 ./data）
  -h, --help             显示帮助

环境变量：
  OAL_PORT / OAL_HOST / OAL_DATA_DIR / OAL_DB
  OAL_ADMIN_TOKEN        保护管理后台
  OAL_PROXY_TOKEN        保护本地 /v1 代理
  OAL_UPSTREAM_URL       首次运行自动创建该上游
  OAL_UPSTREAM_KEY / OAL_UPSTREAM_NAME
`);
}

function serveStatic(webDir, relPath, res) {
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(webDir, safeRel);
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end('forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const env = { ...process.env };
  if (args.dataDir) env.OAL_DATA_DIR = args.dataDir;
  if (args.host) env.OAL_HOST = args.host;
  if (args.port) env.OAL_PORT = String(args.port);

  const paths = resolvePaths(env);
  fs.mkdirSync(paths.dataDir, { recursive: true });

  const config = new ConfigStore(paths, env);
  config.load();
  const existedBefore = fs.existsSync(paths.configFile);
  if (!existedBefore) {
    config.save();
    console.log(`[init] 已生成默认配置：${paths.configFile}`);
  }

  const store = new Store(paths.dbFile);
  console.log(`[init] 数据库：${paths.dbFile}`);

  // 首次运行：用环境变量种入上游，方便开箱即用
  if (store.listUpstreams().length === 0) {
    const seed = seedUpstreamFromEnv(env);
    if (seed) {
      const created = store.createUpstream(seed);
      console.log(`[init] 已根据环境变量创建上游「${created.name}」→ ${created.base_url}`);
    }
  }

  // 启动时清理过期日志
  const retentionDays = Number(config.logging.retentionDays) || 0;
  if (retentionDays > 0) {
    const purged = store.purgeOlderThan(retentionDays);
    if (purged) console.log(`[init] 已按保留策略（${retentionDays} 天）清理 ${purged} 条历史日志`);
  }

  // 上次被强杀时可能留下「进行中」的日志，收尾掉以免界面上永久显示进行中
  const stale = store.markStaleRunning();
  if (stale) console.log(`[init] 已将 ${stale} 条上次未收尾的日志标记为中断`);

  const proxy = createProxyHandler({ store, config, bus });
  const admin = createAdminHandler({ store, config, bus, version: VERSION });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    res.setHeader('x-powered-by', `openai-api-logger/${VERSION}`);

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, version: VERSION, upstreams: store.listUpstreams().length }));
      return;
    }
    if (pathname.startsWith('/admin/api/')) {
      await admin(req, res, { pathname, url, search: url.search });
      return;
    }
    if (pathname.startsWith('/static/')) {
      if (serveStatic(paths.webDir, pathname.slice('/static/'.length), res)) return;
    }
    if (pathname === '/' || pathname === '/index.html' || pathname === '/admin' || pathname.startsWith('/admin/')) {
      if (serveStatic(paths.webDir, 'index.html', res)) return;
    }
    try {
      await proxy(req, res, { pathname, search: url.search });
    } catch (err) {
      console.error('[server] 代理处理异常：', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
      } else {
        res.end();
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const { host, port } = config.server;
  server.listen(port, host, () => {
    const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    const upstreams = store.listUpstreams();
    console.log('');
    console.log(`  openai-api-logger v${VERSION} 已启动`);
    console.log(`  ├─ 控制台     ${base}/`);
    console.log(`  ├─ 代理地址   ${base}/v1`);
    console.log(`  ├─ 上游数量   ${upstreams.length}${upstreams.length === 0 ? '（请先在控制台添加上游）' : ''}`);
    console.log(`  ├─ 管理鉴权   ${config.server.adminToken ? '已开启（adminToken）' : '未开启（仅本机可访问时建议保持关闭）'}`);
    console.log(`  └─ 代理鉴权   ${config.server.proxyToken ? '已开启（proxyToken）' : '未开启'}`);
    if (host !== '127.0.0.1' && host !== 'localhost' && !config.server.adminToken) {
      console.warn('  ⚠ 当前监听在非本机地址且未设置 adminToken，任何能访问该端口的人都能读取日志与上游密钥。');
    }
    console.log('');
    console.log('  客户端接入示例：');
    console.log(`    OPENAI_BASE_URL=${base}/v1`);
    console.log(`    OPENAI_API_KEY=<在上游里配置的 key，或留任意值>`);
    console.log('');
  });

  // 定时清理过期日志
  let timer = null;
  if (retentionDays > 0) {
    timer = setInterval(() => {
      const purged = store.purgeOlderThan(retentionDays);
      if (purged) console.log(`[retention] 已清理 ${purged} 条过期日志`);
    }, 3600_000);
    timer.unref?.();
  }

  const shutdown = (signal) => {
    console.log(`\n[shutdown] 收到 ${signal}，正在关闭…`);
    if (timer) clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
