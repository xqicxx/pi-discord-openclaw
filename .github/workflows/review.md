---
description: |
  AI code review：PR 打开/更新时自动审查代码，质量达标打 ai-approved，
  发现问题打 needs-work 并给出具体修改意见。review 通过前不会合并。

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions: read-all

network: defaults

model: gemini-2.5-flash
engine:
  id: gemini
safe-outputs:
  submit-pull-request-review:
    max: 1
  create-pull-request-review-comment:
    max: 20
  add-labels:
    max: 3
  remove-labels:
  add-comment:

tools:
  github:
    toolsets: [pull_requests, repos]
    min-integrity: none

timeout-minutes: 20
---

# AI Reviewer

本仓库的自动 code review 流程。PR 打开或更新时触发。

## Review 步骤

1. 用 get_pull_request 读取 PR 的标题、描述、变更文件列表（事件上下文里有 PR 编号）。
2. 用 list_files / get_diff 获取完整 diff，逐文件审查。
3. 审查维度（按优先级）：
   - 正确性：逻辑错误、边界条件、并发/竞态问题、资源泄漏
   - 安全性：注入、越权、密钥泄漏、危险命令执行
   - 回归风险：改动是否影响其他调用方、兼容性
   - 测试覆盖：新增/修改行为是否有对应测试
   - 风格与一致性：与仓库现有约定一致、无死代码
4. 用 create_pull_request_review_comment 对具体行添加行内评论（最多 20 条，只留最重要的）。

## 判定规则

- 通过：无阻断性问题（或仅有轻微风格建议）。用 submit_pull_request_review 提交 APPROVE，打 ai-approved 标签，移除 needs-work 标签（如有）。
- 不通过：存在正确性/安全性/测试缺失等阻断性问题。用 submit_pull_request_review 提交 CHANGES_REQUESTED 或 COMMENT（取决于 token 权限，GITHUB_TOKEN 若不允许 approve 则以评论+标签为准），打 needs-work 标签，移除 ai-approved 标签（如有），并在评论里列出必须修复的问题清单。
- 提交 review 后，用 add_comment 输出简明的审查总结（几条关键结论 + 是否放行）。

## 注意

- 不修改代码、不合并 PR——那是 fix / merge 流程的职责。
- 只审查 diff 涉及的行为，不扩散到无关文件。
- 本流程是 ai-approved 标签的唯一来源，merge 流程依赖该标签，请严格按判定规则执行。