// Ack + status reactions — FULL native port of openclaw
// src/channels/status-reactions.ts + ack-reactions.ts（笔记 23）。
// 完整移植：13 表情、debounce 700ms、stall 软 10s/硬 30s、终态保护、
// 延迟移除（只增不减，终态统一清理）、restoreInitial、clear、工具名分类表情。

import type { DiscordRest } from "../transport/discord-rest.ts";
import type { Snowflake } from "../transport/types.ts";

/** 默认 ack 表情（openclaw DEFAULT_ACK_REACTION = "👀"）。 */
export const DEFAULT_ACK_REACTION = "👀";

/** 默认表情全集（openclaw DEFAULT_EMOJIS，13 个，全部移植）。 */
export const STATUS_EMOJIS = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  deploy: "🛫",
  build: "🏗️",
  concierge: "💁",
  done: "✅",
  error: "❌",
  stallSoft: "⏳",
  stallHard: "⚠️",
  compacting: "🗜️",
} as const;

export type StatusEmojiKey = keyof typeof STATUS_EMOJIS;
export type StatusEmoji = (typeof STATUS_EMOJIS)[StatusEmojiKey];
export type StatusTimingKey = keyof typeof STATUS_TIMING;

/** 默认时序（openclaw DEFAULT_TIMING，全部移植）。 */
export const STATUS_TIMING = {
  debounceMs: 700,      // 中间状态防抖
  stallSoftMs: 10_000,  // 10s 无活动 → ⏳
  stallHardMs: 30_000,  // 30s 无活动 → ⚠️
  doneHoldMs: 1500,     // ✅ 停留 1.5s 后清理
  errorHoldMs: 2500,    // ❌ 停留 2.5s 后清理
} as const;

// ---- 工具名 → 表情分类 token（openclaw 原样） ----

const CODING_TOOL_TOKENS = ["exec", "process", "read", "write", "edit", "session_status", "bash"];
const WEB_TOOL_TOKENS = ["web_search", "web-search", "web_fetch", "web-fetch", "browser"];
const DEPLOY_TOOL_TOKENS = ["fastlane", "deploy", "upload", "testflight", "ship", "release", "publish", "distribute"];
const BUILD_TOOL_TOKENS = ["build", "compile", "xcode", "swift", "gradle", "cargo", "make", "cmake", "webpack", "vite", "tsc", "lint"];
const CONCIERGE_TOOL_TOKENS = ["navigate", "click", "fill", "screenshot", "scroll", "page", "form", "puppeteer", "playwright", "selenium", "chromedp"];

/**
 * 工具名 → 分类表情（openclaw resolveToolEmoji）。
 * 优先级 deploy > build > concierge > web > coding > tool；token 包含匹配。
 */
export function resolveToolEmoji(toolName?: string, emojis: Partial<Record<StatusEmojiKey, string>> = {}): string {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (!normalized) return emojis.tool ?? STATUS_EMOJIS.tool;
  const category: StatusEmojiKey = DEPLOY_TOOL_TOKENS.some((t) => normalized.includes(t))
    ? "deploy"
    : BUILD_TOOL_TOKENS.some((t) => normalized.includes(t))
      ? "build"
      : CONCIERGE_TOOL_TOKENS.some((t) => normalized.includes(t))
        ? "concierge"
        : WEB_TOOL_TOKENS.some((t) => normalized.includes(t))
          ? "web"
          : CODING_TOOL_TOKENS.some((t) => normalized.includes(t))
            ? "coding"
            : "tool";
  return emojis[category] ?? STATUS_EMOJIS[category];
}

// ---- reaction 适配器（openclaw StatusReactionAdapter） ----

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

// ---- 状态反应控制器（openclaw createStatusReactionController 完整移植，笔记 23） ----

export interface StatusReactionControllerOptions {
  enabled?: boolean;
  adapter: ReactionAdapter;
  /** 初始表情（queued 缺省时用，openclaw initialEmoji）。 */
  initialEmoji?: string;
  /** 表情覆盖（按分类）。 */
  emojis?: Partial<Record<StatusEmojiKey, string>>;
  /** 时序覆盖。 */
  timing?: Partial<Record<StatusTimingKey, number>>;
  onError?: (err: unknown) => void;
}

export interface StatusReactionController {
  setQueued: () => void;
  setThinking: () => void;
  setTool: (toolName?: string) => void;
  setCompacting: () => void;
  cancelPending: () => void;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
  isFinished: () => boolean;
  activeEmoji: () => string;
}

/**
 * 状态反应控制器（openclaw createStatusReactionController 完整逻辑）：
 * - Promise 链串行：所有表情操作排队，杜绝并发 API 乱序
 * - Debounce：中间状态（thinking/tool/compacting）700ms 防抖；排队/stall/终态立即
 * - Stall timers：每次活动重置；10s → ⏳、30s → ⚠️
 * - 终态保护：setDone/setError 后 finished=true，后续 setXxx 全部忽略
 * - 延迟移除：activeEmojis 记录所有已加表情；中间状态只增不减（避免闪烁）；
 *   终态时 removeActiveEmojis({ keepEmoji }) 移除除终态外全部
 * - restoreInitial：回到初始表情（👀）并移除其他
 * - clear：移除全部活跃表情
 */
