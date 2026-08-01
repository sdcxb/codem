# Coding 功能改进待办

> 基于对标 Wecode-ref 的功能差距分析，逐项细化：架构影响、上下游关联、消息通信、展示逻辑、自动响应、逻辑闭合、潜在隐患、工作量估算

---

## P0-1：内置终端（xterm.js + Tauri PTY）

### 架构影响

```
新增层级：
┌──────────────────────────────────────────────────────┐
│ React 层                                              │
│  ├── TerminalPanel.tsx (xterm.js 渲染 + 输入)         │
│  ├── useTerminalSession.ts (会话管理 Hook)            │
│  └── store.ts 新增 terminalSessions 状态              │
├──────────────────────────────────────────────────────┤
│ Tauri IPC 层                                          │
│  ├── spawn_pty(cwd, env) → ptyId                      │
│  ├── write_pty(ptyId, data)                           │
│  ├── resize_pty(ptyId, cols, rows)                    │
│  ├── close_pty(ptyId)                                 │
│  └── 事件: pty-output(ptyId, data) → 前端监听        │
├──────────────────────────────────────────────────────┤
│ Rust 层                                               │
│  ├── PtyManager (HashMap<PtyId, PtySession>)          │
│  ├── PtySession { master: MasterPty, child: Child }  │
│  └── 输出读取线程 → emit("pty-output", ...)           │
└──────────────────────────────────────────────────────┘

新增依赖：
  Rust: portable-pty = "0.8"
  npm:  @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

### 上下游关联

```
上游（被谁调用）：
  ├── App.tsx 布局层 → PanelSidebar 新增 "终端" Tab
  ├── InputArea.tsx → 用户可从输入区打开终端
  └── ChatPanel.tsx → Agent 执行 bash 工具时，可选在终端面板显示输出

下游（调用谁）：
  ├── Rust lib.rs → spawn_pty/write_pty/resize_pty/close_pty
  ├── store.ts → terminalSessions 状态管理
  ├── PanelSidebar.tsx → 新增 "terminal" Tab
  └── FileTreePanel.tsx (P0-3) → 终端 CWD 变化时同步文件树路径
```

### 消息通信传递

```
用户输入 → xterm.js onData → invoke("write_pty", {id, data})
  → Rust 写入 PTY master → shell 处理
  → PTY 输出 → Rust 读取线程 → emit("pty-output", {id, data})
  → 前端 listen("pty-output") → xterm.write(data)

窗口 resize → xterm resize 事件 → invoke("resize_pty", {id, cols, rows})
  → Rust portable_pty resize → 内部进程收到 SIGWINCH

用户关闭终端面板 → useEffect cleanup → invoke("close_pty", {id})
  → Rust kill child + close master → 释放资源

Agent bash 工具执行（可选联动）：
  → agentic-loop emit "tool_start" (name=bash)
  → TerminalPanel 可选: 在终端中显示 "Agent 正在执行: {command}"
  → 工具执行完成后 emit "tool_end"
  → 终端不直接执行 Agent 的命令（Agent 用 execute_command 独立执行）
  → 但可以显示通知: "[Agent] 已执行: npm install (退出码 0)"
```

### 展示逻辑

```
PanelSidebar 布局变化：
  现有: [Git] [工作台] [✕]
  改后: [文件] [Git] [终端] [工作台] [✕]

终端面板内容：
  ├── 终端标签栏（多会话切换）
  │   ├── Tab 1: PowerShell (~/project)
  │   ├── Tab 2: PowerShell (~/project/src)
  │   └── + 新建终端
  ├── xterm.js 终端区域（填充剩余空间）
  └── 底部状态栏: 当前 CWD | shell 类型 | 连接状态

CSS 变量适配：
  --terminal-bg: var(--bg-primary)
  --terminal-fg: var(--text-primary)
  --terminal-cursor: var(--accent)
  梦幻皮肤: backdrop-filter + 毛玻璃
```

### 自动响应机制

```
1. 会话 TTL 自动清理
   → 30 分钟无输入 → close_pty → 释放资源 → UI 标记 "会话已过期"

