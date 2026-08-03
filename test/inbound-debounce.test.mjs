// F4 验证：inbound-debounce（笔记 04）
import { InboundDebouncer } from '../src/inbound/debounce.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 同 key 连续消息合并为一批
{
  const flushes = [];
  const d = new InboundDebouncer({ debounceMs: 80, onFlush: async (es) => flushes.push(es) });
  d.push({ key: 'chat1', text: 'a', receivedAtMs: Date.now(), lane: 'default' });
  await wait(30);
  d.push({ key: 'chat1', text: 'b', receivedAtMs: Date.now(), lane: 'default' });
  await wait(150);
  assert(flushes.length === 1, '同 key 合并为一批');
  assert(flushes[0].length === 1, '批内合并为一条');
  assert(flushes[0][0].text === 'a\nb', '文本以 \n 合并');
  d.destroy();
}

// 2. 不同 key 独立 flush
{
  const flushes = [];
  const d = new InboundDebouncer({ debounceMs: 80, onFlush: async (es) => flushes.push(es) });
  d.push({ key: 'chat1', text: 'a', receivedAtMs: Date.now(), lane: 'default' });
  d.push({ key: 'chat2', text: 'b', receivedAtMs: Date.now(), lane: 'default' });
  await wait(150);
  assert(flushes.length === 2, '不同 key 分两批');
  d.destroy();
}

// 3. forward lane 用更短窗口（80ms）
{
  const flushes = [];
  const d = new InboundDebouncer({ debounceMs: 300, forwardDebounceMs: 50, onFlush: async (es) => flushes.push(es) });
  const t0 = Date.now();
  d.push({ key: 'c', text: 'fwd', receivedAtMs: t0, lane: 'forward' });
  await wait(120);
  assert(flushes.length === 1, 'forward 快速 flush');
  d.destroy();
}

// 4. 空文本跳过（笔记 04: skipped）
{
  const flushes = [];
  const d = new InboundDebouncer({ debounceMs: 50, onFlush: async (es) => flushes.push(es) });
  d.push({ key: 'c', text: '', receivedAtMs: Date.now(), lane: 'default' });
  await wait(120);
  assert(flushes.length === 0, '空文本 → skipped');
  d.destroy();
}

// 5. flushNow 立即落盘
{
  const flushes = [];
  const d = new InboundDebouncer({ debounceMs: 5000, onFlush: async (es) => flushes.push(es) });
  d.push({ key: 'c', text: 'urgent', receivedAtMs: Date.now(), lane: 'default' });
  await d.flushNow();
  assert(flushes.length === 1 && flushes[0][0].text === 'urgent', 'flushNow 立即处理');
  d.destroy();
}

// 6. hasPending
{
  const d = new InboundDebouncer({ debounceMs: 5000, onFlush: async () => {} });
  d.push({ key: 'c', text: 'x', receivedAtMs: Date.now(), lane: 'default' });
  assert(d.hasPending('c') === true, 'hasPending 检测');
  d.destroy();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
