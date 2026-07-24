# Codem Git 项目与 Worktree 使用指南

> 适用于默认皮肤模式。涵盖：新建 Git 项目 → Worktree 工作流 → Push 到 GitHub。

---

## 一、新建 Git 项目

### 场景 A：从 GitHub 拉取已有项目 ✅ 已实现

适用于：GitHub 上已存在仓库，需要 clone 到本地。

**步骤：**

1. 打开左侧栏 → 点击项目名区域 → 打开**项目管理器**
2. 点击 **📂 导入文件夹** — 选择一个本地已有 git 仓库
3. 或通过 Hub 皮肤右侧栏 **"从 GitHub 拉取项目"** 紫色卡片：
   - 输入 GitHub 仓库 URL（如 `https://github.com/user/repo.git`）
   - 点击"拉取" → 自动 `git clone` 到用户目录 → 自动创建项目

### 场景 B：新建本地项目并初始化 Git ⚠️ 部分实现

适用于：从零开始新建项目，本地初始化 Git 仓库。

**当前状态**：项目管理器的"新建项目"会创建 `.codem` 目录和 `AGENTS.md`，但**不会**自动执行 `git init`。

**变通方案（当前可用）：**

1. 先在终端或文件管理器中创建空文件夹
2. 在该文件夹中执行 `git init`
3. 在 Codem 中：项目管理器 → 📂 导入文件夹 → 选择该文件夹
4. 此时底部控制栏会显示 🌿 分支（通常是 `main` 或 `master`），说明 Git 项目就绪

### 场景 C：新建项目并推送到 GitHub（GitHub 上尚无此仓库）❌ 未实现

适用于：新建一个本地项目，在 GitHub 上创建对应仓库，然后推送。

**当前状态**：应用没有"在 GitHub 创建新仓库"的功能。需要手动操作。

**变通方案（当前可用）：**

1. 在 GitHub 网页上手动创建空仓库（不勾选 README/.gitignore）
2. 在本地创建项目文件夹并 `git init`
3. `git remote add origin https://github.com/user/repo.git`
4. 在 Codem 中导入该项目
5. 使用右侧 GitInfoPanel 面板提交并推送

**实现建议**（如需后续开发）：

```
功能：在项目管理器"新建项目"流程中增加选项：
  ☑ 初始化 Git 仓库 (git init)
  ☑ 创建 GitHub 仓库并推送

实现方案：
1. ProjectManager 新建项目表单增加 checkbox："初始化 Git 仓库"
2. handleCreate() 中增加：
   await executeCommand(`git init`, newPath)
   await executeCommand(`git add -A`, newPath)
   await executeCommand(`git commit -m "Initial commit"`, newPath)
3. 如勾选"创建 GitHub 仓库"：
   a. 通过 GitHub API: POST https://api.github.com/user/repos
      需要 GitHub Token（存储在 codem-git-config 中）
   b. 获取返回的 clone URL
   c. git remote add origin <url>
   d. git push -u origin main
4. 复用已有的 Rust http_post 命令发送 API 请求
```

---

## 二、Worktree 工作树模式 ✅ 已实现

### 什么是 Worktree 模式

Git Worktree 允许在同一仓库下创建多个工作目录。每个 Worktree 是一个隔离的工作环境，有自己的分支和文件状态，互不干扰。

在 Codem 中，选择"新工作树"模式后，每次发送消息会自动在 `{项目}/.codem-worktrees/{sessionId}/` 目录创建一个隔离的工作环境。AI 的所有文件操作都在这个隔离目录中进行，不影响原始项目目录。

### 如何切换到 Worktree 模式

1. 确保当前项目是 **Git 仓库**（底部控制栏显示 🌿 分支名）
2. 在底部控制栏找到 🏠 "本地处理" 按钮
3. 点击右侧 ▾ 下拉箭头
4. 选择 🌲 **"新工作树"**
   - 如果项目不是 Git 仓库，此选项灰色禁用
   - 如果有未提交的修改，会弹出确认对话框

### 底部控制栏说明

```
┌─────────────────────────────────────────────────────────────────┐
│  📁 项目名 ▾  │  🏠 本地处理 ▾  │  🌿 main ▾  │  输入 / 选择技能  │
└─────────────────────────────────────────────────────────────────┘
```

