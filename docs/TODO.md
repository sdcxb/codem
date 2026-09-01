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
> v0.95.0 已发布：Vision Proxy MiMo v2.5 支持图片输入 + CLI/API 双模式视觉代理全链路打通（engine 获取 CLI token） + CSP 全面修复 + 梦幻皮肤视频背景打包修复 + 仓库清理 + 13 个 E2E 全场景测试（156 通过）。
> v0.96.0 已发布：主对话窗口 UI 大改版（对标 frakio-work/wecode）+ 内联 Diff 批量审批（替换弹窗）+ 三皮肤暗色模式深度修复 + 梦幻皮肤自适应主题（data-theme 基于 palette.isDark）+ 富内容渲染系统（9 组件）+ Shiki 语法高亮 + 39 个新组件 + 3 个新依赖（framer-motion/shiki/xlsx）。42 个文件修改（+4,599/-1,866 行）。
> v0.96.1 已发布：右侧栏文件浏览器体系重构（对标 wecode 固定宽度面板 420px）+ 文件拖拽修复（Tauri dragDropEnabled + dropEffect）+ 拖拽方向反转修复 + 文件编辑器悬浮窗口（createPortal 全屏预览）+ Hub 皮肤强制暗色 + TitleBar 主题初始化修复 + MentionAutocomplete 重写 + FileEditor 全格式预览（图片/PDF/Excel/Word/视频/音频/HTML）+ **应用 Logo 替换**（icos/codem.ico 紫色图标）+ **NSIS 安装包图标修复**（sharp/png-to-ico 生成 BMP 格式 ICO + installerIcon 配置）。19 个文件修改（+2,392/-414 行）。
> v0.96.2 已发布：CodeGraph 代码知识图谱集成（自动检测 .codegraph/ → MCP Server 注册 → 系统提示词注入 codegraph_explore 指导 → 设置页面"代码图谱"标签页）+ 测试套件改造（readFileSync+toContain → 真实模块行为验证）+ CI Workflow（tsc + vitest + cargo check）+ Vite watch EBUSY 修复 + CodeGraph 集成测试（49 用例 4 层覆盖）。全量 72 文件 / 2872 用例通过。
> v0.97.0 已发布：Agentic Loop 性能优化（Tool Result 磁盘持久化 + ToolSearch 延迟加载 + Micro-Compact 摘要 + TranscriptCache 修复）+ 工具系统增强（工具中断行为 + Bash 分析器 + Hooks 系统 + TodoWrite 增强 + Forked Agent 记忆提取）+ 技能市场三大新源接入（ClawHub.ai / Skills.sh / SkillHub CLI）+ 技能发布功能（publishSkillToMarket 三种目标 + UI 发布对话框）。**补丁修复（同版本重新构建）：** ctx.abort 空指针 + Session 持久化缺失（executionMode/worktreePath/worktreeBranch）+ preserveExecutor 类型错误 + 移除 57 个假测试 + 重写 61 个源码字符串匹配测试为真实行为测试。全量 84 文件 / 2924 用例全部通过（0 失败）。
> v0.98.0 已发布：多智能体协同架构 — Phase 1 TaskCenter 统一任务管理中心（概览/委派/子智能体/自动化 4 Tab）+ Phase 2 Squad 多智能体协同（Leader-Member + Roster 协议 + 3 个 LLM 工具 + dispatch 路由）+ Phase 3 Issue 追踪 + 看板（7 状态 + 4 优先级 + 评论 + 看板拖拽 + 4 个 LLM 工具 + 分配给 Squad）+ Phase 4 Autopilot 扩展（Cron 引擎 + Issue 状态触发器）+ Phase 5 Inbox 全局通知聚合中心（6 分类 + 事件填充集成 + Sidebar 未读角标）+ Phase 6 AgentManager 扩展 + 死代码清理（DelegationPanel/AutomationSettingsSection/onAutomations/__pendingSquadDispatch 移除 + TopNavbar 双 Tasks 修复 + micro-compact bug 修复）。5 张新 DB 表、7 个新 LLM 工具、8 Tab 全景、30 个新文件、20 个修改文件。全量 87 文件 / 3057 用例通过。
> v0.99.0 已发布：**对标 DeepSeek Harness 全量升级** — 31 项差距系统性追平。P0 架构基础（事件溯源会话日志 + 5 层工具管线 + Plan Mode exit_plan_mode 增强 + 测试覆盖率门控）+ P1 功能增强（Windows ACL 沙箱 + Code Mode run_code + Session Query FTS5 + 防御性文档 + ADR）+ P2 架构提升（Capability Seam 三角色 + Workflow 编排 + Goal 自动续行 + Replay 测试 + Telemetry + 代码质量工具 + Bash 后台模式 + 终端 LLM 工具组 + Postmortem + 测试分层补齐）+ P3 远期完善（MCP 市场 + 语音 STT/TTS + Ollama 本地 LLM + CI/CD 管理 + 技能安全沙箱 + 远程同步引擎 + i18n 提示词重构 + Adaptive Idle Tracker + 事件系统增强）。25 文件修改（+1721/-313 行），50+ 新文件。全量 99 文件 / 3234 用例全部通过。**补丁修复（同版本重新构建）：** 上下游关联修复 — provider.ts toAPIMessage 补全 ContentBlock tool_use/tool_result 块处理（事件投影路径工具调用信息丢失修复）+ agentic-loop.ts 事件投影消息映射补全 tool_calls 属性（下游优先级排序/孤儿过滤/micro-compact 全链路修复）+ tools.ts readViaSeam + local-fs-provider.ts readFile 相对路径 cwd 解析修复。全量 99 文件 / 3235 用例全部通过。
> v1.0.0 已发布：**UI/UX 标准化 + 插件系统架构 + 测试体系全面升级** — P4 Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seams + P5 全能力族拆分（FS/Shell/Sandbox/Web/Skill/Subagent + 凭证/附件/知识/调度/目标/计划/后台任务）+ P6 UI 插件包化（7 个 UI 插件包 + Self-Referential Runtime + 插件市场基础设施）+ 补齐遗漏能力模块（compaction/approval/permissions/hooks/automation + fs-sandbox + tool-todo/ask-user/lsp/run-code/workflow/goal/schedule/knowledge + skin-default/pet/ui-pet + Preset/Bundle/SDK/ACP/Host/Client）+ 全弹窗 UI/UX 标准化（modal-overlay + modal-editor + 统一关闭按钮 + 图标映射体系 + CSS 变量替代硬编码 + Tailwind 类替代 + SVG 图标对齐）+ 测试体系升级（5 个新测试文件 / 271+ 用例：图标标准化 97 用例 / 工具触发-调用-执行闭环 30+ 用例 / 综合质量套件 80 用例 / 插件依赖图 24+ 用例 / 插件关闭影响 40+ 用例）+ 历史用例适配（full-regression-smoke + phase-b-f-regression 适配 SlotBridge + icon-map）。67 文件修改（+1112/-641 行）。全量 104 文件 / 3552 用例全部通过。**补丁修复（同版本重新构建）：** SlotBridge 泛型类型修复（`[key: string]: any` + `@ts-nocheck` → 泛型 `SlotBridge<P>` 从 fallback Props 自动推断参数类型）+ 恢复 `noImplicitAny` 严格检查 + App.tsx 参数类型精确化（`onResolve` alwaysAllow 可选 + `onOpenSession` 类型注解）+ SettingsPanel AgentManager onClose + files.ts 数组类型声明。`tsc --noEmit` 零错误 + `vite build` 成功。
> v1.1.0 已发布：**DSH 对标全面整改 + 测试体系深化 + Bug 修复** — Phase A-D 全部完成。孤岛模块接入 10 项（compaction-control / output-contract / feedback / type-safety / event-system-strict / cookbook / persistence-provider / replay-adapter / preset-discovery / agent-message-queue）+ 重复实现统一 4 项（capabilities vs provider / Telemetry-CostTracker / projectedTokens / seam-dsh-compat deprecation）+ 缺失功能补齐 5 项（代理指令分层 / 进程级沙箱 ACL / Dynamic Plugin 工具 / 测试分层框架 / 包不变量检查）+ 5 个 Bug 修复（ESM require→import / fire-and-forget .catch() / TranscriptCache.clear / 网络命令阻断 / 敏感变量）+ 4 个新测试文件 / 118 用例（dsh-integration-full 53 / plugin-disable-impact 18 / functional-chain-closed-loop 12 / extended-test-methods 35：模糊+属性+契约+链路探针）+ 消息存储双轨制统一（C5）+ 系统提示词分层加载（D1）。22 文件修改，24 新文件。全量 107 文件 / 3624 用例全部通过。
> v1.1.1 已发布：**UI 布局优化 + 插件条件渲染 + 宠物窗口 Bug 修复 + 工具调用防御性检查** — 插件管理按钮移至左下角 + CI/CD 移至右侧边栏 + 性能移至主对话框顶端 + 插件启用/禁用与按钮/面板联动显示 + 宠物窗口关闭 Bug 修复（Rust CloseRequested 拦截器）+ 插件管理面板 Cordis Context 初始化时序修复（重试机制+直接属性访问）+ UI 组件 useCtx→tryGetCtx 防御 + 6 个工具 Consumer 文件 execute 回调 null 检查防御（tool-fs/tool-bash/tool-web/tool-skill/tool-cordis/tool-extra）。15 文件修改。编译零错误。
> v1.2.0 已发布：**Cordis 架构全面对齐 DSH + 安全加固 + 全量测试重构** — 移除 Cordis 核心 `@ts-nocheck`（对齐 DSH 模式，`declare module` 类型声明全面生效，`ctx.get()` 返回强类型）+ `getCtxService` 对齐 DSH `ReflectService.get` keyof 推断模式 + `declare module` 声明对齐 DSH 非 optional 模式 + 泛型 `<T>` 回退 `<T,>` hack + 安全加固（AST 代码验证 + Worker 隔离 + XOR 密钥混淆 + SandboxGuard 覆盖读操作）+ 生命周期管理（复合 Dispose + LRU 淘汰 + 异步 I/O + 空 catch 日志）+ Bug 修复（React Hooks 顺序违规 + `useSyncExternalStore` 无限循环 + `import type` 语法错误 + 注释 `*/` 提前闭合 + context.ts Symbol 索引类型）+ UI 改进（输入框两行布局 + 全局错误监听）+ 全量测试重构 109 套件 3690 测试通过 + 66 个架构变更新用例。
> v1.3.0 已发布：**Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐** — 死 slot 从 29 个降至 0 个 + 7 个 UI provider 添加 `inject` 声明依赖 + Conversation slot 层级对标 DSH 完整建立（ConversationRoot/Session/Composer + 5 个子 slot）+ `slots.inject()` 消费声明方法 + 11 个重复/无消费点 slot 注册移除 + MessageBubble/InputArea/ChatPanel/Sidebar 全面接入 SlotBridge/SlotListBridge 消费 conversation 子 slot + SlotBridge 泛型类型推断修复。30+ 文件修改，10 个新组件。`tsc --noEmit` 零错误 + `vite build` 通过。
> v1.4.0 已发布：**UI/UX 体验优化 11 项 Bug 修复 + 性能/CI-CD 面板切换化 + 梦幻皮肤一致性修复** — 技能市场乱码修复 + http_get 超时优化 + 智能体管理滚动 + 模型默认值修复 + CI/CD 面板切换化 + 梦幻皮肤毛玻璃 + 圆角一致性 + 首页自适应 + write code 修复 + 安全策略按钮 + 性能面板切换化 + 编译 warnings 清零。15 文件修改，`tsc --noEmit` 零错误 + `tauri build` 零 warning。
> v1.4.1 已发布：**插件管理初始化修复 + 技能市场性能优化 + 对话区域自适应 9 项 Bug 修复** — Cordis Context fiber 激活时序修复（await 微任务等待）+ PluginManager 重试增强（50→100 + non-strict fallback）+ 三大技能市场 MAX_PAGES 减少（ClawHub 20→3/Skills.sh 10→2/SkillHub 20→3）+ configureEngine DB 未就绪重试 + CicdPanel 去除 header/关闭按钮 + 三套皮肤圆角统一 12px + 首页布局 flex-start 修复 + Write Code prompt 完整化 + 底部 CI/CD 按钮移除 + 对话区域 max-width 75vw/1100px→90vw/1400px。10 文件修改，`tsc --noEmit` 零错误。同 v1.4.0 补丁（不更新版本号）。
> v1.4.2 已发布：**10 项 Bug 修复 + Cordis 插件时序改进 + SlotBridge 降级机制增强 + 头像系统升级** — ①默认模型显示彻底修复（dbReady 同步读取 + engineRef 重试 + model-badge 友好名称 + getConfiguredApiModels name 属性修正）②右侧边栏 CI/CD 面板遮挡彻底修复（createPortal + z-index + right/maxWidth 调整）③底部栏多余模型选择器删除 ④输入框聚焦紫色边框→透明 ⑤技能市场缓存机制（先加载缓存快速显示 + "检查更新"按钮覆盖缓存）⑥Git 分支按钮居中 + 刷新逻辑修复 ⑦右侧边栏白色背景 + 拖拽影响左侧修复 ⑧顶部栏空白区域消除 ⑨CicdPanel 白色背景修复 ⑩顶部栏右侧按钮居中副作用修复。**架构增强**：Cordis 插件系统时序改进三步方案（fiber.await() 显式等待 + consumer 重试机制 + fiber 状态日志）+ SlotBridge 降级机制健壮性增强（SlotErrorBoundary + 降级提示 + 诊断日志）+ 头像系统升级（DiceBear API 50 个预设混合 13 种风格）。20+ 文件修改，`tsc --noEmit` 零错误 + `vitest run` 全量通过。
> v1.5.0 已发布：**Cordis "一切插件化" 工具发现机制** — 对标 DSH `ctx.systemPrompt.section()` + `ctx.tools.schemas()` 模式，彻底解决 LLM 工具发现断档问题。①`ToolDef` 新增 `guidance` 字段，工具自带使用引导 ②`toolsProvider` 改造：工具注册时自动将 guidance 注册为 `systemPrompt` prompt section，工具卸载时自动移除 ③`buildSystemPrompt` 删除硬编码工具列表，改为从 `systemPrompt.assemble()` 动态收集 ④`LLMEngine` 新增 `collectToolGuidance()` / `collectToolGuidanceSync()` 双路径收集方法 ⑤全部 31 个工具补充 guidance 文案（核心 11 + 能力 8 + 高级 6 + 笔记 4 + 会话 4 + 目标 3 + 终端 4 + 任务 2 + 协同 4 + 小队 3 + Issue 4 + 工作流 1 + 动态插件 5）⑥`skill-creator` 技能增强：LLM 可通过 `write`/`bash` 工具从 URL 或 ZIP 安装技能，`load_skill` 增加文件系统回退自动发现新技能。31 文件修改，`tsc --noEmit` 零错误 + 109 套件 / 3686 测试全通过。
> v1.5.1 已发布：**DSH 架构对标深度整改 + YAML 声明式插件加载 + 严重 Bug 修复** — ①新增 YAML 声明式插件加载器（对标 DSH `cordis.patch.yml`），`config/codem.base.yml` + `codem.desktop.yml` 分层 bundle，80+ 插件声明式加载 + 拓扑排序 + `assertActivated` fail-loud 验证 ②修复 LLM 回答重复问题（根因：`saveMessages` 全量追加事件日志导致重复，`buildMessages` 移除事件投影路径强制只从 DB 读取 + 事件投影去重）③修复 llmEngine 未注册为 Cordis 服务（`ctx.provide('llmEngine', engine)` 在 YAML 加载前完成）④修复 mimoAuth 未注册 + PluginLoader.load() 未调用 ⑤SlotBridge/SlotRenderer 对标 DSH `scoped-slots.tsx` 重写（SlotErrorBoundary + fiber await 超时保护）⑥30+ Provider 文件统一改造（import + re-export + inject 声明对齐）⑦新增 `mimo-auth-provider.ts` + `buffer-polyfill.ts` + 3 个测试文件。118 文件修改（+2359/-1583 行），`tsc --noEmit` 零错误。
> v1.5.2 已发布：**大文件性能修复 + Agent Loop 无上限改造 + 模型系统动态化 + Skills 增量搜索** — ①Rust 新增 `read_file_lines` 分页读取（对标 DSH TextRetainer，O(limit) 内存，彻底解决数百 MB 文件分析时前后台卡死）②Agent Loop 移除 `maxIterations` 硬上限，改为 `while(true)` + 三重安全阀（无进展检测 10 次 + Token 上限 2M + 子智能体有限迭代）③修复 `spawnForked` 深拷贝丢失 `tool_calls`/`toolCallId` 导致 API 400 ④模型选择器动态化（`codem-dynamic-models` 存储，联动设置页面 API 刷新）⑤Skills 市场增量搜索（本地缓存 TTL 30min + 自动联网搜索 + SkillHub 服务端搜索 API）⑥终端切换崩溃修复（`listen` 从 `__TAURI__.event` 获取）⑦权限弹窗 `DecisionTray` 改为 fixed 定位⑧技能市场 `tags` 防御（`Array.isArray()` 检查）。11 文件修改（+558/-90 行），新增 `v1.5.2-full-regression.test.ts` 100 用例，113 套件 3947 测试全部通过。
> v1.5.3-v1.5.4 已发布：**引导消息立即注入 + Markdown 文件路径超链接 + 任务完成标签稳定显示 + 技能市场优化** — ①`GuidanceQueue` 新增 `unshift` 高优先级注入 + `AbortController` 中断当前流 + `guidanceInterrupt` 标志位引导循环进入下一轮迭代 ②`react-markdown` code 渲染器文件路径白名单识别 + 转换为 `<a>` 链接 ③`isTurnEnd` 逻辑修复 + 滚动重试 10 次/150ms 锚定到任务完成标签 ④`installSkillFromGitHubDir` GitHub Contents API 递归下载特定目录（规避 1.4GB 整包下载）+ 动态获取 `default_branch` ⑤技能市场搜索数据源清零修复（增量更新保留旧数据）⑥SkillHub 串行改并行 + 12s 超时保护 ⑦搜索超时保护 20s per-source ⑧micro-compact CACHE HIT skip ⑨block-code 单词渲染 ⑩file-link cwd 解析 ⑪发送按钮图标居中 ⑫sidebar tooltip+context menu ⑬step plan 动态命名 ⑭notebook CSS 修复 ⑮知识笔记本面板遮挡修复 ⑯dialog 权限修复文件选择器 ⑰scroll 监听绑定错误容器修复。
> v1.5.5 已发布：**Compaction 并发写入治根修复 + Bash 缓存失效修复** — ①`compactMessages` DB 操作原子化（对标 DSH `compactSurfaceRegion`：异步 LLM summarization 前置完成，然后同步一次性提交 `deleteMessagesByIds` → `createMessage` → `EventLog.append`，中间无 `await` 间隙，消除 `bad parameter or other API misuse` 并发错误）②新增 `setCompactionInProgress`/`isCompactionInProgress` 互斥标志（defense-in-depth，`saveMessages` 在 compaction 期间跳过）③移除 `compaction_end` 事件中的 `saveMessages` 调用（DB 是唯一真相源，不应把过时 UI store 写回）④bash 工具执行成功后清除整个 `readCache`（修复脚本写入文件后 read 仍命中旧缓存，45 行旧内容覆盖 227 行新内容）。4 文件修改，`tsc --noEmit` 零错误。
> v1.6.0 已发布：**SubagentRuntime 架构重构 + 技能市场 Trees API 改造 + GitHub Token 修复** — ①**SubagentRuntime 全面重构（对标 DSH）**：移除旧 `SubagentManager`（-642 行）和 `LLMSubagentSpawner`（-338 行），新增 DSH 风格 `SubagentRuntime` 持续后台子智能体运行时 + `InProcessSpawnProvider`，4 个新工具（`subagent`/`send_message`/`interrupt_agent`/`list_agents`），`ToolRegistry.createScope()` 隔离工具作用域，系统提示词对标 DSH 重写为后台默认运行 + 自动通知模式 ②**技能市场 Trees API 改造（移植 vercel-labs/skills 官方 CLI 逻辑）**：Contents API 逐层遍历（O(N×M) 次调用）→ Trees API 一次性获取全量文件树（1 次调用），在内存中搜索 SKILL.md，支持 30+ Agent 目录约定前缀（Claude/Cline/Goose/Codex 等），修复 `dreambigou/eli5` 和 `cloudflare/cloudflare-docs`（15296 文件大仓库）等安装失败问题 ③**GitHub Token 配置链路修复**：统一 Token 读取链路 ④i18n-templates 新增子智能体协作模板（+138 行）⑤42 文件修改（+1542/-1562 行），`tsc --noEmit` 零错误。
> v1.6.1 已发布：**桌面宠物独立窗口改造 + 文件输出标识增强 + 设置版本号动态化** — ①**桌面宠物单一独立窗口改造（Cordis 插件化架构）**：移除主窗口内 PetOverlay，`@codem/ui-pet` 插件改为空壳；宠物窗口作为独立 Tauri 窗口运行，与主窗口共享 WebView2 进程组（实际内存增量仅 ~108MB，全部来自 1 个 renderer 进程）；新增 `ui-pet-provider.ts` Cordis Provider 封装，`App.tsx` 统一 `getPet()` 获取入口；Rust `show_pet_menu` 合并右键菜单，支持切换宠物样式子菜单（`SubmenuBuilder`）；`emitToPetWindow` 传递完整状态 ②**文件输出标识增强（DSH 风格 FileMentions）**：新增 `FileMentions` 解析器，从 `message.toolCalls` 提取 LLM 产出文件路径；`RichContent` inline code 渲染器优先解析文件路径为可点击按钮；`write`/`edit`/`multi_edit` 工具 guidance + 系统提示词强化文件路径引用要求 ③**设置版本号动态化**：关于页面版本号从 `package.json` 动态导入，不再需要手动同步。
> v1.6.2 已发布：**大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复** — 在 Codem 中嵌入完整的大富翁4风格桌面游戏，作为用户等待 LLM 执行任务时的休闲娱乐。游戏作为完全独立的大插件运行，零侵入主项目代码。Phase 1-6 完成基础设施和核心玩法（棋盘渲染/动态骰子/地产系统/角色系统/命运新闻事件/股票系统/卡片系统/道具系统/AI 策略/存档读档）；Phase 7-9 完成视觉交互和核心机制对齐（地块图标映射/角色精灵动画/消息条系统/物价指数/住院监狱酒店沉睡状态/连锁奖励税收）；Phase 10（G20-G36）补全开局设置（游戏天数/玩家数量/初始资金/胜利条件）+ 机制补全（机场传送/商业地块/主动卖地/股票分红/银行拒绝）+ 体验补全（多人热座/帮助规则/财富面板/资产清单/日志增强/投降功能/音量控制/速度调节）。三轮审计修复 7 个关键 Bug（破产清算逻辑/玩家状态检查/死循环保护/命运事件移动/初始资金应用/AI 循环优化/掷骰跳过检查）。TypeScript 编译 0 错误，Vite 构建成功。
> v1.7.0 已发布：**PPT 生成质量大幅提升 — oh-my-ppt 风格技能集成 + Cordis SkillRegistry 渐进式加载 + 生成链路断点修复** — 集成 oh-my-ppt 项目 74 种风格 SKILL.md + 9 种产品技能（布局/图表/动画等），通过 Vite `import.meta.glob` 构建时收集，运行时注册到 Cordis SkillRegistry。审计发现 PPT 生成两条通路（Studio 一键生成 + 对话中 generate_ppt 工具调用）都经过 `generatePPTContent`，该函数是单次 LLM 调用（非 agentic loop），AI 无法使用 `load_skill` 工具。修复方案：在调用 LLM 前主动从 SkillRegistry 加载当前选中风格的 SKILL.md 内容注入 systemPrompt，只加载当前 1 个风格 + 产品技能，不注入全部 74 个风格，避免 token 爆炸。新增 `ppt-skill-registry.ts` + `skills/` 资源目录，删除旧的 `ppt-skill-loader.ts`。TypeScript 编译 0 错误 + Lint 0 错误。
> v1.8.0 已发布：**知识图谱 React Flow 重构 + DSH 框架穿透性整改 + UI 设计规范化** — ①知识图谱从自研 Canvas 力导向图改为 @xyflow/react (React Flow) 库，获得 MiniMap/Controls/Background/fitView/贝塞尔曲线边等专业体验 ②vision-proxy.ts 的 resolveVisionConfig/resolveSTTConfig 从手动拼凑 codem-settings 改为统一使用 engine.getConfiguredProvider('vision'/'stt') ③50+ 组件批量 fontSize 数字→CSS 变量替换（var(--fs-xs)~var(--fs-3xl)）④SettingsPanel/PluginManager/ChatPanel 硬编码颜色→CSS 变量 ⑤笔记本功能对标 lumina-note 审计：功能完整无断点。TypeScript 编译 0 错误 + Lint 0 错误。
> v1.9.0 已发布：**上下文压缩过早触发治根修复 + 通用协议 API 配置 + 工具执行正确性修复** — ①**压缩治根（模型感知窗口 + 压力驱动）**：estimateMessagesTokens 永不回落修复（baseline 仅为下限不再忽略实际增长，压缩后 prompt 稳定回落到 ~40k）+ AgenticLoop 从 provider 解析模型真实 contextWindow 并同步 tracker（1M 窗口模型此前按 128k 估算压力放大 ~8 倍）+ micro-compact 由纯条数触发改为压力驱动（条数 > 12 且压力 >= 0.5）+ 新增 inferContextWindow 按模型 id 推断窗口（deepseek/gemini/mimo→1M、claude→200k、qwen→32k）+ getAgenticLoop 构造时同步 contextWindow ②**通用协议 API 配置（OpenAI 兼容）**：设置页手动 Base URL + API key + 自动拉取模型列表并持久化 + 修复刷新模型列表丢弃 contextWindow（运行时窗口解析不再回退 128k）+ getFirstConfiguredModel 初始模型 fallback + resolveProviderForModel 自定义 provider 模型路由 ③**工具执行正确性**：read 单响应去重键含 offset/limit（读全文+读片段不再误判重复跳过）+ DecisionTray 审批内容空白修复（读 req.input 而非 req.args，bash 显示命令/其他工具显示参数 JSON）+ 审批长命令滚动显示 ④新增回归测试 context-window-regression（8 例）+ custom-provider-config + s0-regression read 去重范围键。TypeScript 编译 0 错误 + 回归测试全部通过。

