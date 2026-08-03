# Codem 待办事项

> **开发计划主线文档**：`docs/DEV-PLAN-UNIFIED.md`（统一开发计划，包含架构约束、影响分析、完整路线图）
>
> 以下为具体待办事项跟踪。Phase 0-4 + Phase B-D + Phase F-G 已全部完成，v0.89 已发布（含跨会话委派编排 + 高级调试 UI + 冒烟测试），v0.89 发布后完成宠物窗口锚点 resize + 多页打包 + 模型持久化修复。
> v0.90.0 已发布：推理强度分档 + UI/UX 大幅优化 + 统一 + 按钮 + 新手引导完善 + 梦幻皮肤磨砂玻璃 + 架构培训文档 + **P0-P4 全量功能（滚动UX/高级Agent/体验提升/多模态/智能输入/知识管理增强）**。
> v0.91.0 已发布：Coding 工作台基础设施升级 — 终端 PTY 交互式 + 文件变更追踪 Artifact + 文件树 Git 状态 + 自动 Commit + Agent Profile + Needs You + 异步 Agent 通信 + 浏览器面板 + Overview 可观测性。全量回归测试 2770 通过。集成与测试项全部完成（自动Commit开关UI / AgentProfile管理UI / PTY跨平台shell / TranscriptCache统计面板 / FileChangeTracker大patch预检查 / P0-P4组件全量集成 49/49测试通过）。
> v0.91.0 集成与测试全部完成后，进入下一阶段开发。
> v0.91.0 UI 设计完全版改造完成：自定义缓动曲线 + transition:all清零 + 按钮按压反馈 + 弹窗origin + 可访问性全覆盖 + 材质分层 + 入场动画现代化（对标 emilkowalski/skills + apple-design，三皮肤适配）。
> v0.92.0 已发布：Codex use-cases 对标分析（101个use-case逐项复现路径） + Playwright/Figma/GitHub 三个MCP工具（可复现率67%→81%） + 梦幻皮肤磨砂效果彻底修复 + 新手引导仅首次启动 + 检查更新修复 + 定位圆圈优化。
> v0.93.0 已发布：Vision Proxy 视觉代理全链路 — DeepSeek 等纯文本模型支持图片理解 + STT 语音转写代理 + 图片生成通路 + 多模态能力矩阵重构 + TaskSlot 新增 vision + 89 新测试（全量 2859 通过）。
> v0.94.0 已发布：配置方案 Portal 渲染彻底修复遮挡 + 新建方案自动展开配置面板 + 名称描述行内编辑 + 持久化修复（DB初始化时序） + 梦幻皮肤支持 GIF 和视频背景 + 3 种音频模式 + 音量控制。

## 待开发

### v0.94.0 已发布（2026-08-03）

#### 配置方案体验修复
- [x] 配置方案弹窗改用 `createPortal(document.body)` 渲染，彻底脱离 SettingsPanel DOM 层级
- [x] z-index 提升到 2000 确保不被遮挡
- [x] 新建方案后自动展开 `SlotConfigTable` 配置面板
- [x] 内置方案新增"复制并编辑"按钮
- [x] 编辑模式新增 `ProfileNameEditor` — 方案名称和描述行内编辑

#### 持久化修复
- [x] `ModelProfileManager` 新增 `reload()` 方法，在 `initDatabase()` 完成后调用
- [x] `save()` 方法增加 `flushDatabase()` 强制立即写入

#### 梦幻皮肤 GIF/视频背景
- [x] `DreamSkinConfig` 新增 `bgMediaType` / `videoAudioMode` / `videoVolume` 字段
- [x] `setDreamBackground()` 自动检测文件类型（image/gif/video）
- [x] 视频走动态创建 `<video>` 元素，全屏覆盖
- [x] 三种音频模式：永久循环+声音 / 仅首次声音后静音 / 静音循环
- [x] 音量滑轨控制（0-100%）

### v0.93.0 已发布（2026-08-03）

#### Vision Proxy 视觉代理全链路
- [x] 新建 `vision-proxy.ts` — 核心代理模块：检测图片 → 智能路由 → 视觉模型描述 → 替换为文字 → 转发主模型
- [x] `message.ts` `messagesToLLMMessages()` 生成 `ContentBlock[]`（text + image block）
- [x] `provider.ts` `toAPIMessage()` 支持 `ContentBlock[]` → OpenAI `image_url` array
- [x] `agentic-loop.ts` 在 `provider.stream()` 前插入 Vision Proxy 拦截
- [x] 智能路由：GPT-4o/Claude/Gemini 直接传图；DeepSeek/MiMo 代理描述

