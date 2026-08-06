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
  queued: "⏳",
  working: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  deploy: "🛫",
  build: "🏗️",
  concierge: "💁",
  done: "✓",
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
 * 笔记 33：args 里的真实联网调用信号（只认「实际调用形态」，不认代码文本提词）。
 * fabric_exec 的 args 是 TS 源码——旧版 bare-word 正则（WEB_ARGS_RE）会把源码里出现过的
 * "web_search"/"firecrawl"/"tavily"/"bing" 等字样（注释、grep 模式、工具清单、测试用例）
 * 也判成搜索 → 没搜网也挂 🌐（用户实锤误报）。现在只匹配调用形态：
 *   1) 调用语法：web_search( / webSearch( / web_fetch_exa( / firecrawl.scrape( / agent_browser(
 *   2) 具名访问：extensions.web_search / extensions.web_fetch / mcp.exa / mcp.firecrawl / mcp.tavily
 *   3) 搜索引擎 URL：google.com(/search) / duckduckgo.com / bing.com
 *   4) agent-reach CLI 命令：agent-reach <cmd>
 * JSON.stringify 会把代码内双引号转义成 \"——括号/点号不转义，所以调用语法在转义后仍可匹配。
 */
function argsHaveWebSignal(args: unknown): boolean {
  const s = JSON.stringify(args);
  if (!s) return false;
  const code = s.slice(0, 3000);
  // 1) 调用语法（fabric_exec 源码里的真实 web 工具调用）
  if (/web[_ -]?(?:search|fetch|crawl)\w*\s*\(/i.test(code)) return true;   // web_search( webSearch( web_fetch_exa(
  if (/firecrawl\.\w+\s*\(|agent_browser\s*\(|search_web\s*\(/i.test(code)) return true;
  // 2) 具名访问
  if (/extensions\.\s*web[_ -]?(?:search|fetch)/i.test(code)) return true;  // extensions.web_search / extensions.web_fetch
  if (/mcp\.\s*(?:exa|firecrawl|tavily)\b/i.test(code)) return true;        // mcp.exa / mcp.firecrawl / mcp.tavily
  // 3) 搜索引擎 URL（真联网）
  if (/google\.com(?:\/search)?|duckduckgo\.com|bing\.com/i.test(code)) return true;
  // 4) agent-reach CLI 命令
  if (/agent[-_]reach\s+[a-z][\w-]*/i.test(code)) return true;
  return false;
}

/**
 * 笔记 33：工具名或 args 中是否带联网信号。
 * - toolName 命中 WEB_TOOL_TOKENS（web_search/browser/web_fetch…）
 * - args 命中 argsHaveWebSignal（fabric_exec 内部真实调用 extensions.web_search / mcp.exa / firecrawl 等）
 * 两者任一命中 → 🌐。只匹配「实际调用」，源码提词（注释/grep 模式/清单）不误报。
 */
function hasWebSignal(toolName?: string, args?: unknown): boolean {
  if (!toolName && args === undefined) return false;
  if (WEB_TOOL_TOKENS.some((t) => (toolName ?? "").toLowerCase().includes(t))) return true;
  if (args === undefined) return false;
  return argsHaveWebSignal(args);
}

/** 笔记 33：长任务/联网工具 → 更宽的 stall 窗口（避免正常执行被误报 ⚠️）。
 *  fabric_exec 跑 TS 脚本、联网搜索 30-60s 很常见，期间 pi 侧无 thinking/tool 事件，
 *  默认 30s 硬阈值必然误报。这类工具 soft 3x / hard 4x。 */
const LONG_RUNNING_TOOL_RE = /fabric_exec|fabric|subagent|workflow|agents\.run|agents\.spawn/gi;

/**
 * 工具名 → 分类表情（openclaw resolveToolEmoji）。
 * 优先级 deploy > build > concierge > web > coding > tool；token 包含匹配。
 */
export function resolveToolEmoji(
  toolName?: string,
  emojis: Partial<Record<StatusEmojiKey, string>> = {},
  args?: unknown,
): string {
  const normalized = (toolName ?? "").trim().toLowerCase();
  // 笔记 30：联网搜索常在 fabric_exec 内部发生——args 里有 web 信号也算 🌐
  const argsWeb = hasWebSignal(toolName, args);
  if (!normalized && !argsWeb) return emojis.tool ?? STATUS_EMOJIS.tool;
  const category: StatusEmojiKey = DEPLOY_TOOL_TOKENS.some((t) => normalized.includes(t))
    ? "deploy"
    : BUILD_TOOL_TOKENS.some((t) => normalized.includes(t))
      ? "build"
      : CONCIERGE_TOOL_TOKENS.some((t) => normalized.includes(t))
        ? "concierge"
        : argsWeb || WEB_TOOL_TOKENS.some((t) => normalized.includes(t))
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
  /** 笔记 30：处理中（agent_start 后、thinking 前）——👀 表示真正开工。 */
  setWorking: () => void;
  /** 笔记 31：countsAsActivity=false 时不重置 stall 计时（思考对用户不可见时，
   *  thinking_delta 不算「可见活动」——10s ⏳ / 30s ⚠️ 照常出现，用户能分辨死活）。 */
  setThinking: (countsAsActivity?: boolean) => void;
  /** 笔记 30：思考结束移除 🧠（不常驻无意义标签）。 */
  removeThinking: () => void;
  /** 笔记 31：立即移除 🧠（无实质思考内容时，跳过 1.5s 防抖）。 */
  removeThinkingNow: () => void;
  setTool: (toolName?: string, args?: unknown) => void;
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
  /** 笔记 30：🧠 防抖移除 timer（多段思考时不闪烁）。 */
  let thinkingRemoveTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (thinkingRemoveTimer) { clearTimeout(thinkingRemoveTimer); thinkingRemoveTimer = undefined; }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
  }

  function resetStallTimers(msOverride?: { soft?: number; hard?: number }): void {
    if (stallSoftTimer) clearTimeout(stallSoftTimer);
    if (stallHardTimer) clearTimeout(stallHardTimer);
    // 笔记 33：新活动到来 → 之前挂上的 ⏳/⚠️ 不再是「卡死」信号，立即移除。
    // 原语义「只增不减」只该用于正常演进表情（⏳👀🧠🛠️…）；stall 是异常信号，
    // 恢复活动后还挂着会误导用户「网关死了」，且只能等终态才清。removeEmoji 幂等安全。
    for (const stallEmoji of [emojis.stallSoft, emojis.stallHard]) {
      if (activeEmojis.has(stallEmoji)) enqueue(() => removeEmoji(stallEmoji));
    }
    stallSoftTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallSoft, { immediate: true, skipStallReset: true });
    }, msOverride?.soft ?? timing.stallSoftMs);
    stallHardTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallHard, { immediate: true, skipStallReset: true });
    }, msOverride?.hard ?? timing.stallHardMs);
  }

  async function removeActiveEmojis(options: { keepEmoji?: string } = {}): Promise<void> {
    if (!adapter.removeReaction) return;
    for (const emoji of Array.from(activeEmojis)) {
      if (emoji === options.keepEmoji) continue;
      // 笔记 32：删除失败时**保留在 activeEmojis 集合中**（不 finally 删除）——
      // 否则 Discord 上表情还挂着、本地集合已删 → clear() 永不重试 → 永久残留。
      // 重试一次；仍失败则记日志（表情残留但可诊断）。
      try {
        await adapter.removeReaction(emoji);
        activeEmojis.delete(emoji);
      } catch (err) {
        if (onError) onError(err);
        try {
          await adapter.removeReaction(emoji);
          activeEmojis.delete(emoji);
        } catch (err2) {
          if (onError) onError(err2);
          console.warn("[ack-reactions] removeReaction 失败，表情可能残留:", emoji, (err2 as Error)?.message ?? String(err2));
        }
      }
    }
  }

  async function applyEmoji(newEmoji: string): Promise<void> {
    if (!enabled) return;
    try {
      // 笔记 30：只增不减（openclaw 原版语义）——⏳👀🧠 叠加演进是正常的
      //（每步都真实发生，有意义的）；终态 ✅/❌ 时 removeActiveEmojis 全部清理，
      // 不残留无意义标签。双通道 bug（裸加 👀）已修复，状态单通道管理。
      if (!activeEmojis.has(newEmoji)) {
        await adapter.setReaction(newEmoji);
      }
      activeEmojis.add(newEmoji);
      currentEmoji = newEmoji;
    } catch (err) {
      if (onError) onError(err);
    }
  }

  function scheduleEmoji(emoji: string, options: { immediate?: boolean; skipStallReset?: boolean; stallOverride?: { soft?: number; hard?: number } } = {}): void {
    if (!enabled || finished) return;
    if (emoji === currentEmoji || emoji === pendingEmoji) {
      if (!options.skipStallReset) resetStallTimers(options.stallOverride);
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
    if (!options.skipStallReset) resetStallTimers(options.stallOverride);
  }

  function setQueued(): void {
    scheduleEmoji(emojis.queued, { immediate: true });
  }

  /** 移除指定表情（如已添加）。失败时保留在集合中，后续终态清理会重试。 */
  async function removeEmoji(emoji: string): Promise<void> {
    if (!adapter.removeReaction || !activeEmojis.has(emoji)) return;
    try {
      await adapter.removeReaction(emoji);
      activeEmojis.delete(emoji);
    } catch (err) {
      if (onError) onError(err);
      console.warn("[ack-reactions] removeEmoji 失败，表情可能残留:", emoji, (err as Error)?.message ?? String(err));
    }
  }

  /** 笔记 30：处理中状态（👀）——开工即移除排队 ⏳（排队结束，不常驻），再显示 👀。
   *  remove 与 add 都走 enqueue 串行链，顺序稳定（切换流畅）。 */
  function setWorking(): void {
    enqueue(() => removeEmoji(emojis.queued));
    scheduleEmoji(emojis.working, { immediate: true });
  }

  /** 笔记 30：思考结束 → 1.5s 防抖后移除 🧠（多段思考时持续显示，不闪烁）。 */
  function removeThinking(): void {
    if (thinkingRemoveTimer) clearTimeout(thinkingRemoveTimer);
    thinkingRemoveTimer = setTimeout(() => {
      thinkingRemoveTimer = undefined;
      enqueue(() => removeEmoji(emojis.thinking));
    }, 1_500);
  }

  /** 笔记 31：立即移除 🧠（无实质思考内容时——thinking 总长度低于阈值，模型只是形式化思考）。
   *  与 removeThinking 的区别：跳过 1.5s 防抖，「没思考却有思考标签」的观感立即消失。 */
  function removeThinkingNow(): void {
    if (thinkingRemoveTimer) {
      clearTimeout(thinkingRemoveTimer);
      thinkingRemoveTimer = undefined;
    }
    enqueue(() => removeEmoji(emojis.thinking));
  }

  function setThinking(countsAsActivity = true): void {
    // 笔记 30：新思考段到来 → 取消待移除（防止闪烁）
    if (thinkingRemoveTimer) {
      clearTimeout(thinkingRemoveTimer);
      thinkingRemoveTimer = undefined;
    }
    // immediate——思考标签即时出现（applyEmoji 去重，无重复 API）
    // 笔记 31：思考不可见（思考行被关闭）时 skipStallReset——thinking 不算可见活动，
    // 否则 stall 永远被高频 thinking_delta 重置，「分不清死活」。
    scheduleEmoji(emojis.thinking, { immediate: true, skipStallReset: !countsAsActivity });
  }

  function setTool(toolName?: string, args?: unknown): void {
    const emoji = resolveToolEmoji(toolName, emojis, args);
    // 笔记 33：长任务/联网工具用宽 stall 窗口；普通工具保持 10s/30s 默认。
    // LONG_RUNNING_TOOL_RE 带 g flag，test 前重置 lastIndex（同上，防串台）
    LONG_RUNNING_TOOL_RE.lastIndex = 0;
    const isLong = (toolName ?? "").length > 0 && LONG_RUNNING_TOOL_RE.test(toolName!) || hasWebSignal(toolName, args);
    scheduleEmoji(emoji, {
      immediate: true,
      ...(isLong ? { stallOverride: { soft: timing.stallSoftMs * 3, hard: timing.stallHardMs * 4 } } : {}),
    });
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
    setWorking,
    setThinking,
    removeThinking,
    removeThinkingNow,
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
