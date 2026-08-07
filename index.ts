/**
 * pi-discord-openclaw — Discord bridge for Pi with OpenClaw-style streaming.
 *
 * 改造自 pi-telegram-openclaw（以 openclaw extensions/discord 为蓝本，笔记 09-15）。
 * 命令系统（笔记 20/21）：文本 /xx 拦截 + Discord 原生命令注册/分发，本地执行不进模型。
 * 架构（解耦 + 简单 + 高性能）：
 *   Discord ⇄ transport (REST + Gateway) ⇄ OpenclawBridge ⇄ pi agent
 *                         │
 *                         ├─ AnswerLane     📝 流式编辑（draft-stream，2000 分块/throttle/重试）
 *                         ├─ ReasoningLane  🧠 思考流（<think> 提取 + 🧠 斜体渲染）
 *                         ├─ ProgressLane   🔧 工具进度（tool-start/update/end 行）
 *                         └─ InboundDebouncer ⏭️ 连续输入合并
 *   CommandLane（新增）：文本 /xx + slash 命令 → 本地执行（abort/compact/model/...）
 *
 * 入口职责：读配置 → 建 transport → 收消息（MESSAGE_CREATE）→ 文本命令拦截 →
 * 提交 pi；订阅 pi 事件 → 驱动 lanes → 经 REST 发送/编辑；ready 后注册 slash 命令，
 * INTERACTION_CREATE → 命令分发。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadDiscordConnectionConfig,
  loadOpenclawStyleConfig,
  isOpenclawStyleEnabled,
  type DiscordConnectionConfig,
  type OpenclawStyleConfig,
} from "./src/config.ts";
import { DiscordRest } from "./src/transport/discord-rest.ts";
import {
  createDiscordReactionAdapter,
  createStatusReactionController,
  STATUS_TIMING,
  type StatusReactionController,
} from "./src/feedback/ack-reactions.ts";
import {
  convertMarkdownTables,
  convertTextWithTables,
  stripInlineDirectiveTagsForDelivery,
} from "./src/dispatch/markdown-tables.ts";
import { DiscordGateway } from "./src/transport/discord-gateway.ts";
import { OpenclawBridge, type DiscordDelivery } from "./src/dispatch/dispatch.ts";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resolveTextCommand } from "./src/commands/text-commands.ts";
import { isAbortRequestText } from "./src/interrupt/abort-triggers.ts";
import {
  findCommandByNativeName,
  type CommandExecutionCtx,
} from "./src/commands/registry.ts";
import { executeCommand } from "./src/commands/handler.ts";
import {
  buildDiscordCommandOptions,
  truncateDiscordCommandDescription,
} from "./src/commands/options.ts";
import {
  buildSkillGroups,
  collectPiRuntimeCommands,
  filterDiscordRegisterableCommands,
  findSkillBySubcommand,
  loadPiBuiltinCommands,
  mergeCommandSets,
  findMergedCommandByNativeName,
} from "./src/commands/pi-commands.ts";
import { getCommands, type ChatCommandDefinition } from "./src/commands/registry.ts";
import { PiRpcBridge } from "./src/rpc/rpc-bridge.ts";
import {
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  type DiscordInteraction,
} from "./src/transport/types.ts";

const TAG = "[pi-discord-openclaw]";

// 笔记 28：abort 触发词识别已提取至 src/interrupt/abort-triggers.ts（可单测；
// 顺带修复原 `/s+/g` 丢失反斜杠的 bug——英文触发词 stop/abort 等此前归一化后永远不命中）。
// 用户发「停止/暂停/stop/abort」等时直接中断当前任务，不进 agent。

/** 延迟（openclaw sleep；表情终态 hold 用）。 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 最后一条 assistant 完整文本（/copy 用；message_end 缓存，模块级便于 adaptCommandCtx 闭包引用）
let lastAssistantText: string | undefined;

// Gateway intents: Guilds | GuildMessages | DirectMessages | MessageContent
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/**
 * config 的 streaming.mode（progress/partial/full）→ dispatch 的 StreamMode
 * （off/partial/block/progress）。"full" 对应 openclaw 的 "block"（回答+进度都要）。
 */
function toStreamMode(mode: "progress" | "partial" | "full"): "off" | "partial" | "block" | "progress" {
  return mode === "full" ? "block" : mode;
}

/**
 * 把 pi 的 assistantMessageEvent（text_delta/thinking_delta/toolcall_*）
 * 转成 OpenclawActivityEvent（映射同 activity-adapter，但事件名来自 pi-ai）。
 */
function adaptPiAssistantEvent(event: AssistantMessageEvent) {
  switch (event.type) {
    case "text_delta":
      return { type: "assistant-text-delta" as const, delta: event.delta };
    case "thinking_delta":
      return { type: "reasoning-delta" as const, delta: event.delta };
    case "thinking_end":
      return { type: "reasoning-end" as const };
    case "toolcall_start":
      return { type: "tool-start" as const, id: `toolcall-${event.contentIndex ?? 0}` };
    case "toolcall_end":
      return { type: "tool-end" as const, id: `toolcall-${event.contentIndex ?? 0}`, ok: true };
    default:
      return undefined;
  }
}

