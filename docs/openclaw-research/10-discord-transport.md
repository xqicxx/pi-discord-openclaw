# OpenClaw 调研笔记 10：Discord 传输层（REST + Gateway）

> 位置：extensions/discord/src/internal/{rest,gateway,client}.ts

## REST 客户端（internal/rest.ts）

RequestClient 关键能力：
- tokenHeader: "Bot" | "Bearer"；baseUrl + apiVersion（v10）；自定义 fetch（proxy）
- **队列+调度**：RestScheduler，priority lanes（maxQueueSize/staleAfterMs/weight），maxConcurrency
- 限流重试：RateLimitError + retry-after（秒/毫秒解析），maxRateLimitRetries
- gzip 响应（gunzipSync）、响应大小限制（readResponseWithLimit）
- runtimeProfile: "serverless" | "persistent"

## Gateway（internal/gateway.ts）

- 基于 EventEmitter + ws 包；discord-api-types GatewayOp/Dispatch/Intent 常量
- intents：Guilds | GuildMessages | DirectMessages | MessageContent 等（客户端按需组合）
- 生命周期：identify（限频器 sharedGatewayIdentifyLimiter）→ heartbeat 定时 → READY → dispatch
- **断线恢复**：resume（session_id + sequence），canResumeAfterGatewayClose / isFatalGatewayCloseCode 判定
- 重连原因：close / identify / invalid-session / reconnect-opcode / zombie
- GatewaySendLimiter（发送限频）、GatewayHeartbeatTimers、GatewayReconnectTimer

## 消息事件（internal/listeners.ts）

- BaseListener: ReadyListener / MessageListener / ReactionListener / VoiceStateListener …
- DiscordMessageDispatchData: { id, channel_id, guild_id?, message, author, member{roles,nick}, guild?, channel? }
- 事件流：Gateway MESSAGE_CREATE → mapGatewayDispatchData → handler

## 移植到 pi 的最小面

```ts
// 上游语义（对应我们 fork 的 TelegramApiSurface）
createChannelMessage(rest, channelId, { body: { content, allowed_mentions?, message_reference?, flags? } }) // → { id }
editChannelMessage(rest, channelId, messageId, { body: { content, allowed_mentions?, flags? } })
deleteChannelMessage(rest, channelId, messageId)
sendChannelTyping(rest, channelId)
createThread(rest, channelId, { name, autoArchiveDuration, message? })
getChannelMessage / listChannelMessages / searchGuildMessages / pin
```

## 与 Telegram polling 对照

| | Telegram (我们 fork) | Discord |
|---|---|---|
| 事件源 | getUpdates long poll（lib/polling.ts，30s 超时，update_id 偏移） | Gateway WS（intents + resume） |
| 去重 | update_id 单调 | message id + sequence |
| 打字 | sendChatAction | PUT typing（5s 超时封装 sendTyping） |
| 限流 | 409/retry_after 洪水控制 | 429 retry-after + 队列调度 |
