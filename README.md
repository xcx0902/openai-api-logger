# openai-api-logger

本地 OpenAI 兼容**代理 + 请求日志系统**。把客户端的 `base_url` 指过来，它就会把请求
转发到你在网页里配置的上游，并把**完整请求、完整响应（含流式分片的逐条时间线）、
token 用量、时延**全部落库到本地 SQLite。自带一个 Web 控制台用于管理上游和浏览日志。

- 零第三方运行时依赖：只用 Node 内置模块（`node:http` + `node:sqlite`），
  **不需要 `npm install`**，也不需要编译 `better-sqlite3` 之类的原生模块。
- 同时支持 `POST /v1/chat/completions` 与 `POST /v1/responses`，流式与非流式都能完整记录。
- 流式响应会被**重组**成与非流式等价的完整响应对象，日志里既能看最终结果，也能看每个分片。
- 其余路径（`/v1/models`、`/v1/embeddings`、各家兼容实现的自定义路径）一律透明转发并记录。
- 控制台自带**对话**页：不用写代码，直接在网页上设 system prompt / 模型 / 上游试请求，
  这些请求走的是同一个 `/v1`，因此和外部客户端一样落进日志，可一键跳到详情。

---

## 快速开始

```bash
# 1. 启动（首次运行会自动生成 data/config.json 与 data/logs.db）
npm start                 # 等价于 node src/server.js

# 2. 打开控制台
open http://127.0.0.1:8787/
```

在控制台「上游」页添加一个上游，例如：

| 字段 | 示例 |
| --- | --- |
| 名称 | `openai` |
| Base URL | `https://api.openai.com/v1` |
| API Key | `sk-...` |
| 设为默认上游 | ✅ |

