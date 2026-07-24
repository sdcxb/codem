# Codem 待办事项

> **开发计划主线文档**：`docs/DEV-PLAN-UNIFIED.md`（统一开发计划，包含架构约束、影响分析、完整路线图）
>
> 以下为具体待办事项跟踪。Phase 0-4 + Phase B-D + Phase F-G 已全部完成，v0.87 已发布。

## 待开发

### Phase B：工具/技能基础架构（1-2周）✅ 已完成

> 详见 `docs/DEV-PLAN-UNIFIED.md` 第四章 Phase B

- [x] **B1** SKILL.md 解析器增强 — 新增 provider/tools/mcpServers/version/author/tags/bindShells 等字段 (`skill.ts`)
- [x] **B2** SkillToolProvider 架构 — 技能携带工具的抽象层 (新增 `provider.ts`/`registry.ts`, `ToolRegistry.remove()`)
- [x] **B3** load_skill 懒加载工具 — LLM 按需加载技能 prompt + 会话级缓存 + TTL 自动卸载 (新增 `load-skill.ts`, agentic-loop 集成)
- [x] **B4** web_search 工具 — 支持 Tavily/通用 API 搜索引擎 (新增 `web-search.ts`, 设置面板配置)
- [x] **B5** read_attachment 工具 — 分页读取用户上传附件 (新增 `read-attachment.ts`)
- [x] **B6** mermaid-diagram 技能 — 内置技能 + MessageBubble Mermaid SVG 渲染 (新增 `MermaidDiagram` 组件, `mermaid` npm 依赖)

### Phase C：技能管理 UI（1周）✅ 已完成

> 详见 `docs/DEV-PLAN-UNIFIED.md` 第四章 Phase C

- [x] **C1** UI 组件基础设施 — Switch/Dialog/AlertDialog/Badge/Card/Progress (新增 `src/components/ui/`, 安装 `@radix-ui/react-switch`/`react-dialog`/`react-alert-dialog`/`fflate`)
- [x] **C2** 技能上传/安装 — ZIP 拖拽上传+fflate 解压+安全检查+覆盖确认 (新增 `installer.ts`, 重构 `SkillManager.tsx`)
- [x] **C3** 技能启用/禁用 — Switch 开关+SQLite 持久化+`buildSkillPrompt` 过滤禁用技能
- [x] **C4** 技能删除+搜索 — AlertDialog 二次确认+搜索框+标签/别名搜索+来源 Badge
- [x] **C5** MCP 管理改进 — 编辑服务器(Dialog)+JSON 导入+删除确认+`updateServer()` 方法
- [x] **C6** 管理界面图标替换 — SkillManager/McpManager 全面使用 `lucide-react` 图标 (聊天内 Emoji 保留)

### Phase D：高级技能（2-3周）✅ 已完成

> 详见 `docs/DEV-PLAN-UNIFIED.md` 第四章 Phase D

- [x] **D1** conversation_to_prompt 技能 — 对话转可复用提示词 (纯 prompt 技能 + SKILL.md + 内置注册)
- [x] **D2** prompt-optimization 技能 — 查看/修改系统提示词 (`PromptOptimizationProvider` + `get_system_prompt`/`submit_prompt_changes` 工具 + `PromptChangeReviewDialog` UI + App 全链路接线)
- [x] **D3** interactive 表单技能 — 交互式数据收集 (`InteractiveFormProvider` + `interactive_form_question` 工具 + `InteractiveFormDialog` UI + App 全链路接线)
- [x] **D4** skill-creator 技能 — 创建/改进/评估技能 (SKILL.md + `references/schemas.md` + `agents/{grader,analyzer,comparator}.md` + `scripts/{run-eval,aggregate-benchmark,quick-validate,package-skill,generate-review}.ts`)

### 技能市场（B+C 方案：Rust HTTP 代理）✅ 已完成

> 详见 `docs/DEV-PLAN-UNIFIED.md` 第 8.5 节

