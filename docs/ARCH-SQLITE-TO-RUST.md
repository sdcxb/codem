# 架构整改：SQLite 从渲染进程迁移到 Rust 原生实现（路径 ①）

> 决策：**不做中间路线**（不采用 sqlite-wasm + OPFS「治一半」方案）。目标是把
> 「整个语料活在渲染进程的 32 位 WASM 线性内存里 + 落盘必须整库序列化」这两个约束**同时拿掉**。
>
> 本文是执行计划（活文档）：每完成一个阶段就在对应处补「实际结果」，
> 每轮迭代遵循同一套流程：**实现 → 审计 → 修复 → 全量测试 + 真机 → 发布**。

---

## 0. 背景（为什么要做这件事）

用户现场反复出现 `RuntimeError: memory access out of bounds`（sql.js / Emscripten WASM 陷阱）。
第 90/91 波已把「崩溃后的诚实处理」与「索引可重建」做成了真的，但**崩溃本身只是被限幅**：

| 约束 | 内容 | 现状 |
|---|---|---|
| **(a) 载体** | 全部消息正文/附件/索引活在渲染进程的 WASM 堆里，无隔离；堆一中 Poison，之后每次调用都 trap | 未解决 |
| **(b) 持久化** | 落盘 = `db.export()` 整库（单次 O(库大小) 的 WASM 分配）+ base64（1.33×）+ 字符串过 IPC | 仅有限幅（256 MB 上限） |

① 同时消灭 (a)(b)：原生 64 位 sqlite3 跑在 Rust 进程里，WAL 页级增量落盘，没有 export。
更关键的是**错误形态的质变**：`SQLITE_NOMEM/BUSY` 是**可处理的值**（可重试、可降级、影响面可控），
而 WASM 陷阱是**不可恢复的进程级中毒**（现场表现：第一次报错之后所有 DB 调用都在报同一个错）。

---

## 1. 验收标准（Definition of Done）

1. 渲染进程**不再加载 sql.js / WASM**（依赖、wasm 资产、`new SQL.Database`、`db.export()` 全部消失）。
2. 渲染进程**不写 SQL**：所有访问经**类型化仓储命令**（`messages.create/update/list/…`）。
3. 持久化 = **WAL 页级增量**；**不存在**整库导出 / base64 / 整库文件落地路径。
4. 单写者 + 事务：所有批量写在一个事务内完成；跨 await 不会出现"事务被另一路写入插队"。
5. 安全边界：IPC 面**不接受裸 SQL**；Rust 侧 authorizer 禁止 `ATTACH`/`load_extension`/危险 `PRAGMA`；
   结果集**分页 + 行数/字节上限**。
6. 错误是值：结构化错误码（`BUSY|LOCKED|NOMEM|CORRUPT|IO|CONSTRAINT|OTHER` + `retryable`），
   渲染侧据此重试/降级/上报（复用第 87 波的统一失败通道）。
7. 契约测试：**同一套用例**驱动「参考实现」与「生产实现」；Rust 实现可被 vitest 直接驱动（见 §3.3）。
8. 数据迁移：一次性、可回滚、带备份与对账（`quick_check` + 表行数 + 内容摘要比对）。
9. 保留既有纪律：**JSONL 追加日志仍是权威存储**，索引可重建（第 91 波已完成），
   Rust 迁移不得削弱这条兜底（任何索引都可能丢）。
10. 大文档：单条消息正文可分页读写；正文/附件继续走文件外置，DB 只放索引与元数据；
    给出**规模压测数字**（N 万条消息 / GB 级附件索引下的内存与延迟）。

---

## 2. 关键架构决策（含理由）

### 2.1 仓储命令，而不是"通用 SQL over IPC"
- **决定**：Rust 侧暴露语义化命令（`messages_create`、`messages_list`、`events_append`、`settings_get_all`…），
  SQL 文本只存在于 Rust 里；渲染侧没有 SQL 字符串。
- **理由**：① 安全 —— `ATTACH DATABASE '/任意路径'` 就是任意文件读取原语，裸 SQL 透传等于开这个口子；
  ② 可测 —— 语义化命令才能写出跨实现的契约测试；③ 可演进 —— schema 变化不再泄漏到 30 个渲染文件。

### 2.2 同步 / 异步边界（最大的风险点，必须先定死）
现状：`getDatabase()` **114 处 / 30 个文件**，`db.exec/run/prepare` **163 处**，全部**同步**。
一刀切异步会撕裂时序假设（写后读、flush 后对账、React 渲染期读取）。因此按**数据形态**分三类：

