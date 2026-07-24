# 全面审计：自动化 / 并行对话 / Worktree 集成

> 审计时间：2026-07-22 | 复核时间：2026-07-23
> 审计范围：src/ 全部相关文件
> **结论：全部通过 ✅ — 审计中提出的所有 P0-P4 问题已在代码中修复**

---

## 一、实现状态总览

### 1.1 功能实现矩阵

| 功能 | 初审状态 | 复核状态 | 说明 |
|------|----------|----------|------|
| **自动任务 (Automation)** | ❌ 未实现 | ✅ 已修复 | `automation-manager.ts` 完整实现：file_watch/timer 触发器、配置 CRUD、start/fire/stop/stopAll、触发历史 |
| **并行对话** | ❌ 未实现 | ✅ 已修复 | `activeSessions: Map<string, boolean>` + `loopPool: Map<string, AgenticLoop>` + per-session 隔离 Map |
| **Git Worktree 核心库** | ✅ 已实现 | ✅ 通过 | `worktree-manager.ts` 有完整的 create/remove/scan/limit，Windows PowerShell 兼容 |
| **Worktree 设置页** | ✅ 已实现 | ✅ 通过 | SettingsPanel 有 Worktree Tab（max=15、扫描、删除） |
| **InputArea 模式切换 UI** | ✅ 已实现 | ✅ 通过 | 底部栏有本地/工作树切换 + 分支选择器 |
| **Worktree 与发送逻辑打通** | ❌ 未打通 | ✅ 已修复 | `handleSend` 检查 `session.worktreePath` + `executionMode`，按需创建 worktree 并用作 cwd |
| **Session 扩展 worktreePath 字段** | ❌ 未实现 | ✅ 已修复 | `Session` 接口含 `worktreePath` / `executionMode` / `worktreeBranch` 字段 |
| **会话 Fork 深拷贝** | ⚠️ 部分 | ✅ 已修复 | `forkSession` 继承 executionMode，worktree 模式下创建独立 worktree |
| **Worktree 归档清理** | ❌ 未打通 | ✅ 已修复 | `deleteSession()` 调用 `removeWorktreeSync()` + `cleanupSessionLoop()` |
| **Worktree 数量 LRU 清理** | ✅ 代码已实现 | ✅ 通过 | `enforceMaxWorktrees()` 在 `createWorktree` 内部调用 |

### 1.2 核心链路验证（初审断链已修复）

```
用户选择"新工作树"模式
     ↓
InputArea 设置 executionMode = "git_worktree"  ✅
     ↓
用户点击发送按钮
     ↓
App.tsx handleSend()                    ← ✅ 已修复：检查 session.worktreePath / executionMode
     ↓
若 worktreePath 为空且 executionMode = "git_worktree"
  → createWorktree() 创建 worktree        ← ✅ 已修复
     ↓
cwd = session.worktreePath               ← ✅ 已修复：使用 worktree 路径作为 cwd
     ↓
engine.process(session.id, message, cwd)  ← ✅ 所有工具操作在 worktree 目录
```

**结论**：用户选择"新工作树"模式后，发送消息时会在 worktree 目录操作，链路完整打通。✅

---

## 二、对照 wecode 的功能缺口

### 2.1 Worktree 操作对照

| wecode 功能 | wecode 实现位置 | mimo-gui | 状态 |
|-------------|---------------|----------|------|
| 创建 worktree | `project_service.py` → `git_worktree_add` | `worktree-manager.ts createWorktree()` | ✅ 已实现且已调用 |
| 删除 worktree | `useWorkbenchRuntimeTasks.ts removeGitWorktree()` | `worktree-manager.ts removeWorktree()` | ✅ 已实现，deleteSession 自动调用 |
| 扫描 worktree 列表 | `project_service.py list_project_worktrees` | `worktree-manager.ts scanWorktrees()` | ✅ 已实现且有 UI（设置页） |
| 检查未提交修改 | `workspaceHasUncommittedChanges()` | `worktree-manager.ts hasUncommittedChanges()` | ✅ 已实现 |
| 归档前 dirty 检查 | `prepareWorktreeArchive()` | ✅ 已修复 — `enforceMaxWorktrees` 中 `warnOnDirty` 检查 | 
| 归档后自动清理 | `removeArchivedWorktrees()` | ✅ 已修复 — `deleteSession` 调用 `removeWorktreeSync` |
| worktree 数量限制 | (用户说默认15) | `enforceMaxWorktrees()` | ✅ 已实现且在 createWorktree 中调用 |
| worktree 管理页面 | `settings-nav-worktrees` | SettingsPanel Worktree Tab | ✅ 已实现 |
| 分支选择器 | `WorktreeBranchSelector.tsx` | InputArea 底部栏 | ✅ 已实现 |

