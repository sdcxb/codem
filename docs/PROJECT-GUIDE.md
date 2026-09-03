# Codem 项目完整说明

> **用途**：新对话快速理解项目全貌、架构、文件关联、当前状态。
> 创建时间：2026-07-23 | 最后更新：2026-09-02 | 当前版本：v1.9.6（打包版运行问题修复：CSP blob:/ipc: + YAML 清理 + 解析降噪 + subagent 激活竞态）
>
> **版本历程概览**：v0.70 基础存储 → v0.80 轮次架构 → v0.87 Worktree/并行 → v0.88 桌面宠物 → v0.89 跨会话委派 → v0.90 P0-P4 全量功能 → v0.91 Coding 工作台 → v0.92 Codex 对标 → v0.93 Vision Proxy → v0.94 配置修复 → v0.95 CLI/API 视觉代理 → v0.96 UI 大改版 → v0.97 Agentic Loop 性能优化 → v0.98 多智能体协同 → v0.99 DSH 全量升级 → v1.0.0 插件系统架构 + UI/UX 标准化 → v1.1.0 DSH 对标整改 + 测试深化 → v1.1.1 UI 布局优化 + 插件条件渲染 + Bug 修复 → v1.2.0 Cordis 架构对齐 DSH + 安全加固 + 全量测试重构 → v1.3.0 Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐 → v1.4.0 UI/UX 体验优化 11 项 Bug 修复 + 性能/CI-CD 面板切换化 + 梦幻皮肤一致性修复 → v1.4.1 插件管理初始化修复 + 技能市场性能优化 + 对话区域自适应 9 项 Bug 修复 → v1.4.2 10 项 Bug 修复 + Cordis 插件时序改进 + SlotBridge 降级机制增强 + 头像系统升级 → v1.5.0 Cordis "一切插件化" 工具发现机制 — ToolDef guidance + toolsProvider 自动注册 systemPrompt section + buildSystemPrompt 动态收集 + 31 个工具补充 guidance + skill-creator 技能安装增强 → v1.5.1 DSH 架构对标深度整改 + YAML 声明式插件加载 + LLM 回答重复根因修复 + llmEngine/mimoAuth 注册修复 + SlotBridge/SlotRenderer 对标 DSH 重写 → v1.5.2 大文件流式分页读取 + Agent Loop 无上限改造（对标 DSH） + 模型系统动态化 + Skills 市场增量搜索 → v1.5.3-v1.5.4 引导消息立即注入 + Markdown 文件路径超链接 + 任务完成标签稳定显示 + 技能市场优化（GitHub API 目录下载） → v1.5.5 Compaction 并发写入治根修复（对标 DSH compactSurfaceRegion） + Bash 缓存失效修复 → v1.6.0 SubagentRuntime 架构重构（对标 DSH） + 技能市场 Trees API 改造（移植 vercel-labs/skills 官方 CLI） + GitHub Token 链路修复 → v1.6.1 桌面宠物独立窗口改造（Cordis Provider 封装） + 文件输出标识增强（DSH 风格 FileMentions） + 设置版本号动态化 → v1.6.2 大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复 → v1.7.0 PPT 生成质量大大幅升 — oh-my-ppt 74 种风格 SKILL.md 集成 + Cordis SkillRegistry 渐进式加载 + 生成链路断点修复 → v1.8.0 知识图谱 React Flow 重构 + vision-proxy 统一 getConfiguredProvider + UI 字体变量批量规范化 → v1.9.0 上下文压缩过早触发治根修复（模型感知窗口 + 压力驱动 micro-compact）+ 通用协议 API 配置 + 工具执行正确性修复（read 去重范围键 / 审批内容修复） → v1.9.1 对话任务步数计算对标改造 + 文件树显示隐藏文件夹 + 输入框/安全按钮修复 + 数据库持久化加固 + PowerShell 命令修复 → v1.9.2 LLM 请求级超时加固 + 安全模式按钮颜色反馈 + 引导消息注入体验改造 + LLM 失败可见性（对标 DSH 结构化失败上报） → v1.9.3 安全模式完全访问修复（dbReady 时序 + 委派遵循用户模式 + write 拒绝误判）+ 工具调用配对修复（API 400）+ 输入框历史 wrap 折行修复 + 引导栏 UI 对标 wecode + 思考过程紫色样式恢复 → v1.9.4 dsh-desktop 全面对标稳健性审计修复（15 轮：崩溃标记/渲染崩溃兜底/运行时文件日志/持久化失败可见性/命令超时杀树/PowerShell 转义/统一脱敏与超时） → v1.9.5 对话步骤语义化与 update_plan 动态插入（对标 dsh todo）+ token 消耗审计修复（read 上限/工具 defer/结果裁剪/窗口预算/折叠摘要）+ 全面功能审计修复（PTY 树杀/超时补全/托盘退出 flush） → v1.9.6 打包版运行问题修复（CSP blob:/ipc: 修复嵌入 WASM 与 IPC 回退/YAML 清理/解析降噪/知识摘要降级/subagent 激活竞态）

---

## 一、项目概述

**Codem** 是对标 Codex 的 AI 编程助手桌面应用，基于 Tauri v2 + React + TypeScript 构建。

- **产品名**：Codem（`com.codem.app`）
- **GitHub**：https://github.com/sdcxb/codem
- **分发**：NSIS `.exe` + WiX `.msi`，一键安装无需依赖
- **平台**：Windows 优先
- **版本**：v1.9.6（打包版运行问题修复：CSP blob:/ipc: + YAML 清理 + 解析降噪 + subagent 激活竞态，2026-09-02）

---

## 二、技术架构

### 2.1 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| **桌面框架** | Tauri v2 (Rust) | 原生窗口 + 文件系统 + 命令调用 + 多窗口（主窗口 + 宠物窗口） |
| **前端框架** | React 18 + TypeScript | SPA，Vite 构建 |
| **状态管理** | Zustand 5 | 三个 store：`useAppStore`（消息/流式/工具）+ `useProjectStore`（项目/会话/技能）+ `usePetStore`（宠物状态/气泡/窗口） |
| **UI 组件** | Radix UI + Lucide React + Font Awesome + Framer Motion | Switch/Dialog/Tooltip/Popover/Dropdown + 图标库 + 动画引擎 |
| **Markdown** | react-markdown + remark-gfm + remark-math + rehype-katex + Shiki | 消息渲染 + VS Code 级语法高亮 + 数学公式 |
| **图表** | Mermaid 11 | 技能内置 Mermaid SVG 渲染 |
| **终端** | xterm.js (@xterm/xterm + addon-fit + addon-web-links) | CLI 模式终端 |
| **存储** | SQLite (sql.js) | 内存数据库 + Tauri 文件系统持久化到 AppData |
| **嵌入模型** | ONNX Runtime (WASM) + @huggingface/transformers | 本地语义嵌入，零外部依赖 |
| **文档解析** | mammoth + pdfjs-dist + xlsx | DOCX/PDF/Excel 文档内容提取 |
| **数学公式** | KaTeX | Markdown 中的 LaTeX 公式渲染 |
| **压缩** | fflate | 技能 ZIP 包解压 |
| **桌面宠物** | Petdex (MIT License) 集成 | 宠物包格式 + 市场 Manifest API + 精灵图帧动画 |
| **Tauri 前端 API** | @tauri-apps/api + plugin-dialog + plugin-notification | IPC 通信 + 原生对话框 + 系统通知 |
| **依赖注入** | Cordis DI 容器 | SlotRegistry + 18 Capability Seam + Plugin Loader |
| **插件系统** | Plugin Loader + Plugin Market | 拓扑排序加载/卸载 + 生命周期管理 + 插件市场 |
| **终端** | portable-pty 0.8 (Rust) | PTY 交互式终端 — spawn/write/resize/close |
| **测试** | Vitest 4 + happy-dom + jsdom | 单元/快照/E2E/模糊/属性/契约/链路探针测试 |

### 2.2 前端依赖

```
React 18 + Zustand 5 + Radix UI + Lucide React + Font Awesome 7 + Framer Motion
react-markdown + remark-gfm + remark-math + rehype-katex + Shiki (VS Code 级语法高亮)
sql.js (SQLite) + @huggingface/transformers (ONNX)
mermaid + @xterm/xterm + addon-fit + addon-web-links + fflate + clsx + tailwind-merge
mammoth (DOCX) + pdfjs-dist (PDF) + xlsx (Excel) + katex (数学公式)
@tauri-apps/api + @tauri-apps/plugin-dialog + @tauri-apps/plugin-notification
```

**devDependencies:** TypeScript 5.6 + Vite 6 + Vitest 4 + happy-dom + jsdom + png-to-ico + sharp
**v0.96.0 新增:** framer-motion (动画引擎) + shiki (语法高亮) + xlsx (Excel 解析)
**v0.96.1 新增:** createPortal (React DOM 悬浮窗口渲染)
**v0.97.0 新增:** portable-pty (PTY 终端交互) + Cordis DI 容器框架
**v0.98.0 新增:** 多智能体协同架构（Squad/Issue/Inbox/Autopilot 扩展）
**v0.99.0 新增:** 事件溯源 + 5 层工具管线 + Capability Seam + Telemetry + Ollama Provider + 语音 STT/TTS
**v1.0.0 新增:** Cordis DI 容器 + Plugin Loader + 18 Capability Seam + UI 插件包化
**v1.1.0 新增:** compaction-control / output-contract / feedback / type-safety / event-system-strict / runtime-invariants / request-header / postmortem / sandbox-acl / instruction-layers / dynamic-plugin-tools / test-layers / token-tracker / spill-policy / spill-store / surface-manager / repeat-tool-reminder / time-context / preset-discovery / persistence-provider
**v1.1.1 新增:** 插件条件渲染联动 + UI 布局调整 + 全工具 execute null 检查防御

### 2.3 Rust 依赖

```
tauri 2 (devtools + tray-icon + image-png)
tauri-plugin-shell/dialog/fs/notification
reqwest (HTTP 代理，json + stream) + tokio (async runtime, full)
futures-util + tokio-util (io)
serde/serde_json + uuid + window-vibrancy (Mica/Acrylic)
rfd (原生文件对话框) + open (打开文件/URL)
base64 + x25519-dalek (加密) + sha2 + aes-gcm + rand
hostname (设备标识)
windows (Win32 API: SetWindowPos 单次调用原子设置窗口位置+尺寸)
portable-pty 0.8 (PTY 交互式终端 — spawn/write/resize/close)
url 2 (URL 解析 — 浏览器预览面板)
regex (正则表达式 — 沙箱路径模式匹配)
```

### 2.4 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        Tauri 原生窗口                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    React 前端 (SPA)                         │  │
│  │                                                            │  │
│  │  App.tsx ─ 主应用 (状态管理 + 事件处理 + handleSend)        │  │
│  │  ├── Sidebar.tsx ─ 左侧栏 (项目/会话列表/导航/Inbox未读角标) │  │
│  │  ├── ChatPanel.tsx ─ 对话面板 (消息列表 + InputArea + P1-P4) │  │
│  │  │   ├── MessageBubble.tsx ─ 消息气泡 (memo + 图片画廊 + 视频 + 反馈)│  │
│  │  │   └── InputArea.tsx ─ 输入区 (底部控制栏 + @提及 + 上下文徽章)│  │
│  │  ├── RightSidebar.tsx ─ 右侧栏 (文件浏览器/活跃任务/GitInfo) │  │
│  │  ├── SettingsPanel.tsx ─ 设置面板 (10+Tab，含宠物/CodeGraph) │  │
│  │  ├── PetWindowApp.tsx ─ 独立宠物窗口 (透明/置顶/精灵图动画)  │  │
│  │  ├── PetSprite.tsx ─ 宠物精灵图帧动画渲染                    │  │
│  │  ├── PetMarketDialog.tsx ─ 宠物市场 (Petdex API)             │  │
│  │  ├── TopNavbar.tsx ─ 顶部导航 (皮肤/布局切换)              │  │
│  │  └── DreamLayout.tsx / HubLayout.tsx ─ 皮肤布局            │  │
│  │                                                            │  │
│  │  核心引擎层 (src/core/)                                     │  │
│  │  ├── llm/ ─ LLM 引擎 (Provider/AgenticLoop/Tools/Spill/     │  │
│  │  │              TokenTracker/CompactionControl/             │  │
│  │  │              RuntimeInvariants/RequestHeader/            │  │
│  │  │              Postmortem/AgentMessageQueue/               │  │
│  │  │              OutputContract/Feedback/TypeSafety/         │  │
│  │  │              EventSystemStrict/Cookbook/                 │  │
│  │  │              SurfaceManager/RepeatToolReminder/          │  │
│  │  │              TimeContext/TestLayers/                     │  │
│  │  │              DynamicPluginTools)                         │  │
│  │  ├── subagent/ ─ 子智能体 spawn/wait                       │  │
│  │  ├── context/ ─ 上下文管理 + token计数 + 压缩              │  │
│  │  ├── memory/ ─ 三级记忆 (project/session/global)          │  │
│  │  ├── permission/ ─ 权限系统 + 安全模式                     │  │
│  │  ├── environment/ ─ Git Worktree + 执行模式 + FileChange    │  │
│  │  ├── pet/ ─ 桌面宠物 (Petdex集成/状态映射/气泡/市场)        │  │
│  │  ├── automation/ ─ 自动任务 (定时器/文件监听/Cron引擎)     │  │
│  │  ├── knowledge/ ─ 知识管理 (RAG + 笔记 + 闪卡 + 图谱 + PPT)  │  │
│  │  ├── skill/ ─ 技能系统 (SKILL.md + 注册 + 安全沙箱)        │  │
│  │  ├── mcp/ ─ MCP 协议 + CodeGraph + MCP市场                │  │
│  │  ├── theme/ ─ 皮肤系统 (默认/Hub/梦幻)                     │  │
│  │  ├── storage/ ─ 事件溯源 + SQLite 持久化 (EventLog/         │  │
│  │  │              EventProjection/SessionEvents/             │  │
│  │  │              PersistenceProvider/SyncEngine)            │  │
│  │  ├── prompt/ ─ 系统提示词构建 + 指令分层 + i18n模板        │  │
│  │  ├── settings/ ─ 数据层设置 (SettingsSource 层级)           │  │
│  │  ├── recovery/ ─ 会话恢复                                  │  │
│  │  ├── i18n/ ─ 中英文双语                                    │  │
│  │  ├── agent/ ─ Agent定义 + PresetDiscovery                  │  │
│  │  ├── session/ ─ 跨会话委派编排 (Bus/Orchestrator/Executor)  │  │
│  │  ├── sandbox/ ─ 进程级沙箱 ACL (路径/命令/环境变量过滤)    │  │
│  │  ├── hooks/ ─ Hook 系统 (GuardHook/FinalizeHook)           │  │
│  │  ├── goal/ ─ Goal 自动续行 (create/get/update_goal)        │  │
│  │  ├── issue/ ─ Issue 追踪 + 看板 (7状态/4优先级)            │  │
│  │  ├── squad/ ─ 多智能体协同 (Leader-Member/Roster协议)      │  │
│  │  ├── inbox/ ─ 全局通知聚合中心 (6分类)                     │  │
│  │  ├── telemetry/ ─ 遥测采集 + PerformanceDashboard          │  │
│  │  ├── cicd/ ─ CI/CD 管理 (GitHub Actions)                   │  │
│  │  ├── cordis/ ─ Cordis DI 容器 (依赖注入框架)               │  │
│  │  ├── slots/ ─ SlotRegistry (18 Capability Seam 注册表)     │  │
│  │  ├── plugin-loader/ ─ 插件加载器 (拓扑排序/生命周期)       │  │
│  │  ├── plugin-market/ ─ 插件市场 (Manifest/安装/卸载)        │  │
│  │  ├── provider/ ─ 46 个 Provider 实现 (Canonical 实现)       │  │
│  │  ├── capabilities/ ─ 能力族接口定义 (Provider 接口)        │  │
│  │  ├── seam/ ─ 遗留 Seam (@deprecated → provider/)          │  │
│  │  ├── dsh-compat/ ─ DSH 兼容层 (@deprecated)              │  │
│  │  ├── ui-plugins/ ─ 14 个 UI 插件包                        │  │
│  │  ├── consumer/ ─ Consumer 工具                             │  │
│  │  ├── file-mention.ts ─ 文件提及解析                        │  │
│  │  └── model-config.ts ─ 模型配置集中管理                    │  │
│  │                                                            │  │
│  │  状态管理                                                   │  │
│  │  ├── store.ts (useAppStore) ─ 消息/流式/工具/步骤进度      │  │
│  │  ├── core/store.ts (useProjectStore) ─ 项目/会话/技能      │  │
│  │  └── pet/pet-store.ts (usePetStore) ─ 宠物状态/气泡/窗口  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                          │ Tauri Commands (invoke)               │
│  ┌───────────────────────┴─────────────────────────────────────┐ │
│  │              Rust 后端 (src-tauri/src/lib.rs)               │ │  │  文件操作 / 命令执行 / HTTP代理 / 删除到回收站 /           │ │
│  │  窗口管理 / Mica毛玻璃 / 路径检查 / 安装器检测 /            │ │
│  │  宠物窗口管理 / 原生右键菜单 / 阴影控制 / 系统托盘 /        │ │
│  │  PTY 终端 (portable-pty) / 浏览器窗口                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                        │
│  ┌───────────────────────┴─────────────────────────────────────┐ │
│  │              SQLite 数据库 (AppData/codem-db.bin)           │ │
│  │  projects / sessions / messages / settings /                 │ │
│  │  memory / notebooks / notebook_sources / notebook_chunks    │ │
│  │  notes / note_links / flashcards / graph_nodes / graph_edges │ │
│  │  quick_phrases / prompt_drafts / todo_lists / message_feedback│ │
│  │  session_events / goals / jobs / telemetry_events /          │ │
│  │  agent_profiles / agent_messages / needs_you_pending /       │ │
│  │  turn_file_changes / issues / issue_comments / inbox_items /  │ │
│  │  sync_state / notebook_groups                                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

外部 API：
├── MiMo CLI (小米账户登录 → CLI 模式)
├── OpenAI 兼容 API (多 Provider: DeepSeek/OpenAI/MiMo/自定义)
├── Ollama 本地 LLM (REST API + 离线推理)
├── Embedding API (OpenAI/自定义 + 本地 ONNX 回退)
├── Petdex Manifest API (宠物市场目录 + 图片代理下载)
├── MCP 市场 (30+ 预设 MCP 服务器目录)
└── CodeGraph MCP Server (代码知识图谱)

★ 宠物窗口：独立 Tauri 透明窗口 (pet)
  ├── PetWindowApp.tsx ─ 精灵图 + 气泡 + 拖拽 + 右键
  ├── 通过 Tauri 事件与主窗口双向通信
  └── Rust: create_pet_window / close_pet_window / show_pet_menu

★ Cordis DI 容器：v1.0.0 引入
  ├── SlotRegistry ─ 18 Capability Seam 注册表
  ├── PluginLoader ─ 拓扑排序 + 加载/卸载 + 生命周期
  ├── 46 个 Provider 实现 (provider/ 目录)
  └── 14 个 UI 插件包 (ui-plugins/ 目录)
