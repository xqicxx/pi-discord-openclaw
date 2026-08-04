# 20 — Native Command Handling（原生命令处理）移植调研

> 任务 28652「Implement core Discord command handling」：pi-discord-openclaw 中 `/xx` 命令
> （`/stop` 等）完全未响应。本文档调研 OpenClaw 的完整命令处理链路，确定原生移植方案。

## 1. 根因

pi-discord-openclaw 的 index.ts **没有任何命令处理**：

- MESSAGE_CREATE → 过滤 → ack(👀) → `bridge.pushUserMessage(content)` → `pi.sendUserMessage(text)`
- 所有消息（包括 `/stop`、`/help`）都被当作普通用户消息发给 agent → agent 不响应（或当作文本响应）→「直接未响应」
- Gateway 只处理 MESSAGE_CREATE/MESSAGE_UPDATE，**没有 INTERACTION_CREATE**，也没有注册任何 application commands

## 2. OpenClaw 命令处理全链路（源码位置）

### 2.1 命令注册表（src/auto-reply/commands-registry*.ts）

- `ChatCommandDefinition`（commands-registry.types.ts）：
  `key / nativeName / nativeAliases / description / args / acceptsArgs / textAliases / scope("text"|"native"|"both") / category / tier("essential"|"standard"|"power")`
- `CommandArgDefinition`：`name/description/type("string"|"number"|"boolean")/required/choices/captureRemaining`
- `buildBuiltinChatCommands()`（commands-registry.shared.ts）—— 全部内置命令定义：
  help / commands / tools / skill / status / goal / diagnostics / allowlist / approve / btw /
  export-session / export-trajectory / tts / whoami / session / subagents / focus / unfocus /
  agents / steer / config / mcp / plugins / debug / usage / **stop** / restart / activation /
  send / **reset** / **new** / name / compact / think / verbose / trace / fast / reasoning /
  elevated / exec / model / queue / sleep / wake ...
- 辅助函数（commands-registry.ts / commands-registry-normalize.ts）：
  `findCommandByNativeName / parseCommandArgs / buildCommandTextFromArgs / serializeCommandArgs`
- 文本命令规范化 `normalizeCommandBody`（commands-registry-normalize.ts）：
  - `/cmd: value` 冒号语法 → `/cmd value`
  - `/cmd@bot` mention 剥离
  - 多行消息：首行命令 + tail 保留（skill/learn 用换行，reset 用空格压平）
  - 大小写不敏感（lowercase 匹配）
- 文本命令检测（command-detection.ts）：
  `hasControlCommand / isControlCommandMessage / isSessionBoundaryCommandText(/^\/(new|reset)/) / hasInlineCommandTokens`
- 文本命令开关（commands-text-routing.ts）：`shouldHandleTextCommands` — `commands.text !== false` 时启用（无原生命令的表面即使 false 也启用）

### 2.2 原生命令（extensions/discord/src/monitor/native-command*.ts）

- `createDiscordNativeCommand`（native-command.ts）：构建 discord.js `Command` 子类
  - `name/description/descriptionLocalizations/defer=false/ephemeral=default/options`
  - options 由 `buildDiscordCommandOptions`（native-command.options.ts）生成：
    - String/Number/Boolean 类型映射（ApplicationCommandOptionType）
    - 静态 choices ≤25；>25 或动态 → autocomplete
    - 描述截断 100 字符（Discord 限制，truncateUtf16Safe）
  - `run(interaction)`：defer（ephemeral）→ `readDiscordCommandArgs`（native-command.args.ts：
    options.getString/getNumber/getBoolean 读值）→ `parseCommandArgs` → `buildCommandTextFromArgs`
    → `dispatchDiscordCommandInteraction`
- `dispatchDiscordCommandInteraction` 授权链（native-command.ts + native-command-auth.ts + allow-list.ts）：
  channel enabled/allowed → groupPolicy → DM policy/pairing → guild allowlist
  （commands.allowFrom / ownerAllowFrom / channel config / member roles）
