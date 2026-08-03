// Reasoning lane — ported from openclaw reasoning-lane-coordinator.ts (笔记 02).
// 把模型流中的思考（reasoning）与回答（answer）分离：
// 思考以 🧠 _斜体_ 独立消息发送，回答走 answer lane。

// 笔记 02 核心：
//   1. splitTelegramReasoningText(text, isReasoning) — 思考/回答分离
//   2. extractThinkingFromTaggedStreamOutsideCode(text) — 提取 <think> 标签内容
//   3. markReasoningMessage(formatted) — 文本 → 🧠 _斜体_（openclaw formatReasoningMessage 先包斜体再 🧠）
//   4. isPartialReasoningTagPrefix(text) — 未闭合标签前缀判断
//   5. createTelegramReasoningStepState() — 思考步骤状态机

const REASONING_MESSAGE_RE = /^🧠\s+_/u;
const CORE_THINKING_HEADER_RE = /^Thinking\.{0,3}\s*\n+/u;
const LEGACY_REASONING_MESSAGE_PREFIX = "Reasoning:\n";

const REASONING_TAG_PREFIXES = [
  "<think", "<thinking", "<thought", "<antthinking", "<mm:think",
  "</think", "</thinking", "</thought", "</antthinking", "</mm:think",
];

const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

/** 笔记 02-3: 文本 → 🧠 _斜体_。纯文本先包斜体（openclaw formatReasoningMessage 行为），再 🧠。 */
function markReasoningMessage(formatted: string): string {
  const withoutHeader = formatted.replace(CORE_THINKING_HEADER_RE, "");
  const body = /^_/u.test(withoutHeader) ? withoutHeader : `_${withoutHeader.trim()}_`;
  return body.replace(/^_/u, "🧠 _");
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

/** 渲染：按风格输出思考文本。 */
export function renderReasoningText(text: string, style: "emoji-italic" | "italic" | "hidden"): string {
  if (style === "hidden") return "";
  const trimmed = text.trim().replaceAll("_", "\\_");
  if (style === "emoji-italic") return `🧠 _${trimmed}_`;
  return `_${trimmed}_`;
}
