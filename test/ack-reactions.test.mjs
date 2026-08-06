// 笔记 23 验证：status-reactions 完整移植（13 表情、debounce、stall、终态保护、restoreInitial）
import {
  DEFAULT_ACK_REACTION,
  STATUS_EMOJIS,
  STATUS_TIMING,
  createDiscordReactionAdapter,
  createStatusReactionController,
  queueInitialAckReaction,
  resolveToolEmoji,
} from '../src/feedback/ack-reactions.ts';
import { DiscordRest } from '../src/transport/discord-rest.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 3. 状态机：queued → thinking → tool → done（中间状态 debounce 可覆盖，逐个应用）
{
  const set = []; const removed = [];
  const adapter = { setReaction: async (e) => set.push(e), removeReaction: async (e) => removed.push(e) };
  const ctl = createStatusReactionController({ adapter, timing: { debounceMs: 5 } });
  ctl.setQueued();   // ⏳ immediate
  await wait(20);
  ctl.setThinking(); // 🧠 debounce
  await wait(20);
  ctl.setTool();     // 🛠️ debounce
  await wait(20);
  await ctl.setDone(); // ✓ 终态（finishWithEmoji）
  assert(set.join(',') === '⏳,🧠,🛠️,✓', `状态转移表情：${set.join(' → ')}`);
  assert(removed.join(',') === '⏳,🧠,🛠️', '终态移除除 ✓ 外全部（keepEmoji）');
  assert(ctl.isFinished() === true, 'done 后 finished');
  assert(ctl.activeEmoji() === '✓', '终态 = ✓');
}

// 3b. 快速连续状态调用：全部立即应用（笔记 31 起 setThinking/setTool 改 immediate，
//     applyEmoji 按 activeEmojis 去重 → 无重复 API；旧「debounce 覆盖」语义已不存在）
{
  const set = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} }, timing: { debounceMs: 10 } });
  ctl.setQueued();   // ⏳ immediate
  ctl.setThinking(); // 🧠 立即
  ctl.setTool();     // 🛠️ 立即
  await wait(40);
  await ctl.setDone();
  assert(set.join(',') === '⏳,🧠,🛠️,✓', '快速连续调用立即应用（immediate + 去重）');
}

// 4. error 路径：→ ❌ + 终态保护（后续 setThinking 被忽略）
{
  const set = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} }, timing: { debounceMs: 5 } });
  ctl.setThinking();
  await wait(30);
  await ctl.setError();
  ctl.setThinking(); // finished 后应被忽略
  await wait(10);
  assert(set.join(',') === '🧠,❌' && ctl.activeEmoji() === '❌', '错误 → ❌（终态后 setThinking 忽略）');
}

// 5. clear：移除所有活跃表情
{
  const removed = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async () => {}, removeReaction: async (e) => removed.push(e) }, timing: { debounceMs: 5 } });
  ctl.setThinking();
  await wait(30);
  await ctl.clear();
  assert(removed.join(',') === '🧠' && ctl.activeEmoji() === '', 'clear 移除活跃表情');
}

// 6. restoreInitial：回到 queued（⏳）——保留 ack 语义（仅供显式回退排队态的场景）
{
  const set = []; const removed = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async (e) => removed.push(e) }, timing: { debounceMs: 5 } });
  ctl.setThinking();
  await wait(30);
  await ctl.restoreInitial();
  assert(set.join(',') === '🧠,⏳' && removed.join(',') === '🧠', 'restoreInitial → 回 ⏳ 并移除其他');
}

// 7. 工具分类表情（openclaw resolveToolEmoji）
{
  const cases = [
    ['bash', '💻'], ['exec', '💻'], ['read', '💻'], ['write', '💻'], ['edit', '💻'],
    ['web_search', '🌐'], ['browser', '🌐'], ['web_fetch', '🌐'],
    ['deploy', '🛫'], ['release', '🛫'], ['upload', '🛫'],
    ['build', '🏗️'], ['tsc', '🏗️'], ['cargo', '🏗️'],
    ['navigate', '💁'], ['click', '💁'], ['screenshot', '💁'],
    ['unknown_tool', '🛠️'], ['', '🛠️'], [undefined, '🛠️'],
  ];
  let ok = true;
  for (const [name, expect] of cases) {
    if (resolveToolEmoji(name) !== expect) { ok = false; console.log('    ✗', name, '→', resolveToolEmoji(name), '期望', expect); }
  }
  assert(ok, '工具名分类表情（coding/web/deploy/build/concierge/tool）');
  assert(resolveToolEmoji('bash', { coding: 'X' }) === 'X', 'emojiOverrides 按分类覆盖');
}