```

---

## 三、目录树与文件说明

```
mimo-gui/
├── src/                          # 前端源码
│   ├── main.tsx                  # React 入口
│   ├── App.tsx                   # 主应用组件（~1850行）
│   │                             #   handleSend → runAgenticLoop → engine.process
│   │                             #   事件循环 (text_delta/tool_start/tool_complete/...)
│   │                             #   per-session 隔离 (safeAddMessage/isViewingSession)
│   │                             #   并行对话 (abortControllersRef Map/streamBufferRef Map)
│   │                             #   权限/写确认/提示词变更 per-session Map
│   ├── store.ts                  # useAppStore (消息/流式/工具调用/步骤进度/activeSessions)
│   ├── types.ts                  # 前端类型定义
│   ├── types/                   # 类型声明
│   │   └── sql.js.d.ts          # sql.js 类型补充声明
│   ├── lib/                     # 工具函数
│   │   └── utils.ts             # cn() Tailwind 类名合并 (clsx + tailwind-merge)
│   ├── styles.css                # 全局样式（~12500行，含所有皮肤基础样式 + P1-P4组件样式 + v0.96 UI重构）
│   ├── styles/
│   │   ├── skin-dream.css        # 梦幻皮肤样式（磨砂/背景图/动画/自适应主题）
│   │   ├── skin-hub.css          # Hub 皮肤样式（分段控件/卡片布局）
│   │   └── codem-ui.css          # Codem UI 组件专用样式（v0.96 新增）
│   │
│   ├── components/               # UI 组件
│   │   ├── ChatPanel.tsx         # 对话面板（消息列表 + InputArea + 轮次分组）
│   │   ├── MessageBubble.tsx     # 消息气泡（memo优化 + 子智能体状态 + 分段/统一渲染）
│   │   ├── InputArea.tsx         # 输入区（底部控制栏：项目/模式/分支/安全模式 + slash命令）
│   │   ├── Sidebar.tsx           # 左侧栏（项目列表 + 会话列表 + 右键菜单 + 更多操作）
│   │   ├── RightSidebar.tsx      # 右侧栏（活跃任务面板 + GitInfoPanel + 上下文监控）
│   │   ├── GitInfoPanel.tsx      # Git 信息面板（分支/dirty/diff/commit/push/pull/worktree监控）
│   │   ├── SettingsPanel.tsx     # 设置面板（10个Tab：通用/外观/安全/Git/环境/Worktree/知识/自动化/多模态/宠物）
│   │   ├── TopNavbar.tsx         # 顶部导航（皮肤切换/布局切换）
│   │   ├── DreamLayout.tsx       # 梦幻皮肤布局
│   │   ├── HubLayout.tsx         # Hub 皮肤布局
│   │   ├── SkinSelector.tsx      # 皮肤选择器
│   │   ├── ConfirmDialog.tsx     # 确认对话框（Portal渲染 → 绕过 backdrop-filter）
│   │   ├── CloseConfirmDialog.tsx# 关闭确认对话框（Portal）
│   │   ├── PermissionDialog.tsx  # 权限请求对话框（Portal）
│   │   ├── PromptChangeReviewDialog.tsx # 提示词变更审查（Portal + diff）
│   │   ├── InteractiveFormDialog.tsx     # 交互式表单（Portal）
│   │   ├── GitHubCloneDialog.tsx # Git Clone 对话框（Portal）
│   │   ├── SearchDialog.tsx      # 全局搜索对话框（Portal）
│   │   ├── SlashCommandMenu.tsx  # / 命令菜单
│   │   ├── FileExplorer.tsx      # 文件浏览器
│   │   ├── FileEditor.tsx       # 文件编辑器
│   │   ├── DiffViewer.tsx       # Diff 对比查看器（v0.96 被 InlineDiffReview 替代，保留兼容）
│   │   ├── InlineDiffReview.tsx # 内联 Diff 审查（v0.96 新增，批量审批 + 统一/预览双视图）
│   │   ├── FileUpload.tsx       # 文件上传组件
│   │   ├── BootstrapWizard.tsx  # 初始化引导（AI身份 + 用户信息）
│   │   ├── ProjectManager.tsx   # 项目管理器
│   │   ├── ConfigEditor.tsx     # 配置编辑器
│   │   ├── McpManager.tsx       # MCP 服务器管理
│   │   ├── MemoryManager.tsx    # 记忆管理器
│   │   ├── NotebookManager.tsx  # 笔记本管理器
│   │   ├── MultimodalPanel.tsx  # 多模态配置（Embedding/TTS/ImageGen）
│   │   ├── ModelProfilePanel.tsx# 模型配置面板
│   │   ├── GitEnvSettings.tsx   # Git 环境配置
│   │   ├── ContextMonitor.tsx   # 上下文监控
│   │   ├── AgentPanel.tsx       # 智能体面板
│   │   ├── AgentDetail.tsx      # 智能体详情
│   │   ├── TitleBar.tsx         # 自定义标题栏（最小化/最大化/关闭）
│   │   ├── TerminalPanel.tsx    # CLI 终端面板（xterm.js）
│   │   ├── SkillManager.tsx     # 技能管理器
│   │   ├── SnapshotPanel.tsx    # 快照面板
│   │   ├── SessionRecovery.tsx  # 会话恢复面板
│   │   ├── SelectionTooltip.tsx # 选中文字浮窗工具栏
│   │   ├── UsageStats.tsx       # 用量统计面板
│   │   ├── PetOverlay.tsx       # 宠物市场/设置浮层入口（主窗口内）
│   │   │
│   │   │  ── v0.96 新增组件 ──
│   │   ├── BootSplash.tsx       # 启动加载画面
│   │   ├── ToastNotification.tsx# Toast 通知系统
│   │   ├── Drawer.tsx           # 通用抽屉组件
│   │   ├── NewChatPage.tsx      # 新对话首页
│   │   ├── SpaceSwitcher.tsx    # 工作空间切换器
│   │   ├── GitBranchSelector.tsx# Git 分支选择器
│   │   ├── AudioPlayer.tsx      # 音频播放器
│   │   ├── ExcelViewer.tsx      # Excel 文件查看器（xlsx）
│   │   ├── ErrorCard.tsx        # 错误卡片
│   │   ├── RunStatusBar.tsx     # 运行状态栏
│   │   ├── ActivityTimeline.tsx # 活动时间线
│   │   ├── AgentRoster.tsx      # 智能体花名册
│   │   ├── ConversationOverview.tsx # 对话概览
│   │   ├── UsageVisuals.tsx     # 用量可视化
│   │   ├── WorkspaceBackdrop.tsx# 工作区背景
│   │   ├── DecisionTray.tsx     # 决策托盘
│   │   ├── SettingsParts.tsx    # 设置面板分区组件
│   │   ├── ShikiCodeBlock.tsx   # Shiki 代码块（VS Code 级语法高亮）
│   │   ├── ToolCallCard.tsx     # 工具调用卡片（pill 胶囊风格）
│   │   ├── ToolCallGroup.tsx    # 工具调用组（内联展示 + 同类合并）
│   │   ├── MessageActions.tsx   # 消息操作工具栏（绝对定位悬浮）
│   │   ├── rich-content/        # 富内容渲染系统（v0.96 新增）
│   │   │   ├── RichContent.tsx  # 富内容统一入口
│   │   │   ├── ContentFrame.tsx # 内容框架
│   │   │   ├── CodeBlockView.tsx# 代码块视图
│   │   │   ├── HtmlPreviewView.tsx # HTML 预览
│   │   │   ├── ImagePreviewView.tsx # 图片预览
│   │   │   ├── JsonFormatView.tsx # JSON 格式化
│   │   │   ├── MathFormulaView.tsx # 数学公式
│   │   │   ├── MermaidCanvasView.tsx # Mermaid 图表
│   │   │   ├── TableScrollView.tsx # 表格滚动视图
│   │   │   └── FullscreenViewer.tsx # 全屏查看器
│   │   ├── ui/
│   │   │   └── overlay-kit.tsx  # Overlay 工具包（v0.96 新增）
│   │   │
│   │   │  ── P0: 滚动与UX基础 ──
│   │   ├── ScrollbarMarkers.tsx # 滚动条消息标记
│   │   ├── ScrollToBottomIndicator.tsx # 滚动到底部指示器
│   │   ├── hooks/useScrollState.ts # 滚动状态Hook
│   │   │
│   │   │  ── P1: 高级Agent功能 ──
│   │   ├── CorrectionModeToggle.tsx  # 事实核查模式开关
│   │   ├── CorrectionResultPanel.tsx # 核查结果展示面板
│   │   ├── ClarificationForm.tsx     # AI澄清交互表单
│   │   ├── PipelineNextStepDialog.tsx# 管道步骤选择对话框
│   │   ├── TodoListDisplay.tsx       # Todo列表可视化
│   │   ├── GuidanceBlock.tsx         # 引导消息展示块
│   │   ├── StreamingWaitIndicator.tsx# 流式等待阶段提示
│   │   ├── Workbench.tsx             # 代码工作台（Git diff + 工具状态）
│   │   ├── RegenerateModelPopover.tsx# 重生成模型选择弹窗
│   │   ├── FeedbackButtons.tsx       # 消息反馈按钮（赞/踩）
│   │   ├── InlineMessageEdit.tsx     # 消息内联编辑
│   │   ├── CapabilityGuard.tsx       # 模型能力守卫
│   │   │
│   │   │  ── P2: 体验提升 ──
│   │   ├── QuickAccessCards.tsx      # Agent快速访问卡片
│   │   ├── QuickPhraseSelector.tsx   # 快捷短语选择器
│   │   ├── PromptDraftPicker.tsx     # 提示词草稿版本选择
│   │   ├── OnboardingTour.tsx        # 新手引导浮窗
│   │   ├── SourceReferences.tsx      # RAG来源引用展示
│   │   │
│   │   │  ── P3: 多模态 ──
│   │   ├── ImageGallery.tsx          # 图片画廊预览
│   │   ├── VideoPlayer.tsx           # 视频播放器
│   │   ├── GenerateModeSelector.tsx  # 生成模式选择器
│   │   ├── ResolutionSelector.tsx    # 分辨率选择器
│   │   │
│   │   │  ── P4: 智能输入 ──
│   │   ├── ContextBadgeList.tsx      # 上下文徽章列表
│   │   ├── MentionAutocomplete.tsx   # @提及自动补全
│   │   ├── SkillAutocomplete.tsx     # 技能自动补全
│   │   ├── SourceSelector.tsx        # 知识来源选择器
│   │   │
│   │   │  ── 知识管理扩展 ──
│   │   ├── NotebookWorkspace.tsx     # 笔记本工作台
│   │   ├── NoteEditor.tsx            # 笔记编辑器
│   │   ├── KnowledgeGraphView.tsx    # 知识图谱可视化
│   │   ├── FlashcardViewer.tsx       # 闪卡复习器
│   │   ├── DocxViewer.tsx            # DOCX文档查看器
│   │   ├── PdfViewer.tsx             # PDF文档查看器
│   │   ├── SourceViewer.tsx          # 来源内容查看器
│   │   ├── ppt/                      # PPT生成组件
│   │   └── ui/                  # Radix UI 封装组件
│   │
│   ├── core/                     # 核心引擎层
│   │   ├── store.ts              # useProjectStore（项目/会话/技能/记忆 + deleteSession清理）
│   │   ├── types.ts              # 核心类型（Session含worktreePath/executionMode字段）
│   │   ├── file-api.ts           # 文件操作 API（writeFile/executeCommand/同步到工作区）
│   │   │
│   │   ├── llm/                  # LLM 引擎
│   │   │   ├── index.ts          # 统一引擎（Provider/Tool/Agent/Memory/MCP管理 + loopPool Map）
│   │   │   ├── agentic-loop.ts   # 多轮迭代循环（流式/工具调用/压缩/子智能体/任务完整性）
│   │   │   ├── provider.ts      # API 适配（OpenAI/DeepSeek/MiMo SSE流式 + Prompt缓存）
│   │   │   ├── streaming-executor.ts # 流式执行器（并发安全工具/密钥扫描）
│   │   │   ├── tools.ts          # 工具定义（read/write/edit/bash/multi_edit/spawn_subagent/ask_clarification/fact_check/show_todo/...）
│   │   │   ├── tools/            # 专用工具
│   │   │   │   ├── load-skill.ts     # 懒加载技能
│   │   │   │   ├── read-attachment.ts # 读取附件
│   │   │   │   ├── search-notebook.ts # 笔记本搜索
│   │   │   │   ├── ask-clarification.ts # AI澄清表单（P1）
│   │   │   │   ├── fact-check.ts      # 事实核查（P1）
│   │   │   │   ├── show-todo.ts       # Todo列表管理（P1）
│   │   │   │   ├── note-operations.ts # 笔记操作（知识管理）
│   │   │   │   └── web-search.ts     # Web 搜索
│   │   │   ├── model-config.ts  # 模型配置集中管理（MIMO_MODELS/API_MODELS/getModelsForMode）
│   │   │   ├── capability-detector.ts # 模型能力探测
│   │   │   ├── guidance-queue.ts # 引导消息队列
│   │   │   ├── model-resolver.ts # 模型解析器
│   │   │   ├── output-parser.ts  # 输出解析器
│   │   │   ├── processor.ts      # 请求处理器
│   │   │   ├── session.ts       # 会话管理
│   │   │   ├── cost-tracker.ts   # 成本追踪
│   │   │   ├── model-profile.ts  # 模型配置槽位
│   │   │   ├── multimodal.ts     # 多模态（Embedding/TTS/ImageGen）
│   │   │   ├── attachment-formatter.ts # 附件格式化
│   │   │   ├── attachment-sync.ts     # 附件同步到工作区
│   │   │   ├── tool-renderer.ts # 工具渲染
│   │   │   ├── run-status-tracker.ts # 运行状态追踪器（v0.96 新增）
│   │   │   ├── stream-reveal.ts # 流式内容逐步揭示（v0.96 新增）
│   │   │   └── types.ts         # LLM 类型
│   │   │
│   │   ├── subagent/             # 子智能体
│   │   │   ├── subagent.ts       # 子智能体管理器（spawn/wait fork-join）
│   │   │   ├── spawner.ts        # 生成器（工具别名映射）
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── context/              # 上下文管理
│   │   │   ├── context.ts        # token计数 + 自动压缩 + 优先级选择
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── memory/               # 记忆系统
│   │   │   ├── memory.ts         # 三级记忆（project/session/global）+ 整合 + 脱敏
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── permission/            # 权限系统
│   │   │   ├── permission.ts     # 受保护路径 + 权限请求
│   │   │   ├── security-mode.ts  # 三级安全模式（ask/auto/full）
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── environment/           # 环境管理（v0.87）
│   │   │   ├── worktree-manager.ts # Git Worktree 管理（create/remove/scan/limit）
│   │   │   ├── environment-runner.ts # 环境运行器
│   │   │   └── index.ts          # 导出（isGitRepo/getCurrentBranch/listBranches/...）
│   │   │
│   │   ├── automation/            # 自动任务（v0.87）
│   │   │   └── automation-manager.ts # 定时器/文件监听 + 触发 + 历史 + 停止
│   │   │
│   │   ├── knowledge/             # 知识管理（RAG + 笔记 + 闪卡 + 图谱 + PPT）
│   │   │   ├── chunker.ts        # 文本分块
│   │   │   ├── extractor.ts      # 文本提取（txt/md/code/url/html）
│   │   │   ├── pdf-extractor.ts  # PDF 提取（纯TS零依赖）
│   │   │   ├── indexer.ts        # Embedding 索引管道（含摘要/建议问题/增量索引）
│   │   │   ├── retriever.ts      # 语义检索（cosine + top-K + 阈值过滤）
│   │   │   ├── local-embedding.ts # 本地 ONNX 嵌入
│   │   │   ├── storage.ts        # 知识存储（含notes/flashcards/graph表）
│   │   │   ├── types.ts          # 类型（含Note/Flashcard/GraphNode等）
│   │   │   ├── exporter.ts       # 知识导出（Markdown/JSON）
│   │   │   ├── importer.ts       # 知识导入
│   │   │   ├── note-manager.ts   # 笔记管理（CRUD + 版本历史）
│   │   │   ├── flashcard-store.ts# 闪卡存储与复习调度
│   │   │   ├── graph-extractor.ts# 知识图谱实体/关系提取
│   │   │   ├── study-path.ts     # 学习路径生成
│   │   │   ├── ppt-generator.ts  # PPT内容生成（集成 oh-my-ppt 风格技能）
│   │   │   ├── ppt-skill-registry.ts # oh-my-ppt 风格技能注册到 Cordis SkillRegistry
│   │   │   ├── ppt-types.ts      # PPT类型定义
│   │   │   ├── skills/           # oh-my-ppt SKILL.md 资源（74 风格 + 9 产品技能）
│   │   │   │   ├── styles/       # 74 种风格的 SKILL.md
│   │   │   │   └── products/     # 布局/图表/动画等产品技能 SKILL.md
│   │   │   └── index.ts          # 统一导出
│   │   │
│   │   ├── skill/                # 技能系统
│   │   │   ├── skill.ts          # SKILL.md 解析 + 技能注册
│   │   │   ├── registry.ts      # 技能注册表
│   │   │   ├── provider.ts       # 技能工具提供者
│   │   │   ├── installer.ts      # 技能安装器（ZIP解压）
│   │   │   ├── skill-market-client.ts # 技能市场客户端
│   │   │   └── providers/        # 内置技能提供者
│   │   │       ├── interactive-form-provider.ts
│   │   │       └── prompt-optimization-provider.ts
│   │   │
│   │   ├── skills/               # 内置技能（SKILL.md）
│   │   │   ├── conversation-to-prompt/ # 对话转提示词
│   │   │   ├── interactive/      # 交互式表单
│   │   │   ├── mermaid-diagram/  # Mermaid 图表
│   │   │   ├── prompt-optimization/ # 提示词优化
│   │   │   └── skill-creator/    # 技能创建器
│   │   │
│   │   ├── mcp/                  # MCP 协议
│   │   │   ├── mcp.ts            # stdio 传输 + 工具代理
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── theme/                # 皮肤系统
│   │   │   ├── theme-manager.ts  # 主题管理（背景图提取颜色 + v0.96 自适应data-theme）
│   │   │   ├── theme-extractor.ts # 颜色提取器
│   │   │   ├── contrast-checker.ts # 对比度检查器（v0.96 新增，确保文字可读性）
│   │   │   ├── presets.ts        # 预设主题
│   │   │   ├── use-skin.ts       # 皮肤 Hook
│   │   │   ├── types.ts          # 类型
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── storage/              # SQLite 持久化
│   │   │   ├── database.ts       # SQLite 初始化 + 防抖持久化 + schema（含notes/flashcards/graph/quick_phrases/prompt_drafts/todo_lists/message_feedback表）
│   │   │   ├── session.ts        # 会话 CRUD
│   │   │   ├── message.ts        # 消息 CRUD + messagesToLLMMessages + 反馈存储
│   │   │   ├── project.ts        # 项目 CRUD
│   │   │   ├── settings.ts       # 键值设置存储 + 快捷短语CRUD
│   │   │   ├── prompt-draft.ts   # 提示词草稿版本存储（P2）
│   │   │   ├── account.ts        # 账户存储
│   │   │   ├── migration.ts      # 数据迁移
│   │   │   └── v2-session.ts     # v2 会话
│   │   │
│   │   ├── prompt/               # 系统提示词
│   │   │   ├── prompt.ts         # 系统提示词构建（双语 + 知识上下文 + 技能注入）
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── auth/                 # 认证
│   │   │   ├── mimo.ts           # MiMo 小米账户登录
│   │   │   └── storage.ts        # 认证存储
│   │   │
│   │   ├── agent/                # 智能体定义
│   │   │   └── agent.ts          # AgentDefinition（角色/模型槽位/协作模式）
│   │   │
│   │   ├── project/              # 项目工具
│   │   │   └── files.ts          # AGENTS.md 生成 + 项目根检测
│   │   │
│   │   ├── recovery/             # 会话恢复
│   │   │   └── recovery.ts       # 多层恢复 + 多层索引
│   │   │
│   │   ├── i18n/                 # 国际化
│   │   │   └── lang.ts           # 中英文双语（getLang/setLang/S/Sidebar/Input）
│   │   │
│   │   ├── icons/                # 图标
│   │   │   ├── icon-map.ts       # 图标名映射
│   │   │   └── index.ts          # 导出
│   │   ├── heartbeat/            # 心跳
│   │   │   ├── heartbeat.ts      # 心跳逻辑
│   │   │   └── index.ts
│   │   ├── retry/                # 重试
│   │   │   ├── retry.ts          # 指数退避重试逻辑
│   │   │   └── index.ts
│   │   ├── snapshot/             # 快照
│   │   │   ├── snapshot.ts       # 会话快照保存/恢复
│   │   │   └── index.ts
│   │   ├── config/               # 配置加载
│   │   │   └── loader.ts         # 配置加载器
│   │   │
│   │   ├── settings/             # 数据层设置系统（★ v0.87 随重构新增）
│   │   │   ├── settings.ts       # SettingsSource 层级 (cli/policy/flag/user/project/local/default) + PermissionRule
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── pet/                  # 桌面宠物系统（★ v0.88 新增）
│   │   │   ├── pet-store.ts      # Zustand store (usePetStore: 状态映射/气泡/窗口管理)
│   │   │   ├── pet-types.ts      # 类型定义 (PetDefinition/PetState/PetSettings)
│   │   │   ├── pet-manager.ts    # 本地宠物安装/加载/卸载
│   │   │   ├── pet-market-client.ts # Petdex 市场 API 客户端
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── session/             # 跨会话委派编排（★ v0.89 新增）
│   │   │   ├── bus.ts            # SessionMessageBus
│   │   │   ├── orchestrator.ts   # DelegationOrchestrator
│   │   │   ├── executor.ts       # executeSessionTurn + EventLog 双写
│   │   │   ├── delegation-storage.ts # 委派存储
│   │   │   ├── tools.ts          # 委派工具
│   │   │   ├── types.ts          # 类型
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── sandbox/              # 进程级沙箱 ACL（★ v1.1.0 新增）
│   │   │   └── sandbox-acl.ts    # 前端 ACL 层（路径/命令/环境变量过滤 + strict 策略）
│   │   │
│   │   ├── hooks/               # Hook 系统（★ v0.99 新增）
│   │   │   ├── hook-manager.ts   # Hook 管理器
│   │   │   └── hook-types.ts     # GuardHook / FinalizeHook 类型
│   │   │
│   │   ├── goal/                # Goal 自动续行（★ v0.99 新增）
│   │   │   └── goal.ts           # create/get/update_goal + goals DB 表
│   │   │
│   │   ├── issue/               # Issue 追踪 + 看板（★ v0.98 新增）
│   │   │   ├── issue.ts          # 7 状态 + 4 优先级
│   │   │   ├── issue-storage.ts  # Issue 存储
│   │   │   ├── issue-tools.ts    # 4 个 LLM 工具
│   │   │   └── index.ts
│   │   │
│   │   ├── squad/               # 多智能体协同（★ v0.98 新增）
│   │   │   ├── squad.ts          # Leader-Member + Roster 协议
│   │   │   ├── squad-tools.ts   # 3 个 LLM 工具
│   │   │   └── index.ts
│   │   │
│   │   ├── inbox/              # 全局通知聚合（★ v0.98 新增）
│   │   │   ├── inbox.ts          # 6 分类通知
│   │   │   ├── inbox-storage.ts  # 通知存储
│   │   │   └── index.ts
│   │   │
│   │   ├── telemetry/          # 遥测采集（★ v0.99 新增）
│   │   │   └── telemetry.ts     # TelemetryCollector + PerformanceDashboard
│   │   │
│   │   ├── cicd/               # CI/CD 管理（★ v0.99 新增）
│   │   │   ├── pipeline.ts      # GitHub Actions workflow 生成
│   │   │   └── index.ts
│   │   │
│   │   ├── cordis/             # Cordis DI 容器（★ v1.0.0 新增）
│   │   │   ├── src/             # DI 容器核心
│   │   │   └── cosmokit/src/    # 工具集
│   │   │
│   │   ├── slots/              # SlotRegistry（★ v1.0.0 新增）
│   │   │   └── index.ts        # 18 Capability Seam 注册表
│   │   │
│   │   ├── plugin-loader/      # 插件加载器（★ v1.0.0 新增）
│   │   │   └── index.ts        # 拓扑排序 + 加载/卸载
│   │   │
│   │   ├── plugin-market/      # 插件市场（★ v1.0.0 新增）
│   │   │   └── ...
│   │   │
│   │   ├── provider/           # 46 个 Provider 实现（★ v1.0.0 Canonical 实现）
│   │   │   ├── index.ts         # Provider 注册导出
│   │   │   ├── fs-provider.ts   # 文件系统
│   │   │   ├── shell-provider.ts # Shell
│   │   │   ├── sandbox-provider.ts # 沙箱
│   │   │   ├── llm-provider.ts  # LLM
│   │   │   └── ... (43 个更多 Provider)
│   │   │
│   │   ├── capabilities/        # 能力族接口定义（★ v1.0.0 — Provider 接口定义）
│   │   │   ├── index.ts         # 统一导出
│   │   │   ├── fs/              # 文件系统能力族
│   │   │   ├── shell/           # Shell 能力族
│   │   │   ├── sandbox/         # 沙箱能力族
│   │   │   ├── subagent/        # 子智能体能力族
│   │   │   ├── skill/           # 技能能力族
│   │   │   ├── web/             # Web 能力族
│   │   │   ├── extensions/      # 扩展能力族
│   │   │   ├── extra/           # 额外能力族
│   │   │   ├── infra/           # 基础设施能力族
│   │   │   └── misc/            # 杂项能力族
│   │   │
│   │   ├── seam/               # 遗留 Seam（@deprecated → provider/）
│   │   │   ├── types.ts        # ServiceDefinition/Provider/Consumer
│   │   │   ├── local-fs-provider.ts  # @deprecated
│   │   │   └── local-shell-provider.ts # @deprecated
│   │   │
│   │   ├── dsh-compat/         # DSH 兼容层（@deprecated）
│   │   │   ├── dsh-types.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── ui-plugins/         # 14 个 UI 插件包（★ v1.0.0 新增）
│   │   │   └── ...
│   │   │
│   │   ├── consumer/           # Consumer 工具
│   │   │   └── index.ts
│   │   ├── file-mention.ts     # 文件提及解析
│   │   └── model-config.ts     # 模型配置集中管理（MIMO_MODELS/API_MODELS/getModelsForMode）
│   │
│   ├── hooks/                    # React Hooks（v0.96 新增目录）
│   │   ├── useDraftPersistence.ts # 草稿持久化 Hook
│   │   ├── usePaneResize.ts      # 面板尺寸调整 Hook
│   │   ├── useSpeechRecognition.ts # 语音识别 Hook（v0.99 新增）
│   │   └── useSpeechSynthesis.ts  # 语音合成 Hook（v0.99 新增）
│   │
│   └── test/                     # 测试文件（107 文件 / 3624 用例）
│       ├── ui-batch-a-d.test.ts  # UI 批量测试
│       ├── security-mode.test.ts # 安全模式测试
│       ├── git-env-config.test.ts # Git环境配置测试
│       ├── pet-system.test.ts    # 宠物系统测试
│       ├── event-sourcing.test.ts # 事件溯源测试
│       ├── tool-pipeline.test.ts  # 5层工具管线测试
│       ├── codegraph-integration.test.ts # CodeGraph 集成测试（49 用例）
│       ├── icon-standardization.test.ts # 图标标准化测试（97 用例）
│       ├── trigger-call-execute-loop.test.ts # 工具管线 5 层闭环测试
│       ├── extended-quality-suite.test.tsx # 快照+性能+交互+i18n 测试（80 用例）
│       ├── plugin-dependency-graph.test.ts # 插件依赖图谱测试
│       ├── plugin-disable-impact.test.ts # 插件禁用影响测试
│       ├── dsh-integration-full.test.ts # DSH 对标整改集成测试（53 用例）
│       ├── functional-chain-closed-loop.test.ts # 功能链路闭环测试（12 用例）
│       ├── extended-test-methods.test.ts # 模糊+属性+契约+链路探针测试（35 用例）
│       ├── r3-snapshot-tests.ts  # R3 快照测试
│       ├── smoke-test.test.ts    # 冒烟测试（30 用例）
│       └── ...                   # 其他测试（共 107 文件）
│
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── lib.rs                # Tauri 主入口（所有命令注册 + 实现）
│   │   │                         #   write_file / read_file / execute_command
│   │   │                         #   list_dir / path_exists / delete_directory (回收站)
│   │   │                         #   http_get / http_download / get_app_data_dir
│   │   │                         #   get_installer_default_lang / ...
│   │   │                         #   create_pet_window / close_pet_window / show_pet_menu
│   │   │                         #   resize_pet_window / resize_pet_window_anchored
│   │   │                         #   set_pet_window_geometry / hide_to_tray / show_from_tray
│   │   │                         #   quit_app / update_tray_language
│   │   │                         #   create_browser_window (v0.91 浏览器预览)
│   │   │                         #   pty_spawn / pty_write / pty_resize / pty_close (v0.91 PTY 终端)
│   │   └── main.rs               # 程序入口
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置（窗口/CSP/Bundle/NSIS/WiX）
│   └── capabilities/             # Tauri 权限配置
│
├── docs/                         # 文档目录（详见第五节）
├── scripts/                      # 脚本
│   └── verify-package-invariants.ts # 包不变量检查（v1.1.0 新增）
├── .wecode-ref/                  # ⚠ 对标参考项目（微博 wecode 客户端），非本项目代码，仅供对标分析参考
├── public/                       # 静态资源
│   ├── models/                   # ONNX 模型（Xenova/all-MiniLM-L6-v2）
│   ├── wasm/                     # WASM 运行时
│   └── fonts/                    # 全局字体（AlimamaFangYuanTiVF-Thin.ttf）
├── dist/                         # 构建输出
├── package.json                  # npm 依赖 + 脚本
├── vite.config.ts                # Vite 配置
├── tsconfig.json                # TypeScript 配置
├── vitest.config.ts             # 测试配置
├── vitest.e2e.config.ts         # E2E 测试配置（v0.99 新增）
├── vitest.snapshot.config.ts    # 快照测试配置（v0.99 新增）
├── knip.json                    # 死代码检测配置（v0.99 新增）
├── .jscpd.json                  # 重复代码检测配置（v0.99 新增）
├── .github/workflows/ci.yml     # CI Workflow（v0.96.2 新增）
├── THIRD_PARTY_NOTICES.md        # 开源声明（Petdex MIT License）
└── README.md                     # 项目 README
```

---

## 四、文件关联关系

### 4.1 对话消息链路（最核心）

```
用户输入
  │
  ├─ InputArea.tsx (onSend)
  │   └─ App.tsx handleSend()
  │       ├─ useProjectStore.getState().currentSession (避免闭包过期)
  │       ├─ addMessage(用户消息) → store.ts useAppStore
  │       ├─ saveMessages(session.id) → storage/message.ts → database.ts
  │       └─ runAgenticLoop(message, session)
  │           ├─ 检查 session.executionMode → worktree? 创建 worktree
  │           │   └─ environment/worktree-manager.ts
  │           ├─ setStreaming(true) + setSessionActive(session.id, true)
  │           │   └─ store.ts useAppStore (activeSessions Map)
  │           ├─ abortControllersRef.set(session.id, controller)  ← 并行隔离
  │           ├─ safeAddMessage/safeUpdateMessage (isViewingSession守卫)  ← 并行隔离
  │           ├─ streamBufferRef Map<sessionId, buffer>  ← 并行隔离
  │           ├─ engine.process(session.id, message, cwd, ...)
  │           │   └─ llm/index.ts → agentic-loop.ts
  │           │       ├─ provider.ts (API 调用)
  │           │       ├─ tools.ts (工具执行)
  │           │       │   └─ onPermissionRequest → per-session Map
  │           │       │   └─ onWriteConfirm → per-session Map
  │           │       ├─ subagent/subagent.ts (spawn/wait)
  │           │       ├─ context/context.ts (压缩)
  │           │       └─ memory/memory.ts (提取记忆)
  │           ├─ 事件循环 (for await event)
  │           │   ├─ text_delta → safeAddMessage + streamBufferRef
  │           │   ├─ tool_start → safeAddMessage + addToolCall(isViewingSession)
  │           │   ├─ tool_complete → updateToolCall(isViewingSession)
  │           │   ├─ reasoning_delta → safeUpdateMessage
  │           │   ├─ start(iter) → flushStreamBuffer + 新消息
  │           │   └─ end → 完成
  │           └─ finally → setStreaming(false) + setSessionActive(false) + cleanup
  │
  └─ 影响文件: App.tsx, store.ts, core/store.ts, llm/index.ts, agentic-loop.ts,
              provider.ts, tools.ts, storage/message.ts, storage/database.ts
