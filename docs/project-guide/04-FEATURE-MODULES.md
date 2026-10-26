# 04 · 功能模块全清单（按域）

> 基线：1.16.330 ｜ 2026-10-26
> 本文是**当前状态**的功能目录，不是逐条宣传语。功能叶子库见 `docs/CODEM-FEATURES.md`（2779 条，2026-09-09/10-22 生成）；本文在其上做“域 → 关键功能 → 入口 → 证据 → 成熟度”的重编，并补 10 月新增项。
>
> 成熟度：**稳定** = 有判据 + 真机使用；**可用** = 有入口/判据但边界明确；**受限** = 依赖外部条件；**占位/不可达** = 代码在但当前无入口或未接线。

---

## 0. 覆盖统计（旧叶子库，供对照）

| 片 | 主题 | 组 | 叶子 |
|---|---|---:|---:|
| slice01 | 对话主区与消息渲染 | 9 | 128 |
| slice02 | 会话增强与审批澄清 | 4 | 120 |
| slice03 | 布局导航与工作区 | 5 | 116 |
| slice04 | 设置 23 分区 | 1 | 290 |
| slice05 | 独立配置/工具面板 | 27 | 184 |
| slice06 | 任务中心 | 19 | 96 |
| slice07 | 知识笔记本 | 19 | 141 |
| slice08 | PPT 全套 | 28 | 130 |
| slice09 | 文件/富内容/生态市场 | 27 | 131 |
| slice10 | 宠物/启动/引导/杂项 | 13 | 66 |
| slice11 | 引擎能力层 | 24 | 126 |
| slice12 | 存储/会话/记忆/知识 | 15 | 92 |
| slice13 | 协作与自动化 | 25 | 171 |
| slice14 | 连接·工程·安全 | 32 | 211 |
| slice15 | 生态·主题·可观测 | 57 | 495 |
| slice16 | Rust 命令面 | 19 | 89 |
| slice17 | 大富翁玩法 | 7 | 141 |
| slice18 | LLM 工具全集 | 31 | 52 |
| **合计** | | **362** | **2779** |

> 这是 2026-09-09 的代码审计口径；10 月新增的项目工作台、OFM、DeepSeek 搜索、插件详情页等**不在其中**，已补在 §16。

---

## 1. 对话与消息（slice01 / slice02）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 流式正文 / 推理 / 工具调用 | 主对话 | `ChatPanel.tsx`、`MessageBubble.tsx`、`App.tsx` 事件消费 | 稳定 |
| 迭代边界独立 assistant 消息 | 主对话 | `agentic-loop` `start` 事件 + `App.tsx` | 稳定 |
| 统一 / 分段显示模式 | 设置 → 外观 / 消息头 | `codem-display-mode`、`MessageBubble` | 稳定 |
| 消息操作：复制/编辑/重发/重生成/分支/fork | 消息悬停 | `MessageActions.tsx`、`InlineMessageEdit.tsx` | 稳定 |
| 赞/踩 + 备注 + 版本 | 消息底部 | `FeedbackButtons.tsx`、`message_feedback` 表 | 稳定 |
| 运行中追加（引导） | 输入框（执行中） | `guidance-queue.ts`、`guidance-display.ts`、`ChatPanel` 引导栏 | 稳定 |
| 引导附件（图片/文件） | 执行中追加 | `guidance` 附件 → 落库 → image block | 稳定 |
| 计划步骤 / 第 X/X 步 | 对话顶部 | `step_progress`、`update_plan`、`PlanModeChip` | 稳定 |
| 任务完成 / 回归红 / 最大 token / 重试状态 | 回合末 | `TurnStatus.tsx`、`turn-outcome.ts` | 稳定 |
| 工具卡：Terminal/Diff/Read/Search/Web | 消息内 | `ToolCallCard.tsx`、`ToolCallGroup.tsx` | 稳定 |
| Diff 统一/分屏 + 行号 | 工具卡 | `DiffBlockCard.tsx`、`diff-view.ts` | 稳定 |
| 图片画廊 / 共享元素转场 | 图片附件 | `ImageGallery.tsx`、`view-transition.ts` | 稳定 |
| 上下文水位条 | 对话顶部 | `WaterLevelBanner.tsx` | 稳定 |
| 上下文面板（手动压缩/统计） | 对话头 → 上下文 | `ContextMonitor.tsx` | 可用（默认不展开） |
| 轨迹 / 智能体 / 快照 / 侧会话面板 | 对话头开关 | `TrajectoryPanel`、`AgentPanel`、`SnapshotPanel`、`SideSessionPanel` | 可用 |
| 会话搜索（当前会话） | 对话头搜索 | `ChatPanel` 搜索弹窗 | 稳定 |
| 会话总览 / 关闭确认 | 消息头/关闭 | `ConversationOverview.tsx`、`CloseConfirmDialog.tsx` | 可用 |
| 任务完成提示音 | 设置 → 外观 | `sound-cues.ts` | 可用（默认关） |

