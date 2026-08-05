// F3 验证：progress-lane（笔记 03+06+19）
import {
  buildToolProgressLine,
  renderProgressLine,
  renderProgressDraft,
  removeProgressLine,
  formatTelegramProgressLine,
  clipTelegramProgressText,
  normalizeReasoningProgressLine,
  mergeReasoningProgressText,
  formatReasoningProgressDisplayLine,
  buildProgressReceiptSummary,
  ProgressLane,
} from '../src/progress/progress-lane.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. 工具开始 → 行构建
{
  const line = buildToolProgressLine({ event: 'tool', toolCallId: 't1', name: 'exec_command', phase: 'start', args: { cmd: 'ls ~/' } });
  assert(line?.kind === 'tool', '行 kind=tool');
  assert(line?.id === 'tool:t1', '行 id=tool:t1');
  assert(line?.status === 'running', '状态 running');
  assert((line?.label ?? '').includes('exec_command'), 'label 含工具名');
  assert(line?.detail === 'ls ~/', 'detail 含命令');
}

// 2. 渲染 HTML
{
  const line = buildToolProgressLine({ event: 'tool', toolCallId: 't1', name: 'bash', phase: 'start', args: { cmd: 'ls' } });
  const html = renderProgressLine(line);
  assert(html.includes('🛠️'), '含工具 emoji');
  assert(html.includes(': ls'), '含 detail');
  assert(!html.includes('*running*'), '原生行无状态标记');
}

// 3. 完成 → ✓，失败 → ✗
{
  const done = buildToolProgressLine({ event: 'tool', toolCallId: 't2', name: 'git', phase: 'end', ok: true });
  assert(done?.status === 'completed', '完成状态 completed');
  const err = buildToolProgressLine({ event: 'tool', toolCallId: 't3', name: 'git', phase: 'end', ok: false });
  assert(err?.status === 'error', '失败状态 error');
}

// 4. 截断
{
  assert(clipTelegramProgressText("a".repeat(400)).length === 300, "超长截断到 300");
  assert(formatTelegramProgressLine('_italic_') === '_italic_', '斜体原样');
  assert(formatTelegramProgressLine('plain').startsWith('`'), '普通文本 → 代码块');
}

// 5. removeProgressLine
{
  const lines = [
    { id: 'tool:a', kind: 'tool', text: 'a' },
    { id: 'tool:b', kind: 'tool', text: 'b' },
  ];
  const next = removeProgressLine(lines, 'tool:a');
  assert(next.length === 1 && next[0].id === 'tool:b', '按 id 删除行');
}

// 6. ProgressLane 生命周期（start→update→end）
{
  const previews = [];
  const lane = new ProgressLane({ enabled: true, maxLines: 8 }, {
    updatePreview: (p) => previews.push(p.text),
  });
  lane.beginTurn();
  lane.onToolStart({ id: 't1', name: 'exec_command', args: { cmd: 'ls' } });
  assert(previews.length === 1, 'start → 渲染一次');
  assert(previews[0].includes('exec\\_command'), 'start 渲染含工具名（下划线已转义）');
  lane.onToolUpdate({ id: 't1', detail: 'progress 50%' });
  assert(previews.length === 2, 'update → 渲染第二次');
  lane.onToolEnd({ id: 't1', ok: true });
  assert(previews.length === 3, 'end → 渲染第三次');
  assert(previews[2].includes('✓'), 'end 渲染含 ✓');
}

// ---- 笔记 19：思维链在方块里流动 ----

// 7. normalizeReasoningProgressLine：剥标签/头/空白
{
  assert(normalizeReasoningProgressLine('<think> 需要检查 配置 </think>') === '需要检查 配置', '剥 think 标签');
  assert(normalizeReasoningProgressLine('Reasoning:\ncompare install paths') === 'compare install paths', '剥 Reasoning 头');
  assert(normalizeReasoningProgressLine('Thinking...\n\n_compare_') === '_compare_', '剥 Thinking 头');
  assert(normalizeReasoningProgressLine('  a\n\n  b  ') === 'a b', '空白折叠');
}