#### 语音 STT 代理通路
- [x] `vision-proxy.ts` 扩展为媒体代理：检测 audio → 调用 Whisper 转写 → 替换为文字
- [x] `ContentBlock` 新增 `audio` 类型（message.ts + types.ts）
- [x] `MessageAttachment` 新增 `audio` 类型（store.ts）
- [x] `provider.ts` 支持 `input_audio` OpenAI 格式

#### 图片生成通路
- [x] `image_gen` 工具检查 ImageGen 配置，未配置返回错误提示
- [x] DeepSeek 可调用 `image_gen` 工具生成图片

#### 多模态能力矩阵重构
- [x] `MultimodalSettings` 新增 `vision` 和 `stt` 字段
- [x] `MULTIMODAL_MODELS` 重构为五维能力矩阵（vision/stt/embedding/tts/imageGen）
- [x] 修正 MiMo 虚假 tts/imageGen 条目；Anthropic 新增 vision

#### 配置方案增强
- [x] `TaskSlot` 新增 `vision` + fallback 链 `vision → chat`
- [x] 内置方案“DeepSeek + 视觉代理”
- [x] `EDITABLE_SLOTS` 新增 vision
- [x] 配置方案弹窗 z-index 修复

#### 对话窗口体验
- [x] 贴图时检测 vision 能力并显示提示
- [x] 图片附件显示缩略图预览

#### 测试
- [x] 新增 `vision-proxy-media.test.ts`（89 用例）
- [x] 修正 `multimodal.test.ts` 失效断言
- [x] 全量 68 个测试文件 2859 用例全部通过

### v0.92.0 已发布（2026-08-02）

#### 新增工具
- [x] `browser_automate` — Playwright 浏览器自动化（导航/截图/点击/输入/JS执行/文本提取）
- [x] `figma_fetch` — Figma REST API 集成（文件结构/节点/图片导出/组件/样式）
- [x] `github_tool` — GitHub API 集成（PR审查/代码搜索/Issue搜索/漏洞扫描/提交历史）

#### Codex Use-Cases 对标分析
- [x] 抓取 Codex 官方 101 个 use-cases
- [x] 创建 101 个独立分析文件 + 3 个分析文档
- [x] 可复现率：✅ 82（81%）/ ⚠️ 7（7%）/ ❌ 12（12%）
- [x] 纯 Chat 模型（DeepSeek）可复现 70（69%）
- [x] `REPRODUCTION-ANALYSIS.md` — 逐项复现路径+工具链路+改造方案

#### 梦幻皮肤磨砂效果修复
- [x] CSS 变量 `--dream-panel-bg` 从 `.app` 提到 `[data-skin="dream"]`（html 级别）
- [x] 透明度从 0.97 降至 0.78（亮色）/ 0.82（暗色）
- [x] `.floating-explorer` 类名加入 CSS 选择器（文件浏览器根因）
- [x] `.sidebar-project-more-menu` 加入选择器（更多操作弹窗根因）
- [x] 删除所有内联 `background` 覆盖，让 CSS `!important` 生效
- [x] 内联 style 双保险（Portal 节点直接设 background）

#### UX 优化
- [x] 新手引导仅首次启动显示（根因：useState 在 DB 初始化前同步执行）
- [x] 检查更新 undefined 修复 + 无 JSON 时自动打开 GitHub 下载页
- [x] 定位圆圈居中 + 缩小至 28px + 梦幻皮肤磨砂不透明

### v0.91.0 已发布（2026-08-01）

#### P0 — 终端从 one-shot 升级为 PTY 交互式（#1）
- [x] 新增 `portable-pty` Rust 依赖，实现 `spawn_pty` / `write_pty` / `resize_pty` / `close_pty` 四个 Tauri 命令
- [x] `TerminalPanel.tsx` 完全重写为 PTY 交互式终端，支持多会话 Tab（最多 5 个）+ 30min TTL 自动清理
- [x] `Ctrl+C` 改为只复制（无选区不发信号，不会误中断）；`Ctrl+Shift+C` 发送中断信号 `\x03`
- [x] 工具栏新增 ⏹ 停止按钮，可视化中断当前进程
- [x] `ResizeObserver` 自动跟随窗口大小调整 PTY 列数/行数

