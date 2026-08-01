# 编程功能对标分析：Wecode-ref 有什么，我们缺什么

> 逐功能模块对比 Wecode-ref（含 Codex 集成 + Claude Code 集成 + 后端编排）与 Codem

---

## 一、完整功能清单对比

### 1.1 总表

| # | 功能模块 | Wecode-ref | Codem（我们） | 差距 |
|---|---------|-----------|--------------|------|
| 1 | **内置终端** | ✅ xterm.js + PTY 真终端 | ❌ 无 | 🔴 缺失 |
| 2 | **文件树浏览器** | ✅ WorkspaceFileTree 组件 | ❌ 无（仅工具 glob/grep） | 🔴 缺失 |
| 3 | **文件变更 Diff 面板** | ✅ FileChangesReviewPanel | ❌ 无 | 🔴 缺失 |
| 4 | **浏览器面板** | ✅ 内置浏览器（CDP 协议） | ❌ 无 | 🔴 缺失 |
| 5 | **文件变更追踪（per-turn）** | ✅ TurnFileChangeTracker | ❌ 无 | 🔴 缺失 |
| 6 | **自动 Git Commit** | ✅ git_commit_message 自动生成 | ❌ 无 | 🟡 缺失 |
| 7 | **Git 认证管理** | ✅ AES-256 加解密 + token 注入 | ❌ 无（用户手动配置） | 🟡 缺失 |
| 8 | **Pre-execute Hook** | ✅ 环境变量钩子 | ❌ 无 | 🟡 缺失 |
| 9 | **File Edit Hook** | ✅ PreToolUse/PostToolUse 钩子 | ⚠️ 有 onWriteConfirm 但无 hook 机制 | 🟡 部分 |
| 10 | **多 Agent 引擎切换** | ✅ Codex + Claude Code + Dify + Agno | ❌ 仅自研 LLM 循环 | 🔴 缺失 |
| 11 | **多阶段输出** | ✅ commentary/analysis/final_answer | ❌ 单一文本流 | 🟡 缺失 |
| 12 | **apply_patch 流式补丁** | ✅ apply_patch_streaming_events | ❌ 精确字符串匹配 | 🟡 替代方案 |
| 13 | **对话工作区隔离** | ✅ 每个对话创建独立目录 | ⚠️ Git worktree（需手动启用） | 🟡 部分 |
| 14 | **运行时归档/恢复** | ✅ tar.gz 归档 + 恢复 | ❌ 无 | 🔴 缺失 |
| 15 | **Heartbeat 进程监控** | ✅ sandbox heartbeat + OOM 检测 | ❌ 无 | 🔴 缺失 |
| 16 | **Executor 自动更新** | ✅ GitHub 版本检查 + 二进制替换 | ⚠️ Tauri updater（刚接入） | 🟢 基本对齐 |
| 17 | **技能部署** | ✅ skill_deployer 部署计划 | ✅ 有技能系统但无部署计划 | 🟡 部分 |
| 18 | **技能市场下载** | ✅ skill_download 并发下载 | ✅ 有技能市场 | 🟢 对齐 |
| 19 | **RAG 知识库（后端）** | ✅ 完整 RAG 运行时 | ✅ 有 Notebook RAG | 🟢 基本对齐 |
| 20 | **Transcript 缓存** | ✅ 文件签名 + TTL 缓存 | ❌ 每次从 DB 重新加载 | 🟡 缺失 |
| 21 | **Fork 对话** | ✅ fork_transfer + SIDE_BOUNDARY | ✅ 有 fork 上下文隔离 | 🟢 对齐 |
| 22 | **配置隔离** | ✅ CODEX_HOME / CLAUDE_CONFIG_DIR | ❌ 无（共享配置） | 🟡 缺失 |
| 23 | **多租户/多设备** | ✅ device_id + workspace_root | ❌ 无（单用户桌面应用） | N/A |
| 24 | **任务编排与恢复** | ✅ Backend 任务队列 + 恢复 | ❌ 无（无任务队列） | 🔴 缺失 |
| 25 | **代码理解（AST/语义）** | ❌ 委托 Codex/Claude 处理 | ❌ 实时 glob/grep | N/A（都无） |

---

## 二、缺失功能详细分析

### 2.1 内置终端（🔴 关键缺失）

#### Wecode-ref 实现

