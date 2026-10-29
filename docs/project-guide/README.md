# Codem 项目文档集（2026-10-26 重编）

> **基线**：`master` @ 代码提交见 `git log -1`（1.16.331 发布提交）｜ 文档集提交见 `git log -1` ｜ 版本 **1.16.331**（2026-10-29 发布，GitHub `Latest`）
> **用途**：把「长期演进后散落在 170+ 份文档里的现状」重新收拢成一套**可交接、可核查、可分维度阅读**的文档。
> **适用对象**：人类开发者、任何大模型 / Agent 平台、以及未来的维护会话。

---

## 1. 这套文档解决什么问题

这个仓库已经历了多个 Agent 平台与大模型接力开发，代码规模到：

- 前端 `src/` 约 **44 万行**（其中 `src/test/` 约 16 万行），`App.tsx` 单文件 6251 行；
- Rust 侧 `src-tauri/src` 约 **2.2 万行**，`lib.rs` 单文件 7784 行；
- SQLite **39 张实表** + FTS + 审计表；Tauri **118 个命令注解 / 117 个注册命令**；
- `src/core/` **60 个子域**，`src/components/` 152 个顶层组件 + 6 个子目录；
- **779 个测试文件 / 8769 个用例**（2026-10-29 全量实测：8752 通过、17 跳过、0 失败，见 `09-CURRENT-STATE.md`）。

旧文档的问题不是“少”，而是**多且互相矛盾**：`docs/PROJECT-GUIDE.md` 有 823 KB，仍以 1.16.305 的口径写“当前状态”；`AGENTS.md` 的旧正文停在 1.16.323（本次已更新版本/测试数与文档指针，但详细状态仍以本套为准）；`docs/GAP-LIST.md` 的版本记录停在 1.16.305；`docs/NEW-SESSION-START.md` 停在 1.16.319；`docs/HANDOVER-2026-10-17.md` 停在 1.16.329。新会话读哪一份都可能拿到过期结论。

这套文档的原则是：**一份文档只回答一类问题；所有“当前”结论都标日期与基线；代码/测试优先于文档**。

---

## 2. 先读哪几份（按角色）

### 2.1 任何 AI / Agent 接手（最小包，约 40 分钟）

按顺序读：

1. **`00-AGENT-HANDBOOK.md`** —— 开工清单、硬规则、基线、坑、任务路由；
2. **`02-CODE-MAP.md`** —— 目录与模块职责，知道东西在哪；
3. **`03-RUNTIME-FLOWS.md`** —— 一轮对话到底怎么跑，改哪里会牵动什么；
4. **`08-ENGINEERING-GATES.md`** —— 判据、审计、构建、发布、常见改造配方；
5. **`09-CURRENT-STATE.md`** —— 现在哪些是绿的、哪些没验、哪些别碰。

如果只给模型**三份**：`00` + `02` + `08`。如果任务涉及对话/工具/上下文，再加 `03`；涉及存储，加 `06`。

**要把它正式交接给新模型 / 新 Agent 平台**：直接复制 `11-HANDOFF-PROMPT.md` 的「标准开场白」——里面有必读顺序、硬规则、当前基线和 6 条验收问题；它答得出，才算真读懂。

### 2.2 人类快速了解产品

`01-PRODUCT-OVERVIEW.md` → `04-FEATURE-MODULES.md` → `05-UI-UX.md`。

### 2.3 按任务查

| 你要做的事 | 先读 | 再查 |
|---|---|---|
| 修一个对话/工具/流式 bug | 03 | 02 的 `core/llm`、08 的判据 |
| 加一个工具 | 08 的「加工具」配方 | `core/llm/tools.ts`、`tool-pipeline.ts` |
| 改设置项 / 加设置面板 | 05、08 | `SettingsPanel.tsx`、`core/storage/settings.ts` |
| 改数据库 / 迁移 | 06 | `src-tauri/codem-db/sql/schema.sql`、`migrate.rs` |
| 改 Rust 命令 / IPC | 07 | `src-tauri/src/lib.rs` 的 `generate_handler!` |
| 改 UI / 皮肤 / 布局 | 05、13 | `App.tsx`、`styles.css`、`core/theme/` |
| 做发布 | 08 的「发布」 | `docs/RELEASE-GUIDE.md`、`tools/release/` |
| 接手“现在做到哪了” | 09 | `CHANGELOG.md` 顶部、`docs/manuals/PROJECT-MODE.md` |
| 继续大富翁 / Godot 实验 | 10 | `prototype/wealth-island-2.5d/README.md` |

---

