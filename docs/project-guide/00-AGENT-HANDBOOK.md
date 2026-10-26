# 00 · AI 接手手册（任何模型 / Agent 平台先读这份）

> **目标**：只读这份手册 + `02-CODE-MAP.md` + `08-ENGINEERING-GATES.md`，就能在 **30–40 分钟**内安全地改第一行代码，并且知道“什么不能做、做完怎么证明”。
> **基线**：2026-10-26 ｜ `master` @ 代码提交 `bb5d4cce`（文档集提交见 `git log -1`）｜ **1.16.330** ｜ Node 24.19 / rustc 1.97.1。
> **适用范围**：`C:\mimo-gui` 这个仓库（Codem 桌面 AI 编程助手）。大富翁 / Godot 实验线见 `10-GAME-AND-PROTOTYPE.md`。

---

## 0. 先记住这 10 件事

1. **这是 Windows 优先的 Tauri v2 桌面应用**：Rust 进程 + WebView2 里的 React SPA；不是纯 Web 项目，也不是 Electron。
2. **`src/App.tsx` 是应用外壳**（6251 行），**`src/core/llm/agentic-loop.ts` 是 agent 主循环**（6810 行），**`src-tauri/src/lib.rs` 是 Rust 主入口**（7784 行）。这三个文件不要“通读”，按函数名/关键词检索。
3. **代码 > 判据 > 文档**。文档会过期；`src/test/` 里的判据是这个仓库的“法律”。
4. **任何改动都要先写判据，再做变异自证**：把实现改坏，判据必须变红；不变红 = 判据无效。这是本仓库最看重的纪律。
5. **禁止“目标模式 / 持久目标 / 自动续跑 / goal mode”**。用户 2026-10-15 明确要求，已写入 `AGENTS.md §5.9`。一次把事做完；多步用 `todo_write`；需要用户拍板的岔路直接问。
6. **不要靠“再提醒模型一句”解决结构问题**。能用代码/契约/门禁解决的，不要用提示词兜。
7. **凭据是封存的**：库里 `providers[].apiKey` 是空串、`apiKeySealed` 是 `dsh1:…` 密文；不要据此判断“用户没填 Key”。
8. **插件“注册 ≠ 生效”**：`builtin-registry.ts` 只填注册表；真正装配在 `config/codem.base.yml` → `loadFromEntries()`。只注册不写 YAML = 功能永不生效但单测可能全绿。
9. **发布必须先问用户**；评测/构建有互斥纪律；不要整树 `git` 操作。
10. **当前工作区不是干净的**：有未提交的 `.gitignore` / `.jscpd.json`，有未跟踪的 `art/`、`prototype/`、`docs/ref-analysis/`。不要 `git add -A`。

---

## 1. 30 分钟开工清单

在仓库根 `C:\mimo-gui` 执行：

```powershell
pwd
git status -sb
git log --oneline -5
node -v; npm -v; rustc --version
npx tsc --noEmit                 # 期望 exit 0
npx vitest run                   # 约 2.5 分钟；当前基线见 §4
```

然后按顺序读：

1. 本文件（10 分钟）；
2. `02-CODE-MAP.md` 的「目录树 + core 子域表」（10 分钟）；
3. `03-RUNTIME-FLOWS.md` 的「一轮对话主链路」（10 分钟）；
4. `08-ENGINEERING-GATES.md` 的「改动配方 + 影响表」（10 分钟）。

如果只做 UI：把 3 换成 `05-UI-UX.md`；只做存储：换成 `06-DATA-STORAGE.md`；只做 Rust：换成 `07-BACKEND-IPC.md`。

---

## 2. 项目坐标（最短版）

```text
Codem = 对话 → 计划 → 工具调用（读写文件/跑命令/终端）→ 验证，做成 GUI
技术栈 = Tauri v2 + Rust + React 18 + TypeScript + Zustand + SQLite(WAL) + Phaser(内置游戏)
分发   = NSIS .exe + WiX .msi；Windows 优先；GitHub Releases + minisign 自动更新
数据   = %APPDATA%\com.codem.app\codem-db-rust.bin（索引）
        + sessions/<sid>.jsonl（权威追加日志）
        + attachments/ + spill/ + extensions/our-free-model/
```