#### P0 — 文件变更追踪 + Artifact 快照（#2）
- [x] 新增 `turn_file_changes` SQLite 表，存储 `before_tree` / `after_tree` / `patch` / `patch_sha256` / `current_brief` / `changed_files`
- [x] 新建 `FileChangeTracker` — 迭代边界 `start()` 捕获 `git rev-parse HEAD^{tree}`，`finalize()` 生成 `git diff --binary` + SHA-256 + 存 SQLite + emit 事件
- [x] 新建 `FileChangeStorage` CRUD — `create` / `listBySession` / `getById` / `updateStatus` / `deleteBySession` / `parseChangedFiles`
- [x] `agentic-loop.ts` 在每次迭代 `executeIteration` 前后自动调用 start/finalize，yield `file_changes_tracked` 事件
- [x] `FileChangeTracker.revert()` 通过 `git apply --reverse` 回滚指定轮次变更
- [x] 非 Git 工作区优雅降级（跳过不报错）；patch 超 500KB 截断；独立于 messages JSON 不受上下文压缩影响

#### P0 — 文件树 Git 状态 + 自动刷新（#3）
- [x] `FileExplorer.tsx` 新增 `loadGitStatus()` 解析 `git status --porcelain`，缓存到 `gitStatusCache`
- [x] 文件名右侧显示 Git 状态徽章：M（橙）/ A（绿）/ D（红）/ U（蓝）/ R（紫）
- [x] 监听 `onFileChangesTracked` 事件，Agent 修改文件后自动刷新文件树 + Git 状态

#### P1 — Diff 面板 + Topic 视角（#4）
- [x] 新建 `FileChangesList.tsx` — 按轮次分组的变更历史面板，展开显示文件列表 + brief 摘要 + 回滚按钮
- [x] `PanelSidebar.tsx` 新增"文件"和"变更"两个 Tab

#### P1 — 自动 Git Commit（#5）
- [x] 新建 `git-commit-service.ts` — `generateCommitMessage()` 支持 LLM 生成或启发式 fallback
- [x] `tryAutoCommit()` 在 `file_change_tracker.finalize()` 后自动触发（可通过 Settings 开关）
- [x] `GitInfoPanel.tsx` 监听 `onAutoCommitted` 事件自动刷新
- [x] 设置持久化到 `localStorage`（`auto_commit_enabled`）

#### P1 — Transcript 缓存（#6）
- [x] 新建 `transcript-cache.ts` — SHA-256 键缓存 LLM 请求/响应对，10min TTL，最多 100 条
- [x] `agentic-loop.ts` 在上下文压缩（`compaction_end`）时自动调用 `TranscriptCache.clear()`

#### P1 — Agent Profile 持久化（#7）
- [x] 新增 `agent_profiles` SQLite 表 — 存储 `identity` / `domain` / `scope` / `skills` / `experience_summary`
- [x] 新建 `AgentProfileStorage` CRUD + `SubagentTask.profile_id` 可选字段
- [x] `spawner.ts` 在生成子智能体时，若 `profile_id` 存在且 `persistent=true`，自动注入 Profile 到 system prompt

#### P1 — Needs You 精确提问机制（#8）
- [x] 新建 `needs-you-queue.ts` — Agent→Human 反向队列，迭代边界消费（不在工具回调内避免阻塞）
- [x] 新建 `NeedsYouPanel.tsx` — 显示当前工作 + 已确认事实 + 精确问题 + 候选选项 + 自定义回答
- [x] 新增 `needs_you_pending` SQLite 表，支持会话恢复
- [x] `agentic-loop.ts` 在迭代边界消费 needs_you，`waitForAnswer()` 异步等待用户回答
- [x] `App.tsx` 渲染 NeedsYouPanel，支持"跳过并继续"

#### P2 — 浏览器预览面板（#9）
- [x] 新增 `create_browser_window` / `close_browser_window` Rust 命令
- [x] 使用 `tauri::WebviewWindowBuilder` 创建独立 WebView 窗口，支持 URL 预览

#### P2 — 异步 Agent 间通信（#10）
- [x] 新建 `agent-message-queue.ts` — `send()` / `consume()` / `getReply()` / `onAgentMessage()`
- [x] 新增 `agent_messages` SQLite 表，独立于 messages JSON 不受压缩影响
- [x] `agentic-loop.ts` 在迭代边界消费 Agent 消息，yield `agent_message_received` 事件

#### P2 — Overview 轻量可观测性（#11）
- [x] `Workbench.tsx` 重写为三视图：Status（执行中工具）/ Capacity（修改文件+增删行统计）/ Activity（变更时间线）
- [x] 遵循 "Signal is not Diagnosis" 原则 — 指标仅作为调查入口

#### P2 — Artifact 快照引用（#12）
- [x] `turn_file_changes` 表的 `id` 字段即为 artifact_id，`patch_sha256` 确保完整性
- [x] `agentic-loop.ts` yield `file_changes_tracked` 事件携带 artifactId + changedFiles

