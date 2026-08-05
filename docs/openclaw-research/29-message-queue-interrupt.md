# 29 — 运行中收到消息：OpenClaw 的队列/中断策略调研

> 任务：bot 处理任务时收到新消息，旧任务卡住 → 新消息排队等旧任务跑完（「没动静」）。
> 调研 OpenClaw 怎么处理「agent 正在运行时的入站消息」，性能第一。

## 1. 问题复盘

- 我们现状：InboundDebouncer（250ms 合并）→ pi.sendUserMessage(text, { deliverAs: "followUp" })
- followUp = 排队等旧任务全部完成 → 旧任务卡住（如交互命令）时，新消息永远排队 → bot「没动静」

## 2. OpenClaw 入站消息处理模型

### 2.1 核心决策：resolveActiveRunQueueAction（typing-mode-C35PNSLH.js）

伪代码：
  function resolveActiveRunQueueAction(params) {
    if (!params.isActive) return "run-now";            // agent 空闲 → 立即处理
    if (params.isHeartbeat) return "drop";             // 心跳/系统事件 → 丢弃
    if (params.resetTriggered) return "run-now";       // reset 指令 → 立即
    if (params.shouldFollowup) return "enqueue-followup"; // 显式队列模式 → 排队
    return "run-now";                                  // 默认 → 立即处理（中断旧任务）
  }

### 2.2 shouldFollowup 判定（get-reply-OTG64ybi.js）

  shouldFollowup = !resetTriggered && (
    (isRoomEvent && isActive) ||                        // 群聊事件在忙时 → 排队
    resolvedQueue.mode === "steer" ||
    resolvedQueue.mode === "followup" ||
    resolvedQueue.mode === "collect"
  )

- DM 场景 + 默认（无 /queue 指令）→ shouldFollowup = false → **run-now**
- 结论：**OpenClaw 默认在 agent 忙时收到新消息 = 立即处理（中断旧任务），不是排队！**

### 2.3 队列模式（queue/directive.ts）

- interrupt（abort）：直接中断当前
- steer：排队，当前工具调用执行完后插入
- followup：排队等全部完成
- collect（coalesce）：合并多条输入
- drop 策略：old（丢最旧）/ new（丢最新）/ summarize（合并摘要）
- cap：队列容量上限；debounceMs：合并窗口
- 用户可通过 /queue 指令配置（debounce/cap/dropPolicy）

### 2.4 并发准入：interruptSessionWorkAdmissions（session-lifecycle-admission-DfdITEs1.js）

  function interruptSessionWorkAdmissions(params) {
    // 收集当前 session 的所有活跃 work admission
    for (const admission of admissions) admission.interrupt?.();  // 逐个中断
    await Promise.all(admissions.map(a => a.released));           // 等全部释放
    // timeoutMs 可配：超时强制继续
  }

- **同一 session 单任务串行**：新任务进入前，先中断旧任务的所有活跃工作（工具/子任务），
  等 released 后才继续 —— 这是「运行中收到新消息」的并发控制核心

### 2.5 isActive 判定

- replyOperationActive = isReplyRunActiveForSessionId(...)（reply 运行注册表）
- embeddedAgentRuntime.isEmbeddedAgentRunActive(...)（嵌入式 agent run）
- isOwnPreDispatchOperationSession 排除自身预分发

## 3. 与 pi-discord-openclaw 对比

| 维度 | openclaw | 我们（现状） |
|---|---|---|
| agent 忙时新消息 | run-now（中断旧，立即处理） | followUp 排队等旧完成 |
| 队列模式 | interrupt/steer/followup/collect + /queue 指令 | 只有 followup |
| 并发控制 | session 级 admission，中断旧等释放 | 无（排队） |
| 合并 | collect 模式 | debounce 250ms |
| 丢弃 | heartbeat drop / drop 策略 | 无 |

## 4. 实现方案（本任务，性能第一）

1. bridge 加中断策略：debouncer onFlush 时若 this.turn 活跃 → onInterrupt（宿主
   ctx.abort() 中断当前 agent）+ 立即处理新消息（对齐 openclaw run-now 默认）
2. index.ts：onInterrupt = ctx.abort()；新消息 sendUserMessage 用 steer（当前工具
   执行完插入；abort 后 agent 停止即处理）替代 followUp（等全部完成）→ 新消息
   立即生效，不再排队等旧任务
3. 保留 abort 触发词（停止/暂停）显式中断；watchdog 兜底（真正中断，笔记 28）
4. 队列满/连续输入：debounce 250ms 已有合并（≈ collect 语义）