**已知不可达**：`ChatPanel.showWorkbench` 从不置 true ⇒ 分屏 Workbench 永不出现（`ChatPanel.tsx:350,948,1347`）。

---

## 2. Agent 引擎、上下文、模型（slice11 / slice18）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| Agent 主循环（无固定 token/迭代上限） | 自动 | `agentic-loop.ts::run` | 稳定 |
| 模型感知上下文窗口 | 自动 | `resolveModelContextWindow`、`TokenTracker` | 稳定 |
| 自动压缩（70% 阈值 / 保留 40% / 最近 3 轮不切） | 自动 | `doCompactMessages`、`compaction-budget.ts` | 稳定（真机边界见 09） |
| 工具输出折叠 | 自动 | `tool-output-fold.ts`、`context-fold.ts` | 稳定 |
| 旧工具参数折叠 | 自动 | `write/edit/multi_edit` 只留 path | 稳定 |
| 前缀缓存稳定性 | 自动 | `prompt.ts` 缓存边界、尾部易变消息 | 稳定 |
| 多模型：MiMo/OpenAI/Anthropic/DeepSeek/Moonshot/Gemini/Ollama/自定义 | 设置 → 模型 / 对话模型选择器 | `provider.ts`、`SettingsPanel`、`model-config.ts` | 稳定 |
| 免费模型插件（OFM） | 插件管理 → Our Free Model | `free-model-plugin/service.ts`、`src-tauri/src/ofm.rs` | 受限（上游政策） |
| 模型可用性/模态标注 | 模型列表 | `model-index.ts`、`catalog-health.ts` | 稳定 |
| 推理强度（low→ultra） | 对话模型菜单 | `reasoning-effort.ts`、`SettingsPanel` | 稳定 |
| 视觉代理（图片→文本描述） | 设置 → 多模态 | `vision-proxy.ts` | 可用 |
| 多模态：TTS/STT/ImageGen/Embedding/Ollama | 设置 → 多模态/语音/Ollama | `multimodal.ts`、`voice`、`ollama-provider.ts` | 可用 |
| 成本追踪/降级/限额 | 设置 → 用量/高级 | `cost-tracker.ts`、`E8` 降级 | 可用 |
| Token/缓存统计 | 消息 StatsLine / 性能面板 | `token-tracker.ts`、`cache-percent.ts` | 稳定 |
| 工具延迟加载 `tool_search` | 自动 | `tools.ts` `DEFERRED_BIG_TOOLS` | 稳定 |
| 重试（provider/工具/更新） | 自动/设置 | `retry.ts`、`RetryConfigPanel` | 稳定 |
| 收尾门禁（改红不显示完成） | 自动 | `test-regression.ts`、`turn-outcome.ts` | 稳定 |

---

## 3. 工具系统（slice18）

**核心文件工具**：`bash`、`read`、`write`、`edit`、`multi_edit`、`glob`、`grep`、`read_attachment`、`session_search`、`session_event_search`、`session_trace`、`session_event_read`。

**命令/终端**：`bash`（Windows 上经 `@codem/shell-ops` 走真 bash）、`terminal_open/send/read/signal/close/list`、`job_list/output/kill`。

**协作**：`subagent`、`send_message`、`interrupt_agent`、`list_agents`、`delegate_to_session`、`handoff_to_new_session`、`wait_for_delegation`、`query_session_result`、`list_sessions`、`cancel_delegation`。

