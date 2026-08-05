// Command executor — 命令执行器（笔记 20/21/22）。
// openclaw dispatchChannelInboundTurn 语义：命令作为本地 turn 执行，绝不进模型。
// 每个命令通过 CommandExecutionCtx（index.ts 从事件 ctx 捕获）调用 pi 能力。
// 笔记 22：终端 only 命令桥接 —— 只读命令本地实现，导出走 RPC 桥，写命令引导终端。
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
import type { PiRpcBridge } from "../rpc/rpc-bridge.ts";

/** 执行依赖：pi API + 最近一次事件 ctx 捕获器（index.ts 注入）+ RPC 只读桥。 */
export interface CommandHandlerDeps {
  pi: ExtensionAPI;
  getCtx: () => CommandExecutionCtx | undefined;
  /** 只读 RPC 桥（/export 等；懒启动，可为 undefined）。 */
  rpc?: PiRpcBridge;
  /** 当前工作目录（RPC 导出路径校验用）。 */
  cwd?: string;
}

const TERMINAL_ONLY = (cmd: string, hint = "") =>
  `⚠️ 该命令需要会话级权限，无法从 Discord 触发（pi 扩展 API 无远程会话替换入口）。

**请在本机 pi 终端执行**：/${cmd}${hint ? ` ${hint}` : ""}

（上游限制见 issue #5952；本桥支持 /tree /session /copy /settings /export 等只读命令）`;

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

/** /settings：模型 / 思考 / 作用域 / 上下文 / 会话汇总。 */
function formatSettings(ctx: CommandExecutionCtx, pi: ExtensionAPI): string {
  const lines = [
    `**模型**: ${ctx.getModelName() ?? "未设置"}`,
    `**思考**: ${pi.getThinkingLevel() ?? "default"}`,
  ];
  const scoped = ctx.listScopedModels();
  if (scoped.length > 0) {
    lines.push(`**作用域模型**: ${scoped.join(", ")}`);
  } else {
    lines.push(`**作用域模型**: 全部可用`);
  }
  const usage = ctx.getContextUsageText();
  if (usage) lines.push(`**上下文**: ${usage}`);
  const info = ctx.getSessionInfo?.();
  if (info?.sessionName) lines.push(`**会话名**: ${info.sessionName}`);
  if (info?.sessionId) lines.push(`**会话 ID**: ${info.sessionId.slice(0, 8)}…`);
  return lines.join("\n");
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
  const { pi, getCtx, rpc } = deps;
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

    // ---- 笔记 22：终端 only 命令桥接（只读本地实现）----

    case "tree": {
      if (!ctx?.getSessionTreeText) return reply("该命令需要会话能力，请在终端执行 /tree");
      const text = ctx.getSessionTreeText();
      return reply(text ? `🌳 **会话树**：\n${text}` : "🌳 会话为空（暂无条目）。", false);
    }

    case "session": {
      if (!ctx?.getSessionInfo) return reply("该命令需要会话能力，请在终端执行 /session");
      const info = ctx.getSessionInfo();
      if (!info) return reply("无法读取会话信息。");
      const lines = [
        `📁 **会话文件**: ${info.sessionFile ?? "未知"}`,
        `🆔 **会话 ID**: ${info.sessionId ?? "未知"}`,
      ];
      if (info.sessionName) lines.push(`📛 **会话名**: ${info.sessionName}`);
      if (info.leafId) lines.push(`📍 **Leaf**: ${info.leafId.slice(0, 8)}…`);
      if (typeof info.entryCount === "number") lines.push(`📝 **条目数**: ${info.entryCount}`);
      return reply(lines.join("\n"), false);
    }

    case "copy": {
      if (!ctx?.getLastAssistantText) return reply("该命令需要会话能力，请在终端执行 /copy");
      const text = ctx.getLastAssistantText();
      if (!text) return reply("还没有 assistant 回复可复制。");
      return reply(`📋 **最后回复**：\n${text.slice(0, 1900)}`, false);
    }

    case "settings": {
      if (!ctx) return reply("桥接尚未就绪（无事件上下文），请稍后再试。");
      return reply(formatSettings(ctx, pi), false);
    }

    case "scoped-models": {
      if (!ctx) return reply("桥接尚未就绪（无事件上下文），请稍后再试。");
      const scoped = ctx.listScopedModels();
      return reply(
        scoped.length > 0
          ? `🎯 **作用域模型（${scoped.length}）**：${scoped.join(", ")}`
          : "🎯 作用域模型：全部可用（未配置 --models / enabledModels）",
        false,
      );
    }

    case "models": {
      if (!ctx?.listAllModels) return reply("该命令需要模型注册表，请在终端执行 /models");
      // 修复：有 model 参数时切换（复用 /model 的 setModel 逻辑），无参数时列出
      const query = (values.model as string | undefined)?.trim();
      if (query) {
        if (!ctx.setModel) return reply("桥接尚未就绪，无法切换模型。");
        const ok = await ctx.setModel(query);
        return reply(
          ok
            ? `🤖 模型已切换：${query}`
            : `❌ 未找到模型 ${query}（/models 查看全部；模型 id 形如 provider/model）`,
        );
      }
      const models = ctx.listAllModels();
      const current = ctx.getModelName();
      return reply(
        [
          `🤖 **模型（${models.length}）**：`,
          ...models.map((m) => (m === current ? `• ${m} ✅` : `• ${m}`)),
          `💡 切换：/models <模型 id>`,
        ].join("\n").slice(0, 1900),
        false,
      );
    }

    case "thinking-levels": {
      if (!ctx?.listThinkingLevels) return reply("该命令需要模型能力，请在终端执行");
      const levels = ctx.listThinkingLevels();
      return reply(`🧠 **可用思考级别**：${levels.join(", ")}`, false);
    }

    case "export": {
      if (!rpc) return reply("导出桥未启用（配置 rpc.enabled）。");
      const target = (values.path as string | undefined)?.trim();
      const path = await rpc.exportHtml(target || undefined);
      if (!path) return reply("❌ 导出失败（RPC export_html 未返回路径）。");
      return reply(`📦 **会话已导出**：` + `` + `${path}`, false);
    }

    case "changelog":
      return reply(
        "📜 **变更日志**：请查看 https://github.com/earendil-works/pi/releases（终端 /changelog 显示本地记录）",
        false,
      );

    case "hotkeys":
      return reply(
        "⌨️ **快捷键**：终端 /hotkeys 显示完整按键表。常用：Ctrl+N 新会话 · Ctrl+R 重试 · Ctrl+C 中止",
        false,
      );

    // ---- 写会话命令：引导终端（BACKLOG 约束，上游无 API）----
    case "new":
      return reply(TERMINAL_ONLY("new", "[可选初始化提示]"));
    case "reset":
      return reply(TERMINAL_ONLY("reset", "[soft|hard]"));
    case "fork":
      return reply(TERMINAL_ONLY("fork", "<entryId>"));
    case "clone":
      return reply(TERMINAL_ONLY("clone"));
    case "resume":
      return reply(TERMINAL_ONLY("resume", "<session>"));
    case "reload":
      return reply(TERMINAL_ONLY("reload"));
    case "login":
      return reply(TERMINAL_ONLY("login", "<provider>"));
    case "logout":
      return reply(TERMINAL_ONLY("logout", "<provider>"));
    case "trust":
      return reply(TERMINAL_ONLY("trust"));
    case "share":
      return reply(TERMINAL_ONLY("share"));
    case "import":
      return reply(TERMINAL_ONLY("import", "<path>"));

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
