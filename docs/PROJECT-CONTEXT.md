# Codem 项目上下文交接文档

> **用途**：新对话迁移时快速了解项目全貌和当前开发状态。
> 创建时间：2026-07-09 | 更新时间：2026-07-13 | 当前版本：v0.79.0

---

## 一、项目概述

**Codem** 是一个基于 Tauri + React 的桌面 AI 编程助手（类似 Codex / Claude Code 的 GUI 版本）。

- **产品名**：Codem（`com.codem.app`）
- **版本**：v0.79.0
- **平台**：Windows（NSIS + MSI 安装包）
- **前端**：React 18 + TypeScript + Vite
- **后端**：Tauri 2.x（Rust）+ Node.js 辅助服务器
- **数据库**：SQLite（sql.js，浏览器端 WASM 实现）
- **LLM**：OpenAI 兼容协议（支持 OpenAI / Anthropic / DeepSeek / MiMo / Moonshot / Google）

### 核心能力

- Agentic Loop（工具调用循环，最多 50 轮迭代）
- 子智能体系统（fork 隔离上下文，最多 5 个并发）
- 上下文自动压缩（LLM 摘要 + 级联压缩）
- 记忆系统（SQLite 持久化，手动/自动提取）
- AGENTS.md 分层指令（全局 → 项目 → 子目录）
- 文件快照 + 会话恢复
- 成本追踪
- MCP 协议支持
- 内置 6 个 Agent（build / plan / explore / general / debug / review）
- 中英文双语支持（系统提示词 + UI + 工具返回）

---

## 二、项目结构