**任务/计划**：`update_plan`、`create_goal/get_goal/update_goal`、`show_todo`、`ask_clarification`、`exit_plan_mode`、`project_report`、`workflow`、`squad_*`、`issue_*`。

**知识与技能**：`load_skill`、`search_notebook`、`note_create/edit/link`、`codegraph`、`zvec_grep_*`、MCP 工具/资源。

**联网**：`web_search`（MiMo/Exa/Perplexity/DeepSeek 后端）、`web_fetch`（DeepSeek Fetch）、`github_tool`、`figma_fetch`、`browser_automate`。

**多模态/创作**：`generate_ppt`、`image_gen`、`tts`、`run_code`、`lsp`、`fact_check`、`tool_search`、`cordis_define/inspect/run/stop/undefine`。

**门控**：
- 工具可在设置 → 工具里禁用（`codem-disabled-tools`）；
- plan 模式隐藏写工具；
- 无文档附件时隐藏 `read_attachment`；
- 延迟工具不进每轮 schema；
- 并发白名单只读工具。

---

## 4. 技能 / 插件 / MCP / 检索（slice15）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 技能安装（仓库/本地/ZIP） | 技能管理 | `core/skill/installer.ts`、`SkillManager.tsx` | 稳定 |
| 技能市场（GitHub Trees API） | 技能管理 → 市场 | `skill-market-client.ts` | 可用 |
| `SKILL.md` 渐进式加载 | `load_skill` | `src/core/llm/tools/load-skill.ts` | 稳定 |
| 内置技能包（PPT 74 风格等） | `core/skills/` | 102 文件 | 可用 |
| 插件管理（启停/详情/依赖/服务/风险） | 设置 → 插件管理 | `PluginManager.tsx`、`plugin-manager-service.ts` | 稳定 |
| 外部 DSH 插件检查更新/升级 | 插件管理 → 已安装 | `external-dsh-plugins.ts` | 可用 |
| 插件市场（内置 + DSH 目录） | 插件管理 → 市场 | `plugin-market/`、`builtin-registry.ts` | 可用 |
| Cordis DI / YAML 装配 | 自动 | `core/cordis/`、`plugin-loader/yaml-loader.ts` | 稳定 |
| UI 槽位（single/list/keyed/chain） | 自动 | `core/slots/`、`SlotBridge` | 稳定 |
| MCP 服务器管理/市场/连接 | 设置 → MCP / 插件 | `core/mcp/mcp.ts`、`McpManager.tsx` | 可用 |
| MCP 工具/资源/提示 | 自动 | `mcp-resources-tool.ts` | 可用 |
| CodeGraph（代码图谱/索引） | 设置 → 代码图谱 | `src/core/llm/tools/codegraph-tool.ts`、`codegraph_install` 命令 | 可用 |
| zvec-grep 语义检索 | 插件/工具 | `core/zvec-grep/` | 实验 |
| JS 沙箱（run_code/workflow） | 工具 | `src-tauri/js_sandbox*.rs` | 可用 |
| 动态插件（cordis_*） | 工具 | `dynamic-plugin-tools.ts` | 实验 |

---

## 5. 知识笔记本（slice07）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 笔记本管理（创建/分组/导入） | 侧栏 → 知识笔记本 | `NotebookManager.tsx`、`knowledge/storage.ts` | 稳定 |
| 来源导入（PDF/DOCX/文本/URL/音视频转写） | 笔记本 → 添加来源 | `extractor.ts`、`importer.ts`、`pdf-extractor.ts` | 可用 |
| 分块 + 向量索引 + 本地嵌入 | 自动 | `chunker.ts`、`indexer.ts`、`local-embedding.ts` | 可用 |
| RAG 检索 + 引用 | 对话/笔记本问答 | `retriever.ts`、`SourceReferences.tsx` | 可用 |
| 三栏工作区（来源/笔记/对话） | 笔记本工作区 | `NotebookWorkspace.tsx` | 可用 |
| Markdown 笔记 + 双链 + 版本 | 笔记编辑器 | `NoteEditor.tsx`、`note_links`/`note_versions` | 可用 |
| 知识图谱（React Flow/Canvas） | 笔记本 → 图谱 | `KnowledgeGraphView.tsx`、`graph_*` 表 | 可用 |
| 闪卡 SM-2 复习 | 笔记本 → 闪卡 | `FlashcardViewer.tsx`、`flashcards` 表 | 可用 |
| 学习路径 / 导出导入 | 笔记本 | `study-path.ts`、`exporter.ts` | 可用 |
| 笔记本对话模式 | 主对话 + 笔记本 | `LLMEngine.process` `notebookId` | 可用 |