> v1.9.1 已发布：**对话任务步数计算对标改造 + 文件树显示隐藏文件夹 + 输入框/安全按钮修复 + 数据库持久化加固 + PowerShell 命令修复** — ①**步数对标 codex 宏观计划步**：总量固定为计划步数（不再随执行膨胀）+ 侦查类工具（read/glob/grep/tool_search 等 RECON_TOOL_NAMES）不推进步骤 + 执行类工具（write/edit/bash/run_test）首次出现才推进 + 步骤标题中文语义化 + 计划耗尽后追加去重限次 ②**文件树显示隐藏文件夹**：Rust list_directory 加 show_hidden 参数 + FileExplorer 传 true（.wecode-ref/.git 等可见，node_modules 仍过滤）③**输入框高度收缩修复**：textarea absolute+inset:0 测量前重置 minH ④**安全模式切换按钮修复**：portal 外部点击误判，新增 dropdownRef 排除判定 ⑤**数据库持久化加固**：损坏自动备份重建（PRAGMA quick_check）+ Rust write_file 原子写入 + DB 保存链串行化 + 退出前 flush 等待 ⑥**PowerShell 命令修复**：grepSearch 去外层 powershell 包裹 + autoLint 单引号路径 + execute_command 剥外层双引号 ⑦新增 step-progress-macro（6 例）+ file-tree-hidden（4 例）。全量 117 文件 / 3960 用例通过，tsc 零错误，cargo check 通过。
> v1.9.2 已发布：**LLM 请求级超时加固 + 安全模式按钮颜色反馈 + 引导消息注入体验改造 + LLM 失败可见性（对标 DSH 结构化失败上报）** — ①**LLM 请求级超时加固（对标 DSH request_timeout_seconds）**：complete() 非流式总超时 120s + stream() 流式连接阶段超时 60s（首字节后沿用 120s idle timeout）+ 修复 fetch 本身无超时导致服务端不返回时永久挂起、主循环卡死、activeSessions 残留的关键漏洞 + withRequestTimeout 合并外部 abort signal 与超时预算（cleanup 解除连接阶段超时）+ rethrowIfRequestTimeout 转为带诊断的超时错误 ②**安全模式按钮选中态颜色反馈**：ask/auto/full 显示蓝/紫/绿（修复选中后无变色）③**引导消息注入体验改造（对标 wecode markGuidanceApplied / Codex steering 消失）**：store 新增 removeGuidanceMessage 注入成功后状态栏自动消失 + 移除 ChatPanel 独立引导输入框改为复用主输入框（onSendGuidance 双按钮 + placeholder 提示）④**LLM 失败可见性**：移除任务完整性猜测机制（checkTaskCompleteness 不再正则猜测用户意图注入伪造 user 消息）+ EMPTY_RESPONSE 空响应检测（无文本/无推理/无工具调用抛错走重试）+ 失败必须对用户可见（agentic-loop text_delta / App.tsx too_many_errors/error/空 toolCall 上报）⑤新增 llm-timeout-hardening（200 行）+ GUIDE-061/062 + LOOP-051~053。全量 119 文件 / 3985 用例通过，tsc 零错误，cargo check 通过。

