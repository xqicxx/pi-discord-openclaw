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
import { todosAdd, todosDelete, todosList, todosSetStatus, todosShow } from "./todos.ts";
import { whimsyReset, whimsySet, whimsyStatus } from "./whimsy.ts";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 执行依赖：pi API + 最近一次事件 ctx 捕获器（index.ts 注入）+ RPC 只读桥。 */
export interface CommandHandlerDeps {
  pi: ExtensionAPI;
  getCtx: () => CommandExecutionCtx | undefined;
  /** 只读 RPC 桥（/export 等；懒启动，可为 undefined）。 */
  rpc?: PiRpcBridge;
  /** 当前工作目录（RPC 导出路径校验用）。 */
  cwd?: string;
  /** 发起者信息（Discord 用户 id / 角色 id 列表），用于权限校验。 */
  author?: { userId?: string; roleIds?: string[] };
  /** 授权配置（allowedUserIds / allowedRoleIds）。 */
  allowedUserIds?: string[];
  allowedRoleIds?: string[];
}

const TERMINAL_ONLY = (cmd: string, hint = "") =>
  `⚠️ 该命令需要会话级权限，无法从 Discord 触发（pi 扩展 API 无远程会话替换入口）。

**请在本机 pi 终端执行**：/${cmd}${hint ? ` ${hint}` : ""}

（上游限制见 issue #5952；本桥支持 /tree /session /copy /settings /export 等只读命令，/resume 可远程恢复会话）`;

/** 统一答复前缀（对齐 openclaw command reply 风格）。 */
function reply(content: string, ephemeral = true): CommandResult {
  return { content, ephemeral };
}

// ---- /resume 会话恢复（Discord 远程可用：改启动脚本 PI_SESSION + 重启桥自动恢复）----

/** 会话目录（可注入 dir 便于测试）。 */
export function resolveSessionDir(dir?: string): string {
  return dir ?? join(homedir(), ".pi", "agent", "sessions", "--home-ubuntu--");
}

/** 会话文件 → { id, file, label }；id = 文件名中的 UUID 部分。 */
export function parseSessionFile(file: string): { id: string; label: string; file: string } | null {
  const m = file.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f-]+)\.jsonl$/);
  if (!m) return null;
  // label: 2026-08-06 04:56:18.417 (id 前 8 位)
  const stamp = m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + ":" + m[6] + "." + m[7];
  return { id: m[8], label: stamp + " (" + m[8].slice(0, 8) + ")", file };
}

/** 最近 N 个会话（按文件名倒序 = 时间倒序）。 */
export async function listRecentSessions(limit = 10, dir?: string): Promise<Array<{ id: string; label: string; file: string }>> {
  const files = (await readdir(resolveSessionDir(dir))).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const sessions = files.map(parseSessionFile).filter((s): s is { id: string; label: string; file: string } => s !== null);
  return sessions.slice(0, limit);
}

/** 按前缀匹配会话：UUID 前缀或时间戳前缀（如 "019fd56d" / "2026-08-06T04"）。 */
export async function findSessionsByPrefix(prefix: string, dir?: string): Promise<Array<{ id: string; label: string; file: string }>> {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const sessions = await listRecentSessions(100, dir);
  return sessions.filter((s) => s.id.toLowerCase().startsWith(p) || s.file.toLowerCase().startsWith(p));
}

/** 会话列表排版（/resume /sessions 共用）。 */
export function formatSessionList(sessions: Array<{ id: string; label: string }>): string {
  return sessions.map((s) => `• ${s.label}`).join("\n");
}

