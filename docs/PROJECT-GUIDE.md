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

> ⚠️ **第 72 轮（2026-09）起的口径：当前缺口只有一份清单 —— [`docs/GAP-LIST.md`](./GAP-LIST.md)。**
>
> 下面这张表的"状态"列**记录的是当初写下它时的状态**，不是今天的判断：
> 计划 / 缺口 / 待办类文档（文件名带 `GAP` / `PLAN` / `ROADMAP` / `TODO` / `STATUS` /
> `TRIAGE` / `UNIMPLEMENTED` / `REMEDIATION` / `DEFERRED`）**都已经加了
> 「历史文档（不再维护）」横幅**（40 份，由 `.preview-shot/banner-historical-docs.mjs` 加，
> 守门用例 `src/test/docs-current-gap-list.test.ts`）。
>
> 为什么这么做：实测对着 `TODO.md` 读出来的"还没做"里有相当一部分**早就做完了**
> （它列的 `InlineMessageEdit` / `ScrollbarMarkers` / `ScrollToBottomIndicator` 都在代码里），
> 于是"缺口清单"自己成了谣言来源。历史文档按原样保留（它们是各轮的取证记录），
> 但**引用前请在 `GAP-LIST.md` 与代码里各复核一次**。

| 文件 | 类型 | 说明 | 状态 |
|------|------|------|------|
| **GAP-LIST.md** | 📌当前清单 | **唯一的当前缺口清单**（未关闭项 / 已关闭项附判据 / 判定为"不是缺口"的） | ✅ 最新 |
| **PROJECT-GUIDE.md** | 📌本项目 | **本文档**，完整项目说明 | ✅ 最新 |
| **RELEASE-GUIDE.md** | 发布指南 | **构建 + 签名 + GitHub Release 完整流程**（v1.9.0 成功经验固化；发布构建必读） | ✅ 最新 |
| **AREX-SKILL-INTEGRATION.md** | 集成指南 | **第三方 Agent Skills（AREX-Skill）集成**：三种安装方式 + 实测体积 + 验证清单 + 已知边界 | ✅ 最新 |
| **PROJECT_STATUS.md** | 项目简介 | 项目概述+架构+功能清单+版本历史 | ⚠️ v0.88 时点（历史，见横幅） |
| **PROJECT-CONTEXT.md** | 旧版交接 | v0.79 时的交接文档，已被 PROJECT_STATUS 替代 | 📦 归档 |
| **TODO.md** | 待办跟踪 | Phase 0-G 完成记录 + v0.88-v1.1.0 版本变更 | ⚠️ 历史（**不是**当前待办，见 `GAP-LIST.md`） |

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
2. `GAP-LIST.md` — **了解当前还有哪些缺口**（唯一清单；历史文档里的"待办"一律不作数）
3. `CHANGELOG.md`（顶部若干条）— 了解最近几个版本改了什么、怎么验证的
4. `RELEASE-GUIDE.md` — 要发布时读它
5. `tools/audit/coverage-baseline.md` — 覆盖率棘轮的真实数字（"测试够不够"看这里）

**其余文档均为历史归档或已完成计划的记录，不影响进度判断**（计划/缺口类文档都带
「历史文档（不再维护）」横幅，指向 `GAP-LIST.md`）。

