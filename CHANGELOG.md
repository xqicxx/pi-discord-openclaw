# Changelog

## 0.1.23: 🛠️ typecheck 恢复 + /reload 引导终端 + abort 确认防双发

- `Fix`: **typecheck 全面恢复（issue #115）**——修复 19 处 TS 错误：`rest`/`applicationId` 闭包窄化失效、`makeReactions` 定义在 messageCreate 回调内却被 agent_start 引用（顺带修掉排队消息升级为 active 时的运行时 ReferenceError）、`/context-simple` 系统提示改从事件 ctx 读取（ExtensionAPI 无 `getSystemPrompt`）、`sendChatAction` 签名对齐；CI 新增 `npm run typecheck` 步骤防回归，Deno 测试文件从 typecheck 与 npm pack 排除。
- `Fix`: **/reload 不再必崩（issue #115）**——`pi.reload()` 只存在于终端命令上下文，扩展 API 无远程触发入口；改为回复引导在本机 pi 终端执行 `/reload`。
- `Fix`: **abort 确认消息双发（issue #117）**——`abortCurrentTurn` 返回是否已向 turn 频道发送确认，宿主仅在无活跃 turn 时兜底回复，避免同一条「🛑 已中止」发两次。
- `Tests`: interrupt 测试新增 abort 返回值断言（有 turn=true / 无 turn=false）。

## 0.1.22: 🔁 远程 /resume + ⏸️ abort 触发词 + ✓ 表情终态常驻 + 📊 上下文健康提醒

- `Feature`: **远程 /resume**——Discord 发 `/resume <id>` 重启桥自动恢复历史会话（约 15s，上下文不丢），无需终端；配套只读 `/tree` `/session` `/copy` `/settings` `/export`（issue #97 卡顿调研期间产出）。
- `Feature`: **abort 触发词**——移植 openclaw `abort-primitives.ts`，40+ 多语言停止词（stop/停止/暂停/やめて/halt…）+ `/stop`，活跃 turn 立即中断、表情清理（笔记 28）。
- `Feature`: **表情终态 ✓ 常驻**——完成态 ✓ 不再回落 ⏳（对齐 openclaw `removeAckAfterReply=false`），单通道状态机只增不减、终态零残留（笔记 30/35 定稿）。
- `Feature`: **上下文健康提醒**——每 turn 检查上下文使用率，>70% 提醒 `/compact`（别名 `/compress`），避免膨胀导致卡顿（笔记 36）。
- `Fix`: 卡顿修复（issue #97）——`contextHighUsageThreshold` 配置 + `onContextHighUsage` 回调，经 PR #98 合入。
- `Tests`: 新增 interrupt / resume / resume-command 测试；全套 21 files 通过。

## 0.1.21: 🌐 误报修复——没搜网不再挂地球（bare-word → 只认真实调用形态）

- `Bugfix`: **没搜网也挂 🌐**（用户实锤）——笔记 33 的 WEB_ARGS_RE 是 bare-word 匹配，而 fabric_exec 的 args 是 TS 源码：源码里**提过** web_search/firecrawl/tavily/bing 等字样（grep 模式、注释、工具清单、测试用例）就误判成搜索。修复：`argsHaveWebSignal` 只认调用形态——①调用语法 `web_search(` / `webSearch(` / `web_fetch_exa(` / `firecrawl.scrape(` / `agent_browser(` / `search_web(`；②具名访问 `extensions.web_search` / `mcp.exa` / `mcp.firecrawl` / `mcp.tavily`；③搜索引擎 URL（google.com(/search)/duckduckgo.com/bing.com）；④agent-reach CLI 命令。删除全部 bare-word 分支。
- `Tests`: 新增 7c 回归——grep 模式/注释/工具清单提词 → 💻（不挂 🌐）；真实调用（URL/CLI/调用语法/MCP）→ 🌐。ack-reactions 25 pass / 4 fail（4 fail 为既有遗留，见 0.1.20），typecheck 无新增错误。

## 0.1.20: 联网地球 🌐 识别升级 + ⚠️ 警告「误报 / 不解除」双修复（openclaw 调研笔记 33）

