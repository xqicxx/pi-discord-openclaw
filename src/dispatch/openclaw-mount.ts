// openclaw-mount — 收拢 openclaw-style 可选挂载逻辑。
// 目的：index.ts 保持上游 invariants（无 =>、无 process.env、无本地函数声明），
// 全部 openclaw 逻辑（配置读取、API 适配、桥接挂载）下沉到 src/。
import { isOpenclawStyleEnabled } from "../config.ts";
import {
  mountOpenclawBridge,
  type MountActivityRuntime,
  type MountResult,
} from "./mount.ts";
import { createTelegramMountDeps, type TelegramApiSurface } from "./telegram-api-adapter.ts";

/** index.ts 传入的上游 API 面（sendChatAction 带 action 参数，与 outbound 一致）。 */
export interface OpenclawStyleMountApi {
  sendMessage: TelegramApiSurface["sendMessage"];
  editMessageText: TelegramApiSurface["editMessageText"];
  deleteMessage: TelegramApiSurface["deleteMessage"];
  sendChatAction: (chatId: number, action: string) => Promise<unknown>;
}

/**
 * 仅当 telegram.json 显式启用 openclawStyle.enabled 时挂载 OpenclawBridge。
 * 返回 undefined 表示未启用（保持上游行为）。
 */
export function mountOpenclawStyleIfEnabled(
  activityRuntime: MountActivityRuntime,
  api: OpenclawStyleMountApi,
  getActiveChatId: () => number | undefined | Promise<number | undefined>,
  getProactiveChatId: () => number | undefined | Promise<number | undefined>,
): MountResult | undefined {
  if (!isOpenclawStyleEnabled()) return undefined;
  return mountOpenclawBridge(
    activityRuntime,
    createTelegramMountDeps(
      {
        sendMessage: api.sendMessage,
        editMessageText: api.editMessageText,
        deleteMessage: api.deleteMessage,
        sendChatAction: (chatId: number) => api.sendChatAction(chatId, "typing"),
      },
      async () => (await getActiveChatId()) ?? (await getProactiveChatId()) ?? undefined,
    ),
  );
}
