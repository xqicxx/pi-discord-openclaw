# 21 — pi 命令全集盘点与原生移植实现（命令处理落地）

> 任务 31242「Register Pi Commands with Pi-Discord-Openclaw」：笔记 20 定方案，本笔记记录
> pi 侧命令全集、最终命令集、以及 3-9 项实现（options/handler/transport/interaction/接线/测试）。

## 1. pi 内置命令全集（dist/core/slash-commands.js BUILTIN_SLASH_COMMANDS）

settings / model / scoped-models / export / import / share / copy / name / session /
changelog / hotkeys / fork / clone / tree / trust / login / logout / new / compact /
resume / reload / quit

## 2. pi 扩展 API 能力盘点（0.82.x 类型，dist/core/extensions/types.d.ts）

- ExtensionAPI：sendUserMessage / registerCommand / setModel / getThinkingLevel /
  setThinkingLevel / getCommands / setSessionName / exec / getActiveTools / getAllTools /
  setActiveTools / registerProvider / unregisterProvider / appendEntry / setLabel
- 事件 ctx = ExtensionContext：abort() / isIdle() / compact({customInstructions}) /
  shutdown() / getContextUsage() / model / scopedModels / thinkingLevel / signal /
  sessionManager / modelRegistry（getAll/getAvailable/find/hasConfiguredAuth）
- 命令 ctx = ExtensionCommandContext（仅 registerCommand 触发时）：newSession / fork /
  switchSession / navigateTree / reload / waitForIdle —— 扩展无法程序化触发已注册命令
  （runner 无 executeCommand 公开方法）→ Discord 侧 /new /reset /fork /reload 无法原生实现
- 关键约束（BACKLOG 确认）：扩展 origin 的 pi.sendUserMessage() 故意禁用 slash 处理
  → 文本命令必须在扩展内本地执行，绝不转发给 pi 当文本

## 3. 最终命令集（scope=both：文本 /xx + Discord 原生命令）

| 命令 | 动作 | pi API |
|---|---|---|
| help | 列 essential 命令 | 本地 |
| commands | 列全部命令 | 本地 |
| status | 模型/思考/上下文/空闲 | ctx.model+getContextUsage+isIdle |
| stop | 停止当前 run | ctx.abort() |
| compact [instructions] | 压缩上下文 | ctx.compact({customInstructions}) |
| think [level] (+/thinking /t) | 设置思考级别 | pi.setThinkingLevel |
| model [id] | 显示/设置模型 | ctx.modelRegistry + pi.setModel |
| tools [mode] | 列出工具 | pi.getAllTools |
| usage [mode] | 上下文使用量 | ctx.getContextUsage |
| name [title] | 会话命名 | pi.setSessionName |
| new / reset | 会话边界 | ❌ 回复「请在终端执行」（上游无 API） |
| quit | 优雅退出 pi | ctx.shutdown() |

## 4. 移植来源（能抄就抄）

- options.ts ← openclaw extensions/discord/src/monitor/native-command.options.ts（纯函数）
- handler.ts ← openclaw dispatchChannelInboundTurn 语义（本地执行，不进模型）
- transport ← openclaw native-command-reply.ts safeCall 语义（零依赖 REST 版）
- 授权 ← 沿用 conn.channels allowlist（与消息一致，简化 openclaw 授权链）
