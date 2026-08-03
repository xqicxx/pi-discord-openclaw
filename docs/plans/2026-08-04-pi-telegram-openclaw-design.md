# pi-telegram-openclaw 设计文档

> 日期：2026-08-04 ｜ 状态：已确认（v2 修订）

## 决策记录（已确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 项目形态 | **B. fork @llblab/pi-telegram 直接改造** | 复用成熟机制（轮询/锁/多实例/会话），只换输出渲染层；用户指定 |
| 宿主范围 | **pi + oh-my-pi** | 两个都是 pi 系，fork 后天然兼容；ActivityAdapter 保留接口抽象 |
| 效果范围 | **A. 全都要** | 🧠思考 + 🔧工具进度 + 📝流式回复 + ⏭️连续输入，按 TODO 分阶段 |

## 技术选型（已确认）

| 组件 | 选择 | 理由 |
|---|---|---|
| 基础 | **fork @llblab/pi-telegram** | 轮询/锁/多实例/会话管理直接用 |
| 渲染层 | **openclaw lane 模型移植** | draft-stream / reasoning-lane / progress-draft / inbound-debounce |
| Telegram SDK | grammy（pi-telegram 自带） | 无需换 |

## 架构

```
pi-telegram (fork) ← 原轮询/锁/会话 → 注入 openclaw-style 渲染层
     │
     ├─ ReasoningLane  🧠 思考消息（独立）← openclaw reasoning-lane-coordinator
     ├─ AnswerLane     📝 流式编辑（打字机）← openclaw draft-stream
     ├─ ProgressLane   🔧 工具进度（代码块行）← openclaw progress-draft
     └─ InboundDebouncer ⏭️ 连续输入合并/排队 ← openclaw inbound-debounce
```

## 调研笔记（边看边记）

见 `docs/openclaw-research/`——每读一个 openclaw 模块写一份笔记。

## TODO 里程碑（一点一点来）

- [ ] **R0 调研笔记**：openclaw 各模块逐份笔记（draft-stream / reasoning / progress / debounce / dispatch）
- [ ] **F0 fork 基础**：fork @llblab/pi-telegram，改名 pi-telegram-openclaw，能跑原功能
- [ ] **F1 AnswerLane 流式回复**：draft-stream 移植（throttle / 分块 / 重试 / flood 退避）
- [ ] **F2 ReasoningLane 思考流**：<think> 提取、🧠 斜体渲染、思考结束定型
- [ ] **F3 ProgressLane 工具进度**：tool-start/update/end → `tool: running ✓` 行
- [ ] **F4 InboundDebouncer 连续输入**：忙时排队、短消息合并、follow-up 注入
- [ ] **F5 端到端联调**：pi 实测 + omp 适配器 + 稳定性（重连/限流）
- [ ] **F6 发布**：README 演示、npm 发布、示例配置、分享
