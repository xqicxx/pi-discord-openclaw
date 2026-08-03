// Progress lane — ported from openclaw progress-draft-preview.ts + progress-draft-lines.ts (笔记 03/06).
// 工具调用期间显示进度草稿：一行一个工具，实时更新（tool-start/update/end）。
//
// 笔记 03 要点：
//   - 行格式：<b>🔧 name</b> <code>detail</code> <i>running|✓</i>
//   - 已完成工具折叠为摘要（summary）
// 笔记 06 要点：
//   - ChannelProgressDraftLineInput: tool/item/plan/approval/command-output 事件
//   - 行结构：{ id, kind, text, label, status, icon }
//   - removeChannelProgressDraftLine(lines, id) — 按 id 增量更新

import type { DraftStream, DraftPreview } from "../draft/draft-stream.js";

/** 笔记 06: 进度行结构。 */
export interface ProgressLine {
  id?: string;
  kind: "tool" | "item" | "plan" | "approval" | "command-output";
  text: string;
  label?: string;
  status?: string;
  icon?: string;
  detail?: string;
}

/** 笔记 06: 工具进度事件（映射 pi activity tool-start/update/end）。 */
export interface ToolProgressEvent {
  event: "tool";
  toolCallId?: string;
  name?: string;
  phase?: string; // start | update | end
  args?: Record<string, unknown>;
  status?: string;
  ok?: boolean;
}

const MAX_PROGRESS_LINES = 8;
const MAX_LINE_CHARS = 80;

/** 超长截断（笔记 03: clipTelegramProgressText）。 */
export function clipTelegramProgressText(text: string, max = MAX_LINE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** 笔记 03: formatTelegramProgressLine — 斜体原样，否则代码块。 */
export function formatTelegramProgressLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : `\`${clipTelegramProgressText(trimmed)}\``;
}

/** 笔记 06: 从工具事件构建进度行。 */
export function buildToolProgressLine(input: ToolProgressEvent): ProgressLine | undefined {
  const name = input.name?.trim();
  if (!name) return undefined;
  const id = input.toolCallId ? `tool:${input.toolCallId}` : undefined;
  const status = input.ok === false ? "error" : input.phase === "end" ? "completed" : "running";
  const icon = input.phase === "end" ? (input.ok === false ? "✗" : "✓") : "🔧";
  const label = `${icon} ${name}`;
  return {
    id,
    kind: "tool",
    label,
    text: label,
    status,
    detail: input.args ? compactArgs(input.args) : undefined,
  };
}

/** 工具参数压缩为简短 detail（笔记 03: command text）。 */
function compactArgs(args: Record<string, unknown>): string | undefined {
  const cmd = args.cmd ?? args.command ?? args.query ?? args.prompt;
  if (typeof cmd === "string" && cmd.trim()) {
    return clipTelegramProgressText(cmd.trim());
  }
  return undefined;
}

/** 笔记 06: 按 id 删除进度行（保留其他行）。 */
export function removeProgressLine(lines: ProgressLine[], id: string): ProgressLine[] {
  const lineId = id.trim();
  if (!lineId) return lines;
  const next = lines.filter((line) => line.id?.trim() !== lineId);
  return next.length === lines.length ? lines : next;
}

/** 进度行渲染为 HTML（笔记 03: renderTelegramProgressLine）。 */
export function renderProgressLine(line: ProgressLine): string {
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return escapeHtml(line.text);
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [`<b>${escapeHtml(label)}</b>`];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(`<code>${escapeHtml(clipTelegramProgressText(detail))}</code>`);
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      parts.push(`<code>${escapeHtml(clipTelegramProgressText(text))}</code>`);
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(`<i>${escapeHtml(line.status)}</i>`);
  }
  return parts.join(" ");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 整个进度草稿渲染（多行 <br>）。 */
export function renderProgressDraft(lines: ProgressLine[]): string {
  return lines.map(renderProgressLine).join("<br>");
}

export interface ProgressLaneOptions {
  enabled: boolean;
  maxLines: number;
}

/**
 * ProgressLane：管理工具进度行列表，通过 draft stream 渲染到 Telegram。
 * 事件流：tool-start → 加行；tool-update → 更新行；tool-end → 标记 ✓/✗；
 * 全部完成 → 保留摘要或清理。
 */
export class ProgressLane {
  private opts: ProgressLaneOptions;
  private draft?: DraftStream;
  private lines: ProgressLine[] = [];

  constructor(opts: ProgressLaneOptions, draft?: DraftStream) {
    this.opts = opts;
    this.draft = draft;
  }

  bindDraft(draft: DraftStream): void {
    this.draft = draft;
  }

  beginTurn(): void {
    this.lines = [];
  }

  private upsert(line: ProgressLine): void {
    if (!line.id) {
      this.lines.push(line);
    } else {
      const idx = this.lines.findIndex((l) => l.id === line.id);
      if (idx >= 0) this.lines[idx] = line;
      else this.lines.push(line);
    }
    // 超过 maxLines 时丢弃最早的完成行（笔记 03: 折叠摘要思想）
    if (this.lines.length > this.opts.maxLines) {
      const doneIdx = this.lines.findIndex((l) => l.status === "completed");
      if (doneIdx >= 0) this.lines.splice(doneIdx, 1);
      else this.lines.shift();
    }
    this.render();
  }

  onToolStart(event: { name?: string; id?: string; args?: Record<string, unknown> }): void {
    if (!this.opts.enabled) return;
    const line = buildToolProgressLine({
      event: "tool",
      toolCallId: event.id,
      name: event.name,
      phase: "start",
      args: event.args,
    });
    if (line) this.upsert(line);
  }

  onToolUpdate(event: { id?: string; detail?: string }): void {
    if (!this.opts.enabled) return;
    const idx = this.lines.findIndex((l) => l.id === `tool:${event.id}`);
    if (idx >= 0 && event.detail) {
      this.lines[idx].detail = clipTelegramProgressText(event.detail);
      this.render();
    }
  }

  onToolEnd(event: { id?: string; ok?: boolean }): void {
    if (!this.opts.enabled) return;
    const idx = this.lines.findIndex((l) => l.id === `tool:${event.id}`);
    if (idx >= 0) {
      const icon = event.ok === false ? "✗" : "✓";
      this.lines[idx].status = event.ok === false ? "error" : "completed";
      this.lines[idx].label = `${icon} ${(this.lines[idx].label ?? "").replace(/^[🔧✗✓]\s*/u, "")}`;
      this.lines[idx].text = this.lines[idx].label;
      this.render();
    }
  }

  private render(): void {
    if (!this.draft) return;
    const preview: DraftPreview = {
      text: renderProgressDraft(this.lines),
      parseMode: "HTML",
    };
    this.draft.updatePreview(preview);
  }

  endTurn(): void {
    // 全部完成：保留简短摘要（笔记 03: collapse summary）
    if (this.lines.some((l) => l.status === "running")) {
      this.render();
    } else if (this.lines.length > 0) {
      this.draft?.updatePreview({ text: `✅ ${this.lines.length} 个工具调用完成`, parseMode: "HTML" });
    }
  }
}
