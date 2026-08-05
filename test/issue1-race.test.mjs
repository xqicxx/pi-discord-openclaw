// Issue #1 回归测试：flush 飞行竞态导致内容丢失
// 场景：updateDelta 在 flush（await sendMessage）飞行期间到达时，
// 旧实现把 delta 追加到已清空的 pendingText → 下一次 editMessage 覆盖已发送内容。
import { DraftStream } from '../src/draft/draft-stream.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log('  XX', label); }
}

// 慢 transport：sendMessage 200ms、editMessage 150ms，模拟 Discord REST 往返
const DELAY = { send: 200, edit: 150 };

// 1. 飞行期间 updateDelta：最终消息必须包含全部内容
{
  const sent = []; const edited = [];
  const s = new DraftStream({ throttleMs: 300, chunkSize: 1900, transport: {
    sendMessage: async (t) => { await new Promise(r => setTimeout(r, DELAY.send)); sent.push(t); return 'm1'; },
    editMessage: async (id, t) => { await new Promise(r => setTimeout(r, DELAY.edit)); edited.push(t); },
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  s.updateDelta('AAAA');
  await new Promise(r => setTimeout(r, 400));
  s.updateDelta('BBBB');
  await new Promise(r => setTimeout(r, 700));
  const last = edited.length ? edited[edited.length - 1] : (sent[sent.length - 1] || '');
  assert(last === 'AAAABBBB', '飞行期间 delta 不丢失 (got ' + JSON.stringify(last) + ')');
  await s.stop();
}

// 2. 连续多次飞行竞态：每次飞行窗口内都来 delta，内容仍完整
{
  const sent = []; const edited = [];
  const s = new DraftStream({ throttleMs: 250, chunkSize: 1900, transport: {
    sendMessage: async (t) => { await new Promise(r => setTimeout(r, 150)); sent.push(t); return 'm1'; },
    editMessage: async (id, t) => { await new Promise(r => setTimeout(r, 120)); edited.push(t); },
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  }});
  const expect = [];
  for (let i = 0; i < 5; i++) {
    const chunk = 'X' + i;
    expect.push(chunk);
    s.updateDelta(chunk);
    await new Promise(r => setTimeout(r, 180));
  }
  await new Promise(r => setTimeout(r, 600));
  const last = edited.length ? edited[edited.length - 1] : (sent[sent.length - 1] || '');
  assert(last === expect.join(''), '多次飞行竞态内容完整 (expect ' + expect.join('') + ' got ' + JSON.stringify(last) + ')');
  await s.stop();
}

console.log('issue-1 regression: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
