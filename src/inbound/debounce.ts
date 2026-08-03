// Inbound debouncer — ported from openclaw bot-handlers.inbound-debounce.runtime.ts (笔记 04).
// 连续输入合并：短时间内的多条消息 debounce 成一批，避免打断 agent、减少无意义 turn。
//
// 笔记 04 要点：
//   1. 双 lane：default（普通文本 1000ms）/ forward（转发突发 80ms）
//   2. onFlush：单条直接处理；多条合并文本（\n 连接）+ 合并媒体
//   3. 空内容+无媒体 → skipped
//   4. 忙时排队：agent 忙时 follow-up 注入（KeyedAsyncQueue 串行）

const DEFAULT_DEBOUNCE_MS = 1000;
const FORWARD_BURST_DEBOUNCE_MS = 80;

export type InboundDebounceLane = "default" | "forward";

export interface InboundDebounceEntry {
  /** 合并键（如 chatId），同键消息合并。 */
  key: string;
  text: string;
  receivedAtMs: number;
  lane: InboundDebounceLane;
}

export interface InboundDebouncerOptions {
  /** 默认 debounce 窗口（ms）。 */
  debounceMs?: number;
  /** forward lane 窗口（ms）。 */
  forwardDebounceMs?: number;
  /** 合并批处理回调。 */
  onFlush: (entries: InboundDebounceEntry[]) => Promise<void>;
}

/**
 * InboundDebouncer：按键分组的 debounce 合并器。
 * - push(entry)：进入窗口，窗口到期后 flush
 * - 窗口内同 key 消息合并（文本 \n 连接）
 * - serializeImmediate：flush 串行执行（防并发）
 */
export class InboundDebouncer {
  private debounceMs: number;
  private forwardDebounceMs: number;
  private onFlush: (entries: InboundDebounceEntry[]) => Promise<void>;
  private pending = new Map<string, InboundDebounceEntry[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushing = false;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(options: InboundDebouncerOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.forwardDebounceMs = options.forwardDebounceMs ?? FORWARD_BURST_DEBOUNCE_MS;
    this.onFlush = options.onFlush;
  }

  /** 进入 debounce 窗口。 */
  push(entry: InboundDebounceEntry): void {
    const existing = this.pending.get(entry.key);
    if (existing) {
      existing.push(entry);
    } else {
      this.pending.set(entry.key, [entry]);
    }
    this.resetTimer(entry);
  }

  /** 立即 flush 所有 pending。 */
  async flushNow(): Promise<void> {
    for (const key of [...this.timers.keys()]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
    const entries = [...this.pending.values()];
    this.pending.clear();
    await this.dispatch(entries);
  }

  private resetTimer(entry: InboundDebounceEntry): void {
    const existing = this.timers.get(entry.key);
    if (existing) clearTimeout(existing);
    const windowMs =
      entry.lane === "forward" ? this.forwardDebounceMs : this.debounceMs;
    const timer = setTimeout(() => void this.fire(entry.key), windowMs);
    this.timers.set(entry.key, timer);
  }

  private async fire(key: string): Promise<void> {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const entries = this.pending.get(key);
    this.pending.delete(key);
    if (entries && entries.length > 0) {
      await this.dispatch([entries]);
    }
  }

  /** 串行 dispatch（serializeImmediate）。 */
  private dispatch(batches: InboundDebounceEntry[][]): Promise<void> {
    this.flushQueue = this.flushQueue.then(async () => {
      for (const batch of batches) {
        // 笔记 04: 空内容+无媒体 → skipped
        const combined = this.combine(batch);
        if (combined.text.trim() === "") continue;
        await this.onFlush([combined]);
      }
    });
    return this.flushQueue;
  }

  /** 笔记 04: 多条合并（文本 \n 连接；媒体合并由调用方处理）。 */
  private combine(entries: InboundDebounceEntry[]): InboundDebounceEntry {
    const last = entries[entries.length - 1];
    const text = entries.map((e) => e.text).filter(Boolean).join("\n");
    return {
      key: last.key,
      text,
      receivedAtMs: last.receivedAtMs,
      lane: last.lane,
    };
  }

  /** 是否有 pending 消息。 */
  hasPending(key?: string): boolean {
    return key === undefined ? this.pending.size > 0 : this.pending.has(key);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
