# v0.89.0 - 跨会话委派编排 + 高级调试 UI + 冒烟测试

> 本次更新引入跨会话 Agent 协作（委派/编排/执行器）、8 个高级功能 UI 面板（AgentManager/HeartbeatMonitor/RetryConfigPanel/PromptDebugger/LayeredSettingsPanel/RecoveryPanel/ToolManager/DelegationPanel）、核心模块持久化增强、上下文压缩参数配置 UI，以及 30 个发布阻断级冒烟测试。涉及 30+ 个新增/修改文件，+5000 行代码。

## 🚀 核心功能

### 一、跨会话 Agent 协作系统（Session Orchestration）

**新增模块 `src/core/session/`：**

- **SessionMessageBus（`bus.ts`）**：跨会话事件总线，支持 delegation/result/status/cancel 四种消息类型，发布-订阅模式，会话间实时通信
- **DelegationOrchestrator（`orchestrator.ts`）**：委派编排器，死锁检测（A→B→C 深度限制）、并发控制（maxConcurrent）、超时管理
- **executeSessionTurn（`executor.ts`）**：程序化触发会话执行，支持 abort 取消、pending 委派处理
- **DelegationStorage（`delegation-storage.ts`）**：SQLite 持久化层，delegation_tasks 表 CRUD
- **委派工具（`tools.ts`）**：`delegate_to_session` / `wait_for_delegation` / `query_session_result` / `list_sessions` 四个 LLM 可调用工具

**委派流程：**
```
会话 A (源) → delegate_to_session(task, targetSessionId)
  → DelegationOrchestrator 委派任务到会话 B
  → SessionMessageBus 发送 delegation 消息
  → 会话 B (目标) 执行任务
  → 结果通过 result 消息回传
  → 会话 A 调用 wait_for_delegation(taskId) 获取结果
```

### 二、高级功能 UI 面板（8 个新组件）

| 组件 | 功能 | 入口 |
|------|------|------|
| **AgentManager.tsx** | 智能体管理面板，查看/编辑/注册自定义智能体，权限规则可视化 | 设置 → 高级 |
| **HeartbeatMonitor.tsx** | 心跳监控面板，实时显示会话心跳状态、全局配置（间隔/超时/最大失败数） | 设置 → 高级 |
| **RetryConfigPanel.tsx** | 重试配置面板，指数退避参数可视化配置（最大重试/基础延迟/倍率/上限/总超时） | 设置 → 高级 |
| **PromptDebugger.tsx** | 提示词调试面板，查看完整系统提示词、智能体提示词、变量注入预览 | 设置 → 高级 |
| **LayeredSettingsPanel.tsx** | 分层设置面板，展示七层设置源（cli/policy/flag/user/project/local/default）及生效值 | 设置 → 高级 |
| **RecoveryPanel.tsx** | 会话恢复面板，浏览/恢复/删除历史会话，强制保存控制 | 设置 → 高级 |
| **ToolManager.tsx** | 工具管理面板，查看已注册工具列表、参数 Schema、权限规则 | 设置 → 高级 |
| **DelegationPanel.tsx** | 委派任务面板，查看活跃/已完成委派任务，跨会话任务追踪 | 设置 → 高级 |

### 三、核心模块持久化增强

以下核心模块新增 SQLite 持久化，重启后配置不丢失：

- **AgentRegistry**：`loadCustomAgents` / `saveCustomAgents` / `update` / `unregister` / `isBuiltin`，自定义智能体持久化到 `codem-custom-agents` 设置键
- **HeartbeatManager**：`getGlobalConfig` / `setGlobalConfig`，心跳全局配置持久化到 `codem-heartbeat-config` 设置键
- **RetryExecutor**：`getConfig` / `setConfig`，重试配置持久化到 `codem-retry-config` 设置键
- **SessionRecoveryService**：`loadRecoveryData` / `saveRecoveryData`，恢复数据持久化到 SQLite recovery_data 表

### 四、上下文压缩参数配置 UI（P1-1）

- 设置面板新增「上下文压缩」配置区域
- 可配置参数：
  - 压缩触发阈值（context pressure 百分比，默认 80%）
  - 压缩槽位模型选择（可降级到更便宜的模型）
  - 最大保留消息数
  - 压缩后摘要长度限制
- 参数变更实时生效，下次压缩使用新配置

### 五、冒烟测试（Smoke Test）

- 新增 `src/test/smoke-test.test.ts`，30 个发布阻断级冒烟用例
- 覆盖 6 大领域：应用初始化、核心消息链路、工具与智能体注册、会话与权限、v0.89 新增模块、系统提示词与上下文
- 执行策略：`vitest run smoke`，30 秒内全部通过
- 任一失败 = 发布阻断

### 六、Bug 修复

- **修复 `SessionMessageBus` 未导出导致黑屏**：`bus.ts` 中 `SessionMessageBus` 类缺少 `export` 关键字
- **修复 `executor.ts` 导入路径错误**：`useAppStore` 路径从 `../store` 修正为 `../../store`
- **修复 `tools.ts` 导入路径错误**：`ToolDef` 路径从 `../tools` 修正为 `../llm/tools`；`getLang` 路径修正为 `../i18n/lang`

