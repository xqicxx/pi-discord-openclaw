# OpenClaw 连续输入与状态反馈机制调研（笔记 30）

> 2026-08-06 · 调研对象：openclaw 官方源码（/tmp/openclaw-src，v2026.7.1-2）+ 本地 dist + pi-discord-openclaw
> 背景：用户反馈 ① 连续输入时 ack 表情👀 误导以为"同时在处理"；② progress 方块（思考/工具）不消失；③ 消息截断。

## 一、openclaw 的 inbound 处理（源码实锤）

### 1. 入站去抖（messages.inbound）
- 配置：`messages.inbound.debounceMs`（全局）+ `byChannel`（按渠道覆盖）
- 解析：`resolveInboundDebounceMs` = override ?? byChannel ?? base ?? **0**（未配置=不合并）
- `shouldDebounceTextInbound`：带媒体/空文本/控制命令不合并
- Telegram 额外有 text-fragment 缓冲：间隙 ≤1500ms 且 message_id 连续 → 合并（上限 12 条 / 50000 字符）

### 2. 忙时队列（messages.queue）—— 连续输入的核心
`resolveQueueSettings`（dist queue-C2HxHfMa.js）：
- **默认 mode = "steer"**（不是 interrupt！）
- queue debounce 默认 **500ms**
- cap 默认 **20**，超限 drop 默认 **"summarize"**（摘要丢弃最旧）

四种 mode（`src/config/types.queue.ts`）：
| mode | 行为 |
|---|---|
| steer（默认）| 新消息注入活跃 run（转向）|
| followup | 排队，当前 run 结束后处理 |
| collect | 批量合并兼容消息 |
| interrupt | abort 活跃 run，立即处理新消息 |

`resolveActiveRunQueueAction`（dist typing-mode-C35PNSLH.js）：
```js
if (!params.isActive) return "run-now";      // 无活跃 run → 立即
if (params.isHeartbeat) return "drop";
if (params.resetTriggered) return "run-now";
if (params.shouldFollowup) return "enqueue-followup";  // steer/followup/collect → 排队
return "run-now";                              // interrupt 模式 → 中断
```
run-now 时：`abortActiveRun`（abort 活跃 run）+ `waitForActiveRunEnd`（REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS 等它收尾）。

### 3. ack / 状态表情（status-reactions + ack-reactions）
- 👀 = **queued**（收到消息即设；排队中也显示它，直到被处理才切换 thinking）
- 🧠 thinking → 🛠️/💻/🌐/🏗️/🛫/💁（工具分类）→ ✅ done（停留 1.5s 后清理）/ ❌ error（2.5s）
- 10s 无活动 → ⏳ stallSoft；30s → ⚠️ stallHard
- 中间状态 debounce 700ms；终态保护（done/error 后忽略后续状态）
- 完成/错误后：`removeActiveEmojis`（移除除终态外全部）→ `restoreInitial` 回到 👀 或 clear

**关键结论：openclaw 的 👀 就是"排队中"语义**——连续输入时排队消息显示 👀 是正确行为，
不是"同时在处理"。pi-discord 移植了同一套（ack-reactions.ts 笔记 23）。

### 4. progress/预览方块生命周期（draft-preview / live preview）
- 流式 preview（思考+工具行）是**独立消息**，turn 结束（agent-end）时 finalize：
  `deliverFinalizableLivePreview` → "preview-finalized"（编辑为最终回复）/ "preview-retained"（保留）
- pi-discord：`deletePreviewIfDwelled`（MIN_PREVIEW_DWELL_MS=4s 停留后删除）
- **漏洞**：turn 异常中断（agent_end 不触发，如重启/被杀/pi 内部错误）→ preview 永不删除 → 方块残留

### 5. 分块 / 截断（chunk.ts）
- DEFAULT_CHUNK_LIMIT = 4000（长度模式，超限才切；不破坏换行/围栏）
- Discord：textChunkLimit 2000；`maxLinesPerMessage` 默认 **17 行**（软截断，超行截断显示）
- draft-streaming preview：minChars=200 / maxChars=800，按 paragraph/newline/sentence 断

## 二、pi-discord-openclaw 的问题与修复

