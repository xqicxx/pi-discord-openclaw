// 笔记 21 验证：动态命令收集（pi-commands.ts）—— 不写死，从 pi 动态获取
import {
  loadPiBuiltinCommands,
  collectPiRuntimeCommands,
  mergeCommandSets,
  findMergedCommandByNativeName,
  sanitizeDiscordCommandName,
} from '../src/commands/pi-commands.ts';
import { buildBuiltinCommands, getCommands } from '../src/commands/registry.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. 动态导入 pi 内置命令（BUILTIN_SLASH_COMMANDS，真实包）
{
  const builtins = await loadPiBuiltinCommands();
  assert(builtins.length >= 22, `pi 内置命令 ≥22 个（实际 ${builtins.length}）`);
  const names = new Set(builtins.map((c) => c.nativeName));
  for (const n of ['new', 'resume', 'fork', 'tree', 'settings', 'export', 'model', 'compact', 'quit']) {
    assert(names.has(n), `内置命令存在: /${n}`);
  }
  assert(builtins.every((c) => c.nativeName && c.description), '每个内置命令有 name+description');
}

// 2. pi.getCommands() 动态收集（fake pi）
{
  const fakePi = {
    getCommands: () => [
      { name: 'my-tool', description: 'A custom tool', source: 'extension', sourceInfo: {} },
      { name: 'tpl-demo', description: 'A prompt template', source: 'prompt', sourceInfo: {} },
      { name: 'skill:foo', description: 'Skill foo', source: 'skill', sourceInfo: {} },
    ],
  };
  const dynamic = collectPiRuntimeCommands(fakePi);
  const names = new Set(dynamic.map((c) => c.nativeName));
  assert(names.has('my-tool'), '扩展命令被收集');
  assert(names.has('tpl-demo'), 'prompt 模板被收集');
  assert(!names.has('skill:foo'), 'skill:xxx 跳过（数量多+需终端）');
}

// 3. sanitizeDiscordCommandName
{
  assert(sanitizeDiscordCommandName('skill:foo') === 'skill-foo', '冒号 → 连字符');
  assert(sanitizeDiscordCommandName('UPPER Name!') === 'upper-name', '大写/空格/符号规范化');
  assert(sanitizeDiscordCommandName('!!!') === 'command', '全非法字符回退');
  assert(sanitizeDiscordCommandName('x'.repeat(50)).length <= 32, '超长截断 32');
}

// 4. 合并：本地优先去重
{
  const local = buildBuiltinCommands();
  const dynamic = [
    ...(await loadPiBuiltinCommands()),
    ...collectPiRuntimeCommands({ getCommands: () => [] }),
  ];
  const merged = mergeCommandSets(local, dynamic);
  const mergedNames = new Set(merged.map((c) => c.nativeName));
  // 本地命令全部保留
  for (const c of local) assert(mergedNames.has(c.nativeName), `本地命令保留: /${c.nativeName}`);
  // pi 内置非重叠命令加入（如 settings/fork/tree）
  for (const n of ['settings', 'fork', 'tree', 'export', 'resume', 'login']) {
    assert(mergedNames.has(n), `pi 内置命令合并: /${n}`);
  }
  // 无重复 nativeName
  assert(merged.length === mergedNames.size, '合并后无重复');
  // 本地优先：model 的 description 来自本地（"Show or set the current model."）
  const model = findMergedCommandByNativeName(merged, 'model');
  assert(model?.description.includes('Show or set'), '本地 model 定义优先于 pi 内置');
}

// 5. findMergedCommandByNativeName
{
  const merged = mergeCommandSets(buildBuiltinCommands(), await loadPiBuiltinCommands());
  assert(findMergedCommandByNativeName(merged, 'stop')?.key === 'stop', '查本地命令');
  // settings 现为本地命令（笔记 22 桥接），本地优先 → key 是 settings
  assert(findMergedCommandByNativeName(merged, 'SETTINGS')?.key === 'settings', '查 settings（本地优先，大小写不敏感）');
  assert(findMergedCommandByNativeName(merged, 'nope') === undefined, '未知命令 undefined');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
