// Progress lane — ported from openclaw progress-draft-compositor.ts（笔记 03/06/16/19）。
// 工具调用期间显示进度草稿：一行一个工具，实时更新（tool-start/update/end）。
// 笔记 19：思维链（reasoning）**注入同一个方块**——🧠 _斜体_ 行原地流动更新，
// 工具行到达时 commit 当前思维行，下一段思考另起一行（openclaw pushReasoningProgress）。
//
// 笔记 16 §2（discord 原生格式，buildChannelProgressDraftLine）：
//   - 普通工具行：🛠️ Bash: run tests（emoji + label + ": " + detail）
//   - command 工具（exec/bash）：🛠️ run tests（紧凑：emoji + detail，省略 label）
//   - 无 detail：🛠️ Bash
//   - emoji 映射 fallback：🧩（对应 openclaw resolveToolDisplay / tool-display-config）
// 笔记 06 要点：
//   - ChannelProgressDraftLineInput: tool/item/plan/approval/command-output 事件
//   - 行结构：{ id, kind, text, label, status, icon }
//   - removeChannelProgressDraftLine(lines, id) — 按 id 增量更新

import type { DraftStream, DraftPreview } from "../draft/draft-stream.ts";

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

const MAX_LINE_CHARS = 300;
/** 笔记 19: 思维行默认字符预算（openclaw progress.maxLineChars 默认 120）。 */
const DEFAULT_THINKING_MAX_CHARS = 120;
/** 笔记 19: 思考/回答分离正则（openclaw progress-draft-status-text）。 */
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
const THINKING_HEADER_RE =
  /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i;

/** openclaw tool-display-config 子集（resolveToolDisplay 的 emoji 映射）。 */
const TOOL_EMOJI: Record<string, string> = {
  bash: "🛠️",
  exec: "🛠️",
  "web_search": "🔎",
  "web-search": "🔎",
  "grep_search": "🔎",
  "grep-search": "🔎",
  read: "📄",
  write: "✏️",
  apply_patch: "✏️",
  "apply-patch": "✏️",
  "edit": "✏️",
  "todo": "📋",
  "list": "📋",
  "ls": "📋",
  "glob": "📋",
  "memory": "🧠",
  "recall": "🧠",
  "send_message": "📨",
  "send-message": "📨",
  "notify": "🔔",
  "http": "🌐",
  "fetch": "🌐",
  "curl": "🌐",
  "browser": "🌐",
  "docker": "🐳",
  "docker_exec": "🐳",
  "container": "🐳",
  "git": "🌿",
  "npm": "📦",
  "pnpm": "📦",
  "yarn": "📦",
  "python": "🐍",
  "node": "🟢",
  "tsx": "🟢",
  "go": "🐹",
  "rust": "🦀",
  "cargo": "🦀",
  "search": "🔎",
  "request": "🌐",
  "approve": "✅",
  "deny": "⛔",
  "plan": "🗺️",
  "wait": "⏳",
  "think": "🧠",
  "reason": "🧠",
  "image": "🖼️",
  "video": "🎬",
  "audio": "🎵",
  "tts": "🔊",
  "voice": "🎙️",
  "transcribe": "📝",
  "translate": "🌍",
  "code": "💻",
  "shell": "🛠️",
  "terminal": "🛠️",
  "open": "🔗",
  "close": "🔒",
  "delete": "🗑️",
  "remove": "🗑️",
  "move": "📦",
  "copy": "📋",
  "rename": "🏷️",
  "mkdir": "📁",
  "make_dir": "📁",
  "upload": "⬆️",
  "download": "⬇️",
  "export": "📤",
  "import": "📥",
};

/** openclaw resolveToolDisplay：工具名 → emoji + label（fallback 🧩 + 默认标签）。 */
export function resolveToolDisplay(name?: string): { emoji: string; label: string } {
  const key = (name ?? "").trim().toLowerCase();
  const emoji = TOOL_EMOJI[key] ?? "🧩";
  const label = key || "tool_call";
  return { emoji, label };
}

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
  const { emoji } = resolveToolDisplay(name);
  const icon = input.phase === "end" ? (input.ok === false ? "✗" : "✓") : emoji;
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
  // 笔记 19: 思维行（🧠 _斜体_）原样输出，斜体不能被转义
  if (line.text.startsWith("🧠 ")) {
    return line.text;
  }
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return escapeDiscordMarkdown(line.text);
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    return `${escapeDiscordMarkdown(label)}: ${escapeDiscordMarkdown(clipTelegramProgressText(detail))}`;
  }
  const text = line.text.trim();
  if (text && text !== label) {
    return `${escapeDiscordMarkdown(label)}: ${escapeDiscordMarkdown(clipTelegramProgressText(text))}`;
  }
  return escapeDiscordMarkdown(label);
}

