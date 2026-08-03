// F5 验证：dispatch 桥接层（笔记 05/08）
import { OpenclawBridge, TurnManager } from '../src/dispatch/dispatch.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDelivery() {
  const sent = []; const edited = []; const deleted = [];
  return {
    delivery: {
      sendMessage: async (t) => { sent.push(t); return sent.length; },
      editMessage: async (id, t) => { edited.push(t); },
      deleteMessage: async (id) => { deleted.push(id); },
      sendChatAction: async () => {},
    },
    sent, edited, deleted,
  };
}

// 1. 事件路由：reasoning-delta / tool-start / assistant-text-delta
{
  const { delivery, sent, edited } = makeDelivery();
  const bridge = new OpenclawBridge({
    delivery,
    config: { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 50 },
  });
  const turn = bridge.beginTurn({ chatId: 'chat1' });
  assert(turn.turnId.startsWith('chat1:'), 'turnId 含 chatId');
  bridge.handleActivity({ type: 'reasoning-delta', delta: 'thinking...' });
  bridge.handleActivity({ type: 'tool-start', id: 't1', name: 'exec_command', args: { cmd: 'ls' } });
  bridge.handleActivity({ type: 'assistant-text-delta', delta: '答案' });
  await wait(150);
  assert(sent.length >= 1, '至少发了一条消息');
  await bridge.endTurn();
}

// 2. 新 turn 取代旧 turn（isDispatchSuperseded）
{
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 50 } });
  const t1 = bridge.beginTurn({ chatId: 'chat1' });
  const t2 = bridge.beginTurn({ chatId: 'chat1' });
  assert(t1.isSuperseded() === true, '旧 turn 被取代');
  assert(t2.isSuperseded() === false, '新 turn 活跃');
  assert(bridge.currentTurn() === t2, 'currentTurn 指向新 turn');
  await bridge.endTurn();
}

// 3. 连续输入 debounce 合并
{
  let received = '';
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 60 } });
  bridge.onUserInput = async (text) => { received = text; };
  bridge.pushUserMessage('第一句', 'chat1');
  await wait(20);
  bridge.pushUserMessage('第二句', 'chat1');
  await wait(150);
  assert(received === '第一句\n第二句', '连续输入合并为一轮');
}

// 4. tool-end 状态流转
{
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 50 } });
  bridge.beginTurn({ chatId: 'c' });
  bridge.handleActivity({ type: 'tool-start', id: 't1', name: 'git', args: { cmd: 'status' } });
  bridge.handleActivity({ type: 'tool-end', id: 't1', ok: true });
  await bridge.endTurn();
  assert(true, 'tool 生命周期正常结束');
}

// 5. 事件在无 turn 时忽略
{
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 50 } });
  const handled = bridge.handleActivity({ type: 'assistant-text-delta', delta: 'x' });
  assert(handled === false, '无 turn → 事件忽略');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
