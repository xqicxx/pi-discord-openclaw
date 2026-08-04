# OpenClaw 调研笔记 15：Telegram → Discord 改造映射

> 把 pi-telegram-openclaw 改为 pi-discord-openclaw 的逐项对照

## 传输 API 映射（telegram-api-adapter → discord-api-adapter）

| Telegram（现 fork） | Discord（openclaw 参考） | 备注 |
|---|---|---|
| sendMessage{chat_id,text,parse_mode:HTML} | createChannelMessage{channel_id, content, allowed_mentions, message_reference} | snowflake 字符串 ID |
| editMessageText{chat_id,message_id,text} | editChannelMessage{channel_id,message_id,content} | 2000 上限 |
| deleteMessage(chatId,messageId) | deleteChannelMessage(channelId,messageId) | |
| sendChatAction(chatId) | sendChannelTyping(channelId) | REST PUT /typing |
| getUpdates long poll | Gateway WS（MESSAGE_CREATE） | 无轮询 |
| reply_to_message_id | message_reference{message_id,fail_if_not_exists:false} | |
| parse_mode HTML + 转义 | 原生 Markdown + 转义 + 表格降级 | |
| 4096 分块（chunkSize 3800） | 2000 分块（建议 1800-1900 留余量） | maxLines 17 |
| thread_id（forum topic） | autoThread + thread bindings | |

## 配置映射（src/config.ts + 读取路径）

- telegram.json openclawStyle → discord.json openclawStyle（或同一 schema 换文件名）
- 环境变量 TELEGRAM_BOT_TOKEN → DISCORD_BOT_TOKEN（可选 applicationId）
- chatId 解析 → channelId 解析（可复用 resolveChatId 模式）

## 保留不动（transport 无关）

- src/index.ts 的 pi.hooks.onActivity 链路（agent-start/reasoning-delta/assistant-text-delta/tool-*/agent-end/agent-settled）
- DraftStreamManager / ReasoningLane / ProgressLane / InboundDebouncer 状态机
- dispatch 的 activity-adapter / reasoning-command / preview-streaming / lane-delivery-state
- 上游 vendor/（pi-telegram fork）→ 可作为参照保留或移除，Discord 版需要新的 bridge 骨架

## 需要新写

1. src/transport/discord-rest.ts：REST 客户端（Bot header、429 retry-after、gzip）
2. src/transport/discord-gateway.ts：WS 客户端（intents、heartbeat、resume、重连）
3. src/dispatch/discord-api-adapter.ts：API surface → MountDeps
4. src/draft/ 调整：2000 上限、minInitialChars、generation 代际
5. src/format/：markdown 直通 + 转义 + 表格降级 + fence 分块
6. config 读取：discord.json + DISCORD_BOT_TOKEN

## 风险点

- Gateway intents 需要在 Discord 开发者后台开启（MessageContent intent 需审核/白名单）
- 2000 字符 + 17 行的分块参数需要实测（emoji/中文 utf16 计数）
- 回复消息引用在私聊/频道行为不同（fail_if_not_exists 处理）
- 速率：Discord 单通道 5 msg/5s（burst 有惩罚）→ throttle 1200ms 是参考值，长文本编辑流不受限（编辑不占 send 限流）