```
┌──────────────────────────────────┐
│  WorkspacePanelCards             │
│  ├── 内置终端面板 (xterm.js)      │
│  │   ├── 本地终端 (PTY 真终端)    │
│  │   │   └── portable_pty 管理    │
│  │   └── 远程终端 (SSH/容器)      │
│  │       └── SessionType::Terminal │
│  ├── 终端会话管理                   │
│  │   ├── start/resume/close       │
│  │   └── TTL 60 分钟自动清理       │
│  └── 链接检测 (URL 可点击)         │
│      └── xterm WebLinks Addon     │
└──────────────────────────────────┘
```

**关键文件**：
- `executor/src/local/pty.rs` — PTY 进程管理（Unix）/ Windows 兼容
- `executor/src/local/session.rs` — 终端会话管理（Terminal/CodeServer 两种类型）
- `executor/src/envd/process_service.rs` — 沙箱内 PTY 管理
- `wework/src/components/layout/workspace-panels/EmbeddedLocalTerminal.tsx`
- `wework/src/components/layout/workspace-panels/RemoteTerminal.tsx`

**功能**：
- 真终端：用户可以直接在应用内打开终端，运行命令
- 多会话：支持同时多个终端标签
- 远程终端：可以连接到 Docker 容器内的终端
- xterm.js 渲染：完整 ANSI 颜色、链接检测、输入回退
- 会话 TTL：60 分钟无活动自动清理

#### Codem 缺失影响

**用户不能**：
- 在应用内直接运行 `npm run dev`、`cargo build` 等命令
- 看到 Agent 执行命令的实时输出（只能在消息流中看到结果）
- 手动执行 Agent 不会执行的命令
- 与 Agent 协作开发（Agent 改代码，用户在终端看效果）

---

### 2.2 文件树浏览器（🔴 关键缺失）

#### Wecode-ref 实现

```
┌──────────────────────────────────┐
│  WorkspaceFileTree               │
│  ├── 目录树渲染（折叠/展开）      │
│  ├── 文件图标（按扩展名）         │
│  ├── 文件操作                     │
│  │   ├── 创建文件/文件夹          │
│  │   ├── 删除                     │
│  │   └── 重命名                   │
│  └── Git 状态标记                 │
│      ├── M (Modified)             │
│      ├── A (Added)                │
│      └── U (Untracked)            │
└──────────────────────────────────┘
```

**关键文件**：
- `wework/src/components/layout/workspace-panels/WorkspaceFileTree.tsx`

#### Codem 缺失影响

**用户不能**：
- 可视化浏览项目文件结构
- 直观看到哪些文件被 Agent 修改了
- 在文件树中点击打开文件查看内容
- 快速导航到 Agent 正在操作的文件

---

### 2.3 文件变更 Diff 面板（🔴 关键缺失）

#### Wecode-ref 实现

```
┌──────────────────────────────────┐
│  FileChangesReviewPanel          │
│  ├── Per-turn 变更列表            │
│  │   └── 来自 TurnFileChangeTracker│
│  ├── Diff 渲染                    │
│  │   ├── 增加（绿色 +）           │
│  │   ├── 删除（红色 -）           │
│  │   └── 修改（黄色）             │
│  ├── 文件快照对比                  │
│  │   ├── before 旧版本            │
│  │   └── after 新版本             │
│  └── 回滚操作                     │
│      └── 按 turn 回滚到任意快照   │
└──────────────────────────────────┘
```

**关键文件**：
- `wework/src/components/chat/FileChangesReviewPanel.tsx`
- `executor/src/services/turn_file_changes.rs` — TurnFileChangeTracker

#### TurnFileChangeTracker 工作原理

```rust
// executor/src/services/turn_file_changes.rs
pub struct TurnFileChangeTracker {
    workspace: PathBuf,
    before: Option<GitTreeSnapshot>,  // 开始前 git tree ID
    active: bool,
}

impl TurnFileChangeTracker {
    pub fn start(&mut self) -> bool {
        // 1. 捕获开始前的 git tree 快照
        self.before = Some(capture_tree(&self.workspace));
    }

    pub fn finalize(&mut self) -> Value {
        // 2. 捕获结束后的 git tree
        let after = capture_tree(&self.workspace);
        // 3. 生成二进制 diff 补丁
        let patch = git_diff("--binary --find-renames", before, after);
        // 4. 收集变更文件内容快照
        let snapshots = collect_file_snapshots(changed_paths);
        // 5. SHA256 校验
        // 6. Gzip 压缩归档
    }
}
```

