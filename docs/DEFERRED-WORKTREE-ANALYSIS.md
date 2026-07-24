# Worktree 方案分析（暂缓）

> 状态：**暂缓，后续考虑**
> 创建时间：2026-07-21
> 关联：Git 配置（方案 A）和环境脚本（方案 B）已实现完毕

---

## 背景

对标 wecode-ref（`.wecode-ref/`）项目的 worktree 实现方式，评估在 mimo-gui 中引入 Git worktree 的必要性、工作量、影响范围和风险。结论是**暂不实现**，留待后续考虑。

---

## wecode-ref 的实现方式

wecode-ref 是**分布式全栈架构**，由 4 层组成：

| 层 | 目录 | 技术栈 | 职责 |
|---|---|---|---|
| 前端 | `wework/` | Next.js + Tauri | 桌面 UI、状态管理 |
| 后端 | `backend/` | Python FastAPI | 项目管理、worktree 编排 |
| 执行管理器 | `executor_manager/` | Python | 管理多个执行设备 |
| 执行器 | `executor/` | Rust | 实际跑 git clone / worktree add |

### 关键发现

1. **wecode-ref 只有 worktree，没有 Git 配置和环境脚本**。搜索 `branch_prefix`、`merge_method`、`force_push`、`draft_pr`、`setup_script`、`cleanup_script` 等关键词全部无匹配。wecode-ref 的 Git 能力仅限于：commit/push、branch list/checkout、diff、AI 生成 commit message、**git worktree**。
2. **我们上一轮实现的方案 A（Git 配置）和方案 B（环境脚本）已经超过了 wecode-ref 的覆盖范围**。

### worktree 数据流

```
用户选择"新工作树"模式 + 选择启动分支
         ↓
前端发送任务时附带 execution.workspace.source = 'git_worktree'
         ↓
后端 project_service.prepare_git_worktree_for_task()
         ↓
在执行设备上运行: git worktree add --detach <path> <branch>
         ↓
路径: ~/.wecode/wegent-executor/workspace/worktrees/<taskId>/<projectName>
         ↓
任务记录 worktree 路径，后续所有工具（终端/文件树/IDE）都用这个路径
```

### 关键文件清单

| 文件 | 行数 | 作用 |
|---|---|---|
| `wework/src/components/chat/composer/ProjectWorkBar.tsx` | 1052 | 执行模式切换 UI（本地模式 vs 新工作树） |
| `wework/src/components/chat/composer/WorktreeBranchSelector.tsx` | 289 | worktree 模式下的分支选择器 |
| `wework/src/features/workbench/WorkbenchProvider.tsx` | ~700+ | 状态管理：执行模式 + 分支偏好持久化 |
| `wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts` | ~560 | 发任务时注入 `execution.workspace.source` |
| `wework/src/api/environment.ts` | 624 | Git 操作封装（commit/push/branch/worktree remove） |
| `wework/src/api/projects.ts` | 67 | worktree 列表/删除 API |
| `wework/src/types/api.ts` | ~1200 | 类型定义（ProjectWorktreeItem 等 10+ 接口） |
| `backend/app/services/project_service.py` | ~1400+ | worktree 创建/列表/删除核心逻辑 |
| `backend/app/api/endpoints/projects.py` | ~200+ | REST API 端点 |
| `executor/src/agents/git_workspace.rs` | 516 | git clone + worktree 路径解析 |
| `executor/src/runtime_work/util.rs` | ~530 | worktree 路径推断 |
| `wework/src/lib/projectClassification.ts` | 20 | 判断项目是否支持 worktree |
| `wework/src/components/layout/TaskForkDialog.tsx` | ~400 | 任务分叉到不同工作区 |

wecode-ref 的 worktree 相关代码总量约 **6000+ 行**。

---

## 架构差异对比

| 维度 | wecode-ref | mimo-gui |
|---|---|---|
| **架构** | 分布式：前端↔后端↔执行器 | 本地单体：前端↔Tauri Shell |
| **命令执行** | 通过设备 API 远程执行 | 直接 `execute_command` |
| **项目存储** | 后端数据库 (PostgreSQL) | 本地 SQLite |
| **任务模型** | 后端 Task 表 + 执行器 runtime | 本地 Session 模型 |
| **文件隔离** | worktree（物理目录隔离） | 快照系统（虚拟回滚） |
| **Git 配置** | ❌ 无 | ✅ 已实现（方案 A） |
| **环境脚本** | ❌ 无 | ✅ 已实现（方案 B） |
| **Worktree** | ✅ 完整实现 | ❌ 未实现 |

---

## 如果对标实现 worktree 的工作量

由于架构不同，可以砍掉大量代码，只需写约 **1500-2000 行**（wecode-ref 的 1/3）：

