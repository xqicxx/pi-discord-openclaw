// Preview streaming mode resolution — ported from openclaw preview-streaming.ts (对照遗漏 #6).
// Telegram 默认 progress 草稿：工具密集回合显示状态草稿（能回答"在干活吗"），
// 而非流式回答文本。操作者可用 streaming.mode: "partial" 切换为直接流式回答。

export type PreviewStreamMode = "progress" | "partial" | "full";

export function resolveTelegramPreviewStreamMode(
  params: { streaming?: unknown } = {},
): PreviewStreamMode {
  const streaming =
    params.streaming && typeof params.streaming === "object"
      ? (params.streaming as { mode?: string })
      : undefined;
  const mode = streaming?.mode;
  if (mode === "partial" || mode === "full") {
    return mode;
  }
  return "progress"; // 默认（与 openclaw 一致）
}
