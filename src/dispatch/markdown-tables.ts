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

/**
 * markdown 表格 → Discord Embed fields（每行一个 field，name=第一列，value=其余列）。
 * 返回 null 表示无表格或表格过大（超过 25 fields 或单格超 1024 字符）。
 */
export function convertMarkdownTableToEmbed(markdown: string): { embeds: unknown[] } | null {
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const block = parseTableBlock(lines, i);
    if (block) {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
      // 表头作为第一个 field 的 name？不，表头放 description 或 title，这里简单处理：
      // 每行一个 field，name=第一列，value=其余列（用 | 分隔）
      for (const row of block.rows) {
        if (row.length === 0) continue;
        const name = row[0] ?? "";
        const value = row.slice(1).join(" | ") || "—";
        if (name.length > 256 || value.length > 1024) return null;
        fields.push({ name, value, inline: true });
      }
      if (fields.length === 0 || fields.length > 25) return null;
      // 表头放 description（截断到 4096）
      const description = block.headers.join(" | ").slice(0, 4096);
      return { embeds: [{ title: "表格", description, fields }] };
    }
    i += 1;
  }
  return null;
}

/**
 * 文本中的 markdown 表格全部转为 Discord Embed fields（issue 59）。
 * - 非表格内容保留在 content（Discord 原生渲染 markdown）
 * - 每个表格块 → 一个 embed（title=表格，description=表头，fields=每行一字段）
 * - 超出 Discord 限制（>10 embeds / 单表 >25 fields / 单格 >1024 字符 /
 *   合计 >6000 字符）→ 返回 null，调用方回退 ASCII 代码块
 */
export function convertTextWithTables(
  markdown: string,
): { content: string; embeds: unknown[] } | null {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const embeds: unknown[] = [];
  let i = 0;
  let totalEmbedChars = 0;
  // 笔记 30：Discord 的 embed 只能渲染在 content 下方——
  // 若表格之后还有内容，embed 会把表格挤到最后（位置错乱）。
  // 此时回退 ASCII 代码块（保位置优先）。
  let sawTable = false;
  while (i < lines.length) {
    const block = parseTableBlock(lines, i);
    if (block) {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
      for (const row of block.rows) {
        if (row.length === 0) continue;
        const name = row[0] ?? "";
        const value = row.slice(1).join(" | ") || "—";
        if (name.length > 256 || value.length > 1024) return null;
        fields.push({ name, value, inline: true });
      }
      if (fields.length === 0 || fields.length > 25) return null;
      const description = block.headers.join(" | ").slice(0, 4096);
      const embed = { title: "表格", description, fields };
      const chars = JSON.stringify(embed).length;
      if (totalEmbedChars + chars > 5800) return null; // 6000 留余量
      totalEmbedChars += chars;
      embeds.push(embed);
      sawTable = true;
      i += 2 + block.rows.length;
    } else {
      // 笔记 30：表格之后还有非空内容 → 回退（embed 位置会错乱）
      if (sawTable && lines[i].trim() !== "") return null;
      out.push(lines[i]);
      i += 1;
    }
  }
  if (embeds.length === 0 || embeds.length > 10) return null;
  return { content: out.join("\n").trim(), embeds };
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
 * 按 maxChars 分块，代码围栏（``` 或 ~~~）感知（Issue #4 修复）：
 * 围栏块（开围栏行到闭合行）整体作为最小不可分单元 —— 表格转换器输出的
 * ```+ASCII表格+``` 永远不会被切断，避免孤立围栏导致的排版错乱。
 * 非围栏内容按行边界分块；单行/围栏块超过 maxChars 时才内部切（行完整优先，
 * 超长行才硬切 fallback）。
 */
export function chunkDiscordText(text: string, maxChars: number = DISCORD_TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split("\n");

  // 1) 聚合段落：围栏块（``` / ~~~ 配对）整体为一段；其余行为单行段
  const paragraphs: string[] = [];
  let fence: string | undefined;
  let fenceBuf: string[] = [];
  const flushFence = (): void => {
    if (fenceBuf.length) paragraphs.push(fenceBuf.join("\n"));
    fenceBuf = [];
  };
  for (const line of lines) {
    if (fence === undefined) {
      const m = /^\s*(```|~~~)/.exec(line);
      if (m) {
        fence = m[1];
        fenceBuf = [line];
        const closes = (line.match(new RegExp(fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
        if (closes >= 2) {
          flushFence();
          fence = undefined;
        }
      } else {
        paragraphs.push(line);
      }
    } else {
      fenceBuf.push(line);
      const closes = (line.match(new RegExp(fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
      if (closes >= 1) {
        flushFence();
        fence = undefined;
      }
    }
  }
  flushFence(); // 未闭合围栏也整体保留（避免孤立围栏）

  // 2) 段落级分块：段落不跨块；段落超限时内部行切（行完整优先）
  const chunks: string[] = [];
  let current = "";
  const push = (para: string): void => {
    if (para.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      let buf = "";
      for (const pline of para.split("\n")) {
        if (pline.length > maxChars) {
          // 超长行硬切 fallback（保持每块 ≤ maxChars）
          if (buf) {
            chunks.push(buf);
            buf = "";
          }
          let rest = pline;
          while (rest.length > maxChars) {
            chunks.push(rest.slice(0, maxChars));
            rest = rest.slice(maxChars);
          }
          buf = rest;
          continue;
        }
        const add = buf ? "\n" + pline : pline;
        if (buf && buf.length + add.length > maxChars) {
          chunks.push(buf);
          buf = pline;
        } else {
          buf += add;
        }
      }
      if (buf.trim().length) chunks.push(buf);
      return;
    }
    const add = current ? "\n" + para : para;
    if (current && current.length + add.length > maxChars) {
      chunks.push(current);
      current = para;
    } else {
      current += add;
    }
  };
  for (const p of paragraphs) push(p);
  if (current.trim().length) chunks.push(current);
  return chunks;
}