```

### 4.2 状态管理关联

```
store.ts (useAppStore)
  ├── messages[] ← addMessage/updateMessage/addToolCall/updateToolCall
  ├── isStreaming ← setStreaming (activeSessions.size > 0)
  ├── activeSessions: Map<sessionId, boolean> ← setSessionActive
  ├── stepProgress ← setStepProgress
  ├── llmStatus ← setLLMStatus
  └── streamStartTime ← setStreamStartTime

core/store.ts (useProjectStore)
  ├── projects[] ← openProject/createProject/deleteProject/updateProject
  ├── sessions[] ← createSession/switchSession/deleteSession/forkSession
  ├── currentProject ← openProject
  ├── currentSession ← switchSession/createSession
  └── 影响文件: App.tsx, Sidebar.tsx, ChatPanel.tsx, InputArea.tsx, SettingsPanel.tsx
```

### 4.3 皮肤系统关联

```
theme/theme-manager.ts → 注入 CSS 变量 (--dream-bg-image, --dream-accent, ...)
  ├── v0.96: applyDreamCSS 根据 palette.isDark 自适应设置 data-theme
  ├── v0.96: cleanDreamCSS 恢复用户偏好主题
  ├── v0.96: 注入 glass/surface/message-bubble/tool-card/composer/titlebar/rich-code token 覆盖
  ├── styles/skin-dream.css → [data-skin="dream"] 选择器
  │   ⚠ backdrop-filter 在 .sidebar 上 → 为 position:fixed 子元素创建 containing block
  │   → 所有弹窗组件必须用 createPortal 渲染到 document.body
  ├── styles/codem-ui.css → Codem UI 组件专用样式（工具调用/推理块/InlineDiffReview）
  ├── DreamLayout.tsx → 梦幻皮肤布局
  ├── HubLayout.tsx → Hub 皮肤布局（v0.96: rightRailOpen 状态同步）
  ├── TopNavbar.tsx → 皮肤切换
  ├── TitleBar.tsx → v0.96: Dream 皮肤激活时跳过 data-theme 覆盖
  ├── SkinSelector.tsx → 皮肤选择器
  ├── theme/contrast-checker.ts → v0.96: 对比度检查（确保文字可读性）
  └── 影响文件: App.tsx (data-skin 属性), 所有弹窗组件 (Portal)
```

### 4.4 Worktree 关联

```
environment/worktree-manager.ts
  ├── createWorktree(projectPath, sessionId, branch?) → 创建 worktree 目录
  ├── removeWorktreeSync(projectPath, worktreePath) → 删除 worktree
  ├── scanWorktrees(projectPath) → 扫描
  └── enforceMaxWorktrees(projectPath, max) → LRU 清理

关联链路:
  InputArea.tsx → setProjectExecutionMode (localStorage)
  App.tsx handleSend → 检查 session.executionMode === "git_worktree"
    → createWorktree → session.worktreePath → cwd = worktreePath
  core/store.ts deleteSession → removeWorktreeSync + cleanupSessionLoop
  core/store.ts forkSession → createWorktreeSync (继承 executionMode)
  GitInfoPanel.tsx → projectPath = currentSession?.worktreePath || currentProject?.path
```

### 4.5 并行对话隔离关联

```
关键修改文件:
  App.tsx
    ├── abortControllersRef: Map<sessionId, AbortController>  ← 替代单例
    ├── streamBufferRef: Map<sessionId, buffer>               ← 替代单例
    ├── pendingPermissions: Map<sessionId, ...>                ← 替代单例
    ├── pendingWriteConfirms: Map<sessionId, ...>             ← 替代单例
    ├── pendingPromptChangesMap: Map<sessionId, ...>          ← 替代单例
    ├── pendingInteractiveForms: Map<sessionId, ...>          ← 替代单例
    ├── safeAddMessage/safeUpdateMessage (isViewingSession)   ← UI 隔离
    └── isStreaming = activeSessions.size > 0                ← 全局状态

  llm/index.ts
    └── loopPool: Map<sessionId, AgenticLoop> + getAgenticLoop(agentId, sessionId)

  store.ts
    ├── activeSessions: Map<sessionId, boolean>
    └── setStreaming(v) → isStreaming = v ? true : activeSessions.size > 0

  ChatPanel.tsx
    └── disabled = (!currentSessionId || activeSessions.has(currentSessionId)) || !connected
```

### 4.6 自动任务关联

```
automation/automation-manager.ts
  ├── AutomationTrigger (timer / fileWatch)
  ├── start() → setInterval / setInterval(check, 2000)
  ├── fire() → callback(sessionId, message)
  └── stop() / stopAll()

关联链路:
  SettingsPanel.tsx → 配置触发器 → saveTrigger → setAutomationConfig
    → refreshAutomationEngines() → 创建/停止引擎
  App.tsx → handleSendRef.current = handleSend (useEffect 每次渲染更新)
    → 自动化回调用 handleSendRef.current(message)
    → createSession 继承 executionMode → 可能创建 worktree
```

### 4.7 宠物系统关联

```
主窗口 (App.tsx) ──Tauri 事件──→ 宠物窗口 (PetWindowApp.tsx)
  │                                    │
  ├─ setLLMStatus(status)              ├─ PetSprite.tsx (精灵图帧动画)
  │   → usePetStore.onLLMStatus()      │   6种状态: idle/thinking/working/happy/sad/sleeping
  │   → emit("pet-status-update")      │
  │                                    ├─ 气泡 (useLayoutEffect 测量高度)
  ├─ 流式事件 (text_delta/...)         │   → invoke("resize_pet_window", {width, height})
  │   → usePetStore.onStreamEvent()    │   → invoke(setPosition) 增量位移 (宠物视觉不动)
  │   → emit("pet-stream-event")       │
  │                                    ├─ 右键 → invoke("show_pet_menu", {x, y})
  ├─ Token 查询                        │   → Rust MenuBuilder (原生菜单, 不受窗口裁剪)
  │   → emit("pet-check-tokens")       │   → 菜单项 → emit 回前端
  │   → pet-store.showBubble(text)     │
  │                                    └─ 拖拽 → setPosition (保存宠物位置)
  ├─ SettingsPanel 🐾Tab                │
  │   → usePetStore (启用/大小/透明度/市场)
  │
  └─ PetMarketDialog.tsx
      → pet-market-client.ts → Petdex Manifest API
      → pet-manager.ts (安装/卸载本地宠物包)

Rust 后端 (lib.rs):
  ├── create_pet_window()             → WebviewWindowBuilder + transparent + always_on_top
  ├── close_pet_window()              → 关闭宠物窗口
  ├── resize_pet_window()             → 动态调整宠物窗口尺寸
  ├── resize_pet_window_anchored()    → 锚点 resize（单次 SetWindowPos，零漂移）
  ├── set_pet_window_geometry()       → 原子化设置位置+尺寸
  └── show_pet_menu()                 → MenuBuilder 原生右键菜单
