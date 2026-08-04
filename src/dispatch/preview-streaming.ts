// Preview streaming modes — ported from openclaw preview-streaming.ts + streaming.ts (对照遗漏).
// Telegram 默认 progress 草稿：工具密集回合显示状态草稿（能回答"在干活吗"）。
// 文档：channels.telegram.streaming = off | partial | block | progress (默认 progress)。

export type PreviewStreamMode = "off" | "partial" | "block" | "progress";

/**
 * 解析 streaming 模式（对齐 openclaw 文档：off|partial|block|progress）。
 * - off: 关闭预览流式，直接发送最终消息
 * - partial: 流式回答文本进预览
 * - block: 分块流式（回答文本分段发送）
 * - progress: 默认，保留可编辑状态草稿（工具进度行）
 */
export function resolveTelegramPreviewStreamMode(
  params: { streaming?: unknown } = {},
): PreviewStreamMode {
  const streaming =
    params.streaming && typeof params.streaming === "object"
      ? (params.streaming as { mode?: string })
      : undefined;
  const mode = streaming?.mode;
  if (mode === "partial" || mode === "block" || mode === "off") {
    return mode;
  }
  return "progress"; // 默认（与 openclaw 一致）
}

/**
 * streaming.progress.commentary（默认 false）— 助手注释/前言文本进临时进度草稿。
 * 对齐 openclaw resolveChannelStreamingProgressCommentary。
 */
export function resolveProgressCommentary(
  params: { streaming?: unknown } = {},
): boolean {
  const streaming =
    params.streaming && typeof params.streaming === "object"
      ? (params.streaming as { progress?: { commentary?: boolean } })
      : undefined;
  return streaming?.progress?.commentary ?? false;
}

/**
 * streaming.preview.commandText（raw|status，默认 raw）— 命令细节显示模式。
 * - raw: 显示完整命令文本
 * - status: 只显示工具名（状态标签）
 */
export function resolveCommandTextMode(
  params: { streaming?: unknown } = {},
): "raw" | "status" {
  const streaming =
    params.streaming && typeof params.streaming === "object"
      ? (params.streaming as { preview?: { commandText?: string } })
      : undefined;
  const mode = streaming?.preview?.commandText;
  return mode === "status" ? "status" : "raw";
}
