// Activity adapter — 把 pi-telegram 的 TelegramAssistantStreamEvent 转成
// OpenclawActivityEvent（解耦：不动 lib/ 内部，只在挂载点转换）。
//
// lib/activity.ts 事件（上游已有，openclaw 风格）：
//   start / text_start / text_delta / text_end /
//   thinking_start / thinking_delta / thinking_end /
//   toolcall_start / toolcall_delta / toolcall_end / done / error

import type { OpenclawActivityEvent } from "./dispatch.ts";

export type TelegramAssistantStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done" }
  | { type: "error" };

/** 把上游流事件转成 openclaw-style 事件。 */
export function adaptAssistantEvent(
  event: TelegramAssistantStreamEvent,
): OpenclawActivityEvent | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "assistant-text-delta", delta: event.delta };
    case "thinking_delta":
      return { type: "reasoning-delta", delta: event.delta };
    case "thinking_end":
      return { type: "reasoning-end" };
    case "toolcall_start":
      return { type: "tool-start", id: `toolcall-${event.contentIndex}` };
    case "toolcall_end":
      return { type: "tool-end", id: `toolcall-${event.contentIndex}`, ok: true };
    default:
      return undefined; // start/text_start/end/done/error 由上层处理
  }
}
