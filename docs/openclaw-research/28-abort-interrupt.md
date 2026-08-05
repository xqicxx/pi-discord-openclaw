# 28 — 任务中断机制调研：OpenClaw 的 abort 触发词 + 真正中断

> 任务：bot「超时但没停止」——watchdog 发中止消息但 agent 继续跑；用户发「全部暂停」无效。
> 调研 OpenClaw 怎么中断正在运行的任务，性能第一。

## 1. 问题复盘（现场时间线）

- 20:53:44 bot 发「任务超时已中止（连续 90s 无活动）」——但 tmux 里 agent 还在跑（fabric 调 agently-cli auth login 卡住）
- 21:01:13 用户执行 /skill-agently-mail，又卡在交互命令
- 21:01:44 用户发「全部暂停」——被当普通消息排进队列，旧任务继续跑，bot「没动静」

根因：
1. watchdog abortTurn 只清理 bridge turn 状态，**没有调用 pi 的 ctx.abort()** → agent 根本没停
2. 没有 abort 触发词拦截：用户发「暂停/停止」等中文 → 当普通消息发 agent
3. turn watchdog 90s 太激进：模型 thinking max 长时间无 delta 事件会误杀

## 2. OpenClaw 中断机制（源码位置）

### 2.1 abort-primitives.ts（触发词识别）

文件：dist/abort-primitives-Eo9j6lAM.js（src/auto-reply/reply/abort-primitives.ts）

- ABORT_TRIGGERS：多语言停止词集合
  stop / esc / abort / exit / interrupt / halt / detente / 停止 / 停下来 / 暂停 /
  やめて / 止めて / रुको / توقف / стоп / ... + 短语（stop the agent、please stop...）
- normalizeAbortTriggerText：归一化（小写、去尾部标点、空白折叠）
- isAbortRequestText(text)：`/stop` 或触发词命中 → true
- ABORT_MEMORY（LRU 2000 上限）：abort 去重记忆（同一请求不重复中断）
- 调用者：message-handler.preflight / get-reply / chat-abort / abort

### 2.2 abort 执行链（abort-J462pIQw.js）

abortSessionRunTargetWithOutcome：
1. replyRunRegistry.abort(key) —— 中断正在运行的 reply（AbortSignal 贯穿 → agent 真正停止）
2. abortEmbeddedAgentRun(sessionId) —— 中断嵌入式 agent run
3. markSessionAbortTarget / resolveSessionAbortTarget —— session 标记
4. clearSessionQueues —— **清空排队消息**
5. setAbortMemory —— 去重记忆

### 2.3 abort-cutoff（abort-cutoff-DfANjv5i.js）

- abort 时记录 cutoff（messageSid/timestamp）持久化到 session
- shouldSkipMessageByAbortCutoff：后续 **MessageSid <= cutoff 的旧消息直接跳过**
- 防止 abort 后积压的旧消息继续被处理

### 2.4 chat-abort（ChatRun 超时）

- DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60s
- 超时范围：min 2min，max 24h（可配 timeoutMs）
- 超时 → AbortController.abort() → TimeoutError → 真正中断 agent 调用
- isChatStopCommandText = isAbortRequestText

### 2.5 消息 preflight 拦截

message-handler.preflight：消息处理早期检查 isAbortRequestText，
命中 → 直接走 abort 流程，**不进 agent**（不消耗模型调用）

## 3. 与 pi-discord-openclaw 差距

| 维度 | openclaw | 我们（现状） |
|---|---|---|
| 中断执行 | replyRunRegistry.abort + abortEmbeddedAgentRun（真中断） | 只清 bridge 状态，不调 pi ctx.abort() |
| 触发词 | 多语言表 + /stop，preflight 拦截 | 只有 /stop 文本命令 |
| 队列 | clearSessionQueues 清空 | followUp 排队等旧任务跑完 |
| 旧消息 | abortCutoff 跳过 | 无 |
| 超时 | ChatRun timeoutMs + 60s grace，min 2min | turn watchdog 90s 无 grace，误杀 |

## 4. 实现方案（本任务，性能第一）

1. bridge 注入 abort 能力：OpenclawBridge 加 onAbort 回调 + abortCurrentTurn()；
   abortTurn/abortCurrentTurn 调用 onAbort（index.ts 设 bridge.onAbort = () => ctx.abort()）→ 真正中断 pi agent
2. abort 触发词拦截（移植 openclaw ABORT_TRIGGERS）：messageCreate 检测到停止词
   （stop/停止/暂停/abort/exit/...）→ bridge.abortCurrentTurn() + 回复「已中止」+ 不进 agent
3. watchdog 优化：90s → 180s（thinking max 长思考不误杀），abort 时真正中断
4. 队列清理：abort 后丢弃 pi 侧排队 followUp（pi 无清队列 API，靠 ctx.abort + 后续消息正常处理）