**完整审计链**：
```
Agent 开始执行 → capture_tree(before)
  → Agent 调用 edit/bash 工具（可能多次）
  → capture_tree(after)
  → git diff --binary before..after → 二进制补丁
  → 每个变更文件的 before/after 内容快照
  → SHA256 校验 → Gzip 压缩 → 归档
```

#### Codem 缺失影响

**用户不能**：
- 看到每轮对话 Agent 改了什么文件
- 对比修改前后的内容
- 按轮次回滚到任意历史状态
- 审计 Agent 的所有文件操作

**我们仅有**：覆写已有文件时弹 diff 确认（`onWriteConfirm`），但无历史归档。

---

### 2.4 浏览器面板（🔴 关键缺失）

#### Wecode-ref 实现

- 内置浏览器通过 CDP (Chrome DevTools Protocol) 控制
- 用户可以在应用内打开网页
- Agent 可以用 `browser_navigate`、`browser_take_screenshot` 等 MCP 工具操作浏览器
- 开发场景：前端开发时实时预览效果

#### Codem 缺失影响

- 前端开发场景：Agent 改完代码后，用户要切换到外部浏览器看效果
- 爬虫场景：Agent 不能直接操作浏览器抓取页面

---

### 2.5 多 Agent 引擎切换（🔴 关键缺失）

#### Wecode-ref 实现

```rust
// executor/src/protocol/execution.rs
pub enum AgentKind {
    ClaudeCode,   // Claude Code CLI 集成
    CodeX,        // OpenAI Codex CLI 集成
    Agno,         // Agno 框架集成
    Dify,         // Dify 平台集成
    ImageValidator, // 图片验证 Agent
    Unsupported(String),
}
```

```rust
// executor/src/agents/mod.rs
pub fn command_for(&self, request: &ExecutionRequest) -> Result<CommandSpec, String> {
    match request.resolved_agent_kind() {
        AgentKind::ClaudeCode => Ok(build_claude_command(request, &self.claude_binary)),
        AgentKind::CodeX => Ok(build_codex_app_server_command(&self.codex_binary)),
        // ...
    }
}
```

**能力**：
- 用户可以选择用 Codex 还是 Claude Code 来完成任务
- 每个 Agent 引擎有独立的配置目录和认证
- 通过统一的 ExecutionRequest 协议适配

#### Codem 缺失影响

- 用户只能使用我们自己集成的 LLM API（DeepSeek/OpenAI/Anthropic）
- 不能利用 Codex 或 Claude Code 的专有能力（如 apply_patch、sophisticated code understanding）

---

### 2.6 自动 Git Commit（🟡 缺失）

#### Wecode-ref 实现

```rust
// executor/src/local/git_commit_message.rs
pub async fn generate_commit_message(cwd, env) -> CommandResult {
    // 1. git status --short → 变更概览（最大 20KB）
    // 2. git diff --cached --stat → 统计信息
    // 3. git diff --cached -- → 完整 diff（最大 200KB）
    // 4. 调用 Codex CLI 生成 commit message（最大 180 字符）
    // 5. 超时 90 秒
}
```

**功能**：
- Agent 完成任务后自动生成 commit message
- 基于实际 staged changes 分析
- 使用 Codex 模型生成人类可读的 commit subject

#### Codem 缺失影响

- Agent 完成修改后，用户需要手动 git add + git commit
- 没有 AI 辅助的 commit message 生成

---

### 2.7 Heartbeat 进程监控（🔴 缺失）

#### Wecode-ref 实现

```rust
// executor/src/heartbeat.rs
// sandbox heartbeat: 定期检查容器/进程存活
if heartbeat_type == "sandbox" {
    // 检查 /sandboxes/{heartbeat_id}/heartbeat
    // 检测 OOM killed 容器
    // 检测 dead container
    // 自动标记任务失败
}
```

**功能**：
- 定期检查 Agent 进程是否存活
- 检测 OOM（内存溢出）killed
- 容器死掉后自动标记任务失败
- 支持恢复

#### Codem 缺失影响

- Agent 执行命令超时后无自动恢复
- 如果 Agent 进程崩溃，用户无感知

---

### 2.8 运行时归档/恢复（🔴 缺失）