// 7b. 笔记 33：args 透传——fabric_exec 内部调用 web 工具 → 🌐（工具名识别不到时靠 args）
{
  const cases = [
    ['fabric_exec', { code: "extensions.web_search({ query: 'x' })" }, '🌐'],
    ['fabric_exec', { code: "await mcp.exa.web_search_exa({ query: 'x' })" }, '🌐'],
    ['fabric_exec', { code: "pi.bash({ cmd: 'ls' })" }, '💻'],           // 无 web 信号 → 按工具名 coding
    ['fabric_exec', undefined, '💻'],                                     // 无 args → 按工具名
    ['web_search', { code: "pi.bash({ cmd: 'ls' })" }, '🌐'],            // 工具名本身命中 web
  ];
  let ok = true;
  for (const [name, args, expect] of cases) {
    const got = resolveToolEmoji(name, {}, args);
    if (got !== expect) { ok = false; console.log('    ✗', name, JSON.stringify(args), '→', got, '期望', expect); }
  }
  assert(ok, 'args 透传：fabric_exec 内部 web → 🌐（纯 bash 仍 💻）');
}

// 7c. 笔记 33 修复：源码提词不误报（没搜网不挂 🌐）——bare-word 曾把这些判成搜索
{
  const cases = [
    ['fabric_exec', { code: "grep -iE 'web_search|firecrawl|tavily' src" }, '💻'],            // grep 模式提词
    ['fabric_exec', { code: "// 调研 web_search 工具的可用性" }, '💻'],                      // 注释提词
    ['fabric_exec', { code: "const t = ['web_search','firecrawl','agent_browser']" }, '💻'], // 工具清单提词
    ['fabric_exec', { code: "await extensions.memory_search({ query: 'x' })" }, '💻'],        // 无关工具
    ['fabric_exec', { code: "pi.read({ path: 'docs' })" }, '💻'],                            // 无关工具
    ['fabric_exec', { code: "fetch('https://www.google.com')" }, '🌐'],                      // 真实联网 URL
    ['fabric_exec', { code: "agent-reach search 'x'" }, '🌐'],                               // CLI 命令
    ['fabric_exec', { code: "webSearch('foo')" }, '🌐'],                                     // 真实调用语法
    ['fabric_exec', { code: "await mcp.firecrawl.scrape({ url: 'https://x.com' })" }, '🌐'], // MCP 真实调用
  ];
  let ok = true;
  for (const [name, args, expect] of cases) {
    const got = resolveToolEmoji(name, {}, args);
    if (got !== expect) { ok = false; console.log('    ✗', name, JSON.stringify(args), '→', got, '期望', expect); }
  }
  assert(ok, '源码提词不误报（grep/注释/清单 → 💻；真实调用 → 🌐）');
}

// 8. stall 警告：无活动超时 → ⏳（软）/ ⚠️（硬）
{
  const set = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} }, timing: { debounceMs: 5, stallSoftMs: 30, stallHardMs: 60 } });
  ctl.setThinking();
  await wait(90);
  assert(set.includes('⏳') && set.includes('⚠️'), `stall 警告：${set.join(',')}`);
}

// 8b. 笔记 33：活动恢复 → 残留的 ⏳/⚠️ 被移除（「警告不解除」根因修复）
{
  const set = []; const removed = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async (e) => removed.push(e) }, timing: { debounceMs: 5, stallSoftMs: 25, stallHardMs: 50 } });
  ctl.setThinking();
  await wait(70);                 // 触发 ⏳ + ⚠️
  assert(set.includes('⏳') && set.includes('⚠️'), `8b stall 已触发：${set.join(',')}`);
  ctl.setThinking();              // 新活动（恢复正常）
  await wait(15);                 // 等 enqueue 串行执行 removeEmoji
  assert(removed.includes('⏳') && removed.includes('⚠️'), `8b 恢复活动后 ⏳⚠️ 被移除：removed=${removed.join(',')}`);
}

