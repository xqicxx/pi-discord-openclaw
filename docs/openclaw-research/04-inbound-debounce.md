# OpenClaw 调研笔记 04：inbound debounce（连续输入）

> 位置：extensions/telegram/src/bot-handlers.inbound-debounce.runtime.ts

## 作用

连续输入合并：短时间内的多条消息 debounce 成一批，避免打断 agent、减少无意义 turn。

## 机制

### 双 lane（debounce 分类）

| lane | 触发条件 | debounce 时长 |
|---|---|---|
| `default` | 普通文本（无媒体） | 配置值（默认 1000ms） |
| `forward` | 转发消息（有 forward_origin 等） | 80ms（快速合并转发突发） |

### createInboundDebouncer 配置

```ts
{
  debounceMs,               // 默认窗口
  serializeImmediate: true, // 立即串行化
  resolveDebounceMs,        // 按 lane 取时长
  buildKey: (e) => e.debounceKey,
  shouldDebounce,
  onFlush: (entries) => { ... }  // 合并后处理
}
```

### onFlush 合并逻辑

1. **单条**：直接 processMessageWithReplyChain（原消息+结构化 forward 元数据）
2. **多条**：joinTelegramTextParts(entries, "\n") 合并文本；flatMap 合并媒体
3. 空内容+无媒体 → 释放 dedupe claims，标记 skipped
4. 合成 synthetic text message / context 发送给 agent
5. settleSpooledReplayParticipants 结算参与者

### 防重复

- dispatchDedupeClaims（merge/release）避免同一条消息重复处理
- spooledReplayParticipants 处理重放

## 移植要点

- pi-telegram inbound 里加 debouncer：短消息合并 + 忙时排队
- follow-up 注入：agent 忙时把合并后的消息作为 follow-up 排队
- KeyedAsyncQueue（bot-handlers.inbound-text.runtime.ts）保证按 key 串行