/** Discord Markdown 转义（` * _ [ ] 需转义；保留换行）。 */
export function escapeDiscordMarkdown(text: string): string {
  return text.replace(/([\\\`*_\[\]])/g, "\\$1");
}

/** 整个进度草稿渲染（多行 <br>）。 */
export function renderProgressDraft(lines: ProgressLine[]): string {
  return lines.map(renderProgressLine).join("\n");
}

// ---------------- 笔记 19：思维链注入（openclaw progress-draft-status-text） ----------------

/**
 * 笔记 19: 规范化思维文本——剥 <think> 标签、剥 "Reasoning:/Thinking" 头、空白折叠成单行。
 */
export function normalizeReasoningProgressLine(text: string): string {
  const stripped = (text ?? "").replace(THINKING_TAG_RE, "");
  return stripped
    .replace(THINKING_HEADER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 笔记 19: 思维文本累积（openclaw mergeReasoningProgressText）。
 * 快照（snapshot:true / 以 "Reasoning:/Thinking" 开头）→ 整体替换；普通 delta → 追加。
 */
export function mergeReasoningProgressText(
  current: string,
  incoming: string,
  options?: { snapshot?: boolean },
): string {
  if (!current) return incoming;
  const normalizedCurrent = normalizeReasoningProgressLine(current);
  const normalizedIncoming = normalizeReasoningProgressLine(incoming);
  if (!normalizedIncoming) return current;
  if (normalizedIncoming === normalizedCurrent) return current;
  const isSnapshot =
    options?.snapshot === true || THINKING_HEADER_RE.test(incoming.trimStart()) ||
    (normalizedCurrent !== "" && normalizedIncoming.startsWith(normalizedCurrent));
  return isSnapshot ? incoming : `${current}${incoming}`;
}

/**
 * 笔记 19: 思维行格式化（openclaw formatReasoningProgressDisplayLine）。
 * _斜体_ 包裹 + 词边界截断保持斜体平衡（_ 恰好 2 个）。
 */
export function formatReasoningProgressDisplayLine(text: string, maxChars = DEFAULT_THINKING_MAX_CHARS): string {
  const normalized = normalizeReasoningProgressLine(text);
  if (!normalized) return "";
  if (Array.from(normalized).length <= maxChars) return `_${normalized}_`;
  const head = Array.from(normalized).slice(0, Math.max(1, maxChars - 2)).join("").trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  const body =
    boundary > Math.floor(maxChars * 0.6)
      ? `${head.slice(0, boundary).trimEnd()}…`
      : `${head}…`;
  return `_${body}_`;
}

/**
 * 笔记 19: 折叠摘要（openclaw progress-receipt-tracker buildSummaryLine）。
 * 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns
 */
export function buildProgressReceiptSummary(params: {
  reasoningSteps: number;
  toolCalls: number;
  startedAtMs: number;
  nowMs?: number;
}): string {
  const seconds = Math.max(1, Math.round(((params.nowMs ?? Date.now()) - params.startedAtMs) / 1000));
  const parts = [
    ...(params.reasoningSteps > 0 ? [`🧠 ${params.reasoningSteps} thought${params.reasoningSteps === 1 ? "" : "s"}`] : []),
    ...(params.toolCalls > 0 ? [`🛠️ ${params.toolCalls} tool call${params.toolCalls === 1 ? "" : "s"}`] : []),
    `⏱️ ${seconds}s`,
  ];
  return parts.join(" · ");
}

export interface ProgressLaneOptions {
  enabled: boolean;
  maxLines: number;
  /** 笔记 19: 思维链注入开关（openclaw progress.thinking，默认 true）。 */
  thinking?: boolean;
  /** 笔记 19: 思维行字符预算（openclaw progress.maxLineChars，默认 120）。 */
  thinkingMaxChars?: number;
  /** 笔记 19: endTurn 输出折叠摘要（🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns）。 */
  receipt?: boolean;
}

/**
 * ProgressLane：管理工具进度行 + 思维链（🧠 _斜体_），同一条 progress draft 消息（方块）。
 * 事件流：tool-start → 加行；tool-update → 更新行；tool-end → 标记 ✓/✗；
 *         pushReasoningProgress → 思维行原地流动；工具行到达 commit 思维行。
 */
export class ProgressLane {
  private opts: ProgressLaneOptions;
  private draft?: DraftStream;
  private lines: ProgressLine[] = [];
  /** 笔记 19: 累积中的思维文本（mergeReasoningProgressText）。 */
  private reasoningRawText = "";
  /** 笔记 19: 当前渲染的思维行（lastReasoningLine，原地替换目标）。 */
  private lastReasoningLine: string | undefined;
  /** 笔记 19: 折叠摘要计数。 */
  private reasoningSteps = 0;
  private toolCalls = 0;
  private startedAtMs = 0;

  constructor(opts: ProgressLaneOptions, draft?: DraftStream) {
    this.opts = { thinking: true, thinkingMaxChars: DEFAULT_THINKING_MAX_CHARS, receipt: false, ...opts };
    this.draft = draft;
  }

  bindDraft(draft: DraftStream): void {
    this.draft = draft;
  }

  beginTurn(): void {
    this.lines = [];
    this.reasoningRawText = "";
    this.lastReasoningLine = undefined;
    this.reasoningSteps = 0;
    this.toolCalls = 0;
    this.startedAtMs = Date.now();
  }

  /** 笔记 19: 注入思维 delta/快照（openclaw pushReasoningProgress）。 */
  pushReasoningProgress(text?: string, options?: { snapshot?: boolean }): void {
    if (!this.opts.enabled || !this.opts.thinking || !text) return;
    this.reasoningRawText = mergeReasoningProgressText(this.reasoningRawText, text, options);
    const compactLine = formatReasoningProgressDisplayLine(
      this.reasoningRawText,
      this.opts.thinkingMaxChars,
    );
    if (!compactLine) return;
    const displayLine = `🧠 ${compactLine}`;
    const priorIndex =
      this.lastReasoningLine === undefined ? -1 : this.lines.findIndex((l) => l.text === this.lastReasoningLine);
    if (priorIndex >= 0) {
      this.lines[priorIndex] = { kind: "item", text: displayLine, label: displayLine };
    } else {
      this.lines.push({ kind: "item", text: displayLine, label: displayLine });
      if (this.lines.length > this.opts.maxLines) this.lines.shift();
    }
    this.lastReasoningLine = displayLine;
    if (this.reasoningSteps === 0) this.reasoningSteps += 1;
    this.render();
  }

  /** 笔记 19: 工具行到达 → commit 当前思维行（下一段思考另起一行）。 */
  private commitThinking(): void {
    this.reasoningRawText = "";
    this.lastReasoningLine = undefined;
  }

  private upsert(line: ProgressLine): void {
    // 笔记 19: 工具行落地前 commit 思维行（与工具行按到达顺序交错）
    this.commitThinking();
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
    if (line) {
      this.toolCalls += 1;
      this.upsert(line);
    }
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
      parseMode: "Markdown",
    };
    this.draft.updatePreview(preview);
  }

  endTurn(): void {
    // 笔记 19: 折叠摘要（可开关）
    if (this.opts.receipt && (this.reasoningSteps > 0 || this.toolCalls > 0)) {
      this.draft?.updatePreview({
        text: buildProgressReceiptSummary({
          reasoningSteps: this.reasoningSteps,
          toolCalls: this.toolCalls,
          startedAtMs: this.startedAtMs,
        }),
        parseMode: "Markdown",
      });
      return;
    }
    // 全部完成：保留简短摘要（笔记 03: collapse summary）
    if (this.lines.some((l) => l.status === "running")) {
      this.render();
    } else if (this.lines.length > 0) {
      this.draft?.updatePreview({ text: `✅ ${this.lines.length} 个工具调用完成`, parseMode: "Markdown" });
    }
  }
}
