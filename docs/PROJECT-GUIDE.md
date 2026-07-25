# Codem 项目完整说明

> **用途**：新对话快速理解项目全貌、架构、文件关联、当前状态。
> 创建时间：2026-07-23 | 最后更新：2026-07-26 | 当前版本：v0.89（已发布，含跨会话委派编排 + 高级调试 UI + 冒烟测试）

---

## 一、项目概述

**Codem** 是对标 Codex 的 AI 编程助手桌面应用，基于 Tauri v2 + React + TypeScript 构建。

- **产品名**：Codem（`com.codem.app`）
- **GitHub**：https://github.com/sdcxb/codem
- **分发**：NSIS `.exe` + WiX `.msi`，一键安装无需依赖
- **平台**：Windows 优先
- **版本**：v0.89

---

## 二、技术架构

### 2.1 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| **桌面框架** | Tauri v2 (Rust) | 原生窗口 + 文件系统 + 命令调用 + 多窗口（主窗口 + 宠物窗口） |
| **前端框架** | React 18 + TypeScript | SPA，Vite 构建 |
| **状态管理** | Zustand 5 | 三个 store：`useAppStore`（消息/流式/工具）+ `useProjectStore`（项目/会话/技能）+ `usePetStore`（宠物状态/气泡/窗口） |
| **UI 组件** | Radix UI + Lucide React + Font Awesome | Switch/Dialog/Tooltip/Popover/Dropdown + 图标库 |
| **Markdown** | react-markdown + remark-gfm | 消息渲染 + 代码高亮 |
| **图表** | Mermaid 11 | 技能内置 Mermaid SVG 渲染 |
| **终端** | xterm.js (@xterm/xterm + addon-fit + addon-web-links) | CLI 模式终端 |
| **存储** | SQLite (sql.js) | 内存数据库 + Tauri 文件系统持久化到 AppData |
| **嵌入模型** | ONNX Runtime (WASM) + @huggingface/transformers | 本地语义嵌入，零外部依赖 |
| **压缩** | fflate | 技能 ZIP 包解压 |
| **桌面宠物** | Petdex (MIT License) 集成 | 宠物包格式 + 市场 Manifest API + 精灵图帧动画 |
| **Tauri 前端 API** | @tauri-apps/api + plugin-dialog + plugin-notification | IPC 通信 + 原生对话框 + 系统通知 |

### 2.2 前端依赖

```
React 18 + Zustand 5 + Radix UI + Lucide React + Font Awesome 7
react-markdown + remark-gfm + react-syntax-highlighter
sql.js (SQLite) + @huggingface/transformers (ONNX)
mermaid + @xterm/xterm + addon-fit + addon-web-links + fflate + clsx + tailwind-merge
@tauri-apps/api + @tauri-apps/plugin-dialog + @tauri-apps/plugin-notification
```