```

---

## 五、docs/ 文档说明

| 文件 | 类型 | 说明 | 状态 |
|------|------|------|------|
| **PROJECT-GUIDE.md** | 📌本项目 | **本文档**，完整项目说明 | ✅ 最新 |
| **RELEASE-GUIDE.md** | 发布指南 | **构建 + 签名 + GitHub Release 完整流程**（v1.9.0 成功经验固化；发布构建必读） | ✅ 最新 |
| **PROJECT_STATUS.md** | 项目简介 | 项目概述+架构+功能清单+版本历史 | v0.88 |
| **PROJECT-CONTEXT.md** | 旧版交接 | v0.79 时的交接文档，已被 PROJECT_STATUS 替代 | 📦 归档 |
| **TODO.md** | 待办跟踪 | Phase 0-G 全部完成记录 + v0.88-v1.1.0 全部版本变更 | ✅ 最新 |

| **deepseek-harness-analysis.md** | 对标分析 | DSH 第一轮对标分析文档 | ✅ 最新 |
| **deepseek-harness-round2.md** | 对标分析 | DSH 第二轮对标分析文档 | ✅ 最新 |
| **dsh-round3-analysis.md** | 对标分析 | DSH 第三轮深度对标分析文档 | ✅ 最新 |
| **dsh-audit-final-report.md** | 审计报告 | DSH 对标整改最终审计报告（Phase A-D 全部完成） | ✅ 最新 |
| **dsh-gap-coverage-final.md** | 对标分析 | DSH 差距覆盖最终文档 | ✅ 最新 |
| **dsh-improvement-dev-plan.md** | 开发计划 | DSH 整改开发计划 | ✅ 已实现 |
| **dsh-post-refactor-dev-plan.md** | 开发计划 | DSH 重构后开发计划 | ✅ 已实现 |
| **dsh-post-refactor-gap-analysis.md** | 对标分析 | DSH 重构后差距分析 | ✅ 最新 |
| **dsh-skill-fusion-plan.md** | 计划文档 | DSH 技能融合计划 | ✅ 最新 |
| **dsh-skill-gap-analysis.md** | 对标分析 | DSH 技能差距分析 | ✅ 最新 |
| **plugin-reality-audit.md** | 审计文档 | 插件现实审计（1111行） | ✅ 最新 |
| **harness-comparative-analysis.md** | 对标分析 | Harness 比较分析 | ✅ 最新 |
| **BETTER-HARNESS-INTEGRATION-ANALYSIS.md** | 对标分析 | 更好的 Harness 集成分析 | ✅ 最新 |

| **CHANGELOG-v0.70.md** | 变更日志 | v0.70 变更记录 | 📦 归档 |
| **CHANGELOG-v0.80.md** | 变更日志 | v0.80 变更记录 | 📦 归档 |
| **CHANGELOG-v0.86.md** | 变更日志 | v0.86 变更记录 | 📦 归档 |
| **CHANGELOG-v0.87.md** | 变更日志 | v0.87 变更记录 | 📦 归档 |
| **CHANGELOG-v0.88.md** | 变更日志 | v0.88 变更记录 | 📦 归档 |
| **CHANGELOG-v0.89.3.md** | 变更日志 | v0.89.3 变更记录 | 📦 归档 |
| **CHANGELOG-v0.89.md** | 变更日志 | v0.89 变更记录 | 📦 归档 |
| **CHANGELOG-v0.98.0.md** | 变更日志 | v0.98.0 变更记录 | ✅ 最新 |
| **CHANGELOG-v1.0.0.md** | 变更日志 | v1.0.0 变更记录 | ✅ 最新 |
| **CHANGELOG-v1.1.0.md** | 变更日志 | v1.1.0 变更记录（DSH 对标整改 + 测试深化 + Bug 修复） | ✅ 最新 |
| **CHANGELOG-v1.1.1.md** | 变更日志 | v1.1.1 变更记录（UI 布局优化 + 插件条件渲染 + Bug 修复） | ✅ 最新 |

| **defensive-patterns.md** | 防御文档 | 7+ 条防御规则文档化 | ✅ 最新 |
| **adr/0001-event-sourcing.md** | 架构决策记录 | 事件溯源 ADR | ✅ 最新 |
| **adr/0002-tool-pipeline.md** | 架构决策记录 | 5层工具管线 ADR | ✅ 最新 |
| **adr/0003-plan-mode-alignment.md** | 架构决策记录 | Plan Mode 对齐 ADR | ✅ 最新 |
| **postmortem/README.md** | 事故复盘 | 事故复盘文档体系 | ✅ 最新 |
| **p3-roadmap.md** | 路线图 | P3 远期路线图 | ✅ 最新 |
| **coding-improvement-final.md** | 改进计划 | 编码改进最终版（598行） | ✅ 最新 |
| **release-notes-v0.97.0-patch.md** | 补丁说明 | v0.97.0 补丁修复说明 | ✅ 最新 |
| **DEV-PLAN-UNIFIED.md** | 主线计划 | 统一开发计划（1172行），整合了 ROADMAP + Benchmark + TODO | 📦 参考 |
| **ROADMAP-codex-alignment.md** | 历史路线图 | Codex 对标改进路线图（Phase 0-4 已完成） | 📦 归档 |
| **TOOLS-SKILLS-BENCHMARK.md** | 对标分析 | 工具/技能/MCP 对标分析（66K，Phase B-D 已完成） | 📦 归档 |
| **UI-UX-Wegent-Benchmark.md** | 对标分析 | UI/UX 对标分析（10项优化方向） | 📦 归档 |
| **SKIN-SYSTEM-DESIGN.md** | 设计文档 | 皮肤系统设计（默认/Hub/梦幻三套） | ✅ 已实现 |
| **WORKTREE-INPUTBAR-PLAN.md** | 计划文档 | InputArea 控制栏重构 + Git Worktree 集成计划 | ✅ 已实现 |
| **GIT-WORKTREE-GUIDE.md** | 用户指南 | Git Worktree 使用指南 | ✅ 最新 |
| **DEFERRED-WORKTREE-ANALYSIS.md** | 分析文档 | Worktree 早期审计（断链分析），已被 AUDIT 替代 | 📦 归档 |
| **AUDIT-WORKTREE-PARALLEL.md** | 审计文档 | 自动化/并行/Worktree 全面审计（最终版） | ✅ 最新 |
| **AUDIT-V3-FINAL.md** | 审计文档 | V3 最终审计 | 📦 归档 |
| **REFACTOR-PROMPT-TO-DATA.md** | 重构计划 | 从提示词约束到数据层约束的整改计划 | ✅ 已实现（P0-P5 全部落地，143个测试） |
| **REGRESSION-TEST-CASES.md** | 测试用例 | 58组236步全覆盖回归测试用例 | ✅ 最新 |
| **TEST-RESULTS.md** | 测试结果 | 上述测试用例的执行结果 + 发现的5个问题已修复 | ✅ 最新 |
| **MANUAL-TEST-GUIDE.md** | 测试指南 | 手动测试指南 | 📦 参考 |
| **DISPLAY-MODE-PROGRESS.md** | 进度日志 | 显示模式切换进度（分段/统一） | 📦 归档 |
| **CHANGELOG-v0.70.md** | 变更日志 | v0.70 变更记录 | 📦 归档 |
| **CHANGELOG-v0.80.md** | 变更日志 | v0.80 变更记录 | 📦 归档 |
| **CHANGELOG-v0.86.md** | 变更日志 | v0.86 变更记录 | 📦 归档 |
| **CHANGELOG-v0.87.md** | 变更日志 | v0.87 变更记录 | 📦 归档 |
| **CHANGELOG-v0.88.md** | 变更日志 | v0.88 变更记录 | 📦 归档 |
| **CHANGELOG-v0.89.3.md** | 变更日志 | v0.89.3 变更记录 | ✅ 最新 |
| **CHANGELOG-v0.89.md** | 变更日志 | v0.89 变更记录 | ✅ 最新 |
| **TEST-CASES-REGRESSION-V2.md** | 测试用例 | 回归测试V2（含冒烟测试），185个用例 | ✅ 最新 |
| **WECODE-REF-GAP-ANALYSIS.md** | 对标分析 | 全局对标 wecode-ref 核心功能缺失分析 | ✅ 最新 |
| **IMPLEMENTATION-PLAN-FULL.md** | 实施计划 | P0-P4 全量功能实施计划（含文件修改/交互变更/存储架构） | ✅ 最新 |
| **NOTEBOOK-FEATURE-GAP-ANALYSIS.md** | 对标分析 | 笔记本功能差距分析（1066行） | ✅ 最新 |
| **NOTEBOOK-FEATURE-GAP-ANALYSIS-V2.md** | 对标分析 | 笔记本功能差距分析V2（精简版） | ✅ 最新 |
| **NOTEBOOK-UI-UX-BENCHMARK.md** | 对标分析 | 笔记本UI/UX基准分析 | ✅ 最新 |
| **NOTEBOOK-UNIMPLEMENTED-FEATURES.md** | 对标分析 | 笔记本未实现功能清单 | ✅ 最新 |

### 文档优先级说明

**新对话只需要阅读：**
1. `PROJECT-GUIDE.md`（本文档）— 完整理解项目
2. `TODO.md` — 了解当前待办（含 v1.1.1 变更）
3. `CHANGELOG-v1.1.1.md` — 了解最新发布版本变更
4. `dsh-audit-final-report.md` — 了解 DSH 对标整改审计结果
5. `WECODE-REF-GAP-ANALYSIS.md` — 了解对标分析发现的功能缺失
6. `IMPLEMENTATION-PLAN-FULL.md` — 了解 P0-P4 实施计划
7. `TEST-CASES-REGRESSION-V2.md` — 了解回归测试用例（含冒烟测试）

**其余文档均为历史归档或已完成计划的记录，不影响进度判断。**

**DSH 对标系列文档阅读顺序：**
1. `deepseek-harness-analysis.md` — 第一轮对标
2. `deepseek-harness-round2.md` — 第二轮对标
3. `dsh-round3-analysis.md` — 第三轮深度对标
4. `dsh-audit-final-report.md` — 整改审计报告（最终）
5. `dsh-gap-coverage-final.md` — 差距覆盖最终文档

---

## 六、当前开发状态

### 6.1 已发布版本

| 版本 | 日期 | 主要内容 |
|------|------|---------|
| v0.70 | 2026-07-06 | SQLite统一存储 + 中文编码 + 子智能体重构 |
| v0.77 | 2026-07-07 | 多语言 + 安全策略 + 智能体调用修复 |
| v0.79 | 2026-07-11 | 三级安全 + LLM连接稳定性 + 任务完整性 |
| v0.80 | 2026-07-14 | 轮次架构 + UI对比度 + 性能优化 + 置顶 |
| v0.85 | 2026-07-19 | 技能触发三层 + 附件重构 + 技能市场 + Web搜索 + 知识管理 + 本地嵌入 |
| v0.86 | 2026-07-20 | 皮肤系统 + Mica毛玻璃 + 自定义标题栏 |
| v0.87 | 2026-07-24 | Worktree全链路 + 并行对话 + 自动任务 + GitHub Clone + 侧边栏重构 + 全局字体 + Prompt Cache优化 |
| v0.88 | 2026-07-24 | 桌面宠物系统 + 宠物市场 + 悬浮气泡通知 + 右键原生菜单 + Token查询 |
| v0.89 | 2026-07-26 | 跨会话委派编排 + 8个高级UI面板 + 核心模块持久化 + 上下文压缩配置UI + 冒烟测试 |
| v0.89.3 | 2026-07-27 | 宠物窗口多页打包(3.4MB→5.7KB) + 锚点 resize 零漂移 + 模型/模式持久化修复 |
| v0.90.0 | 2026-07-31 | 推理强度分档 + UI/UX大幅优化 + P0-P4全量功能(滚动UX/高级Agent/体验提升/多模态/智能输入/知识管理增强) + 新手引导 + 梦幻皮肤磨砂玻璃 + 架构培训文档 |
| v0.91.0 | 2026-08-01 | Coding工作台基础设施升级 — PTY交互式终端 + 文件变更追踪Artifact + 文件树Git状态 + 自动Commit + AgentProfile + NeedsYou + 异步Agent通信 + 浏览器面板 + Overview可观测性 + **集成与测试全部完成** + **UI设计完全版改造**（自定义缓动曲线 / transition:all清零 / 按钮按压反馈 / 弹窗transform-origin / 可访问性全覆盖 / 材质分层 / 入场动画现代化，对标 emilkowalski/skills + apple-design） |
| v0.92.0 | 2026-08-02 | Codex use-cases对标分析（101个use-case逐项复现路径） + Playwright/Figma/GitHub三个MCP工具（可复现率67%→81%） + 梦幻皮肤磨砂效果彻底修复（CSS变量提到html级别+内联style双保险+类名选择器补全） + 新手引导仅首次启动修复 + 检查更新undefined修复+自动打开GitHub下载页 + 定位圆圈居中+缩小 |
| v0.93.0 | 2026-08-03 | Vision Proxy视觉代理全链路 — 纯文本模型(DeepSeek)支持图片理解（检测图片→智能路由→视觉模型描述→替换为文字→转发主模型） + STT语音转写代理通路 + 图片生成通路 + 多模态能力矩阵重构(vision/stt输入 + embedding/tts/imageGen输出) + TaskSlot新增vision + 内置方案DeepSeek+视觉代理 + 配置弹窗z-index修复 + 89新测试(全量2859通过) |
| v0.94.0 | 2026-08-03 | 配置方案Portal渲染彻底修复遮挡 + 新建方案自动展开配置面板+名称描述行内编辑 + 持久化修复(ModelProfile单例在DB初始化后reload) + 梦幻皮肤支持GIF和视频背景(3种音频模式+音量滑轨) |
| v0.95.0 | 2026-08-03 | Vision Proxy MiMo v2.5支持 + CLI/API双模式视觉代理全链路打通(engine获取token) + CSP全面修复(media/font/frame-src+blob+asset.localhost) + 梦幻皮肤视频背景打包修复 + 花瓣缩小 + 仓库清理(移除对标/培训/内部文档) + 13个E2E全场景测试(156通过) |
| v0.96.0 | 2026-08-08 | 主对话窗口UI大改版(对标frakio-work/wecode) + 内联Diff批量审批(替换弹窗) + 三皮肤暗色模式深度修复 + 梦幻皮肤自适应主题(data-theme基于palette.isDark) + 富内容渲染系统(9组件) + Shiki语法高亮 + 39个新组件 + 3个新依赖(framer-motion/shiki/xlsx) |
| v0.96.1 | 2026-08-10 | 右侧栏文件浏览器体系重构(对标wecode固定宽度420px) + 文件拖拽修复(Tauri dragDropEnabled + dropEffect) + 文件编辑器悬浮窗口(createPortal全屏预览) + 全格式文件预览(图片/PDF/Excel/Word/视频/音频/HTML) + 应用Logo替换(codem.ico紫色图标) + NSIS安装器图标修复(installerIcon配置 + sharp/png-to-ico生成BMP格式ICO) + GitHub Release更新 |
| v0.96.2 | 2026-08-11 | CodeGraph代码知识图谱集成(自动检测.codegraph/→MCP Server注册→系统提示词注入→设置页面标签页) + 测试套件改造(readFileSync+toContain→真实模块行为验证) + CI Workflow(tsc+vitest+cargo check) + CodeGraph集成测试(49用例4层覆盖) |
| v0.97.0 | 2026-08-12 | Agentic Loop性能优化(Tool Result磁盘持久化+ToolSearch延迟加载+Micro-Compact摘要+TranscriptCache修复) + 工具系统增强(工具中断行为+Bash分析器+Hooks系统+TodoWrite增强+Forked Agent记忆提取) + 技能市场三大新源接入(ClawHub.ai/Skills.sh/SkillHub CLI) + 技能发布功能。**补丁修复：** ctx.abort空指针 + Session持久化缺失(executionMode/worktreePath/worktreeBranch) + preserveExecutor类型错误 + 移除57个假测试 + 重写61个源码字符串匹配测试为真实行为测试。全量84文件/2924用例通过 |
| v0.98.0 | 2026-08-13 | 多智能体协同架构 — TaskCenter统一任务管理中心(概览/委派/子智能体/自动化4Tab) + Squad多智能体协同(Leader-Member+Roster协议+3个LLM工具+dispatch路由) + Issue追踪+看板(7状态+4优先级+评论+看板拖拽+4个LLM工具) + Autopilot扩展(Cron引擎+Issue状态触发器) + Inbox全局通知聚合中心(6分类+事件填充+Sidebar未读角标) + AgentManager扩展+死代码清理。5张新DB表、7个新LLM工具、8Tab全景、30新文件、20修改文件。全量87文件/3057用例通过 |
| v0.99.0 | 2026-08-14 | **对标DeepSeek Harness全量升级** — 事件溯源会话日志(SessionEvent+deriveMessages+Replay+Fork+Projection) + 5层工具管线(pre-execute/monotonic-guards/execute/post-execute/finalize) + Plan Mode增强(exit_plan_mode工具+对齐dsh 6段提示词规范+PlanApprovalCard审批UI) + Capability Seam(ServiceDefinition/Provider/Consumer三角色+LocalFs/LocalShell Provider+SeamRegistry) + Code Mode(run_code TypeScript执行器+ToolSDK) + Session Query(FTS5全文搜索) + Goal自动续行(create/get/update_goal+Goals表) + Workflow编排(JavaScript fan-out子智能体) + Snapshot测试(ReplayAdapter录制/回放) + Telemetry(OpenTelemetry采集+telemetry_events表+PerformanceDashboard) + Bash后台模式(JobManager+job_list/output/kill) + 终端LLM工具组(terminal_open/send/signal/close) + i18n提示词重构(prompt.ts→i18n-templates.ts双语模板) + MCP市场(catalog+一键安装+分类搜索) + 语音STT/TTS(useSpeechRecognition/useSpeechSynthesis浏览器原生) + Ollama本地LLM Provider(REST API+动态模型发现+离线推理) + CI/CD管理(GitHub Actions workflow生成+运行监控+重试/取消) + 技能安全沙箱(内容预检+哈希签名+权限声明+安装审计) + 远程同步引擎(seq增量同步+Supabase/REST后端) + 代码质量工具(knip死代码+jscpd重复检测) + 测试分层补齐(snapshot+e2e配置) + 防御性文档+ADR+Postmortem体系。25文件修改(+1721/-313行)，50+新文件。全量99文件/3234用例全部通过。**补丁修复（同版本重新构建）：** provider.ts toAPIMessage补全ContentBlock tool_use/tool_result块处理（事件投影路径工具调用信息丢失修复）+ agentic-loop.ts事件投影消息映射补全tool_calls属性（下游优先级排序/孤儿过滤/micro-compact全链路修复）+ tools.ts readViaSeam+local-fs-provider.ts readFile相对路径cwd解析修复。全量99文件/3235用例全部通过 |
| v1.0.0 | 2026-08-15 | **UI/UX 标准化 + 插件系统架构 + 测试体系全面升级** — P4 Cordis DI容器+SlotRegistry+PluginLoader+18 Capability Seam + P5 全能力族拆分(13个独立能力族) + P6 UI插件包化+插件市场基础设施(7个UI插件包+Self-Referential Runtime+插件市场Manifest) + 全弹窗UI/UX标准化(modal-overlay+modal-editor统一结构) + 图标映射体系(7图标集+ToolEmojis+消除直接lucide-react导入) + CSS样式标准化(硬编码→CSS变量+Tailwind→size属性) + 核心插件保护(riskLevel+locked+core) + 5个新测试文件/271+用例(图标标准化97用例+工具管线闭环30+用例+质量套件80用例+插件依赖图24+用例+插件禁用影响40+用例) + SlotBridge泛型类型修复+恢复noImplicitAny严格检查。67文件修改(+1112/-641行)。全量100文件/3552用例通过 |
| v1.1.0 | 2026-08-16 | **DSH对标全面整改 + 测试体系深化 + Bug修复** — Phase A-D全部完成：孤岛模块接入10项(compaction-control/output-contract/feedback/type-safety/event-system-strict/cookbook/persistence-provider/replay-adapter/preset-discovery/agent-message-queue) + 重复实现统一4项(capabilities vs provider/Telemetry-CostTracker/projectedTokens/seam-dsh-compat deprecation) + 缺失功能补齐5项(代理指令分层/进程级沙箱ACL/Dynamic Plugin工具/测试分层框架/包不变量检查) + 5个Bug修复(ESM require→import/fire-and-forget .catch()/TranscriptCache.clear/网络命令阻断/敏感变量) + 4个新测试文件/118用例(dsh-integration-full 53+plugin-disable-impact 18+functional-chain-closed-loop 12+extended-test-methods 35:模糊/属性/契约/链路探针) + 消息存储双轨制统一(C5) + 系统提示词分层加载(D1)。22文件修改，24新文件。全量107文件/3624用例通过 |
| v1.1.1 | 2026-08-17 | **UI布局优化 + 插件条件渲染 + Bug修复** — 插件管理按钮移至左下角 + CI/CD移至右侧边栏 + 性能移至主对话框顶端 + 插件启用/禁用与按钮/面板联动显示 + 宠物窗口关闭Bug修复(Rust CloseRequested拦截器) + 插件管理面板Cordis Context初始化时序修复(重试机制+直接属性访问) + UI组件useCtx→tryGetCtx防御 + 6个工具Consumer文件execute回调null检查防御(tool-fs/tool-bash/tool-web/tool-skill/tool-cordis/tool-extra)。15文件修改。编译零错误 |
| v1.2.0 | 2026-08-18 | **Cordis 架构全面对齐 DSH + 安全加固 + 全量测试重构** — 移除核心 `@ts-nocheck`（`declare module` 类型声明全面生效）+ `getCtxService` 对齐 DSH `ReflectService.get` keyof 推断 + 安全加固（AST 代码验证 + Worker 隔离 + XOR 密钥混淆 + SandboxGuard 覆盖读操作）+ 生命周期管理（复合 Dispose + LRU 淘汰）+ Bug 修复（React Hooks 顺序 + `useSyncExternalStore` 无限循环）+ 全量测试重构 109 套件 3690 测试通过 |
| v1.3.0 | 2026-08-19 | **Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐** — 死 slot 从 29 个降至 0 个 + 7 个 UI provider 添加 `inject` 声明依赖 + Conversation slot 层级对标 DSH 完整建立 + `slots.inject()` 消费声明方法 + 11 个重复/无消费点 slot 注册移除 + SlotBridge 泛型类型推断修复。30+ 文件修改，10 个新组件 |
| v1.4.0 | 2026-08-19 | **UI/UX 体验优化 11 项 Bug 修复 + 编译 Warnings 清零** — 技能市场乱码修复 + http_get 超时优化 + 智能体管理滚动 + 模型默认值修复 + CI/CD 面板切换化 + 梦幻皮肤毛玻璃 + 圆角一致性 + 首页自适应 + write code 修复 + 安全策略按钮 + 性能面板切换化 + 编译 warnings 清零 |
| v1.4.1 | 2026-08-20 | **插件管理初始化修复 + 技能市场性能优化 + 对话区域自适应 9 项 Bug 修复** — Cordis Context fiber 激活时序修复 + PluginManager 重试增强 + 三大技能市场 MAX_PAGES 减少 + configureEngine DB 未就绪重试 + CicdPanel 去除 header/关闭按钮 + 三套皮肤圆角统一 + 首页布局 + Write Code prompt 完整化 + 底部 CI/CD 按钮移除 + 对话区域 max-width 扩展 |
| v1.4.2 | 2026-08-20 | **10 项 Bug 修复 + 3 项架构增强** — ①默认模型显示彻底修复 ②右侧边栏 CI/CD 面板遮挡彻底修复 ③底部栏多余模型选择器删除 ④输入框聚焦紫色边框→透明 ⑤技能市场缓存机制 ⑥Git 分支按钮居中 + 刷新逻辑修复 ⑦右侧边栏白色背景修复 ⑧顶部栏空白区域消除 ⑨CicdPanel 白色背景修复 ⑩顶部栏右侧按钮居中副作用修复。架构增强：Cordis 插件系统时序改进三步方案 + SlotBridge 降级机制增强 + 头像系统升级 |
| v1.5.0 | 2026-08-21 | **Cordis "一切插件化" 工具发现机制** — `ToolDef` 新增 `guidance` 字段 + `toolsProvider` 自动注册 systemPrompt section + `buildSystemPrompt` 动态收集 + 全部 31 个工具补充 guidance + `skill-creator` 技能安装增强。31 文件修改，全量测试通过 |
| v1.5.1 | 2026-08-23 | **DSH 架构对标深度整改 + YAML 声明式插件加载 + 严重 Bug 修复** — ①YAML 声明式插件加载器（对标 DSH `cordis.patch.yml`，`config/codem.base.yml` + `codem.desktop.yml` 分层 bundle，80+ 插件声明式加载 + 拓扑排序 + `assertActivated` fail-loud 验证）②修复 LLM 回答重复问题（`saveMessages` 全量追加事件日志导致重复 → 移除事件投影路径强制只从 DB 读取 + 事件投影去重）③修复 llmEngine 未注册为 Cordis 服务 ④修复 mimoAuth 未注册 + PluginLoader.load() 未调用 ⑤SlotBridge/SlotRenderer 对标 DSH 重写（SlotErrorBoundary + fiber await 超时保护）⑥30+ Provider 文件统一改造（import + re-export + inject 声明对齐）⑦新增 `mimo-auth-provider.ts` + `buffer-polyfill.ts` + 3 个测试文件。118 文件修改（+2359/-1583 行） |
| v1.9.0 | 2026-08-31 | **上下文压缩过早触发治根修复 + 通用协议 API 配置 + 工具执行正确性修复** — 三根因（estimateMessagesTokens 永不回落 / 动态 provider 窗口 128k / 工具定义双算）+ getAgenticLoop 构造时同步 contextWindow + 通用协议 API 配置（Base URL + API key → 拉模型列表 → 持久化）+ read 去重键含 offset/limit + DecisionTray 审批内容修复（req.args → req.input）。新增 context-window-regression（8 例）+ custom-provider-config 测试。全量 115 文件 / 3950 用例通过 |
| v1.9.1 | 2026-09-01 | **对话任务步数计算对标改造 + 文件树显示隐藏文件夹 + 输入框/安全按钮修复** — 步数对标 codex 宏观计划步（总量固定、侦查类工具不推进、执行类首次出现才推进、标题中文语义化）+ 文件树显示隐藏文件夹（list_directory 加 show_hidden 参数 + FileExplorer 传 true）+ 输入框删除后高度不收缩修复 + 安全模式切换按钮 portal 误判修复。新增 step-progress-macro（6 例）+ file-tree-hidden（4 例）。全量 117 文件 / 3960 用例通过 |
| v1.9.2 | 2026-09-01 | **LLM 请求级超时加固 + 安全模式按钮颜色反馈 + 引导消息注入体验改造 + LLM 失败可见性** — complete 120s / stream 连接 60s 超时预算（修复 fetch 无超时永久挂起）+ 安全模式按钮按 ask/auto/full 显示蓝/紫/绿 + removeGuidanceMessage 注入后状态栏自动消失（复用主输入框发送引导消息）+ 移除任务完整性猜测机制 + EMPTY_RESPONSE 空响应检测 + 失败必须对用户可见（text_delta / too_many_errors / 空 toolCall 上报）。新增 llm-timeout-hardening（200 行）+ GUIDE-061/062 + LOOP-051~053。全量 119 文件 / 3985 用例通过 |
| v1.9.6 | 2026-09-02 | **打包版运行问题修复** — ①CSP `script-src`/`worker-src` 加 `blob:`（知识笔记本导入 docx 的 transformers.js WASM 动态加载不再被拦，修复"no available backend found"索引失败）+ `connect-src` 加 `ipc: http://ipc.localhost`（Tauri 自定义 IPC 不再回退 postMessage）②`config/codem.base.yml` 移除已删 @codem/terminal-bash（启动 YamlLoader failed 0）③extractJSON 失败尝试静默（不再刷屏）④generateSourceSummary 解析失败降级文本摘要（前 200 字，卡片不空白）⑤SubagentRuntime 动态 import 异步 → 静态 import 同步（9 个依赖 subagent 插件不再 PENDING，消除 assertActivated FAILED）。全量 145 文件 / 4102 用例通过 + tsc/cargo 零错误 |
| v1.9.5 | 2026-09-02 | **对话步骤语义化与动态插入（对标 dsh todo）+ token 消耗审计修复 + 全面功能审计修复** — ①步骤语义化：执行型任务强制 LLM 语义计划（任务意图检测修复"修复卡死"被判纯问答的根因 + planSteps 好/坏例 + 空白清洗）+ 新增 update_plan 工具（insert_before/after/append 动态插入、编号顺延、禁插已完成区、上限校验、成功回执新列表）+ 每轮计划上下文注入 + fromLlm 门控（语义计划不混入泛化步骤），测试 STEP-P1~P8 + STEP-L1~L9 ②token 审计（6 项，对齐 dsh 参数）：read 单次 100k→50k 字符、陈旧大工具结果 head+tail 裁剪（context-fold，8192/4096/1024）、7 低频工具 defer（schema 10.6k→7.5k tok/轮）、systemPrompt 工具目录/guidance 三重复裁剪、select 预算对齐真实窗口 + CJK 估算、截断丢历史零成本折叠摘要，测试 TOK-F1~F7 ③功能审计：PTY 关闭/退出杀进程树、TerminalPanel spawn 失败 DOM 残留清理、4 处裸 fetch 补超时、托盘退出先 flush 再退出。全量 145 文件 / 4102 用例通过 + tsc/cargo 零错误 |
| v1.9.4 | 2026-09-02 | **dsh-desktop 全面对标稳健性审计修复（15 轮迭代，42+ 项）** — ①崩溃检测与恢复（active-run.json 崩溃标记 + panic 落盘 codem-crash.log + previous-run-unclean 界面提示）②渲染崩溃恢复边界 AppErrorBoundary（白屏→恢复卡片，REC-R1~R6）③运行时文件日志 runtime_log.rs（按日 + 段轮转 4MB + 目录上限 24MB + 保留 14 天 + 统一脱敏，13 个 Rust 单测）④DB 保存失败可见性（事件提示 + 限流 + 3s 自动重试 + 恢复复位，DBSAVE-F1~F4）⑤命令超时杀进程树 + PowerShell 安全转义（HEAD^{tree} 崩溃修复）⑥fetchWithTimeout 统一超时全覆盖 + API 错误统一脱敏 + WebSocket 定时器泄漏修复 ⑦前端稳健性（全局错误 alert→记录 / 6 处 JSX 优先级 / 终端 pty-exit / mermaid strict / useWindowState / telemetry flush 保护 / mkdir Rust 化）。新增 repro-ps-command/exec-timeout/bash-abort/jsx-classname/redact + app-error-boundary + db-save-failure-alert。全量 141 文件 / 4079 用例通过 + tsc 零错误 + cargo 零警告 + cargo test 13/13 |
| v1.9.3 | 2026-09-02 | **安全模式完全访问修复 + 工具调用配对修复 + 输入框历史 wrap 修复 + 引导栏 UI 对标 wecode + 思考过程紫色样式恢复** — dbReady 时序修复（DB 就绪后重新同步 securityMode + 切项目重新解析）+ 委派/后台任务遵循用户安全模式（executor.ts 不再硬编码 auto）+ write 拒绝误判修复（限定 write 工具）+ 工具调用按 tool_call_id 精确配对（修复 API 400 insufficient tool messages）+ 输入框历史视觉行判断（wrap 折行不再误触发）+ 记忆检索正则元字符转义 + 引导栏卡片式三操作（立刻引导/编辑/取消）+ 思考过程紫色样式恢复。新增 10 个 repro 回归测试（34 用例） |
| v1.5.2 | 2026-08-24 | **大文件性能修复 + Agent Loop 无上限改造 + 模型系统动态化 + Skills 增量搜索** — ①Rust 新增 `read_file_lines` 分页读取（对标 DSH TextRetainer，O(limit) 内存）②Agent Loop 移除 `maxIterations` 硬上限，改为 `while(true)` + 三重安全阀（无进展检测 10 次 + Token 上限 2M + 子智能体有限迭代）③修复 `spawnForked` 深拷贝丢失 `tool_calls`/`toolCallId` 导致 API 400 ④模型选择器动态化（`codem-dynamic-models` 存储）⑤Skills 市场增量搜索（本地缓存 TTL 30min + 自动联网搜索）⑥终端切换崩溃修复⑦权限弹窗 fixed 定位⑧技能市场 tags 防御。11 文件修改（+558/-90 行），113 套件 3947 测试通过 |

