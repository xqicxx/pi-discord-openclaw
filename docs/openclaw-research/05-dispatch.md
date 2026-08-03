# OpenClaw 调研笔记 05：dispatch 主链路（事件→消息）

> 位置：extensions/telegram/src/bot-message-dispatch-*.ts

## 组成

| 文件 | 职责 |
|---|---|
| bot-message-dispatch.ts | 总入口：turn 生命周期 |
| bot-message-dispatch-draft.ts | 草稿 lane 控制器（TelegramDraftController） |
| bot-message-dispatch-progress.ts | 进度控制器（TelegramProgressController） |
| bot-message-dispatch-delivery.ts | 投递（分块/频道/回复） |
| bot-message-dispatch-session.ts | 会话管理 |
| bot-message-dispatch-turn.ts | turn 状态 |
| bot-message-dispatch.types.ts | 类型（TelegramReasoningLevel 等） |

## DispatchContext

```ts
{
  chatId, ctxPayload,
  dispatchStartedAt,
  draft: TelegramDraftController,   // 回答草稿
  progress: TelegramProgressController, // 工具进度
  streamMode: TelegramStreamMode,   // partial/full/progress
  isDispatchSuperseded: () => boolean,
  ...
}
```

## 流式模式（streamMode）

| 模式 | 行为 |
|---|---|
| `progress` | 工具进度草稿优先（默认），回答文本流式编辑 |
| `partial` | 直接流式回答文本（无进度草稿） |
| `full` | 两者都要 |

## 关键机制

1. **transcriptMirrorTurnId**：`${chatId}:${MessageSid ?? message_id ?? startedAt}` 标识 turn
2. **isDispatchSuperseded**：新消息到达时判定旧 turn 是否被取代
3. **draft 控制器**：manage answer/reasoning 两个 lane + rotation（轮换）
4. **final text 选择**：selectLongerFinalText 处理截断（truncated final vs candidate）
5. **分块**：超过限制的文本分多页发送/保留

## 移植要点

- pi-telegram 的 delivery 已有 sendView/editView/deleteView，可作为 draft 控制器底座
- 需要补：lane 概念（answer/reasoning/progress）、turn 生命周期（agent-start → agent-end）
- 用 activity 事件（pi 已有 reasoning-delta/tool-start 等）驱动