/** 把 pi 事件 ctx 适配为命令执行能力面（笔记 21）。 */
function adaptCommandCtx(pi: ExtensionAPI, ctx: ExtensionContext): CommandExecutionCtx {
  return {
    isIdle: () => ctx.isIdle(),
    abort: () => ctx.abort(),
    compact: (options) => ctx.compact({ customInstructions: options?.reason }),
    shutdown: () => ctx.shutdown(),
    getModelName: () => ctx.model?.id,
    getThinkingLevel: () => ctx.thinkingLevel ?? "medium",
    getContextUsageText: () => {
      const usage = ctx.getContextUsage();
      if (!usage) return undefined;
      return `${usage.tokens ?? "?"} / ${usage.contextWindow} tokens (${usage.percent ?? "?"}%)`;
    },
    getSystemPrompt: () => ctx.getSystemPrompt(),
    listScopedModels: () => ctx.scopedModels.map((entry) => entry.model.id),
    getAllTools: () => pi.getAllTools().map((tool) => tool.name),
    setSessionName: (name) => pi.setSessionName(name),
    // ---- 笔记 22：只读会话能力面 ----
    getSessionInfo: () => {
      const sm = ctx.sessionManager;
      if (!sm) return undefined;
      let entryCount: number | undefined;
      try {
        entryCount = sm.getEntries().length;
      } catch { /* 空会话等 */ }
      return {
        sessionFile: sm.getSessionFile(),
        sessionId: sm.getSessionId(),
        sessionName: sm.getSessionName(),
        leafId: sm.getLeafId(),
        entryCount,
      };
    },
    getSessionTreeText: () => {
      const sm = ctx.sessionManager;
      if (!sm) return undefined;
      try {
        const tree = sm.getTree() as unknown as Array<{
          entry: { id: string; message?: { role?: string; content?: unknown } };
          children: unknown[];
          label?: string;
        }>;
        if (!tree || tree.length === 0) return "（空会话）";
        const lines: string[] = [];
        const walk = (nodes: typeof tree, prefix: string) => {
          for (const node of nodes) {
            const role = node.entry.message?.role ?? "?";
            const content = node.entry.message?.content;
            const text =
              typeof content === "string"
                ? content.replace(/\s+/g, " ").slice(0, 50)
                : Array.isArray(content)
                  ? JSON.stringify(content).replace(/\s+/g, " ").slice(0, 50)
                  : "";
            const label = node.label ? ` [${node.label}]` : "";
            lines.push(
              `${prefix}${role === "user" ? "👤" : role === "assistant" ? "🤖" : "•"} ${node.entry.id.slice(0, 8)}: ${text}${label}`,
            );
            walk(node.children as typeof tree, prefix + "  ");
          }
        };
        walk(tree, "");
        return lines.join("\n");
      } catch {
        return undefined;
      }
    },
    getLastAssistantText: () => lastAssistantText,
    listAllModels: () => {
      try {
        return ctx.modelRegistry.getAll().map((m) => m.id);
      } catch {
        return [];
      }
    },
    listThinkingLevels: () => {
      try {
        return ctx.model
          ? (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as string[])
          : [];
      } catch {
        return [];
      }
    },
    getSettingsText: () => {
      const model = ctx.model?.id ?? "未设置";
      const thinking = ctx.thinkingLevel ?? "default";
      const usage = ctx.getContextUsage();
      const usageText = usage
        ? `${usage.tokens ?? "?"} / ${usage.contextWindow} (${usage.percent ?? "?"}%)`
        : "未知";
      const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model.id).join(", ") : "全部可用";
      const name = ctx.sessionManager?.getSessionName?.();
      return [
        `**模型**: ${model}`,
        `**思考**: ${thinking}`,
        `**上下文**: ${usageText}`,
        `**作用域模型**: ${scoped}`,
        ...(name ? [`**会话名**: ${name}`] : []),
      ].join("\n");
    },
    setModel: async (query) => {
      const trimmed = query.trim();
      if (!trimmed) return false;
      const slash = trimmed.indexOf("/");
      let model;
      if (slash !== -1) {
        model = ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
      } else {
        model = ctx.modelRegistry.getAll().find((m) => m.id === trimmed || m.name === trimmed);
      }
      if (!model) return false;
      try {
        return await pi.setModel(model);
      } catch {
        return false;
      }
    },
  };
}

/**
 * 扩展入口。启用条件：discord.json 配置 openclawStyle.enabled: true 且
 * 提供 DISCORD_BOT_TOKEN（环境变量或 discord.json 的 token）。
 */