// 8. mergeReasoningProgressText：delta 追加 / 快照替换
{
  let acc = mergeReasoningProgressText('', 'Considering');
  acc = mergeReasoningProgressText(acc, ' plugin');
  acc = mergeReasoningProgressText(acc, ' installation');
  acc = mergeReasoningProgressText(acc, '!');
  assert(normalizeReasoningProgressLine(acc) === 'Considering plugin installation!', 'delta 追加累积');
  acc = mergeReasoningProgressText(acc, 'Checking ', { snapshot: true });
  acc = mergeReasoningProgressText(acc, 'Reading \n\nChecking ', { snapshot: true });
  assert(normalizeReasoningProgressLine(acc) === 'Reading Checking', '快照替换不重复前缀');
}

// 9. formatReasoningProgressDisplayLine：斜体 + 截断平衡
{
  assert(formatReasoningProgressDisplayLine('hi') === '_hi_', '斜体包裹');
  const long = 'Thinking through a very detailed installation plan with many steps';
  const truncated = formatReasoningProgressDisplayLine(long, 36);
  assert(truncated.startsWith('_') && truncated.endsWith('_'), '截断保持斜体');
  const underscores = (truncated.match(/_/g) ?? []).length;
  assert(underscores === 2, '斜体平衡（_ 恰好 2 个）');
}

// 10. buildProgressReceiptSummary
{
  const summary = buildProgressReceiptSummary({ reasoningSteps: 3, toolCalls: 2, startedAtMs: Date.now() - 12000 });
  assert(summary.includes('🧠 3 thoughts'), '含思考数');
  assert(summary.includes('🛠️ 2 tool calls'), '含工具数');
  assert(summary.includes('⏱️ 12s'), '含耗时');
}

// 11. ProgressLane 思维链注入：🧠 行原地流动 + 工具行 commit
{
  const previews = [];
  const lane = new ProgressLane({ enabled: true, maxLines: 8, thinking: true }, {
    updatePreview: (p) => previews.push(p.text),
  });
  lane.beginTurn();
  lane.pushReasoningProgress('Considering');
  lane.pushReasoningProgress(' plugin');
  lane.pushReasoningProgress(' installation');
  lane.pushReasoningProgress('!');
  const last = previews.at(-1) ?? '';
  assert(last.includes('> 🧠 _Considering plugin installation!_'), '思维链在方块里流动（累积完整，blockquote 区分）');
  assert(previews.length <= 4, '思维行原地替换不爆行');
  lane.onToolStart({ id: 't1', name: 'exec', args: { cmd: 'go test' } });
  const afterTool = previews.at(-1) ?? '';
  assert(afterTool.includes('🛠️') && afterTool.includes('> 🧠 _Considering plugin installation!_'), '工具行与思维行同方块');
  lane.pushReasoningProgress('Now checking');
  lane.pushReasoningProgress(' the results');
  const final = previews.at(-1) ?? '';
  assert(final.includes('> 🧠 _Now checking the results_'), '工具行 commit 后新思考另起一行');
}

// 12. thinking 开关关闭 → 思维链不注入
{
  const previews = [];
  const lane = new ProgressLane({ enabled: true, maxLines: 8, thinking: false }, {
    updatePreview: (p) => previews.push(p.text),
  });
  lane.beginTurn();
  lane.pushReasoningProgress('secret thinking');
  assert(previews.length === 0, 'thinking:false → 不渲染');
}

// 13. receiptSummary
{
  const previews = [];
  const lane = new ProgressLane({ enabled: true, maxLines: 8, receipt: true }, {
    updatePreview: (p) => previews.push(p.text),
  });
  lane.beginTurn();
  lane.pushReasoningProgress('a');
  lane.onToolStart({ id: 't1', name: 'bash', args: { cmd: 'ls' } });
  lane.endTurn();
  const last = previews.at(-1) ?? '';
  assert(last.includes('🧠 1 thought'), '折叠摘要含思考数');
  assert(last.includes('🛠️ 1 tool call'), '折叠摘要含工具数');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