三个“主动脉”：

- **Agent 主链路**：`App.tsx::runAgenticLoop` → `LLMEngine.process` → `AgenticLoop.run` → `provider.stream` → `StreamingToolExecutor` + `ToolPipeline` → 消息/事件落库。
- **插件装配链**：`config/codem.base.yml`（171 条）+ `codem.desktop.yml` → `mergeYamlEntries` → `loadFromEntries` → Cordis `ctx.plugin()` → 服务/工具/UI 槽位。
- **存储链**：`src/core/storage/*` → `rust-port.ts` → `storage_invoke`（117 命令中的 7 个）→ `codem-db` 引擎（WAL、单写者、authorizer 禁裸 SQL）。

---

## 3. 六条硬规则（违反会被判据或用户挡住）

### 3.1 判据先行 + 变异自证

- 新行为：先在 `src/test/` 写一个会因缺陷而红的用例；
- 修 bug：先让用例复现红，再修；
- **变异**：把实现改坏，跑用例必须红；还原后必须绿。只写用例不做变异 = 没测。
- 计时敏感用例在全量并行下可能抖动：**先单跑确认**，不要急着改代码。

### 3.2 结构优先于提示词

- 真机验证过：提醒类手段在通过与失败的轮次里都会出现，不是分水岭。
- 需要“模型别再做 X”时，优先加**工具契约 / 状态机 / 数据校验 / 门禁**，而不是加一段提示。

### 3.3 禁止目标模式

- 不创建持久目标、不自动续跑、不用 goal mode 迭代。
- 一次交付在同一轮内推进；多步用 `todo_write`；必须用户拍板（发版、产品取舍）就直接问。
- 本文件本身就是“反目标模式”的产物：把上下文一次写清，而不是靠多轮自动续跑补。

### 3.4 诚实失败

- 没验成的，不许写成“已验证”；不确定就标「未知」。
- 失败必须可见：不能把失败伪装成“已是最新 / 已完成 / 已保存”。
- 用户无法介入的自检发现只进日志；用户能采取动作的才弹提示。

### 3.5 中文与符号

- 回答用中文；文档/注释里的中文引号统一 `「」`。
- 写脚本时尤其注意：JS 模板串里不要嵌反引号；块注释里不要出现 `*/`；中文串里不要混半角引号。
- 写完脚本 **立刻** `node --check <file>`。

### 3.6 进程与数据安全

- **只按 PID 杀自己 spawn 的进程**；绝对不要 `taskkill /IM codem.exe`。
- 真机/构建持锁：`mkdir .preview-shot/_realmachine.lock`，用完 `rmdir`；锁超过 30 分钟可接管。
- 禁止整树 `git stash` / `checkout -- .` / `reset --hard`；只 `git add <显式路径>`。
- 只读钻取数据库必须走 `tools/maintenance/read-only-db.mjs` 的 `withReadOnlyDb` / `openReadOnlyDb`（复制 `.bin` + `-wal` + `-shm` 到临时目录再读），不要直接只读打开真库。

---

## 4. 当前基线（2026-10-26 实测）

| 项 | 值 |
|---|---|
| 版本 | **1.16.330**（`package.json` / `tauri.conf.json` / `Cargo.toml` / `latest.json` 一致） |
| 发布 | GitHub `Codem v1.16.330` = `Latest`（2026-10-23） |
| HEAD | 以 `git log -1` 为准；代码基线 `bb5d4cce` |
| `tsc --noEmit` | **0 错误** |
| 全量测试 | **733 文件 / 8516 用例：8497 通过、17 跳过、2 失败**（约 149 秒） |
| 两条失败 | ① `no-bom.test.ts`：18 个**未跟踪**游戏文档带 BOM；② `docs-current-gap-list.test.ts`：`MONOPOLY-GODOT-PLAN.md` / `MONOPOLY-REBUILD-PLAN.md` 缺“历史文档”横幅。**都不是产品代码回归** |
| 变异波次 | 65+ 波（`node tools/mutate/check-artifacts.mjs`） |
| 上报点分诊 | 267 = 267（`node tools/audit/scan-report-sites.mjs --check`） |
| 工作区 | `master...origin/master` 同步；`.gitignore` / `.jscpd.json` 有未提交修改；`art/`、`prototype/`、`docs/ref-analysis/` 未跟踪 |

