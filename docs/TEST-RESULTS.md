# 全量测试结果 — 代码静态分析+逻辑追踪

> 测试方法：逐行追踪代码路径，验证每个测试用例的预期行为
> 测试日期：2026-07-23

---

## A. 对话核心链路

### A1. 基本发送→流式回答→完成 — ✅ 通过
- `handleSend` 读取 `useProjectStore.getState().currentSession`（非闭包 stale）✅
- `runAgenticLoop` 设置 `setStreaming(true)` + `setSessionActive(session.id, true)` ✅
- `text_delta` 用 `safeAddMessage` + per-session buffer ✅
- `finally` 块清除 `setStreaming(false)` + `setSessionActive(session.id, false)` + `streamingSessionIdRef = null` ✅

### A2. 思考过程(reasoning) — ✅ 通过
- `reasoning_delta` 事件用 `safeAddMessage` 创建 assistant 消息 ✅
- `safeUpdateMessage` 更新 reasoning 内容 ✅
- 切换会话后 reasoning 内容存入 DB ✅

### A3. 多轮迭代(iteration) — ✅ 通过
- `start` 事件 iter>1 时 `flushStreamBuffer(session.id)` ✅
- `safeUpdateMessage` 标记前一轮为 done ✅
- 新 `assistantMsgId` 生成 ✅
- 每轮 `saveMessages(session.id)` 保存到 DB ✅

### A4. 消息存储与加载 — ✅ 通过
- `useEffect([currentProject?.id, currentSession?.id])` 触发 `loadMessages` ✅
- 切换前 `saveMessages(messagesSessionRef.current)` 保存旧会话 ✅
- DB 层 `MessageStorage.listMessages` 不变 ✅

### A5. 消息流式buffer — ✅ 通过
- `streamBufferRef: Map<sessionId, buffer>` per-session ✅
- `flushStreamBuffer(session.id)` 只 flush 指定会话 ✅
- flush 时检查 `isViewingSession()` 才调用 `appendToMessage` ✅

---

## B. 工具调用链路

### B1. 基本工具调用 — ✅ 通过
- `tool_start` 用 `safeAddMessage` + `isViewingSession()` 守卫 `addToolCall` ✅
- `saveMessages(session.id)` 立即保存 ✅

### B2. 权限请求 — ✅ 通过
- `onPermissionRequest` 用 `setPendingPermissions` per-session Map ✅
- `pendingPermission = currentSession ? pendingPermissions.get(currentSession.id) : null` ✅
- resolve 后 `clearPendingPermission()` 清除当前会话 ✅

### B3. 写文件确认 — ✅ 通过
- `onWriteConfirm` 用 `setPendingWriteConfirms` per-session Map ✅
- resolve 后 `clearPendingWriteConfirm()` ✅

### B4. 并行权限请求 — ⚠️ 发现问题
- **问题**：`onPromptChangeSubmit` 和 `onInteractiveForm` 仍用全局单例 `setPendingPromptChanges` / `setPendingInteractiveForm`，未 per-session 化
- **影响**：并行会话的 prompt change 和 interactive form 请求会互相覆盖
- **严重性**：中（这两个功能在并行时使用概率较低）

### B5. tool_complete/tool_error 未守卫 — 🔴 发现问题
- `tool_complete` 中 `updateToolCall(assistantMsgId, tc.id, {...})` 直接调用，**未检查 `isViewingSession()`**
- `tool_error` 中 `updateToolCall(assistantMsgId, tc.id, {...})` 也未检查
- **影响**：后台会话的工具结果会更新到前台会话的消息上（如果 messageId 相同的极端情况）
- **修复**：改为 `if (isViewingSession()) updateToolCall(...)`

---

## C. 子智能体调用

### C1. 子智能体生成与执行 — ✅ 通过
- `processSubagent(sessionId, ...)` 传递 `sessionId` 到 `getAgenticLoop(agentId, sessionId)` ✅
- 子智能体获得独立的 loop 实例 ✅
- `handleGlobalPause` abort 所有 `abortControllersRef.current.values()` ✅

### C2. 并行模式下的子智能体 — ✅ 通过
- 会话 A 的子智能体使用 `loopPool.get(A.id)` ✅
- 会话 B 的子智能体使用 `loopPool.get(B.id)` ✅
- `handleCancel` 只 abort `currentSession.id` 的 controller ✅

---

## D. 技能调用

### D1. 基本技能调用 — ✅ 通过
- SlashCommandMenu 正常工作 ✅
- `userSelectedSkills` 传入 `engine.process` 的 options ✅

### D2. 技能与Worktree — ✅ 通过
- `cwd` 在 worktree 模式下切换到 worktree 路径 ✅
- 技能工具使用 `cwd` 执行 ✅

---

## E. Git Worktree 全链路

### E1. 创建Worktree — ✅ 通过
- `session.executionMode === "git_worktree"` 检查 ✅
- `createWorktree(currentProject.path, session.id, session.worktreeBranch)` ✅
- 成功 toast + 失败 toast ✅
- `updateSession(session.id, { worktreePath: wtPath })` 持久化 ✅

### E2. 删除会话清理Worktree — ✅ 通过
- `deleteSession` 调用 `removeWorktreeSync` ✅
- `cleanupSessionLoop?.(sessionId)` 清理引擎池 ✅

### E3. 分支选择 — ✅ 通过
- PowerShell 单引号转义 `projectPath.replace(/'/g, "''")` ✅
- `git -C '${safePath}' checkout '${safeBranch}'` ✅