#### Wecode-ref 实现

```rust
// executor/src/envd/archive.rs
pub enum ArchiveMode {
    Executor,  // 执行器归档
    Sandbox,   // 沙箱归档
}

pub struct ArchiveOptions {
    pub mode: ArchiveMode,
    pub workspace_path: PathBuf,
    pub home_path: PathBuf,       // 包含 CODEX_HOME / CLAUDE_CONFIG_DIR
    pub max_size_bytes: u64,
}

pub struct RuntimeArchive {
    pub bytes: Vec<u8>,                // tar.gz 归档
    pub session_file_included: bool,  // 是否包含会话文件
    pub git_included: bool,            // 是否包含 .git
}
```

**功能**：
- 把整个工作区 + 配置 + 会话状态打包成 tar.gz
- 可以在另一台机器上恢复
- 排除 node_modules/.git/target 等大目录
- 支持增量（fork_transfer 只传差异）

#### Codem 缺失影响

- 不能把 Agent 的工作状态打包迁移
- 会话历史只有消息文本，不包含文件系统状态

---

### 2.9 配置隔离（🟡 缺失）

#### Wecode-ref 实现

```rust
// executor/src/agents/codex.rs
const CODEX_HOME_ENV: &str = "CODEX_HOME";

// 每个任务有独立的 CODEX_HOME 目录
// config.toml 中注入 developer_instructions
// auth.json 软链接到用户级认证
```

```rust
// executor/src/agents/claude_code.rs
const CLAUDE_CONFIG_DIR = ...;
// 每个任务有独立的 Claude 配置目录
// settings.json 中注入 file_edit_hooks
```

#### Codem 缺失影响

- 所有 Agent 共享同一个系统提示词配置
- 不能为不同项目/任务定制不同的 Agent 行为
- 无独立的配置目录隔离

---

### 2.10 任务编排与恢复（🔴 缺失）

#### Wecode-ref 实现

```
Backend (Python FastAPI)
  ├── 任务队列（SQLAlchemy Task Store）
  │   ├── task → subtask → execution
  │   ├── 任务状态机（pending/running/completed/failed/cancelled）
  │   └── 重试与恢复
  ├── Executor Manager
  │   ├── Docker 容器调度
  │   ├── 容器状态监控
  │   └── OOM/超时处理
  ├── Polling Dispatcher
  │   └── 轮询执行器状态
  └── Recovery Service
      └── 任务恢复与重试
```

#### Codem 缺失影响

- Agent 任务没有持久化的状态管理
- 应用崩溃后无法恢复正在执行的 Agent 任务
- 无任务队列和并发控制

---

## 三、我们的独有优势

以下功能是我们有但 Wecode-ref 没有的：

| # | 功能 | 说明 |
|---|------|------|
| 1 | **自研 Agent 循环** | 不依赖外部 CLI，可自由调整工具/权限/压缩 |
| 2 | **跨会话委派** | `delegate_to_session` + `wait_for_delegation` |
| 3 | **子 Agent 异步 spawn** | `spawn_subagent` + `wait_for_subagent` |
| 4 | **精确字符串编辑** | 不怕行号偏移，比 unified diff 更健壮 |
| 5 | **diff 确认弹窗** | 覆写前用户审查（Wecode-ref 无此机制） |
| 6 | **编码安全五层防御** | chcp 65001 + BOM + python -c 改写 |
| 7 | **提示词注入六项防护** | 四层 system-reminder 过滤 + 身份锁定 |
| 8 | **桌面宠物系统** | 悬浮通知 + 精灵动画 |
| 9 | **皮肤系统** | 默认/Hub/梦幻三套皮肤 |
| 10 | **成本感知降级** | token 用量超限自动切换到更便宜的模型 |

---

## 四、能否支撑完整开发工作？

### 4.1 当前能力评估

| 开发场景 | 支持度 | 缺什么 |
|---------|--------|--------|
| 代码阅读与理解 | ✅ 完全支持 | — |
| 代码编辑（小文件） | ✅ 完全支持 | — |
| 代码编辑（大文件） | ⚠️ 部分支持 | 无 apply_patch 增量补丁 |
| 命令执行 | ⚠️ 部分支持 | Agent 能执行 bash，但用户无内置终端 |
| 调试与排错 | ⚠️ 部分 | Agent 可以执行命令看输出，但用户不能实时交互 |
| 前端开发 | ❌ 不足 | 无浏览器预览面板 |
| Git 工作流 | ⚠️ 部分 | 有 worktree 隔离，无自动 commit message |
| 文件审计与回滚 | ❌ 不足 | 无 TurnFileChangeTracker |
| 多项目并行 | ✅ 支持 | 有会话管理 + 跨会话委派 |
| 大型重构 | ⚠️ 部分 | 无语义搜索/AST 分析，靠 glob/grep |

