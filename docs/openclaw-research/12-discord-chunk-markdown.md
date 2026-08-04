# OpenClaw 调研笔记 12：Discord 分块 + Markdown

> 位置：extensions/discord/src/{chunk,markdown}.ts

## chunk.ts（分块）

- DEFAULT_MAX_CHARS = 2000；DEFAULT_MAX_LINES = 17（Discord 客户端超高消息会折叠，按行拆）
- **fence-aware**：FENCE_RE = /^( {0,3})(\x60{3,}|~{3,})(.*)$/，代码围栏内不拆块
- **reasoning 斜体标记**：hasReasoningItalics —— /^(Reasoning:|Thinking...)\n+_/ 且以 _ 结尾，整块保留
- chunkDiscordTextWithMode：基于 plugin-sdk reply-chunking 的 chunkMarkdownTextWithMode

## markdown.ts（规范化）

- mdast-util-from-markdown 解析 → 语义签名对比 → 源保留式规范化
- DISCORD_FORMAT_PROFILE：mechanism "markdown"，table: "fallback"（Discord 不支持表格 → 降级文本），chunk { limit: 2000, unit: "utf16" }
- **粗体探测**：DISCORD_BOLD_PROBE 用 probe 文本渲染出 ** 标记，用于探测平台实际渲染行为
- URL 范围识别（DISCORD_URL_START_RE，括号配对、_ 前缀排除）
- **原生 Discord token 保护**：DISCORD_NATIVE_TOKEN_RE = /<a?:[A-Za-z0-9_]+:\d+>|</[^>]+:\d+>/（emoji/mention 原样保留）
- renderMarkdownWithMarkers：样式标记（bold/italic/code）→ ** ** / * * / \x60 \x60

## 移植要点

我们 src/dispatch/rich-text.ts（46 行）目前是 Telegram HTML 转义思路 → 需改为：
1. Markdown 直通 + 转义冲突字符（* _ \x60 [ ]）
2. 表格降级（| --- | → 文本对齐/列表）
3. 代码围栏不拆分（chunk 逻辑）
4. 2000/17 行分块策略