| 类别 | 例子 | 形态 | 理由 |
|---|---|---|---|
| **数据面（大）** | messages / events / attachments / telemetry / graph | **异步**（`await`） | 体量大、必须分页；调用方（UI 加载、agentic loop、维护）本来就在 async 上下文 |
| **配置面（小）** | settings / quick phrases / 各类开关 | **同步读 + 写穿队列** | 表很小，启动一次性全量预热到内存（`Map`）；读永远同步；写先更新内存、再入队落库，失败如实上报。
这是**唯一**允许的内存镜像，且是配置不是语料 —— 不违反根因 (a) |
| **只追加写入** | 事件日志、遥测、追加日志 | **入队（fire-and-forget）+ 背压** | 不需要读回结果；由写队列保证顺序与合并；失败上报 + 计数 |

- **禁止**：为"保住同步读"而缓存消息正文语料 —— 那会把根因 (a) 请回来。

### 2.3 Rust 侧做成「库 + CLI + Tauri 薄层」
- `crates/codem-db`：**纯逻辑库**（连接管理、schema、迁移、所有仓储命令、authorizer、错误映射）。
- `codem-db-cli`：同一库的**命令行入口**（`--db <path> <command> --json`）。
- Tauri command：只做「参数解码 → 调库 → 结果编码」，**没有业务逻辑**。
- **理由（关键）**：vitest 跑在 Node 里，**无法直接调 Tauri IPC**。有了 CLI，契约测试可以
  **真的驱动生产实现**（`execFile` 调 CLI），而不是退化成"测试 WASM、生产 Rust"的双实现分歧
  （本仓库 **104 个测试文件**在用 sql.js，这个分歧风险真实存在）。同一 CLI 还可用于
  迁移对账与规模压测，离线可跑。

### 2.4 连接与并发模型
- **单写者**：一个写连接（Rust 侧 `Mutex<Connection>` 或专写线程 + 通道），读连接池可选。
- `PRAGMA journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`、
  `temp_store=MEMORY`、页大小与 `mmap_size` 按压测再定。
- **事务边界在 Rust**：渲染侧不再出现 `BEGIN/COMMIT`（现状 event-log 里有裸事务，异步化后必然交错）。

### 2.5 迁移与回滚
- 同一份 `codem-db.bin`（普通 SQLite 文件）由 Rust 打开；**迁移期绝对禁止 WASM 与 Rust 同时打开**。
- 切换开关（setting）可一键回退到 WASM 实现，直到稳定若干版本后再删除。
- FTS：现用 FTS4 虚拟表；Rust bundled SQLite 默认含 FTS5 → **迁移时重建为 FTS5**（并保留降级路径）。

### 2.6 保留的既有兜底（不得削弱）
- JSONL 追加日志 = 权威；**写入顺序权威优先**（第 91 波）；索引可从日志重建 + 崩溃标记自愈（第 91 波）。
- 三类审计门禁（A 静默空写 / B 假成功 / C 守卫绕过）+ **新增 D 类存储边界门禁**（见 §5）。

---

## 3. 阶段计划（每阶段独立可验证、可回滚、以发布或明确说明收尾）

### P0 盘点与端口定义
**产物**
- `tools/audit/storage-inventory.mjs`：扫描渲染侧全部 SQL 调用点，按「表 × 操作」归类成仓储方法清单；
- `docs/STORAGE-INVENTORY.md`（自动生成）：163 处调用 → N 个语义方法的映射表；
- `src/core/storage/port.ts`：`SqlitePort` 接口定义（三类形态，见 §2.2）+ 类型化的
  `StorageError`（错误码 + retryable）。
**验收**：清单覆盖 100% 调用点（脚本自检：未归类为 0）；接口编译通过；无行为变更。
**审计**：脚本复跑结果与人工抽查一致；接口里不得出现裸 SQL 字符串类型。

### P1 Rust 侧地基（`crates/codem-db` + CLI）
**产物**：连接管理/PRAGMA/WAL、schema + 迁移（含 FTS5）、authorizer（禁 ATTACH/危险 PRAGMA/扩展加载）、
错误映射（结构化错误码）、**全部仓储命令**、CLI（json 输出、退出码约定）。
**验收**：CLI 能独立完成「建库 → 迁移 → 增删改查 → 对账」；`quick_check` 通过；
authorizer 单测证明 `ATTACH` 被拒；错误码映射单测。
**审计**：D 类门禁（Rust 侧不得出现 `format!` 拼 SQL）；CLI 不得回显敏感参数（密钥/正文）。

