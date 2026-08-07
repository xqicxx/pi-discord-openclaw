// Batch 3.1 验证：discord-api-adapter（DiscordRest → MountDeps 接口适配）
import { createDiscordMountDeps } from '../src/dispatch/discord-api-adapter.ts';
import { DiscordRest } from '../src/transport/discord-rest.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const channelId = '123456789012345678';
const calls = [];
const rest = new DiscordRest({ token: 'tok', fetch: async (url, init) => {
  calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  if (init.method === 'POST') return new Response(JSON.stringify({ id: 'm42' }), { status: 200 });
  return new Response(null, { status: 204 });
}});

// 1. sendMessage：POST /channels/{id}/messages，返回 snowflake message id
{
  calls.length = 0;
  const deps = createDiscordMountDeps(rest, async () => channelId);
  const id = await deps.sendMessage('hello');
  assert(id === 'm42', 'sendMessage 返回 message id（snowflake 字符串）');
  assert(calls[0].method === 'POST' && calls[0].url.endsWith('/channels/123456789012345678/messages'), 'POST 正确频道');
  assert(calls[0].body.content === 'hello', 'content 传递');
}

// 2. editMessageText：PATCH /channels/{id}/messages/{mid}
{
  calls.length = 0;
  const deps = createDiscordMountDeps(rest, async () => channelId);
  await deps.editMessageText('m42', 'updated');
  assert(calls[0].method === 'PATCH' && calls[0].url.endsWith('/messages/m42'), 'editMessageText PATCH 正确消息');
  assert(calls[0].body.content === 'updated', 'edit content 传递');
}

// 3. deleteMessage：DELETE /channels/{id}/messages/{mid}
{
  calls.length = 0;
  const deps = createDiscordMountDeps(rest, async () => channelId);
  await deps.deleteMessage('m42');
  assert(calls[0].method === 'DELETE' && calls[0].url.endsWith('/messages/m42'), 'deleteMessage DELETE 正确消息');
}

// 4. sendChatAction：POST /channels/{id}/typing
{
  calls.length = 0;
  const deps = createDiscordMountDeps(rest, async () => channelId);
  await deps.sendChatAction('typing');
  assert(calls[0].method === 'POST' && calls[0].url.endsWith('/typing'), 'sendChatAction → typing POST');
}

// 5. 无 channelId → 抛错
{
  const deps = createDiscordMountDeps(rest, async () => undefined);
  let threw = false;
  try { await deps.sendMessage('x'); } catch { threw = true; }
  assert(threw, '无 channelId 时抛错');
}

console.log(`\ndiscord-api-adapter tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