- 执行：`/stop /new /reset /compact` 等走 `dispatchChannelInboundTurn`（命令作为本地 turn，
  不进模型）；回复经 `deliverDiscordInteractionReply`（native-command-reply.ts）：
  - reply/followUp 二选一（`preferFollowUp`：slash 命令 defer 后必须 followUp）
  - 分块（textLimit 2000 / maxLinesPerMessage / chunkMode）
  - `safeDiscordInteractionCall`：Unknown interaction (10062) 容错
- 部署：`deployDiscordCommands`（provider.deploy.ts）— PUT /applications/{id}/commands 批量注册
- bypass（native-command-bypass.ts）：/new /reset 可绕过 ACP guild guards

### 2.3 文档要点（docs/channels/discord.md + docs/tools/slash-commands.md）

- `commands.native` 默认 "auto"（Discord 开启注册）；false 跳过注册
- `commands.text` 默认 true（文本 `/cmd` 消息）
- 默认 slash 命令回复 ephemeral: true（channels.discord.slashCommand.ephemeral）
- 三类命令：Commands（独立消息）/ Directives（内联剥离，如 /think /fast）/ Inline shortcuts（/help /status 嵌入剥离）
- 授权：native command auth 与普通消息 allowlist 相同

## 3. pi 侧能力盘点（@earendil-works/pi-coding-agent）

- ExtensionAPI：sendUserMessage(content,{deliverAs:"steer"|"followUp"}) / registerCommand /
  setModel / getThinkingLevel / setThinkingLevel / getCommands / setSessionName / exec
- 事件 handler ctx = ExtensionContext：**abort() / isIdle() / compact() / shutdown() /
  getContextUsage() / model / scopedModels / thinkingLevel / signal**
- 命令 handler ctx = ExtensionCommandContext：额外 newSession() / fork() / switchSession() /
  waitForIdle() / navigateTree() / reload()（仅 registerCommand 命令触发时可用）

## 4. 移植决策（能抄就抄，除非有更高效做法）

| OpenClaw 原始 | pi-discord 移植 | 说明 |
|---|---|---|
| ChatCommandDefinition + buildBuiltinChatCommands | src/commands/registry.ts 原样移植定义结构，内置命令裁剪为 pi 可实现集 | 保留 args/captureRemaining/tier 语义 |
| normalizeCommandBody | src/commands/text-commands.ts 原样移植 | 冒号语法/mention/多行 tail |
| command-detection.ts | 移植 hasControlCommand/isControlCommandMessage/isSessionBoundaryCommandText | 文本 /xx 拦截 |
| native-command.options.ts | 移植 buildDiscordCommandOptions（纯函数，零依赖） | String/Number/Boolean/choices |
| native-command-reply.ts | 移植 safeCall 语义到 REST：interaction callback + followUp | 零依赖 REST 版 |
| deployDiscordCommands | index.ts 启动时 PUT /applications/{id}/commands | application id 从 READY.application.id 取 |
| dispatchChannelInboundTurn | 本地命令执行器 + pi 事件 ctx（abort/compact/...） | 不走模型 |
| allowlist 授权链 | 简化：沿用 conn.channels allowlist + owner 配置 | 与消息授权一致 |

**命令集（移植）**：help / commands / status / stop / compact / think / model / verbose / debug
（pi 可实现的本地命令）；/new /reset 因事件 ctx 无 newSession → 明确回复不支持并引导。

## 5. 实现清单

1. src/commands/registry.ts — 命令定义 + 注册表 + parse/serialize
2. src/commands/text-commands.ts — normalizeCommandBody + 检测（抄 OpenClaw）
3. src/commands/options.ts — buildDiscordCommandOptions（抄 OpenClaw）
4. src/commands/handler.ts — 命令执行（abort/compact/status/help/think/model）
5. src/transport/types.ts — interaction 类型（抄 discord-api-types 最小面）
6. src/transport/discord-rest.ts — registerApplicationCommands / createInteractionResponse / followUp
7. src/transport/discord-gateway.ts — INTERACTION_CREATE 事件
8. index.ts — 文本命令拦截 + slash 注册 + interaction 分发
9. test/commands.test.mjs — registry/normalize/options 单测
