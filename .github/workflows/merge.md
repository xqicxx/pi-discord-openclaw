---
description: |
  AI 自动合并：PR 带有 ai-approved 标签（AI review 已通过）且满足全部
  合并条件时，由 AI 执行合并。这是闭环的最后一步。

on:
  pull_request:
    types: [labeled]

permissions: read-all

network: defaults

model: gemini-2.5-flash
engine:
  id: gemini
safe-outputs:
  merge-pull-request:
    required-labels: [ai-approved]
    max: 1
  add-comment:
  noop:

tools:
  github:
    toolsets: [pull_requests]
    min-integrity: none

timeout-minutes: 10
---

# AI Merger

本仓库的自动合并流程。PR 被打上 ai-approved 标签时触发（也可能因其他标签触发，需先确认）。

## 合并检查（全部满足才合并）

1. 读取触发 PR 的信息（事件上下文里有 PR 编号）。
2. 确认 PR 带有 ai-approved 标签；如果没有，用 noop 结束——本流程只合并 AI review 通过的 PR。
3. 确认 PR 不是 draft、无冲突、可合并。
4. 确认全部 status checks 通过（尤其是测试）。检查还在跑就等结果或 noop 并说明。
5. 检查合并方式：优先 squash merge，保留 Fixes #N 的关联。

## 合并

- 全部条件满足：用 merge_pull_request 合并，并在 PR 上加一条评论说明已合并。
- 任一条件不满足：noop 结束，用 add_comment 说明缺少什么（不要强行合并，也不要移除 ai-approved 标签）。

## 注意

- 只合并带 ai-approved 标签的 PR，这是硬性门槛。
- 不修改代码、不 review——那是 fix / review 流程的职责。
- 合并失败（冲突等）时说明原因并 noop，不要重试。