## 待开发

### v1.3.0 已发布（2026-08-19）— Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐

#### SlotBridge 消费闭环（阶段 2）
- [x] SLOT-1 InputArea 中 `app.model-selector`/`app.permission-preset-selector`/`app.plan-mode-chip` 通过 SlotBridge 消费
- [x] SLOT-2 ChatPanel 中 `app.jobs-badge`/`app.deliverable-files`/`app.trajectory-panel` 通过 SlotBridge 消费
- [x] SLOT-3 语义映射修正（uiGoal→GoalBar、uiJobs→JobsBadge、uiDeliverables→DeliverableFiles、uiPlan→PlanModeChip+PlanApprovalCard）

#### inject 依赖对齐（阶段 4）
- [x] INJECT-1 7 个核心 UI provider 添加 `inject: ['slots']` 属性声明
- [x] INJECT-2 移除所有 UI provider 内部的 `if (slots && slots.register)` null 检查
- [x] INJECT-3 `SlotsService` 新增 `slots.inject()` 消费声明方法

#### Conversation Slot 层级（阶段 3）
- [x] CONV-1 创建 ConversationRoot 组件（对标 DSH，声明 5 个子 slot 层级）
- [x] CONV-2 创建 ConversationSession 组件（消费 `conversation.session.header.actions`）
- [x] CONV-3 创建 ConversationComposer 组件（消费 `conversation.composer.bar`/`conversation.composer.dock`）
- [x] CONV-4 子 slot 注册（composer.bar ← ModelSelector/PlanModeChip/PermissionPreset、session.header.actions ← JobsBadge）

#### 消除剩余死 slot（阶段 5）
- [x] DEAD-1 App.tsx 添加 6 个全局 slot 消费（overlay/monitor/goal/subagent/user-questions/workflow-run）
- [x] DEAD-2 组件内 slot 消费（conversation.node.tool/app.message-feedback/conversation.messages/conversation.details.tool/app.ui-commands/conversation.input/app.attachment）
- [x] DEAD-3 布局 slot 消费（sidebar.tabs/bottom-panel.tabs）
- [x] DEAD-4 移除 11 个重复/无消费点 slot 注册
- [x] DEAD-5 Provider inject 对齐补充（uiSubagent/uiUserQuestions/uiWorkflowRun）

