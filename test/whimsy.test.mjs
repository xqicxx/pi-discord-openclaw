// 笔记 26 验证：/whimsy 本地桥接（settings.json whimsical 字段，与扩展同格式）
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { whimsyStatus, whimsySet, whimsyReset } from '../src/commands/whimsy.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'whimsy-test-'));
const settingsPath = path.join(tmp, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({ model: 'x', whimsical: { enabled: true, spinnerPreset: 'spin' } }));

// 1. status 读取现有状态
{
  const s = await whimsyStatus(settingsPath);
  assert(s.includes('开启') && s.includes('spin'), `status 读现有状态（${s}）`);
}

// 2. off → status
{
  const off = await whimsySet(false, settingsPath);
  assert(off.includes('关闭'), 'off 返回已关闭');
  const s = await whimsyStatus(settingsPath);
  assert(s.includes('关闭'), 'status 反映关闭');
}

// 3. on 写回
{
  const on = await whimsySet(true, settingsPath);
  assert(on.includes('开启'), 'on 返回已开启');
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert(parsed.whimsical?.enabled === true, 'settings.json whimsical.enabled=true');
  assert(parsed.whimsical?.spinnerPreset === 'spin', 'spinnerPreset 保留');
}

// 4. reset 删除字段（扩展默认值）
{
  const reset = await whimsyReset(settingsPath);
  assert(reset.includes('重置'), 'reset 返回已重置');
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert(parsed.whimsical === undefined, 'whimsical 字段已删除');
}

// 5. 无 settings 文件兜底
{
  const s = await whimsyStatus(path.join(tmp, 'nonexistent.json'));
  assert(s.includes('开启'), '无文件时默认开启');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
