# Codem 项目完整说明

> **用途**：新对话快速理解项目全貌、架构、文件关联、当前状态。
> 创建时间：2026-07-23 | 最后更新：2026-09-10 | 当前版本：v1.13.0（图书馆插件集成手绘像素美术 — 场景直接用 ClawLibrary 的图书馆像素画 + Capy/Cat 角色精灵；监控面板对标 lobster-pet 重排，图书馆作为监控界面内的一张卡；资源许可与义务见 docs/ASSET-LICENSES.md）
>
> **版本历程概览**：v0.70 基础存储 → v0.80 轮次架构 → v0.87 Worktree/并行 → v0.88 桌面宠物 → v0.89 跨会话委派 → v0.90 P0-P4 全量功能 → v0.91 Coding 工作台 → v0.92 Codex 对标 → v0.93 Vision Proxy → v0.94 配置修复 → v0.95 CLI/API 视觉代理 → v0.96 UI 大改版 → v0.97 Agentic Loop 性能优化 → v0.98 多智能体协同 → v0.99 DSH 全量升级 → v1.0.0 插件系统架构 + UI/UX 标准化 → v1.1.0 DSH 对标整改 + 测试深化 → v1.1.1 UI 布局优化 + 插件条件渲染 + Bug 修复 → v1.2.0 Cordis 架构对齐 DSH + 安全加固 + 全量测试重构 → v1.3.0 Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐 → v1.4.0 UI/UX 体验优化 11 项 Bug 修复 + 性能/CI-CD 面板切换化 + 梦幻皮肤一致性修复 → v1.4.1 插件管理初始化修复 + 技能市场性能优化 + 对话区域自适应 9 项 Bug 修复 → v1.4.2 10 项 Bug 修复 + Cordis 插件时序改进 + SlotBridge 降级机制增强 + 头像系统升级 → v1.5.0 Cordis "一切插件化" 工具发现机制 — ToolDef guidance + toolsProvider 自动注册 systemPrompt section + buildSystemPrompt 动态收集 + 31 个工具补充 guidance + skill-creator 技能安装增强 → v1.5.1 DSH 架构对标深度整改 + YAML 声明式插件加载 + LLM 回答重复根因修复 + llmEngine/mimoAuth 注册修复 + SlotBridge/SlotRenderer 对标 DSH 重写 → v1.5.2 大文件流式分页读取 + Agent Loop 无上限改造（对标 DSH） + 模型系统动态化 + Skills 市场增量搜索 → v1.5.3-v1.5.4 引导消息立即注入 + Markdown 文件路径超链接 + 任务完成标签稳定显示 + 技能市场优化（GitHub API 目录下载） → v1.5.5 Compaction 并发写入治根修复（对标 DSH compactSurfaceRegion） + Bash 缓存失效修复 → v1.6.0 SubagentRuntime 架构重构（对标 DSH） + 技能市场 Trees API 改造（移植 vercel-labs/skills 官方 CLI） + GitHub Token 链路修复 → v1.6.1 桌面宠物独立窗口改造（Cordis Provider 封装） + 文件输出标识增强（DSH 风格 FileMentions） + 设置版本号动态化 → v1.6.2 大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复 → v1.7.0 PPT 生成质量大大幅升 — oh-my-ppt 74 种风格 SKILL.md 集成 + Cordis SkillRegistry 渐进式加载 + 生成链路断点修复 → v1.8.0 知识图谱 React Flow 重构 + vision-proxy 统一 getConfiguredProvider + UI 字体变量批量规范化 → v1.9.0 上下文压缩过早触发治根修复（模型感知窗口 + 压力驱动 micro-compact）+ 通用协议 API 配置 + 工具执行正确性修复（read 去重范围键 / 审批内容修复） → v1.9.1 对话任务步数计算对标改造 + 文件树显示隐藏文件夹 + 输入框/安全按钮修复 + 数据库持久化加固 + PowerShell 命令修复 → v1.9.2 LLM 请求级超时加固 + 安全模式按钮颜色反馈 + 引导消息注入体验改造 + LLM 失败可见性（对标 DSH 结构化失败上报） → v1.9.3 安全模式完全访问修复（dbReady 时序 + 委派遵循用户模式 + write 拒绝误判）+ 工具调用配对修复（API 400）+ 输入框历史 wrap 折行修复 + 引导栏 UI 对标 wecode + 思考过程紫色样式恢复 → v1.9.4 dsh-desktop 全面对标稳健性审计修复（15 轮：崩溃标记/渲染崩溃兜底/运行时文件日志/持久化失败可见性/命令超时杀树/PowerShell 转义/统一脱敏与超时） → v1.9.5 对话步骤语义化与 update_plan 动态插入（对标 dsh todo）+ token 消耗审计修复（read 上限/工具 defer/结果裁剪/窗口预算/折叠摘要）+ 全面功能审计修复（PTY 树杀/超时补全/托盘退出 flush） → v1.9.6 打包版运行问题修复（CSP blob:/ipc: 修复嵌入 WASM 与 IPC 回退/YAML 清理/解析降噪/知识摘要降级/subagent 激活竞态） → v1.9.7 dsh 插件市场 + dsh-compat 懒解析 + 皮肤兼容契约 + 插件架构审计（同版本补丁：CodeGraph 接入/一键安装 + 技能市场/输入框/GitHub 修复） → v1.9.8 对话用量/缓存命中率统计真实化（对标 dsh-desktop，诚实精度显示）+ date 尾置稳定前缀优化 + 真实请求实证（96K 前缀稳态命中 99.947% 达 dsh 量级） → v1.9.9 EAC 对标（DSH-Desktop-EAC）：编辑并回退 fork / 节点导航升级与精选 pin / 输入框失焦折叠 / persona 人设卡 / side-session 临时会话 / @codem/agent-teams 团队编排 → v1.10.0 EAC 对标四项全落地（④宠物大肥鱼式状态卡 / ③computer-use 电脑操作 / ②wechat-bridge 微信 ClawBot 桥 / ①phone-link 手机连接）+ 四路审计修复（P0 computer-use PS 断链 / 宠物卡隐藏 / 插件禁用=关闭 / executor 失败落库等） → v1.11.0 团队体系深合并（Squad→团队模板 + agent-teams 运行时统一 / TaskCenter 单一「团队」Tab / 智能体·团队双维度面板 + 行内预览 / 持续审计修复） → v1.11.1 zvec-grep（zg）语义检索可选增强（市场卡片一键安装/离线单包 + MCP stdio 接入 + 双轨路由）+ archify 图表技能内置（架构图/功能结构图产出）+ UI/体验修复打包（标题栏拖拽/Logo/磨砂/导航轨/头像） → v1.11.2 zg 在线安装 Node 源根治（Node 并入 zg 单包、仅 GitHub 取包）+ 审计四坑修复（真 PPTX 导出 / 纠偏模型接线 / Whisper 语音入口 / 会话内搜索激活）+ 功能文档体系（介绍 20 域 152 + 功能树 2779）

---

## 一、项目概述

**Codem** 是对标 Codex 的 AI 编程助手桌面应用，基于 Tauri v2 + React + TypeScript 构建。

- **产品名**：Codem（`com.codem.app`）
- **GitHub**：https://github.com/sdcxb/codem
- **分发**：NSIS `.exe` + WiX `.msi`，一键安装无需依赖
- **平台**：Windows 优先
- **版本**：v1.9.7（dsh 插件市场 + 皮肤兼容契约 + 执行轨迹持久化，2026-09-04）

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
│   │   ├── TaskCenter.tsx       # ★ 任务管理面板（8 页签；「看板」= task-center.board slot）
│   │   ├── task-center/         # ★ 任务管理页签组件（v1.14.0 审计修复）
│   │   │   ├── OverviewTab.tsx / DelegationTab.tsx / SubagentsTab.tsx / AutomationTab.tsx
│   │   │   ├── IssuesTab.tsx / IssueBoard.tsx（看板基础视图）/ IssueCard.tsx / IssueDetailPanel.tsx
│   │   │   ├── TeamTab.tsx / InboxTab.tsx / BoardTab.tsx（SlotBridge + IssueBoard 回退）
│   │   │   └── use-current-project.ts # ★ 项目边界：无项目不查库 / 不建记录（P2-12）
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
│   ├── plugins/                  # 完全独立的大插件（启停不影响现有功能）
│   │   ├── monopoly-game/        # 大富翁小游戏（v1.6.2，Phaser 3，@codem/ui-game）
│   │   └── library-ops/          # ★ 图书馆运营监控（v1.14.0，@codem/ui-library-ops）
│   │       ├── index.ts          # 公共导出
│   │       ├── types.ts          # 领域类型 + ACTIVITY_META（11 种工作态）+ LoIconName + 设置
│   │       ├── store.ts          # zustand store（视图/采样/时间序列/双场景槽位/场景图/自动对位）
│   │       ├── data/
│   │       │   ├── library-map.ts  # 岗位地图：10 岗位 + 装饰 + 投影 + 岗位路由 + 工位槽位
│   │       │   ├── characters.ts   # 角色外观生成器（等距场景用，34560 种，令牌化调色板）
│   │       │   ├── pixel-art.ts    # 像素资源清单：12 房间 / walkGraph / 精灵表 / 岗位→房间 / SCENE_PRESETS
│   │       │   └── layout-override.ts # ★ 场景对位覆盖层（拖动房间框/路网节点，按场景图分别存）
│   │       ├── core/
│   │       │   ├── pathfinder.ts   # 等距：可通行网格 + BFS
│   │       │   ├── scene-engine.ts # 等距场景状态机（纯函数）
│   │       │   ├── pixel-path.ts   # 像素：walkGraph 图最短路 + 房间工位排布
│   │       │   ├── pixel-scene.ts  # 像素场景状态机（纯函数）
│   │       │   ├── scene-image.ts  # ★ 场景图片校验/微调/解码（纯函数 + 可注入 IO）
│   │       │   ├── scene-image-db.ts # ★ 场景图片 IndexedDB 持久化（Blob 原样存）
│   │       │   ├── scene-align.ts  # ★ 场景自动对位（地面掩码 vs 房间掩码的 IoU 拟合）
│   │       │   ├── telemetry-adapter.ts # 真实宿主数据 → LibrarySnapshot（只读 + 可注入）
│   │       │   └── format.ts       # 数值/时间格式化
│   │       ├── components/
│   │       │   ├── LibraryOpsBoardView.tsx # ★ 接管「任务管理 → 看板」页签（看板/场景/用量/工具/错误/时间线/设置）
│   │       │   ├── icons.tsx        # ★ LoIcon + LO_ICONS（49 个语义名 → lucide-react）
│   │       │   ├── library/PixelLibraryScene.tsx # ★ 像素图书馆场景（内置预设/自定义图 + 拖拽换图）
│   │       │   ├── library/LibraryScene.tsx      # 等距矢量场景（备用，自绘）
│   │       │   ├── library/{iso,SceneFurniture,CharacterActor}.tsx # 等距几何/家具/角色
│   │       │   └── monitor/          # common / charts / labels / EventList / SceneImageCard / 监控面板
│   │       └── styles/library-ops.css # 样式（只消费皮肤令牌 + 容器查询自适应）
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
│   ├── verify-package-invariants.ts # 包不变量检查（v1.1.0 新增）
│   ├── sync-library-ops-assets.mjs  # 图书馆插件美术资源同步（上游 → public/，PNG→WebP）
│   ├── build-library-ops-scene-preset.mjs # 场景图预设接入（任意图 → 2752×1536 WebP + 缩略图）
│   ├── build-library-ops-scene.mjs  # 自有场景图接入（尺寸归一 + 自动/校验可行走掩码）
│   ├── build-library-ops-sprites.mjs# 自有角色精灵表接入（去背景/切格/基线对齐/WebP/清单）
│   ├── export-library-ops-layout-guide.mjs # 导出布局参考图（喂绘图模型做 img2img）
│   └── lib/library-ops-asset-utils.mjs # 上述脚本的纯函数（有单测）
├── tools/                        # 开发工具（不参与打包）
│   ├── preview/                  # 插件视觉预览页 + DOM 结构审计（audit-dom.mjs）+ 版面自适应审计（audit-layout.mjs，7 种窗口宽度）
│   └── library-ops/              # 布局参考图（layout-guide.png / layout-guide-solid.png）
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

