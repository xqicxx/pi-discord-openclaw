# Changelog

## 0.1.10: /skill:xxx 进 Discord（guild 级注册，笔记 25 续）

- `Guild Skill Registration`: 新增 filterGuildRegisterableCommands + registerGuildApplicationCommands + listMyGuilds——skills 注册到 guild（独立 100/guild 额度，全局 100 上限之外），全局 88 命令不变。ready 时对 bot 所在每个 guild PUT skill 命令（55 个 /skill-xxx，超限截断 100）。交互执行路径（0.1.7 的 executeDynamicSourceCommand + 先响应）已就绪，点 /skill-xxx 即读 SKILL.md 发给 agent。
- `Tests`: pi-commands.test 新增 guild 集用例（只含 skills、skill:xxx→skill-xxx、全局集不受影响、超限截断）。Impact: 全量测试 15 文件全绿，typecheck 通过。

## 0.1.9: 性能优化（笔记 25 续）

- `Preview Throttle`: DraftStream 新增 previewThrottleMs（默认 1000ms）——thinking_delta 毫秒级到达时，窗口内合并为最新值、窗口后编辑一次（首条立即发）。Discord 消息操作限流 ~1/s/channel，无节流时 thinking 高频 edit 触发 429 风暴（重试 → 卡顿 → 暂停）。Impact: 思考方块 1s 一跳稳定流动，REST 调用量降一个数量级。
- `Discord 429 Backoff`: flush 失败识别 DiscordRateLimitError.retryAfterMs（原只认 Telegram 格式，Discord 限流误入普通失败重试风暴）。Impact: 429 时优雅退避而非反复重试。
- `Typing Throttle`: sendChatAction 节流 10s（Discord 官方建议间隔；原每次 flush 都发，超 typing 限流 5/10s）。Impact: typing 请求减少 ~90%。
- `Faster Inbound`: inbound.debounceMs 1000 → 250（单人使用合并收益小，消息进 agent 感知延迟 -750ms）。
- `Tests`: draft-stream.test 新增节流合并用例（窗口内不重复发 + 窗口后最新值编辑）；并发串行用例显式 previewThrottleMs:0 保持原语义。Impact: 全量测试 15 文件全绿，typecheck 通过。

## 0.1.8: preview 并发竞态修复（笔记 25 续）

- `Preview Serialization`: DraftStream.updatePreview 的发送改为串行 drain（pendingPreview 最新值合并 + previewFlushInFlight 互斥）——thinking_delta 毫秒级到达、REST sendMessage 几十~几百 ms，原实现并发 flushPreview 下 previewMessageId 竞态覆盖，每条消息都成孤儿 → Discord 里思考内容大量重复（一轮思考 15+ 条递增消息）。修复后首条 send、后续全部 edit 同一条，中间预览按最新值合并。Impact: 思考方块恢复单条流动，不再刷屏。
- `Delivered-text Semantics`: previewText 改为「发送成功后才更新」（原同步设置，失败后相等去重会跳过恢复重试）。Impact: 网络抖动时预览可自愈。
- `Tests`: draft-stream.test 新增并发 preview 用例（5 次快速 updatePreview → 断言 1 send + 后续 edit + 最终最新文本 + 无并发时继续 edit 同一条）。Impact: 全量测试 15 文件全绿，typecheck 通过。

## 0.1.7: 斜杠命令注册上限 + interaction 必响应修复（笔记 25）

- `Registerable Command Filter`: 新增 filterDiscordRegisterableCommands——注册集排除 skill 命令（52+ 个，Discord 全局命令 100 上限会整体拒绝 PUT）+ 保底截断 100（本地+builtin 优先）。0.1.6 放开 skill 源后注册集 ≈140 超限，Discord 一直保留旧 78 命令（无 /models /help /status 等）。skill 仍保留在 merged 集：文本 /skill-xxx 本地执行不受影响。Impact: 重启后注册集 88 个（含 /models），低于 100 上限。
- `Interaction Must Respond`: prompt/skill 动态命令本地执行【先】respondInteraction（📥 正在加载…）再读文件发 agent——此前执行成功后直接 return 不响应 interaction，Discord 显示「应用无响应」；执行失败改走 followUp 引导终端。文本路径同步：先发「加载中」再执行。Impact: subagents-*/remnic-*/parallel-*/handoff 等 50+ 模板命令不再「无响应」。
- `Interaction Failure Logging`: respondInteraction 首次响应失败与 followUp 兜底失败都记录错误日志（此前静默吞掉，难排查「无响应」）。Impact: 3s 超时/网络错误可定位。
- `Skill Test Strengthened`: pi-commands.test 新增注册过滤器测试（skill 排除 + ≤100 + 本地保留 + 截断保底）；原「skill:xxx 跳过」断言被 sanitize 掩盖的漏洞补上。Impact: 全量测试 16 文件全绿。

