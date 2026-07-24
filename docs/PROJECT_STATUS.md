# Codem 项目开发状态

> 本文档供新对话快速理解项目当前状态。最后更新：v0.87（含 Worktree 全链路 + 并行对话 + 自动任务 + GitHub Clone + 侧边栏重构 + 全局字体）

## 项目概述

**Codem** 是对标 Codex 的 AI 编程助手桌面应用，基于 Tauri v2 + React + TypeScript 构建。

- **技术栈**：Tauri v2（Rust 后端）+ React 18 + TypeScript + Vite + Zustand + Radix UI
- **存储**：SQLite（sql.js，通过 Tauri 文件系统持久化到 AppData）
- **模型接入**：MiMo CLI（小米账户登录）+ OpenAI 兼容 API（多 Provider）
- **GitHub**：https://github.com/sdcxb/codem
- **当前版本**：v0.87（已发布 release）

## 架构总览

```
App.tsx                    — 主应用，状态管理 + 事件处理
├── Sidebar.tsx            — 左侧栏（全局对话 + 项目对话 + 导航）
├── ChatPanel.tsx          — 对话面板（消息列表 + 输入区 + 轮次分组 + 显示模式切换）
│   ├── MessageBubble.tsx  — 消息气泡（React.memo 优化，子智能体状态，分段/统一渲染）
│   └── InputArea.tsx     — 输入区（安全模式切换 + 文件上传 + 引用）
├── TerminalPanel.tsx      — 终端面板
├── FileExplorer.tsx      — 文件浏览器
├── BootstrapWizard.tsx   — 初始化引导（AI 身份 + 用户信息）
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
| `database.ts` | SQLite 初始化 + 防抖持久化（500ms debounce）+ flushDatabase |
| `session.ts` | 会话 CRUD + pinned + togglePinned |
| `message.ts` | 消息 CRUD |
| `project.ts` | 项目 CRUD + pinned |
| `settings.ts` | 键值设置存储（替代 localStorage）|

### 状态管理

- `store.ts`（useAppStore）：消息、流式状态、工具调用、步骤进度、**displayMode（"segmented" | "unified"）**
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
- [x] **任务完成通知**：窗口最小化时弹窗 + 原生通知（含对话标题和提问内容，对标 Codex）
- [x] **性能优化**：content-visibility、React.memo、useMemo、DB 防抖（500ms）
- [x] **UI 对比度**：深色/浅色模式 CSS 变量统一
- [x] **初始化引导**：BootstrapWizard（AI 身份 + 用户信息，保存后验证）
- [x] **i18n**：中英文双语
- [x] **显示模式切换**：分段（segmented）/ 统一（unified，默认），统一模式将连续 assistant 消息合并为一个气泡
- [x] **子智能体调用修复**：跨迭代去重 + cacheHitCount 机制，修复 wait_for_subagent 无限循环
- [x] **任务完整性检查增强**：追加/汇总关键词检测，防止 LLM 提前停止
- [x] **Git Worktree 全链路**：worktree-manager.ts（create/remove/scan/limit）+ handleSend 自动创建 + deleteSession 自动清理 + forkSession 继承
- [x] **并行对话**：per-session Map 隔离（activeSessions/loopPool/权限/写确认/提示词变更/表单），多会话同时流式
- [x] **自动任务**：automation-manager.ts（timer/file_watch 触发器）+ 设置面板配置 + 自动回调 handleSend
- [x] **InputArea 底部控制栏**：项目/模式/分支/安全模式选择器，一键切换执行环境
- [x] **GitInfoPanel**：分支/dirty/diff/commit/push/pull/worktree 实时监控面板
- [x] **GitHub Clone**：项目管理器新增从 GitHub 拉取功能，支持 git clone URL 直接创建项目
- [x] **侧边栏布局重构**：分段控件（MCP/技能/记忆）+ 独立滚动 + Portal 菜单 + 标题栏按钮
- [x] **全局字体系统**：内置 Alimama 方圆体 + 字体选择器 + 字重滑块（100-900）
- [x] **SlashCommandMenu**：/ 命令菜单
- [x] **Prompt Cache 优化**：System Prompt 时间戳降为分钟精度，提升 KV Cache 命中率
- [x] **梦幻皮肤磨砂弹窗**：所有弹窗组件用 createPortal 渲染，绕过 backdrop-filter 问题
- [x] **安全移除项目**：三按钮弹窗（移除/删除到回收站/取消）
- [x] **设置侧边栏分栏**：9 个 Tab（通用/外观/安全/Git/环境/Worktree/知识/自动化/多模态）
- [x] **分段控件主题适配**：color-mix + --accent 主题色自适应，三套皮肤均有良好对比度

### 🔧 开发中

（无）

### 🔄 待完成

- [ ] Phase E：Work 模式拆分（Codex/Work 双模式切换）
- [ ] 更多 Provider 测试（目前主要测试了 DeepSeek + MiMo）
- [ ] REFACTOR-PROMPT-TO-DATA（提示词约束→数据层约束的重构计划）
- [ ] MSI 中文向导（WiX 多语言配置）
- [ ] 对话搜索功能完善
- [ ] Vision API 图片理解（将粘贴的图片数据传给 vision 模型）
- [ ] 上下文压缩策略优化

## 关键技术决策

1. **SQLite via sql.js**：所有数据存储在内存中的 SQLite，通过 Tauri 文件系统持久化到 `AppData/Roaming/com.codem.app/codem-db.bin`
2. **DB 防抖持久化**：`persistDatabase()` 使用 500ms debounce，避免连续写操作时多次序列化全量 DB；`flushDatabase()` 用于立即保存
3. **handleSend 从 store 读取 session**：`useProjectStore.getState().currentSession` 避免闭包过期导致消息追加到错误会话
4. **runAgenticLoop 接收 session 参数**：`handleSend` 和 `handleRegenerate` 都从 store 读取 session 并传给 `runAgenticLoop(message, session)`
5. **SubagentStatus toolStatus fallback**：历史对话中 SubagentManager 内存已清空，通过 tool call 状态（`tc.status`）回退显示
6. **Zustand setState**：不能用 `.getState().set()`（不存在），用 `useProjectStore.setState()`
7. **任务完成通知**：用 `windowVisibleRef`（blur/focus/visibilitychange 三重事件）追踪窗口可见性，不用 `document.visibilityState`（Tauri 最小化时不可靠）；通过 Tauri 内部 API `plugin:window|show` + `plugin:notification|notify` 调用
8. **全局对话**：useEffect 中 `if (currentSession)` 替代 `if (currentProject && currentSession)`，CLI session ID 用 `currentProject?.id || ""` 兼容全局会话

## .wecode-ref 参考项目

项目下 `.wecode-ref/` 目录是一个对标 Codex 的客户端项目（微博出品），可参考其实现：
- 非分段式对话渲染：`frontend/src/features/tasks/components/message/MessageBubble.tsx` 使用 `MixedContentView` 交错渲染 text/thinking/tool blocks
- 消息 blocks 数组：`msg.result.blocks` 是 `MessageBlock[]` 类型，包含 text/thinking/tool/image/video
- `ReasoningDisplay` 和 `ThinkingDisplay` 是统一的折叠面板

## 测试覆盖

- 1614 个测试（36 个测试文件），覆盖 UI 批次 A-F + 安全模式 + Git 环境 + Worktree + 命名规范等

## 版本历史

| 版本 | 日期 | 主要内容 |
|------|------|---------|
| v0.70 | 2026-07-06 | 存储统一 SQLite + 中文编码修复 + 子智能体重构 |
| v0.80 | 2026-07-14 | 轮次架构 + UI 对比度 + 性能优化 + 置顶功能 |
| v0.80.1 | 2026-07-14 | 全局对话 + 任务通知 + 新建对话修复 + DB 防抖 |
| 开发中 | 2026-07-15 | 显示模式切换（分段/统一）— 未提交未发版 |
| v0.80.2 | 2026-07-15 | 显示模式切换 + 子智能体调用修复 + 任务完整性增强 |
| v0.85 | 2026-07-19 | 技能触发三层改造 + 附件系统重构 + 全局对话持久化修复 + 技能市场 + Web搜索 |
| v0.86 | 2026-07-20 | 皮肤系统（默认/Hub/梦幻）+ 窗口 Mica 毛玻璃 + 自定义标题栏 + UI 修复 |
| v0.87 | 2026-07-24 | Worktree全链路 + 并行对话 + 自动任务 + GitHub Clone + 侧边栏重构 + 全局字体 + Prompt Cache优化 |

## 当前工作区状态

v0.87 已发布，工作区干净（git working tree clean）。全部 1614 个测试通过。