**插件皮肤兼容契约（Skin Token Contract，docs/SKIN-PLUGIN-CONTRACT.md）：**
插件（市场 Tab、插件管理、ui-* provider 及未来可适配的 dsh UI 插件）影响 UI/UX，
必须与全部皮肤（default 亮/暗、dream、hub）兼容——样式**只消费令牌、禁止硬编码色值**
（唯一例外 var fallback；半透明用 color-mix 派生）。`theme/skin-tokens.ts` 提供
`auditPluginStyle` 源码审计 + 令牌登记表；`test/skin-compat-plugin.test.ts`（SC-1~4）
把契约变成门禁（市场 UI 零硬编码色 / 令牌在 styles.css 均有定义 / 目录分类受支持）。

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
| **AREX-SKILL-INTEGRATION.md** | 集成指南 | **第三方 Agent Skills（AREX-Skill）集成**：三种安装方式 + 实测体积 + 验证清单 + 已知边界 | ✅ 最新 |
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
| **SKIN-PLUGIN-CONTRACT.md** | 契约文档 | 插件皮肤兼容契约（令牌唯一化 + 审计 SC-1~4，见 4.3） | ✅ 最新 |
| **LIBRARY-OPS-PLUGIN.md** | 插件设计 | 图书馆运营监控插件（需求对照 + 参考项目分析 + 架构 + 集成点 + 测试矩阵） | ✅ 最新 |
| **LIBRARY-OPS-AUDIT.md** | 审计报告 | 图书馆运营监控插件全面审计（四轮方法 + 28 项问题与修复 + 验证证据 + 对标结论） | ✅ 最新 |
| **ASSET-LICENSES.md** | 许可声明 | 第三方美术资源许可（来源 / 义务 / 商用替代方案 / 刻意排除项） | ✅ 最新 |
| **ASSET-PROMPT-PACK.md** | 制作指南 | 美术素材生成提示词包（实测规格 + 场景/角色/掩码提示词 + 接入脚本 + 验收清单） | ✅ 最新 |
| **art-prompts/** | 提示词（易用版） | 一个提示词一个 md，直接复制粘贴；生成图丢进 `.art-inbox/` 即可 | ✅ 最新 |
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
| v1.16.63 | 2026-09-17 | **启动维护在 rust 模式下从未执行过（真机缺陷）+ 最后两处"偷偷加载 WASM"的入口** — ①`runDatabaseMaintenance()` 第一行是 `if (!db \|\| dbFatal) return`，而切到 rust 后 `db` 在正常路径下**永远是 null**（旧库刻意不加载），于是这个每次启动都被 `await` 的函数**一行都没跑**：追加日志（**权威副本**）的回填与压缩、索引裁剪、外置附件预热与孤儿清理、崩溃后"索引重建标记"驱动的自愈、遥测按天裁剪 —— 全部从未执行。长期没人发现的原因是 `src/test/setup.ts` 每个用例都 `initDatabase()`，测试里 `db` 永远非空，**与真机恰好相反**（方法论教训：基座把"产品不会出现的状态"维持成常态，会让一整类缺陷隐身）。修法：按"是否依赖旧库"拆成两半，与旧库无关的那半**无条件执行**，旧库专属的半边（体积统计/VACUUM/事件截断）只在旧库存在时执行，rust 侧遥测裁剪改走引擎命令 `telemetry.prune { before }`；端口模式下也留一行带数字的日志（原来"没跑"和"跑了没事做"长得一样）。新增 `maintenance-rust-mode.test.ts`（MR-1..MR-6）用 `closeDatabase()` **显式模拟真机**，已验证修复前会红。②`wechat-bridge::ensureWorkspaceProject` **无条件** `await initDatabase()` → rust 模式下把 sql.js 拖回渲染进程并整库读写 `codem-db.bin`（`Loaded 11137024 bytes`+`Saved 11137024 bytes`），"渲染进程不再持有 WASM"被一句无害调用无声废掉（同样的坑在 `migration.ts` 修过，这是漏网最后一处）→ 先判引擎；`PerformanceDashboard::handleClearAll` 的 A 态回退（组件自己 `getDatabase()` 清表）在 rust 下必抛、`setShowClearConfirm(false)` 在抛点之后 → **确认框不关、界面像卡住** → `clearAll()` 改为只返回真实行数 + 清空回执。③把"本进程不用旧库"从约定升级为**运行期不变量**：rust 模式下 `initDatabase()`/`resetDatabase()` 直接拒绝（后者会删掉迁移源 `codem-db.bin`），MR-6 全仓静态守门"每处 initDatabase 调用都必须先判引擎"。④L4 收尾：A 态回退分支全部删除，L3 **165 处/18 文件 → 19 处/1 文件**；写路径删除统一走新增的 `reportWriteNotAccepted()`（避免退化成静默假成功）；审计工具补口径（readiness 增 `tryGetDatabase` 列、coverage 增**端口侧盘点**）。实测：**277 文件 / 5241 通过 / 0 失败**、Rust 99 全绿、tsc 0 错误、七门禁 exit 0。 |
| v1.16.62 | 2026-09-17 | **退役回滚开关（L4 第一步）** — 迁移期靠 `localStorage["codem-storage-engine"] = "wasm"` 一键回退到渲染进程内的 sql.js，而**那个引擎已随 L1 清除**：开关留着只会制造一个**假的**安全感（以为切回去还能用，实际切过去没有任何引擎可用）。本轮把它退役：`selectedEngine()` 不再读 localStorage、恒为 `rust`；`DEFAULT_ENGINE` 的类型从 `"wasm" | "rust"` 收窄为 `"rust"`（类型层面也不允许再选旧引擎）；契约测试同步改成「开关已退役」语义（BOOT-2 从「写 wasm 就跳过注册」改为「写 wasm 也仍然注册 rust 端口」，BOOT-4 改为「非法取值也不影响引擎选择」）；`settings-keys-symmetry` 白名单移除 `codem-storage-engine`（键已不再被读写）。**回退能力改为应用级**：装回上一版安装包，且旧库 `codem-db.bin` 全程只读不改，任何一次回退都能拿回原始数据。实测：端口模式 **0 失败 / 5235 通过**、A 态对照 **0 失败 / 5235 通过**、Rust 101 全绿、tsc 0 错误、七道审计门 exit 0。 |
| v1.16.61 | 2026-09-17 | **端口模式全绿（74 → 0）+ 附件域端口覆盖 + 四个真机缺陷** — ①**端口模式套件清零**：迁移期 B 态（端口在 rust，打包版真实形态）那 74 个失败是"测试直接读写旧库、产品已只读写端口"的待办清单，本轮逐个处置（断言改读端口表 `__table()`、预置改端口 seed/命令、补齐测试替身与真引擎的差距：`messages.list` 的时间序、`crud.delete` 的外键级联、`messages.rebuild_index` 的 `{sessions:[…]}` 契约、`attachments.update`；另修一类用例间串味——`localHiddenIds` 是进程级状态而多个用例共用会话 id）。**结果：端口模式 0 失败 / 5235 通过，A 态对照同样 0 失败 / 5235 通过**。②**附件域端口覆盖**：rust 模式下附件原本**既不写也不读**（唯一的附件 INSERT 在 A 态分支里，端口接手后整段被短路；JSONL 也不含附件；`getAttachmentContent()` 在 B 态硬返回 undefined）→ 写走 `crud.upsert{attachments}`、外置标记写回走 `attachments.update`、读走新增的 Rust `attachments.content{id}` + 渲染侧同步缓存与一次异步预取、列表走域镜像的**元数据投影**（不含正文）、外置清单走新增的 `attachments.externalized`（引擎侧过滤，只回 id+路径，不再把整张表连同正文读进渲染进程）。③**四个真机缺陷**（都由端口化测试抓出）：**孤儿清理会误删所有外置附件**（域就绪但为空 → `referenced=∅` → 把 `<appData>/attachments/` 全删，不可逆）→ 判据改成"清单是否权威"；**`tool_calls` 刚写读不到**（写路径从未维护 `toolCallCache`，fork 复制整批丢失）→ 写路径补缓存 + `getMessage` 同步兜底查日志镜像；**`generated_files` 读不回来**（Rust SELECT 与镜像映射都漏了这一列 → 重启后标记消失）→ 四处补齐；**索引重建计数恒为 0**（用 `data.execute` 读结构化结果）→ 改用 `command` 且不再静默取 0。实测：`tsc` 0 错误、七道审计门 exit 0、Rust 101 全绿。 |
| v1.16.60 | 2026-09-17 | **"点开会话内容全空"的根因找到并修掉：`mode:"replace"` 会级联删子表** — 根因一句话：SQLite 的 `INSERT OR REPLACE` 是"**冲突时先 DELETE 再 INSERT**"，而 `sessions` 是父表（`messages`/`tool_calls`/`session_events`/`message_feedback` 全部 `ON DELETE CASCADE`），渲染侧 `updateSession()`（改标题/最后消息时间/置顶/消息数都走它）用的正是 `domainWrite(..., {mode:"replace"})` —— 于是"打开一个会话"触发一次会话行更新 → **该会话的全部消息/工具调用/事件被级联删除**，而会话行本身还在（列表看起来正常、点进去是空的）。这就是用户长期报告、前几轮 8 层仪器都没抓到的"点开会话清空数据"；`storage_audit` 的两条记录与之完全吻合（**同一秒**删 2~3 个 sessions + 821 messages + 883 tool_calls + 2131 events），而"渲染侧端口审计没有任何删除"也解释得通了：调用方发的是 **`crud.upsert`（写命令）**，删除是 SQLite 在引擎内部做的级联。**修法**：`crud.upsert` 的 `replace` 改成"**先 UPDATE、0 行才 INSERT**"——绝不删行（子表不被级联）、只更新本次提供的列（未提供的列保持原值，`INSERT OR REPLACE` 会把它们清成 NULL）；不用 `INSERT ... ON CONFLICT DO UPDATE` 是因为那一半 INSERT 仍要满足所有 NOT NULL 列（实测踩到 `sessions.project_id`）。这一处改动同时修掉 `projects`/`notebooks`/`v2_sessions`/`notes`/`goals`/`inbox` 等**所有** `mode:"replace"` 写路径上的同类风险。审计触发器扩到 `projects`/`notebooks`（从前只看得见子表删除、看不见级联源头）。实测：基线 **5235 全绿**、端口模式 **74 失败（集合未变）/ 5161 通过**、Rust **99 全绿**（新增 `crud_upsert_replace_does_not_cascade_delete_children`）、七门禁 exit 0、tsc 0 错误；打包版实测"覆盖会话行"后该会话消息数不变。 |
| v1.16.59 | 2026-09-17 | **L3 门控收尾：171 处旧库调用全部两态化** — L3 清单（"端口没接手就回退旧库"的每一处）最后 10 个站点全部处置完，现在**每个文件都满足"已门控 ≥ 旧库调用数"**（171 处调用 / 178 个门控）；剩下的字面量要等回滚开关退役（L4）时随 A 态分支一起消失。本轮要点：①`note-manager` 那处"第 42 轮删回退导致基线红"的教训落定（A 态回退 + B 态上报，`note-links-order` NL-2 两种模式都绿）；②`session_trace` **端口化**（读 `sessions` 域镜像遍历 fork 谱系，原来 rust 模式下必然抛错）；③`session-log-bridge` 三处：B 态跳过附件预热**并跳过孤儿清理**（`referenced` 为空会把外置文件全当孤儿删掉——破坏性）、会话清单端口优先（原来"回填 0 条"是假正常）、端口重建失败后不回退旧库重试（那会把真实原因换成无关异常）；④`event-log` 四处 + 新增 `rustEventPortAny()`：**写路径不再要求"该会话事件镜像已加载"** —— 那条规则本意是避免读写分裂，而 rust 下旧库刻意不存在、没有可分裂的对象，剩下的只有"写路径抛错"（真机形态：启动窗口期事件整段丢失）；镜像侧用占位 seq 承接窗口期写入、加载后 reconcile 对账，新增契约 EV-11 钉住"零旧库访问 + 一条不丢"。实测：基线 **5235 全绿**、端口模式 **74 失败（集合未变，无新增）/ 5160 通过**、Rust 97 全绿、七门禁 exit 0、tsc 0 错误。 |
| v1.16.58 | 2026-09-17 | **面板不再"有时是空的"：把域镜像的就绪窗口挪到首屏之前** — 域镜像是"同步读、异步加载"：面板首次渲染时同步读一次（`listProjects` / `listNotes` / `listFlashcards` / `loadPromptDrafts`…），而端口侧加载是一次 IPC；窗口期里读路径拿到的是"该域的合理空结果"（B 态的正确行为），而**没有任何东西会稍后重读**。真机启动日志实测可复现：`loadFromDB: found 0 "projects"` → 端口就绪后重读 → `found 1 "projects"`。问题不在"有一次空读"，而在**那次空读只有 projects 一个域有补救**（第 24 轮给它单独打过补丁），其余十几个域（目标/收件箱/问题/团队/闪卡/画像/草稿/轮次文件变更/记账/笔记…）一个都没有 —— 会一直空到用户切走再切回。修法：①新增 `prefetchDomainMirrors()`，在 `App.tsx` 里**放在 `loadFromDB()` 之前**（也在所有迁移/自检之后）一次性触发 18 张热表加载并等就绪；②有界（单表 1200ms、总 2500ms，坏表不拖垮启动，正常几十毫秒）；③不静默（返回 `{ready,pending,ms}`，未就绪表进启动日志并注册**一次性**"就绪即重读"，判据是"该表镜像就绪"而非"端口存在"——后者会让重读在加载完成前触发、拿到的还是空，正是第 24 轮踩过的坑）；④新增 `tools/audit/check-hot-tables.mjs` 校验热表名真实存在（写错表名不报错，只会让那张表永远加载不上）。实测：基线 **5234 全绿**、端口模式 **74 失败（集合未变）/ 5160 通过**、Rust 97 全绿、七门禁 exit 0、tsc 0 错误。 |
| v1.16.57 | 2026-09-17 | **"数据无故被清空"结案：删除者就是迁移/恢复路径自己** — 这条追了多轮、8 层仪器全部 0 命中的悬案，本轮用 `storage_audit` 触发器留下的两条硬证据定位到一行代码：`auto_migrate` 固定传 `replace: true`，而 `import_all` 对它的实现是**把每张目标表整表清空再重灌**。证据：①2026-09-16T23:47:45Z 删 sessions 2 行 + 某会话 277 条 messages；②2026-09-17T01:13:34Z 删 sessions 3 行 + **messages 821 条（全部）** + tool_calls 883 + session_events 2131 —— 与"整表清空"完全吻合，且与 `codem-db.bin-shm`（旧库被打开）、运行时日志**同秒**。完整因果链：自检判据里 `crud.count` 的读失败被 `?? 0` 吞成"0 条消息" → 对**完好的库**执行恢复 → `migration.auto` 整库清空再重灌 → 中间态一旦被打断就是历史上真实的 821→0。另发现同一段代码的第二个破坏源：同名行用 `INSERT OR REPLACE`（SQLite 语义是**先 DELETE 再 INSERT**），父表 `sessions` 被替换时子表按 `ON DELETE CASCADE` **连带删掉该会话全部消息** —— 正是"某个会话消息凭空消失"的形态；以及第三个触发点：`bootstrap` 读 settings 失败时 `catch {}` **继续往下跑迁移**（三条守卫一条没执行）。**四道修法**：①整表清空彻底去掉（`INSERT OR IGNORE` → 未插入则 `UPDATE` 两段式，不删除、不触发级联，目标端多出的行一律保留）；②对账改成单向（源端每行必须到，目标端多出的行不算失败并报 `kept_newer`）；③**引擎侧守卫**：目标库有消息时拒绝 `migration.auto`（除非显式 `force`）；④两处"读不到 ≠ 是 0"（自检计数 + bootstrap 守卫）。实测：基线 5230 全绿、端口模式 74 失败（与上批同集合，无新增）、Rust 97 用例全绿、七门禁 exit 0、tsc 0 错误；真机验收在打包版里直接调用 `migration.auto` 被拒（"已有 821 条消息"）且**本次启动没有产生任何新的删除审计记录**。 |
| v1.16.56 | 2026-09-17 | **消息域补齐端口实现：一批"rust 模式下静默失效"的功能真的恢复了** — 本轮把 `message.ts` 的旧库回退点全部做成**两态门控**（A 态=端口未注册/回滚 wasm，旧库是唯一数据源，必须回退；B 态=端口在 rust 但镜像未就绪，**不许**回退），门控一装上就把 8 个"只有旧库一条实现"的函数照了出来 —— rust 引擎下旧库刻意不加载，它们的真机行为是**抛错、被上层 `catch` 后静默**：①`updateMessageContent` + `deleteMessagesAfter`（编辑并重发）→ **编辑重启后回退、被删的旧回复从权威日志复活**；②`loadFeedback`（`getDatabase()` 写在 `try` **外面**）→ 点历史消息的赞/踩报错；③`trimIndexedMessages`（启动维护）→ **索引裁剪从未执行过**；④`rebuildSessionFts` 被 `isFts5Available()`（rust 下恒 false）挡住 → **新消息永远搜不到**；⑤`appendToMessage`/`setMessageContent`/`setMessageReasoning`/`setMessageStatus` 同族。修法：统一走"端口优先 + 权威日志/墓碑照写"，新增 Rust `fts.upsert`/`fts.remove`（单条消息的全文索引维护，用与 `fts.rebuild` 同一套中文 bigram 切分），镜像未就绪时**等就绪再做**（一次性回调，不轮询 —— 与 `addNoteLink` 同规则）。顺带修掉两个更深的缺陷：**`messages.delete { soft: true }` 被 Rust 侧忽略**（压缩要的是"隐藏"，实现却是硬删除；假端口按 soft 实现了 → **测试绿、真机行为不同**，最危险的一类偏差），以及 `schema_report.tables` 在"全新库第一次打开"时少 1（报表取在 `audit::install` 建 `storage_audit` 之前，`engine_tests::schema_apply_is_idempotent` 因此长期失败）。实测（同一套脚本两侧都测）：基线 **5221 全绿**、端口模式 **91 → 74 失败（−17，无新增失败）**、Rust **94 用例全绿**、L3 已门控 **167/171**、七道审计门 exit 0、tsc 0 错误。 |
| v1.16.55 | 2026-09-17 | **修 5 处"看着像防御、实际不会触发"的判空 + 一处 SQL 拼接** — 代码里写着 `const db = getDatabase(); if (!db) return;`，而 `getDatabase()` **从不返回 null**（旧库未加载时**抛错**），所以这个判空**永不触发**：看着安全，实际什么都没挡。逐处后果（`agent-profile-storage`）：`create` 抛错（调用方未预期，返回类型是具体对象）→ 打断上层流程；`getById`/`list` 返回 null/[] → **假降级**（无法区分"确实没有"与"读不到"）；`update`/`delete` **静默 return** → **假成功（调用方以为改了/删了，实际什么都没发生）**——智能体画像的修改与删除可能"看起来成功"、重启后失效。修法是把"端口未接手"的**两种态分开**（本轮整改主线）：A 态（端口未注册/回滚 wasm）→ 旧库是唯一数据源，回退；B 态（端口在 rust、镜像未就绪）→ 不回退，读给合理空结果、写删**如实上报**。本轮覆盖 `agent-profile-storage`(5)、`goal`(4)、`feedback`(5)。顺带修一处 SQL 拼接：`goal.listGoals` 原来把调用方传入的 `status` 直接串进 SQL（`` `AND status = '${status}'` ``）——虽走渲染内 sql.js 非 IPC，但"值必须参数化绑定"是硬约束，拼接一旦被复制就是注入，已改为按需绑定参数。L3「已门控」12 → 25 处。基线 5211 全绿、端口模式 91/5120（均无回归）、七门禁 exit 0、39 个 Rust 测试全绿；真机验收 0 错误、0 WASM 请求，三个改动域经端口读正常。 |
| v1.16.54 | 2026-09-17 | **修好上下文压缩：压缩终于真的让上下文变小** — 用户报过的「移除 840 条、请求仍 105 万 token、迭代重压、硬停『请开启新对话』」本轮找齐完整机制，是**三个环节连环空转**：①`deleteMessagesByIds`（压缩软删除入口）第一行就是 `getDatabase()`，而 rust 模式下旧库刻意不存在 → 直接抛错 → **压缩一条都没隐藏**（该路径此前从未端口化）；②`sessionIdsForMessages()` 只查旧库 → 空 Map → 按会话分组整条链路（写墓碑、剔日志镜像）全部空转 —— **删除链路的会话归属查不到 = 整条链路无效**；③镜像 hidden 集合在「未加载完」时为空，而压缩发生在使用中 → 合并阶段把已软删除消息从日志整批加回来。修法：①软删除端口优先（`messages.delete` + `soft:true`）②会话归属改为先问镜像 `byIdLookup` ③新增 `localHiddenIds`（本进程隐藏过的 id，有界 5 万），读路径叠加它不必等镜像重载。另修掉「测试双比实现更宽松」（假端口 `applyWrite` 谎报 loaded、未实现 `messages.delete`，致一批压缩用例假绿）。实测：真机软删除使可见条数 277 → 276（此前直接抛错）；验收气泡 3、0 错误、0 WASM 请求；基线 5199 全绿，端口模式 96 → 91 失败。 |
| v1.16.53 | 2026-09-17 | **数据救回来之后，界面真的显示出来（镜像重拉）** — 1.16.52 让数据在使用中也能当场恢复，但真机验收发现缺口：**数据已救回（messages=821），界面却依旧空白**。根因是镜像"已加载"的语义被用错：`isLoaded === true` 的含义是"**这份快照是完整的**"，不是"**库没变过**"——恢复之后镜像那份**空快照**仍是 loaded，于是读路径继续返回空集合，"未加载不路由"这条防读写分裂的规则反过来把陈旧快照当成了权威。修法：①`RustMessageMirror.reload()` 作废该会话镜像；②`MessageStorage.reloadSessionMessages()` 对外入口（同时清日志缓存，端口无 reload 时优雅退化）；③恢复分支改为"重拉镜像→回调里读→显示"，并重读项目/会话列表（`currentSession` 可能已失效）。实测（打包版）：点开会话→被清空→同一进程内自动恢复，**气泡数 3**（此前恒为 0），日志"已恢复并重拉镜像 → 显示 277 条"，数据 821/3/883 完好。基线 5199 全绿。 |
| v1.16.52 | 2026-09-17 | **数据在"使用中"被清空也能当场恢复（运行期守护）** — 上版只在启动时自检，而文件级取证（150ms 采样库文件+WAL）证明数据是在**使用过程中**消失的：点击前 WAL=28KB，点击后 1.1 秒涨到 1.75MB（主库不变→全走 WAL 提交），紧接着 messages 821→0 —— 中间整个使用期用户是裸奔的。本版新增 `guardContentBeforeSessionOpen()`，挂在 **`loadMessages` 读到 0 条**那一刻：判据与启动自检完全一致（同一水位/阈值/旧库非空）、带进行中闩锁、恢复后清会话日志缓存并重读，**不需要重启**。实测（打包版）：点开会话→被清空→**同一进程内自动恢复 821/3/2131/883**。另确认：只有点"会话"触发、点"项目"不触发；应用读的就是 `codem-db-rust.bin`（点前 `messages.count`=277）。**仍未定位删除发起者**：渲染侧+Rust 侧 8 层仪器全部 0 命中（端口三层 / domain-store 5 点 / write-audit / RustDataPort / tauriTransport / 镜像类 / 端口实例数 / `codem_db::dispatch`），而 SQLite 触发器每次都记下删除；恢复后界面气泡仍为 0（显示问题，不影响数据安全）。基线 5199 全绿。 |
| v1.16.51 | 2026-09-17 | **数据"无故消失"不再真的丢：批量删除闸门 + 启动自检自愈** — 上轮定位到"点开会话会清空 821 条消息"，但渲染侧所有审计点（端口三层 + domain-store 全部 5 个写穿点 + 删除类写操作控制台记录）**全部 0 命中**，触发路径追查两轮仍未定位。于是换目标：不依赖"找到那个 bug"，而是让用户数据无论如何都不真的丢。①**批量删除闸门**（Rust，按**实际影响行数**判定）：受保护表单次删除 >50 行、或"删 1 行会话级联 >50 行"必须显式 `confirm_bulk`——事故形态正是"删 2 个会话级联带走 821 条消息"，规模不体现在调用参数里，所以必须按影响行数判定；拒绝时如实报"这次删多少 / 该表共多少"。UI 的显式删除传 `confirmBulk: true`，自动清理/对账/修复一律不传。实测删 544 条被拒且**数据一行没少**。②**启动自检自愈**：每次启动记内容水位，下次启动若"消息全空 + 上次水位≥50 + 旧库有内容"三条同时成立则自动从旧库恢复（缺一只告警不覆盖）。实测 821→0 后重启**自动恢复 821 消息/3 会话/2131 事件/883 工具调用**。另：删除审计转正为长期能力；修正自愈误用 `reportActionFailure` 打出与事实相反的"该功能本次没有生效"。35 个 Rust 测试全绿。 |
| v1.16.50 | 2026-09-17 | **SQLite 侧删除审计：把"数据消失"查到具体哪一步** — 发现迁移对账通过后新库仍被清空，而渲染侧端口审计里**没有任何删除**（存在绕过端口、无从追溯的删除路径）→ 不再猜代码，改为**让数据库自己记账**：引擎打开时给 `messages`/`sessions`/`session_events`/`tool_calls` 装 `AFTER DELETE` 与 `AFTER UPDATE(hidden 0→1)` 触发器，写进只增的 `storage_audit` 表，并配 `codem-db-cli audit [N\|summary\|clear]`（**不启动应用即可取证**）。审计结论：`session_events` 2131 / `tool_calls` 883 / `messages` 821 / `sessions` **2**，3000 条时间戳完全相同 → **单条 `DELETE FROM sessions` 的级联删除**；被删的两个会话正是用户真实会话（笔记本会话保留）= 有选择的删除。触发条件已精确刻画：**启动后不操作等 30 秒完好、点项目完好、点会话就 821→0** —— 即"打开会话"路径上触发。仍未定位最终发起者（不声称已修）：线索是"索引暂不可用"与删除同秒出现、`currentSessionIdForMessage` 对迁移消息返回 null 使其走旧回退。数据已恢复 821/3/883，旧库始终完好。46 个 Rust 测试全绿。 |
| v1.16.49 | 2026-09-16 | **测试基座切到存储端口，逼出并修掉 7 个真实读写分裂** — 删旧引擎回退分支的前置条件：测试若继续跑在旧库上，套件全绿也在验证"马上要删掉的那条路"。对照实验（同一套件只切一个开关）：`CODEM_TEST_PORT=0` → **5199 通过 / 0 失败**；端口模式（新默认）→ 5103 通过 / **96 失败**。这 96 个不是回归，而是"旧路径还被测试照顾"的那部分账，它们逼出的都是真实缺陷：`getMessage` 只读旧库（按 id 取取决于缓存有没有预热）、`tool_calls` 读写分裂（= 用户现场"模型看不到自己的工具结果、反复重发同一调用"）、`currentSessionIdForMessage` 对新消息返回 null（→ 不写墓碑，重建时消息复活）、镜像同步晚于 IPC 的时序窗口、**`compactWithSnapshot` 在 rust 引擎下是空操作**（读镜像、写只对旧库生效）、`cutoff_seq` 传成锚点自己（把刚写的快照删掉）、`anchor.seq` 是字符串导致 `+1` 变拼接（81 → "811"）。新增 `src/test/fake-storage-port.ts`（如实内存端口）。七个审计门禁全绿。 |
| v1.16.48 | 2026-09-16 | **修一次真实的数据清空事故** — 全量覆盖迁移（`replace: true` 先清空目标表）原来只判"有没有会话"，于是 sessions 被清空一次就会重新触发，把新库剩下的消息/事件清掉再用旧库当时的内容重导 → 用户看到"数据没了"（真机实测踩到：821 消息 + 2131 事件全空）。守卫改为"会话/消息/用户项目三者都为空"才允许覆盖。已从旧库完整恢复（39 表 / 3990 行，中文搜索 21 条）。另补上 `recovery_data` / `cost_records` 两张"一直只走旧库"的表接入端口。 |
| v1.16.47 | 2026-09-16 | **sql.js 改为按需加载 + 修一个被引爆的测试竞态** — 原来静态 import 会把 sql.js（含 .wasm）打进主 chunk，于是"引擎是 rust、不加载 WASM 数据库"的产物每次启动仍要下载解析 sql.js。改动态 import 后拆成独立 chunk，只有走 WASM 回退才加载。真机抓网络请求验证：启动 124 个请求里 **sql.js 0 个、.wasm 0 个**。异步化引爆了 worktree 测试里 `resetDatabase()` 未 await 的长期竞态（5 个测试变红），已定位并修掉。另新增 `wasm-removal-readiness.mjs` 量化删除面：L3 回退分支 23 文件 / 167 处。 |
| v1.16.46 | 2026-09-16 | **修中文搜索（迁移后 FTS 索引形态不对）** — 中文搜索依赖 CJK bigram 切分，而迁移搬进来的 session_fts 是老库 unicode61 时代的原始文本 → 英文能搜、**中文恒为 0 条**（真机：`消息` LIKE 命中 21 行、FTS 返回 0）。行数与逐表摘要**全部对账通过**也发现不了它 —— 属于"搬对了行、索引形态不对"。修法：新增 `fts.rebuild_all` 并**接进自动迁移末尾**，加 Rust 回归测试断言索引是切分形式且中文子串可命中。重建后 `消息`→21 / `上下文`→11 / `压缩`→2。 |
| v1.16.45 | 2026-09-16 | **修首屏"暂无项目"的启动竞态** — 引擎为 rust 时读路径要等端口注册 + 镜像加载完才接手，而 `loadFromDB()` 在端口就绪前跑一次就再也不重试，于是首屏一直显示"暂无项目/暂无对话"（数据其实都在库里）。修为**有界重试**：判据必须是「projects 这张表的镜像已就绪」，不是「端口存在」——第一版只判端口，重试在镜像加载完成前就触发，日志打了"重新加载"界面照样空（真机实测抓到）。 |
| v1.16.44 | 2026-09-16 | **架构级：SQLite 搬出渲染进程，默认走 Rust 原生实现（第 92 波 · 路径①）** — 内存越界不是偶发而是架构问题：sql.js 峰值内存是正文的 3.4~3.7 倍（整库在堆 + `db.export()` 再复制一份），wasm32 上限 2GB → 约 550MB 正文必崩。本版把引擎搬到 Rust（WAL 增量落盘、无整库导出、ATTACH 被禁、结构化错误码、分页与上限），**启动不再加载 WASM 数据库**（实测 12MB 正文只占渲染进程 12.0MB = 1.0×），消息镜像与附件缓存加预算+LRU，并支持**首次启动自动迁移老数据**（只读旧库 + 逐表对账后才写标记）。回滚开关仍保留。 |
| v1.16.43 | 2026-09-15 | **架构级：让「权威日志」真的权威（写入顺序 / 索引自愈 / 存储压力）（第 91 波）** — 用户追问"越界出现很多次，**数据库有问题吗**？别掩盖表象，实在不行升级架构"。结论：**数据库文件没坏，坏的是分层名不副实** —— 第 78 波就写明"JSONL 追加日志 = 权威存储、SQLite = 可重建索引"，但：①**写入顺序是反的**（createMessage 先 getDatabase→INSERT/UPDATE×N→persistDatabase，**最后**才 appendSessionMessage；索引一出问题第一行就抛，权威日志那步根本没跑 —— 113 条消息的危险正源于此）；②**读路径也挂在索引上**（listMessagesFromIndex 直接 getDatabase，索引崩了历史读不出来）；③**重建方向从未实现**（只有索引→日志回填，没有日志→索引；且重建会因 messages.session_id→sessions(id) 外键失败）；④**存储压力无上限**（saveMessages 每次全量重写上百条、每条工具调用先删后插；saveDatabase 每次 db.export() 整库 = 单次 O(库大小) 的 WASM 分配，正是越界最现实的触发点）。本轮：**写入顺序翻过来**（先写权威日志、再尽力更新索引；索引失败只上报不再让调用方失败）、**读路径索引不可用即回退日志**、**索引自愈**（rebuildIndexFromSessionLogs 幂等含工具调用 + 补齐缺失 sessions 行；致命闩锁写**不依赖数据库**的标记文件，下次启动维护先"从日志重建索引"再回填/裁剪、成功后删标记 —— 崩溃从"重启后索引空空"变成"自动重建、消息一条不少"）、**压力上界**（saveMessages 只写变化过的消息，内容指纹=长度+首尾采样+字符码累加；saveDatabase 加 256MB 整库导出硬上限，超限即暂停整库落盘并提示，改为只写日志+下次重建）。验证：新增 authority-first-storage AR-1~7（索引致命时 create/update 照样进日志、历史照样可读、索引可从日志重建含工具调用、崩溃留标记且维护先重建再回填、saveMessages 首轮 40/二轮 0/改一条只写一条、导出上限存在）；全量 256 文件 / 5007 用例通过 / 15 跳过、tsc 0、审计 0-0、门禁全绿。**仍建议**：①把 SQLite 移出渲染进程（Rust rusqlite，代价是 200+ 处同步调用改异步）或②保持 sql.js 但彻底不做整库导出（本轮已铺好重建地基）—— 建议先走②。 |
| v1.16.42 | 2026-09-15 | **用户现场：数据库 WASM 崩溃后没有人发现（错误刷屏、抢救流程从未执行）（第 90 波）** — 用户跑长会话（生成"2．主要研究内容"文档）时控制台刷同一条 `RuntimeError: memory access out of bounds`（saveMessages / EventLogFinalize / loadFeedback / Telemetry.flush，几十次，遥测还带层层嵌套 setTimeout），且**没有任何提示说数据库已死**。三个根因同一个断点：①`isFatalDbError()` 名单里只有 out of memory/malformed schema/bad parameter，WASM 陷阱（memory access out of bounds、RuntimeError: unreachable、Cannot enlarge memory、null function…、table index is out of bounds）**一条都不在** → 致命状态从未闩锁；②`codem:db-fatal` 从未派发 → App 里"把当前会话抢救成 JSON + 提示用户重启"的处理函数（一直存在）**根本没跑**，那一刻 113 条消息只在内存里；③查询路径各自 catch 一下就过，**每次都在已崩的 WASM 堆上再撞一次**，遥测还无限重排定时器。修复：补齐 WASM 陷阱家族（保守：UNIQUE/no such column/FK 等普通错误不误判）、新增 DatabaseFatalError + noteDatabaseError() + `installFatalGuard()`（装在 db.exec/run/prepare 上：任何陷阱就地闩锁 + 派发事件；闩锁后直接抛错、**不再进入底层**）、调用点（store.saveMessages / 遥测 flush / EventLog 终层 / loadFeedback / recovery.multiLayer 定时写）改为致命即跳过 + 一次性上报（第 87 波的统一通道）；用户可见：界面直接给出"已停止写入 + 会话已抢救到 <路径>，请重启应用"。验证：新增 db-fatal-cascade DBF-1~7（撤掉 WASM 文案 **6 条立刻变红**）；全量 255 文件 / 5000 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化、三类门禁全绿。 |
| v1.16.41 | 2026-09-15 | **C 类（守卫被绕过）也成了门禁；三类问题现在全部机器把关（第 89 波）** — A/B 两类第 88 波已进门禁，C 类此前只有手工 grep，这一轮补齐并当场修掉抓到的问题。新增 tools/audit/scan-guard-bypass.mjs 三类判据：C1 catch 里返回放行语义（只报**无条件**放行或"有放行但整块无拒绝路径"的；`if (hook.allowOnError) … return allow; return deny…` 这种显式选择的 fail-open 只记为"需人工确认"信息项）、C2 catch 里守卫/权限类调用（analyzeBashCommand/isAutoApprovable/checkPermission/modeGate/getEffectiveSecurityMode/isProtectedPath/isPathWithinWorkspace/isSandboxAclEnabled/PlanModeGuard/SandboxGuard/shouldFireHook…）失败被静默忽略（块内无 throw/拒绝/失败上报）、C3 空 catch 紧邻 "ask" 审批判断或位于权限/守卫语义函数里。调优留痕：第一版把 mode/allow 放进函数名匹配 → getMode、saveCustomModels（"Model" 含 mode）被误报 → 收紧为 permission|approve|guard|security|sandbox|consent|deny|hook；C3 从"整个函数体出现过 ask"收紧为"catch 前 25 行内出现 ask"。②门禁当场抓出并修掉：AgentRegistry.loadPresets 预设发现失败原来只写一行 warn、构造函数更是 .catch(()=>{}) 全吞 —— 用户放的 agent.cordis.yml **静默不生效**（只在"自定义智能体怎么不见了"体现）→ 走统一失败上报；另 2 处豁免写入 allowlist.json（isCodeGraphEnabled 与设置面板同名逻辑都是**读取开关**的函数、不是守门人，真正门禁在 AgenticLoop/HookManager/权限层）。③门禁现状：A 类 0、B 类 0（4 条豁免均写理由）、C 类 0（2 条豁免均写理由）；npm run audit 一次跑三类；src/test/audit-gates.test.ts 扩到 GATE-1~5（含"豁免必写理由"），自检样本扩到三类 —— 门禁本身必须会咬。验证：全量 254 文件 / 4993 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化。 |
| v1.16.40 | 2026-09-15 | **两个审计扫描器变成测试门禁；门禁上线当场又抓出 15 处 A 类（第 88 波）** — 把第 86/87 波的一次性扫描脚本升级为**每次跑测试都会执行**的门禁：tools/audit/scan-false-success.mjs（B 类：catch 里 return true；写/动作类函数的 catch 只有日志）、tools/audit/scan-silent-write.mjs（A 类：db.run(UPDATE … WHERE id = ?) 未走 runGuarded；DELETE 只列出不计违规）、allowlist.json（豁免必须写理由，GATE-3 强制）、src/test/audit-gates.test.ts（GATE-1~4：两类零未豁免 + 豁免必写理由 + **扫描器自检**用临时样本证明会咬）、npm run audit / audit:json。匹配前先剥注释（仓库注释里就写着这些模式，上一版的一处误报正来自此）。②**门禁上线当场抓出 15 处此前漏掉的 A 类**：旧 grep 只认模板串，兼容三种引号后扫出 storage/message.ts×7（含 `UPDATE messages SET hidden = 1`（**墓碑路径 —— 正是 v1.16.33「假压缩」事故的观测点**）、generated_files/retrieved_sources 两条路径、content 追加、attachments 外置写回）、knowledge/storage.ts×3（graph_nodes 的 community_id/weight/source_ids+chunk_ids）、squad-storage×2（归档、成员角色）、accounts 激活×2、sessions 排序 —— 全部接入探测器，让"墓碑写 0 行"这类事故从"靠旁证推断"变成"运行期直接响"。③另抓出 1 处 B 类：LLMEngine.setupSubagentSpawner 里 SubagentRuntime 初始化失败原来只有一行 warn（子智能体/委派整体不可用而用户只看到功能不见了）→ 走统一失败上报。验证：全量 254 文件 / 4992 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化、npm run audit 两类 exit 0；GATE-4 实测会咬。 |
| v1.16.39 | 2026-09-15 | **B 类机器扫描（31→2）+「沙箱模式」开关真的接线（第 87 波）** — ①按三类问题写扫描器（两级可证明判据：catch 里 return true/success:true；catch 只有日志且所在函数名属写/动作类）→ 报出 **31 处 P2**（P1 三处复核后均为误报：isCodeGraphEnabled 的"读不到设置默认开"是既有语义）。31 处含 updateSession/deleteProject/updateProject/createProject 写库失败仍更新 store、createWorktree 创建失败静默回退主工作区（用户以为在隔离分支改代码）、removeWorktree、委派任务三处、recovery.save/multiLayer.saveState/saveSessions、**permission.saveCustomRules（安全相关：以为拒绝规则生效）**、settings.saveFile（导出其实没写）、costTracker.setLimits、modelProfile.save、mcp.saveConfigs/setCodeGraphEnabled、sessionRecovery.clearSnapshot、storage.deleteQuickPhrase、syncEngine.autoSync、worktree.setExecutionMode、noteManager.deleteNoteLinksBySource、message.setMessageReasoning、saveFeedback、libraryOps.persistSettings/persistLayoutOverrides、retry.setConfig、**delegationTools.agentTeams/computerUse（注册失败=模型没这些工具）**、uiPlugins.load。新增统一通道 storage/persist-failure.ts（error 日志 + 按区域计数 + codem:persist-failed 事件，kind=persist/action），App 转成一次性可见提示（同区域不重复），不改控制流但不再静默；扫描器复跑 P2=2（自身文档注释 + createSession 的"读会话数失败用内存计数"这一处读操作）= 扫干净。②**设置面板里的「🔒 沙箱模式」一直是装饰品**：面板能勾、文案承诺限制写入范围，而 AgenticLoop 的 isSandboxEnabled 硬编码 ()=>false，SandboxGuard 从未启用 → 现在 sandbox-acl 导出 SANDBOX_SETTING_KEY/isSandboxAclEnabled/setSandboxAclEnabled（与面板同键）、AgenticLoop 跟随设置、面板改统一入口 + 独立 state + 写入失败提示、启动日志按真实状态说明生效防线。验证：新增 persist-failure-reporting PF-1~4（含关键路径接线契约）、sandbox-wiring-87 SBW-1~5（含面板不得再裸写该键、AgenticLoop 不得硬编码 false、真实管线里开关打开后工作区外写入被拒）；全量 253 文件 / 4988 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化、零 WriteGuard 空写告警。 |
| v1.16.38 | 2026-09-15 | **延伸审计（A 类，静默空写）：剩余 10 处「按 id 更新」接入探测器（第 86 波续）** — 按同一套三类问题继续机器扫描：`db.run(`UPDATE … WHERE id = ?`)` 全项目还有哪些没走 runGuarded，结果 10 处（6 个模块）：auth/storage updateAccount、knowledge/storage 的 updateNotebook/updateSource/updateNote/updateGroup/updateGraphNode、flashcard-store updateFlashcard、squad-storage updateSquad、storage/account updateAccount、storage/project updateProject。改动只有一件：接入 runGuarded（影响 0 行即记账+告警一次，行为与控制流不变）；同时把这 10 个函数里 `if (fields.length === 0) return;` 的空更新静默返回改成带函数名的告警（调用方以为更新成功、实际一个字段都没写）。有意不动两处 DELETE（agent_profiles.delete(id)、turn_file_changes.deleteBySession）——"删一个本来就不存在的行"是正常语义。验证：全量 251 文件 / 4979 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化、**全量跑完零 WriteGuard 空写告警**（说明接入后所有被测更新路径都真的写到了行）。 |
| v1.16.37 | 2026-09-15 | **把「看起来有、实际没有」的服务面修成真的（第 86 波）** — 继续上一轮列出的未修项，这一批的共同特征是"服务/接口存在、文档承诺了能力，底层却没实现（调用即报错，或更糟：返回值看起来成功）"。①插件服务面 —— **`ctx.get('hooks')` 是个空壳**（provider 暴露 register/unregister/executeHooks/listHooks/clearAllHooks 并声称"插件通过 ctx.hooks.register() 注册"、"ToolPipeline 会调 executeHooks"，而 HookManager 根本没有这四个方法：任何插件调用立即 TypeError、clearAllHooks 是空函数 → 现在补齐真正的运行时钩子并按事件接进 Pre/PostToolUse，deny/modify 真的生效、写错 action 按 fail-closed 拦下、undefined 视为无意见）；**uiJobs.cancelJob/retryJob 在 automation 缺失时 return true**（假成功 → 改为抛错）；**uiGoal.setGoal 在 driver 缺失时凭空造目标对象**（以为已持久化，实际 getGoals 仍为空 → 改为抛错）；**sessionCheckpoint.saveCheckpoint 返回 void**（调用方没带 id 就永远取不回 → 自动生成并返回 id，并写清检查点是进程内的、重启不保留）；**schedule 提醒到点但无通知通道时静默丢弃**（→ 告警）且 addRecurring(0) 会创建紧循环定时器（→ 拒绝）；**computer.setMode 写库失败不报**（重启后模式变回去 → 返回结果 + 弹提示）。②工具与循环 —— **browser_automate 从不读 MCP result.isError**（Playwright 报错被当成成功文本、单动作失败整次调用仍成功 → 转异常 + n/m 失败）；**github_tool 漏洞扫描把"扫描没做成"报成"没有漏洞"**（GraphQL 报错/缺 data.repository 时一律 ✅ → 区分并写明"不代表没有漏洞"）；**关闭反应式压缩后上下文溢出是静默终止**（无文本无事件 → 与压缩用尽同一套可见路径）；**SandboxGuard 恒关却没人说明**（isSandboxEnabled=false 是既有取舍，现在进程内提醒一次并写清真正生效的是工具级受保护路径与权限层）。③技能安装 —— **installSkill 静默跳过文件却仍 success: true**（只装一半 → skipped/warning 随结果返回，全部跳过即失败）。验证：新增 provider-honesty-86 HK2-1~11（撤掉修复必红验过三处）；全量 251 文件 / 4979 用例通过 / 15 跳过、tsc 0、UI 审计 0-0、css-contract 2745 类无变化、零 WriteGuard 空写告警。 |
| v1.16.36 | 2026-09-15 | **「全修」：上一轮审计列出的每一处都修掉（第 85 波）** — 用户要求"全修！然后再审计。我们的目标是消灭所有问题"。把 v1.16.35 逐条列出的"仍存在未修的"全部修掉，每条先复核原文、再修、再补一条撤掉修复必红的回归用例。①守卫被绕过/缺省放行类 —— **hooks 退出码从来没被读**（exit 1/7 的守卫等于没做，现在退出码 2 拦下、其它非 0/超时/抛错默认 fail-closed，只有显式 allowOnError 才放行；MODIFY 非法 JSON、未识别 action、modify 缺参数也一律拦下）；**exit_plan_mode 审批通过后没真切模式**（工具宣称已进 Default，实际计划模式仍在、同一回合所有写操作继续被拦 → 批准 = 真的切 UI 状态 + 正在运行的 loop，并把结果如实回报）；**SecurityScanMiddleware 是空的**（匹配后直接 proceed，注释却写着 post-execute 会追加，实际没有那段实现 → 现在真正记录）；**grepSearch 把搜索失败当成没有匹配**（路径不存在被 -ErrorAction SilentlyContinue 吞掉 → lsp 给出假否定 → 现在抛明确错误）。②假成功类 —— **工具把失败写成文本状态却永远 completed**（100+ 处失败路径是 output:"Error: …"，界面显示绿色成功、交付物判定把报错的写算成写下来了 → 新增 tool-result-status.ts：显式 isError 优先、内容型工具不推断、其余按首行前缀；errorSource:"tool" 让执行器区分工具自报失败与执行层异常；顺带修回 metadata 丢弃导致的 subagentId 到不了上层）；**MCP 的连上了是假的**（stdio 连 initialize 都不发就写 connected、tools/list 异常吞成空数组、autoDetectCodeGraph 无脑 true、isCodeGraphInstalled 只看 stderr 文本 → 现在握手 + 清单校验，失败即 error 带原因）；**agent-teams 三处永久卡死**（重启零对账 / 转派给成员后停在静默期 / 先领取再唤醒的幽灵占用 → 重启对账、两种目标都结束静默、先确认子会话存在再领取并给出可执行建议）；**可持续子智能体没有阀门**（无空闲看门狗、scoped loop 不进 loopPool 连中断句柄都没有、无轮次预算、中止的续聊轮仍结算成 completed → 看门狗 + scopedLoopPool + 轮次预算 + 如实标 cancelled）；**generate_ppt 汇报要求页数而非实际页数**；**ask_clarification 没通道时假装用户未回答**；**read_attachment 偏移应用两次**（起点约 2 倍、还把窗口长度写成文件总长）；**load_skill 工具加载失败只写 console**；**terminal 后台任务失败仍回已启动**；**图谱部分批次失败看不出来**（新增 warnings）；**memory/heartbeat/store.createSession 乐观返回**（记忆静默丢失、会话写失败仍设为当前会话）。③静默空写类 —— FileChangeStorage.updateStatus 写 0 行无痕、IssueStorage.update 空更新照样发通知、addNoteLink 的 INSERT OR IGNORE 被忽略仍计数、generateSourceSummary 四处静默 return、idle-tracker 的 0 语义反了、micro-compact 的"已压缩过"闸门语义错误、retry.ts 的总超时只统计 sleep、**沙箱 ACL 黑名单在 Windows 上几乎全失效**（条目不规范化、~/.ssh 死规则、误伤 .environment.ts）。验证：新增 8 个测试文件（HK/EPM/TRS/TEAMR/MCP-H/SUBV/SBX/HC 共 68 条，撤掉修复必红逐条验过）；全量 250 文件 / 4968 用例通过 / 15 跳过、tsc 0、审计 27 条规则 0-0、css-contract 2745 类无变化、零 WriteGuard 空写告警。 |
| v1.16.35 | 2026-09-15 | **按「问题类型」全项目延伸审计：又抓到 19 处同类缺陷（第 84 波）** — 用户要求"审计还有没有类似问题，尤其是任务管理链路；有问题不论新旧都修，然后按问题类型做延伸审计"。按三类问题（**静默空写 / 假成功 / 守卫被绕过**）做三路只读审计 + 本地逐条复核原文，修了 19 处：①静默空写类 —— `deleteMessagesAfter` 是唯一不写墓碑的删除路径（编辑并重发会让旧回复从日志复活）；新增 `storage/write-guard.ts` 静默空写探测器（id 定向写影响 0 行即记账+告警一次，已接入 9 个存储模块，并有"跑完一轮后台执行不许出现任何空写"的系统级用例）；issues/squads/inbox/agent-profile/file-change 从不 `persistDatabase()`（强杀即丢数据）。②假成功/永久卡住类 —— 委派链四个"不执行"分支只打日志不写失败（任务永久 running）、`executeSessionTurn` 重复执行保护不通知编排器、**被中止的回合报成功**（微信收到"处理完成（无文本输出）"）、重启后被中断的委派只 warn 不置失败（继续占并发额度）、**agent-teams 唤醒成员 `followup` 参数位置全错**（3 参 vs 4 参签名 → 每次都抛错被吞，成员永远收不到任务）、`squad_dispatch` 的 `spawnFailures` 从不读取、**子智能体中断后父会话永久阻塞**（abort 分支提前 return 跳过 settlement 解析）、子智能体自报 failed 被当成 completed、**笔记 `[[WikiLink]]` 保存后必被删空**（删除排在微任务）、`list_sessions` 用永远为空的 Set 判执行中。③守卫被绕过类 —— 停滞守卫把"可能写"的命令当交付物（新增 `artifact-tracker.ts` 分级）、重复守卫的"写后宽容"可被幂等写无限重新武装、**PowerShell 危险命令整段跳过分析**（Windows 平台下 auto 模式等于没闸门）、计划模式写名单缺 shell、权限 `ask` 无回调时默认放行（fail-open）、`echo x > file` 被判成只读。**审计仪器**：全量跑完零 `[WriteGuard]` 告警。验证：新增 silent-write-guard SWG-1~6 / STALL-10~12 / GUARD-20 / note-links NL-1~2（修复前必红）/ powershell-danger-gate 17 条 / PLAN-1~5 / EXEC-1~3+DELE-X1~2；全量 242 文件 / 4900 用例通过 / tsc 0 / 审计 27 条规则 0-0 / css-contract 无变化。**仍存在未修的**（已在 CHANGELOG 逐条列证据）：phone-link 202-then-work 且失败只进 console、wechat 出站失败被吞、关闭 UI 插件未真卸载、文件变更面板恒空（HEAD^{tree} 判定）、hooks 退出码未读、exit_plan_mode 未真切模式、ToolRegistry 把文本错误标成 completed、团队链路三处未闭环、子智能体无空闲/预算上限、memory/store/heartbeat 乐观返回。 |
| v1.16.34 | 2026-09-15 | **跨会话委派：b 会话原地打转、a 会话干等（第 83 波续）** — 用户现场：a 把情况交给 b（b 要读三个 docx、建认知、产出确认文件），a 侧正常，**b 卡住**：控制台反复 `Single-response dedup: [bash("python …\_tmp_extract.py")]` + `Tool executed … output length: 358`（每次输出都一样）+ 每次更新都打 `[SessionJSONL] 更新消息 assistant-…-2 时找不到所属会话`；a 一直等不到反馈。①**根因（主因）：后台执行的"第 2 轮之后整轮历史都写不进库"** —— `executeSessionTurn`（委派/后台路径，不碰 React store）在 `start`（iteration>1）里**只换了 `currentAssistantMsgId`、没有建行**，之后全部走 `updateMessage`/`addToolCall` → `UPDATE … WHERE id=?` 影响 0 行、`tool_calls` 挂在幽灵消息上 → 第 2 轮起的正文/工具调用/工具结果**全丢**（就是那行刷屏告警）。而 AgenticLoop **每轮都从库里重建上下文** → 模型看不到自己上轮干过什么 → 一遍遍重发同一个工具调用 → 死循环。**修复**：抽出 `ensureAssistantMessage()`，任何要写"当前助手消息"的事件（delta/工具开始/完成/报错/新一轮）都先确保这一行存在；并修掉同类的第二种丢法（模型"不说话直接调工具"时 id 还是空的，以前直接跳过 → 调用与结果凭空消失）。②**根因二：重复调用守卫给解释器命令发了"永久免死金牌"** —— `python` 在 `MUTATE_CMDS` 里 → `inspect()` 判定 mutate 后**直接 return allow**，把零增益判定整段短路（第 62 波现场是 `Get-ChildItem` 所以拦住了，这次换"用脚本当读手段"就绕过去了）。**修复**：拆成 `MUTATE_CMDS`（可证明会写：Set-Content/Remove-Item/重定向/新建/复制…→ 清零证据并放行）与 `SPECULATIVE_MUTATE_CMDS`（可能写：python/node/npm/git/cargo/docker/curl/start-process…→ **不清零、不短路**，必须靠结果是否真的变了证明进展；`bashIntent` 加 `provable` 字段，`kind` 保持 `mutate` 不破坏其它调用方）；"写后宽容一次"的豁免留给紧随其后的重看而不是被写操作自己的结果吃掉。③真机验证发现并修掉**「委派假成功」**：工具创建了任务并回"已创建"，但 App 侧执行入口只在 `useProjectStore.sessions`（当前项目）里找目标 → 跨项目/全局会话直接 `Target session not found`，父会话要等 `wait_for_delegation` 才知道根本没跑 → `delegate_to_session` 现在**先确认目标存在**（store ∪ 持久层，不存在就直接报错且不建任务），App 侧执行入口加**持久层回退**。④验证：`delegated-turn-persistence.test.ts` EXEC-1~3 + DELE-X1~2（EXEC-1 **撤掉修复会红**：实际只剩 `assistant-…`、`err-…`）；`loop-guard.test.ts` GUARD-17~19（复刻用户现场：同一脚本、输出恒为 358 → **真实执行 ≤ 8 次就被停**，而产出真在变时照常放行）；全量 238 文件 / 4866 用例通过 / tsc 0 / 审计 27 条规则 0-0 / css-contract 无变化。 |
| v1.16.33 | 2026-09-15 | **上下文压缩是「假压缩」：删了 840 条、上下文一条没少（第 83 波）** — 用户现场日志：每轮都 `Removed 840/841 old messages, kept 20`，但请求恒为 ~105 万 token，迭代 1→2→3→4 反复压缩白烧 LLM 摘要，最后硬停"请开启新对话"。①**根因（致命）**：`doCompactMessages` → `deleteMessagesByIds` 只做索引侧软删除（`UPDATE messages SET hidden=1`），**不写权威日志**；而读路径 `listMessages` = 索引(`WHERE hidden = 0`) ∪ 追加日志（第 79 波把合并收进 listMessages 的那次改动）→ 日志里根本没有 hidden 语义，被"移除"的消息**整批加回来且不带 hidden** → 压缩声称删 840 条、下一次读又回来 840 条。**先用例钉住复现**：30 条软删除 25 → `listMessages` 仍返回 30 条、带 hidden 的 0 条。**修复**：`deleteMessagesByIds` 同时写**权威日志墓碑**（与 `deleteMessage`/`deleteMessagesBefore` 对齐）并**同步剔除内存镜像**；墓碑纳入 `flushSessionLogWrites()` 在途集合（原来墓碑没登记，删完立刻 flush 再读会读到旧内容）；读路径加两道防御（日志里 deleted/hidden 不进读集合 + **索引里的 hidden 集合也参与判定** → 老版本已踩坑的会话立刻恢复）。②**根因二（体积盲）**：压缩只看条数（固定"保留最近 20 条"），而这 20 条自己就能顶满窗口 → 永远压不进 → 只剩重试。**修复**：抽出 `src/core/llm/compaction-budget.ts`（纯逻辑 + 独立用例）：按 token 估算成半收缩（仍对齐轮次边界，避免"没有 tool_use 的 tool_result"），预算 = 窗口一半，下限 4 条；连下限都装不下就判 overBudget 并直接顶满连压计数，立刻给出可执行结论（开新对话/改用附件）。③**真机验证（同一现场：10 条大消息 ≈ 100 万 token，窗口 1M）**：修复前 `Too many consecutive compactions, forcing stop` 且**没有任何 [compactMessages] 日志**（messagesToRemove=0，压缩空转）；修复后 `保留集按体积收缩：11 → 5 条（估算 199976，预算 500000，窗口 1000000）` + `Removed 6 old messages, kept 5`，本轮正常回复结束，库内 6 条 `hidden=1`、权威日志 6 条墓碑、压缩标记就位。④顺手修掉一条**依赖外网**的用例（extractText URL 真的 fetch example.com → 全量跑随机超时红），改为 fetch 桩。验证：`compaction-budget.test.ts` CB-1~12 + `compact-resurrect-repro.test.ts` REPRO-1~2；全量 237 文件 / 4858 用例通过 / tsc 0 / 审计 27 条规则 0-0 / css-contract 无变化。 |
| v1.16.32 | 2026-09-15 | **用户报的「推理强度点不动」+ 发布后自查的同源一致性（第 82 波）** — ①**用户 bug（主对话区顶部模型列表里点「推理强度」闪烁、选不中）**：用打包版本 + CDP **真实鼠标事件**测出关键证据 —— 按下时 `pointerdown/mousedown` 命中 `new-chat-page`（浮层被盖住），松手时 `mouseup` 命中 `chat-effort-row`（又回来），**期间 DOM 零变更**。根因：全局按压反馈给通用可点元素加 `transform`（`button/[role=button]/.clickable:active → scale(0.97)`、`translateY(--press-shift)`），而 `transform` **创建层叠上下文** → 聊天栏模型下拉（`<div class="model-selector" role="button">` 内部渲染 `.model-picker`，推理强度行同理）的 `z-index:1300` 退化成局部的 → 按住时整个浮层被兄弟节点 `.chat-body` 盖住：视觉上"闪烁"，交互上 mousedown/mouseup 命中不同元素 → click 派发到**共同祖先** → 选项 onClick 不执行 = "选不中"。**修复**：新增宿主标记 `.press-layer-host`（内部渲染浮层的可点元素退出几何按压反馈，改用背景色反馈），两条全局按压规则加 `:not(.press-layer-host)`，ChatPanel 两处宿主标上；并把这一类**做成门禁**：`tools/ui-audit/scan-ui.mjs` 新增 `press-feedback-layer-host`（CSS 侧）+ `press-transform-hosts-layer`（TSX 侧，用 TypeScript 编译器 API 精确遍历 JSX），规则**自检过**（去掉标记 → 报 5+1，恢复 → 0）；全项目同类结构排查只有这两处（其余 5 处是类名误报）。顺手修同类"点了没反应"：`ModelSelector` 推理强度只写存储不进 state → 写入后界面不刷新，现进 state 立即回显。②**自查同源一致性**：引擎注入范围漏了"配了 key 但没刷新过"的 provider（`loadDynamicModels` 只遍历缓存键 → 改 缓存 provider ∪ `BUILTIN_MODEL_CATALOG`，ENG-1~4）；方案面板选不到目录模型（`ModelProfilePanel` 原读缓存 → 改走 `getMergedDynamicModels()` 并抽出 `buildAvailableProviders()`，MPS-1~4）；`isUnknownModelError` 收得太宽（`Invalid model input` 会被当成名字问题 → 现须带 name/id/冒号，CH-1b）；记录条数上限在同一毫秒下会丢最新写入（全量跑才暴露 → 反序+稳定排序）。验证：真机（打包版本）按下浮层仍在命中栈顶、选项可点中、值即时回显并落库；`press-layer-host.test.ts` PLH-1~5；全量 235 文件 / 4844 用例通过 / tsc 0 / 审计 27 条规则 0-0 / css-contract 无变化。 |
| v1.16.31 | 2026-09-14 | **用户追问「内置目录」三连：旧名重复列出 + 供应商改名了怎么办（第 81 波）** — ①**事实**：服务器 `/models` 实际返回 `deepseek-flash` / `deepseek-v4-pro`；Codem **源码写死**的内置目录（`model-catalog.ts`）是 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`；并集 = 用户看到的 4 条。②**目录的来由**（v1.16.24）：实测服务器 `/models` **不是"可调用模型"的完整真相** —— `/v1/models` 只有 2 条，但 `POST chat/completions model=deepseek-v4-flash-vision-exp` 实测 **200 可调用**；DSH 能看到它是因为 DSH 把模型当**静态目录**（listModels 不请求服务器）；Codem 只信服务器列表 → 该模型消失（而内置方案视觉槽位正指向它）→ 于是加目录做兜底并集并标注来源。③**用户这一问暴露的真缺陷**：目录里的 `deepseek-v4-flash` 是服务器当前 `deepseek-flash` 的**旧名**（同一模型），并集后重复列成两条、其中一条还挂"服务器未列出"，像凭空多出来 → **修复**：目录条目支持 `aliases`，服务器已列出等价 id 时该条目不再补入；服务器都不列时旧名仍兜底（不因去重丢能力）；仅剩真正"服务器不列但可调用"的视觉模型；设置里给目录条目加 `title` 说明来源与优先级。修复后显示 **3 条**。④**追问「供应商改名了怎么办」→ 第二个真缺陷**：对比 DSH（`dsh-llm-deepseek/lib/index.js`）—— 它的模型表是**纯静态** `DEFAULT_MODELS`（`:1825`）、`listModels()` 直接返回配置目录（`:1558`）、**全程不请求 `/models`**（唯一网络调用是 `/chat/completions` `:1754`），对"目录过期"**不处理**，靠"目录只是建议"兜底（`listModels` 文档：不得把目录缺席当成拒绝；`modelInfoFor` `:1563` 对未列 id 照样放行、用 `defaultContextWindow` 补元数据），且 `models` 是**可配置项**（`:1870`）。Codem 取舍：服务器列表=事实来源（改名/新增自动跟上）+ 目录兜底 + **失败证据落盘** → 新增 `src/core/llm/catalog-health.ts`：只在服务器明确说"不认识这个模型名"时记账（`isUnknownModelError`，并**先排除上下文超限措辞**），网络/401/429/5xx/超限**一律不记**；接在 `stream()`/`complete()`/`vision-proxy` 三条真实错误路径；成功即撤销、30 天有效期、单 provider 上限 80 条、坏数据静默降级；界面把被拒条目**沉底并标注**「服务器已拒绝此名字」+ 悬停给出时间与服务器原话，**不删除**（可能改回来）。⑤**验证**：CAT-8/CAT-9 + `catalog-health.test.ts` CH-1~13 + `catalog-health-wiring.test.ts` CH-14~17（接线用真实 `Response` 打三条路径）；全量 232 文件 / 4829 用例通过 / tsc 0 / 审计 0-0 / css-contract 无变化。 |

| v1.16.30 | 2026-09-14 | **路线收尾两项：附件外置 + 全文索引一致性（第 80 波）** — ①**附件外置**：`attachments.content` 过去把文档全文存进 SQLite（长文档几十 MB），而本地库整库常驻内存、sql.js 只能整库导出 → 一条大附件就顶高每次保存的内存峰值。新设计（**不改 schema、常见场景行为不变**）：小内容（≤64 KB，含图片 data URL）保持内联、零文件 I/O；大内容写 `<appData>/attachments/<id>-<name>`（**原子写** .tmp→rename），库里 `content` 存 `file:<路径>` 标记、`preview` 留开头；附件读取是**同步**路径而文件读取是异步 → **预取 + 同步命中**（启动维护 hydrate 进内存缓存），未预热时返回 undefined 并补一次异步预取、**绝不把标记当正文**（有专门用例）；外置异步排队完成（createMessage 保持同步）、失败保留内联；孤儿文件随维护清理。②**全文索引一致性**：`session_fts` 无外键级联，裁剪后留孤儿行（真机实测 112 条）→ 新增 `rebuildSessionFts`：删除"既不在索引也不在日志镜像"的行、为"在日志镜像但不在 FTS"的历史补行；断言口径 = FTS 内容与"读者可见消息集合"一致。③**审计修正（自己接错线）**：写 ATT-4 时发现我把"回填日志/附件预热/日志压缩"和"是否裁剪索引"塞进同一个 `if` —— 关掉索引裁剪时附件就不预热（同步读取拿不到外置内容）、日志也不压缩；现只有裁剪受该开关控制。④**验证**：`attachment-externalization.test.ts` ATT-1~4 + FTS-1；全量 230 文件 / 4810 用例通过 / tsc 0 / 审计 0-0 / css-contract 无变化。⑤路线至此全部完成：①削峰节流 ②原子写 ③致命错误停止重试+抢救 ④WASM 引擎 ⑤工具溢出 ⑥事件快照压缩 ⑦JSONL 权威存储+SQLite 可重建 ⑧日志压缩 ⑨附件外置 ⑩全文索引一致性。 |
| v1.16.29 | 2026-09-14 | **存储改造的审计修正（读路径没接上＝静默丢历史）+ 日志压缩（第 79 波）** — ①**审计发现三处真 bug（均为上一波自己引入）**：(a) **读路径没接上（严重）**：上一波做了"索引可有界裁剪 + 日志是权威"，但 `listMessages` 仍**只读索引**，而全平台几十处调用它（UI store.loadMessages、agentic loop 上下文、fork、导出、上下文监控、不变量）→ 被裁历史**凭空消失**（真机已裁 112 条）→ 现在把合并收进 `listMessages`（`listMessagesFromIndex` 留内部），所有调用点自动拿到完整历史；SLOG-8 同时断言"索引只剩 3 条 / 读者仍见 8 条"。(b) **更新路径从未写进日志**：`appendUpdatedMessageToLog` 靠 `getMessage(id)` 取 sessionId，而它返回的 Message **不含 session id** → sessionId 恒 undefined → 更新**从未落日志**（日志只有初版，索引被裁/重建后内容会回退）→ 改为直接查库拿 session_id（与删除路径同源）+ 查不到时告警。(c) **按 id 读取在裁剪后失效**：搜索命中/跨会话引用/fork 走 `getMessage` 而索引已无该消息 → "搜索得到、点开却没有"（实测 `session_fts` **112 条**孤儿行正是这条路径暴露的）→ `getMessage` 查不到索引时回退日志镜像。②**收尾项：追加日志压缩**：新增 `compactSessionLog()` 把日志重写成"每个 id 只留最新一行"（后写者胜+墓碑语义不变），**原子替换**（.tmp→rename）、安全性检查（行数须等于唯一 id 数且严格减少，否则放弃）、压缩前等齐在途写、压缩后重新 hydrate；维护对 ≥200 行的会话自动执行。③**全平台存储隐患快查（真机 DB 实测）**：附件 0 行（**附件外置**仍是待做项：长文档会全文进库）、`session_fts` 孤儿 112 条（读取路径已修，FTS 行有意保留）、memory/recovery/notebook 合计 <50 KB 无风险。④**验证**：SLOG-1~10；全量 229 文件 / 4805 用例通过 / tsc 0 / 审计 0-0。 |

| v1.16.28 | 2026-09-14 | **治本（三）：会话落成 append-only JSONL，SQLite 降级为可重建索引（第 78 波）** — ①**这一步要治的根**：前六波把风险压到最低，但"整库导出"这个动作还在 —— 只要会话历史住在 SQLite 里，库就随对话增长，而 sql.js 只能整库 export，峰值随之增长直到 out of memory。DSH 的答案是：权威存储 = **append-only JSONL**（增量追加、无整库导出），SQLite 只是**可重建的查询索引**。②**实现**：`<appData>/sessions/<sessionId>.jsonl` 一行一条消息（`append_file` 追加即持久，同 id **后写者胜**，损坏行只计数不致命）；`createMessage`/`updateMessage`/`appendToMessage` 全部双写；启动维护**先回填**老会话再裁剪索引（`trimIndexedMessages`：每会话至少留 500 条，超出的只有"日志里确实存在"且"无附件"才删）；读路径 `listMessagesMerged` + `hydrateSessionLog` 合并日志，被裁历史照样读得到。③**自查审计修掉两处自己写的 bug**：(a) 日志成权威后 `deleteMessage` 只删索引 → 被删消息会**复活** → 删除追加**墓碑**（`deleted:true`，后写者胜），所有真删除路径都补墓碑；(b) 耐久性检查可能读到**旧日志**（追加是 fire-and-forget）→ 新增 `flushSessionLogWrites()`，裁剪/回填前先等齐。④**另一个教训**：多行 PowerShell 替换两次静默没生效，导致**双写根本没接上**（日志一直为空）——是 SLOG-5/6 抓出来的；结论：新增关键路径必须有"从用户动作这一端"验证接通的用例。⑤**验证**：`session-jsonl-index.test.ts` SLOG-1~9（含耐久性不变量、墓碑防复活）；全量 229 文件 / 4804 用例通过 / tsc 0 / 审计 0-0 / css-contract 无变化。⑥**路线收尾**：①削峰节流 ②原子写 ③致命错误停止重试+抢救 ④WASM 引擎 ⑤工具溢出 ⑥事件快照压缩 ⑦JSONL 权威存储 ← 本波完成（后续可做：FTS 重建、附件外置、旧会话一次性迁移压缩）。 |
| v1.16.27 | 2026-09-14 | **治本（二）：事件日志快照式压缩（第 77 波）** — ①**死结**：`session_events` 只增不减（本机实测 2130 行 / 3.8 MB），但**不能按 seq 截断** —— 事件被投影当状态读取（`event-projection` 重建投影、`runtime-invariants` 靠回放查不变量，preset-discovery/feedback/postmortem/time-context/session-search/ui-trajectory/sync-engine 都 readAll），截断 = 悄悄改数据；上一波只能把裁剪默认关掉。②**本波**（对齐 DSH `dsh-session-projection-cache` 的 checkpoint 思路）：新增 `session_snapshot` 事件 + `EventLog.compactWithSnapshot()` —— 先把**截至锚点的投影**固化成事件，再删锚点之前的事件（`session_meta` 永不删），**回放 = 快照 + 其后事件，与完整回放逐条等价**。③**三个坑（我踩的）**：(a) 快照必须**占据锚点自己的 seq**（`INSERT OR REPLACE`）——否则快照排到"要保留的尾部事件"之后，而 `applySnapshot` 是替换语义，回放会把刚发生的对话覆盖丢失（SNAP-4 当场抓住）；(b) `applySnapshot` 必须**替换而非合并**，否则残留叠加成重复消息；(c) 维护默认只压缩 **>5000 条事件**的会话并**保留最近 8 条**，阈值内小会话完全不碰。④**验证**：`snapshot-compaction.test.ts` SNAP-1~6，其中 **SNAP-2 回放等价性**（压缩前后投影逐条一致）是本波敢默认开启压缩的唯一理由；全量 228 文件 / 4795 用例通过 / tsc 0 / 审计 0-0 / css-contract 无变化。⑤**路线位置**：已做 ①削峰节流 ②原子写 ③致命错误停止重试+会话抢救 ④WASM 引擎 ⑤工具结果溢出+保留期 ⑥事件快照压缩；**待做 ⑦ 会话持久化改 append-only JSONL、SQLite 降级为可重建索引**（做完"整库导出"才从架构里消失；⑥的快照机制是 ⑦ 的前置）。 |
| v1.16.26 | 2026-09-14 | **数据库治本：换 WASM 引擎 + 对齐 DSH 的溢出与保留策略（第 76 波）** — ①**DSH 参照**（本机 `@deepseek-ai/*` 包）：权威存储是 **append-only JSONL**（`dsh-session-persistence-jsonl`，增量追加、无整库导出），**SQLite 只是可重建的 FTS5 查询索引**（`dsh-session-query-sqlite`）；超限工具文本走 `dsh-spill`/`dsh-spill-local`/`dsh-spill-policy`（`maxInlineBytes`，head/tail 预览 + 定位符 + `describeOmitted` 说明）；`dsh-output-retention` 的 `ItemRetainer`/`TextRetainer` 按**字节**计预算并做 **UTF-8 边界修剪**；`dsh-atomic-write` 用"随机后缀临时文件 + rename"。②**本波两条**：(a) **换 WASM 引擎** —— asm.js 堆扩容只能整块复制、失败即 abort 整个模块（那屏 `xe[…] is not a function` + OOM 刷屏的机制），wasm 走 `memory.grow`；`sql-wasm.wasm` 随包发出、`locateFile` 指过去，资源缺失自动回退 asm 并告警；(b) **spill + 保留策略** —— 新增 `src/core/storage/spill.ts`：工具结果 >64 KB 时全文写 `<appData>/spill/<sessionId>/<tool>-<callId>.txt`（原子写），入库/入上下文的是 head 8 KB + tail 8 KB 预览（UTF-8 边界安全）+「（已省略 N 字节；完整结果保存在：<路径>）」，未超限零 I/O、溢出失败回退原文；拦截点 `executor.ts` 的 `tool_complete`（结果进库进上下文的唯一入口）；启动后台 `runDatabaseMaintenance()`：遥测保留 7 天 + **按需** `VACUUM`（护栏：空闲页 ≥5% 且库 <256 MB），打印前后占用；**审计修正：默认不裁剪 `session_events`**（事件日志被投影/不变量/预设发现当作状态读取，截断 = 悄悄改数据；安全做法是先写快照事件再丢旧事件）。③**实测**：真实库副本维护 `10.62 MB → 10.34 MB`（事件 0 行 / 遥测 960 行 / 回收 0.29 MB = 2.7%）——照实说：这个库还不够大、收益有限，主因是"每次保存整库导出 + asm.js 堆"；spill 实测 200 KB 结果 → 入库 <20 KB。④**验证**：`spill-retention.test.ts` SPILL-1~5；全量 226 文件 / 4783 用例；tsc 0；审计 0-0；css-contract 无变化；构建产物启动日志确认 wasm 引擎 + 维护 + 保存往返。⑤**诚实留给下一波**：彻底对齐 DSH 需要把会话持久化改成 **JSONL 追加 + SQLite 只做可重建索引**（一次存储层重构）。 |
| v1.16.25 | 2026-09-14 | **本地数据库内存耗尽（out of memory 刷屏）：三条防线（第 75 波）** — ①**现象**：控制台先出现 `TypeError: xe[e[((s+12)>>2)]] is not a function`，随后 `out of memory` / `malformed database schema (sqlite_master) - table x already exists` 在 saveMessages / loadFeedback / cost-tracker / telemetry / store.updateSession / readAll 各处刷屏几十次，`[extractMemories] Extracted 0 memories` 静默失效。②**本质**：asm.js 版 sql.js 堆扩展失败会 **abort 整个模块**（那句"函数指针 is not a function"就是模块已死的签名），之后每次调用都报同样的错 —— 真正的伤害是**级联**：调用方无限重试，而写入永远不成功（消息写不进库）。③**防线一：削峰 + 合并**（`database.ts`）—— 旧实现每次保存 = `db.export()`（整库一份）+ 与库等大的二进制字符串 + `btoa` 的 1.33 份（峰值 ≈2.3× 库大小），现在分块编码一次 join（≈1.33×）；整库 export 是 sql.js 唯一落盘方式，那就加**脏标记 + 2 秒节流窗口**（telemetry/cost/autosave/设置写入一次对话会轮番触发几十次）。④**防线二：原子写盘** —— 先写 `codem-db.bin.tmp` 再 `rename` 覆盖；半截 base64 落盘就是下次启动的 `malformed database schema`（仓库里的 `codem-db-broken.bin` 即此）。⑤**防线三：认出致命错误后停止重试并抢救会话** —— 新增 `isFatalDbError()`（OOM / malformed schema / disk image malformed / bad parameter）+ `DB_FATAL_EVENT`：只报一次、停止一切后续写入与重试；App 收到事件后**绕开 sql.js** 把当前会话写成 `codem-session-rescue-<ts>.json` 并提示"关闭重开 + 把 rescue 文件发我"（数据库这条路已断，只有直写 JSON 能保住用户消息）。另修 `importDatabase()`：旧实现把 `initSqlJs()` 的 **Promise** 当构造函数用 → 必抛 `SQL.Database is not a constructor`（"导入恢复"以前根本走不通）。⑥**验证**：新增 `database-oom-defense.test.ts` DB-OOM-1~6；**双向验证** —— 把三处修复临时改回旧行为，DB-OOM-2/3 立刻失败，恢复后全绿。⑦**已知未完成（下一波）**：换 `sql-wasm.js`（asm.js 堆扩展只能拷贝整堆）、控库体积（本机实测 `session_events` 3.8 MB 只增不减、`tool_calls.result` 2.6 MB，需保留策略 + VACUUM）。 |
| v1.16.24 | 2026-09-13 | **为什么模型下拉只有 2 个 DeepSeek 模型：服务器 /models 不是「可调用模型」的完整真相（第 74 波）** — ①**用户提问**：改成从服务商拉列表后，DeepSeek 只拿到两个模型、没有 `deepseek-v4-flash-vision-exp`，而 DSH 有。②**实测**（同一把 key 直连官方接口，脚本 `.preview-shot/probe-deepseek-*.mjs`）：`GET /v1/models` → **只有 2 个**（`deepseek-flash`、`deepseek-v4-pro`，且已从 `deepseek-v4-flash` 改名）；`POST chat/completions model=deepseek-v4-flash-vision-exp` → **HTTP 200 可正常调用**；`model=DeepSeek-V4-Flash-Vision-Exp` → **HTTP 400**（"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed …"）。③**DSH 之所以有，是因为它的模型是静态目录**：`dsh-llm-deepseek` 的 `DEFAULT_MODELS` 写死了 flash / pro / vision-exp，其 `listModels()` **根本不请求服务器**；Codem 只信服务器列表 → "能调用但未列出"的模型消失。④**另一个真 bug**：API 模型 id **大小写敏感**，而 Codem 内置方案把**显示名**当 id 用（`DeepSeek-V4-Flash-Vision-Exp`）→ 视觉代理走该槽位必然 400。⑤**修复**：新增 `src/core/llm/model-catalog.ts`（内置目录 + `mergeModelsWithCatalog` 并集 + `normalizeModelId` 归一化）—— **服务器列表仍为事实来源**（服务器给的模型全保留，含改名后的新 id 与未来新模型），目录只补服务器缺的并标记 `catalogOnly`，界面如实标注「（内置目录，服务器未列出）」；并集在 `loadDynamicModels`（**升级后无需手动刷新即出现**，缓存仍只存服务器事实）、`model-config.ts`、设置页刷新/视图三处统一生效；vision 槽位改小写并在 `resolveSlot` 读取处归一化历史方案；`vision-proxy`/`capability-detector` 登记该模型支持视觉。⑥**退役两条把 bug 写进断言的用例**并改为实测可调用的小写 id。⑦**验证**：新增 `model-catalog.test.ts` CAT-1~7（含**用户场景回归**：缓存只有那两个模型时视觉模型必须出现）。⑧**教训**：**第三方列表是"元数据"，不是"可用性真相"** —— 能调用但未列出的模型必须由内置目录兜底，且来源要在界面上说清楚。 |
| v1.16.23 | 2026-09-13 | **「删除技能卡死」真正根因：确认弹窗被压在模态窗口后面（第 73 波）** — ①用户发来落盘轨迹，两条证据一次定位：`heartbeat` 每 2 秒一行、`driftMs` 仅 ±10ms → **窗口没卡死、主线程正常**；`confirm action fired` **一次都没有** → 那个"删除"按钮根本没被点到（所以 `[SkillInstaller]` 一行都没有）。②**根因**：技能管理器本身是模态 `.modal-overlay { z-index: var(--z-modal) = 1300 }`，而"确认删除"弹窗 `.alert-dialog-content { z-index: var(--z-dropdown) = 1000 }` —— 弹窗经 Portal 挂在 body 下，与模态**不在同一层叠上下文**比较，只要模态落在自带层叠上下文的祖先里（皮肤/插件/祖先样式），1300 就把 1000 整个压住：**看不见、点不到**；而 Radix 打开模态时已把 `body` 设为 `pointer-events: none` → 点哪都没反应，表现为"整个窗口卡死"，而主线程/日志/性能全无异常（**这类事故没有任何控制台线索**，正是它查了三轮的原因）。③**修复两层**：新增层叠令牌 `--z-dialog-overlay: 1400` / `--z-dialog: 1410`（严格高于 1300）并让 `.alert-dialog-content` / `.dialog-content` / `.dialog-overlay` 使用 → "对话框高于模态"成为明文约束；删除确认**改为详情面板内联确认**（「确定要删除「X」吗？」+「确认删除 / 取消」，新增 `.skill-delete-confirm(-actions)` 样式）→ 根因是"模态里套模态"，那就让它不再套模态。④**顺带**：轨迹里的删除目标是一个名叫 `skills`、路径 `<技能根目录>\SKILL.md` 的**幽灵技能**（技能根目录下有个名为 SKILL.md 的目录，其内部 SKILL.md 无 `name` 字段被兜底成父目录名）→ 现在加载时跳过结构异常目录并明确警告。⑤**验证**：新增 `dialog-layer-contract.test.ts` LAYER-1~4（令牌序 + 三处规则用法 + 不再使用嵌套模态确认）与 UNINST-9；真实界面验证改用**真实鼠标事件**（CDP `Input.dispatchMouseEvent`）—— 上一轮用 `element.click()` 属**假绿**（JS 点击绕过命中测试，恰好绕过本 bug）。⑥**教训**：**"窗口卡死"先分清"主线程停了"还是"交互被挡住了"**（心跳漂移一眼分开）；**JS 点击不能用来验证可点击性**。 |
| v1.16.22 | 2026-09-13 | **「删除技能卡死」第二轮：把不可复现的冻结变成可取证（第 72 波）** — ①**用户复测仍卡死**并给出三条关键信息：删的是**用户来源**技能、**整个窗口点不动**、控制台**连一条 `[SkillInstaller]` 都没有**。第三条改变范围判定：连删除逻辑入口都没进 → 卡点在「点击 → 进入删除逻辑」之间，而不是原生删除。②**本机用 WebView2 远程调试（CDP）驱动真实界面**把删除跑通取证：探针技能 → 技能管理 → 选中 → 删除技能 → 确认 ⇒ 控制台出现 `[SkillInstaller] uninstall … → 永久删除 …`、弹窗关闭、用户技能数 1 → 0、磁盘目录消失、无错误；且本机构建与用户日志**逐行对得上**（`main-IHu-_uUa.js:9571 / :8813`）→ 证明同一条代码路径在另一侧正常，他的卡死是数据/状态相关。③**新增落盘黑匣子** `src/core/skill/skill-delete-diag.ts`：写 `<appData>/.codem/skills-delete-diag.log`，记录 `delete button clicked` / `confirm dialog opened` / `confirm action fired`（含技能名·来源·路径 + `+Nms` 相对时间戳）、`heartbeat`（每 2 秒，`driftMs` 超阈值附 `suspicion: main-thread block` = 窗口点不动的机器可读证据）、`render burst`（1 秒内渲染数超阈值，抓"无限渲染循环"——它钉死主线程且不产生任何控制台输出）；写盘全部 fire-and-forget + try/catch，**诊断失败绝不影响删除**（有专门用例守）。④**同时补三处**：慢删除显示「正在删除… 已用 N 秒」（超过 5 秒补说明，慢 ≠ 卡死）；删除失败就地显示在详情面板按钮下方（不再只依赖顶部横幅）；**目标护栏** —— 若记录路径其实是技能根目录本身或其上级，直接拒绝并说明（否则"删一个技能"会变成"删掉全部技能"，且目标体积/耗时不可预测）；`handleDelete` 的空目标分支从静默 return 改为可见错误 + 落盘。⑤**验证**：CDP 端到端跑通并确认轨迹落盘完整；新增 `skill-delete-diag.test.ts` DIAG-1~4 与 UNINST-6~7；全量 222 文件 / 4760 用例通过 / tsc 0 错误 / 审计 0-0 / css-contract 无变化。⑥**教训**：**不可复现的卡死，第一步不是猜代码，而是把"点击到哪一步、主线程停了多久"变成落盘事实**。 |
| v1.16.21 | 2026-09-13 | **修复：技能管理「删除技能」卡死（第 71 波）** — ①**现象**：点删除后卡死，控制台只有启动日志、无任何错误（卡住的不是 JS，是一个永不完结的原生调用）。②**根因**：`uninstallSkill → deletePath(目录) → delete_directory` 在 Windows 上走 `powershell -Command "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('<目录>','OnlyErrorDialogs','SendToRecycleBin')"` 并用 `Command::output()` 等它退出 —— `OnlyErrorDialogs` 的语义是「出错时弹对话框并等用户确认」，而 PowerShell 是**隐藏子进程**（没有可见窗口），于是删除一旦失败（文件被占用 / 回收站不可用 / 目录超过回收站配额）对话框就弹在没人能点的地方 → 进程永不退出 → Tauri 命令永不返回 → 前端 await 永不结束 = 卡死。同一命令还被项目删除与宠物卸载复用。③**修复三层**：新增 Rust `delete_directory_permanent`（`remove_dir_all` + 只读位清障重试）供**应用自管目录**（技能/宠物/zvec 运行时/快照）使用；`delete_directory`（回收站，留给项目文件夹等用户内容）改为直接调 `SHFileOperationW` 并抑制全部界面（`FOF_NOCONFIRMATION\|FOF_SILENT\|FOF_NOERRORUI\|FOF_ALLOWUNDO`），实测 **130 ms** 返回（旧 PowerShell 路径同机 473 ms）；前端 `uninstallSkill`/`uninstallPet` **失败不再谎报成功**（旧代码 catch 后照旧 return success → 界面显示已删、文件夹还在、重启又被扫回来），并加 30 秒兜底超时 + 「删除中…」可见反馈 + 失败可见。④**验证**：`cargo test --lib` 42 通过（含 4 条新删除用例）；新增 `skill-uninstall-safety.test.ts` UNINST-1~5，并**换回修复前 installer 跑过 —— 4 条失败**；全量 221 文件 / 4754 用例通过 / tsc 0 错误 / 审计 0-0 / css-contract 无变化。⑤**教训**：**不要让界面等待一个"可能弹对话框"的原生调用** —— 隐藏进程 + 弹窗等待 = 没有终点的等待。 |
| v1.16.20 | 2026-09-13 | **修复：上传附件后「上下文」标签不消失 + 兼容第三方 Agent Skills（第 70 波）** — ①**用户反馈**：上传 a.md 后编辑框里出现「上下文：a.md」标签，发送后不消失、对话结束仍在。根因不是忘了清空，而是**同一份状态被手工复制成两份**（附件 `pendingAttachments` + 徽章 `contextBadges`，后者只在 textarea `onChange` 里重算）→ 四条路径全在说谎：发送后残留（用户报的）、点 × 移除附件后徽章仍声称会发送它、切换会话跨会话残留、粘贴/拖拽进来的附件不进徽章行。修复：徽章行改为从 `pendingAttachments` **派生**，删掉状态与手工同步；`component-input-area.test.tsx` 新增 ATTC-1~4，并**换回修复前组件验证过这 4 条用例确实会失败**（不是假通过）。②**AREX-Skill 集成暴露的第三方兼容缺陷**（实测上游真实 SKILL.md）：`name: "repo-skills-router"` 连引号一起注册成技能名 → `load_skill("repo-skills-router")` 查不到；跨行双引号描述被截断到第一行（vllm 描述 159 → 61 字符且带多余引号）；`description: >-` / `|` 被当成字面字符串（描述整段丢失）；正文没有 `# ` 一级标题时整份 SKILL.md 被静默丢弃。修复（`src/core/skill/skill.ts`）：字符串字段统一去引号 + 反转义；跨行双引号标量按 YAML 折行拼接；块标量 `> >- >+ \| \|- \|+` 全支持（折叠/字面 + chomping）；frontmatter 之后无一级标题的内容作为正文（无 frontmatter 的纯文本仍非法）；市场安装白名单补 `.jsonl` / `.csv`（AREX 路由器索引是 JSON Lines）。③**核对结论**：Codem 只加载技能目录一层子目录 → AREX「router + `repo-skills/<id>/` 兄弟目录」原始形状天然契合（只有 router 进技能目录，仓库根技能由路由器按需 read 展开）；`<skill_resources>` 给出技能目录绝对路径 → SKILL.md 里的相对路径可直接解析；`disable-model-invocation` 被忽略；项目根 `.codem\skills\` 只在项目管理器展示。④**文档**：新增 `docs/AREX-SKILL-INTEGRATION.md`（三种安装方式的可执行命令、实测体积 vllm 35 文件 217 KB / router 204 文件 1.6 MB、验证清单、边界）。⑤**教训**：**同一份事实存两份、其中一份靠手工同步维护，迟早会说谎**。校验：tsc 0 错误 / 220 文件 4749 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化。 |
| v1.16.19 | 2026-09-13 | **修复：上下文超限后的「白重试 + 假续写」；思考模型被输出上限掐断（第 69 波）** — 用户日志给出完整真相：`finish_reason=length — text 0 chars, tool calls 0`（思考吃光输出预算）→ 自动续写 → 之后每次请求都 400 `maximum context length is 1048576 tokens. However, you requested 1048735 tokens`，而且上下文还在变大（1048735 → 1048992 → 1049249），每轮还白重试 3 次。①**根因一**：反应式压缩的判定只认 `prompt_too_long` / `context_length_exceeded`，而 DeepSeek 的措辞是 `maximum context length is ...` → **本该救场的压缩从未触发**。②**根因二**：确定性错误被白重试（4xx 非 429 无意义），且 provider 没把 HTTP 状态挂到错误对象上，`classifyError` 也判不出来。③**根因三（我上一波引入）**：`lastFinishReason` 跨迭代不重置 → 失败轮沿用上一轮的 `length` 触发假续写，把超限上下文继续撑大。④**修复**：新增 `provider-errors.ts` 做**语义匹配**（maximum context length / context_length_exceeded / prompt too long / reduce the length of the messages / too many tokens…）并能解析上限与实际请求数字；溢出⇒**立即走压缩**不重试，压缩 3 次仍不够则停下（`context_overflow`）并给出可执行说明（数字 + 开新对话/收敛内容/换大模型）；不可重试的 4xx **立即失败**；provider 挂 `err.status` 并把错误体给足 2000 字符；**结束原因每轮重置**且记录本轮**正文长度**——「正文 0 字符」判定为「思考吃光预算」，续写提示改为「少想、直接产出」。⑤**按模型族给输出上限**（补强第 67 波）：`deepseek-flash` 在目录里查不到 → 以前落到 8192（对带思考的模型明显偏小，直接导致「正文 0 字符」）→ 现在按族推断（DeepSeek/推理系 65536、Claude 4 32000、Gemini 2.5+ 65536），未知型号仍保守兜底。⑥**教训**：**错误分类不能只匹配「自家见过的措辞」** —— 只认两个字符串，等于让一条能自动救场的路径形同虚设。校验：tsc 0 错误 / 219 文件 4729 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 OFLOW-1~7（用事故现场真实报错体做样本）。 |
| v1.16.18 | 2026-09-13 | **修复：回复被输出上限截断时「任务又中断了」（第 68 波）** — 用户说「继续之前没完成的任务」，控制台显示一轮就收尾（`Single-response dedup: 0 tool calls` → 直接 `[extractMemories]`），没有报错也没有重试。①**根因**：`finish_reason === length`（达到单次输出上限、回复被截断）此前**只用于内容型工具的提示**，从不参与「要不要停」的判断 → 被截断的纯文本回复被当成「写完了」，循环以 `completed` 收尾；而 `finish_reason` 只写在默认静默的 `debugLog` 里，控制台毫无线索。②**修复**：截断 ⇒ **自动续写**（注入「从断点继续」提示：不要重复已输出内容 / 长文件改用 `write` + `append: true` 分块 / 写完就说明），界面显示「⏩ …正在自动续写」；③**续写预算 3 次**，用完则明确停下并给出下一步（分块写入 / 调大 `maxTokens`），停止原因 `output_truncated`（结构化事件 + 用户可见说明），不再静默结束；④**结束原因进入循环状态**（provider 的 `end` 事件不向上游 yield，故写入 `LoopState.lastFinishReason`），主循环的停止判断这才看得见它；⑤**非正常结束原因默认可见**（`finish_reason` 非 stop/tool_use 时 console.warn，例如「length（达到单次输出上限，回复被截断）」）。校验：tsc 0 错误 / 218 文件 4722 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 TRUNC-1~5 与**行为测试** TRUNC-B1~B3（脚本化 provider 真跑循环）。 |
| v1.16.17 | 2026-09-13 | **输出上限按模型动态解析（被拒自动降档）+ 同类问题清查（第 67 波）** — 用户指出上一版「让用户自己去设置里调 maxTokens」不对：应该**按模型上限动态取**或**被拒时临时调整**。① 查下去发现**模型目录里本来就有**每模型的 `maxOutputTokens`（`deepseek-v4-flash` 384000 / `gpt-4o` 16384 / `moonshot-v1-8k` 4096），写死常量的后果**两头都错**：小 → 大文件参数被截断（用户遇到的报错）；大 → 请求被 API 直接拒绝。② 新增 `src/core/llm/model-output-limit.ts`：优先级 **显式配置 → 被拒后学到的值 → 模型目录值（夹在 65536 天花板）→ 兜底 8192**。③ **被 API 拒绝自动折半降档 + 进程内按模型记住 + 自动重试一次**（用户不必手调）；拒绝判定保守（仅 400/422 + 提到 max_tokens + 像值不合法/超限）。④ 顺带修掉同类硬编码：ultra 模式原本 `Math.max(config \|\| 4096, 16384)`，对上限 4096 的模型会把请求打挂 → 改为同样按模型目录夹住。⑤ **同类问题清查（静默丢数据这一族）**：`provider.ts` 的 SSE 坏行 catch 以前只 warn 就丢整行 —— 若丢的是 tool_calls 参数增量，累积 JSON 即残缺（**与截断同一现象**）→ 现在计数并在 `tool_use_end` 标注「参数可能不完整」，走拒绝执行 + 引导重试；`finish_reason=length` 且跑了内容型工具 → 追加「核对完整性 + 用 append 补齐」提示与事件 `output_truncated`；`write` 把已有非空文件写成空 → 结果里警告并带原文件大小。⑥ **已核查不是问题的**（都有明确提示）：read 截断（showing lines X-Y of Z）、落盘失败截断、上下文预算截断、终端 `[output truncated]`、附件预览、记忆压缩占位符。⑦ 另有波 66 的一条断言因本波而退役（常量不再出现于 index.ts），按新事实更新为「按模型解析」。 校验：tsc 0 错误 / 216 文件 4714 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 OUTLIM-1~7 与 SAMECLASS-1~3。 |
| v1.16.16 | 2026-09-13 | **修复：大文件写入时「工具参数被 JSON 截断」+ 一个数据安全级隐患（第 66 波）** — 用户报错：让模型生成科研绘图脚本（6–10KB），控制台反复 `SyntaxError: Unterminated string in JSON at position 6648/6348/2080`，同一个 `write` 反复失败。①**根因一：单次输出上限被写死 4096**（`index.ts` 默认值 + `processor.ts` 的 `?? 4096`）—— 6–10KB 脚本连同 JSON 转义正好在这个量级，流在字符串中间被 cap 掉，参数 JSON 天生不完整。②**根因二：解析失败的处理是「静默降级 + 正则兜底」，而**兜底更危险** —— provider 失败只打日志仍返回 `input: {}`，循环再用正则从残缺 JSON 抽 `path`/`content`，而截断时**结尾引号还没生成** → `content` 取空串 → `write` 拿**空内容**执行 → 对已存在文件就是**清空**（auto/full 模式下覆盖保护不拦）。③**修复**：新增 `DEFAULT_MAX_OUTPUT_TOKENS = 8192` 统一使用（仍可由 `codem-settings.maxTokens`/智能体/槽位覆盖），processor 未配置时不发 `max_tokens`；④**参数不可用一律拒绝执行**（新 `src/core/llm/tool-args-guard.ts`）：删掉正则兜底，改为带出原因+长度并给可操作指引（「这次没有执行；已确认/疑似被输出上限截断；请分块：先 write ≤~200 行，再用 `append: true` 追加；不要原样重发」）；⑤**`write` 支持 `append: true`**（大文件分块落点）+ `content` 非字符串直接报错（绝不用空值覆盖）；⑥**provider 不再静默降级**（带 `argsParseError`+`rawLength`）；⑦**可观测**：拒绝执行落结构化事件（`loop_stopped` + `args_truncated`）。⑧**本轮审计自查**：provider 报错但无 rawArgs 时同样会空参数执行 → 已补分支拒绝；提示补 `length` 结束原因的「已确认」；另一处残留的 4096 一并收口。校验：tsc 0 错误 / 215 文件 4704 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 ARGS-1~7。 |
| v1.16.15 | 2026-09-13 | **把「卡住」治理从止损补齐到五层：预防 / 收敛 / 止损 / 恢复 / 可见（第 65 波）** — 上一版把判据从「时钟与次数」换成「沉默与信息增益」，但仍留着两个洞：**每次输出都略有不同的空转抓不住**（内容确实变了）、**检测到之后只会停不会救**。①**L1 新增计划停滞检测**（`src/core/llm/stall-guard.ts`）：判据**与内容无关** —— 「模型没修订计划（update_plan）+ 没产出任何交付物（写入/编辑/会改盘的命令）」，连续 12 个迭代**先问**（注入聚焦问题：卡在哪/下一步/要不要改计划），再连续到 24 才停。②**审计修正**：一开始用「计划标题 + macroStep」当推进指纹，而 macroStep 是 **UI 启发式步进**（每个迭代首次出现非侦察类工具就 +1）→ 计数被不断清零、检测等于失效；改成只认**真正的计划修订**（update_plan 成功时 planRevision++）。③**审计修正**：`git status` 这类只读查询不再算「产出交付物」（否则反复查 git 的会话永远判不出停滞）。④**L3 先问再停**（恢复而非只止损）；**审计修正**：停滞检测排在「重复调用守卫停止」之后，否则两者同时成立会留下一条没有下文的「进度自查」孤儿消息。⑤**L2 修正：长工具不再被当成沉默** —— 一个跑了 10 分钟的构建期间**本来就没有事件**，原空闲看门狗会把它当卡死砍掉。按 DSH 思路拆开两种语义：**空闲**（既没事件、也没工具在跑，连续 5 分钟）与**工具挂死**（单工具在飞超过 20 分钟 `toolFlightMs`）；工具在飞期间每 30 秒心跳，既给看门狗续命**也向父会话上报进度**。⑥**资源预算修正**：原来只统计模型文本（严重低估，真正吃上下文的是工具入参/结果）→ 现在两者都计入；默认从 `0（不限）` 改为 **200k 估算 token**。⑦**L0 升级**：交接判据必须**可判定**（会存在的文件 / 反引号命令 / 可比的量），「完成判据：全部完成」这种空话会被拒；模板同步更新；校验仍会放手。⑧**L4 停止原因结构化**（`src/core/llm/loop-stop-log.ts`）：`no_gain`/`idle`/`tool_hung`/`plan_stale`(+`_ask`)/`budget` 统一写 EventLog 的 `loop_stopped`，可统计「哪种卡法最多」；并**审计发现**：因停滞停止的任务不能再当「已完成」上报给父会话（父会话会拿半成品继续走）→ 改为按失败交回并附上已产出内容。校验：tsc 0 错误 / 214 文件 4696 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 STALL-1~9、DELE-045~048 等契约。 |
| v1.16.14 | 2026-09-13 | **用「信息增益」与「沉默」替代时钟与次数（第 64 波）** — 用户质疑「15 分钟墙钟 / 3 分钟单次等待 / 8 分钟累计 / 第 10 次就停」拿时间次数做可靠性有问题；**质疑成立**（合法长任务会被误杀、还在产出的死循环拦不住、「列目录→读→再列」会被误杀）。于是去读 DSH 真实实现（`app.asar.unpacked/node_modules/@deepseek-ai/`）：①**时间只测沉默**：`dsh-timeout` 的 `idleWatchdog`（LLM 流默认 300s）定时器只在等下一个 chunk 期间存在、有进展 `pulse()` 重新上弦，文档明写「消费者思考时间不算空闲」；`<=0` = 不设上限。②**绝对截止只给单次能力调用**：`deadline`（文件 API 60s、bash/pwsh 默认 120s 上限 600s，每次可自带 + `clampTimeout` 夹住），**没有**「整轮 15 分钟」。③**agent 循环里没有迭代上限/无进展计数器/重复调用守卫** —— 它不做次数治理。④**上限是 settings**（`maxParallelToolCalls`/`maxTokens`/`streamIdleTimeoutMs`），不是魔法数字；中止全链路走 `AbortSignal`。⑤**照此重做**：新增 `src/core/session/idle-watchdog.ts`（语义对齐 DSH：pulse 重新上弦 / `<=0` 不设上限 / 错误码可取回）；后台会话**删除 15 分钟墙钟**，改为「连续 `turnIdleMs`（默认 5 分钟）没有任何事件」才中止，上限改用**资源**（`turnTokenBudget` 估算 token）；⑥**守卫判据从次数换成信息增益**：`noteResult()` 比较**结果内容**，「连续 N 次拿到已经见过的内容且期间无写操作」= 可证明的零进展，才升级提醒(2)→跳过(4)→停(6)；**结果一变就是有进展，永远不拦**（同一命令跑 30 次也不拦）；⑦**被判定零增益的只是那一个签名，换新手段一律放行**（旧版「数到 10 次就停」连正常节奏都会误杀）；枚举计数降级为纯文案提醒。⑧**委派等待按活动返回**：任务结束即返回；子会话连续无进度上报（安静了）才带进度返回；**一直在产出就一直等**；⑨三个窗口都是可配置项且写清语义来源。校验：tsc 0 错误 / 213 文件 4680 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增 `idle-watchdog.test.ts`（IDLE-1~6）与 GUARD-1~16。 |
| v1.16.13 | 2026-09-13 | **审计收尾：把「子会话卡住」变成界面上可见、可终止（第 63 波续）** — ①**任务中心（委派页签）现在显示子会话进度**：`已调用工具 N 次 · 最近：<某个工具/命令>`。第 62 波起子会话就会定期上报进度，但**界面一直没有消费** —— 等于「上报了但用户看不到」，用户仍只能看着「执行中」干等；这是同一轮审计里查出的最后一处缺口。②**运行中的委派任务多了「终止」按钮**：点击后**先掐掉子会话的后台循环**（`cancelSessionExecution`）再置任务为已取消 —— 顺序不能反，反了的话子会话的收尾回调可能把它改回「已完成」（服务端同名修复见 v1.16.12 的 `completeTask`/`failTask` 守卫）。③至此「子会话原地打转」三处都能停：**模型**（重复调用守卫自动停）、**父会话**（`cancel_delegation` 工具）、**用户**（任务中心按钮）。校验：tsc 0 错误 / 212 文件 4674 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功；新增契约 DELE-044。 |
| v1.16.12 | 2026-09-13 | **自我审计：给上一版「原地打转」修复找茬（第 63 波）** — 用户要求审计 v1.16.11 的「重复调用守卫 + 等待预算」是否治标不治本；**三轮审计查出 11 个真问题，其中 5 个是上一版自己引入的，全部修掉**。①**拦截结果曾返回 `status:"error"`** → executor 抛成 `tool_error` → 累加 `consecutiveErrors`（上限只有 3）→ 「第 7 次抑制 / 第 10 次停」**根本走不到**，循环先以「连续错误过多」停掉（理由张冠李戴）；现改 `completed`，阶梯与理由都对上。②**守卫按「会话」累积而非按「轮次」**（AgenticLoop 按会话缓存复用，重置写在了构造函数里）→ 几轮后第一次读同一个文件就被「重复调用被跳过」；现挪到 `run()` 开头。③**精确指纹整体转小写 + 截断 400 字符** → 大小写敏感文件系统上会误拦合法读取、长命令前缀相同会相撞；现只压缩空白、键保留全文。④**精确重复没有「停」档** → 抑制只是不给执行，模型可原样再叫，而每次被抑制的调用仍走一遍工具事件 → 无进展阀门不触发 → **抑制变成新的死循环**；现精确档也有停档（第 8 次）。⑤**被拦下的调用仍算「有效工具调用」** → 从有效调用数里扣掉。⑥**取消会被悄悄改回「已完成」**（取消是异步的，子会话收尾时 `completeTask`/`failTask` 无条件覆盖状态）→ 现不再覆盖 `cancelled`，executor 被 abort 时也不上报完成。⑦**等待不阻塞后出现新的空转路径**（总预算用完每次查看都是秒回 → 「查一下再查一下」）→ 同一任务一轮最多查看 3 次，超过即抑制并要求「报告或取消」。⑧**交接校验不能把功能锁死** → 连续被拒 2 次后放宽放行，并给接收方注入兜底提示：缺信息就报告缺什么、不要靠反复枚举去猜。⑨**守卫抢了更友好的缓存回复** → `read`/`write`/`wait_for_delegation` 交回各自缓存，守卫只管其余工具；枚举历史的清零判据也从「指纹是否见过」改成**按分类**（否则事故里 17 条不同开关的命令会把计数一路清零、永远抓不到打转）。⑩**治本的另一半**：新增 `src/core/session/handover.ts`（交接协议 + 机械校验：缺产物绝对路径/具体目标、缺完成判据、超 12000 字 → 拒绝并给模板；超 4000 字 → 放行+提醒），`delegate_to_session` 接上校验，新增 **`cancel_delegation`** 工具（父会话能终止打转的子会话，而不是只能干等），系统提示词新增「Writing a Handover」模板章节，等待再加**累计**预算（默认 8 分钟，用完后只查看不阻塞）。⑪**审计方法**：先怀疑仪器（上一波的 12 个「发现」全是仪器坏了）→ 把自己的修复当别人的代码再审（重点查**新的循环路径**、**状态覆盖关系**、**误杀面**）→ **每条阈值都要对上现实机制**（「第 7 次抑制」走不到，就是因为阈值在守卫里、机制在 executor 里）。校验：tsc 0 错误 / 212 文件 4673 用例通过 / 审计 25 条规则 0/0 / css-contract 无变化 / 打包成功。 |
| v1.16.11 | 2026-09-13 | **第 62 波：修复智能体「原地打转」与交接「黑等」+ 第 61 波：死字段排查** — 【第 62 波 · 用户报：交接出去的新会话一直在跑、原对话等待超时、十几分钟没结果】①**现象**（用户控制台日志）：父会话 `delegate_to_session` 后 `wait_for_delegation` 阻塞；子会话读完工交接文件后**连续三十多次执行几乎一样的目录枚举**，只换 `-Force`/`-LiteralPath`/`Out-String -Width 200`/`Sort-Object` 这些装饰性开关，在两个目录之间来回打转，直到超时。②**为什么两道阀门都拦不住**：「连续无进展」的判据是 `iterationHadText \|\| toolCallsInIteration > 0` —— **每次枚举都成功返回了内容**，计数器每轮被清零，`MAX_CONSECUTIVE_NO_PROGRESS = 30` 永远到不了；同轮次去重只覆盖 `read`（同 path+range）与 `wait_for_delegation`（同 task_id），**bash 换个写法就绕过去了**。③**新增重复调用守卫** `src/core/llm/loop-guard.ts`（纯状态机，可单测）：**精确指纹**（工具 + 归一化参数）第 3 次提醒 / 第 5 次抑制；**意图指纹**（只读目录枚举按目标路径归并、忽略装饰性开关、会话 cwd 参与指纹）第 4 次提醒 / 第 7 次抑制 / **第 10 次直接停整个循环**并给出三条出路（读已知文件 / 直接报告「未找到 + 已试路径」 / 说明需要什么）；写操作重置计数；认不出的命令只走精确指纹（宁可漏判不误杀）。④**`wait_for_delegation` 不再无限期阻塞**：单次等待 3 分钟预算，到点**带进度返回**（已跑多久 / 工具调用次数 / 最近一次工具 / 子会话最新输出 + 三个可选动作）；后台/委派会话另加 15 分钟**墙钟上限**，到点按「**部分完成**」把已产出一并交回（原实现把打转十几分钟当**正常结束**回传）。⑤**修好一处「看不见证据」的日志**：`Single-response dedup` 原先只打印 `task_id` / `path`，于是 bash 一律显示成 `bash("")` —— 恰在最需要看命令的时候看不见命令；现在带出命令本身（截断）。⑥**测试用事故现场的原话**：`GUARD-1/2` 直接以日志里那 **17 条真实命令**为样本，要求全部识别为只读枚举、且塌缩成**两个**意图指纹。⑦【第 61 波 · 死字段】`codem-display-mode` **只写不读**（设置页能改、值也真进了库，但没人读回来，重启回默认）→ 启动时读回并应用；`codem-current-project-path` **无写入方** → codegraph「索引检测」恒为空串，改读项目 store；两处 `getSetting(键, 默认值)` **多传参数被静默忽略**（那两个文件带 `@ts-nocheck`，类型检查拦不住）；`defaultSettings` 的 `theme` / `mimoPath` / `autoApprove` 零读取方已删（`theme: "dark"` 还与 `DEFAULT_THEME = "light"` 矛盾）；删 7 个死 CSS 令牌（22 行定义）+ 新增审计规则 `css-var-unused`。⑧**新增两道门禁**：`settings-keys-symmetry.test.ts`（SKEY-0~4：每个设置键必须**既有写入方又有读取方**，扫 810 文件 / 251 调用点 / **70 键**；检测器自身第一版报的 12 个键**全是仪器坏了** —— 事件名/前缀判断被当成键、读取别名 `settings(...)` 被当成写入、6 个模块同名 `SETTINGS_KEY` 串味、泛型组贪婪吞掉调用点，四种形状现已钉成 `SKEY-0` 断言）与 `settings-effect.test.ts`（锁住「读到的值真被用上」）。⑨**遗留（需产品决定）**：`codem-figma-token` 只读且**没有设置界面**、而 `figma-fetch.ts` 却让用户「去设置里配」；9 个皮肤令牌由 JS 注入但 CSS 从未消费；`ConversationComposer/Session.tsx` 零引用却是 3 个插槽的唯一消费者；**262 个文件带 `@ts-nocheck`**。校验：tsc 0 错误 / **211 文件 4650 用例通过** / 审计 25 条规则 0/0 / CSS 生效取值快照（2743 类）无变化 / 打包成功。 |
| v1.16.10 | 2026-09-11 | **修复：启动时先闪一下「相反的主题」（第 60 波）** — ①用户报的老问题：暗色主题启动先白后暗、浅色先黑后亮，偶尔还「黑→亮→黑」三段跳。②**三个现象一个根因**：主题有真相源（DB `codem-theme`）与首屏镜像（localStorage `codem-theme-cache`）两份但**从不校准**，而 `TitleBar` 的主题初值写的是「DB → **默认档**」——启动早期 DB 未就绪 → 挂载时用默认档**覆盖**了 `index.html` 预渲染好的档位（`data-theme` 抖动），**并把镜像也改成默认档**（镜像因此长期停在错档 → **每次启动都闪**），DB 就绪后再改回真实档 → 就是那三段跳。③**修复**：`theme-default.ts` 新增 `resolveEffectiveTheme(readSetting)`＝**DB（就绪后）→ 镜像（首屏预测）→ 默认档**，启动路径（TitleBar / SkinSelector / ThemeManager ×2）全部改用它；`applyThemeAttribute` 改为**幂等**（档位没变不碰 DOM、不重写镜像，只补一次缺失镜像）。④顺带补首屏画布底色 `html:not(.pet-window-mode){background-color:var(--bg-primary)}`（此前 html/body/#root 全透明 + 窗口 transparent:true，首帧底色只能靠浏览器默认）。⑤**实测**（无头浏览器 + 源码 CSS）：镜像暗 → 画布与启动页均 `rgb(14,15,15)`；镜像浅 → `rgb(252,252,251)`；无镜像 → 默认档浅色。⑥新增 `theme-boot.test.ts` 8 条契约（优先级、幂等、复现用户场景、真执行 index.html 内联脚本、启动路径源码不得拼默认档、首屏画布规则 + 2 条真浏览器首帧断言）；反验：改回旧写法立刻变红。⑦说明：升级后**第一次**启动仍可能切换一次（旧版写坏的镜像要等 DB 就绪才能纠正），之后不再闪。校验：tsc 0 错误 / 208 文件 4624 用例通过 / 审计 24 条规则 0/0 / 打包成功。 |
| v1.16.9 | 2026-09-11 | **光标看不清（用户报）+ 控制台噪声治理（第 58/59 波）** — ①用户报「默认皮肤暗色下，对话编辑区打字时光标是紫的、在深底上看不清」：光标用的是品牌紫 `--accent`（暗色 `#7c6cf0`），落在近黑背景上对比度仅 **4.33:1**，而同一处正文是 **11.67:1** —— 1px 闪烁竖线只有文字 1/3 的可见度。修法：新增 `--caret-color: var(--text-primary)` 令牌并让编辑区光标走它（皮肤可覆盖）→ 暗色 **11.67:1**、浅色 **16.50:1**，与旁边文字一致。②用户贴出运行日志问「后台控制台报警告」：逐行分类后**真正的 warn 只有一条** —— `[AgenticLoop] Service "snapshot" not available, falling back to singleton`，**每次工具调用打两遍**（一次 `write` 打两条、带调用栈）；根因是快照服务本就按 cwd 单例（`getSnapshotService(cwd)`，文件面板与测试都这么取），**没有任何 Provider 注册过 `ctx.provide('snapshot')`** → `ctx.get('snapshot')` 必然落空。修法：这一处不再走 ctx。③其余 7 处回退告警改为 `warnOnce`（回退是设计好的容错，值得知道一次而非每次）。④新增 `src/core/debug.ts`：13 条热路径诊断日志改为 `debugLog(ns, …)` 默认静默（`localStorage.setItem('codem-debug','agent-loop,provider')` 或 `window.__CODEM_DEBUG__` 开启）；收口清单含 `Iteration N: calling LLM`／`buildMessages raw`／`[Provider] stream:`／**`[Provider] Tool call end:`（原来会把工具参数含文件内容打进控制台）**／`[AutoSave] Debounce save`；**所有 console.error 与真信号保持不变**。⑤新增 `console-noise.test.ts`（LOG-1~5）与 CSS-INTEGRITY-8（光标必须跟随正文色、对比度 ≥7:1，按令牌实算）。校验：tsc 0 错误 / 207 文件 4616 用例通过 / 审计 24 条规则 0/0 / 打包成功。 |
| v1.16.8 | 2026-09-11 | **修复：工具行没撑开/没靠右（用户报）+ 打开设置后全部文字变大（第 56/57 波）** — ①用户报「右侧栏【文件】的【筛选文件】搜索框里【刷新】按钮没居右、右边空了一片」：`.file-explorer-search-bar` 是 `repeat(3, max-content)` 的三列网格，而输入框上写着 `flex: 1` —— **flex 在 grid 容器里完全无效**，三列全按内容宽度排 → 整行靠左、右侧留白（实测 724px 宽的行里按钮距右边缘 **527px**）。②**同类排查出 4 处**（用户未遇到）：`.video-controls`（进度条卡 129px、右空 485px）、`.notebook-manager-toolbar`（搜索框卡 194px、空 444px）、`.mcp-catalog-actions`（提示卡 220px、空 424px，320px 窄卡片下整行溢出）、`.mm-footer`（保存按钮的 `margin-left:auto` **在 grid 里不吸收行尾空白**、空 616px）。③**修复**：这 5 处改为 flex（子元素原有 `flex: 1` 立即生效）+ 工具行允许换行 + 提示文本 `min-width:0` + 省略号。④**新增门禁 LAYOUT-10**（真实渲染）：7 种宽度下断言「可伸缩元素占行宽 ≥25%」「未换行时行尾控件贴右（≤2px）」「不溢出」——修复前 35 个测量点全不合格、修复后 0 个。⑤**另一处修复**：点开「设置」后主页文字突然放大 **+7.7%** 且关掉设置不回退 —— 界面字号存**两个键**且默认值不同（启动读旧扁平键 `codem-font-size`→基准 13px，设置页读 `codem-settings.fontSize`→默认 14）；现收敛为单一解析器（旧键=显式选择 → 设置对象值 → 基准 13），应用点统一为「DB 就绪后 + 侧栏挂载 + 设置页打开/拖动」，兼容期内把"14 且无滑杆记录"视为未设置归一为 13。⑥新增 `ui-font-scale.test.ts` 6 条契约；顺带修掉无头浏览器冷启动导致的测试偶发超时。校验：tsc 0 错误 / 206 文件 4610 用例通过 / 审计 24 条规则 0/0 / 打包成功。 |
| v1.16.7 | 2026-09-11 | **修复：设置里的选项标签被压成竖排 / 性能面板页签变形（第 55 波）** — ①用户报两处：设置→「通用」的「我是什么 / 什么风格」选项按钮变成**竖着的一条**（4 字排 4 行、按钮仅 42px 宽），性能面板【总览】【会话】【时延】被压变形。**同一病根**：第 42 波把 `flex-wrap: wrap` 的标签墙改成 `repeat(auto-fill, minmax(<32/40px>, max-content))` —— **auto-fill 空轨道不折叠**，轨道数按最小轨道排满一行，文字芯片被塞进 32/40px 轨道 → 中文逐字换行（1200px 宽下也一样）；第 51 波又把包括 `.perf-tabs` 在内的按钮行统一成 `nowrap`，放不下时压缩子元素而不是换行。②**修复 17 个标签墙/工具行**（12 个是排查出的、用户还没遇到的）：恢复 `display:flex; flex-wrap:wrap` + 给 11 类文字芯片补 `white-space: nowrap`。③**性能面板重设计**：页签行/控件行/数据行改为可换行，`.perf-type-name` 从 `min-width:200px` 改可压缩+省略号，内容区横向也给 `overflow:auto` 兜底（宁可滑动也不溢出看不到）。④**新增真实渲染门禁**：无头 Edge 渲染 17 个容器 × 9 种宽度，用 `Range.getClientRects()` 数真实文字行数，判定"短标签不得 ≥3 行"与"不得溢出"，153 个测量点全部正常。⑤**新增静态门禁**：禁止最小轨道 <64px 的 auto-fill 网格（本次事故写法）。⑥反验：修复前 55 处异常 / 10 个容器中招 → 修复后 0 处。⑦教训：上一轮为对齐"grid 处数"指标改标签墙是**把指标当目标**；标签墙的正确原语是 `flex-wrap`。校验：tsc 0 错误 / 205 文件 4603 用例通过 / 审计 24 条规则 0/0 / 打包成功。 |
| v1.16.6 | 2026-09-11 | **紧急修复：设置窗口塌成 160px 窄缝（用户报「设置窗口很狭长的一条，内容都看不到」）+ 补两道「生效取值」门禁（第 54 波）** — ①根因：`codem-ui.css` 里残留悬空的 `.settings-panel,`（第 51 波跨文件合并脚本残骸，后接 `.settings-sidebar {`）→ 选择器列表变成 `.settings-panel, .settings-sidebar`，**弹窗继承侧栏的 `width:160px` / 纵向 flex / 毛玻璃底**，内容区只剩 40px。②为何一路绿灯：那是**合法 CSS**，打包不报错；`tsc` 看不见样式；`css-class-duplicate`/`cross-file` 只比单类选择器（列表整条跳过）；`css-integrity` 只看语法；已有契约测试只看个别属性 —— **没有任何门禁在看"生效取值/真实几何"**。③顺带查出同源回归：第 51 波把两个 `font-weight` 组并成一条，**区块标题 620 被降成 560**（破坏字重层次），已拆回两档并逐类核对与合并前一致。④新增门禁 A「真实布局契约」：无头 Edge 加载 fixture（引用源码 CSS、加载顺序同应用，无需构建），13 种可用区域下断言弹窗 ≥480px、内容区 ≥320px、宽屏等于设计宽 760px、窄屏整宽（无 Edge 自动跳过）。⑤新增门禁 B「CSS 生效取值快照」（`css-contract.mjs` + 2743 个类）：取值变化即红，须显式 `--write` 更新（diff 里写清改了什么）。⑥新增「外壳类不得与兄弟部件同规则」静态检查（本次事故签名）。⑦两条门禁均已反验会红（注入事故 → 精确报出 `width: 760px → 160px`）。⑧实测：1920×1080 / 1366×768 / 1280×720 / 1024×600（矮窗）/ 800×600（窄屏）下弹窗均正常，竖向不足时可滚动。校验：tsc 0 错误 / 205 文件 4600 用例通过 / 审计 24 条规则 0/0 / 打包成功。 |
| v1.16.5 | 2026-09-11 | **修复：「分层配置管理」弹窗后半页签点不到 + 界面图标继续收口（第 53 波）** — ①用户报「另一个右侧边栏（文件/浏览器）标签区有滚动条」：`.right-sidebar-tabs` 在两个基础样式表里各写一遍（`overflow-x: auto` + `flex-wrap: wrap`）→ 两个属性同时生效，已合并成一处权威定义。②**排查同类问题时挖出更严重的实例**：`.config-tabs`（「分层配置管理」弹窗）有 **7 个页签**而弹窗只有 560px 宽，第 51 波改成 `nowrap + overflow: hidden` 后**后半页签直接消失、点不到** —— 改为允许换行（高度自适应永不裁切）+ 标签省略号。③**ConfigEditor 整个组件从未迁到图标体系**：标题/关闭/7 个页签/层级按钮/结构清单/保存按钮共 11 处 emoji + 文字 ✕，全部换 lucide + `ActionIcons.close`（`ActionIcons` 补 `save`）。④**13 处「文字 ✕」按钮换图标**，其中 4 处实为**删除**动作（环境脚本行/恢复会话/幻灯片/列表项）改用垃圾桶 + 统一补 `aria-label`；AudioPlayer 内联样式收口成 `.audio-player-close`。⑤AgentPanel 状态图标改 `StatusIcons`。⑥**门禁从「逐文件白名单」改成「全仓库扫描 + 显式豁免」**（ICON-062~065，含"迁移文件必须真的引用图标集"的产物校验）+ 两条 CSS 布局契约（CSS-INTEGRITY-5/6：`nowrap + overflow:hidden` 必须逐个说明理由、`.config-tabs` 必须能换行）。⑦盘点出剩余 16 个组件仍以 emoji 当图标（多为 `✅/❌` 结果文案，属内容），已列清单留给下一轮。校验：tsc 0 错误 / 204 文件 4593 用例通过 / 审计 24 条规则 0/0。 |
| v1.16.4 | 2026-09-10 | **修复：上一轮「跨文件去重」脚本留下的三处 CSS 残骸 + 编码损坏门禁（第 52 波）** — 上一轮用脚本批量合并"同一个类在两个基础样式表里各写一遍"时按字节偏移删块，把相邻代码一起吃掉了三处，而 `tsc`、4581 条单测、UI 审计全是绿的，**只有打包时的 postcss 才报错**。①`codem-ui.css` 的标题栏按钮选择器行被吃掉只剩裸声明（其重复的 hover 用深色半透明变量，**浅色主题下按钮悬停会发黑**，现由 `styles.css` 权威接管）；②`styles.css` 的 `@media (prefers-reduced-motion: reduce)` 浮层减动效块**声明体整块消失**，只剩 15 个逗号结尾的选择器 —— **「减少动效」对 15 个浮层全部失效**且页面照常渲染、极其隐蔽；③`ppt-editor.css` 的放映模式规则同样只剩裸声明。另外全量扫出 **3 个样式表 87 处 U+FFFD 编码损坏**（注释里的中文被截断，页面无影响），已按 git 干净版本逐行还原并归一换行符。**加固**：新增 `src/test/css-integrity.test.ts`（不依赖 postcss 的花括号深度/选择器形态校验，4 个坏样本验证会红、4 个合法写法验证零误报）；UI 门禁新增 `encoding-replacement-char`（23 → 24 条）；修正 `css-class-cross-file` 把条件覆盖块误判为静默覆盖的假阳性（并用注入探针反验仍能抓到真实冲突）；用 `lost-declarations`/`verify-merges` 逐属性复核上一轮 11 个跨文件合并类**无静默丢失**。校验：tsc 0 错误 / 204 文件 4586 用例通过 / 打包成功 / 审计 24 条规则 error 0 warn 0。 |
| v1.16.3 | 2026-09-10 | **修复：右侧面板标签行只显示前两个 + 无会话时两个按钮应禁用** — ①右侧面板（Git/文件/变更/工作台/CI·CD）标签容器原是 `repeat(2, max-content)` **固定两列网格**，五个标签排成三行、容器 38px 高又不滚动 → 后两行被裁掉（只看得见 Git/文件）；改成**不换行的 flex 行**，宽度不足时文字省略号。②刚打开应用停在主页时「搜索」「临时会话」无处可施 → 用原生 `disabled` 禁用（鼠标/键盘/读屏同时失效）+ 标题说明原因 + 复位悬停反馈；会话消失时把两个面板一并收起。两处是同一个错误（把"容器排列"和"元素内部排列"混用同一套网格模板）；新增 `panel-sidebar-tabs.test.ts` 与 InputArea 的相应契约断言。 |
| v1.16.2 | 2026-09-10 | **修复：对话编辑器底部工具行被折成三行** — 现象是 `【＋】` / `【执行模式】【安全策略】` / `【搜索】【临时会话】` 各占一行。根因：上一轮把一批"标签墙"（flex-wrap）改成 `repeat(auto-fill, minmax(…, max-content))` 网格时顺手把工具行也改了，而 auto-fill 的列数由"容器宽度 ÷ 最小列宽"推出，带文字的 chip 远比 40px 宽 → 轨道撑大、后面的 chip 被挤到下一行。修法：工具行改回**不换行的 flex 行**（flex-wrap: nowrap），图标型按钮固定尺寸、带文字 chip 允许压缩到省略号，行内焦点改走内嵌环（整行 overflow: hidden 会裁外扩环）；新增 CSS 契约测试断言"工具行必须一行放完"。 |
| v1.16.1 | 2026-09-10 | **修复三处界面问题** — ①**顶部状态栏中段拖不动窗口**：上一版把拖拽交给专用拖拽区时顺手把 `.titlebar` 整组容器抬到拖拽区之上，而左右两组都是 `flex: 1` 会撑满中段，于是"执行模型按钮右边那段空白"被容器盖住；现在只抬真正可交互的元素，容器保持静态。②**右侧栏（Git/文件/变更/工作台/CI·CD）标签区出现滚动条**：按钮区不该滚动 —— 面板宽度 420 → 520px（`--panel-sidebar-width`），标签栏改 `overflow: hidden` + 按钮可压缩 + 文字省略。③**左侧栏「项目 → 更多操作」菜单是 emoji 图标**：图标藏在 i18n 文案里（"📌 置顶项目"…），现在文案去 emoji、菜单项改「线性图标 + 文字」两列、"移除项目"用错误色。顺带清掉同类 emoji：子智能体类型图标、必需工具锁形标记与说明文案、清理过程文件按钮、仅移除项目按钮；新增 ICON-053~055 三条测试锁住。 |
| v1.16.0 | 2026-09-10 | **UI 设计体系统一（第 1–44 波）** — ①**默认主题改为浅色暖中性**（画布 `#fcfcfb` / 卡片 `#f5f5f3` / 文字 `#1f1f1e` / 线 12%·7% 黑），`:root` 即默认档、暗色改为显式覆盖，两档令牌完全对称（此前浅色只覆盖 49/76 个令牌），并加首屏镜像脚本消除启动闪烁；②**新增应用级菜单栏**（文件 / 视图 / 帮助，`role="menubar"` + `aria-*` + 完整键盘可达 + 8 条行为测试，只放真实可用的命令）；③**窗口外壳对齐参考实现**：`--chrome-height` 44px、标签条两端渐隐、**专用拖拽区 + 左右安全区令牌**（不再整条可拖 + 逐个 no-drag）、标签条"新建对话"按钮；④**尺度与细节校正**：字重细档令牌（自带字体经 `fvar` 核验是可变字体 `wght` 200–700）、控件高度 26/30/34/38/44、圆角阶梯修正为严格单调（xs4/sm6/8/md10/lg14/xl20，此前 `--radius-xs` 竟比 `--radius-sm` 大）、149 处离刻度图标尺寸吸附回八级、字体栈 31 种写法收敛为 `--font-ui/--font-mono/--font-display`；⑤**可访问性**：清掉 21 处 `:focus { outline:none }` 与 14 处内联 `outline:'none'`（键盘焦点曾完全不可见）、57 条循环动画全部显式关停、新增 `useReducedMotion` 让 rAF 动画也尊重系统偏好、文件树条目与图谱节点从"键盘到不了"改为可聚焦；⑥**对齐原语**：`display: grid` 50 → 302 处、`:has()` 父级状态 7 → 41 处、标签/选项墙改 auto-fill 网格；⑦**门禁从 9 条扩到 22 条**（z-index / 重复类 / 间距 / 圆角 / 图标尺寸 / 字体栈 / 焦点抑制 / 减动效覆盖 / 死类名 …），error 0 / warn 0，并新增版本号一致性测试；⑧**死代码清理**：删除 223 条从未被使用的 CSS 规则（未使用类名 258 → 110）。 |
| v1.15.0 | 2026-09-10 | **任务管理再收敛：场景归「子智能体」+ 角色只绑定团队/子智能体** — ①**概览不再重复活动**：只留四张统计卡 + 「活动与用量」入口（直达「看板 → 用量 / 时间线」），插件禁用时回退宿主活动预览。②**场景 + 设置移到「子智能体」页签**：新扩展点 `task-center.subagents`，插件 `LibraryOpsSceneView`（场景 | 设置），禁用时回退宿主列表；「看板」收敛为 看板/用量/工具/错误/时间线；新增 `requestView()` 统一跨页签跳转；`Ctrl+Cmd+Shift+L` 改开「子智能体 → 场景」；两页签加宽 1180px。③**角色绑定**：队长（当前会话 + 各运行时团队队长）+ 团队成员 + 子智能体（有/无团队）+ 仅在途委派的目标会话；闲置会话与模板角色不再入馆 ⇒ 无团队/无子智能体/无在途委派时只有队长待命。测试：LO-UI 看板 5 视图/场景 2 视图、LO-TASK 双 slot、LO-ADP-1/1b/1c/4/13、LO-REAL-3/3b/3c。全量 196 文件 / 4538 用例通过（+15 跳过）|
| v1.15.2 | 2026-09-10 | **修复：「看板 → 时间线」为空** — 根因是事件来源太窄：`buildEvents` 只把工具调用/团队任务/角色焦点/宿主遥测变成事件，**对话消息不算事件**，于是只问答不调工具的会话时间线恒为空。①对话消息也进时间线（最近 30 条：用户发言 → `session`/active、助手回复 → `session`/ok、失败消息 → `error`/bad；空正文与纯工具调用消息不重复出条目）；②`TimelinePanel` 空态改为**自解释**（`.lo-diag` 列出会话/消息/工具调用/子智能体/运行时团队/遥测事件六项计数 + `sources.failed` + 事件来源说明；类别筛选下为空时文案区分）；③预览夹具事件数 4 → 60（线上上限 120），长列表裁切/滚动纳入版面审计。新增 `library-ops-events.test.tsx` LO-EVT-1~5。全量 199 文件 / 4554 用例通过（+15 跳过）|
| v1.15.1 | 2026-09-10 | **修复：任务管理「概览」没有滚动条** — 内容区 `overflow` 原先绑在 `wide`（面板宽度）上（`wide ? "hidden" : "auto"`），v1.15.0 把概览加入 `wide` 后它被 `hidden` 裁掉、下面的用量面板看不到。现拆成两个判断：`wide = board\|subagents\|overview`（宽度）、`fillsViewport = board\|subagents`（滚动归属，只有插件外壳 `.lo-task` 自管滚动的两个页签才 hidden），内容区按后者决定 `overflow`，并加 `data-task-center-content="<tab>"` 便于断言排查；新增 DEDUP-7（源码契约）/ DEDUP-8（真实渲染）回归用例。全量 198 文件 / 4549 用例通过（+15 跳过）|
| v1.15.0 | 2026-09-10 | **任务管理再收敛：用量迁进概览 + 场景归「子智能体」+ 结构树去重** — ①**P0 修复**：视图外壳漏导入 `styles/library-ops.css` → 看板/子智能体整片无样式、不自适应；改为外壳统一导入 + 新增样式入口守卫测试，版面审计新增 `stylesApplied` 断言（样式未生效即失败）并按宿主位置分别跑（board/scene/概览用量嵌入）。②**「用量」迁移进「概览」**：新 slot `task-center.overview` 承载 OverviewPanel+CostPanel，**看板里的用量视图删除**（原先是指回去的引用卡片）；用量块自带 `.lo-embed` 容器查询上下文与采样，不渲染 `.lo-task`。③场景+设置归「子智能体」页签（`task-center.subagents`：场景\|设置），看板收敛为 看板\|工具\|错误\|时间线；跨页签跳转统一 `requestView()`。④场景角色只绑定队长（当前会话+各运行时团队队长）/团队成员/子智能体（有/无团队）/仅在途委派会话；闲置会话与模板角色不再入馆。⑤**新增 `docs/TASK-CENTER-MAP.md`**（8 页签 + 3 接管点功能结构树到最小叶子 + 25 项重叠判定），本版修掉 13 项：定位死按钮、父会话下钻断链（`codem:open-session`）、概览 token/成本重复三遍、概览手写事件列表改复用 `EventList`、Issue 状态元数据 5 份合并为 `issue-status-meta.ts`（自动化补齐 backlog/todo）、采样双轮询合并为引用计数定时器、`SquadsTab` 跟随项目重查、底栏委派限制读 `getLimits()`、删死代码 `DelegationPanel.tsx` 与重复时钟函数。全量 198 文件 / 4547 用例通过（+15 跳过）|
| v1.14.1 | 2026-09-10 | **修复：看板子视图被「实时事件」挤占/遮挡** — ①「看板」子视图默认不渲染右侧实时事件流（状态条新增开关可临时打开，`aria-pressed` 可访问），其它监控视图不变；②新增 `.lo-board-host` 包裹宿主 `IssueBoard`（`flex:1 1 auto` + `min-height:0`），看板正好填满内容区高度、横向滚动条不再落到折叠线以下；宿主列最小宽度改走 `--issue-col-min` 变量（默认 180px，插件内 128px）→ 宽面板 7 列一屏排完；③**补齐审计漏检**：`tools/preview` 改为渲染真实 `LibraryOpsBoardView`（导航栏 + 事件流）并把宿主 `IssueBoard` 真组件纳入审计（新增 `issue-stub.ts` / `store-stub.ts`），预览同时加载宿主全局样式 `src/styles.css` 以对齐 `box-sizing`，子视图审计 6 → **7 个（含看板）**，新增 `tools/preview/probe-layout.mjs` 版面探针与 `?audit=1&view=<视图>` 定点检查。全量 196 文件 / 4534 用例通过（+15 跳过）+ 版面审计 7 宽度 × 7 视图全 0 |
| v1.14.0 | 2026-09-10 | **图书馆并入「看板」+ 场景图可上传/自动对位 + 界面自适应与图标统一** — ①**并入看板**：图书馆场景的初衷即「谁在做什么、在哪做」的可视化看板，与宿主「看板」页签（Issues 状态列）合并为一个页签 —— 看板为默认视图，插件追加 场景/用量（合并原「成本」）/工具/错误/时间线/设置；去掉与任务管理重复的「总览/团队/会话」入口；宿主新增 `task-center.board` slot（`BoardTab` = `SlotBridge` + `IssueBoard` 回退），插件禁用即回退自带看板；删除独立面板/悬浮入口/store 的 open 状态。②**场景图可上传**：设置 →「场景图片」拖拽或选择上传，Blob 存 IndexedDB，`build-library-ops-scene-preset.mjs` 可做内置预设。③**自动对位**：`core/scene-align.ts` 用「地面掩码 vs 房间掩码 IoU 粗到细搜索」自动求缩放/位移 + 置信度，上传后自动应用，仍可手动微调。④**界面自适应**：容器查询按面板实际宽度分档、子视图自然高度 + 内容区滚动、固定值换 `minmax/clamp`；新增 `tools/preview/audit-layout.mjs`（7 种窗口宽度逐视图检查裁切/重叠）。⑤**图标/样式统一**：emoji → lucide-react（`icons.tsx`，49 语义名），卡片/标签对齐宿主 `.card`/`.badge`。⑥**修复**：dev 白屏 `process is not defined`（dev-only polyfill）、Vite 监听 `*.tmpdir` EBUSY、子视图固定高度挤压重叠。⑦**任务管理全量审计 15 项**：P0 子智能体列表恒空（render 里 `require()`）；P1 事件只认 teams 页签 / 子智能体点不开父会话 / 看板拖拽与同列误写库 / 看板缺 `blocked`+`cancelled` 列 / 看板无法滚动 / 委派统计与列表口径不一致 / 面板打开期间不跟随页签；P2 自动化「停止所有」无法恢复 / Issues 筛选缺 backlog+cancelled / 收件箱徽标与点击穿透 / **无项目跨项目串数据**（新增 `use-current-project.ts`）/ `IssueCard` hover 覆盖状态条 / 详情面板切换不刷新；新增 `task-center-audit-fixes.test.tsx` 12 例。⑧**二次去重**：概览只留最近 5 条 + 「查看完整时间线」入口、场景标注为可视化表达、自动化唯一入口、删除插件元数据旧按钮 id。**第二轮独立复审 14 项**（P1 工具路径项目边界 + 非法 status 崩溃；P2 详情面板假评论 / 自动化暂停状态 / cron 步长为零 / 概览统计口径 / 委派历史恢复 / 切项目重查 / single 槽位优先级；P3 时间线深链 / 新建被筛选藏起来 / N+1 查询 / 收件箱裁剪）全部修复，新增 `task-center-audit-fixes-2.test.tsx` 14 例。全量 196 文件 / 4533 用例通过（+15 跳过）|
| v1.13.0 | 2026-09-10 | **图书馆插件集成手绘像素美术 + 监控面板对标 lobster-pet** — ①**像素图书馆场景（默认）**：直接使用 ClawLibrary 的 `scene-floor`/`scene-objects`（2752×1536 手绘像素画）+ `walkGraph`（20 节点）+ 12 资源分区坐标；角色用其 Capy-Claw / Cat-Claw 精灵表（128×128 帧 @6fps，各 12 动作），按 id 稳定分配变体；11 种工作状态 → 上游动作（walk/idea/read/work/rest/coffee/error/sleep…）；相机缩放平移定位；资源缺失降级到等距矢量。②**资源管道与许可**：`scripts/sync-library-ops-assets.mjs`（PNG→WebP 30.1MB→5.1MB + 每源 SOURCE.md + 复制 LICENSE）+ `docs/ASSET-LICENSES.md` + THIRD_PARTY_NOTICES 条目 + 设置页「美术资源许可」卡；刻意排除 LimeZu 派生素材；**仅限非商业**，商用切等距矢量或替换资源。③**面板对标**：总览页改为 lobster-pet `DetailPanel` 单屏卡片网格，**图书馆作为监控界面内的一张卡**嵌入。④修复：两套场景引擎共享 store 槽位崩溃（双槽位）/ 上游 4 个房间 workZone 锚点越界（夹回房间）。新增 2 测试文件 / 18 用例。全量 186 文件 / 4432 用例通过 |
| v1.12.0 | 2026-09-10 | **图书馆运营监控插件（@codem/ui-library-ops，完全独立可启停）+ 四轮全面审计修复 28 项** — 团队角色/子智能体 → 各自不同的动画角色（12×4×5×6×6×4=34560 种外观，id 确定性生成，岗位影响头饰/道具）在图书馆的 10 个职能岗位工作（按角色标签关键词自动分配 + 寻路 + 工位槽位 + 11 种工作动画，由真实工具调用/任务状态驱动）；监控界面对标 lobster-pet（9 页签：总览/图书馆/团队/会话/工具/成本/错误/时间线/设置），数据只读（会话/团队/子智能体/模板/工具/成本/遥测），App.tsx 零改动（挂 `app.overlay`），禁用即不装配、面板关闭即停止采样；皮肤契约零硬编码色值。**审计修复 28 项**（P0 8 / P1 11 / P2 9），含宿主 Bug：agent-teams 成员完成任务后状态永不回落 `working`（新增 `releaseAssigneeIfIdle()`）；等距几何双重偏移致区域高亮整体放大错位；活跃会话 Map 判定失效；气泡/动画态不随场景更新；`done` 动画永久定格；角色站到岗位外；道具转向换手等。新增 9 个测试文件 / 100 用例（含真实服务联动 8 例 + 渲染几何 7 例）+ `tools/preview/` DOM 审计脚本。全量 184 文件 / 4414 用例通过 |
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
| v1.11.0 | 2026-09-08 | **团队体系深合并（B）+ 智能体双维度面板 + 审计修复** — ①Squad 升级为团队模板（TeamTemplate/toTeamTemplate），`squad_dispatch` 桥接 agent-teams 运行时（按模板建队：队长=会话/角色 spawn 成员/任务入共享池调度），`squad_status`=模板+运行时摘要；TaskCenter `squads`→`teams`（TeamTab：模板+运行时活动同视图），对话旁入口收敛；旧事件路由/死码清理 ②顶部「子智能体」页升级「智能体与团队」双维度（团队卡片成员行内个体动态预览不跳页；engine snapshot 补成员 id 修复下钻/去重）③持续审计修复（executor end 判据/pet 误清/runPs 超时等）。矩阵 docs/AGENT-SYSTEMS-MATRIX.md，计划 docs/TEAM-CONSOLIDATION-PLAN.md。全量 vitest 168 文件 / 4239 用例通过 + tsc 零错误 |
| v1.10.0 | 2026-09-07 | **EAC 对标 DSH-Desktop-EAC 第①②③④项 + 全量审计修复** — ④宠物大肥鱼式状态卡（真实 Agent 事件驱动：项目/阶段/真实步骤，不编造）/ ③@codem/computer-use 电脑操作（10 工具 + PS 零依赖后端 + manual 手动批准）/ ②@codem/wechat-bridge 微信 ClawBot 桥（iLink 直连：Rust 传输层扫码登录/长轮询/收发/配额 + TS 引擎桥 + 准入命令）/ ①@codem/phone-link 手机连接（Rust LAN HTTP 地基扫码配对 + 手机浏览/续聊/新建会话）。四路只读审计修复（computer-use PS 调用约定 P0 断链 / 宠物卡隐藏信号 / 插件禁用=关闭真实生效 / executor 失败落库 / /api/chat 202 语义 / 配对 cookie 重放 / ui-pet·mimo-auth·hot 元数据对齐）。实施记录 docs/EAC-PHASE2-STATUS.md。全量 167 文件 / 4231 用例通过 + tsc 零错误 + Rust cargo test 38 通过 |
| v1.9.9 | 2026-09-07 | **UI 交互改进 + 3 个新插件（对标 DSH-Desktop-EAC）** — ①编辑并回退（fork 保留原会话）②节点导航升级（滚动容器修复 + hover 预览 + 滚轮 + 📌 精选 pin）③输入框失焦折叠 ④字号生效（--ui-font-scale）⑤设置搜索 ⑥persona 人设卡（# Persona 注入 + 热重载，修 SOUL 孤儿；插件门控）⑦side-session 临时会话（不污染主会话，text_delta 流式）⑧**@codem/agent-teams 团队编排**（依赖任务 DAG/attempt 防覆盖/成员邮箱/共享调度/活动面板/10 工具 defer）。差距矩阵 docs/EAC-GAP-ANALYSIS.md。全量 163 文件 / 4204 用例通过 + tsc 零错误 |
| v1.9.8 | 2026-09-07 | **对话用量/缓存命中率统计真实化（对标 dsh-desktop）+ 稳定前缀优化 + 真实请求实证** — ①真实数据链路：TokenUsage 扩展 cacheHitTokens/uncachedInputTokens；provider 归一化透传 DeepSeek `prompt_cache_hit_tokens`/OpenAI `cache_read_input_tokens`（usage-normalize 口径精确化）；agentic-loop 每轮累计；token-tracker 真实优先；StatsLine uncached 口径 + 诚实精度命中率（cacheReported 门控）②用量统计面板缓存命中卡（近 7 天聚合）③date 每分钟易变字段尾置 # Current Date 段（稳定前缀 >95% 断言）④真实请求实证：短请求恒 miss、3259-token 重复命中 98.2%、96K 前缀纯重复稳态 **99.947%**（达 dsh 99.97% 量级）⑤端到端测试（真实 AgenticLoop 回放含缓存价差成本）。全量 157 文件 / 4159 用例通过 + tsc 零错误 |
| v1.9.7 | 2026-09-04 | **dsh 插件市场 + 插件皮肤兼容契约 + 插件架构审计修复（13 项）** — ①插件管理弹窗新增「插件市场」Tab：50 条真实官方 @deepseek-ai/dsh-* 目录（bundled 37 / adaptable 9 / unsupported 4，codemAnchor 一对一 + npm registry 在线检索跟随输入 + 动态分类 + 三态安装按钮）浏览/搜索/安装（bundled=启用内置等价，核心恒启只读）/禁用（真卸载 ctx 插件）+ 小窗自适应 ②dsh-compat 懒解析代理接入（7 别名恒注册、调用时现取真实服务；服务名矩阵 78 vs 203 核对）+ 真实 Cordis 装配集成验证（LC-1~6）③插件皮肤兼容契约（skin-tokens 审计 + SC-1~5 门禁，default 亮/暗+dream+hub 四态令牌化）④稳定性/架构审计修复：enable 部分失败必报错（P1）/error 持久化（P2）/loading 连点保护（P3）/error 可重试（P4）/manager 单例幂等（V1）/元数据同源（V2，图=激活）/禁用=真卸载（P6）/管理入口 core 防死锁（P7）/动态分类/无障碍 ⑤执行轨迹修复+事件日志持久化（重启回放）+ 首页无会话自动新建全局对话。全量 152 文件 / 4141 用例通过 + tsc 零错误。**另含同版本补丁覆盖发布**（commit 7d1f329/88b49f2）：CodeGraph defer 接入与一键安装 / 技能市场联网搜索卡死修复 / 输入框长 URL 光标视觉错位修复 / GitHub URL 标签重复生成修复 |
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

### v1.16.22（2026-09-13）— 「删除技能卡死」第二轮：把不可复现的冻结变成可取证（第 72 波）

- **用户复测仍卡死**，并给出三条决定性信息：删的是「用户」来源技能、**整个窗口都点不动**、
  控制台**连一条 `[SkillInstaller]` 都没有**。最后一条把范围从"原生删除"改到"点击 → 进入删除逻辑"之间
- **本机取证（CDP 驱动真实界面）**：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`
  启动构建产物，脚本化走完「技能管理 → 选中探针技能 → 删除技能 → 确认」：控制台出现
  `[SkillInstaller] uninstall "zz-delete-probe" → 永久删除 …`，弹窗关闭、用户技能数 1 → 0、
  磁盘目录消失、无错误横幅；且本机构建与用户日志逐行一致（`main-IHu-_uUa.js:9571 / :8813`）
- **新增落盘黑匣子**（`src/core/skill/skill-delete-diag.ts` → `<appData>/.codem/skills-delete-diag.log`）：
  - 点击链路：`delete button clicked`（技能名/来源/路径）→ `confirm dialog opened` → `confirm action fired`
    → `uninstallSkill deleting` → `directory removed` / `failed` → `delete flow finished`，每行带 `+Nms`
  - `heartbeat`（2 秒一次，报告 `driftMs`；漂移超阈值附 `suspicion: "main-thread block"`）
  - `render burst`（1 秒内渲染超阈值，抓"无限渲染循环"这类**不产生任何控制台输出**的冻结）
  - 约束：写盘 fire-and-forget + try/catch —— **诊断失败绝不影响删除**
- **同时补三处**：慢删除显示「正在删除… 已用 N 秒」；删除失败就地显示在详情面板按钮下方；
  **目标护栏**（记录路径若是技能根目录或其上级 → 拒绝删除并说明，避免"删一个技能"变成"删掉全部技能"）
- **验证**：CDP 端到端 + 轨迹落盘完整；`skill-delete-diag.test.ts` DIAG-1~4、
  `skill-uninstall-safety.test.ts` UNINST-1~7；全量 222 文件 / 4760 用例通过；tsc 0 错误；
  审计 25 条规则 0/0；css-contract 无变化
- **给用户的一步**：若仍卡死，把 `%APPDATA%\com.codem.app\.codem\skills-delete-diag.log` 发回 ——
  轨迹会直接指出卡在哪一步、主线程停了多久

### v1.16.21（2026-09-13）— 修复：技能管理「删除技能」卡死（第 71 波）

- **现象**：技能管理点「删除技能」卡死；控制台只有启动日志、没有任何错误 —— 卡住的不是 JS，
  而是一个永不完结的原生调用（前端 `await` 永不返回）
- **根因**：`uninstallSkill → deletePath(技能目录) → delete_file 失败 → delete_directory`，而
  `delete_directory` 在 Windows 上是 `powershell -Command "…FileSystem::DeleteDirectory('<目录>',
  'OnlyErrorDialogs', 'SendToRecycleBin')"` + `Command::output()` 等待退出。`OnlyErrorDialogs`
  语义 = 出错时弹对话框并等用户确认，而该 PowerShell 是**隐藏子进程**（没有可见窗口）→ 删除一旦
  失败（目录被占用 / 回收站不可用 / 超过回收站配额）对话框就弹在没人能点的地方 → 进程永不退出
  → 命令永不返回 → 前端 `await` 永不结束 = 卡死。项目删除与宠物卸载复用同一命令
- **修复**：① 新增 Rust `delete_directory_permanent`（`remove_dir_all`，失败时清只读位重试一次），
  应用自管目录（技能/宠物/zvec 运行时/快照）一律走它 —— 无 shell、无对话框、无回收站；
  ② `delete_directory`（回收站，保留给项目文件夹等用户内容）改为直接调 `SHFileOperationW`，
  `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI` 抑制全部界面，只可能返回
  （实测 130 ms，旧 PowerShell 路径同机 473 ms）；③ 前端 `uninstallSkill`/`uninstallPet` 失败
  **不再谎报成功**并保留注册表记录（旧代码 catch 后照旧 return success → 界面显示已删、文件夹
  还在、下次启动又被扫回来），删除加 30 秒兜底超时，删除期间显示「删除中…」、失败在界面可见
- **验证**：`cargo test --lib` 42 通过（含 4 条新用例：嵌套+只读整树删除、缺失路径幂等、
  拒绝空/根路径、回收站路径必须返回）；新增 `skill-uninstall-safety.test.ts` UNINST-1~5，
  并**用修复前的 installer 跑过一遍：4 条失败**（证明用例真能抓住 bug）；全量 221 文件 /
  4754 用例通过；tsc 0 错误；审计 25 条规则 0/0；css-contract 无变化
- **同类清查**：`deletePath` 剩余用途均为临时文件（computer-use / 工具 / 市场下载），
  不再对应用自管目录走回收站删除
- **诚实交代**：未在机器上"亲眼复现"卡死那一刻（触发需要失败场景，而旧实现进入该场景会弹系统
  对话框，不在用户桌面上弹一个来验证）；根因依据是 `OnlyErrorDialogs` 的 API 语义 + 用户症状，
  且无论具体触发点为何，新链路都不再存在"等待对话框"这条路

### v1.16.20（2026-09-13）— 修复：上传附件后「上下文」标签不消失；兼容第三方 Agent Skills（AREX-Skill）

- **附件徽章不消失（用户反馈）**：上传 a.md 后编辑框里的「上下文：a.md」标签发送后仍在。
  根因是同一份状态被手工复制成两份（`pendingAttachments` + `contextBadges`，后者只在
  textarea onChange 重算）。同类路径一次性同生共死：发送后残留、点 × 移除附件后仍显示、
  跨会话残留、粘贴/拖拽的附件不进徽章行。修复：徽章行从 `pendingAttachments` 派生
  （`src/components/InputArea.tsx`）；`component-input-area.test.tsx` 新增 ATTC-1~4，
  并用「换回修复前组件」验证过 4 条用例确实会失败
- **第三方 Agent Skills 兼容（AREX-Skill 集成驱动）**：`name: "x"` 连引号一起注册成技能名 →
  `load_skill("x")` 查不到；跨行双引号描述被截断到第一行（vllm 描述 159 → 61 字符且带多余引号）；
  `description: >-` / `|` 字面解析成 `>-` / `|`（描述整段丢失）；正文没有 `# ` 一级标题时整份
  SKILL.md 被静默丢弃。修复（`src/core/skill/skill.ts`）：字符串字段统一去引号 + 反转义；
  跨行双引号标量按 YAML 折行拼接；块标量 `> >- >+ | |- |+` 全支持（折叠/字面 + chomping）；
  frontmatter 之后无一级标题的内容作为正文（无 frontmatter 的纯文本仍非法）；市场安装白名单
  补 `.jsonl` / `.csv`（AREX 路由器索引是 JSON Lines）
- **核对结论（写入文档）**：Codem 只加载技能目录一层子目录，AREX「router + `repo-skills/<id>/`
  兄弟目录」原始形状天然契合（只有 router 进技能目录，仓库根技能由路由器按需 read 展开）；
  `<skill_resources>` 提供技能目录绝对路径，相对路径可直接解析；`disable-model-invocation`
  被忽略；项目根 `.codem\skills\` 只在项目管理器展示，不注册为可调用技能
- **文档**：新增 `docs/AREX-SKILL-INTEGRATION.md`（三种安装方式的可执行命令、实测体积
  vllm 35 文件 217 KB / router 204 文件 1.6 MB、验证清单、边界）
- **测试**：`agent-skills-compat.test.ts` 16 用例 + `component-input-area.test.tsx` 4 用例；
  全量 220 文件 / 4749 用例通过

### v1.11.2（2026-09-09）— zg 在线安装 Node 源根治 + 审计四坑修复 + 功能文档体系

- **zvec-grep 在线安装 Node 源根治**：便携 Node v24.19.0 并入 zg 单包（162MB，隔离目录
  不冲突系统）；安装链只从 GitHub Release 取包（不再访问 nodejs.org/npmmirror——部分
  网络对这些源返回 404 是此前"一键安装"失败根因，本机实测 URL 200 判定为网络层差异，
  改 GitHub 分发根治）；node 解析 = 系统≥22 → 包内 → 网络兜底；离线 zip 亦可全离线。
  打包脚本升级六步（Node+裁剪 zg+模型+冒烟+单包）
- **审计四坑修复**：① PPT「导出 PPTX」占位 → 真 OOXML 图片型 PPTX（buildPptxFromImages，
  16:9 EMU/contain/PNG·JPEG/IHDR 回退；PPTEditor 逐页截图生成；OPC 结构完整性单测）
  ② 纠偏模型配置面板接线（codem-correction-model 持久化；fact_check 专属/回退主模型
  诚实标注；移除 ctx.correctionProvider/correctionModel 假默认）③ Whisper 语音输入
  双引擎闭环（语音设置引擎选择 + 麦克风 MediaRecorder→/audio/transcriptions 转写 +
  未配置引导/无 SpeechRecognition 降级；公开 transcribeAudioFile 供 vision-proxy 共用）
  ④ 会话内搜索激活（头部入口 + 点击滚动定位含 unified 合并气泡回溯；修复旧内联过滤
  关闭后残留残缺视图 bug）；附带清理 InputArea 重复声明
- **功能文档体系**：项目功能说明介绍（20 域 152 亮点宣传向 + 皮肤独立域 13 项细粒度 +
  分层附录）与项目功能树-全量（18 路只读审计 2779 项叶子，含证据路径+宣传句）
- **覆盖包：手动添加自定义模型名（50010f3）**——服务商 /models 列表外的内测/灰度模型
  （如 deepseek-v4.1-flash-expires-on-0910，调用同协议仅模型名不同）可在设置→模型与
  API Key→对应 Provider 卡片直接添加（chips 可删）；存储独立 codem-custom-models，
  引擎加载/设置页/聊天模型下拉/方案面板读取统一 mergeCustomModels 合并，不污染服务器
  缓存；12 单测
- 测试：全量 175 文件 / 4314 用例通过 + tsc 零错误 + cargo check 通过

### v1.11.1（2026-09-09）— zvec-grep（zg）语义检索集成 + archify 图表技能 + UI/体验修复打包

> 主安装包自 v1.11.0 首次包含本版代码（c200ec9→f4b6470）——升级本版后插件市场
> 「本地语义检索」卡片 / Rust 新命令 / 内置 archify 技能才会出现在应用内。

- **zvec-grep（zg）语义检索（可选增强，不改架构）**：本地「语义向量+BM25+rg」统一检索；
  运行时按用户主动安装于 `<appData>/.codem/zvec-grep/`（不进安装包），经 MCP stdio
  （`zg server --stdio` 自动起/复用 daemon）接入现有 MCPRegistry；Rust 新增
  `http_download_ext`/`extract_zip`；编排服务 `src/core/zvec-grep/`（node 检测与便携
  下载、在线一键安装、离线单包导入、卸载、索引重建与模型切换）；`syncZvecTools` 注册
  `zvec_grep_search`（仿 codegraph）与内置 grep 双轨并行（精确锚点→grep；措辞未知/语义/
  跨文件→zg；混合→先 zg 后 grep 验证），只读/并发/权限集合加白；插件市场新增
  「本地语义检索」卡片；发布单合并包 `codem-zvec-win-x64.zip`（~125MB 运行时+code-16m
  模型，脚本 `scripts/build-zvec-runtime.ps1`，保留 *.wasm 供 tree-sitter）
- **archify 图表技能（内置）**：`src/core/skills/archify/`（v2.17，tt-a1i，MIT）——
  架构/工作流/时序/数据流/生命周期图 JSON-IR→自包含交互 HTML（showcase 9/9 校验）；
  用其产出 Codem 架构图/功能结构图（`artifacts/archify/html/`，组件带源码证据）
- **UI/体验修复打包（v1.11.0 覆盖包内容随本版首发）**：标题栏可拖拽修复（移除
  titlebar-center/nav-actions no-drag 残留）与品牌 Logo（icos/codem.ico → PNG）；
  左下角用户头像读取 codem-user.avatar 即时刷新；右侧栏磨砂玻璃（z 920 盖过导航轨）；
  消息导航轨全内容比例铺轨 + 纯紫点 + 最小间距避让；Git 分支控件并入右侧栏 Git 面板；
  右侧栏「智能体」tab 收敛（与顶部「智能体与团队」重复）
- 测试：全量 171 文件 / 4260 用例通过 + tsc 零错误 + cargo check 通过

### v1.11.0（2026-09-08）— 团队体系深合并 + 智能体双维度面板 + 审计修复

> 自 v1.10.0 后全部改动：持续审计第 1 轮（dde3620）→ 体系盘点（07dd260，docs/AGENT-SYSTEMS-MATRIX.md）
> → B 深合并 Phase1-3（614de0d/dab14c5/6585c9d/abfec90，docs/TEAM-CONSOLIDATION-PLAN.md）→ 审计修复（a5b4e1e）
> → 双维度面板与行内预览（86646ac/60b89aa/120ae66）。

- **B 深合并（团队单一化）**：Squad 升级为「团队模板」（TeamTemplate/toTeamTemplate）；`squad_dispatch` 按模板创建 agent-teams 运行时团队（队长=当前会话、按角色 spawn 可续聊成员、任务入共享池调度；模板无 agent 角色前置拒绝）；`squad_status`=模板+派生运行时团队摘要（team_id 可选）；`squad_list`=模板列表；App `codem-squad-dispatch` 事件路由与 `generateSquadRoster`/`SquadDispatchResult` 死码删除
- **TaskCenter 单一「团队」Tab**：tab `squads`→`teams`（TeamTab：说明 + 运行时团队活动（AgentTeamsPanel 嵌入，订阅刷新）+ 团队模板管理（SquadsTab 复用））；对话旁「团队活动」按钮收敛为快捷入口（codem:open-task-center → 团队 Tab）；旧 id 归一兼容
- **「智能体与团队」双维度面板**：顶部「子智能体」页首部显示当前会话活动团队卡片（成员=角色+状态点），点成员行内展开个体动态预览（最近活动+结果摘要，不跳页；「完整详情 →」进 AgentDetail）；成员从平铺去重；`engine.snapshot()` 补成员 id（修复下钻失效/去重失灵）；团队变化/切会话清理展开态；离线成员提示
- **持续审计修复**：executor end 失败判据补全（非 completed 即落库失败）；宠物卡轻量推送误清修复；runPs 默认超时 60s
- 测试：全量 168 文件 / 4239 用例通过 + tsc 零错误

### v1.10.0（2026-09-07）— EAC 对标 DSH-Desktop-EAC 第①②③④项 + 四路审计修复

> 四项按工作量递增落地（实施记录 docs/EAC-PHASE2-STATUS.md，差距矩阵 docs/EAC-GAP-ANALYSIS.md）：
> ④宠物状态卡（929a0f3）→ ③computer-use（c7ad786）→ ②wechat-bridge（229c0ae）→ ①phone-link（163815d）→ 审计修复（bccd152 + 57e2a3c）。

- ④**宠物大肥鱼式状态卡（对标 dsh-dafeiyu）**：真实 Agent 事件驱动工作状态卡（项目名/阶段/真实步骤进度，total null 不编造）；PetCard + pet-store updateCard + PetWindowApp 卡 UI + 锚点 resize 并入
- ③**@codem/computer-use 电脑操作（对标 dsh computer-user / Codex）**：10 个 computer_* 工具（截屏/点击/输入/组合键/滚轮/拖拽/移动/等待/读光标/改模式）；PS 零依赖后端（EAC capture/input 内联，MIT 声明）；默认 manual 手动批准（/computer）；computer_see 走独立视觉模型
- ②**@codem/wechat-bridge 微信 ClawBot 桥（iLink 直连）**：Rust 传输层（8 态扫码登录 + 配对码 + getupdates 长轮询 + 收发 + 每 peer 10条/24h 配额软记账 + 会话/游标/token 落盘，零新依赖）+ TS 引擎桥（peer→持久会话 executeSessionTurn + /help /status /new /attach /model /clear /reconnect /allow /ignore + 白名单准入 + QR/配对码/准入设置卡）
- ①**@codem/phone-link 手机连接（对标 dsh-phone）**：Rust LAN HTTP 地基（零新依赖手写 HTTP/1.1）——扫码配对（token 5min 轮换 + 桌面批准 + HttpOnly cookie + secret 仅存 sha256 落盘重启保配对）+ 手机浏览器浏览/续聊/新建桌面会话（/api/* 事件代理到 WebView 引擎）
- **审计修复**（bccd152/57e2a3c）：computer-use runPs 与 execute_command 调用约定 P0 断链 + 动作名失配（wait/getpos/move/action2/from-to）+ 宠物卡隐藏信号丢失（updateCard(null) 省略 card 键）+ executor end-reason 失败不落库（微信静默无回复）+ /api/chat 15s 必 504（改先 202）+ 配对 cookie 一次性不可重试 + 「插件禁用=关闭」真实生效（微信/手机外部可达面 + computer 门禁 + ui-pet/mimo-auth/hot 元数据对齐）+ wx-workspace 内部项目过滤 + 孤儿清理
- 测试：全量 167 文件 / 4231 用例通过 + tsc 零错误 + Rust cargo test 38 通过

### v1.9.7（2026-09-04）— dsh 插件市场 + 插件皮肤兼容契约 + 插件架构审计修复（另含执行轨迹持久化 / 首页自动建会话）

> 对标 dsh-desktop / deepseek-harness 插件生态机制（插件 = npm 包 @deepseek-ai/dsh-* 含 Cordis apply/name/inject/Config；装配 = cordis.patch.yml 分层 overlay；Loader 解析 name 模块按服务可用性拓扑激活；无公开 GUI 市场页，plugin-inventory Remote 供内部 UI）分析后评估：Codem YAML 声明式装配（codem.base.yml + codem.desktop.yml 分层）+ Cordis 激活同构，但内置 registry factory 映射加载、**不能加载任意 npm 插件**（运行时鸿沟），@codem/dsh-compat 桥此前 deprecated 未接入。落地模型：bundled（Codem 内置等价，codemAnchor 指向 @codem/* 真实插件，安装 = enable anchor）/ adaptable（dsh 协议、无第三方依赖，经 dsh-compat）/ unsupported（依赖 Node/npm 运行时，诚实标注）。
>
> - **插件市场目录**（`plugin-market/dsh-market-catalog.ts`）：50 条真实官方 @deepseek-ai/dsh-* 包（与 harness packages 全量核对存在性；bundled 37 / adaptable 9 / unsupported 4，bundled 锚**一对一唯一**），附 npm registry `/-/v1/search` 在线检索（15s 超时兜底，失败返回 []）；unsupported 含 dsh-goal（依赖 zod 等 npm 依赖）等诚实标注
> - **插件管理弹窗新增「插件市场」Tab**（`components/plugin-market/PluginMarketTab.tsx` + PluginManager Tab 切换）：浏览/搜索/分类（**动态派生**——按目录实际分类渲染，harness 无 UI 类核心插件时不出现空"界面"分类）+ 兼容徽标（"内置等价"= bundled 可一键安装对应内置插件）+ **三态安装按钮**（未启用→"安装并启用"；已启用且可安全卸载→"禁用"走统一级联；核心恒启锚（llm/fs-local/session/shell-local/tools/credentials）→只读"已启用（核心）"，杜绝把核心插件当卸载目标）+ 在线检索结果展示（**跟随搜索框输入**，空值用 dsh 宽搜默认）+ 小窗自适应（maxHeight 滚动、manager 未就绪禁用安装并提示"初始化中…"）
> - **dsh-compat 懒解析代理接入**（`dsh-compat/index.ts`）：注册时同步取服务（时序竞态 → 别名缺失）重写为 Proxy 懒解析——dshLlm/dshShell/dshFs/dshTools/dshSessions/dshEvents/dshCredentials 恒注册、方法调用时现取真实服务并做接口转换（如 dshTools.execute({callId,name,arguments}) → execute(name,args)）；builtin-registry 注册 @codem/dsh-compat + codem.base.yml 装配行——adaptable 类插件有了真实承载
> - **服务名对齐矩阵审计**（dsh-compat 头注释固化）：对 harness packages 全量插件 inject 服务名 78 项 vs Codem provides 203 项逐项比对——核心 seam（fs/shell/tools/llm/session/credentials/sandboxPolicy/slots/subprocess/commands/compaction/systemPrompt/userQuestions/web/subagent 等）**同名直通**；复数/命名差异（sessions/sessionProjections/sessionQuery/sessionTitle/goals/bash 等）经 dsh-compat 别名承接；约 30 项 harness 宿主装配名（remote.*/ui*/typert/webServer/cmdlineArgs 等）属宿主层，超出纯协议插件范围——"能力/工具类 dsh 插件适配成本集中在命名别名、无协议级鸿沟"的量化结论
> - **插件皮肤兼容契约（Skin Token Contract）**：插件（影响 UI/UX 者）与三套皮肤（default 亮/暗、dream、hub 恒暗，共 4 视觉态）兼容机制化——`theme/skin-tokens.ts` 登记令牌表 + `auditPluginStyle` 源码级硬编码色审计；新测试 `skin-compat-plugin.test.ts`（SC-1~4：审计函数行为 / 市场 Tab + 插件管理弹窗源码零硬编码色 / 登记令牌在 styles.css 均有定义 / 目录分类受支持）；修复市场 Tab 安装按钮文字 `#fff`→`var(--text-on-accent)`；完整契约见 `docs/SKIN-PLUGIN-CONTRACT.md`
> - 测试：`dsh-plugin-market.test.ts`（DM-1~5：三类覆盖 + bundled 必有 anchor + anchor 全部存在于 runtimePluginList + fetch 失败返回 [] + bundled 锚一对一唯一 + **真实依赖图（runtimePluginList 全量）下全部 37 个 bundled 锚安装级联可达、无缺失依赖**）+ `dsh-compat-lazy.test.ts`（DC-1~4：懒解析/服务未就绪抛错/接口转换）+ `dsh-plugin-market-wiring.test.ts`（PM-1~3：YAML ↔ builtin 装配一致性，防 terminal-bash 式断链）+ `plugin-market-tab.test.tsx`（MT-1~5：jsdom 渲染/安装/禁用/核心恒启条目只读）+ `skin-compat-plugin.test.ts`（SC-1~5）。全量测试通过 + tsc 零错误 + 重打包安装验证
>
> 同工作区另含（v1.9.6 后）：执行轨迹数据修复 + 事件日志持久化（重启可回放）+ 小窗自适应、首页无会话输入自动新建全局对话、知识笔记本导入 docx（CSP blob: 已随 v1.9.6 发布）。

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