### 6.2 v0.90.0 已发布功能（P0-P4 全量功能，commit 7435919，2026-07-31）

> v0.90.0 发布提交包含 P0-P4 全量功能 + 推理强度分档 + UI/UX 大幅优化 + 新手引导 + 梦幻皮肤磨砂玻璃 + 架构培训文档。以下为 P0-P4 变更全量清单。

#### 变更统计
- **已修改文件**：26 个（+5,415 行 / -2,156 行）
- **新增文件**：40+ 个（组件/核心模块/文档/类型声明）
- **TypeScript 编译**：0 错误
- **Lint 检查**：0 错误

#### 新增功能模块

##### P0: 滚动与 UX 基础
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 滚动条消息标记 | `ScrollbarMarkers.tsx`, `hooks/useScrollState.ts` | 滚动条上标注消息位置 |
| 滚动到底部指示器 | `ScrollToBottomIndicator.tsx` | 未读消息提示 + 一键回到底部 |
| 自动滚动优化 | `ChatPanel.tsx` | 修复滚动与未读指示器的交互冲突 |

##### P1: 高级 Agent 功能
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 事实核查模式 | `CorrectionModeToggle.tsx`, `CorrectionResultPanel.tsx`, `fact-check.ts` | 开启后 AI 回复自动核查 |
| AI 澄清交互 | `ClarificationForm.tsx`, `ask-clarification.ts` | AI 主动提问收集信息 |
| Todo 列表 | `TodoListDisplay.tsx`, `show-todo.ts` | AI 创建 Todo + 用户勾选 + DB 持久化 |
| 引导消息块 | `GuidanceBlock.tsx`, `guidance-queue.ts` | 引导消息折叠展示 |
| 流式等待提示 | `StreamingWaitIndicator.tsx` | 分阶段（思考/搜索/编码/审查）状态提示 |
| 代码工作台 | `Workbench.tsx` | 工具执行状态 + Git diff + 修改文件统计 |
| 模型选择弹窗 | `RegenerateModelPopover.tsx`, `model-config.ts` | 重生成时选择不同模型 |
| 消息反馈 | `FeedbackButtons.tsx` | 赞/踩 + DB 持久化 (`message_feedback` 表) |
| 消息内联编辑 | `InlineMessageEdit.tsx` | 点击编辑用户消息并重发 |
| 模型能力守卫 | `CapabilityGuard.tsx`, `capability-detector.ts` | 检测模型是否支持特定功能 |
| 管道步骤选择 | `PipelineNextStepDialog.tsx` | 多步骤任务上下文选择 |
| 输出解析器 | `output-parser.ts` | 结构化输出解析 |
| 模型解析器 | `model-resolver.ts` | 模型路由解析 |

##### P2: 体验提升
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 快捷短语 | `QuickPhraseSelector.tsx`, `settings.ts` (CRUD) | 分类短语模板 + `quick_phrases` 表 |
| 提示词草稿 | `PromptDraftPicker.tsx`, `prompt-draft.ts` | 版本管理 + A/B 对比 + `prompt_drafts` 表 |
| Agent 快速访问 | `QuickAccessCards.tsx` | 卡片网格 + 收藏 + 搜索 |
| 新手引导 | `OnboardingTour.tsx` | 4 步浮窗引导 + 首次启动检测 |
| RAG 来源引用 | `SourceReferences.tsx` | 消息底部来源芯片展示 |

##### P3: 多模态
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 图片画廊 | `ImageGallery.tsx` | 全屏 lightbox + 左右切换 + 下载 |
| 视频播放器 | `VideoPlayer.tsx` | 进度条 + 下载 + `MessageAttachment.type` 扩展 `"video"` |
| 生成模式选择 | `GenerateModeSelector.tsx` | 图片/视频生成模式切换 |
| 分辨率选择 | `ResolutionSelector.tsx` | 输出分辨率选项 |

##### P4: 智能输入
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 上下文徽章 | `ContextBadgeList.tsx` | 显示当前附件/技能上下文 |
| @ 提及补全 | `MentionAutocomplete.tsx` | 输入 `@` 触发文件/笔记本补全 |
| 技能补全 | `SkillAutocomplete.tsx` | 输入 `/` 触发技能列表 |
| 来源选择器 | `SourceSelector.tsx` | 知识来源选择 |

##### 知识管理增强
| 功能 | 关键文件 | 说明 |
|------|---------|------|
| 笔记管理 | `note-manager.ts`, `NoteEditor.tsx` | 笔记 CRUD + 版本历史 (`notes`/`note_versions` 表) |
| 闪卡系统 | `flashcard-store.ts`, `FlashcardViewer.tsx` | 闪卡存储 + 复习调度 (`flashcards` 表) |
| 知识图谱 | `graph-extractor.ts`, `KnowledgeGraphView.tsx` | 实体/关系提取 + 可视化 (`graph_nodes`/`graph_edges` 表) |
| 知识导出 | `exporter.ts` | 导出为 Markdown/JSON |
| 知识导入 | `importer.ts` | 批量导入来源 |
| 学习路径 | `study-path.ts` | AI 生成学习路径 |
| PPT 生成 | `ppt-generator.ts`, `ppt-types.ts`, `ppt/` | 从知识库生成 PPT |
| DOCX 查看 | `DocxViewer.tsx` | mammoth 库解析 DOCX |
| PDF 查看 | `PdfViewer.tsx` | pdfjs-dist 库渲染 PDF |
| 来源查看 | `SourceViewer.tsx` | 知识来源内容查看 |
| 笔记本工作台 | `NotebookWorkspace.tsx` | 统一笔记本工作界面 |
| 笔记本管理增强 | `NotebookManager.tsx` | +372 行增强 |
| 笔记本分组 | `storage.ts` | `notebook_groups` 表 |

##### 基础设施变更
| 变更 | 关键文件 | 说明 |
|------|---------|------|
| 模型配置集中化 | `model-config.ts` | `MIMO_MODELS`/`API_MODELS`/`getModelsForMode` 统一管理 |
| Session 类型扩展 | `types.ts` | 新增 `correctionMode`/`deepThinkingMode`/`preserveExecutor` |
| Message 类型扩展 | `store.ts` | 新增 `metadata` 属性 |
| Attachment 类型扩展 | `store.ts` | `type` 新增 `"video"` |
| AgenticLoop 事件扩展 | `agentic-loop.ts` | 新增 `clarification`/`correction_complete`/`pipeline_step_complete`/`todo_list_created` 事件 |
| DB Schema 扩展 | `database.ts` | +171 行，新增 10 张表 |
| i18n 扩展 | `lang.ts` | +141 行翻译键（P1-P4 全部组件） |
| CSS 扩展 | `styles.css` | +1,327 行（P1-P4 全部组件样式） |
| 新依赖 | `package.json` | katex/mammoth/pdfjs-dist/rehype-katex/remark-math |

### 6.3 v0.89 已发布功能

以下功能均已包含在 v0.89 发布版本中：

| 功能 | 关键文件 |
|------|----------|
| **跨会话委派编排** | `core/session/` (bus/orchestrator/executor/delegation-storage/tools) |
| **AgentManager UI** | `components/AgentManager.tsx`, `SettingsPanel.tsx` (高级Tab) |
| **HeartbeatMonitor UI** | `components/HeartbeatMonitor.tsx` |
| **RetryConfigPanel UI** | `components/RetryConfigPanel.tsx` |
| **PromptDebugger UI** | `components/PromptDebugger.tsx` |
| **LayeredSettingsPanel UI** | `components/LayeredSettingsPanel.tsx` |
| **RecoveryPanel UI** | `components/RecoveryPanel.tsx` |
| **ToolManager UI** | `components/ToolManager.tsx` |
| **DelegationPanel UI** | `components/DelegationPanel.tsx` |
| **上下文压缩配置UI** | `components/SettingsPanel.tsx`, `core/context/context.ts` |
| **AgentRegistry持久化** | `core/agent/agent.ts` (loadCustomAgents/saveCustomAgents) |
| **HeartbeatManager持久化** | `core/heartbeat/heartbeat.ts` (getGlobalConfig/setGlobalConfig) |
| **RetryExecutor持久化** | `core/retry/retry.ts` (getConfig/setConfig) |
| **冒烟测试** | `test/smoke-test.test.ts` (30个发布阻断级用例) |
| **回归测试V2** | `test/regression-*.test.ts` (9个文件, 155个用例) |

### 6.3.1 v0.88 已发布功能（含 v0.89 期间的后续优化）

以下功能均已包含在 v0.88 发布版本中（v0.89 期间做了多项优化）：

| 功能 | 关键文件 |
|------|----------|
| **桌面宠物系统** | `core/pet/pet-store.ts`, `PetWindowApp.tsx`, `PetSprite.tsx`, `lib.rs` (create_pet_window) |
| **宠物市场** | `PetMarketDialog.tsx`, `core/pet/pet-market-client.ts` (Petdex Manifest API) |
| **悬浮气泡通知** | `PetWindowApp.tsx` (canvas measureText精确测量+锚点resize), `pet-store.ts` (showBubble/showRawBubble) |
| **右键原生菜单** | `lib.rs` (show_pet_menu + MenuBuilder), `PetWindowApp.tsx` (handleContextMenu) |
| **Token查询** | `App.tsx` (pet-check-tokens-request事件), `pet-store.ts` (showBubble) |
| **宠物设置面板** | `SettingsPanel.tsx` (🐾Tab, 启用开关/大小滑轨/透明度滑轨/市场入口) |
| **精灵图动画** | `PetSprite.tsx` (CSS background-position帧动画, 9种状态含waiting/review/waving) |
| **Agent状态映射** | `pet-store.ts` (onLLMStatus/onStreamEvent → idle/thinking/working/happy/sad/sleeping/waiting/review/waving) |
| **开源声明** | `THIRD_PARTY_NOTICES.md` (Petdex MIT License) |
| **多页打包优化** ★ | `vite.config.ts` (rollupOptions.input pet.html), `pet-main.tsx` (轻量入口), JS Bundle 3.4MB→5.7KB |
| **锚点 resize（零漂移）** ★ | `lib.rs` (resize_pet_window_anchored + SetWindowPos), `PetWindowApp.tsx` (锚点定位+canvas测量) |
| **模型/模式持久化修复** ★ | `App.tsx` (DB就绪后configureEngine + 关闭时flushDatabase) |

### 6.3.2 v0.87 已发布功能

以下功能均已包含在 v0.87 发布版本中：

| 功能 | 关键文件 |
|------|---------|
| **Git Worktree 全链路** | `environment/`, `App.tsx`, `core/store.ts`, `GitInfoPanel.tsx` |
| **并行对话** | `App.tsx` (per-session Map), `llm/index.ts` (loopPool), `store.ts` (activeSessions) |
| **自动任务 (Automation)** | `automation/automation-manager.ts`, `SettingsPanel.tsx` |
| **InputArea 底部控制栏** | `InputArea.tsx` (项目/模式/分支/安全选择器) |
| **设置侧边栏分栏** | `SettingsPanel.tsx` (9个Tab) |
| **GitInfoPanel** | `GitInfoPanel.tsx` (分支/dirty/diff/commit/push/pull/worktree监控) |
| **梦幻皮肤磨砂弹窗** | 所有弹窗组件 Portal + `skin-dream.css` |
| **安全移除项目** | `App.tsx` (三按钮弹窗) + `lib.rs` (回收站删除) |
| **侧栏更多操作菜单** | `Sidebar.tsx` (absolute定位 + 点击/hover双模式) |
| **选项目打开最新对话** | `InputArea.tsx` (handleSelectProject) |
| **GitHub Clone** | `ProjectManager.tsx`, `GitHubCloneDialog.tsx` |
| **侧边栏布局重构** | `Sidebar.tsx` (分段控件 + 独立滚动 + Portal菜单) |
| **全局字体系统** | `public/fonts/`, `SettingsPanel.tsx`, `styles.css` (--font-family/--font-weight) |
| **SlashCommandMenu** | `SlashCommandMenu.tsx` (/ 命令菜单) |
| **Prompt Cache 优化** | `prompt.ts` (时间戳分钟精度) |
| **分段控件主题适配** | `styles.css` (color-mix + --accent) |

### 6.4 待办事项

