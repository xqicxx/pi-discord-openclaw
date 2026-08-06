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
  /** 笔记 30：思维行字符预算（openclaw progress.maxLineChars，默认 120，越小越清爽）。
   *  笔记 31：已独立为 thinkingMaxChars（默认 120）；保留 maxLineChars 兼容旧配置。 */
  maxLineChars?: number;
  /** 笔记 31：思维行字符预算（openclaw progress.maxLineChars 默认 120；独立于 maxLineChars）。 */
  thinkingMaxChars?: number;
  /** 笔记 30：progress 方块最大行数（思考+工具，默认 8，越小越紧凑）。 */
  maxProgressLines?: number;
  /** 笔记 24：最终回答投递前格式化钩子（convertMarkdownTables + stripInlineDirectiveTags）。
   *  可返回 {content, embeds} 以支持 Discord Embed 表格投递（issue 59）。 */
  formatAnswerText?: (text: string) => string | { content: string; embeds?: unknown[] };
  /** 笔记 27/30：turn 级 watchdog——连续无活动超时（ms）。
   *  第一次超时发「还在处理」软提示（不 abort）；再等 5 分钟仍无活动才暂停。
   *  对齐 openclaw：stall 表情分级提示（10s ⏳ → 30s ⚠️），abort 是最后手段。 */
  turnWatchdogMs?: number;
  /** 连续工具超时阈值（默认 3 次），超过则强制 abort turn。 */
  maxToolTimeouts?: number;
  /** 笔记 30：投递/桥层错误通知（宿主发到 discord，避免静默）。 */
  onDeliveryFailed?: (error: unknown, context: string) => void;
  /** 笔记 36：上下文使用率阈值（0-1），超过时触发 onContextHighUsage 提醒。 */
  contextHighUsageThreshold?: number;
  /** 笔记 36：上下文使用率过高时降低 thinking 级别（减小 TTFT）。 */
  setThinkingLevel?: (level: "low" | "high") => void;
  /** 笔记 36：上下文使用率过高回调（宿主可提示用户 /compact）。 */
  onContextHighUsage?: (usageText: string) => void;
}

