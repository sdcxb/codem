# Codem Coding 能力完整整改优化方案（终版）

> 合并自 4 份分析文档，消除冗余，保留所有有效结论。
> 原始文档：coding-improvement-todo.md（v1 基础）、coding-improvement-todo-v2.md（CodexLoom 启发）、coding-improvement-master-plan.md（整合）、coding-improvement-master-plan-rev2.md（深度影响分析）

---

## 一、整改背景

### 现状

Codem 没有针对 coding 开发做过专门的架构设计。有终端但只能 one-shot 执行；有文件树但无 Git 状态标记；有 DiffViewer 但无 per-turn 变更追踪。Agent 协作层面：有子 Agent spawn 和跨会话委派，但都是同步阻塞模式。

### 已有组件清单（之前漏检，现已确认）

| 组件 | 文件 | 现状 |
|------|------|------|
| **TerminalPanel** | `src/components/TerminalPanel.tsx` | ✅ xterm.js，**one-shot 模式**（非 PTY） |
| **FileExplorer** | `src/components/FileExplorer.tsx` | ✅ 递归树+懒加载+缓存，**无 Git 状态** |
| **FileEditor** | `src/components/FileEditor.tsx` | ✅ 文本编辑+保存+图片+PDF |
| **DiffViewer** | `src/components/DiffViewer.tsx` | ✅ LCS diff+三视图+Accept/Reject |
| **Workbench** | `src/components/Workbench.tsx` | ✅ 工具状态+修改文件统计（但传入空数组） |
| **GitInfoPanel** | `src/components/GitInfoPanel.tsx` | ✅ 分支+dirty+diff+commit+push |
| **list_directory** | `src-tauri/src/lib.rs` | ✅ Rust 命令，排序+过滤 |
| **execute_command** | `src-tauri/src/lib.rs` | ✅ PowerShell+chcp 65001 |
| **@xterm/\*** | `package.json` | ✅ 已安装 |
| **BottomTab** | `src/App.tsx` | ✅ `"chat" | "terminal"` |
| **GuidanceQueue** | `src/core/llm/guidance-queue.ts` | ✅ Human→Agent 方向 |
| **SubagentTask** | `src/core/subagent/subagent.ts` | ✅ 有 persistent 字段但未充分使用 |

---

## 二、12 项改进任务全表

| # | 功能 | 优先级 | 人天 | 改造方式 | 来源 |
|---|------|--------|------|---------|------|
| 1 | 终端升级 one-shot → PTY | P0 | 6 | **升级现有** TerminalPanel | v1 对标 |
| 2 | 文件变更追踪 + Artifact | P0 | 11 | **新建** FileChangeTracker | v1+v2 |
| 3 | 文件树升级（Git 状态+自动刷新） | P0 | 5 | **升级现有** FileExplorer | v1 对标 |
| 4 | Diff 面板 + Topic 视角 | P1 | 3 | **复用** DiffViewer | v1+v2 |
| 5 | 自动 Git Commit Message | P1 | 3 | **新建** GitCommitService | v1 对标 |
| 6 | Transcript 缓存 | P1 | 2 | **新建** | v1 优化 |
| 7 | Agent Profile 持久化 | P1 | 3 | **扩展** SubagentTask | v2 CodexLoom |
| 8 | Needs You 机制 | P1 | 4 | **扩展** GuidanceQueue 反向 | v2 CodexLoom |
| 9 | 浏览器面板（前端预览） | P2 | 5 | **新建** Tauri WebView | v1 对标 |
| 10 | Agent Message 异步通信 | P2 | 5 | **扩展** SubagentSpawner | v2 CodexLoom |
| 11 | Overview 轻量版 | P2 | 3 | **升级现有** Workbench | v2 CodexLoom |
| 12 | Artifact 快照引用 | P2 | 2 | **集成到** #2 | v2 CodexLoom |

> ~~多引擎切换~~ 已删除（用户明确不集成 Claude Code CLI / Codex CLI）

**总工作量：50 人天**（P0=22d + P1=14d + P2=14d）

---

## 三、任务依赖链与执行顺序

### 依赖关系图