## 3. 文档清单

| 文档 | 回答什么问题 | 体量 | 更新频率 |
|---|---|---|---|
| `README.md`（本文） | 这套文档怎么用、基线是什么、先读什么 | 短 | 每次重编 |
| `00-AGENT-HANDBOOK.md` | 任何 AI 如何安全接手：规则、命令、基线、坑、路由 | 中 | 每次基线变化 |
| `01-PRODUCT-OVERVIEW.md` | 产品是什么、给谁、能力边界、对标结论、规模 | 中 | 每季度 / 大版本 |
| `02-CODE-MAP.md` | 目录树、分层、60 个 core 子域、关键文件、Rust 布局 | 长 | 结构变化时 |
| `03-RUNTIME-FLOWS.md` | 启动、发送、Agent 循环、工具管线、流式、审批、压缩、记忆、子代理、项目、IPC | 长 | 主链路变化时 |
| `04-FEATURE-MODULES.md` | 16 个功能域 + 关键子功能 + 入口 + 成熟度 | 长 | 功能变化时 |
| `05-UI-UX.md` | 三皮肤外壳、导航、面板、对话区、设计令牌、交互与可访问性 | 长 | UI 变化时 |
| `06-DATA-STORAGE.md` | 数据分层、39 张表、JSONL、数据根、设置/凭据、迁移/维护 | 长 | schema/存储变化时 |
| `07-BACKEND-IPC.md` | Rust 文件地图、117 命令、执行器/PTY、存储引擎、安全、OFM、phone/iLink | 长 | Rust 变化时 |
| `08-ENGINEERING-GATES.md` | 测试/审计/变异/评测、构建发布、环境、改造配方、纪律 | 长 | 门禁变化时 |
| `09-CURRENT-STATE.md` | 版本/发布/工作区/测试基线、未完成项、文档债、下一步 | 中 | 每个版本 |
| `10-GAME-AND-PROTOTYPE.md` | 内置大富翁插件、Godot 2.5D 重制、未跟踪资产边界 | 中 | 游戏线变化时 |
| `11-HANDOFF-PROMPT.md` | **复制给新模型/新 Agent 的交接话术 + 验收问题 + 按任务加读** | 短 | 交接方式变化时 |
| `12-DOC-MAINTENANCE.md` | 文档也是发版物：发版同步流程、`docs:sync`/`audit:docs`、历史文档处理 | 短 | 门禁/流程变化时 |
| `13-UI-BENCHMARK-OMP.md` | OMP Studio 全要素对标、P0/P1/P2 方案、截图/契约验收、执行防走样；含可打开的 HTML 预演 | 长 | 做 UI 优化时 |
| `14-P26-AND-DENSITY.md` | P2-6 现有页面复用矩阵、聚合页施工设计、全局 spacing 密度分阶段方案 | 中 | 做 P2-6 / 密度时 |
| `15-VISUAL-REBUILD-PLAN.md` | 左栏/对话/Composer/设置的视觉重做施工单，含双基线验收和底栏排除 | 中 | 做视觉重做时 |
| `16-MCODE-STACK-AUDIT.md` | mcode-stack 外部审计的结论：22 条清单逐条 pass/fail/unknown、上下文税实测读数、本轮借鉴落地了什么、哪些还不借 | 中 | 评估外部工作流 / 复查这几块机制时 |
| `17-MULTI-AGENT-INVENTORY.md` | 5 套多智能体机制各是什么、真实使用计数（693 会话）、工具定义成本、合并/不合并的三个选项与推荐 | 中 | 决定团队/子代理/委派怎么收口时 |

> 说明：本目录在 `docs/` 的子目录下，不受仓库根 `.gitignore` 的 `docs/*.md` 规则影响（已用 `git check-ignore` 验证），可以直接入库。

---

## 4. 当前事实基线（2026-10-29）

