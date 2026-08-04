# Changelog

## 0.1.2: pi 命令系统接入（原生移植，笔记 20/21）

- `Native Command Handling`: 新增完整命令系统——文本 `/xx` 消息拦截（normalize 冒号语法/mention 剥离/别名 → canonical，移植 openclaw commands-registry-normalize + command-detection）与 Discord 原生命令（启动时 PUT /applications/{id}/commands 批量注册，INTERACTION_CREATE 分发，ephemeral 回复）。Impact: Discord 里 `/stop`、`/compact`、`/think`、`/model`、`/status` 等命令本地执行，不再被当普通消息发给 agent 导致「直接未响应」。
- `Command Set`: 13 个内置命令（help/commands/status/stop/compact/think/model/tools/usage/name/quit/new/reset），定义结构移植 openclaw ChatCommandDefinition（args/captureRemaining/tier/choices）。Impact: 覆盖 pi 扩展 API 可实现的核心命令全集。
- `Local Execution`: 命令经 CommandExecutionCtx（从事件 ctx 捕获的 abort/compact/shutdown/setModel/setThinkingLevel/setSessionName 能力面）本地执行，不进模型；`/new`、`/reset` 明确回复「请在终端执行」（上游 ExtensionAPI 无会话替换能力，BACKLOG 已记录）。Impact: 命令即时响应，无需 agent turn。
- `Transport`: discord-rest.ts 新增 registerApplicationCommands/createInteractionResponse/createInteractionFollowUp；gateway 新增 INTERACTION_CREATE 分发；types.ts 新增 interaction/application-command 最小面（discord-api-types v10 子集）。Impact: 零依赖实现完整 slash 命令生命周期。
- `Docs`: 新增 docs/openclaw-research/20-native-commands.md（openclaw 命令处理全链路调研 + 移植决策）与 21-pi-commands-fullset.md（pi 命令全集盘点 + 最终命令集）。

