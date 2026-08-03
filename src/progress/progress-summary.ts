// Progress summary — ported from openclaw progress-summary.ts (对照遗漏 #4).
// Turn 结束时折叠进度窗口为一行摘要：🧠 thoughts · 💬 notes · 🛠️ tool calls · ⏱️ seconds
//（与 Discord 的 collapse-summary 行一致）。

export type TelegramProgressSummaryCounters = {
  reasoningSteps: number;
  commentaryNotes: number;
  toolCalls: number;
};

/**
 * 进度摘要跟踪器：统计本 turn 实际流式到进度窗口的活动。
 * 只统计真正流出的内容（与 openclaw 一致：不统计 durable 交付项）。
 */
export function createTelegramProgressSummaryTracker() {
  let reasoningSteps = 0;
  let commentaryNotes = 0;
  let toolCalls = 0;
  let reasoningBurstOpen = false;
  let commentaryBurstOpen = false;

  return {
    noteReasoningBurst: () => {
      if (!reasoningBurstOpen) {
        reasoningBurstOpen = true;
        reasoningSteps += 1;
      }
    },
    closeReasoningBurst: () => {
      reasoningBurstOpen = false;
    },
    noteCommentaryBurst: () => {
      if (!commentaryBurstOpen) {
        commentaryBurstOpen = true;
        commentaryNotes += 1;
      }
    },
    closeCommentaryBurst: () => {
      commentaryBurstOpen = false;
    },
    noteToolCall: () => {
      toolCalls += 1;
    },
    counters: (): TelegramProgressSummaryCounters => ({
      reasoningSteps,
      commentaryNotes,
      toolCalls,
    }),
  };
}

/**
 * 渲染摘要行。全部为零时返回 undefined（避免只显示 ⏱️ 的退化行）。
 * 内容与顺序与 openclaw/Discord 完全一致。
 */
export function formatTelegramProgressSummaryLine(
  counters: TelegramProgressSummaryCounters,
  elapsedMs: number,
): string | undefined {
  const { reasoningSteps, commentaryNotes, toolCalls } = counters;
  if (reasoningSteps <= 0 && commentaryNotes <= 0 && toolCalls <= 0) {
    return undefined;
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const parts = [
    ...(reasoningSteps > 0
      ? [`🧠 ${reasoningSteps} thought${reasoningSteps === 1 ? "" : "s"}`]
      : []),
    ...(commentaryNotes > 0
      ? [`💬 ${commentaryNotes} note${commentaryNotes === 1 ? "" : "s"}`]
      : []),
    ...(toolCalls > 0 ? [`🛠️ ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : []),
    `⏱️ ${seconds}s`,
  ];
  return parts.join(" · ");
}
