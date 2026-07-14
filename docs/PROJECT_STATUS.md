# Codem 项目开发状态

> 本文档供新对话快速理解项目当前状态。最后更新：v0.80.1

## 项目概述

**Codem** 是对标 Codex 的 AI 编程助手桌面应用，基于 Tauri v2 + React + TypeScript 构建。

- **技术栈**：Tauri v2（Rust 后端）+ React 18 + TypeScript + Vite + Zustand + Radix UI
- **存储**：SQLite（sql.js，通过 Tauri 文件系统持久化到 AppData）
- **模型接入**：MiMo CLI（小米账户登录）+ OpenAI 兼容 API（多 Provider）
- **GitHub**：https://github.com/sdcxb/codem

## 架构总览

```
App.tsx                    — 主应用，状态管理 + 事件处理
├── Sidebar.tsx            — 左侧栏（全局对话 + 项目对话 + 导航）
├── ChatPanel.tsx          — 对话面板（消息列表 + 输入区 + 轮次分组）
│   ├── MessageBubble.tsx  — 消息气泡（React.memo 优化，子智能体状态）
│   └── InputArea.tsx     — 输入区（安全模式切换 + 文件上传 + 引用）
├── TerminalPanel.tsx      — 终端面板
├── FileExplorer.tsx      — 文件浏览器
└── SettingsPanel.tsx     — 设置面板（API + 身份 + 用户配置）
```

### 核心引擎层（src/core/）

| 模块 | 文件 | 功能 |
|------|------|------|
| LLM 引擎 | `llm/index.ts` | 统一引擎，管理 Provider/Tool/Agent/Memory/MCP |
| Agentic Loop | `llm/agentic-loop.ts` | 多轮迭代循环，流式处理，工具调用 |
| Provider | `llm/provider.ts` | OpenAI/MiMo/DeepSeek 等 API 适配 |
| 子智能体 | `subagent/subagent.ts` | spawn/wait fork-join 模式 |
| 记忆系统 | `memory/memory.ts` | SQLite 持久化，project/session/global 三级 |
| 上下文管理 | `context/context.ts` | token 计数 + 自动压缩 |
| 权限系统 | `permission/permission.ts` | 受保护路径 + 安全模式 |
| MCP | `mcp/mcp.ts` | stdio 传输，工具代理 |
| 恢复系统 | `recovery/recovery.ts` | 多层会话恢复 |

### 存储层（src/core/storage/）

| 文件 | 功能 |
|------|------|
| `database.ts` | SQLite 初始化 + 防抖持久化（500ms debounce）|
| `session.ts` | 会话 CRUD + pinned + togglePinned |
| `message.ts` | 消息 CRUD |
| `project.ts` | 项目 CRUD + pinned |
| `settings.ts` | 键值设置存储（替代 localStorage）|

### 状态管理

- `store.ts`（useAppStore）：消息、流式状态、工具调用、步骤进度
- `core/store.ts`（useProjectStore）：项目、会话、技能、记忆

## 当前版本功能清单

### ✅ 已完成

- [x] **对话核心**：流式对话、工具调用、多轮 agentic loop
- [x] **全局对话**：新对话按钮创建全局会话（projectId=""），项目内对话独立
- [x] **会话管理**：置顶（原子 togglePinned）、时间分组、分叉（按轮次整体分叉）
- [x] **重新生成**：按 Q&A 轮次整体重跑（删除整轮 assistant 消息后重新执行）
- [x] **轮次分组**：Q&A 轮次间分隔线，hover 显示操作按钮
- [x] **子智能体**：spawn/wait fork-join，历史状态回退（toolStatus fallback）
- [x] **记忆系统**：三级 scope（project/session/global），SQLite 持久化，reload 机制
- [x] **MCP 集成**：stdio 传输，工具代理
- [x] **技能系统**：SKILL.md 加载，GUI 管理
- [x] **安全模式**：default/blocked 隔离沙箱，受保护路径
- [x] **任务完成通知**：窗口最小化时弹窗 + 原生通知（含对话标题和提问内容）
- [x] **性能优化**：content-visibility、React.memo、useMemo、DB 防抖
- [x] **UI 对比度**：深色/浅色模式 CSS 变量统一
- [x] **初始化引导**：BootstrapWizard（AI 身份 + 用户信息）
- [x] **i18n**：中英文双语

### 🔄 待完成

- [ ] 更多 Provider 测试（目前主要测试了 DeepSeek + MiMo）
- [ ] Skills/MCP 完整功能测试
- [ ] 对话搜索功能完善
- [ ] 上下文压缩策略优化

## 关键技术决策

1. **SQLite via sql.js**：所有数据存储在内存中的 SQLite，通过 Tauri 文件系统持久化到 `AppData/Roaming/com.codem.app/codem-db.bin`
2. **DB 防抖持久化**：`persistDatabase()` 使用 500ms debounce，避免连续写操作时多次序列化全量 DB
3. **handleSend 从 store 读取 session**：`useProjectStore.getState().currentSession` 避免闭包过期导致消息追加到错误会话
4. **SubagentStatus toolStatus fallback**：历史对话中 SubagentManager 内存已清空，通过 tool call 状态回退显示
5. **Zustand setState**：不能用 `.getState().set()`（不存在），用 `useProjectStore.setState()`

## 测试覆盖

- 188 个测试（`src/test/ui-batch-a-d.test.ts`），覆盖批次 A-F
- 批次 E：轮次分组 + 分叉/重新生成
- 批次 F：子智能体状态 + 全局对话 + 性能 + 通知 + pinned 持久化

## 版本历史

| 版本 | 日期 | 主要内容 |
|------|------|---------|
| v0.70 | 2026-07-06 | 存储统一 SQLite + 中文编码修复 + 子智能体重构 |
| v0.80 | 2026-07-14 | 轮次架构 + UI 对比度 + 性能优化 + 置顶功能 |
| v0.80.1 | 2026-07-14 | 全局对话 + 任务通知 + 新建对话修复 + DB 防抖 |
