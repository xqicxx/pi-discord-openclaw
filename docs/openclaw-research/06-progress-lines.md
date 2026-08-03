# OpenClaw 调研笔记 06：progress-draft-lines（工具进度行构建）

> 位置：src/channels/streaming.ts（buildChannelProgressDraftLine）+ src/channels/progress-draft-lines.ts

## ChannelProgressDraftLineInput（进度事件）

```ts
type ChannelProgressDraftLineInput =
  | { event: "tool"; itemId?; toolCallId?; name?; phase?; args? }
  | { event: "item"; itemId?; toolCallId?; itemKind?; title?; name?; phase?; status?; summary?; meta? }
  | { event: "plan"; phase?; steps?; explanation?; title? }
  | { event: "approval"; phase?; command?; message?; reason?; title? }
  | { event: "command-output"; phase?; ... }
```

## buildChannelProgressDraftLine 分支逻辑

| event | 行为 |
|---|---|
| **tool** | buildNamedProgressLine(name, [inferToolMeta, phase])；command 工具加 correlationKey |
| **item** | 空 reasoning item 跳过；有 name → buildNamedProgressLine；否则纯文本行 |
| **plan** | 只保留 phase=update；显示 update_plan + 第一步 step |
| **approval** | 只保留 phase=requested；显示 approval + command + reason，status=requested |
| **command-output** | 只保留 phase=end |

## 行结构（ChannelProgressDraftLine）

```ts
{
  id?: string;          // 唯一标识（可增量更新）
  kind: "tool" | "item" | "plan" | "approval" | "command-output";
  text: string;         // 渲染文本
  label?: string;       // 标签
  status?: string;      // running/completed/requested...
  icon?: string;        // 图标
}
```

## Telegram 渲染（progress-draft-preview.ts）

```html
<b>🔧 exec_command</b> <code>ls ~/</code> <i>running</i>
```

- label = `[icon] [label]` → `<b>` 加粗
- detail ≠ label → `<code>` 代码块（escape + clip 截断）
- status 非 completed → `<i>` 斜体

## removeChannelProgressDraftLine(lines, id)

- 按 id 删除结构化行，保留纯文本行
- 返回原数组（无删除）作为 no-op 信号（渲染器据此跳过重绘）

## 移植要点

- pi activity 的 tool-start/update/end 映射为 tool 事件行
- 行 id = toolCallId，更新时按 id 增量编辑（不重发整条）
- 完成的行保留 ✓ 或删除