**devDependencies:** TypeScript 5.6 + Vite 6 + Vitest 4 + happy-dom + jsdom + png-to-ico + sharp

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
```

### 2.4 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        Tauri 原生窗口                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    React 前端 (SPA)                         │  │
│  │                                                            │  │
│  │  App.tsx ─ 主应用 (状态管理 + 事件处理 + handleSend)        │  │
│  │  ├── Sidebar.tsx ─ 左侧栏 (项目/会话列表/导航)             │  │
│  │  ├── ChatPanel.tsx ─ 对话面板 (消息列表 + InputArea)        │  │
│  │  │   ├── MessageBubble.tsx ─ 消息气泡 (memo优化 + 子智能体) │  │
│  │  │   └── InputArea.tsx ─ 输入区 (底部控制栏 + 模式/分支)   │  │
│  │  ├── RightSidebar.tsx ─ 右侧栏 (活跃任务/GitInfoPanel)     │  │
│  │  ├── SettingsPanel.tsx ─ 设置面板 (10个Tab，含宠物)        │  │
│  │  ├── PetWindowApp.tsx ─ 独立宠物窗口 (透明/置顶/精灵图动画)  │  │
│  │  ├── PetSprite.tsx ─ 宠物精灵图帧动画渲染                    │  │
│  │  ├── PetMarketDialog.tsx ─ 宠物市场 (Petdex API)             │  │
│  │  ├── TopNavbar.tsx ─ 顶部导航 (皮肤/布局切换)              │  │
│  │  └── DreamLayout.tsx / HubLayout.tsx ─ 皮肤布局            │  │
│  │                                                            │  │
│  │  核心引擎层 (src/core/)                                     │  │
│  │  ├── llm/ ─ LLM 引擎 (Provider/AgenticLoop/Tools/Memory)   │  │
│  │  ├── subagent/ ─ 子智能体 spawn/wait                       │  │
│  │  ├── context/ ─ 上下文管理 + token计数 + 压缩              │  │
│  │  ├── memory/ ─ 三级记忆 (project/session/global)          │  │
│  │  ├── permission/ ─ 权限系统 + 安全模式                     │  │
│  │  ├── environment/ ─ Git Worktree + 执行模式                │  │
│  │  ├── pet/ ─ 桌面宠物 (Petdex集成/状态映射/气泡/市场)        │  │
│  │  ├── automation/ ─ 自动任务 (定时器/文件监听)              │  │
│  │  ├── knowledge/ ─ 笔记本知识管理 (RAG)                     │  │
│  │  ├── skill/ ─ 技能系统 (SKILL.md + 注册)                   │  │
│  │  ├── mcp/ ─ MCP 协议                                       │  │
│  │  ├── theme/ ─ 皮肤系统 (默认/Hub/梦幻)                     │  │
│  │  ├── storage/ ─ SQLite 持久化                              │  │
│  │  ├── prompt/ ─ 系统提示词构建                              │  │
│  │  ├── settings/ ─ 数据层设置 (SettingsSource 层级)           │  │
│  │  ├── recovery/ ─ 会话恢复                                  │  │
│  │  └── i18n/ ─ 中英文双语                                    │  │
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
│  │  宠物窗口管理 / 原生右键菜单 / 阴影控制 / 系统托盘          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                        │
│  ┌───────────────────────┴─────────────────────────────────────┐ │
│  │              SQLite 数据库 (AppData/codem-db.bin)           │ │
│  │  projects / sessions / messages / settings /                 │ │
│  │  memory / notebooks / notebook_sources / notebook_chunks    │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

外部 API：
├── MiMo CLI (小米账户登录 → CLI 模式)
├── OpenAI 兼容 API (多 Provider: DeepSeek/OpenAI/自定义)
├── Embedding API (OpenAI/自定义 + 本地 ONNX 回退)
└── Petdex Manifest API (宠物市场目录 + 图片代理下载)

★ 宠物窗口：独立 Tauri 透明窗口 (pet)
  ├── PetWindowApp.tsx ─ 精灵图 + 气泡 + 拖拽 + 右键
  ├── 通过 Tauri 事件与主窗口双向通信
  └── Rust: create_pet_window / close_pet_window / show_pet_menu
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
│   ├── styles.css                # 全局样式（~8000行，含所有皮肤基础样式）
│   ├── styles/
│   │   ├── skin-dream.css        # 梦幻皮肤样式（磨砂/背景图/动画）
│   │   └── skin-hub.css          # Hub 皮肤样式（分段控件/卡片布局）
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
│   │   ├── DiffViewer.tsx       # Diff 对比查看器
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
│   │   │   ├── tools.ts          # 工具定义（read/write/edit/bash/multi_edit/spawn_subagent/...）
│   │   │   ├── tools/            # 专用工具
│   │   │   │   ├── load-skill.ts     # 懒加载技能
│   │   │   │   ├── read-attachment.ts # 读取附件
│   │   │   │   ├── search-notebook.ts # 笔记本搜索
│   │   │   │   └── web-search.ts     # Web 搜索
│   │   │   ├── processor.ts      # 请求处理器
│   │   │   ├── session.ts       # 会话管理
│   │   │   ├── cost-tracker.ts   # 成本追踪
│   │   │   ├── model-profile.ts  # 模型配置槽位
│   │   │   ├── multimodal.ts     # 多模态（Embedding/TTS/ImageGen）
│   │   │   ├── attachment-formatter.ts # 附件格式化
│   │   │   ├── attachment-sync.ts     # 附件同步到工作区
│   │   │   ├── tool-renderer.ts # 工具渲染
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
│   │   ├── knowledge/             # 知识管理（RAG）
│   │   │   ├── chunker.ts        # 文本分块
│   │   │   ├── extractor.ts      # 文本提取（txt/md/code/url/html）
│   │   │   ├── pdf-extractor.ts  # PDF 提取（纯TS零依赖）
│   │   │   ├── indexer.ts        # Embedding 索引管道
│   │   │   ├── retriever.ts      # 语义检索
│   │   │   ├── local-embedding.ts # 本地 ONNX 嵌入
│   │   │   ├── storage.ts        # 知识存储
│   │   │   └── types.ts          # 类型
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
│   │   │   ├── theme-manager.ts  # 主题管理（背景图提取颜色）
│   │   │   ├── theme-extractor.ts # 颜色提取器
│   │   │   ├── presets.ts        # 预设主题
│   │   │   ├── use-skin.ts       # 皮肤 Hook
│   │   │   ├── types.ts          # 类型
│   │   │   └── index.ts          # 导出
│   │   │
│   │   ├── storage/              # SQLite 持久化
│   │   │   ├── database.ts       # SQLite 初始化 + 防抖持久化(500ms) + flushDatabase
│   │   │   ├── session.ts        # 会话 CRUD
│   │   │   ├── message.ts        # 消息 CRUD + messagesToLLMMessages
│   │   │   ├── project.ts        # 项目 CRUD
│   │   │   ├── settings.ts       # 键值设置存储
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
│   │
│   └── test/                     # 测试文件
│       ├── ui-batch-a-d.test.ts  # 188个UI批量测试
│       ├── security-mode.test.ts # 安全模式测试
│       ├── git-env-config.test.ts # Git环境配置测试
│       ├── pet-system.test.ts    # 宠物系统测试
│       └── ...                   # 其他测试
│
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── lib.rs                # Tauri 主入口（所有命令注册 + 实现）
│   │   │                         #   write_file / read_file / execute_command
│   │   │                         #   list_dir / path_exists / delete_directory (回收站)
│   │   │                         #   http_get / http_download / get_app_data_dir
│   │   │                         #   get_installer_default_lang / ...
│   │   │                         #   create_pet_window / close_pet_window / show_pet_menu
│   │   │                         #   resize_pet_window / hide_to_tray / show_from_tray
│   │   │                         #   quit_app / update_tray_language
│   │   └── main.rs               # 程序入口
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置（窗口/CSP/Bundle/NSIS/WiX）
│   └── capabilities/             # Tauri 权限配置
│
├── docs/                         # 文档目录（详见第四节）
├── .wecode-ref/                  # 对标项目参考（微博 wecode 客户端）
├── public/                       # 静态资源
│   ├── models/                   # ONNX 模型（Xenova/all-MiniLM-L6-v2）
│   ├── wasm/                     # WASM 运行时
│   └── fonts/                    # 全局字体（AlimamaFangYuanTiVF-Thin.ttf）
├── dist/                         # 构建输出
├── package.json                  # npm 依赖 + 脚本
├── vite.config.ts                # Vite 配置
├── tsconfig.json                # TypeScript 配置
├── vitest.config.ts             # 测试配置
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
  ├── styles/skin-dream.css → [data-skin="dream"] 选择器
  │   ⚠ backdrop-filter 在 .sidebar 上 → 为 position:fixed 子元素创建 containing block
  │   → 所有弹窗组件必须用 createPortal 渲染到 document.body
  ├── DreamLayout.tsx → 梦幻皮肤布局
  ├── HubLayout.tsx → Hub 皮肤布局
  ├── TopNavbar.tsx → 皮肤切换
  ├── SkinSelector.tsx → 皮肤选择器
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
  ├── create_pet_window()   → WebviewWindowBuilder + transparent + always_on_top
  ├── close_pet_window()    → 关闭宠物窗口
  ├── resize_pet_window()   → 动态调整宠物窗口尺寸 (气泡溢出修复)
  └── show_pet_menu()       → MenuBuilder 原生右键菜单
```

