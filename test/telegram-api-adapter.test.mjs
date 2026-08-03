// F6 验证：telegram-api-adapter（上游 API → mount 接口适配）
import { createTelegramMountDeps } from '../src/dispatch/telegram-api-adapter.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const chatId = 8753447694;
const api = {
  sendMessage: async (body) => ({ message_id: 42 }),
  editMessageText: async (body) => 'edited',
  deleteMessage: async (cid, mid) => {},
  sendChatAction: async (cid) => {},
};

// 1. sendMessage 适配：text → body，返回 message_id
{
  const deps = createTelegramMountDeps(api, async () => chatId);
  const id = await deps.sendMessage('hello');
  assert(id === 42, 'sendMessage 返回 message_id');
}

// 2. editMessageText 适配
{
  const deps = createTelegramMountDeps(api, async () => chatId);
  await deps.editMessageText(42, 'updated');
  assert(true, 'editMessageText 无异常');
}

// 3. deleteMessage 适配
{
  const deps = createTelegramMountDeps(api, async () => chatId);
  await deps.deleteMessage(42);
  assert(true, 'deleteMessage 无异常');
}

// 4. sendChatAction 适配
{
  const deps = createTelegramMountDeps(api, async () => chatId);
  await deps.sendChatAction('typing');
  assert(true, 'sendChatAction 无异常');
}

// 5. 无 chatId → 报错
{
  const deps = createTelegramMountDeps(api, async () => undefined);
  let threw = false;
  try { await deps.sendMessage('x'); } catch { threw = true; }
  assert(threw === true, '无 chatId 抛错');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
