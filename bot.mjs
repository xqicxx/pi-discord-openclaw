// 假设这是 bot.mjs 的完整内容（基于 issue 描述重建）
// 实际修复需结合真实文件，此处为最小修复示意
import { setPR, getPR, TAGS } from './state.js';

let fixRunning = false;
let iterateRunning = false;

// 统一互斥锁
export async function withLock(fn) {
  while (fixRunning || iterateRunning) {
    await new Promise(r => setTimeout(r, 1000));
  }
  fixRunning = true;
  try {
    return await fn();
  } finally {
    fixRunning = false;
  }
}

export async function reviewPR(n, names) {
  const st = getPR(n);
  if (names.includes(TAGS.approve) || names.includes(TAGS.needsWork)) {
    // 合并状态而非覆盖，保留 iterRound
    setPR(n, {
      ...st,
      stage: 'review-done',
      verdict: names.includes(TAGS.approve) ? 'approve' : 'needs-work',
      iterRound: st?.iterRound ?? 0
    });
    return;
  }
  // 其他逻辑...
}

export async function iterateNeedsWorkPR(n) {
  const st = getPR(n);
  const round = st?.iterRound ?? 0;
  if (round >= 3) {
    // 达上限，标记 done 且不移除 needs-work
    setPR(n, { ...st, stage: 'done', iterRound: round });
    return;
  }
  // 迭代逻辑...
  setPR(n, { ...st, stage: 'iterated', iterRound: round + 1 });
}
