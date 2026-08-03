// F6 验证：activity-adapter（TelegramAssistantStreamEvent → OpenclawActivityEvent）
import { adaptAssistantEvent } from '../src/dispatch/activity-adapter.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// text_delta → assistant-text-delta
{
  const e = adaptAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'hi' });
  assert(e?.type === 'assistant-text-delta' && e.delta === 'hi', 'text_delta → assistant-text-delta');
}

// thinking_delta → reasoning-delta
{
  const e = adaptAssistantEvent({ type: 'thinking_delta', contentIndex: 0, delta: 'think' });
  assert(e?.type === 'reasoning-delta' && e.delta === 'think', 'thinking_delta → reasoning-delta');
}

// thinking_end → reasoning-end
{
  const e = adaptAssistantEvent({ type: 'thinking_end', contentIndex: 0, content: 'done' });
  assert(e?.type === 'reasoning-end', 'thinking_end → reasoning-end');
}

// toolcall_start → tool-start
{
  const e = adaptAssistantEvent({ type: 'toolcall_start', contentIndex: 3 });
  assert(e?.type === 'tool-start' && e.id === 'toolcall-3', 'toolcall_start → tool-start');
}

// toolcall_end → tool-end
{
  const e = adaptAssistantEvent({ type: 'toolcall_end', contentIndex: 3 });
  assert(e?.type === 'tool-end' && e.ok === true, 'toolcall_end → tool-end');
}

// start/text_start/done/error → undefined（由上层处理）
{
  assert(adaptAssistantEvent({ type: 'start' }) === undefined, 'start → undefined');
  assert(adaptAssistantEvent({ type: 'text_start', contentIndex: 0 }) === undefined, 'text_start → undefined');
  assert(adaptAssistantEvent({ type: 'done' }) === undefined, 'done → undefined');
  assert(adaptAssistantEvent({ type: 'error' }) === undefined, 'error → undefined');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
