# OpenClaw 调研笔记 23：Status Reactions 完整原生移植（表情系统）

> 用户需求：OpenClaw 表情很丰富（收到消息立即 👀），当前移植版表情简陋且
> 时序不对——"人还没处理的就没有表情，特别是那个眼睛，已经进入队列的才有的
> 表情，容易让人误会"。要求原生移植完整表情状态机。

## 1. 源码位置

- 控制器：`dist/channel-feedback-ChYFAgPX.js`（src/channels/status-reactions.ts）
- ack 门控：`dist/ack-reactions-Pw4-TsUB.js`（src/channels/ack-reactions.ts）
- 接线：`dist/message-handler.process-C5Yiltgh.js`（extensions/discord/src/monitor/message-handler.process.ts）
- 文档：docs/tools/reactions.md、docs/channels/discord.md

## 2. 默认表情全集（DEFAULT_EMOJIS，13 个）

| 状态 | 方法 | 表情 |
|---|---|---|
| 排队 | setQueued | 👀（immediate，收到消息立即） |
| 思考 | setThinking | 🧠 |
| 工具(通用) | setTool | 🛠️ |
| 编码 | （工具分类） | 💻 |
| 网络 | （工具分类） | 🌐 |
| 部署 | （工具分类） | 🛫 |
| 构建 | （工具分类） | 🏗️ |
| 礼宾/浏览器 | （工具分类） | 💁 |
| 完成 | setDone | ✅（终态，hold 1500ms 后清理） |
| 错误 | setError | ❌（终态，hold 2500ms 后清理） |
| 卡住(软) | stallSoft | ⏳（10s 无活动） |
| 卡住(硬) | stallHard | ⚠️（30s 无活动） |
| 压缩 | setCompacting | 🗜️ |

## 3. 默认时序（DEFAULT_TIMING）

- debounceMs: 700 —— 中间状态（thinking/tool）防抖合并；终态/排队/stall 立即
- stallSoftMs: 10000 —— 10s 无活动 → ⏳
- stallHardMs: 30000 —— 30s 无活动 → ⚠️
- doneHoldMs: 1500 —— ✅ 停留 1.5s 后移除/恢复
- errorHoldMs: 2500 —— ❌ 停留 2.5s 后移除/恢复

## 4. 工具名 → 表情分类（resolveToolEmoji）

按 token 包含匹配（normalized.toLowerCase().includes(token)），优先级：
deploy > build > concierge > web > coding > tool：

- CODING_TOOL_TOKENS: exec/process/read/write/edit/session_status/bash → 💻
- WEB_TOOL_TOKENS: web_search/web-search/web_fetch/web-fetch/browser → 🌐
- DEPLOY_TOOL_TOKENS: fastlane/deploy/upload/testflight/ship/release/publish/distribute → 🛫
- BUILD_TOOL_TOKENS: build/compile/xcode/swift/gradle/cargo/make/cmake/webpack/vite/tsc/lint → 🏗️
- CONCIERGE_TOOL_TOKENS: navigate/click/fill/screenshot/scroll/page/form/puppeteer/playwright/selenium/chromedp → 💁
- 其余 → 🛠️
- emojiOverrides 可按分类覆盖；TOOL_DISPLAY_CONFIG.tools 精确名匹配优先

## 5. 控制器核心机制（createStatusReactionController，全部移植）

1. **Promise 链串行**：所有表情操作 enqueue 进 chainPromise，杜绝并发 API 调用乱序
2. **Debounce**：中间状态 scheduleEmoji 700ms 防抖；immediate 标志（排队/stall/终态）立即执行
3. **Stall timers**：每次活动重置；10s → ⏳、30s → ⚠️（immediate）
4. **终态保护**：finishWithEmoji 置 finished=true，后续 setXxx 全部忽略
5. **延迟移除**：activeEmojis Set 记录所有已加表情；中间状态只增不减（避免闪烁）；
   finishWithEmoji 时 removeActiveEmojis({ keepEmoji: 终态 }) —— 移除除终态外全部
6. **restoreInitial**：回到初始表情（👀）并移除其他（用于"完成但保留 ack"场景）
7. **clear**：移除全部活跃表情（用于 removeAckAfterReply 场景）

## 6. 接线时序（message-handler.process.ts 原样）

1. 收到消息 → `queueInitialDiscordAckReaction`：
   - statusReactions 启用 → `setQueued()`（👀 立即）
   - 否则 → ackReaction（👀）单独设置
2. 回复开始（onDiscordReplyStart）→ `setThinking()`
3. reasoning 流（onReasoningStream）→ `setThinking()`
4. 工具开始（onToolStart）→ `setTool(payload.name)`（带工具名分类）
5. 压缩开始（onCompactionStart）→ `setCompacting()`；结束 → `cancelPending()` + `setThinking()`
6. finally 收尾：
   - 中断 → removeAckAfterReply ? clear() : restoreInitial()
   - 错误/最终投递失败 → `setError()`（❌）
   - 正常 → `setDone()`（✅）
   - removeAckAfterReply → sleep(done/errorHoldMs) 后 `clear()`
   - 否则 → `restoreInitial()`（回到 👀）

## 7. 当前 pi-discord-openclaw 差距（移植前）

| 项 | 现状 | OpenClaw 原生 |
|---|---|---|
| 收到消息 | queueInitialAckReaction 直接 setReaction 👀（不走 controller） | setQueued() 走 controller |
| 表情集合 | 5 个（queued/thinking/tool/done/error） | 13 个（含分类/卡住/压缩） |
| 工具表情 | setTool() 无名字 → 永远 🛠️ | setTool(toolName) 分类 |
| 表情管理 | 先移除旧再加新（替换式） | 只增不减，终态统一清理 |
| 终态 | ✅ 永远留着（无 hold/清理） | hold 1.5s/2.5s 后 clear 或 restoreInitial |
| 错误路径 | gateway fatal 只 console.error（不接 ❌） | setError() |
| debounce | 无（每次立即 API 调用） | 700ms 中间状态防抖 |
| stall | 无 | ⏳ 10s / ⚠️ 30s |
| compacting | 无 | 🗜️ |
| 终态保护 | isFinished 但后续仍可 set | finished 后全部忽略 |
| restoreInitial | 无 | 有（回 👀） |