---

## 五、docs/ 文档说明

| 文件 | 类型 | 说明 | 状态 |
|------|------|------|------|
| **PROJECT-GUIDE.md** | 📌本项目 | **本文档**，完整项目说明 | ✅ 最新 |
| **PROJECT_STATUS.md** | 项目简介 | 项目概述+架构+功能清单+版本历史 | v0.88 |
| **PROJECT-CONTEXT.md** | 旧版交接 | v0.79 时的交接文档，已被 PROJECT_STATUS 替代 | 📦 归档 |
| **TODO.md** | 待办跟踪 | Phase 0-G 全部完成记录 + v0.88 宠物系统 + Phase E 待办 | ✅ 最新 |
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
| **CHANGELOG-v0.89.md** | 变更日志 | v0.89 变更记录 | ✅ 最新 |
| **TEST-CASES-REGRESSION-V2.md** | 测试用例 | 回归测试V2（含冒烟测试），185个用例 | ✅ 最新 |

### 文档优先级说明

**新对话只需要阅读：**
1. `PROJECT-GUIDE.md`（本文档）— 完整理解项目
2. `TODO.md` — 了解当前待办
3. `CHANGELOG-v0.89.md` — 了解最新版本变更
4. `TEST-CASES-REGRESSION-V2.md` — 了解回归测试用例（含冒烟测试）