### P2 契约测试与双实现并行
**产物**：`src/test/storage-contract/*.test.ts`（参数化：`impl=wasm|rust`，rust 走 CLI）+
共享用例集（正常/边界/错误/并发/分页/大 payload/事务回滚/FTS）。
**验收**：两实现全绿；**故意在 Rust 侧改坏一处** → 契约测试必须红（bite 验证）。
**审计**：契约覆盖率（方法级）100%；未覆盖方法列入显式 allowlist 并说明理由。

### P3 调用点逐模块切换
**顺序**（先写后读、先低风险后高风险）：
1. settings/config（同步缓存 + 写穿）
2. events / telemetry（入队）
3. messages / tool_calls / attachments（数据面）
4. sessions / projects / issues / squads / inbox / notebooks（其余域）
5. agentic loop 与 Agent/Team 链路
**每切一个模块**：该模块单测 + 契约测试 + 真机冒烟；D 类门禁把该模块的 WASM 调用加入"禁止清单"。
**验收**：渲染侧该模块零 `getDatabase()`；整库导出路径在该模块不可达。

### P4 数据迁移与切换（含对账）
**产物**：迁移工具（CLI 子命令）：备份 → `quick_check` → 表行数 + 每会话消息摘要比对 →
标记迁移完成（写入 settings + 文件标记）；失败自动回滚到 WASM 实现并上报。
**验收**：真机在**真实大数据集**上迁移成功且对账一致（行数、逐会话摘要、FTS 命中对比）；
迁移后再重启仍走 Rust；回滚开关有效。
**审计**：对账工具本身要能被"故意制造的差异"触发失败（bite）。

### P5 收尾：删除 WASM DB 路径
**产物**：移除 sql.js 依赖与 wasm 资产、删除渲染侧 schema/迁移代码、删除回滚开关（或降级为只读诊断）。
**验收**：`grep -r "sql.js\|sql-wasm\|db.export()"` 在渲染侧为 0（allowlist 例外仅测试夹具）；
包体减小数字；启动时间与内存占用对比数据。

### P6 大文档与规模专项（与 P1–P5 并行推进）
- 单条消息正文**分页**读写；正文/附件外置强化（已有 spill/附件外置机制）；
- 压测：1 万 / 10 万条消息、单条 1 MB 正文、GB 级附件索引 → 内存峰值、写入延迟、启动时间；
- 给出"能力上限"文档：多大的文档/多少条消息下，什么操作会退化为分页/后台任务。

---

## 4. 每轮迭代的标准流程（"边执行边审计，边修复"）

1. **实现**：只做一个阶段的**一个可验证切片**（宁可小）。
2. **审计**：A/B/C/D 四类门禁 + 本阶段的专项审计（见各阶段"审计"）。
3. **修复**：门禁/契约/真机发现的任何问题，**先补会红的用例**再改代码。
4. **全量验证**：`npm run audit`、`npx tsc --noEmit`、`npx vitest run`、
   UI 审计（27 规则 0/0）、css-contract 无变化、`tsc` 0 错。
5. **真机验证**（打包版本）：`tauri build` → 启动 → 关键路径实测 → 数据库与探针还原。
6. **发布**：版本号 + CHANGELOG + PROJECT-GUIDE 行 + `latest.json` + `gh release` + 发布后验证签名/URL。

---

## 5. 门禁（机器约束，防止回退）

| 类别 | 门禁 | 现状 |
|---|---|---|
| A 静默空写 | `tools/audit/scan-silent-write.mjs` | 已上线（0 违规） |
| B 假成功 | `tools/audit/scan-false-success.mjs` | 已上线（0 违规） |
| C 守卫被绕过 | `tools/audit/scan-guard-bypass.mjs` | 已上线（0 违规） |
| **D 存储边界** | `tools/audit/scan-storage-boundary.mjs` | **本轮新增（报告模式 → 逐阶段收紧）** |

D 类规则的最终形态（分阶段收紧，未豁免即失败）：
1. 渲染侧不得 `import "sql.js"` / 引用 `sql-wasm`；
2. 渲染侧不得出现 `db.export()` / `new SQL.Database` / `getDatabase()`（P3 完成后）；
3. 渲染侧不得出现裸 SQL 字符串（`SELECT|INSERT|UPDATE|DELETE` 字面量，测试夹具豁免）；
4. 渲染侧不得出现 `BEGIN TRANSACTION`/`COMMIT`（事务归 Rust）；
5. 仓储命令必须经 `SqlitePort`，不得绕过。

---

## 6. 风险登记表（含缓解与回滚触发条件）

