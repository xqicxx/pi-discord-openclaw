// F3 验证：progress-lane（笔记 03+06）
import {
  buildToolProgressLine,
  renderProgressLine,
  renderProgressDraft,
  removeProgressLine,
  formatTelegramProgressLine,
  clipTelegramProgressText,
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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
