# 专项对标分析：Coding Agent 与代码生成

> 我们（零预处理架构）vs Wecode-ref（Codex 集成架构）vs Codex 原版

---

## 一、架构对比总览

### 三种架构范式

| 维度 | Codem（我们） | Wecode-ref | OpenAI Codex 原版 |
|------|--------------|------------|------------------|
| **架构范式** | 零预处理 + 实时工具调用 | Codex CLI 集成 + 后端编排 | 内置 LLM + sandbox |
| **代码理解** | 实时 glob/grep/read | 委托 Codex CLI 处理 | 内置 apply_patch + 文件工具 |
| **代码编辑** | 精确字符串匹配 edit | Codex apply_patch 流式补丁 | apply_patch 协议 |
| **执行隔离** | Git worktree（进程级） | Docker 容器 + 沙箱环境 | 远程 sandbox 容器 |
| **文件变更追踪** | 无（用户手动 diff 确认） | TurnFileChangeTracker（git tree 快照） | Codex 事件流 |
| **上下文管理** | LLM 摘要压缩 | Transcript Cache + Rollout | Codex 内部管理 |
| **配置注入** | System Prompt 分层 | CODEX_HOME + config.toml | config.toml |

> **[配图位]**：三架构对比流程图，展示各自从"用户输入"到"代码写入"的完整链路

---

## 二、详细对比分析

### 2.1 代码理解（Codebase Understanding）

#### Codem（我们）—— 零预处理 + 实时工具

```
用户："找到所有 API 路由定义"
  │
  ├── glob(pattern="**/route*", type="ts")  → 文件名搜索
  ├── grep(pattern="router\.(get|post)", path="src/")  → 内容搜索
  ├── read(filePath="src/routes/index.ts")  → 读取文件
  │
  └── LLM 综合工具结果生成回答
```

**特点**：
- ✅ 零预处理，无需预索引，适配任何项目
- ✅ 工具调用即所见即所得，LLM 自主决定搜索策略
- ❌ 无 AST 解析，不理解符号依赖关系
- ❌ 无语义搜索（如"找到类似的函数"）
- ❌ 每次都重新搜索，无结果缓存

#### Wecode-ref —— Codex CLI 集成

```
用户："实现一个搜索功能"
  │
  ├── Executor 创建 Codex app-server 子进程
  ├── CODEX_HOME 环境变量指向隔离配置目录
  ├── config.toml 注入 developer_instructions
  ├── Codex CLI 内部自主调用 read/grep/shell 工具
  ├── apply_patch_streaming_events=true 启用流式补丁
  │
  └── Executor 通过 JSON-RPC 监听事件流
      ├── item/started → 阶段追踪（commentary/analysis/final_answer）
      ├── item/agentMessage/delta → 流式文本
      └── patch/apply_end → 文件变更追踪
```

**特点**：
- ✅ Codex CLI 自带完整的代码理解能力（预训练了代码库模式）
- ✅ apply_patch 流式补丁，支持大文件增量编辑
- ✅ 多阶段输出（commentary → analysis → final_answer），用户能看到思考过程
- ❌ 依赖外部 Codex CLI 二进制，不能自研模型
- ❌ CODEX_HOME 隔离需要文件系统管理

#### OpenAI Codex 原版

- Codex 自身集成了代码理解和生成能力
- 使用 `apply_patch` 协议进行文件编辑
- 远程 sandbox 容器隔离执行
- 无需用户预索引，Codex 内部自主探索

---

### 2.2 代码编辑（Code Editing）

#### Codem —— 精确字符串匹配

```typescript
// src/core/llm/tools/edit.ts
// edit 工具：old_string → new_string 精确替换
edit(filePath, oldString, newString, replaceAll)
```

| 特性 | 实现 |
|------|------|
| 匹配方式 | 精确字符串匹配（非行号） |
| 健壮性 | 文件外部修改不影响（只要目标字符串还在） |
| 唯一性 | old_string 不唯一时报错，要求更多上下文 |
| 批量替换 | replaceAll 选项 |
| 安全确认 | 覆写已有文件时弹出 diff 对比 |

#### Wecode-ref —— Codex apply_patch 流式补丁

```rust
// executor/src/agents/codex.rs
const CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE: &str =
    "features.apply_patch_streaming_events=true";
```

| 特性 | 实现 |
|------|------|
| 匹配方式 | apply_patch 协议（基于 unified diff） |
| 流式输出 | patch_apply_end 事件实时推送 |
| 变更追踪 | TurnFileChangeTracker 捕获 git tree 快照 diff |
| 补丁格式 | 标准 unified diff，支持二进制文件（--binary） |
| 回滚能力 | 保留 before/after git tree，可精确回滚 |

