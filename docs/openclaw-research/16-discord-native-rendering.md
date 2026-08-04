# OpenClaw 调研笔记 16：Discord 原生输出渲染格式（对照修正）

> 用户反馈：输出"很奇怪，不是 openclaw 的 discord 原生输出"。
> 定位：① 插件未加载（config.ts 修复后未重启）；② 渲染格式移植自 telegram 版，与 discord 原生不一致。

## 1. Reasoning 原生格式（formatDiscordReasoningQuote）

位置：extensions/discord/src/monitor/message-handler.process-reply-runtime.ts

```ts
export function formatDiscordReasoningQuote(quoteText: string): string | undefined {
  const lines = quoteText.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  lines[0] = `🧠 ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join("\n");
}
```

- **blockquote 格式**：每行 `> ` 前缀，首行加 🧠（不是 `🧠 _斜体_`）
- 投递前分块：chunkLimit = max(256, min(textLimit, 2000) - 8)，chunkDiscordTextWithMode
- 从 raw 剥离 "Reasoning:\n" 前缀（`raw.startsWith("Reasoning:\n") ? raw.slice(8) : raw`）

## 2. Progress 行原生格式（buildChannelProgressDraftLine）

位置：src/channels/streaming.ts → buildNamedProgressLine → formatToolAggregateParts（src/auto-reply/tool-meta.ts）

文本组装：
```ts
const prefix = compactCommandSummary ? display.emoji : `${display.emoji} ${display.label}`;
return {
  text: compactCommandSummary ? `${prefix} ${detail}` : `${prefix}: ${detail}`,
  detail,
};
```

- 普通工具：`🛠️ Bash: run tests`（emoji + label + `: ` + detail）
- command 工具（exec/bash）：`🛠️ run tests`（紧凑，emoji + detail，省略 label）
- 无 detail：`🛠️ Bash`
- **emoji 映射**（src/agents/tool-display.ts + tool-display-config.js）：Bash→🛠️、Web Search→🔎、read→📄 等；fallback 🧩
- detail 折叠：路径按目录分组 + brace 折叠（`src/{a, b}.ts`）

## 3. 最终回复原生处理

位置：extensions/discord/src/monitor/message-handler.draft-preview.ts

```ts
const formatted = convertMarkdownTables(
  stripInlineDirectiveTagsForDelivery(text).text,
  params.tableMode,
);
const chunks = chunkDiscordTextWithMode(formatted, {
  maxChars: draftMaxChars, maxLines: params.maxLinesPerMessage, chunkMode,
});
```

- **表格降级**：Discord 不支持 markdown 表格 → convertMarkdownTables（tableMode 可配）
- **指令标签剥离**：stripInlineDirectiveTagsForDelivery（&lt;thinking&gt; 等）
- 分块：2000 字符 / maxLines 行（默认 17）

## 4. streaming 模式（文档 channels/discord.md §Live stream preview）

- mode: `off` | `partial` | `block` | `progress`（默认 progress）
- `progress`：一个可编辑状态草稿直到最终投递；状态标题 = 最新 preamble/narration；下方紧凑工具行
- toolProgress 默认 true（两种模式都开）；行如 `🛠️ Bash: run tests` / `🔎 Web Search: for "query"`
- commentary（默认 false）：可选在进度草稿中显示原始 assistant 评论
- commandText: `raw`（默认，显示命令）| `status`（只显示工具标签）

## 5. 对照修正清单（pi-discord-openclaw）

| 文件 | 现状 | 修正为 |
|---|---|---|
| src/reasoning/reasoning-lane.ts | `🧠 _斜体_` | `> 🧠 首行\n> 续行`（blockquote） |
| src/progress/progress-lane.ts | `**🔧 name** `detail` *status*` | `🛠️ Bash: run tests`（emoji+label+detail） |
| src/dispatch/rich-text.ts | HTML 转义（废弃残留） | Discord markdown 直通 + 表格降级（简化） |
| index.ts | —— | config.ts 修复后需重启才加载插件 |

## 6. 部署提醒

- config.ts 的 require→ESM import 修复在 17:05 完成，但 17:02 重启在修复前 → **必须再次重启 pi 服务**
- 重启后验证：tmux 出现 "[pi-discord-openclaw] Discord Gateway 已连接"