#### 审计结果
- [x] 死 slot 从 29 个降至 0 个
- [x] `tsc --noEmit` 零错误
- [x] `vite build` 通过

### v1.2.0 已发布（2026-08-18）— Cordis 架构全面对齐 DSH + 安全加固 + 全量测试重构

#### 架构对齐 DSH（4 项）
- [x] ARCH-1 移除 Cordis 核心 `@ts-nocheck` — 对齐 DSH 模式（DSH 完全不用 `@ts-nocheck`），使 `declare module` 类型声明生效，`ctx.get()` 返回强类型
- [x] ARCH-2 `getCtxService` 对齐 DSH `ReflectService.get` keyof 推断模式 — 签名改为 `<K extends string & keyof Context>(name: K): Context[K] | null`
- [x] ARCH-3 `declare module` 声明对齐 DSH 非 optional 模式 — 统一为 `xxx: XxxService`（非 `xxx?`）
- [x] ARCH-4 泛型 `<T>` 回退 `<T,>` hack — DSH 不需要逗号 hack（DSH tsconfig 不设 `jsx`，`.ts` 文件中 `<T>` 不被当作 JSX）

#### 安全加固（3 项）
- [x] SEC-1 代码运行时 AST 验证 + Worker 线程隔离 — `validateCode()` 正则匹配危险 API + Worker 内受限 `require` 白名单
- [x] SEC-2 API Key XOR + Base64 混淆存储 — 密钥不再明文存储 + `migrateToObfuscated` 自动迁移
- [x] SEC-3 SandboxGuard 扩展覆盖读操作 — `read_file`/`list_dir`/`grep`/`glob` 等读操作纳入沙箱检查

#### 生命周期管理（4 项）
- [x] LIFE-1 复合 Dispose 模式 — `hooks-provider.ts`/`automation-provider.ts` dispose 时设置 `_active = false`
- [x] LIFE-2 LRU 缓存淘汰 — `agent-loop-provider.ts` `loopPool` 上限 20 LRU 淘汰
- [x] LIFE-3 异步文件 I/O — `spill-store.ts` 从同步 `fs.mkdirSync` 改为异步 `fs.promises.mkdir`
- [x] LIFE-4 空 catch 块日志 — 8 个文件的裸 `catch {}` 块全部添加 `console.warn` 日志

#### Bug 修复（5 项）
- [x] BUG-1 React Hooks 顺序违规 — `SlotBridge.tsx` 中 `useSlotEntries` 在条件 `return` 之后被调用
- [x] BUG-2 `useSyncExternalStore` getSnapshot 不稳定导致无限循环 — `noopGetSnapshot` 每次返回新数组
- [x] BUG-3 `import type` 语法错误 — `consumer/index.ts` 中 `import type '../provider/service-types'` 缺少 `from` 关键字
- [x] BUG-4 `capabilities/index.ts` 注释中 `*/` 提前关闭块注释 — 路径 `capabilities/*/local.ts` 中的 `*/`
- [x] BUG-5 `context.ts` static 块 Symbol 索引类型错误 — `TS7053`，添加 `as any` cast 对齐 DSH `noImplicitAny: false`

#### UI 改进（2 项）
- [x] UI-1 输入框两行布局 — `InputArea.tsx` 和 `styles.css`
- [x] UI-2 全局错误监听 — `App.tsx` 添加 `unhandledrejection` 事件监听器

#### 测试重构
- [x] 全量 109 套件 3690 测试通过 + 66 个架构变更新用例

### v1.1.1 已发布（2026-08-17）— UI 布局优化 + 插件条件渲染 + 宠物窗口 Bug 修复 + 工具调用防御性检查

#### Bug 修复（4 项）
- [x] BUG-1 宠物右键关闭/设置关闭导致应用窗口也退出 → Rust `CloseRequested` 拦截器区分宠物窗口和应用窗口（`src-tauri/src/lib.rs`）
- [x] BUG-2 插件管理面板打开提示"Cordis Context 尚未初始化"，插件列表全为 0 → 添加重试机制等待 Context 就绪 + 修正 `ctx.get?.()` 为直接属性访问（`PluginManager.tsx`）
- [x] BUG-3 UI 组件 `CordisPanel`/`PluginMarketPanel`/`PluginManagerPanel` 在 Context 未初始化时渲染会抛出异常 → 改为 `tryGetCtx()` 返回 null（`ui-cordis/index.tsx`、`plugin-market.tsx`）
- [x] BUG-4 6 个工具 Consumer 文件 execute 回调缺少服务 null 检查 → 添加 `if (!ctx.xxx) return 'not available'` 防御（`tool-fs.ts`/`tool-bash.ts`/`tool-web.ts`/`tool-skill.ts`/`tool-cordis.ts`/`tool-extra.ts`）

#### UI 布局优化（3 项）
- [x] UI-1 插件管理按钮从左侧边栏功能区域移至左下角用户信息右侧，重命名为「插件管理」（`Sidebar.tsx`）
- [x] UI-2 CI/CD 按钮从左侧边栏移至右侧浮动面板 PanelSidebar，与 Git/文件/变更/工作台/智能体 并列（`PanelSidebar.tsx`）
- [x] UI-3 性能按钮从左侧边栏移至主对话框顶端 panel-tabs，与「对话」「终端」并列（`App.tsx`）

#### 插件条件渲染
- [x] COND-1 `App.tsx` 添加 `pluginDisabledList` state，监听 `localStorage` 变化和 `codem:plugin-state-changed` 自定义事件
- [x] COND-2 `plugin-manager-service.ts` 在 `saveDisabledList()` 和 `notifyListeners()` 中 dispatch 事件通知 UI 层
- [x] COND-3 根据 `cicdEnabled`/`perfEnabled`/`pluginMgrEnabled` 动态传递 props 给 Sidebar 和其他组件
- [x] COND-4 当 tab 对应插件被禁用时自动回退到默认 tab

### v1.1.0 已发布（2026-08-16）— DSH 对标全面整改 + 测试体系深化 + Bug 修复

#### Phase A — 孤岛模块接入（10 项）
- [x] A1 compaction-control 接入 — `agentic-loop.ts` 压缩锁 + 崩溃修复（repairCrashedSession）
- [x] A2 output-contract 接入 — `tool-pipeline.ts` OutputContractValidationMiddleware 注册到 finalize 层
- [x] A3 feedback 接入 — `store.ts` putMessageFeedback 实现 EventLog 双写
- [x] A4 type-safety re-export — `event-types.ts` assertNever + Branded 类型成为核心类型
- [x] A5 event-system-strict 接入 — `event-log.ts` TypedEventBus 事件发射 + 作用域过滤
- [x] A6 cookbook re-export — `llm/index.ts` 不再是孤岛
- [x] A7 persistence-provider 接入 — `event-log.ts` configurePersistenceProvider 方法
- [x] A8 replay-adapter 接入 — `provider.ts` CODEM_REPLAY_MODE 环境变量开关
- [x] A9 preset-discovery 接入 — `agent.ts` AgentRegistry 构造函数调用 discoverPresets
- [x] A10 agent-message-queue 接入 — `agentic-loop.ts` 迭代边界消费 agent 消息

#### Phase B — 运行时不变量 + 请求头追踪 + 事后复盘（10 项）
- [x] B1 runtime-invariants 接入 — `agentic-loop.ts` debug 模式下检查 "visible = recorded"
- [x] B2 request-header 接入 — `agentic-loop.ts` 请求头指纹追踪 + 缓存失效检测
- [x] B3 postmortem 接入 — `agentic-loop.ts` 错误处理中的事后分析
- [x] B4 type-safety 增补 — `event-types.ts` assertNever + Branded 类型
- [x] B5 event-system-strict 增补 — `event-log.ts` TypedEventBus
- [x] B6 cookbook 增补 — `llm/index.ts` re-export
- [x] B7 persistence-provider 增补 — `event-log.ts` 持久化后端切换
- [x] B8 replay-adapter 增补 — `provider.ts` CODEM_REPLAY_MODE
- [x] B9 preset-discovery 增补 — `agent.ts` discoverPresets
- [x] B10 agent-message-queue 增补 — `agentic-loop.ts` 迭代边界消费

#### Phase C — 重复实现统一（4 项）
- [x] C1 消除 capabilities/ vs provider/ — `capabilities/index.ts` 标注 provider/ 为 canonical
- [x] C2 统一 Telemetry/CostTracker — `cost-tracker.ts` recordUsage 转发到 TelemetryCollector
- [x] C3 补齐 projectedTokens — `token-tracker.ts` projectedTokens + shouldMicroCompact
- [x] C4 清理 seam/ 和 dsh-compat/ — 所有文件标注 @deprecated

#### Phase D — 缺失功能补齐（5 项）
- [x] D1 代理指令分层 — `prompt/instruction-layers.ts` global→deploy→project→session 四级分层加载
- [x] D2 进程级沙箱 ACL — `sandbox/sandbox-acl.ts` 前端 ACL 层（路径/命令/环境变量过滤 + strict 策略）
- [x] D3 Dynamic Plugin 工具 — `dynamic-plugin-tools.ts` cordis_define/inspect/run/stop/undefine
- [x] D4 测试分层框架 — `test-layers.ts` snapshot + real-API e2e 框架
- [x] D5 包不变量检查 — `scripts/verify-package-invariants.ts` CI 检查脚本

#### 消息存储双轨制统一（C5）
- [x] C5 EventLog 双写 — `store.ts` + `session/executor.ts` user/assistant 消息写入 MessageStorage 的同时追加为事件到 EventLog

#### Bug 修复（5 个，全部修代码不绕过用例）
- [x] BUG-1 `agent.ts` 中 `require("./preset-discovery")` 在 ESM 环境下报 `Cannot find module` → 改为 `await import()`
- [x] BUG-2 `llm/index.ts` 中 4 处 fire-and-forget `import().then()` 缺少 `.catch()`，环境 teardown 后产生 12 个 unhandled rejection → 全部添加 `.catch()`
- [x] BUG-3 `agentic-loop.ts` 中 `this.getTranscriptCache().clear()` 与测试期望的 `TranscriptCache.clear()` 不匹配 → 改为直接调用 `TranscriptCache.clear()`
- [x] BUG-4 `sandbox-acl.ts` 的 `checkCommand` 未检查 `blockNetwork` 策略，strict 模式下 `curl`/`wget` 未被阻止 → 添加网络命令检查逻辑
- [x] BUG-5 `sandbox-acl.ts` 的 `blockedEnvVars` 缺少 `DATABASE_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET` → 补充到列表

