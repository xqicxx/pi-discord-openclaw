# pi-telegram-openclaw

> 复刻 OpenClaw 在 Telegram 上的流式输出体验——思考 🧠、工具调用 🔧、流式回复 📝、连续输入 ⏭️——基于 **fork @llblab/pi-telegram** 改造。

## ✨ 为什么做这个？

OpenClaw 的 Telegram 频道是**流式输出标杆**：

- 🧠 **思考独立成消息**（斜体 + 🧠 图标），和回答分开
- 🔧 **工具调用实时进度**（`tool: running ✓` 代码块行，实时更新）
- 📝 **回答流式编辑**（同一条消息不断 editMessage，像打字机）
- ⏭️ **连续输入合并**（debounce 批量处理，不打断当前 turn）

pi-telegram 原本没有这些。本项目把 OpenClaw 的完整流式机制移植过来，**能复用就复用**：基础轮询/锁/会话用 pi-telegram fork，lane 模型照 openclaw 源码移植。

## 🧩 架构

```
Telegram ⇄ grammy (pi-telegram fork) ⇄ OpenclawBridge ⇄ activityRuntime ⇄ pi agent
                              │
                              ├─ AnswerLane     📝 流式编辑（draft-stream，throttle/分块/重试）
                              ├─ ReasoningLane  🧠 思考流（<think> 提取 + 🧠 斜体渲染）
                              ├─ ProgressLane   🔧 工具进度（tool-start/update/end 行）
                              └─ InboundDebouncer ⏭️ 连续输入合并（default 1s / forward 80ms）
```

## 📦 模块（对应调研笔记）

| 模块 | 文件 | 笔记 | 说明 |
|---|---|---|---|
| DraftStream | `src/draft/draft-stream.ts` | 01 | 节流 editMessage、分块、失败重试、flood 退避、预览消息 |
| ReasoningLane | `src/reasoning/reasoning-lane.ts` | 02 | `<think>` 标签提取、🧠 斜体、思考步骤状态机 |
| ProgressLane | `src/progress/progress-lane.ts` | 03/06 | 工具进度行构建、HTML 渲染、按 id 增量更新 |
| InboundDebouncer | `src/inbound/debounce.ts` | 04 | 双 lane debounce、消息合并、串行 flush |
| Dispatch | `src/dispatch/dispatch.ts` | 05/08 | TurnManager 生命周期、事件路由、桥接层 |
| ActivityAdapter | `src/dispatch/activity-adapter.ts` | 07 | pi-telegram 流事件 → openclaw 事件 |
| Mount | `src/dispatch/mount.ts` | F6 | 最小侵入挂载到 activityRuntime（可开关） |
| TelegramApiAdapter | `src/dispatch/telegram-api-adapter.ts` | F6 | 上游 API → bridge delivery 接口 |

## 🔌 启用（telegram.json）

```jsonc
{
  "profiles": {
    "default": {
      "botToken": "...",
      "botUsername": "...",
      "botId": 123456789,
      "allowedUserId": 987654321
    }
  },
  "openclawStyle": { "enabled": true }
}
```

启用后：
- 思考以 🧠 斜体独立消息流式出现
- 工具调用显示 `🔧 name <code>detail</code> <i>running</i>` 进度行，完成后变 ✓
- 回答打字机式逐字编辑
- 连续消息 1s 内合并为一轮

## 🧪 测试

```bash
npx tsx test/draft-stream.test.mjs       # 7 用例
npx tsx test/reasoning-lane.test.mjs     # 15 用例
npx tsx test/progress-lane.test.mjs      # 19 用例
npx tsx test/inbound-debounce.test.mjs   # 8 用例
npx tsx test/dispatch.test.mjs           # 8 用例
npx tsx test/activity-adapter.test.mjs   # 9 用例
npx tsx test/mount.test.mjs              # 6 用例
npx tsx test/telegram-api-adapter.test.mjs  # 5 用例
```

**77 个测试全部通过** ✅

## 📚 文档

- `docs/plans/2026-08-04-pi-telegram-openclaw-design.md` — 设计文档（决策 + 里程碑）
- `docs/openclaw-research/` — 8 份 openclaw 源码调研笔记

## License

MIT — 自用并分享 🎉
