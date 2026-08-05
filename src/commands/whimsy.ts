// Whimsy bridge — 笔记 26：/whimsy 本地实现。
// 原命令（pi-agent-extensions/whimsical）交互调权重需 TUI；on/off/status/reset 是纯状态操作，
// 状态存 ~/.pi/agent/settings.json 的 whimsical 字段（与扩展同一格式，双向兼容）。
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SETTINGS_PATH = () => path.join(homedir(), ".pi", "agent", "settings.json");

interface WhimsyState {
  enabled: boolean;
  spinnerPreset?: string;
}

async function loadState(settingsPath: string): Promise<WhimsyState> {
  try {
    const text = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(text) as { whimsical?: Partial<WhimsyState> };
    return {
      enabled: typeof parsed.whimsical?.enabled === "boolean" ? parsed.whimsical.enabled : true,
      spinnerPreset: parsed.whimsical?.spinnerPreset,
    };
  } catch {
    return { enabled: true };
  }
}

async function saveState(settingsPath: string, state: WhimsyState): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await readFile(settingsPath, "utf-8");
    parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  parsed.whimsical = {
    enabled: state.enabled,
    ...(state.spinnerPreset ? { spinnerPreset: state.spinnerPreset } : {}),
  };
  await writeFile(settingsPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

function formatStatus(state: WhimsyState): string {
  return `🎲 Whimsy：${state.enabled ? "开启" : "关闭"}${state.spinnerPreset ? `（spinner: ${state.spinnerPreset}）` : ""}`;
}

export async function whimsyStatus(settingsPath = DEFAULT_SETTINGS_PATH()): Promise<string> {
  return formatStatus(await loadState(settingsPath));
}

export async function whimsySet(enabled: boolean, settingsPath = DEFAULT_SETTINGS_PATH()): Promise<string> {
  const state = await loadState(settingsPath);
  state.enabled = enabled;
  await saveState(settingsPath, state);
  return enabled ? "🎲 Whimsy 已开启。" : "🎲 Whimsy 已关闭。";
}

export async function whimsyReset(settingsPath = DEFAULT_SETTINGS_PATH()): Promise<string> {
  // 删除 whimsical 字段 = 扩展默认值（enabled true + 默认权重/spinner）
  let parsed: Record<string, unknown> = {};
  try {
    const text = await readFile(settingsPath, "utf-8");
    parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  delete parsed.whimsical;
  await writeFile(settingsPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return "🎲 Whimsy 已重置为默认。";
}