#### 测试体系深化（4 个新文件 / 118 用例）
- [x] TEST-1 `dsh-integration-full.test.ts`（53 用例）— Phase A-D 全部 25 项变更点逐项验证
- [x] TEST-2 `plugin-disable-impact.test.ts`（18 用例）— 插件 define/undefine 生命周期 + EventBus listener 注销 + AgentMessageQueue 清理 + Sandbox 策略切换
- [x] TEST-3 `functional-chain-closed-loop.test.ts`（12 用例）— 12 条完整功能链路端到端验证
- [x] TEST-4 `extended-test-methods.test.ts`（35 用例）— 模糊测试（6）+ 属性测试（7）+ 契约测试（14）+ 链路探针（8）

#### 系统提示词分层加载（D1）
- [x] D1-1 `prompt/prompt.ts` — `SystemPromptConfig` 增加 `layeredInstructions` 和 `sessionInstructions` 字段
- [x] D1-2 `buildSystemPrompt` 优先使用 `layeredInstructions`，回退到 `projectInstructions`

### v1.0.0 已发布（2026-08-15）— UI/UX 标准化 + 插件系统架构 + 测试体系全面升级

#### P4 — Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seams
- [x] P4-1 Cordis DI 容器（`slots/index.ts`）— `SlotRegistry` 注册表 + `initSlots()` 初始化 18 个 Capability Seam
- [x] P4-2 Plugin Loader（`plugin-loader/index.ts`）— 扫描 + 拓扑排序 + 加载/卸载 + 生命周期管理
- [x] P4-3 App.tsx 接入 PluginLoader + `loadUIPlugins()` 动态加载

#### P5 — 全能力族拆分（13 个独立能力族）
- [x] P5-1 FS 能力族（文件系统读写/目录/搜索）
- [x] P5-2 Shell 能力族（命令执行/后台任务/终端）
- [x] P5-3 Sandbox 能力族（Windows ACL 路径检查/受保护路径）
- [x] P5-4 Web 能力族（HTTP 请求/网页抓取）
- [x] P5-5 Skill 能力族（技能加载/执行/审计）
- [x] P5-6 Subagent 能力族（子智能体 spawn/wait/通信）
- [x] P5-7 凭证/附件/知识/调度/目标/计划/后台任务 7 个辅助能力族

#### P6 — UI 插件包化 + 插件市场基础设施
- [x] P6-1 7 个 UI 插件包（ui-conversation / ui-market / ui-misc / ui-settings / ui-sidebar / ui-skin / ui-tool）
- [x] P6-2 Self-Referential Runtime（UI 插件可引用其他 UI 插件的 Slot）
- [x] P6-3 插件市场基础设施（Manifest + 安装/卸载/更新流程）

#### 补齐遗漏能力模块
- [x] compaction / approval / permissions / hooks / automation
- [x] fs-sandbox + tool-todo / ask-user / lsp / run-code / workflow / goal / schedule / knowledge
- [x] skin-default / pet / ui-pet
- [x] Preset / Bundle / SDK / ACP / Host / Client

#### UI/UX 全面标准化
- [x] UI-1 弹窗统一结构（modal-overlay + modal-editor + 标准 header + 标准 close 按钮）
- [x] UI-2 图标映射体系（icon-map.ts 7 个图标集 + 消除直接 lucide-react 导入 + 消除 emoji）
- [x] UI-3 CSS 样式标准化（硬编码颜色 → CSS 变量 + Tailwind → size/CSS + 缺失规则补齐 + SVG 对齐）
- [x] UI-4 核心插件保护（riskLevel + locked + core 属性 + 关闭二次确认）
- [x] UI-5 弹窗布局排查（不拥挤/不变形/不换行验证 + CSS 修复）

#### 测试体系全面升级
- [x] T-1 icon-standardization.test.ts（97 用例）— 图标映射 + emoji 拘留 + 关闭按钮 + CSS 变量 + 运行时完整性
- [x] T-2 trigger-call-execute-loop.test.ts（30+ 用例）— 工具管线 5 层闭环 + Agent 循环事件流 + 消息存储 + 插件加载
- [x] T-3 extended-quality-suite.test.tsx（80 用例）— 快照 + 性能 + 交互 + CSS 布局 + i18n + 稳定性
- [x] T-4 plugin-dependency-graph.test.ts（24+ 用例）— 依赖图 + 拓扑排序 + 级联启停 + 锁定
- [x] T-5 plugin-disable-impact.test.ts（40+ 用例）— 插件关闭对系统功能/信息流/数据流影响
- [x] T-6 历史用例适配 — full-regression-smoke + phase-b-f-regression 适配 SlotBridge + icon-map
- [x] T-7 全量测试执行与修复 — 3552 用例全部通过 + vite build 零错误

#### 补丁修复（同版本重新构建）
- [x] PATCH-1 SlotBridge 泛型类型修复 — 从 `[key: string]: any` + `// @ts-nocheck` 改为泛型 `SlotBridge<P>`，从 `fallback` 组件 Props 自动推断参数类型
- [x] PATCH-2 恢复 `noImplicitAny` 严格检查 — 撤回 `tsconfig.json` 中的 `noImplicitAny: false`
- [x] PATCH-3 App.tsx 参数类型精确化 — `onResolve` 的 `alwaysAllow` 修正为可选 + `onOpenSession` 补充 `string` 注解
- [x] PATCH-4 SettingsPanel.tsx — `AgentManager` 补充 `onClose` 必选属性
- [x] PATCH-5 files.ts — 数组初始化补充 `Array<{ name: string; content: string }>` 类型声明
- [x] PATCH-6 验证 — `tsc --noEmit` 零错误 + `vite build` 成功 + 重新构建安装包推送 GitHub

### v0.99.0 已发布（2026-08-14）— 对标 DeepSeek Harness 全量升级

#### P0 — 架构基础（对标 dsh 内核范式）
- [x] P0-1 事件溯源会话日志（`event-types.ts` + `event-log.ts` + `event-projection.ts`）
  - [x] 14 种 SessionEvent 类型定义（user_message / assistant_text / assistant_reasoning / tool_call / tool_result / compaction / turn_start / turn_end / memory_update / session_meta / permission_granted / permission_denied / error / abort）
  - [x] `session_events` DB 表（append-only，seq 自增，session_id + event_type + payload + timestamp）
  - [x] `deriveMessages()` 投影函数（从事件流投影出 LLM 消息列表）
  - [x] Fork 支持（从任意历史点 fork 新会话）
  - [x] Replay 支持（从事件流重放重建完整状态）
  - [x] 运行时不变量（"模型可见即已记录" 断言）
  - [x] 双写过渡期（旧 CRUD + 新事件流同时写入，messages 表保留为 fallback）
- [x] P0-2 5 层工具管线（`tool-pipeline.ts`）
  - [x] 第 1 层 pre-execute（waterfall）：hooks + permission + bash-analyzer → 可 deny/modify
  - [x] 第 2 层 monotonic guards（frozen order）：sandbox + 受保护路径 + 覆盖保护 → 不可重排序
  - [x] 第 3 层 execute（waterfall）：tool.execute() + 超时 + 重试 + metrics
  - [x] 第 4 层 post-execute（waterfall）：hooks → result accept/reject/replace/append
  - [x] 第 5 层 finalize（freeze）：finalizeContent → 写入事件流 → 返回权威结果
  - [x] `streaming-executor.ts` 全量路由通过管线（executeSingle + executeBatch）
  - [x] 管线错误重新抛出确保 `tool_error` 事件正确发送
  - [x] `agentic-loop.ts` 移除冗余 permission/plan 检查（已由管线处理）
- [x] P0-3 Plan Mode 增强（`exit-plan-mode.ts` + `PlanApprovalCard.tsx`）
  - [x] `exit_plan_mode` 工具定义（plan_markdown 参数，提交计划给用户审批）
  - [x] `setPlanApprovalCallback` / `clearPlanApprovalCallback` 回调注册
  - [x] `PlanApprovalCard` UI 组件（createPortal 弹窗，Approve/Reject + 反馈输入）
  - [x] 提示词对齐 dsh 6 段规范（模式声明 / 探索优先 / 工具目录不变 / ask_user 限制 / 计划完整性 / exit_plan_mode 调用方式）
  - [x] App.tsx 集成 exit_plan_mode 回调 + PlanApprovalCard 渲染
- [x] P0-4 测试覆盖率门控（`vitest.config.ts`）
  - [x] v8 coverage provider 配置
  - [x] per-file 阈值（lines/functions/branches/statements 70%）
  - [x] exclude 配置（src/test/** + src/**/*.d.ts）

#### P1 — 功能增强
- [x] P1-5 进程级沙箱
  - [x] Windows ACL 沙箱路径检查
  - [x] `SandboxGuard` 中间件集成到 5 层管线第 2 层（monotonic guards）
  - [x] `PlanModeGuard` 中间件（Plan 模式下拦截 write/edit 工具）
- [x] P1-6 Code Mode（`run-code.ts`）
  - [x] TypeScript 代码执行工具
  - [x] `ToolSDK` 接口（bash / read / write / glob / grep / fetch）
  - [x] 超时保护（默认 30s，可配置）
  - [x] console 代理（log/error/warn/info 重定向到 stdout/stderr）
  - [x] async IIFE 包装执行
- [x] P1-7 Session Query（`session-search.ts`）
  - [x] SQLite FTS5 虚拟表（session_fts: session_id / message_id / content / role / timestamp）
  - [x] `session_search` LLM 工具（FTS5 查询语法：短语/布尔/前缀/NEAR）
  - [x] 消息自动索引（`message.ts` createMessage 中写入 FTS5）
  - [x] 返回匹配消息片段 + 会话标题
  - [x] FTS5 表创建隔离（database.ts 独立 try-catch，兼容浏览器环境）
- [x] P1-8 防御性模式文档（`docs/defensive-patterns.md`）
  - [x] 7+ 条防御规则文档化
- [x] P1-9 Agent Notes/ADR（`docs/adr/`）
  - [x] `0001-event-sourcing.md` — 事件溯源决策记录
  - [x] `0002-tool-pipeline.md` — 工具管线决策记录
  - [x] `0003-plan-mode-alignment.md` — Plan Mode 对齐决策记录

#### P2 — 架构提升 + 功能补齐
- [x] P2-10 Capability Seam（`seam/types.ts` + `local-fs-provider.ts` + `local-shell-provider.ts`）
  - [x] `SeamServiceDefinition<T>` 接口定义（契约）
  - [x] `SeamProvider` 接口（id + isAvailable）
  - [x] `SeamConsumer` 接口（seamName）
  - [x] `SeamRegistry` 注册表（registerDefinition / registerProvider / getProvider / hasProvider）
  - [x] `FileSystemSeam` + `LocalFsProvider`（readFile / writeFile / listDirectory / exists）
  - [x] `ShellSeam` + `LocalShellProvider`（executeCommand）
  - [x] `initDefaultSeams()` 应用初始化（App.tsx 调用）
  - [x] `read` 工具通过 `readViaSeam` fallback 访问文件系统