> 如果你跑出来不是这个数：先确认是不是多了未跟踪文件（`git status`），再看 `09-CURRENT-STATE.md`。不要为了让“全绿”去改产品代码。

---

## 5. 真相源优先级

1. `src/`、`src-tauri/` 的可执行代码；
2. `src/test/*.test.ts`、`src-tauri/**/tests/*.rs`；
3. `docs/project-guide/`（本套，标注日期/基线）；
4. `CHANGELOG.md` 顶部（面向用户，不含内部编号）；
5. `docs/HANDOFF-NEXT-SESSION.md`（逐轮日志，grep 用，不通读）；
6. 其余 `docs/*.md`（多数已过期）。

**遇到冲突**：代码为准，然后修文档。不要用旧文档推翻代码行为。

---

## 6. 最小上下文包（复制给任何模型）

```text
你在 Windows 仓库 C:\mimo-gui 工作。这是 Codem：Tauri v2 + Rust + React/TS 的桌面 AI 编程助手。
先读 docs/project-guide/00-AGENT-HANDBOOK.md、02-CODE-MAP.md、08-ENGINEERING-GATES.md，
再读 09-CURRENT-STATE.md。按任务补 03（运行时）/05（UI）/06（存储）/07（Rust）。
硬规则：先写判据 + 变异自证；禁止 goal mode / 自动续跑；不要整树 git 操作；
只按 PID 杀自己 spawn 的进程；发布先问用户；中文引号用「」；新文件无 BOM。
当前基线：1.16.330，tsc 0，733 测试文件 / 8516 用例（2 条失败来自未跟踪游戏文档）。
先跑 git status -sb、npx tsc --noEmit，再决定改哪里。
```

如果对方**没有仓库访问权**：把 `02-CODE-MAP.md`、`03-RUNTIME-FLOWS.md` 和本文件一起给；没有代码时不要让它猜实现细节。

---

## 7. 第一次改动怎么选（任务路由）

| 任务 | 先看 | 第一个该打开的文件 | 容易漏的同步点 |
|---|---|---|---|
| 对话不回复 / 流式中断 | 03 §3–§5 | `App.tsx::runAgenticLoop`、`agentic-loop.ts::run` | `provider.ts` 超时、`streaming-executor` 中止 |
| 工具没被调用 / 调错 | 03 §6、08 §6 | `core/llm/tools.ts`、`tool-pipeline.ts` | 工具注册、并发白名单、输出契约、上报点登记 |
| 上下文爆 / 压缩无效 | 03 §8 | `compaction-budget.ts`、`agentic-loop.ts::doCompactMessages` | `context-fold`、`ContextMonitor`、设置阈值 |
| 记忆重复 / 审批太多 | 03 §9 | `core/memory/memory.ts`、`llm/index.ts::extractMemoriesFromSession` | 面板、scope、拒绝记录、注入 |
| 设置保存无效 | 05 §6、08 §6 | `SettingsPanel.tsx::handleSave`、`storage/settings.ts` | 读写键对称、`SKEY-2`、写后确认 |
| 插件开关没效果 | 03 §2、08 §6 | `config/codem.base.yml`、`plugin-loader/*` | 注册表 + YAML 双入口、fiber 卸载 |
| 数据库/迁移 | 06 | `schema.sql`、`migrate.rs`、`rust-port.ts` | 三条门禁：schema parity / unrouted-db / storage-boundary |
| 新增 Rust 命令 | 07 §2 | `lib.rs` 的 `generate_handler!` | 前端 `invoke` 参数、Rust 测试、TAURI-ARITY |
| UI 错位/皮肤坏 | 05 | `App.tsx`、`styles.css`、`skin-*.css` | CSS 契约、三皮肤、窄容器、可访问名 |
| 发布 | 08 §7 | `docs/RELEASE-GUIDE.md` | 四处版本号、签名、latest.json、Latest 抢回 |

---

