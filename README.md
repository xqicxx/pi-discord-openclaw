# pi-telegram-openclaw

> 复刻 OpenClaw 在 Telegram 上的流式输出体验——思考 🧠、工具调用 🔧、流式回复 📝、连续输入 ⏭️——作为 pi 的 Telegram bridge 增强扩展。

## 为什么做这个？

OpenClaw 的 Telegram 频道是**流式输出标杆**：

- 🧠 **思考独立成消息**（斜体 + 图标），和回答分开
- 🔧 **工具调用实时进度**（`tool: running` 代码块行，完成后更新）
- 📝 **回答流式编辑**（同一条消息不断 editMessage，像打字机）
- ⏭️ **连续输入合并**（debounce 批量处理，不打断当前 turn）

pi-telegram 目前只做**最终回复转发**（pi-telebridge 模式）或简单流式，没有 lane 分离、没有思考/工具进度展示。本项目把 OpenClaw 的完整流式机制移植过来。

## 核心机制（来自 openclaw 源码调研）

### 1. Lane 模型（多通道并行）

```
agent 事件流
    │
    ├─ reasoning lane → 🧠 思考消息（斜体，独立消息）
    ├─ answer lane    → 回答消息（流式 editMessage）
    └─ progress lane  → 工具进度草稿（代码块行，实时更新）
```

### 2. 流式草稿（draft-stream）

- 单条消息持续 `editMessageText` 实现打字机效果
- 节流 1s（Telegram flood control）
- 超过 4096 字符自动分块（多条消息）
- 失败重试（网络错误、rate limit 退避）

### 3. 思考流（reasoning-lane-coordinator）

- 从流中提取 `<think>...</think>` / `thinking` 标签内容
- 思考内容以 `🧠 _斜体_` 格式发送为独立消息
- 思考结束（`reasoning-end`）后把思考消息保留或折叠

### 4. 工具进度（progress-draft-preview）

- `tool-start` → 添加一行 `` `tool: running` ``
- `tool-update` → 更新该行（进度/输出摘要）
- `tool-end` → 标记 ✓ 完成
- 渲染为等宽代码块，实时 editMessage 更新

### 5. 连续输入（inbound debounce）

- 短时间内的多条消息合并为一次处理
- 不打断当前正在执行的 turn
- 排队为 follow-up

## 仓库结构

```
pi-telegram-openclaw/
├── README.md
├── docs/
│   └── architecture.md   # 架构设计与事件流
├── src/
│   ├── lanes/            # lane 模型（reasoning/answer/progress）
│   ├── draft/            # 流式草稿引擎
│   ├── reasoning/        # 思考流提取与渲染
│   ├── progress/         # 工具进度渲染
│   ├── inbound/          # 连续输入 debounce
│   ├── index.ts          # pi 扩展入口（registerExtension）
│   └── config.ts         # 配置（节流、分块、模式开关）
└── package.json
```

## 安装

```bash
# 在 pi 中
pi install npm:pi-telegram-openclaw
# 或 omp
omp plugin install pi-telegram-openclaw
```

## 配置（telegram.json）

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
  "openclawStyle": {
    "enabled": true,
    "streaming": {
      "mode": "progress",     // progress | partial | full
      "throttleMs": 1000,
      "chunkSize": 3800
    },
    "reasoning": {
      "enabled": true,
      "style": "🧠 italic"    // 或 "hide" / "block"
    },
    "toolProgress": {
      "enabled": true,
      "maxLines": 8
    }
  }
}
```

## License

MIT — 自用并分享 🎉