---

## 6. 记忆（slice12）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 三层记忆（平台/项目/对话） | 记忆管理 | `memory/memory.ts` | 稳定 |
| 自动提取 + 同批合并 + 相似查重 | 回合结束 | `extractMemoriesFromSession`、`candidate-merge.ts`、`similarity.ts` | 稳定 |
| 待批准 / 批量批准 / 拒绝记录 | 记忆 → 待批准 | `MemoryManager.tsx` | 稳定 |
| 一键关闭项目级逐条审批 | 待批准区 | `MemoryManager.tsx`、`memory-quick-toggle` 判据 | 稳定 |
| 积压上限（5 条后降级 conversation） | 自动 | `pending-backlog.ts` | 稳定 |
| 记忆体检（相似重复/归属失效/迁移回退） | 设置 → 记忆体检 | `MemoryCheckupView.tsx`、`checkup.ts` | 可用 |
| 导出脱敏（JSON/Markdown） | 记忆管理 | `settings.ts`、`memory.ts` | 稳定 |
| 记忆注入（缓存边界之后） | 系统提示 | `prompt.ts` | 稳定 |

---

## 7. 任务中心 / 自动化 / Issues / Inbox / 目标（slice06 / slice13）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 任务中心 8 Tab | 侧栏/标题栏 | `TaskCenter.tsx`、`task-center/*` | 稳定 |
| 概览（运行中/待你/待评审/完成） | Tab overview | `OverviewTab.tsx` | 稳定 |
| 委派列表 | Tab delegation | `DelegationTab.tsx` | 可用 |
| 子智能体列表 | Tab subagents | `SubagentsTab.tsx` | 稳定 |
| 自动化触发器（定时/文件监听） | Tab automation / 设置 | `automation-manager.ts` | 可用 |
| Issues（创建/状态/优先级/标签/评论/看板） | Tab issues/board | `issue.ts`、`IssueBoard.tsx` | 可用 |
| 收件箱（全局通知/未读） | Tab inbox | `inbox.ts`、`InboxTab.tsx` | 可用 |
| 团队模板（Squad）+ 运行时团队 | Tab teams | `squad.ts`、`agent-teams/` | 可用 |
| 目标（create/get/update） | 工具/GoalBar | `goal.ts` | 可用（GoalBar 默认不渲染） |
| 后台 Jobs（列表/终止） | 抽屉 → 任务 / 底部 jobs | `JobsPanel.tsx`、`job-tools.ts` | 稳定 |

> `automation` 设置分区已变为占位文案“已移至任务管理面板”（`SettingsPanel.tsx:2451-2461`）。

---

## 8. 多智能体 / 团队 / 委派（slice13）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 子代理（后台、可继续、可中断） | `subagent` 工具 | `subagent/runtime.ts` | 稳定 |
| 子代理活动/结算/汇报 | AgentPanel / 通知 | `SubagentRuntime`、`agentic-loop` settlement gate | 稳定 |
| 跨会话委派 | `delegate_to_session` | `session/orchestrator.ts`、`executor.ts` | 可用 |
| 新建会话交接 | `handoff_to_new_session` | `session/handover.ts` | 稳定 |
| 委派等待/查询/取消 | 工具 | `wait_for_delegation` 等 | 可用 |
| Agent Teams（运行时团队） | 团队面板/工具 | `agent-teams/engine.ts` | 可用 |
| Squad 模板（蓝图） | 任务中心 → 团队 | `squad/` | 可用 |
| 并发上限（1–3 回合） | 自动 | `executor.getConcurrencyLimit` | 稳定 |
| 会话活动/进度 | 任务中心/轨迹 | `agent_activity`、`session` | 可用 |

---

