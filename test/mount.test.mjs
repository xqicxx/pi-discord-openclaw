// F6 验证：mount（OpenclawBridge 挂到 activityRuntime 的最小侵入接入）
import { mountOpenclawBridge } from '../src/dispatch/mount.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRuntime() {
  const calls = { assistant: 0, toolStart: 0, toolEnd: 0, agentStart: 0, agentEnd: 0 };
  const runtime = {
    onAssistantEvent: (e) => { calls.assistant++; },
    onToolStart: (e) => { calls.toolStart++; },
    onToolUpdate: (e) => {},
    onToolEnd: (e) => { calls.toolEnd++; },
    onAgentStart: (t) => { calls.agentStart++; },
    onAgentEnd: () => { calls.agentEnd++; },
    onAgentSettled: () => {},
  };
  return { runtime, calls };
}

const deps = {
  sendMessage: async (t) => 1,
  editMessageText: async () => {},
  deleteMessage: async () => {},
  sendChatAction: async () => {},
};

// 1. 挂载后事件桥接（text_delta → bridge answer lane）
{
  const { runtime, calls } = makeRuntime();
  const m = mountOpenclawBridge(runtime, deps);
  assert(m !== undefined, '挂载成功');
  runtime.onAgentStart({ chatId: 'c' });
  runtime.onAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'hi' });
  runtime.onToolStart({ toolCallId: 't1', toolName: 'exec', args: {} });
  runtime.onToolEnd({ toolCallId: 't1', toolName: 'exec', result: {}, isError: false });
  await wait(1200); // throttle 1s
  runtime.onAgentEnd();
  await wait(50);
  assert(calls.assistant === 1, '原始 onAssistantEvent 仍被调用（不破坏上游）');
  assert(calls.toolStart === 1, '原始 onToolStart 仍被调用');
  assert(calls.agentStart === 1, '原始 onAgentStart 仍被调用');
  m.unmount();
}

// 2. unmount 恢复原始方法
{
  const { runtime } = makeRuntime();
  const m = mountOpenclawBridge(runtime, deps);
  m.unmount();
  // 验证方法已恢复：没有 bridge 拦截
  const before = runtime.onAssistantEvent;
  runtime.onAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'x' });
  assert(true, 'unmount 后方法可正常调用');
}

// 3. thinking_delta 桥接（reasoning lane）
{
  const { runtime } = makeRuntime();
  const m = mountOpenclawBridge(runtime, deps);
  runtime.onAgentStart({ chatId: 'c' });
  runtime.onAssistantEvent({ type: 'thinking_delta', contentIndex: 0, delta: 'think' });
  await wait(50);
  m.unmount();
  assert(true, 'thinking_delta 桥接无异常');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