2. CWD 同步
   → 终端 CWD 变化（通过 OSC 7/51 序列或定时 pwd 探测）
   → emit("pty-cwd-changed", {id, cwd})
   → FileTreePanel 监听 → 自动切换到新路径

3. Agent 命令输出联动（可选）
   → Agent 执行 bash → 工具结果 → 如果用户终端打开
   → 在终端中插入 "[Agent] {command}\n{output_preview}\n"
   → 让用户看到 Agent 在做什么

4. 进程退出检测
   → PTY child exit → emit("pty-exited", {id, exitCode})
   → UI 显示 "[进程已退出，退出码 N]"
   → 提供 "重新打开" 按钮
```

### 逻辑闭合

```
完整生命周期：
  用户点击 "终端" Tab → 新建会话 → spawn_pty → I/O 流式传输
  → 用户输入命令 → 输出实时显示 → resize 自适应
  → 用户关闭 Tab / 会话超时 / 应用退出 → close_pty → 资源释放
  → 无 PTY 泄漏（useEffect cleanup + TTL + 应用退出钩子）
```

### 潜在隐患与规避

| 隐患 | 规避方案 |
|------|---------|
| Windows ConPTY 最低版本 1809 | 运行时检测，不支持时 fallback 到 `execute_command` 单次模式 |
| xterm.js 包体积 +200KB | 动态 import，仅在用户点击终端 Tab 时加载 |
| PTY 资源泄漏 | 三重清理：useEffect cleanup + 30min TTL + 应用退出钩子 |
| 编码问题（GBK 输出） | Rust 端 PTY 读取用 `from_utf8_lossy`，复用现有编码安全体系 |
| 用户执行危险命令 | 与外部终端同等风险，不做限制（用户自主决策） |
| 多终端内存占用 | 限制最多 5 个并发会话，超出时拒绝新建 |
| PTY 输出洪泛 | Rust 端 64KB 缓冲，溢出时丢弃旧数据 + 提示 |

### 影响文件清单

| 文件 | 修改类型 |
|------|---------|
| `src-tauri/Cargo.toml` | 新增 `portable-pty` 依赖 |
| `src-tauri/src/lib.rs` | 新增 PTY 管理：spawn/write/resize/close + 输出线程 |
| `src-tauri/capabilities/default.json` | 新增 PTY 相关权限 |
| `src/components/TerminalPanel.tsx` | **新建** xterm.js 终端渲染 |
| `src/components/PanelSidebar.tsx` | 新增 "终端" Tab |
| `src/hooks/useTerminalSession.ts` | **新建** 终端会话管理 Hook |
| `src/core/store.ts` | 新增 `terminalSessions` 状态 |
| `src/styles.css` | 终端样式 + 皮肤适配 |
| `src/styles/skin-dream.css` | 梦幻皮肤终端磨砂 |
| `src/App.tsx` | 布局：PanelSidebar 新增终端 Tab 传入 |
| `package.json` | 新增 xterm 依赖 |

### 工作量估算

| 子任务 | 人天 |
|--------|------|
| Rust PTY 管理（spawn/write/resize/close + 输出线程） | 2 |
| 前端 xterm.js 集成 + TerminalPanel 组件 | 2 |
| 多会话管理 + TTL 清理 | 1 |
| PanelSidebar 集成 + 布局适配 | 0.5 |
| CSS + 皮肤适配 | 0.5 |
| 联动（CWD 同步 + Agent 输出通知） | 1 |
| 测试 + 调试 | 1 |
| **合计** | **8 人天** |

---

## P0-2：文件变更追踪（TurnFileChangeTracker）

### 架构影响

```
新增层级：
┌──────────────────────────────────────────────────────┐
│ React 层                                              │
│  └── FileChangesPanel.tsx (展示 + 回滚)               │
├──────────────────────────────────────────────────────┤
│ 核心层                                                │
│  ├── file-change-tracker.ts (追踪器)                  │
│  │   ├── start(workspace) → beforeTreeId             │
│  │   ├── finalize() → patch + changedFiles + snapshot│
│  │   └── revert(turnId) → 应用反向补丁               │
│  └── storage/file-change-storage.ts (SQLite 持久化)  │
├──────────────────────────────────────────────────────┤
│ Agentic Loop 集成点                                   │
│  ├── process() 开头 → tracker.start()                │
│  ├── 每次 tool.execute() 后 → 检查是否写操作          │
│  └── process() 结尾 → tracker.finalize() → 存 DB     │
├──────────────────────────────────────────────────────┤
│ SQLite 新增表                                         │
│  └── turn_file_changes (见下方 DDL)                   │
└──────────────────────────────────────────────────────┘
```

### SQLite 表结构

```sql
CREATE TABLE IF NOT EXISTS turn_file_changes (
  id TEXT PRIMARY KEY,                  -- UUID
  session_id TEXT NOT NULL,            -- 会话 ID
  message_id TEXT NOT NULL,             -- 对应的 assistant 消息 ID
  turn_index INTEGER NOT NULL,          -- 第几轮
  before_tree TEXT,                     -- git tree ID (执行前)
  after_tree TEXT,                      -- git tree ID (执行后)
  patch TEXT,                           -- git diff --binary 补丁
  changed_files TEXT,                   -- JSON: [{path, status, before_path, after_path}]
  patch_sha256 TEXT,                    -- 补丁 SHA256 校验
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 上下游关联

```
上游（数据来源）：
  ├── AgenticLoop.process() → 在轮次边界调用 start/finalize
  ├── worktree-manager.ts → 复用 git 命令执行能力
  └── execute_command → 执行 git rev-parse/diff 命令

下游（数据消费）：
  ├── FileChangesPanel.tsx (P1-4) → 展示变更列表 + Diff
  ├── FileTreePanel.tsx (P0-3) → 监听变更 → 刷新文件树 Git 状态
  ├── AutoCommitService (P1-5) → finalize 后触发自动提交
  └── Compaction → 压缩时保留 turn_file_changes 记录（不删除）
```

### 消息通信传递

```
Agent 轮次开始：
  → AgenticLoop.process() 调用 tracker.start(workspace)
  → execute_command("git rev-parse HEAD^{tree}") → beforeTreeId
  → 存入 tracker 内部状态

Agent 执行工具（edit/write/bash）：
  → 正常执行，无追踪器介入
  → 工具执行完成后 emit "tool_end" 事件
  → （可选）FileChangesPanel 实时刷新（显示 "Agent 正在修改..."）

Agent 轮次结束：
  → tracker.finalize()
  → execute_command("git rev-parse HEAD^{tree}") → afterTreeId
  → execute_command("git diff --binary --name-status beforeTreeId afterTreeId")
  → 解析变更文件列表
  → 对每个变更文件：读取 before/after 内容（从 git show 获取）
  → 生成完整 patch
  → SHA256(patch)
  → file-change-storage.create({sessionId, messageId, ...})
  → emit("file_changes_tracked", {turnIndex, changedFiles})
  → FileChangesPanel 监听 → 刷新 UI

用户点击回滚：
  → FileChangesPanel → invoke tracker.revert(turnId)
  → 从 DB 读取 patch
  → execute_command("git apply --reverse patch")
  → 验证: git rev-parse HEAD^{tree} 应等于 beforeTreeId
  → emit("file_changes_reverted", {turnId})
  → FileTreePanel 刷新
```

### 展示逻辑

```
FileChangesPanel（在 PanelSidebar "变更" Tab 中）：

  ┌────────────────────────────────────┐
  │ 📋 变更历史                         │
  ├────────────────────────────────────┤
  │ ▸ Turn 3: "修改了用户认证逻辑"      │  ← 可展开
  │   📄 auth/login.ts   [M]  +12 -3   │  ← 文件级
  │   📄 auth/token.ts   [A]  +45       │
  │   [查看 Diff] [回滚此轮]            │
  ├────────────────────────────────────┤
  │ ▸ Turn 2: "新增 API 路由"           │
  │   📄 routes/api.ts   [A]  +89       │
  │   [查看 Diff] [回滚此轮]            │
  ├────────────────────────────────────┤
  │ ▸ Turn 1: "初始化项目结构"           │
  │   📄 package.json   [M]  +5         │
  │   [查看 Diff] [回滚此轮]            │
  └────────────────────────────────────┘

点击 [查看 Diff] → 展开内联 Diff 视图：
  ┌────────────────────────────────────┐
  │ auth/login.ts  Before → After       │
  ├────────────────────────────────────┤
  │   function login(user) {           │  旧（灰）
  │ -   if (!user) return null;        │  删（红 -）
  │ +   if (!user?.id) return null;     │  增（绿 +）
  │     return token;                  │  不变
  └────────────────────────────────────┘
```

### 自动响应机制

```
1. 变更通知
   → tracker.finalize() 后 emit "file_changes_tracked"
   → ChatPanel 监听 → 在消息流中插入 "[文件变更: 2 个文件已修改]"
   → 用户可点击展开查看

2. 关键文件保护
   → finalize() 检查变更文件列表
   → 如果包含 .env / package.json / Cargo.toml 等关键文件
   → emit "critical_file_changed" → 弹窗确认

3. 自动回滚检测
   → 如果 Agent 在后续轮次中撤销了自己的修改
   → 检测到反向 patch → 标记为 "已自动回滚"

4. 压缩感知
   → compaction 不删除 turn_file_changes 记录
   → 压缩后仍可查看历史变更和回滚
```

### 逻辑闭合

```
完整生命周期：
  Agent 轮次开始 → start() 捕获 beforeTree
  → Agent 执行工具 → （中间不介入）
  → 轮次结束 → finalize() 捕获 afterTree + diff + 快照
  → 存入 SQLite → emit 事件 → UI 刷新
  → 用户查看变更 → 展开文件 → 查看 Diff
  → 用户回滚 → 应用反向 patch → 刷新文件树
  → 压缩后仍可访问历史变更
  → 非 git 工作区 → 优雅降级（不追踪，不报错）
```

### 潜在隐患与规避

| 隐患 | 规避方案 |
|------|---------|
| 非 Git 工作区无法追踪 | `start()` 检测 `isGitRepo()`，返回 false 则跳过追踪，UI 显示 "需要 Git 仓库" |
| 大 diff 撑爆存储 | patch 超过 500KB 截断 + 标记 "truncated"；超 2MB 只存文件列表不存 patch |
| 二进制文件 diff 无意义 | 检测 `git diff --numstat` 中 `-\t-\t` 标记二进制，只存路径不存内容 |
| Agent 执行 git commit 导致 tree 跳跃 | `start()` 时记录 HEAD commit，`finalize()` 时用 commit SHA 而非 tree SHA |
| 并发编辑冲突 | finalize 时检测 afterTree 与当前 HEAD 是否一致，不一致则标记 "检测到外部修改" |
| 回滚破坏后续轮次 | 回滚时检查后续是否有更新轮次，有则警告 "回滚可能影响后续修改" |

### 影响文件清单

| 文件 | 修改类型 |
|------|---------|
| `src/core/environment/file-change-tracker.ts` | **新建** 追踪器 |
| `src/core/storage/file-change-storage.ts` | **新建** SQLite CRUD |
| `src/core/storage/database.ts` | 新增 `turn_file_changes` 表 DDL |
| `src/core/llm/agentic-loop.ts` | 在 `process()` 头尾插入 start/finalize 调用 |
| `src/core/llm/index.ts` | `process()` 传入 tracker 实例 |
| `src/components/FileChangesPanel.tsx` | **新建** 变更展示面板 |
| `src/components/PanelSidebar.tsx` | 新增 "变更" Tab |
| `src/components/ChatPanel.tsx` | 监听 `file_changes_tracked` 事件 |
| `src/styles.css` | Diff 视图样式 |

### 工作量估算

| 子任务 | 人天 |
|--------|------|
| FileChangeTracker 核心逻辑（start/finalize/revert） | 2 |
| SQLite 持久化 + 表结构 | 1 |
| Agentic Loop 集成（start/finalize 钩子） | 1 |
| FileChangesPanel UI（列表 + Diff 渲染 + 回滚） | 3 |
| PanelSidebar 集成 | 0.5 |
| ChatPanel 变更通知集成 | 0.5 |
| 非 Git 降级 + 边缘情况处理 | 1 |
| 测试 | 1 |
| **合计** | **10 人天** |

---

## P0-3：文件树浏览器

### 架构影响

```
新增层级：
┌──────────────────────────────────────────────────────┐
│ React 层                                              │
│  ├── FileTreePanel.tsx (树渲染 + 交互)                │
│  └── useFileTree.ts (目录加载 + 缓存 Hook)            │
├──────────────────────────────────────────────────────┤
│ Tauri IPC 层                                          │
│  └── list_directory(path) → 目录树 JSON               │
│      （复用 tauri-plugin-fs 的 read_dir）              │
├──────────────────────────────────────────────────────┤
│ Git 状态集成                                          │
│  └── git status --porcelain → Map<path, status>      │
└──────────────────────────────────────────────────────┘
```

### 上下游关联

```
上游：
  ├── PanelSidebar → 新增 "文件" Tab → FileTreePanel
  ├── tauri-plugin-fs → 目录读取
  └── file-change-tracker (P0-2) → 变更事件 → 刷新树

下游：
  ├── TerminalPanel (P0-1) → CWD 同步 → 定位到新目录
  ├── ChatPanel → 用户点击文件 → 填充输入框 "读取这个文件"
  └── FileChangesPanel (P1-4) → 点击变更文件 → 定位到树中
```

### 消息通信传递

```
面板加载：
  → FileTreePanel mounts
  → invoke("list_directory", {path: workspace})
  → Rust 读取目录 → 返回 {name, path, isDir, size}[]
  → 前端渲染树节点
  → 同时调用 execute_command("git status --porcelain") → git 状态 Map
  → 合并状态 → 渲染 M/A/U 标记

展开目录：
  → 用户点击文件夹 → 展开
  → invoke("list_directory", {path: subfolder})
  → 懒加载子节点

Agent 修改文件后：
  → file-change-tracker emit "file_changes_tracked"
  → FileTreePanel 监听
  → 对变更文件所在目录 → 重新 list_directory
  → 重新执行 git status → 更新状态标记
  → 变更文件高亮闪烁 2 秒

用户点击文件：
  → invoke("read_file", {path: filePath})
  → 内容预览（底部预览面板 或 右侧预览区）
  → 或填充输入框: "读取 ${filePath}"
```

### 展示逻辑

```
PanelSidebar 新增 "文件" Tab：
  [文件] [Git] [终端] [工作台] [✕]

FileTreePanel 布局：
  ┌────────────────────────────────────┐
  │ 📁 src/                             │  ← 可折叠
  │   📁 components/                   │
  │     📄 ChatPanel.tsx    [M]        │  ← Git 修改标记
  │     📄 InputArea.tsx                │
  │   📁 core/                         │
  │     📁 llm/                        │
  │     📄 store.ts          [U]       │  ← 未跟踪
  │ 📁 docs/                           │
  │ 📄 package.json          [M]        │
  │ 📄 tauri.conf.json                 │
  └────────────────────────────────────┘

状态标记：
  [M] 修改 (橙色)
  [A] 新增 (绿色)
  [U] 未跟踪 (蓝色)
  [D] 删除 (红色，灰色文字)

交互：
  单击文件夹 → 展开/折叠
  双击文件 → 预览内容
  右键文件 → 菜单: [读取] [编辑] [在终端打开] [复制路径]
```

### 自动响应机制

```
1. Agent 文件操作后自动刷新
   → file-change-tracker emit "file_changes_tracked"
   → FileTreePanel → 刷新变更文件所在目录
   → 变更文件高亮闪烁

2. 终端 CWD 同步
   → TerminalPanel emit "pty-cwd-changed"
   → FileTreePanel → 自动展开到 CWD 对应路径

3. 大目录排除
   → list_directory 过滤: node_modules, .git, target, dist, __pycache__
   → 显示 "已隐藏 N 个目录" 提示（可展开查看）
```

### 逻辑闭合

```
完整生命周期：
  用户点击 "文件" Tab → 加载根目录 → 渲染树
  → 用户展开/折叠 → 懒加载子目录
  → Git 状态覆盖 → 显示 M/A/U 标记
  → Agent 修改文件 → 自动刷新 + 高亮
  → 用户点击文件 → 预览或填充输入框
  → 终端 CWD 变化 → 自动定位
  → 大目录过滤 → 性能保护
```

### 潜在隐患与规避

| 隐患 | 规避方案 |
|------|---------|
| 超大目录（node_modules 10万+文件） | 过滤规则 + 懒加载 + 不递归进入排除目录 |
| 文件监听性能 | 不用 native watcher，改用事件驱动刷新（Agent 变更后刷新） |
| 非 UTF-8 文件名 | Rust 端 `to_string_lossy` 容错 |
| 权限不足目录 | `list_directory` 捕获错误 → 显示 "无权限" |
| 树状态丢失（切换 Tab 后折叠状态重置） | 用 Map<path, expanded> 持久化展开状态到组件 state |

### 影响文件清单

| 文件 | 修改类型 |
|------|---------|
| `src/components/FileTreePanel.tsx` | **新建** 文件树组件 |
| `src/hooks/useFileTree.ts` | **新建** 目录加载 + 缓存 Hook |
| `src/components/PanelSidebar.tsx` | 新增 "文件" Tab |
| `src-tauri/src/lib.rs` | 新增 `list_directory` 命令（或复用 tauri-plugin-fs） |
| `src/styles.css` | 文件树样式 + Git 状态标记 |

### 工作量估算

| 子任务 | 人天 |
|--------|------|
| Rust list_directory 命令 | 0.5 |
| FileTreePanel 组件（树渲染 + 懒加载 + Git 状态） | 3 |
| useFileTree Hook | 1 |
| PanelSidebar 集成 | 0.5 |
| 事件联动（变更刷新 + CWD 同步） | 1 |
| CSS 样式 + 皮肤适配 | 0.5 |
| 测试 | 0.5 |
| **合计** | **7 人天** |

---

## P1-4：文件变更 Diff 面板

### 架构影响

依赖 P0-2（TurnFileChangeTracker）提供数据。

### 上下游关联

```
上游：
  └── file-change-storage.ts → 读取 turn_file_changes 表

下游：
  └── FileTreePanel → 回滚后刷新
```

### 消息通信

```
用户打开 "变更" Tab：
  → FileChangesPanel 加载 → 读取 file-change-storage
  → 按 turn_index 倒序展示

用户点击 "查看 Diff"：
  → 从记录中取出 patch → 解析为行级 diff
  → 渲染 before/after 对比视图

用户点击 "回滚此轮"：
  → tracker.revert(turnId)
  → git apply --reverse patch
  → emit "file_changes_reverted"
  → FileTreePanel 刷新
  → FileChangesPanel 标记该轮为 "已回滚"
```

### 工作量估算：**4 人天**（Diff 渲染 2 + 回滚逻辑 1 + UI 1）

---

## P1-5：自动 Git Commit Message

### 架构影响

```
新增：
  src/core/environment/git-commit-service.ts
  ├── generateCommitMessage(workspace) → string
  │   ├── git status --short → 变更概览
  │   ├── git diff --cached --stat → 统计
  │   ├── git diff --cached -- → 完整 diff（截断 50KB）
  │   └── 调用 LLM（subagent slot, temp=0.3）→ commit message
  └── autoCommit(workspace) → 执行 git add -A + git commit
```

### 上下游关联

```
上游：
  ├── file-change-tracker (P0-2) → finalize() 后触发
  └── LLM Engine → 调用 subagent slot 生成 message

下游：
  ├── git 命令执行 → git add + git commit
  ├── emit("auto_committed", {message}) → UI 通知
  └── FileTreePanel → 刷新 Git 状态（M 标记消失）
```

### 消息通信

```
Agent 轮次结束：
  → tracker.finalize() → 有变更
  → 如果 autoCommitEnabled:
    → gitCommitService.generateCommitMessage(workspace)
      → git status --short → " M src/index.ts\n?? new-file.ts"
      → git diff --cached --stat → "1 file changed, 10 insertions(+)"
      → git diff --cached -- → "+function foo() { ... }"
      → LLM(subagent slot) → "feat: 添加 foo 函数用于..."
    → gitCommitService.autoCommit(workspace, message)
      → git add -A
      → git commit -m "feat: 添加 foo 函数用于..."
    → emit("auto_committed", {message, filesChanged})
    → ChatPanel 显示: "✅ 已自动提交: feat: 添加 foo 函数..."
    → FileTreePanel → 刷新 Git 状态
```

### 工作量估算：**3 人天**（LLM 调用 1 + git 集成 1 + UI 通知 + 设置开关 1）

---

## P1-6：Transcript 缓存

### 架构影响

```
新增：
  src/core/storage/transcript-cache.ts
  ├── TranscriptCache 类
  │   ├── get(sessionId) → CachedTranscript | null
  │   ├── set(sessionId, messages, signature)
  │   ├── invalidate(sessionId)
  │   └── TTL 自动过期
  └── 文件签名: {dbSize, dbModified} → 检测 DB 是否被外部修改
```

### 消息通信

```
AgenticLoop.convertMessagesToLLM():
  → 先查 transcriptCache.get(sessionId)
  → 如果缓存命中 且 签名匹配 → 直接用缓存（跳过 DB 查询）
  → 如果未命中 → 从 DB 加载 → 存入缓存
  → DB 写入新消息后 → transcriptCache.invalidate(sessionId)
```

### 工作量估算：**2 人天**（缓存逻辑 1 + 集成 agentic-loop 0.5 + 测试 0.5）

---

## P2-7：浏览器面板（前端预览）

### 架构影响

```
方案：Tauri WebView 窗口（非 xterm.js）
  ├── 新建 Tauri 窗口: url = "http://localhost:5173"（或用户指定）
  ├── 前端面板控制: 启动/停止/刷新/导航
  └── Agent 工具: browser_navigate/browser_screenshot（MCP）
```

### 工作量估算：**5 人天**（窗口管理 2 + 面板控制 1 + MCP 工具 2）

---

## P2-8：多 Agent 引擎切换

### 架构影响

```
方案：集成 Claude Code CLI（类似 Wecode-ref 的 AgentKind 枚举）
  ├── src/core/llm/agent-kind.ts → AgentKind 枚举
  ├── src/core/llm/engines/claude-code-engine.ts
  ├── src/core/llm/engines/codex-engine.ts
  └── 现有 engine → 重命名为 mimo-engine.ts
```

### 工作量估算：**15 人天**（CLI 集成 5 + 协议适配 5 + UI 切换 3 + 测试 2）

---

## 总工作量汇总

| 优先级 | 功能 | 人天 | 影响 |
|--------|------|------|------|
| **P0** | 内置终端 | 8 | 🔴 关键 |
| **P0** | 文件变更追踪 | 10 | 🔴 关键 |
| **P0** | 文件树浏览器 | 7 | 🔴 关键 |
| **P1** | Diff 面板 | 4 | 🟡 重要 |
| **P1** | 自动 Commit | 3 | 🟡 重要 |
| **P1** | Transcript 缓存 | 2 | 🟡 优化 |
| **P2** | 浏览器面板 | 5 | 🔵 增强 |
| **P2** | 多引擎切换 | 15 | 🔵 增强 |
| | **合计** | **54 人天** | |

### 建议实施顺序

```
阶段1（P0，25 人天）:
  ① 文件变更追踪 (10d) — 无 UI 依赖，先做核心
  ② 文件树浏览器 (7d) — 依赖①的变更事件
  ③ 内置终端 (8d) — 独立，可与①②并行

阶段2（P1，9 人天）:
  ④ Diff 面板 (4d) — 依赖①的数据
  ⑤ 自动 Commit (3d) — 依赖①的 finalize 钩子
  ⑥ Transcript 缓存 (2d) — 独立优化

阶段3（P2，20 人天）:
  ⑦ 浏览器面板 (5d)
  ⑧ 多引擎切换 (15d)
```

### 全局风险

| 风险 | 规避 |
|------|------|
| PanelSidebar Tab 过多（6个） | 底部 Tab 改为图标 + tooltip，或可折叠 |
| 包体积膨胀 | xterm.js + diff 组件 动态 import |
| 性能（每轮 git 操作延迟） | git 命令并行化 + 超时 15s 降级 |
| 非 Git 工作区 | 所有 Git 相关功能优雅降级 |