- [x] **M1** Rust 层 HTTP 代理命令 — `http_get` + `http_download` Tauri command（复用 `reqwest` 依赖，绕过 CSP）
- [x] **M2** 前端市场客户端 — `skill-market-client.ts`：搜索/下载/安装逻辑 + 4个默认市场源（Anthropic Skills / GitHub Agent Skills / GitHub SKILL.md Repos / Codem 内置）
- [x] **M3** SkillManager 市场标签页 — 新增「技能市场」Tab + 卡片网格 UI + 搜索/筛选/安装/详情对话框
- [x] **M4** 编译验证 + 生产构建 — TypeScript 零错误 + Rust `cargo check` 通过 + `npm run build` 成功

### Phase F：笔记本式知识管理（NotebookLM 模式，3-4周）✅ 已完成（2026-07-16）

> 详见 `docs/DEV-PLAN-UNIFIED.md` 第四章 Phase F
> 对标 Google NotebookLM：笔记本→上传来源→知识化处理→笔记本内问答
> 全部使用本地 SQLite + 已有 Embedding API，不破坏一键安装

- [x] **F1** 数据模型 — SQLite 新增 notebooks/notebook_sources/notebook_chunks 三张表 (`database.ts` SCHEMA 扩展, 新增 `knowledge/storage.ts`)
- [x] **F2** 文本提取与分块引擎 — 文件/文本/URL→纯文本提取 + 段落+句子分块+重叠窗口 (新增 `extractor.ts`/`chunker.ts`)
- [x] **F3** Embedding 索引管道 — 提取→分块→批量 Embedding→SQLite BLOB 存储 + 进度回调 (新增 `indexer.ts`)
- [x] **F4** 语义检索引擎 — query embedding + cosineSimilarity 排序 + top-K + 来源标注 (新增 `retriever.ts`)
- [x] **F5** 笔记本对话集成 — 系统 prompt 注入知识范围 + 自动检索 + `search_notebook` 工具 + 来源引用渲染 (修改 `prompt.ts`/`agentic-loop.ts`/`tools.ts`, 新增 `search-notebook.ts`)
- [x] **F6** 笔记本管理 UI — 侧边栏笔记本分区 + 笔记本详情(来源管理+对话+摘要+建议问题) (新增 `NotebookManager.tsx`/`NotebookDetail.tsx`/`NotebookChat.tsx`)
- [x] **F7** PDF 文本提取 — `pdf-extractor.ts` (纯 TypeScript，零依赖，支持 FlateDecode 解压)
- [x] **F8** 笔记本设置与配置 — Embedding/分块/检索参数配置 (修改 `SettingsPanel.tsx`)

### Phase E：Work 模式拆分（远期，2-3周）⏳ 待开始

> 前提：Phase B-D 全部完成

- [ ] **E1** 模式切换器（UI 顶层 Codex/Work 切换）
- [ ] **E2** Work 系统提示词（调研/文档导向）
- [ ] **E3** Work 工具集（Web 搜索/文档生成/信息整理）
- [ ] **E4** 项目制上下文（对话+文件+指令绑定）
- [ ] **E5** 计划任务（定时/触发/监控）
- [ ] **E6** 人机协作迭代（中途暂停/审查/调整）
- [ ] **E7** 用量池共享

### MSI 安装包中文向导
- [ ] 在 `tauri.conf.json` 的 `bundle.windows.wix` 中配置 WiX 多语言（zh-CN + en-US）
- [ ] 重新构建 MSI 安装包，确认安装向导界面支持中英文
- [ ] 更新 Release 中的 MSI 文件

### v0.87 发布 (2026-07-24)

#### Git Worktree 全链路
- [x] `worktree-manager.ts` — create/remove/scan/limit，Windows PowerShell 兼容
- [x] `environment-runner.ts` — setup/cleanup 脚本自动执行
- [x] `App.tsx handleSend` — 检查 executionMode，worktree 模式自动创建并用作 cwd
- [x] `core/store.ts deleteSession` — 自动调用 removeWorktreeSync 清理
- [x] `core/store.ts forkSession` — 继承 executionMode，创建独立 worktree
- [x] `GitInfoPanel.tsx` — 分支/dirty/diff/commit/push/pull/worktree 监控面板
- [x] `GitEnvSettings.tsx` — Git 环境配置（token/提交身份/脚本）
- [x] `InputArea.tsx` — 底部控制栏：本地/工作树模式切换 + 分支选择器

