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
  type StatusReactionController,
} from "./src/feedback/ack-reactions.ts";
import { DiscordGateway } from "./src/transport/discord-gateway.ts";
import { OpenclawBridge, type DiscordDelivery } from "./src/dispatch/dispatch.ts";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resolveTextCommand } from "./src/commands/text-commands.ts";
import {
  findCommandByNativeName,
  listNativeCommandSpecs,
  type CommandExecutionCtx,
} from "./src/commands/registry.ts";
import { executeCommand } from "./src/commands/handler.ts";
import { buildDiscordCommandOptions } from "./src/commands/options.ts";
import {
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  type DiscordInteraction,
} from "./src/transport/types.ts";

const TAG = "[pi-discord-openclaw]";

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
  // 命令执行 ctx（最近一次事件 handler 的 ExtensionContext 适配，笔记 21）
  let commandCtx: CommandExecutionCtx | undefined;
  // bot username（/cmd@bot mention 剥离用，READMEY.user）
  let botUsername: string | undefined;
  // application id（slash 命令注册，READMEY.application.id）
  let applicationId: string | undefined;

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
    } catch {
      // 首次响应失败（3s 超时/已响应）→ followUp 兜底
      if (interaction.application_id) {
        await rest
          .createInteractionFollowUp(interaction.application_id, interaction.token, {
            content,
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          })
          .catch(() => {});
      }
    }
  }

  /** 读取 interaction options → 原始参数字符串（空格拼接）。 */
  function readInteractionArgs(interaction: DiscordInteraction): string | undefined {
    const options = interaction.data?.options;
    if (!options?.length) return undefined;
    return options
      .map((option) => (typeof option.value === "string" ? option.value : String(option.value ?? "")))
      .join(" ");
  }

  /** slash 命令分发（本地执行，不进模型）。 */
  async function handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (interaction.type !== InteractionType.ApplicationCommand) return;
    const name = interaction.data?.name;
    if (!name) return;
    const command = findCommandByNativeName(name);
    if (!command) return;
    // 频道 allowlist 与消息一致
    const channelId = interaction.channel_id;
    if (conn.channels?.length && channelId && !conn.channels.includes(channelId)) {
      await respondInteraction(interaction, "该频道未授权使用命令。", true);
      return;
    }
    const result = await executeCommand(command, readInteractionArgs(interaction), {
      pi,
      getCtx: () => commandCtx,
    });
    await respondInteraction(interaction, result.content, result.ephemeral ?? true);
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
        });
        await replyTextCommand(channelId, result.content);
      })();
      return;
    }

    // 普通消息：ack + 提交 pi
    const adapter = createDiscordReactionAdapter(rest, channelId, message.id);
    statusReactions = createStatusReactionController(adapter);
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
    commandCtx = adaptCommandCtx(pi, ctx);
  };
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
    void statusReactions?.setTool();
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
    // 笔记 17：完成 → ✅（失败路径由 gateway error/fatal 处理 ❌）
    void statusReactions?.setDone();
  });

  // 连接 Gateway；ready 后注册 slash 命令（笔记 20：openclaw provider.deploy.ts 语义）
  gateway.events.on("ready", (data) => {
    applicationId = data.application?.id;
    botUsername = data.user?.username;
    if (applicationId) {
      const specs = listNativeCommandSpecs();
      const commands = specs.map((command) => ({
        name: command.nativeName as string,
        description: command.description,
        options: buildDiscordCommandOptions(command),
      }));
      void rest
        .registerApplicationCommands(applicationId, commands)
        .then(() => {
          console.log(`${TAG} 已注册 ${commands.length} 个 slash 命令`);
        })
        .catch((error) => {
          console.error(`${TAG} slash 命令注册失败：`, error?.message ?? error);
        });
    }
    console.log(`${TAG} Discord Gateway 已连接`);
  });
  gateway.events.on("fatal", (code) => {
    console.error(`${TAG} Gateway fatal（code=${code}）：检查 token/intents/权限`);
  });
  gateway.connect();

  console.log(`${TAG} OpenClaw-style Discord streaming 已启用（mode=${cfg.streaming.mode} chunkSize=${cfg.streaming.chunkSize}）`);
}