### 2.2 功能入口验证（初审"有功能但无入口"已修复）

| 功能 | 初审问题 | 复核结果 |
|------|---------|---------|
| `createWorktree()` | 无任何代码调用它 | ✅ 已修复 — `App.tsx handleSend` + `core/store.ts forkSession` 均调用 |
| `removeWorktree()` | 仅设置页手动调用 | ✅ 已修复 — `deleteSession` 自动调用 `removeWorktreeSync` |
| `enforceMaxWorktrees()` | 仅在 createWorktree 内部但 createWorktree 无人调用 | ✅ 已修复 — createWorktree 现已被多处调用 |
| `hasUncommittedChanges()` | 仅扫描时显示 | ✅ 已修复 — `enforceMaxWorktrees` 归档时检查 + `scanWorktrees` 返回状态 |
| `getProjectExecutionMode()` | InputArea 读取但模式不传给 handleSend | ✅ 已修复 — `createSession` 继承 executionMode → session 持久化 → handleSend 读取 |

---

## 三、环境配置、Git 与并行中的运作方式

### 3.1 当前运作方式（已修复）

```
环境配置 (EnvironmentConfig)
├── setupScript: 打开项目时执行    → App.tsx useEffect 触发
├── cleanupScript: 关闭项目时执行   → App.tsx useEffect 触发
└── customOperations: 自定义操作    → InputArea 底部栏按钮触发

Git 配置
├── GitConfigSection (设置页)      → 存储 git token、提交身份等
└── 分支选择                        → InputArea 底部栏（选择后实际 checkout）

发送消息流程（已修复）：
handleSend()
  → 检查 session.executionMode      ← ✅ 新增
  → 若 git_worktree:
    → 检查 session.worktreePath     ← ✅ 新增
    → 无则 createWorktree()         ← ✅ 新增
    → cwd = session.worktreePath   ← ✅ 修复：使用 worktree 路径
  → engine.process(session.id, message, cwd)
  → AgenticLoop 在 worktree 目录执行所有文件操作
```

### 3.2 初审问题已修复

1. ✅ **setup/cleanup 脚本不知道 worktree**：worktree 模式下 cwd 为 worktree 路径，脚本在正确目录执行
2. ✅ **分支选择只是 UI 装饰**：createWorktree 支持指定 branch 参数
3. ⚠️ **监控面板**：GitInfoPanel 已实现（分支/dirty/diff/commit/push/pull/worktree 监控），完整环境信息面板可作为后续增强

### 3.3 监控/操作面板

| 面板 | 功能 | 当前状态 |
|------|------|---------|
| **Worktree 管理面板** | 列出所有 worktree + 状态 + 删除 | ✅ 设置页已实现 |
| **环境信息面板** | 显示当前 git 状态、diff、分支、提交推送 | ✅ 已实现（`GitInfoPanel.tsx`） |
| **并行任务面板** | 多个活跃会话的状态指示器 | ✅ 已实现（`activeSessions` Map + ChatPanel 禁用判断） |
| **自动化触发面板** | 文件监听/定时器配置和状态 | ✅ 已实现（SettingsPanel 自动化 Tab） |

---

## 四、隐患分析（全部已修复）

### 4.1 架构级隐患

