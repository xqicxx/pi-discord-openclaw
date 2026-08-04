// Rich message formatting — ported from openclaw rich-message.ts + format.ts (对照遗漏).
// openclaw 文档: 输出使用标准 Telegram HTML（bold/italic/links/code/spoilers/quotes）。
// 可选 richMessages: true 启用 Bot API 10.2 富消息。

const HTML_ESCAPE_RE = /[&<>"']/g;

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 转义 HTML 特殊字符（openclaw escapeTelegramHtml）。 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export type RichTextTag = "b" | "i" | "code" | "spoiler" | "quote" | "link" | "pre";

/**
 * 渲染标准 Telegram HTML 富文本（openclaw Rich message formatting）。
 * 支持: 加粗/斜体/代码/剧透/引用/链接/预格式。
 */
export function renderRichHtml(tag: RichTextTag, content: string, href?: string): string {
  const escaped = escapeTelegramHtml(content);
  switch (tag) {
    case "b":
      return `<b>${escaped}</b>`;
    case "i":
      return `<i>${escaped}</i>`;
    case "code":
      return `<code>${escaped}</code>`;
    case "spoiler":
      return `<tg-spoiler>${escaped}</tg-spoiler>`;
    case "quote":
      return `<blockquote>${escaped}</blockquote>`;
    case "link":
      return href ? `<a href="${escapeTelegramHtml(href)}">${escaped}</a>` : escaped;
    case "pre":
      return `<pre>${escaped}</pre>`;
    default:
      return escaped;
  }
}