- `Feature`: **fabric_exec 内部联网 → 🌐**——tool_execution_start 把 `event.args` 透传给 setTool（此前只传工具名，args 检测形同虚设）。fabric_exec 是容器工具，名字永远识别不出联网，只有 args.code 里的 web 调用痕迹（web_search/exa/firecrawl/tavily）能兜住；WEB_ARGS_RE 扩充 firecrawl|tavily|exa.web|web_fetch_exa。
- `Bugfix`: **⚠️ 不解除**——stall 表情只增不减：一旦挂上，后续恢复活动只 add 新表情，⚠️ 残留到终态。修复：resetStallTimers（每次新活动触发）把已挂着的 ⏳/⚠️ 立即移除（removeEmoji 幂等安全）。
- `Bugfix`: **正常执行误报 ⚠️**——fabric_exec 单次调用执行 30-60s（内部多轮联网）期间 pi 侧无任何事件，30s 硬阈值必误报。修复：长任务/联网工具（fabric_exec/subagent/workflow/web 信号）stall 窗口放宽 soft 3x / hard 4x（30s/120s）；真卡死仍触发 ⚠️（卡死检测不失效）。
- `Bugfix`: 全局正则（WEB_ARGS_RE/LONG_RUNNING_TOOL_RE 带 g flag）连续 test() 的 lastIndex 串台——同一次任务多个工具互相污染识别结果。修复：test 前重置 lastIndex。
- `Tests`: 新增 7b（args→🌐 分类）、8b（stall 恢复移除）、8c（长任务窗口不误报 + 超长仍 ⚠️）。ack-reactions 24 pass / 4 fail（基线 19/4，4 fail 为既有遗留 queued=⏳ vs 期望 👀，笔记 32 已记载），typecheck 无新增错误。
- `Research`: docs/openclaw-research/33-tool-emoji-and-stall-warning.md — 三症状根因调研与修复验证。

## 0.1.19: 表情「回复时掉 / 完成时不消」双修复（openclaw 调研笔记 32）

- `Bugfix`: **完成但 emoji 没消失**——`removeActiveEmojis`/`removeEmoji` 的 `finally` 无条件删本地 `activeEmojis`：`removeReaction` API 失败（429 限流/网络抖动）时 Discord 上表情还挂着、本地集合已删 → `clear()` 永不重试 → 永久残留。修复：删除成功才删集合，失败保留 + 重试一次 + `console.warn` 日志（可诊断）。
- `Bugfix`: **回复时 emoji 掉了**——`agent_end` 里 `void bridge.endTurn()` 不等待：回答正文还在 throttle（500ms）分块发送时 `setDone()` 已执行，`removeActiveEmojis` 把 🧠/👀 全删（「回复还在输出、表情已经没了」）。修复：先 `await bridge.endTurn()`（回答最终 flush 完成）再进入终态表情。
- `Tests`: 复现测试验证——删除失败重试成功（⏳🧠 最终被删）、连续失败集合保留（可再次清理）。全量 18 测试文件与改动前一致（ack-reactions 4 fail / progress-lane 1 fail 为既有遗留），typecheck 无新增错误。
- `Research`: docs/openclaw-research/32-emoji-drop-and-residue.md — 两症状根因调研（agent_end 时序竞争 + 删除失败静默残留）与修复验证。

 表情生命周期重构 + 思考标签真实性（openclaw 调研笔记 31）

- `Bugfix`: **表情错位/残留根因**——旧实现每次收到消息都重建 `statusReactions` controller 并覆盖旧引用：bot 思考/操作中用户新发消息时，全局 thinking/tool 事件会把 🧠/🛠️ 错挂到新消息（「没思考却有思考标签」），旧消息的 controller 被丢弃后 ⏳👀🧠🛠️ 永久残留。
- `Lifecycle`: 重构为 `activeReactions`（当前 turn 消息的状态机）+ `queuedReactions`（turn 活跃时的新消息只标 ⏳=排队，不进状态机）——对齐 openclaw 每条消息独立 reaction runtime 的生命周期；agent_start 时队首升级为 active（⏳→👀），agent_end/fatal/abort 终态必清理，turn 消息收尾后释放 active。
- `Thinking Truth`: message_update 空 thinking delta 不触发 🧠；thinking_end 总内容 < 20 字符（模型形式化思考）→ `removeThinkingNow()` 立即移除 🧠（新增方法，跳过 1.5s 防抖）——「没思考却有思考标签」的内容侧修复。
- `Uncouple`: 思维行字符预算独立为 `streaming.thinkingMaxChars`（默认 120，openclaw progress.maxLineChars），不再复用 maxLineChars——配置 40 时思考行被切碎（观感生硬）的问题消除。
- `Research`: docs/openclaw-research/31-status-reactions-lifecycle.md — openclaw 原版调研（每条消息独立 controller、finish 必 restoreInitial/setDone、中间表情 debounce 700ms、新版本 Discord 用 embed + accentColor + components 提升视觉）。
- `Lifecycle`: 补充「存活信号」三件套——
  - `Stall Truth`: `setThinking(countsAsActivity?)`——思考对用户不可见（streaming.thinking:false 或 reasoning.enabled:false）时 thinking_delta 不再重置 stall 计时（否则被高频 delta 永远重置），10s ⏳ / 30s ⚠️ 照常出现，用户能分辨「还在跑 vs 卡死」。
  - `Typing Heartbeat`: 思考期间持续发 typing（即使思考行被关闭）——「还活着」的可见信号（节流 10s 复用）。
  - `Restart Notice`: 停机时（SIGTERM/SIGHUP，覆盖 tmux kill-server 场景）尽力发「🔄 服务重启中…」；启动时总是发「✅ 服务已重新上线」（异常退出则提示任务中断）——更新代码重启后 Discord 那边不再「分不清死活」。
