# OpenClaw 调研笔记 14：Discord 出站 + 线程

> 位置：extensions/discord/src/outbound-adapter.ts, send.*.ts, monitor/threading*.ts

## 出站适配（outbound-adapter.ts）

- DISCORD_TEXT_CHUNK_LIMIT = 2000
- resolveDiscordWebhookIdentity：username（截断 80 utf16）+ avatarUrl → 线程绑定 webhook 身份
- sendDiscordOutboundPayload → send.messages.ts（createChannelMessage/editChannelMessage/createThread/pin/search）
- 回复引用：resolveDiscordReplyReference → message_reference
- 审批：native approval UI（按钮组件）
- send receipt：createDiscordSendReceipt（platformMessageIds + channelId + kind）

## 线程（threading.ts / thread-bindings*.ts）

- **自动线程**：threading.auto-thread.ts —— maybeCreateDiscordAutoThread；autoThreadName: "message"（消息文本命名）| "generated"（LLM 标题）；autoArchiveDuration: 60/1440/4320/10080 分钟；includeThreadStarter
- **线程绑定**：thread-bindings.manager.ts —— 会话 ↔ Discord thread 持久映射（webhook 身份、会话路由、persona）；生命周期：创建/归档/关闭/清理；session-adapter 对接 agent session
- 活跃 turn → 线程路由：active-turn-thread-route.ts

## 组件/交互（可后置）

- internal/components.ts：按钮/选择菜单组件构建；component-custom-id.ts 编解码
- internal/interactions.ts：slash command / button / modal 交互响应
- native-command*.ts：/model /think /status 等原生命令（approval 场景用）
- 语音（voice/）：STT-TTS / agent-proxy / bidi，DAVE 加密 —— 移植优先级最低

## 移植优先级建议（到 pi 的最小可行）

1. P0：REST 发送/编辑/删除/typing + Gateway 收消息 + 2000 分块 + Markdown 直通
2. P1：回复引用（message_reference）、提及禁用、流式 minInitialChars/generation
3. P2：自动线程、thread bindings（会话持久化）、反应 ack
4. P3：斜杠命令、组件审批、语音
