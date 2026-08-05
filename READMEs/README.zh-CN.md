# pi-discord-openclaw

<p align="center">
  <img src="../screenshot.png" alt="pi-discord-openclaw — Discord 上的 OpenClaw 流式体验" width="720" />
</p>

<p align="center">
  <strong>让 Pi 编码代理在 Discord 上复刻 OpenClaw 的流式输出体验</strong><br/>
  🧠 思考独立渲染 · 🔧 工具实时进度 · 📝 打字机式回答 · ⏭️ 连续输入合并 · ⏹️ 新消息中断旧任务
</p>

<p align="center">
  <a href="../README.md">English</a> |
  <b>简体中文</b>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white" />
  <img alt="License" src="https://img.shields.io/github/license/xqicxx/pi-discord-openclaw?color=blue" />
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-2ea44f" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-18%20files%20green-2ea44f" />
  <img alt="Pi" src="https://img.shields.io/badge/pi-extension-8A2BE2" />
</p>

<p align="center">
  <a href="#为什么做这个">为什么做这个</a> &bull;
  <a href="#核心特性">核心特性</a> &bull;
  <a href="#快速开始">快速开始</a> &bull;
  <a href="#配置参考">配置参考</a> &bull;
  <a href="#架构">架构</a> &bull;
  <a href="#命令">命令</a> &bull;
  <a href="#工作原理">工作原理</a> &bull;
  <a href="#测试">测试</a> &bull;
  <a href="#文档">文档</a> &bull;
  <a href="#安全边界">安全边界</a>
</p>

---

## 为什么做这个？

