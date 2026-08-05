// F1 验证：draft-stream 核心机制（throttle / 分块 / 首次send后续edit / 重试 / flood）
// 注意：实现强制 throttle >= 250ms（笔记 01），测试等待需超过 300ms
import { DraftStream, TelegramFloodError, readRetryAfterMs } from '../src/draft/draft-stream.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const WAIT = 400; // > 250ms 最小节流

// 1. throttle + 首次 send / 后续 edit
{
  const sent = []; const edited = [];
  const s = new DraftStream({ throttleMs: 300, chunkSize: 100, transport: {
    sendMessage: async (t) => { sent.push(t); return sent.length; },
    editMessage: async (id, t) => { edited.push(t); },
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  s.update('hello');
  await new Promise(r => setTimeout(r, WAIT));
  assert(sent.length === 1 && edited.length === 0, '首次 update → sendMessage');
  s.update('hello world');
  await new Promise(r => setTimeout(r, WAIT));
  assert(edited.length === 1, '二次 update → editMessage');
  await s.stop();
}

// 2. 分块：超长文本拆多条
{
  const sent = []; const edited = [];
  const s = new DraftStream({ throttleMs: 300, chunkSize: 20, transport: {
    sendMessage: async (t) => { sent.push(t); return sent.length; },
    editMessage: async (id, t) => { edited.push(t); },
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  s.update('a'.repeat(60)); // 60 chars → 3 chunks
  await new Promise(r => setTimeout(r, WAIT));
  assert(sent.length === 3, `超长文本分块（${sent.length} 条）`);
  await s.stop();
}

// 3. flood 退避解析（Telegram 错误格式：description + parameters）
{
  const e1 = { description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } };
  assert(readRetryAfterMs(e1) === 5000, 'description+parameters 解析 retry after 5s');
  const e2 = { description: 'Too Many Requests: retry after 3' };
  assert(readRetryAfterMs(e2) === 3000, '仅 description 解析');
  const e3 = new TelegramFloodError('flood', 30000);
  assert(e3.retryAfterMs === 30000, 'TelegramFloodError.retryAfterMs');
}

// 4. 失败重试（3 次内恢复）
{
  let fails = 0; const sent = [];
  const s = new DraftStream({ throttleMs: 300, transport: {
    sendMessage: async (t) => { if (fails++ < 1) throw new Error('boom'); sent.push(t); return sent.length; },
    editMessage: async () => {},
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  s.update('retry me');
  await new Promise(r => setTimeout(r, WAIT * 2));
  assert(sent.length === 1, '失败后重试成功');
  await s.stop();
}


// 5. preview 并发串行化（笔记 25 修复）：thinking_delta 高频到达时不得并发 sendMessage
{
  const sent = []; const edited = [];
  // sendMessage 模拟网络延迟（真实 REST 几十~几百 ms，delta 事件毫秒级到达 → 必然并发）
  const s = new DraftStream({ throttleMs: 300, transport: {
    sendMessage: async (t) => { await new Promise(r => setTimeout(r, 60)); sent.push(t); return 'm' + sent.length; },
    editMessage: async (id, t) => { await new Promise(r => setTimeout(r, 30)); edited.push({ id, t }); },
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  // 快速连续 5 次 preview 更新（不等 await —— 模拟 thinking_delta 流）
  for (let i = 1; i <= 5; i++) {
    s.updatePreview({ text: 'thinking chunk ' + i, parseMode: 'Markdown' });
  }
  await new Promise(r => setTimeout(r, 800));
  assert(sent.length === 1, `并发 preview 只发 1 条消息（实际 ${sent.length}）`);
  assert(sent[0] === 'thinking chunk 1', '首条为最早文本');
  assert(edited.length >= 1, `合并后至少 1 次 edit（实际 ${edited.length}）`);
  const lastEdited = edited[edited.length - 1]?.t;
  assert(lastEdited === 'thinking chunk 5', `最终编辑为最新文本（实际 ${lastEdited}）`);
  // drain 期间到达的中间预览被合并（最新值语义），后续无并发时继续 edit 同一条
  s.updatePreview({ text: 'thinking chunk 5b', parseMode: 'Markdown' });
  await new Promise(r => setTimeout(r, 300));
  assert(sent.length === 1 && edited[edited.length - 1]?.t === 'thinking chunk 5b', '后续 preview 继续 edit 同一条消息');
  await s.stop();
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