- [x] P2-11 Workflow 编排（`workflow-engine.ts`）
  - [x] `workflow` LLM 工具定义（code 参数）
  - [x] `WorkflowSDK` 接口（spawn / wait / bash / read / write）
  - [x] 并行 fan-out 子智能体支持
  - [x] 复用 `executeCode` 执行引擎
- [x] P2-12 Goal 自动续行（`goal/goal.ts` + `goal-tools.ts`）
  - [x] `goals` DB 表（id / sessionId / title / description / status / priority / successCriteria / createdAt / updatedAt）
  - [x] `createGoal` / `getGoal` / `listGoals` / `updateGoal` 管理器
  - [x] `create_goal` / `get_goal` / `update_goal` 三个 LLM 工具
  - [x] 优先级（low / normal / high）+ 状态（in_progress / completed / failed / cancelled）
- [x] P2-13 Snapshot 测试（`replay-adapter.ts`）
  - [x] `ReplayAdapter` 类（recordMode + replayMode）
  - [x] `fingerprintRequest` 指纹匹配（model + messages hash + tools hash）
  - [x] `addResponse()` 内存快照（无需文件 I/O）
  - [x] 完整 `LLMProvider` 实现（name / listModels / isConfigured / complete / completeStream）
  - [x] `vitest.snapshot.config.ts` 配置文件
- [x] P2-14 Telemetry（`telemetry/telemetry.ts`）
  - [x] `TelemetryEvent` 类型定义
  - [x] `TelemetryCollector` 类（record / flush / batch 50 / 5s 定时）
  - [x] `telemetry_events` DB 表
  - [x] `PerformanceDashboard` UI 组件（总览 / 趋势图 / 会话统计 / 时延 P50/P95）
  - [x] OTel JSON 导出
  - [x] 自动刷新（10s）
  - [x] Sidebar 入口按钮
- [x] P2-15 代码质量工具
  - [x] `knip.json` 配置（死代码检测）
  - [x] `.jscpd.json` 配置（重复代码检测）
  - [x] `package.json` verify 脚本（vitest run --coverage && knip && jscpd）
- [x] P2-16 Bash 后台模式（`job-manager.ts` + `job-tools.ts`）
  - [x] `JobManager` 类（start / getOutput / kill / listJobs）
  - [x] `jobs` DB 表
  - [x] `job_list` / `job_output` / `job_kill` 三个 LLM 工具
  - [x] `background: true` 参数支持
- [x] P2-17 终端 LLM 工具组（`terminal-tools.ts`）
  - [x] `TerminalManager` 类（open / send / signal / close / list）
  - [x] `terminal_open` / `terminal_send` / `terminal_signal` / `terminal_close` 四个 LLM 工具
  - [x] 与 xterm.js PTY 共享会话（CustomEvent 通信）
- [x] P2-18 测试分层补齐
  - [x] `vitest.e2e.config.ts` 配置文件
  - [x] `vitest.snapshot.config.ts` 配置文件
  - [x] `package.json` test:e2e / test:snapshot 脚本
- [x] P2-19 Postmortem 体系（`docs/postmortem/README.md`）
  - [x] 事故复盘文档模板

#### P3 — 远期完善
- [x] P3-20 MCP 市场（`mcp-registry-catalog.ts` + `McpMarketplace.tsx`）
  - [x] `MCPRegistryEntry` 类型定义（id / name / description / category / transport / command / args / env）
  - [x] `MCPCategory` 分类（filesystem / database / search / developer-tools / communication / productivity / data / cloud / other）
  - [x] 30+ 预设 MCP 服务器目录
  - [x] `getCatalog` / `getCategories` / `searchCatalog` / `installCatalogEntry` / `uninstallCatalogEntry` / `isEntryInstalled`
  - [x] `McpMarketplace` UI 组件（搜索 + 分类筛选 + 安装/卸载 + 状态追踪）
  - [x] McpManager 集成入口
- [x] P3-21 语音 STT/TTS（`useSpeechRecognition.ts` + `useSpeechSynthesis.ts` + `VoiceSettingsPanel.tsx`）
  - [x] `useSpeechRecognition` Hook（Web Speech API STT，实时识别 + 连续模式 + 语言跟随 i18n）
  - [x] `useSpeechSynthesis` Hook（Web Speech API TTS，语音选择 / 语速 / 音调 / 音量）
  - [x] `VoiceSettingsPanel` 设置面板（语音选择 + 参数配置 + 试听 + 云端 TTS 优先级）
  - [x] SettingsPanel 新增"语音"标签页
- [x] P3-22 Ollama 本地 LLM（`ollama-provider.ts` + `OllamaSettingsPanel.tsx`）
  - [x] `OllamaProvider` 类（实现 `LLMProvider` 接口）
  - [x] REST API 连接（GET /api/tags 获取模型列表）
  - [x] OpenAI 兼容端点推理（POST /v1/chat/completions）
  - [x] streaming + non-streaming 支持
  - [x] 健康检查（`checkConnection`）
  - [x] `OllamaSettingsPanel` UI（Base URL + 连接检测 + 自动检测 + 模型列表）
  - [x] SettingsPanel 新增"Ollama"标签页
- [x] P3-23 CI/CD 管理（`cicd/pipeline.ts` + `CicdPanel.tsx`）
  - [x] `generateWorkflow` — 根据项目类型生成 GitHub Actions YAML（node / python / rust / go / java / generic）
  - [x] `listWorkflowRuns` — 获取最近 workflow runs（GitHub API）
  - [x] `getWorkflowJobs` — 获取 workflow job 详情
  - [x] `retryWorkflowRun` / `cancelWorkflowRun` — 重试/取消
  - [x] `triggerWorkflowDispatch` — 手动触发
  - [x] `CicdPanel` UI（仓库输入 + 状态概览 + run 列表 + job 展开 + YAML 模板生成 + 自动刷新）
  - [x] Sidebar 入口按钮
- [x] P3-24 技能安全沙箱（`skill/sandbox.ts` + `SkillAuditDialog.tsx`）
  - [x] `AuditLevel` 类型（safe / warning / danger）
  - [x] `auditSkill` 函数（内容预检：远程脚本 / iframe / eval / document.cookie / fetch 恶意调用）
  - [x] `validatePermissions` 函数（权限声明验证）
  - [x] `InstallAuditEntry` 类型 + 安装审计日志
  - [x] 哈希签名验证（`hashSkillContent`）
  - [x] `SkillAuditDialog` UI（safe 直接安装 / warning 确认 / danger 阻止）
- [x] P3-25 远程同步引擎（`sync-engine.ts`）
  - [x] `RemoteBackendType` 类型（supabase / rest-api / none）
  - [x] `SyncConfig` 配置（后端类型 / URL / Key / 自动同步 / 间隔 / 方向 / sessionIds）
  - [x] `SyncState` 状态（lastPushedSeq / lastPulledSeq / lastSyncTime / error）
  - [x] push（本地新事件 → 远程）
  - [x] pull（远程新事件 → 本地）
  - [x] last-write-wins 冲突解决
  - [x] 自动同步定时器
- [x] P3-26 i18n 提示词重构（`prompt/i18n-templates.ts`）
  - [x] `PromptTemplates` 接口（17 个模板段：identity / language / personality / formatting / finalAnswer / scriptExecution / fileEditing / dirtyWorktree / workingUpdates / parallelToolCalls / contextManagement / corrections / autonomy / memory / safety / collaborationModePlan / collaborationModeDefault / safetyRules / languageRule）
  - [x] `getPromptTemplates(lang)` 函数
  - [x] `ZH_TEMPLATES` + `EN_TEMPLATES` 完整双语模板
  - [x] `prompt.ts` 改为调用 `getPromptTemplates()`
  - [x] 测试期望更新（英文 → 中文 prompt 对齐）
- [x] P3-27 Adaptive Idle Tracker（`idle-tracker.ts`）
  - [x] `IdleTracker` 接口（pulse / expired / idleMs / dispose）
  - [x] `createIdleTracker` 工厂函数
  - [x] 只在无数据流入时计时（收到数据 pulse 重置）
  - [x] `provider.ts` 集成 idle tracker
- [x] P3-28 事件系统增强（`hook-types.ts`）
  - [x] 新增 `GuardHook` 类型（monotonic guard 层钩子）
  - [x] 新增 `FinalizeHook` 类型（finalize 层钩子）
- [x] P3-29 消息存储增强（`message.ts`）
  - [x] FTS5 自动索引（createMessage 中写入 session_fts 表）
  - [x] 事件流双写（createMessage 同时写入 session_events 表）
- [x] P3-30 数据库初始化修复（`database.ts`）
  - [x] FTS5 表创建隔离（独立 try-catch，兼容浏览器环境 sql.js asm 版本）
  - [x] `session_events` 表新增
  - [x] `goals` 表新增
  - [x] `jobs` 表新增
  - [x] `telemetry_events` 表新增

#### 测试
- [x] `tool-pipeline.test.ts` — 5 层管线功能测试
- [x] `s0-pipeline-integration.test.ts` — 管线集成测试（hooks / permissions / plan mode）
- [x] `s0-seam-integration.test.ts` — Seam 注册表和 provider 集成测试
- [x] `s0-regression-full.test.ts` — S0 变更影响链全量回归测试
- [x] `event-sourcing.test.ts` — 事件溯源测试
- [x] `replay-adapter.test.ts` — Replay 适配器测试
- [x] `sync-engine.test.ts` — 远程同步引擎测试
- [x] `skill-sandbox.test.ts` — 技能安全沙箱测试
- [x] `mcp-marketplace.test.ts` — MCP 市场测试
- [x] `ollama-provider.test.ts` — Ollama Provider 测试
- [x] `useSpeechRecognition.test.ts` — 语音识别 Hook 测试
- [x] `useSpeechSynthesis.test.ts` — 语音合成 Hook 测试
- [x] i18n 测试期望更新（`git-env-config.test.ts` + `refactor-prompt-to-data.test.ts`）
- [x] 全量 99 文件 / 3234 用例全部通过