#### 测试与质量
- [x] 新增 4 个测试文件共 101 用例：`regression-coding-p0.test.ts`（19）/ `p1`（28）/ `p2`（22）/ `cross-impact`（32）
- [x] 全量回归测试 2770/2770 通过，零回归
- [x] 交叉影响测试覆盖：agentic-loop 事件链顺序、database 表完整性+FK 约束、PanelSidebar Tab 不破坏现有面板、App.tsx 新增组件不破坏对话流、FileExplorer Git 状态不破坏文件树、spawner Profile 注入不破坏现有生成

#### v0.91.0 待完成 — ✅ 全部完成（2026-08-01）
- [x] Settings 面板新增“自动 Commit”开关 UI — `GitEnvSettings.tsx` 新增开关，调用 `isAutoCommitEnabled()`/`setAutoCommitEnabled()`
- [x] Settings 面板新增“Agent Profile 管理”UI — `SettingsPanel.tsx` Advanced tab 新增👤 Profiles 子标签，支持查看/创建/编辑/删除
- [x] FileChangesList 的 DiffViewer 集成验证 — 已在 `FileChangesList.tsx` 第 135-146 行集成 DiffViewer
- [x] TerminalPanel PTY 在非 Windows 平台的测试 — `lib.rs` 改为读取 `$SHELL` 环境变量，fallback 链 zsh→bash→sh
- [x] NeedsYouPanel 的 App.tsx 集成验证 — 已在 `App.tsx` 第 2396-2408 行渲染
- [x] TranscriptCache 命中率统计面板 — `SettingsPanel.tsx` Advanced tab 新增 💬 Cache 子标签，进度条+清空/刷新按钮
- [x] FileChangeTracker 的 git diff 输出流式处理 — `file-change-tracker.ts` 新增 `git diff --stat` 预检查，>20万行变更或>100文件时跳过全量 patch

### v0.90.0 已发布（2026-07-31）

#### 推理强度分档
- [x] 修复 `engine.process()` 断点：`reasoningEffort` 参数正确传递到 LLM API
- [x] 模型选择器底部新增推理强度分栏（低/中/高/超高）
- [x] 超高档位映射为 `reasoning_effort: "high"` + `maxOutputTokens: 16384`
- [x] 深度思考按钮从“⋯更多”菜单移除

#### UI/UX 大幅优化
- [x] 统一 + 按钮：上传文件 + 选择技能 + 生成图片 + 语音合成
- [x] 发送器右侧上箭头按钮：快捷短语 + 提示词草稿（视觉一体化）
- [x] 输入框内所有按钮垂直居中
- [x] 赞/踩按钮内联到复制/收起同一行
- [x] 快速访问 Agent 扩展：plan/explore/general 从 subagent 改为 all

#### 新手引导完善
- [x] 修复最后一步窗口太靠下看不全
- [x] 改为仅首次打开显示
- [x] 设置页新增「帮助」标签页，可重新播放

#### 侧边弹窗统一
- [x] 多模态/智能体/快照/上下文监控弹窗与主对话区同高居右
- [x] CSS 变量动态测量 chat-body 边界
- [x] 修复弹窗关闭按钮与主窗口重叠

#### 梦幻皮肤磨砂玻璃
- [x] 所有侧边浮动弹窗增加 `backdrop-filter: blur(20px) saturate(1.2)`
- [x] 暗色梦幻模式弹窗背景适配

#### 架构培训文档
- [x] 新增 `docs/training/` 目录，8 章项目架构培训文档

### v0.90.0 已发布功能（P0-P4 全量功能，commit 7435919）

#### P0: 滚动与 UX 基础
- [x] `ScrollbarMarkers.tsx` — 滚动条消息标记组件
- [x] `ScrollToBottomIndicator.tsx` — 滚动到底部指示器 + 未读消息计数
- [x] `hooks/useScrollState.ts` — 滚动状态 Hook（位置追踪 + 未读计数）
- [x] `ChatPanel.tsx` — 自动滚动优化（修复与未读指示器的交互冲突）
- [x] `ChatPanel.tsx` — `handleEditAndResend` 修复 session 级别 isStreaming 检查
- [x] `ChatPanel.tsx` — `reEditContent` 内部化管理（移除 App.tsx prop）