## 🧪 测试覆盖

### 回归测试用例 V2（`TEST-CASES-REGRESSION-V2.md`）

新增 185 个回归测试用例（含 30 个冒烟测试），覆盖 9 大模块：

| 模块 | 用例数 |
|------|--------|
| AgentRegistry 持久化回归 | 20 |
| HeartbeatManager 配置回归 | 15 |
| RetryExecutor 配置回归 | 15 |
| 新增设置键不冲突 | 15 |
| Git/Worktree/环境配置对核心链路影响 | 25 |
| 消息链路与存储完整性 | 20 |
| 工具调用与权限回归 | 20 |
| 系统提示词构建回归 | 15 |
| 会话恢复与多层恢复回归 | 15 |
| **冒烟测试（Smoke Test）** | **30** |

### 测试文件清单（新增）

| 文件 | 用例数 |
|------|--------|
| `regression-agent-registry.test.ts` | 20 |
| `regression-heartbeat.test.ts` | 15 |
| `regression-retry.test.ts` | 15 |
| `regression-settings-keys.test.ts` | 15 |
| `regression-git-worktree-env.test.ts` | 25 |
| `regression-message-chain.test.ts` | 20 |
| `regression-tool-permission.test.ts` | 20 |
| `regression-prompt-builder.test.ts` | 15 |
| `regression-session-recovery.test.ts` | 15 |
| `smoke-test.test.ts` | 30 |
| `core-chat-message-storage.test.ts` | — |
| `core-context-memory.test.ts` | — |
| `core-delegation-orchestration.test.ts` | — |
| `core-reasoning-feedback.test.ts` | — |
| `core-security-permission.test.ts` | — |
| `core-skill-loading.test.ts` | — |
| `core-storage-persistence.test.ts` | — |
| `core-subagent-lifecycle.test.ts` | — |
| `core-tool-execution.test.ts` | — |
| `core-worktree-environment.test.ts` | — |

## 🔧 技术细节

### 新增文件

**核心模块：**
- `src/core/session/index.ts` — 统一导出
- `src/core/session/types.ts` — 类型定义（DelegationTask / SessionMessage / DelegationConfig）
- `src/core/session/bus.ts` — SessionMessageBus 跨会话事件总线
- `src/core/session/orchestrator.ts` — DelegationOrchestrator 编排器
- `src/core/session/executor.ts` — executeSessionTurn 执行器
- `src/core/session/delegation-storage.ts` — 委派任务 SQLite 存储
- `src/core/session/tools.ts` — 委派工具定义

**UI 组件：**
- `src/components/AgentManager.tsx`
- `src/components/DelegationPanel.tsx`
- `src/components/HeartbeatMonitor.tsx`
- `src/components/LayeredSettingsPanel.tsx`
- `src/components/PromptDebugger.tsx`
- `src/components/RecoveryPanel.tsx`
- `src/components/RetryConfigPanel.tsx`
- `src/components/ToolManager.tsx`

**测试：**
- `src/test/smoke-test.test.ts` — 30 个冒烟测试
- `src/test/regression-*.test.ts` — 9 个回归测试文件
- `src/test/core-*.test.ts` — 10 个核心功能测试文件

**文档：**
- `docs/CHANGELOG-v0.89.md` — 本文件
- `docs/TEST-CASES-REGRESSION-V2.md` — 回归测试用例 V2（含冒烟测试）

### 修改文件

- `package.json` / `Cargo.toml` / `tauri.conf.json` — 版本号 0.88.0 → 0.89.0
- `src/core/agent/agent.ts` — AgentRegistry 持久化方法
- `src/core/heartbeat/heartbeat.ts` — HeartbeatManager 全局配置持久化
- `src/core/retry/retry.ts` — RetryExecutor 配置持久化
- `src/core/context/context.ts` — 压缩参数配置
- `src/core/llm/agentic-loop.ts` — 压缩配置集成
- `src/core/llm/cost-tracker.ts` — 成本追踪增强
- `src/core/llm/index.ts` — 引擎初始化增强
- `src/core/prompt/prompt.ts` — 提示词构建增强
- `src/core/storage/database.ts` — delegation_tasks 表
- `src/components/SettingsPanel.tsx` — 新增「高级」Tab 集成 8 个面板
- `src/components/ChatPanel.tsx` — UI 适配
- `src/components/Sidebar.tsx` — UI 适配
- `src/components/ContextMonitor.tsx` — 压缩参数显示
- `src/components/UsageStats.tsx` — 统计增强
- `src/App.tsx` — 应用初始化增强
- `src/core/heartbeat/heartbeat.ts` — 心跳增强
- `src/core/retry/retry.ts` — 重试增强

## 📦 升级信息

- **版本**：0.88.0 → 0.89.0
- **新增依赖**：无（全部复用已有依赖）
- **新增文件**：30+ 个（7 个核心模块 + 8 个 UI 组件 + 20 个测试文件 + 2 个文档）
- **兼容性**：向后兼容
- **平台支持**：Windows 10/11

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 下载: https://github.com/sdcxb/codem/releases/tag/v0.89.0
