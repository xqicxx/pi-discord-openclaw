// Draft stream engine — ported from openclaw draft-stream.ts (笔记 01).
// Single Telegram message continuously editMessageText for typewriter streaming.
//
// 笔记 01 机制要点（全部实现）：
//   1. 分页：splitChunks 长文本拆多页（4096 限制，安全余量 3800）
//   2. 节流：throttleMs = max(250, 配置)，默认 1000ms
//   3. 首次 sendMessage；后续 editMessageText
//   4. 预览：独立 preview 消息（进度/思考框），teardown 延迟删除（MIN_PREVIEW_DWELL_MS）
//   5. 失败重试：MAX_CONSECUTIVE_FAILURES 内重试
//   6. flood 退避：读 retry_after，最长挂起 60s

import { splitChunks } from "../lanes/lane.ts";

const DEFAULT_THROTTLE_MS = 1000;
const MIN_THROTTLE_MS = 250;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PREVIEW_FLOOD_SUSPEND_MS = 60_000;
const MIN_PREVIEW_DWELL_MS = 4_000;
const DEFAULT_CHUNK_SIZE = 1900; // Discord 2000 上限留余量

export interface DraftStreamOptions {
  throttleMs?: number;
  chunkSize?: number;
  /** Minimum chars before sending first message (debounce push notifications). */
  minInitialChars?: number;
  /** Telegram transport: send/edit/delete/chatAction. Injected by the bridge. */
  transport?: DraftTransport;
}

export interface DraftTransport {
  sendMessage: (text: string) => Promise<string>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  sendChatAction: (action: "typing") => Promise<void>;
}

/** Preview payload for the ephemeral progress/reasoning box. */
export interface DraftPreview {
  text: string;
  /** Parse mode for the preview message (default HTML). */
  parseMode?: "HTML" | "Markdown";
}

/** Error carrying Telegram retry_after (ms) for flood control. */
export class TelegramFloodError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Extract retry_after from a Telegram error payload if present. */
export function readRetryAfterMs(err: unknown): number | undefined {
  const anyErr = err as { description?: string; parameters?: { retry_after?: number } };
  const raw =
    anyErr?.parameters?.retry_after ??
    (typeof anyErr?.description === "string"
      ? /retry after (\d+)/i.exec(anyErr.description)?.[1]
      : undefined);
  const parsed = raw === undefined ? undefined : Number(raw);
  if (parsed !== undefined && Number.isFinite(parsed)) {
    return Math.max(0, Math.round(parsed * (parsed < 100 ? 1000 : 1))); // seconds→ms
  }
  return undefined;
}

export class DraftStream {
  private throttleMs: number;
  private chunkSize: number;
  private minInitialChars: number;
  private transport: DraftTransport;
  private pendingText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private streamMessageId: string | undefined;
  private deliveredText = "";
  private failures = 0;
  private stopped = false;
  private previewMessageId: string | undefined;
  private previewText = "";
  private previewVisibleAtMs: number | undefined;
  private suspendedUntilMs = 0;

  constructor(options: DraftStreamOptions) {
    this.throttleMs = Math.max(MIN_THROTTLE_MS, options.throttleMs ?? DEFAULT_THROTTLE_MS);
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.minInitialChars = options.minInitialChars ?? 0;
    this.transport = options.transport ?? {
      sendMessage: async () => "",
      editMessage: async () => {},
      deleteMessage: async () => {},
      sendChatAction: async () => {},
    };
  }

  /** Queue a text update; throttled edit will follow. */
  update(text: string): void {
    if (this.stopped) return;
    this.pendingText = text;
    this.scheduleFlush();
  }

  /** Append delta to current draft. */
  updateDelta(delta: string): void {
    this.update(this.pendingText + delta);
  }

  /** Lazy update: text resolved at flush time (笔记 01: updateLazy). */
  updateLazy(resolveText: () => string | undefined): void {
    if (this.stopped) return;
    const resolved = resolveText();
    if (resolved === undefined) return;
    this.pendingText = resolved;
    this.scheduleFlush();
  }