// 8c. 笔记 33：长任务/联网工具（fabric_exec）→ 宽 stall 窗口，短时无事件不误报 ⚠️
{
  const set = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} }, timing: { debounceMs: 5, stallSoftMs: 20, stallHardMs: 40 } });
  ctl.setTool('fabric_exec', { code: "extensions.web_search({ query: 'x' })" }); // long：soft 60 / hard 160
  await wait(55); // 距 setTool 55ms：普通工具早已 ⏳(20ms)+⚠️(40ms)，长任务窗口内应无 stall
  assert(!set.includes('⏳') && !set.includes('⚠️'), `8c 长任务窗口内无 stall 误报：${set.join(',')}`);
  await wait(120); // 累计 175ms > 160（hard override）→ ⚠️ 终会出现（工具真的卡住仍能提醒）
  assert(set.includes('⚠️'), `8c 超长时仍触发 ⚠️（卡死检测不失效）：${set.join(',')}`);
}

// 9. 表情覆盖（emojis）
{
  const set = [];
  const ctl = createStatusReactionController({ adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} }, emojis: { queued: '🙋', done: '🎉' }, timing: { debounceMs: 5 } });
  ctl.setQueued();
  await wait(20);
  await ctl.setDone();
  assert(set.join(',') === '🙋,🎉', 'emojis 覆盖生效');
}

// 10. removeThinkingNow：立即移除 🧠（跳过防抖）；removeThinking 防抖后移除
{
  const set = [], removed = [];
  const ctl = createStatusReactionController({
    adapter: { setReaction: async (e) => set.push(e), removeReaction: async (e) => removed.push(e) },
    timing: { debounceMs: 5 },
  });
  ctl.setThinking();
  await wait(20);
  assert(set.includes('🧠'), 'setThinking 加 🧠');
  ctl.removeThinkingNow();
  await wait(10);
  assert(removed.includes('🧠'), 'removeThinkingNow 立即移除 🧠（无防抖延迟）');
  const removedAt = removed.length;
  await wait(1600);
  assert(removed.length === removedAt, 'removeThinkingNow 后无重复移除');
}
{
  const removed = [];
  const ctl = createStatusReactionController({
    adapter: { setReaction: async () => {}, removeReaction: async (e) => removed.push(e) },
    timing: { debounceMs: 5 },
  });
  ctl.setThinking();
  ctl.removeThinking();
  await wait(50);
  assert(!removed.includes('🧠'), 'removeThinking 防抖窗口内不移除');
  await wait(1600);
  assert(removed.includes('🧠'), 'removeThinking 防抖后移除 🧠');
}

// 11. setThinking(countsAsActivity=false)：思考不可见时不重置 stall → ⏳⚠️ 照常出现
{
  const set = [];
  const ctl = createStatusReactionController({
    adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} },
    timing: { debounceMs: 5, stallSoftMs: 30, stallHardMs: 60 },
  });
  ctl.setWorking();
  for (let i = 0; i < 5; i++) { ctl.setThinking(false); await wait(10); } // 高频「不可见思考」
  await wait(90);
  assert(set.includes('⏳') && set.includes('⚠️'), `思考不可见时 stall 照常触发：${set.join(',')}`);
}
{
  // 对照组：思考可见（默认）→ setThinking 重置 stall → 距重置 < stallSoftMs 时 ⏳ 不出现
  const set = [];
  const ctl = createStatusReactionController({
    adapter: { setReaction: async (e) => set.push(e), removeReaction: async () => {} },
    timing: { debounceMs: 5, stallSoftMs: 100, stallHardMs: 200 },
  });
  ctl.setWorking();
  await wait(60); // 距 setWorking 60ms（<100，未触发）
  ctl.setThinking(); // 可见思考：重置 stall
  await wait(80); // 距重置 80ms（<100）→ ⏳ 不应出现；若未重置则距 setWorking 140ms > 100 → ⏳ 已出现
  assert(!set.includes('⏳'), `思考可见时 setThinking 重置 stall：${set.join(',')}`);
}

// 12. createDiscordReactionAdapter 绑定消息
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
