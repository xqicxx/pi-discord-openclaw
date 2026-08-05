# 26 — openclaw Discord 思考/回答区分机制调研（思维链折叠摘要）

> 背景：用户反馈 Discord 输出里思考内容与输出内容"一团，费眼睛"。0.1.15 试过
> blockquote（> 🧠）方案不满意，要求调研 openclaw 原版做法后修改。

## 1. openclaw 的 reasoning 双模式（message-handler.process）

reasoningLevel（agent 配置 reasoningDefault / session 级，默认 off）：
- **on（durable）**：思考作为**独立 blockquote 消息**投递 —— formatDiscordReasoningQuote：
  每行 > 前缀 + 首行 🧠，发完 persistentReasoningDelivered = true
- **stream（窗口式）**：思考注入 progress 方块，🧠 _斜体_ 行原地流动更新
- 默认 off：思考完全不显示

## 2. progress 方块（createChannelProgressDraftCompositor + draft-preview controller）

- reasoningLinePrefix = "🧠 "（**无 blockquote**）；commentaryLinePrefix = "💬 "
- 思考行 = 🧠 _斜体_（formatReasoningProgressDisplayLine 保斜体平衡，maxChars 默认 120）
- 工具行 = 🛠️ label: detail（resolveToolDisplay emoji 映射）
- 同一消息（draft stream，throttle 1200ms），思考行与工具行交错（工具行到达 commit 思维行）
- **markFinalReplyStarted**：最终回答开始时冻结 progress（不再渲染新思考/工具行）
- **markFinalReplyDelivered**：回答投递后 progress 完全停止

## 3. 最终回答投递时（核心区分机制！）

if (isFinal && isProgressMode && hasProgressDraftStarted && !isError) {
  if (persistentReasoningDelivered) {
    // durable 思考已独立投递 → progress 消息【删除】，单独发摘要消息
    await draftStream.clear();
    await deliverDiscordReply([{ text: buildProgressSummaryLine() }]);
  } else {
    // 流式思考 → progress 消息【编辑成折叠摘要】（思考细节全部消失）
    await draftStream.seal();
    await editMessageDiscord(channelId, draftId, { content: buildProgressSummaryLine() });
  }
}

**buildProgressSummaryLine**（-# 前缀 = Discord list item 小字灰色文本）：
-# 🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 45s

计数语义：
- progressReasoningSteps：closePendingWindowThought（工具行 commit 或折叠时，每段思考窗口闭合 +1）
- progressToolCalls：工具行 start 计数
- ⏱️ 从 turn 开始到折叠的秒数

## 4. 最终呈现（用户看到的）

1. 思考期间：progress 消息（🧠 斜体行 + 🛠️ 工具行）实时流动
2. 回答投递瞬间：progress 消息**变成一行小字摘要**（-# 🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 45s）
3. 回答：干净的独立消息（无前缀、无分隔线、无思考混入）

**区分的关键不是格式花哨，而是"思考过程被折叠成低调摘要"**——频道里不残留思考细节。

## 5. 我们项目（pi-discord-openclaw）的差距

| 项 | openclaw | 我们 0.1.15 | 修改 |
|---|---|---|---|
| 思考行 | 🧠 _斜体_（无 blockquote） | > 🧠 _斜体_（blockquote） | 去掉 >，恢复 🧠 _斜体_ |
| 回答前分隔线 | 无 | ━━━ 分隔线 | 去掉 |
| 回答投递后 progress | 折叠成 -# 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns | ✅ N 个工具调用完成（误导） | 按 openclaw 格式折叠 |
| 思考段计数 | 每段窗口闭合 +1（commitThinking） | 只计 1（===0 才 +1） | commitThinking 时 +1 |
| durable reasoning | 独立 > 🧠 blockquote 消息 | 已有 formatDiscordReasoningQuote（reasoning-lane） | 保留 |

## 6. 实施

1. progress-lane.ts：renderProgressLine 思考行去 blockquote；endTurn 始终折叠摘要（-# 格式）；commitThinking 递增 reasoningSteps
2. index.ts：formatAnswerText 去掉分隔线闭包
3. 测试：progress-lane.test 更新断言（无 > 前缀；折叠摘要 -# 格式；多段思考计数）