**其余文档均为历史归档或已完成计划的记录，不影响进度判断。**

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

### 6.2 v0.89 已发布功能

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

### 6.2.1 v0.88 已发布功能

以下功能均已包含在 v0.88 发布版本中：

| 功能 | 关键文件 |
|------|----------|
| **桌面宠物系统** | `core/pet/pet-store.ts`, `PetWindowApp.tsx`, `PetSprite.tsx`, `lib.rs` (create_pet_window) |
| **宠物市场** | `PetMarketDialog.tsx`, `core/pet/pet-market-client.ts` (Petdex Manifest API) |
| **悬浮气泡通知** | `PetWindowApp.tsx` (useLayoutEffect测量高度+增量位置), `pet-store.ts` (showBubble/showRawBubble) |
| **右键原生菜单** | `lib.rs` (show_pet_menu + MenuBuilder), `PetWindowApp.tsx` (handleContextMenu) |
| **Token查询** | `App.tsx` (pet-check-tokens-request事件), `pet-store.ts` (showBubble) |
| **宠物设置面板** | `SettingsPanel.tsx` (🐾Tab, 启用开关/大小滑轨/透明度滑轨/市场入口) |
| **精灵图动画** | `PetSprite.tsx` (CSS background-position帧动画, 6种状态) |
| **Agent状态映射** | `pet-store.ts` (onLLMStatus/onStreamEvent → idle/thinking/working/happy/sad/sleeping) |
| **开源声明** | `THIRD_PARTY_NOTICES.md` (Petdex MIT License) |

### 6.2.1 v0.87 已发布功能

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

### 6.3 待办事项

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
| **Phase E: Work 模式拆分** | ⏳ 远期 | Codex/Work 双模式切换（E1-E7） |
| **MSI 中文向导** | ⏳ | WiX 多语言配置（zh-CN + en-US） |
| **更多 Provider 测试** | ⏳ | 目前主要测试 DeepSeek + MiMo |
| **对话搜索完善** | ⏳ | 当前 SearchDialog 仅搜索项目名，未搜索对话内容 |
| **Vision API 图片理解** | ⏳ | 将粘贴的图片数据传给 vision 模型 |

### 6.4 关键技术决策

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

43. **独立透明宠物窗口**：`transparent + always_on_top + decorations:false + shadow(false)`，与主窗口通过 Tauri 事件双向通信
44. **原生右键菜单**：Rust `MenuBuilder` 构建，避免浏览器菜单被透明窗口裁剪
45. **气泡高度自适应**：`useLayoutEffect` 同步测量气泡 DOM 高度，`resize_pet_window` + `setPosition` 增量调整窗口尺寸，宠物视觉位置不动
46. **系统托盘集成**：`tray-icon` feature + `build_tray_menu` 实现最小化到托盘 / 恢复 / 退出

---

## 七、启动与测试

```bash
# 开发
npm run tauri dev          # 启动 Tauri 开发模式（Vite + Rust 热更新）

# 编译检查
npx tsc --noEmit           # TypeScript 编译检查
cd src-tauri && cargo check # Rust 编译检查

# 测试
npm test                   # 运行 Vitest 测试套件

# 构建生产版
npm run tauri build        # 构建 NSIS exe + MSI
```
