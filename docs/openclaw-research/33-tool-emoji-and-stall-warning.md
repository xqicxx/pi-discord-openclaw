# 33 — 工具表情「联网地球 🌐」识别升级 + ⚠️ 警告「误报 / 不解除」双修复

> 背景：用户反馈三个现象——
> ① fabric_exec 内部跑联网搜索时显示 🛠️ 而不是 🌐（「联网时可以添加上 emoji 的地球」）；
> ② 明明一切正常执行，⚠️ 警告却出现（「网关死了、卡了、不能执行了」时才会警告，别的执行时不该出现）；
> ③ ⚠️ 出现后一直不解除（「上一条在正常运行」警告还挂着）。
> 要求调研根因并修复，写笔记。

## 1. 现象①「fabric_exec 联网不显示 🌐」——args 未透传

### 根因

index.ts 的 tool_execution_start handler 旧实现：

```ts
void activeReactions?.setTool(event.toolName);   // ← 只传工具名
```

而 ack-reactions.ts 的 `setTool(toolName?, args?)` 和 `resolveToolEmoji(toolName, emojis, args)`
**早已支持 args 参数**（笔记 30 加了 WEB_ARGS_RE：args 里有 web 信号也算 🌐），
但 index.ts 一直没把 `event.args` 传过去 → args 检测形同虚设。

关键场景：**fabric_exec 是容器工具**——工具名永远是 `fabric_exec`，
不在 WEB_TOOL_TOKENS 里，名字上永远识别不出联网；
联网发生在内部：`extensions.web_search(...)` / `mcp.exa.web_search_exa(...)` / firecrawl / tavily 等。
只有 args.code 里的调用痕迹能兜住。

### 修复

```ts
// index.ts
void activeReactions?.setTool(event.toolName, event.args as Record<string, unknown> | undefined);
```

同时把 web 特征正则扩到 `firecrawl|tavily|exa.web|web_fetch_exa`（不只 search 类）。

### 顺带挖出的坑：全局正则 lastIndex 串台

WEB_ARGS_RE / LONG_RUNNING_TOOL_RE 都带 `g` flag，`.test()` 有 lastIndex 副作用——
连续调用会**从上次匹配结束位置继续**，导致同一次任务里多个工具互相影响识别结果
（测试复现：先匹配 `extensions.web_search` 成功，再测 `mcp.exa.web_search_exa` 就漏掉）。
修复：每次 test 前 `re.lastIndex = 0`。

## 2. 现象②「正常执行却出现 ⚠️」——长任务工具无心跳 + 30s 硬阈值

### 根因

stall 检测（openclaw 原版语义，移植一致）：**30s 无任何活动事件 → ⚠️**。
「活动」= pi 事件流里的 thinking_delta / tool_execution_start 等（scheduleEmoji 会 resetStallTimers）。

而 fabric_exec 是**单次工具调用**：pi 只在开始/结束时发 tool_execution_start / tool_execution_end，
执行期间（跑 TS 脚本、内部多次联网搜索，30-60s 很常见）**没有任何 pi 事件**。
再叠加笔记 31 的规则（思考行关闭时 thinking_delta 不算可见活动，不重置 stall），
30s 一到 ⚠️ 必现——尽管工具一直在正常工作。

本质：**stall 的「死活」判定对容器工具失效**——工具活着，但事件流是静默的。

### 修复

长任务/联网工具（fabric_exec / subagent / workflow / 命中 web 信号的工具）
→ stall 窗口放宽到 soft 3x / hard 4x（默认 10s/30s → 30s/120s）：

```ts
const LONG_RUNNING_TOOL_RE = /fabric_exec|fabric|subagent|workflow|agents\.run|agents\.spawn/gi;
// setTool 内
const isLong = 工具名命中 LONG_RUNNING_TOOL_RE || hasWebSignal(toolName, args);
scheduleEmoji(emoji, { immediate: true, stallOverride: { soft: timing.stallSoftMs * 3, hard: timing.stallHardMs * 4 } });
```

⚠️ 卡死检测不失效：真卡死（超过放宽后窗口）仍会 ⚠️，测试 8c 验证。

## 3. 现象③「⚠️ 不解除」——stall 表情只增不减，恢复活动后残留

### 根因

状态机「只增不减」语义（openclaw 原版）：中间状态表情 ⏳👀🧠🛠️ 叠加演进，
终态（✅/❌）时才 removeActiveEmojis 统一清理。
但 ⏳/⚠️ 是**异常信号**，不是正常演进的一部分——
一旦加上，后续恢复活动只 add 新表情，⚠️ 一直留在消息上直到 agent_end。
用户看到「上一条明明正常运行，⚠️ 还挂着」。

### 修复

resetStallTimers（每次新活动都调用）里，把已挂着的 stall 表情立即移除：

```ts
function resetStallTimers(msOverride?) {
  ...清定时器...
  // 新活动 → 之前的 ⏳/⚠️ 不再是「卡死」信号，立即移除（removeEmoji 幂等安全）
  for (const stallEmoji of [emojis.stallSoft, emojis.stallHard]) {
    if (activeEmojis.has(stallEmoji)) enqueue(() => removeEmoji(stallEmoji));
  }
  ...重新设 soft/hard 定时器（支持 msOverride）...
}
```

注意 stallSoft ⏳ 与 queued ⏳ 是同一 emoji——但 queued 在 setWorking 时已被移除（笔记 30），
且 removeEmoji 有 activeEmojis.has 幂等检查，无副作用。

## 4. 验证

- 新增测试（test/ack-reactions.test.mjs）：
  - 7b：args 透传——fabric_exec + web args → 🌐；纯 bash args → 💻；无 args → 💻；工具名本身命中 → 🌐
  - 8b：stall ⏳⚠️ 触发后新活动 → 两者被移除（「不解除」修复）
  - 8c：fabric_exec 短时无事件不误报 ⚠️；超长（>4x 窗口）仍触发 ⚠️（卡死检测保留）
- ack-reactions：24 pass / 4 fail（基线 19 pass / 4 fail——4 个为既有遗留：测试期望 queued=👀 而实现是 ⏳，笔记 32 已记载）
- npm test 失败文件与基线一致（ack-reactions 既有 4 fail / progress-lane 既有 1 fail）
- typecheck：10 个既有错误，无新增

## 5. 改动文件

- `index.ts` — tool_execution_start 把 event.args 透传给 setTool（现象①）
- `src/feedback/ack-reactions.ts` — hasWebSignal 抽取 + lastIndex 重置；resetStallTimers 移除残留 stall 表情 + 支持 msOverride（现象③）；LONG_RUNNING_TOOL_RE 长任务宽窗口（现象②）；WEB_ARGS_RE 扩充 firecrawl/tavily/exa
- `test/ack-reactions.test.mjs` — 新增 7b / 8b / 8c 用例