## 9. 项目工作台（10 月新增）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 项目状态 `.codem/project/` | 项目根 | `core/project/` | 可用 |
| brief / MEMORY / gates | 项目目录 | `PROJECT-MODE.md` | 可用 |
| 协调者会话（可选） | 侧栏项目菜单 | `coordinator/storage`、`PROJECTS-*` | 可用 |
| thread 注册表 / 生命周期 | Overview | `state.json`、`updateThreadStatus` | 可用 |
| `project_report` v3.1 | 工具 | `project/report-contract.ts` | 可用 |
| gate 重验（command） | 自动/Overview | `verifyProjectGates` | 可用 |
| 证据缺失降级 done→review | 自动 | `PROJECTS-MVP-REVIEW.md` | 可用 |
| Overview 四态 + 展开 thread | 项目总览 | `ProjectOverviewDialog.tsx` | 可用 |
| blocked 审批 → decisions.jsonl | Overview | `decisions.jsonl` | 可用 |
| 项目级自动化 | 自动化 | `trigger.projectId` | 可用 |
| PR/CI 只读同步 | Overview | `gh` | 受限（只读） |
| 真实模型 3 并发稳定性 | — | R3 复验 | **未证明** |

---

## 10. Git / Worktree / CI-CD（slice14 / slice03）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| Git 面板（状态/分支/提交/差异） | 抽屉 → Git | `GitInfoPanel.tsx` | 稳定 |
| 分支选择/创建 | 标题栏/面板 | `GitBranchSelector.tsx` | 可用 |
| 执行模式：本地 / 新工作树 | 标题栏 | `environment/worktree-manager.ts` | 稳定 |
| worktree 创建/切换/清理 | 标题栏/面板 | `worktree-manager.ts` | 稳定 |
| worktree 合并回主工作区 + 冲突选边 | Git 面板 | `GitInfoPanel`、worktree merge 判据 | 可用（无逐文件 UI） |
| 回合级文件变更追踪（before/after/patch） | 工作台/变更列表 | `file-change-tracker.ts`、`turn_file_changes` | 稳定 |
| 无改动不发 git | 自动 | `finalize()` | 稳定 |
| CI-CD（Actions 列表/日志/重跑） | 抽屉 → CI/CD | `CicdPanel.tsx`、`cicd/pipeline.ts` | 可用（只读/重跑） |
| GitHub 克隆 | 项目菜单 | `GitHubCloneDialog.tsx` | 可用 |

---

## 11. 安全 / 权限 / 沙箱 / 凭据（slice14）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 三档安全模式（ask/auto/full） | 输入区/设置 → 安全 | `security-mode.ts` | 稳定 |
| 项目级覆盖 | 设置/项目 | `codem-security-mode-project:*` | 稳定 |
| 工具审批（allow/deny/ask） | 弹窗 | `permission.ts`、`PermissionDialog.tsx` | 稳定 |
| 写入覆盖 Diff 审查 | 工具卡 | `onWriteConfirm`、`InlineDiffReview` | 稳定 |
| Bash 危险命令分析 | 自动 | `bash-analyzer.ts` | 稳定 |
| 受保护路径 | 自动 | `.git/.env/node_modules` | 稳定 |
| 沙箱 ACL（工作区/允许目录） | 设置 → 安全 | `sandbox-acl.ts`、`SandboxAllowPrompt` | 可用（默认关） |
| 凭据封存（DPAPI `dsh1:`） | 自动 | `secret.rs`、`secret-store.ts` | 稳定 |
| 凭据状态/重新填写提示 | 设置 → 安全 | `PersistFailureBanner` | 稳定 |
| 导出脱敏 | 设置/记忆 | `credential-shapes.ts` | 稳定 |
| 权限预设 | 设置 → 安全 | `PermissionPresetSelector.tsx` | 可用 |

---

## 12. 连接与远程（slice14）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| Phone Link（LAN 扫码配对/TLS/审批） | 设置 → 连接手机 | `phone-link/`、`src-tauri/src/phone/` | 可用（网络环境依赖） |
| 手机端页面（app.html/pair.html） | 手机浏览器 | `src-tauri/src/phone/ui/` | 可用 |
| 出站中继 connector | 设置/自动 | `phone/connector.rs` | 可用 |
| 微信 ClawBot（iLink 登录/收发） | 设置 → 微信 | `wechat-bridge.ts`、`ilink/` | 可用（需扫码登录） |
| Computer Use（读屏/鼠标键盘） | 设置 → 电脑操作 | `computer-use.ts` | 可用（权限敏感） |
| 浏览器自动化（Playwright） | `browser_automate` | `browser-automate.ts` | 可用（需启用） |
| 内嵌浏览器窗口 | 右侧栏 Browser | `create_browser_window` | 可用 |
| 远程控制/AA 账号 | 设置 → 连接手机 | `aa_account`、`aa_connector` | 实验/受限 |

