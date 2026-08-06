// 笔记 36 验证：/resume 会话恢复——列表、前缀匹配、当前会话判断（远程重启部分不单测）。
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentSessions, findSessionsByPrefix, parseSessionFile, formatSessionList } from '../src/commands/handler.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 构造临时会话目录（模拟 pi session 文件命名）
const dir = mkdtempSync(join(tmpdir(), 'resume-test-'));
const files = [
  '2026-08-06T04-56-18-417Z_019fd56d-eaf1-7c73-8a6d-30e7c1bc8f9f.jsonl',
  '2026-08-06T04-31-00-558Z_019fd556-c1ce-7668-9aca-f1e515ced5c9.jsonl',
  '2026-08-05T10-00-00-000Z_019fc999-aaaa-bbbb-cccc-dddddddddddd.jsonl',
  'not-a-session.txt',
  'corrupt-jsonl.jsonl',  // 命名不匹配 → 跳过
];
for (const f of files) writeFileSync(join(dir, f), '{}');

// 1. parseSessionFile：正确解析 id / label
{
  const p = parseSessionFile(files[0]);
  assert(p?.id === '019fd56d-eaf1-7c73-8a6d-30e7c1bc8f9f', '解析 UUID id');
  assert(p?.label.includes('019fd56d'), 'label 含 id 前 8 位');
  assert(parseSessionFile('not-a-session.txt') === null, '非会话文件跳过');
}

// 2. listRecentSessions：时间倒序 + limit
{
  const all = await listRecentSessions(10, dir);
  assert(all.length === 3, '只统计合法会话文件（3 个）');
  assert(all[0].id === '019fd56d-eaf1-7c73-8a6d-30e7c1bc8f9f', '最新在前');
  const two = await listRecentSessions(2, dir);
  assert(two.length === 2, 'limit 生效');
}

// 3. findSessionsByPrefix：UUID 前缀 / 时间戳前缀 / 多匹配 / 无匹配
{
  const byUuid = await findSessionsByPrefix('019fd56d', dir);
  assert(byUuid.length === 1 && byUuid[0].id.startsWith('019fd56d'), 'UUID 前缀唯一匹配');
  const byStamp = await findSessionsByPrefix('2026-08-06T04', dir);
  assert(byStamp.length === 2, '时间戳前缀匹配 2 个');
  const none = await findSessionsByPrefix('zzz', dir);
  assert(none.length === 0, '无匹配返回空');
  const empty = await findSessionsByPrefix('  ', dir);
  assert(empty.length === 0, '空前缀返回空');
  // 大小写不敏感
  const upper = await findSessionsByPrefix('019FD56D', dir);
  assert(upper.length === 1, '前缀匹配大小写不敏感');
}

// 4. formatSessionList：排版
{
  const text = formatSessionList([{ id: '019fd56d-eaf1-7c73-8a6d-30e7c1bc8f9f', label: 'L' }]);
  assert(text.includes('• L'), '列表项排版');
}

console.log(`\nresume tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
