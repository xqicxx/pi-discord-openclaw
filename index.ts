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
  queueInitialAckReaction,
  STATUS_TIMING,
  type StatusReactionController,
} from "./src/feedback/ack-reactions.ts";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
} from "./src/dispatch/markdown-tables.ts";
import { DiscordGateway } from "./src/transport/discord-gateway.ts";
import { OpenclawBridge, type DiscordDelivery } from "./src/dispatch/dispatch.ts";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resolveTextCommand } from "./src/commands/text-commands.ts";
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
  const conn: DiscordConnectionConfig = loadDiscordConnectionConfig();
  if (!conn.token) {
    console.log(`${TAG} 未配置 DISCORD_BOT_TOKEN（discord.json 或环境变量），已跳过`);
    return;
  }
  if (!isOpenclawStyleEnabled()) {
    console.log(`${TAG} discord.json 未启用 openclawStyle.enabled，已跳过`);
    return;
  }

  const cfg: OpenclawStyleConfig = loadOpenclawStyleConfig();
  const rest = new DiscordRest({ token: conn.token });
  const gateway = new DiscordGateway({ token: conn.token, intents: DISCORD_INTENTS });

  // 当前活跃频道（最近收到用户消息的 channel_id；agent 回复发往该频道）
  let activeChannelId: string | undefined;
  // typing 节流（笔记 25 性能：10s 一次）
  let lastTypingAtMs = 0;
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

  const delivery: DiscordDelivery = {
    sendMessage: async (text) => {
      if (!activeChannelId) throw new Error(`${TAG} no active channelId`);
      const sent = await rest.createChannelMessage(activeChannelId, { content: text });
      if (!sent.id) throw new Error(`${TAG} sendMessage: no message id`);
      return sent.id;
    },
    editMessage: async (messageId, text) => {
      if (!activeChannelId) throw new Error(`${TAG} no active channelId`);
      await rest.editChannelMessage(activeChannelId, messageId, text);
    },
    deleteMessage: async (messageId) => {
      if (!activeChannelId) throw new Error(`${TAG} no active channelId`);
      await rest.deleteChannelMessage(activeChannelId, messageId);
    },
    sendChatAction: async () => {
      if (!activeChannelId) return;
      // 笔记 25 性能：typing 节流 10s（Discord 官方建议间隔；每次 flush 都发会触发
      // typing 限流 5/10s → 429，且白白占用请求预算）
      const now = Date.now();
      if (now - lastTypingAtMs < 10_000) return;
      lastTypingAtMs = now;
      await rest.sendChannelTyping(activeChannelId).catch(() => {});
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
      // 笔记 24：最终回答投递前格式化（表格 → 对齐 ASCII 代码块 + 指令标签剥离）
      // 笔记 26：区分靠 openclaw 折叠摘要（progress 方块变 -# 小字摘要），回答不加分隔线
      formatAnswerText: (text) =>
        convertMarkdownTables(stripInlineDirectiveTagsForDelivery(text).text, "code"),
    },
  });

  // ---- 命令系统（笔记 20/21）----

  /** 文本命令回复：直接发消息（命令不走 lanes/agent）。 */
  async function replyTextCommand(channelId: string, content: string): Promise<void> {
    await rest.createChannelMessage(channelId, { content }).catch((error) => {
      console.error(`${TAG} text command reply failed:`, error?.message ?? error);
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
      await respondInteraction(
        interaction,
        `❌ 命令 /${name} 执行异常：${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  // 入站：Gateway MESSAGE_CREATE → 过滤 → 文本命令拦截 → ack(👀) → debounce → pi
  let statusReactions: StatusReactionController | undefined;
  gateway.events.on("messageCreate", (message) => {
    const channelId = message.channel_id;
    const content = message.content?.trim();
    const author = message.author;
    // 过滤：bot 自己的消息 / 其他 bot（可配）/ 空内容 / 频道 allowlist
    if (conn.ignoreBots !== false && author?.bot) return;
    if (!content) return;
    if (conn.channels?.length && !conn.channels.includes(channelId)) return;
    activeChannelId = channelId;

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
    // 笔记 23：收到消息立即 setQueued（👀 走 controller，与 openclaw 一致）
    const adapter = createDiscordReactionAdapter(rest, channelId, message.id);
    statusReactions = createStatusReactionController({
      adapter,
      enabled: cfg.statusReactions?.enabled ?? true,
      emojis: cfg.statusReactions?.emojis,
      timing: cfg.statusReactions?.timing,
    });
    void statusReactions.setQueued();
    void queueInitialAckReaction({ adapter });
    bridge.pushUserMessage(content, channelId);
  });

  // slash 命令交互（INTERACTION_CREATE）
  gateway.events.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction);
  });

  bridge.onUserInput = async (text) => {
    // 触发 pi turn；若正在流式输出则排队为 followUp
    pi.sendUserMessage(text, { deliverAs: "followUp" });
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
    bridge.beginTurn({ chatId: activeChannelId ?? "default" });
    void statusReactions?.setThinking();
  });
  pi.on("message_update", (event, ctx) => {
    captureCtx(ctx);
    const adapted = adaptPiAssistantEvent(event.assistantMessageEvent);
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
    void statusReactions?.setTool(event.toolName);
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
    void bridge.endTurn();
    // 笔记 23：完成 → ✅（终态 hold 后 clear 或 restoreInitial，openclaw finally 语义）
    const reactions = statusReactions;
    const srCfg = cfg.statusReactions;
    if (reactions && srCfg?.enabled !== false) {
      void (async () => {
        await reactions.setDone();
        if (srCfg?.removeAckAfterReply !== false) {
          await sleepMs(STATUS_TIMING.doneHoldMs);
          await reactions.clear();
        } else {
          await reactions.restoreInitial();
        }
      })();
    }
  });

  // 连接 Gateway；ready 后注册 slash 命令（笔记 20/21：
  // 动态 = 本地可执行命令 + pi 内置 BUILTIN_SLASH_COMMANDS + pi.getCommands() 扩展/prompt 命令）
  gateway.events.on("ready", (data) => {
    applicationId = data.application?.id;
    botUsername = data.user?.username;
    if (applicationId) {
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
        try {
          await rest.registerApplicationCommands(applicationId, commands);
          const skippedSkills = merged.length - registerable.length;
          console.log(
            `${TAG} 已注册 ${commands.length} 个 slash 命令（merged=${merged.length}，跳过 skill ${skippedSkills}）`,
          );
        } catch (error) {
          const detail =
            error instanceof Error && "body" in error
              ? JSON.stringify((error as { body?: unknown }).body)
              : undefined;
          console.error(
            `${TAG} slash 命令注册失败：`,
            error instanceof Error ? error.message : String(error),
            detail ? `${detail}` : "",
          );
        }

        // 笔记 25 续：/skill:xxx 进 Discord —— 单个 /skill 命令 + 二级分类
        // （subcommand groups：/skill video hyperframes；Discord 每命令 options 上限 25，
        // 55 个 skill 分 4 组 video/dev/fabric/tools 各 ≤25），guild 级注册（≤100/guild）
        const skillGroups = buildSkillGroups(merged);
        if (skillGroups.length > 0) {
          const skillCommand = {
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
          };
          try {
            const guilds = await rest.listMyGuilds();
            for (const guild of guilds) {
              await rest.registerGuildApplicationCommands(applicationId, guild.id, [skillCommand]);
              console.log(
                `${TAG} 已注册 /skill 命令（${skillGroups.length} 组 ${skillGroups.reduce((n, g) => n + g.subs.length, 0)} 个 skill）到 guild ${guild.name ?? guild.id}`,
              );
            }
          } catch (error) {
            const detail =
              error instanceof Error && "body" in error
                ? JSON.stringify((error as { body?: unknown }).body)
                : undefined;
            console.error(
              `${TAG} guild /skill 命令注册失败：`,
              error instanceof Error ? error.message : String(error),
              detail ? `${detail}` : "",
            );
          }
        }
      })();
    }
    console.log(`${TAG} Discord Gateway 已连接`);
  });
  gateway.events.on("fatal", (code) => {
    console.error(`${TAG} Gateway fatal（code=${code}）：检查 token/intents/权限`);
    // 笔记 23：错误 → ❌（终态 hold 后 clear）
    void (async () => {
      await statusReactions?.setError();
      await sleepMs(STATUS_TIMING.errorHoldMs);
      await statusReactions?.clear();
    })();
  });
  gateway.connect();

  console.log(`${TAG} OpenClaw-style Discord streaming 已启用（mode=${cfg.streaming.mode} chunkSize=${cfg.streaming.chunkSize}）`);
}