#### 并行对话隔离
- [x] `store.ts` — `activeSessions: Map<sessionId, boolean>` 替代单例 isStreaming
- [x] `llm/index.ts` — `loopPool: Map<sessionId, AgenticLoop>` + getAgenticLoop + cleanupSessionLoop
- [x] `App.tsx` — 所有 Promise-based UI 改为 per-session Map（权限/写确认/提示词变更/表单）
- [x] `App.tsx` — safeAddMessage/safeUpdateMessage + isViewingSession 守卫

#### 自动任务系统
- [x] `automation-manager.ts` — timer/file_watch 触发器 + 配置 CRUD + start/fire/stop/stopAll
- [x] `SettingsPanel.tsx` — 自动化 Tab 可视化配置

#### GitHub Clone + UI 改进
- [x] `ProjectManager.tsx` — 从 GitHub 拉取功能 + 2×2 网格布局
- [x] `Sidebar.tsx` — 分段控件 + 独立滚动 + Portal 菜单 + 标题栏按钮
- [x] `SlashCommandMenu.tsx` — / 命令菜单
- [x] 全局字体系统 — Alimama 方圆体 + 字体选择器 + 字重滑块
- [x] Prompt Cache 优化 — System Prompt 时间戳降为分钟精度
- [x] 分段控件主题适配 — color-mix + --accent 三皮肤自适应
- [x] 梦幻皮肤磨砂弹窗 — 所有弹窗用 createPortal 渲染
- [x] 安全移除项目 — 三按钮弹窗 + 回收站删除
- [x] 设置侧边栏分栏 — 9 个 Tab

#### 审计与测试
- [x] `AUDIT-WORKTREE-PARALLEL.md` — 12 项隐患全部修复
- [x] `REGRESSION-TEST-CASES.md` — 58 组 236 步回归测试
- [x] 新增 `codem-naming.test.ts`（443 行）+ `git-env-config.test.ts`（1147 行）
- [x] 全部 1614 个测试通过

### 版本发布流程备忘
每次发版需完成以下步骤：
1. `git commit` + `git tag vX.XX` + `git push origin master --tags`
2. `gh release create vX.XX --title "..." --notes-file release-notes.md`
3. `npm run tauri build` 构建生产版安装包
4. `gh release upload vX.XX` 上传 exe + msi 到 GitHub Release

## 已完成

### Phase 0-4：Codex 核心对标 ✅ 全部完成

### Phase 0：类型与接口层（0.5 天）✅ 完成
- [x] `LLMRequest` 增加 `reasoningEffort` 字段 (`types.ts`)
- [x] `LoopConfig` 增加 `reasoningEffort` / `onCompactionComplete` / `onTurnComplete` / `memoryEnabled` / `costTracker` / `resolveSlot` / `collaborationMode` / `onWriteConfirm` 字段 (`agentic-loop.ts` Zone A)
- [x] `AgentDefinition` 增加 `collaborationMode` + `reasoningEffort` 字段 (`agent.ts`)

### Phase 1：基础设施通电 + 文件安全（1-1.5 天）⚡ ✅ 完成
- [x] E1 子智能体模型路由 — `index.ts getAgenticLoop()` 读取 `agent.model`
- [x] F1.1 记忆面板编辑/新增 — `MemoryManager.tsx` 改为可编辑
- [x] F1.2 压缩后自动提取记忆 — `agentic-loop.ts` Zone B+E
- [x] F1.3 回合结束自动提取记忆 — `agentic-loop.ts` Zone B
- [x] F1.4 AGENTS.md 可配字节上限 — `files.ts`
- [x] **S2 受保护路径机制** — 禁止写入 `.git`/`.env`/`.mimo-snapshots` 等关键路径 (`tools.ts`, `permission.ts`)
- [x] **S1 Write 工具覆写保护** — 已存在文件先做 diff 检查 (`tools.ts`)