#### P1: 高级 Agent 功能
- [x] `CorrectionModeToggle.tsx` — 事实核查模式开关（ChatPanel 工具栏集成）
- [x] `CorrectionResultPanel.tsx` — 核查结果展示面板
- [x] `ClarificationForm.tsx` — AI 澄清交互表单组件
- [x] `PipelineNextStepDialog.tsx` — 管道步骤选择对话框
- [x] `TodoListDisplay.tsx` — Todo 列表可视化（分组展示 + 勾选 + DB 持久化）
- [x] `show-todo.ts` — Todo 工具（saveTodoList/loadTodoList/updateTodoStatus）
- [x] `ask-clarification.ts` — AI 澄清工具（表单数据收集）
- [x] `fact-check.ts` — 事实核查工具（callCorrectionModel 占位）
- [x] `GuidanceBlock.tsx` — 引导消息折叠展示块
- [x] `guidance-queue.ts` — 引导消息队列管理
- [x] `StreamingWaitIndicator.tsx` — 分阶段等待提示（thinking/searching/coding/reviewing）
- [x] `Workbench.tsx` — 代码工作台（工具状态 + Git diff + 修改文件统计）
- [x] `RegenerateModelPopover.tsx` — 重生成模型选择弹窗
- [x] `FeedbackButtons.tsx` — 消息反馈按钮（赞/踩 + DB 持久化）
- [x] `InlineMessageEdit.tsx` — 消息内联编辑
- [x] `CapabilityGuard.tsx` + `capability-detector.ts` — 模型能力守卫
- [x] `model-config.ts` — 模型配置集中管理（MIMO_MODELS/API_MODELS/getModelsForMode/getConfiguredApiModels）
- [x] `model-resolver.ts` — 模型路由解析器
- [x] `output-parser.ts` — 结构化输出解析器
- [x] `agentic-loop.ts` — LoopEvent 扩展（clarification/correction_complete/pipeline_step_complete/todo_list_created）
- [x] `types.ts` — Session 接口扩展（correctionMode/deepThinkingMode/preserveExecutor）
- [x] `tools.ts` — 注册 ask_clarification/fact_check/show_todo 工具

#### P2: 体验提升
- [x] `QuickPhraseSelector.tsx` — 快捷短语选择器（分类 + 搜索 + 插入）
- [x] `settings.ts` — 快捷短语 CRUD（saveQuickPhrase/loadQuickPhrases/deleteQuickPhrase/incrementQuickPhraseUsage）
- [x] `PromptDraftPicker.tsx` — 提示词草稿版本选择器（A/B 对比 + 版本切换）
- [x] `prompt-draft.ts` — 草稿存储（savePromptDraft/loadPromptDrafts/deletePromptDraft/comparePromptDrafts）
- [x] `QuickAccessCards.tsx` — Agent 快速访问卡片（网格 + 收藏 + 搜索）
- [x] `OnboardingTour.tsx` — 新手引导浮窗（4 步引导 + 首次启动检测）
- [x] `SourceReferences.tsx` — RAG 来源引用展示（来源芯片 + 点击查看）

#### P3: 多模态
- [x] `ImageGallery.tsx` — 图片画廊预览（全屏 lightbox + 左右切换 + 下载）
- [x] `VideoPlayer.tsx` — 视频播放器（进度条 + 下载）
- [x] `GenerateModeSelector.tsx` — 生成模式选择器
- [x] `ResolutionSelector.tsx` — 分辨率选择器
- [x] `store.ts` — MessageAttachment.type 扩展 `"video"`

#### P4: 智能输入
- [x] `ContextBadgeList.tsx` — 上下文徽章列表（附件/技能展示）
- [x] `MentionAutocomplete.tsx` — @ 提及自动补全（文件/笔记本）
- [x] `SkillAutocomplete.tsx` — 技能自动补全
- [x] `SourceSelector.tsx` — 知识来源选择器
- [x] `InputArea.tsx` — @ 提及触发 + 上下文徽章集成

#### 知识管理增强
- [x] `note-manager.ts` — 笔记管理（CRUD + 版本历史）
- [x] `flashcard-store.ts` — 闪卡存储与复习调度
- [x] `graph-extractor.ts` — 知识图谱实体/关系提取
- [x] `exporter.ts` — 知识导出（Markdown/JSON）
- [x] `importer.ts` — 知识导入
- [x] `study-path.ts` — 学习路径生成
- [x] `ppt-generator.ts` + `ppt-types.ts` — PPT 内容生成
- [x] `NoteEditor.tsx` — 笔记编辑器
- [x] `KnowledgeGraphView.tsx` — 知识图谱可视化
- [x] `FlashcardViewer.tsx` — 闪卡复习器
- [x] `NotebookWorkspace.tsx` — 笔记本工作台
- [x] `DocxViewer.tsx` — DOCX 文档查看器（mammoth 库）
- [x] `PdfViewer.tsx` — PDF 文档查看器（pdfjs-dist 库）
- [x] `SourceViewer.tsx` — 来源内容查看器
- [x] `note-operations.ts` — 笔记操作工具
- [x] `storage.ts` — +591 行（notes/note_links/flashcards/graph_nodes/graph_edges/notebook_groups/note_versions 表）
- [x] `indexer.ts` — +359 行（摘要生成/建议问题/增量索引增强）
- [x] `retriever.ts` — +35 行（检索增强）
- [x] `types.ts` — +143 行（Note/Flashcard/GraphNode/GraphEdge 等类型）
- [x] `NotebookManager.tsx` — +372 行增强

