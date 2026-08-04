// Dynamic pi command collection — 从 pi 动态获取命令清单（不写死，笔记 21 修订）。
// 来源：
//   1. BUILTIN_SLASH_COMMANDS（pi 内置 22 命令）—— 按实际安装位置深层导入，跟随 pi 版本
//   2. pi.getCommands()（扩展注册命令 + prompt 模板）—— 运行时动态
//   注意：skill:xxx 不注册（Discord 全局命令 100 上限 + 需终端执行），/help 会提示。
// 与本地 registry（有 handler 的可执行命令）合并：本地优先（同名覆盖）。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChatCommandDefinition } from "./registry.ts";
import { defineChatCommand } from "./registry.ts";

/** 已解析的 pi 包 slash-commands.js 物理路径（惰性）。 */
let piSlashCommandsPath: string | undefined;

/**
 * 解析 pi 包 slash-commands.js 物理路径。
 * package exports 只暴露 "." 与 "./rpc-entry"（子路径 resolve 失败），
 * 因此直接探测候选物理路径（跟随实际安装位置）：
 *   1. 项目 node_modules（peerDependency）
 *   2. 全局 node_modules（pi 本体安装位置）
 */
function resolvePiSlashCommandsPath(): string | undefined {
  if (piSlashCommandsPath) return piSlashCommandsPath;
  const relative = "node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
  // 从本模块（src/commands/）向上找项目 node_modules
  const here = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = here + "../..";
  const candidates = [
    projectRoot + "/" + relative,
    "/home/ubuntu/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        piSlashCommandsPath = candidate;
        return candidate;
      }
    } catch {
      // 继续下一个候选
    }
  }
  return undefined;
}

/** pi 内置命令（BUILTIN_SLASH_COMMANDS，22 个）；失败降级为空。 */
let builtinCommandsCache: ChatCommandDefinition[] | undefined;

/** Discord 命令名合法性：小写字母/数字/连字符/下划线，1-32 字符。 */
const DISCORD_COMMAND_NAME_RE = /^[a-z0-9-_]{1,32}$/;

/** 把非法 Discord 命令名转合法（skill:foo → skill-foo）；过长截断。 */
export function sanitizeDiscordCommandName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 32) || "command";
}

/**
 * 动态导入 pi 内置命令（BUILTIN_SLASH_COMMANDS，22 个）。
 * 用绝对路径绕过 package exports 限制（已验证可导入）；失败降级为空。
 */
export async function loadPiBuiltinCommands(): Promise<ChatCommandDefinition[]> {
  if (builtinCommandsCache) return builtinCommandsCache;
  const slashCommandsPath = resolvePiSlashCommandsPath();
  if (!slashCommandsPath) {
    builtinCommandsCache = [];
    return builtinCommandsCache;
  }
  try {
    const mod = (await import(slashCommandsPath)) as {
      BUILTIN_SLASH_COMMANDS?: Array<{ name: string; description: string }>;
    };
    const list = mod.BUILTIN_SLASH_COMMANDS ?? [];
    builtinCommandsCache = list
      .filter((c) => c && typeof c.name === "string" && c.name && DISCORD_COMMAND_NAME_RE.test(c.name))
      .map((c) =>
        defineChatCommand({
          key: `pi:${c.name}`,
          nativeName: c.name,
          description: c.description ?? "pi command",
          category: "session",
          tier: "standard",
          scope: "native",
        }),
      );
  } catch {
    builtinCommandsCache = [];
  }
  return builtinCommandsCache;
}

/** 收集 pi 动态命令（扩展命令 + prompt 模板；skills 跳过）。 */
export function collectPiRuntimeCommands(pi: ExtensionAPI): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [];
  try {
    for (const info of pi.getCommands()) {
      const name = info.name;
      if (!name) continue;
      if (info.source === "skill") continue; // 数量多 + 需终端，不注册
      if (!DISCORD_COMMAND_NAME_RE.test(name)) continue;
      commands.push(
        defineChatCommand({
          key: `pi:ext:${name}`,
          nativeName: name,
          description: info.description ?? "pi command",
          category: "tools",
          tier: "standard",
          scope: "native",
        }),
      );
    }
  } catch {
    // pi.getCommands 不可用时返回已收集部分
  }
  return commands;
}

/**
 * 合并本地 + 动态命令（本地优先，按 nativeName 去重）。
 * 返回注册到 Discord 的完整命令集。
 */
export function mergeCommandSets(
  local: ChatCommandDefinition[],
  dynamic: ChatCommandDefinition[],
): ChatCommandDefinition[] {
  const byNative = new Map<string, ChatCommandDefinition>();
  for (const command of [...local, ...dynamic]) {
    const name = command.nativeName;
    if (!name) continue;
    if (!byNative.has(name)) byNative.set(name, command);
  }
  return [...byNative.values()];
}

/** 在合并命令集中按原生名查找（本地 handler 优先）。 */
export function findMergedCommandByNativeName(
  merged: ChatCommandDefinition[],
  name: string,
): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return merged.find(
    (command) =>
      command.nativeName?.toLowerCase() === normalized ||
      (command.nativeAliases ?? []).some((alias) => alias.toLowerCase() === normalized),
  );
}