#### 补丁修复 — 上下游关联修复（同版本重新构建 2026-08-14）
- [x] **provider.ts `toAPIMessage`** — 补全 `ContentBlock[]` 中 `tool_use`/`tool_result` 块的处理：事件投影路径产生的工具调用信息不再丢失（从 `tool_use` 块提取 `tool_calls`，从 `tool_result` 块生成 `tool` 角色消息，与 `ollama-provider.ts` 实现对齐）
- [x] **agentic-loop.ts `buildMessages` 事件投影映射** — 补全 `tool_calls`（OpenAI snake_case）属性生成：下游 `selectMessagesByPriority`、孤儿工具消息过滤、`micro-compact` 工具名称映射全部恢复正常工作；`tool_result` 消息正确保持 `tool` 角色和 `toolCallId`
- [x] **tools.ts `readViaSeam` + local-fs-provider.ts `readFile`** — 相对路径 `cwd` 解析修复：`LocalFileSystemProvider.readFile` 不再忽略 `cwd` 参数，`readViaSeam` 回退路径也正确解析相对路径
- [x] 测试更新：`event-sourcing.test.ts` 断言改为检查 `ContentBlock tool_use` 块（匹配新数据模型）+ `s0-seam-integration.test.ts` mock 数据和断言对齐实际实现
- [x] 全量 99 文件 / 3235 用例全部通过

#### P0 — Agentic Loop 性能优化（上下文膨胀治理）
- [x] P0-1 Tool Result 磁盘持久化（`tool-result-storage.ts`）
  - [x] 超大工具输出（>4KB）自动落盘到 `~/.codem/tool-results/`
  - [x] 上下文中仅保留摘要 + 文件路径引用
  - [x] agent 可按需 `read_file` 回读完整结果
  - [x] disk-full 降级到截断模式
- [x] P0-2 ToolSearch 延迟加载（`tool-search.ts` + `tools/lsp-tool.ts`）
  - [x] LSP 等重型工具标记 `shouldDefer: true`
  - [x] ToolRegistry 新增 `getCoreDefinitions()` / `getDeferredDefinitions()` / `getDeferredDefinition()`
  - [x] `tool_search` 工具按名称/关键词搜索 deferred 工具的完整 schema
  - [x] TranscriptCache key 包含 `toolNames` 防止缓存不匹配
  - [x] Deferred 工具提示注入 system prompt
- [x] P0-3 Micro-Compact 摘要（`micro-compact.ts`）
  - [x] 上下文使用率超过 80% 时自动触发 LLM 摘要压缩
  - [x] 旧对话轮次压缩为 1-2 段摘要
  - [x] JSON 修复提取 + 重试降级
  - [x] 摘要前后 token 计数
- [x] P0-4 TranscriptCache 修复
  - [x] 缓存 key 新增 `toolNames` 字段

#### P1 — 工具系统增强
- [x] P1-5 工具中断行为（`streaming-executor.ts`）
  - [x] 每个工具调用拥有独立 `AbortController`
  - [x] 并发工具独立中断 + 顺序工具逐一中断
  - [x] `StreamingToolCall` 新增 `abortController` 字段
- [x] P1-6 Bash 命令分析器（`permission/bash-analyzer.ts`）
  - [x] 解析 bash 命令的风险等级（safe/caution/dangerous）
  - [x] 操作类型（read/write/execute/network）
  - [x] 目标路径提取
- [x] P1-7 Hooks 系统（`hooks/hook-manager.ts` + `hook-types.ts`）
  - [x] pre-tool / post-tool / pre-message / post-message 四种钩子类型
  - [x] 安全审计、自动日志、工具拦截
- [x] P1-8 TodoWrite 增强（`tools/show-todo.ts`）
  - [x] 优先级排序 + 状态过滤 + 嵌套缩进
- [x] P1-9 Forked Agent（`llm/index.ts`）
  - [x] 新增 `spawnForked()` 方法，复用父对话 messages 前缀
  - [x] provider prompt cache 命中降低 input token 成本
  - [x] `extractMemoriesFromSession` 改用 forked agent
  - [x] 深拷贝 messages 防止 msgCache 污染
  - [x] 独立 AbortController

#### P0 — 技能市场三大新源接入
- [x] ClawHub.ai（`clawhub-api` 类型）
  - [x] REST API `GET /api/v1/skills` 获取技能列表
  - [x] 支持 Bearer Token 认证
- [x] Skills.sh（`skills-sh-api` 类型）
  - [x] REST API `GET /api/v1/skills?view=all-time` 获取 Top 100
  - [x] Vercel OIDC Token 认证 + 401 错误处理
- [x] SkillHub 腾讯云（`cli` 类型）
  - [x] `skillhub search --json` 获取技能列表
  - [x] `skillhub install <name>` 安装技能
  - [x] JSON + 表格两种输出格式解析
  - [x] CLI 不可用时优雅降级
- [x] MarketSource 新增 `cliCommand` / `apiToken` 字段
- [x] MarketSourceType 从 3 种扩展到 6 种

#### P0 — 技能发布功能
- [x] `publishSkillToMarket()` 统一发布入口
  - [x] ClawHub：`clawhub skill publish --slug --name --version --changelog --tags`
  - [x] GitHub：`git init` → `git add -A` → `git commit` → `gh repo create --push`
  - [x] CLI：通用 `<cliCommand> publish` / `upload` 命令适配（自动 fallback）
- [x] `listPublishableMarkets()` 检查市场就绪状态
- [x] `dryRunPublish()` 支持 ClawHub `--dry-run` 预检
- [x] SkillManager UI 发布按钮 + 发布对话框 + CSS 样式
- [x] CI 命令本地逐条验证通过

#### P0 — CodeGraph 集成测试
- [x] 新增 `src/test/codegraph-integration.test.ts` — 49 个用例
  - [x] MCP 层（22 用例）：设置读写、索引检测、CLI 检测、自动连接、断开、工具匹配、幂等性
  - [x] Prompt 层（7 用例）：中英文注入、禁用不注入、MCP Tools 共存
  - [x] LLMEngine 集成（6 用例）：导出验证、工具联动
  - [x] 端到端流程（3 用例）：启用→检测→连接→工具→提示词、禁用→不检测、断开→工具消失
  - [x] 边界场景（11 用例）：null/undefined 路径、空格/中文路径、重复设置、双匹配规则、项目切换

#### 验证
- [x] `tsc --noEmit`：零错误
- [x] `vitest run`：72 文件 / 2872 用例全部通过
- [x] `cargo check`：Exit 0
- [x] GitHub Release v0.96.2 安装包已上传（NSIS + MSI）

### v0.96.1 已发布（2026-08-09）

#### P0 — 右侧栏文件浏览器体系重构（对标 wecode FileWorkspacePanel）
- [x] 右侧栏宽度对标 wecode（默认 420px，可调 360-620px，替代原 280-700/344px）
- [x] 移除分栏膨胀逻辑（`Math.max(sidebarWidth, 520)` → 固定宽度，不再挤压主对话窗口）
- [x] 文件预览改为单栏替换模式（占满侧栏宽度 + `← 文件树` 返回按钮）
- [x] 移除 `split-mode` / `right-sidebar-split` / `right-sidebar-tree-pane` 分栏 CSS
- [x] 新增 `right-sidebar-file-preview` / `right-sidebar-back-btn` / `right-sidebar-preview-body` 单栏 CSS
- [x] 右侧栏启动时默认收缩（`rightRailOpen` 初始值 `true` → `false`）

#### P0 — 文件拖拽修复
- [x] 修复 Tauri v2 `dragDropEnabled` 默认拦截 HTML5 拖拽事件（`tauri.conf.json` 设为 `false`）
- [x] 修复 `InputArea` `onDragOver`/`onDragEnter` 缺少 `e.dataTransfer.dropEffect = "copy"` 导致禁止符号
- [x] 修复 `usePaneResize` 拖拽方向反转（左边缘手柄：`delta = startX - clientX` 而非 `clientX - startX`）
- [x] 修复 `handleUp` 使用全局 `event` 变量 bug（改为从 `PointerEvent` 参数获取 `clientX`）

#### P1 — 文件编辑器悬浮窗口（放大浏览）
- [x] 新增 `Maximize2` 按钮 — 点击弹出 90vw × 90vh 悬浮窗口（`createPortal` 渲染到 `document.body`）
- [x] 悬浮窗口含完整文件预览/编辑功能 + `Minimize2` 缩小返回 + `X` 关闭
- [x] 点击遮罩层关闭 + 淡入/缩放入场动画
- [x] 新增 `.file-editor-floating-overlay` / `.file-editor-floating-window` / `.file-editor-floating-header` / `.file-editor-floating-body` CSS

#### P1 — 暗色模式 + 主题修复
- [x] Hub 皮肤强制 `data-theme=dark`（ThemeManager `applySkin` + codem-ui.css `[data-skin="hub"]` 双保险）
- [x] TitleBar DB 初始化后重新读取保存的主题（`dbReady` useEffect 读取 `codem-theme`）
- [x] 暗色模式 CSS 变量体系完善（glass-border / tool-card-border / composer-border / titlebar-btn-hover 等）
- [x] 梦幻皮肤段落 hover 移除（`p:hover background: transparent !important`）+ AI 消息 hover 磨砂高亮
- [x] ShikiCodeBlock 暗色模式代码块背景修复

#### P1 — FileEditor 全格式预览增强
- [x] 图片预览（缩放/旋转）— `FilePreviewImage`
- [x] PDF 预览（iframe data URL）— `FilePreviewPdf`
- [x] Excel 预览（SheetJS 解析表格 + 多 sheet 切换）— `FilePreviewExcel`
- [x] Word 预览（JSZip 解压 docx 提取纯文本）— `FilePreviewWord`
- [x] 视频/音频预览（HTML5 media player）— `FilePreviewMedia`
- [x] HTML 沙箱预览（预览/源码切换）— `FilePreviewHtml`
- [x] 二进制文件提示（系统应用打开）— `FilePreviewBinary`
- [x] 代码编辑器 Shiki 高亮 + 行号 + Tab 缩进 + 自动配对括号 + Ctrl+S 保存

#### P2 — MentionAutocomplete 重写
- [x] 输入 @ 弹出文件列表，支持过滤选择
- [x] 文件/文件夹/笔记本类型图标区分（FileText/FileCode/FileImage/Folder）
- [x] 键盘导航（上下箭头 + Enter 选择 + Esc 关闭）

#### P1 — 应用 Logo 替换 + 安装包图标修复
- [x] 应用 Logo 替换为 `icos/codem.ico`（紫色渐变背景 + 代码括号图标）
- [x] 使用 `sharp` + `png-to-ico` 从 `codem-1024.png` 生成 BMP 格式多尺寸 ICO（16/24/32/48/64/128/256），解决 `tauri icon` 生成的 PNG 格式 ICO 在 Windows 资源编译器下颜色损坏问题
- [x] 生成所有 PNG 图标文件（32x32 / 64x64 / 128x128 / 128x128@2x / icon.png / Square 系列 / StoreLogo）
- [x] `tauri.conf.json` NSIS 配置新增 `installerIcon` 字段，显式指定安装器图标路径
- [x] 全量 `cargo clean` + 重新构建，确保 `resource.lib` 正确嵌入新图标
- [x] 验证安装包图标、codem.exe 图标、icon.ico 三者像素级一致（R=206 G=200 B=227 紫色）
- [x] GitHub Release v0.96.1 安装包已更新为图标修复版

