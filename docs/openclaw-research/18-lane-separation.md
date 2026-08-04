# OpenClaw 调研笔记 18：Lane 分离 + 可开关配置（穿插问题根因）

> 用户反馈：回复直接穿插在思考跟工具调用里面；openclaw 文档有些功能可开关，要求一并移植。

## 1. 穿插问题根因（对照 openclaw lane 控制器）

**我们的实现（错）**：dispatch.ts 中 reasoning 和 progress 共用同一个 preview 消息
- ReasoningLane → this.draft.updatePreview（🧠 思考进 preview 消息）
- ProgressLane → this.draft.updatePreview（🔧 工具行也进同一条 preview 消息！）
- answer → this.answer.updateDelta（另一条消息）
- 结果：思考被工具行覆盖、回答穿插其间

**openclaw 原生（对）**：bot-message-dispatch-draft.ts 三条独立 lane
```ts
const lanes: Record<LaneName, DraftLaneState> = {
  answer: createDraftLane("answer", canStreamAnswerDraft),
  reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
};
// progress 也有独立 preview（progress-draft-preview.ts）
```

关键机制：
1. **每条 lane 一个独立 DraftStream（独立消息）**：answer/reasoning/progress 各一条消息
2. **splitTextIntoLaneSegments**：把模型文本按 reasoning/answer 拆段，分发给对应 lane
3. **rotateLaneForNewMessage / repositionLaneForNewMessage**：新回答块到来时轮换/重定位消息（保留旧文本或开新消息）
4. **prepareAnswerLaneForToolProgress**：工具进度占用 answer lane 时标记 activeAnswerDraftIsToolProgressOnly，回答文本到来时轮换新消息
5. **progress 模式**：一个可编辑状态草稿直到最终投递；answer 文本不轮换它（streamMode === "progress" 时）

## 2. 可开关配置（openclaw 文档 §Live stream preview + config schema）

`channels.discord.streaming` 可开关项：

| 配置 | 值 | 默认 | 作用 |
|---|---|---|---|
| mode | off/partial/block/progress | progress | 流式模式 |
| preview.toolProgress | bool | true | partial 模式显示工具行 |
| preview.commandText | raw/status | raw | 工具行显示命令原文或仅标签 |
| preview.chunk | {minChars,maxChars,breakPreference} | — | block 分块 |
| progress.toolProgress | bool | true | progress 模式显示工具行 |
| progress.commentary | bool | false | 在进度草稿中显示原始 assistant 评论 |
| progress.narration | bool | true | 显示最新 preamble/narration 状态头 |
| progress.maxLines | int | — | 最大行数 |
| progress.maxLineChars | int | 120 | 每行字符预算（词边界截断，命令保留后缀） |
| progress.commandText | raw/status | raw | 命令文本模式 |
| progress.render | text/rich | — | 渲染方式 |
| progress.label / labels | string/false/list | — | 状态标签 |

`messages` 可开关：
- `messages.ackReaction`（默认 👀）、`messages.ackReactionScope`（group-mentions/...）
- `messages.statusReactions.enabled`（默认 true）、emojis 覆盖

## 3. 移植计划（pi-discord-openclaw）

1. **三条独立 lane**：TurnManager 持有 answer/reasoning/progress 三个独立 DraftStream（各自独立消息）
2. **progress 模式语义**：answer 文本不轮换 progress 草稿；工具行独立
3. **配置开关**（discord.json openclawStyle 扩展）：
   - streaming: { mode, toolProgress, commentary, narration, maxLineChars, commandText }
   - reasoning: { enabled, style }
   - toolProgress: { enabled, maxLines }
   - inbound: { debounceMs }
   - messages: { ackReaction, statusReactions }
4. 测试：lane 独立性（三消息并存）+ 配置解析
