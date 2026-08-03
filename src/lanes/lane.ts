// Lane model — ported from openclaw lane-delivery.ts / bot-message-dispatch-draft.ts.
// Each turn owns up to three lanes: reasoning (🧠), answer (📝), progress (🔧).

export type LaneName = "reasoning" | "answer" | "progress";

export interface DraftLaneState {
  /** Telegram message id once materialized (send) or set (edit target). */
  messageId?: number;
  /** Whether this lane has already streamed at least one message. */
  hasStreamedMessage: boolean;
  /** Last delivered text — used to avoid redundant edits. */
  lastDeliveredText?: string;
  /** Retained prompt-context pages for chunked messages (openclaw parity). */
  retainedPromptContextPages: string[];
}

export function createLaneState(): DraftLaneState {
  return { hasStreamedMessage: false, retainedPromptContextPages: [] };
}

/**
 * Split text into Telegram-safe chunks. openclaw uses TELEGRAM_TEXT_CHUNK_LIMIT
 * with a safety margin (3800 default here, configurable).
 */
export function splitChunks(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    // Prefer breaking at newline within the window; else hard cut.
    const window = rest.slice(0, chunkSize);
    const nl = window.lastIndexOf("\n");
    const cut = nl > chunkSize * 0.6 ? nl + 1 : chunkSize;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
