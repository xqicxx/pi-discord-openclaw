# 22 — 终端 only 斜杠命令桥接调研（Discord 可用化）

> 任务：让 pi 只能终端使用的斜杠命令也能通过 pi-discord-openclaw 在 Discord 使用。
> 参照：openclaw / Claude Code / codex（codex-telegram-bot 本地有完整源码）。

## 1. pi 终端 only 命令盘点

pi 内置命令（BUILTIN_SLASH_COMMANDS，22 个）：
settings model scoped-models export import share copy name session changelog hotkeys
fork clone tree trust login logout new compact resume reload quit

- 扩展 API 已可实现（本地 handler）：model name new compact quit + 本地 13 个
- **终端 only（17 个）**：settings scoped-models export import share copy session
  changelog hotkeys fork clone tree trust login logout resume reload

原因（0.83.x 类型，dist/core/extensions/types.d.ts）：
- 事件 ctx = ExtensionContext：abort/isIdle/compact/shutdown/getContextUsage/model/
  scopedModels/thinkingLevel/sessionManager(READONLY: getTree/getEntries/getLeafId/
  getSessionFile/getSessionName)/modelRegistry
- 命令 ctx = ExtensionCommandContext（仅 registerCommand handler 触发时）：
  newSession/fork/switchSession/navigateTree/reload/waitForIdle —— 扩展无法程序化触发
  已注册命令（runner 无 executeCommand 公开方法）
- sendUserMessage 走 prompt() 但 expandPromptTemplates:false → 禁用 slash 处理

## 2. pi RPC mode = pi 版 app-server（关键发现）

`pi --mode rpc`：headless JSONL 协议（stdin 命令 / stdout 响应+事件），34 个命令：

prompt steer follow_up abort new_session get_state get_messages set_model cycle_model
get_available_models set_thinking_level cycle_thinking_level get_available_thinking_levels
set_steering_mode set_follow_up_mode compact set_auto_compaction set_auto_retry
abort_retry bash abort_bash get_session_stats export_html switch_session fork clone
get_fork_messages get_entries get_tree get_last_assistant_text set_session_name get_commands

启动选项：`--no-extensions / -ne`（禁用扩展发现，显式 -e 仍加载）、`--no-session`。

**命令映射（终端 only → RPC）**：
| 终端命令 | RPC 命令 | 可读? |
|---|---|---|
| /new | new_session | 写 |
| /resume | switch_session | 写 |
| /fork | fork + get_fork_messages | 写 |
| /clone | clone | 写 |
| /tree | get_tree | 只读 |
| /export | export_html | 只读 |
| /copy | get_last_assistant_text | 只读 |
| /session | get_session_stats | 只读 |
| /model | get_available_models / set_model | 混合 |
| /think | get_available_thinking_levels / set_thinking_level | 混合 |
| /name | set_session_name | 写 |
| /usage | get_session_stats | 只读 |
| /commands | get_commands | 只读 |
| /settings | get_state | 只读 |

RPC 没有：login/logout/trust/share/import/reload/hotkeys/changelog（TUI only，文档明确
"Built-in TUI commands are not included, handled only in interactive mode"）。

## 3. codex-telegram-bot（本地完整源码，成熟参照）

路径 /home/ubuntu/.local/lib/node_modules/codex-telegram-bot，架构：
- src/acp/client.ts：spawn `codex app-server` + JSON-RPC 2.0 over stdio
  （wire 上省略 jsonrpc header，匹配 Codex）；一个进程管理多线程（bot 的 sessions）
- src/bot/session-runtime.ts：一个 chat ↔ 一个 codex session，驱动 prompt/stream
  生命周期、typing、follow-up 队列、live watch；状态持久化
- src/stream/streamer.ts：整个 turn 渲染成尽量少的消息，throttle 编辑（anti-429）
- src/sessions/store.ts：扫描 $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
- 命令集：start menu projects sessions active running killall mcp models agents
  skills tasks newtask history new status usage btw flush queue cancel unwatch model
  restart reauth accounts help —— /new /sessions /resume /active /history 全覆盖

## 4. openclaw（本地源码）

- native-command.ts：Discord slash → defer → readArgs → parseCommandArgs →
  buildCommandTextFromArgs → dispatchDiscordCommandInteraction（本地执行不进模型）
- native-command-dispatch.ts：命令分发（会话边界 /new /reset 走本地 turn）
- command-detection.ts isSessionBoundaryCommandText：/^\/(new|reset)/

## 5. 设计方案（推荐：RPC 桥，借鉴 codex-tg）

**核心**：保持现有主进程架构（Discord 桥扩展 + 流式/回复走 pi.sendUserMessage），
新增 src/rpc/ 模块：对「终端 only 命令」懒启动 `pi --mode rpc --no-extensions`
子进程（防递归加载扩展），JSONL 通信，渲染结果回 Discord。

- 子进程 `--session-dir` 指向主进程同一 agent 目录 → /tree /export /session 等
  只读命令看到真实会话；写命令（new/fork/switch）在 RPC 会话执行并提示状态
- 命令分级：只读（tree/export/copy/session/usage/commands/model 列表/think 列表）+
  写（new/resume/fork/clone/model 设置/think 设置/name）+ 不可桥（login/logout/trust/
  share/import/reload → 明确提示终端）
- 渲染：树形缩进 / 表格 / 简短摘要，复用现有 reply 通道
- transport：仿 codex-tg JsonRpcTransport（零依赖 JSONL over stdio）
- 懒启动 + 空闲超时回收（不常驻子进程）

**约束**：BACKLOG「Do not spawn a shadow pi subprocess」针对的是「扩展 API 同线程
/new 会话替换」场景（上游无 API）；RPC 桥是官方 headless 协议 + 独立子进程会话，
与 codex-tg spawn app-server 同构，不触碰主进程 TUI 生命周期。

## 6. 实现落地（S178+，0.1.4）

三层架构已实现：
1. **扩展内本地实现**：/tree（sessionManager.getTree 渲染缩进树）、/session（sessionFile/ID/leaf/条目数）、
   /copy（message_end 缓存最后 assistant 文本）、/settings（model/thinking/scoped/context 汇总）、
   /scoped-models、/models（modelRegistry.getAll）、/thinking-levels、/changelog、/hotkeys
2. **RPC 只读桥**：src/rpc/rpc-bridge.ts —— 懒启动 `pi --mode rpc --no-extensions` 子进程
   （--session-dir 共享主进程会话目录），JSONL over stdio（仿 codex-tg transport），/export 走 export_html；
   空闲 30s 自动 dispose，不常驻。
3. **写命令引导**：new/reset/fork/clone/resume/reload/login/logout/trust/share/import → 终端引导
   （原因 + 命令 + issue #5952），不假装可用。

关键点：index.ts captureCtx 里 rpc.setSessionDir(ctx.sessionManager.getSessionDir())，
message_end 事件缓存 lastAssistantText（模块级，供 /copy）；CommandExecutionCtx 增加
getSessionInfo/getSessionTreeText/getLastAssistantText/listAllModels/listThinkingLevels/getSettingsText。
验证：Discord 命令数 78 不变（本地执行层增强，注册仍纯动态），typecheck + 全量测试通过。