#### 对比

| 维度 | Codem | Wecode-ref |
|------|-------|------------|
| 编辑粒度 | 字符串替换 | 行级 diff 补丁 |
| 大文件编辑 | 需要完整 old_string | 增量补丁，只传变化部分 |
| 变更追踪 | 无 | ✅ git tree 快照 + diff 归档 |
| 回滚 | 用户手动 git checkout | ✅ 精确到 turn 级别回滚 |
| 安全确认 | ✅ diff 弹窗确认 | Codex 内部审批 |

---

### 2.3 执行隔离与沙箱

#### Codem —— Git Worktree（进程级隔离）

```
项目目录 .git
  ├── main 分支（用户主工作区）
  └── worktree: codem-session-xxx（会话工作区）
      └── Agent 在此工作区中读写/执行命令
```

| 特性 | 实现 |
|------|------|
| 隔离级别 | Git 分支级（同一文件系统） |
| 优点 | 轻量，无需 Docker，启动即用 |
| 缺点 | 进程共享，Agent 可影响系统（如写入非工作区目录） |
| 安全补充 | write_file 路径白名单 + worktree 单引号路径 |

#### Wecode-ref —— Docker 容器 + 沙箱

```
Executor Manager
  ├── Docker Container（每个任务一个容器）
  │   ├── Codex CLI 进程
  │   ├── Workspace 挂载（只读/读写）
  │   ├── 沙箱环境（受限网络/文件系统）
  │   └── Heartbeat 进程监控
  └── fork_transfer（容器间文件传输）
```

| 特性 | 实现 |
|------|------|
| 隔离级别 | 容器级（完全隔离） |
| 文件系统 | 挂载 workspace，排除 node_modules/.git 等 |
| 网络隔离 | `NO_PROXY=localhost,127.0.0.1` |
| 进程监控 | Heartbeat 定期检查容器存活 |
| OOM 处理 | `get_container_status` 检测 OOM killed |
| Fork 传输 | runtime-fork 归档传输（排除 .git/node_modules 等） |
| 回滚 | git tree 快照 + 二进制 diff 补丁归档 |

#### OpenAI Codex 原版

| 特性 | 实现 |
|------|------|
| 隔离级别 | 远程 sandbox 容器 |
| 网络隔离 | 完全隔离，按需白名单 |
| 文件系统 | 临时容器文件系统 |

---

### 2.4 文件变更追踪与审计

#### Codem —— 无自动追踪

- 覆写前弹 diff 确认（`onWriteConfirm`）
- 用户手动通过 git 查看变更
- 无自动化的 per-turn 变更归档

#### Wecode-ref —— TurnFileChangeTracker

```rust
// executor/src/services/turn_file_changes.rs
pub struct TurnFileChangeTracker {
    workspace: PathBuf,
    task_id: i64,
    subtask_id: i64,
    before: Option<GitTreeSnapshot>,  // 开始前 git tree ID
    active: bool,
}

impl TurnFileChangeTracker {
    pub fn start(&mut self) -> bool {
        // 捕获开始前的 git tree 快照
        self.before = Some(capture_tree(&self.workspace));
    }

    pub fn finalize(&mut self) -> Value {
        // 捕获结束后的 git tree
        let after = capture_tree(&self.workspace);
        // 生成二进制 diff 补丁
        let patch = git_output("diff --binary --find-renames before after);
        // 归档补丁 + 文件内容快照
    }
}
```

**完整审计链**：
```
任务开始 → capture_tree(before)
  → Agent 执行（可能多次 edit/bash）
  → capture_tree(after)
  → git diff --binary before..after  → 二进制补丁
  → 文件内容快照（每变更文件的 before/after 内容）
  → SHA256 校验
  → Gzip 压缩归档
  → 上传到 Backend 存储
```

#### 对比

| 维度 | Codem | Wecode-ref |
|------|-------|------------|
| 变更追踪 | 无 | ✅ per-turn git tree 快照 |
| 补丁格式 | 无 | ✅ 二进制 unified diff |
| 文件快照 | 无 | ✅ before/after 内容 |
| 回滚 | 用户手动 git | ✅ 精确到 turn 级别 |
| 审计归档 | 无 | ✅ Gzip 压缩 + SHA256 校验 |

---

### 2.5 上下文管理

#### Codem —— LLM 摘要压缩

- 上下文压力 > 80% 触发 LLM 摘要压缩
- 级联压缩（旧摘要纳入新摘要）
- 压缩后恢复已加载技能 prompt
- 反应式压缩（API 返回 context 超限时自动压缩重试）

#### Wecode-ref —— Transcript Cache + Rollout

