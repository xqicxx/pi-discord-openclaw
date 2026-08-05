// Discord API adapter — 把 transport 层（DiscordRest）适配成 mount 需要的
// MountDeps（签名：Discord 用 channel_id + snowflake messageId，无 chat_id）。
// 解耦：index.ts 只传 DiscordRest + getChannelId，不关心内部适配。

import type { DiscordRest } from "../transport/discord-rest.ts";
import type { MountDeps } from "./mount.ts";
import { convertMarkdownTableToEmbed } from "./markdown-tables.ts";

/** 把 DiscordRest + channelId 解析器适配成 MountDeps。 */
export function createDiscordMountDeps(
  rest: DiscordRest,
  getChannelId: () => string | undefined | Promise<string | undefined>,
): MountDeps {
  const resolveChannelId = async (): Promise<string> => {
    const id = await getChannelId();
    if (!id) {
      throw new Error("openclaw-style: no channelId available");
    }
    return id;
  };

  return {
    sendMessage: async (text) => {
      const channelId = await resolveChannelId();
      const embeds = convertMarkdownTableToEmbed(text);
      const sent = await rest.createChannelMessage(channelId, { content: text, embeds });
      if (!sent.id) {
        throw new Error("discord sendMessage: no message id in response");
      }
      return sent.id;
    },
    editMessageText: async (messageId, text) => {
      const channelId = await resolveChannelId();
      await rest.editChannelMessage(channelId, messageId, text);
    },
    deleteMessage: async (messageId) => {
      const channelId = await resolveChannelId();
      await rest.deleteChannelMessage(channelId, messageId);
    },
    sendChatAction: async () => {
      const channelId = await resolveChannelId();
      await rest.sendChannelTyping(channelId);
    },
  };
}