| 项目 | 状态 | 说明 |
|------|------|------|
| **桌面宠物系统** | ✅ 已完成 | v0.88 发布，基于 Petdex MIT 集成 |
| **跨会话委派编排** | ✅ 已完成 | v0.89 发布，SessionMessageBus + DelegationOrchestrator + executeSessionTurn |
| **高级功能UI面板** | ✅ 已完成 | v0.89 发布，8个面板（AgentManager/HeartbeatMonitor/RetryConfig/PromptDebugger/LayeredSettings/Recovery/ToolManager/Delegation） |
| **核心模块持久化** | ✅ 已完成 | v0.89 发布，AgentRegistry/HeartbeatManager/RetryExecutor/SessionRecoveryService |
| **上下文压缩配置UI** | ✅ 已完成 | v0.89 发布，P1-1 压缩参数可视化配置 |
| **冒烟测试** | ✅ 已完成 | v0.89 发布，30个发布阻断级冒烟用例 |
| **REFACTOR-PROMPT-TO-DATA** | ✅ 已完成 | P0-P5 全部落地（编码运行时注入/cd拆分/Plan只读/频率限制/条件注册/子智能体拦截），143个测试 |
| **数据层设置系统** | ✅ 已完成 | `core/settings/` SettingsSource 层级 (cli/policy/flag/user/project/local/default) |
| **推理强度分档 + UI/UX 优化** | ✅ 已发布 | v0.90.0 发布，推理强度低/中/高/超高 + 统一按钮 + 新手引导 + 梦幻皮肤磨砂玻璃 |
| **P0-P4 全量功能集成** | ✅ 已发布 | v0.90.0 发布（commit 7435919），40+ 新组件已集成到 ChatPanel/MessageBubble/InputArea/App.tsx |
| **知识管理增强** | ✅ 已发布 | v0.90.0 发布，笔记/闪卡/图谱/PPT/导出导入/学习路径，10张新DB表 |
| **对标分析文档** | ✅ 已发布 | v0.90.0 发布，wecode-ref全局对标 + 笔记本功能差距分析（6份新文档） |
| **PTY 交互式终端** | ✅ 已发布 | v0.91.0 发布，portable-pty + 多会话 Tab + Ctrl+Shift+C 中断 + 停止按钮 |
| **文件变更追踪 Artifact** | ✅ 已发布 | v0.91.0 发布，turn_file_changes 表 + FileChangeTracker + git diff + SHA-256 + 回滚 |
| **文件树 Git 状态** | ✅ 已发布 | v0.91.0 发布，FileExplorer 解析 git status + 状态徽章 + 自动刷新 |
| **自动 Git Commit** | ✅ 已发布 | v0.91.0 发布，git-commit-service + finalize 后自动触发 + GitInfoPanel 自动刷新 |
| **Agent Profile 持久化** | ✅ 已发布 | v0.91.0 发布，agent_profiles 表 + SubagentTask.profile_id + spawner 注入 |
| **Needs You 精确提问** | ✅ 已发布 | v0.91.0 发布，needs-you-queue + NeedsYouPanel + needs_you_pending 表 |
| **异步 Agent 间通信** | ✅ 已发布 | v0.91.0 发布，agent-message-queue + agent_messages 表 + 迭代边界消费 |
| **浏览器预览面板** | ✅ 已发布 | v0.91.0 发布，create_browser_window + WebviewWindow |
| **Overview 可观测性** | ✅ 已发布 | v0.91.0 发布，Workbench 三视图（Status/Capacity/Activity） |
| **Transcript 缓存** | ✅ 已发布 | v0.91.0 发布，transcript-cache.ts SHA-256 键缓存 10min TTL |
| **v0.91.0 集成与测试项** | ✅ 已完成 | 自动Commit开关UI（GitEnvSettings）/ AgentProfile管理UI（SettingsPanel Advanced tab）/ DiffViewer已集成 / PTY跨平台shell检测（$SHELL fallback）/ NeedsYouPanel已集成 / TranscriptCache统计面板 / FileChangeTracker大patch预检查 |
| **P0-P4 组件集成项** | ✅ 已完成 | GenerateModeSelector/ResolutionSelector已渲染（InputArea多模态面板）/ SourceSelector已集成 / QuickAccessCards已集成 / CorrectionResultPanel已集成 / ClarificationForm已集成 / PipelineNextStepDialog已集成 / SkillAutocomplete由SlashCommandMenu覆盖 / note-operations已注册（tools.ts L922） |
| **UI 设计完全版改造** | ✅ 已完成 | 自定义缓动曲线（cubic-bezier）/ transition:all清零（三皮肤51处）/ 按钮按压反馈scale(0.97) / 弹窗transform-origin / 可访问性reduced-motion+reduced-transparency / 材质分层blur(20px)+blur(12px) / @starting-style入场现代化 |
| **v0.96 UI 大改版** | ✅ 已发布 | v0.96.0 发布，主对话窗口样式对标 frakio-work/wecode + 内联 Diff 批量审批 + 三皮肤暗色模式修复 + 梦幻皮肤自适应主题 + 富内容渲染系统 + Shiki 语法高亮 + 39 个新组件 |
| **v0.96.1 文件浏览器+Logo** | ✅ 已发布 | v0.96.1 发布，右侧栏文件浏览器体系重构 + 文件拖拽修复 + 全格式文件预览 + 应用Logo替换 + NSIS安装器图标修复 |
| **v0.96.2 CodeGraph+CI** | ✅ 已发布 | v0.96.2 发布，CodeGraph 代码知识图谱集成 + 测试套件改造(表面→行为) + CI Workflow |
| **v0.97.0 Agentic Loop 性能** | ✅ 已发布 | v0.97.0 发布，Tool Result 磁盘持久化 + ToolSearch 延迟加载 + Micro-Compact 摘要 + TranscriptCache 修复 + 工具系统增强 + 技能市场三大新源 + 技能发布 |
| **v0.98.0 多智能体协同** | ✅ 已发布 | v0.98.0 发布，TaskCenter 统一任务管理 + Squad 多智能体协同 + Issue 追踪+看板 + Autopilot 扩展 + Inbox 全局通知 + 5张新DB表 + 7个新LLM工具 |
| **v0.99.0 DSH 全量升级** | ✅ 已发布 | v0.99.0 发布，事件溯源 + 5层工具管线 + Plan Mode增强 + Capability Seam + Code Mode + Session Query + Goal 续行 + Workflow 编排 + Snapshot测试 + Telemetry + Bash后台 + 终端工具组 + i18n提示词 + MCP市场 + 语音STT/TTS + Ollama + CI/CD管理 + 技能安全沙箱 + 远程同步 + 代码质量工具 |
| **v1.0.0 插件系统+UI标准化** | ✅ 已发布 | v1.0.0 发布，Cordis DI 容器 + Plugin Loader + 18 Capability Seam + UI 插件包化 + 全弹窗 UI/UX 标准化 + 图标映射体系 + CSS 样式标准化 + 5个新测试文件/271+用例 + SlotBridge 泛型类型修复 |
| **DSH 对标全面整改** | ✅ 已完成 | v1.1.0 发布，Phase A-D 全部完成（孤岛模块接入 10 项 + 重复实现统一 4 项 + 缺失功能补齐 5 项）+ 5 Bug 修复 + 4 新测试文件 / 118 用例 |
| **UI 布局优化 + 插件条件渲染** | ✅ 已完成 | v1.1.1 发布，插件管理移至左下角 + CI/CD 移至右侧边栏 + 性能移至主对话框顶端 + 插件启用/禁用与按钮联动 + 宠物窗口关闭修复 + 工具 null 检查防御 |
| **Phase E: Work 模式拆分** | ⏳ 远期 | Codex/Work 双模式切换（E1-E7） |
| **MSI 中文向导** | ⏳ | WiX 多语言配置（zh-CN + en-US） |
| **更多 Provider 测试** | ⏳ | 目前主要测试 DeepSeek + MiMo + Ollama |
| **对话搜索完善** | ✅ 已完成 | v0.99.0 Session Query（FTS5 全文搜索）已实现 |
| **Vision API 图片理解** | ✅ 已完成 | v0.93.0 Vision Proxy 视觉代理全链路已实现 |

### 6.5 关键技术决策

#### A. 架构与基础设施

1. **SQLite via sql.js**：内存数据库 + 500ms 防抖持久化到 AppData，避免每次写操作都触发文件 IO
2. **handleSend 从 store 读取**：`useProjectStore.getState().currentSession` 避免闭包过期，确保并行对话时拿到最新 session
3. **弹窗用 createPortal**：绕过梦幻皮肤 `backdrop-filter` 的 containing block 问题，所有 Dialog/Menu 渲染到 `document.body`
4. **per-session Map 隔离**：所有 Promise-based UI（权限/写确认/提示词变更/表单）改为 `Map<sessionId, ...>`，支持多会话并行不串扰
5. **loopPool Map 隔离**：`llm/index.ts` 中 `loopPool: Map<sessionId, AgenticLoop>`，每个会话独立的迭代循环实例
6. **删除文件到回收站**：`delete_directory` 用 PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` 而非 `std::fs::remove_dir_all`，防止误删
7. **菜单用 position:absolute**：替代 `position:fixed`，避免梦幻皮肤 `backdrop-filter` 坐标偏移

#### B. LLM 引擎与上下文管理

8. **OpenAI 兼容 Provider 统一**：所有 Provider（DeepSeek/OpenAI/MiMo/自定义）共用 `OpenAICompatibleProvider` 类，通过 `ProviderRegistry` 管理，新增 Provider 只需配置 baseUrl + apiKey
9. **流式优先（SSE）**：所有 LLM 交互使用 `stream: true`，非流式仅保留 fallback；用户可随时通过 AbortController 取消
10. **Prompt Cache 优化**：System Prompt 时间戳截断为分钟精度（`minutePrecisionDate()`），同分钟内多次迭代 KV Cache 前缀稳定，命中率大幅提升
11. **reasoning_content 不回传**：历史 assistant 消息的 `reasoning_content`（DeepSeek 思考模式输出）不发送回 API，防止旧推理被当作隐式指令污染后续请求
12. **DeepSeek 中文推理注入**：DeepSeek 模型 + 中文模式时，向 system prompt 追加强制中文思考指令（`reasoning_content` 默认英文）
13. **Agentic Loop 迭代控制**：`maxIterations=20`、`maxConsecutiveErrors=3`，指数退避重试（5 次 / 1s 基础 / 2x 倍率 / 30s 上限 / 5min 总超时）
14. **上下文压缩（Compaction）**：context pressure 达 80% 触发 LLM 摘要压缩，旧消息替换为 compaction marker，支持级联压缩（已有 marker 时追加），防止 `consecutiveCompactions` 死循环
15. **优先级消息选择**：`selectMessagesByPriority()` 在 token 预算内智能选择保留哪些消息（system > recent > tool results > old user）
16. **成本追踪与降级**：`CostTracker` 实时追踪 token/费用，80% 预算降级到 compaction 槽位模型，100% 硬停止
17. **步数启发式估算**：`estimateSteps()` 分析用户消息关键词预估迭代次数（无需 LLM 调用），驱动 UI 进度条
18. **回顾性分析**：连续 2 次以上错误后，`getRetrospectiveHint()` 建议用户更新 AGENTS.md

#### C. 工具系统与安全

19. **并发工具执行**：只读工具（read/glob/grep/codebase_search/file_search/list_directory/web_fetch）可并行，`maxConcurrent=5`，写工具串行
20. **文件内容 LRU 缓存**：`FileContentCache` 50 条 / 60s TTL，write/edit 自动 invalidate，减少重复文件读取
21. **bash cd 自动拆分**：`cd <path> && <command>` 自动拆分为 `workdir + command`，LLM 无需知道 workdir 参数
22. **编码运行时注入**：所有 bash 命令自动 prepend `chcp 65001 + PYTHONUTF8=1 + PYTHONIOENCODING=utf-8`；`.bat/.cmd` 额外注入 `chcp 65001`
23. **三级安全模式**：`ask`（全部确认）/ `auto`（安全操作自动放行）/ `full`（从不询问），全局 + 项目级
24. **受保护路径**：`.git` / `.env` / `.mimo-snapshots` 等关键路径禁止写入
25. **写入前 Diff 审查**：已存在文件先做 diff，用户通过 `DiffViewer` 确认后才覆写
26. **沙箱路径白名单**：可选的 workspace 限制，`isPathWithinWorkspace()` 前端 + Rust 双重检查
27. **自定义权限规则**：模式匹配 `allow/deny/ask`，按 tool + resource 粒度配置
28. **参数密钥扫描**：write/bash 工具执行前扫描参数中的 API Key / 密码 / 私钥，检测到则警告（不阻断）

#### D. 数据层约束重构（REFACTOR-PROMPT-TO-DATA）

29. **Plan 模式 → 工具注册层强制**：Plan 模式下不注册 write/edit/multi_edit/tts/image_gen，API 层面 "tool not found"，不依赖提示词
30. **read_attachment 条件注册**：仅当对话中存在文档附件时才注册，防止 LLM 对纯文本对话幻觉调用
31. **子智能体两步运行时拦截**：同一 response 中同时有 `spawn_subagent` 和 `wait_for_subagent` 时，拒绝 wait 调用（task_id 尚未返回）
32. **单响应去重**：同一 response 中重复 read 同一路径 / 重复 wait 同一 task_id 自动去重

#### E. 记忆与知识管理

33. **三级记忆系统**：project / session / global 三级作用域，SQLite 持久化，max 1000 条/作用域
34. **记忆脱敏**：7 种正则模式（API Key / Bearer Token / 密码 / Secret / 私钥 / AWS Key / GitHub Token）在存储前自动 redact
35. **记忆提取触发**：上下文压缩完成后 + 回合结束后自动触发记忆提取（可 `/memory on|off` 控制）
36. **本地 ONNX Embedding**：WASM 后端零外部依赖，子分块 ≤128 token + mean pooling，7 种多领域模型可选，模型切换后旧索引自动跳过（维度不匹配保护）
37. **纯 TypeScript PDF 提取**：零依赖实现 FlateDecode 解压，不引入 pdf-parse 等原生模块

#### F. 子智能体与 MCP

38. **Fork-Join 模型**：`spawn_subagent` 返回 task_id，下一轮 `wait_for_subagent` 收集结果；随机人名标识（40 个名字池）
39. **未等待子智能体检测**：LLM 试图结束时检查 `spawnedSubagents` Set，有未 wait 的子智能体则注入提醒继续循环
40. **MCP stdio 传输**：子进程生命周期管理 + auto-reconnect + timeout + 正常 cleanup

#### G. 模型配置与设置

41. **多槽位模型路由**：7 个 TaskSlot（chat/subagent/memory/compaction/tts/imageGen/embedding），未配置的槽位沿 fallback 链向上查找
42. **七层设置源层级**：`cli > policy > flag > user > project > local > default`，支持企业策略覆盖用户配置

#### H. 桌面宠物与窗口

43. **独立透明宠物窗口**：`transparent + always_on_top + decorations:false + shadow(false)`，与主窗口通过 Tauri 事件双向通信；多页打包（`pet.html` + `pet-main.tsx`），JS Bundle 仅 5.7KB，彻底切断对主应用 3.4MB 包的依赖
44. **原生右键菜单**：Rust `MenuBuilder` 构建，避免浏览器菜单被透明窗口裁剪
45. **气泡高度自适应（锚点 resize）**：canvas `measureText` 精确测量文本宽高 → 前端传目标 `width/height` → Rust `resize_pet_window_anchored` 单次 `SetWindowPos` 原子设置位置+尺寸，以精灵图水平中心+底部为锚点，窗口尺寸变化时精灵图屏幕位置完全不动（零漂移）
46. **系统托盘集成**：`tray-icon` feature + `build_tray_menu` 实现最小化到托盘 / 恢复 / 退出
47. **DB 关闭时 flush**：`close-requested` 事件 + `handleCloseChoice` 中调用 `flushDatabase()`，确保 500ms 防抖写入在应用退出前立即刷盘，防止设置丢失
48. **模型/模式持久化修复**：DB 初始化完成后（`initDatabase` + `migrateFromLocalStorage` 之后）同步调用 `configureEngine()`，确保重启后正确恢复上次使用的模式（API/CLI）及对应模型

#### I. v0.96 UI 大改版决策

49. **内联 Diff 审查替代弹窗**：`InlineDiffReview` 在消息流内联展示 diff，支持批量审批 + 自定义指令，多文件审批不再逐个弹窗，用户体验显著提升
50. **Shiki 替换 react-syntax-highlighter**：Shiki 提供 VS Code 级别语法高亮（TextMate 语法 + VS Code 主题），渲染质量更高，支持所有语言
51. **富内容渲染系统**：`RichContent` + `ContentFrame` 统一管理代码/HTML/图片/JSON/数学公式/Mermaid/表格的渲染，每种内容类型有专用视图组件 + 全屏查看器
52. **梦幻皮肤自适应主题**：`ThemeManager.applyDreamCSS` 根据提取的调色板 `isDark` 自动设置 `data-theme`，`TitleBar` 在 Dream 皮肤激活时跳过 `data-theme` 覆盖，确保主题一致性
53. **工具调用 pill 胶囊风格**：`ToolCallCard` + `ToolCallGroup` 采用内联 pill 风格，同类工具合并展示，减少视觉噪音
54. **Framer Motion 动画引擎**：Toast/Drawer/BootSplash 等组件统一使用 Framer Motion 管理入场/退场动画，替代 CSS animation
55. **消息容器居中限宽**：`.messages-container` 添加 `max-width` + `margin: auto`，大屏下消息不会过宽，视觉节奏更清晰

#### J. v0.97 Agentic Loop 性能优化

56. **Tool Result 磁盘持久化**：`tool-result-storage.ts` 将工具执行结果持久化到磁盘，减少重复工具调用的 token 消耗
57. **ToolSearch 延迟加载**：工具定义懒加载，仅在 LLM 首次请求时注册，减少初始化开销
58. **Micro-Compact 摘要**：`micro-compact.ts` 在完整压缩之前先做轻量级摘要，减少 LLM 调用次数
59. **TranscriptCache**：`transcript-cache.ts` SHA-256 键缓存 10min TTL，相同请求直接命中缓存
60. **工具中断行为**：工具执行过程中支持中断（ctx.abort），清理半完成状态
61. **Bash 分析器**：`bash-analyzer.ts` 分析 bash 命令意图（读/写/网络/危险），辅助安全决策

#### K. v0.98 多智能体协同

62. **Squad Leader-Member 协议**：Leader 智能体可以 dispatch 任务给 Member 智能体，Member 完成后通过 Roster 协议汇报
63. **Issue 看板状态机**：7 状态（backlog/todo/in_progress/in_review/done/wont_fix/blocked）+ 4 优先级，看板拖拽改变状态
64. **Inbox 事件填充**：6 分类通知（delegation/issue/automation/error/system/goal），通过事件自动填充而非手动创建
65. **Autopilot Cron 引擎**：Cron 表达式解析 + 每 30 秒检查 + Issue 状态触发器，实现自动化任务调度

#### L. v0.99 DSH 全量升级

66. **事件溯源（Event Sourcing）**：`session_events` 表为唯一真相源，14 种 SessionEvent 类型 + `deriveMessages()` 投影函数，messages 表保留为 fallback
67. **5 层工具管线**：pre-execute（权限/hooks/bash-analyzer）→ monotonic guards（沙箱/受保护路径）→ execute（超时/重试/metrics）→ post-execute（接受/拒绝/替换/附加上下文）→ finalize（冻结结果写入事件流）
68. **Plan Mode 工具注册层强制**：Plan 模式下不注册 write/edit/multi_edit，API 层面 "tool not found"，不依赖提示词
69. **Capability Seam 三角色**：ServiceDefinition（接口）/ Provider（实现）/ Consumer（调用方），`SeamRegistry` 管理注册
70. **FTS5 全文搜索**：`session-search.ts` 基于 SQLite FTS5 实现跨会话搜索，支持短语/布尔/前缀/NEAR 查询
71. **ReplayAdapter 快照测试**：`fingerprintRequest` 指纹匹配 + `addResponse()` 内存快照，LLM 调用录制/回放
72. **Telemetry OpenTelemetry 格式**：`TelemetryCollector` 批量采集 + `telemetry_events` DB 表 + P50/P95 时延分析
73. **技能安全沙箱**：内容预检（远程脚本/iframe/eval 检测）+ 哈希签名验证 + 权限声明 + 安装审计日志

#### M. v1.0.0 插件系统架构

74. **Cordis DI 容器**：`SlotRegistry` 注册 18 个 Capability Seam + `PluginLoader` 拓扑排序加载/卸载 + 生命周期管理
75. **46 个 Provider 实现**：`provider/` 目录下 46 个 Provider 作为 Canonical 实现，`capabilities/` 仅保留接口定义
76. **UI 插件包化**：7 个 UI 插件包（ui-conversation/ui-market/ui-misc/ui-settings/ui-sidebar/ui-skin/ui-tool）+ Self-Referential Runtime
77. **弹窗统一结构**：所有弹窗统一 `modal-overlay` + `modal-editor` + 标准 header + 标准关闭按钮，涉及 35+ 组件
78. **图标映射体系**：`icon-map.ts` 统一图标包（7 个图标集 + `ToolEmojis`），消除所有直接 `lucide-react` 导入
79. **核心插件保护**：`riskLevel` + `locked` + `core` 属性标识 + 关闭核心插件二次确认
80. **SlotBridge 泛型类型**：从 `fallback` 组件 Props 自动推断参数类型，移除 `@ts-nocheck`，恢复严格类型检查

#### N. v1.1.0 DSH 对标整改

81. **CompactionControl 崩溃修复**：`repairCrashedSession()` 检测并修复上一会话未完成的工具调用，防止状态不一致
82. **Runtime Invariants**：debug 模式下检查 "visible = recorded" 不变量，确保模型可见的内容都已写入事件流
83. **Request Header 指纹追踪**：`trackRequestHeader()` 记录每次 LLM 请求的头指纹，检测缓存失效
84. **AgentMessageQueue 迭代边界消费**：Agent 间异步消息在迭代边界（非循环中间）消费，避免打断当前迭代
85. **OutputContractValidationMiddleware**：工具输出在 finalize 层验证契约（非空/合法类型/大小限制）
86. **TypedEventBus 严格事件系统**：事件发射前类型检查 + 作用域过滤（session 级 vs 全局级）
87. **指令分层加载**：global→deploy→project→session 四级分层加载，`buildSystemPrompt` 优先使用 `layeredInstructions`
88. **进程级沙箱 ACL**：前端 ACL 层（路径白名单/命令过滤/环境变量屏蔽），strict 策略阻止网络命令和敏感变量
89. **Dynamic Plugin 工具**：`cordis_define/inspect/run/stop/undefine` 五个工具，支持运行时动态加载/卸载 Cordis 插件
90. **包不变量检查**：`scripts/verify-package-invariants.ts` 检查包导出完整性和单例唯一性，CI 友好
91. **测试分层框架**：`test-layers.ts` 提供 snapshot + real-API e2e 框架，`shouldRunLayer()` / `shouldUpdateSnapshots()` / `isE2EMode()`

---

## 七、启动与测试

```bash
# 开发
npm run tauri dev          # 启动 Tauri 开发模式（Vite + Rust 热更新）

