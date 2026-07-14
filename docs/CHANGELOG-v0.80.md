# v0.80.0 - 分叉/重新生成架构重构 + UI 对比度修复 + 性能优化

## 🎯 核心改进

### 1. 分叉/重新生成 Q&A 轮次架构重构

**问题背景**：agentic loop 的多轮迭代会产生多条 assistant 消息（第一段读文件、第二段唤醒子智能体、第三段 wait、第四段合并写入）。之前每条 assistant 消息都有独立的 fork/regenerate 按钮，导致：
- 从中间段分叉 → 打破问答逻辑闭环
- 从中间段重新生成 → 语义不明确（只重生成这一段？还是后续全部？）

**解决方案 — 按轮次整体操作**：

- **分叉按钮（🔀）**：只在 user 提问消息上显示，点击后复制从开头到当前轮次结束（下一条 user 消息前）的所有消息到新会话 — 整个问答对完整分叉
- **重新生成按钮（🔄）**：只在轮次中最后一条 assistant 消息上显示，点击后从该位置往上找到 user 消息，删除该 user 消息之后的所有 assistant 消息（整轮回答），然后重新执行 `runAgenticLoop`
- **轮次分组框**：每个完整 Q&A 轮次之间有细分割线，视觉上清晰区分不同轮次；hover 时显示分叉和重新生成按钮

**修改文件**：
- `MessageBubble.tsx`：fork/regenerate 按钮移除，新增 `isLastInTurn` prop
- `ChatPanel.tsx`：按轮次分组消息，计算 `isLastInTurn` 和 `isTurnEnd`，在轮次底部渲染 footer 按钮
- `App.tsx` `handleFork`：从 `slice(0, messageIndex+1)` 改为 `slice(0, endIdx)`，分叉整个轮次
- `App.tsx` `handleRegenerate`：从 `slice(messageIndex)` 改为 `slice(userIndex+1)`，保留 user 消息删除整轮回答

### 2. UI 对比度修复（深色/浅色模式）

**根因**：大量使用不存在的 CSS 变量：
- `var(--accent-primary)` → 应为 `var(--accent)`
- `var(--text-error)` → 应为 `var(--error)`
- `var(--border-color)` → 应为 `var(--border-primary)`

**修复内容**：
- 新增 `--text-on-accent: #ffffff` 语义变量，统一所有强调色按钮的文字颜色
- 修复 `.agent-toggle.active` 从紫字紫底改为 `color: var(--text-primary)`
- 修复 `.mode-toggle-btn` 缺少 `color` 属性导致深色模式按钮不可见
- 修复 `.compaction-banner.compaction-active` 文字颜色
- 记忆系统：统一所有按钮为 `memory-action-btn` 风格，移除 ➕/📥/📝/📤/🧹 emoji，改用纯文本
- MCP 管理：统一所有按钮为 `mcp-action-btn` 风格，➕ 替换为 `+`
- ContextMonitor：🗜️ emoji 替换为 `▼` 纯文本（Windows 上 🗜️ 渲染为紫色，深色模式不可见）
- 设置面板：修复会话恢复/用量统计按钮白字浅底不可见
- ModelProfilePanel / CloseConfirmDialog / MultimodalPanel / ChatPanel：修复 accent 变量引用

### 3. 滚动性能优化

- **CSS `content-visibility: auto`**：浏览器原生跳过屏外消息的渲染计算
- **CSS `contain: content`**：限制浏览器 reflow 范围到单个消息气泡
- **`React.memo()`** 包装 `MessageBubble`：已完成消息不再因父组件状态变化而重渲染
- **`useMemo()`** 缓存 ReactMarkdown `components` 配置：避免每次渲染重新创建对象导致 Markdown 重新解析

### 4. 会话置顶功能修复

**问题**：
- 置顶按钮 `onClick` 只做了 `e.stopPropagation()`，完全没有 toggle 逻辑
- `pinned` 字段没有持久化到 SQLite（Session 接口、DB schema、CRUD 全部缺失）
- store 的 `updateSession` 强制 `lastMessageAt: Date.now()`，导致取消置顶后会话排到顶部
- 连续快速点击时 React 闭包捕获旧值导致 toggle 混乱

**修复**：
- `Session` 接口新增 `pinned?: boolean`
- sessions 表新增 `pinned INTEGER DEFAULT 0` 列 + migration
- `SessionStorage`：`SessionRow` / `rowToSession` / `rowToSessionFromAny` / `createSession` / `updateSession` 全部支持 `pinned`
- 新增 `SessionStorage.togglePinned(id)` 原子性 toggle（从 DB 读取真实当前值，不依赖 React 闭包）
- `listSessions` SQL 改为 `ORDER BY pinned DESC, last_message_at DESC`
- 图标切换：未置顶 📌 / 已置顶 📍
- `onPin` handler 直接调用 `SessionStorage.togglePinned()`，绕过 store 层的 `lastMessageAt` 强制更新

