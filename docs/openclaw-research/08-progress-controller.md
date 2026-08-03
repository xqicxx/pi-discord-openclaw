# OpenClaw 调研笔记 08：progress-controller + lane deliverer

> 位置：bot-message-dispatch-progress.ts + lane-delivery-text-deliverer.ts

## TelegramProgressController（进度控制器）

### buildTelegramThinkingProgressLine

```ts
function buildTelegramThinkingProgressLine(progressTokens: number): ChannelProgressDraftLine {
  return { id: "reasoning:token-progress", kind: "item", icon: "🧠",
           label: `Thinking… (~${tokens} tokens)`, text: `🧠 Thinking… (~${tokens} tokens)` };
}
```

- 思考期间显示 🧠 Thinking… (~N tokens) 行，实时更新 token 数
- id 固定 `reasoning:token-progress`（增量更新同一行）

### buildTelegramTextToolProgressLine

```ts
{ kind: "item", label: "", text, prefix: false }
```

- 纯文本工具进度（无图标）

### createTelegramProgressController(params)

- accountId / chatId / draft / streamMode / streamReasoningInProgressDraft / telegramCfg / threadId
- 负责：进度窗口（ephemeral）+ 折叠摘要（collapse summary）
- 工具事件 → 进度行；完成后保留摘要或删除

### 摘要（progress-summary.ts）

- createTelegramProgressSummaryTracker：跟踪已完成工具，生成折叠摘要
- formatTelegramProgressSummaryLine：`✅ N tools completed` 之类的汇总行

## LaneDeliverer（lane 文本投递）

### LaneName

```ts
type LaneName = "answer" | "reasoning";
```

### DraftLaneState

```ts
{
  stream: TelegramDraftStream | undefined,
  lastPartialText: string,
  hasStreamedMessage: boolean,
  finalized: boolean,
  retainedPromptContextPages: Array<{ messageId, text }>,
}
```

### createLaneTextDeliverer(params)

- lanes: Record<LaneName, DraftLaneState>
- applyTextToPayload：把文本应用到回复 payload

### 投递结果类型

```ts
type LaneDeliveryResult =
  | { kind: "preview-finalized"; delivery: { content, messageId, buttonsAttached?, receipt } }
  | { kind: "preview-retained" | "preview-updated" | "sent" | "skipped" };
```

### 关键逻辑

- **finalized**：流式结束后定型（保留最终文本 + 回执）
- **retained**：分块时保留旧页
- **selectLongerFinalText**：处理截断的最终文本（流式中途截断 vs 完整候选）

## 移植要点

- pi-telegram 的 delivery 层（sendView/editView）已具备 edit 能力
- 需要补：answer/reasoning 双 lane 的 DraftLaneState、finalized 定型逻辑、进度折叠摘要
