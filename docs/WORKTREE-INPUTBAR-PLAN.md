# InputArea 控制栏重构 + Git Worktree 集成计划

> 创建时间：2026-07-22
> 对标：wecode-ref `ProjectWorkBar.tsx` + `WorktreeBranchSelector.tsx`

## 一、改造目标

### 1.1 InputArea 布局重构

**现状问题**：控件分散在两处——`input-wrapper` 内有协作模式/安全/自定义操作按钮，`input-control-bar`（底部栏）有项目/协作模式/安全/自定义操作的**重复**。

**目标布局**（对标 wecode ProjectWorkBar）：

```
┌─────────────────────────────────────────────────────────────┐
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐              │
│  │项目  │ │模式  │ │分支  │ │协作  │ │安全  │   [textarea] │ →
│  │mimo  │ │本地  │ │main │ │⚡执行│ │🔒ask│              │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘              │
│  📎 🎯                                                      │
└─────────────────────────────────────────────────────────────┘
```

- 所有控件放回 `input-wrapper` 左侧，不再有独立底部栏
- 控件以紧凑 pill 按钮形式排列
- 每个控件点击弹出下拉菜单（不占用 textarea 空间）
- 保留 `/` slash 命令、文件上传、技能选择器

### 1.2 控件清单

| 控件 | 图标 | 功能 | 下拉菜单 |
|------|------|------|---------|
| 项目 | 📁 | 当前项目名，点击切换 | 项目列表 |
| 模式 | 🌲/🏠 | 执行模式：本地处理 / 新工作树 | 模式选择 |
| 分支 | 🌿 | 当前 Git 分支（仅工作树模式显示） | 分支列表 |
| 协作 | 📋/⚡ | 计划/执行模式 | 无（点击切换） |
| 安全 | 🔒 | 安全策略 ask/auto/full | 模式选择 |

### 1.3 Git Worktree 管理

**核心模块**：`src/core/environment/worktree-manager.ts`

```
WorktreeManager
├── createWorktree(projectPath, sessionId, branch?) → string  // 返回 worktree 路径
├── removeWorktree(worktreePath) → void
├── scanWorktrees(worktreeRoot) → WorktreeInfo[]
├── hasUncommittedChanges(path) → boolean
├── getCurrentBranch(path) → string
├── listBranches(path) → string[]
├── enforceMaxWorktrees(max=15) → void  // LRU 清理最旧的
└── getWorktreeSettings() → WorktreeSettings
```

**路径规则**：`{projectPath}/.mimo-worktrees/{sessionId}/`

### 1.4 设置项

SettingsPanel 新增 "Worktree" Tab：

```
设置 → Worktree
├── 最大工作树数量: [15] （默认15，超过自动清理最旧）
├── 自动清理最旧: [✓]
├── 归档前检查未提交: [✓]
└── 已有工作树列表（扫描结果）
```

## 二、实施步骤

### Phase 1: WorktreeManager 核心（P-WT）
- [ ] 创建 `src/core/environment/worktree-manager.ts`
- [ ] 实现 createWorktree / removeWorktree / scanWorktrees
- [ ] 实现 hasUncommittedChanges / getCurrentBranch / listBranches
- [ ] 实现 enforceMaxWorktrees (LRU 清理)
- [ ] 实现 getWorktreeSettings / setWorktreeSettings

### Phase 2: InputArea 布局重构（P-UI）
- [ ] 移除 `input-control-bar` 底部栏
- [ ] 将项目指示器、模式、分支、协作、安全控件移入 `input-wrapper` 左侧
- [ ] 实现执行模式下拉菜单（本地处理 / 新工作树）
- [ ] 实现分支选择下拉菜单（仅工作树模式显示）
- [ ] 保留安全模式下拉菜单
- [ ] 更新 CSS 样式

### Phase 3: SettingsPanel Worktree Tab（P-SET）
- [ ] 在设置侧边栏添加 "Worktree" 导航项
- [ ] 实现 maxWorktrees 输入 + autoClean 开关
- [ ] 实现工作树扫描列表 + 删除按钮

### Phase 4: Session 集成（P-SES）
- [ ] Session 类型增加 `worktreePath?: string` + `executionMode?: ExecutionMode`
- [ ] 新建会话时根据模式决定是否创建 worktree
- [ ] AgenticLoop 使用 session.worktreePath 作为 cwd
- [ ] 切换会话时恢复对应 worktree 路径

### Phase 5: Worktree 数量控制（P-LIMIT）
- [ ] 创建 worktree 前检查数量
- [ ] 超过 maxWorktrees 时找最旧非活跃的清理
- [ ] 有未提交修改的跳过，找次旧的

## 三、数据结构

```typescript
// src/core/environment/worktree-manager.ts

export type ExecutionMode = 'current_workspace' | 'git_worktree';

export interface WorktreeInfo {
  sessionId: string;
  path: string;
  branch: string;
  createdAt: number;
  hasUncommitted: boolean;
}

export interface WorktreeSettings {
  maxWorktrees: number;       // 默认 15
  autoCleanOldest: boolean;   // 默认 true
  warnOnDirty: boolean;       // 默认 true
}

// src/core/types.ts 扩展
export interface Session {
  // ... existing fields
  worktreePath?: string;
  executionMode?: ExecutionMode;
}
```

## 四、对标参考

| wecode-ref | mimo-gui |
|------------|----------|
| `ProjectWorkBar.tsx` | InputArea 控件栏 |
| `WorktreeBranchSelector.tsx` | 分支选择下拉菜单 |
| `project_service.py` (list/delete worktrees) | `worktree-manager.ts` |
| `command_registry.py` (git_worktree_add/remove) | Tauri `execute_command` |
| `useWorkbenchRuntimeTasks.ts` (archive cleanup) | 归档/清理逻辑 |
| UserPreferences `wework_project_execution_mode` | settings `executionMode` |
| `settings-nav-worktrees` | SettingsPanel Worktree Tab |