  /** Update the ephemeral preview box (reasoning / progress). */
  updatePreview(preview: DraftPreview): void {
    if (this.stopped) return;
    if (this.suspendedUntilMs > Date.now()) return;
    const text = preview.text;
    if (text === this.previewText) return;
    this.previewText = text;
    void this.flushPreview(preview);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.suspendedUntilMs - Date.now());
    this.timer = setTimeout(() => void this.flush(), Math.max(wait, this.throttleMs));
  }

  private async flushPreview(preview: DraftPreview): Promise<void> {
    try {
      if (this.previewMessageId === undefined) {
        this.previewMessageId = await this.transport.sendMessage(preview.text);
        this.previewVisibleAtMs = Date.now();
      } else {
        await this.transport.editMessage(this.previewMessageId, preview.text);
      }
    } catch (err) {
      const retryAfter = readRetryAfterMs(err);
      if (retryAfter !== undefined) {
        this.suspendedUntilMs = Date.now() + Math.min(retryAfter, MAX_PREVIEW_FLOOD_SUSPEND_MS);
      }
    }
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || !this.pendingText) return;
    if (this.suspendedUntilMs > Date.now()) {
      this.scheduleFlush();
      return;
    }
    const text = this.pendingText;
    this.pendingText = "";
    // 笔记 01: minInitialChars — 未达最小长度不发首条（防推送轰炸）
    if (this.streamMessageId === undefined && text.length < this.minInitialChars) {
      this.pendingText = text;
      this.scheduleFlush();
      return;
    }
    const chunks = splitChunks(text, this.chunkSize);
    try {
      if (this.streamMessageId === undefined) {
        this.streamMessageId = await this.transport.sendMessage(chunks[0] ?? "");
        this.deliveredText = chunks[0] ?? "";
      } else {
        await this.transport.editMessage(this.streamMessageId, chunks[0] ?? "");
        this.deliveredText = chunks[0] ?? "";
      }
      // Extra chunks become separate follow-up messages (openclaw parity).
      for (let i = 1; i < chunks.length; i++) {
        await this.transport.sendMessage(chunks[i]);
      }
      this.failures = 0;
      await this.transport.sendChatAction("typing");
    } catch (err) {
      const retryAfter = readRetryAfterMs(err);
      if (retryAfter !== undefined) {
        this.suspendedUntilMs = Date.now() + Math.min(retryAfter, MAX_PREVIEW_FLOOD_SUSPEND_MS);
      }
      this.failures++;
      if (this.failures <= MAX_CONSECUTIVE_FAILURES) {
        this.pendingText = text;
        this.scheduleFlush();
      }
    }
  }

  messageId(): string | undefined {
    return this.streamMessageId;
  }

  lastDeliveredText(): string {
    return this.deliveredText;
  }

  /** True while a pending or visible draft owns a first/batched reply target. */
  hasConsumedReplyTarget(): boolean {
    return this.streamMessageId !== undefined || this.previewMessageId !== undefined;
  }

  /** Final flush + mark stopped. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = true;
    await this.flush();
    await this.deletePreviewIfDwelled();
  }

  /** Stop without a final flush or delete. */
  async discard(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = true;
  }

  private async deletePreviewIfDwelled(): Promise<void> {
    if (this.previewMessageId === undefined) return;
    const dwell = this.previewVisibleAtMs === undefined ? 0 : Date.now() - this.previewVisibleAtMs;
    const wait = Math.max(0, MIN_PREVIEW_DWELL_MS - dwell);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      await this.transport.deleteMessage(this.previewMessageId);
    } catch { /* ignore */ }
    this.previewMessageId = undefined;
    this.previewVisibleAtMs = undefined;
  }

  async clear(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.streamMessageId !== undefined) {
      try { await this.transport.deleteMessage(this.streamMessageId); } catch { /* ignore */ }
    }
    await this.deletePreviewIfDwelled();
    this.streamMessageId = undefined;
    this.deliveredText = "";
    this.pendingText = "";
    this.stopped = false;
  }
}
