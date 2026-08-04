// 笔记 17 验证：ack-reactions（👀 入站 → 🧠 思考 → 🛠️ 工具 → ✅ 完成 + 移除）
import {
  DEFAULT_ACK_REACTION,
  STATUS_EMOJIS,
  createDiscordReactionAdapter,
  createStatusReactionController,
  queueInitialAckReaction,
} from '../src/feedback/ack-reactions.ts';
import { DiscordRest } from '../src/transport/discord-rest.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. transport reaction API：PUT/DELETE reactions/{emoji}/@me
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push({ url, method: init.method }); return new Response(null, { status: 204 }); }});
  await rest.createChannelReaction('c1', 'm1', '👀');
  await rest.deleteChannelReaction('c1', 'm1', '🧠');
  assert(calls[0].method === 'PUT' && calls[0].url.endsWith('/messages/m1/reactions/%F0%9F%91%80/@me'), 'PUT reaction（emoji URL 编码）');
  assert(calls[1].method === 'DELETE' && calls[1].url.endsWith('/messages/m1/reactions/%F0%9F%A7%A0/@me'), 'DELETE reaction');
}

// 2. queueInitialAckReaction：收到消息 → 加 👀
{
  const reactions = [];
  const adapter = { setReaction: async (e) => reactions.push(e), removeReaction: async () => {} };
  await queueInitialAckReaction({ adapter });
  assert(reactions[0] === '👀', '入站默认 ack = 👀');
}

// 3. 状态机：queued → thinking → tool → done（每个状态只留一个表情）
{
  const set = []; const removed = [];
  const adapter = { setReaction: async (e) => set.push(e), removeReaction: async (e) => removed.push(e) };
  const ctl = createStatusReactionController(adapter);
  await ctl.setQueued();    // 👀
  await ctl.setThinking();  // 移除👀 + 🧠
  await ctl.setTool();      // 移除🧠 + 🛠️
  await ctl.setDone();      // 移除🛠️ + ✅
  assert(set.join(',') === '👀,🧠,🛠️,✅', `状态转移表情：${set.join(' → ')}`);
  assert(removed.join(',') === '👀,🧠,🛠️', '旧表情逐个移除');
  assert(ctl.isFinished() === true, 'done 后 finished');
  assert(ctl.activeEmoji() === '✅', '终态 = ✅');
}

// 4. error 路径：→ ❌
{
  const set = [];
  const ctl = createStatusReactionController({ setReaction: async (e) => set.push(e), removeReaction: async () => {} });
  await ctl.setThinking();
  await ctl.setError();
  assert(set.join(',') === '🧠,❌' && ctl.activeEmoji() === '❌', '错误 → ❌');
}

// 5. clear：完成后移除所有表情
{
  const removed = [];
  const ctl = createStatusReactionController({ setReaction: async () => {}, removeReaction: async (e) => removed.push(e) });
  await ctl.setThinking();
  await ctl.clear();
  assert(removed.join(',') === '🧠' && ctl.activeEmoji() === undefined, 'clear 移除活跃表情');
}

// 6. createDiscordReactionAdapter 绑定消息
{
  const calls = [];
  const rest = new DiscordRest({ token: 't', fetch: async (url, init) => { calls.push(init.method); return new Response(null, { status: 204 }); }});
  const adapter = createDiscordReactionAdapter(rest, 'c9', 'm9');
  await adapter.setReaction('✅');
  await adapter.removeReaction('👀');
  assert(calls.join(',') === 'PUT,DELETE', 'adapter 绑定 channel/message');
}

console.log(`\nack-reactions tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