| # | 风险 | 缓解 | 回滚触发 |
|---|---|---|---|
| R1 | 同步→异步撕裂（114/163 处调用） | §2.2 三类形态；写后读改为"写队列 + 事件镜像"；禁语料缓存 | 任一模块切换后真机出现时序性 bug 且无法在当轮修复 |
| R2 | 测试与生产双实现分歧（104 个测试文件） | §2.3 Rust 库 + CLI，契约测试直接驱动生产实现 | 契约测试无法覆盖某方法 → 该方法不得切换 |
| R3 | 迁移期双写导致损坏 | 单写者硬切换 + 备份 + 开关回滚；禁两实现同开一库 | 对账不一致 → 自动回滚 |
| R4 | IPC 变成任意 SQL/文件读写 | §2.1 类型化仓储 + §2.4 authorizer | 出现绕过端口的裸 SQL → 门禁拦下 |
| R5 | 大结果集压爆 IPC/Rust 内存 | 分页 + 行/字节上限 + 流式 | 单命令超过上限 → 必须分页才允许合并 |
| R6 | IPC 往返导致大会话卡顿 | 批量命令下沉 Rust（单事务）| 延迟超过阈值 → 合并命令 |
| R7 | 恢复语义变化（WAL/checkpoint/新错误） | 结构化错误码 + 保留 JSONL 权威与重建 | 出现无法归类的存储错误 → 暂停切换并取日志 |
| R8 | 构建/平台（bundled C 编译、浏览器预览） | crate 版本 pin + CI 校验；dev 预览走 WASM 但**明确标注为"仅预览，非生产路径"** | 打包失败/体积异常 → 回退 WASM 版本发布 |
| R9 | 可观测性下降 | Rust 侧埋点（慢查询/锁等待/checkpoint/错误码分布）写 `codem-runtime-*.log` | 无法定位存储问题 → 先补埋点再继续 |
| R10 | FTS4→FTS5 差异 | 迁移时重建 FTS，保留降级（无 FTS 时搜索退化为 LIKE） | 搜索命中率下降 → 暂缓切换搜索路径 |

---

## 7. 当前状态

- 第 90 波：致命错误识别 + 闩锁 + 抢救 + 止血（**已完成**，v1.16.42）
- 第 91 波：权威日志优先写入 + 索引自愈重建 + 存储压力上界（**已完成**，v1.16.43）
- 第 92 波 P0：盘点工具 + 端口定义 + D 类门禁（**已完成**；盘点数字后被修正 **+43%**，见下）
- 第 92 波 P1：Rust 存储引擎 + CLI + 安全边界 + 错误映射 + 契约测试 + 覆盖率门禁 + 规模基准
  （**已完成**，Rust 27 项 + 契约 26 项 + 覆盖率 6 项全绿）
- 第 92 波 P3 第 1 段：Tauri 命令层 + Rust 端口 + 启动引导/回滚开关 + **跨语言线协议契约**
  （**已完成**，端口契约 25 项 + 引导 11 项 + 线协议 2+6 项全绿；迁移期默认仍是 WASM，零行为变更）
- 后续：P3 第 2 段（把调用点切到端口，需先做 settings 数据搬迁）→ P4（迁移与对账）→
  P5（删除 WASM 路径）→ P6（大文档专项）

## 8. 实际结果（按阶段追加）

### P0（第 92 波）—— 已完成，**但盘点数字后来被证实低估 43%**

**盘点（自动生成，可复跑）**

| 指标 | P0 当时报告 | **P1 修正后（真值）** |
|---|---:|---:|
| 扫描生产文件 | 831 | **836** |
| SQL 调用点 | 159 | **277** |
| 涉及表 | 38 | 38 |
| 需要实现的仓储方法 | 82 | **129** |

**为什么错**：盘点正则写作 `db\.(exec|run|prepare)\(['"]`（要求引号**紧跟**括号），
而本项目源码是 CRLF 且普遍写成

```ts
db.run(
  "INSERT INTO messages …",
```

于是**所有 INSERT（也就是写路径）都被漏掉了**。发现的路径不是"再看一眼代码"，
而是 P2 的覆盖率门禁要求"两个扫描器的方法集合必须一致"——
覆盖率工具修正正则后，两者立刻对不上，门禁把这件事顶了出来。

**留痕与防线**：
- 两个扫描器的正则已统一为 `[\s\S]{0,40}?['"…]`（允许换行/缩进），文件集合口径统一为
  "排除 `*.test.ts(x)`"（不再排除整个 `test` 目录）；
- `GATE-DB-1`（两个扫描器必须一致）、`GATE-DB-5`（`messages/sessions/settings` 的 **insert**
  必须出现在盘点里）已进 `npx vitest run`。GATE-DB-5 直接钉住"曾经被漏掉的那一类"：
  正则若退回旧写法，测试立刻变红。

