# pi-discord-openclaw

> 复刻 OpenClaw 在 Discord 上的流式输出体验——思考 🧠、工具调用 🔧、流式回复 📝、连续输入 ⏭️——基于 **pi-telegram-openclaw** 改造（transport 换 Discord，保留 OpenClaw 流式机制）。

## ✨ 为什么做这个？

OpenClaw 的 Discord 频道是**流式输出标杆**：

- 🧠 **思考独立成消息**（斜体 + 🧠 图标），和回答分开
- 🔧 **工具调用实时进度**（`**🔧 name** \`detail\` *running*` 行，实时更新）
- 📝 **回答流式编辑**（同一条消息不断 editChannelMessage，像打字机）
- ⏭️ **连续输入合并**（debounce 批量处理，不打断当前 turn）

## 🧩 架构（解耦）

```
Discord ⇄ transport (REST + Gateway) ⇄ OpenclawBridge ⇄ pi agent
                         │
                         ├─ AnswerLane     📝 流式编辑（draft-stream，2000 分块/throttle/重试）
                         ├─ ReasoningLane  🧠 思考流（<think> 提取 + 🧠 斜体渲染）
                         ├─ ProgressLane   🔧 工具进度（tool-start/update/end 行）
                         └─ InboundDebouncer ⏭️ 连续输入合并
```

分层原则（openclaw 蓝本，笔记 09-15）：

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
| dispatch | `src/dispatch/discord-api-adapter.ts` | transport → bridge delivery 接口 |
| config | `src/config.ts` | discord.json 读取（openclawStyle + token + channels） |

## 🔌 启用（discord.json）

在 `~/.pi/agent/discord.json` 配置（或在 `$PI_CODING_AGENT_DIR/discord.json`）：

```json
{
  "token": "DISCORD_BOT_TOKEN",
  "channels": ["频道 id（可选，留空 = 全部）"],
  "ignoreBots": true,
  "openclawStyle": {
    "enabled": true,
    "streaming": { "mode": "progress", "throttleMs": 1200, "chunkSize": 1900 },
    "reasoning": { "enabled": true, "style": "emoji-italic" },
    "toolProgress": { "enabled": true, "maxLines": 8 },
    "inbound": { "debounceMs": 1000 }
  }
}
```

Token 也可用环境变量 `DISCORD_BOT_TOKEN` 提供。

## 🚀 运行要求

- **Node ≥ 22.19**（原生 fetch + WebSocket，零额外依赖）
- Discord 开发者后台：创建 Bot、开启 **Message Content Intent**（收消息必需）
- Gateway intents：`Guilds | GuildMessages | DirectMessages | MessageContent`

## 🧪 测试

```bash
npm test          # 12 个用例（transport/rest/gateway、draft、lanes、dispatch、adapter）
npm run typecheck # tsc 0 error
```

## 📚 调研笔记

`docs/openclaw-research/09-15`：Discord 扩展总览 / 传输层 / 草稿流 / 分块+Markdown / 入站 / 出站+线程 / Telegram→Discord 映射。

## 边界（safety boundary）

- 只处理配置允许的频道；`ignoreBots` 默认忽略其他 bot 消息
- 不执行终端控制；只做消息流式与回复（与 OpenClaw 同理念）
- 2000 字符硬上限：超长文本按块拆分（默认 1900 留余量）
