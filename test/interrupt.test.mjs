// 笔记 28 验证：abort 中断机制——触发词识别、onAbort 回调、abortCurrentTurn/abortTurn
// 的 turn 清理与 followUp 排队处理、watchdog/工具超时路径、commandCtx 未就绪时安全。
import { isAbortRequestText, normalizeAbortTriggerText } from '../src/interrupt/abort-triggers.ts';
import { OpenclawBridge } from '../src/dispatch/dispatch.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_CONFIG = { streamMode: 'progress', throttleMs: 50, chunkSize: 100, reasoningEnabled: true, toolProgressEnabled: true, debounceMs: 30 };

function makeDelivery() {
  const sent = [];
  const delivery = {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return 'm' + sent.length; },
    editMessage: async () => {},
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  };
  return { delivery, sent };
}

// 1. 触发词识别（abort-triggers 模块；含 /s+/g bug 修复验证）
{
  const positives = [
    '/stop', 'stop', 'abort', 'exit', 'interrupt', 'halt', 'esc',
    '停止', '停下来', '暂停', 'やめて', '止めて', 'стоп',
    'stop the agent', 'please stop', 'stop current action', 'stop openclaw',
    'Stop.', 'stop...', '停止！', '暂停？', 'STOP',
  ];
  let ok = true;
  for (const t of positives) {
    if (!isAbortRequestText(t)) { ok = false; console.log('    ✗ 应为触发词:', JSON.stringify(t)); }
  }
  assert(ok, `触发词命中（${positives.length} 个：中/英/多语言/短语/标点/大小写）`);

  const negatives = ['你好', '继续', 'stopwatch', 'stoppage', 'stopping', '请继续暂停讨论', '', null, undefined];
  ok = true;
  for (const t of negatives) {
    if (isAbortRequestText(t)) { ok = false; console.log('    ✗ 不应触发:', JSON.stringify(t)); }
  }
  assert(ok, `非触发词不命中（${negatives.length} 个：普通消息/相似词/空值）`);

  assert(normalizeAbortTriggerText('Stop the Agent!') === 'stop the agent', '归一化：小写+空白折叠+去尾部标点');
  assert(normalizeAbortTriggerText('  Stop  The  Agent! ') === 'stop the agent!', '尾随空格时标点保留（既有语义：标点剥离在 trim 前）');
  assert(isAbortRequestText('stop the agent'), '修复后英文短语命中（/s+/g bug：\s+ 正确折叠空白）');
}

// 2. abortCurrentTurn：有活跃 turn → onAbort + reason 发送 + turn 清理
{
  let aborted = 0;
  const { delivery, sent } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: BASE_CONFIG });
  bridge.onAbort = () => { aborted++; };
  bridge.beginTurn({ chatId: 'chat1' });
  const sentByBridge = await bridge.abortCurrentTurn('🛑 已中止当前任务。');
  assert(aborted === 1, 'onAbort 被调用（真正中断 agent）');
  assert(sent.some((m) => m.chatId === 'chat1' && m.text === '🛑 已中止当前任务。'), '向 turn.chatId 发送确认消息');
  assert(sentByBridge === true, '有活跃 turn 时返回 true（已发送确认，宿主不再重复发送）');
  assert(bridge.currentTurn() === undefined, 'turn 已清理');
}

// 3. abortCurrentTurn：无活跃 turn → 仍调 onAbort（清表情+中断 agent），本层不发送确认（宿主负责）
{
  let aborted = 0;
  const { delivery, sent } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: BASE_CONFIG });
  bridge.onAbort = () => { aborted++; };
  const sentByBridge = await bridge.abortCurrentTurn('🛑 已中止当前任务。');
  assert(aborted === 1, '无 turn 时 onAbort 仍被调用');
  assert(sent.length === 0, '本层不发送确认消息（index.ts replyTextCommand 负责，避免双发）');
  assert(sentByBridge === false, '无活跃 turn 时返回 false（宿主负责确认回复）');
}

// 3b. abortCurrentTurn：有活跃 turn 但发送失败 → 返回 false（宿主兜底回复，不丢确认）
{
  let aborted = 0;
  const delivery = {
    sendMessage: async () => { throw new Error('rate limited'); },
    editMessage: async () => {},
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  };
  const bridge = new OpenclawBridge({ delivery, config: BASE_CONFIG });
  bridge.onAbort = () => { aborted++; };
  bridge.beginTurn({ chatId: 'chat1' });
  const sentByBridge = await bridge.abortCurrentTurn('🛑 已中止当前任务。');
  assert(aborted === 1, '发送失败时 onAbort 仍被调用');
  assert(sentByBridge === false, '发送失败时返回 false（宿主负责兜底回复）');
  assert(bridge.currentTurn() === undefined, '发送失败时 turn 仍已清理');
}

// 4. abort 后 followUp 排队消息被 drain 处理（用户意图不丢）
{
  let aborted = 0;
  const received = [];
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { ...BASE_CONFIG, debounceMs: 30 } });
  bridge.onAbort = () => { aborted++; };
  bridge.onUserInput = async (text) => { received.push(text); };
  bridge.beginTurn({ chatId: 'chat1' });
  bridge.pushUserMessage('follow-up 消息', 'chat1');   // turn 活跃 → 排队
  await wait(80);                                       // debounce flush → pendingInputs
  await bridge.abortCurrentTurn('🛑 已中止当前任务。');
  assert(received.length === 1 && received[0] === 'follow-up 消息', 'abort 后排队 followUp 提交给 agent');
  assert(bridge.currentTurn() === undefined, 'abort 后 turn 清理');
}

// 5. watchdog 第二次超时 → abortTurn（onAbort + reason）
{
  let aborted = 0;
  const { delivery, sent } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { ...BASE_CONFIG, turnWatchdogMs: 60 } });
  bridge.onAbort = () => { aborted++; };
  bridge.beginTurn({ chatId: 'chat1' });
  await wait(3200);   // 2 × (60+1000) + buffer
  assert(aborted === 1, 'watchdog 二次超时触发 onAbort');
  assert(sent.some((m) => m.text.includes('已停止')), 'watchdog abort 发送提示消息');
}

// 6. 连续工具超时 → abortTurn（maxToolTimeouts）
{
  let aborted = 0;
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: { ...BASE_CONFIG, maxToolTimeouts: 2 } });
  bridge.onAbort = () => { aborted++; };
  bridge.beginTurn({ chatId: 'chat1' });
  bridge.handleActivity({ type: 'tool-timeout', id: 't1', name: 'bash' });
  bridge.handleActivity({ type: 'tool-timeout', id: 't2', name: 'bash' });
  await wait(50);
  assert(aborted === 1, '连续工具超时达到阈值 → abort');
  assert(bridge.currentTurn() === undefined, '工具超时 abort 后 turn 清理');
}

// 7. onAbort 未设置时 abort 安全（commandCtx 未捕获/未就绪场景）
{
  const { delivery } = makeDelivery();
  const bridge = new OpenclawBridge({ delivery, config: BASE_CONFIG });
  bridge.beginTurn({ chatId: 'chat1' });
  let threw = false;
  try { await bridge.abortCurrentTurn('🛑 已中止当前任务。'); } catch { threw = true; }
  assert(!threw && bridge.currentTurn() === undefined, 'onAbort 未设置时 abort 不抛异常');
}

console.log(`\ninterrupt tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
