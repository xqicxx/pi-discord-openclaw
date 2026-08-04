# OpenClaw 调研笔记 13：Discord 入站链路

> 位置：extensions/discord/src/monitor/*

## 消息处理器（message-handler.ts）

- createDiscordMessageHandler：dispatcher（createDiscordMessageDispatcher）+ ingress monitor（createDiscordIngressMonitor）组合
- admission 并发集合：accepting 开关，deactivate 时 Promise.allSettled 排空

## ingress.ts（持久入站 + 重放）

- DISCORD_INGRESS_PAYLOAD_VERSION = 1；DISCORD_INGRESS_DRAIN_INTERVAL_MS = 1000
- payload: { version, receivedAt, rawMessage: APIMessage }；eventId/laneKey 从 rawMessage 提取
- 基于 plugin-sdk ChannelIngressMonitor（持久队列 + 崩溃重放）—— 比 Telegram 版多了持久化

## 消息处理流水线（message-handler.process*.ts）

process.ts 主干 → 各 preflight 阶段：
- preflight.ts：bot-self-filter（自己消息跳过）、channel-access（allowlist）、DM preflight、thread 路由
- hydration：消息历史补全（多轮上下文）
- draft-preview / progress / reasoning / final：对应流式阶段
- ack（反应 ✅）/ reply-runtime / session-routing
- 队列 + batch-gate + abort-retry/skip + recovery

## 与 Telegram 对照

| 阶段 | Telegram | Discord |
|---|---|---|
| 入口 | update → bot-message-dispatch | gateway MESSAGE_CREATE → dispatcher |
| 过滤 | allow-from | allowlist（guild/channel/user/role）+ bot self filter + 提及策略 |
| 上下文 | message + reply chain | message hydration（历史拉取） |
| 确认 | 无/回复 | reaction ack（✅） |
| 线程 | topic/thread_id | 自动线程（autoThread）+ thread bindings |

## 移植最小面

- MESSAGE_CREATE → 提取 { channel_id, id, author, content, member.roles, guild_id } → 我们的 InboundDebouncer.push
- 过滤：非 bot 自己 + channel allowlist（可先用环境变量简化）
- 后续 turn 消息去重（message id 集合，仿 update_id）
