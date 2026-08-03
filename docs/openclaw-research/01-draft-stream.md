# OpenClaw 调研笔记 01：draft-stream.ts（流式草稿核心）

> 位置：extensions/telegram/src/draft-stream.ts

## 作用

单条 Telegram 消息持续 `editMessageText` 实现打字机式流式输出。

## 关键常量

| 常量 | 值 | 说明 |
|---|---|---|
| DEFAULT_THROTTLE_MS | 1000 | 编辑节流（防 Telegram flood） |
| MAX_CONSECUTIVE_PREVIEW_FAILURES | 3 | 连续预览失败上限 |
| MAX_PREVIEW_FLOOD_SUSPEND_MS | 60000 | flood 暂停上限 |
| MIN_PREVIEW_DWELL_MS | 4000 | 预览框最少停留 |
| TELEGRAM_TEXT_CHUNK_LIMIT | 4096 | Telegram 单消息限制 |
| TELEGRAM_RICH_TEXT_LIMIT | - | 富文本限制 |

## 核心结构

```ts
createTelegramDraftStream(params: {
  chatId, throttleMs, maxChars, minInitialChars,
  replyToMessageId, thread, richMessages, ...
}): TelegramDraftStream
```

返回对象：
- `update(text)` — 排队文本更新（节流编辑）
- `updateLazy(resolveText)` — 惰性取文本
- `updatePreview(preview)` — 更新预览（进度/思考框）
- `flush()` — 立即落盘
- `messageId()` — 当前消息 id
- `lastDeliveredText()` — 最后投递文本（diff 编辑用）
- `clear()` / `stop()` — 清理/停止
- `hasConsumedReplyTarget()` — 是否已占回复目标

## 机制要点

1. **分页**：planTelegramDraftPages 把长文本拆成多页（rich blocks / HTML chunks）
2. **节流**：throttleMs = max(250, 配置)，默认 1000ms
3. **首次发送**：sendMessage；**后续**：editMessageText
4. **预览**：独立的 preview 消息（进度框），teardown 时延迟删除（MIN_PREVIEW_DWELL_MS）
5. **失败重试**：MAX_CONSECUTIVE_PREVIEW_FAILURES 内重试
6. **flood 处理**：读 retry_after，最长挂起 60s

## 移植要点（到 pi-telegram-openclaw）

- pi-telegram 的 delivery.ts 已有 sendView/editView/deleteView——可复用做 editMessage 机制
- 需要补：throttle 节流器、分页逻辑、预览消息、flood 退避