## 8. 常见坑（按会让你误判的程度排序）

1. **凭据封存**：原始库里 `apiKey` 为空 ≠ 没填。要判断走设置层水合。
2. **注册 ≠ 装配**：只改 `builtin-registry.ts`，功能不会生效；必须改 `config/codem.base.yml`。
3. **`docs/*.md` 不一定入库**：根目录很多文档被 `.gitignore` 忽略；只有显式 `!docs/...` 的白名单会进 git。本套文档在子目录，已确认不被忽略。
4. **`stripComments` 之后注释消失**：任何“用注释当切片锚点”的判据都会 `indexOf=-1` 而恒红。
5. **日历炸弹**：判据读“某时间戳距今多久”时，生成器若不刷新时间戳，到期必红。
6. **全量并行抖动**：计时敏感用例在满载时会超时；先单跑。
7. **PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM**：会炸 JSON/PostCSS；用无 BOM 写法。
8. **脚本内容错误的三种死法**：模板串里嵌反引号、块注释里出现 `*/`、中文串里混半角引号。
9. **`/tmp` 在 MSYS 与 Node 里可能不是同一个目录**：跨两者传临时文件会失败。
10. **不要用“目标模式/自动续跑”**：见 §3.3。
11. **同名“保存”按钮**：面板里只有 `handleSave` 是规范路径；其余可能只是刷新模型/立即生效的选项。
12. **`session_events` 不可从 JSONL 重建**：它含压缩、工具配对、turn 时间线；维护刻意不压缩它。
13. **`needs_you_pending` / `agent_messages` 有表无实现**：队列实际在内存，不要据表名以为已持久化。
14. **`execute_command` 与 `write_file` 是两套安全事实**：写文件有沙箱判定，跑命令目前没有工作区校验。
15. **删除运行中会话**：必须先 abort loop 再删；否则会撞 FK / 消息归属不一致。当前版本已修，但新增删除路径要沿用同一登记表。

---

## 9. 交接前自检

```powershell
npx tsc --noEmit                          # 0
npx vitest run <相关判据>                  # 先单跑
npx vitest run                            # 全量（知道基线，别被 2 条未跟踪失败骗）
node tools/audit/scan-report-sites.mjs --check   # 267 = 267
node tools/mutate/check-artifacts.mjs     # 变异产物未过期
node tools/ui-audit/css-contract.mjs      # 改 CSS 后先 --write
node tools/audit/knip-gate.mjs            # 未使用导出不许增长
```

交付说明必须写清：

- 改了什么、为什么；
- 判据文件/用例名，以及变异做了哪几条；
- 哪些是**真机验证**、哪些只有判据层证据；
- 没做的、已知风险、下一步。

---

## 10. 文档地图

| 想知道 | 读 |
|---|---|
| 产品是什么、能力边界 | `01-PRODUCT-OVERVIEW.md` |
| 代码在哪、core 60 个子域各干什么 | `02-CODE-MAP.md` |
| 一轮对话/工具/压缩/记忆/项目怎么跑 | `03-RUNTIME-FLOWS.md` |
| 有哪些功能、入口在哪、成熟度 | `04-FEATURE-MODULES.md` |
| 界面/皮肤/令牌/交互 | `05-UI-UX.md` |
| 表/JSONL/数据根/凭据/迁移 | `06-DATA-STORAGE.md` |
| Rust 命令/执行器/PTY/安全 | `07-BACKEND-IPC.md` |
| 测试/审计/变异/评测/发布/改造配方 | `08-ENGINEERING-GATES.md` |
| 现在做到哪、哪些没验、下一步 | `09-CURRENT-STATE.md` |
| 大富翁插件 / Godot 重制 | `10-GAME-AND-PROTOTYPE.md` |
| 怎么把项目交接给新模型/新 Agent | `11-HANDOFF-PROMPT.md`（可直接复制的开场白 + 验收问题） |

---

> **最后一句**：这个仓库里大量中文注释在解释“为什么”，很多坑已经写在那里。改动前先读目标文件顶部与关键分支的注释；不要先假设“这是遗留垃圾”。如果注释与代码冲突，以代码 + 判据为准，并把注释修到一致。