# 编译检查
npx tsc --noEmit           # TypeScript 编译检查
cd src-tauri && cargo check # Rust 编译检查

# 测试
npm test                   # 运行 Vitest 测试套件（全量 107 文件 / 3624 用例）
npm run test:coverage      # 测试 + 覆盖率报告
npm run test:e2e           # E2E 测试
npm run test:snapshot      # 快照测试
npm run verify             # 测试 + 覆盖率 + knip 死代码 + jscpd 重复检测

# 构建生产版
npm run tauri build        # 构建 NSIS exe + MSI

# 发布（构建 + 签名 + GitHub Release）
# 完整流程见 docs/RELEASE-GUIDE.md —— 必须按该文档执行！
# 直接跑 npm run tauri:build 会卡死：签名密钥是加密的（rsign encrypted secret key），CLI 会等交互密码输入
# 关键步骤：构建前设置签名环境变量，密码固定为 dummy：
#   $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
#   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
# 或直接运行根目录 build-release.ps1 一键完成「构建 + 签名 + 生成 latest.json」
```

---

## 八、版本历史

### v1.9.6（2026-09-02）— 打包版运行问题修复

> 用户报告知识笔记本导入 docx 报错与启动控制台告警，逐项定位修复：①CSP 允许 blob:（tauri.localhost 下 transformers.js/onnxruntime 用 URL.createObjectURL 动态 import WASM 被 script-src 拦截 → "no available backend found"、索引全部失败；script-src/worker-src 增加 blob:）②CSP connect-src 增加 ipc: http://ipc.localhost（Tauri v2 自定义 IPC 不再回退 postMessage）③config/codem.base.yml 移除已删除的 @codem/terminal-bash 条目（YamlLoader failed 0）④output-parser extractJSON 失败尝试静默、全部失败后单次 warn（消除导入多来源时的控制台刷屏）⑤generateSourceSummary 在模型未返回严格 JSON 时把输出清理后取前 200 字降级为文本摘要（此前仅 warn 留空、笔记本卡片无内容）⑥SubagentRuntime 由动态 import 异步创建改为静态 import 同步（import 链无值依赖循环），subagentProvider 不再拿到空 runtime → 9 个 inject ['subagent'] 插件正常激活（消除 assertActivated FAILED）。全量 145 文件 / 4102 用例通过 + tsc/cargo 零错误。

### v1.9.5（2026-09-02）— 对话步骤语义化与动态插入 + token 消耗审计修复 + 全面功能审计修复

> 对话步骤语义化（对标 dsh 客户端 todo 语义列表）：任务意图检测 looksLikeExecutableTask（修复"修复卡死的问题"被判纯问答 → 显示"回答问题"的根因）+ 执行型任务强制 LLM 语义计划（planSteps 好/坏例约束 + 空白标题清洗回退）+ 新增 plan-utils.ts（applyPlanUpdate：insert_before/after/append，编号顺延、禁插已完成区、空/重复/12 步上限校验、renderPlanSection 计划上下文渲染）+ agentic-loop 接入（activePlan 状态、planDirty 事件循环即时刷新 step_progress、每轮 systemPrompt 注入计划状态、fromLlm 门控防泛化步骤）+ tools.ts 新增 update_plan 工具（成功回执含插入后完整计划）。测试 STEP-P1~P8（11）+ STEP-L1~L9（6，驱动真实 loop 复现"第 3 步前插入修复调用链路→3/5 刷新→继续推进"）。
>
> token 消耗审计修复（用户报告同样任务比 dsh 大数倍；对照 harness 源码参数 6 项）：①read 单次结果上限 100k→50k 字符（对齐 dsh READ_MAX_BYTES≈50KB，中文内容此前 6 倍）②新增 context-fold.ts：陈旧大工具结果 head+tail 裁剪（保留最近 2 条完整，>8KB 裁为 4096+marker+1024，对齐 dsh pruner）+ 截断丢历史时插入零成本折叠摘要（打断失忆→重复劳动循环）③7 个低频大工具 defer（generate_ppt/browser_automate/figma_fetch/github_tool/workflow/image_gen/tts，schema 10.6k→7.5k tok/轮）④systemPrompt 工具信息三重复裁剪（tools:catalog 置空、guidance 仅核心工具、fallback 去列表）⑤select 预算对齐模型真实窗口（tracker.getContextWindow×90%）+ CJK 感知 estimateTokens（不再超窗口被截断）⑥token-tracker 新增 getContextWindow。测试 TOK-F1~F7。
>
> 全面功能审计修复：PTY close_pty/quit_app 杀进程树（taskkill /T /F，孙进程不再残留孤儿）+ TerminalPanel spawn 失败 dispose/移除 DOM + 4 处裸 fetch 补超时（web-provider/extractor/remote-client/search-deepseek）+ 托盘"退出"菜单 emit quit-requested → 前端 flushDatabase 后 quit_app（Rust 2.5s 兜底，防二次 exit）。全量 145 文件 / 4102 用例通过 + tsc/cargo 零错误。

### v1.9.4（2026-09-02）— dsh-desktop 全面对标稳健性审计修复（15 轮迭代）

> 对标 dsh-desktop（crash-evidence / renderer-health / log-files / shutdown 等机制）审计共有功能的稳健性，逐项修复 + 回归 + 重打包验证，bug 级清零收敛。崩溃检测与恢复：Rust 启动写 active-run.json（pid + 启动时间），quit_app / 托盘退出 / ExitRequested 三重清理，上次异常终止下次启动 emit previous-run-unclean → 界面提示；panic hook 追加 codem-crash.log（打包版 stderr 不可见时信息落盘）。
>
> 渲染崩溃恢复边界：新增 AppErrorBoundary 顶层错误边界（main.tsx 包裹），React 渲染崩溃不再白屏——恢复卡片提供重试渲染 / 重新加载应用 / 重置界面设置并重新加载（仅清 codem-* 本地键，不动 SQLite 会话数据），崩溃证据（脱敏）写 localStorage 下次启动提示。测试 REC-R1~R6。
>
> 运行时文件日志（对标 dsh log-files.ts）：新增 src-tauri/src/runtime_log.rs —— codem-runtime-YYYY-MM-DD.log 按日文件 + 段轮转（单文件 4MB × 3 段）+ 目录上限 24MB + 启动清理超 14 天 + 单行截断 8KB + 统一脱敏 mask_secrets（sk-/pk- 需 token≥10 防误伤，ghp_/AKIA/Bearer/Authorization/password= 贪婪型，重叠区间合并）。启动/崩溃/命令执行/超时杀树/PTY/退出/托盘全部落盘，best-effort。13 个 Rust 单测。
>
> 持久化失败可见性：saveDatabase 写盘失败（磁盘满/占用）不再静默——首次失败 dispatch codem:db-save-failed → guidance 提示，连续失败限流，3s 自动重试一次，成功复位并 dispatch 恢复事件。测试 DBSAVE-F1~F4。
>
> 命令执行与 PowerShell：execute_command 超时杀进程树（默认 600s，clamp 1s~1h；taskkill /T /F），修复 cmd.output() 同步阻塞 + Promise.race 超时后僵尸进程堆积；ps-command.ts 安全转义修复 git HEAD^{tree} 等含 {} 命令的 ScriptBlock 崩溃。
>
> 网络与 API：fetchWithTimeout（默认 20s）覆盖 github/figma/run-code/web-search/job-manager/workflow-engine/pipeline/sync-engine/skill-market；redact.ts 统一错误体脱敏；WebSocket onopen/onerror clearTimeout 泄漏修复。
>
> 前端稳健性：全局 error/unhandledrejection alert→记录；6 处 JSX 运算符优先级修复；TerminalPanel className 括号 + closeSession 函数式更新 + pty-exit 监听（僵尸会话回收）；mermaid securityLevel strict；useWindowState 窗口状态持久化（防抖 500ms，宽 ≥400/高 ≥300 校验）；telemetry flush isCompactionInProgress 保护 + 失败保留重试；配置文件 mkdir Rust 化。
>
> 会话/数据：messagesToLLMMessages 保留 reasoning + provider 双分支输出 reasoning_content；buildMessages 按 toolCallId 精确配对；bash 工具外部取消（ctx.abort）。
>
> 测试：新增 repro-ps-command / repro-exec-timeout / repro-bash-abort / repro-jsx-classname / repro-redact / app-error-boundary（REC-R1~R6）/ db-save-failure-alert（DBSAVE-F1~F4）+ KM-074 动态导入 flaky 30s 超时修复。全量 141 文件 / 4079 用例通过 + tsc 零错误 + cargo check 零警告 + cargo test 13/13。

### v1.9.3（2026-09-02）— 安全模式完全访问修复 + 工具调用配对修复 + 输入框历史 wrap 修复 + 引导栏 UI 对标 wecode + 思考过程紫色样式恢复

> 安全模式（完全访问）修复：App.tsx 的 dbReady 时序导致 securityMode state 在 DB 就绪前回退 ask（选择"完全访问"后重启仍弹审批），现在 DB 就绪后重新同步 + 依赖数组加入 currentProject?.path（切换项目重新解析，项目级 > 全局）；executor.ts 委派/后台任务不再硬编码 securityMode "auto"，改为 getEffectiveSecurityMode(cwd)（full 放行，非 full 后台自动拒绝）；agentic-loop 的 write 拒绝检测限定为 name === "write"（此前任何工具输出含 "User rejected the overwrite" 字面量被误判为用户拒绝写入，ask/auto/full 全部失效）。
>
> 工具调用配对修复：buildMessages 在上下文选择截断部分工具结果时，按 tool_call_id 精确配对——声明 N 个 tool_calls 但只有 M<N 个结果存活时只保留被满足的 M 个，修复 DeepSeek/OpenAI API 400 "insufficient tool messages"。
>
> 输入框历史浏览修复：textarea 是 pre-wrap 软换行，旧 guard 只检查 indexOf("\n")，wrap 折行（无换行符但视觉两行）时按 ↑ 直接填充历史；改为镜像测量（复制字体/宽度/行高）判断视觉行。
>
> 记忆检索正则元字符转义：用户查询词含 +/*/( 等元字符时 RegExp 抛 SyntaxError。
>
> 引导栏按钮 UI 对标 wecode 优化：单气泡改卡片式三操作（立刻引导/编辑/取消 + 状态胶囊），圆角浮卡样式。
>
> 思考过程紫色样式恢复（对标 v0.96.0）：ReasoningRow 折叠行文字 + Brain 图标改回紫色 #9333ea，展开体淡紫底 + 紫色左边框。
>
> 新增 10 个 repro 回归测试文件（34 用例）：repro-security-mode-full/engine-link/project-link/ui-sync/db-reset/ctx + repro-write-rejected-false-positive + repro-tool-pairing-400 + repro-input-history-wrap-guard + repro-memory-regex。

### v1.9.2（2026-09-01）— LLM 请求级超时加固 + 安全模式按钮颜色反馈 + 引导消息注入体验改造 + LLM 失败可见性

> LLM 请求级超时加固（对标 DSH request_timeout_seconds）：complete() 非流式总超时 120s，stream() 流式连接阶段超时 60s（首字节后沿用 120s idle timeout），修复 fetch 本身无超时导致服务端不返回时永久挂起、主循环卡死、activeSessions 残留的关键漏洞；withRequestTimeout 合并外部 abort signal 与超时预算、cleanup 解除连接阶段超时。安全模式按钮选中态颜色反馈：按 ask/auto/full 显示蓝/紫/绿（修复选中后无变色）。引导消息注入体验改造（对标 wecode markGuidanceApplied / Codex steering 消失）：store 新增 removeGuidanceMessage 注入成功后状态栏自动消失，移除 ChatPanel 独立引导输入框改为复用主输入框（onSendGuidance 双按钮）。LLM 失败可见性（对标 DSH 结构化失败上报）：移除任务完整性猜测机制（checkTaskCompleteness 不再正则猜测用户意图注入伪造 user 消息）+ EMPTY_RESPONSE 空响应检测 + 失败必须对用户可见（agentic-loop text_delta / App.tsx too_many_errors/error/空 toolCall 上报）。新增 llm-timeout-hardening.test.ts（200 行）+ GUIDE-061/062 + LOOP-051~053。全量 118 文件 / 3970 用例通过，tsc 零错误，cargo check 通过。

### v1.9.1（2026-09-01）— 对话任务步数计算对标改造 + 文件树显示隐藏文件夹 + 输入框/安全按钮修复

> 步数计算对标 codex 宏观计划步：总量固定为计划步数，侦查类小工具（read/glob/grep/tool_search）不推进步骤，执行类工具首次出现才推进，步骤标题中文语义化（读取文件/修改文件/执行命令/运行测试/委派子智能体）。文件树显示隐藏文件夹（Rust list_directory 新增 show_hidden 参数 + FileExplorer 传 true，.wecode-ref/.git 等可见；LLM 工具调用不受影响）。修复输入框删除内容后高度不收缩（absolute+inset:0 测量前重置 minH）+ 安全模式切换按钮点击不生效（portal 外部点击误判，新增 dropdownRef 排除判定）。新增 step-progress-macro.test.ts（6 例）+ file-tree-hidden.test.ts（4 例）。全量 117 文件 / 3960 用例通过，tsc 零错误，cargo check 通过。

### v1.9.0（2026-08-31）— 上下文压缩过早触发治根修复 + 通用协议 API 配置 + 工具执行正确性修复

> 上下文压缩三根因修复（estimateMessagesTokens 永不回落 / 动态 provider 模型窗口一律 128k / 工具定义双算）+ getAgenticLoop 构造时同步 contextWindow + 通用协议 API 配置（Base URL + API key → 自动拉模型列表 → 持久化）+ 刷新模型列表不再丢弃 contextWindow + read 单响应去重键含 offset/limit + DecisionTray 审批内容空白修复（req.args → req.input）。新增 context-window-regression.test.ts（8 例）+ custom-provider-config.test.ts。全量 115 文件 / 3950 用例通过。

### v1.6.2（2026-08-29）— 大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复

> 在 Codem 中嵌入完整的大富翁4风格桌面游戏，作为用户等待 LLM 执行任务时的休闲娱乐。游戏作为完全独立的大插件运行，零侵入主项目代码。Phase 1-10 全量交付 + 三轮审计修复 7 个关键 Bug。

**大富翁桌面游戏 — 完整版（Phase 1-10）：**

Phase 1-6（基础设施 + 核心玩法）：
- 棋盘渲染：Phaser 3 2D 俯视棋盘，36 节点环形布局 + 中心区域信息展示
- 动态骰子：3D 骰子动画，交通方式决定骰子数（步行1/机车2/汽车3）
- 地产系统：等级 0-3，地价/建造费/各等级过路费，连锁店标记
- 角色系统：8 个可选角色，各自不同初始资金/移动/投资能力
- 命运/新闻事件：40+ 种事件卡，包括移动/金钱/状态/股票效果
- 股票系统：6 支股票，价格波动 + 买卖 + 分红
- 卡片系统：10 种卡片，停留/免停留/送人/抢夺/升级/降级/查地图
- 道具系统：6 种道具，遥控骰子/飞弹/路障/机车/汽车/航母
- AI 策略：地产购买评估 + 升级评估 + 股票投资 + 卡牌使用 + 道具使用
- 存档/读档：完整序列化/反序列化，支持中途保存和恢复

Phase 7-9（视觉交互 + 核心机制对齐）：
- 地块图标映射 + 角色精灵动画 + 消息条系统 + 物价指数 + 住院/监狱/酒店/沉睡状态 + 连锁奖励/税收

Phase 10（G20-G36 开局设置 + 机制补全 + 体验补全）：
- G20 游戏天数选择（15/30/50/100 天）
- G21 玩家数量选择（热座模式 1-4 人 + AI 1-3 个）
- G22 初始资金选择（10000/15000/20000/30000）
- G23 胜利条件实现（2x/3x/5x/10x 倍率或仅比天数）
- G24 机场/传送点（付费传送至任意位置）
- G25 商业地块（保险购买 + 建筑公司购买/交费）
- G26 地产主动出售（卖地面板列出所有地产，半价出售）
- G27 股票分红（每回合自动发放 10% 分红）
- G28 银行拒绝机制（5% 概率审查高负债玩家 3 天禁贷）
- G29 多人热座（多人类玩家轮流操作）
- G30 帮助/规则（完整规则面板含地块/操作/经济说明）
- G31 财富面板（资产面板显示地产/股票/卡牌/道具）
- G32 资产清单（含在财富面板中）
- G33 日志增强（日志颜色 + 物价指数 + 胜利条件显示）
- G34 投降功能（确认后没收地产退出）
- G35 音量控制（滑块控制 0-100%）
- G36 速度调节（1x/2x/4x 速度选择）

**三轮审计 Bug 修复（7 项）：**
1. 破产清算逻辑 — 修复 `BankruptcySystem.ts` 中现金重复计算 Bug，变卖所得先累加再统一扣除债务
2. 玩家状态检查 — `GameEngine.ts` 的 `rollDice()` 添加住院/监狱/酒店/沉睡/停留状态检查
3. 全部破产保护 — 防止 `endTurn()` 中 `do...while` 循环在所有玩家破产时死循环
4. 命运事件前后移动 — 修复 `FortuneSystem.ts` 中 fortune_move 事件未实际移动玩家的问题
5. 初始资金应用 — 修复 `setInitCash()` 不追溯应用已有玩家的问题
6. AI 循环优化 — 游戏结束时停止 AI 轮询
7. 掷骰跳过检查 — 添加 `phase` 非 `moving` 时跳过自动移动间隔

**构建验证**：TypeScript 编译 0 错误，Vite 构建成功

### v1.1.1（2026-08-17）— UI 布局优化 + 插件条件渲染 + 宠物窗口 Bug 修复 + 工具调用防御性检查

> v1.1.0 的增量修复版本。修复宠物右键关闭导致应用退出的问题，优化 UI 布局，实现插件启用/禁用状态与按钮/面板的联动显示，修复插件管理面板 Cordis Context 初始化时序问题，并为所有工具 execute 回调添加服务 null 检查防御。

**Bug 修复（4 项）：**
- 宠物窗口关闭 Bug — Rust `CloseRequested` 拦截器区分宠物窗口和应用窗口（`src-tauri/src/lib.rs`）
- 插件管理面板初始化失败 — 添加重试机制等待 Context 就绪 + 修正 `ctx.get?.()` 为直接属性访问（`PluginManager.tsx`）
- UI 组件 useCtx() 崩溃 — 改为 `tryGetCtx()` 返回 null（`ui-cordis/index.tsx`、`plugin-market.tsx`）
- 工具 execute 回调缺少 null 检查 — 6 个工具 Consumer 文件添加 `if (!ctx.xxx) return 'not available'` 防御

**UI 布局优化（3 项）：**
- 插件管理按钮移至左下角用户信息右侧（`Sidebar.tsx`）
- CI/CD 移至右侧浮动面板 PanelSidebar（`PanelSidebar.tsx`）
- 性能移至主对话框顶端 panel-tabs（`App.tsx`）

**插件条件渲染：**
- 插件关闭后对应按钮和面板自动隐藏，启用后重新显示
- `App.tsx` 监听 `codem:plugin-state-changed` 事件 + `localStorage` 变化
- 当 tab 对应插件被禁用时自动回退到默认 tab

### v1.1.0（2026-08-16）— DSH 对标全面整改 + 测试体系深化 + Bug 修复

> Phase A-D 全部完成，消除所有功能孤岛、统一重复实现、补齐缺失功能。22 文件修改，24 个新文件。全量 107 文件 / 3624 用例全部通过。

**Phase A — 孤岛模块接入（10 项）**：compaction-control（崩溃修复）/ output-contract（finalize 层验证）/ feedback（EventLog 双写）/ type-safety（Branded 类型）/ event-system-strict（TypedEventBus）/ cookbook（re-export）/ persistence-provider（后端切换）/ replay-adapter（CODEM_REPLAY_MODE）/ preset-discovery（AgentRegistry 构造函数）/ agent-message-queue（迭代边界消费）

**Phase B — 运行时不变量 + 请求头追踪 + 事后复盘（10 项）**：runtime-invariants / request-header / postmortem / type-safety 增补 / event-system-strict 增补 / cookbook 增补 / persistence-provider 增补 / replay-adapter 增补 / preset-discovery 增补 / agent-message-queue 增补

**Phase C — 重复实现统一（4 项）**：capabilities/ vs provider/ 统一（provider/ 为 Canonical）/ Telemetry-CostTracker 统一 / projectedTokens 补齐 / seam-dsh-compat deprecation

**Phase D — 缺失功能补齐（5 项）**：代理指令分层（`instruction-layers.ts`）/ 进程级沙箱 ACL（`sandbox-acl.ts`）/ Dynamic Plugin 工具（`dynamic-plugin-tools.ts`）/ 测试分层框架（`test-layers.ts`）/ 包不变量检查（`verify-package-invariants.ts`）

**Bug 修复（5 个）**：ESM require→import / fire-and-forget .catch() / TranscriptCache.clear() / 网络命令阻断 / 敏感环境变量屏蔽

**测试体系深化（4 文件 / 118 用例）**：dsh-integration-full（53）/ plugin-disable-impact（18）/ functional-chain-closed-loop（12）/ extended-test-methods（35：模糊+属性+契约+链路探针）

### v1.0.0（2026-08-15）— UI/UX 标准化 + 插件系统架构 + 测试体系全面升级

> Codem 从 0.x 迈向 1.0 的里程碑版本。67 文件修改（+1112/-641 行），5 个新测试文件，3552 用例全部通过。

**P4 — Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seam**：`SlotRegistry` 注册表 + `initSlots()` 初始化 18 个 Capability Seam + `PluginLoader` 拓扑排序 + 加载/卸载 + 生命周期管理

**P5 — 全能力族拆分（13 个独立能力族）**：FS / Shell / Sandbox / Web / Skill / Subagent + 凭证 / 附件 / 知识 / 调度 / 目标 / 计划 / 后台任务

**P6 — UI 插件包化 + 插件市场基础设施**：7 个 UI 插件包 + Self-Referential Runtime + 插件市场 Manifest + 安装/卸载流程

**UI/UX 全面标准化**：弹窗统一 `modal-overlay` + `modal-editor` + 标准 header + 标准关闭按钮（35+ 组件）/ 图标映射体系（7 图标集 + ToolEmojis）/ CSS 样式标准化（硬编码→CSS 变量）/ 核心插件保护（riskLevel + locked + core）

**测试体系全面升级（5 文件 / 271+ 用例）**：icon-standardization（97）/ trigger-call-execute-loop（30+）/ extended-quality-suite（80）/ plugin-dependency-graph（24+）/ plugin-disable-impact（40+）

**补丁修复**：SlotBridge 泛型类型修复（`[key: string]: any` → 泛型函数 `SlotBridge<P>`）+ 恢复 `noImplicitAny` 严格检查 + App.tsx 参数类型精确化

### v0.96.2（2026-08-11）— CodeGraph 集成 + 测试改造 + CI Workflow

**CodeGraph 代码知识图谱集成**
- 新增 CodeGraph 自动检测与 MCP Server 注册（`src/core/mcp/mcp.ts`）
  - `isCodeGraphEnabled()` / `setCodeGraphEnabled()` — 设置开关（默认启用）
  - `hasCodeGraphIndex(projectPath)` — 检测项目 `.codegraph/` 目录
  - `autoDetectCodeGraph(registry, projectPath)` — 自动连接 CodeGraph MCP Server（stdio: `codegraph mcp`）
  - `disconnectCodeGraph(registry)` — 断开连接
  - `hasCodeGraphTools(registry)` — 检查 codegraph 工具可用性
- 系统提示词增强（`src/core/prompt/prompt.ts`）— `codeGraphEnabled` 字段注入"优先使用 codegraph_explore"指导
- LLMEngine 集成（`src/core/llm/index.ts`）— `buildSystemPromptAsync()` 打开项目时自动检测 `.codegraph/` 并连接 MCP Server
- 设置页面新增"代码图谱"标签页（`SettingsPanel.tsx` → `CodeGraphSettingsSection`）
  - 启用/禁用开关
  - CLI 状态检测（`codegraph --version`）
  - 当前项目索引状态 + 一键构建（`codegraph init`）
  - 安装命令引导 + 基准数据展示

**测试套件改造 — 表面测试 → 行为测试**
- `phase-b-f-regression.test.ts` B1-B3+B8：`readFileSync` + `toContain` 改为真实模块调用
  - B1: `parseSkillMarkdown()` 解析测试 SKILL.md 验证返回字段
  - B2: `getSkillToolRegistry()` + `getBuiltinProviderFactory()` 行为验证
  - B3: `await import()` 动态加载验证导出
  - B8: `getSkillRegistry().buildSkillPrompt()` 返回字符串验证
- `encoding-tools.test.ts`：硬编码 description 字符串改为 `createDefaultToolRegistry().get("bash")` 真实工具验证
- `context-consistency.test.ts` P0-1：模拟 `buildMemoryPrompt` 改为 `getMemoryService().buildMemoryPrompt("project")` 真实调用

**CI Workflow + 构建修复**
- 新增 `.github/workflows/ci.yml`（`npm ci` + `tsc --noEmit` + `vitest run` + `cargo check`）
- 修复 Vite dev server EBUSY 错误（`vite.config.ts` 添加 `watch.ignored: ["**/src-tauri/target/**"]`）

**CodeGraph 集成测试**
- 新增 `src/test/codegraph-integration.test.ts` — 49 个用例，4 层覆盖：
  - MCP 层（22 用例）：设置读写、索引检测、CLI 检测、自动连接、断开、工具匹配
  - Prompt 层（7 用例）：中英文注入、禁用不注入、MCP Tools 共存
  - LLMEngine 集成（6 用例）：导出验证、工具联动
  - 端到端 + 边界场景（14 用例）：完整流程、null/undefined 路径、中文路径、幂等性、项目切换

**验证结果**
- `tsc --noEmit`：零错误
- `vitest run`：72 文件 / 2872 用例全部通过
- `cargo check`：Exit 0

### v0.96.1（2026-08-10）— 右侧栏文件浏览器优化 + 拖拽修复 + 暗色模式修复 + Logo替换

**右侧栏文件浏览器体系重构**
- 右侧栏宽度对标 wecode（默认 420px，可调 360-620px）
- 移除分栏膨胀逻辑（不再挤压主对话窗口）
- 文件预览改为单栏替换模式（占满侧栏宽度 + 返回按钮）
- 文件编辑器新增「放大浏览」悬浮窗口（createPortal + 90vw×90vh 全屏预览）
- 右侧栏启动时默认收缩

**文件拖拽修复**
- 修复 Tauri v2 `dragDropEnabled` 默认拦截 HTML5 拖拽事件问题（`tauri.conf.json` 设为 `false`）
- 修复 `InputArea` `onDragOver`/`onDragEnter` 缺少 `dropEffect = "copy"` 导致禁止符号
- 修复 `usePaneResize` 拖拽方向反转（左边缘手柄 delta 计算修正）
- 修复 `handleUp` 使用全局 `event` 变量 bug（改为从 PointerEvent 参数获取）

**暗色模式 + 主题修复**
- Hub 皮肤强制 `data-theme=dark`（ThemeManager + codem-ui.css 双保险）
- TitleBar DB 初始化后重新读取保存的主题，避免状态与 DOM 不一致
- 暗色模式 CSS 变量体系完善（glass-border / tool-card-border / composer-border 等）
- 梦幻皮肤段落 hover 移除 + AI 消息 hover 磨砂高亮
- ShikiCodeBlock 暗色模式代码块背景修复

**文件编辑器增强**
- 新增图片/PDF/Excel/Word/视频/音频/HTML 全格式预览
- 代码编辑器 Shiki 语法高亮 + 行号 + Tab 缩进 + 自动配对括号
- 文件保存（Ctrl+S）+ 修改状态指示

**MentionAutocomplete 重写**
- 输入 @ 弹出文件列表，支持过滤选择
- 文件/文件夹/笔记本类型图标区分

**应用 Logo 替换 + 安装包图标修复**
- 应用 Logo 替换为 `icos/codem.ico`（紫色渐变背景 + 代码括号图标）
- 使用 `sharp` + `png-to-ico` 从 `codem-1024.png` 生成 **BMP 格式**多尺寸 ICO（16/24/32/48/64/128/256），解决 `tauri icon` 生成的 PNG 格式 ICO 在 Windows 资源编译器下颜色损坏问题
- `tauri.conf.json` NSIS 配置新增 `installerIcon` 字段，显式指定安装器图标路径
- 全量 `cargo clean` + 重新构建，确保 `resource.lib` 正确嵌入新图标
- GitHub Release v0.96.1 安装包已更新为图标修复版

### v0.99.0（2026-08-14）— 对标 DeepSeek Harness 全量升级

> 本次更新是 Codem 内核架构史上最大规模的对标升级：以 DeepSeek Harness (dsh) 为唯一对标对象，系统性追平 31 项差距。25 文件修改（+1721/-313 行），50+ 新文件。全量 99 文件 / 3234 用例全部通过。

**P0 — 架构基础（4 项）：** 事件溯源会话日志（14 种 SessionEvent + deriveMessages() 投影 + Fork/Replay）/ 5 层工具管线 / Plan Mode 增强（exit_plan_mode 工具 + dsh 6 段提示词规范 + PlanApprovalCard 审批 UI）/ 测试覆盖率门控（v8 coverage + per-file 阈值 70%+）

**P1 — 功能增强（5 项）：** 进程级沙箱（Windows ACL + SandboxGuard 中间件）/ Code Mode（TypeScript 执行器 + ToolSDK）/ Session Query（FTS5 全文搜索）/ 防御性模式文档（7+ 条规则）/ Agent Notes/ADR（3 篇架构决策记录）

**P2 — 架构提升 + 功能补齐（14 项）：** Capability Seam（三角色抽象）/ Workflow 编排（JavaScript fan-out 子智能体）/ Goal 自动续行（3 个 LLM 工具 + goals DB 表）/ Snapshot 测试（ReplayAdapter 录制/回放）/ Telemetry（OpenTelemetry 采集 + PerformanceDashboard）/ 代码质量工具（knip + jscpd）/ Bash 后台模式（JobManager + 3 个工具）/ 终端 LLM 工具组（4 个工具）/ Postmortem 体系 / 测试分层补齐（e2e + snapshot 配置）

**P3 — 远期完善（12 项）：** MCP 市场（30+ 预设目录 + 一键安装）/ 语音 STT/TTS（Web Speech API）/ Ollama 本地 LLM（REST API + 离线推理）/ CI/CD 管理（GitHub Actions）/ 技能安全沙箱（内容预检 + 哈希签名）/ 远程同步引擎（seq 增量同步）/ i18n 提示词重构（17 个模板段）/ Adaptive Idle Tracker / Cron 引擎增强 / 事件系统增强（GuardHook/FinalizeHook）/ 消息存储增强（FTS5 + 事件流双写）/ 数据库初始化修复

### v1.0.0（2026-08-15）— UI/UX 标准化 + 插件系统架构 + 测试体系全面升级

> Codem 从 0.x 迈向 1.0 的里程碑版本。67 文件修改（+1112/-641 行），5 个新测试文件，3552 用例全部通过。（详见上方版本历史摘要）

### v0.96.0（2026-08-08）— 主对话窗口 UI 大改版 + 内联 Diff + 富内容渲染

（详见 TODO.md）

### v0.96.1（2026-08-10）— 右侧栏文件浏览器优化 + 拖拽修复 + 暗色模式修复 + Logo替换

（详见上方版本历史摘要）

### v0.96.2（2026-08-11）— CodeGraph 集成 + 测试改造 + CI Workflow

（详见上方版本历史摘要）

### v1.4.2（2026-08-20）— 10 项 Bug 修复 + Cordis 插件时序改进 + SlotBridge 降级机制增强 + 头像系统升级

> 针对用户实际使用反馈的 10 项 Bug 修复 + 3 项架构增强。20+ 文件修改，`tsc --noEmit` 零错误 + `vitest run` 全量通过。

**Bug 1 — 默认模型显示错误（彻底修复）**：`dbReady` 时同步读取 settings 更新 model/mode/provider；`engineRef` 的 `useEffect` 在 DB 就绪后重新调用 `configureEngine`；`model-badge` 显示友好名称；`getConfiguredApiModels` 中 `name` 属性从 `m.id` 改为 `m.name`。

**Bug 2 — 右侧边栏 CI/CD 面板被外窗口遮挡（彻底修复）**：`PanelSidebar` 使用 `createPortal` 渲染到 `document.body`，提升 `z-index`；调整 `right` 和 `maxWidth` 确保 CI/CD 面板完整可见。

**Bug 3 — 默认皮肤底部栏 UI 不一致 + 多余模型选择器**：删除 `InputArea` 底部栏的 `ModelSelector` 渲染逻辑；调整 `.input-control-bar` 样式。

**Bug 4 — 输入框聚焦时出现紫色边框**：`.composer-inner:focus-within` 的 `border-color` 改为 `transparent`。

**Bug 5 — 技能市场加载慢（缓存机制）**：实现技能市场缓存机制 — 首次加载后缓存列表信息，再次进入时先加载缓存快速显示；刷新按钮改名为"检查更新"，点击时更新列表并覆盖缓存。

**Bug 6 — Git 分支按钮未居中 + 一直刷新**：为 `.titlebar-center` 添加居中样式；修复 `GitBranchSelector` 的 `refreshInterval` 逻辑，添加是否为 git 仓库的检查；`!workDir` 时返回占位按钮而非 `null`。

**Bug 7 — 右侧边栏边缘白色背景 + 拖拽影响左侧边栏**：移除 `.app-content` 的 `padding-right`；给 `.sidebar` 添加 `position: relative`。

**Bug 8 — 顶部栏左侧和左侧边栏之间空白区域**：删除 `.sidebar-header`，将收起按钮移入 `.sidebar-nav`；恢复 `.titlebar-icon` 和 `.titlebar-title` 的显示。

**Bug 9 — CicdPanel 白色背景**：`CicdPanel` 背景改为 `transparent`。

**Bug 10 — 顶部栏右侧按钮被居中（Bug 6 修复副作用）**：为 `.titlebar-left` 和 `.titlebar-nav-actions` 添加 `flex-shrink: 0`；修改 `.titlebar` flex 布局使 Git 分支按钮居中、右侧按钮靠右。

**增强 1 — Cordis 插件系统时序改进（三步方案）**：第一步，`getCordisContext()` 中将 `setTimeout(0)` 替换为显式等待所有 fiber 就绪 (`fibers.map(f => f.await())`)；第二步，`consumer/index.ts` 中为关键服务获取函数添加重试等待机制 (`getServiceAsync`)；第三步，`loadDefaultProviders()` 中添加 `internal/status` 事件监听器记录 fiber 状态变更日志。

**增强 2 — SlotBridge 降级机制健壮性增强**：新增 `SlotErrorBoundary` 包裹插件组件，崩溃时自动回退到 fallback；为关键 slot 添加 `showDegraded` prop，异常时显示降级提示；`SlotListBridge` 在 slots 服务不可用时输出警告日志。

**增强 3 — 头像系统升级**：从 Multiavatar 切换回 DiceBear API（URL 生成方式，无需 npm 依赖）；预设头像从 12 个扩展到 50 个，混合 13 种 DiceBear 风格。

### v1.4.1（2026-08-19）— 插件管理初始化修复 + 技能市场性能优化 + 对话区域自适应 9 项 Bug 修复

> 针对用户实际使用反馈的 9 项 Bug 修复。同 v1.4.0 补丁（不更新版本号）。10 文件修改，`tsc --noEmit` 零错误。

**Bug 1 — 插件管理页面“Cordis Context 尚未初始化”彻底修复**：`getCordisContext()` 在 `loadDefaultProviders(ctx)` 后加 `await new Promise(setTimeout 0)` 等待 fiber 激活；`PluginManager.tsx` 重试次数 50→100，最终失败用 non-strict fallback。

**Bug 2 — 技能市场 ClawHub/Skills.sh/SkillHub 加载很慢**：三大市场源 MAX_PAGES 大幅减少 — ClawHub 20→3、Skills.sh 10→2、SkillHub 20→3。

**Bug 3 — 启动后默认模型显示 mimo-v2.5-pro 而非上次保存的 deepseek**：`configureEngine` 在 `saved` 为 null（DB 未就绪）时也重试（200ms 间隔）。

**Bug 4 — CI/CD 面板太靠右被遮挡 + 界面元素太大有关闭按钮**：去掉 `CicdPanel` 的 header 和关闭按钮，`onClose` 改为可选 prop。

**Bug 5 — 对话框编辑框圆角太大 + 梦幻皮肤毛玻璃未适配**：三套皮肤 `.input-card-container` 圆角统一为 12px（基础 20px、梦幻 16px、Hub 16px → 12px）。

**Bug 6 — 首页区域未自适应窗口分辨率**：`.empty-state` 和 `.new-chat-page` 的 `justify-content: center`→`flex-start`，去掉 `height: 100%`，加 `padding` 和 `width: 100%`。

**Bug 7 — 首页 Write Code 显示不全 + Tips 消失**：prompt 从半句改为完整提示语 `"Help me write code: "` / `"帮我编写代码："`。

**Bug 8 — 顶部对话/终端/性能区域多了 CI/CD 按钮**：从底部面板 tab 栏移除 CI/CD 按钮和面板渲染（CI/CD 保留在右侧边栏 PanelSidebar 中）。

**Bug 9 — 对话区域不按窗口大小自适应**：`.chat-body` 添加 `flex-direction: column`；`.messages-container` 和 `.input-area > .input-card-container` 的 `max-width` 从 `clamp(100%, 75vw, 1100px)` 改为 `clamp(100%, 90vw, 1400px)`。

### v1.4.0（2026-08-19）— UI/UX 体验优化 11 项 Bug 修复 + 性能/CI-CD 面板切换化 + 梦幻皮肤一致性修复

> 针对用户实际使用反馈的 11 项 Bug 修复 + 编译 warnings 全部清零。15 文件修改，`tsc --noEmit` 零错误 + `tauri build` 零 warning。

**Bug 1 — 技能市场 skill.sh 插件内容显示乱码**：Skills.sh HTML 爬取正则匹配范围过宽，会匹配到 HTML 标签属性。收紧正则为只匹配字母数字和连字符组成的路径段 + 增加二次清洗过滤残留非法字符。

**Bug 2 — 技能市场外部技能加载很慢**：Rust 层 `http_get` 超时从 30s 减为 15s，`http_download` 从 120s 减为 60s。

**Bug 3 — 智能体定义管理窗口点击新建后视觉锚点未滚动**：增加 `editorRef`，在 `handleNew`/`handleEdit` 中调用 `scrollIntoView` 滚动到编辑区域。

**Bug 4 — 启动后模型选择默认显示 mimo-v2.5-pro**：`configureEngine` 在 engine 未就绪时增加 200ms 自动重试逻辑。

**Bug 5 — 右侧栏 CI/CD 管理面板太靠右被遮挡且弹窗改为面板切换**：`BottomTab` 类型增加 `cicd`，`CicdPanel` 从 `createPortal` 弹窗模式改为内嵌面板模式。

**Bug 6 — 梦幻皮肤下对话编辑框区域透明度未适配毛玻璃**：`backdrop-filter` 加上 `!important` 和 `saturate(1.4)`，增加深色模式背景色覆盖。

**Bug 7 — 梦幻皮肤下主对话框圆角与边栏直角风格不一致**：`.sidebar` 增加 `border-radius: 16px` 和 `margin: 8px`，`.right-sidebar` 增加毛玻璃背景和圆角。

**Bug 8 — 首页区域未自适应窗口分辨率**：`.new-chat-page` 和 `.empty-state` 增加 `min-height: 100%` 和 `overflow-y: auto`。

**Bug 9 — 首页点击 write code 等按钮编辑框内容未清理和显示不全**：新增 `suggestionPrompt` + `onSuggestionConsumed` prop 机制，建议卡片点击时直接替换输入框内容。

**Bug 10 — 深色模式下安全策略按钮白色底色突兀**：给 compact 按钮加上 `security-mode-btn` class，深色模式下使用紫色边框透明背景样式。

**Bug 11 — 性能面板应改为面板切换而非弹窗**：`PerformanceDashboard` 从 `createPortal` 弹窗模式改为内嵌面板模式。移除了 `showPerfDashboard` 弹窗渲染。

**编译 Warnings 清零**：修复 4 个 Rust warnings — 多余分号、未使用变量 `window`→`_window`、未读取字段 `id`→`_id`、`Cargo.toml` 添加 `[lints.rust]` 配置 `linker_messages = allow`。

