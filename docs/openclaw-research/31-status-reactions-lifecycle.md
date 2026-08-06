# 31 — openclaw 表情生命周期与 Discord UX 调研（「没思考却有思考标签」根因）

> 背景：用户反馈 bot 思考/操作时发新消息，新消息下面挂着一串奇怪表情——
> 明明没被思考却有 🧠，观感生硬。要求调研 openclaw 等开源软件在 Discord 上的 UX 设计。

## 1. 根因（我们 fork 的实现 bug）

index.ts 旧实现：**每次收到消息都重建 statusReactions controller**（覆盖旧引用）：

```ts
// messageCreate:
const adapter = createDiscordReactionAdapter(rest, channelId, message.id);
statusReactions = createStatusReactionController({ adapter, ... });  // ← 覆盖！
void statusReactions.setQueued();
```

而 pi 的 agent 事件（thinking_delta / tool_execution_start / agent_end）是**全局的**，
驱动模块级最新引用。用户场景复现：

1. 消息 A → controller A（绑 A）→ ⏳ on A
2. agent_start → 👀 on A；thinking_delta → 🧠 on A；工具 → 🛠️ on A
3. **用户发消息 B**（bot 还在处理 A）→ controller B（绑 B）→ ⏳ on B
4. A 的 thinking 还在流 → **B.setThinking() → 🧠 挂到 B 上**（B 根本没被思考！）
5. agent_end → B.setDone → B 的表情清理；**A 的 ⏳👀🧠🛠️ 永久残留**（controller A 被丢弃）

## 2. openclaw 原版怎么做的（源码调研）

extensions/discord/src/monitor/message-handler.process-reactions.ts：

- **每条 inbound 消息创建独立 reaction runtime**（createDiscordMessageReactionRuntime），
  绑定该消息的 adapter；turn 的事件都路由到「这条消息」的 controller。
- **finish() 必清理**（openclaw finally 语义）：
  - 正常 → setDone（✅）→ restoreInitial（回到初始 ack，移除全部其他表情）
  - abort → restoreInitial
  - 错误 → setError（❌）→ restoreInitial
  最终每条消息**只剩一个 ack 表情**，绝无残留。
- 中间表情（🧠/🛠️）debounce 700ms；stall 10s/30s → ⏳/⚠️（src/channels/status-reactions.ts）。

## 3. 视觉/UX 设计（openclaw 在 Discord 上的体验提升）

| 项 | openclaw | 说明 |
|---|---|---|
| 思考默认 | **reasoningDefault off**（不显示思考）| 显示思考是显式配置（stream 注入 progress / durable 独立 blockquote）|
| 思考行 | `🧠 _斜体_`（无 blockquote）| 注入 progress 方块原地流动 |
| 工具行 | `🛠️ label: detail` | emoji 映射（tool-display-config）|
| 回答投递 | progress 方块**折叠为一行小字摘要** | `-# 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns`（-# = Discord 灰色小字）|
| 回答消息 | 干净独立（无分隔线）| 思考细节不残留频道 |
| 新版本视觉 | **Discord 原生 embed + accentColor（#5865F2 blurple）+ components 按钮** | extensions/discord/src/ui.ts、ui-colors.ts、embeds/components.builders |

## 4. 我们的修复（0.1.18）

1. **activeReactions / queuedReactions 分离**：turn 活跃时新消息只标 ⏳（排队），
   不进状态机 → 全局 thinking/tool 事件不会再错挂到未处理的消息；
   agent_start 时队首升级为 active；终态必清理 + 释放 active。
2. **思考内容真实性**：空 thinking delta 不触发 🧠；thinking_end 总内容 < 20 字符
   （形式化思考）→ removeThinkingNow 立即移除。
3. **thinkingMaxChars 独立**（默认 120）：maxLineChars: 40 不再把思考行切碎。

## 5. 遗留

- 既有失败测试 2 个（ack-reactions 时序用例、progress-lane「超长截断 300」——
  笔记 30 代码改 100 后测试未同步），与本次改动无关。
- openclaw 的 embed + components 交互（回答附按钮）未移植——后续可做。