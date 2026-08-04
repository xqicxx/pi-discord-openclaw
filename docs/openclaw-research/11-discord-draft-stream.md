# OpenClaw 调研笔记 11：Discord 草稿流（draft-stream.ts）

> 位置：extensions/discord/src/draft-stream.ts

## 常量

- DISCORD_STREAM_MAX_CHARS = 2000（消息硬上限）
- DEFAULT_THROTTLE_MS = 1200（vs Telegram 1000）
- DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] }

## 接口（DiscordDraftStream）

update(text) / flush() / messageId() / clear() / deleteCurrentMessage() / discardPending() /
seal() / stop() / **retarget(channelId)**（跨频道迁移草稿）/ **forceNewMessage("preserve"|"discard")** /
cleanupRetargeted()

## 核心机制

1. **sendOrEditStreamMessage**：有 messageId → editChannelMessage；无 → createChannelMessage（带 message_reference 回复 + allowed_mentions 禁提及 + flags suppressEmbeds）
2. **超限即停**：trimmed.length > maxChars → streamState.stopped = true（避免反复 API 失败）
3. **首次发送防抖**：minInitialChars（推送通知质量，未达阈值不首发）
4. **generation 代际**：streamGeneration 递增；在途 REST 结果若代际过期则丢弃（forceNewMessage 后旧 create 结果不覆盖新 turn 状态）；discardActiveCreate 标记删除陈旧首条
5. **生命周期基座**：createFinalizableDraftLifecycle（plugin-sdk/channel-outbound）：throttle 循环 + stop/clear/discardPending/seal 状态机，与 Telegram 版共用
6. **lastSentText 去重**：内容未变不发请求
7. **错误处理**：失败 → warn + stopped（可恢复轮次由 forceNewMessage 重置）

## 与我们 fork 的对照

我们 src/draft/draft-stream.ts（244 行）已实现 DraftStreamManager：
- 有 throttle + 编辑流 + 分块，但**缺**：minInitialChars、generation 代际防串、retarget、seal/forceNewMessage 语义
- chunkSize 默认 3800（Telegram 4096 安全值）→ Discord 需改 2000（或 1800 留余量）
- 发送走 telegram-api-adapter 的 sendMessage/editMessageText → 需换成 createChannelMessage/editChannelMessage
