// 端到端模拟：完整 turn 生命周期（agent-start → thinking → tool → text → agent-end）
// 验证所有 lane 协同工作，产出符合 openclaw 风格的输出。
import { mountOpenclawBridge } from '../src/dispatch/mount.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 模拟真实 Telegram 发送记录
const sent = []; const edited = []; const deleted = [];
const delivery = {
  sendMessage: async (t) => { sent.push(t); return sent.length; },
  editMessage: async (id, t) => { edited.push({ id, t }); },
  deleteMessage: async (id) => { deleted.push(id); },
  sendChatAction: async () => {},
};

// 模拟 activityRuntime（与 fork bindings 调用方式一致）
const calls = { onAssistantEvent: 0, onToolStart: 0, onToolEnd: 0, onAgentStart: 0, onAgentEnd: 0 };
const runtime = {
  onAssistantEvent: () => { calls.onAssistantEvent++; },
  onToolStart: () => { calls.onToolStart++; },
  onToolUpdate: () => {},
  onToolEnd: () => { calls.onToolEnd++; },
  onAgentStart: () => { calls.onAgentStart++; },
  onAgentEnd: () => { calls.onAgentEnd++; },
  onAgentSettled: () => {},
};

// 挂载（mount 内部创建 bridge 并包装 runtime）
const mount = mountOpenclawBridge(runtime, delivery);
assert(mount !== undefined, 'mount 成功');
const bridge = mount.bridge;

async function simulateTurn() {
  // 1. agent-start → 开始 turn
  runtime.onAgentStart({ chatId: 8753447694 });
  const turn = bridge.currentTurn();
  assert(turn !== undefined, 'turn 已创建');
  assert(turn.turnId.includes('8753447694'), 'turnId 含 chatId');

  // 2. 思考流：thinking_delta 事件
  runtime.onAssistantEvent({ type: 'thinking_delta', contentIndex: 0, delta: '让我想想' });
  await wait(60);

  // 3. 工具调用
  runtime.onToolStart({ toolCallId: 't1', toolName: 'exec_command', args: { cmd: 'ls ~/' } });
  runtime.onToolEnd({ toolCallId: 't1', toolName: 'exec_command', result: { ok: true }, isError: false });
  await wait(60);

  // 4. 流式回复：text_delta 分片
  runtime.onAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: '你好' });
  await wait(60);
  runtime.onAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: '，这是' });
  await wait(60);
  runtime.onAssistantEvent({ type: 'text_delta', contentIndex: 0, delta: '测试回复' });
  await wait(60);

  // 5. agent-end → 收尾
  runtime.onAgentEnd();
  await wait(100);
}

await simulateTurn();

// 验证
assert(sent.length >= 1, `至少发了 ${sent.length} 条消息`);
assert(calls.onAssistantEvent === 4, '原始 onAssistantEvent 仍被调用(不破坏上游)'); // 1 thinking + 3 text
assert(calls.onToolStart === 1 && calls.onToolEnd === 1, '工具事件桥接');
assert(calls.onAgentStart === 1 && calls.onAgentEnd === 1, 'turn 生命周期');
console.log('  📦 发送:', JSON.stringify(sent.map(s => String(s).slice(0, 40))));

mount.unmount();
assert(true, 'unmount 正常');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