/** 更新启动脚本 PI_SESSION 并重启桥（延迟 2s 确保确认回复已发出；失败仅记日志）。 */
export function scheduleBridgeRestart(sessionId: string, label: string): void {
  const script = "/usr/local/bin/pi-discord-start.sh";
  const cmd = `sed -i 's/^PI_SESSION=.*/PI_SESSION=${sessionId}/' ${script} && systemctl restart pi-discord`;
  setTimeout(() => {
    execFile("sudo", ["bash", "-c", cmd], { timeout: 30_000 }, (err) => {
      if (err) console.error("[pi-discord-openclaw] /resume 重启失败:", err.message);
      else console.log(`[pi-discord-openclaw] /resume → 会话 ${label} 已排定重启`);
    });
  }, 2_000);
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

  // 用户级授权：管理命令仅允许授权用户执行（默认仅 owner）。
  const ADMIN_COMMANDS = new Set(["quit", "bye", "exit", "resume", "reload", "export", "model", "compact", "compress", "todos", "whimsy"]);
  if (ADMIN_COMMANDS.has(command.key)) {
    const userId = deps.author?.userId;
    const roleIds = deps.author?.roleIds ?? [];
    const allowedUsers = deps.allowedUserIds ?? [];
    const allowedRoles = deps.allowedRoleIds ?? [];
    const isOwner = userId && allowedUsers.length === 0 ? true : allowedUsers.includes(userId ?? "");
    const hasRole = roleIds.some((r) => allowedRoles.includes(r));
    if (!isOwner && !hasRole) {
      return reply("⛔ 你没有权限执行此命令（仅授权用户可操作）。");
    }
  }

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

    // 笔记 36：/compact 别名（用户可能输入 /compact 或 /compress）
    case "compress": {
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

    // 笔记 26：bye/exit = quit 别名（扩展 whimsical 的退出命令）
    case "bye":
    case "exit": {
      if (!ctx) return reply("桥接尚未就绪，无法退出。");
      ctx.shutdown();
      return reply("👋 正在退出 pi…");
    }

    // 笔记 26：/whimsy 本地桥接（状态在 settings.json，与扩展同格式）
    case "whimsy": {
      try {
        const action = (values.action as string | undefined)?.trim().toLowerCase() ?? "status";
        switch (action) {
          case "on":
            return reply(await whimsySet(true), false);
          case "off":
            return reply(await whimsySet(false), false);
          case "reset":
            return reply(await whimsyReset(), false);
          case "status":
          default:
            return reply(await whimsyStatus(), false);
        }
      } catch (err) {
        return reply(`❌ /whimsy 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 笔记 26：/sessions 只读列表（切换会话需终端——上游 switchSession 仅命令 ctx 可用）
    case "sessions": {
      if (!ctx?.getSessionInfo) return reply("该命令需要会话能力，请在终端执行 /sessions");
      try {
        const { readdir } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const pathMod = await import("node:path");
        const dir = pathMod.join(homedir(), ".pi", "agent", "sessions", "--home-ubuntu--");
        const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
        if (files.length === 0) return reply("📁 暂无会话文件。");
        const lines = files.slice(0, 15).map((f) => {
          const m = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+)\.jsonl$/);
          return `• ${m ? m[1].replace("T", " ").replace("-", ":") : f}`;
        });
        return reply([`📁 **会话文件（最近 ${lines.length} 个）**：`, ...lines, "💡 恢复会话：/resume <id>（Discord 远程重启恢复，约 15s）"].join("\n"), false);
      } catch (err) {
        return reply(`❌ /sessions 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
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

    // 笔记 26：/todos 本地实现（方案二——TUI 命令远程不可用，桥接层直接读写 .pi/todos）
    case "todos": {
      const action = (values.action as string | undefined)?.trim().toLowerCase() ?? "list";
      const rest = (values.args as string | undefined)?.trim() ?? "";
      try {
        const cwd = deps.cwd ?? process.cwd();
        switch (action) {
          case "list":
            return reply(await todosList(cwd), false);
          case "add":
            return reply(await todosAdd(cwd, rest), false);
          case "done":
            return reply(await todosSetStatus(cwd, rest, "closed"), false);
          case "open":
            return reply(await todosSetStatus(cwd, rest, "open"), false);
          case "show":
            return reply(await todosShow(cwd, rest), false);
          case "delete":
            return reply(await todosDelete(cwd, rest), false);
          default:
            return reply(`未知动作：${action}（可用 list/add/done/open/show/delete）`);
        }
      } catch (err) {
        return reply(`❌ /todos ${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
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

    // 笔记 37：/context-simple 桥接（pi 终端命令，扩展 API 无远程触发入口，桥侧等价实现）
    case "context-simple": {
      if (!ctx) return reply("桥接尚未就绪（无事件上下文），请稍后再试。");
      const lines: string[] = [];
      const usage = ctx.getContextUsageText();
      if (usage) lines.push(`**上下文使用**: ${usage}`);
      const sysPrompt = pi.getSystemPrompt?.();
      if (sysPrompt) lines.push(`**系统提示**: ${sysPrompt.slice(0, 500)}${sysPrompt.length > 500 ? "…" : ""}`);
      const commands = pi.getCommands();
      if (commands.length > 0) {
        lines.push(`**命令（${commands.length}）**: ${commands.map((c) => c.name).join(", ")}`);
      }
      const activeTools = pi.getActiveTools?.();
      if (activeTools && activeTools.length > 0) {
        lines.push(`**活动工具（${activeTools.length}）**: ${activeTools.join(", ")}`);
      }
      const allTools = ctx.getAllTools();
      if (allTools.length > 0) {
        lines.push(`**全部工具（${allTools.length}）**: ${allTools.join(", ")}`);
      }
      return reply(lines.length > 0 ? lines.join("\n") : "（无上下文信息）", false);
    }

    // ---- 写会话命令：引导终端（BACKLOG 约束，上游无 API）----
    case "new":
      return reply(TERMINAL_ONLY("new", "[可选初始化提示]"));
    case "reset":
      return reply(TERMINAL_ONLY("reset", "[soft|hard]"));
    case "fork":
      return reply(TERMINAL_ONLY("fork", "<entryId>"));
    case "clone":
      return reply(TERMINAL_ONLY("clone"));
    case "resume": {
      // 笔记 36：Discord 远程恢复会话——列出/匹配会话，改启动脚本 PI_SESSION + 重启桥（Restart=always 自动恢复）。
      // 无需终端 /resume；重启约 15s，上下文不丢（--session 启动参数恢复）。
      const target = (rawArgs ?? "").trim();
      const currentId = ctx?.getSessionInfo()?.sessionId;
      try {
        if (!target) {
          const recent = await listRecentSessions(10);
          if (recent.length === 0) return reply("📁 暂无会话文件。");
          return reply(
            [
              "📁 **最近会话**（/resume <id> 恢复，约 15s 重启）:",
              formatSessionList(recent),
              "💡 id 可用前缀（如 019fd56d 或 2026-08-06T04），/resume last 恢复最近一个",
            ].join("\n"),
            false,
          );
        }
        if (target === "last") {
          const recent = await listRecentSessions(2);
          if (recent.length === 0) return reply("📁 暂无会话文件。");
          const pick = recent.find((s) => s.id !== currentId) ?? recent[0];
          if (pick.id === currentId) return reply("✅ 已在当前会话。");
          scheduleBridgeRestart(pick.id, pick.label);
          return reply(`♻️ 正在恢复会话 ${pick.label}… bot 将重启（约 15s），恢复后上下文完整。`, false);
        }
        const matches = await findSessionsByPrefix(target);
        if (matches.length === 0) return reply(`❌ 未找到匹配 ` + target + ` 的会话（/resume 查看列表）。`);
        if (matches.length > 1) {
          return reply(
            [`⚠️ 匹配到 ${matches.length} 个会话，请用更精确的前缀：`, formatSessionList(matches)].join("\n"),
            false,
          );
        }
        const pick = matches[0];
        if (pick.id === currentId) return reply("✅ 已在当前会话。");
        scheduleBridgeRestart(pick.id, pick.label);
        return reply(`♻️ 正在恢复会话 ${pick.label}… bot 将重启（约 15s），恢复后上下文完整。`, false);
      } catch (err) {
        return reply(`❌ /resume 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    case "reload": {
      // 热重载扩展/skills/prompts/themes（需环境变量 RELOAD_ALLOWED=1 才允许远程触发，默认关闭）
      if (process.env.RELOAD_ALLOWED !== "1") {
        return reply("⚠️ 远程 /reload 未启用。如需从 Discord 热重载，请设置环境变量 RELOAD_ALLOWED=1 后重启服务。");
      }
      try {
        await pi.reload();
        return reply("♻️ 已热重载扩展/skills/prompts/themes。");
      } catch (err) {
        return reply(`❌ /reload 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