### Phase 2：核心效率 + 安全 + 协作模式（3-4 天）⚡ ✅ 完成
- [x] **Bash timeout_ms** — bash 工具增加 `timeout_ms` 参数，LLM 可自主设置超时 (`tools.ts`, `streaming-executor.ts`)
- [x] E2 推理力度配置 → `provider.ts` 传入 `reasoning_effort`
- [x] E8 成本检查 → `agentic-loop.ts` 每轮迭代检查 `costTracker` 限额
- [x] F3.4 自动lint → `tools.ts` write/edit/multi_edit 后自动运行 linter
- [x] **S3 apply_patch 编辑工具** — 新增 `multi_edit` 工具支持批量编辑 (`tools.ts`)
- [x] **C1 协作模式切换** — Default/Plan 两种模式，Plan 禁止写操作 (`agent.ts`, `prompt.ts`, `App.tsx`, `InputArea.tsx`, `ChatPanel.tsx`, `agentic-loop.ts`)
- [x] F3.6 retrospective — 回顾性分析 (`agentic-loop.ts` 循环检测 + `getRetrospectiveHint()`)
- [x] E3 增量消息构建 → `agentic-loop.ts` Zone D `buildMessages()` 增量缓存
- [x] E6 智能上下文选择 → `agentic-loop.ts` `selectMessagesByPriority()` 优先级选择
- [x] E4 文件缓存 → `tools.ts` `FileContentCache` LRU 缓存
- [x] E5 并发扩展 → `streaming-executor.ts` 扩展 `concurrencySafeTools` 列表
- [x] F2.5 安全扫描 → `streaming-executor.ts` `scanParametersForSecrets()`
- [x] E7 Prompt Caching → `provider.ts` `markCacheableMessages()` Anthropic 缓存标记
- [x] F2.1 记忆脱敏 → `index.ts` `redactSecrets()` + `SECRET_REDACT_PATTERNS`
- [x] F2.2 root检测 → `files.ts` `detectProjectRoot()` 向上查找 `.git` 等标记
- [x] F2.3 fallback文件名 → `files.ts` `AGENTS_MD_FALLBACKS` + `readWithFallbacks()`
- [x] F2.4 导出导入 → `memory.ts` `exportAsJSON/exportAsMarkdown/importFromJSON` + `MemoryManager.tsx` UI
- [x] **S4 Diff 审查 UI** — `DiffViewer.tsx` 组件 + `App.tsx` `onWriteConfirm` 集成 + `tools.ts` 写入前调用回调

### Phase 3：混合模型系统（4-5 天）⚡ ✅ 完成
- [x] M1 模型配置方案 — 新增 `model-profile.ts` 类型+管理器 + `ModelProfilePanel.tsx` 管理 UI + `SettingsPanel.tsx` 入口
- [x] M1 `AgentDefinition` 增加 `modelSlot` 字段 (`agent.ts`)，内置 Agent 设置对应槽位
- [x] M1 `getAgenticLoop()` + `extractMemoriesFromSession()` 通过 Profile 解析模型 (`index.ts`)
- [x] M1 `compactMessages()` 使用 compaction 槽位 (`agentic-loop.ts`)
- [x] M1 `resolveProvider` 回调传递 (`index.ts` → `agentic-loop.ts`)
- [x] E8 成本降级接入 — 80% 降级到 compaction 槽位模型，100% 硬停止 (`agentic-loop.ts`, `cost-tracker.ts`)
- [x] F3.1 跨会话记忆整合 — `memory.ts` `consolidate()` 去重+过期清理+容量限制 + `MemoryManager.tsx` 整合按钮
- [x] F3.2 会话级记忆控制 — `/memory on|off|status|consolidate` 命令 + `isMemoryEnabled()`/`setMemoryEnabled()` (`index.ts`, `App.tsx`)

