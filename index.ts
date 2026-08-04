/**
 * pi-discord-openclaw — Discord bridge for Pi with OpenClaw-style streaming.
 *
 * 改造自 pi-telegram-openclaw（以 openclaw extensions/discord 为蓝本，笔记 09-15）。
 * 架构（解耦 + 简单 + 高性能）：
 *   Discord ⇄ transport (REST + Gateway) ⇄ OpenclawBridge ⇄ pi agent
 *                         │
 *                         ├─ AnswerLane     📝 流式编辑（draft-stream，2000 分块/throttle/重试）
 *                         ├─ ReasoningLane  🧠 思考流（<think> 提取 + 🧠 斜体渲染）
 *                         ├─ ProgressLane   🔧 工具进度（tool-start/update/end 行）
 *                         └─ InboundDebouncer ⏭️ 连续输入合并
 *
 * 入口职责：读配置 → 建 transport → 收消息（MESSAGE_CREATE）→ 提交 pi；
 * 订阅 pi 事件 → 驱动 lanes → 经 REST 发送/编辑。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
      // 笔记 18：可开关配置（openclaw streaming.progress 对应项）
      toolProgressLines: cfg.streaming.toolProgress,
    },
  });

  // 入站：Gateway MESSAGE_CREATE → 过滤 → ack(👀) → debounce → pi
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
    // 笔记 17：收到消息立即加 👀 ack；绑定状态控制器到该消息
    const adapter = createDiscordReactionAdapter(rest, channelId, message.id);
    statusReactions = createStatusReactionController(adapter);
    void queueInitialAckReaction({ adapter });
    bridge.pushUserMessage(content, channelId);
  });

  bridge.onUserInput = async (text) => {
    // 触发 pi turn；若正在流式输出则排队为 followUp
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  };

  // 出站：pi 事件 → lanes（与 openclaw 的 turn 生命周期对齐）
  pi.on("agent_start", () => {
    bridge.beginTurn({ chatId: activeChannelId ?? "default" });
    void statusReactions?.setThinking();
  });
  pi.on("message_update", (event) => {
    const adapted = adaptPiAssistantEvent(event.assistantMessageEvent);
    if (adapted) bridge.handleActivity(adapted);
  });
  pi.on("tool_execution_start", (event) => {
    bridge.handleActivity({
      type: "tool-start",
      id: event.toolCallId,
      name: event.toolName,
      args: event.args as Record<string, unknown> | undefined,
    });
    void statusReactions?.setTool();
  });
  pi.on("tool_execution_update", (event) => {
    bridge.handleActivity({
      type: "tool-update",
      id: event.toolCallId,
      detail: typeof event.partialResult === "string" ? event.partialResult : undefined,
    });
  });
  pi.on("tool_execution_end", (event) => {
    bridge.handleActivity({
      type: "tool-end",
      id: event.toolCallId,
      ok: !event.isError,
    });
  });
  pi.on("agent_end", () => {
    void bridge.endTurn();
    // 笔记 17：完成 → ✅（失败路径由 gateway error/fatal 处理 ❌）
    void statusReactions?.setDone();
  });

  // 连接 Gateway
  gateway.events.on("ready", () => {
    console.log(`${TAG} Discord Gateway 已连接`);
  });
  gateway.events.on("fatal", (code) => {
    console.error(`${TAG} Gateway fatal（code=${code}）：检查 token/intents/权限`);
  });
  gateway.connect();

  console.log(`${TAG} OpenClaw-style Discord streaming 已启用（mode=${cfg.streaming.mode} chunkSize=${cfg.streaming.chunkSize}）`);
}