**教训（值得记住）**：**用工具估算工作量之前，先验证工具能看见你已知存在的东西**。
"扫到 0 个写路径"本该是明显的警报（一个数据库应用不可能没有 INSERT），
但当时没有人拿已知事实去对照数字。

**端口定义**：新增 `src/core/storage/port.ts` —— `StorageError`（结构化错误码 + `retryable`）、
`PageRequest/Page<T>`、`StorageEnginePort`（open/close/health/integrityCheck/checkpoint）、
`StorageDataPort`（异步分页 `query/write/execute`，**不接受 SQL 字符串**）、
`StorageConfigPort`（同步读 + 写穿队列）、`StorageAppendPort`（入队 + 背压）、聚合 `StoragePort` 与注册表。
尚未被任何调用点使用（P3 逐步接管），因此 P0/P1 都**无行为变更**。

**D 类门禁上线（迁移期基线）**：新增 `tools/audit/scan-storage-boundary.mjs` 五条规则
（D1 sql.js 依赖 / D2 整库导出 / D3 裸 SQL / D4 渲染侧事务 / D5 绕过端口的 `getDatabase()`），
基线 **532 条命中全部落在 30 个待迁移文件的允许清单里**（每条写明理由与目标阶段），
`npm run audit` 已纳入（四类门禁全绿）。允许清单由 `tools/audit/gen-storage-baseline.mjs` 生成，
**每迁移完一个模块就删掉对应文件条目**（删不掉 = 迁移没做完）。

**门禁自检（bite）**：`GATE-7` 用一段故意写坏的样本（`import "sql.js"` + 裸 SELECT + BEGIN + `db.export()`
+ `getDatabase()`）验证五条规则**都会报警**；`GATE-6` 保证基线以内零未豁免。

**调优留痕**：D3 第一版用了 `["'`]\s*(?:SELECT|…)`，结果 `className={"selected"}` 这类字符串被误报
**532 条中绝大多数是噪声**；改为要求"关键字后必须跟空白/后续子句"（`SELECT\s+…\sFROM`、`UPDATE x SET` 等）
后噪声清零。

### P1（第 92 波，本轮）—— 存储引擎落地为 Rust crate（已完成）

**产物**

| 组件 | 说明 |
|---|---|
| `src-tauri/codem-db/` | 独立 crate（lib `codem_db` + bin `codem-db-cli`），不依赖 Tauri |
| `engine.rs` | `Engine::open`（PRAGMA: WAL + synchronous=NORMAL + busy_timeout=5000 + foreign_keys=ON）· `with_conn` / `write_tx`（单写者）· `health` / `integrity_check` / `checkpoint` / `table_counts` |
| `authorizer.rs` | 安全边界：拒 `ATTACH`/`DETACH`/`load_extension`；引擎级 PRAGMA 只读不写；`writable_schema` 读写皆拒 |
| `error.rs` | `ErrorCode`（与渲染侧 `StorageErrorCode` 一一对应）+ `retryable` + 由 sqlite 扩展码映射 |
| `schema.rs` | `include_str!` 引用脚本生成的 `sql/schema.sql`(17,053 B) / `migrations.json`(23 条) / `fts.json`；幂等应用 + 全局项目种行 |
| `repo.rs` | 第一切片 22 个命令：settings 3 · events/telemetry 3 · messages 8 · sessions/projects 4 · counts/health/integrity/checkpoint 4 |
| `src/bin/codem-db-cli.rs` | 契约测试驱动入口（`init/health/integrity/counts/invoke/batch/commands/checkpoint`，stdout 单行自描述 JSON，退出码 0/1） |

**验证（数字口径）**

| 项 | 结果 |
|---|---|
| `cargo test`（Rust 单元 + 集成） | **27 passed / 0 failed**（含 ATTACH/load_extension 拒绝、错误码映射、分页不重不漏、批次原子性 23 项 + authorizer 4 项） |
| `vitest src/test/db-contract.test.ts`（CLI 驱动生产实现） | **26 passed / 0 failed** |
| 真实 11,137,024 B 生产库副本 | `init` 幂等（45 表 / 23 条迁移全部命中"列已存在"）· `fts_module=fts4`（老库不动）· `quick_check=ok` · 计划外文件 0 |
| 真实库数据读数 | sessions 3 · messages 821 · tool_calls 883 · session_events 2197 · settings 24 · telemetry 19 · notebooks 1 |

**四条"踩过才知道"的实测结论（都已写进代码注释与测试）**

1. **authorizer 不能把内部探针 PRAGMA 一起拒掉**。`PRAGMA data_version` 是 SQLite 在
   `sqlite3_prepare` 期间自己会读的；拒掉它导致**所有语句准备失败**，且报错完全指不到原因：
   新建库时表现为 `vtable constructor failed: session_fts`（虚拟表构造期间的 prepare 被拒）。
   现在 `data_version` / `integrity_check` / `quick_check` / `page_count` 等只读探针一律放行，
   `writable_schema` 读写皆拒，引擎级 PRAGMA 读放行、写拒绝。
2. **健康检查必须只读**。原实现用 `PRAGMA wal_checkpoint(PASSIVE)` 取 WAL 帧数，那是个**写操作**；
   改为读 WAL 文件大小（`<db>-wal` 的 fs metadata）。
3. **CLI 响应必须自描述**。成功分支漏 `ok` 字段时，调用方只能猜字段名判断"结果还是错误体"
   （契约测试当场抓到，`commands`/`counts` 等分支曾漏）。
4. **参数取值必须严格**。渲染侧历史写法 `String(x ?? "")` 会把数字静默变字符串；
   存储边界上改为"类型不对就报错"，并把 `UPDATE` 影响 0 行升级为 `NOT_FOUND`（A 类防线）。

**同时修掉的工具链缺陷**

- `tools/bench/db-scale.mjs` 原在模块顶层写 `process.exit(1)`：审计扫描器一旦 import 它
  （扫描会遍历 `tools/`）就会**杀掉 vitest worker**，表现为"无关测试随机失败"。
  现已改为 `isMain` 守卫（库文件在顶层不得有 exit/写盘/长任务副作用）。
- CLI 增加 `-`（从 stdin 读 JSON）与 BOM 剥离：PowerShell 会把参数里的 `"` 转义成 `\"`、
  管道还会带 UTF-8 BOM，两种都会让参数解析莫名失败。