#### 基础设施变更
- [x] `database.ts` — +171 行，新增 10 张表（notes/note_links/flashcards/graph_nodes/graph_edges/notebook_groups/note_versions/message_feedback/quick_phrases/prompt_drafts/todo_lists）
- [x] `lang.ts` — +141 行翻译键（correctionMode/workbench/todoList/guidance/quickPhrase/promptDraft/onboarding/quickAccess/sources/gallery/video/streaming/context/mention/skills 全部组件）
- [x] `styles.css` — +1,327 行 CSS（P1-P4 全部组件样式）
- [x] `store.ts` — Message 接口新增 `metadata` 属性
- [x] `package.json` — 新依赖（katex/mammoth/pdfjs-dist/rehype-katex/remark-math）
- [x] `App.tsx` — OnboardingTour 集成 + QuickAccessCards 导入
- [x] `ChatPanel.tsx` — P1/P2 组件全量集成（CorrectionModeToggle/Workbench/GuidanceBlock/StreamingWaitIndicator/TodoListDisplay/QuickPhraseSelector/PromptDraftPicker）
- [x] `MessageBubble.tsx` — P3/P2 组件集成（ImageGallery/VideoPlayer/SourceReferences/FeedbackButtons）
- [x] `InputArea.tsx` — P4 组件集成（ContextBadgeList/MentionAutocomplete）

#### 对标分析文档
- [x] `docs/WECODE-REF-GAP-ANALYSIS.md` — 全局对标 wecode-ref 核心功能缺失分析
- [x] `docs/IMPLEMENTATION-PLAN-FULL.md` — P0-P4 全量功能实施计划
- [x] `docs/NOTEBOOK-FEATURE-GAP-ANALYSIS.md` — 笔记本功能差距分析（1066 行）
- [x] `docs/NOTEBOOK-FEATURE-GAP-ANALYSIS-V2.md` — 笔记本功能差距分析V2（精简版）
- [x] `docs/NOTEBOOK-UI-UX-BENCHMARK.md` — 笔记本 UI/UX 基准分析
- [x] `docs/NOTEBOOK-UNIMPLEMENTED-FEATURES.md` — 笔记本未实现功能清单

#### 待完成（集成与测试项）— ✅ 全部完成（2026-08-01）
- [x] **提交代码** — 已在 v0.90.0 发布提交中 commit（7435919）
- [x] **功能测试** — P1-P2 回归测试 49/49 通过，TS 编译 0 错误，lint 0 错误
- [x] **GenerateModeSelector/ResolutionSelector 集成** — 已在 `InputArea.tsx` 多模态面板中渲染
- [x] **SkillAutocomplete 集成** — SlashCommandMenu 已覆盖 `/` 命令功能，保留现有方案
- [x] **SourceSelector 集成** — 已在 `InputArea.tsx` 第 517-524 行渲染
- [x] **QuickAccessCards 集成** — 已在 `App.tsx` 第 2523-2561 行渲染
- [x] **CorrectionResultPanel 集成** — 已在 `App.tsx` 第 2484 行渲染，事件已处理
- [x] **ClarificationForm 集成** — 已在 `App.tsx` 第 2463 行渲染
- [x] **PipelineNextStepDialog 集成** — 已在 `App.tsx` 第 2508 行渲染
- [x] **note-operations 工具注册** — 已在 `tools.ts` 第 922 行注册

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

### v0.89 发布后优化 (2026-07-26)

#### 宠物窗口多页打包 + 内存优化
- [x] `vite.config.ts` — `rollupOptions.input` 新增 `pet.html` 入口，多页打包分离宠物窗口
- [x] `src/pet-main.tsx` — 宠物窗口专用轻量入口（仅 React + PetWindowApp + pet-window.css）
- [x] `src/styles/pet-window.css` — 宠物窗口专用最小样式（透明背景 + 基础重置，不加载 8400 行主 CSS）
- [x] JS Bundle 体积从 3.4MB 降至 5.7KB（-99.8%），WebView2 宠物进程内存大幅下降