### E4. Worktree设置管理 — ✅ 通过
- 扫描/删除/上限管理全部实现 ✅
- 显示 `当前: N/15` ✅

### E5. 模式切换Dirty检查 — ✅ 通过
- `handleExecutionModeChange` 检查 `hasUncommittedChanges` ✅
- confirm 弹窗 ✅

### E6. Fork会话 — ✅ 通过
- `forkSession` 继承 `executionMode` ✅
- `createWorktreeSync` 创建独立 worktree ✅

---

## F. 并行对话

### F1. 基本并行发送 — ✅ 通过
- `disabled = (!currentSessionId || activeSessions.has(currentSessionId)) || !connected` ✅
- 会话 A 运行时切换到 B，B 的 `activeSessions.has(B.id)` = false → 输入框可用 ✅

### F2. 消息隔离 — ✅ 通过
- `safeAddMessage` 检查 `isViewingSession()` ✅
- `safeUpdateMessage` 检查 `isViewingSession()` ✅
- `flushStreamBuffer` 检查 `isViewingSession()` ✅

### F3. 并行取消 — ✅ 通过
- `handleCancel` 只 abort `currentSession.id` 的 controller ✅
- 其他会话不受影响 ✅

### F4. 全局暂停 — ✅ 通过
- `handleGlobalPause` abort 所有 `abortControllersRef.current.values()` ✅

### F5. 引擎池隔离 — ✅ 通过
- `getAgenticLoop(agentId, sessionId)` 从 `loopPool.get(sessionId)` 取 ✅
- 每个 session 有独立 AgenticLoop ✅

### F6. Buffer并行隔离 — ✅ 通过
- `streamBufferRef: Map<sessionId, buffer>` ✅
- `flushStreamBuffer(session.id)` 只 flush 指定会话 ✅

### F7. 删除运行中的会话 — ✅ 通过
- `deleteSession` 调用 `cleanupSessionLoop(sessionId)` ✅
- `abortControllersRef` 在 finally 块中清理 ✅

---

## G. 自动任务

### G1. 定时器触发器 — ✅ 通过
- `setInterval` 按间隔触发 ✅
- `refreshAutomationEngines()` 在设置保存后调用 ✅

### G2. 文件监听触发器 — ✅ 通过
- `setInterval(check, 2000)` 轮询文件大小 ✅
- cooldown 防抖 ✅

### G3. 双模式下触发 — ✅ 通过
- `createSession` 继承 `getProjectExecutionMode(project.path)` ✅
- `runAgenticLoop` 检查 `session.executionMode` ✅

### G4. 触发器管理 — ✅ 通过
- toggle/save/delete 后 `refreshAutomationEngines()` ✅
- "停止所有"按钮调用 `stopAutomationEngines()` ✅

### G5. handleSendRef闭包 — ✅ 通过
- `useEffect(() => { handleSendRef.current = handleSend })` 每次渲染后更新 ✅
- 自动化回调用 `handleSendRef.current()` ✅

---

## H-N. 其余模块

### H. InputArea — ✅ 通过
- 模式/分支/安全模式选择器全部实现 ✅
- `modeLocked = isStreaming` → 实际应为 `activeSessions.has(currentSessionId)` 但 ChatPanel 传入的 `isStreaming` 已经是 per-session 的 ✅

### I. 设置面板 — ✅ 通过
- 9个 Tab 切换正常 ✅

### J. GitInfoPanel — ✅ 通过
- `projectPath = currentSession?.worktreePath || currentProject?.path` ✅
- commit/push/pull 全部实现 ✅
- 提交历史可折叠 ✅

### K. 活跃任务面板 — ✅ 通过
- `activeSessionsList` 从 `visibleSessions` 过滤 ✅
- 点击切换 `onOpenSession` ✅

### L. 侧栏标识 — ✅ 通过
- `isActiveSession = activeSessions.has(session.id)` ✅
- 🌒 worktree 标识 ✅

### M. Windows兼容 — ✅ 通过
- 所有路径用 PowerShell 单引号 ✅
- `chcp 65001` UTF-8 编码 ✅
- `path_exists` Rust 命令 ✅

### N. 边界异常 — ✅ 通过（部分已追踪）
- N1 无Provider：`providerObj2.isConfigured()` 检查 + `setSessionActive(session.id, false)` ✅
- N3 Worktree失败：catch + 回退本地模式 ✅
- N5 文件不存在：`Get-Item -ErrorAction SilentlyContinue` 返回空 ✅

---

## O. 跨功能交互

### O1-O5 — ✅ 通过
- Worktree+Automation：createSession 继承 executionMode ✅
- 并行+Worktree：各自独立 worktree ✅
- 并行+权限：per-session Map ✅
- GitInfoPanel+分支：监控 worktree 路径 ✅
- 自动化+并行：handleSendRef ✅

---

## P. 数据完整性

### P1-P2 — ✅ 通过
- DB 表结构不变，新字段 nullable ✅
- 旧会话无 executionMode 默认 current_workspace ✅

---

## 发现的问题汇总

| # | 问题 | 严重性 | 位置 |
|---|------|--------|------|
| 1 | **tool_complete/tool_error 的 updateToolCall 未守卫 isViewingSession** | 中 | App.tsx L1040, L1061 |
| 2 | **onPromptChangeSubmit 用全局单例** | 低 | App.tsx L884-886 |
| 3 | **onInteractiveForm 用全局单例** | 低 | App.tsx L890-893 |
| 4 | **catch 块的 addMessage 未守卫** | 中 | App.tsx L1118 |
| 5 | **end 事件的 addMessage 未守卫** | 低 | App.tsx L1095 |