```
mimo-gui/
├── src/                          # 前端源码
│   ├── App.tsx                   # 主应用（事件处理 + loop 创建 + 命令解析）
│   ├── main.tsx                  # 入口
│   ├── store.ts                  # 全局状态
│   ├── styles.css                # 全局样式
│   ├── types.ts                  # 前端类型
│   ├── components/               # UI 组件
│   │   ├── ChatPanel.tsx         # 聊天主面板
│   │   ├── InputArea.tsx         # 输入区
│   │   ├── MessageBubble.tsx     # 消息气泡
│   │   ├── Sidebar.tsx           # 侧边栏（会话列表）
│   │   ├── SettingsPanel.tsx     # 设置面板
│   │   ├── MemoryManager.tsx     # 记忆管理面板（当前只读）
│   │   ├── AgentPanel.tsx        # Agent 选择面板
│   │   ├── AgentDetail.tsx       # Agent 详情
│   │   ├── ContextMonitor.tsx    # 上下文监控
│   │   ├── FileExplorer.tsx      # 文件浏览器
│   │   ├── FileEditor.tsx        # 文件编辑器
│   │   ├── TerminalPanel.tsx     # 内置终端（xterm）
│   │   ├── PermissionDialog.tsx  # 权限确认弹窗
│   │   ├── SnapshotPanel.tsx     # 快照面板
│   │   ├── UsageStats.tsx        # 用量统计
│   │   ├── McpManager.tsx        # MCP 管理
│   │   ├── SkillManager.tsx      # 技能管理
│   │   ├── BootstrapWizard.tsx   # 初始配置向导
│   │   └── ...
│   ├── core/                     # 核心逻辑
│   │   ├── llm/                  # LLM 引擎
│   │   │   ├── index.ts          # ⭐ LLMEngine 主类（getAgenticLoop / extractMemories / buildSystemPrompt）
│   │   │   ├── agentic-loop.ts   # ⭐ AgenticLoop（run / executeIteration / buildMessages / compactMessages）
│   │   │   ├── provider.ts       # OpenAI 兼容 Provider
│   │   │   ├── types.ts          # LLMRequest / LLMProvider / StreamEvent 等类型
│   │   │   ├── tools.ts          # 内置工具注册（read/write/bash/grep/glob/spawn_subagent...）
│   │   │   ├── streaming-executor.ts # 工具执行器（并发/串行/超时）
│   │   │   ├── cost-tracker.ts   # 成本追踪
│   │   │   ├── session.ts        # 会话/消息类型
│   │   │   ├── tool-renderer.ts  # 工具结果渲染
│   │   │   └── processor.ts      # 消息处理器
│   │   ├── agent/
│   │   │   ├── agent.ts          # ⭐ AgentDefinition + AgentRegistry（6 个内置 Agent）
│   │   │   └── index.ts          # 导出
│   │   ├── memory/
│   │   │   ├── memory.ts         # ⭐ MemoryService（增删改查 + 搜索）
│   │   │   └── index.ts
│   │   ├── context/
│   │   │   ├── context.ts        # ContextManager（压缩配置）
│   │   │   └── index.ts
│   │   ├── project/
│   │   │   └── files.ts          # ⭐ AGENTS.md 分层加载 + 项目文件操作
│   │   ├── prompt/
│   │   │   ├── prompt.ts         # ⭐ 系统提示词构建（双语）
│   │   │   └── index.ts
│   │   ├── permission/
│   │   │   ├── permission.ts     # PermissionManager
│   │   │   └── index.ts
│   │   ├── subagent/
│   │   │   ├── spawner.ts        # ⭐ 子智能体执行器
│   │   │   ├── subagent.ts       # SubagentManager
│   │   │   └── index.ts
│   │   ├── storage/              # SQLite 存储层
│   │   │   ├── database.ts       # DB 初始化
│   │   │   ├── message.ts        # 消息存储
│   │   │   ├── session.ts        # 会话存储
│   │   │   ├── settings.ts       # ⭐ 设置存储（key-value）
│   │   │   ├── project.ts        # 项目存储
│   │   │   ├── account.ts        # 账户存储
│   │   │   ├── migration.ts      # 数据库迁移
│   │   │   ├── v2-session.ts     # V2 会话格式
│   │   │   └── index.ts
│   │   ├── settings/
│   │   │   ├── settings.ts       # ⭐ SettingsManager（统一设置读写）
│   │   │   └── index.ts
│   │   ├── config/
│   │   │   └── loader.ts         # 配置加载（identity / user）
│   │   ├── i18n/
│   │   │   └── lang.ts           # 语言管理（getLang/setLang/isZh/isEn）
│   │   ├── auth/                 # 认证（MiMo 登录）
│   │   ├── heartbeat/            # 心跳
│   │   ├── mcp/                  # MCP 协议
│   │   ├── skill/                # 技能系统
│   │   ├── snapshot/             # 文件快照
│   │   ├── recovery/             # 会话恢复
│   │   ├── retry/                # 重试
│   │   ├── store.ts              # 核心状态管理
│   │   ├── types.ts              # 核心类型
│   │   └── file-api.ts           # 文件 API
│   ├── types/
│   │   └── sql.js.d.ts           # sql.js 类型声明
│   └── test/                     # 测试文件
├── src-tauri/                    # Rust 后端
│   ├── src/                      # Rust 源码
│   ├── binaries/                 # 内置二进制
│   ├── capabilities/             # Tauri 权限
│   ├── icons/                    # 应用图标
│   ├── gen/                       # 生成文件
│   └── tauri.conf.json           # Tauri 配置
├── dist-server/                  # Node.js 服务器构建产物
├── docs/                         # 文档
│   ├── ROADMAP-codex-alignment.md # ⭐ 改进路线图（686 行，核心文档）
│   ├── TODO.md                   # 待办事项
│   ├── CHANGELOG-v0.70.md        # 变更日志
│   └── *.png                     # 截图
├── example-config/               # 配置示例
├── package.json                  # 依赖管理
├── vite.config.ts                # Vite 配置
├── tsconfig.json                 # TypeScript 配置
└── build-server.mjs              # 服务器构建脚本
```

---

## 三、当前开发状态

### 已完成（v0.77-v0.79）

| 功能 | 状态 | 说明 |
|------|------|------|
| **三级安全策略** | ✅ v0.79 | ask/auto/full 全局+项目级安全模式，153 个测试 |
| **智能体协作修复** | ✅ v0.79 | 修复 wait_for_subagent 死循环根因，两步式 spawn/wait 模式 |
| **LLM 连接状态机制** | ✅ v0.79 | 状态驱动（Connecting/Streaming/Executing）替代时间超时 |
| **任务完整性检查** | ✅ v0.79 | 防止 LLM 提前停止，检查用户原始意图 |
| **改进路线图 Phase 0-4** | ✅ v0.79 | 全部完成（类型接口/基础设施/核心效率/混合模型/精细化+多模态） |
| **Wegent UI/UX 对标分析** | ✅ v0.79 | 完成 10 项优化方向分析，待执行 |
| 多语言支持 | ✅ v0.79 | 中英文双语（系统提示词 + UI + 工具返回） |
| 子智能体系统 | ✅ v0.79 | fork 隔离上下文，最多 5 个并发 |
| 上下文自动压缩 | ✅ v0.79 | LLM 摘要 + 级联压缩 |
| 记忆系统 | ✅ v0.79 | 自动提取 + 手动编辑 + 跨会话整合 |
| AGENTS.md 分层加载 | ✅ v0.79 | 全局 → 项目 → 子目录三层 + 自动生成 |
| 成本追踪 | ✅ v0.79 | CostTracker 记录/统计/限额/降级 |
| Model Profile | ✅ v0.79 | 多模型多场景调用（默认/compaction 槽位） |
| 文件快照 + 会话恢复 | ✅ v0.79 | |
| MCP 协议支持 | ✅ v0.79 | |
| 多模态 | ✅ v0.79 | Embedding/TTS/ImageGen |
| 系统托盘 + 关闭行为 | ✅ v0.79 | |