### Phase 4：精细化 + 多模态扩展 ✅ 完成
- [x] F3.3 AGENTS.md 自动生成 — `files.ts` `generateAgentsMd()` 扫描项目结构生成初始模板 + `/generate-agents` 命令
- [x] F3.5 自定义权限规则 UI — `permission.ts` 规则持久化 + `SettingsPanel.tsx` `PermissionRulesSection` 可视化编辑
- [x] **S5 沙箱路径白名单** — Rust `write_file` + 前端 `isPathWithinWorkspace()` 双重路径检查 + 设置面板开关
- [x] 多模态-Embedding — `multimodal.ts` `generateEmbeddings()` + `semanticSearch()` + `cosineSimilarity()`
- [x] 多模态-TTS — `multimodal.ts` `textToSpeech()` + `playTTSAudio()` + `/tts` 命令 + AI `tts` 工具
- [x] 多模态-ImageGen — `multimodal.ts` `generateImages()` + `/image` 命令 + AI `image_gen` 工具
- [x] 多模态设置 UI — `MultimodalPanel.tsx` 配置面板 + `SettingsPanel.tsx` 入口

### v0.79 发布 (2026-07-13)

#### 三级安全策略系统
- [x] `src/core/permission/security-mode.ts` — ask/auto/full 三级安全模式，全局+项目级
- [x] 安全模式按钮集成到输入区（单击切换，颜色区分）
- [x] 153 个单元测试和集成测试

#### 智能体协作修复
- [x] **根因修复**：`message.ts` `messagesToLLMMessages` 改为按工具状态独立处理（不再全有或全无）
- [x] **迭代消息隔离**：`App.tsx` 每次迭代创建独立 assistant 消息
- [x] **Prompt 重构**：明确两步式 spawn/wait 模式（先 spawn 获取 task_id，下一轮再 wait）
- [x] **子智能体守卫**：LLM 试图结束时检查未 wait 的子智能体
- [x] **跨迭代去重**：`spawnedSubagents` Set 追踪未 wait 的子智能体

#### LLM 连接稳定性
- [x] 移除时间超时，改为状态驱动（Connecting → Streaming → Executing）
- [x] AbortController 全链路传播
- [x] `provider.ts` 移除空闲 timer / Promise.race / timeout 逻辑

#### 任务完整性检查
- [x] `checkTaskCompleteness` 方法防止 LLM 提前停止
- [x] `toolsCalledInRun` Set 追踪本次 run() 中调用的工具

#### 改进路线图 Phase 0-4 全部完成
- [x] Phase 0：类型与接口层
- [x] Phase 1：基础设施通电 + 文件安全
- [x] Phase 2：核心效率 + 安全 + 协作模式
- [x] Phase 3：混合模型系统
- [x] Phase 4：精细化 + 多模态扩展

#### Wegent UI/UX 对标分析
- [x] `docs/UI-UX-Wegent-Benchmark.md` — 10 项优化方向分析

### 安全策略 + 智能体调用修复 (2026-07-11)

#### 三级安全策略系统
- [x] `src/core/permission/security-mode.ts` — 实现 `SecurityMode` 类型（ask/auto/full），全局+项目级安全模式管理
- [x] `getGlobalSecurityMode` / `setGlobalSecurityMode` / `getProjectSecurityMode` / `setProjectSecurityMode` / `getEffectiveSecurityMode` 全局与项目级获取/设置
- [x] `shouldShowWriteConfirm` / `shouldCheckPermissions` / `isAutoApprovable` / `evaluateWithSecurityMode` 行为辅助函数
- [x] `src/core/permission/index.ts` 导出安全模式模块
- [x] `src/components/SettingsPanel.tsx` 全局安全模式选择器 `SecurityModeSelector`
- [x] `src/components/InputArea.tsx` 项目级安全模式切换按钮（单击循环 ask→auto→full，显示文字标签+颜色区分）
- [x] `src/core/llm/agentic-loop.ts` `LoopConfig` 添加 `securityMode` 字段，`executeIteration` 中根据模式调整权限检查
- [x] `src/core/llm/tools.ts` `write` 工具根据 `ctx.securityMode` 决定是否触发 `ctx.onWriteConfirm`
- [x] `src/core/permission/permission.ts` 移除 `requestPermission` 中的 5 分钟超时
- [x] `src/styles.css` 安全策略按钮样式（`.security-ask` / `.security-auto` / `.security-full`）
- [x] `src/test/security-mode.test.ts` 80 个单元测试
- [x] `src/test/security-mode-chain.test.ts` 73 个集成测试