---

## 13. UI / 皮肤 / 宠物 / 设置（slice03 / slice04 / slice05 / slice10）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 三皮肤 default/hub/dream | 设置 → 外观 | `theme-manager.ts`、`skin-*.css` | 稳定 |
| 浅色/深色 + 跟随系统 | 标题栏/设置 | `theme-default.ts` | 稳定 |
| 高对比 / 密度档 | 设置 → 外观 | `appearance-modes.ts` | 稳定 |
| 自定义字体/字号/字重 | 设置 → 外观 | `applyStoredUiFont` | 稳定 |
| 原生材质 Mica/Acrylic | 自动 | `lib.rs::native_material` | 可用（Win11） |
| 23 个设置分区 | 设置 | `SettingsPanel.tsx:646` | 稳定 |
| 命令面板/搜索 | Ctrl+K | `SearchDialog.tsx` | 稳定 |
| @提及文件 / /命令 / 技能选择 | 输入区 | `MentionMenuPortal`、`SlashCommandMenu` | 稳定 |
| 快速短语 / 草稿 / 输入历史 | 输入区 | `quick_phrases`、`prompt_drafts` | 可用 |
| 桌面宠物（独立窗/精灵/市场/气泡） | 设置 → 宠物 | `PetWindowApp.tsx`、`pet/` | 可用 |
| 皮肤选择器 | 设置 → 外观 | `SkinSelector.tsx` | 稳定 |
| 引导（首次启动/重播） | 帮助 | `OnboardingTour.tsx` | 可用 |
| 启动屏 / Bootstrap 向导 | 首次启动 | `BootSplash`、`BootstrapWizard` | 稳定 |
| 崩溃恢复卡片 | 渲染崩溃 | `AppErrorBoundary` | 稳定 |
| 宠物窗崩溃边界 | 宠物窗 | `PetErrorBoundary` | 稳定 |

---

## 14. 内容生产与查看（slice08 / slice09）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| PPT 生成（74 风格） | `generate_ppt` / 对话 | `core/knowledge/ppt-*`、`components/ppt/` | 可用 |
| PPT 编辑器（画布/工具栏/属性/放映） | PPT 面板 | `PPTEditor.tsx` 等 | 可用 |
| PPTX 导入/导出 | PPT | `pptx-importer.ts`、`ppt-export-pptx.ts` | 可用 |
| PDF/DOCX/XLSX 查看 | 附件/文件 | `PdfViewer/DocxViewer/ExcelViewer` | 可用 |
| 图片/视频/音频查看 | 附件 | `ImageGallery`、`VideoPlayer`、`AudioPlayer` | 稳定 |
| Markdown/Shiki/Mermaid/KaTeX | 消息 | `MessageBubble`、`ShikiCodeBlock`、`rich-content/` | 稳定 |
| 文件编辑器 / Diff / 变更列表 | 右侧栏/抽屉 | `FileEditor`、`DiffViewer`、`FileChangesList` | 可用 |
| 富内容卡片（表格/代码/Mermaid/图片） | 消息 | `rich-content/` | 稳定 |

---

## 15. 可观测 / 恢复 / 更新（slice15）

| 功能 | 入口 | 证据 | 状态 |
|---|---|---|---|
| 用量/成本统计 | 设置 → 用量统计 | `UsageStats.tsx`、`cost_records` | 稳定 |
| 性能面板（DB/内存/耗时） | 设置 → 性能 / 底部 perf | `PerformanceDashboard.tsx` | 可用 |
| 遥测事件 | 自动 | `telemetry.ts`、`telemetry_events` | 稳定 |
| 轨迹 | 对话头 | `TrajectoryPanel.tsx` | 可用 |
| 会话恢复 | 启动/崩溃后 | `SessionRecovery.tsx`、`recovery_data` | 稳定 |
| 心跳监控 | 设置 → 高级 | `HeartbeatMonitor.tsx` | 可用 |
| 重试配置 | 设置 → 高级 | `RetryConfigPanel.tsx` | 可用 |
| 更新器（检查/下载/进度/重试/签名） | 标题栏/设置 | `update/`、`tauri.conf.json` | 稳定 |
| 运行时日志/崩溃取证 | 自动 | `runtime_log.rs`、`crash_evidence.rs` | 稳定 |
| 数据维护（索引重建/裁剪/对账/完整性） | 启动/后台 | `maintenance.ts` | 稳定 |