- `Tests`: ack-reactions.test 新增 removeThinkingNow（立即移除/无重复移除）与 removeThinking（防抖窗口内不移除/防抖后移除）用例 + stall 可见性联动（思考不可见时 ⏳⚠️ 照常触发 / 可见时重置）。Impact: 全量 18 测试文件，失败集与改动前一致（2 个既有 flaky/遗留用例），typecheck 无新增错误。

## 0.1.17: 修复长回复分块切断代码围栏（Issue #4）

- `Chunk Fence-Aware`: `chunkDiscordText`（src/dispatch/markdown-tables.ts）升级为真正的围栏感知——围栏块（``` / ~~~ 配对）作为最小不可分单元整体保留，表格转换器输出的 ```+ASCII表格+``` 永远不会被切断；非围栏内容按行边界分块；段落超限时内部行切（行完整优先），超长行才硬切 fallback。未闭合围栏也整体保留（避免孤立围栏）。
- `Use It`: draft-stream.ts 投递分块从 `splitChunks`（纯换行感知，src/lanes/lane.ts）切换为 `chunkDiscordText`——围栏感知实现此前存在但从未被使用（Issue #4 根因）。
- `Regression`: markdown-tables.test 新增 3 用例——表格代码块跨切分点围栏成对/表格行不散落、非超长行不切半、未闭合围栏整体保留。Impact: 全量 18 测试文件全绿，typecheck 通过。
## 0.1.16: 按 openclaw 原版重做思考/输出区分（笔记 26）

- `Research`: 调研 openclaw 机制（docs/openclaw-research/26-thinking-answer-separation.md）——核心不是格式花哨，而是**回答投递时 progress 方块折叠成一行小字摘要**（buildProgressSummaryLine：`-# 🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 45s`，-# 为 Discord 小字灰色文本），思考细节不残留；思考行本身是 `🧠 _斜体_`（无 blockquote）；回答为干净独立消息（无分隔线）。
- `Thinking Line`: 撤销 0.1.15 的 `> ` blockquote，恢复 `🧠 _斜体_`（openclaw reasoningLinePrefix 一致）。
- `Collapse Summary`: endTurn 始终把 progress 方块折叠为 openclaw 格式摘要（-# 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns），替代误导的「✅ N 个工具调用完成」。
- `Thought Counting`: 思考段计数改 openclaw closePendingWindowThought 语义——思考窗口闭合时 +1（工具行 commit / endTurn 折叠），多段思考计数正确。
- `Answer Cleanup`: 撤销回答分隔线（━━━），回答消息干净独立（openclaw 无分隔线设计）。
- `Tests`: progress-lane.test 新增折叠摘要用例（-# 格式/多段计数/纯思考 turn），更新无 blockquote 断言。Impact: 全量 17 测试文件全绿，typecheck 通过。

## 0.1.15: 思考/回答视觉区分（笔记 26 续）

- `Thinking Blockquote`: progress 方块里思维行从 `🧠 _斜体_` 改为 `> 🧠 _斜体_`（Discord 引用样式：灰色竖线 + 缩进），与 🛠️ 工具行、回答正文显著区分——不再是一团文字。
- `Answer Separator`: 最终回答首条 flush 前加 ━━ 分隔线（每个 turn 重置），回答消息与思考/进度方块视觉分层。
- `Summary Semantics`: endTurn 折叠摘要只统计真实工具行（纯思考 turn 显示「✅ 处理完成」而非误导的「N 个工具调用完成」）。
- `Tests`: progress-lane.test 断言更新为 blockquote 格式。Impact: 全量 17 测试文件全绿，typecheck 通过。