#### 宠物窗口锚点 resize（零漂移）
- [x] `src-tauri/src/lib.rs` — 新增 `resize_pet_window_anchored` 命令，单次 `SetWindowPos` 原子设置位置+尺寸
- [x] `src-tauri/src/lib.rs` — 新增 `set_pet_window_geometry` 命令（前端传 x/y/width/height）
- [x] `src-tauri/Cargo.toml` — 新增 `windows` crate 依赖（Win32_UI_WindowsAndMessaging + Win32_Foundation）
- [x] `src/components/PetWindowApp.tsx` — 重写为锚点定位策略：精灵图水平中心+底部为锚点，窗口尺寸变化时精灵图屏幕位置完全不动
- [x] `src/components/PetWindowApp.tsx` — canvas `measureText` 精确测量气泡文本宽高（逐字符换行，兼容中英文混合）
- [x] `src/components/PetWindowApp.tsx` — 初始尺寸 = 精灵图宽×(精灵图高+MIN_BUBBLE_HEIGHT)，事件气泡出现时动态扩展窗口

#### 宠物状态扩展
- [x] `src/components/PetOverlay.tsx` — `STATE_LABELS` 补全 waiting/review/waving 三个状态

#### 模型/模式持久化修复
- [x] `src/App.tsx` — DB 初始化完成后（`initDatabase` + `migrateFromLocalStorage` 之后）同步调用 `configureEngine()`，确保重启后正确恢复上次使用的模式（API/CLI）及对应模型
- [x] `src/App.tsx` — `close-requested` 事件 + `handleCloseChoice` 中调用 `flushDatabase()`，确保 500ms 防抖写入在应用退出前立即刷盘
- [x] `src/core/storage/index.ts` — 导出 `flushDatabase`
- [x] 修复根因：之前 `configureEngine` 在 DB 未就绪时执行，读到空设置 fallback 到 `mimo-v2.5-pro`；关闭应用时未 flush DB 导致最后一次设置写入丢失

### v0.89 发布 (2026-07-26)

#### 跨会话 Agent 协作系统（Session Orchestration）
- [x] `core/session/types.ts` — 类型定义（DelegationTask/SessionMessage/DelegationConfig）
- [x] `core/session/bus.ts` — SessionMessageBus 跨会话事件总线（发布-订阅，4种消息类型）
- [x] `core/session/orchestrator.ts` — DelegationOrchestrator 编排器（死锁检测/并发控制/超时管理）
- [x] `core/session/executor.ts` — executeSessionTurn 程序化触发会话执行
- [x] `core/session/delegation-storage.ts` — 委派任务 SQLite 持久化层
- [x] `core/session/tools.ts` — 4个委派工具（delegate_to_session/wait_for_delegation/query_session_result/list_sessions）
- [x] `core/session/index.ts` — 统一导出

#### 高级功能 UI 面板（8 个新组件）
- [x] `AgentManager.tsx` — 智能体管理面板（查看/编辑/注册自定义智能体）
- [x] `HeartbeatMonitor.tsx` — 心跳监控面板（全局配置可视化）
- [x] `RetryConfigPanel.tsx` — 重试配置面板（指数退避参数配置）
- [x] `PromptDebugger.tsx` — 提示词调试面板（查看完整系统提示词）
- [x] `LayeredSettingsPanel.tsx` — 分层设置面板（七层设置源展示）
- [x] `RecoveryPanel.tsx` — 会话恢复面板（浏览/恢复/删除历史会话）
- [x] `ToolManager.tsx` — 工具管理面板（查看已注册工具和权限规则）
- [x] `DelegationPanel.tsx` — 委派任务面板（跨会话任务追踪）
- [x] `SettingsPanel.tsx` — 新增「高级」Tab 集成 8 个面板

#### 核心模块持久化增强
- [x] `agent/agent.ts` — AgentRegistry loadCustomAgents/saveCustomAgents/update/unregister/isBuiltin
- [x] `heartbeat/heartbeat.ts` — HeartbeatManager getGlobalConfig/setGlobalConfig
- [x] `retry/retry.ts` — RetryExecutor getConfig/setConfig
- [x] `recovery/recovery.ts` — SessionRecoveryService loadRecoveryData/saveRecoveryData

#### 上下文压缩参数配置 UI（P1-1）
- [x] `SettingsPanel.tsx` — 新增「上下文压缩」配置区域
- [x] `context/context.ts` — 压缩参数可配置（阈值/槽位模型/最大保留/摘要长度）

#### 冒烟测试（Smoke Test）
- [x] `smoke-test.test.ts` — 30 个发布阻断级冒烟用例（SMOKE-001 ~ SMOKE-030）
- [x] `TEST-CASES-REGRESSION-V2.md` — 新增第10节「冒烟测试」用例文档

