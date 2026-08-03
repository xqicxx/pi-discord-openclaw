/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */

import { randomUUID } from "node:crypto";

import type {
  TelegramInlineKeyboardButtonStyle,
  TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import {
  parseTelegramActionPayload,
  parseTopLevelTelegramComment,
  replaceTopLevelHtmlComments,
} from "./outbound-markup.ts";
import {
  type PendingTelegramTurn,
  type TelegramQueueTarget,
  truncateTelegramQueueSummary,
} from "./queue.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
  selectedStyle?: TelegramInlineKeyboardButtonStyle;
}

export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
  createdAt: number;
}

export type TelegramOutboundButtonMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramButtonReplyPlan {
  markdown: string;
  replyMarkup?: TelegramOutboundButtonMarkup;
}

export interface TelegramButtonActionStore {
  register: (action: TelegramOutboundButtonAction) => string;
  resolve: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
}

export interface TelegramButtonCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number };
    reply_markup?: TelegramOutboundButtonMarkup;
  };
}

export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
  resolveAction: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  enqueueButtonPrompt: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => boolean | void;
  editMessageReplyMarkup?: (
    chatId: number,
    messageId: number,
    replyMarkup: TelegramOutboundButtonMarkup,
  ) => Promise<void>;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function getTelegramButtonString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTelegramButtonAction(
  payload: Record<string, unknown>,
): TelegramOutboundButtonAction | undefined {
  const value = getTelegramButtonString(payload, "value");
  const label = getTelegramButtonString(payload, "label") ?? value;
  const prompt = getTelegramButtonString(payload, "prompt") ?? value;
  if (!label || !prompt) return undefined;
  const selectedStyle = payload.selected_style;
  return {
    text: label,
    prompt,
    ...(selectedStyle === "success" ||
    selectedStyle === "danger" ||
    selectedStyle === "primary"
      ? { selectedStyle }
      : {}),
  };
}

export function createTelegramButtonActionStore(
  options: { ttlMs?: number } = {},
): TelegramButtonActionStore {
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  const actions = new Map<string, TelegramOutboundButtonStoredAction>();
  const cleanup = (currentTime: number): void => {
    for (const [key, action] of actions) {
      if (currentTime - action.createdAt > ttlMs) actions.delete(key);
    }
  };
  return {
    register: (action) => {
      const currentTime = nowMs();
      cleanup(currentTime);
      const key = `${TELEGRAM_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`;
      actions.set(key, { ...action, createdAt: currentTime });
      return key;
    },
    resolve: (callbackData) => {
      if (!callbackData?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
        return undefined;
      }
      const currentTime = nowMs();
      cleanup(currentTime);
      const action = actions.get(callbackData);
      if (!action) return undefined;
      actions.delete(callbackData);
      return {
        text: action.text,
        prompt: action.prompt,
        ...(action.selectedStyle
          ? { selectedStyle: action.selectedStyle }
          : {}),
      };
    },
  };
}

const DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN =
  "☑️ **Choose an option:**";

export function planTelegramButtonReply(
  markdown: string,
  deps: { registerAction: (action: TelegramOutboundButtonAction) => string },
): TelegramButtonReplyPlan {
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = parseTopLevelTelegramComment(comment, "telegram_button");
    if (!command) return comment.raw;
    const payload = parseTelegramActionPayload(comment, "telegram_button");
    const action = payload ? parseTelegramButtonAction(payload) : undefined;
    if (action) {
      keyboard.push([
        {
          text: action.text,
          callback_data: deps.registerAction(action),
        },
      ]);
    }
    return "";
  });
  const visibleMarkdown = normalizeMarkdownAfterButtonExtraction(stripped);
  return {
    markdown:
      keyboard.length > 0 && !visibleMarkdown
        ? DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN
        : visibleMarkdown,
    ...(keyboard.length > 0
      ? { replyMarkup: { inline_keyboard: keyboard } }
      : {}),
  };
}

export function createTelegramButtonReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (markdown: string) => TelegramButtonReplyPlan {
  return (markdown) =>
    planTelegramButtonReply(markdown, { registerAction: store.register });
}

export function createTelegramButtonPromptTurn(options: {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  action: TelegramOutboundButtonAction;
  target?: TelegramQueueTarget;
}): PendingTelegramTurn {
  const prompt = `[telegram] ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    ...(options.target ? { target: options.target } : {}),
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "priority",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
}

export function markTelegramButtonSelected(
  replyMarkup: TelegramOutboundButtonMarkup,
  callbackData: string,
  selectedStyle: TelegramInlineKeyboardButtonStyle = "primary",
): TelegramOutboundButtonMarkup | undefined {
  let matched = false;
  const inlineKeyboard = replyMarkup.inline_keyboard.map((row) =>
    row.map((button) => {
      if (button.callback_data !== callbackData) return { ...button };
      matched = true;
      return { ...button, style: selectedStyle };
    }),
  );
  return matched ? { inline_keyboard: inlineKeyboard } : undefined;
}

export async function handleTelegramButtonCallbackQuery<TContext = unknown>(
  query: TelegramButtonCallbackQuery,
  ctx: TContext,
  deps: TelegramButtonCallbackHandlerDeps<TContext>,
): Promise<boolean> {
  const action = deps.resolveAction(query.data);

  if (!action) {
    if (query.data?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
      await deps.answerCallbackQuery(query.id, "Button action expired.");
      return true;
    }
    return false;
  }

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action expired.");
    return true;
  }

  const enqueued = deps.enqueueButtonPrompt(query, action, ctx);
  if (enqueued === false) {
    await deps.answerCallbackQuery(query.id, "Already queued.");
    return true;
  }
  const selectedMarkup =
    query.data && query.message?.reply_markup
      ? markTelegramButtonSelected(
          query.message.reply_markup,
          query.data,
          action.selectedStyle,
        )
      : undefined;
  if (selectedMarkup && deps.editMessageReplyMarkup) {
    await deps.editMessageReplyMarkup(chatId, messageId, selectedMarkup);
  }
  await deps.answerCallbackQuery(query.id, "Queued.");
  return true;
}