- `TempDb` 增加进程退出兜底清理：测试失败/超时时 `afterAll` 不执行，
  真实库副本（11 MB 起）会在 `%TEMP%` 堆积。

**语义变更（迁移时必须跟的）**：`messages.list` 现在**要求显式 `include_hidden`** ——
索引层不替调用方猜可见性（默认隐藏或默认包含都是错的：前者丢数据、后者把压缩内容喂给 LLM）。
渲染侧的上下文裁剪是业务决策，必须显式表达。

**覆盖率门禁（P2 的一部分提前落地）**

`tools/audit/storage-coverage.mjs` 把"还差多少"变成数字：**277 个调用点 / 129 个方法**，
当前已实现 **14 个方法（10.85%）**、覆盖 **19.49% 的调用点**。
`GATE-DB-1..6` 已进 `npx vitest run`：扫描器一致性、覆盖率下限、映射表命令必须真实存在、
盘点规模防退化（"扫到 0 个"这种静默失效）、**写路径必须被盘点覆盖**、已实现集合必须在 Rust 侧注册。
报告落在 `docs/STORAGE-COVERAGE.md`（`node tools/audit/storage-coverage.mjs --md` 重新生成）。

**规模基准**：`tools/bench/db-scale.mjs`（`npm run bench:db`）在 **1k / 10k / 100k** 三档、
用同一份数据形状同时压 Rust 引擎与 sql.js(WASM)，报告落到 `docs/DB-SCALE-BENCH.json`。
关键结论见下节。

**未做（下一轮 P3）**：把 129 个方法按模块逐个切到 Rust（配置面 → 只追加 → 数据面 → 会话/项目 → 其余域），
每切一个模块就删掉 D 类允许清单里的对应条目。

### P3 第 1 段（第 92 波）—— 把 Rust 引擎接进应用（已完成）

P1 的引擎**在应用里根本调不到**（没有 Tauri 命令层）。这一段补齐"渲染进程真的能用它"的全部环节。

| 新增组件 | 作用 |
|---|---|
| `src-tauri/src/storage.rs` | Tauri 命令层：`storage_invoke` / `storage_batch` / `storage_health` / `storage_integrity_check` / `storage_checkpoint` / `storage_capabilities` / `storage_info`；**只做参数解析→dispatch→序列化**，无 SQL、无业务逻辑 |
| `src-tauri/Cargo.toml` | 新增 `codem-db = { path = "codem-db" }`（crate 从"孤立可编译"变成"真被应用使用"） |
| `src/core/storage/rust-port.ts` | 实现 `StoragePort` 的渲染侧适配：引擎/数据/配置/追加四个面全部走 IPC；`StorageTransport` 可注入（测试无需 Tauri 运行时） |
| `src/core/storage/bootstrap.ts` | 启动注册 + **回滚开关** + 失败上报 |
| `src/App.tsx` | 在 `initDatabase()` 之后注册端口（`await` 是必要的：配置面同步读依赖启动预热） |