OpenClaw 的 Discord 频道是**流式输出的行业标杆**：思考、工具调用、回答在同一个频道里层次分明地流动。pi-discord-openclaw 把这份体验完整搬给了 [Pi 编码代理](https://github.com/xqicxx/pi)：

| 维度 | 普通 bot | OpenClaw 风格（本项目） |
|---|---|---|
| 🧠 思考 | 不可见 / 混在回答里 | 独立斜体消息（🧠 前缀），与回答分离 |
| 🔧 工具进度 | 结束后才看到 | 实时逐行更新（\`**🔧 名** \`detail\` *running*\` 行），按 id 增量修正 |
| 📝 回答 | 一次性发完 | 同一条消息不断 edit，像打字机一样逐块流出 |
| ⏭️ 连续输入 | 互相打断 | debounce 合并，批量处理不打断当前 turn |
| ⏹️ 新消息 | 排队等到天荒地老 | 立即中断旧任务、先响应新消息（run-now） |
| 📊 收尾 | 进度方块永远残留 | 回答投递时自动折叠成一行灰色小字摘要 |

## 核心特性

- **🧠 思考流** —— `<think>` 提取 + `🧠 _斜体_` 渲染，多段思考状态机（openclaw reasoning-lane 移植）
- **🔧 工具进度** —— tool-start/update/end 三态行，`✓ 🛠️ bash: ...` / `✗ 🧩 fabric_exec`，按 id 增量更新，上限可控
- **📝 打字机回答** —— 2000 字符分块、节流编辑、失败重试、预览消息（draft-stream）
- **⏭️ 连续输入合并** —— 双 lane debounce、消息合并、串行 flush
- **⏹️ 新消息中断** —— 输入新消息立即中断当前任务并优先响应（对齐 openclaw run-now）
- **📊 折叠摘要** —— 回答投递时方块折叠为 `-# 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns`（openclaw 核心机制）
- **🪄 Markdown 表格 → Discord embed** —— `tableMode: embed` 把表格渲染成真正的 Discord embed 卡片
- **⌨️ 命令系统** —— 88+ 全局命令 + 55 个 `/skill` 子命令（按类别分组、guild 级注册），本地执行不进模型；`/todos`、`/whimsy`、`/sessions`、`/abort`、`/compact` 等直接桥接
- **👀 状态表情** —— queued/thinking/tool/done/error 全阶段反应表情，可自定义 emoji 与时机
- **🛡️ 安全默认** —— 频道白名单、ignoreBots、token 脱敏、turn 级 watchdog 超时
- **🚀 零额外依赖** —— Node ≥ 22 原生 fetch + WebSocket，一个扩展文件即插即用

## 快速开始

### 1. 创建 Discord Bot

Discord 开发者后台（https://discord.com/developers/applications）→ New Application → Bot：

- 打开 **Message Content Intent**（收消息必需）
- Gateway intents：`Guilds | GuildMessages | DirectMessages | MessageContent`
- 把 bot 邀请进你的服务器

### 2. 配置 `discord.json`

在 `~/.pi/agent/discord.json`（或 `$PI_CODING_AGENT_DIR/discord.json`）：

```json
{
  "token": "DISCORD_BOT_TOKEN",
  "channels": ["频道 id（可选，留空 = 全部）"],
  "ignoreBots": true,
  "openclawStyle": {
    "enabled": true,
    "streaming": { "mode": "progress", "throttleMs": 1200, "chunkSize": 1900, "receiptSummary": true, "maxLineChars": 60 },
    "reasoning": { "enabled": true, "style": "emoji-italic" },
    "toolProgress": { "enabled": true, "maxLines": 8 },
    "inbound": { "debounceMs": 1000 }
  }
}
```

Token 也可用环境变量 `DISCORD_BOT_TOKEN` 提供。

### 3. 作为 Pi 扩展加载

本项目是 [Pi](https://github.com/xqicxx/pi) 扩展（`pi.extensions: ["./index.ts"]`）。把仓库放进 Pi 的扩展目录（或按 Pi 扩展机制安装）后启动 Pi，bridge 会在 ready 后自动注册 slash 命令、开始监听频道。

### 4. 开聊

在配置的频道里直接发消息即可——看思考流、工具进度和打字机回答依次出现。

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | — | Bot token（或用 `DISCORD_BOT_TOKEN` 环境变量） |
| `channels` | `[]` | 允许的频道 id，留空 = 全部 |
| `ignoreBots` | `true` | 忽略其他 bot 消息 |
| `streaming.mode` | `progress` | `progress`（进度方块）/ `partial` / `full` |
| `streaming.throttleMs` | `1200` | 编辑节流间隔 |
| `streaming.chunkSize` | `1900` | 分块大小（Discord 2000 上限留余量） |
| `streaming.receiptSummary` | `false` | 回答投递时折叠为 `-# 🧠 N · 🛠️ N · ⏱️ Ns` 摘要 |
| `streaming.maxLineChars` | `120` | 思考/工具行字符预算 |
| `streaming.thinking` | `true` | 思维链注入进度方块 |
| `streaming.commandText` | `raw` | 命令文本模式 `raw` / `status` |
| `reasoning.style` | `emoji-italic` | `emoji-italic` / `italic` / `hidden` |
| `toolProgress.maxLines` | `8` | 工具进度最大行数 |
| `inbound.debounceMs` | `1000` | 连续输入合并窗口 |
| `statusReactions` | — | 阶段表情（queued/thinking/tool/done/error…）、时序自定义 |
| `turnWatchdogMs` | `90000` | turn 级无活动超时 |
| `tableMode` | `code` | 表格渲染：`embed` / `code` / `off` |

## 架构

```
Discord ⇄ transport (REST + Gateway) ⇄ OpenclawBridge ⇄ pi agent
                         │
                         ├─ AnswerLane     📝 流式编辑（draft-stream，2000 分块/throttle/重试）
                         ├─ ReasoningLane  🧠 思考流（<think> 提取 + 🧠 斜体渲染）
                         ├─ ProgressLane   🔧 工具进度（tool-start/update/end 行）
                         ├─ InboundDebouncer ⏭️ 连续输入合并
                         └─ CommandLane    ⌨️ 文本 /xx 拦截 + slash 命令本地执行
```

分层原则（openclaw 蓝本，调研笔记 09-30）：

| 层 | 文件 | 职责 |
|---|---|---|
| transport | `src/transport/discord-rest.ts` | REST 客户端：Bot header、v10 API、429 retry-after、超时 |
| transport | `src/transport/discord-gateway.ts` | Gateway WS：identify/heartbeat/resume/断线重连 |
| transport | `src/transport/types.ts` | 最小 Discord 类型（snowflake/消息/事件） |
| lanes | `src/draft/draft-stream.ts` | 2000 字符分块、节流编辑、失败重试、预览消息 |
| lanes | `src/reasoning/reasoning-lane.ts` | `<think>` 提取、🧠 斜体、思考步骤状态机 |
| lanes | `src/progress/progress-lane.ts` | 工具进度行（Discord Markdown）、按 id 增量更新 |
| lanes | `src/inbound/debounce.ts` | 双 lane debounce、消息合并、串行 flush |
| dispatch | `src/dispatch/dispatch.ts` | TurnManager 生命周期、事件路由、OpenclawBridge |
| dispatch | `src/dispatch/markdown-tables.ts` | Markdown 表格 → embed / ASCII 表格、围栏感知分块 |
| dispatch | `src/dispatch/discord-api-adapter.ts` | transport → bridge delivery 接口 |
| commands | `src/commands/` | slash 注册/分发、`/todos`、`/whimsy`、文本命令拦截 |
| feedback | `src/feedback/ack-reactions.ts` | 状态表情反应（queued→thinking→tool→done/error） |
| security | `src/security/token-mask.ts` | token 脱敏 |
| config | `src/config.ts` | `discord.json` 读取（openclawStyle + token + channels） |

## 命令

- **88+ 全局命令**：`/abort`、`/compact`、`/model`、`/sessions`、`/todos`、`/whimsy`、`/quit` 等——本地执行，不进模型
- **55 个 `/skill` 子命令**：按类别分组（video 19 / dev 14 / fabric 12 / tools 10，每组 ≤ Discord 25 上限），guild 级注册避开全局 100 上限
- **文本命令**：`/xx` 文本前缀拦截，转发本地执行

## 工作原理

一个 turn 的完整生命周期：

1. 用户发消息 → Gateway 收到 `MESSAGE_CREATE` → 文本命令拦截检查
2. 非命令消息进入 debounce 窗口（`debounceMs`），合并连续输入
3. 提交 Pi → 触发 `queued` 表情 → 任务开始
4. Pi 产生思考 → ReasoningLane 渲染 `🧠 _斜体_` 行；调用工具 → ProgressLane 逐行更新
5. 回答开始 → draft-stream 分块 edit 同一条消息（打字机效果）
6. 新消息到达 → 中断当前 turn，优先处理新消息（run-now）
7. turn 结束 → progress 方块折叠为一行摘要，表情更新为 `done`/`error`

## 测试

```bash
npm test          # 18 个测试文件（transport/rest/gateway、draft、lanes、dispatch、commands、reactions、e2e-turn）
npm run typecheck # tsc 0 error
npm run validate  # typecheck + test + audit + pack check
```

## 文档

- `docs/openclaw-research/09-30`：调研笔记——传输层 / 草稿流 / 分块+Markdown / 入站 / 出站+线程 / Telegram→Discord 映射 / 命令系统 / 注册上限 / 思考-回答分离 / 中断与队列语义
- `docs/architecture.md`：架构说明
- `CHANGELOG.md`：版本演进
- `BACKLOG.md`：待办

## 安全边界

- 只处理配置允许的频道；`ignoreBots` 默认忽略其他 bot 消息
- 不执行终端控制；只做消息流式与回复（与 OpenClaw 同理念）
- 2000 字符硬上限：超长文本按块拆分（默认 1900 留余量），围栏感知分块不切断代码块
- token 一律脱敏显示；turn 级 watchdog 防止僵尸任务

## License

MIT — 基于 [pi-telegram-openclaw](https://github.com/xqicxx/pi-telegram-openclaw) 改造（transport 换 Discord，保留 OpenClaw 流式机制）。
