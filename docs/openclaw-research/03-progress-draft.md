# OpenClaw 调研笔记 03：progress-draft-preview.ts（工具进度）

> 位置：extensions/telegram/src/progress-draft-preview.ts

## 作用

工具调用期间显示进度草稿（progress draft）：一行一个工具，实时更新。

## 进度行渲染

### renderTelegramProgressLine(line)

输入 `ChannelProgressDraftCompositorLine`，输出 HTML：

```html
<b>🔧 tool_name</b> <code>detail</code> <i>status</i>
```

规则：
- label = `[icon] [label]`（如 `🔧 exec_command`）→ `<b>` 加粗
- detail = 与 label 不同则追加 `<code>` 代码块
- status 非 completed 且非 detail → `<i>` 斜体
- 纯字符串/无图标行 → 普通文本渲染
- 所有文本先 escapeTelegramHtml + clipTelegramProgressText（截断）

### formatTelegramProgressLine(text)

- 已是 `_..._` 斜体 → 原样
- 否则 → `` `text` `` 代码块

### renderTelegramProgressStringLine(text)

- 思考/注释行走 HTML-safe 渲染（parse_mode HTML）
- 斜体正则 `^(\S+ )?_(.*)_$` 保留斜体，截断内容

### clipTelegramProgressText(text)

- 超长截断（truncate.ts）

## 进度草稿合成（src/channels/progress-draft-compositor.ts）

- createChannelProgressDraftCompositor：收集工具事件 → 合成进度行列表
- createChannelProgressReceiptTracker：跟踪投递回执
- buildChannelProgressDraftLine：单行构建（icon/label/detail/status）

## 移植要点

- pi activity 已有 `tool-start` / `tool-update` / `tool-end` 事件
- 实现 ProgressLane：独立 draft stream 显示进度，全部完成时清理
- 行格式：`<b>🔧 name</b> <code>detail</code> <i>running|✓</i>`
