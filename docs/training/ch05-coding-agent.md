# 第5章：Coding Agent 与代码生成

> Agent 如何理解代码库、编写代码、运行测试

---

## 5.1 工作原理

### Coding Agent 的核心循环

Coding Agent 的工作流程是一个 **Agentic Loop（智能体循环）**：

```
用户："帮我实现一个搜索功能"
  │
  ▼
1. 理解意图 ──── LLM 分析用户需求
  │
  ▼
2. 探索代码 ──── 调用 read/glob/grep 工具理解现有代码结构
  │
  ▼
3. 制定计划 ──── LLM 生成实现方案（可能用 plan 模式）
  │
  ▼
4. 编写代码 ──── 调用 write/edit 工具创建/修改文件
  │
  ▼
5. 运行验证 ──── 调用 bash 工具运行测试/编译
  │
  ▼
6. 修复错误 ──── 如果有报错，读取错误信息，修改代码
  │
  ▼
7. 完成 ───────── 输出最终结果
```

### 行业主流做法

| 框架 | 核心策略 | 代码理解 |
|------|---------|---------|
| OpenAI Codex | Agentic loop + 工具调用 | 实时文件读取 |
| Cursor | 代码库预索引 + 语义检索 | AST 索引 |
| GitHub Copilot | 内联补全 + 上下文窗口 | 相邻文件 |
| Devin | 全自主 Agent + 终端 | 实时文件读取 |

---

## 5.2 我们的实现

### 5.2.1 代码理解

Agent 使用三种方式理解代码库：

#### 文件名搜索（glob）

```
LLM: "我需要找到所有的路由定义"
→ 调用 glob 工具: pattern="**/route*", glob="**/*.{ts,tsx}"
→ 返回匹配的文件路径列表
→ LLM 选择相关文件，调用 read 读取内容
```

#### 内容搜索（grep）

```
LLM: "我需要找到已有的搜索实现"
→ 调用 grep 工具: pattern="search", path="src/", type="ts"
→ 返回匹配的文件和行号
→ LLM 决定是否读取完整文件
```

#### 文件读取（read）

```typescript
// src/core/llm/tools/read.ts
// read 工具支持：
// 1. 读取完整文件
// 2. 按行号范围读取
// 3. 读取目录结构
```

### 5.2.2 代码编写

#### 创建新文件（write）

```typescript
// src/core/llm/tools/write.ts
// write 工具：
// - 如果文件不存在，直接创建
// - 如果文件存在，触发 onWriteConfirm 让用户对比 diff
// - 支持创建目录
```

#### 编辑已有文件（edit）

```typescript
// src/core/llm/tools/edit.ts
// edit 工具：
// - 接收 old_string 和 new_string
// - 精确匹配 old_string 并替换
// - 如果 old_string 不唯一，报错要求提供更多上下文
// - 支持 replace_all 选项
```

**关键设计**：`edit` 工具要求 `old_string` **精确匹配**，而不是行号。这比基于行号的编辑更健壮——即使文件在对话过程中被外部修改，只要目标字符串还在就能正确编辑。

### 5.2.3 运行验证

```typescript
// src/core/llm/tools/bash.ts
// bash 工具：
// - 在项目目录或 worktree 中执行命令
// - 支持 stdout/stderr 流式输出
// - 支持超时和取消
// - 支持 shell 类型自动检测（PowerShell/Bash）
```

### 5.2.4 Worktree 隔离

```typescript
// src/core/environment.ts
// Git worktree 模式：
// - 每个会话可以在独立的 git worktree 中工作
// - 修改不影响主分支
// - 支持分支创建和合并
```

---

## 5.3 代码生成的质量保障

### 5.3.1 写文件 diff 确认（S4）

当 Agent 要覆写已有文件时：

```
Agent: write("src/index.ts", newContent)
  │
  ▼
系统检测文件已存在
  │
  ▼
弹出 diff 对比弹窗
  ┌─────────────────────────┐
  │  旧代码 │ 新代码 │
  │  - line │ + line │
  │  - line │ + line │
  └─────────────────────────┘
  [接受]  [拒绝]  [修改指令]
  │
  ▼
用户选择 → 继续/停止/追加修改
```

### 5.3.2 权限控制

```
安全模式 = "ask"
  → 每次写文件都询问

安全模式 = "auto"
  → 读文件自动批准
  → 写文件仍需确认

安全模式 = "full"
  → 全部自动批准
```

### 5.3.3 上下文压缩后的恢复

当上下文压缩后，Agent 可能丢失之前的代码上下文。我们的恢复机制：

```typescript
// 压缩后重新注入已加载的技能 prompt
// src/core/llm/agentic-loop.ts
// "Also inject already-loaded skill prompts (for context recovery after compaction)"
```

---

## 5.4 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 代码理解 | 预索引 | 实时工具调用 | 零预处理，适应任何项目 |
| 编辑方式 | 行号/补丁 | 精确字符串匹配 | 健壮，不怕文件偏移 |
| 安全确认 | 无/简单的确认 | diff 对比 + 三层模式 | 防误操作 |
| 沙箱隔离 | Docker/容器 | Git worktree | 轻量，无需 Docker |
| 测试验证 | Agent 自主决定 | Agent 调用 bash | 灵活 |

### 我们的优势

1. **精确字符串编辑**：比行号编辑更健壮，不怕外部修改导致行号偏移
2. **diff 确认**：覆写前展示 diff，用户有最后一次审查机会
3. **worktree 隔离**：在 git worktree 中工作，不影响主分支
4. **上下文恢复**：压缩后自动恢复技能 prompt

### 我们的取舍

1. **无代码库预索引**：每次理解代码都需要实时 read/glob/grep，不如 Cursor 的 AST 索引高效
2. **无语义代码搜索**：只有正则和 glob 搜索，没有"找到类似的函数"能力
3. **无自动测试运行**：Agent 需要自己决定运行什么测试，不会自动检测测试框架

---

## 5.5 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/llm/tools/write.ts` | 文件写入 + diff 确认 |
| `src/core/llm/tools/edit.ts` | 精确字符串编辑 |
| `src/core/llm/tools/bash.ts` | 命令执行 |
| `src/core/llm/tools/read.ts` | 文件读取 |
| `src/core/environment.ts` | Worktree 创建和管理 |
| `src/core/permission/security-mode.ts` | 安全模式评估 |

---

## 小结

> 代码理解 = glob 搜文件名 + grep 搜内容 + read 读内容
> 代码编写 = write 创建（带 diff 确认）+ edit 精确替换
> 代码验证 = bash 执行测试/编译
> 质量保障 = diff 确认 + 三层权限 + worktree 隔离 + 上下文恢复