| 控件 | 说明 |
|------|------|
| 📁 项目名 ▾ | 切换项目（下拉列表） |
| 🏠 本地处理 ▾ | 切换执行模式：🏠 本地处理 / 🌒 新工作树 |
| 🌿 main ▾ | 选择分支（仅 Git 项目显示，点击可切换分支） |

### 实际使用示例

#### 示例 1：并行修复两个 Bug

**场景**：你在 `main` 分支开发新功能，突然收到两个 Bug 报告。想同时修复两个 Bug 但互不干扰。

**操作步骤：**

1. **创建对话 A（修复 Bug #1）**
   - 新建对话 → 底部切换到 🌒 "新工作树"模式
   - 选择分支 `main`（从 main 分支创建 worktree）
   - 发送消息："修复登录页面的 CSS 样式问题"
   - AI 在隔离的 worktree 目录中工作，修改文件

2. **创建对话 B（修复 Bug #2）**
   - 新建另一个对话 → 同样切换到 🌒 "新工作树"模式
   - 选择分支 `main`
   - 发送消息："修复 API 响应解析的空指针异常"
   - AI 在另一个独立的 worktree 目录中工作

3. **两个对话并行运行**，互不影响：
   - 对话 A 的文件修改在 `.codem-worktrees/session-A/`
   - 对话 B 的文件修改在 `.codem-worktrees/session-B/`

4. **合并结果**：
   - 在对话 A 完成后，使用右侧 GitInfoPanel 提交
   - 在对话 B 完成后，同样提交
   - 两个 worktree 的修改可以分别推送到不同分支

#### 示例 2：安全地重构代码

**场景**：你想对核心模块做大重构，但不确定效果，想保留回退能力。

**操作步骤：**

1. 新建对话 → 切换到 🌒 "新工作树"模式
2. 选择分支 `main`
3. 发送消息："重构 `src/core/llm/provider.ts`，将 provider 逻辑拆分为独立模块"
4. AI 在隔离 worktree 中执行重构：
   - 原始项目目录完全不受影响
   - 可以随时在另一个对话中继续在原始目录工作
5. 重构完成后：
   - 右侧 GitInfoPanel 显示 🌿 分支状态和文件变更
   - 输入提交信息 → 点击"提交"
   - 点击 ⬆ 推送到远程
6. 如果重构不满意：
   - 直接删除该对话 → worktree 自动清理
   - 原始项目完全不受影响

#### 示例 3：在不同分支上并行开发

**场景**：需要同时在 `feature/auth` 和 `feature/payment` 两个分支上工作。

**操作步骤：**

1. **对话 A（认证功能）**
   - 新建对话 → 🌒 "新工作树"模式
   - 底部分支选择器选择 `feature/auth`（或输入新分支名）
   - 发送消息："实现 OAuth 登录流程"
   - AI 在 `feature/auth` 分支的 worktree 中工作

2. **对话 B（支付功能）**
   - 新建对话 → 🌒 "新工作树"模式
   - 底部分支选择器选择 `feature/payment`
   - 发送消息："实现支付网关集成"
   - AI 在 `feature/payment` 分支的 worktree 中工作

3. 两个对话可以同时运行，各自在不同分支上工作

---

## 三、提交与推送 to GitHub ✅ 已实现

### 使用 GitInfoPanel 面板

右侧栏（RightSidebar）包含 GitInfoPanel 面板，提供完整的 Git 操作能力。

**面板功能：**

```
┌─────────────────────────────────────┐
│  🌿 main  ✓ 干净                     │  ← 分支名 + 状态
│  📝 2 已暂存  ✏️ 1 已修改  ❓ 3 未跟踪 │  ← 文件统计
│  ┌─────────────────────────────┐    │
│  │ 提交信息...            [提交] │    │  ← 提交输入框
│  └─────────────────────────────┘    │
│  ⬆ 推送  ⬇ 拉取  🔄 刷新            │  ← 操作按钮
│  🌒 .codem-worktrees/session-xxx    │  ← Worktree 路径（如适用）
│  ▶ 最近提交 (3)                      │  ← 可展开的提交历史
└─────────────────────────────────────┘
```

**操作步骤：**

1. **查看状态**：面板自动每 10 秒刷新，显示当前分支、文件变更统计
2. **提交修改**：
   - 在输入框输入提交信息（如 "fix: 修复登录样式问题"）
   - 点击"提交"按钮 → 自动 `git add -A` + `git commit -m`
   - 或按 Enter 键快速提交
