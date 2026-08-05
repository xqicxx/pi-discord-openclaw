import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TAGS = CONFIG.tags || { approve: 'approved', needsWork: 'needs-work' };
const MAX_CONCURRENT = 2;
const MAX_ITER_ROUNDS = 3;

// 并发池
let activeWorkers = 0;
const queue = [];
let processing = false;

// 互斥锁（fix 和 iterate 共用）
let mutex = Promise.resolve();

function withLock(fn) {
  const run = mutex.then(fn);
  mutex = run.catch(() => {});
  return run;
}

function enqueue(task) {
  queue.push(task);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0 && activeWorkers < MAX_CONCURRENT) {
    const task = queue.shift();
    activeWorkers++;
    task().finally(() => {
      activeWorkers--;
      processQueue();
    });
  }
  processing = false;
}

// 模拟 GitHub API（实际应替换为真实调用）
const gh = {
  async getIssueLabels(issueNumber) {
    // 示例：返回标签数组
    return [];
  },
  async addLabel(issueNumber, label) {
    // 示例：添加标签
  },
  async removeLabel(issueNumber, label) {
    // 示例：移除标签
  },
  async createPR(issueNumber, title, body, head, base) {
    // 示例：创建 PR
    return { number: 1 };
  },
  async getPR(prNumber) {
    // 示例：获取 PR 信息
    return { state: 'open' };
  },
  async updatePR(prNumber, data) {
    // 示例：更新 PR
  }
};

// 状态存储（内存模拟）
const stateStore = new Map();

function getState(key) {
  return stateStore.get(key) || {};
}

function setState(key, value) {
  stateStore.set(key, value);
}

// 主流程
export async function handleIssue(issue) {
  const issueNumber = issue.number;
  enqueue(() => withLock(() => fixIssue(issueNumber)));
}

async function fixIssue(issueNumber) {
  console.log(`[fix] start issue #${issueNumber}`);
  // 模拟 clone、locate、patch 等步骤
  await sleep(3000);
  const prNumber = await gh.createPR(issueNumber, 'fix: auto-fix', 'body', 'head', 'base');
  setState(`pr:${prNumber}`, { stage: 'created', iterRound: 0 });
  console.log(`[fix] PR #${prNumber} created`);
  // 触发 review
  enqueue(() => withLock(() => reviewPR(prNumber)));
}

async function reviewPR(prNumber) {
  const st = getState(`pr:${prNumber}`);
  console.log(`[review] PR #${prNumber} stage=${st.stage}`);
  const labels = await gh.getIssueLabels(prNumber);
  if (labels.includes(TAGS.approve) || labels.includes(TAGS.needsWork)) {
    // 保留 iterRound，不覆盖
    const verdict = labels.includes(TAGS.approve) ? 'approved' : 'needs-work';
    setState(`pr:${prNumber}`, { ...st, stage: 'review-done', verdict });
    if (verdict === 'needs-work') {
      // 触发迭代，但仅在未达到上限时
      const round = st.iterRound || 0;
      if (round < MAX_ITER_ROUNDS) {
        enqueue(() => withLock(() => iterateNeedsWorkPR(prNumber)));
      } else {
        // 已达上限，标记 done，不再迭代
        setState(`pr:${prNumber}`, { ...st, stage: 'done', iterRound: round });
        console.log(`[review] PR #${prNumber} max rounds reached, done`);
      }
    }
    return;
  }
  // 正常 review 逻辑
  await sleep(1000);
  setState(`pr:${prNumber}`, { ...st, stage: 'review-done', verdict: 'approved' });
}

async function iterateNeedsWorkPR(prNumber) {
  const st = getState(`pr:${prNumber}`);
  const round = st.iterRound || 0;
  console.log(`[iterate] PR #${prNumber} round=${round}`);
  if (round >= MAX_ITER_ROUNDS) {
    // 达到上限，标记 done，不再移除 needs-work
    setState(`pr:${prNumber}`, { ...st, stage: 'done', iterRound: round });
    console.log(`[iterate] PR #${prNumber} max rounds reached, done`);
    return;
  }
  // 模拟迭代修复
  await sleep(2000);
  const newRound = round + 1;
  setState(`pr:${prNumber}`, { ...st, stage: 'iterated', iterRound: newRound });
  // 移除 needs-work 标签
  await gh.removeLabel(prNumber, TAGS.needsWork);
  // 重新 review
  enqueue(() => withLock(() => reviewPR(prNumber)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 启动时处理积压 issue（示例）
// 实际应由外部事件触发 handleIssue