#### LLM 连接状态机制（替代时间超时）
- [x] `src/core/llm/agentic-loop.ts` 新增 `LLMStatus` 类型 + `llm_status` 事件（connecting/streaming/executing_tools）
- [x] `executeIteration` 在调 LLM 前发 `connecting`，收到首个事件后发 `streaming`，工具执行前发 `executing_tools`
- [x] `src/store.ts` 新增 `llmStatus` 状态字段 + `setLLMStatus` 方法
- [x] `src/App.tsx` 处理 `llm_status` 事件更新 store
- [x] `src/components/ChatPanel.tsx` `StreamingTimer` 改为状态驱动显示（"正在连接 AI 服务器" / "正在接收 AI 响应" / "正在执行工具"）
- [x] `src/styles.css` 新增 `.streaming-timer-status` / `.streaming-timer-sep` 样式

#### provider.ts 超时机制重构
- [x] **移除** 5 分钟空闲超时（`STREAM_IDLE_TIMEOUT`）——时间超时本质不可靠
- [x] 改为纯状态驱动：UI 显示连接状态 + 用户随时可点 ■ 按钮取消（AbortController）
- [x] `AbortController` 信号连接到 `reader.cancel()`，确保用户取消时立即中断 `reader.read()`
- [x] TCP 层自然错误：连接真正断开时 OS 返回错误，由 catch 块处理
- [x] 移除 `provider.ts` 中的 `idleTimer` / `Promise.race` / `timeoutPromise` 逻辑

#### 智能体调用死循环修复（根因修复）
- [x] **根因**：`message.ts` `messagesToLLMMessages` 中 `hasCompleteTools` 全有或全无检查——当新迭代添加 "running" 状态工具调用时，**所有**工具结果（包括已完成的历史结果）被排除，LLM 看不到之前 `wait_for_subagent` 的结果 → 反复调用 → 死循环
- [x] **修复**：改为只包含 `completedTools`（status=done/error），不再因为某些工具还在运行就全部排除
- [x] `message.ts` 移除 `hasCompleteTools` 全有或全无检查，改为按完成状态分别处理
- [x] `tools.ts` `wait_for_subagent` 对无效 task_id 返回可用 task ID 列表（帮助 LLM 使用正确的 ID）

#### 任务完整性检查
- [x] `agentic-loop.ts` 新增 `checkTaskCompleteness` 方法——当 LLM 要停止时检查用户原始请求
- [x] 用户要求"保存/写入"但没调 `write` → 注入提醒继续循环
- [x] 用户要求"用子智能体"但没调 `spawn_subagent` → 注入提醒继续循环
- [x] `toolsCalledInRun` Set 追踪本次 run() 中所有调用过的工具名
- [x] 只触发一次（`taskReminderSent`），防止无限提醒

#### 诊断日志增强
- [x] `agentic-loop.ts` 迭代开始/结束/工具执行/LLM 流错误全链路日志
- [x] `provider.ts` 工具调用解析日志

#### 其他修复
- [x] `provider.ts` 流式空闲 timer 在 `Promise.race` 后正确清理
- [x] `agentic-loop.ts` `wait_for_subagent` 跨迭代去重（`waitedSubagents` Map）
- [x] `agentic-loop.ts` 子智能体运行时停止检查（`getChildTasks` 防止提前停止）
- [x] `agentic-loop.ts` 单响应内 `wait_for_subagent` 重复调用去重
- [x] `InputArea.tsx` 安全策略按钮单击切换 + 持久化到 storage

