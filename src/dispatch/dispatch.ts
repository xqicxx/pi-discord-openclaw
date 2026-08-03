// Dispatch bridge layer — ported from openclaw bot-message-dispatch (笔记 05/08).
// 把 F1-F4 四个 lane 组装成完整 turn 生命周期：
//   agent-start → 创建 turn → 各 lane 开始
//   activity 事件 → 路由到对应 lane
//   agent-end → 收尾（finalize / 清理预览）
//
// 笔记 05 关键机制：
//   1. DispatchContext：chatId / draft / progress / streamMode / isDispatchSuperseded
//   2. transcriptMirrorTurnId：${chatId}:${message_id ?? startedAt}
//   3. 流式模式：progress（默认）/ partial / full
// 笔记 08 关键机制：
//   1. LaneName = "answer" | "reasoning"
//   2. DraftLaneState：stream / lastPartialText / hasStreamedMessage / finalized
//   3. 投递结果：preview-finalized / sent / skipped

import { DraftStream, type DraftTransport } from "../draft/draft-stream.ts";
import { ReasoningLane } from "../reasoning/reasoning-lane.ts";
import { ProgressLane } from "../progress/progress-lane.ts";
import { InboundDebouncer } from "../inbound/debounce.ts";

export type StreamMode = "progress" | "partial" | "full";

export interface OpenclawBridgeConfig {
  streamMode: StreamMode;
  throttleMs: number;
  chunkSize: number;
  reasoningEnabled: boolean;
  toolProgressEnabled: boolean;
  debounceMs: number;
}

export interface TelegramDelivery {
  sendMessage: (text: string) => Promise<number>;
  editMessage: (messageId: number, text: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<void>;
  sendChatAction: (action: "typing") => Promise<void>;
}

/**
 * TurnManager：一个 agent turn 的状态与三个 lane 的编排。
 * 解耦设计：只依赖 lane 的公开接口，不依赖 pi-telegram 内部。
 */
export class TurnManager {
  readonly chatId: string;
  readonly turnId: string;
  readonly startedAt: number;
  private superseded = false;

  readonly answer: DraftStream;
  readonly reasoning: ReasoningLane;
  readonly progress: ProgressLane;

  constructor(params: {
    chatId: string;
    messageId?: number;
    delivery: TelegramDelivery;
    config: OpenclawBridgeConfig;
  }) {
    this.chatId = params.chatId;
    this.startedAt = Date.now();
    // 笔记 05: transcriptMirrorTurnId = ${chatId}:${message_id ?? startedAt}
    this.turnId = `${params.chatId}:${params.messageId ?? this.startedAt}`;

    const transport: DraftTransport = {
      sendMessage: params.delivery.sendMessage,
      editMessage: params.delivery.editMessage,
      deleteMessage: params.delivery.deleteMessage,
      sendChatAction: params.delivery.sendChatAction,
    };

    // 笔记 08: answer lane（主回答流式）
    this.answer = new DraftStream({
      throttleMs: params.config.throttleMs,
      chunkSize: params.config.chunkSize,
      transport,
    });

    // 笔记 02: reasoning lane（🧠 思考）
    this.reasoning = new ReasoningLane(
      { enabled: params.config.reasoningEnabled, style: "emoji-italic" },
      undefined,
    );
    this.reasoning.bindDraft(this.answer);

    // 笔记 03: progress lane（🔧 工具进度）
    this.progress = new ProgressLane(
      { enabled: params.config.toolProgressEnabled, maxLines: 8 },
      this.answer,
    );
  }

  isSuperseded(): boolean {
    return this.superseded;
  }

  supersede(): void {
    this.superseded = true;
  }

  /**
   * 路由 activity 事件到对应 lane（笔记 05: dispatch）。
   * @returns true 表示事件已被消费。
   */
  handleActivity(event: OpenclawActivityEvent): boolean {
    if (this.superseded) return false;
    switch (event.type) {
      case "reasoning-delta":
        this.reasoning.onDelta(event.delta);
        return true;
      case "reasoning-end":
        this.reasoning.finalize();
        return true;
      case "assistant-text-delta":
        this.answer.updateDelta(event.delta);
        return true;
      case "tool-start":
        this.progress.onToolStart({ id: event.id, name: event.name, args: event.args });
        return true;
      case "tool-update":
        this.progress.onToolUpdate({ id: event.id, detail: event.detail });
        return true;
      case "tool-end":
        this.progress.onToolEnd({ id: event.id, ok: event.ok });
        return true;
      default:
        return false;
    }
  }

  /** agent-end：收尾（回答定型 + 清理预览）。 */
  async endTurn(): Promise<void> {
    await this.answer.stop();
    this.progress.endTurn();
    this.reasoning.endTurn();
  }
}

export type OpenclawActivityEvent =
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-end" }
  | { type: "assistant-text-delta"; delta: string }
  | { type: "tool-start"; id?: string; name?: string; args?: Record<string, unknown> }
  | { type: "tool-update"; id?: string; detail?: string }
  | { type: "tool-end"; id?: string; ok?: boolean };

/**
 * OpenclawBridge：Telegram 桥接整合层。
 * - 管理当前 turn（单用户单 turn 模型）
 * - 提供连续输入 debounce
 * - 复用 F1-F4 的 lane 实现（解耦）
 */
export class OpenclawBridge {
  private config: OpenclawBridgeConfig;
  private delivery: TelegramDelivery;
  private turn: TurnManager | undefined;
  private debouncer: InboundDebouncer;

  constructor(params: { delivery: TelegramDelivery; config: OpenclawBridgeConfig }) {
    this.delivery = params.delivery;
    this.config = params.config;
    this.debouncer = new InboundDebouncer({
      debounceMs: params.config.debounceMs,
      onFlush: async (entries) => {
        const text = entries.map((e) => e.text).join("\n");
        await this.onUserInput?.(text);
      },
    });
  }

  /** 用户消息注入回调（由宿主设置：pi / omp）。 */
  onUserInput?: (text: string) => Promise<void>;

  /** 用户发消息 → debounce 合并（笔记 04）。 */
  pushUserMessage(text: string, chatId: string): void {
    this.debouncer.push({
      key: chatId,
      text,
      receivedAtMs: Date.now(),
      lane: "default",
    });
  }

  /** 开始新 turn（agent-start）。 */
  beginTurn(params: { chatId: string; messageId?: number }): TurnManager {
    // 笔记 05: isDispatchSuperseded — 新消息取代旧 turn
    if (this.turn && !this.turn.isSuperseded()) {
      this.turn.supersede();
    }
    this.turn = new TurnManager({
      chatId: params.chatId,
      messageId: params.messageId,
      delivery: this.delivery,
      config: this.config,
    });
    return this.turn;
  }

  currentTurn(): TurnManager | undefined {
    return this.turn;
  }

  /** 事件路由到当前 turn（无 turn 时忽略）。 */
  handleActivity(event: OpenclawActivityEvent): boolean {
    return this.turn?.handleActivity(event) ?? false;
  }

  /** agent-end：收尾当前 turn。 */
  async endTurn(): Promise<void> {
    if (this.turn) {
      await this.turn.endTurn();
      this.turn = undefined;
    }
  }
}