## 0.1.6: 斜杠命令 4 类问题修复（S184）

- `Model Switching via /models`: registry models 命令加可选 model 参数，handler models case 支持切换（复用 /model 的 ctx.setModel 逻辑，无参数时列出 + 💡 提示）。Impact: /models <provider/model> 可直接切换模型，不再只能列出。
- `Local Commands Registered as Slash`: 注册集从纯动态命令改为 mergeCommandSets(getCommands(), dynamic) —— 本地可执行命令（status/help/models/stop 等）成为真正 Discord slash 命令。Impact: /status 等不再「应用无响应」（此前只注册 pi 动态命令，本地命令点不了）。
- `Interaction Error Safety`: handleInteraction 包 try/catch，executeCommand 抛异常也 respondInteraction 错误信息（Discord 3s 超时前）。Impact: 命令异常不再显示「应用无响应」，返回 ❌ 具体错误。
- `Skill Dynamic Loading`: collectPiRuntimeCommands 放开 skill 源（原跳过），skill:xxx 名称 sanitize 为合法 Discord 命令名（skill-xxx），保留 source/sourcePath。Impact: skill 命令出现在 Discord 命令列表，可点击执行。
- `Prompt/Skill Local Execution`: 新增 executeDynamicSourceCommand —— prompt 模板 / skill 命令读取 sourcePath 文件内容作为 user message 发给 agent（与终端行为一致），slash 与文本两条路径都接入；extension 源无 handler 仍引导终端。Impact: /btw /todos 等模板命令在 Discord 可直接执行，不再一律提示「需要终端执行」。
- `Command Definition Metadata`: ChatCommandDefinition 加 source/sourcePath 可选字段（向后兼容），defineChatCommand 透传。Impact: 动态命令来源可路由。

## 0.1.5: Status Reactions 完整移植 + Discord 输出格式化（笔记 23/24）

- `Status Reactions Full Port`: src/feedback/ack-reactions.ts 完整重写——13 个状态表情（queued 👀 / thinking 🧠 / tool 分类 💻🌐🏗️🛫💁🛠️ / done ✅ / error ❌ / stall ⏳⚠️ / compacting 🗜️）、工具名分类表情（resolveToolEmoji token 匹配，deploy>build>concierge>web>coding）、debounce 700ms、stall 软 10s/硬 30s 警告、终态保护（finished 后忽略后续）、延迟移除（中间状态只增不减，终态统一清理 keepEmoji）、restoreInitial/clear。Impact: 收到消息立即 👀（不再等进入队列才显示表情），处理中表情按阶段丰富流转，完成后 ✅/❌ hold 1.5s/2.5s 后清理或恢复初始，与 openclaw 原生一致。
- `Reaction Lifecycle Wiring`: index.ts 接线对齐 openclaw message-handler.process——收到消息 setQueued（立即）、agent_start setThinking、tool_execution_start setTool(toolName)（分类）、agent_end setDone + hold + clear/restoreInitial（removeAckAfterReply 可配）、gateway fatal setError + hold + clear；表情/时序可经 discord.json openclawStyle.statusReactions 覆盖。Impact: 用户消息上的表情不再永远停留在 ✅，错误路径显示 ❌。
- `Markdown Table Conversion`: 新增 src/dispatch/markdown-tables.ts——convertMarkdownTables（markdown 表格 → 对齐 ASCII 表格 + 代码块包裹，openclaw tableMode "code" 语义，列宽对齐 + dashCount=max(3,width)）、stripInlineDirectiveTagsForDelivery（剥 [[audio_as_voice]]/[[reply_to:xxx]]）、chunkDiscordText（2000 字符围栏感知分块）。Impact: 最终回答里 Discord 无法渲染的 markdown 表格变成可读的对齐 ASCII 代码块。
- `Answer Formatting Hook`: draft-stream.ts 新增 formatText 钩子（最终投递前格式化，只作用于 answer lane，progress 草稿不受影响），dispatch.ts 透传 formatAnswerText。Impact: 表格转换 + 指令标签剥离在最终回答投递前自动生效。
- `Tests`: ack-reactions.test.mjs 重写（13 表情/工具分类/debounce 合并/stall/终态保护/restoreInitial/表情覆盖）+ 新增 markdown-tables.test.mjs（表格对齐/混合内容/标签剥离/分块）。Impact: 全量测试 15 个文件全绿，typecheck 通过。
- `Docs`: 新增 docs/openclaw-research/23-status-reactions-full.md（status-reactions.ts 完整源码移植笔记：表情全集/时序/工具分类/控制器机制/接线时序/差距对照）与 24-discord-output-formatting.md（convertMarkdownTables + 分块 + 指令标签调研）。

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