### 5. 记忆系统修复

- `MemoryService` 新增 `reload()` 方法，解决单例在 DB 初始化前创建导致数据为空的问题
- `MemoryManager` 打开时先调用 `reload()` 再加载条目

### 6. 测试覆盖

新增批次 E 测试（49 个用例），覆盖：
- E1: isLastInTurn 轮次末尾检测逻辑
- E2: handleFork 整轮分叉逻辑
- E3: handleRegenerate 整轮重跑逻辑
- E4: MessageBubble 按钮显示条件
- E5: ChatPanel isLastInTurn 计算
- E6: App.tsx handleFork 源码验证
- E7: App.tsx handleRegenerate 源码验证
- E8: 工具调用 + 子智能体场景
- E9: 边界条件（空消息列表、连续 user、system 消息）
- E10: 消息反馈工具栏不受影响

全部 166 个测试通过。

## 📦 升级信息

- **版本**：0.79.9 → 0.80.0
- **数据库迁移**：自动添加 sessions 表 pinned 列（无需手动操作）
- **兼容性**：向后兼容，旧版本数据自动迁移

---

# v0.80.1 - 全局对话 + 任务完成通知 + 新建对话修复 + DB 防抖

## 🎯 核心改进

### 1. 全局对话功能

**问题**：左侧栏只有项目对话区域，点击"新对话"按钮只在项目下创建对话。

**修复**：
- 新增"全局对话"区域，显示 `projectId = ""` 的会话，支持时间分组、置顶等全部功能
- "新对话"按钮始终创建全局会话（清除 currentProject），项目内新建对话由项目旁 `+` 按钮负责
- `handleSessionClick` 处理 `__global__` projectId 映射
- `handleSend` 和 `runAgenticLoop` 从 `useProjectStore.getState().currentSession` 读取最新 session（避免闭包过期）
- App.tsx 中 4 处 `if (currentProject && currentSession)` 改为 `if (currentSession)` 支持全局会话

### 2. 任务完成通知（对标 Codex）

**问题**：应用最小化/后台运行时，对话任务完成后用户不知道。

**修复**：
- 新增 `windowVisibleRef`，通过 `blur`/`focus`/`visibilitychange` 三重事件追踪窗口可见性
- 任务完成时检查 `!windowVisibleRef.current`，若在后台则：
  - 通过 Tauri 内部 API `plugin:window|show` + `set_focus` + `unminimize` 弹出窗口
  - 通过 `plugin:notification|notify` 发送原生通知
  - 通知格式对标 Codex：标题 `任务完成 — 对话标题`，内容 `"提问内容" 执行完毕，点击查看结果`
- Rust 侧：`tauri-plugin-notification` 依赖 + `capabilities/default.json` 权限

### 3. 子智能体历史状态修复

**问题**：切换历史对话后，子智能体状态短暂闪烁为"运行中"或消失。

**修复**：
- `SubagentStatus` 初始状态改为 `"init"`（不渲染任何内容）
- 当 `getTask()` 返回 `undefined`（历史会话，内存已清空）时，回退到 `toolStatus` prop
- `SubagentStatus` 新增 `toolStatus` prop，从 `tc.status` 传入

### 4. 新建对话速度优化（4-5秒 → 即时）

**根因**：`persistDatabase()` 每次调用都执行 `db.export()` + base64 + 写文件，`handleNewSession` 有嵌套 `setTimeout(50)`。

**修复**：
- `saveDatabaseAsync` 改为 500ms 防抖，连续写操作只触发一次全量保存
- `handleNewSession` 移除嵌套 `setTimeout`，改为同步调用
- 新增 `flushDatabase()` 函数用于需要立即保存的场景

### 5. 设置面板用户信息加载

**问题**：BootstrapWizard 保存的 `codem-user`（名字/称呼）在 SettingsPanel 打开时为空。

**修复**：`SettingsPanel` useEffect 中新增从 `getSettingJSON("codem-user")` 加载用户配置

### 6. Zustand API 修复

**问题**：`useProjectStore.getState().set(...)` 报错 — Zustand 没有 `.set()` 方法。

**修复**：改为 `useProjectStore.setState(...)`

### 7. BootstrapWizard 保存验证

**修复**：`handleFinish` 添加保存后立即读取验证（`getSettingJSON`），控制台输出验证结果

## 📦 升级信息

- **版本**：0.80.0 → 0.80.1
- **新增依赖**：`@tauri-apps/plugin-notification`、`@tauri-apps/api`、Rust `tauri-plugin-notification`
- **兼容性**：向后兼容
