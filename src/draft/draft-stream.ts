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
  /**
   * Preview（思考/进度方块）编辑节流（笔记 25 性能）：thinking_delta 毫秒级到达，
   * 无节流时 edit 频率逼近 Discord 限流（1/s/channel）→ 429 风暴。
   * 默认 1000ms：首条立即发，窗口内新预览合并为最新值，窗口后编辑一次。
   */
  previewThrottleMs?: number;
  /** Telegram transport: send/edit/delete/chatAction. Injected by the bridge. */
  transport?: DraftTransport;
  /**
   * 最终投递前格式化钩子（笔记 24：convertMarkdownTables + stripInlineDirectiveTags）。
   * 仅对 answer lane 传入；progress 草稿不格式化（进度行是纯文本）。
   */
  formatText?: (text: string) => string;
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
  /** Issue #1：已作为独立消息投递的 chunk 数（避免重复发送旧块）。 */
  private deliveredChunkCount = 0;
  /** Issue #1：本次 flush 正在投递的完整文本基线（飞行竞态防护）。 */
  private inFlightText = "";
  /** Issue #1：未投递的增量文本（相对 deliveredText / inFlightText 之后的部分）。 */
  private pendingDelta = "";
  private failures = 0;
  private stopped = false;
  private previewMessageId: string | undefined;
  private previewText = "";
  private previewVisibleAtMs: number | undefined;
  private suspendedUntilMs = 0;
  private formatText?: (text: string) => string;
  /** 笔记 25 性能：preview 编辑节流窗口。 */
  private previewThrottleMs: number;
  private previewLastSentAtMs = 0;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DraftStreamOptions) {
    this.throttleMs = Math.max(MIN_THROTTLE_MS, options.throttleMs ?? DEFAULT_THROTTLE_MS);
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.minInitialChars = options.minInitialChars ?? 0;
    this.formatText = options.formatText;
    this.previewThrottleMs = Math.max(0, options.previewThrottleMs ?? 1000);
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
    // Issue #1 修复：pendingText 始终保持「完整累积文本」语义。
    // pendingDelta 只记增量；前缀基线 = 本次 flush 飞行中的完整文本
    // （inFlightText，飞行期间到达的 delta 也拼到完整前缀上）或已成功
    // 投递的 deliveredText。原实现 flush 清空 pendingText 后飞行期间的
    // updateDelta 从空串累积，下一次 editMessage 用「尾部」覆盖已发送内容。
    this.pendingDelta += delta;
    const base = this.inFlightText || this.deliveredText;
    this.update(base + this.pendingDelta);
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
    // 笔记 25 修复：preview 发送必须串行化（thinking_delta 毫秒级到达，
    // REST sendMessage 几十~几百 ms —— 并发下 previewMessageId 竞态覆盖，
    // 每条消息都成孤儿，Discord 里思考内容大量重复）。
    // 笔记 25 性能：节流窗口内合并为最新值（Discord 消息操作限流 ~1/s/channel，
    // 无节流时 thinking 高频 edit → 429 风暴）。
    this.pendingPreview = preview;
    void this.drainPreview();
  }

  private previewFlushInFlight = false;
  private pendingPreview: DraftPreview | undefined;

  /** 串行 drain：一次只发一个 preview，期间新到的预览合并为最新值；节流窗口内延后。 */
  private async drainPreview(): Promise<void> {
    if (this.previewFlushInFlight) return;
    const next = this.pendingPreview;
    if (!next) return;
    const sinceLast = Date.now() - this.previewLastSentAtMs;
    if (this.previewThrottleMs > 0 && sinceLast < this.previewThrottleMs) {
      // 节流窗口内：合并为最新值，窗口结束后再发（覆盖旧定时器 = 最新值优先）
      if (!this.previewTimer) {
        this.previewTimer = setTimeout(() => {
          this.previewTimer = undefined;
          void this.drainPreview();
        }, this.previewThrottleMs - sinceLast);
      }
      return;
    }
    this.pendingPreview = undefined;
    this.previewFlushInFlight = true;
    try {
      await this.flushPreview(next);
      this.previewLastSentAtMs = Date.now();
    } finally {
      this.previewFlushInFlight = false;
      // 处理期间又有新预览 → 继续 drain（保持串行 + 最新值优先）
      if (this.pendingPreview && !this.stopped) {
        void this.drainPreview();
      }
    }
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
      // 笔记 25：previewText 表示「已成功投递的文本」，发送成功后才更新
      // （updatePreview 的相等去重依赖它）
      this.previewText = preview.text;
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
    const rawText = this.pendingText; // updateDelta 已保证 = 基线 + pendingDelta
    // 笔记 01: minInitialChars — 未达最小长度不发首条（防推送轰炸）
    if (this.streamMessageId === undefined && rawText.length < this.minInitialChars) {
      this.scheduleFlush();
      return;
    }
    this.pendingText = "";
    this.pendingDelta = "";
    // Issue #1 修复：进入飞行前锁定基线；飞行期间 updateDelta 以它为前缀累积。
    // finally 中清空，保证飞行窗口外的 updateDelta 回落到 deliveredText 基线。
    this.inFlightText = rawText;
    try {
      // 笔记 24: 最终投递前格式化（表格 → ASCII 代码块 + 指令标签剥离）
      const text = this.formatText ? this.formatText(rawText) : rawText;
      const chunks = splitChunks(text, this.chunkSize);
      if (this.streamMessageId === undefined) {
        this.streamMessageId = await this.transport.sendMessage(chunks[0] ?? "");
        this.deliveredChunkCount = 1;
      } else {
        await this.transport.editMessage(this.streamMessageId, chunks[0] ?? "");
      }
      // Extra chunks become separate follow-up messages (openclaw parity).
      // Issue #1 修复：只投递「新增」的后续块；已投递块不重复发送。
      // 追加语义下 chunks[0] 前缀不变，主消息 editMessage 幂等。
      for (let i = this.deliveredChunkCount; i < chunks.length; i++) {
        await this.transport.sendMessage(chunks[i]);
      }
      this.deliveredChunkCount = Math.max(this.deliveredChunkCount, chunks.length);
      // 基线存「未格式化」完整文本：updateDelta 拼接时与 pendingText 同域。
      this.deliveredText = rawText;
      this.failures = 0;
      await this.transport.sendChatAction("typing");
    } catch (err) {
      // 笔记 25 性能：兼容 Discord 429（DiscordRateLimitError.retryAfterMs）——
      // 只有 Telegram 格式会被 readRetryAfterMs 识别，Discord 限流会误入普通失败重试风暴
      const retryAfter =
        readRetryAfterMs(err) ??
        (typeof (err as { retryAfterMs?: unknown })?.retryAfterMs === "number"
          ? ((err as { retryAfterMs: number }).retryAfterMs)
          : undefined);
      if (retryAfter !== undefined) {
        this.suspendedUntilMs = Date.now() + Math.min(retryAfter, MAX_PREVIEW_FLOOD_SUSPEND_MS);
      }
      this.failures++;
      if (this.failures <= MAX_CONSECUTIVE_FAILURES) {
        // Issue #1 修复：重试保留完整累积。恢复未投递增量 =
        // 本次 rawText 超出 deliveredText 的部分 + 飞行中新累积的 pendingDelta，
        // 重新拼成完整文本等待下次 flush。
        this.pendingDelta = rawText.slice(this.deliveredText.length) + this.pendingDelta;
        this.pendingText = this.deliveredText + this.pendingDelta;
        this.scheduleFlush();
      }
    } finally {
      this.inFlightText = "";
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
    // 先发送 pending 文本，再标记 stopped（否则 flush() 会因 stopped 直接返回，最终回复丢失）
    await this.flush();
    this.stopped = true;
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
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.streamMessageId !== undefined) {
      try { await this.transport.deleteMessage(this.streamMessageId); } catch { /* ignore */ }
    }
    await this.deletePreviewIfDwelled();
    this.streamMessageId = undefined;
    this.deliveredText = "";
    this.deliveredChunkCount = 0;
    this.inFlightText = "";
    this.pendingDelta = "";
    this.pendingText = "";
    this.stopped = false;
  }
}