### 已知问题

| 问题 | 说明 |
|------|------|
| **UI/UX 待优化** | Wegent 对标分析已完成（`docs/UI-UX-Wegent-Benchmark.md`），10 项优化待执行 |
| **MSI 中文向导** | WiX 多语言配置未完成 |
| **Work 模式拆分** | Phase 5 远期目标，尚未开始 |

---

## 四、改进路线图摘要

> 完整路线图见 `docs/ROADMAP-codex-alignment.md`（686 行）

### 改进项总览

| 系列 | 数量 | 说明 |
|------|------|------|
| F 系列（功能改进） | 16 项 | 记忆系统激活、AGENTS.md 增强、安全扫描等 |
| E 系列（效率优化） | 8 项 | 模型路由、推理力度、增量消息、文件缓存等 |
| M 系列（混合模型） | 1 项 | Model Profile 系统（多模型多场景调用） |
| S 系列（安全防护） | 5 项 | 覆写保护、受保护路径、apply_patch、Diff 审查、沙箱 |
| C 系列（协作模式） | 1 项 | Default/Plan 模式切换 |
| W 系列（Work 模式拆分） | 7 项 | 远期目标：Work/Codex 双模式拆分（Phase 5） |

### 执行计划（6 个 Phase）

```
Phase 0（0.5天）→ 类型与接口层（零冲突，一次性加完所有字段）
Phase 1（1-1.5天）→ 基础设施通电（E1 + F1.1-F1.4 + S1/S2）
Phase 2（3-4天）→ 一次性改完 agentic-loop.ts 核心区域（E2-E8 + F2.x + F3.4/F3.6 + S3/S4 + C1）
Phase 3（4-5天）→ 混合模型系统（M1 + E8接入 + F3.1/F3.2）
Phase 4（按需）→ 精细化 + 多模态扩展
Phase 5（远期）→ Work 模式拆分（W1-W7，前提：Phase 0-4 全部完成）
```

### 关键文件 × Zone 分析（`agentic-loop.ts` — 最高风险文件）

该文件被 9 个改进项触及，拆分为 5 个 Zone，按 Phase 隔离修改：

| Zone | 代码区域 | 行号 | 涉及 Phase |
|------|---------|------|-----------|
| A | `LoopConfig` 类型 | 32-56 | Phase 0 |
| B | `run()` 主循环 | 256-398 | Phase 1 |
| C | `executeIteration()` | 423-702 | Phase 2 |
| D | `buildMessages()` | 704-753 | Phase 2 |
| E | `compactMessages()` | 779-930 | Phase 1 + Phase 3 |

### 核心冲突点

1. **E3 ← F1.2**：E3（增量消息缓存）必须在 F1.2（压缩回调）之后做，否则压缩删除消息后缓存不失效
2. **E3 → E6**：E3 和 E6 都改 `buildMessages()`，必须同一 Phase 连续完成
3. **E1 → M1**：E1 让 `getAgenticLoop()` 读 `agent.model`，M1 后续覆写为 Profile 解析（计划内演进）
4. **F1.4 + F2.3**：都改 `loadHierarchicalProjectInstructions()`，必须同一 Phase

### 效率优化时机策略

| 类型 | 改进项 | 时机 |
|------|--------|------|
| 配置型（不改结构） | E1, E2, E5, E7 | 尽早做 |
| 结构型（改内部实现） | E3, E6 | 在依赖功能之前、可能被破坏的功能之后 |
| 隔离型（独立模块） | E4, E8 | 随时可做 |

---

## 五、关键代码位置索引

