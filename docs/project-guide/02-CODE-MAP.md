# 02 · 代码地图：目录、分层、60 个 core 子域

> 基线：1.16.330 ｜ 2026-10-26 ｜ 所有路径相对仓库根 `C:\mimo-gui`
> 目的：让接手者 10 分钟内知道“东西在哪、改哪里、哪些文件别硬读”。

---

## 1. 顶层目录

```text
C:\mimo-gui\
├─ src\                     React 前端（约 44.4 万行，含测试）
├─ src-tauri\               Tauri v2 / Rust（约 2.2 万行 + codem-db 1 万行）
├─ config\                  插件装配清单（codem.base.yml / codem.desktop.yml）
├─ tools\                   审计 / 变异 / 评测 / 发布 / UI 审计 / 维护 / 迁移 / 基准
├─ docs\                    文档（根级 173 份 .md + 本套文档；约 309 MB；含大量历史稿与游戏美术）
├─ scripts\                 PowerShell / Node 运维脚本
├─ public\                  Vite 静态资源
├─ icos\、src-tauri\icons\  应用图标
├─ prototype\               **未跟踪**：Godot 2.5D 重制实验（shenman / wealth-island…）
├─ art\                     **未跟踪**：游戏美术源与 rebuild 数据
├─ .preview-shot\           **gitignored**：真机/评测/截图脚手架与产物
├─ node_modules\、dist\     依赖与构建产物
├─ package.json             scripts + 前端依赖（name=codem, version=1.16.330）
├─ AGENTS.md                旧版快速规程（部分数字已过时）
├─ CHANGELOG.md             1.2 MB 版本说明（按版本 grep）
├─ README.md                189 KB 项目介绍（历史）
├─ 项目功能树-全量.md        532 KB / 2779 条功能叶子（2026-09-09 生成）
└─ latest.json              更新器清单（1.16.330）
```

**注意**：`prototype/`、`art/`、`docs/ref-analysis/`、`.edge-ref-profile*/` 都是未跟踪内容。不要把“仓库根有什么”当成“产品包含什么”。

---

## 2. 前端 `src/` 结构

```text
src\
├─ main.tsx                 主窗入口：polyfill → 材质探测 ≤400ms → App
├─ pet-main.tsx             宠物窗入口（独立轻量 bundle：React + PetWindowApp + pet-window.css）
├─ App.tsx                  应用外壳（6251 行）：Cordis 启动、DB 引导、布局、发送/流式/事件消费
├─ store.ts                 useAppStore（1053 行）：消息、流式缓冲、工具卡、状态
├─ styles.css               全局样式 + 设计令牌（21547 行 / 671 KB）
├─ styles\                  skin-hub / skin-dream / codem-ui / notebook-workspace / task-center / pet-window
├─ components\              152 个顶层组件 + 6 个子目录（共 197 文件）
│  ├─ ui\                   14 个原语：dialog / dropdown / popover / tooltip / switch / badge / card…
│  ├─ task-center\          15 个：TaskCenter + 8 Tab + IssueBoard/IssueCard/IssueDetailPanel
│  ├─ ppt\                  7 个：PPTAdapter / PPTEditor / SlideCanvas / PropertyPanel / EditorToolbar…
│  ├─ rich-content\         6 个：RichContent / CodeBlockView / MermaidCanvasView / ImagePreviewView…
│  ├─ plugin-market\        2 个：PluginMarketTab / DshExternalPluginsCard
│  └─ zvec\                 1 个：ZvecGrepMarketCard
├─ core\                    60 个子域（799 文件 / 16.5 万行）
├─ plugins\                 3 个内置插件：monopoly-game（194）、library-ops（42）、shell-ops（3）
├─ hooks\                   13 个：useDomainReady / useDismissableLayer / useRovingFocus / useWindowState…
├─ lib\                     1 个（轻量工具）
├─ stubs\                   process / buffer polyfill（浏览器环境）
├─ types\                   共享类型
├─ utils\                   file-mentions / auto-link-paths / file-link
├─ assets\                  logo 等
└─ test\                    764 个 .test.ts(x) + helpers/fixtures（约 16.3 万行）
```

### 2.1 关键前端文件（按“改得最多/最大”）