3. **推送到 GitHub**：
   - 点击 ⬆ 按钮 → 执行 `git push`
   - 如果推送成功，显示 ✅ 推送成功
   - 如果失败，显示 ❌ 和错误信息
4. **拉取更新**：
   - 点击 ⬇ 按钮 → 执行 `git pull`
5. **查看提交历史**：
   - 点击 ▶ 最近提交 → 展开最近 5 条提交记录
   - 显示 hash、提交信息、作者、时间

### Worktree 模式下的提交

当处于 Worktree 模式时，GitInfoPanel 会自动切换到 worktree 路径：

- 面板底部显示 🌒 worktree 路径
- 所有 git 操作（commit/push/pull）都在 worktree 目录执行
- 提交后推送到远程分支，与主分支独立

---

## 四、Worktree 管理 ✅ 已实现

### 查看所有 Worktree

1. 打开**设置**（左侧栏 ⚙️）
2. 选择 **Worktree** Tab
3. 显示所有 worktree 列表：
   - 每个 worktree 的路径、分支、创建时间
   - 是否有未提交修改（dirty 状态）
   - 可手动删除不需要的 worktree

### Worktree 自动清理

- **会话删除时**：自动删除关联的 worktree
- **数量超限时**：超过 15 个（可配置），自动 LRU 清理最旧的 worktree
- **dirty 检查**：有未提交修改的 worktree 不会被自动清理

### 设置 Worktree 参数

在设置 → Worktree Tab 中可配置：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 最大数量 | 15 | 超过此数量自动清理最旧的 |
| 自动清理 | 开启 | 自动删除超出限制的 worktree |
| dirty 警告 | 开启 | 有未提交修改时不自动清理 |

---

## 五、完整端到端示例

### 从零开始：新建项目 → Worktree 开发 → 推送

```
步骤 1：准备 Git 项目
   终端执行：
   mkdir my-project && cd my-project
   git init
   echo "# My Project" > README.md
   git add . && git commit -m "Initial commit"
   
   在 GitHub 创建空仓库 my-project
   git remote add origin https://github.com/user/my-project.git
   git push -u origin main

步骤 2：在 Codem 中导入
   项目管理器 → 📂 导入文件夹 → 选择 my-project
   底部控制栏显示 🌿 main → Git 项目就绪

步骤 3：切换 Worktree 模式
   底部控制栏 → 🏠 本地处理 ▾ → 🌒 新工作树
   底部显示 🌿 main → 从 main 分支创建 worktree

步骤 4：发送任务
   输入："创建一个 Express.js API 项目结构"
   AI 在隔离 worktree 中创建文件、修改代码

步骤 5：提交并推送
   右侧 GitInfoPanel → 输入 "feat: 初始化 Express 项目"
   → 点击"提交" → 点击 ⬆ 推送

步骤 6：完成
   删除对话 → worktree 自动清理
   或保留对话，下次打开时继续在 worktree 中工作
```

---

## 六、功能状态总结

| 功能 | 状态 | 入口位置 |
|------|------|---------|
| 导入已有 Git 项目 | ✅ | 项目管理器 → 📂 导入文件夹 |
| 从 GitHub Clone | ✅ | Hub 皮肤右侧栏 → 紫色卡片 |
| 新建本地项目 | ✅ | 项目管理器 → ➕ 新建项目 |
| 新建项目自动 git init | ❌ | 建议后续实现 |
| 在 GitHub 创建新仓库 | ❌ | 建议后续实现 |
| 切换 Worktree 模式 | ✅ | 底部控制栏 → 🏠 ▾ → 🌒 |
| 分支选择/切换 | ✅ | 底部控制栏 → 🌿 ▾ |
| Git 提交 | ✅ | 右侧 GitInfoPanel → 提交按钮 |
| Git 推送 | ✅ | 右侧 GitInfoPanel → ⬆ 按钮 |
| Git 拉取 | ✅ | 右侧 GitInfoPanel → ⬇ 按钮 |
| 查看提交历史 | ✅ | 右侧 GitInfoPanel → ▶ 最近提交 |
| Worktree 列表管理 | ✅ | 设置 → Worktree Tab |
| Worktree 自动清理 | ✅ | 删除对话时自动执行 |
| Git 偏好配置 | ✅ | 设置 → Git Tab |
| 环境脚本配置 | ✅ | 设置 → 环境 Tab |
