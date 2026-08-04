# Plan: pi-telegram-openclaw → pi-discord-openclaw

Date: 2026-08-04
Status: 执行中
用户要求: ①解耦 ②代码简单 ③性能好 ④以 openclaw 源码为蓝本复写 ⑤就地改造+改名+GitHub 同步

## 改造蓝图

```
pi-discord-openclaw/
├── index.ts                    # 重写：Discord bridge 入口（gateway + rest + inbound + activity）
├── src/
│   ├── config.ts               # 改：读 discord.json（openclawStyle + token/channels）
│   ├── index.ts                # 保留：activity 事件 → 流式 lane 编排
│   ├── transport/              # 新：以 openclaw extensions/discord 为蓝本
│   │   ├── discord-rest.ts     # REST 客户端（原生 fetch、429 retry-after、Bot header）
│   │   ├── discord-gateway.ts  # WS Gateway（原生 WebSocket、intents、heartbeat、resume）
│   │   └── types.ts            # 最小 Discord 类型
│   ├── dispatch/               # 保留流式编排，delivery 换成 Discord
│   │   ├── dispatch.ts         # TurnManager（小改类型）
│   │   ├── discord-api-adapter.ts  # 新：Discord surface → MountDeps
│   │   └── activity-adapter.ts     # 保留
│   ├── draft/draft-stream.ts   # 保留 + 适配（chunkSize 1900、minInitialChars、generation）
│   ├── reasoning/ progress/ inbound/ lanes/  # 保留（transport 无关）
├── lib/                        # 删除（Telegram 专属：bus/menu/polling 等 56 模块）
├── vendor/                     # 删除或保留为参考（不在构建内）
├── api/                        # 删除 Telegram 公开 API 膜，exports 只留 "."
├── tests/ test/                # 删 Telegram 测试；保留/适配流式 mjs 测试；新增 transport 测试
└── docs/plans/                 # 本计划
```

## 技术选型（简单+性能）

- REST: node 22 原生 fetch（零依赖），Bot token header，v10 API，429 retry-after 解析
- Gateway: node 22 原生 WebSocket（零依赖），intents = Guilds|GuildMessages|DirectMessages|MessageContent，
  heartbeat 41s、resume session、断线重连
- 依赖收敛：移除 grammy 等 Telegram 依赖；dev 仅 typescript/@types/node

## 任务批次

### Batch 1: 骨架改名 + 清理
- [ ] 1.1 package.json: name/description/keywords/repository → pi-discord-openclaw；exports 只留 "."
- [ ] 1.2 删除 lib/、vendor/、api/、tests/（Telegram 专属）
- [ ] 1.3 README.md / AGENTS.md / CHANGELOG.md 术语更新（Telegram → Discord）
- [ ] 1.4 更新 ~/.pi/agent/settings.json packages 注册路径（../../pi-discord-openclaw）

### Batch 2: transport 层（openclaw 蓝本）
- [ ] 2.1 src/transport/types.ts: ChannelId/MessageId(snowflake)、APIMessage 最小面
- [ ] 2.2 src/transport/discord-rest.ts: createChannelMessage/editChannelMessage/deleteChannelMessage/sendChannelTyping
- [ ] 2.3 src/transport/discord-gateway.ts: 连接/identify/heartbeat/resume/MESSAGE_CREATE 分发
- [ ] 2.4 transport 单测（mock fetch/WebSocket）

### Batch 3: 适配层 + 流式适配
- [ ] 3.1 src/dispatch/discord-api-adapter.ts（channelId 解析、messageId string）
- [ ] 3.2 src/config.ts: discord.json + DISCORD_BOT_TOKEN + channel allowlist
- [ ] 3.3 draft-stream: DEFAULT_CHUNK_SIZE 1900、minInitialChars、generation 代际防串（openclaw 机制）
- [ ] 3.4 markdown 直通 + 转义（rich-text 替换 HTML 思路）

### Batch 4: 入口重写
- [ ] 4.1 index.ts 重写：gateway 连接 → 消息过滤（bot self/channel）→ inbound → pi
- [ ] 4.2 activity 事件 → 流式 lane → REST 发送/编辑
- [ ] 4.3 保留 openclaw-mount 式解耦挂载

### Batch 5: 测试全绿
- [ ] 5.1 适配 test/*.mjs（draft-stream/dispatch/mount/reasoning/progress/debounce）
- [ ] 5.2 npm run typecheck + npm test 全绿

### Batch 6: 文档 + GitHub 同步
- [ ] 6.1 CHANGELOG 记 Discord 首版；README 产品化
- [ ] 6.2 gh repo rename → pi-discord-openclaw（或新建）+ push
- [ ] 6.3 settings.json 注册验证（pi doctor / 重启会话）

## 验证标准

- typecheck 0 error；npm test 全绿
- transport 单测覆盖：rest 发送/编辑/429；gateway identify/heartbeat/消息分发
- GitHub 上 pi-discord-openclaw 仓库可见，master 最新