| 文件 | 行数 | 作用 | 怎么读 |
|---|---:|---|---|
| `src/App.tsx` | 6251 | 外壳、启动、发送、`runAgenticLoop`、事件消费、所有面板挂载 | 先读 160–360（Cordis）、1814–2140（启动）、3604–4115（发送）、4139–4700（事件）、5153–5900（布局） |
| `src/core/llm/agentic-loop.ts` | 6810 | Agent 主循环、上下文构建、压缩、工具批次、守卫、收尾 | 读 1838（`run`）、3919（`executeIteration`）、4785（工具执行）、5914（压缩） |
| `src/core/llm/index.ts` | 2985 | `LLMEngine`：provider 解析、系统提示、记忆提取、工具注册、会话循环池 | 读 415–850（构造/工具注册）、1423–1640（`process`）、2409（记忆提取） |
| `src/core/llm/tools.ts` | 2481 | 核心 ToolDef + `ToolRegistry` + 文件/命令工具实现 | 读 2510（`createDefaultToolRegistry`） |
| `src/core/llm/provider.ts` | 1126 | OpenAI 兼容流式、超时、重试、模型上下文窗口 | 读 `OpenAICompatibleProvider` |
| `src/core/llm/streaming-executor.ts` | 922 | 工具批次并发、超时、逐工具执行 | 读 279（类）、602（`runOneTool`） |
| `src/core/llm/tool-pipeline.ts` | 1481 | 5 层管线：pre / guard / execute / post / finalize | 读 1–30（设计） |
| `src/core/storage/rust-port.ts` | ~3300 | Rust 存储端口：IPC、镜像、重试、分页、凭据缓存 | 按函数名查 |
| `src/core/storage/message.ts` | ~3800 | 消息双写、FTS、附件、软删、投影 | 按函数名查 |
| `src/components/ChatPanel.tsx` | 1713 | 对话区：头部、消息流、引导栏、浮动面板 | 读 642–1600 |
| `src/components/InputArea.tsx` | 1885 | 输入区：模型、附件、@、/、审批、发送/停止 | 读 1360–1885 |
| `src/components/SettingsPanel.tsx` | 3989 | 23 个设置分区 + 保存规范路径 | 读 646（分区联合）、1097–1266（壳）、`handleSave` |
| `src/components/MessageBubble.tsx` | 1193 | 消息渲染：Markdown/推理/工具/错误/附件/操作 | 按分支查 |
| `src/styles.css` | 21547 | 全局令牌 + 默认皮肤 + 高对比/密度 + 材质 | 只 grep 令牌/类名，别通读 |

---

## 3. `src/core/` 60 个子域

> 文件数为递归计数；职责是“这个目录负责什么”，不是逐个文件说明。

### 3.1 引擎 / Agent（12）

| 目录 | 文件 | 职责 | 关键文件 |
|---|---:|---|---|
| `llm/` | 106 | Agent 主循环、工具、provider、流式、压缩、成本、多模态、缓存 | `agentic-loop.ts`、`index.ts`、`tools.ts`、`provider.ts`、`streaming-executor.ts`、`tool-pipeline.ts` |
| `agent/` | 3 | Agent 定义、协作模式（default/plan）、预设发现 | `agent.ts`、`preset-discovery.ts` |
| `agent-teams/` | 3 | 运行时多智能体团队（成员、任务、通信） | `engine.ts`、`tools.ts` |
| `subagent/` | 6 | 子代理运行时：启动/继续/中断/结算、进程内 provider | `runtime.ts`、`subagent-session.ts`、`spawn-in-process-provider.ts` |
| `squad/` | 4 | 团队模板（蓝图）：成员、派发、状态 | `squad.ts`、`squad-tools.ts` |
| `session/` | 16 | 跨会话委派/交接、后台执行器、消息总线、并发上限、空闲看门狗 | `executor.ts`、`orchestrator.ts`、`bus.ts`、`handover.ts` |
| `goal/` | 1 | 目标（create/get/update）与会话续跑 | `goal.ts` |
| `context/` | 3 | token 预算、上下文压力、水位 | `context.ts`、`water-level.ts` |
| `prompt/` | 4 | 系统提示构建、i18n 模板、分层指令、缓存边界 | `prompt.ts`、`i18n-templates.ts`、`instruction-layers.ts` |
| `provider/` | 195 | 每个 Cordis 服务一个 provider 文件（**不是** LLM provider） | `llm-provider.ts`、`agent-loop-provider.ts`、`storage-*`、`ui-*` |
| `side-session/` | 1 | 侧会话（并行预览/隔离） | `side-session.ts` |
| `consumer/` | 1 | `tryGetCtx()` / `getCtxService()`：插件消费者取服务 | `index.ts` |