### 已修（本次会话）
| 问题 | 根因 | 修复 |
|---|---|---|
| 连续输入互相打断 | 笔记 29 用 interrupt（abort 活跃 turn）+ debounce 100ms | 改为**排队**（pendingInputs，turn 结束 drainPending）+ debounce 800ms（对齐 openclaw steer 默认）|
| 表格是 ASCII/markdown | convertMarkdownTableToEmbed 未接线；index.ts 硬编码 "code" | 新增 `convertTextWithTables`：表格→embed、文字留 content，超限回退 code |
| 表直接没了 | editMessage **不透传 embeds**（PATCH 丢字段）| 三层透传：draft-stream → dispatch.ts → index.ts |
| 排队误导 | 👀=queued 语义未传达 | 见下方待办 |

### 待修/建议
1. **方块残留兜底**：beginTurn supersede 旧 turn 时清理旧 preview（agent 异常中断时 agent_end 不触发）
2. **排队可见性**：排队时给用户明确提示（openclaw 靠 👀，可增强为排队提示消息）
3. **maxLinesPerMessage（17 行）**：openclaw 有软截断，pi-discord 未移植（当前不截断，长回复靠 2000 分块）

## 三、经验教训
1. **别名/竞态 bug 的典型**：流式编辑 PATCH 不带 embeds → Discord 静默保留旧值/清空字段，API 层无报错，只能靠端到端对比发现。
2. **"必须第二次输入才有回应"根因**：不是输入被吞，而是每次输入都 abort 了正在跑的 turn（interrupt 语义）+ thinking max 思考慢。
3. **Embed 表格的限制**：≤10 embeds/条、≤25 fields/表、name ≤256、value ≤1024、合计 ≤6000 字符——超限必须回退 ASCII，不能硬发。


---

## 四、错误可见性（笔记 30 补充）

### openclaw 的做法
- `messages.suppressToolErrors`（默认 **false**）：工具错误默认以 ⚠️ 警告**显示给用户**，可配置关闭
- 状态表情 error 状态 ❌（2.5s 停留后清理）
- turn 处理失败：`buildFailedProcessingResult` → 失败通知
- 原则：**错误可见但克制**（concise warnings，避免刷屏）

### pi-discord 修复前（静默点）
- 投递失败超重试上限：仅 `console.error`（用户无感知，回复悄悄丢了）
- 命令回复失败 / slash 命令异常：仅 `console.error`
- Gateway 断连：仅日志
- 大量 `catch { /* 忽略 */ }`

### 修复（对齐 openclaw ⚠️ 模式）
1. **`notifyError(title, error)`**（index.ts）：发到活跃频道，格式 `⚠️ **pi-discord 错误 · {title}**` + 错误详情（≤400 字符）
2. **限频 30s/条**：错误风暴不刷屏（对齐 openclaw "concise warnings" 原则）
3. **接线**：
   - `draft-stream.ts` 新增 `onDeliveryFailed` 回调（超过 MAX_CONSECUTIVE_FAILURES 触发）→ `dispatch.ts` 转发 → `index.ts` notifyError
   - 命令回复失败、slash 命令异常、Gateway 断连 → notifyError
4. **不通知的**：rate limited（自动重试）、命令注册/全局命令同步等内部错误（噪音）

### 原则
- 用户可感知的失败（回复丢了、命令挂了、连接断了）→ 必须可见
- 自动恢复的错误（限流重试）→ 保持安静



---

## 五、消息截断根因（笔记 30 补充）

### 现象
discord 上 agent 回复**停在中间态**（如 22:16:09 停在「自建应用」，完整版 22:16:15 有 1194 字符，discord 上只有 405）——流式内容没补全。

### openclaw 的机制（对照）
- `textChunkLimit`（Discord 2000）：超长**分块成多条消息**，不丢内容
- `maxLinesPerMessage`（默认 17）：传给 adapter chunker 的**分块提示**（超行分多条），不是截断丢弃
- 结论：openclaw 从设计上**不丢内容**，只分块

