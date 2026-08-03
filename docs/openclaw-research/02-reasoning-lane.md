# OpenClaw 调研笔记 02：reasoning-lane-coordinator.ts（思考流）

> 位置：extensions/telegram/src/reasoning-lane-coordinator.ts

## 作用

把模型流中的思考（reasoning）与回答（answer）分离：思考以 `🧠 _斜体_` 独立消息发送。

## 核心函数

### 1. splitTelegramReasoningText(text, isReasoning)

| 分支 | 行为 |
|---|---|
| `isReasoning !== true` | 整段作为 answerText 返回 |
| 空/部分标签前缀 | 返回 {}（等待更多内容） |
| 已是 🧠 消息 | 原样 reasoningText |
| 带 "Thinking" 头 | 重写为 🧠 消息 |
| 带 reasoning 前缀 | 原样 |
| 含 `<think>` 标签 | 提取 thinking → markReasoningMessage |
| 无标签 | formatReasoningMessage(全文) |

### 2. extractThinkingFromTaggedStreamOutsideCode(text)

- 正则匹配 `<think>...</think>` / `<thinking>` / `<thought>` / antml / mm: 标签
- 跳过代码块内的标签（findCodeRegions）
- 累积标签内文本返回

### 3. markReasoningMessage(formatted)

```ts
// "Thinking\n\n_body_" → "🧠 _body_"
// 去掉 CORE_THINKING_HEADER_RE (Thinking...\n)，在首个斜体行前加 🧠
```

### 4. isPartialReasoningTagPrefix(text)

- 判断是否处于未闭合标签前缀（如 `<think`、`<th`）→ 返回 true 表示还在流中

### 5. createTelegramReasoningStepState()

思考步骤状态机：

```
status: none → hinted → delivered
```

- noteReasoningHint：收到思考提示
- noteReasoningDelivered：思考消息已投递
- shouldBufferFinalAnswer：思考提示后缓冲最终回答（等思考消息落地）
- takeBufferedFinalAnswer：取缓冲回答
- resetForNextStep：每步重置

## 移植要点

- pi activity 事件已有 `reasoning-delta` / `reasoning-end`（活动类型自带），直接映射
- 渲染：🧠 + 斜体（HTML parse_mode）
- 需实现思考消息的独立 draft stream（与回答分 lane）
