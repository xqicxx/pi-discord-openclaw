// Draft stream engine — ported from openclaw draft-stream.ts.
// Throttled editMessage streaming for the answer lane, with chunking,
// flood-control backoff and retry.

import { splitChunks } from "../lanes/lane.js";

const TELEGRAM_FLOOD_LIMIT_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface DraftStreamOptions {
  throttleMs?: number;
  chunkSize?: number;
  /** Telegram transport: send/edit/delete/chatAction. Injected by the bridge. */
  transport?: DraftTransport;
}

export interface DraftTransport {
  sendMessage: (text: string) => Promise<number>;
  editMessage: (messageId: number, text: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<void>;
  sendChatAction: (action: "typing") => Promise<void>;
}

export class DraftStream {
  private throttleMs: number;
  private chunkSize: number;
  private transport: DraftTransport;
  private pendingText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private messageId: number | undefined;
  private deliveredText = "";
  private failures = 0;
  private stopped = false;

  constructor(options: DraftStreamOptions) {
    this.throttleMs = options.throttleMs ?? TELEGRAM_FLOOD_LIMIT_MS;
    this.chunkSize = options.chunkSize ?? 3800;
    this.transport = options.transport ?? {
      sendMessage: async () => 0,
      editMessage: async () => {},
      deleteMessage: async () => {},
      sendChatAction: async () => {},
    };
  }

  /** Queue a text update; throttled edit will follow. */
  update(text: string): void {
    if (this.stopped) return;
    this.pendingText = text;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.throttleMs);
    }
  }

  /** Append delta to current draft. */
  updateDelta(delta: string): void {
    this.update(this.pendingText + delta);
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || !this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = "";
    const chunks = splitChunks(text, this.chunkSize);
    try {
      if (this.messageId === undefined) {
        this.messageId = await this.transport.sendMessage(chunks[0] ?? "");
        this.deliveredText = chunks[0] ?? "";
      } else {
        await this.transport.editMessage(this.messageId, chunks[0] ?? "");
        this.deliveredText = chunks[0] ?? "";
      }
      // Extra chunks become separate follow-up messages (openclaw parity).
      for (let i = 1; i < chunks.length; i++) {
        await this.transport.sendMessage(chunks[i]);
      }
      this.failures = 0;
      await this.transport.sendChatAction("typing");
    } catch {
      this.failures++;
      if (this.failures <= MAX_CONSECUTIVE_FAILURES) {
        // Retry on next tick with remaining pending text.
        this.pendingText = text;
        this.timer = setTimeout(() => void this.flush(), this.throttleMs);
      }
    }
  }

  messageId(): number | undefined {
    return this.messageId;
  }

  lastDeliveredText(): string {
    return this.deliveredText;
  }

  /** Final flush + mark stopped. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = true;
    await this.flush();
  }

  async clear(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.messageId !== undefined) {
      try { await this.transport.deleteMessage(this.messageId); } catch { /* ignore */ }
    }
    this.messageId = undefined;
    this.deliveredText = "";
    this.pendingText = "";
    this.stopped = false;
  }
}

/** Per-turn manager: owns one answer DraftStream + reasoning/progress lanes. */
export class DraftStreamManager {
  private answer?: DraftStream;
  private cfg: { throttleMs: number; chunkSize: number };

  constructor(cfg: { throttleMs: number; chunkSize: number }) {
    this.cfg = cfg;
  }

  beginTurn(): void {
    this.answer = undefined;
  }

  bindTransport(transport: DraftTransport): DraftStream {
    this.answer = new DraftStream({ ...this.cfg, transport });
    return this.answer;
  }

  updateAnswer(delta: string): void {
    this.answer?.updateDelta(delta);
  }

  async finalizeAnswer(_event: unknown): Promise<void> {
    await this.answer?.stop();
  }

  async endTurn(): Promise<void> {
    await this.answer?.stop();
  }

  async settle(): Promise<void> {
    // optional: clear transient previews
  }
}