**库文件位置**：`%APPDATA%\com.codem.app\codem-db-rust.bin`。
与 WASM 侧 `codem-db.bin` **刻意分开** —— 迁移期两个引擎可并存对照、互不锁文件；
数据搬迁由 P4 的迁移/对账工具负责，而不是"两个引擎抢同一个文件"。

**回滚开关刻意放在 localStorage**（`codem-storage-engine` = `rust|wasm`）：

> 如果开关存在数据库里，那么"数据库读不出来"时你就无法回退 —— 而那恰好是最需要回退的时刻。
> **存储层的开关必须住在存储层之外。**

迁移期 `DEFAULT_ENGINE = "wasm"`，因此本段**零用户可见行为变更**。

**这一段暴露并修掉的真缺陷（契约测试抓到，不是"顺手改改"）**

1. **IPC 通道失败没被包成 `StorageError`**。Rust 返回 `{ok:false,error}` 时端口会转，
   但**桥断了/命令名写错导致 Tauri 直接 reject** 时，调用方 `catch (e) => e.code` 拿到
   `undefined` ——"错误是值"在渲染侧断了一截。现在所有单命令调用统一走 `call()` 包装（PORT-5 钉住）。
2. **配置面 `flush()` 会在写失败之前就返回**。原实现用"计数 + sleep 轮询"判断排空，
   而 `catch` 是微任务，`flush()` 早就返回了 —— 退出前的收尾会漏掉失败上报
   （PORT-16 抓到：失败计数还是 0）。改为直接持有 Promise 并 `allSettled`。
3. **追加面的背压上限永远达不到**。drain 先把一批从队列摘走再等 IPC，只看 `queue.length`
   的话"在途条数"没有上界；现在 `backlog() = 队列 + 在途`（PORT-19 钉住）。

**验证**

