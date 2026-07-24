# v0.87.0 - Worktree 全链路 + 并行对话 + 自动化 + GitHub Clone + 侧边栏重构 + 全局字体

> 本次更新是 v0.86 后的大版本发布，涵盖 Git Worktree 全链路、并行对话隔离、自动任务系统、GitHub Clone、侧边栏布局重构、全局字体系统、Prompt Cache 优化等重大功能，涉及 49 个源文件，+6156/-520 行代码。

## 🎯 核心改进

### 一、Git Worktree 全链路

**核心库（`src/core/environment/`）：**
- 新增 `worktree-manager.ts`：完整的 Git Worktree 管理（create/remove/scan/limit），Windows PowerShell 兼容
- 新增 `environment-runner.ts`：环境运行器（setup/cleanup 脚本自动执行）
- `Session` 接口扩展：`worktreePath` / `executionMode` / `worktreeBranch` 字段

**全链路打通：**
- `App.tsx handleSend`：检查 `session.executionMode`，worktree 模式下自动创建 worktree 并用作 cwd
- `core/store.ts deleteSession`：删除会话时自动调用 `removeWorktreeSync` 清理 worktree
- `core/store.ts forkSession`：继承 executionMode，worktree 模式下创建独立 worktree
- `enforceMaxWorktrees`：LRU 清理，默认上限 15 个

**UI 集成：**
- `InputArea.tsx`：底部控制栏新增本地/工作树模式切换 + 分支选择器
- `GitInfoPanel.tsx`（新增 344 行）：分支/dirty/diff/commit/push/pull/worktree 监控面板
- `GitEnvSettings.tsx`（新增 419 行）：Git 环境配置（token/提交身份/脚本）
- `SettingsPanel.tsx`：新增 Worktree Tab（max=15、扫描、删除）

### 二、并行对话隔离

- `store.ts`：`activeSessions: Map<sessionId, boolean>` 替代单例 `isStreaming`
- `llm/index.ts`：`loopPool: Map<sessionId, AgenticLoop>` + `getAgenticLoop(agentId, sessionId)` + `cleanupSessionLoop`
- `App.tsx`：所有 Promise-based UI 改为 per-session Map（权限/写确认/提示词变更/交互式表单）
- `App.tsx`：`safeAddMessage`/`safeUpdateMessage` 配合 `isViewingSession` 守卫，实现 UI 隔离
- `ChatPanel.tsx`：使用 `activeSessions.has(currentSessionId)` 判断禁用状态

### 三、自动任务系统（Automation）

- 新增 `automation-manager.ts`（249 行）：定时器（timer）和文件监听（file_watch）两种触发器
- 配置 CRUD、start/fire/stop/stopAll、触发历史
- `SettingsPanel.tsx`：新增自动化 Tab，可视化配置触发器
- `App.tsx`：`handleSendRef` 每次渲染更新，自动化回调通过 `handleSendRef.current(message)` 触发

### 四、GitHub Clone 功能

- `ProjectManager.tsx`：新增"📥 从 GitHub 拉取"按钮，支持通过 git clone URL 直接拉取远程仓库并创建项目
- 四个操作按钮（新建项目/导入文件夹/新建 Git 项目/从 GitHub 拉取）改为 2×2 网格布局
- `GitHubCloneDialog.tsx`：三套皮肤均可用

### 五、侧边栏布局重构

- 设置按钮（⚙️）和搜索按钮（🔍）移至标题栏右侧，释放导航区域空间
- MCP/技能/记忆改为 iOS 风格分段控件（segmented control），紧凑三列布局
- 全局对话区域超过 3 条时内部滚动，保证项目展示空间
- 项目区域独立滚动，不再与全局对话共用滚动条
- 项目"更多操作"菜单改用 `createPortal` 渲染，不受 overflow 裁剪
- `SlashCommandMenu.tsx`（新增 124 行）：/ 命令菜单

### 六、全局字体系统

- 内置 Alimama 方圆体变量字体（`AlimamaFangYuanTiVF-Thin.ttf`，7.4MB）
- 设置 → 通用：新增"全局字体"下拉选择器
- 设置 → 外观：新增"字体粗细"滑块（100-900 连续字重），实时预览
- 支持 Inter、System Default、Courier New、Georgia 等多种字体
- CSS 变量 `--font-family` + `--font-weight` 驱动，零 JS 重渲染

### 七、其他改进

- **Prompt Cache 优化**：System Prompt 时间戳从毫秒精度降为分钟精度，同分钟内多次迭代 KV Cache 命中率大幅提升
- **分段控件主题适配**：MCP/技能/记忆区域使用 `color-mix` + `--accent` 主题色自适应，三套皮肤均有良好对比度
- **设置面板默认 Tab 修复**：点击设置按钮始终打开"通用"选项卡，不再残留上次打开的 Tab
- **梦幻皮肤磨砂弹窗**：所有弹窗组件（ConfirmDialog/PermissionDialog/PromptChangeReviewDialog/InteractiveFormDialog/SearchDialog/CloseConfirmDialog）改用 `createPortal` 渲染到 `document.body`，绕过 `backdrop-filter` containing block 问题
- **安全移除项目**：三按钮弹窗（移除/删除到回收站/取消），Rust 端 `delete_directory` 用 PowerShell `Microsoft.VisualBasic.FileIO.FileSystem`
- **选项目打开最新对话**：`InputArea.tsx handleSelectProject` 自动切换到最新会话
- **设置侧边栏分栏**：9 个 Tab（通用/外观/安全/Git/环境/Worktree/知识/自动化/多模态）

### 八、审计与测试

- `AUDIT-WORKTREE-PARALLEL.md`：自动化/并行/Worktree 全面审计，12 项隐患全部修复 ✅
- `REGRESSION-TEST-CASES.md`：58 组 236 步全覆盖回归测试用例
- `TEST-RESULTS.md`：测试结果 + 发现的 5 个问题已修复
- 新增 `codem-naming.test.ts`（443 行）和 `git-env-config.test.ts`（1147 行）测试
- **全部 1614 个测试通过**（36 个测试文件）
- TypeScript 编译零错误 + Rust cargo check 通过

## 📦 升级信息

- **版本**：0.86.0 → 0.87.0
- **新增依赖**：无（全部复用已有依赖）
- **新增文件**：`worktree-manager.ts`、`environment-runner.ts`、`automation-manager.ts`、`GitInfoPanel.tsx`、`GitEnvSettings.tsx`、`SlashCommandMenu.tsx`、`AlimamaFangYuanTiVF-Thin.ttf`
- **兼容性**：向后兼容
- **平台支持**：Windows 10/11

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 下载：https://github.com/sdcxb/codem/releases/tag/v0.87.0
