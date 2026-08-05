// 笔记 26 验证：/todos 本地桥（方案二）——add/list/done/show/delete + 与 TUI 同存储格式
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  todosAdd, todosList, todosSetStatus, todosShow, todosDelete, getTodosDir,
} from '../src/commands/todos.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'todos-test-'));
process.env.PI_TODO_PATH = path.join(tmp, 'todo-store');
const cwd = tmp;

// 1. add + list
{
  const added = await todosAdd(cwd, '测试任务A');
  assert(added.includes('已创建任务 TODO-'), `add 返回 TODO 编号（${added.slice(0, 30)}…）`);
  await todosAdd(cwd, '测试任务B');
  const list = await todosList(cwd);
  assert(list.includes('测试任务A') && list.includes('测试任务B'), 'list 包含两个任务');
  assert(list.includes('⬜'), 'open 任务显示 ⬜');
  assert(/1\. \\[\s\S]*2\./.test(list) || list.split('\n').length >= 3, '有序号列表');
}

// 2. done（按序号）+ list 状态变化
{
  const done = await todosSetStatus(cwd, '1', 'closed');
  assert(done.includes('✅ 已完成'), 'done 返回已完成');
  const list = await todosList(cwd);
  assert(list.includes('✅'), 'closed 任务显示 ✅');
}

// 3-5. 按 id 操作（序号随排序变化——closed 排后，用 id 稳定引用）
{
  const list = await todosList(cwd);
  // 列表顺序：B(open) 在前，A(closed) 在后
  const lines = list.split('\n');
  const idA = lines.find((l) => l.includes('测试任务A')).match(/TODO-([a-f0-9]{8})/)[1];
  const idB = lines.find((l) => l.includes('测试任务B')).match(/TODO-([a-f0-9]{8})/)[1];
  const show = await todosShow(cwd, idA);
  assert(show.includes('测试任务A') && show.includes('TODO-'), 'show 含标题和 id');
  assert(show.includes('closed'), 'show 显示状态');
  const done = await todosSetStatus(cwd, idA, 'open');
  assert(done.includes('🔄 已重新打开'), '按裸 hex id 重新打开');
  const del = await todosDelete(cwd, idB);
  assert(del.includes('🗑️ 已删除'), 'delete 返回已删除');
  const after = await todosList(cwd);
  assert(!after.includes('测试任务B'), '删除后列表不含');
}

// 6. 存储格式与扩展兼容（JSON front matter 可被 parse）
{
  const dir = getTodosDir(cwd);
  const files = await import('node:fs/promises').then((f) => f.readdir(dir));
  assert(files.some((f) => f.endsWith('.md')), '存储为 <id>.md 文件');
  const content = await import('node:fs/promises').then((f) => f.readFile(path.join(dir, files.find((f) => f.endsWith('.md'))), 'utf8'));
  assert(content.trimStart().startsWith('{'), '文件以 JSON front matter 开头（扩展同格式）');
}

// 7. 无效引用
{
  const bad = await todosSetStatus(cwd, '999', 'closed');
  assert(bad.includes('未找到任务'), '无效引用报错');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
