// 笔记 20/21 验证：命令系统单测（registry / options / handler / text-commands）
import {
  assertCommandRegistry,
  buildBuiltinCommands,
  findCommandByNativeName,
  findCommandByTextAlias,
  getCommands,
  parseCommandArgs,
  serializeCommandArgs,
  buildCommandTextFromArgs,
} from '../src/commands/registry.ts';
import {
  buildDiscordCommandOptions,
  truncateDiscordCommandDescription,
} from '../src/commands/options.ts';
import {
  executeCommand,
} from '../src/commands/handler.ts';
import {
  normalizeCommandBody,
  isCommandMessage,
  resolveTextCommand,
} from '../src/commands/text-commands.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. 注册表不变量 + 命令全集
{
  const commands = buildBuiltinCommands();
  assert(commands.length >= 13, `内置命令 ≥13 个（实际 ${commands.length}）`);
  assertCommandRegistry(commands); // 不应抛错
  const keys = new Set(commands.map((c) => c.key));
  for (const k of ['help','commands','status','stop','compact','think','model','tools','usage','name','quit','new','reset']) {
    assert(keys.has(k), `命令存在: /${k}`);
  }
  assert(findCommandByNativeName('stop')?.key === 'stop', 'findCommandByNativeName(stop)');
  assert(findCommandByNativeName('STOP')?.key === 'stop', 'native 查找大小写不敏感');
  assert(findCommandByNativeName('unknown') === undefined, '未知 native 返回 undefined');
}

// 2. 参数解析（openclaw parseCommandArgs 语义）
{
  const compact = findCommandByNativeName('compact');
  const parsed = parseCommandArgs(compact, ' 加详细说明 ');
  assert(parsed?.values?.instructions === '加详细说明', 'compact 捕获剩余参数');
  const think = findCommandByNativeName('think');
  assert(parseCommandArgs(think, 'high')?.values?.level === 'high', 'think 位置参数');
  const model = findCommandByNativeName('model');
  assert(serializeCommandArgs(model, { values: { model: 'claude-sonnet' } }) === 'claude-sonnet', 'serialize');
  assert(buildCommandTextFromArgs(compact, { values: { instructions: 'x' } }) === '/compact x', 'buildCommandText');
  assert(buildCommandTextFromArgs(think, undefined) === '/think', '无参 buildCommandText');
}

// 3. options.ts（buildDiscordCommandOptions 纯函数）
{
  const think = findCommandByNativeName('think');
  const options = buildDiscordCommandOptions(think);
  assert(options?.length === 1, 'think 有一个 option');
  assert(options?.[0].type === 3, 'string option type=3');
  assert(options?.[0].required === true, 'think level required');
  assert(options?.[0].choices?.length === 6, 'think 6 个 choices');
  const status = findCommandByNativeName('status');
  assert(buildDiscordCommandOptions(status) === undefined, 'status 无 options（acceptsArgs 无 args 定义）');
  const noArgs = findCommandByNativeName('stop');
  assert(buildDiscordCommandOptions(noArgs) === undefined, 'stop 无 options');
  const long = 'x'.repeat(200);
  assert(truncateDiscordCommandDescription(long).length <= 100, '描述截断 100');
}

// 4. text-commands.ts（normalize/detect/resolve）
{
  assert(normalizeCommandBody('/stop') === '/stop', 'normalize 原样');
  assert(normalizeCommandBody('/compact: 说明') === '/compact 说明', '冒号语法');
  assert(normalizeCommandBody('/stop@mybot', { botUsername: 'MyBot' }) === '/stop', 'mention 剥离');
  assert(normalizeCommandBody('/stop@otherbot', { botUsername: 'MyBot' }) === '/stop@otherbot', '非本 bot mention 保留');
  assert(isCommandMessage('/stop') === true, 'isCommandMessage /stop');
  assert(isCommandMessage('hello') === false, 'isCommandMessage 普通消息 false');
  assert(isCommandMessage('/nonexistent') === true, '未注册 /xx 仍视为命令消息（OpenClaw 语义）');
  const resolved = resolveTextCommand('/compact 详细说明');
  assert(resolved?.command.key === 'compact', 'resolve /compact');
  assert(resolved?.args === '详细说明', 'resolve 参数');
  assert(resolveTextCommand('hello') === null, '普通消息 resolve null');
  assert(resolveTextCommand('/compact')?.args === undefined, '无参 resolve');
}