### v0.96.0 已发布（2026-08-08）

#### P0 — 主对话窗口样式大改版（对标 frakio-work / wecode）
- [x] 消息容器居中 + `max-width` 限制 + `gap` 增至 24px
- [x] AI 消息背景改为透明，内联 header 展示角色信息
- [x] 用户消息样式调整，视觉层次分明
- [x] 段落 hover 背景移除，改为消息级 hover 高亮
- [x] 新建 `ShikiCodeBlock.tsx` — VS Code 级语法高亮（Shiki 替换 react-syntax-highlighter）
- [x] 新建 `rich-content/` 渲染系统（9 个组件）：RichContent + ContentFrame + CodeBlockView + HtmlPreviewView + ImagePreviewView + JsonFormatView + MathFormulaView + MermaidCanvasView + TableScrollView + FullscreenViewer
- [x] 新建 `ToolCallCard.tsx` + `ToolCallGroup.tsx` — pill 胶囊风格 + 内联展示 + 同类合并
- [x] 推理过程展示改为胶囊按钮 + 自动折叠（ReasoningDisplay 重构）
- [x] 新建 `MessageActions.tsx` — 消息操作工具栏绝对定位悬浮

#### P0 — 内联 Diff 批量审批（替换弹窗式 DiffViewer）
- [x] 新建 `InlineDiffReview.tsx` — 统一视图 + 预览视图双模式 diff
- [x] 支持折叠/展开 + 自定义指令输入 + "全部接受"批量操作
- [x] `App.tsx` `onWriteConfirm` 回调改造：检查 `autoApprove` 标志
- [x] 多文件审批在同一轮对话中内联展示
- [x] `writeConfirmStats` 状态追踪审批统计

#### P0 — 三皮肤暗色模式深度修复
- [x] 默认皮肤暗色模式：设置面板图标颜色修复（`color: inherit` + 暗色变量覆盖）
- [x] 默认皮肤暗色模式：主对话框背景配色优化，文字对比度提升
- [x] 命令类展示颜色从纯白调整为柔和色
- [x] Hub 皮肤：右侧栏 toggle 与 TitleBar `rightRailOpen` 状态同步
- [x] Hub 皮肤：TopNavbar 移除冗余搜索/设置按钮
- [x] Dream 皮肤：`data-theme` 基于 `palette.isDark` 自适应设置
- [x] Dream 皮肤：`TitleBar` 在 Dream 皮肤激活时跳过 `data-theme` 覆盖
- [x] Dream 皮肤：`applyDreamCSS` 新增 glass/surface/tool-card/composer/rich-code token 覆盖
- [x] 三皮肤统一添加 `--radius-*` / `--border-primary` / `--elevation-*` / `--accent-soft` / `--input-bg` CSS 变量

#### P1 — 梦幻皮肤自适应主题
- [x] `ThemeManager.applyDreamCSS` 根据调色板 `isDark` 自动切换明暗模式
- [x] `ThemeManager.cleanDreamCSS` 恢复用户偏好主题
- [x] 新建 `contrast-checker.ts` — 对比度检查器
- [x] 梦幻皮肤设置面板图标颜色自适应修复

#### P1 — 新增组件（39 个新文件）
- [x] `BootSplash.tsx` — 启动加载画面
- [x] `ToastNotification.tsx` — Toast 通知系统
- [x] `Drawer.tsx` — 通用抽屉组件
- [x] `NewChatPage.tsx` — 新对话首页
- [x] `SpaceSwitcher.tsx` — 工作空间切换器
- [x] `GitBranchSelector.tsx` — Git 分支选择器
- [x] `AudioPlayer.tsx` — 音频播放器
- [x] `ExcelViewer.tsx` — Excel 文件查看器
- [x] `ErrorCard.tsx` — 错误卡片
- [x] `RunStatusBar.tsx` — 运行状态栏
- [x] `ActivityTimeline.tsx` — 活动时间线
- [x] `AgentRoster.tsx` — 智能体花名册
- [x] `ConversationOverview.tsx` — 对话概览
- [x] `UsageVisuals.tsx` — 用量可视化
- [x] `WorkspaceBackdrop.tsx` — 工作区背景
- [x] `DecisionTray.tsx` — 决策托盘
- [x] `SettingsParts.tsx` — 设置面板分区组件
- [x] `ui/overlay-kit.tsx` — Overlay 工具包

#### P1 — 核心引擎增强
- [x] `run-status-tracker.ts` — 运行状态追踪器
- [x] `stream-reveal.ts` — 流式内容逐步揭示
- [x] `useDraftPersistence.ts` — 草稿持久化 Hook
- [x] `usePaneResize.ts` — 面板尺寸调整 Hook

#### P1 — 样式系统
- [x] 新建 `codem-ui.css` — Codem UI 组件专用样式表
- [x] `styles.css` +2,809 行大规模重构
- [x] `skin-dream.css` +333 行
- [x] `skin-hub.css` +300 行

#### P2 — 新依赖
- [x] `framer-motion` — 动画引擎
- [x] `shiki` — VS Code 级语法高亮
- [x] `xlsx` — Excel 文件解析

### v0.95.0 已发布（2026-08-03）

#### Vision Proxy MiMo v2.5 支持
- [x] 修正 `MULTIMODAL_MODELS.mimo.vision`：`[]` → `["mimo-v2.5"]`
- [x] 修正 `modelSupportsVision()`：新增 `mimo-v2.5` 精确匹配（pro 不误判）
- [x] 修正 `resolveVisionConfig()`：从 `getLLMEngine().getProviderConfig()` 获取 CLI 模式 API Key
- [x] `LLMEngine` 新增 `getProviderConfig()` 方法

#### CSP 全面修复
- [x] 新增 `media-src`（视频/音频 data URL）
- [x] 新增 `font-src`（自定义字体打包后加载）
- [x] 新增 `frame-src`（PDF 预览 iframe）
- [x] `img-src` 补充 `blob:`（知识图谱/PPT/记忆导出）
- [x] `connect-src` 补充 `asset.localhost`

#### 梦幻皮肤视频背景打包修复
- [x] 视频元素改为插入 `document.body`
- [x] 设置 `autoplay`/`playsinline` 属性
- [x] `z-index` 改为 `-1`

#### UI 优化
- [x] 花瓣装饰缩小：左上 60px，右下 75px
- [x] README 图片修正：.jpg→.png，移到 screenshots/

#### 仓库清理
- [x] 移除 `.wecode-ref/`、`docs/codex-use-cases/`、`docs/training/`
- [x] 移除 docs/ 下 58 个内部文档

#### 测试
- [x] 13 个 E2E 全场景链路测试（CLI/API + 各模型组合）
- [x] 全量 156 测试通过

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

### v1.7.0 (2026-08-31)
- [x] PPT 生成质量大幅提升 — 集成 oh-my-ppt 项目 74 种风格 SKILL.md + 9 种产品技能（布局/图表/动画等）
- [x] 新增 `ppt-skill-registry.ts` — 通过 Vite `import.meta.glob` 构建时收集所有 SKILL.md，运行时注册到 Cordis SkillRegistry
- [x] 新增 `src/core/knowledge/skills/` 目录 — 存放从 oh-my-ppt 项目同步的 SKILL.md 资源文件（styles/ + products/）
- [x] 修复 PPT 生成链路断点 — `generatePPTContent` 是单次 LLM 调用（非 agentic loop），AI 无法使用 `load_skill` 工具
  - 断点分析：Studio 一键生成和对话中生成两条通路都经过 `generatePPTContent`，内部裸调 `provider.stream()` 无工具循环
  - 修复方案：在调用 LLM 前主动从 SkillRegistry 加载当前选中风格的 SKILL.md 内容，注入 systemPrompt
  - 只加载当前 1 个风格 + 产品技能（layout/chart/anim），不注入全部 74 个风格，避免 token 爆炸
- [x] 删除旧的 `ppt-skill-loader.ts`（直接注入全部风格到 systemPrompt 的方案，会导致 token 爆炸）
- [x] TypeScript 编译零错误 + Lint 零错误
- [x] Release v1.7.0 发布

### v1.9.0 (2026-08-31)
- [x] 上下文压缩过早触发治根修复 — TokenTracker.estimateMessagesTokens 永不回落 + 动态 provider 模型窗口 128k + 工具定义双算三根因
- [x] getAgenticLoop 构造时同步 contextWindow，避免构造期回退 128k
- [x] 通用协议 API 配置（OpenAI 兼容）：设置页手动输入 Base URL + API key → 自动拉模型列表 → 持久化
- [x] 刷新模型列表不再丢弃 contextWindow 字段（SettingsPanel 动态模型 state 补全窗口字段 + inferContextWindow 写入）
- [x] 新增 getFirstConfiguredModel() 初始模型 fallback + resolveProviderForModel() 自定义 provider 模型路由
- [x] read 单响应去重键含 offset/limit（readCache 已区分范围但去重层未区分）
- [x] DecisionTray 审批内容空白修复 — App.tsx 读 req.args 改为 req.input
- [x] 新增 context-window-regression.test.ts（8 例）+ custom-provider-config.test.ts
- [x] Release v1.9.0 发布

### v1.9.1 (2026-09-01)
- [x] 对话任务步数计算对标改造（codex 宏观计划步）— total 固定为计划步数不再随 iteration 膨胀 + 侦查类工具（read/glob/grep/tool_search）不推进步骤 + 执行类工具首次出现才推进 + 追加步骤仅在新执行阶段出现时发生
- [x] 步骤标题语义化（中文）— getToolTitle 全量中文化（读取文件/写入文件/修改文件/执行命令/运行测试/委派子智能体等）
- [x] 文件树显示隐藏文件夹 — Rust list_directory 新增 show_hidden 参数（默认 false，LLM 工具调用不受影响）+ FileExplorer 传 true（右侧边栏/PanelSidebar/主面板文件 Tab 统一生效）
- [x] 输入框高度收缩修复 — textarea absolute+inset:0，删除多行内容后高度卡旧值；测量前重置 wrapper/textarea 到 minH
- [x] 安全模式切换按钮修复 — 编辑框底部「请求批准/替我审批/完全访问」portal 下拉菜单外部点击误判，新增 dropdownRef 排除判定
- [x] 新增 step-progress-macro.test.ts（6 例）+ file-tree-hidden.test.ts（4 例）
- [x] 全量 117 文件 / 3960 用例通过，tsc --noEmit 零错误，cargo check 通过
- [x] Release v1.9.1 发布
