// Command executor — 命令执行器（笔记 20/21）。
// openclaw dispatchChannelInboundTurn 语义：命令作为本地 turn 执行，绝不进模型。
// 每个命令通过 CommandExecutionCtx（index.ts 从事件 ctx 捕获）调用 pi 能力。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  findCommandByKey,
  getCommands,
  parseCommandArgs,
  type ChatCommandDefinition,
  type CommandExecutionCtx,
  type CommandResult,
} from "./registry.ts";

/** 执行依赖：pi API + 最近一次事件 ctx 捕获器（index.ts 注入）。 */
export interface CommandHandlerDeps {
  pi: ExtensionAPI;
  getCtx: () => CommandExecutionCtx | undefined;
}

const TERMINAL_ONLY =
  "该命令需要会话级权限，请在 pi 终端中执行（扩展 API 无法触发会话替换）。";

/** 统一答复前缀（对齐 openclaw command reply 风格）。 */
function reply(content: string, ephemeral = true): CommandResult {
  return { content, ephemeral };
}

/** 全部命令的 help 列表（essential 简表 + 全部详细表）。 */
function formatHelpList(essentialOnly: boolean): string {
  const commands = getCommands();
  const visible = essentialOnly
    ? commands.filter((c) => c.tier === "essential")
    : commands;
  const lines = visible.map((c) => {
    const name = c.nativeName ?? c.key;
    const argHint = c.args?.length
      ? c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")
      : "";
    return `/${name}${argHint ? " " + argHint : ""} — ${c.description}`;
  });
  const header = essentialOnly
    ? "**可用命令**（/commands 查看全部）："
    : "**全部命令**：";
  return [header, ...lines].join("\n");
}

/** 状态命令：模型 / 思考级别 / 上下文使用 / 空闲。 */
function formatStatus(ctx: CommandExecutionCtx, pi: ExtensionAPI): string {
  const model = ctx.getModelName() ?? "未设置";
  const thinking = pi.getThinkingLevel() ?? "default";
  const usage = ctx.getContextUsageText() ?? "未知";
  const state = ctx.isIdle() ? "空闲" : "运行中";
  return [
    `**模型**: ${model}`,
    `**思考**: ${thinking}`,
    `**上下文**: ${usage}`,
    `**状态**: ${state}`,
  ].join("\n");
}

/** 解析 /think 参数（default 表示显示当前；非法值返回 null）。 */
function parseThinkingLevel(raw: string | undefined): ThinkingLevel | "default" | null {
  const level = raw?.trim().toLowerCase();
  if (!level || level === "default") return "default";
  const valid: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  return (valid as string[]).includes(level) ? (level as ThinkingLevel) : null;
}

/**
 * 执行命令。args 为原始参数串（文本命令）或解析后的 CommandArgs（原生命令）。
 * 返回回复内容；ephemeral 控制 slash 命令是否仅自己可见。
 */
export async function executeCommand(
  command: ChatCommandDefinition,
  rawArgs: string | undefined,
  deps: CommandHandlerDeps,
): Promise<CommandResult> {
  const { pi, getCtx } = deps;
  const ctx = getCtx();
  const parsed = parseCommandArgs(command, rawArgs);
  const values = parsed?.values ?? {};

  switch (command.key) {
    case "help":
      return reply(formatHelpList(true), false);

    case "commands":
      return reply(formatHelpList(false), false);

    case "status": {
      if (!ctx) return reply("桥接尚未就绪（无事件上下文），请稍后再试。");
      return reply(formatStatus(ctx, pi), false);
    }

    case "stop": {
      if (!ctx) return reply("桥接尚未就绪，无法停止。");
      ctx.abort();
      return reply("⏹️ 已停止当前运行。");
    }

    case "compact": {
      if (!ctx) return reply("桥接尚未就绪，无法压缩。");
      const instructions = (values.instructions as string | undefined)?.trim();
      ctx.compact({ reason: instructions || undefined });
      return reply("🗜️ 已请求压缩上下文。");
    }

    case "think": {
      const level = parseThinkingLevel(rawArgs);
      if (level === null) {
        return reply("无效的思考级别。可用：low / medium / high / xhigh / max");
      }
      if (level === "default") {
        return reply(`🧠 当前思考级别：${pi.getThinkingLevel() ?? "default"}`);
      }
      pi.setThinkingLevel(level);
      return reply(`🧠 思考级别已设为 ${level}。`);
    }

    case "model": {
      const query = (values.model as string | undefined)?.trim();
      if (!query) {
        return reply(`🤖 当前模型：${ctx?.getModelName() ?? "未设置"}`);
      }
      if (!ctx) return reply("桥接尚未就绪，无法切换模型。");
      const ok = await ctx.setModel(query);
      return reply(
        ok
          ? `🤖 模型已切换：${query}`
          : `❌ 未找到模型 ${query}（/model 查看当前；模型 id 形如 provider/model）`,
      );
    }

    case "tools": {
      if (!ctx) return reply("桥接尚未就绪，无法列出工具。");
      const mode = (values.mode as string | undefined)?.trim() ?? "compact";
      const tools = ctx.getAllTools();
      if (mode === "verbose") {
        return reply([`**工具（${tools.length}）**：`, ...tools.map((t) => `• ${t}`)].join("\n"));
      }
      return reply(`**工具（${tools.length}）**：${tools.join(", ")}`);
    }

    case "usage": {
      if (!ctx) return reply("桥接尚未就绪，无法读取用量。");
      return reply(`📊 上下文使用：${ctx.getContextUsageText() ?? "未知"}`);
    }

    case "name": {
      const title = (values.title as string | undefined)?.trim();
      if (!title) return reply("用法：/name <标题>");
      ctx?.setSessionName(title);
      return reply(`📛 会话已命名：${title}`);
    }

    case "quit": {
      if (!ctx) return reply("桥接尚未就绪，无法退出。");
      ctx.shutdown();
      return reply("👋 正在退出 pi…");
    }

    case "new":
    case "reset":
      return reply(TERMINAL_ONLY);

    default:
      return reply(`未知命令：/${command.key}`);
  }
}

/** 按 key 查找并执行（index.ts 便捷入口）。 */
export async function executeCommandByKey(
  key: string,
  rawArgs: string | undefined,
  deps: CommandHandlerDeps,
): Promise<CommandResult> {
  const command = findCommandByKey(key);
  if (!command) return reply(`未知命令：/${key}`);
  return executeCommand(command, rawArgs, deps);
}
