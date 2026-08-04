// openclaw-mount — 收拢 openclaw-style 可选挂载逻辑。
// 目的：index.ts 保持上游 invariants（无 =>、无 process.env、无本地函数声明），
// 全部 openclaw 逻辑（配置读取、API 适配、桥接挂载）下沉到 src/。
import { isOpenclawStyleEnabled } from "../config.ts";
import {
  mountOpenclawBridge,
  type MountActivityRuntime,
  type MountResult,
} from "./mount.ts";
import { createDiscordMountDeps } from "./discord-api-adapter.ts";
import type { DiscordRest } from "../transport/discord-rest.ts";

/** index.ts 传入的 transport 面（DiscordRest 实例）。 */
export interface OpenclawStyleMountApi {
  rest: DiscordRest;
}

/**
 * 仅当 discord.json 显式启用 openclawStyle.enabled 时挂载 OpenclawBridge。
 * 返回 undefined 表示未启用（保持上游行为）。
 */
export function mountOpenclawStyleIfEnabled(
  activityRuntime: MountActivityRuntime,
  api: OpenclawStyleMountApi,
  getActiveChannelId: () => string | undefined | Promise<string | undefined>,
  getProactiveChannelId: () => string | undefined | Promise<string | undefined>,
): MountResult | undefined {
  if (!isOpenclawStyleEnabled()) return undefined;
  return mountOpenclawBridge(
    activityRuntime,
    createDiscordMountDeps(
      api.rest,
      async () => (await getActiveChannelId()) ?? (await getProactiveChannelId()) ?? undefined,
    ),
  );
}