> ⚠️ `core/provider/` 里 195 个文件是 **Cordis 服务提供者**，不是模型供应商。模型供应商在 `core/llm/provider.ts` + `core/llm/tools/*`。这是最容易找错的地方。

### 3.2 存储 / 知识（5）

| 目录 | 文件 | 职责 | 关键文件 |
|---|---:|---|---|
| `storage/` | 42 | 唯一存储抽象：Rust 端口、消息/会话/事件、设置、迁移、维护、附件、spill、凭据 | `rust-port.ts`、`message.ts`、`session.ts`、`event-log.ts`、`settings.ts`、`bootstrap.ts`、`maintenance.ts` |
| `memory/` | 8 | 三层记忆：提取、合并、查重、积压、体检、迁移 | `memory.ts`、`candidate-merge.ts`、`pending-backlog.ts`、`checkup.ts` |
| `knowledge/` | 109 | 笔记本、来源、分块/嵌入、RAG、笔记/双链、图谱、闪卡、学习路径、PPT | `storage.ts`、`indexer.ts`、`retriever.ts`、`ppt-generator.ts` |
| `snapshot/` | 2 | 工作区快照与文件级记录 | `snapshot.ts` |
| `recovery/` | 2 | 中断恢复数据 | `recovery.ts` |

### 3.3 生态 / 扩展（12）

| 目录 | 文件 | 职责 | 关键文件 |
|---|---:|---|---|
| `skill/` | 10 | 技能运行时：加载、安装、市场、注册表 | `skill.ts`、`installer.ts`、`skill-market-client.ts` |
| `skills/` | 102 | 内置技能资源（SKILL.md + 模板/HTML/字体） | 按技能名查 |
| `plugin-loader/` | 5 | 插件注册表、YAML 解析/装配、插件管理服务 | `builtin-registry.ts`、`yaml-loader.ts`、`plugin-manager-service.ts` |
| `plugin-market/` | 3 | DSH 插件市场目录、外部插件检查更新 | `dsh-market-catalog.ts`、`external-dsh-plugins.ts` |
| `mcp/` | 3 | MCP 服务器管理、目录、运行时桥 | `mcp.ts`、`mcp-registry-catalog.ts` |
| `slots/` | 4 | UI 槽位：single/list/keyed/chain + React bridge | `index.ts`、`SlotBridge.tsx`、`declare-slots.ts` |
| `ui-plugins/` | 14 | 内置 UI 插件包（sidebar/conversation/settings…） | `index.ts` |
| `cordis/` | 15 | 内置 Cordis DI 容器（Context/Fiber/Registry/Reflect） | `fiber.ts`、`registry.ts` |
| `dsh-compat/` | 2 | DSH 协议兼容别名（dshLlm/dshShell/dshFs/dshTools） | `index.ts` |
| `seam/` | 3 | Capability Seam：文件/Shell 能力的可替换边界 | `types.ts`、`local-fs-provider.ts`、`local-shell-provider.ts` |
| `portable-node/` | 1 | 便携 Node 解析（OFM 用） | `index.ts` |
| `zvec-grep/` | 5 | 语义检索（可选，zvec/embedding） | `service.ts`、`runtime.ts` |

### 3.4 安全 / 配置（5）

| 目录 | 文件 | 职责 | 关键文件 |
|---|---:|---|---|
| `settings/` | 4 | 分层设置、UI 偏好、自定义 provider、导出脱敏 | `settings.ts`、`ui-preferences.ts`、`custom-provider.ts` |
| `permission/` | 5 | 三档安全模式、审批 broker、bash 命令分析、权限规则 | `permission.ts`、`security-mode.ts`、`approval-broker.ts`、`bash-analyzer.ts` |
| `sandbox/` | 1 | 沙箱 ACL：工作区/允许目录判定 | `sandbox-acl.ts` |
| `auth/` | 2 | MiMo 账号登录/凭据 | `mimo.ts` |
| `config/` | 1 | 分层配置加载（global/project/local） | `loader.ts` |

### 3.5 工程 / 集成（11）

