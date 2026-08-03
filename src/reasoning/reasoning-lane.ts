// Reasoning lane — ported from openclaw reasoning-lane-coordinator.ts.
// Extracts <think>...</think> content from the stream and renders a 🧠 italic
// message separate from the answer lane.

import type { DraftStream } from "../draft/draft-stream.js";

const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
const REASONING_TAG_PREFIXES = [
  "<think", "<thinking", "<thought", "<antthinking", "<mm:think",
  "</think", "</thinking", "</thought", "</antthinking", "</mm:think",
];

export interface ReasoningLaneOptions {
  enabled: boolean;
  style: "emoji-italic" | "italic" | "hidden";
}

export class ReasoningLane {
  private opts: ReasoningLaneOptions;
  private draft?: DraftStream;
  private accumulated = "";
  private inThinking = false;

  constructor(opts: ReasoningLaneOptions, _drafts: unknown) {
    this.opts = opts;
  }

  /** Bind a dedicated draft stream for the 🧠 reasoning message. */
  bindDraft(draft: DraftStream): void {
    this.draft = draft;
  }

  beginTurn(): void {
    this.accumulated = "";
    this.inThinking = false;
  }

  /** Feed raw stream text; extract thinking portions incrementally. */
  onDelta(delta: string): void {
    if (!this.opts.enabled || this.opts.style === "hidden") return;
    this.accumulated += delta;
    const extracted = this.extractThinking(this.accumulated);
    if (extracted) {
      this.draft?.update(this.render(extracted));
    }
  }

  finalize(): void {
    void this.draft?.stop();
  }

  endTurn(): void {
    void this.draft?.stop();
  }

  /** Render extracted thinking per style: 🧠 italic / italic / raw. */
  private render(text: string): string {
    switch (this.opts.style) {
      case "emoji-italic":
        return `🧠 _${text.trim().replaceAll("_", "\\_")}_`;
      case "italic":
        return `_${text.trim().replaceAll("_", "\\_")}_`;
      default:
        return text;
    }
  }

  /**
   * Port of openclaw extractThinkingFromTaggedStreamOutsideCode:
   * collect text between <think>...</think> tags, ignoring code regions.
   */
  private extractThinking(text: string): string {
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
}
