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
    /** 笔记 18：工具进度行开关（openclaw progress.toolProgress，默认 true）。 */
    toolProgress?: boolean;
    /** 笔记 18：progress 草稿显示原始 assistant 评论（openclaw progress.commentary，默认 false）。 */
    commentary?: boolean;
    /** 笔记 18：每行字符预算（openclaw progress.maxLineChars，默认 120）。 */
    maxLineChars?: number;
    /** 笔记 18：命令文本模式 raw/status（openclaw progress.commandText，默认 raw）。 */
    commandText?: "raw" | "status";
    /** 笔记 19：思维链注入 progress 方块（openclaw progress.thinking，默认 true）。 */
    thinking?: boolean;
    /** 笔记 19：endTurn 折叠摘要（🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns，默认 false）。 */
    receiptSummary?: boolean;
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
  /** 笔记 23：状态表情（openclaw messages.statusReactions）。 */
  statusReactions?: {
    enabled?: boolean;
    /** 完成/错误后是否移除全部表情（openclaw removeAckAfterReply，默认 true）。 */
    removeAckAfterReply?: boolean;
    /** 表情覆盖（按分类，openclaw statusReactions.emojis）。 */
    emojis?: Partial<Record<"queued" | "thinking" | "tool" | "coding" | "web" | "deploy" | "build" | "concierge" | "done" | "error" | "stallSoft" | "stallHard" | "compacting", string>>;
    /** 时序覆盖（openclaw statusReactions.timing）。 */
    timing?: Partial<Record<"debounceMs" | "stallSoftMs" | "stallHardMs" | "doneHoldMs" | "errorHoldMs", number>>;
  };
  /** 笔记 27：turn 级 watchdog——连续无活动超时（ms），默认 90s。 */
  turnWatchdogMs?: number;
}

export const DEFAULTS: OpenclawStyleConfig = {
  enabled: true,
  streaming: {
    mode: "progress",
    throttleMs: 1200,
    chunkSize: 1900,
    toolProgress: true,
    commentary: false,
    maxLineChars: 120,
    commandText: "raw",
    thinking: true,
    receiptSummary: false,
  },
  reasoning: { enabled: true, style: "emoji-italic" },
  toolProgress: { enabled: true, maxLines: 8 },
  // 笔记 25 性能：debounce 250ms（单人使用合并收益小，延迟收益大——消息秒进 agent）
  inbound: { debounceMs: 250 },
  statusReactions: { enabled: true, removeAckAfterReply: true },
  // 笔记 27：默认 90s 无活动即 abort（防止长 sleep 轮询卡死 turn）
  turnWatchdogMs: 90000,
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
