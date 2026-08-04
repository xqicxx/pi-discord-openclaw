// Configuration for OpenClaw-style streaming.
// Mirrors openclaw: streaming.mode / throttleMs / chunking, reasoning style,
// tool progress lanes, inbound debounce.

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
  streaming: { mode: "progress", throttleMs: 1000, chunkSize: 3800 },
  reasoning: { enabled: true, style: "emoji-italic" },
  toolProgress: { enabled: true, maxLines: 8 },
  inbound: { debounceMs: 1000 },
};

/**
 * Load config from telegram.json's `openclawStyle` section (per profile).
 * Falls back to defaults; tolerant of partial configs.
 */
/** 依次解析 telegram.json 候选路径：PI_CODING_AGENT_DIR → ~/.pi/agent → HOME。 */
function resolveTelegramJsonPath(): string {
  const os = require("node:os");
  const path = require("node:path");
  const candidates: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR) {
    candidates.push(path.join(process.env.PI_CODING_AGENT_DIR, "telegram.json"));
  }
  candidates.push(path.join(os.homedir(), ".pi", "agent", "telegram.json"));
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, "telegram.json"));
  return candidates[0];
}

export function loadOpenclawStyleConfig(): OpenclawStyleConfig {
  try {
    const fs = require("node:fs");
    const p = resolveTelegramJsonPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const ocs = raw?.openclawStyle ?? raw?.["openclaw-style"];
      if (ocs) return deepMerge(DEFAULTS, ocs);
    }
  } catch { /* fall through to defaults */ }
  return DEFAULTS;
}

/**
 * 仅当 telegram.json 明确配置 openclawStyle.enabled: true 时启用。
 * fork 入口默认关闭（与上游行为一致），避免 DEFAULTS.enabled 误启用。
 */
export function isOpenclawStyleEnabled(): boolean {
  try {
    const fs = require("node:fs");
    const p = resolveTelegramJsonPath();
    if (!fs.existsSync(p)) return false;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
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
