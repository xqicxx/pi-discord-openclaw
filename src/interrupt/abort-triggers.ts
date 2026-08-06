// 笔记 28：abort 触发词识别（移植 openclaw abort-primitives.ts ABORT_TRIGGERS / isAbortRequestText）。
// 独立模块：便于单元测试（index.ts 为 bot 入口，无法直接 import 测试）。

/** abort 触发词（多语言停止词 + 短语）。 */
export const ABORT_TRIGGERS: ReadonlySet<string> = new Set([
  "stop", "esc", "abort", "exit", "interrupt", "halt",
  "detente", "deten", "detén", "arrete", "arrête",
  "停止", "停下来", "暂停", "やめて", "止めて", "रुको", "توقف",
  "стоп", "остановись", "останови", "остановить", "прекрати",
  "anhalten", "aufhören", "hoer auf", "stopp", "pare",
  "stop openclaw", "openclaw stop", "stop action", "stop current action",
  "stop run", "stop current run", "stop agent", "stop the agent",
  "stop don't do anything", "stop dont do anything",
  "stop do not do anything", "stop doing anything",
  "do not do that", "please stop", "stop please",
]);

const TRAILING_ABORT_PUNCTUATION_RE = /[.!?！？…,，。;；:：'"’")\]}]+$/u;

/** 归一化触发词（小写、去尾部标点、空白折叠）。 */
export function normalizeAbortTriggerText(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").replace(TRAILING_ABORT_PUNCTUATION_RE, "").trim();
}

/** 是否 abort 触发消息（openclaw isAbortRequestText 语义：/stop 或触发词）。 */
export function isAbortRequestText(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  if (lower === "/stop") return true;
  return ABORT_TRIGGERS.has(normalizeAbortTriggerText(lower));
}