**DSH 对标系列文档阅读顺序（历史记录，看的是"当时怎么判断的"）：**
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
| v1.16.156 | 2026-09-26 | **玻璃材质：侧栏与弹出菜单改成「半透明 + 背景模糊」；按下态/禁用态/品牌色浅底三处收敛** | 用户问"对方的背景（尤其左侧栏和弹出菜单）是不是有透明过渡或者渐变"⇒ **源码取证回答：是玻璃材质、不是渐变**（侧栏 `color-mix(chrome 90%, transparent)` + `blur(12px) saturate(1.2)` + 顶边内高光，浮层 `raised 94%` + 同一档模糊；全仓 `linear-gradient` 只在卡片装饰/场景/thinking 上，侧栏与菜单一条都没有）①**我们的实情**：只有 `.popover-shell` 写了 `blur(12px)` 而底色 **98% 不透明**（模糊等于没生效），侧栏纯实色，`.model-picker` 用实色 `--bg-secondary` ②现在侧栏 `@supports` 90% 玻璃 + `--blur-medium` + 内高光（浅色侧栏底 `#f4f4f2`→`#f8f8f7`、内嵌块 `--bg-tertiary` `#f2f2f0`→`#f4f4f2`），浮层四处基础规则即 94% 玻璃 + 令牌模糊，**5 条规则 9 处**裸 `blur()` 全令牌化并删掉零消费方的 `--blur-base` ③三条降级（`prefers-reduced-transparency` / `prefers-contrast: more` / `[data-contrast="high"]`）+ 不透明度下限 90%/94%，门禁 **LIGHT-UI-10 / DARK-UI-6**（判据在**去注释后**的源码里找 —— 只在原文 grep 会被自己的注释骗过，这条是变异 M5 逼出来的；D7 高对比档同时落地）④**按下态**：`.press-layer-host:active` 原来用的是悬停档底色（按下去和悬停一样）⇒ 新增 `--surface-pressed`（浅 10% 黑 / 暗 **14%** 白）；暗色那个数是算出来的：按下是半透明的、必须先合成到各面上再比，**最小成立 α = 13%**（10% 时在画布上比悬停还暗 ⇒ 方向反了），门禁 LIGHT-UI-11 / DARK-UI-7 ⑤**禁用态**：0.3/0.4/0.45/0.5/0.55/0.6 **六个数**、35 处 ⇒ `var(--opacity-disabled)` = 0.5，新增令牌卫生 **H5**（禁用族写裸数值就红、`:hover:not(:disabled)` 不误伤、还守"用了却没人定义"）⑥**D5 品牌色阶梯**：**64 处**手写 `color-mix(… var(--accent) N%, transparent)`、**20 种百分比** ⇒ 四档令牌（8/15/30/45%，全派生自 `var(--accent)`）+ **28 处等值迁移**（零视觉变化）+ 新棘轮族 `accent-tint`（剩 43 处只许降）⑦**口径修正**：棘轮曾把 `box-shadow: none` 这种**取消**也算"写死"，玻璃降级块这个正确做法反把棘轮推高 2 处 ⇒ `none/inherit/initial/unset/revert` 计入 `keyword`（可见、不进 raw；`bold` 仍算写死），按新口径**收紧** 5 个族基线（box-shadow 31→29 等）⑧新增 11 条契约、**变异 9/9 + 10/10**；实测 `verify` **exit 0**（400 文件 / 6278 通过）、`audit` 全绿；**仍未做**：P1-2 文字/`--accent-muted` 解耦、P1-3 阴影阶梯统一（`--shadow-lg` 品牌紫被既有用例钉住）、P2-1 密度档、P2-2/D8 身份色、P2-3 皮肤数据化（hub 51 / dream 72）、P2-4 颜色注册表、D1 暗色主文字（用户说好看⇒不动）、D3 暗色阴影强度（需人眼确认） |
| v1.16.155 | 2026-09-26 | **皮肤对标 `GCWing/OpenBitFun` 的 P0 四条全部落地 + 暗色档首次有不变量门禁** | ①**P0-1 真 bug**：`--radius-xs` 被两个 `:root` 重复定义（4px vs 8px）⇒ 装机版运行时实际 **8px**、与 `--radius` 重复、**81 处**受影响；现在唯一定义 4px、80 处密集控件迁到 6px、两套皮肤补齐全套刻度，新增 `scan-token-hygiene.mjs`（H1 重复/H2 成套/H3 单调/H4 类型，audit 第 18 道）+ 用例 12 条 + **变异 5/5** ②**P0-2**：边框补成 5%/9%/34% 三档 + 输入态（hover 20%、focus=strong）并用 `:where()`（特异度 0）接到输入类控件上，判据 LIGHT-UI-2c ③**P0-3**：`--lh-*`(7) + `--ls-*`(3) 令牌，**行高 87 处、字距 7 处**换成令牌（精确等值替换），两个**有真实调用点**的排版角色 `.text-overline`/`.text-meta` ④**P0-4**：写死值棘轮（9 个族，只许降）+ 基线，audit 第 19 道，**变异 5/5** ⑤**口径更正**：第一版的负向断言把 `var(--x, 兜底)` 也算成写死（"字号 917 处"真实值 45）—— 更正后默认皮肤主样式表**裸颜色字面量只有 7 处**，脏的是皮肤（dream 72 / hub 51）与**字重**（317 处没走令牌） ⑥**暗色**：新增 DARK-UI-0…5 六条不变量（此前暗色一条都没有），修掉 `--text-muted` 在悬停面上 3.92:1（现 4.52，四面全过 4.5）与暗色边框偏弱（1.35 → 1.54） ⑦实测：`verify` **exit 0**（400 文件 / 6267 通过 / 0 失败）、`audit` **19 道 exit 0**；缺口清单未关闭 3 项（O-1 / O-29 / O-30 的剩余 P1·P2 + 暗色 D1–D8） |
| v1.16.154 | 2026-09-25 | **O-28 装机版复核当场量出的第三条口径差：`system` 行永远没有事件 ⇒ 自检「本次新产生」恒非 0** | ①在装好的 1.16.153 上跑真回合：主聊天一次工具回合产出空正文纯工具轮助手行，其 `tool_call`/`tool_result` 的 `messageId` **就是行 id**（改前是 `msg-…`），同一会话 `user_message`/`assistant_text` 各 **1 条**（改前各 2 条）✔ O-28 真因确认已修；委派回合（同一条 `executeSessionTurn` 路径）产出 3 条同类行，**每条的工具事件 id 都对得上** ✔。②但同一批复核里维护自检报「本次新产生 **1** 条」，样例是 `err-1790320962593-3axyi` —— **系统提示行**：写侧 `appendMessageTextEvent` 只写 user/assistant、重建侧 `migrateMessagesToEvents` 同样只搬这两类、投影侧只会产出 user/assistant/tool 三种行 ⇒「系统行必须有事件」是**不可能满足**的要求（真机库里 `system` 行 3 条、3 条全被判违规）。③修法：口径收窄到 `system` 行跳过，`user`/`assistant` 一条不动；用例双向钉住（O28-6a 放宽的边界 / O28-6b 反向对照），**变异 6/6**（含 M5 去掉跳过 ⇒ 红、M6 放宽到所有角色 ⇒ 红）。④顺带如实记一个新发现：页面重载后当前会话最近消息会再落库一次，而文本事件的指纹去重表是**进程内内存态** ⇒ 同一条正文再写一条事件（`seq=9001/9002`），不影响"可见即已记录"，已入清单。 |
| v1.16.153 | 2026-09-25 | **O-28 真因：工具事件里的 `messageId` 是引擎自造的 `msg-…`，消息行的 id 由落库方生成 —— 两套 id 从来没对上过** | ①**不是**「没写 `assistant_text`」：副本库（主库+WAL+SHM 复制后只读打开）实测，被判缺口的三行是**纯工具轮**的助手行（正文为空，按设计不写 `assistant_text`），它们的 `tool_call.messageId` 是 `msg-1790319153390` 这类**引擎自造 id**，而 `messages` 表 / `tool_calls.message_id` 用的是 `assistant-1790319154162`。危害不止自检报数：`event-projection.applyToolCall` 找不到那个 id 会**凭空建一条 `msg-…` 助手行**，真实行在投影里消失。②修法：`AgenticLoopConfig` / `LLMEngine.process` 新增 `resolveAssistantMessageId`，由**落库方**（executor 传 `ensureAssistantMessage()`、App 传 `assistantMsgId`）提供本轮的助手消息行 id，引擎不再自造（拿不到才退回）。⚠️ `process()` 里**无条件写**（含 `undefined`）：loop 是按会话池化复用的，条件写会让"没接线的回合"继承上一轮的闭包。③同一处「双写点」收敛成**一个写入者**：删掉 executor 里冗余的显式 `assistant_text` append（真机实测每条用户消息/有正文回复都留下**两条**事件），只在「空正文且无工具调用」的收尾行补一条（投影重建时它会消失）；写入失败按 `seq===0`/抛错走 `reportPersistFailure`（新上报点已分诊）。④判据：`o28-assistant-event-wiring.test.ts`（真 `LLMEngine` + 真工具流水线）+ **变异 4/4**。⑤顺带 O-27 收尾：`binded_redirect` 恢复旧会话前**先探活**（`PROBE_TIMEOUT=6s`，判据与 `poll_loop` 一致；`Dead` ⇒ `Expired`+「请重新扫码」，`Unknown` ⇒ 不判活也不判死）。⑥交接时 `npm run verify` / `npm run audit` **各有一条红**（CHANGELOG·PROJECT-GUIDE 版本号停在 1.16.149；上一轮遗留的一次性脚本语法错）——本轮一并修掉，并补记 1.16.150/151/152 三条。 |
| v1.16.152 | 2026-09-25 | **O-27 真凶：`message_id` 数字/字符串不兼容 ⇒ 整批入站消息被静默丢弃** | `WeixinMessage.message_id` 实测是**数字**而结构体声明成 `String` ⇒ 整批反序列化失败 ⇒ `poll` 里 `unwrap_or_default()` 把消息**静默丢掉**（原始响应里有 `msgs`、应用记 0 条）。改为兼容字符串/数字 + 解析失败改为记账落日志。**装机版实测**：`inbound_count=3` / `outbound_count=3` / 游标推进 / 生成 `wx-…-im-wechat.jsonl`，用户在手机微信里确认收到回复。 |
| v1.16.151 | 2026-09-25 | **O-27 第二轮：`poll` 里那个会吞掉请求的 `poke` 分支去掉了 + 请求/响应留痕** | 原 `select!{ 请求, poke → continue }`：poke 一响就 `continue`，**整轮请求被跳过**。改为直接 `await`；并打印前 5 轮的「发起 getupdates」与「原始响应」（截断 300 字）、前 20 轮的「响应里 0 条消息」⇒ 从此能分辨"请求没发"与"发了但服务端回空"。 |
| v1.16.150 | 2026-09-25 | **O-27 第一轮：微信桥轮询装眼睛 + 看门狗自愈** | `IlinkInner` 加 `polls` / `last_poll_at` / `last_poll_error` / `last_poll_msgs` 并在 `emit_state` 与 `ilink_status` 暴露；每轮记账、取到消息与失败分别落运行时日志、38s 长轮询超时也留痕；新增 `spawn_watchdog`（`connected` + 有会话但 120 秒轮询计数不推进 ⇒ 换代重拉）。 |
| v1.16.149 | 2026-09-25 | **首轮对话的工具表不再可能缺件（六批「延后注册」工具改成可等待）；覆盖率偶发假红查清并根除** | ①`LLMEngine` 的六批工具（squad / issue / agent-teams / computer-use / 跨会话委派 / subagent-tools）原先都是 `import(spec).then(注册)`，**没有等待点** ⇒ 刚启动就发第一条消息时可能还没进工具表；现在 `process()` 构建请求前 `await whenToolsReady()`（六批 import 落定；已就绪时只多一个 microtask）②证据不是猜的：`agent-teams/tools.ts` 函数覆盖率在 **24.13%（7/29）** 与 **62.06%（18/29）** 之间跳，正是「那次动态 import 有时跑完、有时没跑完」；补确定性用例（`agent-teams-tools.test.ts` 13 条 + `llm-tools-ready.test.ts` 4 条）后连续读数 **62.06%**，地板余量 0 → +27 个百分点 ③同源问题就是第 109 轮那次「按文件覆盖率地板假红」（4 次里 1 次），本轮连跑 4 轮复现（24.13% 🔴 / 62.06% ✅ ×3）并定位 ④顺带修好 GAP-LIST 两行表格里未转义的竖线（O-10 行 13 个、O-21 行 6 个 ⇒ 整行渲染错位） ⑤出包前全量：398 文件 / 6241 通过 / 16 跳过 / 0 失败，tsc 0，verify exit 0（地板 307、棘轮 94/59/10、门面交叉 21/21），audit 14 道 exit 0 |
| v1.16.148 | 2026-09-25 | **宠物窗的崩溃兜底终于接上了（以前崩溃 = 一块透明死窗口）+ 更正一处审计错结论** | ①`PetErrorBoundary`（第 44 轮专为宠物窗这个独立 webview 写的自包含边界）**从来没接线** —— `pet-main.tsx` 一直直接渲染 `<PetWindowApp />`，于是宠物窗渲染出错就是一块**透明死窗口**（无文字、无按钮，用户连"重新加载"都点不到，主窗控制台也看不到）。现在接线：崩溃显示诊断文本 + 「重新加载宠物界面」，连点 3 次给「可右键窗口退出」。**发现路径**：第 106/107 轮的可达性普查报出它"只被测试 import、生产 0 引用"。**判据**：`pet-error-boundary-wired.test.tsx` 4 条（接线 + 反向对照 / 崩溃可见可点 / 正常路径不变 / **保持自包含**：不许 import 主窗重依赖）+ 变异 **6/6**；真机在运行中的 1.16.148 里 fetch 宠物窗产物 `pet-*.js` 核对三处标志物（控制台 0/0/0）。②**更正**：第 105 轮那条"`cicd/pipeline.ts` 零生产 import"是**粗脚本的错结论** —— 它经 `core/cicd/index.ts` 被 CicdPanel 正常导入，**是可达的**。③记录一门**覆盖率假红**（`agent-teams/tools.ts` 的 functions 计数抖动，同一命令再跑即过；记为 O-23 待查，**未**放宽地板）。**实测**：全量 395 文件 / 6219 通过 / 0 失败；`tsc` 0；verify 0；audit 13 项全绿；可达性普查不可达 40 → 39。 |
| v1.16.147 | 2026-09-25 | **上报点分诊清零（217/217）+ 三处提示语气修正 + 一句「我们重试过了」的假话** | ①分诊推进：第 90 轮 94/123 → 第 100 轮 131/86 → **本轮 217/0**（86 处覆盖 48 个文件，逐处写了「为什么不是另一种通道」的理由，登记在 `tools/audit/report-site-classification.json`）。②三处通道修正：待办勾选的两条分支（列表已不在库里 / `todos` 是坏 JSON）原来印「写盘失败……本次改动只存在于内存」，而两处**什么都没写** ⇒ 改 action；`eventProjection.compaction` 遇到形状不合契约的载荷时投影**没有失败**（降级处理并继续跑完）⇒ 从 persist 改 **advisory**（标题「压缩事件的形状不合契约」）。③**假话**：`sessionLog.rebuildIndex` 的 extra 写着「已回退旧路径重试」，而那段回退**第 17 轮就删了** ⇒ 改成「本次重建**没有完成**」。④棘轮 `PENDING_BASELINE` **86 → 0**：新上报点必须当场分诊才能合入。**真机**：从本机 dist 找承载新文案的分包，再在运行中的装机版里 `fetch` 那份文件核对（新文案在、旧假话搜不到、控制台 0/0/0）。**实测**：全量 394 文件 / 6215 通过 / 0 失败；`tsc` 0；verify 0；audit 13 项全绿（未分诊 0、漂移 0、过期 0）。 |
| v1.16.146 | 2026-09-24 | **读侧失败不再印成「写盘失败……本次改动只存在于内存」+ 上报点分诊 123 → 86** | 分诊全仓上报点（O-17）时发现 **8 处把「读」事件送进 persist 通道**，而 persist 的默认语气是「写盘失败……本次改动只存在于内存，重启后可能丢失」—— 这些现场根本没写入：知识库按需读（端口被换 / 文本块未读到 / **块数超缓存预算**）、笔记本计数刷新（旧值原样保留，与默认后果句恰好相反）、待办列表加载（镜像未接手）、待办勾选（用户的勾选没生效）、文件回滚 ×2（回滚没执行）。逐处改：前两类走 **action**，容量那条走 **advisory**（标题「知识库文本块超出缓存预算」+「这是容量上限而不是读取失败」）。判据 = `scan-report-sites --check`（登记 kind 必须与实际一致）+ pending 棘轮（`PENDING_BASELINE` 123 → **86**），变异 **8/8**。本批分诊 37 处（inbox/squad/flashcard/issue/knowledge-storage/show-todo/file-change-tracker 七家族）。**真机**：新文案在运行中的 1.16.146 里取回核对（控制台 0/0/0）；**如实标注**这 8 条的触发条件真机造不出来，语气由门禁守着。**实测**：全量 392 文件 / 6192 通过 / 0 失败；`tsc` 0；verify 0；audit 13 项全绿（未分诊 0、漂移 0、过期 0）。 |
| v1.16.145 | 2026-09-24 | **导入 PPTX 的两个「空壳」缺陷 + `.pptx` 走查这一格终于量到** | ①`parseShape` 里「拿不到 `<a:off>`/`<a:ext>` 就 `return null`」，而真实 PPTX 的**占位符几何继承自 slideLayout**（PowerPoint / python-pptx 写出来都是空 `<p:spPr/>`）⇒ 整块被丢：**每页元素 0、一个字都看不到，还不报错**（装机版 1.16.144 实测 `幻灯片 1 / 5 … 元素: 0`）；缺几何时改按占位符类型给默认版面。②图片填充查的是 `a:blipFill`，真实文件是 **`p:blipFill`** ⇒ 图片一律丢弃。③O-12 ① 的空白格补上：先核实"本机没有可打开的演示文稿"（找到的三份 deck 全是空模板），再造一份 **python-pptx 1.0.2** 生成的第三方 deck 夹具（`tools/fixtures/make-pptx-fixture.py`，5 页含标题/要点/表格/图片/备注），单元门禁 **9 条 + 变异 7/7**，并用 CDP `DOM.setFileInputFiles` 喂给 `<input type=file>` 在**装机版**上逐页量：修复前每页元素 0、修复后第 2 页要点与第 4 页图片都渲染出来（控制台 error 0）。④顺带量清一个**测试环境**问题：happy-dom 会丢带前缀属性（`r:id`）且不认单引号 XML 声明，而真实 Chromium 两者都正常（装机版里对照过）⇒ 该用例改用 jsdom，而不是改产品迁就测试。⑤覆盖率棘轮按规则上调：全局 lines 52 → **55**（本轮实测 56.02%）。**实测**：全量 392 文件 / 6192 通过 / 0 失败；`tsc` 0；verify 0（按文件地板 309 个文件；jscpd 169 clones）；audit 13 项全绿；零覆盖文件 4 个 / 553 行。 |
| v1.16.144 | 2026-09-24 | **「导入 Markdown」修两个真缺陷（笔记标题被弄脏、正文被切碎丢掉）+ 「导出→导入」往返门禁 + 正则 Unicode 门禁（audit 第 13 道）** | ①`importer.ts` 剥 `📝`/`📊` 前缀用的是**没有 `u` 标志**的字符类正则，而 emoji 是代理对 ⇒ 只吃掉高位代理、留下孤立低位代理 ⇒ 导入后**每条笔记标题**都多一个替换字符（界面/库里就是 U+FFFD）；改成 `(?:📝\|📊)` + `u`。②`splitSections` 把**任何** `## ` 行当新小节、笔记块按**任何** `### ` 切 ⇒ 笔记正文自带的 `## `/`### ` 会让正文落进未知小节**整段丢掉**（只剩标题与时间戳）；改成只认认得出的小节（摘要/来源/笔记）+ 笔记块只认 `### 📝`/`### 📊` 记号（手写文件无记号时退回老行为）。③新门禁 `knowledge-export-import.test.ts` **17 条**（EXP/IMP/RT 三层，覆盖此前 0 覆盖的 `knowledge/exporter.ts` + `importer.ts`）+ 变异 **9/9**。④新扫描器 `tools/audit/scan-regex-unicode.mjs` 接进 `npm run audit`（**13 道**）：报「字符类里含非 BMP 字符却没有 `u`/`v`」这一形态；门禁 4 条含反向对照与误报对照，并直接复现该形态确实造出 U+FFFD；顺带被自家 `encoding-replacement-char` 规则抓到一次（注释里写了替换字符本身）。**真机（1.16.144）**：修复后的正则在运行中的应用取回核对（老形态不在）、面板能开、控制台 0/0/0；**如实标注**：导入行为本身没点到 —— 原生文件选择框自动化不了（四套路子都试不通，记录在钻取脚本头部）。**实测**：全量 391 文件 / 6183 通过 / 0 失败；`tsc` 0；verify 0（按文件地板 309 个文件）；audit 13 项全绿；零覆盖文件 6 → 4。 |
| v1.16.143 | 2026-09-24 | **按文件覆盖率地板（309 个文件）+ 皮肤对比度变成真门禁 + 设置滑块 24px 命中带** | ①`tools/audit/coverage-per-file.mjs`（接进 `npm run verify`）：地板 = 实测 × 0.8（≥20 行才建，`--write` 只降不许升）；判据 = 不得低于地板 + **新文件 0 覆盖且 ≥50 行必须拦** + 地板表僵尸清理提示；实测 **309 个文件都在地板之上**；门禁 5 条（含 2 处变异与「小文件不该被拦」的反向对照）。②**覆盖率盘点（新开 O-21）**：≥50 行生产文件 182 个，其中**行覆盖 0% 13 个（1251 行 / 1352 语句）**、<20% 29 个（2589 行）；最大 `knowledge/ppt-generator.ts` 263 行。③`contrast-checker.ts` 原来**0 覆盖且无调用方**（只在 index re-export）⇒ 新增 `skin-contrast.test.ts` 读 `styles.css` 用被测实现算三套皮肤对比度并卡线（dark 12.95/8.85/5.42、light 16.50/7.37/5.25；primary/secondary 卡 AAA ≥7、muted 卡 AA ≥4.5）；hub/dream 不覆盖这些变量 ⇒ 继承被同样锁住（CT-3 要求将来覆盖时单独加判据）。④外观页滑块 16px 高、与最近目标仅隔 6px ⇒ 加 `min-height: 24px`（外观不变、命中带变大），门禁 MH-4 钉住。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；verify 0；audit ${AUDITS} 项全绿。 |
| v1.16.142 | 2026-09-24 | **又一批「难点到的控件」+ 读屏念不出名字的开关；两个扫描器共用的 JSX 底层收成一份** | ①`AutomationTab` 的触发器开关：`<label>` 里**只有 input 没有文字** ⇒ 读屏念不出它管哪个触发器（**空 label 给不出可访问名**），13×13 也是全部可点范围 ⇒ 补 `aria-label`（带触发器名+开关状态）+ 外层 24×24 命中区 + 复选框 16×16。②三个窄按钮加 24×24 下限：`.api-key-toggle`（36×**19**）、`.session-recovery-close`（**22×22**）、`.usage-stats-close`（**22×22**）。③把 `=>` 截断这个坑收成共用底层 `tools/ui-audit/jsx-scan.mjs`（`findTags`/`stripJsxTags`，跳引号+跟踪花括号）—— 第 84 轮 icon-button 扫描器因此漏报（55 vs 真实 195），第 95 轮 labeled-inputs 扫描器因此看不到 `onChange` 之后的 `aria-label`。④新门禁 `labeled-inputs.test.ts` 3 条（棘轮基线 0 / 三类窄按钮 24 下限 / 四种写法的反向对照）+ 变异自证 **7/7**；变异连着试出扫描器自己三个毛病（`=>` 截断、**空 label 当有名字**的假阴性、`m.index` 写成 `undefined` 造成的 **25 处假阳性**）并已修。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿；扫描器报 **0 处**。 |
| v1.16.141 | 2026-09-24 | **收件箱两个「难点到的控件」修好（16×19 / 13×13 → 24×24 下限）+ 走查度量更正：`被遮挡控件` 里真缺陷为 0** | ①真机走查在「任务中心 → 收件箱」报出 **7 处真控件命中区不足 24×24**：每行的「归档」按钮（`padding:2px` + 12px 图标 = **16×19**，而它是通知**唯一的移除入口**）与「显示已归档」的复选框（**13×13**，外面 label 只有 20px 高）。修法：两类控件统一 **24×24 下限 + 居中**（图标尺寸不变，只放大可点范围）。判据 `min-hit-area.test.ts` 3 条 + 变异 **7/7**；变异又抓到判据自身一处毛病（MH-2 的「往后找 200 字」正则会越界读到下一个常量 ⇒ 改成限定在常量自己的块里）。②**度量更正**：原来只报「多少面板有被遮挡控件」（123 个），现在按遮挡者分类 —— 157 个入口重跑：`overlayArtifact` **1425**（走查自己开着模态框量后面的面板）、`sticky` **194**（面板自己的吸顶头/底栏）、`decorative` 0、`realControl` **1**（插件装饰方块被菜单栏压住）⇒ **原来那个数字里没有真缺陷**。③**走查安全**：排除名单漏了标题栏的真实文案「还原」「关闭」⇒ 走查真的点了窗口控制（「关闭」= 关掉用户窗口）；已按真实文案排掉，并复核窗口状态无遗留改动。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿。 |
| v1.16.140 | 2026-09-24 | **附件正文被「读回来再写回去」抹成 NULL（静默数据丢失）** | 承接 1.16.139：修完「点开看不到正文」后又追了一层 —— 直接查库发现那一行的 `content` 竟是 **NULL**（`preview` 还在），即**正文被应用自己抹掉了**。副本库上的确定性复现：带 `content` 键写回 ⇒ `content` 变 null（复现）；不带该键写回 ⇒ 原值保留（修法成立）。根因：`writeAttachmentsViaPort`（启动期消息索引重建/回填/更新都走它）把 `content` 一起 upsert，而读路径上的消息按设计不带正文（`attachmentsFromMirror` 只投影元数据）⇒ `undefined` 被写成 NULL；**外置附件更严重**（`content` 是 `file:<路径>` 标记，抹掉后文件再也找不回）。修法：与引擎的 `replace = 未提供的列保持原值` 语义对齐 —— **没有正文就不提供 `content`/`preview` 两列**。判据 `attachment-content-keep.test.ts` 3 条（含「别修成永远不写正文」的反向对照 + 引擎前提核对）。工具 `repro-attachment-content-wipe.mjs`。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿。 |
| v1.16.139 | 2026-09-24 | **附件点开能看到正文了（O-2 关闭）** | 隔离钻取（副本库 + 复制权威日志 + `CODEM_DB_PATH` 启动装机版）第一次把「附件看不看得见」量了出来：元数据**看得见**（`[message-attachments] live-attachment.txt 61 B`），但**点开是空的、且没有任何提示**。根因：`MessageBubble` 只读 `att.content`，而**读路径**上的消息（重启后/从域镜像读）按设计不带正文（正文可能几十 MB，一律留空、按需取）⇒ 只有「刚上传那一刻」能看正文。修法：点开时走 `getAttachmentContent(id)`（同步缓存命中即显示，未命中触发一次异步预取）+ **有界重试**（4 次、退避 400/800/1200/1600ms、卸载时 clearTimeout），读不到就**如实说**「正文暂时读不到（已触发预取，再点一次可重试）」。判据 `attachment-content-read.test.ts` 4 条（含「不许回到只按 att.content 判断」与「图片分支原样保留」的反向对照）。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿。 |
| v1.16.138 | 2026-09-24 | **无名图标按钮清零（O-4 ① 收口）+ 更正扫描器第四类误报（51 → 真问题 12）** | 两类误报：①**非字面量表达式** —— {item.title} / {S.ollama.save[lang]} 这类文字来自变量，旧判据只看字符串字面量 ⇒ 当成「没有文字」；②**嵌套花括号** —— {a === b ? <><Clock size={12} /> 恢复中...</> : …} 被嵌套不匹配的正则在第一个 } 处截断 ⇒ 里面的文字扫不到。两类合计 **39 处误报**（报 51、真问题 12）。**为什么不顺手加 aria-label**：这些按钮**本来就有可见文字**，加 `aria-label` 会盖掉读屏要念的文字（负优化）⇒ 39 处一律不动。修掉真的 12 处（消息气泡分支/重新生成取旁边 Tooltip 的同一 i18n 串、目标栏保存/取消、笔记删除、PDF 上/下一页与缩放、审核对话框关闭、设置搜索清空、会话删除、小队移除成员）。判据：A11Y-ICON-1/2 严格 = 0、**棘轮基线 51 → 0**、新增 A11Y-ICON-5/6（含「整段是 JSX 图标的播放/暂停必须仍被报」的反向对照）。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿；审计脚本报 **0 处**。 |
| v1.16.137 | 2026-09-24 | **全仓 217 处上报点开始逐处分诊（闸门化）+ 提示条不再印重复句号 + 两处「发现」正名** | ①**重复句号**（真机原文「…入口。。」）：拼装四段各自带句末标点，在**唯一出口**收口（`collapseDuplicatePunctuation`，只折叠连续重复的同一标点，不动省略号 `……`）；判据 ADV-8 含「省略号不许被折叠」的反向对照。②**上报点分诊**：新增 `tools/audit/scan-report-sites.mjs` + 登记表 `report-site-classification.json`，扫出全仓 **217 处**（persist 159 / action 51 / advisory 7，64 文件）；闸门 `audit:report-sites` 三条判据（新站点必登记 / kind 必须一致 / 登记不许过期）+ 登记表两档（triaged 逐处看过、pending 待看）与 **pending 棘轮（只许降不许升）**；本轮把逐条读过片段的 **94 处**落成 triaged，待分诊 ${PENDING} 处。门禁 `report-site-classification.test.ts` 5 条 + 变异 **9/9**；变异抓到判据自身两处毛病（key 撞车导致 7 处假的「通道漂移」⇒ 改 `文件::area::#n`；棘轮读 `_counts` 缓存可被绕过 ⇒ 改成从 sites 现算）。③**两处「发现」正名**：bootstrap 的「新库为空但旧库有数据 ⇒ 正在重建」（原 action）与 `eventLog.unknownType`（原 persist，横幅曾说「数据会丢」而事实是没丢）都改走 advisory。④**顺带修掉 mock 漂移**：改完第三处语气后 `migrate-guard` MG-4 从 migrated 变 skipped —— 不是守卫坏了，而是 14 个用例把上报通道整体 mock 掉、只实现两个 API ⇒ 新 API 抛 TypeError 被 catch 吞掉；补齐 mock + 新增 `persist-failure-mock-parity.test.ts`（PFP-1/2/3）。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；`tsc` 0；audit ${AUDITS} 项全绿（新增 audit:report-sites）。 |
| v1.16.136 | 2026-09-24 | **密钥「解不开」时说一声（关闭 O-16）** | 第 88 轮钻取确认：密钥解不开（换 Windows 账户/机器 ⇒ DPAPI 绑账户）时，这些 provider 实际**用不了**，而界面上**一条提示都没有** —— 只有控制台两行 `[secrets] …`，用户唯一能看到的地方是**主动**打开「设置 → 安全」。与「失败必须可见」的仓库契约冲突，属缺口。修法：决策逻辑抽到可单测的 `credential-startup-report.ts`，四种状态按语气归位：解不开 ⇒ **失败**（`凭据：本机解不开已保存的密钥` + 「请在这台机器上重新填写它们的 API Key」）、明文没封存成 ⇒ **失败**（说明仍是明文 + 建议轮换）、这台机器没有系统加密 ⇒ **提醒**、字节残留没回收 ⇒ **提醒**；**一切正常时零上报**，控制台日志一条不删。判据 `startup-credential-visibility.test.ts` 5 条（SCV-1…5，含「正常时不打扰」的反向对照与「App 必须真的调用它」的结构判据）+ 变异自证 **8/8**（含通道串位那类）。变异演练还抓到判据自身的毛病并已修：SCV-1 原来在测试里另抄一份文案 ⇒ 删掉源码里的「重新填写」测试照样绿；现在读**经事件通道产出的那句话**。**实测**：全量 ${FILES} 文件 / ${PASSED} 通过 / 0 失败；装机版 1.16.136 上重跑同一钻取，界面出现该提示条（改前没有），正常库启动零提示。 |
| v1.16.135 | 2026-09-24 | **把「发现」从「失败」里分出来（安全提示横幅不再说「请重试」）+ 失败那一侧的开头也修真 + 密文不再被说成明文** | 起点是**隔离钻取**：复制库 → 引擎 CLI 在副本上把 `apiKeySealed` 换成解不开的密文 → `CODEM_DB_PATH` 指向副本启动**装机版 1.16.134**，于是生产路径真的跑到「密钥解不开 + 凭据普查命中 + 自检发现新缺口」。印出来的原文：横幅「安全提示：设置里存在明文凭据：设置里存在疑似凭据 1 处。**该功能本次不可用，请重试或检查日志**。」、控制台「[PersistFailure] maintenance.invariantAudit.new **写盘失败**（第 1 次）：…—— 本次改动只存在于内存，重启后可能丢失。」——「不可用」（普查刚跑成功）、「请重试」（再跑还是同样发现）、「写盘失败」（没有写盘失败）、「改动只在内存」（没有改动）全是假的。①新增第三条通道 **advisory**（横幅 `提醒（area）`+建议、控制台 `[Advisory]`+warn、第三种颜色、次数后缀改「同类提示 N 次」），四个「发现」站点整条搬过去（凭据普查 / 自检新缺口 / 结构异常 / 索引落后已自动补回），真失败一个没动；②失败那侧给 **9 处**补真实 `title`+`consequence`，并让**控制台标签优先用 title**（以前日志前缀救不了）；③`credential-census` 的 `looksSealed` 放宽到「`dsh1:`+足够长的载荷（hex 或 base64）」，密文不再被说成「明文凭据」，同时保留 `dsh1:abc` 这种保守边界。判据：`persist-advisory-channel.test.ts` 7 条（ADV-1…7，含反向对照）+ CENSUS-6 + EVENT-TYPE-WRITES-8 加严；`mutate-advisory-channel.mjs` **11/11**（含「监听器只透传一处」、「把没跑成也搬去 advisory」这种过度归类）。**实测**：全量 **${FILES} 文件 / ${PASSED} 通过 / ${SKIPPED} 跳过 / 0 失败**；`tsc` 0；verify 0；audit 11 项全绿；钻取只写副本，真库 sha256 未变。 |
| v1.16.134 | 2026-09-24 | **同一类 fail-open 的系统扫描 + 沙箱开关修复 + 白名单闸门** | 承接第 86 轮的「问不到 ≠ 干净」：新增 `tools/audit/scan-fail-open-guards.mjs`（函数名像检查、而 catch 里 return false/null/[]/0）扫出 15 处，逐个定性：12 处能力探测（isGitRepo / isFile / isCLIInstalled / hasGithubToken…，失败⇒「没有这个能力」= 功能降级）、2 处读取型（isSessionEventsReadable / isAbortError / isAuthFileMissing，失败⇒「读不到」调用方会如实报错）、**只有 1 处是安全开关**：`isSandboxAclEnabled` 的 `catch { console.warn; return false }` —— 用户打开的沙箱在一次读失败后**静默失效**，设置面板开关**仍显示「已开启」**。修法：记住上次成功读到的值并在失败时沿用 + 失败走**上报通道**（`sandbox.readSetting`）+ 无历史值时按默认关闭但如实说明「界面开关不代表本次实际生效状态」。再把 14 处无害的**定性结果落成白名单**（`fail-open-guard-allowlist.json`，只许删不许新增）并接进 `npm run audit`（新增未定性 ⇒ 红；白名单过期 ⇒ 红）。门禁 `fail-open-guard-gate.test.ts` 5 条（FOG-1…FOG-5，含「沙箱不许回退」）+ 变异自证 `mutate-fail-open-gate.mjs` 6/6（真实仓库上塞回去再还原）。**实测**：全量 **376 文件 / 6087 通过 / 16 跳过 / 0 失败**；`tsc` 0；`npm run verify` 退出码 0；`npm run audit` **11 项全绿**；装机版 **1.16.134** 由更新器自己从 1.16.133 升上来，在**正在运行**的装机版里取回它实际加载的 `assets/main-*.js`，四项标志物全在、启动控制台 error/warning/exception **0**。**同一轮还做完两件仓库侧的事（不进安装包）**：① **O-14 结清** —— `_broken/` 里 4 个语法已坏的一次性脚本，逐个核对**它们当年想达到的效果是否落地**（7 项全在，`verify-quarantined-effects.mjs` exit 0）；踩坑记一笔：第一版拿脚本里的**原字符串**当针，报出 4 处「没落地」**全是假警报**（那段接线后来重构成 `ensureSecretsHydrated` 单飞入口 + 状态进 `secretStorageStatus()` + 界面显示「解不开几个」，效果还在、名字变了）⇒ **查历史动作要查效果，不要查实现细节**。② **陈旧文档** —— 设计体系文档历史波次清单里 **7 处**同时写着「（本轮）」（28/34/39/40/41/42/46 波），§7 标题写「第 45 波后」而它自己的表已引到第 52 波；清掉标记 + 写死约定 + 标题不再挂波次号 + 门禁 `docs-wave-freshness.test.ts`（DOCW-1a/1b/2 + 三个坏样本证明判据会红）。顺带记下**待确认**的新项 O-16（启动时「密钥解不开」只有 `console.warn`，用户可见面只有主动进「设置 → 安全」；本机没有「解不开」的真实数据可量）。 |
| v1.16.133 | 2026-09-24 | **「问不到」不再被当成「干净」：切换执行模式的防丢改动闸门原来有两层 fail-open** | 起点是第 85 轮走查的观察：点「切换执行模式」时工作区明明是脏的，却**没弹确认框、模式直接切走**（第 84 轮同一探针是弹了的）。翻代码找到两层：① `hasUncommittedChanges` 的 `catch { return false }` —— git 失败被汇报成「工作区是干净的」；② `TitleBar` 又包了一层 `catch { /* 检查失败则继续 */ }`。而这道闸门存在的唯一理由就是防止用户在脏工作区上切模式丢改动。修法：`hasUncommittedChanges` 改**三态**（true/false/**null=问不到**）且 null 走**上报通道**；新增纯函数 `decideWorktreeDirtyGuard`（**只有 false 才直接切**，true 与 null 都要先问，null 的问句如实说明「无法确认」）；`TitleBar` 删掉那层 catch；工作树列表里 `null` 按**有改动**处理。门禁 `worktree-dirty-guard.test.ts` 4 条（WG-3 的判据**限定在函数体内** —— 文件里 `isGitRepo` 也有 `catch { return false }`，那是另一回事）+ **4 处突变全被抓**。**实测**：全量 372 文件 / 6076 通过 / 0 失败；`tsc` 0。 |
| v1.16.132 | 2026-09-24 | **又修 10 处图标按钮 + 更正上一版的数字（扫描器第三类误报：会渲染文字的表达式）** | ①**自我更正**：上一版判定「去掉标签与 {…} 后没文字就算只有图标」，而 `{isZh ? '选择文件' : 'Choose File'}`、`{S.cicd.refresh[lang]}` 这类表达式**是会渲染出文字的** ⇒ 一批本来有可见文字的按钮被误报。修正后判定改为「表达式里的字符串字面量也算文字」。口径更正：上一版报 195 → 修完 39 处后 156，**修正扫描器后 ≈100 → 61**，本轮再修 10 处后 **51**（即「修掉的 39 处是真的，但「还剩 156」是虚的」）。②又修 10 处**逐个看过上下文才起名**的（移除此权限 / 删除这张卡片 / 新建分支 / 清除引用 / 移除附件 / 清空搜索 / 删除该笔记本 / 删除该来源 ×2 / 收起工作台），工具用**显式映射表**（文件+行号+期望 class 三者对上才改，不做按类名批量贴标签 —— 那会造出"读屏念关闭、屏幕写着取消"）。③棘轮基线 **156 → 51**（`icon-button-a11y.test.ts`，注释写明更正来龙去脉）。**实测**：全量 372 文件 / 6072 通过 / 0 失败；`tsc` 0。 |
| v1.16.131 | 2026-09-24 | **确认框在真机上一直弹不出来的真正根因**：注入的 `window.confirm` 指向**不存在的命令**（不是权限没配） | 第 84 轮走查（152 入口）只报 1 条控制台错误，而那一条掀翻了前面的结论：装机版点「切换执行模式」仍报 `Command plugin:dialog|confirm not allowed by ACL` —— 可 1.16.125 就加了 `dialog:allow-confirm`（能力清单里确实有，41 条之一）。**根因（读依赖源码逐字核对）**：`tauri-plugin-dialog` 2.7.2 的 init 脚本（`src/init-iife.js`）把 `window.confirm` 指向 `plugin:dialog|confirm`，而**同一个 crate 只注册 `open`/`save`/`message` 三个命令**（`generate_handler![…]`）⇒ 那个命令不存在，ACL 怎么配都不允许（`permissions/confirm.toml` 自己写着 `allow-confirm` 是 DEPRECATED、「now an alias to allow-message」）。也就是说 1.16.125 把「不问就做」改成「安全地拒绝」，但**弹框从来没弹出来过**（13 处不可逆动作变成「点了报不可用」）。**修法**：真机走插件 JS API（`@tauri-apps/plugin-dialog` 的 `confirm()` = `messageCommand(msg,{buttons:'OkCancel'})==='Ok'`，打的是**已注册**的 `plugin:dialog|message`）；优先级 = ①插件 JS API（真机）→ ②`window.confirm` 同步布尔（浏览器/用例）→ ③都失败则 fail-closed + 上报；①失败会**回退**到②再试一次。门禁 9→**11 条**（新增 NC-8 真机路径 / NC-9 alert 同源）。**实测**：全量 **372 文件 / 6072 通过 / 16 跳过 / 0 失败**。⚠️ 仪器后果：确认框真能弹之后，走查点那个入口会弹**系统模态框**（CDP 点不到、会挡住后续点击）⇒ 走查需排除这类入口；「最后一公里」必须由人工/用户完成那一次确认。 |
| v1.16.130 | 2026-09-24 | **图标按钮的可访问名：全部 31 个图标关闭按钮 + 折叠侧栏 8 个 + 扫描器自己的漏报修正** — ①先把**走查**用修好之后的度量重跑（152 个入口、控制台报错 **0**）："无名按钮"从 23 个面板降到 8 个，逐个看 HTML 只有三处纯图标关闭按钮（`.settings-close` 的 ProjectManager 那处、`.notebook-close-btn`、`.session-recovery-close`）。②再补**静态**规则全仓扫，结果发现**扫描器自己在漏报**：属性区用非贪婪正则 `<button\b([\s\S]*?)>` 截取时，`onClick={() => …}` 的 `=>` 带 `>` ⇒ 正则在箭头函数处截断 ⇒ 属性不完整、内容错位 ⇒ 报 55 处而真实是 **195 处**；另一个坑是拿整个属性区测 `/close/i`（`onClick={onClose}` 也算 close，一次匹配 41 个，其中还有写着"取消"的文字按钮 —— 贴 `aria-label="关闭"` 会覆盖它的名字）。③修了 **31 个图标关闭按钮**（`aria-label="关闭" title="关闭"`，只动只有图标的）+ **8 个折叠侧栏图标条**（名字取紧邻的 `<TooltipContent>` 表达式；Tooltip 不能替代可访问名：读屏不念 tooltip、键盘用户看不到 hover）。④门禁 `icon-button-a11y.test.ts` 4 条：关闭类严格 = 0、折叠侧栏严格 = 0、**其余只许降不许升的棘轮（基线 156）**、以及**给扫描器自己的反向对照**（带 `onClick={() => …}` 的按钮必须被扫到）；规则与审计脚本共用唯一实现 `tools/ui-audit/icon-button-scan.mjs`。**实测**：全量 **372 文件 / 6070 通过 / 16 跳过 / 0 失败**；`tsc` 0。 |
| v1.16.129 | 2026-09-24 | **走查的可访问性那一类：皮肤卡片键盘完全用不了（真缺陷）+ 头像预设名字不可区分 + 走查度量误报修正** — ①🔴 `SkinSelector` 的皮肤卡片原来是 `<div className="skin-card" onClick=…>`：**没有 role、没有 tabIndex、没有键盘处理** ⇒ Tab 跳不过去、Enter/Space 没反应，读屏也不念成控件（皮肤是用户能感知的功能，键盘用户却选不了）。修法：改成真正的 `<button type="button">`（语义/焦点/Enter+Space 由浏览器给出）+ `aria-pressed` 表达选中（原来只有 `active` 类名）+ 网格加 `role="group"` 与可访问名。②🟡 **纠正我自己的误报**：走查报「头像预设 50 个无名按钮」，回读 DOM 后发现名字来自子元素 `<img alt="preset">`（度量只看 `textContent` 所以看不见）——但「50 个按钮的名字**全是同一个无意义的 preset**」仍是真问题；修法：每个按钮给 `aria-label={预设头像 N}` + `aria-pressed`、装饰图 `alt` 留空，**并把度量也修了**（`audit-walk-lib.mjs::__name` 现在按 aria-label → aria-labelledby → title → 后代 `img[alt]` → textContent 取名）。门禁 `ui-a11y-skin-avatar.test.ts` 3 条（每条带反向对照）。**实测**：全量 **370 文件 / 6063 通过 / 16 跳过 / 0 失败**。 |
| v1.16.128 | 2026-09-24 | **提示框统一收口：15 处裸 `alert()` 迁到 `alertDialog()`（关闭 GAP-LIST 的 O-5）** — 与 1.16.125 修的 `confirm` 同源：dialog 插件把 `window.alert` 换成 `plugin:dialog|message`（真机取证 `function(i){n("plugin:dialog|message",{message:i.toString()})}`），它**返回 void** 且**失败时没有上报** ⇒ 弹不出来时用户看到的就是「点了没反应」，控制台只留一条 unhandled rejection。迁移 **9 个文件 / 15 处**（App 2、ClarificationForm 1、FlashcardViewer 1、MemoryManager 3、NotebookManager 2、NotebookWorkspace 3、PipelineNextStepDialog 1、SettingsPanel 1、TitleBar 1）→ `void alertDialog(...)`（失败进上报通道、横幅可见）。**刻意不迁**技能自带脚本 `src/core/skills/skill-creator/scripts/*.ts`（运行环境不保证有 WebView，套 dialog 反而是错的），边界写进门禁注释。新增门禁 **NC-6**（生产源码不许再出现裸 `alert(`；只扫调用）+ **NC-7**（弹不出来必须上报并带原文）；突变脚本扩到 **8 处全被抓**。**实测**：全量 369 文件 / 6061 通过 / 0 失败；**装机版核对**：1.16.127 → 1.16.128 走**真实更新器**完成（按钮 `检查更新 → 检查中… → 发现新版本 1.16.128，下载中…`，随后应用重启、版本变为 1.16.128）。 |
| v1.16.127 | 2026-09-24 | **更新下载会自己重试了，失败也会说人话（关闭 GAP-LIST 的 O-9）** — 起因是两轮实测都撞到同一件事：装机版点「检查更新」，按钮从 `发现新版本…下载中…` 变成 **`更新失败: error decoding response body`**；而同一条网络下独立 `curl` 下同一个 40MB 包，第一次在 **27MB** 处 `exit 56`，加 `--retry 3 --retry-all-errors` 才下全、sha256 与清单一致 ⇒ **包没问题，是网络会把长下载掐断**，问题在应用这一侧「一次失败就放弃 + 把 reqwest 原文印给用户」。修法（新增 `src/core/update/update-retry.ts`）：①**有界重试** —— 只对**可恢复**的传输类错误重试（白名单：`error decoding response body`（真机那一句）/`error sending request`/`connection`/`reset by peer`/`unexpected eof`/`timed out`/`502·503·504`…），最多 **3 次**、退避 **800→1600ms**、次数**硬性夹到 5**（传 999 也只 5 次），下载期间界面显示「**下载中断，正在重试（第 n/3 次，等了 Ns）…**」；②**签名/校验类一次就抛**（`signature`/`verif`/`public key`/`checksum`/`permission`/`403`/`404`/`malformed`）—— 重试没有意义，还会把「发布坏了/可能被改」稀释成"网络不好"；**不认识的错误默认也不重试**；③**错误可读** `describeUpdateError()`：原因 + 下一步 + **保留原文**（「网络把安装包下载掐断了（传输未完成）—— 请重试；若反复失败，可到 GitHub Release 手动下载（原始信息：error decoding response body）」），签名类明说「重试没有用」并请用户反馈原文；④次数用尽后**抛出最后一次的原始错误**（不包装，否则丢掉 `isRetryable` 需要的特征）。门禁 `update-download-retry.test.ts` **7 条** + **6 处突变全被抓**；**两处判据本身的缺陷是突变验证逼出来的**（① 只测纯签名串 ⇒ 「删掉签名排除」照样绿，**当时根本没在判优先级**，现补"同时含签名与网络特征"的混合串；② 组件接线只判「文本里出现过」 ⇒ 改成 `if (false) await downloadWithRetry(...)` 照样绿，现锚在**行首的 `await`** 上）。**装机版核对（1.16.127）**：「检查更新」给出 `检查中… → 未发现更新（当前 v1.16.127）—— 更新清单已读到…`、控制台 error **0**；修复确实进了包（`dist/assets/main-*.js` 含 `下载中断，正在重试`，且安装包构建时间 14:37:38 **晚于** dist 14:34:48）。⚠️ **重试的真机端到端没跑到**（装的就是最新版、清单里没有更高版本）⇒ 已登记 O-13，留到下次有可升级版本时观察。**顺带修**：`check-update.test.ts` 的 UPD-6 那个「从按钮往后截 4000 字符」的窗口被这次改动撑爆（处理函数变长了）⇒ 放宽到 9000 并加「必须截到 relaunch()」的覆盖性断言（是判据的锅，不是代码坏了）。 |
| v1.16.126 | 2026-09-24 | **走查第二阶段：右侧面板补上（第一轮「容器不在」= 一个都没量到）+ 上下文面板自相矛盾（21% 却「即将满」）+ 长跑稳定性有了门禁** — ①🔴 **上下文面板同一屏两个结论打架**：装机版实测 `23,678 / 115,200 tokens 21%` 紧跟着 `压力等级 临界` + `🔴 上下文即将满！请立即压缩或开启新对话`。根因是**同一件事被两套口径各算一遍**：进度条用模型侧口径（可见 → 裁剪陈旧工具结果 → 按优先级选进「真实窗口 × 0.9」），压力等级却另调 `getPressureLevelFromMessages(可见消息)`（**自己另算分母**、**不裁剪不选择**）—— 与 1.16.123 修的「概览卡 vs 委派页签」同一个病。修法：阈值收成唯一实现 `pressureLevelForRatio`（0.5/0.7/0.9）+ 新增 `summarizeDisplayPressure(used, available)` 把**百分比与等级**从同一对数字导出，`ContextMonitor` 的 `pressure` state 与两处 `setPressure` 整个删掉；门禁 `context-monitor-pressure.test.ts` 5 条 + **5 处突变全被抓**。**装机版核对（1.16.126，同一套探针）**：同一会话同一组数字现在是 `21% ⇒ 压力等级 正常`、无告警条（改前是 `21% ⇒ 临界 + 即将满`）。②🟡 **右侧面板补走查**：第一轮按容器找入口，而 `.right-rail`/`.panel-sidebar` 当时不存在（报告里就是「容器不在」），入口其实在**聊天头部的 `.agent-toggle`**（`ChatPanel.tsx:650-691`）。补走结果：智能体与团队 ✓（`agent-panel` 35 字）/ 快照 ✓（1812）/ 上下文监控 ✓（147，抓出上面的缺陷）/ 执行轨迹 ✓（893）/ 侧边面板 ✓，五个页签 Git 74 / **文件 1117** / 变更 45 / 工作台 60 / CI-CD 39 —— **无一处控制台报错**。③🟡 **长跑稳定性门禁**（目标里的「内存与句柄不涨」）：新增 `.preview-shot/stability-longrun.mjs`，连续采样堆/DOM/工作集/**句柄数**/进程树，比较前 1/3 与后 1/3 中位数并设绝对上界，**没有负载直接判失败**；实测 8 分钟 / 19 采样 / **114 次面板切换**：堆 41→42MB、DOM 844 恒定、句柄 362→364、进程树 1266→1282MB ⇒ 通过（⚠️ 脚本注释写明它**证明不了**「跑一夜不漏」）。④📋 如实记录：**看板拖拽测不到**（七列全部渲染、每列都有「拖拽 Issue 到此列」提示，但每列 **0 张卡**、`draggable` 元素 0 个 —— 本机没有 Issue，已登记 O-11 附关闭条件）；**更新器本轮又栽在本机网络掐断**（`更新失败: error decoding response body`，两次尝试都失败，最后用构建产物直装完成装机版核对）。**四个仪器坑**（都写进注释）：`[class*="board"]` 会匹配 **SVG 元素**（把图标当看板容器）；同一屏两个「文件」（侧边页签 vs 标题栏菜单，第一版点错菜单、读数因此是假的）；面板标题要用源码真实字符串（「上下文监控」）；**探针差点拖到侧栏会话行**（`[draggable=true]` 抓到会话行，放开会调 `reorderSessions`）—— 事后核查**无改动**（三个会话 `sort_order` 全 0），现在只允许拖看板容器内的卡片。**实测**：全量 **368 文件 / 6051 通过 / 16 跳过 / 0 失败**。 |
| v1.16.125 | 2026-09-24 | **按"执行四项建议 + 真机面板走查"收口：确认框根本没弹、不可逆动作照做（走查抓到的真机缺陷）+ 反馈唯一写路径（引擎侧也删）+ 覆盖率棘轮 + 唯一缺口清单 + knip 棘轮** — ①🔴 **真机走查 100 个入口**（外壳 19 + 设置页签 56 + 任务中心页签 25）抓到：点标题栏「切换执行模式」时控制台报 `[Unhandled Rejection] Command plugin:dialog\|confirm not allowed by ACL`（报告 `docs/ui-walk-round72.md`、原始数据 `.preview-shot/ui-walk-r72.json`）。只读取证读到 `window.confirm` 的真身是插件调用（`async function(i){return await n("plugin:dialog\|confirm",…)}`）⇒ **两个根因叠加**：dialog 插件把 `window.confirm` 换成异步调用（返回值 **Promise 恒为真**）⇒ `if (!confirm(x)) return;` **永远继续执行**；`capabilities/default.json` 只写 `dialog:default`，实测**不含** confirm ⇒ 调用被 ACL 拒。影响面清点 **13 处**（删项目/清恢复数据/删工作树/回滚快照/回滚文件改动/卸载 zvec/删智能体/删 Profile/恢复 PPT 版本/覆盖演讲稿/切换执行模式/游戏投降/重置界面设置），全是不可逆动作。修法：新增 `src/core/ui/native-dialog.ts`（`confirmDialog`/`alertDialog` 对"同步布尔"与"thenable"两种世界都给对答案；**问不到一律按取消** fail-closed，并用 `options.consequence` 写**界面**那句而不是只进控制台的 `extra`）+ 13 处改 `await confirmDialog(...)` + 能力清单显式放行 confirm/message/ask；门禁 `native-confirm-dialog.test.ts` 7 条、**6 处突变全被抓**。⚠️ 诚实标注：修好后点那个按钮会弹**系统模态框**（CDP 点不到、留着会卡住用户窗口）⇒ **"弹框真的弹出来了"没有在装机版端到端量过**。②🔴 **反馈只剩一条写路径**：删掉渲染侧 `saveFeedback`/写穿缓存，**并把引擎侧 `feedback.set/get/delete` 三条专用命令也删除**（命令清单 + 派发分支 + `config.rs` 三处都不留），`message_feedback` 只走通用 `crud.*`；引擎用例改写为 `message_feedback_goes_through_generic_crud`；门禁 6 条 + **7 处突变全被抓**。③🔴 **覆盖率阈值从来没生效过**（provider 未装 ⇒ `test:coverage` 直接 `MISSING DEPENDENCY`）：装上 provider + `tools/audit/coverage-baseline.mjs`（打印 / `--check` 对账 / `--md` 写基线）+ 先量后定棘轮（行 52 / 函数 46 / 分支 42 / 语句 50，另按目录 存储 81 / LLM 60 / 会话 74 / 诊断 96），接进 `verify`；⚠️ 第一版拿行覆盖率顶替语句覆盖率，第一次真跑就红（实测语句 51.27% vs 行 53.66%）—— `--check` 现在四个指标一个都不放过。④🔴 **`verify` 里的 knip 一直是红的**（32 未用文件 + 348 未用导出 + 222 未用类型 + 13 组重复导出；第 62 轮分诊过但**决定没写进配置**）：分诊结论写进 `knip.json` 的 `ignore`（逐条列 ⇒"未使用文件"期望值 **0**，再出现就是真发现）+ 其余做棘轮（`tools/audit/knip-gate.mjs` + `knip-baseline.json`）；顺带修 `knip.json` 两个真错（入口写成 `src/pet.tsx`、`tasklist` 未登记）。⑤🟡 **当前缺口只有一份清单**：40 份计划/缺口类历史文档加「历史文档（不再维护）」横幅并指回新建的 `docs/GAP-LIST.md`；`PROJECT-GUIDE.md` 不再把 `TODO.md` 说成"✅ 最新 / 当前待办的入口"；门禁 `docs-current-gap-list.test.ts` 5 条 + **5 处突变全被抓**。⑥🟡 走查另外逐条列了三类现象的**样本**（无名按钮：头像候选 `button.sp-avatar--sm` 每页 40–50 个无 `aria-label`；小命中区 28 个面板有读数，典型 `INPUT 13×13`；被遮挡控件 71 个面板有读数但**多数是 sticky 头**）—— **没有**当场改 CSS，因为"看一个数字就改"正是以前的教训。**仪器三坑**（全写进注释）：权限弹窗是独立 page target（`edge://permission-request-dialog/`，旧判据会连到它身上并报出假缺陷）、页签是 `[role=tab]` 不在旧点击池里、页签列表第一个是「关闭设置」（照单全点会把面板关掉再全部报"找不到"）。**实测**：全量 **367 文件 / 6046 通过 / 16 跳过 / 0 失败**；Rust 引擎 **146 通过**；`npm run audit` 10 道全绿；覆盖率 行 53.67% / 分支 43.97% / 函数 47.34% / 语句 51.27%。 |
| v1.16.124 | 2026-09-23 | **按审计报告的建议把剩余问题全部解决**（报告顶部已加状态表；本轮 20 条新用例 + 16 处突变全被抓）— ①🔴 **读侧与写侧不对称**（这两轮所有 bug 的总根因）：写侧早有"就绪后重放"（`deferWrite`），读侧没有对应机制 —— 新增 `DomainReadOpts.onReady` + `onceDomainReady`（**只对"本次读时未就绪"的表回调一次**；已就绪不回调以免"读→回调→再读"成环；返回退订、同表待发有上限并如实告警）+ `useDomainReady` hook，把 9 处"打开对象后才读、读完就不再管"的读点接上（`issue_comments` / `note_links`+`note_versions` / `graph_nodes`+`graph_edges` / `notebook_sources`+`notebook_chunks` / `squads`+`squad_members` / `message_feedback` / `inbox` / `todo_lists`）。②🔴 **侧栏「会话未读徽标」原来是死代码**（读 `session.unreadCount`，而该字段全仓无写入点、`sessions` 表无此列、Rust 侧也没有 `unread_count`）：新增 `core/session/session-read-state.ts` 的**已读水位**（存 settings —— 唯一允许进内存镜像且读同步的配置面），未读 = 现在条数 − 水位；**一次性迁移**把此刻已存在的会话标记已读（否则本机 657 条那个会话升级后会顶一个 657 的徽标），迁移后**新建**会话从 0 起算 ⇒ 委派出去的子会话有新消息看得见；正在看的会话由 `ChatPanel` 持续推进水位（含 5 秒兜底：最后一条消息落库可能晚于 effect），侧栏轮询**先刷新会话列表**再算（第一版按旧快照算 ⇒ 真机实测 0 个徽标）。③🔴 **聊天里的待办面板同样是死代码**（`setActiveTodoId`/`setActiveTodos` 全仓零调用）：`show-todo.ts` 新增 `latestTodoListForSession`（三态 ok+list / ok+null / **unavailable**，沿用该模块 C-5 的"读不到 ≠ 没有"纪律），`ChatPanel` 灌进 state 并挂"就绪后重读"。④🔴 **`list_sessions` 现在列跨作用域会话**（原只列当前作用域 ⇒ 从全局会话发起委派时 agent 看不到任何项目会话，真机核对时只能手打 id）：当前作用域 + 另一侧作用域，每条标 `scope=`，按 id 去重。**顺手修掉**：`onceDomainReady` 第一版在**两处登记**同一回调（靠 Set 去重才没变成回调两次）—— 突变验证把 `domainMirror` 里那处去掉后 READY-1 仍绿，才暴露；现在登记只有一处。**装机版真机核对**：一次真实委派后侧栏对**子会话**显示「5 条新消息」（水位 0 / 库里 5 条）、**正在看的会话无徽标**，水位表与库里条数逐条对得上；切到含 `todo_lists` 行的会话后聊天里出现「待办事项」面板并列出真实条目。⚠️ 两条仪器坑（写进脚本注释）：探针按标题找"对话 1"会点到**全局区**同名会话；点项目标题是**切换**展开状态，已展开时再点会收起 —— 两次都量出过"待办面板不存在"的假结论。门禁：`domain-ready-reread` 7 + `session-unread-badge` 8 + `audit-followups-todo-and-list` 6；`tsc` 0；UI 门禁 823 文件 0 错 0 警。 |
| v1.16.123 | 2026-09-23 | **顺着 1.16.122 的同类审计：又找出 5 处，修掉 2 处、如实报告 3 处**（报告全文 `docs/audit-2026-09-23-boundary-class.md`）— 方法：**先枚举形态、再读代码、最后真机对照**（工具 `audit-boundary-patterns.mjs` 四类形态枚举 / `audit-ctor-reads.mjs` 构造函数里读存储 / `probe-panels-vs-db.mjs` 界面 vs 库对照）。④🔴 **同一事实两处显示、口径各写一遍**：修完委派页签后在装机版上立刻量到同一屏两个答案 —— 概览卡 `0 已完成` vs 委派页签 `3 已完成`（根因不是哪处算错，而是过滤条件被各写一遍）；修法是把口径收成**唯一实现** `task-center/delegation-scope.ts::scopeDelegations`，门禁 `DELEG-4`（三态语义）+ `DELEG-5`（**同时渲染两个面板**逐栏比对各自算出的数字）。⑤🔴 **首屏会读的小表没预取**：`loadFeedback` 是同步接口、每条消息渲染读一次镜像且 effect 依赖 message.id（**每条只读一次**），而 `message_feedback` 不在预取清单 ⇒ 打开会话时历史消息的赞/踩显示成"未评价"且**没人再重读**；已加进清单（表极小），门禁 `DELEG-6`，清单注释里写明**哪些表故意不预取**及理由（`notebook_chunks` 每行带 embedding，预取会顶爆启动内存）。**如实报告 3 处（没有顺手糊）**：① 两处"有界面、没有数据源"的**死代码** —— 侧栏会话未读徽标（`session.unreadCount` 全仓无写入点、`sessions` 表无该列、Rust 侧无 `unread_count`）与聊天里的待办列表（`setActiveTodoId`/`setActiveTodos` 只出现在自己的 useState 声明处）—— 都不是"过滤条件写错"而是**能力缺失**，半做即是本次在治的病，建议各开一轮按功能做；② **读侧与写侧不对称**（本轮 bug 的总根因）：写侧早有"就绪后重放"（`deferWrite`，A-1 首触必丢的修法），读侧**没有**"就绪后重读"通道（`DomainReadOpts` 只有 `maxRows`），扫描 **36 处** `domainReadMany/One` 附近无 `undefined` 判据，之所以只炸一处是因为**只有"读一次就缓存"的调用方才会永久空**（扫构造函数/单例只命中编排器那处），报告里逐表列了风险与下一轮做法（补 `onReady` 重读通道）；③ **agent 侧同族**：`list_sessions` 只列当前作用域 ⇒ 从全局会话发起委派时 agent 无法发现目标会话（真机核对时只能手输 id）。**顺手核对确认没问题的**：记忆面板（库 1 行 JSON 装 18 条 → 界面 18 总计）、知识笔记本（8 来源 / 26 块一致）、智能体面板（表空 → 只列内置）、收件箱与委派（1.16.122 修复后与库一致）。门禁 `inbox-visibility.test.tsx` 13 条 + **11 处突变全被抓**；`tsc` 0；全量 **360 文件 / 6001 通过 / 16 跳过 / 0 失败**。**装机版复核**：概览卡由 `0 已完成` 变为与委派页签一致的 `3 已完成`（同一屏两个答案消失）。两条仪器经验：判据要落在**正确的容器**上（概览页 Issues 卡里也有"已完成"，对整页文本做正则会造假警报）；仓库文件**换行符不统一**，多行判据需按文件自身 EOL 匹配。 |
| v1.16.122 | 2026-09-23 | **任务管理的三个"看不到"（用户报：徽标 4 条 / 收件箱空、要等十几分钟才出现、重启后没了）** — 先在**装机版**用只读探针量现场：侧栏徽标 `任务管理（4 条未读）`、收件箱页签 `emptyText=尚未选择项目 / 一条都没有`、概览卡 `收件箱 0 未读`、委派页签 `0 总计` + "尚未选择项目，委派任务按项目隔离"、当前无项目；查库：`inbox` 正好 **4 条未读且 `project_id` 全 NULL**、`delegation_tasks` 5 条（`project_id` 为空串）⇒ **三个不同的 bug，症状都是"东西在库里、界面上没有"**。①🔴 **徽标与收件箱口径打架**：委派完成/失败、自动化、定时提醒写的是**全局通知**（`project_id` NULL/空串，与项目无关），而 `InboxTab` 写的是 `if (!pid) { setItems([]); setTotalUnread(0); return; }` —— 无项目时整个列表清空；徽标 `getUnreadCount()`（不带边界）数到 4、页签 0、概览卡还给了第三个答案（`projectId ? … : 0`）。修法：把 `projectId` 写成**显式三态**（`undefined` 不设边界／`null` 只要全局／字符串 = 该项目 + 全局），页签不再清空、空态文案如实说明"这里显示的是全局通知"；顺带修掉无项目时「全部已读」`if (!pid) return;` 点了没反应（改成只清全局）。⚠️ 真机核对时又见**第三种写法** `project_id = ""`：`params.projectId ?? null` **不会**把空串换成 null（空串不是 null），只认 null 的判据会让这种行变成幽灵（数得到、看不到）—— 现在三种一律算全局。②🔴 **委派任务被项目边界挡住**：`DelegationTab` 同为 `projectId ? filter(...) : []`，而**从全局会话发起的交接（`task.projectId` 空串）不属于任何项目** ⇒ 用户交接出去的 4 个任务一条都看不到。同一套口径修掉（无项目列全局委派；跨项目串数据 P2-12 不变）。③🔴 **重启后委派历史补不回来**（机制完全不同）：页签读**编排器内存**，内存只在**构造时**补一次（`restoreFromDB`），而 `delegation_tasks` 的域镜像**不在 `HOT_DOMAIN_TABLES` 预取清单里** ⇒ `domainReadMany` 返回 undefined ⇒ 存储层吞成 `[]` ⇒ 构造那刻补到空且**没人再试一次**（`HOT_DOMAIN_TABLES` 注释里写的正是这个坑："漏一张…掉进'首次渲染读到空、之后没人重读'的坑"）。修法：补齐做成**幂等+可重试**（`hydrateFromStorage`，读路径 250ms 窗口重试、补到后降到 30s 低频；被中断任务的上报只写一次）+ 把该表加进预取清单。门禁 `inbox-visibility.test.tsx` 10 条 + **9 处突变全被抓**；⚠️ 仪器坑：仓库文件**换行符不统一**（`DelegationTab.tsx` 是 CRLF），多行判据里的 `\n` 匹配不上会把变异报成"找不到判据"（貌似脚本问题、实际判据没生效），现按文件自身 EOL 匹配。**装机版前后对照**：收件箱 0 条 → **4 条全部列出**；概览卡 0 → **4 未读**；委派页签 0 总计 → 全局委派条目列出；徽标两版都是 4（口径没变）。 |
| v1.16.121 | 2026-09-23 | **"页面白屏 / 页面已崩溃"这类崩溃从此必须留下证据（本次它一点痕迹都没有）+ 有界自动恢复** — 用户报："主对话里 agent 调 `wait_for_delegation` 后十几秒，**窗口还在但页面白屏**"。这是 **WebView2 渲染进程**死了，而事后**一条痕迹都没有**：`codem-crash.log` 不存在（那是 Rust panic hook 写的）、运行时日志无异常、Windows 事件日志无 `codem.exe` 记录（崩的是 `msedgewebview2.exe`，而**被 OOM 杀掉**时连事件都不写）、`EBWebView\Crashpad\reports` 是空的（OOM 不是段错误，不产生 dump）⇒ **那次崩溃不可归因，只能靠"用户说白屏"来猜**。本版把三路证据补齐：① **WebView2 `ProcessFailed`** → 运行时日志（失败类型 / 原因 / 退出码 / 出问题的进程 / **出错模块路径**，同一行附进程树内存）；② **前端心跳每 20 秒**（JS 堆 / DOM 节点数 / 消息数 / 是否在跑回合 / 存活秒数）+ Rust 侧在同一行补**本进程与所有 `msedgewebview2.exe` 的工作集** —— 渲染进程被 OOM 杀掉不留 dump，**最后一次心跳就是它死前的水位**；③ `window.onerror` / `unhandledrejection` / `pagehide` / `beforeunload` → 运行时日志（打包版里这些原本只进控制台）。另补：`ExitRequested` 记下 **`frontend_quit_requested`**（区分"用户点的退出"与"系统关机/外部结束"，此前两者在日志里长得一样）、`RunEvent::Exit`、窗口 `Destroyed`。**有界自动恢复**：渲染进程退出/无响应 ⇒ 自动重载（会话在磁盘上，重载即恢复），预算硬性 10 分钟 3 次（`decide_reload` 纯函数 + 边界单测），超出停手并记原因 —— 否则"加载即崩"会变成崩溃—重载死循环。**用户告知**：Rust 落一次性崩溃标记，重载后前端弹常驻提示（`crash.renderer-process`）并带上可转述的判据行（此前"白屏一闪自己恢复"用户完全不知情 ⇒ 既不会反馈也永远查不清）。**真机核对**（装机版，真打一次再查）：CDP `Page.crash` 主动打死渲染进程 → 留下 `kind=RENDER_PROCESS_EXITED(1) reason=CRASHED(3) exit_code=-2147483645 … total=493MB` + `自动重载页面（第 1/3 次）` + 下一条心跳 `uptime=0s`（页面确实恢复）；界面常驻提示经 DOM 复核（`.persist-alert.is-action`）带着同一行判据；连打两次都恢复（1/3→2/3）。**委派等待压测 3 轮**（真实 delegate+wait，每轮 2 个新会话）**没有复现崩溃**：pid 未变、JS 堆 42→52 MB、进程树 617→598 MB、DOM ~500 节点；**大会话压测**（切到 2.66 MB / 657 条消息的会话）DOM 595、堆 46 MB、40 秒平稳 —— 并**如实标注**：该会话只渲染 2 条消息（有消息窗口化），所以没复现"重 DOM"条件。⚠️ **诚实结论：原始崩溃没有复现**；本版交付的是"下次崩了必定留证据 + 白屏自我恢复 + 用户能看到发生了什么"。两个仪器坑：① `Page.crash` 后渲染进程没了、某些 CDP 命令永不回包，第一版 `await` 卡死 5 分钟什么都没量到（现在一律带超时）；② 验证脚本判据第一版写成等 `window destroyed` —— **错的**，渲染进程崩掉时 WebView2 不销毁窗口（用户现场正是"窗口还在"），判据写错会把"已修好"报成"缺证据"。 |
| v1.16.120 | 2026-09-23 | **用户报的两条控制台红字：`UNIQUE constraint failed`（同一行并发写）+ `saveText failed`（溢出策略在打包版里从未生效过）** — ①🔴 `数据保存失败（telemetry.flush / delegation.createDelegationTask）：UNIQUE constraint failed: ….id` **不是丢数据**：两行数据都在库里，是**同一行的两次写抢在了一起**。引擎写有两种语义 —— `mode:"insert"` 是裸 INSERT（主键冲突即报错）、`mode:"replace"` 是先 UPDATE 再 INSERT（幂等）；而 `delegate()` 的 `createDelegationTask`(insert) 与 `startTask`→`updateDelegationTaskStatus`(replace) 是**并发**发出的，后者先落地时前者的裸 INSERT 必然撞主键（统计那条同理：写穿用 insert、`trackShard` 用 replace 探针）。修法：渲染进程写入口给**同一 (表,主键)** 的引擎写按调用顺序串行（`domain-store.ts::serializeEngineWrite`，**首条同步发出**以保住"写完立刻可见"，仅同键有在途写时才排队），统计写穿改 `mode:"replace"`。**突变验证**：去掉串行化 → **原样复现用户贴的那句报错**；门禁 `write-order-race.test.ts` 5 条（延迟引擎桩下 insert/replace 抢行、真实委派路径、统计幂等、不同行**不**串行）。⚠️ 途中一次回归：一开始让**所有**引擎写推迟一个微任务 → 两条"同 tick 可见"门禁（`STOR-015`/`Y3-1`）立刻红 ⇒ 改为"首条同步、后续排队"+ `__awaitPendingWrites()`。②🔴 `[spill-policy] saveText failed for bash: (void 0) is not a function`：`llm/spill-store.ts` 用了渲染进程里**不存在**的 Node `fs`（被 vite 映射到 `src/stubs/*` 空壳，连 `mkdtempSync` 都没有）⇒ **主循环的溢出策略在打包版里从未成功过一次**。更根本的是**同一件事有两套实现**（`core/storage/spill.ts` 那套一直好的，只有中间件走的是坏的），所以**删掉重复实现**：中间件只做决策（WHEN：上限/跳过 read/跳过错误/best-effort 降级），写盘+预览+说明全部委托 `retainToolResult`，`llm/spill-store.ts` 删除；顺带去掉 `Buffer` 依赖（改用统一 `utf8Length`），落点与 `pruneSpillFiles` **同目录同命名**。门禁 `spill-policy-delegation.test.ts` 6 条（**不 mock 存储**：用文件 API 参数反查"写下去的是全文、原子写、定位符指向真实文件、说明行的省略字节数诚实"）+ 唯一实现守卫；**5 处突变全被抓**。③🔵 `startTask: … is already running` 降级为 debug（`delegate` 的 autoStart 与执行器各标一次是正常路径），终态二次标注仍 warn。④🔴 **真机核对时量出来的第三个缺陷：工具调用的 id 一路是空的** —— 驱动真实回合让 bash 产出 40000 字节，溢出文件确实落盘（40022 字节）但名字是 `bash--1790131192728.txt`（调用 id 为空）。根因：`agentic-loop.ts` 的工具处理器返回的 `ToolCallResult.id` **一直是空串**（`id: ""` 是字面量，全仓 6 处），而处理器签名 `(name,args,ctx)` 里没有调用 id ⇒ 管线之外读 `result.id` 的地方全是空，包括 `EventLogFinalizeMiddleware` 写进事件日志的 `tool_call`/`tool_result` 的 **`toolCallId`**（事件日志是"执行轨迹/事后复盘"的数据源）。修法：不动处理器签名，`streaming-executor` 每次调用管线时注入 `ctx.toolCallId = tc.id`（`ToolExecutorContext` 新增可选字段），读取方 `result.id || ctx.toolCallId`；溢出文件名加防御（缺 id 不留悬空连字符，且仍满足清理器判据 `-<毫秒>.txt`）。门禁 `tool-call-identity.test.ts` 6 条（走真实执行器验证 ctx 拿到 id、事件日志不再是空串、`result.id` 优先、两处都空时如实写空串不编造、溢出文件名用真实 id、缺 id 时仍被清理器认得出）+ **4 处突变全被抓**。 |
| v1.16.119 | 2026-09-21 | **分节线按用户逐状态选定的形态落地：平时只留白、鼠标移上去才长线** — 用户在对照页里分状态给答案（"不移上去：候选 D（不要线）；移上去：候选 C"）。落地形态是**两支候选的并集**：间距恒定取 D 的 `2em`（若两态各照搬 1.5em/2em，悬停瞬间一屏十几条线会让内容上下跳 0.5em），悬停时**只多画一条线**（5% 结构分隔线档 + 左右各内缩 24px + 两端各渐隐 8%），内缩画在**伪元素**上而不是改 `<hr>` 的 margin。线靠 `.rich-content-hr::after` 的 **opacity** 切换（`background-image` 的渐变不可插值 ⇒ 直接切会跳；opacity 可过渡 ⇒ **淡入**，走 `--transition-opacity` 并受全局 `prefers-reduced-motion` 兜底），悬停目标 `.rich-content:is(:hover, :focus-within)` 顺带覆盖键盘焦点。**真机复量**（装机版、`Input.dispatchMouseEvent` 发真实鼠标移动）：移开 `opacity=0`、移上去 `opacity=1`、渐变 `rgba(31,31,30,0.05)` 停靠 8%/92%、`::after` 左右各 24px、`<hr>` 与其后第一个兄弟元素两态位置逐像素相同、间距恒定 28px —— **8 项判据全通过**。⚠️ 过程中被真机量出**两个仪器坑**（都已写进脚本注释）：① 探针挑"第一个 `.rich-content-hr`"时它滚在视口上方（top=-46）⇒ 鼠标落在屏幕外，`opacity` 假失败；② 改取"线往上 14px"又被列表顶部的 `div.load-more-indicator` 浮层盖住 ⇒ hover 落在浮层上；现在逐个候选点用 `elementFromPoint` 验证落点。③ Chromium 把 `transparent` 序列化成 `rgba(0, 0, 0, 0)`，断言只认字面量会假红。门禁 `LIGHT-UI-2c` 重写为四段（平时不画线／悬停线走分隔线档+渐隐+内缩在伪元素／**悬停规则只许改 opacity**（出现 margin/padding/height/width/left/right/top/bottom 即红）／无暗色硬编码覆盖）+ **两处突变验证**（退回控件边框档 → 红；内缩挪到悬停 margin → 红）。 |
| v1.16.118 | 2026-09-21 | **回复"分节线"精修 + 控制台留痕整理 + 清掉我自己注入的诊断探针** — ①🔴 用户报"主对话里一问按节回复，节与节之间那条线太粗糙"：装机版实测到 `<hr class="rich-content-hr">` **共 23 条**，形态是 `background: var(--border-primary)`（**控件边框档**，亮色 9%、白底对比度 1.194）、**宽 = 整个正文列 758px、左右内缩 0**（两端硬切），暗色档另有**手写 16% 白覆盖**（亮色的约 1.8 倍、且绕过令牌）。改法：浓度走 `--border-separator`（亮 5% / 暗 6% 白）+ **两端各渐隐 10%**，高度仍 1px、外边距不变，删掉暗色硬编码覆盖 —— 与工具卡片/回合分隔线的"两端渐隐"同一手法、同一档。门禁 `LIGHT-UI-2c`（4 条断言）+ **突变验证**（改回全宽 9% 硬线 → 红）。②🧹 **控制台那条红字是我自己造成的**：上一轮为做改前/改后对照往本机真实库注入了两行诊断事件（`trajectory_step` + 故意编造的 `zzz_definitely_unknown_probe_68`），后者每次维护都会产生一条结构异常；已**先备份整库**、用 `node:sqlite` 只删这两条 seq（类型白名单校验）、引擎 `integrity` 复核 ok、事件行数 6670→6668。③🧹 **例行空间回收的留痕不再带 8 行调用栈**（用户贴的启动日志里 4 条 `[StorageTrace]/[IpcTrace] storage.compact` 各带 8 行栈，看着像报错）：口径收口到唯一实现 `formatDestructiveTrace` —— 例行命令（compact）单行、可能删数据的命令（delete/replace_table）保留栈 + warn、开 `codem-debug=storage-trace` 后例行命令也带栈；门禁 `storage-trace-quiet.test.ts` 1–3 + **突变验证**（判据改恒真 → 红）。**实测**：`tsc` 0；**355 文件 / 5958 通过 / 16 跳过 / 0 失败**；UI 门禁 error 0 / warn 0；CSS 契约 2734 个类（快照已刷新）；装机版复量分节线计算样式由"全宽 9% 硬线"变为"两端渐隐的分隔线档"。⚠️ 无目视核对（模型不能读图）：线条的取舍另附对照页（`.preview-shot/ui-lab/section-line.html`，含 3 个候选形态）供用户挑选。 |
| v1.16.117 | 2026-09-20 | **过程条目线条精修（承接 1.16.115）+ 一次自我更正 + 审计工具三处假绿修正** — ①🔴 **上一版把"回复过程条目改时间轴竖线"写在了 `.tool-item` 上，而全项目没有任何 TSX 渲染这个类**（TSX 里的 `tool-item` 全是 `sidebar-tool-item`/`agent-tool-item` 的**子串**）⇒ 改完界面零变化，用户当场反馈"为什么没看到 S2 时间轴"。查清真实结构：一条工具调用是**带外框的圆角卡片** `.tool-card`（头 `.tool-card-head` + 多行 `.tool-card-row`/`.tool-io-section--bordered`/`.tool-pill-detail-section`），一叠卡片**内联换行**（`.tool-group-body-inline{flex-wrap:wrap;gap:4px}`）—— 竖线在这个几何里本就不成立，已撤掉；改为把"流线型"落在**真的在画线**的 **3 处**：`.tool-card-head` / `.tool-card-row` / `.tool-io-section--bordered` 的全宽 9% 硬线 → **左右内缩 `--space-2`、两端渐隐的 1px 发丝线**（浓度走 `--border-separator`），并加 `:not(:last-child)` 边界（`TerminalBlock` 无输出时头部就是最后一个子元素，否则发丝线会贴到卡片下边框上又成两条平行线）。🔵 **同类第 4 次"看起来生效、其实匹配不到"**：`.tool-pill-detail-section + .tool-pill-detail-section`（"详情段之间的分隔线"）**恒不成立** —— 那个类只由 `WebSearchResultCard` 渲染、一张卡片里永远只有一块，相邻选择器无从成立；我一度把它也算进"过程条目线条"改成渐隐 `::before`，核对渲染点后**连原规则一起删除**并在 CSS 里写明判据（口径更正：3 处，不是 4 处）。②🔴 **成因是审计工具三处假绿**（`scan-ui.mjs` 的 `css-class-unused`）：**(a) 子串当整词**（`corpus.includes("tool-item")` 被 `sidebar-tool-item` 顶成 true）、**(b) 选择器按任意逗号切分**（`:is(:hover, :focus-visible)` 被切成两半、第二段没有 `.` ⇒ 整条规则静默跳过）、**(c) 只判"所有类名都没人用"**（`.pin-btn.pinned` 这类复合选择器因第二个词是常见标识符而永久隐身）。现在按连接关系判定（与／或／否定三分），**规则比清理脚本更严格**（第 3 条第一版"任一死就报"当场把活的 `.setting-group > :is(p, .sp-note, …)` 误判成死规则，已改）。③ 修好后浮出 **82 条永不匹配的规则 + 8 个死令牌**（`--composer-*-hover`/`--titlebar-*`/`--right-rail-tab-*`，唯一消费方就是那批规则），全部按**全仓整词取证**（`src/**`+`index.html`+`src-tauri/**`；`tools/**` 与文档不算消费方）删除；顺带纠正 1.16.107 的一条**假救活**（`.activity-item` 当时被判"AgentDetail 在用"，实际它渲染 `subagent-activity-item`），并修掉 `chip-rows-probe.html` 里**我自己编的标记**（`skill-detail-tag`，真实组件渲染 `<Badge>`）。④🟡 `--border-separator` 7% → **5%**（亮色白底对比度 1.147 → **1.102**；暗色 8% → 6% 白），`.qa-turn-footer`/`.load-more-indicator` 随之回到 5%。⑤✅ 新增 **两条门禁**：**`tool-call-markup.test.tsx`（TOOL-MARKUP 4 例，走真实渲染）** —— 用真实 `ToolCallGroup`/`ToolCallCard` 渲染（含 grep 多文件命中/diff 多块/有输出 bash/通用 IN-OUT/无输出运行中 bash），断言过程条目线条依赖的类名**真的出现在 DOM 里**、`.tool-card-row` 每卡最后一行确为最后一个子元素、无输出时头部确为最后一个子元素，外加反向守卫"`.tool-item` 不许出现"（**突变验证**：组件里改名 → 红；无输出时也渲染空 `<pre>` → TOOL-MARKUP-3 红）；**`LIGHT-UI-2b`（共 11 例）** —— 数值（弱于主线条、**不得强于 5% 次级线**、≥1.05）+ 资格（类名整词可见、线条必须是 `:not(:last-child)::after` 渐隐渐变），三处**突变验证**全部当场变红（令牌改回 7% / 清单换成不存在的类名 / 行间规则改名）；⚠️ 资格断言第一版**测不出来**（语料含测试目录 ⇒ 清单自证绿），已排除 `src/test/**`。**实测**：`tsc` 0；UI 门禁 **error 0 / warn 0**（清理前 83 条死类）；CSS 契约 2746 → **2734** 个类；354 文件 / 5953 通过 / 16 跳过 / **1 失败（UPD-MANIFEST-6，未发布态设计）**。⚠️ 无目视核对（模型不能读图），全部程序判据 + 真机读数。<br>**⑥ 第二部分（用户贴的真机控制台驱动）：四个存储/诊断真缺陷** — **(a) 会话日志超过 50 MB 就彻底读不出来**：真机原文 `[SessionJSONL] 读取日志失败（回退到索引）: File is large (600416315 bytes)…` + `回填失败（跳过）`；根因是读日志的三条路径都走整读 `read_file`（50 MB 护栏），而**权威副本是追加日志、会随对话长到几百 MB**。修法：新增 Rust `read_text_window`（**行对齐分窗**，读满后补到下一个换行符、`next_offset` 永在行首、单行超 128 MB 明确报错绝不截断）+ 前端 `forEachLogLine`；整读错误改带稳定前缀 `E_FILE_TOO_LARGE:`（原来那句 "Use read tool with offset/limit" 是**给模型看的措辞**，出现在用户控制台只会困惑）。**(b) 日志压缩事实上从未执行过**：真机 8 份会话日志每次都打「压缩推迟：仍有别的追加在途」⇒ 汇总永远 `日志压缩 0 个会话`，而压缩是日志**唯一**的体积控制手段（(a)+(b) 合起来就是"600 MB 日志"的完整成因）。修法：在途写在途表**按会话分桶**，压缩只认**本会话**的在途写（那才会与 rename 打架）。**(c) 压缩读失败是裸 catch** ⇒ 静默返回"没压"，与"没什么可压"长得一样；现在如实上报。**(d) `trajectory_step` / `loop_stopped` 不在权威事件类型集合里** ⇒ 真机 `事件库结构异常 7360 处`全是假报警（事件是**唯一没有等价物**的存储，自检被噪声淹没等于没有自检）；两个类型进内建集合 + 写入侧守卫（**照样写入但不自动登记**，在源头报一次，area 带类型名）+ 新门禁 `event-type-write-sites.test.ts`（用**类型检查器**认定"真的是 EventLog 的 append" —— 按名字匹配会把 `formData.append("file",…)` 报成事件类型；并解析**同文件常量**，真机那个漏检正是 `type: TRAJECTORY_EVENT_TYPE` 这种写法）。**(e)** 顺带修一句假话：结构自检**跑成了**，文案却说「该功能本次没有生效」（自检结果最该被相信，这句话让人不再信它）。<br>**本机前后对照（同一台机器、同一份数据、装 1.16.117 前后各一次冷启动）**：压缩：`8 份日志全部推迟 / 日志压缩 0 个会话` → `1 个会话压缩 287→277 行`（另一份**正确地**因本会话有写在途而推迟，日志现在说清"本会话仍有 1 条"）；事件结构自检：`Unknown event type "trajectory_step" at seq 7163` → **不再报它**（只剩我故意注入的对照行 `zzz_definitely_unknown_probe_68`），文案由「该功能本次没有生效」→「自检**本身跑成了**…这些是**存量**异常」；分窗读取（真机、真实 51.3 MB 文件）：整读抛 `E_FILE_TOO_LARGE: file is 53781803 bytes`（对照面）、分窗 **7 次调用**读回 **53781803 字节逐字节相等**、212 行、每个窗口都落在行首。**突变验证**：SLF-1（窗口前进改坏→红）、SLF-3（摘掉上报→红）、SLF-5（判据退回全局→红）、EVENT-TYPE-WRITES-8（摘掉 consequence→红）。⚠️ 口径：真机读数来自**本机**（我自己的库，最大日志 3.2 MB）；>50 MB 那一条用**隔离目录里的合成日志**证明（用户那台 600 MB 的真实日志我碰不到，只按用户贴出的控制台原文定位）。⚠️ 我自己往本机库注入了 2 行探针事件（1 行 `trajectory_step`、1 行故意编造的 `zzz_…`），后者会持续产生 1 处结构异常 —— 引擎没有"按行删事件"的命令（只有整会话删除），故如实留在那里并在此声明。 |
| v1.16.115 | 2026-09-20 | **亮色模式重做：面阶梯反转 + 线条/调色板统一 + 图标语义色（对齐参考实现 frakio-work，逐项带数）** — 用户反馈"暗色好看、亮色像原型"，本轮把观感拆成可量化项在装机版上量出**四个根因**：①**抬升方向反了**：画布 0.973 → 面板 0.912 → 内嵌/用户消息 0.845（用户消息是 dLum **−0.128** 的深灰大块 + 12% 边框 + 阴影）；而**暗色档本来就是相反方向**（primary 最暗 → secondary 更亮），两档"面往哪走"不一致 ⇒ 亮色档改为内容面**纯白 1.0** / 面板 0.96 / 内嵌 0.887 / 侧栏 0.90（侧栏→内容抬升 0.10，参考实现是 0.069），语义不反转。②**1px 线四种色相**（12% ×33 条 对比度 1.269、7%、冷蓝灰 `208/215/222`、纯黑 `0,0,0`）⇒ 统一 9%（**1.194**，参考 1.201）+ 5%，色相降到 **1 类**。③**两套调色板同屏**：`styles.css` 暖中性 vs `codem-ui.css` 亮色档 GitHub 冷灰（`246/248/250`、`208/215/222`、纯黑）⇒ 冷灰全部换暖等价，暗色档**一个像素没动**。④**功能色用饱和 web 色**：安全模式 `#22c55e` 图标与文字「完全访问」对比度仅 **2.22**、弱文字落内嵌灰块 **3.03** ⇒ 安全色换 600 档、组件里 5 种 Tailwind 色改走语义令牌、弱文字 `#8a8880→#6e6c66`、主色 `#6b5ce7→#6555e0`（原值内嵌块上只有 4.35）、新增 `--accent-strong`（**28 条**"品牌浅底 + 品牌色文字"规则迁移：徽标 4.22→**5.14**）。🟡 顺带：`--message-bubble-user` 早定义但**零引用**（气泡因此用灰块）⇒ 接线两档同源 + 三套皮肤给色，删 **12 行死令牌**（⚠️ `--user-bg` **不是**死的：`SideSessionPanel.tsx:155` 用带兜底写法，第一版差点误删，被守卫拦下）；我自己探针里"元素自身背景叠加两次"的 bug 也被同轮两处读数自相矛盾暴露并修掉。**门禁**：新增 `light-theme-contrast.test.ts` **LIGHT-UI 10 例**（面阶梯方向/线条带/对比度下限/亮色档禁冷灰纯黑饱和色/**禁零消费方令牌**/气泡两档同源）与真机探针同一套数学。**实测**：内容面 0.973→**1.000**、主线条 1.269→**1.194**（参考 1.201）、安全图标 2.22→**5.08**、最弱文字 3.03→**4.77**、亮色档冷灰/纯黑字面量 5 族→**0**；`tsc` 0；351 文件 / 5935 通过 / 0 失败；10 道门禁 exit 0；UI 门禁 error 0 / warn 0。⚠️ 无目视核对（模型不能读图），结论全部来自程序判据。 |
| v1.16.114 | 2026-09-20 | **技能市场第 4 条"源可达、返回为空"假话分支 + 概览房间接线 + 装饰性房间点了亮错地方** — 🔴 **技能市场第 4 条分支**：`githubRateLimitedAt` 是**进程级**时间戳（未认证配额按 IP 计，多个 github-* 源共用 60/h），而冷却判断在**某个源自己的**仓库循环里 ⇒ 源 A 撞光配额后，源 B 每个仓库都被 `skipped++`、**一个请求都没发**、账本上一笔都没有 ⇒ 照旧打出「源可达、返回为空」（复量 R4/R5 同毫秒逐字复现，两源各一条）。修法：冷却早退改走 `noteGithubRateLimit(source.id, …, source.name)`（先记账再按源去重打印**本源自己的**真话）；冷却判据**故意保持全局**（"不再打扰 API"是对的，**错的是不记账**）；文案"只拿到部分结果"→"结果不完整"（整源跳过可能 0 个仓库完成）。用例 `③n` 含突变证明（去掉记账 → 当场报出假话原文）。🔴 **概览页「场景实况」漏接线**（同类第 2 次）：`onSelectZone` 是可选 prop，1.16.113 只接了 `LibraryPanel` ⇒ 概览这两个热区点了没反应；新增 `library-ops-scene-wiring.test.ts`（静态接线门禁 + 控制组 + 突变证明：删一行报出恰好 1 处缺失）。🔴 **装饰性房间点错地方**：12 间房 vs 10 个岗位，`alarm`/`schedule` 无岗位却 `zoneOfRoom` 回退成房间 id ⇒ `selectedZoneId="alarm"` → `roomOfZone` 未知回退 gateway ⇒ **点报警台亮前台**（1.16.114 首构建真机 `alarm→gateway`）；修法 `zoneOfRoomOrNull` + `data-has-zone` + `.is-decor{cursor:default}`（不接点击、无 button 语义、不进 Tab 序），用例 `LO-HITAREA-10` 含突变证明。🟡 **测量工具两处失真**：`normalize()` 把源名一起抹掉 ⇒ 跨源同形告警合并成 `n: 2` 被误读成"重复告警"（现给出 `sources`/`nDistinctRaw`/`mergedAcrossSources` + 真重复判据 `warnDuplicatesPerSource`，带 9 条自测）；`sourceCompletionMs` 曾恒为 `{}`（`noisy()` 滤掉了所有 `log`）。✅ **闸门容量研究结论=不改**（前端 8 / Rust 12）：8 轮真机 BUSY 拒绝**全 0**；唯一稳定越 12s 的 ClawHub.ai 是串行分页、无闸门下界 **20393ms**（改闸门救不了）；受控 A/B 8→12 得 1.606×（说明 8 是刻意余量而非硬件上限），放宽前端会吃掉两个**不经过前端闸门**的调用方（`extractor.ts:139`、`pet-market-client.ts:52`）的余量；**刻意不加**"容量常量一致"用例（会把"数据不足"固化成定论）。✅ **装机版前后对照（同一脚本两版）**：房间"点谁亮谁"概览 **0/7 → 10/10**、子智能体 **0/9 → 10/10**；装饰房间 **2/2 点了不选中**（强判据）；12 间房可见占比 **12/12=1.0、clipped=0**。✅ 技能市场刷新：warning 5（各源超时各 1 条、`warnDuplicatesPerSource: []`）/ error 0 / exception 0、`busyWarnCount 0`、`busyLiePairs []`、932 张技能卡。✅ 记忆面板（**不注入**、读加载中的样式表）：头部 **53px**、按钮组 **327.02×28 单行**、0 重叠 / 0 命中落空。✅ 冷启动普查：互异 138 条、**warning/error/exception = 0**、工作集 **75MB**。**实测**：`tsc` 0；350 文件 / 5925 通过 / 16 跳过 / 0 失败；10 道门禁 exit 0；UI 门禁 12/12；CSS 契约无变化；`cargo test --lib` 58、引擎 88+2+2。🔴 **入库的发布工具写出更新器读不到的清单**：被跟踪的 `tools/release/make-latest-json.mjs` 写 `platforms.windows`（Tauri **v1** 写法），而发布实际用的是未入库的 `.preview-shot/_audit/` 脚本（v2 键写对）⇒ 照入库工具跑一次「检查更新」必报 `TargetsNotFound`，既有 VERSION-5 只校验**产物**、对"生成器写错"无感；修法=构造逻辑收口成 `tools/release/latest-json.mjs`（纯函数 + 自检），新增 `update-manifest-generator.test.ts` 6 例（**真跑一遍 CLI**、无 BOM、缺签名拒绝生成、反向守卫 tools/ 下不许再有 v1 写法、产物与 package.json 同版本）。⚠️ 无目视核对（模型不能读图）。 |
| v1.16.113 | 2026-09-19 | **像素场景"房间点不中"（一个根因）+ 顺带挖出两处死交互** — 🔴 `.lo-pixel-actors` 是**整块画布大小的透明无行为容器**（`rgba(0,0,0,0)`、无背景图、**自身无 onClick**）却 `pointer-events:auto` ⇒ 吞掉下面全部 12 个 `.lo-pixel-room` 热区（真机 12 房间 × 82 点采样「命中自己」**全 0**）。修法：容器 `pointer-events:none` + 精灵本体 `auto`（命中区=精灵方块）；改后子智能体均值 **0→0.908**、中心归属 **0/12→11/12**、概览仅可见采样 **0→0.676**。🔴 **顺带修两处同源死交互**：①点角色无反应（`.lo-actor-wrap` 0×0 + 精灵全 `pointer-events:none` ⇒ 已接好的 onClick 是死代码）②`onSelectZone` **生产代码谁都没传**（房间却带 `role=button+cursor:pointer`，侧栏文案写着"点击场景中的角色或岗位查看详情"）⇒ `LibraryPanel` 已接线；另抓到既有用例 `LO-UI-11` **把"点房间=无操作"当契约**（测试在测缺陷），已按真实语义重写。✅ **(b) 判定"行为正确、不改"6 处**（概览 4 处是**相机取景裁切**：房间可见区只剩 24%/2%/0%/0%，中心那点根本没画房间，命中的是不透明实体卡；另 2 处落在真控件 HUD 条上）。📋 **两处独立未修问题**：`gateway`/`task_queues` 热区 bounds 完全相同（前者 0% 可点，需定"一房两岗怎么点"）、概览 `fitView` 被 `MIN_SCALE=0.3` 钳住导致"适应窗口"永远适应不了。⚠️ 口径：改后数字来自**注入逐字相同的规则**（非装机版）；无目视核对（模型不能读图），全程序判据；无视觉回归=16 元素×40 属性只差 `pointer-events` 三条。**实测**：`tsc` 0；门禁 12/12；346 文件 / 5893 通过 / 0 失败。 |
| v1.16.112 | 2026-09-19 | **技能市场"源超时"根因改造 + 插件禁用不再说假话 + 记忆面板按钮挤压修复 + 命中区安装版复量** — 🔴 Rust `http_get` 改为**共享 `reqwest::Client`**（`OnceLock`，零新增依赖）+ **并发闸门 `Semaphore(12)`**（超限立即返回自描述 `BUSY`，**刻意不排队**）+ 超时分层；`cargo test --lib` **58 passed / 0 failed**（+4 例）、新代码 clippy 零告警。🟡 前端按源名去重 + 3s 轮次合并（突变验证 `expected 2 to be 1`）。🟡 插件禁用日志三态（真卸载/log、装载过但无句柄 **warning**、从未装载/log）+ 登记 `KNOWN GAP`。🔴 **记忆面板「按钮挤到右上角」**：根因是 `.memory-manager-actions` 被第 36-37 波"grid 原语批量替换"改成 `repeat(2, max-content)`，6 个按钮折成 2×3、固有宽仅 126px ⇒ 被压成 **126×99** 小方块、头部撑到 **123.67px**；改为不换行 flex 后 **327×28 / 头部 53px**；新增 `memory-panel-layout.test.tsx`（判据=列轨道数≥子元素数，旧 CSS 必红）。**同类普查 19 面板/40 页签**：本类只有记忆面板一处；另查出任务中心概览 4 处、子智能体 12 处 `lo-pixel-room` 热区被卡片/角色层接走（**未修**，library-ops 层级问题）。✅ 命中区安装版复量：工具 **13→1**、Git **4→1**、技能管理 **1→0**。⚠️ 记忆面板"改后"数字来自**注入修复规则**复量（`dist/` 不在允许范围），出包后需再确认。 |
| v1.16.111 | 2026-09-19 | **按"bug 与 warning 双归零"闸门收口** — 🔴 **MCP 服务器目录锁死**：根因是 `.titlebar` z-index **9999** > 模态 **1300**，面板关闭按钮落在标题栏带内（`24×27@(1160,12)`）⇒ **点它会关掉整个窗口**；修法 = `.mcp-marketplace` 加 `padding-top: var(--chrome-height)`+`border-box`（纵向让开；横向挪 16/24/32/40/48/56 逐档实测均命中 titlebar ⇒ 无效）+ 关闭按钮补名 + **Esc 关闭**（对齐 `ConfirmDialog` 写法）；实测中心点由 `titlebar-btn-close` → `mcp-marketplace-close`、误命中窗口关闭键 true→false；新增 9 例 + 突变检查。🟡 **技能市场 8 条 warning 多为假警报**：`Source X timed out` 的定时器**没人清**（真机量到 7 个 12000ms 定时器 `clearedCount:0`，连同步源也报超时、ClawHub 成功日志比自己的告警晚 5.5s）⇒ `withSourceTimeout` 收口 + 降级源不计入 `result.skills`（顺带修掉"超时让该市场旧技能整片消失"）；同时修真问题：一次刷新 **133 个 `http_get`** 打光 GitHub 配额（60/h）⇒ 并发 8 + 限流识别（原来读的 header 大小写不对）+ 树缓存 + 限流短路；Vercel OIDC 那条按"桌面端无签发方 + HTML 兜底成功"降为正常日志（自配 apiToken 仍 401 保留 warning），**没删日志、没关任何源**。🟡 启动 2 条 `storage.compact` trace 由 `warn` 降 `log`（compact 是回收不是删除）。✅ console 普查（冷启动+设置页签）：互异 135 条、**warning 仅 2 条 / error 0 / exception 0**、CDP 280ms。**实测**：`tsc` 0；344 文件 / 5871 通过 / 0 失败。⚠️ **本版发布前必须先在安装版复量**（启动 warning=0 / MCP 可关 / 命中区 small=），未通过不发。 |
| v1.16.110 | 2026-09-19 | **四路深度审计（性能/稳定性/UI 走查/功能上下文）+ 修掉两处真缺陷** — 🔴 **坏 WAL 静默丢弃**（唯一"数据少掉且无痕迹"形态）：真库副本注入实测，只坏 `-wal` 头 4 KB 时 SQLite 忽略并删除该 WAL、引擎却 `ok:true` 无备份 ⇒ 4,136,512 B 未 checkpoint 写入无声消失。修法：**打开前验 WAL magic**（0x377f0682/83，大端为主小端兜底），不匹配则原样保留为 `<库>.corrupt-wal-<ms>` 并经 `health.wal_backup_from` 报出；magic 正常行为一字不变；真库副本端到端 4,136,512 B 一字不少保住。⚠️ 作者自查改掉二次缺陷：第一版字节序写反（`from_le_bytes`）会把**正常 WAL 判成坏 WAL**，被"正常 WAL 不许产生备份"用例当场打红。渲染侧已接上该字段（`rust-port.ts`）。🔵 **`AgentMessageQueue.consumedReplies` 无上界**（整段回复正文从不删除）⇒ 条数上界 200 + FIFO 逐出 + 2 条用例。🔵 `event-log.ts` 无生产者的缓冲 + 永不执行的回调删除。✅ **真机 32 面板走查**（712 按钮）：16 个无名控件补 `aria-label`（只加属性）、4 个面板关闭按钮补名（任务中心那个与 library-ops 三子视图共用 ⇒ 一处覆盖 4 行）、`[MiMoAuth] auth.json os error 3` 查清为**正规形态**并改代码（Rust `NotFound ⇒ {exists:false}`，TS 正常路径日志**不静默**，真故障仍 error）+ 5 例回归。📋 **已量到未修（逐条待办）**：命中区过小 **49** 个；`RustEventMirror` 无预算（消息镜像有 20k 预算、事件镜像没有）；`cachedLogMessages` 生产无清理者；启动 17 处 await（预取最坏 2.5s，遮罩在末尾才关）；安装包 **40.39 MB**/`dist` **82.93 MB**（wasm 22.48+模型 21.91+字体 7.07=62%）；功能上下文 **24 条**缺口。四份报告入库 `docs/audit-{perf,stability,ui-walk,feature-context}.md`。**实测**：339 文件 / 5844 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0（未接线扫描 808）；UI 门禁 0/0；引擎 54+88+2+2 全过。 |
| v1.16.109 | 2026-09-19 | **清理第 4 包：两条"注册了却永远不渲染"的插槽宿主（功能一件没少）** — 删除 `components/ConversationComposer.tsx` / `ConversationSession.tsx`（两个薄宿主，各渲染 1–2 个 `<SlotListBridge>`，**从未被任何界面渲染**）以及 7 条挂在"没有出口的槽位"上的重复注册（`conversation.composer.bar/dock`、`conversation.session(.header.actions)`）。**查清的关键事实**：模型选择/权限预设/计划标记/目标条/任务徽标/交付物列表这些 UI 今天都在正常显示，走的是 `app.*` 那套（`InputArea`/`ChatPanel` 挂载），被删的只是同一批组件的**双份注册**里的无宿主那一份 ⇒ 删掉不少功能。槽位声明（`ui-conversation/index.ts`）保留为该插件的公开词汇表。**实测**：336 文件 / 5830 通过 / 16 跳过 / 0 失败（退出码 0）；`tsc` 0；10 道门禁 exit 0（未接线扫描 808 文件）；UI 门禁 error 0 / warn 0。 |
| v1.16.108 | 2026-09-19 | **清理第 3 包：8 个孤儿模块**（核心 + 插件内部，非 UI）— 删除 `src/types.ts`、`core/skill/{agent-declaration,file-skill-provider,bundled-scripts}.ts`、`core/slots/SlotRenderer.tsx`、`core/ui-plugins/ui-market/plugin-market.tsx`、`plugins/monopoly-game/{components/DicePanel.tsx,store.ts}`。每个都过三重取证：导出名全仓搜 + 文件名/路径搜 + 动态加载排查。**重点排查了两类"看起来零引用其实活着"的机制**：①`import.meta.glob`/`require.context` 全仓只有 `ppt-skill-registry.ts` 用（不覆盖本包候选）；②构建入口 —— `vite.config.ts` 的 `input` 含 `pet.html`，而它引 `/src/pet-main.tsx` ⇒ **pet-main.tsx 保留**（knip 误报，已从清单划掉）。同样保留 `skill-creator/scripts/*`（运行期调用）与 `stubs/*`（构建别名）。**实测**：336 文件 / 5830 通过 / 16 跳过 / 0 失败；`tsc` 0；10 道门禁 exit 0（未接线扫描 810 文件）；UI 门禁 error 0 / warn 0。⚠️ 一次 `vitest` 退出码 1 但 0 失败 = 已记录的 teardown 竞态（`subagent-turn-valves`），单跑与重跑均 0，如实记为偶发。 |
| v1.16.107 | 2026-09-19 | **清理第 2 包：7 个从未被渲染的 UI 组件 + 其专属死样式/死令牌**（同一条"每类一包 + 真机冒烟"节奏）— 判定依据是**逐文件取证**（导出名全仓搜，命中全是注释/文档，无 import）：`ActivityTimeline.tsx`、`SkillAuditDialog.tsx`、`ui/overlay-kit.tsx`、`rich-content/{FullscreenViewer,HtmlPreviewView,JsonFormatView,MathFormulaView}.tsx`。同目录活着的（`RichContent`/`CodeBlockView`/`ImagePreviewView`/`MermaidCanvasView`/`TableScrollView`/`ContentFrame`）保留。顺带清掉专属 CSS（codem-ui.css 四块 + styles.css 的 `.activity-timeline`/`.activity-dot*`/`pulse-dot`）与 4 个主题块里的 6 个死令牌（`--tool-card-*`/`--tool-status-*`，0 处 var() 引用）。⚠️ 清理中**差点误删活的样式**（`.activity-item` 被 AgentDetail 用、`.activity-time` 被 Workbench 用），同一步发现并原样恢复 ⇒ 教训："按类名批量删 CSS 必须逐个查引用"。**【第 67 轮更正】这句话里 `.activity-item` 那一半是错的**：`AgentDetail.tsx` 渲染的是 `subagent-activity-item`，当时的检索用**子串**匹配把它当成了整词 ⇒ 一次**假救活**（`.activity-time` 确为活的，保留无误）。第 67 轮把 `scan-ui.mjs` 的 `css-class-unused` 改成**标识符整词**匹配后，它与自己的 `:is(:hover, :focus-visible)` 一起被如实报出并按全仓取证删除。另修两处悬空注释、删掉 scan-ui.mjs 里 HtmlPreviewView 的豁免条目。**实测**：UI 门禁 **error 0 / warn 0**（清理前 20 条死类 + 6 条死令牌）；336 文件 / 5830 通过 / 0 失败（退出码 0）；`tsc` 0；10 道门禁 exit 0（未接线扫描 818 文件）；CSS 契约快照 2763 → 2747 个类。 |
| v1.16.106 | 2026-09-19 | **清理遗留脚手架：删 27 个再也走不到的旧文件 + 修掉一处界面假话** — `src/core/capabilities/**`（25 文件/1814 行）是 2026-08-15 架构迁移（`61d2223` Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seams）的**脚手架**：迁移第二步把实现全搬到 `src/core/provider/`（约 180 个 provider，由 `plugin-loader/builtin-registry.ts` 注册，**是活的**），原目录降级为"接口定义 + `@deprecated` 转发壳"（`fs/local.ts` 就是 `export { fsProvider } from '../../provider/fs-provider.ts'`），TS 接口无需 import 也生效 ⇒ 无人引用。**删前三确认**：①目录外零 import 说明符命中；②`provider/` 无反向依赖；③动态 import/别名/配置无引用。保留 `core/consumer/**`（活的）、`core/provider/**`（canonical）、`src-tauri/capabilities/*.json`（Tauri 权限，同名两回事）。另删 `core/recovery/multi-layer(.ts/-index.ts)`（初始提交的"三层+同步"恢复实现，**无生产调用者**；今天支撑面板的是单层 `recovery.ts`）⇒ 面板标题「**多层**会话恢复」改为「会话恢复」，与真实机制一致；`recovery-keys.test.ts` 中钉 `-state`/`-sessions` 的用例删除（无实现再用）。**实测**：336 文件 / 5830 通过 / 16 跳过 / 0 失败（vitest 退出码 0）；`tsc` 0；10 道门禁 exit 0（未接线扫描 825 文件通过）；真机 1.16.106 正常启动、面板标题正确、无新增控制台错误。 |
| v1.16.105 | 2026-09-19 | **旧库凭据清洗（先备份再清洗）+ 普查不再把密文说成"明文凭据"** — 旧库 `codem-db.bin` 里 `sk-×4`+`gho_×3` 共 7 处**原地等长替换**为占位符：先备份并经**字节校验**（`backup-pre-sanitize-<ts>/`）、长度 11,137,024 不变、清洗后 `integrity=ok` 且逐表行数不变（messages 821 / session_events 2198 / tool_calls 883 / settings 24）、复量该文件命中 **7→0**、备份里仍 4+3。⚠️ 副作用：旧库是"损坏库恢复设置"的来源，清洗后恢复出来是占位符需重填（备份可放回）；**不声称**物理不可恢复（覆盖写，SSD/快照层仍可能留残留）。🔴 **普查假话**：封存后 `"apiKeySealed"` 仍被键名判据命中（`apiKey` 是子串），维护日志打出"存在**明文存放的**密钥 1 处"而磁盘上是密文 ⇒ 值是本产品封存格式（`dsh1:<hex>`）的字段单列 `sealed`，从明文告警剔除、只如实补一句"另有 N 处已加密"；新增 `CENSUS-5`（含两个对照组）。另产出 `docs/DEAD-CODE-TRIAGE.md`（按用户选择：只报告不动代码）——knip 76 项逐类给证据，明确**不要动**的误报类别（32 桶文件/12 全局类型增强/4 stub/5 技能脚本/3 Vite 入口）与两个有证据的簇（`core/capabilities/**` 12 文件零引用；`multi-layer.ts` 无生产调用者）。**实测**：336 文件 / 5831 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0。 |
| v1.16.104 | 2026-09-19 | **数据目录台账（对标 dsh-desktop）** — 库路径可被 `CODEM_DB_PATH` 指到别处，而"换了数据目录（新目录为空、旧数据还在）"与"数据真的没了"在界面上**长得一样**（都是"没有会话、没有项目"）。新增 `data-home-ledger.ts`：记 `activeHome/previousHome/generation/source/targetState(empty\|existing)/updatedAt/history`，四条纪律 —— **只记账绝不复制**、台账放**标准数据目录**（否则一切换就"重置"）、**原子写**（.tmp→rename_file）且目录没变**不重写**、**读不出来≠没有台账**（不覆盖、现场另存 `.corrupt-*`、代数记 0）。bootstrap 接线，失败不抛但留痕。⚠️ 与 dsh 有意不同：**不做** 0700/0600 权限收紧（Windows 上无意义，已在注释声明、不声称做了）。测试 7 条，关键负向：DHOME-3（换目录时除台账外**零写动作**）、DHOME-4（损坏时不覆盖）。⚠️ 口径：暂无界面入口（日志可见）；真机只验证了"首次记账 + 未变不重写"，**没有**真的把 `CODEM_DB_PATH` 指到别的目录切换（那会动用户真实数据落点）。**实测**：336 文件 / 5830 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0。 |
| v1.16.103 | 2026-09-19 | **真机复量又抓到两处「印出来的不是真的」** — 🔴 ①「检查更新」的文案原来用 `btn.textContent=` 直接改 DOM，真机上点下去控制台打了 `[updater] 未安装更新：none` 而**界面什么都没有**（任何重渲染都会按 JSX 把文字写回「检查更新」，三条错误分支同样被抹掉）⇒ 改成 React state（`updateMsg`/`updateBusy`）+ `UPD-6` 回归钉子。🔴 ②小图标按钮命中区 24×18：1.16.102 用伪元素外扩**远不够**（只有"上 3px、下 1px"生效，左右被相邻元素盖住 ⇒ 净值约 26×22）⇒ 改成控件自身 `min-width/min-height:24px`。**真机复量（1.16.103）**：更新按钮 `T+0.7s 检查中…` → `T+1.6s 未发现更新（当前 v1.16.103）…CDN 可能还没同步`且**不再消失**；`.market-skill-link-btn` 172 个 **24×18 → 26×24**、两两重叠 **0**、可见的 2 个命中测试 **2/2**。⚠️ 口径：`.lo-link-btn` 仍未复量。**实测**：335 文件 / 5823 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0。 |
| v1.16.102 | 2026-09-19 | **凭据封存：密钥不再明文落盘（方案阶段 1）+ 真机首跑抓到的"封存被自己撤销"+ 回退这个此前并不存在的能力** — 启动时 `secret_unseal` 解封进内存 → `secret_seal` 迁移成密文（封存成功 → 一次性原子写回 → 才清明文）。三条硬规则各有用例：后端不可用⇒一个字不改、任一 provider 失败⇒整体不动、解不开⇒保留密文。🔴 **真机首跑证伪了我自己的话**：日志报"已改为系统加密保存"、残留也回收了，可 CLI 直读库文件是 `apiKey`（明文 35 字符）**与** `apiKeySealed` **并存** —— 根因是全项目 **14 处**「读整份 `codem-settings`（水合⇒明文）→ 改一个字段 → 整份写回」的读改写（App.tsx 3、SettingsPanel.tsx 11），"改一下模型名"就等于把明文写回磁盘。修法放在**唯一写收口**（`secret-write-guard.ts`）：同密钥**同步**换回它自己的密文（零 IPC）、新密钥先落盘再**异步补封存**、用户选明文/后端不可用⇒一步不做、损坏库恢复的裸写也过闸门；并收拾真机上已存在的脏行（同密钥只删明文，`cleanedDuplicate` 单独计数）。**真机复量（已安装 1.16.102）**：`清理了 1 个 provider 的重复明文`；CLI 直读 `apiKey=False / apiKeySealed=True`；字节级 `codem-db-rust.bin` sk- **1→0**、`-wal` sk- **27→0**（18.01 MB，原 19.51）；渲染侧读到密钥并调 DeepSeek 余额接口 **HTTP 200 / is_available=true**；界面「设置→安全→API 密钥存储」勾选框未勾选、文案「已用系统加密保存（1 个 provider）」；无「已是最新版本」类假话。测试：`credential-write-guard` 7 条（含**对照组**：摘掉闸门必须真的泄露明文）+ `credential-seal` 14 条。**实测**：渲染侧 335 文件 / 5822 通过 / 16 跳过 / 0 失败；`tsc` 0；10 道门禁 exit 0；引擎 53 条（含真 DPAPI 往返）。 |
| v1.16.101 | 2026-09-19 | **凭据普查进维护（+ 我自己引入并修掉的同类缺陷）** — 新能力：维护时扫设置，**只报键名 + 数量、从不打印值**，命中即提示「存在明文凭据、建议轮换」；判据与导出脱敏共用同一份正则。🔴 **1.16.100 的缺陷（真机首跑抓到）**：用 `domainReadMany("settings")` 读设置，而该域镜像此刻未就绪 ⇒ 空数组 ⇒ 打出「0 个设置项，未命中」（而 key 明明在库里）—— 正是本会话反复修的「读不到被当成没有」。修法：改用引擎命令 `settings.get_all`；`scanned === 0` 必须说「未跑成」而不是「未命中」。**真机复量（1.16.101）**：`凭据普查：27 个设置项里命中 2 处（codem-settings(shape×1)、codem-settings(field×1)）`。测试 4 条含「返回值里不许出现密钥文本」与「普通设置不许误报」。**实测**：渲染侧 331 文件 / 5792 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0。 |
| v1.16.99 | 2026-09-19 | **导出设置不再带走密钥（凭据方案阶段 0 的第一刀）** — `exportSettings()` 原样返回各来源数据，而界面有导出按钮 ⇒ 导出文件带着 API key 明文。新增 `redactCredentialShapes()`：**键名像凭据**（apiKey/token/secret/…) 或**值形状像凭据**（sk-/gho_/ghp_/AKIA）都替换成占位符，**只替换+计数、从不打印值**；占位符保留字段位置便于重填。测试 4 条含**对照组**（普通设置一个字不许改）。⚠️ 验证口径：逻辑由单元用例证明（4/4），**真机导出文件核对未做成**（打包版设置面板里没有导出入口，它在插件面板内），已记进方案文档待办。依据：`docs/CREDENTIALS-PLAN.md`。**实测**：渲染侧 330 文件 / 5788 通过 / 0 失败；`tsc` 0；10 道门禁 exit 0。 |
| v1.16.98 | 2026-09-19 | **深层面板"说得出来"收口：四个面板无名控件归零（连续三包 1.16.96/97/98）** — 1.16.96 给三处 `.skill-search-input`（插件/技能/市场搜索）补 `aria-label`（**placeholder 不是可访问名**）；1.16.97 给 `.mcp-manager-close` 补名（MCP 面板唯一无名按钮）；1.16.98 给技能行的 `Switch` 补名（`{...props}` 透传 ⇒ **一处标注覆盖 11 行**）。**真机复量（已安装 v1.16.98）**：技能 20/无名 0、智能体 9/0、MCP 5/0，四个面板关闭按钮全部可按名字找到 ⇒ 走查脚本能正常关面板，"读数继承脏状态"的仪器缺陷消失。⚠️ 未修：密集列表 `.market-skill-link-btn` 命中区 24×18（170 个），需按布局判断；`.lo-link-btn` 已改但未在对应面板复量。**实测**：渲染侧 329 文件 / 5784 通过 / 16 跳过 / 0 失败；`tsc` 0。 |
| v1.16.95 | 2026-09-19 | **深层面板的关闭按钮"说得出来"了 + /feedback 文案不再暗示"已起作用"** — 第 79 轮真机普查：插件管理面板内唯一无名按钮是 `.skill-manager-close`（且面板内无任何"关闭/close"名字的按钮）⇒ 走查脚本关不掉面板、后续读数继承脏状态。三个面板（智能体/插件/技能）补 `aria-label`；`.lo-link-btn` 用伪元素扩命中区（实测 24×15 → ≥24，视觉与布局不动）。另按"印出来的必须是真的"，把 `/feedback` 的暗示性提示改成如实（读侧 `listSessionFeedback` 零生产调用者 ⇒ 明确写"当前没有任何自动流程读取它、不会影响模型行为"）。**真机复量（已安装 v1.16.95）**：插件管理面板内无名按钮 **1 → 0**、关闭按钮可按名字找到（`{name:"关闭面板"}`，修前为空）。⚠️ **同一次复量新发现、未修**：该面板 389 个可交互元素里 **170 个命中区偏小**，全部是 `.market-skill-link-btn`（命中 **24×18**）；它在密集列表里，扩命中区有压到相邻控件的风险，需按布局判断后再动。⚠️ `.lo-link-btn` 的修复已进构建，但该面板里计数为 0 ⇒ **本轮不声称已复量**，留到 library-ops 面板那一轮。**实测**：渲染侧 329 文件 / 5784 通过 / 16 跳过 / 0 失败；`tsc` 0。 |
| v1.16.94 | 2026-09-19 | **设置面板的关闭按钮终于"说得出来"了** — 第 71 轮真机普查发现设置面板内 **127 个可见按钮里有 1 个没有可访问名**（右上角 ✕），它同时是第 63 轮走查脚本"按名字找不到关闭按钮、只能按位置兜底"的根因。修法：`SettingsPanel.tsx` 补 `aria-label`（关闭设置 / Close settings）。**真机复量（已安装的 v1.16.94）**：同一条普查脚本 → 面板内 **127 个按钮 / 无名 0 个**，且脚本这次能**按名字**点中关闭按钮（`closed: true`）。**实测**：`tsc` 0；渲染侧 329 文件 / 5784 通过 / 16 跳过 / 0 失败；引擎 85 + 54 + 48 全绿；10 道 audit 门禁 exit 0；远端产物 sha256 与本地一致（7/7）。 |
| v1.16.93 | 2026-09-19 | **补上工具条最后两个没有可访问名的按钮（展开/折叠正文）** — 上一轮补齐「重新编辑/复制/朗读」后复核发现同一排**还有两个**（BookOpen/BookX）也没名字；它们**互斥显示**（任一时刻只看到一个），所以走查清单漏了。补齐后实测工具条**无名按钮 0 个**。**实测**：渲染侧 329 文件 / 5784 通过 / 16 跳过 / 0 失败；	sc 0；10 道 audit 门禁 exit 0。 |
| v1.16.92 | 2026-09-19 | **真机逐面板走查（程序化）：三个按钮"说不出来"、一个计数被显示两遍、几处点击目标比手指小** — 本轮开始走 UI/UX 轴：用**真机打包版**做程序化走查（CDP + `Input.dispatchMouseEvent` **真实鼠标事件**（不是 `element.click()` —— 后者绕过命中测试，被遮挡的按钮也会"点得动"）+ 命中测试 + **量命中区**而不是 `getBoundingClientRect`（圆形/伪元素扩边的控件矩形小但实际好点）），抓到三类并修掉：①`MessageBubble.tsx` 的悬浮工具条里 **`重新编辑`/`复制`/`朗读` 三个按钮没有任何可访问名**（既无 `aria-label` 也无 `title`，里面只有一个 `<svg>`），而左右相邻的（编辑并重发/编辑并回溯/精选到导航条/赞/踩）**全都有** —— 真机走查把它们报成三条 `label: ""`，读屏只能说"按钮"、键盘与自动化也拿不到名字；补上与 Tooltip 文案一致的 `aria-label`。②侧边栏「任务管理」把**同一个未读数显示两次**（图标红点徽章 + 行尾 `marginLeft:auto` 红字）⇒ 未读为 1 时整行读出来是 `1任务管理1`（可访问名也是），而**折叠态**同一入口只画图标徽章 —— 同一事实两处显示、两种画法；现在只留图标徽章，未读数由 `aria-label`（任务管理（N 条未读））说出来。③**点击目标偏小**：会话/项目「置顶」**16×19 px**、输入框左侧「＋」等紧凑按钮 **18×18 px**，均低于 WCAG 2.5.8 的 **24×24** 下限；用伪元素扩命中区到 ≥24×24，**视觉与布局一个像素不动**。🧪 走查脚本 `.preview-shot/ui-walk-r63.mjs`（真机、逐步扫描"无名的可交互元素 / 命中区 <24px / 被遮挡或跑出视口"），仪器本身本轮修了两次并写进注释：**模态打开时"被遮挡"绝大多数是正常的**（只扫模态内部、模态外计成 `behindModal`，否则遮挡数从 21 跳到 205 全是噪声）；**关闭模态不能只认"关闭/Close"**（设置面板是 ✕ 图标按钮，第一版因此没关掉、后面 9 步全在模态里空转）。⚠️ 诚实交代：走查目前只覆盖基线界面/设置/搜索/终端/右侧栏；插件、技能、任务中心等深层面板的遮罩类名不统一，脚本认不出来，那几步读数会"继承"上一个面板状态 —— 逐面板走查需要按面板各写驱动步骤，下一轮继续。**实测**：渲染侧 **329 文件 / 5784 通过 / 16 跳过 / 0 失败**；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.91 | 2026-09-19 | **数据落点只有一个来源：库被指到别处时，权威日志/附件/溢出文件以前会留在原地** — 修的是第二个"同一个事实两个来源"，并顺带在真机上抓到**权威日志回填静默 no-op**。🔴 缺陷一：渲染侧文件落点一直只认 `appDataDir`，而**库**的落点由引擎解析（支持 `CODEM_DB_PATH` —— 便携模式与隔离钻取的唯一受支持入口）⇒ 库一指到别处，`sessions/*.jsonl`（**权威副本**）、`attachments/*`、`spill/*`、`codem-index-rebuild-needed.json` 全都留在原地，**权威副本与被它支撑的索引不在同一份数据集里**：便携模式把库拷到 U 盘而日志留本机、自愈在另一份数据上跑、隔离钻取会**读写用户的真日志**（我自己的验收流程长期踩在这条上，本轮才发现）。🔴 缺陷二（真机取证）：`CODEM_DB_PATH` 隔离启动一个从旧库迁移来的库（索引 800+ 条、日志目录不存在），**连续三次维护都打 `日志回填 0 条`，而 `sessions/` 一个文件都没建出来** —— 机制与第 44 轮"索引裁剪整条从不生效"完全相同：`listMessages` 在消息镜像未加载完时返回空数组 ⇒ 回填循环 `continue`，"跑了但什么都没做"与"确实没有可回填的"在日志上同形；代价是**权威日志没被建出来**，"库坏了从日志重建"那条后路在那次启动里是空的。✅ 修法：①新增 `data-root.ts` —— 数据根目录的**唯一来源 = 引擎实际使用的库所在目录**（`storage_info.path` 的父目录）；标准情况**逐字不变**，库在别处时渲染侧跟着走，拿不到 `storage_info` 才退回 `appDataDir` 并**记住原因**（`origin`/`fallbackWhy`），两个来源都拿不到时**抛错**（绝不退回相对路径 —— 第 55 轮真事故的根因）；②四个消费方跟着走 + `bootstrap` **尽早预热一次**（热路径不再等 IPC；数据根目录是进程常量） + 非标准位置**留醒目告警**（实测输出 `[Storage] ⚠️ 数据根目录不是标准位置：…（原因：由环境变量 CODEM_DB_PATH 指定）—— 权威日志 / 附件 / 溢出文件都跟着它走`）；③回填**先等就绪**（`waitForMessageMirrors`，与索引裁剪共用同一条等待与 5 秒总预算），等不到的会话单独计数 `backfillSkippedUnreadable` 并进汇总行（`；N 个会话镜像未就绪未回填`）。🧪 新增 `data-root-single-source`（10 条：解析规则 / 退避语义（拿不到就抛、**失败不缓存**）/ 四个消费方逐条断言文件真的写到库所在目录）与 `log-backfill-readiness`（4 条：异步窗口仍要把日志建出来 / 永远不就绪不许冒充"0 条" / 幂等 / 汇总行打出"未回填"）；**真机钻取**：隔离目录出现库与 `sessions/`、用户真实目录**逐文件未被改动**、`storage_info` 报 `standard=false` + 原因。⚠️ 诚实交代：产品功能目录（宠物/技能缓存/zvec/克隆目标）与旧库 `codem-db.bin` 刻意**不**跟着走（本轮只收"与库同属一份数据集"的存储文件；功能目录进便携模式是产品决策）。同轮修掉两处夹具"写在飞行中换运行时"的时序问题（CI 偶发红，产品无影响）。**实测**：渲染侧 **328 文件 / 5779 通过 / 16 跳过 / 0 失败**（连跑两次一致）；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.90 | 2026-09-19 | **同一根因的其余四个消费方：对模型说「没有匹配」、对复盘报告说「会话没正常启动」、对面板说「没有轨迹」** — 上一版修的是**维护里的审计**（同一份数据两次维护报 934 与 749），这一版把同一根因在**其余生产消费方**上逐个收口。🔴 根因一句话：`EventLog.readAll(sid)` 在该会话事件镜像没加载完时返回空数组，"读不到"与"确实没有"完全同形。四处失真：①`session_event_search`（**模型可见工具**）把空当成"没有匹配" → 对模型说 `No events found matching "…"`，而事件就在库里；⚠️ 这个工具的典型用法就是**查别的会话**，那些会话镜像基本不可能已加载 ⇒ 这句"没有匹配"**几乎总是假话**；②`session_event_read` 把空当成"seq 不存在" → `Event seq=N not found`；③`generatePostmortem`（**落盘**报告 `~/.codem/postmortem/*.json`）把空当成"会话可能没正常启动"且 `totalEvents: 0` —— 报告在**错误路径**上生成，而错误往往就发生在启动后第一轮（镜像最可能没加载完的时刻），假结论被**持久化**；④`uiTrajectory.getSessionTrajectory` 返回 `[]` 说"没有轨迹"，而**本次运行的步骤就在内存里**（`catch` 分支至少退回内存，正常路径反而丢掉了）。✅ 修法：`event-log.ts` 新增一对最小公共面 —— `isSessionEventsReadable(sid)`（同步问：镜像已就绪吗；没有事件通道时返回 true，因为那种状态没有可判的东西）与 `whenSessionEventsLoaded(sid, timeoutMs?)`（异步等：触发加载并等就绪，超时/失败返回 false）；消费方按能力选：两个工具（本就 async）先等、等不到返回**明确错误**并带 `isError: true`（工具结果状态判定据此把这次调用标成失败，而不是"查了没有"）；`generatePostmortem`（async）先等，报告新增 **`eventsReadable`** 字段，读不到时写"**统计不完整、不许当成'没有事件'**"而**不再**编原因（"会话可能没正常启动"只有"读得到且确实为空"时才允许说）；轨迹面板是**同步渲染**的 ⇒ 不改异步（那是产品改动），改成**读不到就退回内存里的本次运行步骤**。🧹 顺手删掉 `surface-manager.hasEventLog(sid)`（= `count > 0`，**零调用者**）：它在加载窗口里会对一个有上千条事件的会话回答 `false`，名字承诺了它给不出的事实。🧪 新增 1 组 13 条 `event-read-readiness.test.ts`，每一处**成对**断言（没就绪时不许下结论 / 就绪时必须给真结论），只测一半会漏掉"修过头"；夹具要点写进用例：事件行必须**直接播种**，走 `append` 会因内部 `ensureLoaded` 把"未就绪"这一态消掉（第一版就这么写，`RR-1` 当场拿到 true）。⚠️ 诚实交代：这三处的行为由单元用例在"镜像未就绪"的确切状态下验证；打包版真机无法在不真发一轮消息的情况下驱动（工具与面板都要走模型/界面），所以真机口径是"没有回归"：维护仍报 749、未就绪 0、结构异常 0、会话/消息/事件计数不变。**实测**：渲染侧 **327 文件 / 5769 通过 / 16 跳过 / 0 失败**；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.89 | 2026-09-19 | **「历史缺口」这个数字一直在撒谎：同一份数据两次维护报 934 与 749，差距恰好是消息行数** — 闭合审计里那句「不变量审计的数字信不过」，并解释了一桩悬了三轮的公案。🔴 **根因**：`auditInvariantsForSessions` 的两条判据分别读 `getEventLog().readAll(sid)` 与 `MessageStorage.listMessages(sid)`，而两者都有同一条**硬路由规则** —— **该会话的镜像没加载完 → 返回空数组/空列表**；维护触发的这次审计**往往就是第一次访问这些会话**（`ensureLoaded` 触发加载后同步返回，真实现走异步 IPC），于是紧接着的读读到的是空。后果不是少报而是**多报**：把"事件读成空"当成"这些消息都没有事件记录" ⇒ 把该会话**每一条消息**都报成缺口。真机取证（同一份数据、两次维护相隔 36 秒）：**934**（= 657 + 277，即两个会话的**全部消息行**）vs **749**（= 505 + 244，与 DB 真值逐条相等）⇒ 第 47 轮那桩"水位漂移 777 / 757 / 671"的真正变量是**审计那一刻镜像加载到哪一步**，当时归因的"索引裁剪 / 隐藏状态导致集合摆动"**没有被证据支持过**（并集水位只把噪声压住、没修噪声源），注释已按新证据改正；而第 60 轮新接的**结构自检同样瞎**（镜像没加载时读到空事件 → 报 0 处异常，汇总行却写着"含事件库结构自检"，**印出来的不是真的**）。✅ **修法**：`waitForSessionMirrors` 对每个会话**同时等消息与事件两侧**镜像（`isLoaded` 且未被截断），**不增加 IPC 次数**（这些 `ensureLoaded` 本来就会被触发，这里只是等）、有总预算（4 秒按会话均摊）；等不到就**跳过**并计入新字段 `unreadableSessions`（"没检查"绝不折算成"没有缺口"）+ `[PersistFailure]` 写明后果，汇总行新增 `；**N 个会话的读侧镜像未就绪 → 本次未检查**`（`checked + unreadableSessions` 才是参与审计的会话总数）。⚠️ 第一版只等了事件那一侧，契约用例当场抓到它换个方向继续造假（消息读成空 → `RECORDED_BUT_NOT_VISIBLE` × 2）—— 两侧都等。🔴 **同一根因另外三处**：①`session_snapshot` 是引擎**字面写死**在 `repo.rs::events_compact` 里的类型、投影也真的 `case` 它，却不在 `SessionEventType` 联合类型与 `BUILTIN_EVENT_TYPES` 里 ⇒ `isValidEventType` 对它返回 false，而 `validateReplay` 的"已知类型"是**硬编码 `case` 清单**（同样缺它）⇒ 这份校验只要被调用就会把**合法快照报成未知类型**（更巧：它此前**全仓零调用**，所以假报警一直没人看见）—— 判据改走 `isValidEventType()` 唯一真源，`event-type-set-consistency.test.ts` 解析源码把"联合类型 ↔ 内建集合"钉住（3 条齿：少一个红、多一个红、注释里的类型名不算成员）；②**快照边界上的工具配对**：快照语义是"之前的事件已删、状态固化在这条里"，待配对集合必须按快照重建（与 `applySnapshot` 重建 `toolCallIndex` 同理），否则"`tool_call` 在快照里、`tool_result` 在快照之后"这种**正常日志**会被判成孤儿；③**提示词里的"上次活动时间"写成 `unavailable`**：`findLastVisibleMessageTime` 把"事件读不到"当成"查不到时间"，而启动后**第一轮**提示词拼装往往就撞在这个窗口上 —— 现在**同步**回退到消息表最后时间戳（提示词拼装是同步的，"后台算好下次再用"救不了它要救的场景；第一版正是那样写的，用例直接红），两边都没有才允许 unavailable。🧹 **顺手删掉一段"永远不可能命中"的死读**：`project/files.ts` 的 "Layer 4 会话级指令"（v1.1.0 加的）读 `getEventLog().readAll("")`，注释写 "session-agnostic global event log"，但事件镜像**按会话 id 路由**，空 id 永远返回空数组 ⇒ 那个循环**一次都没进过**，且 `instructions_override` **从来没有写入方**（`git log -S` 只命中"加了这段读"的那次提交）；更坏的是 `maintenance.ts` 里"不能压缩事件"的论证曾把它举为**真实消费者**（"内容不在消息表里，删了永久消失"）—— 用不可能命中的读当论据就是第 45 轮已撤回过一次的**同一类假论据**，现在论证改成如实说"`session_meta` 今天没有任何生产读取者"（写它的 `recordSessionFeedback` 有调用者、读它的三个候选全部落空），并加源码判据 RV-12（生产代码不许再出现 `readAll("")`，带齿）。⚠️ 能力没有减少：会话级指令由 `core/prompt/instruction-layers.ts::loadLayeredInstructionsSync` 真实提供（另有两组用例守着）。🧪 新增 4 组 18 条（`replay-validation` 12 / `invariant-audit-load-window` 4 / `event-type-set-consistency` 7 / `time-context-fallback` 3），**牙齿检查**：删掉等待 → `RVL-W1/W2` 红；判据改回硬编码清单 → `TYPE-*` 与 `RV-5` 红。**实测**：渲染侧 **326 文件 / 5756 通过 / 16 跳过 / 0 失败**；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.88 | 2026-09-18 | **库损坏时，设置是唯一"没有任何等价物"的数据（消息有权威日志、归属有抢救、设置什么都没有）** — 闭合审计里那句「损坏库备份**无等价物**」。库被判损坏 → 坏文件改名 `<db>.corrupt-<ts>` → 建**全新空库** → 从**权威会话日志**重建索引：消息正文/工具调用/`hidden`/`metadata` 有日志、项目与会话归属有第 47 轮的抢救（只读坏文件 → 旁路文件），**而设置（模型/provider、安全模式、主题、语言、插件禁用清单、各类水位与标记）不在日志里，永久丢失** —— 尽管坏文件里它们通常读得出来。修法分两半：① 引擎侧（`engine.rs::salvage_projects_from_corrupt`）抢救时也读 `settings` 写进同一旁路文件的新一节，并**去掉 `if sessions.is_empty() { return 0 }` 闸门**（设置的可读性与 `sessions` 完全独立，原来"只有设置读得出来"的坏库连设置也救不回来）；② 渲染侧（`restoreRecoveredSettings`）三硬规则 —— **只补新库缺的键**（已有不动，否则旧快照盖掉这一版刚写的当前状态）、**黑名单不许继承**、**三类分别计数**。🛡️ **黑名单是更要紧的一半**，三条都读过消费者代码才定：`codem-storage-content-watermark`（自愈水位：新库此刻为空，而自愈判据「上次很多、现在 0 ⇒ 疑似丢失」会跑 **replace 语义整库重写**的 `migration.auto` —— 继承水位等于**主动武装破坏性路径**；不继承则没有基线，自愈只记新水位什么都不做）、`codem-fts-bigram-rebuilt`（新库 FTS 是空的，继承"已重建"会让重建被跳过 → 中文搜索静默失效）、`codem-storage-integrity-checked-at`（12 小时节流，而刚从一个坏文件里爬出来，新库应尽快自检）。测试两侧各钉一段：引擎 `salvage_sidecar_carries_settings_and_ownership`（含"不许继承的键也要读出来"——读与写是两件事）+ `salvage_returns_zero_and_writes_nothing_for_unreadable_file`（读不出=0 且**不留空文件**）；渲染 `SET-RESTORE-1..4`（缺的补/已有的不覆盖/黑名单按名单拒绝含对照组/形状不对安静返回）。**牙齿检查**：黑名单清空 → `SET-RESTORE-3` 红；引擎"读不出就放弃"改回 → 红。⚠️ **诚实交代：窗口很窄**（真 CLI 实测三种损坏：破坏文件头 → 判损坏但任何表都读不出；毁第 1 页 schema 区 → 判损坏但 `prepare` 全失败；毁中间数据页 → **根本不判损坏**）—— 真正的风险窗口是「schema 还在、某张表页坏到打开即判损坏」这一窄缝；常见的「库坏了但查询还能跑」（完整性检查失败 → 从日志重建）**不丢设置**，因为重建只动 `sessions`/`messages`/`tool_calls`。仍然做完的两个理由：**它是三类数据里唯一没有等价物的**；**黑名单那半边是净收益**。同轮顺带核对"两套引擎并存会不会丢数据"（真 CLI 逐 id 比对副本）：旧库 821 条消息 id、新库 934 条，**只在旧库的 0 个**、只在新库的 113 个（第 52 轮从日志补回的）⇒ **并存没有丢数据**；但旧库是陈旧快照，继续用旧版所做的事不会进新库（自动迁移守卫在"新库非空"时拒绝导入 ✓ 不会误覆盖）。**实测**：引擎 `cargo test` 85 + 54 + 48 通过 / 0 失败；渲染侧 **322 文件 / 5729 通过 / 16 跳过 / 0 失败**；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.87 | 2026-09-18 | **数据目录解析失败时，应用会把库建到别处（这次进了我的仓库，差点被提交）** — 🔴 根因：**同一个事实两个来源**。渲染侧走 Tauri 的 `app_data_dir()`（Windows = `SHGetKnownFolderPath`，不读环境变量），引擎走自己手写的 `resolve_db_path()`（读 **`APPDATA` 环境变量**）。两者不等价：`APPDATA` 缺失时渲染侧照常写真实目录、**引擎却退回"当前目录里的裸文件名"**（`PathBuf::from("codem-db-rust.bin")`，注释理由"宁可可用也不要存储层直接不可用"）。真机后果：应用在 `C:\mimo-gui\`（仓库工作目录）建了一个**全新的库**——用户看到的是另一个库、数据写进任意目录、两个库静默分叉，而那份库含用户全部对话正文，被 `git add -A` 带进提交（GitHub push protection 拦下，**未外泄**）。修法：① **同源** —— 引擎改用 `dirs::data_dir()`（同一个已知文件夹 API），环境变量在不在位置都一样，这类分叉按构造不可能再发生；② 逐级退回改为 `CODEM_DB_PATH` → 已知文件夹 → `XDG_DATA_HOME` → `HOME` → `%USERPROFILE%\.codem` → 工作目录下的 `.codem-portable/`（带名字的子目录），**绝不退回裸相对文件名**；③ **不静默** —— 非标准位置打醒目告警，并由 `storage_info` / `storage_health` 暴露 `standard` / `reason`，界面终于能说出"库在哪、为什么在那儿"。测试每一档都可复现（纯函数注入候选来源；另有一条真去清 `APPDATA` 再解析、断言位置不变的"接线"测试；**牙齿检查**：兜底改回裸文件名立刻红）。真机验证（打包版、**故意删掉子进程的 `APPDATA`** = 事故原始触发条件）：仓库目录前后**都是 0 个数据文件**、`storage_info` 报 `standard=true, reason=null`、界面读到真实数据（3 会话 / 934 消息 / 991 工具调用 / 3112 事件）。同轮补上审计点名的另一个缺口：**`tool_calls` 大 payload 量级用例**（真 CLI 契约往返：单条 args 2.11 MB + result 1.98 MB + 一条消息 500 个工具调用；**实测写入 78 ms / 读回 13 ms**；判据穿过 `args` 是 JSON 字符串那层编码做**逐字节**比对，含整体替换后旧记录不留残）。**实测**：引擎 `cargo test` 85 + 52 + 48 通过 / 0 失败；渲染侧 **321 文件 / 5725 通过 / 16 跳过 / 0 失败**；`tsc` 0；**10 道 audit 门禁** exit 0。 |
| v1.16.86 | 2026-09-18 | **损坏恢复里「抢救到的项目没写回」以前是静默的；另立两道机器约束** — ①**真缺陷**：库文件损坏后引擎把抢救出的项目/会话归属交给渲染侧写回，而那个写入点只看了 `domainWrite` 的 true 分支（`if (ok) out.projects = …`）—— `false`（= 端口没接手这次写，**行根本没进库**）什么都不做，于是"一行都没写回去"既不上报也不记录，那句写好的后果说明只存在于源码注释里。**确实可达**：该写入点写 `projects`，判"能不能写"的依据却来自 `sessions` 的读 —— 两张表就绪状态互相独立。修法：`reportWriteNotAccepted(...)` + 带后果文案；调用方的日志判据也从 `projects>0 \|\| sessions>0` 改成把 `skipped` 算进来（原来"全失败"这种最坏情况恰好一行日志都不打）。②**通道缺陷**：`reportWriteNotAccepted(scope, note)` 的 `note` 只进 console —— 用户可见的 listener/事件只拿到 `{area,message,count,kind}`，于是界面永远显示通用的"该功能本次没有生效"，最关键那句"会导致什么"到不了用户眼前；现在该函数接受可选 `PersistFailureOptions`（向后兼容），损坏恢复那条已用上（"抢救出来的 N 个项目没写回索引：这些会话会落到「全局项目」…"）。③**第 10 道 audit 门禁**（`check-write-return.mjs` + `GATE-13`）：域写入的返回值必须被处理；判据来自真实现给出的保证（同一函数里先成功读过同一张表、或 `domainPort(T)` 非空 ⇒ 镜像已就绪 ⇒ 写必然被接手 ⇒ `false` 不可达）；实测**扫描 844 个文件 / 写入点 88 处 / 同表先读后写 37 处 / 未处理 0 处**，canary 三态（跨表必须报、同表不许报、带上报不许报）。第一版判据没有那条保证，一次性报出 **35 处假阳** —— 收紧靠的是把真实现的保证写进判据，而不是往允许清单里塞 35 条。④**并发轴（此前未系统查过）新增 4 条用例** `concurrency-lost-update.test.ts`：用假端口卡住 `messages.count` 造确定的交错窗口，证明"读→await→写"里改名与对账**都要留下**、置顶与对账都要留下、**不许把已删除的行写回来**（连写都不发起）、两个对账并发不留半截行；牙齿检查：把对账换成"写回旧快照"即变红（也证明 `updateSession` 内部"写前重读"是这类路径的安全形态）。⑤**发布链路收尾**：上一轮修好的更新清单补齐最后两段验证 —— 发布产物可下载且与本地产物**逐字节相同**（42,345,403 字节、sha256 `4fd4b049…80d5`）、签名用配置公钥验过（Ed25519 over BLAKE2b-512 / key id `1214c3c700876359`）、**已安装的 1.11.0 能发现 1.16.85**（真机、隔离数据目录）；`npm run verify:update-manifest -- --remote` 把这几件事变成发布期校验（7 项通过）。**实测**：渲染侧 **320 文件 / 5723 通过 / 16 跳过 / 0 失败**、`tsc` 0、**10 道 audit 门禁** + UI 门禁全绿、CSS 契约快照无变化。 |
| v1.16.85 | 2026-09-18 | **子智能体的会话谱系一直是 NULL + 一条我先前的结论被自己撤回 + 输入草稿空行堆积 + 「检查更新」一直是坏的** — ①**真缺陷**：`sessions.parent_id` 是 `session_trace`（`Parent:`/`Ancestors:`/`Descendants:`）唯一的谱系来源，而给子智能体补会话行的 `ensureSubagentSession` 建行时没写它，且建行走的是**裸 `INSERT INTO`**（`domainWrite` 默认 `mode:"insert"`）——落库的那一行就是构造器给出的列，于是子会话永远报 `Parent: (root)`、队长会话报 `Descendants: []`；父子关系当时就在函数作用域里（上一行刚用它取过 `project_id`），属于"拿到了却没写下来"。两半都补齐：调用方传 `parentId` + `sessionToWire` 写 `parent_id`。②**撤回**：同一天早些时候我报过"改名/置顶/拖拽排序会把谱系清成 NULL（因为 `replace` = `INSERT OR REPLACE`）"——**这条是错的**：引擎的 `replace` 是"先 `UPDATE` 只写本次提供的列、0 行才 `INSERT`"（`crud.rs:412-429`，引擎自己的用例 `crud_upsert_replace_does_not_cascade_delete_children` 就断言"只给 title 时 project_id 不许被清空"），渲染侧镜像也是合并写（`rust-port.ts:2063`）；当时唯一"会清空"的是**测试基座**（假端口把 replace 写成整行替换，比引擎更严格）——**假端口造出一个产品里不存在的缺陷**，而我只用假端口验证过它，"牙齿检查通过"反而强化了错结论。处置：基座按引擎改正、撤回所有基于该结论的注释与用例、新增 `fake-port-fidelity.test.ts` 把三条引擎语义写成断言（基座不许往任何方向漂）。③**新门禁**（第 9 道 audit）：行构造器必须覆盖表的所有列（`schema.sql ∪ migrations.json` 的迁移列都要算上）；实测**写入点 55 处（构造器 48 / 内联 7）、27 个构造器、含展开跳过 4、未解析 0、发现问题 0**，三类"看不见的地方"都有界且可见 + 内置 canary。④**真机钻取顺手查出的草稿泄漏**：`composer-draft-*` 有 **29** 条全为空串、其中 **26** 条属于早就删掉的会话 —— 防抖定时器**无条件写**（切过去待满 500ms 就写一条空草稿）+ 清空时写空串。现在不变量是"`composer-draft-<key>` 存在 ⇔ 有一份**非空**草稿"（空串即删行、定时器与冲刷共用同一判据、删会话连带清草稿），用户库里 29 条空行已清理（**非空 0 条**，未动任何用户文本）。⑤🔴**「检查更新」从来没成功过**：发布后用应用自己的更新器做端到端确认，报 `None of the fallback platforms ["windows-x86_64"] were found in the response platforms object` —— `latest.json` 一直写的是 **v1 的 `platforms.windows`**，而 v2 更新器按 `{os}-{arch}-{installer}` / `{os}-{arch}` 找键（`tauri-plugin-updater-2.10.1/src/updater.rs:578-597`，`updater_os()`="windows"、`updater_arch()`="x86_64"）；两个候选都找不到就 `TargetsNotFound`，**所有版本之间的自动更新从没走通过**（界面是诚实的"更新失败: …"，不是假成功，但功能一直坏）。修法：生成器同时写 `windows-x86_64-nsis` 与 `windows-x86_64`、**不留** v1 的 `windows` 键，新增 `VERSION-5` 把该契约变成机器约束（牙齿检查：改回 v1 → 红）；修正后的清单已重传到本版本 release。⚠️ 诚实交代：修正后本机验证时 GitHub 不可达（`无法连接到远程服务器`），"下载+验签+装包"这一段本轮**没跑成**，下一轮第一件事就是跑通它（**第 55 轮已补齐**：产物可下载且 sha256 与本地产物一致、签名验过、1.11.0 能发现新版本）。⑥**真机验证（打包版 1.16.85，引擎与 UI 两侧都量）**：引擎临时库上 `insert` 带 `parent_id` → 写进去了、`replace` 只给 `id+title` → `parent_id` **原值保留**（实测推翻旧结论）、`insert` 不带 → NULL、`insert` 同 id 第二次 → `CONSTRAINT: UNIQUE constraint failed`、`replace` 显式 `null` → 清空；打包版 UI 钻取：点分叉按钮 → 新会话 `parent_id` = 源会话、侧边栏改名 → 谱系保持、置顶 → 谱系保持、删除 → 会话行与 262 条消息随级联清掉（934 → 1196 → **934** 精确还原）、草稿键 0 条；草稿行为：启动后 0 条、敲字 → 出现、删光 → 消失。**实测**：渲染侧 **319 文件 / 5715 通过 / 16 跳过 / 0 失败**、`tsc` 0、**9 道 audit 门禁** + UI 门禁全绿、CSS 契约快照无变化。钻取记录见 `.preview-shot/_audit/DRILLS-round54.md`。 |
| v1.16.83 | 2026-09-18 | **索引悄悄少了 112 行，没有任何信号：现在维护自己会发现并修回** — 🔴 架构约定"JSONL 是权威副本、SQLite 索引可重建"，但**修复的触发器**此前只有两个（完整性检查失败写的标记、引擎恢复时写的标记），于是有个静默缺口：**索引真的少了行、但库没坏、也没人写标记** → 什么都不会发生。真机实证（对用户真实库钻取时发现）：会话 `1788268497135-31x6vdt97` 的权威日志有 **657 个唯一 id**、索引只有 **545** 行，差 **112 行**零信号；跑一次"从日志重建"后索引变成 657（与日志逐条一致、内容逐条对上），证明是索引丢了而非日志多了。**判据的根据**：裁剪（`trimIndexedMessages`）是**软删除 + 裁剪标记**、行留在库里（否则 `message_feedback` 外键目标消失），所以 `messages.count.total` 不会因裁剪变小；正常方向的落后是"索引多、日志少"（老会话日志未回填）**不该告警**；反向只可能来自索引写入丢失/被外力删。**修法**：维护里加对账（跳过带会话墓碑的），发现落后就 `rebuildIndexFromSessionLogs(sessionId)`（已端到端验证幂等、只 upsert 不删行）+ 如实上报（含数字），汇总新增 `repairedBehindMessages`（与标记触发的整体重建分开报）。⚠️ **我自己第一版写错了**：判据"只比已 hydrate 的会话"看着保守，实际在**最该发现问题的形态上瞎掉** —— 索引为空的会话在回填里走 `if (messages.length === 0) continue`，回填跳过它、也就不会 hydrate 它 → 对账永远看不到它。这是我在真机夹具（日志 3 条/索引 0 行）上撞出来的；现在检测器主动 `ensureSessionLogHydrated`（幂等去重），对应把 `BEHIND-3` 的断言**推翻改写成相反性质**并新增 `BEHIND-3b`（日志读失败 → 不告警）。同轮还**第一次端到端跑通渲染侧重建全链路**（删空索引 + 写标记 → 维护修回 3/3 且清标记；再跑一次验证 tombstone 阻止复活），并顺手清掉一个由 `global.jsonl` 复活的**幽灵会话**（按产品机制写会话墓碑 + 删行 + 重建验证）。回归 5 条，**验证过有牙齿**。**实测**：渲染侧 **317 文件 / 5700 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿。 |
| v1.16.82 | 2026-09-18 | **卡死的 IPC 不再转圈到天荒地老** — 审计"通信链路 · 重试与超时"轴时发现：**重试有、超时没有**。引擎侧有 `PRAGMA busy_timeout=5000`（锁等待有界），渲染侧 `invokeCommand` 的 promise 一旦不 settle（Tauri 命令卡在 `spawn_blocking`、磁盘/杀软层面 IO 挂住、通道异常）就**永远不回** —— 界面转圈到天荒地老（新加的「正在读取历史消息…」会一直转），更根本的是本项目**所有**机制（重试白名单、失败横幅、"读不到 vs 没有数据"三态、`CORRUPT` 重建标记）都建立在"错误会被抛出来"这个前提上，而"什么都不发生"不是用户能处理的状态。修法：给两个 IPC 出口（`call` 与 `storage_batch`）都加上界等待 **60 秒**（实测最慢的正常命令是 30 MB 会话的 `messages.list` 一次 IPC、100k 行会话的分轮加载每轮 <1 s，60 s 是两个数量级以上余量）；**`retryable: false` 是刻意的**（超时不能证明命令没生效，自动重试对 `messages.create`/`events.append` 就是插入两条 → 给明确不可重试的错误让用户看到"这次没成功"）；超时器成功/失败后都清掉。回归 4 条，**验证过有牙齿**（窗口拉到 1 小时等价于无保护后 2 条立刻失败）。过程撞红并修掉一个**脆弱测试助手**：`domain-mirror.test.ts` 的 `settle()` 原来只数微任务（12 个），本次每次 IPC 多一个 `.finally()` 就让 5001 行/每轮 1000 行的镜像循环跑不完 → `DOM-8` 误判；改成让出**宏任务**（`setTimeout(0)` 排空全部微任务、与链深度无关），假计时器模式下用 `advanceTimersByTimeAsync(0)`（第一版直接用 `setTimeout` 会卡到 5 秒超时）。**实测**：渲染侧 **316 文件 / 5696 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿。 |
| v1.16.81 | 2026-09-18 | **「库坏了但查询还能跑」这种损坏，发现延迟从 12 小时压到 1 小时** — 起因是第 49/50 轮发现完整性检查的注释成本与实测差**一个数量级**，于是把"规模"这个变量真的扫了一遍。旧注释称 `quick_check` 真机 **901 ms @10k 行 / 4,469 ms @100k 行**、且"维护是启动时 await 的一步，直接加 1–4.5 秒"，据此定了 12 小时节流。第 51 轮用**同一套 harness**（同时量 `health` 作"进程启动+开库"基线，只把差值算作检查成本）实测：**10,000 行/14.1 MB → 32 ms**、**100,000 行/137.2 MB → 325 ms**；用户真实库（16.24 MB/61k 审计行）CLI 直跑 **75–77 ms**、应用内维护 **346–425 ms**（跳过时 221 ms）—— 趋势同形但**绝对值小一个数量级**；而"阻塞启动"**不成立**（启动维护是 `void (async …)` **后台任务**，首屏不等它）。新策略按库大小分档：小/中库 **1 小时**（把"数据页损坏但查询仍正常"这种**没有别的信号**的损坏的发现延迟从 ≤12h 压到 ≤1h）、大库（≥256 MB，**未实测**）**保持 12 小时**（按未实测规模放宽节流是拿用户机器赌博）、**读不到库大小按小库处理**（不该退化成永远 12 小时），跳过理由里写明库大小与生效窗口。第 49 轮已把"命令报 `CORRUPT`"这条**即时**信号接到重建标记；这条改的是"损坏存在但查询还正常"那条路径。**新增 7 条用例**（这道节流原来**一条用例都没有**），**验证过有牙齿**（回退窗口后 3 条立刻失败）。**实测**：渲染侧 **315 文件 / 5692 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿。 |
| v1.16.80 | 2026-09-18 | **索引空了、权威日志还在时，界面说的是「开始新对话」** — 🔴 `listMessages` 合并"索引 + 权威日志"，两边都空时返回 `[]`，而这一个 `[]` 同时代表①真的没有消息、②索引镜像还在加载、③**权威日志还没读进来**。第 49 轮关掉了②，①③仍混在一起，而③的后果最重：日志是**权威副本**、索引只是可重建的查询索引，所以"索引空了而日志里有内容"正是这套架构**要救的场景**（索引被裁 / 崩溃丢写入），界面却渲染**欢迎页**说"这个会话没有消息"。**为什么一直没被发现**：进会话时**没有任何生产代码**调 `hydrateSessionLog` —— 日志只在**启动维护的回填**里被读过，于是"维护跑完后一切正常"，缺陷只在"维护还没跑到那个会话"时出现；而用例里大家都先 `await hydrateSessionLog(...)` 再读（测试替做了这一步）。修法：`sessionLogReadState()` 三态（`hydrated`/`pending`/`failed`，成功时空数组也写入=定论）+ `ensureSessionLogHydrated()`（幂等去重，失败记成**定论**而不是永远"正在读取"）+ store 里两种"还没到"都算 `messagesLoading` 并在空结果时**主动去读日志**、读好后重读、只在"日志读过且确实为空"才落回欢迎页 + `readSessionMessages` 把**"文件不存在"与"读失败"分开**（原来 `catch { return 空 }` 把两者合并，这正是这一类缺陷的最底层形态）。**真机核验**（打包版，夹具 = 索引 **0** 条 + 权威日志 **3** 条）：打开后**渲染出日志里的 3 条消息**（内容逐条对上）、**全程没有欢迎页**；反面对照点"新建会话"落到欢迎页（没有引入"永远转圈"）。诚实交代：加载态本身没被真机采样抓到（日志只有 3 行、读得太快，0ms 首次采样时消息已到），由 `LOGLAG-1/2` 用例守。回归 4 条 + 把 `READFAIL-8` 改写成真不变量（"读不出消息时绝不能落到欢迎页"，允许两种形态）+ `READFAIL-8b`（日志有定论 + 镜像不可用 → 必须明确说读不到）；**验证过有牙齿**（回退判据后 `LOGLAG-1/2` 立刻失败）。**实测**：渲染侧 **314 文件 / 5685 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿、CSS 契约快照无变化。 |
| v1.16.79 | 2026-09-18 | **库坏了却要等 12 小时才知道：现在第一条失败的命令就留重建标记** — 🔴 `port.ts` 的错误码表上写着 `"CORRUPT" // 库损坏（走索引重建）`，但**实现里没有这条链路**：全仓 `markIndexRebuildNeeded` 的调用点只有"引擎打开时发现**头部**损坏并重建"与"**12 小时节流**的完整性检查失败"两个。于是当一条普通命令在**数据页**损坏上报 `CORRUPT` 时（真机钻取证实：数据页坏了以后普通读命令**照样成功**，只有 `integrity_check` 报得出来），界面只看到那一次操作失败，"索引需要重建"标记**不会被写** —— 自愈要等到下次完整性检查，最长 **12 小时**（真机日志里那句"距上次检查 7.7 小时…还需 4.3 小时"就是这个形态），期间引擎继续用不可信的索引回答查询。修法：把 `CORRUPT` 挂到命令漏斗（所有命令都经过 `call`/`unwrap`）→ 留标记 + 如实上报；**每进程只做一次**（否则读循环里会写上千次）；**只在端口已注册后才动手**（引导阶段引擎根本打不开，bootstrap 自己会如实上报，且没有端口就没有维护、标记没人消费）；**只补标记不做自动修复**（在错误路径顺手重建会把读命令变成分钟级全库 upsert）。引擎侧钻取（对**副本**做，从不碰 `%APPDATA%`）：**头部**损坏 → 坏文件**改名**为 `<db>.corrupt-<ts>`（16.24 MB 原样保留）+ 新库 46 表 + `recovered:true`/`recovered_from`（备份有等价物）；**数据页**损坏 → `integrity_check` 精确报坏页而普通读照样成功；`messages.rebuild_index` 一个事务写入且**连跑两次结果不变**（恢复可重复执行）。顺带核实一处**文档与实测差一个数量级**：注释写 `quick_check` 真机 901 ms@10k / 4,469 ms@100k，我量的三处是 **76 ms**（引擎 CLI 全库）、**425 ms 含检查 / 221 ms 跳过**（应用内维护）—— 因无法解释旧数字来源，**本轮不动 12 小时策略**（按没核实的数字放宽或收紧比不改更糟），已把测量与不一致写进注释。回归 4 条，**验证过有牙齿**（回退判据后 3 条立刻失败）。用例教训：这条链是异步的（动态 `import` + 文件 IPC），第一版只等 10 ms 就断言 →"没写"与"还没写完"分不开、时红时绿，现在一律**等条件** + 沉淀窗口。**实测**：渲染侧 **313 文件 / 5680 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿、CSS 契约快照无变化。 |
| v1.16.78 | 2026-09-18 | **启动时那 154 毫秒的假警报：还没读到 ≠ 读不到** — 🔴 真机轮询 DOM 抓到的时间线：打包版启动后，针对一条**真有 277 条消息**的会话，t=225ms 时界面渲染的是「暂时读不到这个会话的历史消息／这不代表消息丢了…」，t=379ms 告警消失、出现第 1 条气泡。也就是**一条完好的会话每次启动都被说成"读不到"**。成因是判据把两件事合并了：消息镜像按会话**惰性加载**，而 `isMessagesReadUnavailable()` 过去只看 `isLoaded === false` —— 那个状态同时代表"**还没到**（加载在途）"与"**读不到**（端口没有该能力 / 加载失败过）"。修法把"在途"这一态从端口带到界面：`RustMessageMirror` 暴露 `isLoading(sessionId)`（它本来就有那个 `loading` Map）、新增 `isMessagesReadPending()`、`isMessagesReadUnavailable()` 在在途时返回 false、store 新增与 `messagesReadUnavailable` **互斥**的 `messagesLoading`、`ChatPanel` 新增"正在读取历史消息…"一支且**欢迎页在加载期间不出现**（否则用户以为会话是空的）。判据仍来自端口，不是"等 300ms 猜一下"。代价说清：用户看到"读不到"会以为存储坏了；更贵的是"狼来了"喊多了，**真正的"读不到"就没人信了**。两处改动互为纵深防御（任一处即可拦住），所以**验证牙齿时两处一起回退**才复现（先记下这个现象，免得日后误以为用例没牙齿）。回归 5 条 + 2 条接线用例，`BOOT-2` 是反向对照（端口不在时"读不到"照旧报警，且**不许**被误标成"加载中"）。**实测**：渲染侧 **312 文件 / 5676 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁全绿、CSS 契约快照无变化（复用了既有类）；真机复验同一条 277 条的会话，启动时间线 `framesWithUnavailableBranch: 0`。 |
| v1.16.77 | 2026-09-18 | **翻页失败不再被写成「没有更多历史」（同一类缺陷的最后一条路）** — 🔴 `loadMoreMessages` 原来只有一个结局：拿不到更早的消息就把 `hasMoreMessages` 置 false，于是"这次读失败了"与"真的翻到开头了"合并成同一件事。而那个标记同时控制着**「↑ 滚动加载更多历史消息」提示条**与**滚动到底的自动翻页**（`ChatPanel` / `NbChatPanel` 都按它渲染）—— 一次失败的读之后，用户不仅看不到更早的消息，而且**提示条与自动翻页一起消失、再没有任何重试机会**，界面上一切正常、没有任何错误，看起来只是"这个会话本来就不长"；一个真有 800 条历史的会话就这样被永久渲染成"就这么多"。修法与首屏那条同源（`isMessagesReadUnavailable`：端口在 + 该会话镜像已接手 + 没被截断），但**写的东西不同**：读不可用或抛错 → `hasMoreMessages` **保持 true**（"读不到"不构成"没有"的证据）+ `loadMoreReadUnavailable` 标记 + 界面给说明与**重试入口**；读可用且确实到开头 → 才允许收掉入口。抛错路径原来只有一行 `console.error`，现在同样走可见通道。标记是"那一次读"的结论，首屏重读/切会话/`clearMessages` 都会清掉。回归 7 条（含"正常翻到开头**不许**上报失败"的反向对照）+ 2 条接线用例，**验证过有牙齿**（回退判据后 3 条立刻失败）。**实测**：渲染侧 **311 文件 / 5671 通过 / 16 跳过 / 0 失败**、`tsc` 0、8 道 audit 门禁 + UI 门禁（error 0 / warn 0）全绿、CSS 契约快照 +3 类（diff 逐条核对只有新增）。过程：我在新 CSS 里写了 `padding: 2px`，UI 门禁当场报 `spacing-raw` 并连带顶红 `ui-consistency` 的基线用例 —— 改成 `var(--space-1)` 后两处同时转绿（这是该门禁累计抓到的第 6 个错）。 |
| v1.16.76 | 2026-09-18 | **"刚关掉的插件重启后自己又开了"这条静默回退被堵住了（+ 真机上抓到的开关不刷新）** — 🔴 ①**插件开关可能在重启后被静默改回去**：第 47 轮把权威介质改成 DB 之后，**写入顺序**还留着一条缝 —— 插件管理器只写 localStorage 镜像 → 派发 `codem:plugin-state-changed` → App 收到事件后动态 `import()` → 异步收编进 DB。而 `setSettingJSON` 的契约是"内存即时生效 + 异步落库"，进程在这个窗口里被杀掉，盘上 DB 就是旧值；下次启动那条读契约（"DB 有值就以 DB 为准**并回写镜像**"）会把用户的开关**静默改回**，连镜像里的新值也一起抹掉 —— 事后无法取证。修法三条：**写入方唯一**（`PluginManagerService` 两个写入点都走 `saveDisabledPlugins`：DB 列表+DB 写入时刻+镜像+镜像写入时刻，同一个 `Date.now()`）；**对账有判据**（新增 `reconcileDisabledPluginsAtBoot()`，用写入时刻判断"哪一份更新"：内容不同且镜像戳更新 → 取镜像并回写 DB；镜像无戳/DB 更新/戳相等 → 仍以 DB 为准；有一边没值 → 沿用迁移/首次运行默认值）；**分歧必须可见**（"有一次写入没落地"经 `reportPersistFailure` 上到界面横幅，只有"DB 完好、用户什么都没丢"的那一档刻意不弹，免得淹掉要紧告警）。插件管理器也不再自己读 localStorage，面板开关与工具条显隐从此同源。回归 11 条（`plugin-toggle-medium.test.ts`，真端口契约层面）。🔴 ②**顺带修掉真机抓到的：开关"点了像没反应"** —— 在打包版上点 `@codem/ui-game` 的开关，权威介质**当场就写对了**（`["@codem/ui-game"]` → `[]`，时间戳与镜像一致），但卡片上的开关**一点没变**（`aria-checked="false"`、`aria-label` 仍是「enable plugin」），**再点一次弹出的是「确认关闭插件」**。根因是 `useMemo` 依赖写漏：里面读 `manager.getPluginStates()`（实时状态），而依赖是 `[manager, searchQuery, activeCategory]` —— `manager.subscribe(() => setForceUpdate(n => n + 1))` 只让组件重渲染，三个依赖一个没变 → **列表整个不重算**（顶部的计数在 render 里直接算所以更新了，卡片没有）；`PluginMarketTab` 的 `pluginStates` 是同一个写法。修法：把只取 setter、**丢掉值**的 `const [, setForceUpdate]` 改成留下值的 `stateVersion` 并让派生 memo 依赖它，市场页签由父组件把版本号传下去。**同一类写法全仓扫过**：`const [, setXxx] = useState` 共 3 处，另两处的数据读取都在 render 里直接进行、没有 memo 缓存，逐处确认不受影响。回归 4 条 + `MT-7`，且**验证过有牙齿**（回退修复后 4 条全失败，报的正是真机那句症状）；过程中发现第一版测试替身**比实现宽松**（假 manager 返回内部对象引用，缓存被就地改写把缺陷藏住了）已改成返回快照。**实测**：渲染侧 **310 文件 / 5663 通过 / 16 跳过 / 0 失败**、`tsc` 0、7 道 gate + UI 门禁全绿、CSS 契约快照无变化；真机复核（打包版逐项实测）：①写盘当场落权威介质（DB 列表与**写入时刻**和镜像完全一致，不需要等 App 收编）；②切换后卡片开关与 `aria-label` 同步刷新；③**模拟崩溃窗口**（DB 旧值/旧戳 + 镜像新值/新戳）后重启，DB 被改写成镜像那份（旧契约会静默改回用户的选择）；④同一场景下界面上真的出现了告警横幅 —— 并因此在横幅上抓到"已按较新的一份恢复"与"重启应用后会丢失"**互相矛盾**的两句，已改成由上报方给出真实后果（`consequence`）。 |
| v1.16.75 | 2026-09-18 | **"失败必须可见"这条契约在界面上终于落地了** — 🔴 ①**写盘失败在用户空闲时完全不可见**：`reportPersistFailure` 的可见出口只有一条 → `addGuidanceMessage(...)`，而 `guidanceMessages` 在界面上**唯一**的渲染点带着 `isSessionStreaming` 前置条件 → 用户空闲时（恰恰是大多数写失败发生的时刻）改会话标题失败、删项目失败、保存权限规则失败、**新建会话写库失败**、**存储引擎未启动**，**界面什么都不显示**（仓库里那两处最关键的告警走的正是这条不可见通道）。②**而且它被渲染成"用户引导"**：那条队列的语义是"对正在跑的回合的引导"，主按钮「立刻引导」→ `interruptForGuidance` → **中断正在生成的回复**且不注入任何东西 —— 把"出错了"渲染成"引导"是范畴错误。修法：给失败提示**自己的通道**（`persistAlerts` + `PersistFailureBanner`）——与流式状态无关（空闲时也显示）、常驻直到用户关掉（写失败=重启会丢，toast 一闪不够）、同区域合并并显示累计次数（磁盘满不刷屏）、`persist`/`action` 两种语气用不同颜色（严重程度不同）。另把"上次未正常退出""界面渲染崩溃后已恢复""存储引擎未启动"三条也从这个通道走。回归 6 条，其中 `ALERT-5` 是**正面判据**：断言渲染点**不带** `isStreaming` 之类条件 —— 那正是缺陷本体。**实测**：渲染侧 **307 文件 / 5638 通过 / 16 跳过 / 0 失败**、Rust **140**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿；CSS 契约快照 +7 类（diff 逐条核对只有新增的）。过程：UI 门禁本轮又抓到我在新 CSS 里**发明了三个不存在的令牌**（`--bg-elevated`/`--color-error`/`--color-warning`，真名是 `--surface-content`/`--error`/`--warning`）以及**漏给一个类写样式**（`persist-alert-text`）——这个门禁两轮里一共抓到我 5 个错误。 |
| v1.16.74 | 2026-09-18 | **"读不到"不许被渲染成"你没有数据"（三处纵向收口）** — 🔴 ①**读消息失败被渲染成「开始新对话」欢迎页**：`store.loadMessages` 读失败 → `messages: []` → 用户以为**对话被清空了**（仓库自己记过一次真机事故：一个**确实有 27 条消息**的会话点开是空白且无任何报错），之后输入的每句话都追加进这个他以为"空"的会话。修法：新增 `messagesReadUnavailable` 状态，读不到就说"暂时读不到这个会话的历史消息；这不代表消息丢了（正文在追加日志里）"+**重新读取**按钮，真的空才渲染欢迎页。**判据不是"返回了空"**（空分不出这两种），而是 `isMessagesReadUnavailable(sessionId)` —— 与**读路径自己决定是否路由到镜像**的判据同源（端口在 + 该会话镜像已加载 + 没被上限截断），只是把"不路由"如实报出来而非静默降级；残留缺口（端口就绪+镜像加载但 JSONL 未 hydrate）如实写进注释。🟠 ②**`SnapshotService.getAll()` 的 `catch { return [] }`** 让"读不到"与"确实没有快照"变成同一件事 → 面板的 `readFailed` 守卫**永远不可能为真**、"读取失败请重试"分支**永不渲染** → 用户看到「暂无快照」以为快照丢了；修法：列目录失败**抛出**、单个坏文件跳过并计数、目录空才返回 `[]`。🟠 ③**该缺陷原来被测试掩盖**：`renderer-leaks-b` 那条用例把 `getAll` 打桩成 throw，所以**永远是绿的**而真实实现根本不 reject（"测试双比实现宽松"的经典形态）→ 新增用例**不 mock 服务**、只 mock 最底层文件 API，让真实 catch 逻辑跑起来。**实测**：渲染侧 **306 文件 / 5632 通过 / 16 跳过 / 0 失败**（新增 8 条）、Rust **140**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿；CSS 契约快照随新增 4 个类更新（diff 逐条核对只有那 4 个）。过程：UI 门禁抓到我用了两个不存在的令牌（`--fw-medium`/`--lh-normal`）、B 类门禁抓到我 `catch { return true }`，两处都按门禁的意见改了。 |
| v1.16.73 | 2026-09-18 | **用户拍板的两项：回滚可知情可撤销 + 工具禁用真的生效** — 🔴 ①**「工具管理」的禁用开关过去只是装饰**：面板写着"禁用的工具不会出现在 LLM 的可用工具列表中"，而 `codem-disabled-tools` **全仓无读取方** —— 用户关掉 `bash`、行变灰、重启后还是关的（设置确实落库），但模型照样能调用它：**以为收回了权限，实际一点没变**（安全侧说假话比没有开关更糟）。修法**两层缺一不可**：定义层（`getAll`/`getDefinitions`/`getCoreDefinitions`/`getDeferredDefinitions`）不报给模型 + 执行层（`execute`）拦下绕过（历史 tool_call、委派子会话、插件直调），子作用域 overlay 与 `get` 一并过判据；开关切换后**当前进程立即生效**（`ToolManager` 让缓存失效）；判据出错**不放行**（宁可多拦）。回归 6 条含反向对照。🔴 ②**「回滚」从"单击即永久毁文件"变成"可知情、可撤销"**：原来两个入口（`SnapshotPanel` 快照回滚 / `FileChangesList` 单轮回滚）都是单击即覆盖文件 + **永久删除**快照后新建的文件，回滚前状态只用来打印一句"N 个文件"就丢弃 → 一次误点全部修改消失且**无法拿回**；仓库对更轻的操作都有确认，只有这两个动用户文件的入口没有。修法：`preview()` **先只读地算影响面** → 确认框写清"将覆盖 N 个 / 将删除 M 个"具体文件名并告知可撤销 → `restore()` 动手前**自动创建回滚前快照**（记录当前内容，于是回滚本身可再退回）→ **删除改走回收站**（`apiDelete` 按"是否应用自管目录"分流；Rust `delete_directory` 用 `SHFileOperationW` + `FOF_SILENT\|FOF_NOCONFIRMATION\|FOF_NOERRORUI\|FOF_ALLOWUNDO`，对话框全抑制且可撤销 —— 不会卡在无人可点的对话框上）。回归 4 条（含"拿回滚前快照再回滚能退回原状"证明可撤销）+ `RL-2c`（点取消则 `restore` 一次都不许被调用）。**实测**：渲染侧 **305 文件 / 5624 通过 / 16 跳过 / 0 失败**、Rust **140**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿、CSS 契约无变化。 |
| v1.16.72 | 2026-09-18 | **UI/UX 语义审计的"保存到了错的地方"那一类（含两处静默写坏用户数据）** — 🔴 ①**笔记反向链接导航后保存会覆盖目标笔记**：`NoteEditor` 的标题/正文/标签三个 `useState` 只在挂载时播种，渲染处**无 `key`** → 从 A 跳到 B 不重挂载，框里还是 A 的文本而 `handleSave` 用 `note.id`（已是 B）→ `updateNote(B, A 的内容)` 静默覆盖 B，连版本快照存的也是 A（错上加错）；修法是"监听 `note.id` 变化重置缓冲"，判据用 **id 而非内容**（同一篇被外部更新时不许冲掉用户正在打的字，有反向用例）。②**「分层配置」点第 2 个子目录读写都是第 1 个**：所有子目录按钮都 `setActiveLevel("subfolder")` 而解析是 `find(第一个匹配)` → 点「B」载入 A、保存写进 **A 的文件**，且四个按钮高亮判定硬编码 `=== "subfolder"` 导致**全部同时高亮**（连选错的线索都没有）；修法是按 `basePath`（行身份）选中，解析抽成纯函数。🟠 ③**设置→「代码图谱」整段是空操作**：四个 `require(...)` 在浏览器 ESM 里必抛 `ReferenceError` 被**空 catch** 吞掉 → 开关不落库、**永远显示 ON**、"CLI 未安装"误报、安装成功报失败；改成动态 `import()` + 初值同步读真实设置键 + 失败不再静默（拨回开关+提示+上报）。🟠 ④**微信白名单「移除」实际是永久拉黑**（调 `ignorePeer` → 删出白名单并追加进黑名单，此后消息全被丢弃；同文件对同一函数另标「拉黑」）→ 标签改成「移除并拉黑」并写清后果，**刻意不改行为**（拉黑是唯一可用原语）。**未修但已如实列出**：快照/单轮回滚单击即永久删文件（产品语义待拍板）、「工具管理」禁用的工具仍可被模型调用（`codem-disabled-tools` 无读取方）、失败上报通道只在流式期间渲染且按钮会中断回复、"读取失败"被渲染成"你没有数据"（3 处，需纵向改造）。**实测**：渲染侧 **303 文件 / 5613 通过 / 16 跳过 / 0 失败**（新增 7 条 `ui47-save-target`）、Rust **140**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿、CSS 契约无变化；真机（1.16.70 打包版）启动恢复实测 `lastSession`/`lastProject` 均正确回填、`integrity ok`。 |
| v1.16.71 | 2026-09-18 | **把 P0 的换算抽成纯函数并补 7 条用例（行为不变）** — 1.16.70 修了"分叉复制错历史"（P0），但那段换算写在 `App.tsx` 的 `useCallback` 里**没法被用例驱动**，只能靠读代码判断 —— 而它恰恰是纯算术（窗口下标 + 被截断的条数 = 绝对下标）。现在抽到 `src/core/session/fork-index.ts`（依赖注入"窗口"与"读全量"），行为逐字不变，换来 7 条用例：100 条会话只装载最后 10 条时窗口下标 9 → **99**（改前用 9，只复制会话开头那一小段）；短会话偏移为 0（解释它以前为什么看起来正常）；前插分页后仍算得对；**中途删过消息**也按"比窗口首条更旧的还有几条"算（不依赖"总数 − 窗口长"，那种算法删过消息时会错）；读不到全量列表 → **保持原下标**（猜大 = 多复制用户以为已排除的内容）；空窗口/空全量；越界夹取。**实测**：渲染侧 **302 文件 / 5606 通过 / 16 跳过 / 0 失败**、`tsc` 0、7 道 gate + UI 门禁全绿。 |
| v1.16.70 | 2026-09-18 | **三份只读审计报出的六个真缺陷（含一个"分叉复制错历史"的 P0）** — 🔴 **P0 分叉复制错误历史**：`useAppStore().messages` 只是"最后 10 条"的窗口（`loadMessages` 的 `INITIAL_LIMIT`），而 `ChatPanel` 传给 `onFork` 的 `origIndex` 是**窗口内下标**，`store.forkSession` 却当**绝对下标**去全量列表里切片 → 100 条会话里点最后一轮分叉会**复制会话开头那 10 条**（静默、无报错、短会话下完全正常，所以一直没被发现）→ 新增 `resolveSessionAbsoluteIndex()` 换算（覆盖初始窗口截断与前插分页），`handleEditAndRewind` 的"第一条不能回退"守卫同步修正。🔴 **事件镜像两个静默缺陷**：①`latestSeq()` 把**未落库的占位 seq**（≈9.007e15）当水位 → 一次失败的 `events.append` 之后增量投影**再也读不到真实事件**、`events.compact` 拿到"锚点不存在"；②`loadSession` 的合并判据看 seq 数值，`reconcile` 之后就匹配不上 → **已落库的事件永久从镜像消失**；修法是把"来自本地追加"（`pending`）与"已确认落库"（`settled`）拆成**两个独立字段**（我第一版合成一个，用例当场抓到；又踩过一次 `seq >= placeholderBase` 的 off-by-one）。🔴 **一次压缩可以清空整个会话**：保留数为 0 时 `slice(-0) === slice(0)` —— "保留 0 条"变成"保留全部"、而"待删集"变成"全部"，把摘要正文粘回对话就能触发 → 下限钉在 1。🟠 **`parent_id` 从来没写进去过**：`domainWrite` 缺省 `mode:"insert"`（裸 INSERT），而"编辑并回退"先 `createSession()` 建行再补谱系 → 撞主键整笔失败，且**以假成功呈现**（镜像先更新、`domainWrite` 仍返回 true）→ 显式 `mode:"replace"`。🟠 **损坏恢复抢救项目归属**：恢复链路完整但日志里**没有** `project_id`，重建发生在**空库**上 → 所有复活的会话掉进"全局对话"（那句"`withoutProject` 应当长期为 0"的告警必然被打破）→ 引擎只读打开坏文件备份、把 `projects` + `sessions.id/project_id` 抄成旁路文件附在 `health.recovered_projects`，渲染侧**先项目后会话**落回（外键顺序），失败不影响恢复。🟠 **`hidden` 不在权威日志里 → 索引重建让被压缩的消息原地复活**（重建路径注释写着"必须还原"却读一个日志从没写过的字段）→ 写侧把非 0 的 `hidden` 记进日志。🟠 **日志压缩吞并发追加** → 压缩登记进"在途日志写"集合并读后复查别人的在途写，有则放弃本次（第一版把自己也当成"别人"，压缩永不执行，`SLOG-10` 抓到）。**实测**：渲染侧 **302 文件 / 5596 通过 / 16 跳过 / 0 失败**（新增 12 条回归）、Rust **140**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿、CSS 契约无变化。 |
| v1.16.69 | 2026-09-18 | **修掉"恢复上次会话"里一处会毁用户数据的缺陷 + 水位判据收口** — 🔴 只读审计 + 我的复核共同坐实：`sessions` 镜像**尚未接手**时被当成"会话已删除" → `writeLastSessionId(null)` **清掉用户的上次会话键**，而调用点的一次性闸门（`restoredLastSessionRef` 在**尝试之前**置位）让**一次误判定终身**（功能失效之外永久抹掉指针）。根因是 `getSession` 把 `domainReadOne` 的 `undefined`（没接手）与 `null`（确实没这行）**都返回 null**；该窗口有仓库内物证（`loadFromDB: found 0 projects` → 就绪后 `found 1` 那条既有补丁）。修法：`session.ts` 新增**三态**读 `getSessionState()`，`unavailable` **既不清键也不恢复**；闸门只在"拿到明确结论"后置位，`storage-unavailable` **有界重试**（12×250ms，并主动 `domainEnsureLoaded("sessions")`），另加 `restoreInFlightRef` 串联保护。回归用**方向相反的两条**钉住（读不到→键必须还在 / 确实已删除→才清键）+ `PREF-WIRE-2` 断言"先判结论再置位"这个形状。🟠 同批复核顺手修：`deleteProject` 级联删会话不清键（原来**靠副作用掩盖**）、`codem-last-project` 不匹配的日志对升级用户**每次启动误报**（该键从不参与恢复决策）。🔧 水位判据收口：**有界**（上限 20000 键，超限丢最旧并打印丢了多少）、**去掉 O(n²)**（`keys.includes` 在 for 循环里 → 改 `Set`）、去掉写回前 `sort()`（**排序会抹掉"谁最旧"**，而丢键策略靠它）。并如实收敛上一版那条局限的范围：真正**新出现**的缺口仍然会报，静默只覆盖"同一条**老**消息的事件被补上又丢"这一窄情形；要精确覆盖需**带时间维度的判据**（尚未做）。**实测**：渲染侧 **300 文件 / 5584 通过 / 16 跳过 / 0 失败**、Rust **139**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿；真机长驻 10 分钟每 ~80 秒一次维护 **7 次采样全部 `895 键 / 存在 757 / 0 个新`**（判据不自己报警）、内存 working set 79.6–80.5 MB **非单调**、句柄 408–418、WAL 1.90–1.94 MB → **无泄漏形态**。 |
| v1.16.68 | 2026-09-17 | **补上「上次打开的会话」、统一插件开关介质、面板口径对齐模型** — 🟠 用户可见三件：①**重启后回到上次那个会话**：`codem-last-session` 改前**全仓 0 命中**（启动只跑 `loadFromDB()`，从不设 `currentSession`，每次都停在「无会话」空状态）；现在恢复**必须 `dbReady` 之后**（首帧读的是空镜像，「目标不存在」是假结论 → 会清键，把「能力缺失」升级成「数据丢失」）、**目标必须能从库里读回**（会话可能已删、项目可能级联删会话）、读不回来安静回落并清键（信息级日志）；并补上**记录端**（只补恢复端的话那个键永远是空的，恢复逻辑每天安静返回 `no-key`）。②**插件开关介质统一到 DB**（原来只在 localStorage：换 profile/清缓存就丢），DB 权威 + 镜像兼容三处旧读方；**DB 里空数组也算「有值」** —— 那是用户「全启用」的真实选择，不能被镜像旧值覆盖。③**删掉 App 级永远不显示的「快速访问卡片」**：显示条件 `showQuickAccess` 是 `useState(false)`、全仓只有 `setShowQuickAccess(false)`，槽位 `app.quick-access-cards` 永不被求值（插件注册的卡片一辈子不出现）→ 按「能看见的功能优先于看不见的代码」删除；活着的同类能力在 `ChatPanel`。🟠 面板数字不再是另一套算法：④上下文面板的「消息数/占用」改与模型侧**同一份**口径（改前用 `listMessages()` 全量 → 含软删压缩隐藏行与被裁旧消息，压缩过 200 条的会话会显示「200 多条、占用虚高」，**面板 130%、模型其实只收到一半**）；选择算法抽到 `compaction-budget.ts` 由面板与循环共用。⑤手动压缩摘要不再是「100 字符截断拼接」（工具调用改为保留**名字/参数/结果**三段 + 抽出「涉及文件/错误/待办」；如实交代仍不调 LLM，与自动路径不是同一种摘要）。🟠 两条「写了名字没人填」的谎：⑥**不变量审计的水位从来不存在** —— 上一版注释写「用 `newViolations` 水位判定」，而该字段从未被返回、调用点 `?? 0` 兜底 → 告警分支**永不执行**，真出现新缺口只会被真机实测的「历史缺口 777 条」淹没；现在水位落地（settings 的 `codem-invariant-watermark`，指纹=会话+类型+消息 id **不含内容**），**第一次审计全算历史缺口**并写下水位（否则升级首启会把几百条老缺口报成「新缺陷」）。⑦`isCompactionBoundarySafe` 被当形参收进去、函数体里**一次都没用过** → 删除；不硬接的理由是个个可查的（该判据入参是**事件 seq**，消息行不带 seq，硬接就得猜一个，比不检查更糟），`compaction-control.ts` 如实标注这两个纯函数**当前无生产消费者**。**实测**：渲染侧 **300 文件 / 5580 通过 / 16 跳过 / 0 失败**（新增 28 条偏好契约 + 6 条水位契约用例，全部走真端口、不 mock `getSettingJSON`）、Rust **139**、真 CLI 契约 **28**（含 130 KB / 5 MB 大 payload 逐字保真）、`tsc --noEmit --incremental false` 0 错误、7 道审计 gate exit 0、`scan-ui` error 0 / warn 0、CSS 契约无变化；真机逐面板走查 **连续 3 轮 16/16 点击 / 0 失败 / 0 报错 / 0 空白**；启动恢复、插件 DB 介质、水位判据（`118 新 → 0 新`）三项均真机实证。 |
| v1.16.67 | 2026-09-17 | **修掉 1.16.66 引入的新建会话写入回归 + 两批审计尾巴** — 🔴 回归：1.16.66 的 Rust 批次把 `sort_order` 收进"语义非空列"清单，而渲染侧对"从未拖拽过"的会话写的正是 `sort_order: null`（**有含义的值**：排序里表示排在已拖拽会话之后；换 0 会改变既有列表顺序）→ 整笔 `sessions.upsert` 被拒 → **会话行不存在 → 该会话的消息索引/事件/遥测全部因外键被拒**。真机复现：新建会话的消息只进权威 JSONL 日志、`messages` 表 0 行、`sessions` 表没有它、搜索搜不到、重启后会话可能消失；控制台持续 `[PersistFailure] session.create … sort_order 不合法` 与 `message.createMessage.index … FOREIGN KEY`。判据收窄为"NULL 会让读路径崩掉或让语义变歧义才拒绝"；真 CLI 四项判据全绿 + 两条方向相反的 Rust 回归。🟠 设置尾巴 10 条：分层设置整链死（来源名拼两次/`policy` 无装载器/`loadAll` 零调用/单例固化）、凭证读路径恒空、菜单快捷键没有 handler 且 ARIA 写法不合法、`app.model-selector` 无出口、`theme-provider` 五个方法不存在、首屏皮肤无镜像、面板宽度两种介质、`ui-language` 兜底与应用默认相反。🟠 线协议/功能上下文尾巴：`messages.delete` 的 `count_clamped` 无人读（被夹断现在当场重算写回）、范围删除 N 条 IPC 同时起飞（改有界批量，在飞 ≤50）、不变量检查生产无人断言且纯工具轮恒报违规（口径修正 + 接进启动维护）。**实测**：渲染侧 **298 文件 / 5546 通过 / 0 失败**、Rust **139**、真 CLI 契约 **28**、`tsc` 0、7 道 gate + UI 门禁全绿、启动 **≈1.3 s**（进程→页面 0.68 s，页面→存储就绪 ≈0.65 s）、空闲 10 分钟 **无内存/句柄/WAL 泄漏**。 |
| v1.16.66 | 2026-09-17 | **两轮全盘只读审计的逐条修复：跨会话数据污染、假的 API、以及「设置了不生效」** — 六位只读审计员逐链路核对，坐实 60+ 条缺陷（含 4 个 P0）并全部修完。🔴 数据：①后台会话流式时把「当前查看会话」的消息写进了后台会话的**权威日志**（切一次会话就跨会话污染，重启后仍在）→ store 记录消息列表归属、跨会话写入拒绝并如实上报、后台 loop 只写自己那份（顺带修掉「后台消息从未落库」）；②滚动加载历史后 300ms 内切会话会污染新会话并被 autosave 持久化；③文件编辑器切文件不重置内容 → 点一次保存就把 A 文件文本写进 B 文件（真落盘）→ 切换即清脏标记 + 读取失败禁止保存 + 按路径隔离实例；④助手正文**不进事件日志**（写入侧在端口早退之后，生产不可达）→ 定稿写入点 + 指纹去重；⑤笔记本回合**全局改写 currentSession**（窗口期内面板/权限/自动保存全指向笔记本会话，用户切走还会被回滚）→ 改用「在屏会话」+ 按消息列表归属判定。🔴 死路：⑥大富翁「开始游戏」永远进不去游戏（先清标记、下一帧才初始化 → 容器被卸载 → ref 守卫直接 return）→ 顺序反过来 + 行为级回归。🟠 假的 API：⑦`ctx.permissions` 的 `check/setMode/getActiveMode` 在真实管理器上**都不存在**（`@ts-nocheck` 掩盖，调用即 TypeError），词表还是第三套 → 全部委托真系统；⑧`uiPermissionPresets` 是平行且不生效的权限系统（`isPathBlocked('**')` 声称全拦、实际一条没拦）→ 退化成真实视图；⑨编辑模型档案槽位会写到**激活的**档案并落盘。🟠 设置 12 条：语言首帧缓存死、全局字体写无人消费的变量、窗口状态非法载荷、Hub 主题被覆盖、CLI 模式被自愈翻回、预设写死键、「恢复默认」名不副实、成本上限丢键、字号双源、无条件「已保存」、陈旧快照覆盖。🟠 渲染 11 条 P1 + 9 条 P2：看门狗不停表、槽位边界永不重置、恢复面板空 catch、终端 PTY 泄漏、手动压缩守卫从未生效（连点删两批）、Excel 全量渲染打爆 webview、拖拽卡死整个 UI、草稿丢失、CICD 竞态、快照失败伪装、rAF/定时器泄漏、搜索每键重订阅、宠物窗无边界等。🟠 Rust 10 条：迁移对账**对行序敏感**（旧库上永久不通过）、`trimmed` 无不变式（重建把裁剪静默撤销）、`rebuild_index` 覆盖计数、`events` 绕级联闸门、`hidden=NULL` 打崩读路径、`rebuild_fts` NULL/重复行、CLI batch 内嵌全量 JSON、`legacy.read_table` 跳行、`MAX(0,…)` 静默夹断、陈旧引擎二进制无运行时信号。**量化**：渲染侧测试 **296 文件 / 5498 通过 / 0 失败**、Rust **137 条**（+14）、真 CLI 契约 **28 条全绿**（含 130 KB / 5 MB 工具结果逐字比对、损坏库改名备份 + 重建）、7 道审计门 + UI 门禁全绿、`tsc` 0 错误。每条修复都配「改前会红」的回归证据；两处**我自己引入的回归**（线协议 `retryable` 提权后夹具自相矛盾、假端口把镜像当引擎）也定性并修好，不是改断言将就实现。 |
| v1.16.65 | 2026-09-17 | **四个只读审计员的全盘审计 + 逐条修复：会话语料的「静默消失」路径全部封死** — ①删会话走 crud.delete 时**级联闸门从未生效**（真机复现 300 条消息静默消失）；现在闸门按**真实影响行数**判定并要求显式 confirm_bulk，超限整事务回滚。②给 schema **加一列就永久打死自动迁移**（对账两端各 SELECT *）→ 按源端列投影；真实旧库副本实测迁移成功。③迁移后**中文搜索恒为 0 条**（ebuild_fts 未切分）。④已删会话在索引重建后**整批复活**（补会话墓碑）。⑤被压缩消息被**每 token 一次的写路径**打回可见（hidden 保留语义）。⑥新增 messages.trimmed 列让「索引裁剪」与「上下文压缩」在库里可区分。⑦子智能体缺 sessions 行 → 消息/事件/成本**全部写不进库**。⑧遥测被一条坏行**毒化整批**后永久停摆。⑨知识库超 2000 块**检索静默变空**且计数被写坏。⑩反馈一次点击**抹掉备注**、「取消反馈」从未成功。⑪etrieved_sources 只写不读。⑩⑫拖拽排序无人读、fork 谱系永远为空。⑬归档**不可逆**（补恢复入口）。⑭退出从不 checkpoint、16 MiB 字节上限**从未实施**、审计表 11.8 小时 6.1 万行无界增长、库 85.8% 空闲页、数据页损坏无人发现。Rust 测试 100→123、渲染侧 5194→5300、7 道门禁与 UI 门禁全绿 |
| v1.16.64 | 2026-09-17 | **SQLite 引擎（sql.js）从渲染进程彻底删除：L1/L2/L3/L4 四项归零** — 不是"默认不再加载"，而是**没有这个引擎了**。删掉的东西：①引擎本体 `src/core/storage/database.ts`（1758 行：建库/整库导出/致命闩锁/损坏恢复/原子写盘/schema 模板串）；②`sql.js` 依赖 + `node_modules/sql.js` + `src/types/sql.js.d.ts` + `vitest.config.ts` 里指向它的别名；③死模块 `write-guard.ts`（静默空写探测器只对旧库 SQL 有效，已无生产调用点）；④L3 回退分支 **165 处/18 文件 → 0**、L4 引擎开关 **3 文件 → 0**（`selectedEngine()`/`DEFAULT_ENGINE`/`STORAGE_ENGINE_KEY` 三个符号删除）；⑤测试残留：22 个文件的死 `vi.mock("…/storage/database")` 共 139 行、2 个 sql.js 实验用例、29 条引擎语义用例（逐条写明覆盖移交，指向 Rust 用例编号或"该风险随 sql.js 消失"）。**schema 真源切到 Rust 侧**（`src-tauri/codem-db/sql/schema.sql`，即引擎 `include_str!` 执行的那份）：`gen-schema-sql.mjs` 从"生成 + 比对 TS"改成查三类真会写坏数据的漂移（表清单一一对应 / ALTER 指向存在的表 / fts 列齐全），Rust 侧 `schema_columns.rs` 两条列级契约也改成读资源本身（语义变成"引擎自己声明要建的列，库里都有吗"）。**顺带修掉三个指标缺陷**：覆盖率门禁在旧库 SQL 归零后 `0/0=NaN`（NaN 与下限比较两边都是 false → 门禁静默失效）、GATE-DB-5 在迁移完成时误报"messages 没有写路径"（具名命令未计入端口统计）、readiness 的 L4 扫原文导致"把退役原因写进注释"被算成残留。**能力保留**：索引重建标记 + 维护消费侧、存储不可用时的会话抢救（`codem:storage-unavailable`，生产者换成 bootstrap 注册失败路径）、退出前 `flushSessionLogWrites()`、启动维护。**实测**：`dist/` 里 **0 处** sql.js 痕迹；271 文件 / 5193 通过 / 0 失败；tsc 0 错误；七门禁 exit 0；Rust 99 全绿；打包版实机验证无 WASM 加载、维护日志带数字、用户数据完好。 |
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

