// Discord 输出格式化 — 原生移植 openclaw（笔记 24）。
// 1. convertMarkdownTables：markdown 表格 → 对齐 ASCII 表格 + 代码块包裹
//    （openclaw tableMode "code"，Discord 默认；轻量实现，效果等同无解析器依赖）
// 2. stripInlineDirectiveTagsForDelivery：剥离 [[audio_as_voice]] / [[reply_to:xxx]] 指令标签
// 3. chunkDiscordText：代码围栏感知分块（2000 字符上限，openclaw chunkDiscordText 语义）

/** Discord 单条消息字符上限（openclaw DISCORD_TEXT_CHUNK_LIMIT）。 */
export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

// ---- 表格识别（openclaw markdown-core tables 语义，轻量版） ----

/** 分隔行：| --- | :---: | ---: | 等（仅含 | - : 空格）。 */
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
/** 数据行：含至少一个 | 且以 | 开头/结尾（宽松匹配 openclaw）。 */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

interface TableBlock {
  headers: string[];
  rows: string[][];
}

/**
 * 解析一个 markdown 表格块（表头行 + 分隔行 + 数据行）。
 * 返回 null 表示从 index 开始不是表格。
 */
function parseTableBlock(lines: string[], index: number): TableBlock | null {
  const headerLine = lines[index];
  if (headerLine === undefined) return null;
  if (!TABLE_ROW_RE.test(headerLine)) return null;
  const separatorLine = lines[index + 1];
  if (separatorLine === undefined || !TABLE_SEPARATOR_RE.test(separatorLine)) return null;
  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const headers = splitRow(headerLine);
  const rows: string[][] = [];
  let cursor = index + 2;
  while (
    cursor < lines.length &&
    TABLE_ROW_RE.test(lines[cursor]) &&
    !TABLE_SEPARATOR_RE.test(lines[cursor])
  ) {
    rows.push(splitRow(lines[cursor]));
    cursor += 1;
  }
  return { headers, rows };
}

/** 渲染对齐 ASCII 表格（openclaw appendRow/appendDivider 语义）。 */
function renderAsciiTable(block: TableBlock): string {
  const columnCount = Math.max(block.headers.length, ...block.rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    widths.push(
      Math.max(block.headers[c]?.length ?? 0, ...block.rows.map((r) => r[c]?.length ?? 0)),
    );
  }
  const renderRow = (cells: string[]): string => {
    let out = "|";
    for (let c = 0; c < columnCount; c += 1) {
      const cell = cells[c] ?? "";
      out += " " + cell + " ".repeat(Math.max(0, widths[c] - cell.length)) + " |";
    }
    return out;
  };
  const renderDivider = (): string => {
    let out = "|";
    for (let c = 0; c < columnCount; c += 1) {
      out += " " + "-".repeat(Math.max(3, widths[c])) + " |";
    }
    return out;
  };
  const lines = [renderRow(block.headers), renderDivider()];
  for (const row of block.rows) lines.push(renderRow(row));
  return lines.join("\n");
}

/**
 * markdown 表格 → 对齐 ASCII 表格（代码块包裹）。
 * 非表格内容原样保留；tableMode "off" 直接返回原文。
 * 渲染结果与 openclaw convertMarkdownTables(markdown, "code") 一致：
 *   | a   | b   |
 *   | --- | --- |
 *   | 1   | 2   |
 */
export function convertMarkdownTables(markdown: string, mode: "code" | "off" = "code"): string {
  if (!markdown || mode === "off") return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  let convertedAny = false;
  while (i < lines.length) {
    const block = parseTableBlock(lines, i);
    if (block) {
      out.push("```", renderAsciiTable(block), "```");
      convertedAny = true;
      i += 2 + block.rows.length;
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  if (!convertedAny) return markdown;
  return out.join("\n");
}

// ---- 指令标签剥离（openclaw stripInlineDirectiveTagsForDelivery） ----

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

export interface StrippedText {
  text: string;
  changed: boolean;
}

/**
 * 剥离投递用指令标签：[[audio_as_voice]]、[[reply_to_current]]、[[reply_to:xxx]]。
 * （openclaw stripInlineDirectiveTagsForDelivery 语义）
 */
export function stripInlineDirectiveTagsForDelivery(text: string): StrippedText {
  if (!text) return { text, changed: false };
  const stripped = text.replace(AUDIO_TAG_RE, "").replace(REPLY_TAG_RE, "");
  return { text: stripped, changed: stripped !== text };
}

// ---- 围栏感知分块（openclaw chunkDiscordText 语义） ----

/**
 * 按 2000 字符分块，代码围栏（``` 或 ~~~）感知：
 * 围栏内优先在换行处断开；超长行才硬切（fallback，与 openclaw 一致）。
 */
export function chunkDiscordText(text: string, maxChars: number = DISCORD_TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = "";
  const lines = text.split("\n");
  for (const line of lines) {
    // 单行本身超长 → 硬切（保持每块 ≤ maxChars）
    if (line.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      let rest = line;
      while (rest.length > maxChars) {
        chunks.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
      continue;
    }
    const addition = current ? "\n" + line : line;
    if (current && current.length + addition.length > maxChars) {
      // 行边界断开（围栏行 ``` 作为整行保留，天然围栏感知）
      chunks.push(current);
      current = line;
    } else {
      // 累积：current + 增量（``` 行边界保留）
      current += addition;
    }
  }
  if (current.trim().length) chunks.push(current);
  return chunks;
}