| 功能 | 文件 | 关键函数/区域 | 行号 |
|------|------|-------------|------|
| Loop 创建 | `index.ts` | `getAgenticLoop()` | 115-131 |
| 系统提示词 | `index.ts` | `buildSystemPrompt()` | 134-170 |
| 记忆提取 | `index.ts` | `extractMemoriesFromSession()` | ~498-587 |
| Agent 定义 | `agent.ts` | `AgentDefinition` 接口 | 15-50 |
| Loop 配置 | `agentic-loop.ts` | `LoopConfig` 接口 | 32-56 |
| 主循环 | `agentic-loop.ts` | `run()` | ~256-398 |
| 迭代执行 | `agentic-loop.ts` | `executeIteration()` | 423-702 |
| 请求构建 | `agentic-loop.ts` | `LLMRequest` 构造 | 437-447 |
| 消息构建 | `agentic-loop.ts` | `buildMessages()` | 704-753 |
| 上下文压缩 | `agentic-loop.ts` | `compactMessages()` | 779-930 |
| 压缩摘要 | `agentic-loop.ts` | `generateCompactionSummary()` | ~860-880 |
| LLM 请求类型 | `types.ts` | `LLMRequest` | 21-29 |
| 工具并发配置 | `streaming-executor.ts` | `concurrencySafeTools` | ~22 |
| AGENTS.md 加载 | `files.ts` | `loadHierarchicalProjectInstructions()` | - |
| 设置存储 | `storage/settings.ts` | key-value API | - |
| 设置管理 | `settings/settings.ts` | `SettingsManager` | - |

---

## 六、构建与运行

```bash
# 开发模式
npm run tauri:dev

# 构建生产版
npm run tauri:build

# 仅前端开发
npm run dev

# 仅服务器
npm run server

# 测试
npm test

# 构建 Node.js 服务器
npm run build:server
```

### 发版流程

```bash
# 1. 提交代码 + 打标签
git commit -m "release vX.XX"
git tag vX.XX
git push origin master --tags

# 2. 创建 GitHub Release（注意用 UTF-8 无 BOM 编码）
gh release create vX.XX --title "..." --notes-file release-notes.md

# 3. 构建安装包
npm run tauri:build

# 4. 上传安装包
gh release upload vX.XX src-tauri/target/release/bundle/nsis/*.exe src-tauri/target/release/bundle/msi/*.msi
```

---

## 七、待办事项（来自 `docs/TODO.md`）

### 待开发

- [ ] MSI 安装包中文向导（WiX 多语言配置）
- [ ] **路线图全部改进项**（Phase 0-4，见 `docs/ROADMAP-codex-alignment.md`）

### 近期已完成

- [x] 三级安全策略系统（v0.79）
- [x] 智能体协作死循环修复（v0.79）
- [x] LLM 连接状态机制（v0.79）
- [x] 任务完整性检查（v0.79）
- [x] 改进路线图 Phase 0-4 全部完成（v0.79）
- [x] Wegent UI/UX 对标分析（v0.79）
- [x] 多语言支持（v0.79）
- [x] 系统托盘 + 关闭行为（v0.79）
- [x] 终端增强（v0.79）
- [x] 子智能体调用后语言一致性修复（v0.77）
- [x] 清理代码注释中对标产品名称（v0.77）

---

## 八、技术决策记录

| 决策 | 理由 |
|------|------|
| 不做 Hooks 外部命令框架 | GUI 用户不写脚本；PermissionManager 已覆盖 PreToolUse |
| 不做自定义 Agent TOML | ROI 低；内置 6 个 Agent 覆盖 95% 场景；M1 Profile 已提供灵活性 |
| 不做 Chronicle 截屏 | macOS 专属；Windows 无对应 API；隐私风险 |
| 不做记忆存储改 Markdown | SQLite + 编辑面板更适合 GUI 应用 |
| E1 实现为过渡态（会被 M1 覆写） | 立即带来 60% 成本降低，M1 后续增加灵活性 |
| Phase 0 抽出类型定义层 | 消除 6 项对 `LoopConfig` 的跨 Phase 修改冲突 |
| E3+E6 必须同 Phase | 都改 `buildMessages()`，分开会二次理解缓存逻辑 |
| E8 拆分两 Phase | Phase 2 建框架（检查+warn），Phase 3 接入 M1 降级 |

---

## 九、新对话快速上手建议

1. **先读** `docs/ROADMAP-codex-alignment.md` — 完整的改进路线图、冲突分析、执行计划
2. **再读本文件** — 项目全貌和代码位置索引
3. **如果要开始实现**，从 Phase 0 或 Phase 1 开始：
   - Phase 0：给 `LoopConfig` / `LLMRequest` / `AgentDefinition` 加字段（零风险）
   - Phase 1：E1 改 3 行让 `AgentDefinition.model` 生效 + F1.2/F1.3 加记忆提取回调
4. **热点文件**：`agentic-loop.ts` 是全项目最高风险文件，9 个改进项触及，严格按 Zone 隔离修改
5. **项目内不要出现对标产品名称**（Codex / Claude Code 等），已清理过一轮