## 0.1.14: 更多命令本地桥接（笔记 26 续）

- `Whimsy Bridge`: /whimsy status/on/off/reset 本地实现——状态存 ~/.pi/agent/settings.json 的 whimsical 字段（与 pi-agent-extensions/whimsical 同格式双向兼容）；交互调权重（TUI 组件）保持终端引导。新增 src/commands/whimsy.ts + 测试（9 断言）。
- `Exit Aliases`: /bye /exit = /quit 别名（ctx.shutdown()，对齐 whimsical 扩展的退出命令）。
- `Sessions List`: /sessions 只读列表（~/.pi/agent/sessions 最近 15 个会话文件）；切换会话需终端（上游 switchSession 仅 ExtensionCommandContext 可用——命令 ctx，Discord 事件 ctx 拿不到）。
- `Bridge Feasibility Map`: 盘点 88 命令——本地可执行 29 个；prompt 模板本地执行 ~40 个；无法桥接并保持终端引导：answer/files/workflow/review（TUI 交互组件）、btw/llama/loop/chain/run（直接 LLM/工作流调用）、mcp/mcp-auth（凭据交互）、fork/clone/resume/reload/new/reset/navigateTree（上游 API 仅命令 ctx）、share/import/trust/login/logout（无 API）。
- `Tests`: 新增 whimsy.test.mjs。Impact: 全量 17 测试文件全绿，typecheck 通过。

## 0.1.13: /todos 本地实现（方案二，笔记 26）

- `Todos Bridge`: pi 的 /todos 是 TUI 交互界面（依赖 UI mode），Discord 远程调用无法显示 → 新增 src/commands/todos.ts 在桥接层直接读写 .pi/todos/<id>.md（JSON front matter + markdown body，与 pi-agent-extensions/todos 同一存储格式，双向兼容）。支持 /todos list/add <标题>/done <序号|id>/open <序号|id>/show <序号|id>/delete <序号|id>；id 支持 TODO-xxxx 与裸 hex；写前检查 .lock（TUI 正在编辑时拒绝，防覆盖）。todo 目录 = PI_TODO_PATH 或 <cwd>/.pi/todos。
- `Tests`: 新增 test/todos.test.mjs（临时目录隔离：add/list/done/show/delete/存储格式兼容/无效引用，14 断言）。Impact: 全量 16 测试文件全绿，typecheck 通过。

## 0.1.12: /skill 二级分类（subcommand groups，笔记 25 续）

- `Skill Category Groups`: 55 个 skill 按类别分组成 subcommand groups（/skill video hyperframes 两级选择）——Discord 每个命令 options 上限 25（含 subcommand/group），单层 55 个子命令 PUT 被拒（BASE_TYPE_MAX_LENGTH: Must be 25 or fewer）。分组：video 19 / dev 14 / fabric 12 / tools 10（未命中名单兜底），各 ≤25。新增 buildSkillGroups（SKILL_CATEGORY_NAMES 名单 + tools 兜底 + 每组长上限 25）。
- `Two-level Interaction`: handleInteraction 解析 group(type=2) → subcommand(type=1) 两级，命中后本地执行 SKILL.md 指令。
- `Tests`: pi-commands.test 新增分组用例（类别归属/tools 兜底/每组 ≤25/56 个规模摊分）。Impact: 全量测试 15 文件全绿，typecheck 通过。

## 0.1.11: /skill 子命令分类（笔记 25 续）

- `Skill Subcommand Grouping`: 55 个平铺 /skill-xxx 收拢为单个 /skill 命令 + 每 skill 一个子命令（/skill github /skill reading…）。新增 extractSkillSubcommands（子命令名 = nativeName 去 skill- 前缀，去重冲突防御）+ findSkillBySubcommand（分发查询）；handleInteraction 识别 type=1 子命令 → 本地执行 SKILL.md 指令。guild 注册 PUT 全量覆盖，旧 55 个顶级命令自动替换。Impact: Discord 命令面板清爽分类，/skill 下拉即选。
- `Tests`: pi-commands.test 新增子命令用例（只提取 skills、去前缀、唯一、大小写不敏感查询）。Impact: 全量测试 15 文件全绿，typecheck 通过。

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

- test: code assist verify (临时测试条目)
