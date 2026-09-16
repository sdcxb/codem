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
- 本轮（P0）：盘点工具 + 端口定义 + D 类门禁（报告模式）—— 见下方「实际结果」
- 后续：P1 → P6 逐阶段推进

## 8. 实际结果（按阶段追加）

### P0（第 92 波，本轮）—— 已完成

**盘点（自动生成，可复跑）**

| 指标 | 数字 |
|---|---|
| 扫描生产文件 | **835** |
| SQL 调用点（`db.exec/run/prepare` + `runGuarded`） | **159** |
| 涉及表 | **38** |
| 需要实现的仓储方法（表 × 操作） | **82** |
| 命中 D 类规则的文件（待迁移模块） | **30** |

明细见 `docs/STORAGE-INVENTORY.md`（`npm run audit:inventory-md` 重新生成）。
Top 方法：`messages.update`(13) / `accounts.select`(7) / `accounts.update`(6) / `messages.select`(6) /
`cost_records.select`(4) / `graph_nodes.update`(4) / `inbox.update`(4) / `telemetry_events.select`(4) …

**端口定义**：新增 `src/core/storage/port.ts` —— `StorageError`（结构化错误码 + `retryable`）、
`PageRequest/Page<T>`、`StorageEnginePort`（open/close/health/integrityCheck/checkpoint）、
`StorageDataPort`（异步分页 `query/write/execute`，**不接受 SQL 字符串**）、
`StorageConfigPort`（同步读 + 写穿队列）、`StorageAppendPort`（入队 + 背压）、聚合 `StoragePort` 与注册表。
尚未被任何调用点使用（P2/P3 逐步接管），因此**本轮无行为变更**。

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

**未做（下一轮）**：P1（Rust crate `codem-db` + CLI + 仓储命令 + authorizer + 错误映射）。

