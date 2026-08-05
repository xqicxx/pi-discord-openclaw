# 25 — 斜杠命令注册上限 + interaction 必响应（根因排查）

> 用户反馈：斜杠命令还是很多问题——没有 /models 切换模型；很多命令没有接口不响应。

## 1. 证据收集（API 实查，不猜）

`GET /applications/{id}/commands` → **78 个命令**，且：
- ❌ 无 models / help / commands / status / stop / tools / usage / thinking-levels（本地可执行命令全缺）
- ✅ 有 builtins 22 + prompts 56（subagents-*/remnic-*/parallel-*/handoff 等），**无 skill-***

## 2. 根因一：注册超 100 上限整体被拒 → Discord 停留在旧命令

- 0.1.6（S184）把 collectPiRuntimeCommands 的 skill 跳过删了（注释写着"skill 不注册"但代码注册了）。
- 注册集 = 本地 23 + builtins 22 + prompts 56 + skills 52 ≈ **140 > 100**（Discord 全局命令上限）。
- PUT /commands 全量原子：任一超限整体 400 → Discord 保留上一次成功注册的 78 个旧命令。
- 所以 /models（0.1.6 才加入本地）永远上不了线。register.log 佐证：04:43 成功注册 86 个（当时有 skill 过滤），之后放开 skill 的版本注册全部失败。

## 3. 根因二：prompt/skill 命令「应用无响应」

- handleInteraction 动态分支：executeDynamicSourceCommand 成功后直接 `return`，**不响应 interaction**。
- Discord 3 秒无响应 → 「应用无响应」。50+ 个模板命令（subagents-*/remnic-*/parallel-*/handoff/run-chain/review-loop…）全中招。
- executeDynamicSourceCommand 内部用 replyTextCommand 发「已加载」（走 activeChannelId，还可能发错频道），但没有 ack interaction。

## 4. 修复

1. **filterDiscordRegisterableCommands(merged)**：注册集排除 source==="skill" + slice(0,100) 保底。
   skill 保留在 merged 集 → 文本 /skill-xxx 本地执行（S184 特性）不受影响。
2. **interaction 先响应再执行**：prompt/skill 动态命令先 respondInteraction（📥 正在加载…）再本地执行；
   执行失败 followUp 引导终端。文本路径同步先发「加载中」。
3. **失败留日志**：respondInteraction 首次响应失败 + followUp 兜底失败都 console.error（此前静默吞）。
4. **测试**：pi-commands.test 新增注册过滤器用例；原「skill:xxx 跳过」断言被 sanitize 掩盖（skill:foo→skill-foo，恒真）补强。

## 5. 验证

- 单元：60 断言全绿（含新 7 条），typecheck 通过。
- 线上：重启 pi-telegram.service → 注册集 88（23 本地 + 9 builtin-only + 56 prompts），
  `GET /applications/{id}/commands` 应含 models/help/status/stop/tools/usage/thinking-levels；
  Discord 里点 /handoff 等模板命令应显示「📥 正在加载 模板…」而非「应用无响应」。