| 目录 | 文件 | 职责 | 关键文件 |
|---|---:|---|---|
| `project/` | 8 | 项目工作台：文件、存储、报告契约、协调者 | `files.ts`、`storage.ts`、`report-contract.ts`、`coordinator/*` |
| `environment/` | 6 | 工作树、文件变更追踪、git 提交、自定义操作 | `worktree-manager.ts`、`file-change-tracker.ts`、`git-commit-service.ts` |
| `cicd/` | 2 | GitHub Actions 流水线（只读/重跑） | `pipeline.ts` |
| `automation/` | 1 | 定时/文件监听触发器 | `automation-manager.ts` |
| `issue/` | 4 | 结构化任务（Issues） | `issue.ts`、`issue-tools.ts`、`issue-storage.ts` |
| `inbox/` | 3 | 全局通知聚合 | `inbox.ts`、`inbox-storage.ts` |
| `phone-link/` | 7 | 手机连接：LAN 配对、事件流、AA 协议 | `phone-link.ts`、`event-stream.ts`、`aa-notice.ts` |
| `wechat-bridge/` | 1 | 微信 ClawBot 桥（iLink） | `wechat-bridge.ts` |
| `computer-use/` | 2 | 读屏/鼠标键盘自动化 | `computer-use.ts` |
| `hooks/` | 2 | 工具钩子（PreToolUse/PostToolUse） | `hook-manager.ts` |
| `js/` | 2 | JS VM / 远程运行时（run_code、workflow） | `js-vm.ts`、`js-remote-runtime.ts` |

### 3.6 可观测 / 韧性（5）

| 目录 | 文件 | 职责 |
|---|---:|---|
| `telemetry/` | 1 | 事件遥测（turn/tool/错误） |
| `diagnostics/` | 1 | 渲染侧取证 |
| `heartbeat/` | 2 | 会话心跳/活动检测 |
| `retry/` | 2 | 统一重试执行器 |
| `update/` | 3 | 更新检查/下载进度/重试 |

### 3.7 UI 支撑 / 其它（10）

| 目录 | 文件 | 职责 |
|---|---:|---|
| `theme/` | 12 | 三皮肤、主题、对比度、取色、外观档 |
| `ui/` | 11 | 纯 UI 逻辑：滚动图钉、边缘渐隐、diff 模型、roving focus、提示音、原生对话框 |
| `icons/` | 2 | 图标映射 |
| `i18n/` | 1 | 中英文案 |
| `shortcuts/` | 1 | 全局快捷键 |
| `pet/` | 6 | 桌面宠物：store、manager、市场 |
| `time/` | 1 | 本地时间唯一口径 |
| `utils/` | 6 | 凭据形状、字节、脱敏 |
| `free-model-plugin/` | 2 | OFM 模型索引/健康/聚合服务 |
| `persona/` | 1 | 人设卡 |

---

## 4. Rust 侧 `src-tauri/`

```text
src-tauri\
├─ src\
│  ├─ lib.rs                 7784 行：66 个命令 + run() + 窗口/托盘/宠物 + 文件/命令/PTY/MCP/HTTP
│  ├─ main.rs                5 行：只调 codem_lib::run()
│  ├─ storage.rs             965 行：7 个存储命令 + 数据根/隔离根解析
│  ├─ secret.rs              290 行：DPAPI 封存（dsh1:）
│  ├─ runtime_log.rs         505 行：按日日志 / 脱敏 / 保留
│  ├─ crash_evidence.rs      604 行：渲染崩溃取证（ProcessFailed/心跳/标记）
│  ├─ ofm.rs                 543 行：免费模型插件 Node 进程生命周期（9 命令）
│  ├─ js_sandbox.rs          870 行：boa_engine 单发沙箱（2 命令）
│  ├─ js_sandbox_session.rs  1052 行：会话级 JS 沙箱（4 命令）
│  ├─ ilink\                 5 文件：微信 iLink 传输层（5 命令）
│  └─ phone\                 13 文件：Phone Link / AA / TLS / 中继（19 命令）
├─ codem-db\
│  ├─ src\engine.rs          1010 行：连接、WAL、事务、健康
│  ├─ src\repo.rs            2353 行：类型化仓储（messages/sessions/events…）
│  ├─ src\crud.rs            877 行：通用表/列白名单 CRUD
│  ├─ src\migrate.rs         3500 行：旧库迁移 + 对账
│  ├─ src\authorizer.rs      150 行：SQL 白名单（禁 ATTACH/load_extension/危险 PRAGMA）
│  ├─ src\fts.rs             172 行：FTS5 + 中文 bigram
│  ├─ src\audit.rs           420 行：删除审计触发器
│  ├─ src\schema.rs          202 行：schema 加载/迁移/种子
│  └─ sql\schema.sql         595 行：39 表真源
├─ capabilities\default.json 41 条权限（main + pet）
├─ resources\                内置 Node / 图标等
├─ icons\、binaries\、gen\
└─ tauri.conf.json           窗口、CSP、updater、bundle
```

