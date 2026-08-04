# OpenClaw 调研笔记 19：思维链在方块里流动（progress draft 内 🧠 行原地更新）

> 用户反馈：OpenClaw 的思维链是可以在一个"方块"里面流动的、不断流动的工具。
> 定位：OpenClaw Discord 原生 progress 模式下，思考**不是独立消息**，而是作为一行 `🧠 _斜体_`
> **注入 progress draft 方块**（同一条可编辑消息），随 delta 到达不断**原地替换流动**。

## 1. 核心机制（progress-draft-compositor.ts → pushReasoningProgress）

```ts
async pushReasoningProgress(text?: string, options?: { snapshot?: boolean }) {
  // 门控：active && mode==="progress" && !progressSuppressed && !finalReplyDelivered && thinkingProgressEnabled
  const normalized = mergeReasoningProgress(text, options);       // ① 累积
  const compactLine = formatReasoningProgressDisplayLine(normalized, maxLineChars); // ② 格式化
  const displayLine = `${reasoningLinePrefix}${compactLine}`;  // ③ "🧠 " + 斜体
  const priorIndex = lastReasoningLine === undefined ? -1 : lines.lastIndexOf(lastReasoningLine);
  if (priorIndex >= 0) lines[priorIndex] = displayLine;           // ④ 原地替换（流动！）
  else lines = [...lines, displayLine].slice(-maxLines);          //    首段思考才追加
  lastReasoningLine = displayLine;
  ...gate.noteWork() → render()
}
```

**"在方块里流动"的四步**：
1. **累积**（mergeReasoningProgressText）：快照（isReasoningSnapshotText / snapshot:true / 前缀延续）→ **替换**整个缓冲；普通 delta → **追加**
2. **规范化**（normalizeReasoningProgressLine）：剥 <think> 标签（代码块内保留）、剥 "Reasoning:\n" / "Thinking..." 头、空白折叠成单行；部分标签前缀（"<thi"）暂存等更多字节
3. **格式化**（formatReasoningProgressDisplayLine）：`_..._` 斜体包裹；超过 maxLineChars 词边界截断 + "…"，**斜体保持平衡**（`_` 恰好 2 个）
4. **原地替换**：上一思维行存在 → 替换（流动）；否则追加为新区块末尾行（`slice(-maxLines)`）

## 2. 与工具行交错（noteProgress 中的 commit）

```ts
// A work line lands between reasoning bursts: commit the current thinking line
// so the next thought appends as its own line, interleaved with tools in
// arrival order, instead of replacing the prior thought.
if (shouldStoreLine) { reasoningRawText = ""; lastReasoningLine = undefined; }
```

- 工具行到达 → **commit 当前思维行**（清空累积与 lastReasoningLine）
- 下一段思考 → 作为**新行**追加（与工具行按到达顺序交错）
- 测试期望：`"Clawing...\n\n🛠️ Exec\n🧠 _Considering plugin installation!_"\n`
  （状态头 + 工具行 + 🧠 思维行，**全部在同一条 progress draft 消息**里）

## 3. 门控（thinkingProgressEnabled）

```ts
const thinkingProgressEnabled =
  params.active && (params.reasoningGate ?? previewToolProgressEnabled);
// Discord 传 reasoningGate: previewToolProgressEnabled（draft-preview.ts:124）
```

- 非流式窗口（requiresReasoningProgressOptIn: true）→ 还需 reasoningWindowEnabled
  （process-progress.ts:142：`if (payload?.requiresReasoningProgressOptIn === true && !reasoningWindowEnabled) return;`）
- reasoningPayloadsEnabled: reasoningDurableEnabled（durable reasoning 另发）

## 4. durable reasoning（非 progress 窗口）→ 才用 blockquote

- message-handler.process.ts:307：kind="block" 的 durable reasoning 投递
  → chunkDiscordTextWithMode 分块 → `formatDiscordReasoningQuote`（`> 🧠` blockquote）
- 即：**流式窗口内**思维链在 progress 方块里流动（🧠 _..._）；**窗口外/durable** 才发 `> 🧠` 独立消息

## 5. 最终折叠摘要（progress-receipt-tracker.ts）

```ts
buildSummaryLine() {
  closeReasoning();
  const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
  return [
    ...(reasoningSteps > 0 ? [`🧠 ${reasoningSteps} thought(s)`] : []),
    ...(commentaryNotes > 0 ? [`💬 ${commentaryNotes} note(s)`] : []),
    ...(toolCalls > 0 ? [`🛠️ ${toolCalls} tool call(s)`] : []),
    `⏱️ ${seconds}s`,
  ].join(" · ");
}
```

- 测试：finalizeProgressReceipt("done") → "done\n🧠 3 thoughts · 🛠️ 2 tool calls"
- 思维段计数：noteReasoning() 开段，closeReasoning()/noteToolCall() 关段

## 6. 对照修正清单（pi-discord-openclaw）

| 现状（笔记 18 lane 分离） | 修正为（openclaw 原生，笔记 19） |
|---|---|
| reasoning 独立消息（blockquote `> 🧠`） | **思维链注入 progress 方块**：`🧠 _斜体_` 行原地流动 |
| reasoningDraft 独立 DraftStream | 删除；reasoning 走 progressDraft（同一消息） |
| ReasoningLane.onDelta → updatePreview 整段 | pushReasoningProgress(text, {snapshot}) 累积+替换 |
| 工具行到达 → 各行独立 | 工具行 commit 思维行；下一思考新行交错 |
| 无最终摘要 | endTurn 可输出 `🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns`（可开关） |

## 7. 测试要点（对齐 openclaw draft-reasoning.test.ts）

- delta 累积：`["Considering"," plugin"," installation","!"]` → `🧠 _Considering plugin installation!_`
- 快照替换：`[{text:"Checking ",snapshot},{text:"Reading \n\nChecking ",snapshot}]` → 不重复前缀
- 截断斜体平衡：maxLineChars=36 → `🧠 _..._`（`_` 恰好 2 个）
- 与工具行交错：工具行 commit 后新思考另起一行
- 状态头（label/preamble）在最上：`Clawing...`
