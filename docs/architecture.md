# pi-telegram-openclaw 架构设计

基于 openclaw `extensions/telegram`（draft-stream / reasoning-lane-coordinator / progress-draft-preview / lane-delivery）调研整理。

## 事件流总览

```
pi agent 事件                           telegram-openclaw 扩展                 Telegram
─────────────────────                  ──────────────────────                 ────────
agent-start      ──► 创建 turn 上下文 ──► sendChatAction("typing")
reasoning-delta  ──► reasoning lane ────► 发送/编辑 🧠 思考消息
assistant-text-delta ─► answer lane ────► 发送/编辑回答消息（打字机）
tool-start       ──► progress lane ────► 追加 `` `tool: running` `` 行
tool-update      ──► progress lane ────► 更新该行
tool-end         ──► progress lane ────► 标记 ✓
assistant-segment──► answer lane ──────► 最终回答定型
reasoning-end    ──► reasoning lane ───► 思考消息最终化
agent-end        ──► 收尾 ─────────────► 清理预览/发送完成
agent-settled    ──► 释放 turn
```

## 核心模块

### lanes/（通道模型）

每个 turn 维护 3 条 lane：

```ts
type LaneName = "reasoning" | "answer" | "progress";

interface DraftLaneState {
  messageId?: number;          // 已发送的 Telegram 消息
  hasStreamedMessage: boolean; // 是否已开始流式
  lastDeliveredText?: string;  // 最后已投递文本（用于 diff 编辑）
  retainedPromptContextPages: string[]; // 分块保留
}
```

- **reasoning lane**：独立消息，`🧠 _..._` 斜体渲染，可折叠
- **answer lane**：主消息，流式 editMessage
- **progress lane**：代码块 ` \`tool: name\` ` 行列表

### draft/（流式草稿引擎）

核心：`createDraftStream(text)` → 返回 `{ update, flush, messageId }`。

关键实现（移植自 openclaw draft-stream.ts）：

```ts
class DraftStream {
  private throttleMs = 1000;
  private pendingText = "";
  private timer?: NodeJS.Timeout;

  update(text: string) {
    this.pendingText = text;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.throttleMs);
  }

  async flush() {
    this.timer = undefined;
    const text = this.pendingText;
    // 分块（Telegram 4096 限制）
    const chunks = splitChunks(text, 3800);
    if (!this.messageId) {
      this.messageId = await sendMessage(chunks[0]);
    } else {
      await editMessage(this.messageId, chunks[0]);
    }
    // 后续分块作为新消息
  }
}
```

### reasoning/（思考流）

```ts
// 从流文本中提取 thinking 标签内容（移植 openclaw）
function extractThinkingFromTaggedStreamOutsideCode(text: string): string;
// 渲染：🧠 + 斜体
function markReasoningMessage(formatted: string): string;
// 是否处于思考标签内（部分标签处理）
function isPartialReasoningTagPrefix(text: string): boolean;
```

处理流程：
1. `reasoning-delta` 累积到 reasoning lane
2. 每 1s 节流发送/编辑 🧠 消息
3. `reasoning-end` 最终化（保留或按配置折叠）
4. 若 reasoning 为空则跳过

### progress/（工具进度）

```ts
interface ProgressLine {
  toolName: string;
  state: "running" | "done" | "error";
  detail?: string;
}

// 渲染为等宽行
const renderLine = (l) => \` \`${l.toolName}: ${l.state === "done" ? "✓" : l.state === "error" ? "✗" : "running"}\` \`;
```

- `tool-start`：追加行，若 progress 消息不存在则发送
- `tool-update`：更新行 detail
- `tool-end`：标记 ✓，若全部完成则延迟删除或保留摘要

### inbound/（连续输入）

```ts
// 移植 openclaw createInboundDebouncer
class InboundDebouncer {
  private pending: TelegramDebounceEntry[] = [];
  push(entry, debounceMs = 1000) {
    this.pending.push(entry);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), debounceMs);
  }
  flush() {
    // 合并为一条 user 消息发送给 agent
    // 若 agent 忙则排队 follow-up
  }
}
```

## 与 pi-telegram 现有 delivery 的整合

pi-telegram 的 `TelegramDeliveryRuntime` 已提供：

- `sendView` / `editView` / `deleteView`（编辑消息）
- `sendChatAction`（typing）
- `TelegramDeliveryRenderedChunk`（文本 + parseMode）

openclaw 模式复用它，新增：

1. `openclaw-style` 渲染器：把 activity 事件渲染为 lane 视图
2. 多 view 管理：reasoning 消息 + answer 消息 + progress 消息 各一个 view
3. turn 生命周期：agent-start 创建 lanes，agent-end 收尾

## 事件订阅（pi 扩展 API）

```ts
import type { ExtensionAPI } from "pi-coding-agent";

export default function (api: ExtensionAPI) {
  api.hooks.onActivity((event) => {
    switch (event.type) {
      case "reasoning-delta": handleReasoningDelta(event); break;
      case "assistant-text-delta": handleAnswerDelta(event); break;
      case "tool-start": handleToolStart(event); break;
      case "tool-update": handleToolUpdate(event); break;
      case "tool-end": handleToolEnd(event); break;
      case "agent-end": finalizeTurn(event); break;
    }
  });
}
```

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `streaming.mode` | `progress` | `progress`=工具进度优先；`partial`=直接流式回答；`full`=两者 |
| `streaming.throttleMs` | 1000 | 编辑节流（防 flood） |
| `streaming.chunkSize` | 3800 | 单消息最大字符 |
| `reasoning.enabled` | true | 是否显示 🧠 思考消息 |
| `reasoning.style` | `🧠 italic` | 思考渲染样式 |
| `toolProgress.enabled` | true | 是否显示工具进度 |
| `toolProgress.maxLines` | 8 | 进度最大行数 |
| `inbound.debounceMs` | 1000 | 连续输入合并窗口 |

## 里程碑

- [ ] M1: 扩展骨架 + activity 订阅 + lane 模型
- [ ] M2: answer lane 流式编辑（打字机）
- [ ] M3: reasoning lane（🧠 思考消息）
- [ ] M4: progress lane（工具进度）
- [ ] M5: inbound debounce（连续输入）
- [ ] M6: 分块 + 失败重试 + flood 退避
- [ ] M7: 发布 npm + 分享
