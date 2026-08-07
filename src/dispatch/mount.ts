// Mount — 把 OpenclawBridge 最小侵入地挂到 fork 的 activityRuntime 上。
// 解耦：不修改 lib/ 内部，只在 index.ts 调用 mountOpenclawBridge(activityRuntime, deps)。
// 开关：telegram.json 的 openclawStyle.enabled（默认 false，保持上游行为）。

import { OpenclawBridge, type DiscordDelivery } from "./dispatch.ts";
import { loadOpenclawStyleConfig } from "../config.ts";
import { adaptAssistantEvent, type TelegramAssistantStreamEvent } from "./activity-adapter.ts";

/** 挂载所需的最小 delivery 能力（来自 fork 的 replyRuntime/outbound）。 */
export interface MountDeps {
  sendMessage: (text: string) => Promise<string>;
  editMessageText: (messageId: string, text: string, embeds?: unknown[]) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  /** typecheck 修复（issue #115）：与 DiscordDelivery.sendChatAction 签名对齐。 */
  sendChatAction: (chatId: string, action: "typing") => Promise<void>;
}

/** activityRuntime 的最小接口（index.ts 传入）。 */
export interface MountActivityRuntime {
  onAssistantEvent?: (event: TelegramAssistantStreamEvent) => void;
  onToolStart?: (event: { toolCallId: string; toolName: string; args: unknown }) => void;
  onToolUpdate?: (event: { toolCallId: string; toolName: string; update: unknown }) => void;
  onToolEnd?: (event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }) => void;
  onAgentStart?(target?: unknown): void; // 方法语法（bivariant），兼容 TelegramActivityRuntime.onAgentStart
  onAgentEnd?: () => void;
  onAgentSettled?: () => void;
}

export interface MountResult {
  bridge: OpenclawBridge;
  /** 恢复原始 activityRuntime（卸载用）。 */
  unmount: () => void;
}

/**
 * 把 openclaw-style 桥接挂到 activityRuntime 上。
 * 事件流：
 *   onAssistantEvent (text_delta/thinking_delta) → adaptAssistantEvent → bridge.handleActivity
 *   onToolStart/Update/End → bridge.handleActivity (tool-start/update/end)
 *   onAgentStart → bridge.beginTurn
 *   onAgentEnd → bridge.endTurn
 * 返回原始方法引用，便于 unmount。
 */
export function mountOpenclawBridge(
  activityRuntime: MountActivityRuntime,
  deps: MountDeps,
): MountResult | undefined {
  const delivery: DiscordDelivery = {
    sendMessage: (chatId, text) => deps.sendMessage(text),
    editMessage: (chatId, messageId, text, embeds) => deps.editMessageText(messageId, text, embeds),
    deleteMessage: (chatId, messageId) => deps.deleteMessage(messageId),
    sendChatAction: (chatId, action) => deps.sendChatAction(chatId, action),
  };
  const styleConfig = loadOpenclawStyleConfig();
  const bridge = new OpenclawBridge({
    delivery,
    config: {
      streamMode: styleConfig.streaming.mode === "full" ? "progress" : styleConfig.streaming.mode,
      throttleMs: styleConfig.streaming.throttleMs,
      chunkSize: styleConfig.streaming.chunkSize,
      reasoningEnabled: styleConfig.reasoning.enabled,
      toolProgressEnabled: styleConfig.toolProgress.enabled,
      debounceMs: styleConfig.inbound.debounceMs,
      thinkingEnabled: styleConfig.streaming.thinking,
      thinkingMaxChars: styleConfig.streaming.thinkingMaxChars,
      receiptSummary: styleConfig.streaming.receiptSummary,
    },
  });

  const orig = {
    onAssistantEvent: activityRuntime.onAssistantEvent,
    onToolStart: activityRuntime.onToolStart,
    onToolUpdate: activityRuntime.onToolUpdate,
    onToolEnd: activityRuntime.onToolEnd,
    onAgentStart: activityRuntime.onAgentStart,
    onAgentEnd: activityRuntime.onAgentEnd,
    onAgentSettled: activityRuntime.onAgentSettled,
  };

  activityRuntime.onAssistantEvent = (event) => {
    const adapted = adaptAssistantEvent(event);
    if (adapted) bridge.handleActivity(adapted);
    orig.onAssistantEvent?.(event);
  };
  activityRuntime.onToolStart = (event) => {
    bridge.handleActivity({
      type: "tool-start",
      id: event.toolCallId,
      name: event.toolName,
      args: event.args as Record<string, unknown> | undefined,
    });
    orig.onToolStart?.(event);
  };
  activityRuntime.onToolUpdate = (event) => {
    bridge.handleActivity({
      type: "tool-update",
      id: event.toolCallId,
      detail: typeof event.update === "string" ? event.update : undefined,
    });
    orig.onToolUpdate?.(event);
  };
  activityRuntime.onToolEnd = (event) => {
    bridge.handleActivity({
      type: "tool-end",
      id: event.toolCallId,
      ok: !event.isError,
    });
    orig.onToolEnd?.(event);
  };
  activityRuntime.onAgentStart = (target) => {
    // target 可能是 string 或 TelegramActivityTarget({ chatId })
    const chatId =
      typeof target === "string"
        ? target
        : target && typeof target === "object" && "chatId" in target
          ? String((target as { chatId: unknown }).chatId)
          : "default";
    bridge.beginTurn({ chatId });
    orig.onAgentStart?.(target);
  };
  activityRuntime.onAgentEnd = () => {
    void bridge.endTurn();
    orig.onAgentEnd?.();
  };
  activityRuntime.onAgentSettled = () => {
    orig.onAgentSettled?.();
  };

  return {
    bridge,
    unmount: () => {
      activityRuntime.onAssistantEvent = orig.onAssistantEvent;
      activityRuntime.onToolStart = orig.onToolStart;
      activityRuntime.onToolUpdate = orig.onToolUpdate;
      activityRuntime.onToolEnd = orig.onToolEnd;
      activityRuntime.onAgentStart = orig.onAgentStart;
      activityRuntime.onAgentEnd = orig.onAgentEnd;
      activityRuntime.onAgentSettled = orig.onAgentSettled;
    },
  };
}