export default function (pi: ExtensionAPI) {
  // 笔记 30：重启检测——上次异常退出（崩溃/SIGKILL）时启动发提示，
  // 避免服务重启后旧方块/表情残留「卡在那以为还在跑」
  const CRASH_MARK = "/tmp/pi-discord-crash-mark";
  const ACTIVE_CH_FILE = "/tmp/pi-discord-active-channel";
  // 配置校验提前：未配置 token / 未启用 openclawStyle 时直接早退，
  // 不注册信号处理器、不写崩溃标记（避免 TDZ 和误判崩溃）
  const conn: DiscordConnectionConfig = loadDiscordConnectionConfig();
  if (!conn.token) {
    console.log(`${TAG} 未配置 DISCORD_BOT_TOKEN（discord.json 或环境变量），已跳过`);
    return;
  }
  if (!isOpenclawStyleEnabled()) {
    console.log(`${TAG} discord.json 未启用 openclawStyle.enabled，已跳过`);
    return;
  }

  let crashedLastRun = false;
  try {
    if (existsSync(CRASH_MARK)) crashedLastRun = true;
    writeFileSync(CRASH_MARK, String(process.pid));
  } catch { /* 标记失败不影响主流程 */ }
  // 笔记 31：停机通知——正常重启（更新代码/systemctl restart）也发 Discord 消息，
  // 用户正在使用时不会「分不清 bot 是死了还是重启」。SIGHUP 也处理（tmux kill-server
  // 会给 pi 发 SIGHUP，只监听 SIGTERM 会漏）。尽力而为：3s 兜底强制退出。
  // 配置校验已在上方提前完成（issue #118），rest 直接 const 初始化——
  // 闭包内 let 窄化失效导致 6 处 'rest possibly undefined'（issue #115 typecheck）。
  const rest = new DiscordRest({ token: conn.token });
  const notifyShutdown = (): void => {
    try { rmSync(CRASH_MARK); } catch { /* 忽略 */ }
    const ch = (() => {
      try { return readFileSync(ACTIVE_CH_FILE, "utf8").trim() || undefined; } catch { return undefined; }
    })();
    if (!ch) { process.exit(0); return; }
    void rest
      .createChannelMessage(ch, { content: "🔄 服务重启中，约 15 秒后恢复…" })
      .catch(() => {})
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => notifyShutdown());
  process.on("SIGHUP", () => notifyShutdown());

  const cfg: OpenclawStyleConfig = loadOpenclawStyleConfig();
  const gateway = new DiscordGateway({ token: conn.token, intents: DISCORD_INTENTS });

  // 当前活跃频道（最近收到用户消息的 channel_id；agent 回复发往该频道）
  const activeChannelIds = new Map<string, string>();
  // Issue #30 回归修复：pi ExtensionContext 无 chatId 字段，map 按 Discord channel_id
  // 建 key 永远查不到 → beginTurn chatId 落到 "default" → 404 静默失败。
  // 用「最近活跃频道」兜底（单会话模型下语义正确）。
  let lastActiveChannelId: string | undefined;
  // typing 节流（笔记 25 性能：10s 一次）
  const lastTypingAtMs = new Map<string, number>();
  // 命令执行 ctx（最近一次事件 handler 的 ExtensionContext 适配，笔记 21）
  let commandCtx: CommandExecutionCtx | undefined;
  // bot username（/cmd@bot mention 剥离用，READMEY.user）
  let botUsername: string | undefined;
  // application id（slash 命令注册，READMEY.application.id）
  let applicationId: string | undefined;
  // 合并后的命令集（本地可执行 + pi 动态命令），ready 后填充
  let mergedCommands: ReturnType<typeof getCommands> | undefined;
  // RPC 只读桥（/export 等；懒启动，笔记 22）
  const rpc = new PiRpcBridge({ idleMs: 30_000 });

  // 笔记 30：错误通知——关键错误发到 discord 频道（不再静默）。
  // 限频：30s 窗口内最多 1 条，避免错误风暴刷屏。
  let lastErrorNoticeAt = 0;
  // 笔记 36：上下文阈值提醒限频（10 分钟 1 次，避免每 turn 刷屏）。
  let lastCtxWarnAt = 0;
  function notifyError(title: string, error: unknown): void {
    const now = Date.now();
    if (now - lastErrorNoticeAt < 30_000) return;
    lastErrorNoticeAt = now;
    const chatId = lastActiveChannelId;
    if (!chatId) return;
    const detail =
      error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    void rest
      .createChannelMessage(chatId, {
        content: `⚠️ **pi-discord 错误 · ${title}**\n\`${String(detail).slice(0, 400)}\``,
      })
      .catch(() => {});
  }

  const delivery: DiscordDelivery = {
    sendMessage: async (chatId, text, embeds) => {
      // issue #113：首条发送必须透传 embeds（否则 Embed 表格只在后续编辑时才可能补上）
      const sent = await rest.createChannelMessage(chatId, {
        content: text,
        ...(embeds ? { embeds } : {}),
      });
      if (!sent.id) throw new Error(`${TAG} sendMessage: no message id`);
      return sent.id;
    },
    editMessage: async (chatId, messageId, text, embeds) => {
      // issue 59：透传 embeds，否则流式编辑 PATCH 会清掉已发送的 Embed 表格
      await rest.editChannelMessage(chatId, messageId, text, embeds);
    },
    deleteMessage: async (chatId, messageId) => {
      await rest.deleteChannelMessage(chatId, messageId);
    },
    sendChatAction: async (chatId) => {
      // 笔记 25 性能：typing 节流 10s（Discord 官方建议间隔；每次 flush 都发会触发
      // typing 限流 5/10s → 429，且白白占用请求预算）
      const now = Date.now();
      const last = lastTypingAtMs.get(chatId) ?? 0;
      if (now - last < 10_000) return;
      lastTypingAtMs.set(chatId, now);
      await rest.sendChannelTyping(chatId).catch(() => {});
    },
  };

  const bridge = new OpenclawBridge({
    delivery,
    config: {
      streamMode: toStreamMode(cfg.streaming.mode),
      throttleMs: cfg.streaming.throttleMs,
      chunkSize: cfg.streaming.chunkSize,
      reasoningEnabled: cfg.reasoning.enabled,
      toolProgressEnabled: cfg.toolProgress.enabled,
      debounceMs: cfg.inbound.debounceMs,
      toolProgressLines: cfg.streaming.toolProgress,
      // 笔记 30：思考/输出强区分——receiptSummary 把方块折叠成小字摘要，
      // maxLineChars 收敛思考行长度（openclaw progress.maxLineChars）
      receiptSummary: cfg.streaming.receiptSummary,
      maxLineChars: cfg.streaming.maxLineChars,
      maxProgressLines: cfg.toolProgress.maxLines,
      // 笔记 30：投递失败发到 discord（不再静默丢消息）
      onDeliveryFailed: (error, context) => notifyError(`投递失败（${context}）`, error),
      // 笔记 24：最终回答投递前格式化（表格 → 对齐 ASCII 代码块 + 指令标签剥离）
      // 笔记 26：区分靠 openclaw 折叠摘要（progress 方块变 -# 小字摘要），回答不加分隔线
      // issue 59：tableMode="embed" 时文本中的表格全部 → Discord Embed fields，
      // 非表格内容保留在 content；超出 Embed 限制自动回退 ASCII 代码块（不丢内容）
      formatAnswerText: (text) => {
        const stripped = stripInlineDirectiveTagsForDelivery(text).text;
        const mode = cfg.tableMode ?? "code";
        if (mode === "embed") {
          const converted = convertTextWithTables(stripped, {
            color: cfg.embedStyle?.color,
            imageUrl: cfg.embedStyle?.imageUrl,
            footerText: cfg.embedStyle?.footerText,
          });
          if (converted) return { content: converted.content, embeds: converted.embeds };
          // 笔记 30：表格在中间等不适合 embed 的场景（embed 只能在 content 下方）——
          // 回退 bullets（第一列加粗 + 子弹列表），位置正确且不生硬（openclaw 语义）
          return convertMarkdownTables(stripped, "bullets");
        }
        return convertMarkdownTables(stripped, mode === "off" ? "off" : "code");
      },
    },
  });

  // ---- 命令系统（笔记 20/21）----

  /** 文本命令回复：直接发消息（命令不走 lanes/agent）。 */
  async function replyTextCommand(channelId: string, content: string): Promise<void> {
    await rest.createChannelMessage(channelId, { content }).catch((error) => {
      console.error(`${TAG} text command reply failed:`, error?.message ?? error);
      notifyError("命令回复发送失败", error);
    });
  }

  /** interaction 首次响应（ephemeral 由命令结果决定）。 */
  async function respondInteraction(
    interaction: DiscordInteraction,
    content: string,
    ephemeral: boolean,
  ): Promise<void> {
    const payload = {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content,
        ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
      },
    };
    try {
      await rest.createInteractionResponse(interaction.id, interaction.token, payload);
    } catch (error) {
      // 首次响应失败（3s 超时/已响应）→ followUp 兜底（笔记 25：失败要留日志，否则静默「无响应」）
      console.error(
        `${TAG} interaction 首次响应失败：`,
        error instanceof Error ? error.message : String(error),
      );
      if (interaction.application_id) {
        await rest
          .createInteractionFollowUp(interaction.application_id, interaction.token, {
            content,
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          })
          .catch((followUpError) => {
            console.error(
              `${TAG} interaction followUp 兜底失败：`,
              followUpError instanceof Error ? followUpError.message : String(followUpError),
            );
          });
      }
    }
  }

  /** interaction followUp（首次响应后追加消息；笔记 25：prompt/skill 执行失败引导用）。 */
  async function followUpInteraction(
    interaction: DiscordInteraction,
    content: string,
    ephemeral: boolean,
  ): Promise<void> {
    if (!interaction.application_id) return;
    await rest
      .createInteractionFollowUp(interaction.application_id, interaction.token, {
        content,
        ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
      })
      .catch((error) => {
        console.error(
          `${TAG} interaction followUp 失败：`,
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  /** 读取 interaction options → 原始参数字符串（空格拼接）。 */
  function readInteractionArgs(interaction: DiscordInteraction): string | undefined {
    const options = interaction.data?.options;
    if (!options?.length) return undefined;
    return options
      .map((option) => (typeof option.value === "string" ? option.value : String(option.value ?? "")))
      .join(" ");
  }

  /**
   * S184：动态命令本地执行（prompt 模板 / skill 指令）。
   * 读模板/SKILL.md 内容作为 user message 发给 agent（与终端行为一致）；
   * 非 prompt/skill 源或读取失败返回 false（由调用方引导终端执行）。
   * 注意（笔记 25）：本函数不发消息——「已加载」提示由调用方负责
   * （interaction 必须先响应防 3s 超时；文本路径用 replyTextCommand）。
   */
  async function executeDynamicSourceCommand(
    command: ChatCommandDefinition,
  ): Promise<boolean> {
    const source = command.source;
    const sourcePath = command.sourcePath;
    if ((source !== "prompt" && source !== "skill") || !sourcePath) return false;
    try {
      const fs = await import("node:fs");
      if (!fs.existsSync(sourcePath)) return false;
      const content = fs.readFileSync(sourcePath, "utf8");
      if (!content?.trim()) return false;
      pi.sendUserMessage(content, { deliverAs: "followUp" });
      return true;
    } catch (err) {
      console.error(
        `${TAG} 动态命令 /${command.nativeName} 本地执行失败：`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /** slash 命令分发（本地执行，不进模型）。动态命令（pi 内置/扩展，无本地 handler）提示终端。 */
  async function handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (interaction.type !== InteractionType.ApplicationCommand) return;
    const name = interaction.data?.name;
    if (!name) return;
    // 频道 allowlist 与消息一致
    const channelId = interaction.channel_id;
    if (conn.channels?.length && channelId && !conn.channels.includes(channelId)) {
      await respondInteraction(interaction, "该频道未授权使用命令。", true);
      return;
    }
    // 本地可执行命令优先；否则查动态合并集（pi 内置/扩展命令 → 提示终端）
    const local = findCommandByNativeName(name);
    const merged = mergedCommands;
    try {
      if (local) {
        // /resume 特判：先 defer（3s 内 ACK），再执行，最后 followUp（避免超时）
        if (local.key === "resume") {
          await rest.createInteractionResponse(interaction.id, interaction.token, {
            type: InteractionResponseType.DeferredChannelMessageWithSource,
            data: {},
          });
          const result = await executeCommand(local, readInteractionArgs(interaction), {
            pi,
            getCtx: () => commandCtx,
            rpc,
          });
          await followUpInteraction(interaction, result.content, result.ephemeral ?? true);
          return;
        }
        const result = await executeCommand(local, readInteractionArgs(interaction), {
          pi,
          getCtx: () => commandCtx,
          rpc,
        });
        await respondInteraction(interaction, result.content, result.ephemeral ?? true);
        return;
      }
      // 笔记 25 续：/skill <组> <skill> → 二级解析（group type=2 → subcommand type=1）
      if (name === "skill" && merged) {
        const groupOption = interaction.data?.options?.find((o) => o.type === 2);
        const subOption = groupOption?.options?.find((o) => o.type === 1);
        const subCommand = subOption?.name ? findSkillBySubcommand(merged, subOption.name) : undefined;
        if (subCommand) {
          const ok = await executeDynamicSourceCommand(subCommand);
          if (ok) {
            await respondInteraction(interaction, `📥 已加载 skill 指令：/${subCommand.nativeName}，正在执行…`, false);
          } else {
            await respondInteraction(
              interaction,
              `/skill ${subOption?.name} 需要终端执行：该 skill 仅在 pi 终端可用。`,
              true,
            );
          }
          return;
        }
        await respondInteraction(interaction, `/skill 未知子命令：${subOption?.name ?? "?"}`, true);
        return;
      }
      const dynamicCommand =
        merged && findMergedCommandByNativeName(merged, name);
      if (dynamicCommand) {
        // S184：prompt 模板 / skill 命令 → 本地执行（读模板/SKILL.md 内容发给 agent）。
        // 笔记 25：必须【先】响应 interaction（3s 超时 →「应用无响应」），再本地执行；
        // 执行失败再 followUp 引导终端。
        if (dynamicCommand.source === "prompt" || dynamicCommand.source === "skill") {
          const label = dynamicCommand.source === "prompt" ? "模板" : "skill 指令";
          await respondInteraction(
            interaction,
            `📥 正在加载 ${label}：/${name}…`,
            false,
          );
          const ok = await executeDynamicSourceCommand(dynamicCommand);
          if (!ok) {
            await followUpInteraction(
              interaction,
              `/${name} 需要终端执行：该命令仅在 pi 终端可用（扩展 API 无远程触发入口）。`,
              true,
            );
          }
          return;
        }
        await respondInteraction(
          interaction,
          `/${name} 需要终端执行：该命令仅在 pi 终端可用（扩展 API 无远程触发入口）。`,
          true,
        );
        return;
      }
      await respondInteraction(interaction, `未知命令：/${name}`, true);
    } catch (err) {
      // 修复：executeCommand 抛异常也要响应（Discord 3s 超时前），否则显示「应用无响应」
      console.error(`${TAG} slash 命令 /${name} 执行异常：`, err instanceof Error ? err.message : String(err));
      notifyError(`slash 命令 /${name} 执行异常`, err);
      await respondInteraction(
        interaction,
        `❌ 命令 /${name} 执行异常：${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  // 入站：Gateway MESSAGE_CREATE → 过滤 → 文本命令拦截 → ack(👀) → debounce → pi
  // 笔记 31：表情状态机生命周期（对齐 openclaw 每条消息独立 controller）——
  //   activeReactions = 当前 turn 消息的状态机（⏳→👀→🧠/🛠️→✅→清理）
  //   queuedReactions = turn 活跃时收到的新消息（只标 ⏳=排队，不进状态机，
  //     避免全局 thinking/tool 事件把 🧠/🛠️ 错挂到「还没被处理」的消息上——旧实现
  //     每次收消息都重建 controller 导致的表情错位/残留 bug）
  //   agent_start 时 queued 队首升级为 active；终态（agent_end/abort/错误）必清理
  let activeReactions: StatusReactionController | undefined;
  // 排队消息的 messageId 列表（按 channelId 分组），agent_start 时按合并后的 turn 创建 controller
  const queuedMessageIds: Array<{ channelId: string; messageId: string }> = [];
  // 笔记 31：controller 工厂提到 messageCreate 回调外层——messageCreate 与 agent_start
  // 共用；原定义在回调内导致 agent_start 引用报 TS2304 且运行时 ReferenceError（issue #115）。
  const makeReactions = (target: { channelId: string; messageId: string }) =>
    createStatusReactionController({
      adapter: createDiscordReactionAdapter(rest, target.channelId, target.messageId),
      enabled: cfg.statusReactions?.enabled ?? true,
      emojis: cfg.statusReactions?.emojis,
      timing: cfg.statusReactions?.timing,
    });
  gateway.events.on("messageCreate", (message) => {
    const channelId = message.channel_id;
    const content = message.content?.trim();
    const author = message.author;
    // 过滤：bot 自己的消息 / 其他 bot（可配）/ 空内容 / 频道 allowlist
    if (conn.ignoreBots !== false && author?.bot) return;
    if (!content) return;
    if (conn.channels?.length && !conn.channels.includes(channelId)) return;
    activeChannelIds.set(channelId, channelId);
    lastActiveChannelId = channelId;
    try {
      writeFileSync(ACTIVE_CH_FILE, channelId);
    } catch { /* 忽略 */ }

    // 笔记 20/21：文本命令拦截（/stop /help 等本地执行，不进 agent）
    const resolved = resolveTextCommand(content, { botUsername });
    if (resolved) {
      void (async () => {
        const result = await executeCommand(resolved.command, resolved.args, {
          pi,
          getCtx: () => commandCtx,
          rpc,
        });
        await replyTextCommand(channelId, result.content);
      })();
      return;
    }

    // 笔记 28：abort 触发词拦截（openclaw abort-primitives）——用户发
    // 「停止/暂停/stop/abort」等 → 中断当前任务，不进 agent
    if (isAbortRequestText(content)) {
      void (async () => {
        let confirmationSent = false;
        try {
          // issue #117：turn 活跃时 abortTurn 内部会向 turn 频道发送确认；
          // 返回值标记是否已发送，宿主只兜底无活跃 turn 的场景，避免双发。
          confirmationSent = await bridge.abortCurrentTurn("🛑 已中止当前任务。");
        } catch {
          // 忽略
        }
        if (!confirmationSent) {
          await replyTextCommand(channelId, "🛑 已中止当前任务。");
        }
      })();
      return;
    }

    // 动态命令文本形式（pi 内置/扩展命令，无本地 handler）→ 提示终端执行
    if (content.startsWith("/") && mergedCommands) {
      const match = content.match(/^\/([a-z0-9-_]+)/i);
      const candidate = match?.[1];
      if (candidate && findMergedCommandByNativeName(mergedCommands, candidate)) {
        void (async () => {
          const dynamicCmd = findMergedCommandByNativeName(mergedCommands, candidate);
          // 笔记 25：prompt/skill 先发「加载中」再本地执行（原实现加载提示在函数内，调用方无感知）
          if (dynamicCmd?.source === "prompt" || dynamicCmd?.source === "skill") {
            const label = dynamicCmd.source === "prompt" ? "模板" : "skill 指令";
            await replyTextCommand(
              channelId,
              `📥 正在加载 ${label}：/${candidate}…`,
            );
            const ok = await executeDynamicSourceCommand(dynamicCmd);
            if (!ok) {
              await replyTextCommand(
                channelId,
                `/${candidate} 需要终端执行：该命令仅在 pi 终端可用（扩展 API 无远程触发入口）。`,
              );
            }
            return;
          }
          await replyTextCommand(
            channelId,
            `/${candidate} 需要终端执行：该命令仅在 pi 终端可用（扩展 API 无远程触发入口）。`,
          );
        })();
        return;
      }
    }

    // 普通消息：ack + 提交 pi
    // 笔记 30：只走状态机（⏳=收到/排队）——删掉 queueInitialAckReaction（裸加 👀 不经状态机：
    // 清不掉 + reaction 操作翻倍触发限流，导致后续 🧠/🛠️ 全部失败——「思考时没标签」根因）。
    // 笔记 31：turn 活跃（bot 正在思考/操作）时收到的新消息 → 只建排队 controller（⏳=排队中），
    // 不进入状态机——否则全局 thinking/tool 事件会把 🧠/🛠️ 错挂到这条新消息上
    // （「没思考却有思考标签」根因），且旧消息的 controller 被覆盖后表情永久残留。
    // 笔记 31 修复：不再为每条消息创建排队 controller（debouncer 合并后 turn 数 < 消息数，
    // 导致多余 ⏳ 残留）。改为记录 messageId，agent_start 时按合并后的 turn 创建 controller。
    if (activeReactions && !activeReactions.isFinished()) {
      queuedMessageIds.push({ channelId, messageId: message.id });
    } else {
      activeReactions = makeReactions({ channelId, messageId: message.id });
      void activeReactions?.setQueued();
    }
    bridge.pushUserMessage(content, channelId);
  });

  // slash 命令交互（INTERACTION_CREATE）
  gateway.events.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction);
  });

  bridge.onUserInput = async (text) => {
    // 笔记 29/30：新消息经桥排队后提交给 agent（steer 在当前工具调用后立即处理）
    pi.sendUserMessage(text, { deliverAs: "steer" });
  };
  // 笔记 30：排队用表情表达（⏳=排队中），不再发文字提示——
  // 收到消息即 ⏳，agent_start 变 👀（处理中），thinking 变 🧠。
  // 笔记 28：watchdog/触发词中断时真正停止 pi agent（否则任务还在后台跑）
  bridge.onAbort = () => {
    try {
      commandCtx?.abort();
    } catch {
      // 忽略中断失败
    }
    // 笔记 30/31：停止时清空 active 状态表情（🧠🛠️ 不再挂着，避免「停了却像还在处理」）；
    // 排队消息的 ⏳ 保留（drain 后仍会依次处理，agent_start 升级为 active）
    void activeReactions?.clear().catch(() => {});
  };
  // 笔记 29：turn 活跃时收到新用户消息 → 中断当前 agent，立即响应新消息
  bridge.onInterrupt = () => {
    try {
      commandCtx?.abort();
    } catch {
      // 忽略中断失败
    }
  };

  // 出站：pi 事件 → lanes（与 openclaw 的 turn 生命周期对齐）；同时捕获命令 ctx
  const captureCtx = (ctx: ExtensionContext) => {
    if (!commandCtx) console.log(`${TAG} command ctx captured（命令上下文就绪）`);
    commandCtx = adaptCommandCtx(pi, ctx);
    // RPC 桥会话目录跟随主进程（export_html 读同一批 session 文件）
    try {
      const dir = ctx.sessionManager?.getSessionDir?.();
      if (dir) rpc.setSessionDir(dir);
    } catch { /* 忽略 */ }
  };
  // 启动即捕获 ctx（pi 启动时 session_start 必触发；命令拦截不进 agent，
  // 若只依赖运行期事件，重启后第一次 /status 会报「桥接尚未就绪」）
  pi.on("session_start", (_event, ctx) => {
    captureCtx(ctx);
  });
  pi.on("input", (_event, ctx) => {
    captureCtx(ctx);
  });
  // 笔记 36：provider 耗时日志（卡顿 issue #97 定位用；before→after 按顺序配对，agent 串行调用）
  let lastProviderRequestAt = 0;
  pi.on("before_provider_request", () => {
    lastProviderRequestAt = Date.now();
  });
  pi.on("after_provider_response", (event) => {
    const ms = Date.now() - lastProviderRequestAt;
    console.log(`provider 响应 HTTP ${event.status}：${ms}ms`);
  });
  pi.on("turn_start", (_event, ctx) => {
    captureCtx(ctx);
  });
  pi.on("message_start", (_event, ctx) => {
    captureCtx(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    captureCtx(ctx);
    // /copy：缓存最后一条 assistant 完整文本
    try {
      const msg = event.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role === "assistant" && msg.content) {
        if (typeof msg.content === "string") {
          lastAssistantText = msg.content;
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content
            .map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? ""))
            .join("\n");
          if (parts.trim()) lastAssistantText = parts;
        }
      }
    } catch { /* 忽略 */ }
  });
  pi.on("agent_start", (_event, ctx) => {
    captureCtx(ctx);
    // Issue #30 回归修复：ctx.chatId 不是 Discord channel_id（ExtensionContext 无此字段），
    // 直接查 map 恒 miss → 回退 lastActiveChannelId（真实频道 id）
    const chatId = lastActiveChannelId ?? "default";
    bridge.beginTurn({ chatId });
    // 笔记 31 修复：排队消息升级为 active——从 queuedMessageIds 取队首（对应合并后的 turn），
    // 创建 controller 并标 ⏳→👀；旧 active 正常路径已 finished/清理，这里兜底 clear。
    if (queuedMessageIds.length > 0) {
      const nextTarget = queuedMessageIds.shift()!;
      const next = makeReactions(nextTarget);
      void activeReactions?.clear().catch(() => {});
      activeReactions = next;
      void activeReactions?.setQueued();
    }
    // 笔记 30：处理中 👀（与排队 ⏳ 区分）
    void activeReactions?.setWorking();
  });
  // 笔记 31：思考总内容低于该阈值视为「无实质思考」（模型形式化输出），不显示 🧠。
  const MIN_REASONING_CHARS = 20;
  let thinkingAccumChars = 0;
  // 笔记 31：思考是否对用户可见（推理行渲染 + reaction 🧠 都开）。不可见时 thinking_delta
  // 不算「可见活动」——不重置 stall 计时，10s ⏳ / 30s ⚠️ 照常出现，用户能分辨死活。
  const thinkingVisible = (cfg.streaming.thinking ?? true) && cfg.reasoning.enabled;
  pi.on("message_update", (event, ctx) => {
    captureCtx(ctx);
    const ev = event.assistantMessageEvent;
    // 笔记 30/31：思考状态生命周期——开始 → 🧠；结束（thinking_end）→ 移除 🧠（不常驻）。
    // 空 delta（模型输出空思考帧）不触发 🧠；thinking_end 时总内容 < 阈值 → 立即移除
    //（「没思考却有思考标签」的两个来源：事件错挂已由 31 的排队机制解决，这里是内容过滤）。
    if (ev.type === "thinking_delta") {
      const delta = ev.delta ?? "";
      if (delta.trim().length > 0) {
        thinkingAccumChars += delta.length;
        void activeReactions?.setThinking(thinkingVisible);
        // 笔记 31：思考期间持续 typing（即使思考行被关闭）——「还活着」的可见信号。
        // delivery 类型签名 (chatId, action)，runtime 只取 chatId（节流 10s 在内）
        try { void delivery.sendChatAction(lastActiveChannelId ?? "", "typing"); } catch { /* 忽略 */ }
      }
    } else if (ev.type === "thinking_end") {
      if (thinkingAccumChars < MIN_REASONING_CHARS) {
        void activeReactions?.removeThinkingNow();
      } else {
        void activeReactions?.removeThinking();
      }
      thinkingAccumChars = 0;
    }
    const adapted = adaptPiAssistantEvent(ev);
    if (adapted) bridge.handleActivity(adapted);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    captureCtx(ctx);
    bridge.handleActivity({
      type: "tool-start",
      id: event.toolCallId,
      name: event.toolName,
      args: event.args as Record<string, unknown> | undefined,
    });
    // 笔记 23：工具分类表情（💻/🌐/🏗️/🛫/💁/🛠️，按工具名）
    // 笔记 33：透传 event.args —— fabric_exec 内部调用 web 工具时，仅靠工具名识别不到
    //（工具名是 fabric_exec），args 里的 web 信号（web_search/firecrawl/exa 等）才能命中 🌐。
    void activeReactions?.setTool(event.toolName, event.args as Record<string, unknown> | undefined);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    captureCtx(ctx);
    bridge.handleActivity({
      type: "tool-update",
      id: event.toolCallId,
      detail: typeof event.partialResult === "string" ? event.partialResult : undefined,
    });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    captureCtx(ctx);
    bridge.handleActivity({
      type: "tool-end",
      id: event.toolCallId,
      ok: !event.isError,
    });
  });
  pi.on("agent_end", (_event, ctx) => {
    captureCtx(ctx);
    // 笔记 36：上下文阈值提醒（>80% 提示 /compact，防膨胀卡顿——issue #97/#38）
    try {
      const usage = ctx.getContextUsage();
      if (usage?.percent && usage.percent >= 80 && Date.now() - lastCtxWarnAt > 10 * 60_000) {
        lastCtxWarnAt = Date.now();
        const chatId = lastActiveChannelId;
        if (chatId) {
          void rest
            .createChannelMessage(chatId, {
              content: `⚠️ **上下文使用已达 ${usage.percent}%**（${usage.tokens}/${usage.contextWindow}）— 回复延迟会明显增加，建议 /compact。`,
            })
            .catch(() => {});
        }
      }
    } catch { /* 忽略 usage 读取失败 */ }
    // 笔记 32：先 await endTurn（回答正文最终 flush 完成）再进入终态表情——
    // 旧实现 void 不等待，setDone 在回答还在 throttle 分块发送时就执行，
    // removeActiveEmojis 把 🧠/👀 全删，用户看到「回复还在输出、表情已经掉了」。
    // 笔记 37（issue #104）：reactions 快照必须在 await endTurn **之前**捕获——
    // endTurn 内部 drainPending 会提交排队消息 → 新 turn 的 agent_start 可能先执行
    //（clear 旧 controller + 换绑 activeReactions）→ 之后再读 activeReactions 拿到的是
    // 新 controller：旧消息终态 ✓ 丢失、表情被 clear 全清（用户看到「没有留下任何 emoji」）。
    const endReactions = activeReactions;
    void (async () => {
      try {
        await bridge.endTurn();
      } catch {
        // 忽略 endTurn 失败（回答投递失败由 draft-stream 层处理）
      }
      // 笔记 23/35：完成 → ✓ 常驻表示完成（openclaw 终态常驻语义，不再回 ⏳ 排队态）；
      // 仅显式 removeAckAfterReply=true 时才 hold 后全清。
      const reactions = endReactions;
      const srCfg = cfg.statusReactions;
      if (reactions && srCfg?.enabled !== false) {
        try {
          await reactions.setDone();
          if (srCfg?.removeAckAfterReply === true) {
            await sleepMs(STATUS_TIMING.doneHoldMs);
            await reactions.clear();
          }
        } catch {
          // 忽略表情清理失败（重试机制在状态机内）
        }
        // 笔记 31：turn 消息收尾完成 → 释放 active（下一条消息重新绑定）。
        // 条件守卫：期间若已被新 turn 的 agent_start 换绑，不误清新 controller。
        if (activeReactions === reactions) activeReactions = undefined;
      } else {
        activeReactions = undefined;
      }
    })();
  });

  // 连接 Gateway；ready 后注册 slash 命令（笔记 20/21：
  // 动态 = 本地可执行命令 + pi 内置 BUILTIN_SLASH_COMMANDS + pi.getCommands() 扩展/prompt 命令）
  gateway.events.on("ready", (data) => {
    applicationId = data.application?.id;
    botUsername = data.user?.username;
    // 笔记 30/31：启动通知——上次异常退出 → 提示任务中断；正常重启 → 简短确认。
    // 用户正在 Discord 使用时，重启后 bot 需要 ~15s 加载，不通知就会「分不清死活」。
    const wasCrash = crashedLastRun;
    crashedLastRun = false;
    void (async () => {
      try {
        let ch = readFileSync(ACTIVE_CH_FILE, "utf8").trim();
        if (!ch && conn.channels?.length) ch = conn.channels[0];
        if (ch) {
          await rest.createChannelMessage(ch, {
            content: wasCrash
              ? "🔄 服务已重启（上次异常退出），之前进行中的任务已中断。直接重发需求即可。"
              : "✅ 服务已重新上线。",
          });
        }
      } catch { /* 忽略 */ }
      // 不删标记：load 时已重写为本次 pid（运行中标记=异常退出会残留检测用），
      // 正常退出由 SIGTERM 钩子清理；崩溃（SIGKILL）残留 → 下次启动再提示
    })();
    if (applicationId) {
<<<<<<< HEAD
      // 闭包捕获收窄：async 闭包内 let 窄化失效，先固化到 const（issue #115 typecheck）
>>>>>>> origin/master
      const appId = applicationId;
      void (async () => {
        let builtins: ChatCommandDefinition[] = [];
        try {
          builtins = await loadPiBuiltinCommands();
        } catch (error) {
          console.error(
            `${TAG} loadPiBuiltinCommands 异常：`,
            error instanceof Error ? error.message : String(error),
          );
        }
        let runtime: ChatCommandDefinition[] = [];
        try {
          runtime = collectPiRuntimeCommands(pi);
        } catch (error) {
          console.error(
            `${TAG} collectPiRuntimeCommands 异常：`,
            error instanceof Error ? error.message : String(error),
          );
        }
        const dynamic = [...builtins, ...runtime];
        console.log(`${TAG} 动态命令收集：builtins=${builtins.length} runtime=${runtime.length}`);
        // 斜杠注册 = 本地可执行命令（有 handler）+ pi 动态命令（本地优先，nativeName 去重）
        const merged = mergeCommandSets(getCommands(), dynamic);
        mergedCommands = merged;
        // 笔记 25：注册集排除 skill（100 上限 + 需终端）+ 保底截断 100；
        // skill 保留在 merged 集 → 文本 /skill-xxx 仍可本地执行
        const registerable = filterDiscordRegisterableCommands(merged);
        const commands = registerable.map((command) => ({
          name: command.nativeName as string,
          // Discord 命令描述上限 100 字符（openclaw truncateDiscordCommandDescription 语义）
          description: truncateDiscordCommandDescription(command.description),
          options: buildDiscordCommandOptions(command),
        }));
        // 笔记 25 续：/skill:xxx 进 Discord —— 单个 /skill 命令 + 二级分类
        // （subcommand groups：/skill video hyperframes；Discord 每命令 options 上限 25）。
        // 覆盖式注册修复：registerApplicationCommands 是 PUT 全量覆盖，必须把原生命令
        // 与 /skill 合并成一次注册，否则第二次注册会把第一次的 88 个原生命令顶掉
        // （现象：Discord 里只剩 /skill，原生斜杠命令全消失）。
        const skillGroups = buildSkillGroups(merged);
        const skillCommand =
          skillGroups.length > 0
            ? {
                name: "skill",
                description: "加载 skill 指令（终端 /skill:xxx 的 Discord 形式）",
                options: skillGroups.map((group) => ({
                  type: 2, // SubcommandGroup
                  name: group.groupName,
                  description: `${group.groupName} 类 skill（${group.subs.length} 个）`,
                  options: group.subs.map(({ subName, skill }) => ({
                    type: 1, // Subcommand
                    name: subName,
                    description: truncateDiscordCommandDescription(skill.description),
                  })),
                })),
              }
            : undefined;
        // 全量 = /skill + 原生命令（skill 排最前：全局增量补齐时优先创建 skill，
        // DM 斜杠命令先恢复 skill 再补其他；笔记 27）
        const fullCommands = skillCommand ? [skillCommand, ...commands] : commands;
        // 注册 helper：去重（现有命令一致则跳过 PUT，省 Discord 200/天创建额度）
        // + 全局/guild 独立容错（一个失败不影响另一个）+ 429 限流延迟重试
        const registerCommandsForScope = async (
          scopeLabel: string,
          put: () => Promise<unknown>,
          list: () => Promise<Array<{ name: string }>>,
          attemptsLeft = 3,
          lastRetryAfterMs = 0,
        ): Promise<boolean> => {
          try {
            const existing = await list();
            const existingNames = new Set(existing.map((c) => c.name));
            const same =
              existing.length === fullCommands.length &&
              fullCommands.every((c) => existingNames.has(c.name));
            if (same) {
              console.log(
                `${TAG} ${scopeLabel} 命令集无变化，跳过注册（${fullCommands.length} 个，省额度）`,
              );
              return true;
            }
            await put();
            console.log(`${TAG} 已注册 ${fullCommands.length} 个 slash 命令到${scopeLabel}`);
            return true;
          } catch (error) {
            const detail =
              error instanceof Error && "body" in error
                ? JSON.stringify((error as { body?: unknown }).body)
                : undefined;
            console.error(
              `${TAG} ${scopeLabel} 命令注册失败：`,
              error instanceof Error ? error.message : String(error),
              detail ? `${detail}` : "",
            );
            // 429 限流 → 延迟重试（最多再试 2 次，等待窗口上限 10 分钟）
            const err = error as { retryAfterMs?: unknown };
            const retryAfterMs =
              typeof err?.retryAfterMs === "number" ? err.retryAfterMs : 0;
            if (attemptsLeft > 1 && retryAfterMs > 0) {
              const delay = Math.min(Math.max(retryAfterMs, lastRetryAfterMs), 600_000);
              console.log(
                `${TAG} ${scopeLabel} 限流，${Math.round(delay / 1000)}s 后重试（剩余 ${attemptsLeft - 1} 次）`,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              return registerCommandsForScope(scopeLabel, put, list, attemptsLeft - 1, delay);
            }
            return false;
          }
        };
        const skippedSkills = merged.length - registerable.length;
        console.log(
          `${TAG} 命令集：merged=${merged.length}，跳过 skill ${skippedSkills}，含 /skill=${skillGroups.length} 组，共 ${fullCommands.length} 个`,
        );
        // 全局注册（DM 可见）：reconcile 差异同步（笔记 27，对齐 openclaw DiscordCommandDeployer）
        // - GET 现有 → 缺失 POST create / 内容变化 PATCH edit（不烧 200/天 create 额度）/ 多余 DELETE
        // - 429 等 retry_after 重试（额度滚动释放一个补一个），skill 排最前优先补齐
        // - 全部成功才写 hash 缓存 → 命令集无变化时重启 0 请求
        const comparableCommand = (c: { name: string; description?: string; options?: unknown }) =>
          JSON.stringify({
            name: c.name,
            description: c.description ?? "",
            options: c.options ?? [],
          });
        const commandsEqual = (
          a: { name: string; description?: string; options?: unknown },
          b: { name: string; description?: string; options?: unknown },
        ) => comparableCommand(a) === comparableCommand(b);
        const CACHE_PATH = `${process.env.HOME ?? "/home/ubuntu"}/.pi/agent/discord-commands-cache.json`;
        const cmdHash = createHash("sha256")
          .update(
            JSON.stringify(
              fullCommands
                .map((c) => ({ name: c.name, description: c.description ?? "", options: c.options ?? [] }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            ),
          )
          .digest("hex");
        void (async () => {
          try {
            // hash 命中 → 命令集无变化，跳过全部请求（对齐 openclaw putCommandSetIfChanged）
            try {
              const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as { hash?: string };
              if (cached?.hash === cmdHash) {
                console.log(`${TAG} 全局命令集无变化（hash 命中），跳过注册`);
                return;
              }
            } catch { /* 无缓存文件 */ }
            const existing = await rest.listApplicationCommands(appId);
            const existingByName = new Map(existing.map((c) => [c.name, c]));
            const desiredNames = new Set(fullCommands.map((c) => c.name));
            let created = 0;
            let edited = 0;
            let incomplete = false;
            for (const cmd of fullCommands) {
              const cur = existingByName.get(cmd.name);
              let attempts = 0;
              for (;;) {
                try {
                  if (!cur) {
                    await rest.createApplicationCommand(appId, cmd);
                    created += 1;
                  } else if (cur.id && !commandsEqual(cur, cmd)) {
                    await rest.editApplicationCommand(appId, cur.id, cmd);
                    edited += 1;
                  }
                  break;
                } catch (error) {
                  attempts += 1;
                  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
                  const wait = Math.min(
                    Math.max(typeof retryAfterMs === "number" ? retryAfterMs : 30_000, 15_000),
                    600_000,
                  );
                  if (attempts >= 3) {
                    incomplete = true;
                    console.error(
                      `${TAG} 全局命令 /${cmd.name} 同步失败 3 次，跳过（下次启动自动补）：`,
                      error instanceof Error ? error.message : String(error),
                    );
                    break;
                  }
                  console.log(
                    `${TAG} 全局命令 /${cmd.name} 限流，${Math.round(wait / 1000)}s 后重试（${attempts}/3）`,
                  );
                  await sleepMs(wait);
                }
              }
            }
            // 删除多余的现有命令（如历史遗留的 ping）
            let deleted = 0;
            for (const [name, c] of existingByName) {
              if (desiredNames.has(name)) continue;
              if (c.id) {
                try {
                  await rest.deleteApplicationCommand(appId, c.id);
                  deleted += 1;
                  console.log(`${TAG} 删除多余全局命令 /${name}`);
                } catch (error) {
                  console.error(
                    `${TAG} 删除多余全局命令 /${name} 失败：`,
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }
            }
            console.log(
              `${TAG} 全局命令 reconcile：新建 ${created}，更新 ${edited}，删除 ${deleted}（共 ${fullCommands.length}）${incomplete ? "，未完成（额度受限，下次继续）" : ""}`,
            );
            // 全部成功才写缓存（未完成时下次继续补）
            if (!incomplete) {
              try {
                writeFileSync(
                  CACHE_PATH,
                  JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), hash: cmdHash }),
                );
                console.log(`${TAG} 全局命令 hash 缓存已写入（${cmdHash.slice(0, 12)}…）`);
              } catch { /* 忽略写缓存失败 */ }
            }
          } catch (error) {
            console.error(
              `${TAG} 全局命令 reconcile 失败：`,
              error instanceof Error ? error.message : String(error),
            );
          }
        })();
        // guild 注册（服务器内可见、即时生效；独立额度，全局失败不影响）
        void (async () => {
          try {
            const guilds = await rest.listMyGuilds();
            for (const guild of guilds) {
              void registerCommandsForScope(
                `guild ${guild.name ?? guild.id}`,
                () => rest.registerGuildApplicationCommands(appId, guild.id, fullCommands),
                () => rest.listGuildApplicationCommands(appId, guild.id),
              );
            }
          } catch (error) {
            console.error(
              `${TAG} guild 列表获取失败：`,
              error instanceof Error ? error.message : String(error),
            );
          }
        })();
      })();
    }
    console.log(`${TAG} Discord Gateway 已连接`);
  });
  gateway.events.on("fatal", (code) => {
    console.error(`${TAG} Gateway fatal（code=${code}）：检查 token/intents/权限`);
    notifyError("Discord Gateway 断连", `code=${code}，检查 token/intents/权限`);
    // 笔记 23/35：错误 → ❌ 常驻（终态语义，与完成 ✓ 一致）；显式 true 才全清。
    void (async () => {
      await activeReactions?.setError();
      if (cfg.statusReactions?.removeAckAfterReply === true) {
        await sleepMs(STATUS_TIMING.errorHoldMs);
        await activeReactions?.clear();
      }
    })();
  });
  gateway.connect();

  console.log(`${TAG} OpenClaw-style Discord streaming 已启用（mode=${cfg.streaming.mode} chunkSize=${cfg.streaming.chunkSize}）`);
}