### pi-discord 的根因（竞态 bug，draft-stream.ts）
1. 流式 flush（中间态）在**飞行中**（editMessage 未返回）
2. 完整 delta + agent_end 到达 → `stop()` → `flush()`
3. `flush()` 开头 `if (this.flushing) return`（防重入）→ **直接返回，完整内容没发**
4. `finally` 里 `if (pendingText && !this.stopped) scheduleFlush()`——此时 stopped 已 true → 跳过重排
5. 结果：消息永久停在中间态 = **截断**

### 修复
`stop()` 等待飞行中的 flush 结束（while flushing 轮询 50ms），再 flush 最终内容：
```js
async stop() {
  if (this.timer) clearTimeout(this.timer);
  while (this.flushing) await new Promise(r => setTimeout(r, 50));
  await this.flush();  // 此时完整内容可发
  this.stopped = true;
  ...
}
```
单测验证：模拟慢 editMessage（飞行中 stop）→ 最终内容完整发出（PASS）。

### 经验
- `flushing` 防重入标志与 `stop()` 的配合是经典竞态：**stop 不能只是"再调一次"**，要等飞行完成
- 流式系统的"截断"大多不是主动截断，而是**最终内容在竞态中丢失**


---

## 六、视觉体验优化（笔记 30 补充）

### 1. 表格位置错乱（Discord embed 固有限制）
- 根因：Discord 的 embed 只能渲染在 content 下方。回复「文字→表格→文字」时，convertTextWithTables 把表格提取成 embed → Discord 把表格挤到最后 → 位置错乱
- 修复：convertTextWithTables 检测「表格之后还有非空内容」→ 回退 ASCII 代码块（保位置优先）；表格在末尾/纯表格/多表格 → embed（美观）
- 权衡：美观（embed）vs 位置（ASCII）——位置正确优先

### 2. 状态表情状态机（对齐用户直觉）
用户期望：排队=⏳ → 处理=👀 → 思考=🧠 → 工具=🛠️ → 完成=✅

| 阶段 | 表情 | 触发 |
|---|---|---|
| 收到/排队 | ⏳（原 👀）| 消息到达（queued）|
| 处理中 | 👀（新 working）| agent_start |
| 思考 | 🧠 | thinking_delta |
| 工具 | 🛠️/分类 | tool_execution_start |
| 完成 | ✅ | agent_end（1.5s 后清理）|
| 错误 | ❌ | Gateway 错误 |

- 删除生硬的文字提示「⏳ 排队中：上一条处理完自动继续…」——纯表情表达
- 与 openclaw 差异：openclaw 的 👀 是 queued（收到即设）；本实现改为 ⏳=queued、👀=working（处理中），更符合用户直觉

### 3. 开源参考
- openclaw：👀=queued 语义 + 13 表情 + debounce 700ms + 终态清理（笔记 23 已移植）
- 本实现：openclaw 基础上 queued 改 ⏳、新增 working 👀——「排队/处理」视觉分离

---

## 七、超时机制优化（笔记 30 补充）

### openclaw 的做法（调研结论）
- **不主动 abort**：stall 表情分级提示——10s 无活动 → ⏳（stallSoft）、30s → ⚠️（stallHard），每次活动重置
- abort 是最后手段：abort-cutoff 机制只负责「abort 后停止生成」，不设激进超时
- 长工具/长思考是**正常**的，不会被打断

### pi-discord 修复前
- turnWatchdogMs 90s/180s 无活动 → 直接 abort「任务超时已中止」——**太短 + 生硬**

### 修复（两级超时 + 友好文案）
| 阶段 | 行为 |
|---|---|
| 无活动 10s | ⏳ 表情（stallSoft，已有）|
| 无活动 30s | ⚠️ 表情（stallHard，已有）|
| 无活动 10 分钟（第一次）| 发软提示「⏳ 还在处理中…」，**不打断**，重置计时 |
| 又 10 分钟无活动（第二次）| 友好暂停「⏸️ 任务长时间无进展，已自动暂停…」|

- turnWatchdogMs 180s → 600s（10 分钟）
- 对齐 openclaw 哲学：**提示先行、abort 最后**，长任务不被误杀