```rust
// executor/src/runtime_work/transcript_cache.rs
const RUNNING_TRANSCRIPT_CACHE_TTL_MS: i64 = 1_200;   // 运行中 1.2s 缓存
const COMPLETED_TRANSCRIPT_CACHE_TTL_MS: i64 = 60_000; // 完成后 60s 缓存

pub(crate) struct TranscriptCache {
    entries: Arc<Mutex<HashMap<String, CachedTranscript>>>,
}

pub(crate) struct CachedTranscript {
    pub messages: Vec<Value>,
    pub context_usage: Option<Value>,
    pub running: bool,
    pub source_signature: Option<TranscriptSourceSignature>,  // 文件签名防过期
}
```

**特点**：
- ✅ Transcript 缓存减少重复加载
- ✅ 文件签名（path + len + modified）检测 transcript 文件是否过期
- ✅ Codex rollout 分页加载历史 turn
- ✅ context_usage 追踪上下文使用率
- ❌ 依赖 Codex 内部的上下文管理，不可自研压缩策略

---

### 2.6 配置注入与指令安全

#### Codem —— System Prompt 分层

```
System Prompt 分层拼接（固定在前，动态在后）：
  1. 核心身份（固定）
  2. 用户偏好（固定）
  3. 项目指令（固定）
  4. 技能指令（半固定）
  5. 知识库 RAG 上下文（动态）
  6. 日期/环境信息（动态）
```

#### Wecode-ref —— CODEX_HOME + config.toml

```rust
// executor/src/agents/codex.rs
const CODEX_HOME_ENV: &str = "CODEX_HOME";

// 每个任务有独立的 CODEX_HOME 目录
// config.toml 中注入 developer_instructions
// 链接用户 auth.json 到 CODEX_HOME
```

**指令安全**：
- `SIDE_BOUNDARY_PROMPT`：fork 对话的边界标记，防止旧指令延续
- `WEWORK_EMBEDDED_BROWSER_DEVELOPER_INSTRUCTIONS`：注入浏览器路由指令
- `combined_codex_developer_instructions`：合并用户指令 + 系统指令

---

### 2.7 阶段追踪与流式输出

#### Codem —— 单一文本流

- SSE 流式输出文本 delta
- 工具调用事件（start/progress/end）
- 无阶段区分（LLM 输出就是最终答案）

#### Wecode-ref —— 多阶段追踪

```rust
// executor/src/codex_phase.rs
// Codex 输出有多个阶段：
// 1. commentary — 评述/思考过程
// 2. analysis — 分析
// 3. final_answer — 最终答案

pub(crate) struct CodexAgentMessagePhaseTracker {
    phases_by_item_id: BTreeMap<String, String>,
}
```

**事件协议**：
```
item/started     → 开始新阶段（含 phase 字段）
item/agentMessage/delta → 文本增量（不含 phase，通过 itemId 关联）
item/completed   → 阶段完成
```

**用户体验**：
- 用户能看到 Codex 的思考过程（commentary 阶段）
- 区分"我在分析"和"这是最终答案"
- Transcript 回放时也能正确区分阶段

---

## 三、差距总结

### 我们缺失的能力（按优先级排序）

| # | 缺失能力 | 影响 | 实现难度 |
|---|---------|------|---------|
| 1 | **文件变更追踪** | 无法 per-turn 审计/回滚 | 中（借鉴 TurnFileChangeTracker） |
| 2 | **apply_patch 流式补丁** | 大文件编辑效率低 | 高（需改工具协议） |
| 3 | **多阶段输出** | 用户看不到思考过程 | 中（需 LLM 支持） |
| 4 | **Transcript 缓存** | 重复加载开销 | 低（加文件签名缓存） |
| 5 | **容器级隔离** | Agent 可影响系统 | 高（需 Docker 集成） |
| 6 | **语义代码搜索** | 无法"找类似函数" | 高（需 AST + Embedding） |
| 7 | **Pre-execute Hook** | 无法在执行前预处理 | 低（加环境变量钩子） |

### 我们的优势（Wecode-ref 不具备的）

| # | 优势 | 说明 |
|---|------|------|
| 1 | **零外部依赖** | 不依赖 Codex CLI 二进制 |
| 2 | **自研 Agent 循环** | 可自由调整工具/权限/压缩策略 |
| 3 | **精确字符串编辑** | 比 unified diff 更健壮（不怕行号偏移） |
| 4 | **diff 确认弹窗** | 覆写前用户审查（Codex 无此机制） |
| 5 | **编码安全五层防御** | chcp 65001 + BOM + python -c 改写 |
| 6 | **跨会话委派** | 用户可见会话间调用（行业独有） |

---

## 四、改进建议

### 4.1 短期（低成本高收益）

