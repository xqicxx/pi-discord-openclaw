# Changelog

## 0.1.4: 终端 only 命令桥接（笔记 22 三层架构）

- `Readonly Terminal Commands`: /tree /session /copy /settings /scoped-models /models /thinking-levels /changelog /hotkeys 本地实现——经事件 ctx 的 sessionManager 只读面（getTree/getSessionFile/getLeafId/getSessionName）+ message_end 缓存最后回复 + modelRegistry。Impact: 这些终端命令现在 Discord 可直接调用，不进模型。
- `RPC Export Bridge`: 新增 src/rpc/rpc-bridge.ts——懒启动 `pi --mode rpc --no-extensions` 子进程（JSONL over stdio，仿 codex-telegram-bot JsonRpcTransport），/export 经 export_html 导出会话 HTML，共享主进程 session-dir，空闲 30s 自动回收。Impact: 会话导出在 Discord 可用，零常驻子进程。
- `Write Command Guidance`: /new /reset /fork /clone /resume /reload /login /logout /trust /share /import 输出美观的终端引导（原因 + 命令 + 上游限制 issue #5952）。Impact: 不再回「未实现」，明确可用边界。

## 0.1.3: 动态挂载 pi 全部命令（不写死，笔记 21 修订）

- `Dynamic Command Mounting`: 命令清单不再写死 13 个，改为从 pi 动态获取后全量注册——`loadPiBuiltinCommands()`（BUILTIN_SLASH_COMMANDS 22 个，物理路径探测绕过 package exports）+ `collectPiRuntimeCommands()`（`pi.getCommands()` 的扩展/prompt 命令），与本地可执行命令合并（本地优先去重），注册到 Discord。Impact: Discord 上从 13 个命令增至 86 个（含 settings/fork/tree/resume/login 等 pi 内置与扩展命令），跟随 pi 版本与扩展动态变化。
- `Command Description Truncation`: 命令描述统一截断到 Discord 100 字符上限（openclaw truncateDiscordCommandDescription 语义）。Impact: 修复注册被拒（Invalid Form Body / BASE_TYPE_MAX_LENGTH）——动态命令（prompt 模板）描述超长导致整个 PUT 失败、Discord 保留旧命令的隐蔽问题。
- `Deploy Error Diagnostics`: DiscordApiError 携带完整 errors body；注册失败日志输出精确非法字段（如 `{47:{description:{...}}}`）。Impact: 全量命令注册失败时可秒级定位具体命令与字段。
- `Docs`: 笔记 21 补充排障记录（动态收集成功但注册被拒的完整链路）。

## 0.1.2: pi 命令系统接入（原生移植，笔记 20/21）

- `Native Command Handling`: 新增完整命令系统——文本 `/xx` 消息拦截（normalize 冒号语法/mention 剥离/别名 → canonical，移植 openclaw commands-registry-normalize + command-detection）与 Discord 原生命令（启动时 PUT /applications/{id}/commands 批量注册，INTERACTION_CREATE 分发，ephemeral 回复）。Impact: Discord 里 `/stop`、`/compact`、`/think`、`/model`、`/status` 等命令本地执行，不再被当普通消息发给 agent 导致「直接未响应」。
- `Command Set`: 13 个内置命令（help/commands/status/stop/compact/think/model/tools/usage/name/quit/new/reset），定义结构移植 openclaw ChatCommandDefinition（args/captureRemaining/tier/choices）。Impact: 覆盖 pi 扩展 API 可实现的核心命令全集。
- `Local Execution`: 命令经 CommandExecutionCtx（从事件 ctx 捕获的 abort/compact/shutdown/setModel/setThinkingLevel/setSessionName 能力面）本地执行，不进模型；`/new`、`/reset` 明确回复「请在终端执行」（上游 ExtensionAPI 无会话替换能力，BACKLOG 已记录）。Impact: 命令即时响应，无需 agent turn。
- `Transport`: discord-rest.ts 新增 registerApplicationCommands/createInteractionResponse/createInteractionFollowUp；gateway 新增 INTERACTION_CREATE 分发；types.ts 新增 interaction/application-command 最小面（discord-api-types v10 子集）。Impact: 零依赖实现完整 slash 命令生命周期。
- `Docs`: 新增 docs/openclaw-research/20-native-commands.md（openclaw 命令处理全链路调研 + 移植决策）与 21-pi-commands-fullset.md（pi 命令全集盘点 + 最终命令集）。

