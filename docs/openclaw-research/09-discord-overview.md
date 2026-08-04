# OpenClaw 调研笔记 09：Discord 扩展总览

> 位置：openclaw/extensions/discord（639 个 .ts，vs telegram 493 个）；仓库 /home/ubuntu/data/openclaw

## 定位

官方 Discord channel 插件：服务器/频道/DM/斜杠命令/应用事件。独立包 @openclaw/discord。

## 依赖（package.json）

discord-api-types 0.38.52（类型+常量）、ws 8.21.1（Gateway）、undici 8.9.0（REST）、@discordjs/voice + libopus-wasm（语音）、mdast-util-from-markdown（markdown 解析）、p-map、zod、typebox。

## 入口（index.ts / openclaw.plugin.json）

- defineBundledChannelEntry({ id:"discord", plugin: channel-plugin-api, runtime: runtime-setter-api, accountInspect, registerFull: activities+subagent-hooks })
- channel: { id:"discord", configuredState.env.anyOf:["DISCORD_BOT_TOKEN"], approvalFlags:["native"] }
- activation.onStartup:false；contracts.tools: show_widget/discord_widget；transcriptSourceProviders: discord-voice

## 模块地图

| 层 | 文件 | 职责 |
|---|---|---|
| 传输 | internal/rest.ts, internal/gateway.ts, internal/client.ts | REST 客户端 + Gateway WS |
| 入站 | monitor/message-handler.ts, monitor/ingress.ts, monitor/listeners.ts | 消息事件 → 调度 |
| 出站 | outbound-adapter.ts, outbound-payload.ts, send.*.ts | 投递/分块/组件/反应 |
| 流式 | draft-stream.ts, preview-streaming.ts | 草稿编辑流（2000 字符） |
| 会话 | monitor/thread-bindings*.ts, monitor/threading*.ts | 线程绑定/自动线程 |
| 命令 | internal/commands.ts, monitor/native-command*.ts | 斜杠命令/原生命令 |
| 审批 | approval-*.ts | 原生审批 UI |

## 关键差异 vs Telegram（移植要点）

1. **2000 字符上限**（Telegram 4096）→ chunkSize/流式上限全改
2. **事件源**：Gateway WebSocket（intents + heartbeat + resume），无 long polling
3. **消息标识**：channel_id + message id（snowflake 字符串），非 chat_id(number)
4. **编辑**：PATCH /channels/{id}/messages/{mid}；删除 DELETE；打字 PUT /channels/{id}/typing
5. **回复**：message_reference { message_id, fail_if_not_exists:false }
6. **提及控制**：allowed_mentions: { parse: [] }（预览禁提及）
7. **格式**：原生 Markdown（非 HTML parse_mode），需转义 + 表格降级
8. **线程**：autoThread（60/1440/4320/10080 分钟归档）、thread bindings 持久化