export function createStatusReactionController(params: StatusReactionControllerOptions): StatusReactionController {
  const enabled = params.enabled ?? true;
  const emojis = {
    ...STATUS_EMOJIS,
    queued: params.emojis?.queued ?? params.initialEmoji ?? STATUS_EMOJIS.queued,
    ...params.emojis,
  };
  const timing = { ...STATUS_TIMING, ...params.timing };
  const { adapter, onError } = params;

  let currentEmoji = "";
  let pendingEmoji = "";
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let stallSoftTimer: ReturnType<typeof setTimeout> | undefined;
  let stallHardTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let chainPromise: Promise<void> = Promise.resolve();
  const activeEmojis = new Set<string>();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    chainPromise = chainPromise.then(fn, fn);
    return chainPromise;
  }

  function clearAllTimers(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
    if (stallSoftTimer) { clearTimeout(stallSoftTimer); stallSoftTimer = undefined; }
    if (stallHardTimer) { clearTimeout(stallHardTimer); stallHardTimer = undefined; }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
  }

  function resetStallTimers(): void {
    if (stallSoftTimer) clearTimeout(stallSoftTimer);
    if (stallHardTimer) clearTimeout(stallHardTimer);
    stallSoftTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallSoft, { immediate: true, skipStallReset: true });
    }, timing.stallSoftMs);
    stallHardTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallHard, { immediate: true, skipStallReset: true });
    }, timing.stallHardMs);
  }

  async function removeActiveEmojis(options: { keepEmoji?: string } = {}): Promise<void> {
    if (!adapter.removeReaction) return;
    for (const emoji of Array.from(activeEmojis)) {
      if (emoji === options.keepEmoji) continue;
      try {
        await adapter.removeReaction(emoji);
      } catch (err) {
        if (onError) onError(err);
      } finally {
        activeEmojis.delete(emoji);
      }
    }
  }

  async function applyEmoji(newEmoji: string): Promise<void> {
    if (!enabled) return;
    try {
      if (!activeEmojis.has(newEmoji)) {
        await adapter.setReaction(newEmoji);
      }
      activeEmojis.add(newEmoji);
      currentEmoji = newEmoji;
    } catch (err) {
      if (onError) onError(err);
    }
  }

  function scheduleEmoji(emoji: string, options: { immediate?: boolean; skipStallReset?: boolean } = {}): void {
    if (!enabled || finished) return;
    if (emoji === currentEmoji || emoji === pendingEmoji) {
      if (!options.skipStallReset) resetStallTimers();
      return;
    }
    pendingEmoji = emoji;
    clearDebounceTimer();
    if (options.immediate) {
      enqueue(async () => {
        await applyEmoji(emoji);
        pendingEmoji = "";
      });
    } else {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        enqueue(async () => {
          await applyEmoji(emoji);
          pendingEmoji = "";
        });
      }, timing.debounceMs);
    }
    if (!options.skipStallReset) resetStallTimers();
  }

  function setQueued(): void {
    scheduleEmoji(emojis.queued, { immediate: true });
  }

  function setThinking(): void {
    scheduleEmoji(emojis.thinking);
  }

  function setTool(toolName?: string): void {
    scheduleEmoji(resolveToolEmoji(toolName, emojis));
  }

  function setCompacting(): void {
    scheduleEmoji(emojis.compacting);
  }

  function cancelPending(): void {
    clearDebounceTimer();
    pendingEmoji = "";
  }

  function finishWithEmoji(emoji: string): Promise<void> {
    if (!enabled) return Promise.resolve();
    finished = true;
    clearAllTimers();
    return enqueue(async () => {
      await applyEmoji(emoji);
      await removeActiveEmojis({ keepEmoji: emoji });
      pendingEmoji = "";
    });
  }

  function setDone(): Promise<void> {
    return finishWithEmoji(emojis.done);
  }

  function setError(): Promise<void> {
    return finishWithEmoji(emojis.error);
  }

  async function clear(): Promise<void> {
    if (!enabled) return;
    clearAllTimers();
    finished = true;
    await enqueue(async () => {
      await removeActiveEmojis();
      currentEmoji = "";
      pendingEmoji = "";
    });
  }

  async function restoreInitial(): Promise<void> {
    if (!enabled) return;
    const alreadyInitial = currentEmoji === emojis.queued;
    const pendingBeforeClear = pendingEmoji;
    const hadDebouncedPending = debounceTimer !== null;
    const hasExtraActiveEmoji = Array.from(activeEmojis).some((emoji) => emoji !== emojis.queued);
    clearAllTimers();
    if (alreadyInitial && (!pendingBeforeClear || hadDebouncedPending) && !hasExtraActiveEmoji) {
      pendingEmoji = "";
      return;
    }
    if (pendingBeforeClear === emojis.queued && !hadDebouncedPending) {
      await chainPromise;
      return;
    }
    await enqueue(async () => {
      await applyEmoji(emojis.queued);
      await removeActiveEmojis({ keepEmoji: emojis.queued });
      pendingEmoji = "";
    });
  }

  return {
    setQueued,
    setThinking,
    setTool,
    setCompacting,
    cancelPending,
    setDone,
    setError,
    clear,
    restoreInitial,
    isFinished: () => finished,
    activeEmoji: () => currentEmoji,
  };
}

export type StatusReactionControllerInstance = StatusReactionController;

/** 收到消息时立即加 ack 表情（👀）；失败静默（openclaw queueInitialDiscordAckReaction 简化）。 */
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
