# OpenClaw 调研笔记 17：Reaction Ack（收到消息的表情确认）

> 用户问：OpenClaw 看到消息不是会有个表情吗？—— 是的，有完整的 reaction ack + 状态表情机制。

## 1. 机制总览（两层）

**① Ack Reaction（收到消息立即确认）**：bot 对收到的用户消息加一个表情，表示"看到了"
**② Status Reactions（处理状态表情）**：处理过程中不断更新表情反映当前阶段

## 2. Ack Reaction（ack-reactions.ts + process-reactions.ts）

- 默认表情：**👀**（src/agents/identity.ts: DEFAULT_ACK_REACTION = "👀"）
- 触发：入站消息记录后立即 `queueInitialAckReactionAfterRecord` → 加 ackReaction
- 门控：`shouldAckReactionGate({ scope, isDirect, isGroup, wasMentioned, ... })`
  - scope 配置：`messages.ackReactionScope`：`group-mentions`（默认）/ `group-all` / `direct` / `all` / `off`
  - 群组默认只对 @提及 的消息加 ack；DM 默认加
- REST：PUT /channels/{id}/messages/{mid}/reactions/{emoji}/@me（reactMessageDiscord）

## 3. Status Reactions（status-reactions.ts 状态机）

`createStatusReactionController`：状态转移，默认表情（DEFAULT_EMOJIS）：

| 状态 | 方法 | 默认表情 |
|---|---|---|
| 排队 | setQueued | 👀 |
| 思考 | setThinking | 🧠 |
| 工具 | setTool | 🛠️ |
| 编码 | setCoding | 💻 |
| 网络 | setWeb | 🌐 |
| 完成 | setDone | ✅ |
| 错误 | setError | ❌ |
| 卡住(软/硬) | stallSoft/stallHard | ⏳/⚠️ |
| 压缩 | setCompacting | 🗜️ |

- 时序（message-handler.process.ts）：
  1. 入站 → queueInitialAckReaction（👀）
  2. 回复开始 → `reactions.controller.setThinking()`（🧠）
  3. 工具执行 → setTool（🛠️）
  4. 完成 → `finish()` → setDone（✅）/ setError（❌）
- finishWithEmoji：应用终态表情 + 移除其他活跃表情（`removeActiveEmojis({ keepEmoji })`）
- 可配置：`messages.statusReactions.enabled`（默认 true）；表情可覆盖 `messages.statusReactions.emojis`

## 4. 我们 pi-discord-openclaw 的处理进度

**状态：❌ 未实现**（当时列为 P2 后置项）

- transport：无 reaction API（只有 createChannelMessage / editChannelMessage / deleteChannelMessage / sendChannelTyping）
- src：无 ackReaction / setReaction / statusReaction 逻辑
- 笔记 13/14 已记录为 P2：`反应 ack（✅）` 后置

## 5. 实现计划（若要做）

1. transport：`createChannelReaction(channelId, messageId, emoji)` + `deleteChannelReaction(...)`（REST PUT/DELETE reactions/{emoji}/@me）
2. src/feedback/ack-reactions.ts：AckReactionAdapter（setReaction/removeReaction）+ 默认 👀
3. index.ts 入站：MESSAGE_CREATE 过滤通过后立即加 👀；回复开始 setThinking（🧠）；agent-end setDone（✅）
4. 门控：仅对 @提及/DM 加 ack（简化版：`mentions` 含 bot 或 DM 才加）
5. 测试：transport reaction + ack 状态机
