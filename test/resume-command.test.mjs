// 笔记 36：/resume 命令分支集成测试（列出 / 未找到 / 已在当前会话；不触发真实重启）。
import { executeCommand } from '../src/commands/handler.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const fakeCtx = {
  getSessionInfo: () => ({ sessionId: '019fd56d-eaf1-7c73-8a6d-30e7c1bc8f9f' }),
} ;
const deps = {
  pi: {},
  getCtx: () => fakeCtx,
  rpc: undefined,
};
const resumeCmd = { key: 'resume', name: 'resume', sourceInfo: { type: 'builtin' }, handler: async () => {} };

// 1. 无参数 → 列出最近会话（不重启）
{
  const res = await executeCommand(resumeCmd, undefined, deps);
  assert(res.content.includes('最近会话') && res.content.includes('/resume <id>'), '无参数列出会话+用法');
  assert(!res.content.includes('已排定'), '列分支不触发重启');
}

// 2. 未命中前缀 → 报错提示
{
  const res = await executeCommand(resumeCmd, 'zzzzz', deps);
  assert(res.content.includes('未找到匹配 zzzzz'), '未命中报错');
}

// 3. 当前会话 id → 已在当前会话（不重启）
{
  const res = await executeCommand(resumeCmd, '019fd56d', deps);
  assert(res.content.includes('已在当前会话'), '恢复当前会话提示已在该会话');
}

// 4. 多匹配 → 列候选
{
  const res = await executeCommand(resumeCmd, '2026', deps);
  assert(res.content.includes('匹配到') && res.content.includes('更精确的前缀'), '多匹配列候选');
}

console.log(`\nresume-command tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
