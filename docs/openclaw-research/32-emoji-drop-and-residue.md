# 32 — 表情「回复时掉 / 完成时不消」根因调研与修复（删除失败残留 + agent_end 时序）

> 背景：用户反馈两个 Discord 表情症状——
> ① bot 回复正文还在输出时，🧠/👀 状态表情就掉了；
> ② 上一个回复已经完成，✅ 之后表情却没有消失。
> 要求调研根因并修复。

## 1. 症状①「回复时 emoji 掉了」——agent_end 时序竞争

### 根因

index.ts 的 agent_end handler 旧实现：

```ts
pi.on("agent_end", (_event, ctx) => {
  captureCtx(ctx);
  void bridge.endTurn();   // ← 不 await！
  const reactions = activeReactions;
  ...
  void (async () => {
    await reactions.setDone();   // ✅ 立即出现 + removeActiveEmojis 清掉 🧠/👀
    ...
  })();
});
```

而 `bridge.endTurn()` 内部 `await this.answer.stop()` 是回答正文的**最终 flush**——
回答是流式分块发送的（throttle 500ms，chunkSize 1900），agent_end 触发时
回答正文**可能还有分块没发完**。

时序竞争：

1. 用户消息 → ⏳ → agent_start → 👀 → thinking → 🧠 → 工具 → 🛠️
2. 回答正文开始输出（draft-stream 首条立即发，后续 throttle 500ms）
3. **agent_end 触发** → `void bridge.endTurn()`（不等待）→ `setDone()` 立即执行
4. setDone 的 `removeActiveEmojis` 把 🧠/👀 全删（本地集合 + Discord）
5. 用户看到：**回答还在逐块输出，表情已经没了**（「回复时掉了」）

### 修复

agent_end 先 await endTurn（回答正文最终 flush 完成）再进入终态表情：

```ts
pi.on("agent_end", (_event, ctx) => {
  captureCtx(ctx);
  void (async () => {
    try { await bridge.endTurn(); } catch { /* 投递失败由 draft-stream 层处理 */ }
    const reactions = activeReactions;
    const srCfg = cfg.statusReactions;
    if (reactions && srCfg?.enabled !== false) {
      try {
        await reactions.setDone();
        ...
      } catch { /* 表情清理失败由状态机内重试处理 */ }
      if (activeReactions === reactions) activeReactions = undefined;
    } else {
      activeReactions = undefined;
    }
  })();
});
```

## 2. 症状②「完成但 emoji 没消失」——删除失败静默残留

### 根因（测试复现确认）

ack-reactions.ts 的 `removeActiveEmojis` / `removeEmoji` 旧实现：

```ts
async function removeActiveEmojis(options = {}) {
  for (const emoji of Array.from(activeEmojis)) {
    if (emoji === options.keepEmoji) continue;
    try {
      await adapter.removeReaction(emoji);
    } catch (err) {
      if (onError) onError(err);
    } finally {
      activeEmojis.delete(emoji);   // ← 无条件删本地集合！
    }
  }
}
```

问题：**`removeReaction` API 调用失败（429 限流 / 网络抖动）时，
finally 照样把 emoji 从本地 `activeEmojis` 删除**——

- Discord 上表情还挂着（删除请求没成功）
- 本地集合已删 → `clear()` 认为已清空，永不重试
- 错误被 `onError` 静默吞掉（默认无操作）→ 永久残留，不可诊断

复现测试（修复前）：
```
set: ⏳,🧠,✅ | removed: ⏳,✅ | failed: 🧠
→ 🧠 删除失败被静默吞掉，Discord 上残留
```

### 修复

删除失败时**保留在 activeEmojis 集合中**（不 finally 删除）+ 重试一次 + 失败打日志：

```ts
async function removeActiveEmojis(options = {}) {
  for (const emoji of Array.from(activeEmojis)) {
    if (emoji === options.keepEmoji) continue;
    try {
      await adapter.removeReaction(emoji);
      activeEmojis.delete(emoji);           // 成功才删
    } catch (err) {
      if (onError) onError(err);
      try {
        await adapter.removeReaction(emoji); // 重试一次
        activeEmojis.delete(emoji);
      } catch (err2) {
        if (onError) onError(err2);
        console.warn("[ack-reactions] removeReaction 失败，表情可能残留:", emoji, ...);
      }
    }
  }
}
```

同理 `removeEmoji`：失败保留集合 + warn 日志。

## 3. 修复验证

- 复现测试（修复后）：失败后重试成功，⏳🧠 最终被删；连续失败时集合保留（可再次清理）
  4/4 通过
- 全量 18 个测试文件：与改动前一致（ack-reactions 4 fail / progress-lane 1 fail 为既有遗留，
  非本次引入）
- typecheck：改动前后均 10 个既有错误，无新增

## 4. 改动文件

- `index.ts` — agent_end 先 await endTurn 再进终态表情（症状①）
- `src/feedback/ack-reactions.ts` — 删除失败保留集合 + 重试 + 日志（症状②）
