// Ack + status reactions — ported from openclaw extensions/discord
// src/monitor/ack-reactions.ts + src/channels/status-reactions.ts (笔记 17).
// 收到消息 → 加 👀；处理中 🧠 → 工具 🛠️ → 完成 ✅ / 错误 ❌。

import type { DiscordRest } from "../transport/discord-rest.ts";
import type { Snowflake } from "../transport/types.ts";

/** 默认 ack 表情（openclaw DEFAULT_ACK_REACTION）。 */
export const DEFAULT_ACK_REACTION = "👀";

/** 状态表情（openclaw DEFAULT_EMOJIS 子集）。 */
export const STATUS_EMOJIS = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  done: "✅",
  error: "❌",
} as const;

export type StatusEmoji = (typeof STATUS_EMOJIS)[keyof typeof STATUS_EMOJIS];

/** reaction 适配器（openclaw StatusReactionAdapter 对应）。 */
export interface ReactionAdapter {
  setReaction: (emoji: string) => Promise<void>;
  removeReaction: (emoji: string) => Promise<void>;
}

/** 构建 Discord reaction 适配器（绑定到一条消息）。 */
export function createDiscordReactionAdapter(
  rest: DiscordRest,
  channelId: Snowflake,
  messageId: Snowflake,
): ReactionAdapter {
  return {
    setReaction: async (emoji) => {
      await rest.createChannelReaction(channelId, messageId, emoji);
    },
    removeReaction: async (emoji) => {
      await rest.deleteChannelReaction(channelId, messageId, emoji);
    },
  };
}

/** 收到消息时立即加 ack 表情（👀）；失败静默（openclaw queueInitialDiscordAckReaction）。 */
export async function queueInitialAckReaction(params: {
  adapter: ReactionAdapter;
  ackReaction?: string;
}): Promise<void> {
  const emoji = params.ackReaction ?? DEFAULT_ACK_REACTION;
  try {
    await params.adapter.setReaction(emoji);
  } catch (err) {
    console.warn("[pi-discord-openclaw] ack reaction failed:", (err as Error).message);
  }
}

/**
 * 状态反应控制器（openclaw createStatusReactionController 简化版）。
 * 状态转移：queued(👀) → thinking(🧠) → tool(🛠️) → done(✅)/error(❌)。
 * 每个状态只保留一个表情：先移除旧的，再加新的。
 */
export function createStatusReactionController(adapter: ReactionAdapter) {
  let activeEmoji: string | undefined;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn, fn);
    return chain;
  };

  const applyEmoji = (emoji: string): Promise<void> =>
    enqueue(async () => {
      if (activeEmoji && activeEmoji !== emoji) {
        try {
          await adapter.removeReaction(activeEmoji);
        } catch { /* ignore */ }
      }
      try {
        await adapter.setReaction(emoji);
        activeEmoji = emoji;
      } catch { /* ignore */ }
    });

  const finishWithEmoji = (emoji: string): Promise<void> =>
    enqueue(async () => {
      finished = true;
      // openclaw finishWithEmoji：先移除旧表情，仅保留终态（removeActiveEmojis keepEmoji）
      if (activeEmoji && activeEmoji !== emoji) {
        try {
          await adapter.removeReaction(activeEmoji);
        } catch { /* ignore */ }
      }
      try {
        await adapter.setReaction(emoji);
        activeEmoji = emoji;
      } catch { /* ignore */ }
    });

  return {
    setQueued: () => applyEmoji(STATUS_EMOJIS.queued),
    setThinking: () => applyEmoji(STATUS_EMOJIS.thinking),
    setTool: () => applyEmoji(STATUS_EMOJIS.tool),
    setDone: () => finishWithEmoji(STATUS_EMOJIS.done),
    setError: () => finishWithEmoji(STATUS_EMOJIS.error),
    /** 完成/错误后移除所有状态表情（openclaw clear）。 */
    clear: () =>
      enqueue(async () => {
        finished = true;
        if (activeEmoji) {
          try {
            await adapter.removeReaction(activeEmoji);
          } catch { /* ignore */ }
          activeEmoji = undefined;
        }
      }),
    isFinished: () => finished,
    activeEmoji: () => activeEmoji,
  };
}

export type StatusReactionController = ReturnType<typeof createStatusReactionController>;
