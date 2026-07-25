# 回归测试用例 V2 — 新增特性对核心功能影响

> **目标**：针对新增的 AgentManager、HeartbeatMonitor、RetryConfigPanel、PromptDebugger、LayeredSettingsPanel、RecoveryPanel，以及环境配置/Git/Worktree 修改，验证核心功能（对话、思考过程、工具调用、子智能体、技能调用、消息链路、存储、回调）不受影响。
>
> **测试框架**：Vitest
> **编写日期**：2026-07-25

---

## 目录

| 模块 | 用例编号区间 | 用例数 | 优先级 |
|------|-------------|--------|--------|
| [1. AgentRegistry 持久化回归](#1-agentregistry-持久化回归) | AREG-001 ~ AREG-020 | 20 | P0 |
| [2. HeartbeatManager 配置回归](#2-heartbeatmanager-配置回归) | HBRT-001 ~ HBRT-015 | 15 | P0 |
| [3. RetryExecutor 配置回归](#3-retryexecutor-配置回归) | RTRY-001 ~ RTRY-015 | 15 | P0 |
| [4. 新增设置键不冲突](#4-新增设置键不冲突) | SKEY-001 ~ SKEY-015 | 15 | P0 |
| [5. Git/Worktree/环境配置对核心链路影响](#5-gitworktree环境配置对核心链路影响) | GWTE-001 ~ GWTE-025 | 25 | P0 |
| [6. 消息链路与存储完整性](#6-消息链路与存储完整性) | MSGC-001 ~ MSGC-020 | 20 | P0 |
| [7. 工具调用与权限回归](#7-工具调用与权限回归) | TOOL-REG-001 ~ TOOL-REG-020 | 20 | P0 |
| [8. 系统提示词构建回归](#8-系统提示词构建回归) | PROMPT-REG-001 ~ PROMPT-REG-015 | 15 | P1 |
| [9. 会话恢复与多层恢复回归](#9-会话恢复与多层恢复回归) | RECV-001 ~ RECV-015 | 15 | P1 |
| [10. 冒烟测试（Smoke Test）](#10-冒烟测试smoke-test) | SMOKE-001 ~ SMOKE-030 | 30 | P0 |
| **合计** | | **185** | |

---

## 1. AgentRegistry 持久化回归

覆盖 `AgentRegistry` 新增的 `loadCustomAgents`/`saveCustomAgents`/`update`/`unregister`/`isBuiltin` 方法，确保不破坏现有 `register`/`get`/`getAll`/`evaluatePermission`/`canUseTool` 逻辑。

### 1.1 内置智能体不变性（AREG-001 ~ AREG-008）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| AREG-001 | 内置智能体数量不变 | 无 | `getAgentRegistry().getAll()` | 返回 6 个内置智能体：build/plan/explore/general/title/summary | P0 |
| AREG-002 | 内置智能体 isBuiltin 返回 true | 无 | 对每个内置 ID 调用 `isBuiltin` | 全部返回 true | P0 |
| AREG-003 | 内置智能体不可删除 | 无 | `unregister("build")` | 返回 false，`getAll()` 仍含 build | P0 |
| AREG-004 | 内置智能体不可更新 | 无 | `update("build", {name: "Hacked"})` | 返回 false，`get("build").name` 仍为 "Build" | P0 |
| AREG-005 | build 智能体权限评估不变 | 无 | `evaluatePermission("build", "bash")` | 返回 "allow"（permissions 中有 `{tool:"*", action:"allow"}`）| P0 |
| AREG-006 | plan 智能体工具限制不变 | 无 | `canUseTool("plan", "write")` | 返回 false（toolAllowlist 不含 write）| P0 |
| AREG-007 | title 智能体 maxTokens 不变 | 无 | `get("title").maxTokens` | 为 50 | P0 |
| AREG-008 | build 智能体 modelSlot 不变 | 无 | `get("build").modelSlot` | 为 "chat" | P0 |

### 1.2 自定义智能体持久化（AREG-009 ~ AREG-016）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| AREG-009 | 注册自定义智能体并持久化 | DB 已初始化 | `register(customAgent)` → 重新获取 registry | `getAll()` 包含自定义智能体 | P0 |
| AREG-010 | 持久化数据写入 settings | AREG-009 完成 | 读取 `codem-custom-agents` | JSON 数组包含自定义智能体 | P0 |
| AREG-011 | 重启后加载自定义智能体 | AREG-009 完成 | 重置 singleton，重新 `getAgentRegistry()` | `getAll()` 仍包含自定义智能体 | P0 |
| AREG-012 | 更新自定义智能体 | 已注册自定义 | `update(id, {maxSteps: 30})` | 返回 true，`get(id).maxSteps` 为 30 | P0 |
| AREG-013 | 删除自定义智能体 | 已注册自定义 | `unregister(id)` | 返回 true，`getAll()` 不再包含 | P0 |
| AREG-014 | 删除后持久化更新 | AREG-013 完成 | 读取 `codem-custom-agents` | 数组中不含已删除的智能体 | P0 |
| AREG-015 | 自定义智能体权限评估 | 注册带 permissions 的自定义 | `evaluatePermission(customId, "bash")` | 按 last-match-wins 返回正确结果 | P0 |
| AREG-016 | 自定义智能体 isBuiltin 返回 false | 已注册自定义 | `isBuiltin(customId)` | 返回 false | P0 |

### 1.3 与系统提示词集成（AREG-017 ~ AREG-020）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| AREG-017 | build 智能体提示词不变 | 无 | `get("build").prompt` | 包含 "Engineering Approach" | P0 |
| AREG-018 | 自定义智能体可被 PromptDebugger 选中 | 已注册自定义 | `buildSystemPrompt({agent: customAgent})` | prompt 包含 customAgent.prompt | P1 |
| AREG-019 | 智能体 collaborationMode 正确传递 | build 智能体 | `get("build").collaborationMode` | 为 undefined 或 "default" | P1 |
| AREG-020 | 智能体 modelSlot 被工具执行使用 | explore 智能体 | `get("explore").modelSlot` | 为 "subagent" | P1 |

---

## 2. HeartbeatManager 配置回归

覆盖 `HeartbeatManager` 新增的 `getGlobalConfig`/`setGlobalConfig`/`getAll` 方法，确保不破坏现有 `create`/`get`/`remove`/`stopAll`/`getActive`/`getStats` 逻辑。

### 2.1 全局配置持久化（HBRT-001 ~ HBRT-008）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| HBRT-001 | 默认配置正确 | DB 已初始化 | `getGlobalConfig()` | interval=30000, timeout=5000, maxFailures=3, sendMetadata=true | P0 |
| HBRT-002 | 修改配置并持久化 | 无 | `setGlobalConfig({interval: 10000})` | `getGlobalConfig().interval` 为 10000 | P0 |
| HBRT-003 | 持久化数据写入 settings | HBRT-002 完成 | 读取 `codem-heartbeat-config` | JSON 包含 interval:10000 | P0 |
| HBRT-004 | 重启后加载配置 | HBRT-002 完成 | 重置 singleton | `getGlobalConfig().interval` 仍为 10000 | P0 |
| HBRT-005 | 部分更新不丢失其他字段 | 已设置 interval=10000 | `setGlobalConfig({timeout: 8000})` | interval 仍为 10000，timeout 为 8000 | P0 |
| HBRT-006 | create 使用全局配置 | 已设置 interval=10000 | `create("sess-1")` → `getData()` | 心跳使用 10000ms 间隔 | P0 |
| HBRT-007 | create 可覆盖全局配置 | 全局 interval=10000 | `create("sess-1", {interval: 5000})` | 该会话使用 5000ms | P1 |
| HBRT-008 | endpoint 默认为 undefined | 无 | `getGlobalConfig().endpoint` | 为 undefined | P0 |

### 2.2 会话管理不受影响（HBRT-009 ~ HBRT-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| HBRT-009 | create 返回已有实例 | 已 create("sess-1") | 再次 `create("sess-1")` | 返回同一实例（引用相等）| P0 |
| HBRT-010 | get 返回正确心跳 | 已 create("sess-1") | `get("sess-1")` | 返回 ActivityHeartbeat 实例 | P0 |
| HBRT-011 | remove 销毁心跳 | 已 create("sess-1") | `remove("sess-1")` → `get("sess-1")` | 返回 undefined | P0 |
| HBRT-012 | getAll 返回所有心跳 | create sess-1 和 sess-2 | `getAll()` | 返回 2 个实例 | P0 |
| HBRT-013 | getStats 统计正确 | create sess-1, start → create sess-2 | `getStats()` | total=2, active=1, stopped=1 | P0 |
| HBRT-014 | stopAll 停止所有 | 2 个 active | `stopAll()` | `getStats().active` 为 0 | P0 |
| HBRT-015 | getActive 只返回 active | 1 active, 1 stopped | `getActive()` | 返回 1 个实例 | P0 |

---

## 3. RetryExecutor 配置回归

覆盖 `RetryExecutor` 新增的 `getConfig`/`setConfig`/`loadPersistedConfig` 方法，确保不破坏现有 `execute`/`shouldRetry`/`getDelay`/`reset` 逻辑。

### 3.1 配置持久化（RTRY-001 ~ RTRY-008）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| RTRY-001 | 默认配置正确 | DB 已初始化 | `getConfig()` | maxAttempts=10, baseDelay=500, backoffMultiplier=2, maxDelay=300000, totalTimeout=1800000, respectRetryAfter=true | P0 |
| RTRY-002 | 修改配置并持久化 | 无 | `setConfig({maxAttempts: 5})` | `getConfig().maxAttempts` 为 5 | P0 |
| RTRY-003 | 持久化数据写入 settings | RTRY-002 完成 | 读取 `codem-retry-config` | JSON 包含 maxAttempts:5 | P0 |
| RTRY-004 | 重启后加载配置 | RTRY-002 完成 | 重置 singleton | `getConfig().maxAttempts` 仍为 5 | P0 |
| RTRY-005 | 部分更新不丢失其他字段 | 已设置 maxAttempts=5 | `setConfig({baseDelay: 1000})` | maxAttempts 仍为 5，baseDelay 为 1000 | P0 |
| RTRY-006 | setConfig 更新 totalAttempts | 已设置 maxAttempts=5 | 检查 `getState().totalAttempts` | 为 5 | P0 |
| RTRY-007 | loadPersistedConfig 不覆盖显式参数 | DB 有 codem-retry-config | `new RetryExecutor({maxAttempts: 20})` | maxAttempts 为 DB 中的值（持久化优先）| P1 |
| RTRY-008 | DB 无配置时使用默认值 | 清空 DB | `getConfig()` | 返回 DEFAULT_RETRY_CONFIG 值 | P0 |

### 3.2 重试逻辑不受影响（RTRY-009 ~ RTRY-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| RTRY-009 | shouldRetry 对 429 返回 true | 无 | `shouldRetry({status:429})` | 返回 true | P0 |
| RTRY-010 | shouldRetry 对 400 返回 false | 无 | `shouldRetry({status:400})` | 返回 false | P0 |
| RTRY-011 | shouldRetry 超过 maxAttempts 返回 false | maxAttempts=1, attempt=1 | `shouldRetry({status:500})` | 返回 false | P0 |
| RTRY-012 | getDelay 指数退避 | baseDelay=500, multiplier=2 | `getDelay(0)` → `getDelay(1)` → `getDelay(2)` | 500, 1000, 2000 | P0 |
| RTRY-013 | getDelay 不超过 maxDelay | maxDelay=3000 | `getDelay(10)` | ≤ 3000 | P0 |
| RTRY-014 | getDelay 尊重 Retry-After | respectRetryAfter=true | `getDelay(0, 10000)` | 为 10000 | P0 |
| RTRY-015 | execute 成功后不重试 | 无 | `execute(async () => "ok")` | 返回 "ok"，attempt=0 | P0 |

---

## 4. 新增设置键不冲突

确保新增的 `codem-custom-agents`、`codem-heartbeat-config`、`codem-retry-config` 等设置键不与现有键冲突，不影响已有设置读写。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SKEY-001 | codem-custom-agents 不影响 codem-settings | DB 已初始化 | 写入两个键，读取 codem-settings | codem-settings 值不变 | P0 |
| SKEY-002 | codem-heartbeat-config 不影响 codem-settings | DB 已初始化 | 写入两个键，读取 codem-settings | codem-settings 值不变 | P0 |
| SKEY-003 | codem-retry-config 不影响 codem-context-config | DB 已初始化 | 写入两个键，读取 codem-context-config | codem-context-config 值不变 | P0 |
| SKEY-004 | codem-custom-agents 默认值为空数组 | 清空 DB | `getSettingJSON("codem-custom-agents", [])` | 返回 [] | P0 |
| SKEY-005 | codem-heartbeat-config 默认值为 null | 清空 DB | `getSettingJSON("codem-heartbeat-config", null)` | 返回 null | P0 |
| SKEY-006 | codem-retry-config 默认值为 null | 清空 DB | `getSettingJSON("codem-retry-config", null)` | 返回 null | P0 |
| SKEY-007 | 批量写入新键不损坏 DB | 无 | 连续写入 5 个新键 | 所有键可正确读回 | P0 |
| SKEY-008 | codem-settings 保存后新键仍存在 | 先写 codem-custom-agents，再写 codem-settings | 读取 codem-custom-agents | 值仍存在 | P0 |
| SKEY-009 | removeSetting 不影响其他键 | 有 codem-custom-agents 和 codem-heartbeat-config | `removeSetting("codem-custom-agents")` | codem-heartbeat-config 仍存在 | P0 |
| SKEY-010 | 新键与 codem-git-config 不冲突 | DB 已初始化 | 写入 codem-git-config 和 codem-retry-config | 两者独立读取正确 | P0 |
| SKEY-011 | 新键与 codem-env-config 不冲突 | DB 已初始化 | 写入 codem-env-config 和 codem-heartbeat-config | 两者独立读取正确 | P0 |
| SKEY-012 | 新键与 codem-cost-limits 不冲突 | DB 已初始化 | 写入 codem-cost-limits 和 codem-retry-config | 两者独立读取正确 | P0 |
| SKEY-013 | 新键与 codem-disabled-tools 不冲突 | DB 已初始化 | 写入 codem-disabled-tools 和 codem-custom-agents | 两者独立读取正确 | P0 |
| SKEY-014 | 新键与 codem-notebook-config 不冲突 | DB 已初始化 | 写入 codem-notebook-config 和 codem-heartbeat-config | 两者独立读取正确 | P0 |
| SKEY-015 | 新键与 codem-model-profiles 不冲突 | DB 已初始化 | 写入 codem-model-profiles 和 codem-retry-config | 两者独立读取正确 | P0 |

---

## 5. Git/Worktree/环境配置对核心链路影响

验证环境配置、Git、Git Worktree 的修改不影响工具执行的 cwd、沙箱、权限、消息链路。

### 5.1 Git 配置不影响工具执行（GWTE-001 ~ GWTE-010）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| GWTE-001 | Git 配置写入后 bash 工具仍可执行 | Mock executeCommand | 设置 codem-git-config，执行 bash | bash 工具正常调用，cwd 不变 | P0 |
| GWTE-002 | Git branchPrefix 不影响现有分支检测 | Mock git 命令 | 设置 branchPrefix="feature/"，执行 isGitRepo | 返回正确结果，不受 branchPrefix 影响 | P0 |
| GWTE-003 | Git forcePush=false 不影响 read 工具 | 设置 forcePush=false | 执行 read 工具 | 正常读取文件 | P0 |
| GWTE-004 | 环境配置 setupScript 不影响工具 cwd | 设置 setupScript="install.sh" | 执行 bash 工具 | cwd 仍为 ctx.cwd，不被脚本改变 | P0 |
| GWTE-005 | 环境配置 customOperations 不注入工具 | 设置 customOperations | 检查 ToolRegistry | 内置工具列表不变 | P0 |
| GWTE-006 | Worktree 设置 maxWorktrees 不影响现有会话 | 设置 maxWorktrees=5 | 在非 worktree 模式执行 bash | 工具正常执行 | P0 |
| GWTE-007 | Worktree 模式下沙箱以 worktreePath 为边界 | worktree 模式 + sandbox=true | write 到 worktree 外 | 被沙箱拒绝 | P0 |
| GWTE-008 | 非 worktree 模式下沙箱以 projectPath 为边界 | 非 worktree + sandbox=true | write 到 project 外 | 被沙箱拒绝 | P0 |
| GWTE-009 | Git 配置变更触发 codem-settings-changed 事件 | 无 | 修改 Git 配置 | `window.dispatchEvent` 被调用 | P1 |
| GWTE-010 | 环境配置变更不影响 LLM engine 重配置 | 无 | 修改 env 配置 → dispatch event | engine reconfigure 不报错 | P1 |

### 5.2 Worktree 与消息链路（GWTE-011 ~ GWTE-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| GWTE-011 | Worktree 会话消息独立存储 | 两个 worktree 会话 | 各发消息 | DB 中消息按 sessionId 隔离，不交叉 | P0 |
| GWTE-012 | Worktree 模式下 createMessage 正常 | worktree 会话 | `createMessage(msg, sessionId)` | DB 写入成功 | P0 |
| GWTE-013 | Worktree 模式下 getMessages 正常 | worktree 会话有消息 | `getMessages(sessionId)` | 返回正确消息列表 | P0 |
| GWTE-014 | Worktree 模式下 tool_calls 关联正确 | worktree 会话有工具调用 | 查询 DB | tool_calls.message_id 正确关联 | P0 |
| GWTE-015 | Worktree 路径含中文不崩溃 | 中文项目路径 | createWorktree | 路径正确，不报错 | P0 |
| GWTE-016 | Worktree 删除不删消息 | 有 worktree 会话和消息 | removeWorktree | DB 中消息仍存在 | P0 |
| GWTE-017 | 委派到 worktree 会话——cwd 隔离 | 两个 worktree 会话 | delegate | 目标会话在各自 worktree 执行 | P1 |
| GWTE-018 | Worktree 会话权限按各自会话隔离 | 两个 worktree 会话同时请求权限 | 并行 | pendingPermissions 按 sessionId 隔离 | P0 |
| GWTE-019 | Worktree 模式下 reasoning 存储正常 | worktree 会话有 reasoning | 检查 DB | reasoning 字段正确保存 | P0 |
| GWTE-020 | Worktree 模式下 generatedFiles 序列化正常 | worktree 会话触发 write | 检查 DB | generated_files JSON 正确 | P0 |
| GWTE-021 | Git 配置注入 system prompt 不破坏格式 | 设置 gitConfig | `buildSystemPrompt` | prompt 包含 Git Preferences 段落，格式正确 | P1 |
| GWTE-022 | 环境配置注入 system prompt 不破坏格式 | 设置 environmentConfig | `buildSystemPrompt` | prompt 包含 Environment Scripts 段落 | P1 |
| GWTE-023 | 无 Git 配置时 system prompt 无 Git 段 | gitConfig=undefined | `buildSystemPrompt` | prompt 不含 "# Git Preferences" | P1 |
| GWTE-024 | 无环境配置时 system prompt 无 ENV 段 | environmentConfig=undefined | `buildSystemPrompt` | prompt 不含 "# Environment Scripts" | P1 |
| GWTE-025 | Worktree 自动清理不影响活跃会话 | 有 15 个 worktree | 创建第 16 个 | 最旧非活跃被清理，活跃会话不受影响 | P1 |

---

## 6. 消息链路与存储完整性

验证所有修改后，消息创建、读取、更新、删除的完整链路仍然正常。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| MSGC-001 | 消息创建后 DB 可查 | 有会话 | `createMessage(msg, sessionId)` | `getMessages(sessionId)` 包含该消息 | P0 |
| MSGC-002 | 消息更新后 DB 反映变更 | 有消息 | `updateMessage(id, {status:"done"})` | DB 中 status 为 done | P0 |
| MSGC-003 | 消息删除后 DB 不含 | 有消息 | `deleteMessage(id)` | `getMessages` 不含该消息 | P0 |
| MSGC-004 | 批量删除消息后 DB 正确 | 有 10 条消息 | `deleteMessagesByIds([5个id])` | 剩余 5 条 | P0 |
| MSGC-005 | 工具调用创建并关联消息 | 有消息 | `addToolCall(msgId, toolCall)` | DB 中 tool_calls 行关联正确 | P0 |
| MSGC-006 | 工具调用更新状态 | 有 running 工具调用 | `updateToolCall(id, {status:"done", result:"ok"})` | DB 反映更新 | P0 |
| MSGC-007 | 中文+Emoji 消息不乱码 | 无 | 创建含 "你好🌍🎉" 的消息 | 读取后内容一致 | P0 |
| MSGC-008 | 大消息（10KB）完整存储 | 无 | 创建 10000 字符消息 | 读取完整无截断 | P0 |
| MSGC-009 | 会话切换加载正确消息 | 会话 A 10条、B 5条 | A→B→A | 各加载正确数量，不交叉 | P0 |
| MSGC-010 | 跨项目消息隔离 | 项目 A、B 各有会话 | 切换项目 | 只加载当前项目会话 | P0 |
| MSGC-011 | saveMessages 幂等——重复不产生副本 | 有会话 | 连续调用 2 次 saveMessages | 消息数不变 | P0 |
| MSGC-012 | reasoning 字段持久化 | 有 reasoning 内容 | 创建含 reasoning 的消息 | DB 中 reasoning 字段非 null | P0 |
| MSGC-013 | generatedFiles 序列化 | write 工具产出 | 创建含 generatedFiles 的消息 | DB 中 JSON 正确 | P0 |
| MSGC-014 | 项目删除级联清理 | 项目含会话和消息 | deleteProject | 会话和消息级联删除 | P0 |
| MSGC-015 | delegation_tasks 表正常 | DB 已初始化 | createDelegationTask | 表有行，字段完整 | P0 |
| MSGC-016 | 1000+ 消息查询不超时 | 大量消息 | getMessages | 返回完整，不卡死 | P1 |
| MSGC-017 | 并发写入不互相覆盖 | 会话 A、B 同时保存 | 并行 saveMessages | 各自独立，不死锁 | P1 |
| MSGC-018 | Fork 会话消息复制正确 | 有含工具调用的会话 | fork | 新会话有副本，tool_calls 正确 | P1 |
| MSGC-019 | 会话标题含 Emoji 不乱码 | 无 | 创建标题含 🎉 的会话 | 读取正确 | P0 |
| MSGC-020 | 消息按 timestamp 升序 | 创建乱序时间戳消息 | getMessages | 按 timestamp 升序排列 | P0 |

---

## 7. 工具调用与权限回归

验证新增 AgentRegistry/Heartbeat/Retry 修改不影响工具注册、执行、权限评估。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| TOOL-REG-001 | 内置工具数量不变 | 无 | `createDefaultToolRegistry().getAll()` | 包含 bash/read/write/edit/glob/grep 等核心工具 | P0 |
| TOOL-REG-002 | bash 工具执行不受 AgentRegistry 修改影响 | Mock executeCommand | 执行 bash 工具 | 正常返回结果 | P0 |
| TOOL-REG-003 | read 工具不受 HeartbeatManager 修改影响 | Mock readFile | 执行 read 工具 | 正常返回内容 | P0 |
| TOOL-REG-004 | write 工具不受 RetryExecutor 修改影响 | Mock writeFile | 执行 write 工具 | 正常写入 | P0 |
| TOOL-REG-005 | 沙箱检查不受新设置键影响 | sandbox=true | write 到工作区外 | 被沙箱拒绝 | P0 |
| TOOL-REG-006 | Agent evaluatePermission 正常 | build 智能体 | `evaluatePermission("build", "bash")` | 返回 "allow" | P0 |
| TOOL-REG-007 | Agent canUseTool 正常 | plan 智能体 | `canUseTool("plan", "write")` | 返回 false | P0 |
| TOOL-REG-008 | 权限规则匹配通配符 | 自定义 Agent | `evaluatePermission(customId, "file.read")` | 按 "file.*" 匹配 | P0 |
| TOOL-REG-009 | ToolRegistry 工具去重 | 无 | 注册同名工具 | 后注册的覆盖前者 | P0 |
| TOOL-REG-010 | load_skill 工具存在 | 无 | 检查 ToolRegistry | 包含 load_skill | P0 |
| TOOL-REG-011 | web_search 工具存在 | 无 | 检查 ToolRegistry | 包含 web_search | P0 |
| TOOL-REG-012 | read_attachment 工具存在 | 无 | 检查 ToolRegistry | 包含 read_attachment | P0 |
| TOOL-REG-013 | 工具执行错误不崩溃 | Mock 抛异常 | 执行 bash | 返回 error 结果，不 throw | P0 |
| TOOL-REG-014 | 多工具并发执行 | 无 | 并行执行 2 个 read | 各自返回正确结果 | P0 |
| TOOL-REG-015 | abort 信号中断工具 | 有 abort 信号 | 执行 bash 时 abort | 工具中止，返回 aborted | P0 |
| TOOL-REG-016 | 工具输出存入 DB | 执行工具后 | 查询 DB | tool_calls 表有 result | P0 |
| TOOL-REG-017 | 工具元数据正确传递 | 执行 bash | 检查 ctx | ctx.sessionId/cwd/abort 正确 | P0 |
| TOOL-REG-018 | 安全模式 full 跳过权限 | securityMode=full | 执行 write | 不弹权限，直接执行 | P0 |
| TOOL-REG-019 | 安全模式 ask 触发权限 | securityMode=ask | 执行 bash | 触发 onPermissionRequest | P0 |
| TOOL-REG-020 | 自定义权限规则生效 | 有自定义规则 | 工具调用 | 按规则 allow/deny/ask | P0 |

---

## 8. 系统提示词构建回归

验证 `buildSystemPrompt` 在各种配置组合下不崩溃，输出格式正确。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| PROMPT-REG-001 | build 智能体提示词完整 | 无 | `buildSystemPrompt({agent: buildAgent})` | 包含 Identity/Formatting/Final Answer/Safety 等段落 | P0 |
| PROMPT-REG-002 | plan 模式提示词包含 Plan 段 | collaborationMode=plan | `buildSystemPrompt` | 包含 "Plan mode" | P0 |
| PROMPT-REG-003 | 默认模式提示词包含 Default 段 | collaborationMode=default | `buildSystemPrompt` | 包含 "Default mode" | P0 |
| PROMPT-REG-004 | 含 Git 配置时注入 Git Preferences | gitConfig 有值 | `buildSystemPrompt` | 包含 "# Git Preferences" | P1 |
| PROMPT-REG-005 | 含环境配置时注入 Environment Scripts | environmentConfig 有值 | `buildSystemPrompt` | 包含 "# Environment Scripts" | P1 |
| PROMPT-REG-006 | 含用户配置时注入 Your Human | user.name 有值 | `buildSystemPrompt` | 包含 "# Your Human" | P1 |
| PROMPT-REG-007 | 中文模式语言规则在最后 | lang=zh | `buildSystemPrompt` | 最后一段为语言规则 | P1 |
| PROMPT-REG-008 | 英文模式语言规则在最后 | lang=en | `buildSystemPrompt` | 最后一段为 Language Rules | P1 |
| PROMPT-REG-009 | 自定义智能体 prompt 被注入 | customAgent | `buildSystemPrompt({agent: custom})` | 包含 custom.prompt | P1 |
| PROMPT-REG-010 | system-reminder 标签被过滤 | prompt 含标签 | `buildSystemPrompt` | 输出不含 `<system-reminder>` | P1 |
| PROMPT-REG-011 | 工作目录注入正确 | workingDirectory 有值 | `buildSystemPrompt` | 包含 "Working directory:" | P1 |
| PROMPT-REG-012 | Git 分支注入正确 | gitBranch 有值 | `buildSystemPrompt` | 包含 "Git branch:" | P1 |
| PROMPT-REG-013 | 模型信息注入正确 | modelInfo 有值 | `buildSystemPrompt` | 包含 "Model:" | P1 |
| PROMPT-REG-014 | 知识笔记本模式注入 | knowledgeContext 有值 | `buildSystemPrompt` | 包含 "Knowledge Notebook Mode" | P1 |
| PROMPT-REG-015 | 空配置不崩溃 | 所有可选字段为 undefined | `buildSystemPrompt({agent: buildAgent})` | 不崩溃，返回有效字符串 | P0 |

---

## 9. 会话恢复与多层恢复回归

验证 `SessionRecoveryService` 在新增特性后仍正常工作。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| RECV-001 | 保存会话到恢复数据 | 有会话 | `saveSession(session)` | `loadSession(id)` 返回该会话 | P0 |
| RECV-002 | 加载所有会话 | 有多个会话 | `getAllSessions()` | 按 updatedAt 降序排列 | P0 |
| RECV-003 | 删除会话恢复数据 | 有会话 | `deleteSession(id)` | `loadSession(id)` 返回 undefined | P0 |
| RECV-004 | 添加消息到会话 | 有会话 | `addMessage(sessionId, msg)` | 消息添加成功 | P0 |
| RECV-005 | 更新会话消息 | 有会话和消息 | `updateMessage(sessionId, msgId, updater)` | 消息被更新 | P0 |
| RECV-006 | 获取会话状态 | 有会话 | `getSessionState(sessionId)` | 返回 exists/messageCount/canRecover | P0 |
| RECV-007 | 获取恢复摘要 | 有多个会话 | `getRecoverySummary()` | 返回 totalSessions/totalMessages 等 | P0 |
| RECV-008 | 导出数据 | 有数据 | `exportData()` | 返回 JSON 字符串 | P0 |
| RECV-009 | 导入数据 | 无 | `importData(json)` | 返回 true，数据加载 | P0 |
| RECV-010 | 清除所有数据 | 有数据 | `clear()` | 所有会话清空 | P0 |
| RECV-011 | 消息超限自动裁剪 | maxMessagesPerSession=5 | 添加 6 条消息 | 只保留最近 5 条 | P1 |
| RECV-012 | 项目会话过滤 | 有多个项目会话 | `getProjectSessions(projectId)` | 只返回该项目的会话 | P1 |
| RECV-013 | 设置当前会话 | 无 | `setCurrentSession(id)` → `getCurrentSessionId()` | 返回 id | P0 |
| RECV-014 | trimSessions 裁剪旧会话 | maxSessions=2, 有 3 个会话 | `trimSessions()` | 只保留 2 个最新的 | P1 |
| RECV-015 | forceSave 立即写入 | 有 dirty 数据 | `forceSave()` | 数据持久化到 DB | P0 |

---

## 10. 冒烟测试（Smoke Test）

> **目标**：每次构建/发布后快速验证最关键的功能链路可用，确保应用不会因重构/新增特性而「启动即崩」。冒烟测试聚焦于「能跑起来」而非「完全正确」，覆盖初始化、核心消息流、工具执行、智能体注册、会话管理、设置持久化、权限系统、子智能体、技能系统、v0.89 新增委派/编排模块、以及关键 UI 组件可导入性。
>
> **执行策略**：`npm test -- smoke` 或 `vitest run smoke`，应在 30 秒内全部通过。任一失败 = 发布阻断（release-blocking）。

### 10.1 应用初始化冒烟（SMOKE-001 ~ SMOKE-005）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-001 | 数据库初始化不崩溃 | 无 | `initDatabase()` | 返回 Promise<void>，不 throw，DB 对象可用 | P0 |
| SMOKE-002 | 数据库重置后可重新初始化 | 已初始化 | `resetDatabase()` → `initDatabase()` | 不 throw，DB 恢复可用 | P0 |
| SMOKE-003 | 设置键值读写正常 | DB 已初始化 | `setSettingJSON("smoke-test", {ok: true})` → `getSettingJSON("smoke-test", null)` | 返回 `{ok: true}` | P0 |
| SMOKE-004 | 设置键删除正常 | SMOKE-003 完成 | `removeSetting("smoke-test")` → `getSettingJSON("smoke-test", null)` | 返回 null | P0 |
| SMOKE-005 | 项目存储 CRUD 正常 | DB 已初始化 | `createProject({name, path})` → `listProjects()` | 列表包含创建的项目 | P0 |

### 10.2 核心消息链路冒烟（SMOKE-006 ~ SMOKE-010）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-006 | 消息创建写入 DB | 有会话 | `createMessage(msg, sessionId)` → `listMessages(sessionId)` | 列表包含该消息，role/content/timestamp 正确 | P0 |
| SMOKE-007 | 消息更新写入 DB | SMOKE-006 完成 | `updateMessage(id, {status: "done"})` → `listMessages` | status 为 done | P0 |
| SMOKE-008 | 工具调用创建关联消息 | SMOKE-006 完成 | `addToolCall(msgId, toolCall)` → 查询 DB | tool_calls 表有行，message_id 关联正确 | P0 |
| SMOKE-009 | 工具调用更新状态 | SMOKE-008 完成 | `updateToolCall(id, {status: "done", result: "ok"})` | DB 中 status=done, result=ok | P0 |
| SMOKE-010 | 中文+Emoji 消息不乱码 | 无 | 创建含 "你好🌍🎉" 的消息 → 读取 | 内容完整一致 | P0 |

### 10.3 工具与智能体注册冒烟（SMOKE-011 ~ SMOKE-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-011 | 默认工具注册表包含核心工具 | 无 | `createDefaultToolRegistry().getAll()` | 包含 bash/read/write/edit/glob/grep | P0 |
| SMOKE-012 | load_skill 工具已注册 | 无 | 检查 ToolRegistry | 包含 load_skill | P0 |
| SMOKE-013 | 内置智能体可获取 | 无 | `getAgentRegistry().getAll()` | 包含 build/plan/explore/general/title/summary | P0 |
| SMOKE-014 | build 智能体权限评估正常 | 无 | `evaluatePermission("build", "bash")` | 返回 "allow" | P0 |
| SMOKE-015 | plan 智能体工具限制正常 | 无 | `canUseTool("plan", "write")` | 返回 false | P0 |

### 10.4 会话与权限冒烟（SMOKE-016 ~ SMOKE-020）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-016 | 会话创建正常 | 有项目 | `createSession(projectId, {title})` | 返回 session 对象，DB 中可查 | P0 |
| SMOKE-017 | 会话列表加载正常 | SMOKE-016 完成 | `listSessions(projectId)` | 包含创建的会话 | P0 |
| SMOKE-018 | 安全模式默认值正确 | 无 | `getGlobalSecurityMode()` | 返回 "ask" 或有效值 | P0 |
| SMOKE-019 | 安全模式切换正常 | 无 | `setGlobalSecurityMode("auto")` → `getGlobalSecurityMode()` | 返回 "auto" | P0 |
| SMOKE-020 | 受保护路径检测 | 无 | 检查 `.git` 路径 | 返回受保护 | P0 |

### 10.5 v0.89 新增模块冒烟（SMOKE-021 ~ SMOKE-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-021 | SessionMessageBus 可实例化 | 无 | `new SessionMessageBus()` / `getSessionMessageBus()` | 返回实例，不 throw | P0 |
| SMOKE-022 | DelegationOrchestrator 可获取 | 无 | `getDelegationOrchestrator()` | 返回实例，不 throw | P0 |
| SMOKE-023 | 委派任务 DB CRUD 正常 | DB 已初始化 | `createDelegationTask(task)` → `getDelegationTask(id)` | 返回任务对象，字段完整 | P0 |
| SMOKE-024 | HeartbeatManager 配置可读写 | DB 已初始化 | `getGlobalConfig()` → `setGlobalConfig({interval: 10000})` → `getGlobalConfig()` | interval 为 10000 | P0 |
| SMOKE-025 | RetryExecutor 配置可读写 | DB 已初始化 | `getConfig()` → `setConfig({maxRetries: 5})` → `getConfig()` | maxRetries 为 5 | P0 |

### 10.6 系统提示词与上下文冒烟（SMOKE-026 ~ SMOKE-030）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SMOKE-026 | buildSystemPrompt 不崩溃 | 无 | `buildSystemPrompt({agent: buildAgent})` | 返回非空字符串，不 throw | P0 |
| SMOKE-027 | 提示词包含身份段 | SMOKE-026 完成 | 检查输出 | 包含 "Identity" 或 "身份" | P0 |
| SMOKE-028 | ContextManager 可实例化 | 无 | `new ContextManager()` | 返回实例，不 throw | P0 |
| SMOKE-029 | ContextManager token 计数 | SMOKE-028 完成 | `countTokens("hello world")` | 返回正数 | P0 |
| SMOKE-030 | SessionRecoveryService 可实例化 | 无 | `new SessionRecoveryService()` / `getSessionRecoveryService()` | 返回实例，不 throw | P0 |