```
#2 文件变更追踪 ──→ #3 文件树升级（监听 file_changes_tracked 事件）
       │    ──→ #4 Diff 面板（读取 #2 数据）
       │    ──→ #5 自动 Commit（依赖 #2 的 finalize 钩子）
       │    ──→ #11 Overview（数据来源）
       │    ──→ #12 Artifact 引用（集成到 #2 表结构）
       │
#7 Agent Profile ──→ #10 Agent Message（异步协作前提：有身份才能发消息）
       │
#8 Needs You ──（独立，但 #2 变更关键文件时可触发 needs_you）
       │
#1 终端 ──（独立）
       │
#6 Transcript 缓存 ──（独立）
       │
#9 浏览器面板 ──（独立）
```

### 执行顺序

```
════════ 阶段1：P0 核心（22 人天） ════════

并行轨道 A（11d）：#2 文件变更追踪
  ├── 新建 file-change-tracker.ts
  ├── 新建 file-change-storage.ts
  ├── database.ts 新增 turn_file_changes 表
  ├── agentic-loop.ts 插入 start/finalize 钩子
  └── ChatPanel.tsx 监听 file_changes_tracked 事件

并行轨道 B（6d）：#1 终端升级
  ├── Cargo.toml 新增 portable-pty
  ├── lib.rs 新增 PtyManager
  ├── TerminalPanel.tsx 升级为 PTY + 多会话
  └── Ctrl+Shift+C 中断（不用 Ctrl+C）

串行（5d，依赖 #2 完成）：#3 文件树升级
  ├── FileExplorer.tsx 加 Git 状态 + 自动刷新
  ├── lib.rs list_directory 扩展 include_git_status
  └── PanelSidebar.tsx 新增 "文件" Tab

════════ 阶段2：P1 增强（14 人天） ════════

#4 Diff 面板（3d，依赖 #2）
  ├── 新建 FileChangesList.tsx（薄包装，复用 DiffViewer）
  └── PanelSidebar.tsx 新增 "变更" Tab

#5 自动 Commit（3d，依赖 #2）
  ├── 新建 git-commit-service.ts
  ├── GitInfoPanel.tsx 监听 auto_committed 事件
  └── SettingsPanel.tsx 新增开关

#6 Transcript 缓存（2d，独立）
  ├── 新建 transcript-cache.ts
  └── agentic-loop.ts convertMessagesToLLM 先查缓存

#7 Agent Profile（3d，独立）
  ├── subagent.ts 扩展 SubagentTask + 新增 AgentProfile 接口
  ├── database.ts 新增 agent_profiles 表
  ├── 新建 agent-profile-storage.ts
  └── spawner.ts spawn 时查 Profile 注入 system prompt

#8 Needs You（4d，独立）
  ├── 新建 needs-you-queue.ts（反向 GuidanceQueue）
  ├── 新建 needs_you_pending SQLite 表（会话恢复用）
  ├── agentic-loop.ts 迭代边界检测 needs_you → 暂停
  ├── 新建 NeedsYouPanel.tsx
  └── App.tsx 监听 needs_you 事件

════════ 阶段3：P2 演进（14 人天） ════════

#9 浏览器面板（5d，独立）
#10 Agent Message 异步（5d，依赖 #7）
  ├── 新建 agent-message-queue.ts
  ├── 新建 agent_messages SQLite 表（会话恢复用）
  ├── spawner.ts spawn 后不阻塞，结果入 queue
  ├── agentic-loop.ts 迭代边界消费 reply
  └── tools.ts 新增 check_subagent（非阻塞查询）
#11 Overview 轻量版（3d，依赖 #2 数据）
  └── Workbench.tsx 升级为 Status+Capacity+Activity
#12 Artifact 引用（2d，集成到 #2）
  └── artifact_id + sha256 已在 #2 表结构中
```

---

## 四、逐项详细方案

---

### #1 终端升级（one-shot → PTY）【P0, 6d】

#### 改造内容