#### 回归测试 V2
- [x] `regression-agent-registry.test.ts` — 20 个用例
- [x] `regression-heartbeat.test.ts` — 15 个用例
- [x] `regression-retry.test.ts` — 15 个用例
- [x] `regression-settings-keys.test.ts` — 15 个用例
- [x] `regression-git-worktree-env.test.ts` — 25 个用例
- [x] `regression-message-chain.test.ts` — 20 个用例
- [x] `regression-tool-permission.test.ts` — 20 个用例
- [x] `regression-prompt-builder.test.ts` — 15 个用例
- [x] `regression-session-recovery.test.ts` — 15 个用例
- [x] 10 个核心功能测试文件（core-*.test.ts）

#### Bug 修复
- [x] 修复 `SessionMessageBus` 未导出导致黑屏
- [x] 修复 `executor.ts` 导入路径错误（useAppStore）
- [x] 修复 `tools.ts` 导入路径错误（ToolDef/getLang）

### v0.88 发布 (2026-07-24)

#### 桌面宠物系统（基于 Petdex MIT 集成）
- [x] `pet-store.ts` — Zustand 状态管理，Agent 生命周期事件 → 宠物动画状态映射
- [x] `pet-types.ts` — 类型定义（PetDefinition/PetState/PetSettings/MarketPet）
- [x] `pet-manager.ts` — 本地宠物安装/加载/卸载/列表
- [x] `pet-market-client.ts` — Petdex 市场 API 客户端（Manifest + 图片代理）
- [x] `PetWindowApp.tsx` — 独立透明窗口根组件（精灵图 + 气泡 + 拖拽 + 右键）
- [x] `PetSprite.tsx` — 精灵图帧动画渲染（CSS background-position + requestAnimationFrame）
- [x] `PetMarketDialog.tsx` — 宠物市场对话框（CSS steps() 预览动画 + 安装/卸载）
- [x] `lib.rs` — `create_pet_window`（透明/无边框/置顶/无阴影） + `close_pet_window` + `show_pet_menu`（原生右键菜单）
- [x] `SettingsPanel.tsx` — 🐾 宠物 Tab（启用开关 + 大小滑轨 + 透明度滑轨 + 市场入口 + 已安装列表）
- [x] `App.tsx` — Agent 事件 → pet-store 状态同步 + 任务完成气泡通知 + Token 查询事件监听
- [x] `main.tsx` — pet-window-mode CSS class（透明背景）
- [x] `THIRD_PARTY_NOTICES.md` — Petdex MIT License 集成声明
- [x] `pet-system.test.ts` — 宠物系统单元测试

#### 悬浮气泡通知
- [x] `pet-store.ts` — `showBubble`（自动拼接称呼）/ `showRawBubble`（原始文本）
- [x] `PetWindowApp.tsx` — `useLayoutEffect` 同步测量气泡高度，窗口随内容动态扩展宽高
- [x] `PetWindowApp.tsx` — 增量位置调整（delta 计算），气泡出现/消失时宠物视觉静止
- [x] `App.tsx` — end 事件区分"任务做完了！"/"回复完成了！"，延迟 300ms 等待 happy 动画
- [x] 气泡小尾巴 CSS 三角形 + `petBubbleIn` 淡入动画

#### 右键原生菜单 + Token 查询
- [x] `lib.rs` — `show_pet_menu` 使用 `MenuBuilder`（关闭/置顶切换/重置位置/查看 Token）
- [x] `lib.rs` — `on_menu_event` 处理菜单点击，`app.emit` 转发到前端
- [x] `App.tsx` — `pet-check-tokens-request` 事件监听，调用 `engine.context.calculateBudgetFromMessages`
- [x] 气泡显示 Token 信息，自动拼接称呼，高度自适应不溢出

#### 精灵图渲染修复
- [x] `PetSprite.tsx` — `backgroundPosition` 与 `backgroundSize` 统一缩放坐标系，修复画面截断拼接
- [x] `lib.rs` — `.shadow(false)` 移除 Windows DWM 黑色边框
- [x] `lib.rs` — `.resizable(true)` 支持 `setSize` 动态调整
- [x] `PetWindowApp.tsx` — 物理像素↔逻辑像素正确转换（`window.devicePixelRatio`）

#### 其他改进
- [x] `index.html` — `<title>` 更新为 "Codem"，WebView2 进程名统一
- [x] `capabilities/default.json` — 新增 `core:window:allow-set-shadow` 权限
- [x] `styles.css` — `.pet-window-mode` 透明背景样式

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
