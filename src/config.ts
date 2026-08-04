// Configuration for OpenClaw-style streaming (Discord edition).
// Mirrors openclaw: streaming.mode / throttleMs / chunking, reasoning style,
// tool progress lanes, inbound debounce. 读取 discord.json（openclawStyle 段）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StreamingMode = "progress" | "partial" | "full";

export interface OpenclawStyleConfig {
  enabled: boolean;
  streaming: {
    mode: StreamingMode;
    throttleMs: number;
    chunkSize: number;
  };
  reasoning: {
    enabled: boolean;
    style: "emoji-italic" | "italic" | "hidden";
  };
  toolProgress: {
    enabled: boolean;
    maxLines: number;
  };
  inbound: {
    debounceMs: number;
  };
}

export const DEFAULTS: OpenclawStyleConfig = {
  enabled: true,
  streaming: { mode: "progress", throttleMs: 1200, chunkSize: 1900 },
  reasoning: { enabled: true, style: "emoji-italic" },
  toolProgress: { enabled: true, maxLines: 8 },
  inbound: { debounceMs: 1000 },
};

/**
 * Load config from discord.json's `openclawStyle` section.
 * Falls back to defaults; tolerant of partial configs.
 */
/** 依次解析 discord.json 候选路径：PI_CODING_AGENT_DIR → ~/.pi/agent → HOME。 */
function resolveDiscordJsonPath(): string {
  const candidates: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR) {
    candidates.push(join(process.env.PI_CODING_AGENT_DIR, "discord.json"));
  }
  candidates.push(join(homedir(), ".pi", "agent", "discord.json"));
  if (process.env.HOME) candidates.push(join(process.env.HOME, "discord.json"));
  return candidates[0];
}

export function loadOpenclawStyleConfig(): OpenclawStyleConfig {
  try {
    const p = resolveDiscordJsonPath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const ocs = raw?.openclawStyle ?? raw?.["openclaw-style"];
      if (ocs) return deepMerge(DEFAULTS, ocs);
    }
  } catch { /* fall through to defaults */ }
  return DEFAULTS;
}

/**
 * 仅当 discord.json 明确配置 openclawStyle.enabled: true 时启用。
 * 入口默认关闭（与上游行为一致），避免 DEFAULTS.enabled 误启用。
 */
export function isOpenclawStyleEnabled(): boolean {
  try {
    const p = resolveDiscordJsonPath();
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return (raw as { openclawStyle?: { enabled?: boolean } }).openclawStyle?.enabled === true;
  } catch {
    return false;
  }
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as object) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge((base as any)?.[k] ?? {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

// ---- Discord 连接配置 ----

export interface DiscordConnectionConfig {
  /** Bot token：环境变量 DISCORD_BOT_TOKEN 或 discord.json 的 token。 */
  token?: string;
  /** 允许处理的 channel id 列表；空数组 = 全部频道。 */
  channels?: string[];
  /** 忽略 bot 自己的消息（默认 true）。 */
  ignoreBots?: boolean;
}

export function loadDiscordConnectionConfig(): DiscordConnectionConfig {
  const envToken = process.env.DISCORD_BOT_TOKEN?.trim();
  try {
    const p = resolveDiscordJsonPath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        token?: string;
        channels?: string[];
        ignoreBots?: boolean;
      };
      return {
        token: envToken || raw.token?.trim(),
        channels: raw.channels,
        ignoreBots: raw.ignoreBots ?? true,
      };
    }
  } catch { /* fall through */ }
  return { token: envToken, channels: undefined, ignoreBots: true };
}