| 改造点 | 现状 | 改造后 |
|--------|------|--------|
| 执行模式 | execute_command 一次性 | PTY 交互式 |
| 中断键 | Ctrl+C（与复制冲突） | **Ctrl+Shift+C + 工具栏 ⏹ 按钮** |
| 多会话 | 单实例 | 最多 5 个并发会话 Tab |
| 长进程 | ❌ 等待退出 | ✅ npm run dev 持续输出 |

#### Ctrl+C 冲突修正

**问题**：现有逻辑"有选区→复制，无选区→发 \x03 中断"。用户复制时选区检测有延迟，可能误中断进程。

**修正**：
- Ctrl+C → 只做复制（有选区复制，无选区什么都不做，不发信号）
- Ctrl+Shift+C → 中断进程（PTY 模式）
- 工具栏 ⏹ 停止按钮 → 可视化中断

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/components/TerminalPanel.tsx` | **升级**：PTY + 多会话 + Ctrl+Shift+C |
| `src-tauri/src/lib.rs` | **新增** PtyManager |
| `src-tauri/Cargo.toml` | 新增 portable-pty |
| `src-tauri/capabilities/default.json` | PTY 权限 |
| `src/styles.css` | 终端样式 + 皮肤 |

**不改**：App.tsx（BottomTab 不变）、execute_command（bash 工具继续用）

---

### #2 文件变更追踪 + Artifact【P0, 11d】

#### SQLite 表

```sql
CREATE TABLE IF NOT EXISTS turn_file_changes (
  id TEXT PRIMARY KEY,              -- artifact_id (UUID)
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  before_tree TEXT,
  after_tree TEXT,
  patch TEXT,
  changed_files TEXT,               -- JSON [{path, status, before_hash, after_hash}]
  patch_sha256 TEXT,
  current_brief TEXT,               -- 工作当前状态（借鉴 Topic 概念）
  status TEXT DEFAULT 'completed',  -- completed/reverted/pending_review
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

#### 消息流

```
Agent 轮次开始 → tracker.start(workspace) → git rev-parse HEAD^{tree} → beforeTree
  → Agent 执行工具（tracker 不介入，不阻塞）
  → 轮次结束 → tracker.finalize()
  → git rev-parse → afterTree
  → git diff --binary → patch
  → 每个变更文件 before/after 快照
  → SHA256 → 存 SQLite → emit("file_changes_tracked")
  → FileChangesPanel 刷新 + FileTreePanel 自动刷新
```

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/core/environment/file-change-tracker.ts` | **新建** |
| `src/core/storage/file-change-storage.ts` | **新建** |
| `src/core/storage/database.ts` | 新增表 |
| `src/core/llm/agentic-loop.ts` | process() 头尾插入 start/finalize |
| `src/core/llm/index.ts` | 传入 tracker |
| `src/components/FileChangesList.tsx` | **新建**（薄包装） |
| `src/components/PanelSidebar.tsx` | 新增 "变更" Tab |
| `src/components/ChatPanel.tsx` | 监听事件 |
| `src/components/Workbench.tsx` | 接收 tracker 数据 |

#### 潜在隐患

| 隐患 | 规避 |
|------|------|
| 非 Git 工作区 | start() 检测 isGitRepo，返回 false 跳过 |
| 大 diff | > 500KB 截断；> 2MB 只存文件列表 |
| 二进制文件 | git diff --numstat 检测，只存路径 |
| Agent 执行 git commit | start() 记录 HEAD commit SHA |

---

### #3 文件树升级【P0, 5d】

#### 改造内容

FileExplorer.tsx 已有：递归树+懒加载+dirCache+排序+图标。新增：Git 状态标记 + 自动刷新 + 右键菜单。

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/components/FileExplorer.tsx` | **升级**：Git 状态 + 自动刷新 + 右键 |
| `src-tauri/src/lib.rs` | list_directory 扩展 include_git_status |
| `src/components/PanelSidebar.tsx` | 新增 "文件" Tab |
| `src/styles.css` | Git 状态标记样式 |

**不改**：FileEditor.tsx（点击文件仍弹 FileEditor，流程不变）

---

### #4 Diff 面板 + Topic 视角【P1, 3d】

DiffViewer.tsx 已有 LCS diff + 三视图 + Accept/Reject。新建 FileChangesList.tsx 薄包装，从 turn_file_changes 读数据，复用 DiffViewer 渲染。

| 文件 | 修改 |
|------|------|
| `src/components/FileChangesList.tsx` | **新建**（很薄） |
| `src/components/PanelSidebar.tsx` | "变更" Tab |
| `src/components/DiffViewer.tsx` | **不改** |

---

### #5 自动 Git Commit Message【P1, 3d】

| 文件 | 修改 |
|------|------|
| `src/core/environment/git-commit-service.ts` | **新建** |
| `src/components/GitInfoPanel.tsx` | 监听 auto_committed 刷新 |
| `src/components/SettingsPanel.tsx` | 新增开关 |

**与 GitInfoPanel 关系**：AutoCommit 是自动版，GitInfoPanel 是手动版，互补。

---

### #6 Transcript 缓存【P1, 2d】

| 文件 | 修改 |
|------|------|
| `src/core/storage/transcript-cache.ts` | **新建** |
| `src/core/llm/agentic-loop.ts` | convertMessagesToLLM 先查缓存 |

---

### #7 Agent Profile 持久化【P1, 3d】

#### 改造内容

SubagentTask 现有：id/name/parentId/prompt/cwd/status/persistent。新增 profile_id 关联到 AgentProfile。

```typescript
// 新增接口
export interface AgentProfile {
  id: string;           // 稳定 ID
  identity: string;     // "代码审查 Agent"
  domain: string;       // "负责审查代码变更"
  scope: string;        // "不负责编写代码，只审查"
  experience_summary: string;  // 限 500 字
  created_at: number;
  updated_at: number;
}
```

#### SQLite 表

```sql
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  skills TEXT,
  experience_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/core/subagent/subagent.ts` | 扩展 SubagentTask + AgentProfile 接口 |
| `src/core/subagent/spawner.ts` | spawn 时查 Profile 注入 system prompt |
| `src/core/storage/database.ts` | 新增表 |
| `src/core/storage/agent-profile-storage.ts` | **新建** CRUD |
| `src/core/llm/tools.ts` | spawn_subagent 增加 profile_id |

#### 潜在隐患

| 隐患 | 规避 |
|------|------|
| Profile 过期 | updated_at + 人工 review |
| token 膨胀 | experience_summary 限 500 字 + persistent 才注入 |

---

### #8 Needs You 机制【P1, 4d】

#### 设计

Agent 主动暂停 + 提出精确问题（不是模糊的"怎么办"）。onWriteConfirm 是其简化版，扩展为通用机制。

**触发时机**：**迭代边界**（不在工具回调内，避免阻塞工具返回）。类似 GuidanceQueue 的消费时机。

```
迭代边界 → 检查 needs_you_queue → 如果有未回答项
  → emit("needs_you", {question, context, options, resumePath})
  → AgenticLoop 暂停 → 用户回答 → 结果回到原迭代
```

#### SQLite 表（会话恢复用）

```sql
CREATE TABLE IF NOT EXISTS needs_you_pending (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  options TEXT,
  iteration INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/core/llm/needs-you-queue.ts` | **新建**（反向 GuidanceQueue） |
| `src/core/llm/agentic-loop.ts` | 迭代边界检测 → 暂停 |
| `src/components/NeedsYouPanel.tsx` | **新建** |
| `src/App.tsx` | 监听 needs_you 事件 |

#### 潜在隐患

| 隐患 | 规避 |
|------|------|
| 滥用（频繁打断用户） | 每轮最多 1 次 + 用户可"跳过并继续" |
| 会话恢复丢失 | needs_you_pending 表持久化 |
| 与上下文压缩冲突 | 独立于 messages JSON，不受压缩影响 |
| 在工具回调内触发会阻塞 | **改为迭代边界触发**（不在工具回调内） |
| 子 Agent 的 needs_you | 通过 SubagentActivity 传递 → 主 Agent 看到 blocked 状态 |

---

### #9 浏览器面板【P2, 5d】

新建 Tauri WebView 窗口用于前端预览。独立。

---

### #10 Agent Message 异步通信【P2, 5d】

#### 设计

现有 wait_for_subagent 是**同步阻塞**。改为：spawn 后不阻塞，结果入 message queue，主 Agent 在迭代边界消费。

**不改现有工具语义**：wait_for_subagent 保持同步阻塞。新增 check_subagent（非阻塞查询）。

#### SQLite 表（会话恢复用）

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message_type TEXT NOT NULL,  -- request/notification/reply
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
```

#### 影响文件

| 文件 | 修改 |
|------|------|
| `src/core/llm/agent-message-queue.ts` | **新建** |
| `src/core/subagent/spawner.ts` | spawn 后结果入 queue |
| `src/core/llm/agentic-loop.ts` | 迭代边界消费 reply |
| `src/core/llm/tools.ts` | 新增 check_subagent（非阻塞） |

#### 潜在隐患

| 隐患 | 规避 |
|------|------|
| 消息乱序 | 序列号 + 按序消费 |
| 死锁（A等B，B等A） | 60s 超时 + 循环依赖检测 |
| 会话恢复丢失 | agent_messages 表持久化 |
| 上下文膨胀 | reply 只存摘要 |

---

### #11 Overview 轻量版【P2, 3d】

Workbench.tsx 已有 activeTools + modifiedFiles（但传入空数组）。升级为 Status+Capacity+Activity。

**关键原则**：Signal 不是 Diagnosis——指标只是调查入口，不自动得出结论。

| 文件 | 修改 |
|------|------|
| `src/components/Workbench.tsx` | **升级** |
| `src/components/PanelSidebar.tsx` | 传入真实数据 |

---

### #12 Artifact 快照引用【P2, 2d】

集成到 #2（artifact_id + sha256 已在 #2 表结构中）。其他 Agent 可引用 artifact_id 而非文件路径。

---

## 五、全量受影响文件索引

### Rust 层

| 文件 | 涉及 |
|------|------|
| `src-tauri/Cargo.toml` | #1 portable-pty |
| `src-tauri/src/lib.rs` | #1 PtyManager、#3 list_directory 扩展 |
| `src-tauri/capabilities/default.json` | #1 PTY 权限 |

### 核心层

| 文件 | 涉及 |
|------|------|
| `src/core/environment/file-change-tracker.ts` | #2 **新建** |
| `src/core/storage/file-change-storage.ts` | #2 **新建** |
| `src/core/storage/database.ts` | #2 turn_file_changes、#7 agent_profiles、#8 needs_you_pending、#10 agent_messages |
| `src/core/llm/agentic-loop.ts` | #2 start/finalize、#6 缓存、#8 needs_you、#10 message |
| `src/core/llm/index.ts` | #2 传入 tracker |
| `src/core/llm/tools.ts` | #7 spawn profile_id、#10 check_subagent |
| `src/core/environment/git-commit-service.ts` | #5 **新建** |
| `src/core/storage/transcript-cache.ts` | #6 **新建** |
| `src/core/subagent/subagent.ts` | #7 扩展 |
| `src/core/subagent/spawner.ts` | #7 查 Profile、#10 非阻塞 |
| `src/core/storage/agent-profile-storage.ts` | #7 **新建** |
| `src/core/llm/needs-you-queue.ts` | #8 **新建** |
| `src/core/llm/agent-message-queue.ts` | #10 **新建** |

### 组件层

| 文件 | 涉及 |
|------|------|
| `src/components/TerminalPanel.tsx` | #1 **升级** |
| `src/components/FileExplorer.tsx` | #3 **升级** |
| `src/components/FileChangesList.tsx` | #4 **新建** |
| `src/components/NeedsYouPanel.tsx` | #8 **新建** |
| `src/components/Workbench.tsx` | #11 **升级** |
| `src/components/PanelSidebar.tsx` | #2/#3/#4 新增 Tab、#11 传真实数据 |
| `src/components/GitInfoPanel.tsx` | #5 监听刷新 |
| `src/components/SettingsPanel.tsx` | #5 开关 |
| `src/components/ChatPanel.tsx` | #2 监听事件 |
| `src/components/DiffViewer.tsx` | **不改** |
| `src/components/FileEditor.tsx` | **不改** |

### 布局/样式

| 文件 | 涉及 |
|------|------|
| `src/App.tsx` | #8 监听 needs_you |
| `src/styles.css` | #1/#3/#4/#8 新增样式 |

---

## 六、新增 SQLite 表汇总

| 表名 | 改进项 | 用途 | 受压缩影响 |
|------|--------|------|-----------|
| `turn_file_changes` | #2 | per-turn 变更追踪 + Artifact | ❌ 不受 |
| `agent_profiles` | #7 | Agent 身份持久化 | ❌ 不受 |
| `needs_you_pending` | #8 | 未回答问题持久化 | ❌ 不受 |
| `agent_messages` | #10 | 异步消息持久化 | ❌ 不受 |

**关键设计原则**：所有新增表独立于 v2_sessions.messages JSON，上下文压缩不影响。

---

## 七、深度影响分析

### 对消息链（Event Stream）

现有事件：start/text_delta/tool_start/tool_end/guidance_received/compaction/end。

| 改进项 | 新增事件 | 影响的消费方 | 兼容方案 |
|--------|---------|------------|---------|
| #2 | file_changes_tracked/reverted | ChatPanel | 新增 listen，不改现有 |
| #8 | needs_you/needs_you_answered | App.tsx | 新增 listen，类似 onWriteConfirm |
| #10 | agent_message_sent/received | AgenticLoop | 类似 guidance，新增消费点 |

新增事件不影响现有 switch 分支——只是新增 case。

### 对工具链（Tool Execution）

| 改进项 | 影响 | 风险 | 规避 |
|--------|------|------|------|
| #2 | 不介入工具执行（轮次边界） | 低 | — |
| #8 | **不在工具回调内触发**（迭代边界） | 中 | 改为迭代边界，类似 guidance 消费 |
| #10 | 不改 wait_for_subagent 语义 | 中 | 新增 check_subagent（非阻塞查询） |
| #7 | spawn_subagent 增加可选参数 | 低 | 向后兼容 |

### 对子智能体（Subagent）

| 改进项 | 影响 | 规避 |
|--------|------|------|
| #7 | SubagentTask 新增 profile_id | 向后兼容，不传时退化 |
| #8 | 子 Agent 的 needs_you 通过 SubagentActivity 传递 | 主 Agent 看到 blocked 状态 |
| #10 | spawn 后不阻塞 → 结果入 queue | persistent=true 结果存 DB |

### 对会话恢复（Session Recovery）

| 改进项 | 风险 | 规避 |
|--------|------|------|
| #8 | 未回答 needs_you 恢复后丢失 | needs_you_pending 表持久化 |
| #10 | 未消费 message 恢复后丢失 | agent_messages 表持久化 |
| #2 | 历史变更有 session_id 关联 | 恢复时读取，不影响现有恢复 |
| #7 | Profile 按 project 隔离 | DB 查询，不在消息中 |

### 对上下文压缩（Compaction）

所有新增持久化独立于 messages JSON，**不受压缩影响**。

### 对安全模式（Security Mode）

onWriteConfirm 保持不变（向后兼容）。Needs You 是上层通用机制，两者不冲突。

### 对成本追踪（Cost Tracker）

Profile 注入增加 token。规避：experience_summary 限 500 字 + persistent 才注入。

---

## 八、全局风险与规避

| 风险 | 规避 |
|------|------|
| PanelSidebar Tab 过多（Git+工作台+文件+变更=4个） | 改图标+tooltip 或可折叠 |
| Ctrl+C 与复制冲突 | Ctrl+Shift+C 中断 + 工具栏按钮 |
| 非 Git 工作区 | 所有 Git 功能优雅降级 |
| needs_you 滥用 | 每轮最多 1 次 + 用户可跳过 |
| 异步 Message 死锁 | 60s 超时 + 循环依赖检测 |
| Profile token 膨胀 | 限 500 字 + persistent 才注入 |
| Overview 误读为绩效 | 明确标注 "Signal 不是 Diagnosis" |