**命令分布**（117 注册）：lib.rs 66、phone 16、ofm 9、storage 7、ilink 5、js_sandbox_session 4、crash_evidence 3、phone/connector 3、secret 3、js_sandbox 2。详见 `07-BACKEND-IPC.md`。

---

## 5. 配置、工具、文档

### 5.1 `config/`

- `codem.base.yml`：**171 条**插件声明（core / inject / when / config / disabled）。
- `codem.desktop.yml`：桌面覆盖层，禁用 host-webserver / api-gateway / CLI 等 Web 模式插件。

> **装配 ≠ 注册**：`builtin-registry.ts` 只填表；真正生效走 `mergeYamlEntries` → `loadFromEntries` → `ctx.plugin()`。详见 `03` §2。

### 5.2 `tools/`

| 目录 | 文件 | 用途 |
|---|---:|---|
| `audit/` | 55 | 结构审计：上报点、可达性、静默写、假成功、存储边界、schema parity、命令 parity、knip、覆盖率、颜色角色、控制字节… |
| `mutate/` | 136 | 变异波次与产物校验（`specs/*.json`、`check-artifacts.mjs`） |
| `eval/` | 27 | 评测口径：配对报告、去重、repo 任务臂、selftest/mutation |
| `release/` | 7 | 更新清单校验、发布 tag 校验 |
| `ui-audit/` | 13 | CSS 契约、未定义类名、样式字面量、动效令牌、文档令牌 |
| `maintenance/` | 4 | 清理开发产物 / 只读钻取 DB / 孤儿进程 |
| `migrate/` | 3 | 存储迁移计划/执行/校验/回滚提示 |
| `bench/` | 4 | DB 规模 / 内存基准 |
| `vendor/` | 7 | OFM 内置副本拉取与校验 |
| `preview/` | 122 | 预览/截图脚手架（部分产物 gitignored） |

### 5.3 `docs/`

- 根级 173 份 `.md` + 本套文档；具体跟踪数用 `git ls-files docs` 查；目录总计约 309 MB（含大量 PNG/JPG 游戏美术）。
- **当前真源**：`docs/project-guide/`（本套）。
- **历史但仍有用**：`docs/HANDOVER-2026-10-17.md`（三条主动脉/陷阱）、`docs/RELEASE-GUIDE.md`、`docs/manuals/*`。
- **功能叶子库**：`docs/CODEM-FEATURES.md`、根目录 `项目功能树-全量.md`。
- **已过期**：`docs/PROJECT-GUIDE.md`（823 KB，状态停在 1.16.305）、`docs/GAP-LIST.md`（1.16.305）、`docs/TODO.md`、大量 `*-PLAN/GAP/AUDIT` 稿。
- **游戏/美术稿**：`docs/MONOPOLY-*`、`ART-*`、`board-*.png` 等，属未跟踪实验线，见 `10`。

---

## 6. “我要加/改 X，去哪？”