| 项 | 值 | 怎么核 |
|---|---|---|
| 版本 | **1.16.331** | `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `latest.json` |
| 发布 | GitHub `Codem v1.16.331` = `Latest`（2026-10-29） | `gh release list --limit 1` |
| HEAD | 以 `git log -1` 为准（1.16.331 发布提交） | `git rev-parse --short HEAD` |
| 分支 | `master`，与 `origin/master` 同步（无 ahead/behind） | `git status -sb` |
| TypeScript | **0 错误** | `npx tsc --noEmit`（2026-10-29 实测 exit 0） |
| 全量测试 | **779 文件 / 8769 用例：8752 通过、17 跳过、0 失败** | `npx vitest run`（约 158 秒） |
| 已知失败 | **0**（2026-10-26 那两条未跟踪文档的失败已随未跟踪内容清理而消失，不是产品代码修复） | 见 `09-CURRENT-STATE.md` §3 |
| 工具链 | Node **24.19.0** / npm **11.17.0** / rustc **1.97.1** | `node -v` 等 |
| 工作区 | `.gitignore`、`.jscpd.json` 有未提交修改；`art/`、`prototype/`、`docs/ref-analysis/` 等未跟踪 | `git status --porcelain` |
| 数据根 | `%APPDATA%\com.codem.app\`；库 `codem-db-rust.bin` | `src-tauri/src/storage.rs` |

> ⚠️ 测试基线会随未跟踪内容变化。跑出来不是这个数：先看 `git status` 与 `09` §3，不要为了让全绿去改产品代码。

---

## 5. 真相源与可信度

优先级从高到低：

1. **可执行代码**（`src/`、`src-tauri/`）；
2. **判据**（`src/test/*.test.ts`、`src-tauri/**/tests/*.rs`）—— 这个仓库把“法律”写在测试里；
3. **本轮文档**（`docs/project-guide/`，标注日期与基线）；
4. **发布说明** `CHANGELOG.md`（面向用户，不含内部编号）；
5. **工程日志** `docs/HANDOFF-NEXT-SESSION.md`（逐轮取证，按关键词 grep，不要通读）；
6. 其余历史文档（`docs/*.md`，大量已过时；标题带 PLAN/GAP/TODO 的多数已加“历史文档”横幅）。

任何“现在是这样”的结论，如果与代码冲突，**以代码为准**，并回头修文档。

---

## 6. 维护规则（改代码时顺手做什么）

| 你改了什么 | 必须更新 |
|---|---|
| 版本号 / 发布 | `09-CURRENT-STATE.md` §1、`docs/PROJECT-GUIDE.md` 版本表、`npm run docs:sync` + `audit:docs`（见 `12`） |
| 新增/删除 core 子域、关键文件 | `02-CODE-MAP.md` |
| 主链路（发送/工具/流式/压缩/审批/子代理/项目） | `03-RUNTIME-FLOWS.md` |
| 用户可见功能 | `04-FEATURE-MODULES.md` + `CHANGELOG.md` |
| 设置分区 / 布局 / 皮肤 / 令牌 | `05-UI-UX.md`（并跑 `node tools/ui-audit/css-contract.mjs --write`（改 CSS 时）） |
| 表 / 列 / 迁移 / 数据根 | `06-DATA-STORAGE.md` + `docs/STORAGE-INVENTORY.md`（自动生成） |
| Tauri 命令 / 执行器 / 安全边界 | `07-BACKEND-IPC.md` |
| 门禁 / 命令 / 构建发布 | `08-ENGINEERING-GATES.md` |
| 未完成项 / 新坑 | `09-CURRENT-STATE.md` + `docs/HANDOFF-NEXT-SESSION.md` |

三条硬要求：

1. 中文引号统一用 `「」`（尤其写进 JS/PS 脚本时）；
2. 新文档必须是 **UTF-8 无 BOM**（`no-bom.test.ts` 会扫全仓）；
3. **版本号一变，先跑 `npm run docs:sync`，按提示更新后跑 `npm run audit:docs`**（`verify`/`audit` 已含；见 `12-DOC-MAINTENANCE.md`）。

---

## 7. 与旧文档的关系

- `docs/PROJECT-GUIDE.md`：**保留为历史总览**（823 KB，含早期版本史与旧目录树）。它的“从这里开始”仍可读，但当前状态以本套文档为准。
- `docs/CODEM-FEATURES.md` / `项目功能树-全量.md`：**功能叶子库**（2779 条，2026-09-09 生成）。`04-FEATURE-MODULES.md` 是在其上的“当前状态重编”，不是逐条复制。
- `docs/HANDOVER-2026-10-17.md`：**上一轮交接**（1.16.329），三条主动脉与陷阱清单仍高度有效，`00` 已吸收并更新。
- `docs/NEW-SESSION-START.md` / `AGENTS.md`：**旧开工说明**。`00` 是它们的替代入口；`AGENTS.md` 仍保留命令与发版规程。
- `docs/GAP-LIST.md`：**已过期**（最后版本记录 1.16.305）。当前缺口见 `09-CURRENT-STATE.md`；在它被重写前，不要把它当“唯一清单”。

**没有删除任何旧文档**。这次只新增一套并列的、更新到 1.16.331 的文档；等团队确认后再决定是否在旧文档顶部加指针或归档。
