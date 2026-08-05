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

/**
 * 收集 pi 动态命令（扩展命令 + prompt 模板 + skills，S184 全部注册）。
 * source/sourcePath 保留用于本地执行路由：
 * - extension：无本地 handler → 引导终端
 * - prompt：读取模板内容作为 user message 发送（本地执行模板）
 * - skill：读取 SKILL.md 内容作为 user message 发送（加载 skill 指令）
 */
export function collectPiRuntimeCommands(pi: ExtensionAPI): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [];
  try {
    for (const info of pi.getCommands()) {
      const name = info.name;
      if (!name) continue;
      // S184：skill 命令名形如 skill:xxx（Discord 命令名不允许冒号）→ sanitize
      const nativeName = DISCORD_COMMAND_NAME_RE.test(name)
        ? name
        : sanitizeDiscordCommandName(name);
      if (!nativeName) continue;
      const source = info.source === "skill" || info.source === "prompt" ? info.source : "extension";
      commands.push(
        defineChatCommand({
          key: `pi:${source}:${nativeName}`,
          nativeName,
          description: info.description ?? "pi command",
          category: "tools",
          tier: "standard",
          scope: "native",
          source,
          sourcePath: info.sourceInfo?.path,
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

/**
 * 过滤 Discord 注册集（笔记 25 修复）：
 * - 排除 skill 命令（数量多 + 需终端执行；保留在 merged 集供文本 /skill-xxx 本地执行）
 * - 保底截断 100（Discord 全局命令上限；mergeCommandSets 已保证本地+builtin 在前）
 */
export function filterDiscordRegisterableCommands(
  merged: ChatCommandDefinition[],
): ChatCommandDefinition[] {
  return merged.filter((command) => command.source !== "skill").slice(0, 100);
}

/**
 * 过滤 guild 注册集（笔记 25 续：/skill:xxx 进 Discord）：
 * 提取全部 skill 命令注册到 guild（独立 100/guild 额度，全局 88 不动），
 * 保底截断 100。交互执行路径（executeDynamicSourceCommand）已就绪。
 */
export function filterGuildRegisterableCommands(
  merged: ChatCommandDefinition[],
): ChatCommandDefinition[] {
  return merged.filter((command) => command.source === "skill").slice(0, 100);
}
/**
 * 笔记 25 续：/skill:xxx 分类进 Discord —— 单个 /skill 顶级命令 + 每 skill 一个子命令
 * （/skill github /skill reading…），替代 55 个平铺 /skill-xxx。
 * 子命令计入 Discord 100 上限（全局 88+55=143 超限，仍走 guild 额度：1+55=56 ≤ 100）。
 * 子命令名 = nativeName 去 "skill-" 前缀（github/reading/…），非法则保留全名。
 */
export interface SkillSubcommandSpec {
  /** 子命令名（Discord 合法名）。 */
  subName: string;
  /** 对应 skill 命令（merged 集条目，source==="skill"）。 */
  skill: ChatCommandDefinition;
}

export function extractSkillSubcommands(merged: ChatCommandDefinition[]): SkillSubcommandSpec[] {
  const seen = new Set<string>();
  const specs: SkillSubcommandSpec[] = [];
  for (const skill of merged) {
    if (skill.source !== "skill") continue;
    const native = skill.nativeName ?? "";
    const stripped = native.replace(/^skill-/, "");
    let subName = stripped && DISCORD_COMMAND_NAME_RE.test(stripped) ? stripped : native;
    // 去重冲突：同名子命令时保留全名（极罕见，防御）
    let candidate = subName;
    let n = 2;
    while (seen.has(candidate)) {
      candidate = `${subName}-${n++}`;
    }
    subName = candidate;
    seen.add(subName);
    specs.push({ subName, skill });
  }
  return specs;
}

/** 按子命令名查 skill 命令（handleInteraction 分发用）。 */
export function findSkillBySubcommand(
  merged: ChatCommandDefinition[],
  subName: string,
): ChatCommandDefinition | undefined {
  const sub = subName.trim().toLowerCase();
  if (!sub) return undefined;
  return extractSkillSubcommands(merged).find((s) => s.subName === sub)?.skill;
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
