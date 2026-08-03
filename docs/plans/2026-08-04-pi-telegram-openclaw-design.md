# pi-telegram-openclaw 设计文档

> 日期：2026-08-04 ｜ 状态：已确认

## 决策记录（已确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 项目形态 | **C. 全新独立 bridge** | 不依赖 pi-telegram 源码，自由实现 openclaw lane 模型 |
| 宿主范围 | **pi + oh-my-pi 两个适配器** | 用户确认只做这两个；ActivityAdapter 接口保留抽象，后续可扩 |
| 效果范围 | **A. 全都要** | 🧠思考 + 🔧工具进度 + 📝流式回复 + ⏭️连续输入，按 TODO 分阶段 |

## 技术选型（已确认）

| 组件 | 选择 | 理由 |
|---|---|---|
| Telegram SDK | **grammy** | openclaw 同款，editMessage/分块/重试生态成熟 |
| 运行形态 | **独立进程**（systemd 托管） | 与宿主 agent 解耦，bridge 常驻轮询 |
| 事件源 | **ActivityAdapter 接口** | 实现 pi hooks 适配器 + omp hooks 适配器 |
| 存储 | SQLite（会话/消息映射） | 轻量、无外部依赖 |

## 架构

```
Telegram ←→ grammy bot ←→ OpenclawBridge ←→ ActivityAdapter ←→ pi / omp
                              │
                              ├─ ReasoningLane  🧠 思考消息（独立）
                              ├─ AnswerLane     📝 流式编辑（打字机）
                              ├─ ProgressLane   🔧 工具进度（代码块行）
                              └─ InboundDebouncer ⏭️ 连续输入合并/排队
```

## 事件流（ActivityAdapter 契约）

```ts
interface ActivityEvent =
  | { type: "agent-start" }
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-end" }
  | { type: "assistant-text-delta"; delta: string }
  | { type: "assistant-segment"; text: string }
  | { type: "tool-start"; name: string; id?: string }
  | { type: "tool-update"; id?: string; detail?: string }
  | { type: "tool-end"; id?: string; ok?: boolean }
  | { type: "agent-end" }
  | { type: "agent-settled" }
```

## 适配器实现

| 适配器 | 事件源 | 说明 |
|---|---|---|
| **PiActivityAdapter** | pi 扩展 hooks（`onActivity`） | 作为 pi 扩展加载，把 activity 事件转发给 bridge（IPC/stdio） |
| **OmpActivityAdapter** | omp 扩展 hooks（同 pi 系） | 复用同一适配器代码，omp plugin 加载 |

## TODO 里程碑（一点一点来）

- [ ] **M0 脚手架**：git repo、package.json、tsconfig、grammy 依赖、systemd 模板
- [ ] **M1 ActivityAdapter 接口 + PiAdapter**：订阅 pi activity 事件（thinking/tool/delta）
- [ ] **M2 AnswerLane 流式回复**：throttle editMessage、分块、重试、flood 退避
- [ ] **M3 ReasoningLane 思考流**：<think> 提取、🧠 斜体渲染、思考结束定型
- [ ] **M4 ProgressLane 工具进度**：tool-start/update/end → `tool: running ✓` 行
- [ ] **M5 InboundDebouncer 连续输入**：忙时排队、短消息合并、follow-up 注入
- [ ] **M6 Telegram 桥接层**：bot 创建、轮询、会话映射、多用户隔离
- [ ] **M7 端到端联调**：pi 实测 + omp 适配器 + 稳定性（重连/限流）
- [ ] **M8 发布**：README 演示、npm 发布、示例配置、分享

## 里程碑优先级

M0 → M1 → M2（核心体验）→ M3 → M4 → M5 → M6（桥接整合）→ M7 → M8