| 模块 | 工作内容 | 估算工作量 | 影响文件 |
|---|---|---|---|
| **数据模型** | `WorktreeInfo` 接口、session 表加 `worktree_path` 字段 | 0.5 天 | `settings.ts`, `session.ts` |
| **worktree 运行时** | `createWorktree()` / `deleteWorktree()` / `listWorktrees()` —— 封装 `git worktree add/remove/list` | 1 天 | 新建 `src/core/git/worktree.ts` |
| **执行模式切换 UI** | 在 InputArea 或 ProjectBar 加"本地模式/新工作树"切换 | 1 天 | `InputArea.tsx` 或新建组件 |
| **分支选择器** | worktree 模式下选择启动分支 | 0.5 天 | 新建 `BranchSelector.tsx` |
| **session 关联 worktree** | 发送消息时，若 worktree 模式则先创建 worktree，session 记录路径 | 1 天 | `llm/index.ts`, `store.ts` |
| **工具路径切换** | 文件树、终端、快照等工具感知 worktree 路径 | 1.5 天 | `FileExplorer.tsx`, `TerminalPanel.tsx`, `snapshot/` |
| **worktree 管理 UI** | 列出/删除已创建的 worktree | 1 天 | 新建 `WorktreeManager.tsx` |
| **环境脚本联动** | setupScript 在 worktree 目录执行（而非项目目录） | 0.5 天 | `environment-runner.ts` |
| **清理机制** | 关闭 session 时可选删除 worktree | 0.5 天 | `App.tsx`, `store.ts` |
| **测试** | worktree 创建/删除/切换的单元测试 | 1 天 | `test/` |
| **合计** | | **~8.5 天** | ~12 个文件 |

### 不需要做的（wecode-ref 有但我们不需要）

| 模块 | 原因 |
|---|---|
| 后端 REST API（`/projects/worktrees`） | 我们是本地应用，无需 HTTP API |
| 执行器 Rust 代码（`git_workspace.rs`） | 我们直接用 Tauri `execute_command` |
| 设备管理 / 远程执行 | 我们只有本地设备 |
| 执行管理器 | 无需多设备调度 |
| TaskForkDialog（任务分叉） | 可作为后续增强 |

---

## 影响范围

| 系统 | 影响程度 | 说明 |
|---|---|---|
| **Session 模型** | 🔴 高 | session 需要记录 worktree 路径，工具执行路径需动态切换 |
| **快照系统** | 🟡 中 | 需要决定 worktree 模式下快照是否生效（建议 worktree 模式禁用快照，因为 worktree 本身就是隔离） |
| **环境脚本** | 🟡 中 | setupScript 需在 worktree 目录执行，而非原项目目录 |
| **文件树/终端** | 🟡 中 | 需要感知当前 session 的 worktree 路径 |
| **Git 配置** | 🟢 低 | branchPrefix 等配置在 worktree 模式下同样适用 |
| **LLM 系统** | 🟡 中 | 系统提示需注入 worktree 路径信息 |

---

## 风险评估

| 风险项 | 等级 | 说明 | 缓解措施 |
|---|---|---|---|
| **快照与 worktree 冲突** | 🔴 高 | 快照系统基于原目录文件状态，worktree 是另一个目录，两套隔离机制同时存在会导致混乱 | worktree 模式下禁用快照，二选一 |
| **环境脚本路径错乱** | 🟡 中 | setupScript 可能在错误目录执行 | 明确约定 setupScript 始终在当前工作目录执行 |
| **session 恢复复杂度** | 🟡 中 | 重启后恢复 session 时，worktree 可能已被外部删除 | 启动时校验 worktree 路径是否存在 |
| **用户认知负担** | 🟡 中 | 用户需理解"本地模式"vs"工作树模式"的区别 | 默认本地模式，worktree 作为高级选项 |
| **清理遗漏** | 🟡 中 | session 删除但 worktree 未清理，导致磁盘泄漏 | 提供独立的 worktree 管理页面 |
| **磁盘空间** | 🟡 中 | 每个 worktree 是完整工作副本，大仓库可能占用 GB 级空间 | 提醒用户定期清理 |
| **Git 性能** | 🟢 低 | worktree 共享 `.git`，但大量 worktree 会拖慢 git 操作 | 限制最大 worktree 数量 |

---

## 结论

- **wecode-ref 用分布式架构 + 后端编排实现 worktree，代码量庞大（6000+ 行），但核心逻辑很简单**：`git worktree add` + 路径跟踪。
- **如果我们对标做，由于是本地 Tauri 应用，可以大幅简化**：砍掉后端/执行器/设备管理，只需 ~8.5 天、约 2000 行代码。
- **主要风险**在快照系统冲突（建议 worktree 模式禁用快照）和 session 模型改动。
- **当前决定：暂不实现**。优先考虑的多开项目实例 + per-project 环境配置可覆盖 80% 的并行需求。

---

## 如果后续决定实现，建议的简化方案

1. worktree 创建/删除直接用 Tauri `execute_command` 调 `git worktree add/remove`
2. worktree 路径规则：`<projectDir>/.mimo/worktrees/<sessionId>/`
3. worktree 模式下**禁用快照系统**，避免双重隔离冲突
4. 先做 MVP：仅支持"新工作树"模式切换 + 分支选择 + 自动清理
5. 参考 wecode-ref 的 `WorktreeBranchSelector.tsx` 和 `projectClassification.ts` 的设计思路