| 项 | 结果 |
|---|---|
| `cargo test`（codem-db） | 29 项全绿（27 + 线协议 2） |
| `cargo test`（Tauri 侧 `storage::tests`） | 4 项全绿（错误载荷、可重试标记、响应自描述） |
| 端口契约 `src/test/rust-port.test.ts` | **25 项**全绿（错误映射/分页/批量/配置/背压/命令白名单/不缓存语料） |
| 引导契约 `src/test/storage-bootstrap.test.ts` | **11 项**全绿（开关优先级、脏值兜底、localStorage 抛异常、失败不注册半死端口、幂等） |
| **跨语言线协议** | Rust `wire_contract.rs` 生成并断言金样本（`tests/wire-fixtures.json`）；TS `rust-port-wire.test.ts` 用**同一份样本**断言解包 —— 字段名漂移会让两边同时红 |
| 真实生产路径 | `engine_works_at_production_path_shape` 在 `%APPDATA%\com.codem.app\` 下真开库、写、读、checkpoint、quick_check（用独立文件名，不碰真实数据） |

**未做（下一轮）**：把调用点真正切到端口（settings 同步读需要一次性的数据搬迁，属 P4）；
以及 `quick_phrases` 的"使用次数 +1"语义在 Rust 侧尚无对应命令（`settings_set` 是覆盖语义）。

#### P3 第 1 段真机验证（打包前的实机证据）

用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动应用，经 CDP 在**真实渲染进程**里调用 Tauri 命令：

| 检查项 | 结果 |
|---|---|
| `storage_capabilities` | 22 个命令全部可见，`no_whole_file_export: true` |
| `storage_health` | `journal_mode=wal` · `tables=45` · `fts_module=fts5` · `ready=true` · 文件落在 `%APPDATA%\com.codem.app\codem-db-rust.bin` |
| 写入 → 读回 | `settings.set` → `written:1`，`settings.get_all` 读回 `realmachine-probe: ok` |
| **SQL 被拒** | `sql.raw {sql:"SELECT 1"}` → `UNSUPPORTED`（且 `retryable:false`） |
| A 类防线 | `messages.update` 命中 0 行 → `NOT_FOUND`（而不是"成功"） |
| `storage_integrity_check` | `ok:true, detail:"ok"` |
| `storage_batch` | 2 步全部成功，逐步回报 |
| 启动引导 | `localStorage[codem-storage-engine]=rust` → 刷新后端口已注册（`kind:"rust"`）+ 启动日志 |
| **回滚开关** | `=wasm` → 未注册端口；删除键 → 未注册（默认 wasm）——三种状态都实测过 |
| 真实 WASM 库未被破坏 | 全程只读校验：`quick_check=ok`、821 条消息 / 883 次工具调用 / 2197 条事件原样 |

真机验证本身**又抓到一个缺陷**：端口重复注册时返回的健康快照不完整，
启动日志会打印 `[Storage] Rust 引擎已就绪：undefined（undefined 表 / undefined）`
（StrictMode 双启动时必现）。已改为 `{opened:false}` 且不给 health 快照，日志只在真正打开时打印。

> 说明：应用在这轮验证中被正常启动了 3 次（为了测回滚开关），因此用户自己的
> WASM 库发生了**正常运行时写入**（文件大小不变、大小写与结构一致、`quick_check` 通过）。
> 这是每次正常启动都会发生的事，不是探针污染。

### P1 规模基准（Rust 引擎 vs sql.js/WASM，1k / 10k / 100k）

**读数（`docs/DB-SCALE-BENCH.json`，同一台机器、同一份数据形状；写入批次 1000 条/批）**

| 规模 | 实现 | 批量写入 | 单条写入（200 次） | 分页读全量（100 条/页） | 改写 1 万条 | 落盘字节 |
|---|---|---|---:|---:|---:|---:|---:|
| 1k | rust | 61 ms（0.061 ms/条） | 26.3 ms/次 | 411 ms（34.3 ms/页） | 51 ms | 2,711,552 |
| 1k | wasm | 106 ms（0.106 ms/条） | 0.46 ms/次 | 68 ms（5.7 ms/页） | 11 ms | 2,101,248 |
| 10k | rust | 618 ms（0.062 ms/条） | 27.2 ms/次 | 8,585 ms（84.2 ms/页） | 495 ms | 21,635,072 |
| 10k | wasm | 704 ms（0.070 ms/条） | 2.70 ms/次 | 5,544 ms（54.4 ms/页） | 102 ms | 20,803,584 |
| 100k | rust | 4,633 ms（0.046 ms/条） | 26.4 ms/次 | 149,400 ms（149.1 ms/页） | 395 ms | 60,469,248 |
| 100k | wasm | 6,105 ms（0.061 ms/条） | 7.34 ms/次 | 94,570 ms（94.4 ms/页） | 75 ms | 57,389,056 |

固定开销实测：**纯进程启动 15~16 ms，一次 invoke（启动 + 打开库 + 一次只读查询）21~22 ms**。

**怎么读这些数字（口径说明，避免误读）**

- rust 每次 `invoke` 都是**一次进程启动 + 打开库**（≈21 ms/次）——
  这是**未来 IPC 边界的成本形态**；wasm 是同进程调用，没有这笔固定开销。
  所以不能直接比总墙钟时间，必须把固定开销分离出来：
  - 100k 档分页读全量 1000 页 = 149.4 s，其中约 **22 s 是 1000 次进程启动**，
    剩下 **127 ms/页** 是真实查询成本；WASM 是 **94 ms/页**（同进程、零调用开销）。
  - 1k 档扣掉启动后 rust **13.25 ms/页**（含首次打开库摊销），wasm 5.7 ms/页 —— 小库上 WASM 更快，
    因为整个库就在内存里、且无需跨边界。
- **批量写入两边同量级**（100k：0.046 vs 0.061 ms/条），因为两边都用了单事务批量，
  这也说明"批量写入正确姿势"本身比换引擎更影响性能。
- **单条写入才是放大效应的量化形态**：rust 稳定在 **26 ms/次（几乎全是固定开销，不随语料增长）**；
  wasm 从 0.46 ms（1k）→ 2.70 ms（10k）→ **7.34 ms（100k）**，因为它每次都要 `db.export()` 整库序列化。
  **单条写入成本随整个语料线性增长** —— 这就是"内存访问越界"的根因在性能上的样子。
- **落盘放大**：wasm 每次持久化都要序列化整库（100k 档 57.4 MB/次）；rust 是 WAL 页级增量
  （文件 60.5 MB ≈ 真实数据量，且 `wal_size_bytes` 可观测）。
- **批量改写 1 万条：wasm 更快**（75 ms vs 395 ms，后者含 10 次 invoke 开销）。如实记录：
  同进程做 1 万次 UPDATE 确实省，代价是**渲染进程内存里持有整个库**（这正是要被移除的东西）。

**结论（对"大文档批处理能力"的意义）**

1. 迁到 Rust 解决的是**随语料增长的成本放大**（单条写入 O(语料)、整库序列化、32 位堆上限），
   而不是"每个操作都更快"——小库上同进程反而更快，这一点必须如实说明；
2. **大文档能力的真正杠杆在 P6**：分页读写 + 附件外置 + 渲染进程不再持有语料；
3. 基准脚本本身是资产：任何存储相关改动都可复跑对照，不靠印象。