### 4.2 结论

**我们的项目可以支撑中小型开发工作**（单文件/少量文件的修改、Bug 修复、功能新增），但 **无法支撑完整的大型开发工作流**，主要瓶颈是：

1. **🔴 用户无法在应用内运行命令** — 开发者需要切换到外部终端
2. **🔴 用户无法可视化浏览文件树** — 不知道 Agent 改了哪些文件
3. **🔴 无法追踪和回滚文件变更** — 每轮对话的修改不可审计
4. **🔴 无前端预览** — 前端开发场景缺失

### 4.3 建议优先级

```
P0（必须做）:
  1. 内置终端 (xterm.js + Tauri PTY)
  2. 文件变更追踪 (TurnFileChangeTracker)
  3. 文件树浏览器

P1（应该做）:
  4. 文件变更 Diff 面板
  5. 自动 Git Commit Message
  6. Transcript 缓存

P2（可以等）:
  7. 浏览器面板 (前端预览)
  8. 多 Agent 引擎切换
  9. 运行时归档/恢复
  10. Heartbeat 监控
```

---

## 五、核心代码导航

### Wecode-ref 关键文件

| 文件 | 功能 |
|------|------|
| `executor/src/local/pty.rs` | PTY 终端进程管理 |
| `executor/src/local/session.rs` | 终端/CodeServer 会话管理 |
| `executor/src/local/git_commit_message.rs` | 自动 Git Commit Message 生成 |
| `executor/src/local/local_skills.rs` | 本地技能扫描与发现 |
| `executor/src/services/turn_file_changes.rs` | 文件变更追踪（git tree 快照 + diff） |
| `executor/src/agents/codex.rs` | Codex CLI 集成（CODEX_HOME + apply_patch） |
| `executor/src/agents/claude_code.rs` | Claude Code 集成（file_edit_hooks + config） |
| `executor/src/agents/mod.rs` | 多 Agent 引擎路由（AgentKind 枚举） |
| `executor/src/agents/git_auth.rs` | Git 认证管理（AES-256 加解密） |
| `executor/src/agents/runtime_capabilities.rs` | 运行时能力准备（技能部署 + 附件处理） |
| `executor/src/codex_phase.rs` | 多阶段输出追踪 |
| `executor/src/heartbeat.rs` | Heartbeat 进程监控 |
| `executor/src/envd/archive.rs` | 运行时归档（tar.gz 打包/恢复） |
| `executor/src/runtime_work/transcript_cache.rs` | Transcript 缓存 |
| `executor/src/runtime_work/fork_transfer.rs` | Fork 对话文件传输 |
| `executor/src/hooks/pre_execute.rs` | Pre-execute 钩子 |
| `executor/src/process_environment.rs` | 进程环境变量标准化 |
| `executor/src/services/updater/` | Executor 自动更新 |
| `wework/src/components/layout/workspace-panels/WorkspaceFileTree.tsx` | 文件树浏览器 |
| `wework/src/components/chat/FileChangesReviewPanel.tsx` | 文件变更 Diff 面板 |
| `wework/src/features/workbench/workbenchRuntimeHelpers.ts` | 对话工作区创建 |

### Codem 对应文件

| 文件 | 功能 |
|------|------|
| `src/core/llm/agentic-loop.ts` | 自研 Agent 循环 |
| `src/core/llm/tools/read.ts` | 文件读取 |
| `src/core/llm/tools/glob.ts` | 文件名搜索 |
| `src/core/llm/tools/grep.ts` | 内容搜索 |
| `src/core/llm/tools/edit.ts` | 精确字符串编辑 |
| `src/core/llm/tools/bash.ts` | 命令执行 |
| `src/core/environment/worktree-manager.ts` | Git worktree 隔离 |
| `src/core/session/orchestrator.ts` | 跨会话委派 |
| `src/core/subagent/spawner.ts` | 子 Agent 异步 spawn |
