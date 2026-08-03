// Telegram API adapter — 把 fork 上游的 TelegramBridgeApiRuntime 适配成
// mount 需要的 MountDeps（签名不同：上游带 chatId/body，mount 只需 text/messageId）。
// 解耦：index.ts 只传上游 API + getChatId，不关心内部适配。

import type { MountDeps } from "./mount.js";

/** 上游 API 的最小面（index.ts 传入）。 */
export interface TelegramApiSurface {
  sendMessage: (body: {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
  }) => Promise<{ message_id: number }>;
  editMessageText: (body: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
  }) => Promise<unknown>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
  sendChatAction: (chatId: number) => Promise<unknown>;
}

/**
 * 把上游 API + chatId 解析器适配成 MountDeps。
 * 每次调用动态取 chatId（activeTurnRuntime / proactivePushChatIdGetter）。
 */
export function createTelegramMountDeps(
  api: TelegramApiSurface,
  getChatId: () => number | undefined | Promise<number | undefined>,
): MountDeps {
  const resolveChatId = async (): Promise<number> => {
    const id = await getChatId();
    if (id === undefined) {
      throw new Error("openclaw-style: no chatId available");
    }
    return id;
  };

  return {
    sendMessage: async (text) => {
      const chatId = await resolveChatId();
      const sent = await api.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
      return sent.message_id;
    },
    editMessageText: async (messageId, text) => {
      const chatId = await resolveChatId();
      await api.editMessageText({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
    },
    deleteMessage: async (messageId) => {
      const chatId = await resolveChatId();
      await api.deleteMessage(chatId, messageId);
    },
    sendChatAction: async () => {
      const chatId = await resolveChatId();
      await api.sendChatAction(chatId);
    },
  };
}
