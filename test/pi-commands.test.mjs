// 笔记 21 验证：动态命令收集（pi-commands.ts）—— 不写死，从 pi 动态获取
import {
  loadPiBuiltinCommands,
  collectPiRuntimeCommands,
  filterDiscordRegisterableCommands,
  filterGuildRegisterableCommands,
  extractSkillSubcommands,
  findSkillBySubcommand,
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


// 6. 注册过滤器（笔记 25 修复）：skill 不注册 Discord + 100 上限保底
{
  const fakePi = {
    getCommands: () => [
      { name: 'my-tool', description: 'A custom tool', source: 'extension', sourceInfo: {} },
      { name: 'tpl-demo', description: 'A prompt template', source: 'prompt', sourceInfo: {} },
      { name: 'skill:foo', description: 'Skill foo', source: 'skill', sourceInfo: {} },
    ],
  };
  const dynamic = collectPiRuntimeCommands(fakePi);
  const merged = mergeCommandSets(buildBuiltinCommands(), dynamic);
  const registerable = filterDiscordRegisterableCommands(merged);
  const names = new Set(registerable.map((c) => c.nativeName));
  assert(names.has('my-tool'), '注册集含扩展命令');
  assert(names.has('tpl-demo'), '注册集含 prompt 模板');
  assert(!names.has('skill-foo'), '注册集排除 skill（100 上限 + 需终端）');
  assert(names.has('models'), '注册集含本地 models');
  assert(names.has('help') && names.has('status'), '注册集含本地 help/status');
  assert(registerable.length <= 100, `注册集 ≤100（实际 ${registerable.length}）`);

  // 超 100 时保底截断（本地+builtin 优先，merge 顺序保证）
  const many = buildBuiltinCommands().concat(
    Array.from({ length: 120 }, (_, i) => ({
      key: 'ext' + i, nativeName: 'ext-' + i, description: 'x', textAliases: [], scope: 'native',
      source: 'extension',
    })),
  );
  const capped = filterDiscordRegisterableCommands(many);
  assert(capped.length === 100, `超限截断到 100（实际 ${capped.length}）`);
  assert(capped.some((c) => c.key === 'models'), '截断后本地命令保留');
}

// 7. guild 注册集（笔记 25 续）：skills 走 guild 额度，/skill:xxx 进 Discord
{
  const fakePi = {
    getCommands: () => [
      { name: 'my-tool', description: 'A custom tool', source: 'extension', sourceInfo: {} },
      { name: 'skill:foo', description: 'Skill foo', source: 'skill', sourceInfo: {} },
      { name: 'skill:bar', description: 'Skill bar', source: 'skill', sourceInfo: {} },
    ],
  };
  const merged = mergeCommandSets(buildBuiltinCommands(), collectPiRuntimeCommands(fakePi));
  const guild = filterGuildRegisterableCommands(merged);
  const names = new Set(guild.map((c) => c.nativeName));
  assert(guild.length === 2, `guild 集只含 skills（实际 ${guild.length}）`);
  assert(names.has('skill-foo') && names.has('skill-bar'), 'skill:xxx → skill-xxx 进 guild 集');
  assert(!names.has('my-tool'), '非 skill 不进 guild 集');
  // 全局集不受影响（无 skill）
  const global = filterDiscordRegisterableCommands(merged);
  assert(!global.some((c) => c.source === 'skill'), '全局集仍排除 skill');

  // 超 100 截断
  const manySkills = Array.from({ length: 120 }, (_, i) => ({
    key: 'skill:' + i, nativeName: 'skill-' + i, description: 'x', textAliases: [], scope: 'native',
    source: 'skill',
  }));
  assert(filterGuildRegisterableCommands(manySkills).length === 100, 'guild 集超限截断 100');
}

// 8. skill 子命令分类（笔记 25 续）：/skill github 而非 55 个平铺 skill-xxx
{
  const fakePi = {
    getCommands: () => [
      { name: 'skill:github', description: 'GitHub skill', source: 'skill', sourceInfo: {} },
      { name: 'skill:reading', description: 'Reading skill', source: 'skill', sourceInfo: {} },
      { name: 'my-tool', description: 'tool', source: 'extension', sourceInfo: {} },
    ],
  };
  const merged = mergeCommandSets(buildBuiltinCommands(), collectPiRuntimeCommands(fakePi));
  const subs = extractSkillSubcommands(merged);
  const names = subs.map((s) => s.subName);
  assert(subs.length === 2, `只提取 skills（实际 ${subs.length}）`);
  assert(names.includes('github') && names.includes('reading'), '子命令名去 skill- 前缀');
  assert(new Set(names).size === names.length, '子命令名唯一');
  assert(findSkillBySubcommand(merged, 'github')?.key === 'pi:skill:skill-github', '按子命令查回 skill 命令');
  assert(findSkillBySubcommand(merged, 'nope') === undefined, '未知子命令 undefined');
  assert(findSkillBySubcommand(merged, 'GITHUB')?.nativeName === 'skill-github', '子命令查大小写不敏感');
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
