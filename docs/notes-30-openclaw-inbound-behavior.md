# OpenClaw 连续输入与状态反馈机制调研（笔记 30）

> 2026-08-06 · 调研对象：openclaw 官方源码（/tmp/openclaw-src，v2026.7.1-2）+ 本地 dist + pi-discord-openclaw
> 背景：用户反馈 ① 连续输入时 ack 表情👀 误导以为"同时在处理"；② progress 方块（思考/工具）不消失；③ 消息截断。

## 一、openclaw 的 inbound 处理（源码实锤）

### 1. 入站去抖（messages.inbound）
- 配置：`messages.inbound.debounceMs`（全局）+ `byChannel`（按渠道覆盖）
- 解析：`resolveInboundDebounceMs` = override ?? byChannel ?? base ?? **0**（未配置=不合并）
- `shouldDebounceTextInbound`：带媒体/空文本/控制命令不合并
- Telegram 额外有 text-fragment 缓冲：间隙 ≤1500ms 且 message_id 连续 → 合并（上限 12 条 / 50000 字符）

### 2. 忙时队列（messages.queue）—— 连续输入的核心
`resolveQueueSettings`（dist queue-C2HxHfMa.js）：
- **默认 mode = "steer"**（不是 interrupt！）
- queue debounce 默认 **500ms**
- cap 默认 **20**，超限 drop 默认 **"summarize"**（摘要丢弃最旧）

四种 mode（`src/config/types.queue.ts`）：
| mode | 行为 |
|---|---|
| steer（默认）| 新消息注入活跃 run（转向）|
| followup | 排队，当前 run 结束后处理 |
| collect | 批量合并兼容消息 |
| interrupt | abort 活跃 run，立即处理新消息 |

`resolveActiveRunQueueAction`（dist typing-mode-C35PNSLH.js）：
```js
if (!params.isActive) return "run-now";      // 无活跃 run → 立即
if (params.isHeartbeat) return "drop";
if (params.resetTriggered) return "run-now";
if (params.shouldFollowup) return "enqueue-followup";  // steer/followup/collect → 排队
return "run-now";                              // interrupt 模式 → 中断
```
run-now 时：`abortActiveRun`（abort 活跃 run）+ `waitForActiveRunEnd`（REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS 等它收尾）。

### 3. ack / 状态表情（status-reactions + ack-reactions）
- 👀 = **queued**（收到消息即设；排队中也显示它，直到被处理才切换 thinking）
- 🧠 thinking → 🛠️/💻/🌐/🏗️/🛫/💁（工具分类）→ ✅ done（停留 1.5s 后清理）/ ❌ error（2.5s）
- 10s 无活动 → ⏳ stallSoft；30s → ⚠️ stallHard
- 中间状态 debounce 700ms；终态保护（done/error 后忽略后续状态）
- 完成/错误后：`removeActiveEmojis`（移除除终态外全部）→ `restoreInitial` 回到 👀 或 clear

**关键结论：openclaw 的 👀 就是"排队中"语义**——连续输入时排队消息显示 👀 是正确行为，
不是"同时在处理"。pi-discord 移植了同一套（ack-reactions.ts 笔记 23）。

### 4. progress/预览方块生命周期（draft-preview / live preview）
- 流式 preview（思考+工具行）是**独立消息**，turn 结束（agent-end）时 finalize：
  `deliverFinalizableLivePreview` → "preview-finalized"（编辑为最终回复）/ "preview-retained"（保留）
- pi-discord：`deletePreviewIfDwelled`（MIN_PREVIEW_DWELL_MS=4s 停留后删除）
- **漏洞**：turn 异常中断（agent_end 不触发，如重启/被杀/pi 内部错误）→ preview 永不删除 → 方块残留

### 5. 分块 / 截断（chunk.ts）
- DEFAULT_CHUNK_LIMIT = 4000（长度模式，超限才切；不破坏换行/围栏）
- Discord：textChunkLimit 2000；`maxLinesPerMessage` 默认 **17 行**（软截断，超行截断显示）
- draft-streaming preview：minChars=200 / maxChars=800，按 paragraph/newline/sentence 断

## 二、pi-discord-openclaw 的问题与修复

### 已修（本次会话）
| 问题 | 根因 | 修复 |
|---|---|---|
| 连续输入互相打断 | 笔记 29 用 interrupt（abort 活跃 turn）+ debounce 100ms | 改为**排队**（pendingInputs，turn 结束 drainPending）+ debounce 800ms（对齐 openclaw steer 默认）|
| 表格是 ASCII/markdown | convertMarkdownTableToEmbed 未接线；index.ts 硬编码 "code" | 新增 `convertTextWithTables`：表格→embed、文字留 content，超限回退 code |
| 表直接没了 | editMessage **不透传 embeds**（PATCH 丢字段）| 三层透传：draft-stream → dispatch.ts → index.ts |
| 排队误导 | 👀=queued 语义未传达 | 见下方待办 |

### 待修/建议
1. **方块残留兜底**：beginTurn supersede 旧 turn 时清理旧 preview（agent 异常中断时 agent_end 不触发）
2. **排队可见性**：排队时给用户明确提示（openclaw 靠 👀，可增强为排队提示消息）
3. **maxLinesPerMessage（17 行）**：openclaw 有软截断，pi-discord 未移植（当前不截断，长回复靠 2000 分块）

## 三、经验教训
1. **别名/竞态 bug 的典型**：流式编辑 PATCH 不带 embeds → Discord 静默保留旧值/清空字段，API 层无报错，只能靠端到端对比发现。
2. **"必须第二次输入才有回应"根因**：不是输入被吞，而是每次输入都 abort 了正在跑的 turn（interrupt 语义）+ thinking max 思考慢。
3. **Embed 表格的限制**：≤10 embeds/条、≤25 fields/表、name ≤256、value ≤1024、合计 ≤6000 字符——超限必须回退 ASCII，不能硬发。
