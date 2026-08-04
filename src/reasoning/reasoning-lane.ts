// Reasoning lane — ported from openclaw reasoning-lane-coordinator.ts（笔记 02/16/19）。
// 笔记 19 修正：OpenClaw Discord 原生 progress 模式下，思维链**不是独立消息**，
// 而是注入 progress draft 方块（🧠 _斜体_ 行原地流动更新）。独立 blockquote（> 🧠）
// 仅用于 durable reasoning（非流式窗口）。因此 ReasoningLane 改为把 delta 路由到
// ProgressLane.pushReasoningProgress（同一方块），不再持有独立 DraftStream。
//
// 笔记 02 核心（纯函数保留，兼容既有测试/调用方）：
//   1. splitTelegramReasoningText(text, isReasoning) — 思考/回答分离
//   2. extractThinkingFromTaggedStreamOutsideCode(text) — 提取 <think> 标签内容
//   3. formatDiscordReasoningQuote(text) — 文本 → > 🧠 blockquote（durable reasoning 用）
//   4. isPartialReasoningTagPrefix(text) — 未闭合标签前缀判断
//   5. createTelegramReasoningStepState() — 思考步骤状态机

import type { ProgressLane } from "../progress/progress-lane.ts";

const REASONING_MESSAGE_RE = /^>\s*🧠/u;
const CORE_THINKING_HEADER_RE = /^Thinking\.{0,3}\s*\n+/u;
const LEGACY_REASONING_MESSAGE_PREFIX = "Reasoning:\n";

const REASONING_TAG_PREFIXES = [
  "<think", "<thinking", "<thought", "<antthinking", "<mm:think",
  "</think", "</thinking", "</thought", "</antthinking", "</mm:think",
];

const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

/**
 * 笔记 16 §1: 文本 → > 🧠 blockquote（openclaw formatDiscordReasoningQuote，durable reasoning）。
 * 每行 `> ` 前缀，首行加 🧠；空行剔除。
 */
export function formatDiscordReasoningQuote(quoteText: string): string | undefined {
  const lines = quoteText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  lines[0] = `🧠 ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join("\n");
}

function markReasoningMessage(formatted: string): string {
  const withoutHeader = formatted.replace(CORE_THINKING_HEADER_RE, "");
  return formatDiscordReasoningQuote(withoutHeader) ?? "";
}

/** 笔记 02-2: 提取标签内思考文本。 */
export function extractThinkingFromTaggedStreamOutsideCode(text: string): string {
  if (!text) return "";
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  THINKING_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  if (inThinking) {
    result += text.slice(lastIndex);
  }
  return result.trim();
}

/** 笔记 02-4: 是否处于未闭合标签前缀（如 `<think`、`<th`）。 */
export function isPartialReasoningTagPrefix(text: string): boolean {
  const trimmed = (text ?? "").trimStart().toLowerCase();
  if (!trimmed.startsWith("<")) return false;
  if (trimmed.includes(">")) return false;
  return REASONING_TAG_PREFIXES.some((prefix) => prefix.startsWith(trimmed));
}

/** 笔记 02-1: 思考/回答分离。 */
export function splitTelegramReasoningText(
  text?: string,
  isReasoning?: boolean,
): { reasoningText?: string; answerText?: string } {
  if (typeof text !== "string") return {};
  if (isReasoning !== true) return { answerText: text };

  const trimmed = text.trim();
  if (isPartialReasoningTagPrefix(trimmed)) return {}; // 等更多内容
  if (REASONING_MESSAGE_RE.test(trimmed)) return { reasoningText: trimmed }; // 已是 🧠
  if (CORE_THINKING_HEADER_RE.test(trimmed)) {
    return { reasoningText: markReasoningMessage(trimmed) }; // Thinking 头 → 🧠
  }
  if (
    trimmed.startsWith(LEGACY_REASONING_MESSAGE_PREFIX) &&
    trimmed.length > LEGACY_REASONING_MESSAGE_PREFIX.length
  ) {
    return { reasoningText: trimmed }; // legacy reasoning 前缀
  }

  const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
  return {
    reasoningText: markReasoningMessage(taggedReasoning || trimmed),
  };
}

/** 笔记 02-5: 思考步骤状态机（hinted → delivered）。 */
export function createTelegramReasoningStepState() {
  let reasoningStatus: "none" | "hinted" | "delivered" = "none";
  let bufferedFinalAnswer: { text: string } | undefined;

  return {
    noteReasoningHint: () => {
      if (reasoningStatus === "none") reasoningStatus = "hinted";
    },
    noteReasoningDelivered: () => {
      reasoningStatus = "delivered";
    },
    shouldBufferFinalAnswer: () => reasoningStatus === "hinted" && !bufferedFinalAnswer,
    bufferFinalAnswer: (value: { text: string }) => {
      bufferedFinalAnswer = value;
    },
    takeBufferedFinalAnswer: () => {
      const value = bufferedFinalAnswer;
      bufferedFinalAnswer = undefined;
      return value;
    },
    resetForNextStep: () => {
      reasoningStatus = "none";
      bufferedFinalAnswer = undefined;
    },
  };
}

/** 渲染：按风格输出思考文本（笔记 19：progress 方块内 `🧠 _斜体_` 行由 ProgressLane 负责；此处保留 durable blockquote 渲染）。 */
export function renderReasoningText(text: string, style: "emoji-italic" | "italic" | "hidden"): string {
  if (style === "hidden") return "";
  return formatDiscordReasoningQuote(text) ?? "";
}

/**
 * ReasoningLane 类包装（笔记 19）：思维链 delta **路由到 ProgressLane**（同一方块流动），
 * 不再持有独立 DraftStream。onDelta 直接转发给 progress.pushReasoningProgress（delta 追加语义
 * 在 mergeReasoningProgressText 内处理）；snapshot 语义由 finalize 传入。
 */
export class ReasoningLane {
  private opts: { enabled: boolean; style: "emoji-italic" | "italic" | "hidden" };
  private progress?: ProgressLane;

  constructor(
    opts: { enabled: boolean; style: "emoji-italic" | "italic" | "hidden" },
    progress?: ProgressLane,
  ) {
    this.opts = opts;
    this.progress = progress;
  }

  /** 笔记 19: 绑定思维链注入目标（progress 方块）。 */
  bindProgress(progress: ProgressLane): void {
    this.progress = progress;
  }

  beginTurn(): void {
    // 累积状态由 ProgressLane 持有
  }

  /** 笔记 19: thinking_delta → progress 方块（🧠 行原地流动）。 */
  onDelta(delta: string): void {
    if (!this.opts.enabled || this.opts.style === "hidden") return;
    this.progress?.pushReasoningProgress(delta);
  }

  /** 笔记 19: thinking_end（快照语义，整体替换当前思维行）。 */
  finalize(snapshotText?: string): void {
    if (!this.opts.enabled) return;
    if (snapshotText) {
      this.progress?.pushReasoningProgress(snapshotText, { snapshot: true });
    }
  }

  endTurn(): void {
    // 无状态；由 ProgressLane.endTurn 收尾
  }
}