然后把客户端的 base_url 指过来即可：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=任意非空字符串        # 本代理默认不校验；若设置了代理令牌则填该令牌
```

**不想配真实 API Key？** 内置了一个 mock 上游，可以先把整条链路跑通：

```bash
npm run mock              # 监听 http://127.0.0.1:9911/v1
# 控制台里把 Base URL 填成 http://127.0.0.1:9911/v1，然后随便发请求
```

配好上游后，直接打开控制台「对话」页就能试：填模型名（如 `gpt-4o`）、
可选的 system prompt 与上游，敲一句发出去——不用写任何代码，
这次请求的请求体、响应体、token 用量与流式事件都会出现在「日志」页里。

---

## 控制台

| 页面 | 作用 |
| --- | --- |
| 概览 | 请求量、成功率、平均耗时/首包、token 消耗、近 N 天趋势、按端点/上游/模型分布、最近错误 |
| **对话** | 在网页上直接与上游对话：可设 system prompt、模型名、上游，支持流式；请求经本机代理，全部落库 |
| 日志 | 6 项筛选 + 全文检索 + 分页 + 导出 JSONL/CSV + 实时日志（SSE）；点开单条可看请求体、响应体、流式事件时间线、原始记录 |
| 上游 | 上游增删改查、连通性测试、密钥掩码（明文需显式查看）、启停与默认上游 |
| 设置 | 监听地址与令牌、代理行为、日志记录策略、维护操作、客户端接入片段 |

### 对话页

它是控制台里最省事的「试一试」入口：

- **system prompt / 模型名 / 上游**都可设置；上游留空则走代理的默认路由规则，
  指定时用 `X-Upstream` 请求头，与外部客户端完全一致。
- 支持**流式与非流式**，快捷键 `⌘/Ctrl + Enter` 发送。
- 每次发送都是一次真实的 `POST /v1/chat/completions`，**同样落进日志**：
  日志里的 `request_body` 能看到你和 system prompt、历史消息一起发出去的内容，
  `route_reason` 会记录它命中了哪条路由规则。
- 回复下方会给出这次请求的耗时、token 用量与「查看日志 #N」——
  它靠响应头 `x-logger-request-id` 反查日志，点进去就是这条请求的完整记录
  （请求体、响应体、流式事件时间线）。出错的请求（如上游 500）同样能跳转。
- 对话记录只存在浏览器 `localStorage`（最近 30 条），「清空对话」不会影响已写入的日志。
- 若在「设置」里配了代理令牌，在对话页的「代理令牌」里填一次即可（会记住）。

---

## 架构

```
                   ┌──────────────────────────────────────────────────────────┐
   客户端          │  openai-api-logger                                        │
 (SDK / curl)      │                                                          │
   │               │   ┌────────────┐      ┌─────────────┐                     │
   │ POST /v1/...   │   │ src/proxy  │      │ src/adapters│  重组 / 归一化       │
   ├──────────────►│──►│  透明转发   │─────►│  请求预览    │◄──────┐             │
   │               │   │  背压透传   │      │  流式重组    │       │             │
   │◄──────────────│◄──│            │      │  用量映射    │       │             │
   │  原样响应      │   └─────┬──────┘      └─────────────┘       │             │
                   │         │                                    │             │
                   │         │  ① 先落 running 行 ② 再补齐结果     │             │
                   │         ▼                                    │             │
                   │   ┌────────────┐      ┌──────────────┐       │             │
                   │   │  src/db    │◄─────│  src/sse     │───────┘             │
                   │   │  SQLite    │      │  SSE 解析器   │                     │
                   │   └─────┬──────┘      └──────────────┘                     │
                   │         │                                                  │
                   │         │ 写完后广播            ┌───────────────┐            │
                   │         └──────────────────────►│  src/bus      │            │
                   │                                 └───────┬───────┘            │
                   │                                         │ SSE 实时推送       │
  浏览器 ◄─────────┼─────────────── /admin/api/* ────────────┘                    │
  (Web 控制台)      │  上游 CRUD · 日志筛选/详情/导出 · 统计 · 设置                 │
                   └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼ 转发（可配置多个上游 + 四种路由策略）
                                  上游 OpenAI 兼容服务
```

### 一次请求发生了什么

1. **鉴权**：若配置了 `server.proxyToken`，校验入站 `Authorization`。
2. **读请求体**：硬上限 64MB，超限直接 413，不会把内存打爆。
3. **解析摘要**：识别端点类型、模型、是否流式，生成人类可读的对话预览。
4. **选择上游**：按下面的路由优先级命中一个上游，并记录 `route_reason`。
5. **改写转发体**：剥掉模型名前缀；对流式 chat 请求注入 `stream_options.include_usage`
   （否则上游不会回报 token 用量，日志里就是空的）。
6. **先落库**：写入一条 `phase=running` 的日志并通过 SSE 推给控制台——
   所以长连接、慢响应在界面上是**实时可见**的。
7. **转发 + 边转发边解析**：流式响应先 `flushHeaders` 再逐块透传给客户端，
   绝不做缓冲；同一份字节流喂给 SSE 解析器与重组器。
8. **补齐日志**：用量、总耗时、首包时延、重组后的完整响应体、逐条事件明细。
9. **失败也可观测**：连接失败 502、超时 504、客户端中断 499、上游非 2xx
   与流内 `error` 事件，都会落库并标记 `ok=0` 与具体错误。

### 目录结构

```
src/
  server.js        HTTP 入口与路由分发（/admin/api、静态资源、其余一律代理）
  proxy.js         代理核心：请求生命周期编排、流式透传与重组
  adapters.js      两种请求格式 × 流式/非流式的归一化与重组
  sse.js           SSE 解析器（跨 chunk 半行缓存、多行 data、注释心跳）
  upstream.js      上游选择策略与转发请求头构造
  admin.js         管理后台 API
  db.js            SQLite 表结构、迁移与全部仓储方法
  config.js        配置读写 + 环境变量覆盖
  bus.js           进程内事件总线（实时日志推送）
  util.js          通用工具
  mock-upstream.js 内置 mock 上游（演示 + 测试）
web/
  index.html       控制台外壳
  app.js           控制台前端（原生 ESM，无构建）：概览 / 对话 / 日志 / 上游 / 设置
  styles.css       样式（浅色主题）
test/
  smoke.mjs        端到端测试（43 项断言）
data/              运行时数据（已 gitignore，位置可被 OAL_DATA_DIR 覆盖）
  config.json      配置（含上游密钥，0600 权限）
  logs.db          SQLite 数据库（WAL 模式，另有 logs.db-wal / -shm）
```

---

## 上游路由

请求会按以下顺序匹配上游，命中的规则会写入日志的 `route_reason` 字段：

| 优先级 | 规则 | 用法 | `route_reason` |
| --- | --- | --- | --- |
| 1 | 请求头指定 | `X-Upstream: openai`（填名称或 ID） | `header:x-upstream` |
| 2 | 密钥匹配 | 入站 Key 与某上游配置的 Key 相同 | `api-key-match` |
| 3 | 模型名前缀 | `model: "openai/gpt-4o"` → 转发时自动剥成 `gpt-4o` | `model-prefix` |
| 4 | 默认上游 | 勾选了「设为默认上游」的那个 | `default` |
| 5 | 兜底 | 第一个启用的上游 | `first-enabled` |

第 2、3 条可分别在「设置 → 代理行为」里关闭。

---

## 客户端接入

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="任意值")

# chat completions（非流式）
print(client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)

# chat completions（流式）
for chunk in client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")

# Responses API
print(client.responses.create(model="gpt-4o", input="你好").output_text)
```

### Node（openai SDK）

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'any' });

const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

### curl

```bash
# 非流式 chat
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}]}'

# 流式 responses
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","input":"你好","stream":true}'
```

### 代理专属请求头

| 请求头 | 作用 |
| --- | --- |
| `X-Upstream: <名称或ID>` | 指定本次请求走哪个上游 |
| `X-Logger-Include-Usage: false` | 关闭「流式 chat 自动注入 include_usage」 |

代理会补两个**响应头**（不改动响应体本身）：

| 响应头 | 说明 |
| --- | --- |
| `x-logger-request-id` | 本次请求的本地链路 ID，可用于 `GET /admin/api/logs/by-request-id/:rid` 反查日志。**成功与失败响应都会带上** |
| `x-logger-upstream` | 实际命中的上游名称（失败时若已选定上游也会带上） |

---

## 日志字段

每条日志一行，字段分四类（完整定义见 `src/db.js` 的 DDL）：

**身份与路由**
`request_id`（本地链路 ID，同时也是返回给客户端的 `x-logger-request-id`）、
`upstream_request_id`（上游返回的 id）、`endpoint`、`method`/`path`/`query`、
`upstream_id`/`upstream_name`/`upstream_url`、`route_reason`、`client_ip`、`user_agent`、
`api_key_masked`（入站密钥掩码）。

**请求侧**
`request_headers`（**已脱敏**）、`request_body`（实际转发出去的内容，含模型前缀剥离结果）、
`request_preview`（人类可读的对话预览，用于列表与全文检索）、`request_bytes`、
`requested_model`（客户端原始 model）、`model`（实际使用的 model）、`stream`。

**响应侧**
`status_code`、`ok`、`response_headers`、`response_body`（非流式为上游原始 JSON；
**流式为按事件重组出的完整响应对象**，带 `_reassembled` 标记）、`response_text`
（抽取出的助手正文，含 reasoning 与 tool_calls 的独立字段）、`response_preview`、
`event_count`、`finish_reason`、`tool_calls_count`、`error`。

**观测指标**
`started_at`/`finished_at`/`duration_ms`/`first_token_ms`（首包时延，仅流式）、
`prompt_tokens`/`completion_tokens`/`total_tokens`/`cached_tokens`/`reasoning_tokens`、
`truncated`（因超过 `maxBodyChars` 被截断）、`phase`（`running`/`done`/`error`）。

流式请求的每条 SSE 事件另外存在 `log_events` 表：`seq`、`offset_ms`（相对请求开始的毫秒
偏移）、`event`（事件名，如 `response.output_text.delta`）、`data`（原始负载）。
删除日志时会级联删除事件（`ON DELETE CASCADE`）。

---

## 配置

配置保存在 `data/config.json`（权限 `0600`，含上游密钥，已被 gitignore）。
也可以在控制台「设置」页里改；部分项支持环境变量覆盖。

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "adminToken": "",   // 非空时 /admin/api 需要 Authorization: Bearer <token>
    "proxyToken": ""    // 非空时 /v1 需要该 key
  },
  "proxy": {
    "timeoutMs": 600000,             // 上游超时
    "matchByApiKey": true,           // 按 API Key 路由
    "allowModelPrefix": true,        // 按模型名前缀路由
    "includeUsageInStream": true,    // 流式 chat 自动注入 include_usage
    "cors": false,                   // /v1 是否开启 CORS（默认关闭，见「安全」）
    "forwardHeaders": ["openai-organization", "openai-project", "openai-beta",
                       "anthropic-version", "anthropic-beta"]
  },
  "logging": {
    "logBodies": true,          // 是否记录请求/响应体
    "captureStreamEvents": true, // 是否记录逐条流式事件
    "maxBodyChars": 200000,      // 单条 body 落库上限（超出截断并标记）
    "maxEvents": 2000,           // 单次流式最多保存的事件条数
    "redactHeaders": ["authorization", "api-key", "x-api-key", "cookie",
                      "set-cookie", "proxy-authorization"],
    "retentionDays": 0           // 0 = 永久保留；>0 时启动与每小时自动清理
  },
  "ui": { "pageSize": 25, "theme": "light", "liveTail": true }
}
```

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `OAL_HOST` / `OAL_PORT` | 监听地址与端口 |
| `OAL_DATA_DIR` / `OAL_DB` | 数据目录 / 数据库文件路径 |
| `OAL_ADMIN_TOKEN` / `OAL_PROXY_TOKEN` | 对应上面两个令牌 |
| `OAL_UPSTREAM_URL` / `OAL_UPSTREAM_KEY` / `OAL_UPSTREAM_NAME` | 首次运行（无任何上游时）自动创建该上游 |

命令行参数：`node src/server.js --port 8788 --host 0.0.0.0 --data-dir /path/to/data`
（`--help` 查看全部）。

> **需要透传自定义请求头？** 只有 `proxy.forwardHeaders` 白名单内的头会被转发，
> 其余一律丢弃。要透传业务头（如某些供应商的 `x-api-version`），
> 请加到该白名单，或在上游配置的「额外请求头」里写死。

---

## 管理 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/admin/api/overview?days=7` | 统计概览（总量/成功率/时延/P95/token/分布/趋势/最近错误） |
| GET | `/admin/api/stats` · `/admin/api/facets` | 详细统计 · 筛选项候选值 |
| GET/POST | `/admin/api/upstreams` | 列出 / 新建上游（列表默认返回密钥掩码） |
| GET/PUT/DELETE | `/admin/api/upstreams/:id` | 详情 / 修改 / 删除 |
| POST | `/admin/api/upstreams/:id/reveal` | 取回明文密钥 |
| POST | `/admin/api/upstreams/test` | 连通性测试（请求上游 `/models`，可传 `{id}` 或未保存的配置） |
| GET | `/admin/api/logs` | 日志列表，支持 `endpoint` `model` `upstream_id` `ok` `stream` `phase` `status` `q` `from` `to` `limit` `offset` `sort` `order` |
| GET | `/admin/api/logs/:id` | 日志详情（含完整请求体与响应体） |
| GET | `/admin/api/logs/by-request-id/:rid` | 按本地 `request_id` 反查日志（控制台对话页靠它关联详情） |
| GET | `/admin/api/logs/:id/events` | 流式事件时间线 |
| DELETE | `/admin/api/logs/:id` · POST `/admin/api/logs/delete` · POST `/admin/api/logs/clear` | 删除单条 / 按条件批删 / 清空 |
| GET | `/admin/api/logs/export?format=jsonl\|csv` | 导出（流式写出，支持同样的筛选条件） |
| GET | `/admin/api/events` | 实时日志（SSE） |
| GET/PUT | `/admin/api/settings` | 读写配置（令牌只回显是否已设置） |
| POST | `/admin/api/maintenance/purge` · `/vacuum` | 按保留天数清理 / 整理数据库 |

---

## 安全

这是一个**本地开发工具**，默认按「只服务本机」来做取舍：

- **默认只监听 `127.0.0.1`**。若要监听 `0.0.0.0` 且未设置 `adminToken`，
  启动时会打印明确警告——那意味着同网段任何人都能读到你的日志与上游密钥。
- **日志里的密钥是脱敏的**：`authorization` / `api-key` / `x-api-key` 等按
  `logging.redactHeaders` 存成 `sk-abc…wxyz`。上游密钥接口默认只返回掩码，
  要看明文必须显式调用 reveal。
- **CORS 默认关闭**：否则任意网页都能悄悄调用你的本地代理，直接烧掉你的 API 额度。
  只有需要浏览器前端直连时才在设置里打开。
- **`data/` 不会进 git**：`config.json`（含密钥）与 `logs.db` 都在 `.gitignore` 里。
- **请求体本身不脱敏**：如果提示词里有敏感信息，请自行控制
  （关掉 `logBodies`、调小 `maxBodyChars`，或用 `retentionDays` 定期清理）。

---

## 测试

```bash
npm test
```

`test/smoke.mjs` 会自行拉起 mock 上游与代理（独立端口 + 临时数据目录），
覆盖 43 项断言：两种格式 × 流式/非流式 × 工具调用的透传与落库、四种路由策略、
五类失败路径、日志筛选/检索/分页/排序/导出、按 request_id 反查、
密钥脱敏、令牌鉴权、截断、级联删除，以及「上次被强杀遗留的进行中日志」的启动收尾。

---

## 常见问题

**日志里 token 用量为空？**
流式 chat 请求需要上游在末个 chunk 回报用量。本代理默认会自动注入
`stream_options.include_usage=true`（可用 `proxy.includeUsageInStream` 关闭）；
若上游本身完全不支持 usage 上报，就只能为空了。

**为什么流式日志的 `response_body` 不是上游原始的分片？**
因为那对阅读没用。代理会把分片**重组**成与非流式等价的完整响应，并保留
`_reassembled` 标记；原始分片在 `log_events` 表里可通过「流式事件」页逐条查看。

**客户端收到的响应被改动了吗？**
没有。流式响应不缓冲、按块透传；唯一会改动的是**发往上游的请求体**（模型名前缀剥离、
注入 include_usage，均可关闭）。响应侧只会补齐两个辅助响应头
`x-logger-request-id`、`x-logger-upstream`。

**数据库文件到底在哪儿？**
默认是 `<项目目录>/data/logs.db`（配置文件为 `data/config.json`）。三处都能改：
`OAL_DATA_DIR` / `OAL_DB` 环境变量、`npm start -- --data-dir <路径>`，
或启动时用 `OAL_DATA_DIR` 指向别处。**当前实际用的路径**可以直接看：
控制台「概览」页的「数据库」卡片（路径写在卡片说明里），
以及「设置」页底部的「数据目录 / 数据库 / 配置」三行。

如果你在项目 `data/` 下只看到 `.gitkeep`，说明启动时设了 `OAL_DATA_DIR`
指向了别处（常见于把演示实例 / 测试实例跑到临时目录），
`curl http://127.0.0.1:8787/admin/api/settings` 返回的 `paths` 字段是最权威的答案。

**`logs.db` 只有几 KB，旁边却有个几百 MB 的 `logs.db-wal`？**
正常，那是 SQLite 的 WAL（预写日志）。写入先进 `-wal`，攒够量或进程正常退出时
才合并回主库，所以主库文件小 ≠ 没数据。两点推论：
- 备份或搬移数据**必须把 `logs.db`、`logs.db-wal`、`logs.db-shm` 三个一起拷**，
  只拷主库会丢掉还没合并的日志；或者先在「设置 → 维护」点「整理数据库」（VACUUM）
  并停掉进程再拷。
- `data/*` 已在 `.gitignore` 里忽略，日志和上游密钥都不会进 git。

**数据库很大怎么办？**
控制台「设置 → 日志记录」可以打开 `retentionDays`（启动与每小时自动清理），
或直接「立即清理过期日志」「整理数据库」（VACUUM）。也可以只导出 JSONL/CSV 后清空。

**想在最前面套一层 Nginx / 用 HTTPS？**
可以。转发时会把 `x-forwarded-for` 的第一个地址记为 `client_ip`。

**对话页里发的消息会不会漏记？**
不会。它和外部客户端走的是同一个 `/v1`，代理一视同仁地记录：请求体（含 system prompt
与历史消息）、响应体、用量、流式事件全都在。回复下方的「查看日志 #N」就是这条请求的详情页。

**怎么用一条 curl 就能验证某个请求有没有被记录？**
取响应头里的 `x-logger-request-id`，然后
`curl http://127.0.0.1:8787/admin/api/logs/by-request-id/<rid>` 即可拿到日志 id。

---

## 设计取舍

- **用 Node 内置 SQLite 而不是 better-sqlite3**：零依赖、零编译，代价是
  `node:sqlite` 目前仍标记为实验特性（启动脚本已静默对应告警），且需要 Node ≥ 22.5。
- **同步写库**：单进程、单连接。SQLite 在此负载下完全够用，换来的是实现简单、
  绝不丢日志；真的扛不住时再换 WAL + 队列也不迟（WAL 已经开着）。
- **请求开始就落一行**：多一次 UPDATE，但换来流式长连接在控制台上的实时可见性。
- **前端不引入框架**：整个控制台一个 `app.js`，没有构建步骤，克隆下来就能改。
  模板用自带转义能力的 `` t`` `` 标签函数，避免手写 `innerHTML` 带来的 XSS 风险。
- **对话页只是「又一个客户端」**：它没有直连上游，也没有走后门写日志，而是老老实实
  请求本机 `/v1/chat/completions`。因此不必为它单独实现一套记录逻辑，
  它也顺带成了「代理是否正常工作」的活体验证；上游选择直接复用 `X-Upstream` 路由，
  前端不重复实现一遍规则。

## 许可

MIT