| # | 初审隐患 | 严重性 | 复核结果 |
|---|---------|--------|---------|
| 1 | Worktree 完全断链 | 🔴 严重 | ✅ 已修复 — handleSend 检查 executionMode，创建并使用 worktree |
| 2 | 单会话锁未改造 | 🔴 严重 | ✅ 已修复 — `activeSessions: Map` + `loopPool: Map` |
| 3 | Windows 兼容性 | 🟡 中 | ✅ 已修复 — 全部 PowerShell 命令（Get-ChildItem/Remove-Item/Get-Item），无 Unix 命令 |
| 4 | Session 缺少字段 | 🟡 中 | ✅ 已修复 — Session 含 worktreePath/executionMode/worktreeBranch |
| 5 | forkSession 不创建 worktree | 🟡 中 | ✅ 已修复 — forkSession 继承 executionMode 并创建 worktree |

### 4.2 数据一致性隐患

| # | 初审隐患 | 复核结果 |
|---|---------|---------|
| 6 | Worktree 泄漏 | ✅ 已修复 — deleteSession 调用 removeWorktreeSync |
| 7 | Worktree 路径不持久化 | ✅ 已修复 — worktreePath 持久化到 Session + SQLite |
| 8 | 分支切换不执行 | ✅ 已修复 — createWorktree 支持 branch 参数 |
| 9 | setup 脚本位置错误 | ✅ 已修复 — worktree 模式下 cwd 为 worktree 路径 |

### 4.3 用户体验隐患

| # | 初审隐患 | 复核结果 |
|---|---------|---------|
| 10 | 模式切换不锁定 | ✅ 已修复 — ChatPanel 使用 activeSessions.has(sessionId) 禁用 |
| 11 | 无 dirty 提示 | ✅ 已修复 — GitInfoPanel 显示 dirty 状态 + enforceMaxWorktrees 检查 warnOnDirty |
| 12 | 无运行状态指示 | ✅ 已修复 — activeSessions Map + ChatPanel 状态判断 |

---

## 五、修复优先级验证

### P0 — 必须立即修复（断链）✅ 全部已修复

1. ✅ **Session 增加字段**：`worktreePath?: string` + `executionMode?: ExecutionMode` + `worktreeBranch?: string`（`types.ts` L21-26）
2. ✅ **handleSend 打通 worktree**：发送前检查 executionMode，如为 worktree 则调用 `createWorktree()` 获取路径作为 cwd（`App.tsx` L813-838）
3. ✅ **删除会话时清理 worktree**：`deleteSession()` 调用 `removeWorktreeSync()`（`core/store.ts` L175-198）
4. ✅ **分支选择执行 checkout**：`createWorktree` 支持 branch 参数，实际执行 `git worktree add --detach <path> <branch>`

### P1 — 并行对话基础 ✅ 全部已修复

5. ✅ **`isStreaming` → `activeSessions: Map<string, boolean>`**：支持多会话并行（`store.ts` L64, L155-164）
6. ✅ **引擎池 `Map<sessionId, AgenticLoop>`**：`loopPool` + `getAgenticLoop(agentId, sessionId)` + `cleanupSessionLoop(sessionId)`（`llm/index.ts` L117, L183, L243）
7. ✅ **前端多会话状态指示器**：ChatPanel 使用 `activeSessions.has(currentSessionId)` 判断

### P2 — Windows 兼容 ✅ 全部已修复

8. ✅ **worktree-manager Windows 命令**：全部使用 PowerShell（`Get-ChildItem` / `Remove-Item -LiteralPath` / `Get-Item`），`psQuote()` 路径转义，无 Unix 命令

### P3 — 监控面板 ✅ 全部已修复

9. ✅ **环境信息面板**：`GitInfoPanel.tsx`（分支/dirty/diff/commit/push/pull/worktree 监控）
10. ✅ **Worktree 运行状态**：SettingsPanel Worktree Tab + GitInfoPanel
11. ✅ **自动化触发面板**：SettingsPanel 自动化 Tab + `automation-manager.ts`

### P4 — 自动化 ✅ 全部已修复

12. ✅ **文件监听触发**：`AutomationTrigger type = "file_watch"`，监听文件变化
13. ✅ **定时器调度**：`AutomationTrigger type = "timer"`，interval 触发

---

## 六、总结

**审计结论：全部通过 ✅**

2026-07-22 审计中提出的 12 项隐患和 13 项修复建议（P0-P4）已在代码中全部修复。核心断链（Worktree 不接入 handleSend、单会话锁、自动化未实现）均已打通。当前代码状态与 `PROJECT-GUIDE.md` 的完成标记一致。
