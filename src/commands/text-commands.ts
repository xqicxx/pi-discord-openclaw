// Text-command normalization & detection — 移植自 openclaw
// src/auto-reply/commands-registry-normalize.ts + command-detection.ts（笔记 20）。
// 纯函数、零依赖：/cmd 文本消息的规范化（冒号语法/mention/多行 tail）与注册表匹配。
import {
  findCommandByTextAlias,
  getCommands,
  parseCommandArgs,
  type ChatCommandDefinition,
} from "./registry.ts";

/** 规范化选项（botUsername 用于剥离 /cmd@bot mention）。 */
export interface CommandNormalizeOptions {
  botUsername?: string;
}

type TextAliasSpec = {
  command: ChatCommandDefinition;
  canonical: string;
  acceptsArgs: boolean;
};

type CommandRegistryLookup = {
  aliases: Map<string, TextAliasSpec>;
};

let cachedRegistryLookup: CommandRegistryLookup | undefined;

function getCommandRegistryLookup(): CommandRegistryLookup {
  if (cachedRegistryLookup) {
    return cachedRegistryLookup;
  }
  const aliases = new Map<string, TextAliasSpec>();
  // 从注册表收集别名（与 OpenClaw getCommandRegistryLookup 相同逻辑）。
  // 注：registry.ts 提供 findCommandByTextAlias，这里需要全量映射以支持
  // canonical 规范化（别名 → 主别名）。
  for (const command of getCommands()) {
    const canonical = command.textAliases[0] ?? `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (!aliases.has(normalized)) {
        aliases.set(normalized, { command, canonical, acceptsArgs });
      }
    }
  }
  cachedRegistryLookup = { aliases };
  return cachedRegistryLookup;
}

/** 从注册表重建别名映射（在模块加载后由 ensureAliasIndex 调用）。 */
let commandListProvider: (() => ChatCommandDefinition[]) | undefined;

export function setCommandListProvider(provider: () => ChatCommandDefinition[]): void {
  commandListProvider = provider;
  rebuildAliasIndex();
}

export function rebuildAliasIndex(): void {
  if (!commandListProvider) return;
  const aliases = new Map<string, TextAliasSpec>();
  for (const command of commandListProvider()) {
    const canonical = command.textAliases[0] ?? `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (!aliases.has(normalized)) {
        aliases.set(normalized, { command, canonical, acceptsArgs });
      }
    }
  }
  cachedRegistryLookup = { aliases };
}

function appendMultilineTail(head: string, tail: string | undefined, spec?: TextAliasSpec): string {
  if (!tail) return head;
  if (!spec || spec.command.key === "skill" || spec.command.key === "learn") {
    return `${head}\n${tail}`;
  }
  if (spec.command.key === "reset") {
    const flattened = tail.replace(/\s+/g, " ").trim();
    return flattened ? `${head} ${flattened}` : head;
  }
  return head;
}

/**
 * 规范化命令文本（OpenClaw normalizeCommandBody 原样移植）：
 * - `/cmd: value` 冒号语法 → `/cmd value`
 * - `/cmd@bot` mention 剥离（匹配 botUsername 时）
 * - 多行消息：首行命令 + tail（skill/learn 保留换行，其余丢弃或压平）
 * - 别名 → canonical 主别名
 */
export function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return trimmed;

  const newline = trimmed.indexOf("\n");
  const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
  const multilineTail = newline === -1 ? undefined : trimmed.slice(newline + 1).trimStart();

  // `/cmd: value` is accepted as `/cmd value`（OpenClaw 注释原样）
  const colonMatch = singleLine.match(/^\/([^\s:]+)\s*:(.*)$/);
  const normalized = colonMatch
    ? (() => {
        const [, command, rest] = colonMatch;
        const normalizedRest = (rest ?? "").trimStart();
        return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
      })()
    : singleLine;

  const normalizedBotUsername = options?.botUsername?.trim().toLowerCase();
  const mentionMatch = normalizedBotUsername
    ? normalized.match(/^\/([^\s@]+)@([^\s]+)(.*)$/)
    : null;
  const commandBody =
    mentionMatch && mentionMatch[2]!.toLowerCase() === normalizedBotUsername
      ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}`
      : normalized;

  const lowered = commandBody.toLowerCase();
  const exact = getCommandRegistryLookup().aliases.get(lowered);
  if (exact) {
    return appendMultilineTail(exact.canonical, multilineTail, exact);
  }

  const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${(token ?? "").toLowerCase()}`;
  const tokenSpec = getCommandRegistryLookup().aliases.get(tokenKey);
  if (!tokenSpec) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  if (rest && !tokenSpec.acceptsArgs) {
    return commandBody;
  }
  const normalizedRest = rest?.trimStart();
  const normalizedHead = normalizedRest
    ? `${tokenSpec.canonical} ${normalizedRest}`
    : tokenSpec.canonical;
  return appendMultilineTail(normalizedHead, multilineTail, tokenSpec);
}

/** 规范化后是否为命令消息（以 / 开头）。 */
export function isCommandMessage(raw: string): boolean {
  const normalized = normalizeCommandBody(raw);
  return normalized.startsWith("/");
}

/** 解析结果：命中的命令 + 参数。 */
export interface ResolvedTextCommand {
  command: ChatCommandDefinition;
  args?: string;
}

/**
 * 文本命令解析（OpenClaw command-detection.ts hasControlCommand + resolveTextCommand 移植）。
 * 返回 null = 非命令 / 未命中注册表。
 */
export function resolveTextCommand(text: string, options?: CommandNormalizeOptions): ResolvedTextCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalizedBody = normalizeCommandBody(trimmed, options);
  if (!normalizedBody.startsWith("/")) return null;

  // 精确别名命中
  const exactKey = normalizedBody.toLowerCase();
  const exact = findCommandByTextAlias(exactKey);
  if (exact) {
    return { command: exact };
  }

  // /cmd <args> 命中
  const match = normalizedBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  const tokenKey = `/${match[1]!.toLowerCase()}`;
  const command = findCommandByTextAlias(tokenKey);
  if (!command) return null;
  const rest = match[2];
  if (rest && !command.acceptsArgs) return null;
  return { command, args: rest?.trimStart() };
}

/** 是否为新会话边界命令（/new /reset，OpenClaw isSessionBoundaryCommandText 移植）。 */
export function isSessionBoundaryCommandText(text: string): boolean {
  const normalized = normalizeCommandBody(text);
  return (
    /^\/(?:new|reset)(?:\s|$)/i.test(normalized) && !/^\/reset\s+soft(?:\s|$)/i.test(normalized)
  );
}

/** 解析命令参数（parseCommandArgs 便捷包装，按命中命令的定义解析）。 */
export function parseResolvedCommandArgs(resolved: ResolvedTextCommand): ReturnType<typeof parseCommandArgs> {
  return parseCommandArgs(resolved.command, resolved.args);
}