| 目标 | 主文件 | 必须同步 |
|---|---|---|
| 加一个 LLM 工具 | `core/llm/tools/<name>.ts` + `core/llm/tools.ts` 的 `createDefaultToolRegistry` | 并发白名单 `concurrency-policy.ts`；`outputSchema` + `renderOutput`；上报点登记；测试 |
| 加一个设置项 | `core/storage/settings.ts`（读写键） + `SettingsPanel.tsx` 对应分区 | 读写两侧、`SKEY-2`、保存走 `handleSave` |
| 加一个设置分区 | `SettingsPanel.tsx` 的联合类型 + 导航 + 搜索索引 + 渲染分支 | 23 个分区计数、三皮肤、aria |
| 加一个 DB 表/列 | `src-tauri/codem-db/sql/schema.sql` + `migrations.json` + `schema.rs`（种子） | `tables.json`、`gen-schema-sql.mjs --check`、契约测试、迁移 |
| 加一个 Rust 命令 | `lib.rs`（或 phone/ofm/storage 模块）的 `#[tauri::command]` + `generate_handler!` | 前端 `invoke` 参数、Rust 测试、`TAURI-ARITY` |
| 加一个 provider | `core/provider/*-provider.ts` + `config/codem.base.yml` | `builtin-registry.ts`、注入依赖、启停 |
| 加一个 UI 槽位 | `core/slots/declare-slots.ts` + 消费点 `SlotBridge` | 槽位契约、fallback、三皮肤 |
| 加一个服务 | `core/provider/<svc>-provider.ts` + YAML 条目 | 消费者 `getCtxService`、激活校验 |
| 加一个技能 | `core/skills/<name>/SKILL.md` 或用户技能目录 | `skills` 索引、market、`load_skill` |
| 加一个 MCP 能力 | `core/mcp/mcp.ts` + 设置面板 | 工具同步、资源同步、审批 |
| 改系统提示 | `core/prompt/prompt.ts` + `i18n-templates.ts` | 缓存边界、记忆段序、判据 `MEM-PLACE-*` |

---

## 7. 大文件怎么读（不要通读）

1. **先 grep 关键词**：`Select-String -Path <file> -Pattern '...'`，或 `grep` 工具。
2. **读文件头 80 行**：这些文件顶部通常有“为什么这样写”的长注释。
3. **按导出符号读**：`export function` / `export class` / `private async` 的骨架比正文更有用。
4. **优先读判据**：`src/test/*<关键词>*.test.ts` 常比实现更清楚地说明契约。
5. **看 git blame/log**：大段注释里的波次号可以 `git log --grep` 找到当时的事故记录。

**五个“巨无霸”**：`styles.css`（19k 行）、`lib.rs`（7.8k）、`agentic-loop.ts`（6.8k）、`App.tsx`（6.3k）、`SettingsPanel.tsx`（4k）。它们的共同问题是“单文件承载了过多职责”，但当前不建议为了“好看”而大拆——拆分会同时触发大量判据、CSS 契约、可达性门禁与真机验证，风险远大于收益。

---

## 8. 已知的“看起来有、其实不可达”

这些是接手时最容易白费时间的地方（详见 `09` 的风险表）：

- `ChatPanel.showWorkbench` 只有 `setShowWorkbench(false)`，从未置 `true` ⇒ 分屏 Workbench 永不出现（`ChatPanel.tsx:350,948,1347`）。
- `SpaceSwitcher` 只剩 import，侧栏挂载点已删 ⇒ 当前无“工作空间切换”入口（`Sidebar.tsx:14,601`）。
- `needs_you_pending` / `agent_messages` 两张表有 schema、无实际读写 ⇒ 队列在内存（`core/llm/needs-you-queue.ts:8`、`agent-message-queue.ts:8`）。
- `src/core/storage/event-log.ts` 里 `EVENT_SCHEMA` 零引用，与 Rust 真源并存。
- `src/core/provider/index.ts` 已在 1.16.321 删除；不要再找 `loadDefaultProviders`。
- 顶部页签栏已整体移除；终端在标题栏、性能在设置、文件/任务/CI-CD 在右侧抽屉（`bottom-tab-entries.ts:1-21`）。

---

## 9. 命名与目录约定

- **`core/` 不依赖 React**（除 `slots/SlotBridge.tsx`、`ui-plugins` 等明确 UI 包）；组件只通过 `core` 的服务/端口访问后端。
- **`provider/` = Cordis 服务提供者**；**`llm/provider.ts` = 模型供应商**。两者不是一个概念。
- **`storage/` 是唯一数据访问层**：组件/引擎不要直接 `invoke("storage_invoke")`；走 `storage/*` 的语义函数。
- **`tools/` 不是产品代码**：审计/变异/评测/发布脚本，改动不影响安装包，但门禁依赖它们。
- **`src/test/` 是判据**：不是“可选测试”；新增行为必须有对应用例。
- **`src/plugins/` 是内置插件**：`monopoly-game` / `library-ops` / `shell-ops`；与 `config/codem.base.yml` 的插件不是同一层（前者是前端功能包，后者是 Cordis 服务装配）。
