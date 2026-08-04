// Command registry — 移植自 openclaw src/auto-reply/commands-registry*.ts（笔记 20）。
// 命令定义结构（ChatCommandDefinition / CommandArgDefinition）与 OpenClaw 一致，
// 内置命令裁剪为 pi 扩展 API 可实现的集合（help/commands/status/stop/compact/think/model）。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** 命令可用的表面：text=仅文本命令；native=仅 slash 命令；both=两者。 */
export type CommandScope = "text" | "native" | "both";

/** 渐进披露层级：essential 始终可见；standard 折叠；power 仅搜索。 */
export type CommandTier = "essential" | "standard" | "power";

export type CommandCategory = "session" | "options" | "status" | "management" | "tools";

/** 原生命令参数类型（对应 Discord ApplicationCommandOptionType）。 */
export type CommandArgType = "string" | "number" | "boolean";

export type CommandArgChoice = string | { value: string; label: string };

/** 一个位置参数（OpenClaw CommandArgDefinition 子集）。 */
export interface CommandArgDefinition {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[];
  /** 捕获剩余全部内容（如 /compact <instructions>）。 */
  captureRemaining?: boolean;
}

export type CommandArgsParsing = "none" | "positional";

/** 注册表条目：一个命令（文本别名 + 原生名称 + 参数定义）。 */
export interface ChatCommandDefinition {
  key: string;
  nativeName?: string;
  nativeAliases?: string[];
  description: string;
  /** 文本别名（必须以 / 开头）。 */
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: CommandArgsParsing;
  scope: CommandScope;
  category?: CommandCategory;
  tier?: CommandTier;
}

/** 解析后的命令参数。 */
export interface CommandArgs {
  raw?: string;
  values?: Record<string, string | number | boolean>;
}

/** 命令执行上下文（pi 侧能力注入，见 handler.ts）。 */
export interface CommandExecutionContext {
  /** 最近一次事件 handler 的 ExtensionContext（提供 abort/isIdle/compact/model...）。 */
  getCtx: () => CommandExecutionCtx;
}

/** handler 实际依赖的 pi ctx 能力面（由 index.ts 从事件 ctx 捕获）。 */
export interface CommandExecutionCtx {
  isIdle(): boolean;
  abort(): void;
  compact(options?: { reason?: string }): void;
  shutdown(): void;
  getModelName(): string | undefined;
  getThinkingLevel(): ThinkingLevel;
  getContextUsageText(): string | undefined;
  listScopedModels(): string[];
  getAllTools(): string[];
  setSessionName(name: string): void;
  /** 按 id/别名设置模型（index.ts 经 modelRegistry 解析）。返回 false 表示未找到。 */
  setModel(query: string): Promise<boolean>;
}

/** 命令执行结果：回复文本 + 是否 ephemeral。 */
export interface CommandResult {
  content: string;
  ephemeral?: boolean;
}

/** 定义一条命令（OpenClaw defineChatCommand 的简化版：scope 自动推导）。 */
export function defineChatCommand(command: {
  key: string;
  nativeName?: string;
  description: string;
  args?: CommandArgDefinition[];
  acceptsArgs?: boolean;
  textAliases?: string[];
  scope?: CommandScope;
  category?: CommandCategory;
  tier?: CommandTier;
}): ChatCommandDefinition {
  // openclaw defineBuiltinChatCommand 语义：未显式提供 textAliases 时默认 /key
  const hasExplicitAliases = command.textAliases !== undefined;
  const aliases = (command.textAliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  if (!hasExplicitAliases) aliases.push(`/${command.key}`);
  const scope =
    command.scope ??
    (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
  const argsParsing: CommandArgsParsing = command.args?.length ? "positional" : "none";
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs,
    args: command.args,
    argsParsing,
    textAliases: aliases,
    scope,
    category: command.category,
    tier: command.tier,
  };
}

/** 校验注册表不变量（OpenClaw assertCommandRegistry 的核心检查）。 */
export function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
  const keys = new Set<string>();
  const nativeNames = new Set<string>();
  const textAliases = new Set<string>();
  for (const command of commands) {
    if (keys.has(command.key)) {
      throw new Error(`Duplicate command key: ${command.key}`);
    }
    keys.add(command.key);
    const nativeName = command.nativeName?.trim();
    if (command.scope === "text") {
      if (nativeName) throw new Error(`Text-only command has native name: ${command.key}`);
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      for (const alias of [nativeName, ...(command.nativeAliases ?? [])]) {
        const nativeKey = alias.toLowerCase();
        if (nativeNames.has(nativeKey)) {
          throw new Error(`Duplicate native command: ${alias}`);
        }
        nativeNames.add(nativeKey);
      }
    }
    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }
    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = alias.toLowerCase();
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

/** 位置参数解析（OpenClaw parsePositionalArgs）。 */
function parsePositionalArgs(
  definitions: CommandArgDefinition[],
  raw: string,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  const trimmed = raw.trim();
  if (!trimmed) return values;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let index = 0;
  for (const definition of definitions) {
    if (index >= tokens.length) break;
    if (definition.captureRemaining) {
      values[definition.name] = tokens.slice(index).join(" ");
      break;
    }
    values[definition.name] = tokens[index]!;
    index += 1;
  }
  return values;
}

/** 解析命令参数（OpenClaw parseCommandArgs）。 */
export function parseCommandArgs(command: ChatCommandDefinition, raw?: string): CommandArgs | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!command.args || command.argsParsing === "none") {
    return { raw: trimmed };
  }
  return { raw: trimmed, values: parsePositionalArgs(command.args, trimmed) };
}