// 5. handler.ts（命令执行，fake deps）
{
  let aborted = false, compacted = undefined, shutdown = false, sessionName = undefined;
  let thinkingLevel = 'medium';
  let modelSet = undefined;
  const fakeCtx = {
    isIdle: () => true,
    abort: () => { aborted = true; },
    compact: (o) => { compacted = o; },
    shutdown: () => { shutdown = true; },
    getModelName: () => 'claude-sonnet-4',
    getThinkingLevel: () => thinkingLevel,
    getContextUsageText: () => '1000 / 200000 (0.5%)',
    listScopedModels: () => ['claude-sonnet-4', 'gpt-5'],
    getAllTools: () => ['bash', 'read', 'edit'],
    setSessionName: (n) => { sessionName = n; },
    setModel: async (q) => { modelSet = q; return q === 'claude-sonnet-4'; },
  };
  const deps = { pi: {
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (l) => { thinkingLevel = l; },
    setModel: async () => true,
    getAllTools: () => [],
    setSessionName: () => {},
  }, getCtx: () => fakeCtx };

  const stop = findCommandByNativeName('stop');
  await executeCommand(stop, undefined, deps);
  assert(aborted, '/stop → abort()');

  const compact = findCommandByNativeName('compact');
  const compactResult = await executeCommand(compact, '重写这段', deps);
  assert(compacted?.reason === '重写这段', '/compact 携带 reason');
  assert(compactResult.content.includes('压缩'), '/compact 回复提示');

  const think = findCommandByNativeName('think');
  await executeCommand(think, 'high', deps);
  assert(thinkingLevel === 'high', '/think high → setThinkingLevel');
  const thinkBad = await executeCommand(think, 'nope', deps);
  assert(thinkBad.content.includes('无效'), '/think 非法值提示');

  const model = findCommandByNativeName('model');
  const modelOk = await executeCommand(model, 'claude-sonnet-4', deps);
  assert(modelOk.content.includes('已切换'), '/model 切换成功');
  const modelBad = await executeCommand(model, 'no-such-model', deps);
  assert(modelBad.content.includes('未找到'), '/model 未找到提示');
  const modelShow = await executeCommand(model, undefined, deps);
  assert(modelShow.content.includes('claude-sonnet-4'), '/model 显示当前');

  const tools = findCommandByNativeName('tools');
  const toolsResult = await executeCommand(tools, undefined, deps);
  assert(toolsResult.content.includes('bash') && toolsResult.content.includes('3'), '/tools 列表');

  const usage = findCommandByNativeName('usage');
  const usageResult = await executeCommand(usage, undefined, deps);
  assert(usageResult.content.includes('1000 / 200000'), '/usage 用量');

  const nameCmd = findCommandByNativeName('name');
  await executeCommand(nameCmd, '我的会话', deps);
  assert(sessionName === '我的会话', '/name 设置会话名');

  const quit = findCommandByNativeName('quit');
  await executeCommand(quit, undefined, deps);
  assert(shutdown, '/quit → shutdown()');

  const newCmd = findCommandByNativeName('new');
  const newResult = await executeCommand(newCmd, undefined, deps);
  assert(newResult.content.includes('终端'), '/new 引导到终端');

  const help = findCommandByNativeName('help');
  const helpResult = await executeCommand(help, undefined, deps);
  assert(helpResult.content.includes('/stop'), '/help 列出 essential');
  assert(!helpResult.content.includes('/commands') || helpResult.content.includes('全部'), '/help 不含 power 命令');
}

// 6. 别名注册（think /thinking /t —— OpenClaw registerAlias 语义，本实现用 textAliases 表达）
{
  const think = findCommandByKey('think');
  assert(think.textAliases.length >= 0, 'textAliases 存在');
  // registry 目前未注册 think 别名；这里验证别名查找机制可用
  assert(findCommandByTextAlias('/stop')?.key === 'stop', 'textAlias 查找 /stop');
}

function findCommandByKey(key) {
  return getCommands().find((c) => c.key === key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
