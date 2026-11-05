# Codem 项目文档集（2026-11-04 重编）

> **基线**：`master` @ 代码提交见 `git log -1`（v1.18.9 已发布）｜ 文档集提交见 `git log -1` ｜ 版本 **1.18.8**（2026-11-05 发布，GitHub `Latest`）
> **用途**：把「长期演进后散落在 170+ 份文档里的现状」重新收拢成一套**可交接、可核查、可分维度阅读**的文档。
> **适用对象**：人类开发者、任何大模型 / Agent 平台、以及未来的维护会话。

---

## 1. 这套文档解决什么问题

这个仓库已经历了多个 Agent 平台与大模型接力开发，代码规模到：

- 前端 `src/` 约 **41.6 万行**（其中 `src/test/` 约 17.7 万行），`App.tsx` 单文件 6432 行；
- Rust 侧 `src-tauri/src` 约 **2.15 万行**，`lib.rs` 单文件 7883 行；
- SQLite **40 张实表** + FTS + 审计表；Tauri **118 个命令注解**；
- `src/core/` **61 个子域**，`src/components/` 160 个顶层组件 + 6 个子目录；
- **880 个测试文件 / 9551 个用例**（2026-11-04 全量实测：9605 通过、17 跳过、0 失败，见 `09-CURRENT-STATE.md`）。

旧文档的问题不是“少”，而是**多且互相矛盾**：`docs/PROJECT-GUIDE.md` 有 823 KB，仍以 1.16.305 的口径写“当前状态”；`AGENTS.md` 已更新到 1.18.8 的版本/测试数与文档指针，但详细状态仍以本套为准；`docs/GAP-LIST.md` 的版本记录停在 1.16.305；`docs/NEW-SESSION-START.md` 已于 2026-11-05 重写为短入口；`docs/HANDOVER-2026-10-17.md` 停在 1.16.329。新会话读旧文档仍可能拿到过期结论。

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

**要交派重型任务（完整评测 / 长尾验证 / 移动端 / 结构债）**：先读 **`20-HEAVY-TASK-HANDOFF.md`**。它包含当前事实、证据等级、任务候选、验收口径和可直接粘贴的开场白；不要把旧 `docs/NEW-SESSION-START.md` 的 1.16 待办当成当前任务。

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
| `06-DATA-STORAGE.md` | 数据分层、40 张表、JSONL、数据根、设置/凭据、迁移/维护 | 长 | schema/存储变化时 |
| `07-BACKEND-IPC.md` | Rust 文件地图、命令面、执行器/PTY、存储引擎、安全、OFM、remote/iLink | 长 | Rust 变化时 |
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
| `18-CONTEXT-CHECKPOINT-DESIGN.md` | 上下文检查点终态设计：压缩不删历史、ContextView/DisplayView、水位同源、spill 永久、迁移/回滚 | 长 | 做「完整历史 + 模型压缩视图」时 |
| `19-CONTEXT-CHECKPOINT-CRITERIA.md` | 18 的判据与施工清单：epoch/cutoff、失败矩阵、迁移/回滚、UI/性能/变异矩阵 | 长 | 实现/评审该设计时 |
| `20-HEAVY-TASK-HANDOFF.md` | **新对话接重型任务的一站式交接包**：当前事实、证据等级、任务候选、验收口径、开场白，以及“绝不做什么” | 中 | 每次大版本/重任务交接 |
| `22-DOCUMENT-INDEX-HANDOFF.md` | **项目级文档索引的重型任务移交包**：三条入口（附件/路径/粘贴）、数据模型、ingestion、doc_* 工具、验收判据与开场白 | 长 | 接文档库任务时 |
| `21-SUPER-AGENT-LESSONS.md` | **Super-agent 修订记录（历史版）**：按原文 + 14 图做过一轮修正；**最新从 0 重做的分析见 `22`**，本文保留为对照 | 长 | 只看历史修订时 |
| `22-SUPER-AGENT-ORIGINAL-TO-CODEM.md` | **从原文 + 14 图从 0 重做：Codem 的提升点**：五模块逐条对照（60+ 行机制矩阵）、协调者/事件/上下文/持久/看门狗/信道/安全/度量、24 条优先级 + 7 条安全前置、判据与变异、原文实验硬度（n=5、假工具、1/4 缩放、图 14 双轴口径）、不该学什么；**建议清单已被 `23` 反向审查修订** | 长 | 评估自主性/多任务/自动化方向时 |
| `22A-SUPER-AGENT-FIGURE-EVIDENCE.md` | **14 张正文图逐图取证**：每张图注、画面元素、关键文字/数字/ID、文字没说的、看不清/不确定；含 fig-03 的 11 条边、fig-08 的逐跳 ID/虚线语义、fig-13 表格逐格、fig-12/14 像素标定 | 长 | 核对原文图、避免误读时 |
| `23-SUPER-AGENT-VALIDITY-REVIEW.md` | **反向审查：22 号建议真的有效吗、原文理论成立吗、会不会弄坏 Codem**：5 维红队（理论/收益/稳定性/产品安全/实验设计）、正反例、Top 10 风险、24 条裁决、A/B gate、n<5 规则；**H1 当前单用户先修 4 个真问题，H2 多用户协同用任务生命周期/事件归属/权限审计做基础** | 长 | **决定是否施工、怎么验证时优先读这份** |

> 说明：本目录在 `docs/` 的子目录下，不受仓库根 `.gitignore` 的 `docs/*.md` 规则影响（已用 `git check-ignore` 验证），可以直接入库。

---

## 4. 当前事实基线（2026-11-04）

| 项 | 值 | 怎么核 |
|---|---|---|
| 版本 | **1.18.9**（2026-11-05 发布） | `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `latest.json` |
| 发布 | GitHub `Codem v1.18.9` = `Latest`（2026-11-05） | `gh release list --limit 1` |
| HEAD | 以 `git log -1` 为准（v1.18.9 已发布） | `git rev-parse --short HEAD` |
| 分支 | `master`；v1.18.9 已提交并推送 | `git status -sb` |
| TypeScript | **0 错误** | `npx tsc --noEmit`（2026-11-04 实测 exit 0） |
| 全量测试 | **880 文件 / 9551 用例：9605 通过、17 跳过、0 失败** | `npx vitest run`（2026-11-04 实测，约 181 秒） |
| 已知失败 | **0** | 见 `09-CURRENT-STATE.md` §3 |
| 工具链 | Node **24.19.0** / npm **11.17.0** / rustc **1.97.1** | `node -v` 等 |
| 工作区 | 干净（仅 `.codem/` 运行时文件未跟踪） | `git status --porcelain` |
| 数据根 | `%APPDATA%\com.codem.app\`；库 `codem-db-rust.bin` | `src-tauri/src/storage.rs` |

> **1.18.8 的主线**：项目级文档索引 + 大规模向量检索（IVF/int8/外存）+ 跨文档证据；接入 AI Code With（一把 key 选 GPT/DeepSeek/GLM/Kimi）；修 OCR 冷启动误报与「暂停免费模型插件后仍能选免费模型」。

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
- `docs/NEW-SESSION-START.md`：**已重写为 2026-11-04 的短入口**，只负责把新会话导向 `20` / `00` / `09`；真正的事实以本套为准。
- `docs/GAP-LIST.md`：**已过期**（最后版本记录 1.16.305）。当前缺口见 `09-CURRENT-STATE.md`；在它被重写前，不要把它当“唯一清单”。

**没有删除任何旧文档**。这次只新增一套并列的、更新到 1.18.8 的文档；等团队确认后再决定是否在旧文档顶部加指针或归档。