## zvec-grep（zg）语义检索增强（可选，不改架构）

- **形态**：运行时按用户主动安装于 `<appData>/.codem/zvec-grep/`（不进安装包），经 MCP stdio（`zg server --stdio` 自动起/复用 daemon）接入现有 MCPRegistry；`zvec_grep_search` 由 `syncZvecTools` 注册进共享工具表（仿 codegraph），与内置 `grep` 双轨并行、模型按工具描述智能路由（精确锚点→grep；措辞未知/语义/跨文件→zg；混合→先 zg 后 grep 验证）。
- **入口**：插件管理 → 插件市场 →「本地语义检索（可选增强）」卡片：一键在线安装 / 导入离线 .zip / 为当前项目建索引 / Embedding 模型切换 / 卸载。
- **Rust 新增 command**：`http_download_ext`（长超时下载）、`extract_zip`（zip-slip 安全解压）。
- **发布产物**：`scripts\build-zvec-runtime.ps1` → `codem-zvec-win-x64.zip`（单合并包 ~125MB = 裁剪运行时 `runtime/zg/` + 模型 `models/`，MIT 可再分发；裁剪剔除 llama-cpp/onnx-web，保留 *.wasm 供 tree-sitter 解析）；随 Release 上传供市场卡片一次下载/导入。
- 详细集成说明见本地 `docs/ZVEC-GREP.md`（按 .gitignore 约定不入公开仓库）。




