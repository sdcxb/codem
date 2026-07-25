# v0.89.0 - 跨会话委派编排 + 高级调试 UI + 冒烟测试

> 本次更新引入跨会话 Agent 协作（委派/编排/执行器）、8 个高级功能 UI 面板、核心模块持久化增强、上下文压缩参数配置 UI，以及 30 个发布阻断级冒烟测试。

## 🚀 核心功能

### 跨会话 Agent 协作系统（Session Orchestration）
- **SessionMessageBus**：跨会话事件总线，支持 delegation/result/status/cancel 四种消息类型
- **DelegationOrchestrator**：委派编排器，死锁检测（深度限制）、并发控制、超时管理
- **executeSessionTurn**：程序化触发会话执行，支持 abort 取消
- **委派工具**：`delegate_to_session` / `wait_for_delegation` / `query_session_result` / `list_sessions`

### 高级功能 UI 面板（8 个新组件）
- AgentManager — 智能体管理面板
- HeartbeatMonitor — 心跳监控面板
- RetryConfigPanel — 重试配置面板
- PromptDebugger — 提示词调试面板
- LayeredSettingsPanel — 分层设置面板
- RecoveryPanel — 会话恢复面板
- ToolManager — 工具管理面板
- DelegationPanel — 委派任务面板

### 核心模块持久化增强
- AgentRegistry：自定义智能体持久化到 SQLite
- HeartbeatManager：心跳全局配置持久化
- RetryExecutor：重试配置持久化
- SessionRecoveryService：恢复数据持久化

### 上下文压缩参数配置 UI（P1-1）
- 可配置压缩触发阈值、压缩槽位模型、最大保留消息数、摘要长度限制

### 冒烟测试（Smoke Test）
- 30 个发布阻断级冒烟用例，覆盖 6 大领域
- `vitest run smoke`，30 秒内全部通过

### Bug 修复
- 修复 `SessionMessageBus` 未导出导致黑屏
- 修复 `executor.ts` / `tools.ts` 导入路径错误

## 🧪 测试覆盖
- 全部 2186 个测试通过（57 个测试文件）
- 新增 185 个回归测试用例（含 30 个冒烟测试）

## 📦 升级信息
- 版本：0.88.0 → 0.89.0
- 兼容性：向后兼容
- 平台支持：Windows 10/11
