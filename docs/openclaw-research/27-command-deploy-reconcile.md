# 27 — Discord 命令部署调研：OpenClaw 的 reconcile + hash 缓存机制

> 任务：DM 全局命令受 Discord 200/天创建额度限制，skill 命令排在 83 个命令最后迟迟补不上。
> 调研 OpenClaw 怎么做到「既保留全部命令又保留 skill、重启不烧额度」。

## 1. 问题背景

- Discord 全局命令创建额度 **200/天**（滚动窗口，code 30034），多次重启 PUT 全量会烧光
- 我们当前实现：全局用「GET 现有 → 逐个 POST 缺失」增量补齐（PR #83），每 2-5 分钟补 1 个，
  83 个要几小时，且 **skill 排在最后** → DM 里迟迟没有 skill
- guild 命令额度独立（200/guild/天），PUT 全量一次成功

## 2. OpenClaw 的 DiscordCommandDeployer（源码位置）

源码（压缩 bundle）：/home/ubuntu/.local/lib/node_modules/openclaw/dist/discord-rKQUcEtb.js
区域：extensions/discord/src/internal/command-deploy.ts

### 2.1 命令模型：guildIds 分流

- 每个命令定义可带 guildIds?: string[]
- !command.guildIds → 全局命令（DM 可见）
- 有 guildIds → 按 groupGuildCommands() 分组，只 PUT 到指定 guild
- devGuilds 配置 → 全部命令注册到开发 guild（调试用）

### 2.2 deploy() 三种路径

1. mode=overwrite：PUT 全量覆盖（我们之前的做法，烧额度）
2. mode=reconcile（默认）：reconcileGlobalCommands() 差异同步
3. devGuilds 存在 → 全量注册到 dev guild

### 2.3 reconcileGlobalCommands（核心，省额度）

伪代码：
  existing = GET 现有命令
  existingByKey = Map(stableCommandKey(command))   // key = type:name
  for command of desired:
    key = stableCommandKey(command)
    if !existingByKey.has(key):  POST create（缺失，消耗 1 create 额度）
    elif !commandsEqual(cur, c): PATCH edit（变化，不消耗 create 额度！）
  for command of existing:       // 多余的
    if !desiredKeys.has(key):    DELETE

- PATCH 编辑不消耗 200/天 create 额度 → 命令变化时用 PATCH 而非重建
- stableCommandKey = type + ":" + name；commandsEqual 对比 comparableCommand（忽略 id/version/application_id 等）

### 2.4 putCommandSetIfChanged + hash 缓存（重启 0 请求）

伪代码：
  putCommandSetIfChanged(key, commands, deploy):
    hash = sha256(stableComparableObject 排序序列化)
    if !force && hashes.get(key) === hash: return   // 相同 → 跳过（0 请求）
    await deploy()
    hashes.set(key, hash)
    persistHashes()   // 写 command-deploy-cache.json

- 缓存文件 command-deploy-cache.json：app:{clientId}:global:reconcile / app:{clientId}:guild:{guildId}
- 带文件锁（KeyedAsyncQueue）防并发覆盖
- 命令集没变 → 重启完全跳过注册（GET 都省了）

### 2.5 429 处理

REST 层（discord.js REST）内置 bucket + retry-after 退避，deployer 不自己处理。

## 3. 与 pi-discord-openclaw 现状对比

| 维度 | openclaw | 我们（现状） |
|---|---|---|
| 全局同步 | reconcile（POST/PATCH/DELETE 差异） | 全量 PUT → 改为逐个 POST（PR #83） |
| 变化命令 | PATCH（不烧 create 额度） | 无（只 create） |
| 重启开销 | hash 缓存 → 0 请求 | 每次重启 GET + 逐个补齐 |
| skill 位置 | 命令集内（自定义顺序） | 83 个最后 → DM 补齐最慢 |
| guild | guildIds 分流 + hash 缓存 | PUT 全量 + GET 去重 |

## 4. 实现方案（本任务）

1. skill 优先：fullCommands 排序把 skill 命令放最前 → 增量补齐先创建 skill → DM 快速恢复
2. reconcile 增强：增量循环支持 PATCH edit（现有命令内容变化时更新，不烧 create 额度）
3. hash 缓存：启动算 fullCommands sha256，对比缓存文件：
   - 相同 → 跳过注册（0 请求）
   - 不同 → 执行 reconcile → 全部成功才写缓存（额度不足跳过时不算完成，下次继续补）
4. 保留 429 retry-after 等待重试（openclaw 靠 REST 层，我们自实现）