### 7.0 发布说明规范（Release Notes）

**每个版本都必须发布 Release** —— 更新器读的是
`https://github.com/sdcxb/codem/releases/latest/download/latest.json`，
而 `latest.json` 是**最新那个 Release 的资产**。所以"不发布中间版本"做不到，
能做也必须做的是：**Release 说明写成面向用户的功能说明，而不是开发过程回执。**

写 Release 说明时的硬性要求：

1. **主语是产品，不是开发过程**。禁止出现「我自己引入又修掉的假警报」「撤回我先前的错误结论」
   「第 N 波」这类只对开发者有意义的内容 —— Release 页是用户看的第一份文档。
2. **写"改了什么、对用户意味着什么"**，不写"我怎么发现的"。过程与证据留在 CHANGELOG 与
   `docs/audit-*.md`（那是给维护者的）。
3. **标题格式**：`Codem vX.Y.Z — <一句话功能/主题>`（不用 emoji、不用口语化感叹）。
4. **正文结构**：一句话定位 → 主要变更（按模块或按用户可感知的变化分组）→ 验证（用真实读数）
   → 说明（升级注意 / 兼容性 / 已知待办，如有）。
5. **数字必须与实测一致**（宁可少写一个数字，不写没量过的）；已知未修的问题写在「已知待办」，
   不隐瞒也不夸大。

发布后可用 `node tools/release/prune-releases.mjs`（默认干跑）核对 GitHub Releases 页是否只剩
`tools/release/keep-releases.txt` 里的核心版本；`--apply` 才真删，**默认保留 git tag**，
且硬编码拒绝删除 Latest（它挂着 `latest.json`）。

> 历史清理记录（2026-09-20）：Releases 页原有 174 个版本，绝大多数说明是开发回执；
> 已按上述标准保留 **11 个里程碑版本**（v1.16.114 / 1.16.110 / 1.16.64 / 1.16.44 / 1.16.43 /
> 1.16.28 / 1.16.0 / 1.12.0 / 1.0.0 / 0.98.0 / 0.88.0），删除其余 **163 个 Release**（删除记录
> `.preview-shot/release-delete-log.txt`，失败 0；154 个 git tag 全部保留），并为这 11 个版本重写了
> 正式说明。删除后已复核：Latest 仍为 v1.16.114、5 个资产齐全、生产端点
> `releases/latest/download/latest.json` 仍返回 200 且版本/平台键正确。

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