### 多语言支持 (2026-07-08)
- [x] 创建 `src/core/i18n/lang.ts` 语言管理模块（getLang/setLang/isZh/isEn）
- [x] 系统提示词 `prompt.ts` 支持双语（Language 段 + 末尾语言规则段按 getLang() 切换）
- [x] 子智能体系统提示词 `index.ts buildSubagentSystemPrompt` 全面双语（身份/语言规则/任务执行/编码规则）
- [x] Agent 定义 `agent.ts` 新增 `promptEn` 字段（plan/explore/general 三个角色英文版）
- [x] 工具返回文本 `tools.ts` 双语（spawn_subagent/wait_for_subagent 所有标签和错误消息）
- [x] `parseTaskResult` fallback 默认值双语
- [x] `spawner.ts` 工具结果标记双语（[工具结果] / [Tool Results]）
- [x] `MessageBubble.tsx` 子智能体状态显示双语
- [x] `SettingsPanel.tsx` 新增语言选择器（中文/English）
- [x] `App.tsx` 启动时检测安装器类型自动设置默认语言
- [x] Rust 后端新增 `get_installer_default_lang` 命令（注册表检测 NSIS=zh / MSI=en）
- [x] `tauri.conf.json` 配置 NSIS 中英文双语 + WiX 英文

### Phase F: 笔记本式知识管理（NotebookLM 模式）(2026-07-16)
- [x] F1: 数据模型 — SQLite 新增 notebooks/notebook_sources/notebook_chunks 三表 + CRUD storage
- [x] F2: 文本提取与分块引擎 — extractor.ts (txt/md/code/url/html) + chunker.ts (段落→句子→重叠窗口)
- [x] F3: Embedding 索引管道 — indexer.ts (批量 embedding + 进度回调 + 增量索引 + 摘要生成 + 建议问题)
- [x] F4: 语义检索引擎 — retriever.ts (cosine 相似度 + top-K + 阈值过滤 + 查询缓存 + 上下文构建)
- [x] F5: 笔记本对话集成 — prompt.ts 知识上下文注入 + search_notebook 工具 + agentic-loop notebookId 透传
- [x] F6: 笔记本管理 UI — NotebookManager.tsx (列表/详情/来源管理/索引进度/建议问题/对话入口) + Sidebar 集成
- [x] F7: PDF 文本提取 — pdf-extractor.ts (纯 TypeScript，零依赖，支持 FlateDecode 解压)
- [x] F8: 笔记本设置 — SettingsPanel.tsx 新增分块/检索参数配置 UI
- [x] TypeScript 编译零错误 + npm run build 成功

### Phase G: 本地嵌入模型 (ONNX Runtime + 小型 BERT) (2026-07-17)
- [x] G1: 风险1缓解 — local-embedding.ts 子分块预处理 (≤128 token, mean pooling 合并)
- [x] G2: 风险2缓解 — 7 个多领域模型 (MiniLM/BGE-zh/BGE-en/E5/GTE/paraphrase)
- [x] G3: 风险3缓解 — WASM+默认模型随包打包 (public/wasm + public/models)，安装后离线可用
- [x] G3.1: 默认回退 — 未配置 Embedding API 时自动使用本地 ONNX 模式
- [x] G4: multimodal.ts 本地模式路由 — isLocalEmbeddingProvider + getDefaultLocalEmbeddingConfig + isUsingLocalEmbedding
- [x] G5: retriever.ts 维度不匹配保护 — 切换模型后旧索引自动跳过
- [x] G6: indexer.ts 本地模式批次调整 — BATCH_SIZE = 10
- [x] G7: MultimodalPanel.tsx 本地模型 UI — 选择器/详情/状态指示器
- [x] G8: Phase G 测试套件 — 42 个测试用例全部通过
- [x] TypeScript 编译零错误 + 1213 测试全部通过

### v0.77 (2026-07-07)
- [x] 修复子智能体调用后主任务思考过程变为英文（5 个英语污染源）
- [x] 修复主任务思考过程全英文问题（系统提示词末尾追加强力中文语言规则）
- [x] 修复工具调用窗口子智能体名称显示（正则兼容中英文格式）
- [x] 清理代码注释中所有对标产品名称（Codex、Claude Code 等）
- [x] 修复 prompt.ts 未转义反引号导致编译错误
- [x] 修复测试文件类型安全问题
- [x] Release v0.77 发布，附带 exe + msi 安装包