#### 建议1：文件变更追踪（借鉴 TurnFileChangeTracker）

```typescript
// 新增 FileChangeTracker 类
class FileChangeTracker {
  private beforeTree: string | null = null;

  async start(workspace: string): Promise<boolean> {
    // git rev-parse HEAD^{tree} 获取当前 tree ID
    this.beforeTree = await this.captureTree(workspace);
    return true;
  }

  async finalize(): Promise<FileChangeReport> {
    const afterTree = await this.captureTree(this.workspace);
    // git diff --binary beforeTree afterTree
    // 归档补丁 + 变更文件列表
    return { patch, changedFiles, beforeTree, afterTree };
  }
}
```

#### 建议2：Pre-execute Hook

```typescript
// 从环境变量读取 pre-execute 命令
// 在 Agent 开始执行前运行（如：npm install / pre-commit hook）
const hook = process.env.CODEM_HOOK_PRE_EXECUTE;
if (hook) {
  await executeCommand(hook, workspace, { timeout: 30000 });
}
```

#### 建议3：Transcript 文件签名缓存

```typescript
// 缓存从 DB 加载的消息，通过文件签名检测是否过期
interface TranscriptSignature {
  path: string;
  size: number;
  modified: number;
}
// 文件签名变化时重新加载，否则用缓存
```

### 4.2 中期（中等成本）

#### 建议4：多阶段输出

- 在 System Prompt 中要求 LLM 用 `[ANALYSIS]` / `[FINAL]` 标记区分阶段
- 前端解析标记，分别渲染"思考过程"和"最终答案"

#### 建议5：apply_patch 协议支持

- 新增 `apply_patch` 工具，接收 unified diff
- 支持大文件增量编辑（只传变化部分）
- 需要实现 diff 解析和应用逻辑

### 4.3 长期（高成本）

#### 建议6：语义代码搜索

- 解析项目 AST，提取函数/类/变量符号
- 为符号生成 Embedding 向量
- 支持"找到类似这个函数的代码"

#### 建议7：容器级隔离

- 集成 Docker，每个会话在独立容器中运行
- 挂载 workspace（读写），排除 node_modules/.git
- 心跳监控容器存活状态

---

## 五、核心代码导航

### Wecode-ref 关键文件

| 文件 | 职责 |
|------|------|
| `executor/src/agents/codex.rs` | Codex CLI 集成、CODEX_HOME 配置、apply_patch 流式事件 |
| `executor/src/codex_phase.rs` | 多阶段追踪（commentary/analysis/final_answer） |
| `executor/src/services/turn_file_changes.rs` | TurnFileChangeTracker，git tree 快照 + 二进制 diff 归档 |
| `executor/src/runtime_work/transcript_cache.rs` | Transcript 缓存（文件签名防过期） |
| `executor/src/runtime_work/codex_rollout.rs` | Codex rollout 分页加载历史 turn |
| `executor/src/runtime_work/fork_transfer.rs` | 容器间文件传输（排除 .git/node_modules） |
| `executor/src/prompt_enrichment.rs` | 知识库路由指令注入 |
| `executor/src/hooks/pre_execute.rs` | Pre-execute 钩子 |
| `executor/src/local/git_commit_message.rs` | 自动生成 git commit message |
| `executor/src/process_environment.rs` | 进程环境变量标准化 |
| `backend/app/services/rag/` | RAG 运行时架构（索引/检索/嵌入） |

### Codem 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/llm/tools/read.ts` | 文件读取（实时） |
| `src/core/llm/tools/glob.ts` | 文件名搜索 |
| `src/core/llm/tools/grep.ts` | 内容搜索 |
| `src/core/llm/tools/edit.ts` | 精确字符串编辑 |
| `src/core/llm/tools/bash.ts` | 命令执行（含编码安全） |
| `src/core/llm/agentic-loop.ts` | Agent 循环 + 上下文压缩 |
| `src/core/environment/worktree-manager.ts` | Git worktree 隔离 |

---

## 小结

> **Codem（我们）**：零预处理 + 实时工具调用，轻量灵活，无外部依赖，但缺少文件变更追踪、多阶段输出、容器隔离
> **Wecode-ref**：Codex CLI 集成 + 后端编排，功能完整（apply_patch + 文件追踪 + 容器隔离 + Transcript 缓存），但依赖 Codex 二进制
> **Codex 原版**：远程 sandbox + apply_patch，自研模型，完全隔离
>
> **最值得借鉴的**：TurnFileChangeTracker（文件变更追踪）→ 低成本高收益
> **其次**：Transcript 缓存 + Pre-execute Hook → 快速实现
> **长期方向**：语义代码搜索 + 容器级隔离 → 与 Codex 对齐
