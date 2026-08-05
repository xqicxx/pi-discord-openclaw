# OpenClaw 调研笔记 24：Discord 输出格式化（原生移植）

> 用户需求：输出内容跟思考跟工具混在一起难看；表格根本看不清。要求原生移植
> OpenClaw 的 Discord 输出格式化管线：表格 → 对齐 ASCII 代码块、思考/工具/正文分离、
> 2000 字符分块、指令标签剥离。

## 1. 表格转换（convertMarkdownTables，src/markdown-core/tables.ts）

位置：`dist/tables-Dsnw_rPw.js`（1780 行，含 markdownToIR/renderMarkdownWithMarkers/convertMarkdownTables）

**管线**：markdownToIR（一次解析成 IR：纯文本 + 样式/链接 spans）→
renderMarkdownWithMarkers（样式标记嵌套渲染）→ convertMarkdownTables 出口。

**核心**（Discord 用 `mode: "code"`，默认）：

```js
function convertMarkdownTables(markdown, mode) {
  if (!markdown || mode === "off") return markdown;
  const { ir, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false, autolink: false, headingStyle: "none",
    blockquotePrefix: "", tableMode: mode === "block" ? "code" : mode,
  });
  if (!hasTables) return markdown;
  return renderMarkdownWithMarkers(ir, { styleMarkers: MARKDOWN_STYLE_MARKERS, ... });
}
```

**表格渲染（code 模式）**：对齐 ASCII 表格 + 代码块包裹：

```js
appendRow(headers);   // | a   | b   |
appendDivider();      // | --- | --- |
for (const row of rows) appendRow(row);  // | 1   | 2   |
// 整块包 code_block style → 渲染为 ``` 代码块
```

- 列宽 = max(表头/各行文本长度)；分隔线 dashCount = max(3, width)
- 空表格不输出；表格后跟换行
- style：code_block 包裹整表（Discord 渲染为等宽代码块，可读性最好）

**表格模式**（resolveMarkdownTableMode，markdown-tables-DV_Axunn.js）：
code（默认，对齐 ASCII 代码块）/ bullets（每行 label: value）/ block / off。
Discord 无插件默认 → "code"。

## 2. Discord 分块（chunkDiscordTextWithMode，extensions/discord）

位置：`dist/reply-reference-CVdr_ZsZ.js` line 156

- 默认 chunkMode "length"：`chunkDiscordText` 按 2000 字符（DISCORD_TEXT_CHUNK_LIMIT）
  分块，**代码围栏感知**（openFence 跟踪，不在围栏中间断开）
- chunkMode "newline"：先按行分块再嵌套 2000 字符分块
- `rebalanceReasoningItalics`：`Reasoning:\n_` 开头的跨块斜体补 `_` 保持平衡
- 最终回复 maxLines 默认 17 行（draftMaxChars 2000）

## 3. 指令标签剥离（stripInlineDirectiveTagsForDelivery）

位置：`dist/directive-tags-Dwm0c6MB.js`（src/utils/directive-tags.ts）

- 剥离 `[[audio_as_voice]]`、`[[reply_to_current]]`、`[[reply_to:xxx]]`
- normalizeDirectiveWhitespace：代码块占位保护后折叠空白/去除前导缩进/压多空行
- stripInlineDirectiveTagsForDisplay / ForDelivery 两个出口（delivery 用）

## 4. Discord 最终回复原生处理（message-handler.draft-preview.ts，笔记 16 §3）

```js
const formatted = convertMarkdownTables(
  stripInlineDirectiveTagsForDelivery(text).text, params.tableMode);
const chunks = chunkDiscordTextWithMode(formatted, {
  maxChars: draftMaxChars, maxLines: params.maxLinesPerMessage, chunkMode,
});
```

**即最终回答投递前：剥指令标签 → 表格转对齐 ASCII 代码块 → 2000 字符/17 行分块。**

## 5. 思考/工具/正文分离（OpenClaw 原生）

- **reasoning**：blockquote（`> 🧠 首行\n> 续行`，formatDiscordReasoningQuote，笔记 16 §1）；
  progress 模式下注入 progress 方块（🧠 _斜体_ 行，笔记 19）
- **工具进度**：progress draft 方块（🛠️ Bash: run tests，笔记 16 §2）
- **最终回答**：answer 独立消息，正文 markdown 直通 + 表格转换 + 分块
- 完成后 progress 方块折叠为摘要（✅ N 个工具调用完成，笔记 03）

## 6. 移植方案（pi-discord-openclaw）

| 项 | 方案 |
|---|---|
| 表格转换 | 高效轻量实现：只识别 markdown 表格块（\| 行 + 分隔行），列宽对齐 + \`\`\` 包裹；非表格原样保留（效果等同，无 38KB 解析器依赖） |
| 指令标签 | 移植 stripInlineDirectiveTagsForDelivery（正则，轻量） |
| 分块 | 已有 splitChunks（1900 安全余量）；补围栏感知 + reasoning 斜体重平衡（轻量版） |
| 接线 | 最终回答投递前：剥标签 → 表格转换 → 分块发送 |
