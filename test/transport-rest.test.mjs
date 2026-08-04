// Transport 层验证：discord-rest（发送/编辑/删除/typing/429 retry-after/错误）
import { DiscordRest, DiscordApiError, DiscordRateLimitError } from '../src/transport/discord-rest.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. createChannelMessage → POST /channels/{id}/messages，返回 message id
{
  const calls = [];
  const rest = new DiscordRest({ token: 'tok', fetch: async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ id: '111' }), { status: 200 });
  }});
  const sent = await rest.createChannelMessage('c1', { content: 'hi' });
  assert(sent.id === '111', 'createChannelMessage 返回 message id');
  assert(calls[0].url === 'https://discord.com/api/v10/channels/c1/messages', 'URL 正确');
  assert(calls[0].method === 'POST', 'POST 方法');
  assert(calls[0].body.content === 'hi', 'content 传递');
  assert(calls[0].headers?.Authorization === 'Bot tok', 'Bot header');
}

// 2. editChannelMessage → PATCH
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push(init.method); return new Response('{}', { status: 200 }); }});
  await rest.editChannelMessage('c1', 'm2', 'edited');
  assert(calls[0] === 'PATCH', 'edit 用 PATCH');
}

// 3. deleteChannelMessage → DELETE
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push(init.method); return new Response(null, { status: 204 }); }});
  await rest.deleteChannelMessage('c1', 'm2');
  assert(calls[0] === 'DELETE', 'delete 用 DELETE');
}

// 4. sendChannelTyping → PUT /channels/{id}/typing
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push({ url, method: init.method }); return new Response(null, { status: 204 }); }});
  await rest.sendChannelTyping('c1');
  assert(calls[0].method === 'PUT' && calls[0].url.endsWith('/channels/c1/typing'), 'typing PUT 正确');
}

// 5. 429 → 重试（最多 3 次），header retry-after 秒
{
  let n = 0;
  const rest = new DiscordRest({ token: 't', fetch: async () => {
    n++;
    if (n < 3) return new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
  }});
  const r = await rest.createChannelMessage('c', { content: 'x' });
  assert(n === 3 && r.id === 'ok', `429 重试后成功（请求 ${n} 次）`);
}

// 6. 429 body retry_after 毫秒解析 + 超限抛 RateLimitError
{
  let n = 0;
  const rest = new DiscordRest({ token: 't', fetch: async () => {
    n++;
    return new Response(JSON.stringify({ retry_after: 5, global: false }), { status: 429 });
  }});
  let threw = false;
  try { await rest.createChannelMessage('c', { content: 'x' }); } catch (e) {
    threw = e instanceof DiscordRateLimitError && e.retryAfterMs === 5;
  }
  assert(threw && n === 4, '429 超限抛 DiscordRateLimitError（3 重试 + 1 失败 = 4 次）');
}

// 7. 非 2xx → DiscordApiError（带 code/message）
{
  const rest = new DiscordRest({ token: 't', fetch: async () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 })});
  let err = null;
  try { await rest.createChannelMessage('c', { content: 'x' }); } catch (e) { err = e; }
  assert(err instanceof DiscordApiError && err.status === 403 && err.code === 50013, '403 → DiscordApiError 带 code');
}

// 8. message_reference 传递
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: '1' }), { status: 200 }); }});
  await rest.createChannelMessage('c', { content: 'r', message_reference: { message_id: 'm9', fail_if_not_exists: false } });
  assert(calls[0].message_reference?.message_id === 'm9' && calls[0].message_reference.fail_if_not_exists === false, 'message_reference 传递');
}

console.log(`\nrest tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