---

## 16. 10 月新增 / 变化（旧叶子库未覆盖）

| 版本 | 变化 | 位置 |
|---|---|---|
| 1.16.330 | 外部 DSH 插件检查更新/一键升级；统一插件详情页；免费模型面板收进详情 | `external-dsh-plugins.ts`、`PluginManager.tsx` |
| 1.16.330 | 删除运行中会话立即杀命令进程树 + 事件墓碑短路 | `session-abort-registry.ts`、`session-tombstones.ts` |
| 1.16.329 | 旧工具参数折叠（write/edit/multi_edit 只留 path） | `agentic-loop.ts` 折叠段 |
| 1.16.328 | 压缩阈值 70% + 保留 40%；提示条 90%；小结果/重复读取折叠 | `agentic-loop.ts`、`WaterLevelBanner` |
| 1.16.327 | 记忆审批一键关闭项目级逐条批准 | `MemoryManager.tsx` |
| 1.16.326 | 交接新建会话 + 换名重试；工作区外路径提示加入沙箱白名单 | `handoff_to_new_session`、`SandboxAllowPrompt` |
| 1.16.325 | 运行中追加可见 + 附件到模型；窄容器/滚动图钉/边缘渐隐/Diff 双视图/View Transitions/roving focus/提示音/动效棘轮 | `core/ui/*`、`ChatPanel`、`SettingsPanel` |
| 1.16.324 | `web_search` 结果卡修复；DeepSeek Search/Fetch 真机取证 | `web-search.ts`、`web_fetch` |
| 1.16.323 | 接入 DeepSeek 网页搜索/抓取；移除主对话顶部页签栏 | `deepseek-web.ts`、`bottom-tab-entries.ts` |
| 1.16.321 | Windows `bash` 走真 bash（shell-ops）；插件/技能安装手册 | `src/plugins/shell-ops/`、`docs/manuals/` |
| 1.16.320 | 上下文自动折叠；占用数字不再系统性偏低 | `context-fold.ts`、`tool-output-fold.ts` |
| 1.16.319 | 压缩按距离分档（近端 3 轮/中间 20 条/远端分块） | `compaction-budget.ts` |
| 1.16.309–318 | 免费模型插件（内置 Node/检测可用性/模态标注/残留进程恢复） | `free-model-plugin/`、`ofm.rs` |
| 10-22/23 | 项目工作台 MVP（协调者/thread/Overview/审批/gate 重验/PR 只读/项目自动化） | `core/project/`、`docs/PROJECTS-*` |

---

## 17. 占位、不可达、刻意无入口

| 项 | 状态 | 证据 |
|---|---|---|
| `automation` 设置分区 | 占位文案，指向任务中心 | `SettingsPanel.tsx:2451-2461` |
| `game` 底部页签 | **刻意无入口**（用户决定，GAME-4 钉住） | `bottom-tab-entries.ts:146-148` |
| `SpaceSwitcher` | 组件完整但侧栏无挂载点 ⇒ 不可达 | `Sidebar.tsx:14,601` |
| `ChatPanel` 分屏 Workbench | 从未置 true ⇒ 不可达 | `ChatPanel.tsx:350,948,1347` |
| `needs_you_pending` / `agent_messages` | 有表无读写；队列在内存 | `needs-you-queue.ts:8`、`agent-message-queue.ts:8` |
| `@codem/ui-*` 部分旧插件 | 已下架（无消费者/假承诺） | `config/codem.base.yml` 注释 |
| `GoalBar` | 槽 fallback=null，默认不渲染 | `InputArea.tsx:1355-1359` |
| `src/core/provider/index.ts` | 1.16.321 删除；不要找 `loadDefaultProviders` | git 历史 |