### 4. 状态表情状态机（最终版，用户确认）
- 文字提示彻底移除（含历史消息清理）——排队状态**纯表情**表达
- 状态序列（事件间隔 >700ms debounce 时逐步显示）：
  `⏳(收到/排队) → 👀(agent_start 开工) → 🧠(thinking_delta) → 🛠️(工具) → ✅(完成,清理其他)`
- 表情为 openclaw「只增不减 + 终态清理」语义：Discord 上一排小表情表示状态演进，终态 ✅ 时移除其余
- 与 openclaw 差异：openclaw queued=👀；本实现 queued=⏳、working=👀——「排队/处理」视觉分离，更符合用户直觉

---

## 八、表格模式调研与实现（笔记 30 补充）

### openclaw 的表格方案（源码实锤，packages/markdown-core）
markdown.tables 有 **4 种模式**：`off | bullets | code | block`（block 实际映射为 code）

**bullets 模式**（renderTableAsBullets，ir.ts:916）——解决「位置 + 生硬」的关键：
- 多列表格：**第一列 → 行标签（加粗）**，其余列 → 子弹列表 `• 列名: 值`
- 单列表格：全部 `• 列名: 值`
- 示例：
  ```
  | Feature | SQLite | Postgres |
  → **Speed**
    • SQLite: Fast
    • Postgres: Medium
  ```

### 为什么 bullets 是答案
| 方案 | 位置 | 视觉 |
|---|---|---|
| embed fields | ❌ 只能在 content 下方（中间表格被挤到最后）| ✅ 卡片好看 |
| ASCII code 块 | ✅ 原位 | ❌ 生硬（代码块样式）|
| **bullets** | ✅ **原位（普通文本）** | ✅ 子弹列表 + 加粗标签，Discord 原生渲染 |

### 实现方案（pi-discord）
- `convertMarkdownTables` 扩展支持 "bullets"（移植 openclaw 语义，用现有 parseTableBlock）
- index.ts formatAnswerText（tableMode=embed 时）：
  - 表格在末尾/纯表格 → **embed**（美观）
  - 表格在中间（convertTextWithTables 回退）→ **bullets**（保位置 + 不生硬）
- 显式 tableMode=code/off 保持原行为

---

## 九、思考/工具方块"超级大字"根因（笔记 30 补充）

### 现象
思考/工具方块里出现**超大标题**（如 `# 已有记忆的 files 集合` 被 Discord 渲染成巨大标题）

### 根因
`escapeDiscordMarkdown` 只转义 ` * _ [ ]，**没转义 `#`**——Discord 把行首 `#` 渲染成标题（巨大字体）。
工具行 detail（命令文本）或思考文本里含 `#` 开头行 → 方块出现大字。

### 修复
`escapeDiscordMarkdown` 补转义：`#`（标题=大字）、`>`（引用块）、`- + `（列表）：
```
text.replace(/([\\\`*_\[\]#>\-+])/g, "\\$1")
```
- 效果：`# 已有记忆` → `\# 已有记忆`（显示为普通文字）
- 只影响方块（思考/工具行）；最终回答的 markdown 标题（## xxx）**保留正常渲染**（agent 正式回复可以用标题）

### 开源对照
openclaw 的 progress 行同样有转义（escapeDiscordMarkdown），本修复补齐了 # > - + 的缺口。

---

## 十、表情残留/叠加修复（笔记 30 补充）

### 现象
消息上表情**叠加残留**：⏳👀🧠 全挂一起，处理完了 🧠 还挂着——「没思考却有思考标签」。

### 根因
openclaw 移植的 applyEmoji 是**只增不减**（中间状态只加表情，避免闪烁+省 API 请求），终态才统一清理。多状态叠加 + 完成后残留 → 视觉误导。

### 修复：单表情替换式
applyEmoji 切换时**先移除旧表情再显示当前状态**：
```
+⏳ -⏳ +👀 -👀 +🧠 -🧠 +✅   （消息上始终只有 1 个表情）
```

### 权衡（调研结论）
- openclaw 只增不减：省请求、防闪烁，但叠加/残留
- 本实现替换式：视觉清晰（当前状态唯一），reaction 操作次数略增（每 turn 4-6 次）
- 限流风险：thinking 有 700ms debounce，切换频率低；失败静默（onError）