export interface DiscordDelivery {
  sendMessage: (chatId: string, text: string) => Promise<string>;
  /** issue 59：编辑透传 embeds。 */
  editMessage: (chatId: string, messageId: string, text: string, embeds?: unknown[]) => Promise<void>;
  deleteMessage: (chatId: string, messageId: string) => Promise<void>;
  sendChatAction: (chatId: string, action: "typing") => Promise<void>;
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
      sendMessage: (text) => params.delivery.sendMessage(params.chatId, text),
      editMessage: (messageId, text, embeds) => params.delivery.editMessage(params.chatId, messageId, text, embeds),
      deleteMessage: (messageId) => params.delivery.deleteMessage(params.chatId, messageId),
      sendChatAction: (action) => params.delivery.sendChatAction(params.chatId, action),
    };

    // 笔记 08: answer lane（主回答流式）
    this.answer = new DraftStream({
      throttleMs: params.config.throttleMs,
      chunkSize: params.config.chunkSize,
      transport,
      // 笔记 24: 最终回答投递前格式化（表格 → ASCII 代码块 + 指令标签剥离）
      formatText: params.config.formatAnswerText,
      // 笔记 30：投递失败通知宿主（不再静默）
      onDeliveryFailed: (error, ctx) => params.config.onDeliveryFailed?.(error, ctx),
    });

    // 笔记 19: progress 方块（思维链 + 工具进度同一条消息）
    this.progressDraft = new DraftStream({
      throttleMs: params.config.throttleMs,
      chunkSize: params.config.chunkSize,
      transport,
      onDeliveryFailed: (error, ctx) => params.config.onDeliveryFailed?.(error, ctx),
    });

    // 笔记 03: progress lane（🔧 工具进度 + 🧠 思维链）
    this.progress = new ProgressLane(
      {
        enabled: params.config.toolProgressEnabled,
        maxLines: params.config.maxProgressLines ?? 8,
        thinking: params.config.thinkingEnabled ?? true,
        receipt: params.config.receiptSummary ?? false,
        thinkingMaxChars: params.config.thinkingMaxChars ?? 60,
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
      case "tool-timeout":
        // 工具超时事件：由桥层处理连续超时检测
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
  | { type: "tool-end"; id?: string; ok?: boolean }
  | { type: "tool-timeout"; id?: string; name?: string };

/**
 * OpenclawBridge：Discord 桥接整合层。
 * - 管理当前 turn（单用户单 turn 模型）
 * - 提供连续输入 debounce
 * - 复用 lane 实现（解耦）
 * - 笔记 27：turn 级 watchdog——连续无活动超时 abort
 * - 连续工具超时检测：超过阈值强制 abort turn
 */
export class OpenclawBridge {
  private config: OpenclawBridgeConfig;
  private delivery: DiscordDelivery;
  private turn: TurnManager | undefined;
  private debouncer: InboundDebouncer;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAt = 0;
  private consecutiveToolTimeouts = 0;
  /** 笔记 30：是否已发过「还在处理」软提示（第二次超时才 abort）。 */
  private stallWarned = false;
  /** 笔记 30：turn 活跃时收到的新消息排队（对齐 openclaw 默认 steer/followup，
   *  不中断当前 agent；turn 结束后自动处理）。 */
  private pendingInputs: string[] = [];
  private pendingChatId: string | undefined;

  constructor(params: { delivery: DiscordDelivery; config: OpenclawBridgeConfig }) {
    this.delivery = params.delivery;
    this.config = params.config;
    this.debouncer = new InboundDebouncer({
      debounceMs: params.config.debounceMs,
      onFlush: async (entries) => {
        const text = entries.map((e) => e.text).join("\n");
        // 笔记 30：对齐 openclaw 默认队列语义（steer/followup）——
        // turn 活跃时新消息不中断 agent，排队等当前 turn 结束再处理；
        // 卡死兜底仍由 watchdog（90s 无活动 abort）保证「bot 不没动静」。
        if (this.turn && !this.turn.isSuperseded()) {
          this.pendingInputs.push(text);
          this.pendingChatId = entries[0]?.key ?? this.pendingChatId;
          // 笔记 30：通知宿主「这条在排队」（👀=queued 语义的可见化）
          try {
            await this.onQueued?.(entries[0]?.key ?? "");
          } catch {
            // 忽略通知失败
          }
          return;
        }
        await this.onUserInput?.(text);
      },
    });
  }

  /** 用户消息注入回调（由宿主设置：pi / omp）。 */
  onUserInput?: (text: string) => Promise<void>;
  /** 笔记 30：消息排队通知（turn 活跃时收到新消息）。宿主可提示「排队中」。 */
  onQueued?: (chatId: string) => void | Promise<void>;
  /** 宿主中断回调（笔记 28）：abortTurn/abortCurrentTurn 时真正中断 agent（pi ctx.abort()），
   *  否则只清 bridge 状态，agent 还在跑（「超时但没停止」）。 */
  onAbort?: () => void;
  /** 宿主「新消息中断」回调（笔记 29）：turn 活跃时收到新用户消息 → 中断当前 agent
   *  再处理新消息（对齐 openclaw run-now 默认，避免 followUp 排队等旧任务卡死）。 */
  onInterrupt?: () => void;
  /** 笔记 36：上下文使用率检查回调（宿主注入，返回使用率文本或 null）。 */
  getContextUsageText?: () => string | null;
  /** 笔记 37：设置思考级别回调（宿主注入，用于降低 thinking level 减小 TTFT）。 */
  setThinkingLevel?: (level: string) => void;

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
    // 笔记 36：上下文使用率过高提醒（>70% 时提示用户 /compact，避免膨胀导致延迟）
    this.checkContextUsage();
    // 笔记 37：上下文接近阈值时自动降低思考级别（减小 TTFT）
    this.autoLowerThinking();
    // 笔记 05: isDispatchSuperseded — 新消息取代旧 turn
    if (this.turn && !this.turn.isSuperseded()) {
      this.turn.supersede();
      // 笔记 30：agent 异常中断（agent_end 不触发，如重启/内部错误）时，
      // 旧 turn 的 progress 方块会永久残留——这里兜底清理。
      // 正常路径下旧 turn 已 endTurn（turn 已置 undefined），不会重复执行。
      void this.turn.endTurn().catch(() => {});
    }
    this.turn = new TurnManager({
      chatId: params.chatId,
      messageId: params.messageId,
      delivery: this.delivery,
      config: this.config,
    });
    this.lastActivityAt = Date.now();
    this.consecutiveToolTimeouts = 0;
    this.stallWarned = false;
    this.startWatchdog();
    return this.turn;
  }

  currentTurn(): TurnManager | undefined {
    return this.turn;
  }

  /** 事件路由到当前 turn（无 turn 时忽略）。 */
  handleActivity(event: OpenclawActivityEvent): boolean {
    if (event.type === "tool-timeout") {
      return this.onToolTimeout(event);
    }
    const consumed = this.turn?.handleActivity(event) ?? false;
    if (consumed) {
      this.lastActivityAt = Date.now();
      this.startWatchdog();
    }
    return consumed;
  }

  /** agent-end：收尾当前 turn，随后处理排队的新消息（笔记 30）。 */
  async endTurn(): Promise<void> {
    this.clearWatchdog();
    if (this.turn) {
      await this.turn.endTurn();
      this.turn = undefined;
    }
    await this.drainPending();
  }

  /** 笔记 36：检查上下文使用率，超过阈值时触发提醒。 */
  private checkContextUsage(): void {
    const threshold = this.config.contextHighUsageThreshold ?? 0.7;
    if (threshold <= 0 || !this.config.onContextHighUsage) return;
    const usageText = this.getContextUsageText?.();
    if (!usageText) return;
    // 解析使用率百分比（如 "75%" 或 "75% (98K/131K)"）
    const match = usageText.match(/(\d+)%/);
    if (!match) return;
    const pct = parseInt(match[1], 10);
    if (pct >= threshold * 100) {
      this.config.setThinkingLevel?.("low");
      this.config.onContextHighUsage?.(usageText);
    }
  }

  /** 笔记 37：上下文接近阈值时自动降低思考级别（减小 TTFT）。 */
  private autoLowerThinking(): void {
    const threshold = this.config.contextHighUsageThreshold ?? 0.7;
    if (threshold <= 0 || !this.config.setThinkingLevel) return;
    const usageText = this.getContextUsageText?.();
    if (!usageText) return;
    const match = usageText.match(/(\d+)%/);
    if (!match) return;
    const pct = parseInt(match[1], 10);
    // 上下文 >80% 时强制降为 low（若当前高于 low）
    if (pct >= 80) {
      this.config.setThinkingLevel("low");
    }
  }

  /** 笔记 30：turn 结束后把排队消息合并提交给 agent。 */
  private async drainPending(): Promise<void> {
    if (this.pendingInputs.length === 0) return;
    const texts = this.pendingInputs.splice(0);
    this.pendingChatId = undefined;
    await this.onUserInput?.(texts.join("\n"));
  }

  /** 笔记 27：turn 级 watchdog——连续无活动超时 abort。 */
  private startWatchdog(): void {
    this.clearWatchdog();
    const timeoutMs = this.config.turnWatchdogMs ?? 90000;
    if (timeoutMs <= 0) return;
    this.watchdogTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= timeoutMs && this.turn && !this.turn.isSuperseded()) {
        if (!this.stallWarned) {
          // 笔记 30：第一次超时只重置计时（对齐 openclaw：卡住提示靠 ⏳⚠️ 表情，
          // 不打扰文字；给 agent 一次恢复机会）。再超时仍未恢复 → 停止。
          this.stallWarned = true;
          this.lastActivityAt = Date.now();
          this.startWatchdog();
        } else {
          // 第二次超时（仍无活动）→ 停止：清表情（onAbort）+ 极简提示
          void this.abortTurn("⏸️ 已停止（长时间无响应）");
        }
      }
    }, timeoutMs + 1000);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /** 笔记 27：abort 当前 turn——清理状态 + 回复提示。 */
  private async abortTurn(reason: string): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.clearWatchdog();
    this.turn = undefined;
    // 笔记 28：真正中断 agent（宿主注入 ctx.abort()），否则任务还在后台跑
    try {
      this.onAbort?.();
    } catch {
      // 忽略中断失败
    }
    try {
      await this.delivery.sendMessage(turn.chatId, reason);
    } catch {
      // 忽略发送失败
    }
    // 清理 draft 状态（防止残留预览）
    try {
      await turn.endTurn();
    } catch {
      // 忽略清理失败
    }
    // 笔记 30：abort 后仍处理排队的新消息（用户意图不丢）
    await this.drainPending();
  }

  /** 笔记 28：用户显式中止（stop/暂停 等触发词）——中断当前 turn 并清理。 */
  async abortCurrentTurn(reason = "已中止当前任务。"): Promise<void> {
    if (!this.turn && this.debouncer) {
      // 无活动 turn 时仍走 abort（笔记 30：onAbort 清表情 + 中断 agent，命令层负责回复确认）
      try {
        this.onAbort?.();
      } catch {
        // 忽略
      }
      return;
    }
    await this.abortTurn(reason);
  }

  /** 连续工具超时检测：超过阈值强制 abort turn。 */
  private onToolTimeout(event: Extract<OpenclawActivityEvent, { type: "tool-timeout" }>): boolean {
    if (!this.turn || this.turn.isSuperseded()) return false;
    this.consecutiveToolTimeouts++;
    const max = this.config.maxToolTimeouts ?? 3;
    if (this.consecutiveToolTimeouts >= max) {
      const toolName = event.name ? `（${event.name}）` : "";
      void this.abortTurn(`工具连续超时 ${max} 次${toolName}，已中止任务，请重试或简化请求。`);
      return true;
    }
    // 未达阈值，重置 watchdog 并继续
    this.lastActivityAt = Date.now();
    this.startWatchdog();
    return true;
  }
}
