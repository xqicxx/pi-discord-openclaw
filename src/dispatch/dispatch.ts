// Dispatch bridge layer — ported from openclaw bot-message-dispatch (笔记 05/08/18/19).
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
// 笔记 19 修正：
//   1. reasoning **不再独立消息**（删除 reasoningDraft），思维链注入 progress 方块（🧠 _斜体_ 行原地流动）
//   2. 工具行到达 commit 思维行，下一段思考另起一行（openclaw pushReasoningProgress 语义）
//   3. 最终回答走 answer lane，progress 方块负责 思维链 + 工具进度

import { DraftStream, type DraftTransport } from "../draft/draft-stream.ts";
import { ReasoningLane } from "../reasoning/reasoning-lane.ts";
import { ProgressLane } from "../progress/progress-lane.ts";
import { InboundDebouncer } from "../inbound/debounce.ts";

export type StreamMode = "off" | "partial" | "block" | "progress"; // 对齐 openclaw

export interface OpenclawBridgeConfig {
  streamMode: StreamMode;
  throttleMs: number;
  chunkSize: number;
  reasoningEnabled: boolean;
  toolProgressEnabled: boolean;
  debounceMs: number;
  /** 笔记 18：progress 模式显示工具行（默认 true）。 */
  toolProgressLines?: boolean;
  /** 笔记 19：思维链注入 progress 方块开关（openclaw progress.thinking，默认 true）。 */
  thinkingEnabled?: boolean;
  /** 笔记 19：endTurn 折叠摘要（🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns，默认 false）。 */
  receiptSummary?: boolean;
}

export interface DiscordDelivery {
  sendMessage: (text: string) => Promise<string>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  sendChatAction: (action: "typing") => Promise<void>;
}

/**
 * TurnManager：一个 agent turn 的状态与 lane 的编排。
 * 笔记 19：两条消息——answer（最终回答）+ progress 方块（思维链 🧠 + 工具行 🛠️ 同一条）。
 */
export class TurnManager {
  readonly chatId: string;
  readonly turnId: string;
  readonly startedAt: number;
  private superseded = false;

  readonly answer: DraftStream;
  /** 笔记 19：progress 方块（思维链 + 工具进度同一条消息）。 */
  readonly progressDraft: DraftStream;
  readonly reasoning: ReasoningLane;
  readonly progress: ProgressLane;

  constructor(params: {
    chatId: string;
    messageId?: string;
    delivery: DiscordDelivery;
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

    // 笔记 19: progress 方块（思维链 + 工具进度同一条消息）
    this.progressDraft = new DraftStream({
      throttleMs: params.config.throttleMs,
      chunkSize: params.config.chunkSize,
      transport,
    });

    // 笔记 03: progress lane（🔧 工具进度 + 🧠 思维链）
    this.progress = new ProgressLane(
      {
        enabled: params.config.toolProgressEnabled,
        maxLines: 8,
        thinking: params.config.thinkingEnabled ?? true,
        receipt: params.config.receiptSummary ?? false,
      },
      this.progressDraft,
    );

    // 笔记 02/19: reasoning lane（🧠 思维链注入 progress 方块，不再独立消息）
    this.reasoning = new ReasoningLane(
      { enabled: params.config.reasoningEnabled, style: "emoji-italic" },
      this.progress,
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
    // 笔记 19：answer 定型 + progress 方块收尾（reasoning 已并入 progress）
    await this.answer.stop();
    await this.progressDraft.stop();
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
 * OpenclawBridge：Discord 桥接整合层。
 * - 管理当前 turn（单用户单 turn 模型）
 * - 提供连续输入 debounce
 * - 复用 lane 实现（解耦）
 */
export class OpenclawBridge {
  private config: OpenclawBridgeConfig;
  private delivery: DiscordDelivery;
  private turn: TurnManager | undefined;
  private debouncer: InboundDebouncer;

  constructor(params: { delivery: DiscordDelivery; config: OpenclawBridgeConfig }) {
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
  beginTurn(params: { chatId: string; messageId?: string }): TurnManager {
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
