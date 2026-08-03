# OpenClaw 调研笔记 07：agent 事件源头（工具/思考事件如何 emit）

> 位置：src/agents/cli-output.ts + src/agents/embedded-agent-subscribe.handlers.messages.ts

## 工具事件（cli-output.ts）

### emitToolStartOnce（去重后的工具开始事件）

```ts
function emitToolStartOnce(
  tracker: ToolUseTracker,   // startedIds / nameById / resultDeliveredIds
  toolCallId: string,
  name: string,
  kind: CliToolUseStartDelta["kind"],  // tool_use | server_tool_use | mcp_tool_use
  args: Record<string, unknown>,
  onToolUseStart?: (delta: CliToolUseStartDelta) => void,
)
```

- **去重**：startedIds 已含 toolCallId → 跳过（流式和最终 assistant 记录可能重复描述同一工具调用）
- 记录 nameById 供结果阶段用
- 回调 `onToolUseStart({ toolCallId, name, kind, args })`

### emitToolResultOnce（去重后的工具结果事件）

```ts
function emitToolResultOnce(
  tracker, toolCallId, isError, result,
  onToolResult?: (delta: CliToolResultDelta) => void,
)
```

- **去重**：resultDeliveredIds 已含 → 跳过
- 从 nameById 取工具名
- 回调 `onToolResult({ toolCallId, name, isError, result })`

### 触发时机

- Claude 工具块类型：tool_use / server_tool_use / mcp_tool_use
- 结果块：`*_tool_result` 且非 `tool_result`（assistant 回显或 user 结果）

## 思考事件（embedded-agent-subscribe.handlers.messages.ts）

```ts
onReasoningStream: (text: string) => void   // 每增量触发，传完整累积值
onReasoningEnd: () => void
```

- 增量提取的完整 reasoning 值每次 delta 都 emit（测试用例证实：每次调用传全量文本）
- emitReasoningEnd 在推理结束时调用

## 对应 pi-telegram activity 事件（已存在）

| openclaw | pi activity（已有） |
|---|---|
| onToolUseStart | tool-start |
| onToolResult | tool-end |
| onReasoningStream | reasoning-delta |
| onReasoningEnd | reasoning-end |
| (text stream) | assistant-text-delta |

## 移植要点

pi 的 activity 事件已经完整覆盖 openclaw 需要的信号——**无需改 agent 侧**，只需在 bridge 渲染层实现 lane 模型。