/** 序列化参数为原始串（OpenClaw serializeCommandArgs 简化：优先 raw）。 */
export function serializeCommandArgs(command: ChatCommandDefinition, args?: CommandArgs): string | undefined {
  if (!args) return undefined;
  const raw = args.raw?.trim();
  if (raw) return raw;
  if (!args.values || !command.args) return undefined;
  const parts: string[] = [];
  for (const definition of command.args) {
    const value = args.values[definition.name];
    if (value == null) continue;
    const rendered = typeof value === "string" ? value.trim() : String(value);
    if (!rendered) continue;
    parts.push(rendered);
    if (definition.captureRemaining) break;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** 构建 slash 命令文本（OpenClaw buildCommandTextFromArgs）。 */
export function buildCommandTextFromArgs(command: ChatCommandDefinition, args?: CommandArgs): string {
  const commandName = command.nativeName ?? command.key;
  const serialized = serializeCommandArgs(command, args);
  return serialized ? `/${commandName} ${serialized}` : `/${commandName}`;
}

/** 全部内置命令（OpenClaw buildBuiltinChatCommands 的 pi 可实现子集）。 */
export function buildBuiltinCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "help",
      nativeName: "help",
      description: "Show available commands.",
      category: "status",
      tier: "essential",
    }),
    defineChatCommand({
      key: "commands",
      nativeName: "commands",
      description: "List all slash commands.",
      category: "status",
      tier: "power",
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: "Show current status.",
      category: "status",
      tier: "essential",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "stop",
      nativeName: "stop",
      description: "Stop the current run.",
      category: "session",
      tier: "essential",
    }),
    defineChatCommand({
      key: "compact",
      nativeName: "compact",
      description: "Compact the session context.",
      category: "session",
      tier: "essential",
      args: [
        {
          name: "instructions",
          description: "Extra compaction instructions",
          type: "string",
          required: false,
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "think",
      nativeName: "think",
      description: "Set thinking level.",
      category: "options",
      tier: "essential",
      args: [
        {
          name: "level",
          description: "Thinking level",
          type: "string",
          required: true,
          choices: ["default", "low", "medium", "high", "xhigh", "max"],
        },
      ],
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "Show or set the current model.",
      category: "options",
      tier: "standard",
      args: [
        {
          name: "model",
          description: "Model id or alias",
          type: "string",
          required: false,
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "tools",
      nativeName: "tools",
      description: "List available runtime tools.",
      category: "status",
      tier: "standard",
      args: [
        {
          name: "mode",
          description: "compact or verbose",
          type: "string",
          required: false,
          choices: ["compact", "verbose"],
        },
      ],
    }),
    defineChatCommand({
      key: "usage",
      nativeName: "usage",
      description: "Show context usage.",
      category: "status",
      tier: "standard",
      args: [
        {
          name: "mode",
          description: "tokens or full",
          type: "string",
          required: false,
          choices: ["tokens", "full"],
        },
      ],
    }),
    defineChatCommand({
      key: "name",
      nativeName: "name",
      description: "Set the session display name.",
      category: "session",
      tier: "standard",
      args: [
        {
          name: "title",
          description: "New session name",
          type: "string",
          required: false,
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "quit",
      nativeName: "quit",
      description: "Gracefully shut down pi.",
      category: "session",
      tier: "power",
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: "Start a new session (terminal only).",
      category: "session",
      tier: "essential",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "reset",
      nativeName: "reset",
      description: "Reset the current session (terminal only).",
      category: "session",
      tier: "essential",
      acceptsArgs: true,
    }),
  ];
  assertCommandRegistry(commands);
  return commands;
}

/** 命令注册表（缓存）。 */
let cachedCommands: ChatCommandDefinition[] | undefined;

export function getCommands(): ChatCommandDefinition[] {
  cachedCommands ??= buildBuiltinCommands();
  return cachedCommands;
}

/** 按原生名称查找（OpenClaw findCommandByNativeName）。 */
export function findCommandByNativeName(name: string): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return getCommands().find(
    (command) =>
      command.scope !== "text" &&
      [command.nativeName, ...(command.nativeAliases ?? [])].some(
        (candidate) => candidate?.toLowerCase() === normalized,
      ),
  );
}

/** 按文本别名查找（大小写不敏感）。 */
export function findCommandByTextAlias(name: string): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return getCommands().find((command) =>
    command.textAliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

/** 按命令 key 查找。 */
export function findCommandByKey(key: string): ChatCommandDefinition | undefined {
  return getCommands().find((command) => command.key === key);
}

/** 列出原生命令（slash 注册用）。 */
export function listNativeCommandSpecs(): ChatCommandDefinition[] {
  return getCommands().filter((command) => command.scope !== "text" && command.nativeName);
}
