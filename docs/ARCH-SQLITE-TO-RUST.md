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
- 第 92 波 P4：**数据迁移与对账**（迁移原语 + 孤儿处置 + 逐表摘要对账 + 咬合测试）
  （**已完成**，真机 39 表 / 3989 行全部对账一致）
- 第 92 波 P3 第 2 段：**配置面切到端口**（878 个调用点，签名不变；含首次切换的一次性搬迁）
  （**已完成**，真机验证 24 项配置导入 + 重启不重复导入）
- 第 92 波 P3 第 3 段：**配置面扩展域**（quick_phrases / mcp_servers / memory）
  （**已完成**，真机验证读写往返 + 重启保持；覆盖率 10.85% → 17.05%）
- 第 92 波 P3 第 4 段：**只追加面命令与镜像基础设施**（events.* 8 条命令 + RustEventMirror）
  （**已完成**；接线待下一步，原因见下：避免"读写分裂"的中间态）
- 第 92 波 P3 第 5 段：**事件镜像路由接线**（按会话/按加载状态分流 + 窗口期补写）
  （**已完成**，真机验证追加/占位修正/重启持久/清理全通过；覆盖率 18.6%）
- 第 92 波 P3 第 6 段：**数据面消息索引写分流**（`messages.upsert_index` 单事务复合写 +
  `tool_calls.replace/list`）
  （**已完成**；读路径与 attachments/feedback/FTS 留待下一段）
- 第 92 波 P3 第 7 段：**消息索引读路径**（会话级镜像；修掉上段"写切了读没切"的隐患）
  （**已完成**，MSG-7..10 全绿；覆盖率 18.6%）
- 第 92 波 P3 第 8 段：**attachments / message_feedback / session_fts**
  （**已完成**；并发现并修复"中文全文检索从未生效"：84.3% 索引行正文为空 + CJK 分词不可用；
  覆盖率 18.6% → 25.58%）
- 第 92 波 P3 第 9 段：**搜索链路打通**（中文检索修复送到用户路径 + 跨会话搜索 + 反馈写穿缓存）
  （**已完成**，工具层真机验证：`存储`→3 条跨两会话、`上下文压缩`→1 条）
- 第 92 波 P3 第 10 段：**通用仓储命令（表定义驱动）** —— 覆盖剩余 30 张表 / 87 个方法
  （**已完成**；命令可用性 100%，渲染侧调用点切换 25.58% —— 两个数字分开报，不虚报）
- 第 92 波 P3 第 11 段：**通用域镜像 + 账号域切换**（顺带删除死模块 `auth/storage.ts`：
  零引用、零独有导出，删后调用点 278→270 而迁移进度不丢）
  （**已完成**，覆盖率 25.58% → 28.68%）
- 第 92 波 P3 第 12 段：**域存储骨架抽取 + v2_sessions 切换 + 修两个门禁的误报**
  （**已完成**；B/C 两类扫描器把 `.catch(…)` 当成 catch 子句而误判，已加前字符判据修复；
  覆盖率 28.68% → 31.78%）
- 后续：P3 第 13 段（其余 11 个域模块接入：图谱/笔记本/卡片/目标/团队/问题/收件箱…）
  → P5（删除 WASM 路径）→ P6（大文档专项）
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

#### P3 第 1 段真机验证（实机证据）

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

### P3 第 2 段（第 92 波）—— 配置面切到端口（已完成，真机验证通过）

这是**第一次把真实调用点切到 Rust 引擎**：`settings` 一族函数（`getSetting` / `setSetting` /
`getSettingJSON` / `setSettingJSON` / `removeSetting`）共 **878 个调用点**。

**为什么签名一个都不能改**：`getSetting` 有近 500 个调用点，遍布同步上下文
（React 渲染、模块初始化、快捷键、主题引导）。改成 `Promise` 会波及整条启动链，
风险远大于收益。所以端口里的"配置面"就是**唯一允许同步读**的形态：
启动时一次性预热到内存（`settings` 表实测 24 行），之后读永远同步。
这正是 P0 §2.2 三条形态设计里早就定下的一点 —— 现在兑现了它。

**分流（迁移期的关键）**：

```
端口已注册且 kind === "rust"  → 读走内存缓存（同步）；写 = 内存即时生效 + 写穿队列
否则（默认 / 回滚开关设为 wasm）→ 完全维持原 WASM 行为，一个字节都不变
```

**首次切换必须把配置搬过来**（`importSettingsFromLegacyDb`）：否则用户所有偏好
（主题/字号/语言/显示模式）会"看起来全部重置" —— 用户不会认为这是迁移，只会认为升级弄丢了设置。

触发条件严格到不会误触发：① 端口是 rust 且**已预热**；② Rust 库**一个设置都没有**；
③ 旧库可读且确有内容。搬完写标记键，保证**只搬一次**。

> **"只搬一次"是这里最要紧的性质**：如果每次启动都搬，那么用户清空/修改设置后重启
> 会被旧库的值覆盖回来 —— 表现为"改了的设置自己变回去"，极难排查。已用测试钉住
> （IMP-2：非首次连旧库都不读）。

**真机验证（真实渲染进程 + CDP）**

| 检查项 | 结果 |
|---|---|
| 首次切换 | 日志 `[Storage] 已从旧库导入 24 项配置到 Rust 库（仅此一次）` |
| 读回配置 | `codem-theme=light` · `codem-language=zh` · 标记键存在 ✓ |
| 写入 | `setSetting` 后立即可读（内存镜像生效） |
| **重启不重复导入** | 第二次启动日志只有"引擎已就绪"，**无导入字样**；数据仍在 |
| 回滚开关 | 三态（rust / wasm / 删除键）此前已实测 |

**门禁当场拦下一处违规（值得记）**：把 `importSettingsFromLegacyDb` 写成直接读旧库
（`getDatabase()` + 裸 SQL）后，**D 类存储边界门禁立刻报 2 处未豁免**。
这是门禁按设计工作 —— 但更重要的是它暴露了一个设计问题：

- **不能走端口**：端口的 rust 实现只认 Rust 库，读不了旧库；
- **不能为它加 Tauri 命令**：加一条"任意路径读库"的命令会把安全面**永久**扩大，
  而这个功能只用一次，代价大于收益；
- **不能只靠迁移工具**：用户装的是打包版，不会去跑 CLI ——
  迁移必须由应用自己完成，否则用户看到的就是"设置全丢"。

所以登记为**过渡例外**（允许清单里写明删除条件：P5 删除 WASM 路径后连同代码一起删）。
它被分类、被记录、有删除条件 —— 与"绕过端口写业务 SQL"是两回事。

**验证**：配置面切换契约 7 项 + 首次导入契约 6 项全绿；完整套件见下。

### P3 第 3 段（第 92 波）—— 配置面扩展域（已完成，真机验证通过）

把 `quick_phrases` / `mcp_servers` / `memory` 三个域切到端口。

**为什么它们和 `settings` 同属配置面**：判据是**量级**而不是名字 ——
实测生产库 `settings` 24 行、`quick_phrases` 0 行、`mcp_servers` 0 行、`memory` 1 行，
小到可以整表进内存镜像。于是同步读成立，`loadQuickPhrases()` / `loadMcpServers()` /
`loadMemory()` 这些同步函数**不需要改签名**就能切 —— 878 个调用点的迁移经验直接复用。

> **边界（重要）**：`cost_records`（可能上万行）与 `recovery_data`（每会话一份快照）
> **不进这个镜像**。把大表塞进内存就等于把"语料住在渲染进程"这个根因请回来
> （port.ts 硬约束 4）。它们走数据面的分页读，留待 P3 第 4 段。

**Rust 侧新增命令**（`config.rs`）：`quick_phrases.{list,save,delete,touch}` ·
`mcp_servers.{list,save,remove}` · `memory.{get,set}` · `config_warmup`（一次 IPC 拉齐三个域）。

**契约测试当场抓到一个真 bug**：我把内存镜像的写侧用 camelCase（`usageCount`）、
读侧按线协议 snake_case（`usage_count`）解析，结果"存完立刻读"拿到 0
（CFG-2/3/4 全红）。统一到线协议形状后修复 —— 这正是"镜像读写两侧必须同形状"这类
看似琐碎、实则必然出错的点的价值。

**真机验证（真实渲染进程 + CDP）**

| 检查项 | 结果 |
|---|---|
| 初始（生产库三表为空） | `phrases:0 servers:0 memory:""` |
| 快捷短语写入后 | `count:1 usageAfterSave:1 usageAfterTouch:2 title:"探针短语"` |
| memory | 写入后读回 `"探针记忆内容"` |
| mcp_servers | `count:1 enabled:true typeof:"boolean"` |
| **重启后仍在** | `phraseUsage:2 memory:"探针记忆内容" mcp:true` —— 证明真的落库 |
| 清理 | 三表回到空；**异常日志 0 条** |

**真机验证抓到的第二个问题（值得记）**：第一次跑时全部命令报
"未实现的仓储命令：config_warmup" —— 因为**只重新构建了 crate，没有重建 Tauri 二进制**，
应用里注册的还是旧命令表。这是"in-process 契约测试（假 transport）通过、真机失败"的
典型差距：假 transport 不会告诉你命令是否真的注册在应用里。

> 教训：**给 Rust 侧加命令后必须重建 Tauri 二进制再上真机**（`cargo build` from `src-tauri`）。
> 好消息是失败被如实上报了：每次失败都经统一通道留痕（"未实现的仓储命令…功能本次没有生效"），
> 功能降级（快捷短语空、记忆空串）而不是崩溃 —— 错误处置的设计在这里被验证了一遍。

**验证**：Rust 单测 13 项（新增配置域 5 项）· 配置域契约 12 项 · 完整套件 264 文件 / 5111 通过。
覆盖率从 **10.85% → 17.05%**（22/129 个方法，22.66% 的调用点）。

### P3 第 4 段（第 92 波）—— 只追加面：命令与镜像基础设施（已完成；**接线待下一步**）

只追加面（`session_events`）迁移路上有两个真实约束，这一段把它们查清并备好了基础设施。

**约束一：`PersistenceProvider` 接口全同步，而 IPC 是异步。**
解法是把"读"和"写"分开：
- **读**：事件日志整份放进内存镜像。这**不是**"把语料塞进渲染进程"的倒退 ——
  事件日志本来就是为**回放**而整份读取的（投影、压缩、重建索引都读全量），
  镜像没有增加新的内存负担，反而省掉反复查询。
- **写**：发件箱（outbox）。同步返回 + 异步落库；崩溃可能丢最后几条 ——
  可接受，因为会话 JSONL 才是权威副本，事件索引本就设计成"可重建"。

**约束二（真机/数据实测发现，之前判断错了）**：`session_events.seq` 是 **SQLite 全局
AUTOINCREMENT**，**不是**每会话从 1 开始。实测：两个会话的 seq 交替递增、最大 2197。
所以渲染侧**不能本地预分配 seq**（不知道全局水位会撞主键），必须由引擎分配并回传真实值。
`seq_is_global_autoincrement_not_per_session` 这条测试把它钉死了。

**Rust 侧新增命令**（`repo.rs`）：`events.append`（回传真实 seq）· `events.append_batch`
（单事务、seq 连续 —— 渲染侧靠连续性判断缺口）· `events.list`（分页 + `from_seq`/`to_seq`）
· `events.count` · `events.watermark`（全局/每会话水位）· `events.delete_session` ·
`events.compact`（**快照占用锚点自己的 seq**，锚点不存在则报错，`session_meta` 永不被删）·
`events.fork`。

**渲染侧基础设施**（`rust-port.ts`）：`RustEventMirror` —— 镜像 + 发件箱 +
占位 seq 回填（本地先给占位用于镜像内排序，写成功后用引擎回传的真实 seq 修正）。

**为什么这一段没有直接接线（刻意的）**：接线的必要条件是"镜像已预热"，
而预热需要启动时先枚举会话 —— 那一步尚未做。如果现在就让 `append` 走镜像、读仍走旧库，
会形成**读写分裂**：新事件进了镜像与 Rust 库，但 `readAll` 从旧库读、看不到它们。
**那比不迁移更糟**。所以 `EventLog.appendViaMirror` 保留待用，`append` 仍是原路径，
并明确注明原因 —— 宁可少走一步，也不留一个"看起来迁移了、实际读不到"的中间态。

**验证**：Rust 事件命令 7 项测试全绿（全局 seq / 批次 seq 连续 / 批次原子性 /
分页与 from_seq / 水位 / 压缩锚点与 meta 保留 / fork）· tsc 0 错 · 六道 audit 门禁全绿 ·
覆盖率保持 **17.05%**（未接线故不虚报）。

### P3 第 5 段（第 92 波）—— 事件镜像路由接线（已完成，真机验证通过）

把上一段准备好的镜像/发件箱**真正接上**，只追加面（`session_events`）读写都走 Rust。

**路由规则（这是本段的核心，也是唯一要守住的性质）**：

```
某会话的事件**已完整加载进镜像**  → 该会话的读与写都走 Rust
否则（未加载 / 加载中）           → 该会话继续走旧路径
```

为什么要按会话、按加载状态分流：`EventLog` 的接口是同步的，而 Rust 是异步 IPC。
若某会话"写进镜像、读从旧库"，用户会看到**对话记录不再更新** —— 比不迁移更糟。
所以只要没加载完，读写一起留在旧路径；加载完，读写一起切到 Rust。

**加载窗口期不能丢事件**（契约测试 EV-5 抓到的真实子情形）：加载是后台进行的（几百毫秒），
那个窗口里 `isLoaded` 还是 false、append 走旧库，等切到镜像后这几条就只在旧库里了。
解法：窗口期的 append **记进 pendingDuringLoad**，加载完成后补写进 Rust 库（发件箱）并放进镜像 ——
两处最终一致，一条不丢。

**顺带补的命令**：`sessions.delete` / `projects.delete`（删除会话/项目；**拒绝删除全局项目**
`projects.id=''`，它是全局会话的外键目标）。

**真机验证（真实渲染进程 + CDP，自建会话避免依赖未迁移的数据）**

| 检查项 | 结果 |
|---|---|
| 镜像加载 | `warmupEvents` 后 `isLoaded:true`，`stats.sessions:1` |
| 追加 2 条 + 批量 2 条 | 立刻可读（`count:4`）、`probe` 顺序 1,2,3,4 正确 |
| 占位 seq 修正 | 4 条全部从占位（9.0e15）修正为真实 seq **1,2,3,4** |
| Rust 库核对 | `countInDb:12`（三次运行的累计）、seq 连续、`events.watermark` 正确 |
| **重启后** | 镜像重新加载出 12 条，类型与顺序完全一致 |
| 清理 | `deleteAllForSession` 后库内事件数 0；探针会话/项目行已删除 |
| 异常日志 | **0 条** |

**又踩了一次同一个坑，这次加了机器守卫**：真机第一次跑时全部命令报"未实现的仓储命令：
events.list" —— 又是**只重建了 crate、没重建 Tauri 二进制**。
这是同一个坑的第二次（上段是 `config_warmup`），说明"靠记性"不行，于是：
- 新增 `src/test/storage-command-parity.test.ts`（DEPLOY-1..6）：核对
  `COMMANDS` 声明 ↔ `dispatch` 分支 ↔ Tauri `invoke_handler` 注册 ↔ `storage_invoke` 转发；
- 在 `storage.rs` 顶部写明这条流程纪律（新增命令后必须 `cargo build` from `src-tauri`）。
其中"二进制是否最新"无法用源码测试判断，只能靠流程纪律 + 真机验证兜底。

**覆盖率**：17.05% → **18.6%**（`session_events` 的读/写路径计入）。

### P3 第 6 段（第 92 波）—— 数据面：消息索引写分流（已完成）

数据面（`messages` / `tool_calls` / `attachments`）与配置面**根本不同**：大表**不能**进内存镜像 ——
把 821 条（将来十万条）消息缓存进渲染进程，就等于把"语料住在渲染进程"这个根因请回来。
所以这一段按"写先切、读留后"推进。

**为什么写可以先切（关键判断）**：`createMessage` / `updateMessage` 的结构本来就是

```
① 权威日志（先写、必须成功） → ② 索引（尽力而为、失败上报、可由日志重建）
```

索引侧早已明确是 best-effort + 可重建。因此把 ② 换成"异步发往 Rust"**不引入新的丢数据风险**，
也不会产生 P3 第 4 段那种读写分裂（读的是索引，索引的权威版本在 Rust）。
顺序与优先级必须保持不变：**日志永远先写，索引失败不回滚日志**（MSG-1 / MSG-6 钉住）。

**Rust 侧新增复合写命令**（`repo.rs`）：

| 命令 | 为什么必须是一条命令 |
|---|---|
| `messages.upsert_index` | 渲染侧的索引写不是"一次简单 upsert"：主行 + `generated_files` / `retrieved_sources` 两个 JSON 列 + **整批替换 tool_calls**（先 DELETE 再逐条 INSERT）。拆成多条 IPC 会留下"消息更新了、工具调用只写了一半"的不一致状态，所以做成**单事务复合写** |
| `tool_calls.replace` | 单独替换某条消息的工具调用（渲染侧高频路径）；**目标消息不存在则 NOT_FOUND**，不允许写孤儿工具调用 |
| `tool_calls.list` | 索引读（按 id 稳定排序） |

`messages.upsert_index` 的语义细节（都有测试）：存在则更新、不存在则插入；
**没提 `tool_calls` 就"不动"**（不是清空 —— 空数组与缺省含义不同）；
没提 `generated_files` / `retrieved_sources` 时保留原值；参数错误整条命令不落任何行。

**顺带修掉一处自己引入的语法破坏**：早先为去掉多余空行做的字符串替换，把
`/// 文档注释` 与 `pub fn messages_update_many` 挤到了同一行 —— 于是 `fn` 变成注释的一部分，
函数体没有声明，Rust 报 `unexpected closing delimiter`。已修正。
（教训：**用文本替换编辑代码时要检查替换后的行结构**，不要只看"替换是否命中"。）

**验证**：Rust 复合写 5 项测试（整体替换 / 缺省不动 / JSON 列 / 孤儿拒绝 / 事务外校验）·
消息索引分流契约 6 项（顺序与优先级 / 参数形状 / 缺省语义 / 端口未注册 / wasm 回滚 / 失败不抛）·
`cargo test` 50 项 · tsc 0 错 · 六道 audit 门禁全绿。

**未做（下一轮）**：消息的**读**路径（`listMessages` 等同步接口需要与只追加面类似的分页/镜像策略），
以及 `attachments` / `message_feedback` / `session_fts` 的切换。

### P3 第 7 段（第 92 波）—— 数据面：消息索引读路径（已完成）

**这一段是修上一段留下的隐患。** 第 6 段把**索引写**切到了 Rust，但**读**仍在旧库，
而渲染侧有一条明确的教训（写在 `listMessagesMerged` 的注释里）：

> **索引里的 hidden 状态也是权威** —— 软删除行只在索引里（日志里没有墓碑）。

于是写进 Rust、读旧库就会：旧库那份 hidden 状态是旧的 → 合并时把**已压缩的消息加回来**
→ 上下文永不缩小 → 死循环。这正是用户现场"压缩了 840 条、上下文一点没小"的机制。
所以读必须跟着写一起切。

**做法：会话级消息索引镜像**（`RustMessageMirror`）。粒度是**单个会话**而不是整个库，
而且 `listMessagesMerged` 本来就会把一个会话的消息全部读进内存再渲染 ——
所以没有增加新的内存负担，只是把"每次查询读一遍"变成"读一次、之后同步读"。
语料级缓冲（整个库 / 附件正文 / 全文索引）仍然不进来。

**路由规则与只追加面一致**：只有该会话索引**已完整加载**，读写才都走 Rust；
否则一起留在旧路径。加载被上限截断时**也不路由**（集合不完整 → hidden 判定会错 → 可能复活消息）。
写入成功后立刻把行同步进镜像，保证"刚写的消息立刻可见"。

**契约测试抓到的真 bug**：镜像列表最初**漏了 hidden 过滤**（WASM 查询里有 `WHERE hidden = 0`）。
如果不修，已压缩的消息会重新出现在对话里 —— 与上面那条死循环是同一类后果。
MSG-8 专门钉住"hidden 行不进可见列表，且 hiddenMessageIds 必须来自镜像"。

**验证**：MSG-7（从镜像读且不碰旧库）· MSG-8（hidden 语义）·
MSG-9（未加载不路由）· MSG-10（写入后立刻可读）全部通过。

**未做（下一轮）**：`attachments` / `message_feedback` / `session_fts` 的切换。

### P3 第 8 段（第 92 波）—— attachments / message_feedback / session_fts（已完成）

**本段最重要的不是迁移，而是发现了一个长期存在的产品缺陷。**

**发现：中文全文检索从来没有生效过。** 实测生产库：

| 指标 | 数值 |
|---|---|
| `session_fts` 行数 | 837（与消息一一对应） |
| **content 为空的行** | **706（84.3%）** |
| content 长度 ≤2 的行 | 786（93.9%） |
| content 长度 min/max/avg | 0 / 413 / **5.2 字**（消息平均 86 字） |
| `MATCH '存储'` / `'迁移'` / `'索引'` | **0 行**（而库里确有含这些词的消息） |
| `MATCH 'ChatPanel'` | 17 行（英文正常） |

两个独立问题叠加：① 索引行建立了、**正文没进去**；② 即便正文进去了，
`tokenize=unicode61` 会把**一整串 CJK 当作一个 token**（"关于存储迁移的讨论"整句是一个词），
所以查"存储"永远匹配不到。对一个中文优先的产品来说，这就是"搜索功能不存在"。

**修复**：

1. **`fts.rebuild` 改为"内容不符就重写"**。原来"已索引就跳过"的写法看到坏行会跳过 ——
   实测 `added:0` 就是它修不好的原因（不是缺行，是**行在、内容错**）。
   现在按"切分后长度是否一致"判定，不一致就重写；重跑幂等。
2. **新增 `src/fts.rs`：CJK 切分**。入库与查询走**同一套规则**：CJK 段切成
   "单字 + 相邻双字"，ASCII 词原样保留。
   - 单字保证 1 字查询命中；bigram 保证 2 字以上以词组形式命中；
   - 查询表达式每个 token 都加引号，`OR` 之类只能作为**被搜索的字面词**，不构成查询语法注入。
3. **`fts.search` 不再返回 `snippet()`**：索引里存的是切分形式（`存 存储 储 …`），
   snippet 出来没法展示；片段应由渲染侧按 `message_id` 取真实正文生成
   —— 符合"索引是索引、正文在正文表里"的分工。

**真机验证（真实 11,137,024 B 生产库副本）**

| 查询 | 修复前 | 修复后 | 正文实际包含该词的消息数 |
|---|---:|---:|---:|
| `消息` | 0 | **21** | 21 ✓ |
| `上下文` | — | **7** | 7 ✓ |
| `压缩` | — | **1** | 1 ✓ |
| `ChatPanel` | 17 | 17 | 17 ✓ |
| `存储`/`迁移`/`索引` | 0 | 0 | **0**（这些词确实不在正文里） |

重建量：3 个会话共刷新 588 行（`added 0 / refreshed 588 / removed 0`）——
"added 0"恰好证明问题不是缺行而是**内容为空**。

**其他命令**：`feedback.set/get/delete`（先删后插 = 覆盖语义；`null` 是取消；
非法值在写入前就报错）、`attachments.list`（**不返回 content** ——
大附件正文必须按需取，否则一次读爆内存）、`attachments.update`（COALESCE：只给正文不动预览）。

**验证**：Rust 63 项（含 CJK 检索、重建幂等、附件不返回正文、反馈覆盖与取消）·
tsc 0 错 · 六道 audit 门禁全绿 · **覆盖率 18.6% → 25.58%**。

### P3 第 9 段（第 92 波）—— 搜索链路打通 + 反馈/附件（已完成，真机验证通过）

**这一段把上一段发现的中文检索修复送到了用户手里**，并顺带发现"全局搜索"也是坏的。

**发现：`session-search.ts` 的"全局搜索"从未生效。** 该工具算了一个 `matchExpr`
（带 session 过滤的表达式）**却从未用于 SQL** —— 两条 SQL 都带 `s.session_id = ?`。
于是"跨会话搜索"只是签名上存在，实际永远被限定在单会话里。

**修复**：
1. `fts.search` 的 `session_id` 改为**可选**：不传就是真正的跨会话搜索，
   并在结果里带上 `session_title`（搜索界面要显示"来自哪个会话"）；
2. 结果返回**真实正文**（取自 `messages`）而不是 `snippet()` ——
   索引里存的是切分后的文本（`存 存储 储 …`），snippet 出来没法展示；
3. 渲染侧 `searchViaRust()` 分流：端口是 rust 就走引擎（含 CJK 切分），
   否则完全走原路径（回滚开关的前提）；
4. 片段在**真实正文**上生成并高亮（`…这里谈到了[上下文]压缩的问题…`），
   查询词按"完整词 → CJK 双字片段"逐级退化查找 —— 因为引擎侧是 bigram 匹配，
   命中的可能是查询词的任意一段，片段定位必须用同样的粒度，否则会出现
   "引擎说命中了、但片段里看不到关键词"。

**旁听一个 UX 细节**：片段半径最初取 60，实测让 107 字的短正文"整段"进去（等于没做片段化），
改为 40 后受控（`radius*2 + 高亮`）。这是喂给模型的工具输出，长度必须收敛。

**反馈（message_feedback）**：`saveFeedback` / `loadFeedback` 走"写穿缓存" ——
`loadFeedback` 是同步接口，而反馈表小但没有"按会话"的天然边界。
规则同源：**只缓存本进程写过的**，缓存命中走内存（与写入同处），
未命中继续读旧库（那些消息本进程没改过，读与写同处）。

**真机验证（真实渲染进程 + 工具层，即用户实际路径）**

| 查询 | 命中 | 说明 |
|---|---:|---|
| `存储` | **3** | 跨两个会话（`存储讨论` + `无关会话` 里也含"存储"） |
| `迁移` | **2** | 双字词 |
| `存储迁移` | **2** | 四字词组（bigram 匹配） |
| `上下文压缩` | **1** | 四字词，正文里存在完整形态 |
| `界面样式` | **1** | 只命中相关会话 |
| `不存在的词` | **0** | 如实报告无结果 |
| 反馈 | `null → like → dislike → null` | 覆盖与取消语义正确 |
| 异常日志 | **0 条** | |

**验证**：Rust 64 项（新增跨会话搜索 1 项）· 会话搜索分流契约 8 项 ·
tsc 0 错 · 六道 audit 门禁全绿。

### P3 第 10 段（第 92 波）—— 通用仓储命令（表定义驱动），覆盖剩余 30 张表

**背景**：盘点显示还剩 **87 个「表 × 操作」**，分布在 30 张表上（账号 / 图谱 / 笔记本 /
卡片 / 目标 / 团队 / 问题 / 收件箱 …）。逐表手写的问题是：体量大、重复多，
而且**容易漂移** —— `database.ts` 加一列，手写命令的列清单不会自动跟上，
于是"静默丢字段"（本项目已经因为手写清单漏表吃过一次亏）。

**做法：表定义驱动**（`src/crud.rs`）：命令只描述"做什么"，列清单从
`sql/tables.json`（TS schema 生成）与运行时 `PRAGMA table_info` 得到。

| 命令 | 说明 |
|---|---|
| `crud.list` | 按条件分页读；`columns` 缺省 = 真实列（顺序稳定）；`order_by` 只允许真实列 + asc/desc |
| `crud.upsert` | 批量写（列可逐行不同，按并集收集）；整批一个事务；`mode: replace` 覆盖主键 |
| `crud.delete` | **必须给 where**（空条件会清空整表，明确拒绝 —— 与 `telemetry.prune` 要求水位线同一条原则） |
| `crud.count` | 条件计数 |

**安全性一点没有放松（与裸 SQL 的差别是结构性的）**：
- **表名**必须出现在 `tables.json` 生成的编译期常量清单里；
- **列名**必须逐字出现在 `PRAGMA table_info` 的真实列定义里；
- **值**一律参数化绑定，不做字符串拼接；
- **`order_by`** 也只在真实列之间选择 —— 不给任何表达式入口。

真机（真实 11 MB 库副本）实测拒绝效果：

| 尝试 | 结果 |
|---|---|
| `crud.list {table:"sqlite_master"}` | `UNSUPPORTED`（表不在业务清单里） |
| `crud.list {table:"graph_nodes", order_by:"id; DROP TABLE graph_nodes"}` | 参数错误：**列名含非法字符** |
| `crud.delete {table:"quick_phrases"}`（空 where） | 参数错误：**删除必须给出 where 条件** |
| 之后 `integrity` | `ok`（库未被破坏） |

读数对照（同一份真实数据）：`graph_nodes` 计数 33 ✓、分页 `next_cursor:"2"` ✓、
条件查询 33 ✓。

**契约测试抓到的真 bug**：`ORDER BY` 拼接时**漏了空格**，拼成
`... FROM "graph_nodes""id"` → SQLite 报 `no such table: graph_nodes"id`。
已修并加注释说明这个坑。

**一个必须讲清楚的度量问题（重要）**：通用命令上线后，"命令可用性"直接到 **100%**，
但**这绝不等于迁移完成** —— 渲染侧的调用点在默认引擎（wasm）下仍然在往 WASM 库写。
如果只报一个数字，就会把"引擎有命令"说成"渲染侧已迁移"，那是**虚报**。
所以覆盖率工具现在报**两个**数字，并明确说明差别：

| 指标 | 现在 | 含义 |
|---|---:|---|
| 方法覆盖率（保守口径，门禁盯这个） | **25.58%** | 渲染侧调用点**真的已切到端口** |
| 命令可用性覆盖 | 100% | Rust 侧存在能服务该方法的命令 |

**验证**：Rust 73 项（新增 CRUD 安全边界 / 空 where / 往返 / 分页 / 事务外校验 /
replace / 缺省列顺序 等 7 项）· tsc 0 错 · 六道 audit 门禁全绿。

### P3 第 11 段（第 92 波）—— 通用域镜像 + 账号域切换（附：清掉一个死模块）

**先清掉一个死模块**：`src/core/auth/storage.ts` 与 `src/core/storage/account.ts`
导出**完全同名**的 7 个函数（`listAccounts` / `getAccount` / `getActiveAccount` /
`createAccount` / `updateAccount` / `deleteAccount` / `setActiveAccount`），
SQL 也几乎逐字相同。核查结论：`auth/storage.ts` **零引用、零独有导出**（是 `storage/account.ts`
的真子集），唯一提到它的地方是**审计允许清单自己**。

删除它的效果很干净：生产文件 838→837、SQL 调用点 **278→270**、D 类命中 **534→519**，
而**迁移进度一点没丢**（那 8 个调用点永远不会执行）。
这也说明之前那个 278 的数字里**混着死代码**，删掉之后口径才准。

**通用域镜像**（`src/port.ts` 的 `RustDomainMirror`）：剩余 14 个域模块
（账号/图谱/笔记本/卡片/目标/团队/问题/收件箱/笔记/委派任务/提议草稿/待办/轮次文件变更/智能体画像）
都是同一个形状 —— **纯 CRUD + 同步读**，且表都很小（实测 `graph_nodes` 33 行、`notebooks` 1 行）。
所以做成一个通用镜像：按表加载 → 同步读 → 写穿 + 本地更新。每个域的接入变成
"声明表名 + 保留原签名"。

**边界仍然按量级判断**：单表几十到几百行 → 可镜像；上万行 → 必须分页。
镜像在加载时会记录行数，**超过上限（5000 行）就放弃镜像并回退旧路径** ——
避免某天图谱涨到十万行时把渲染进程压死（DOM-8 钉住这条）。

**账号域已切换**（`storage/account.ts`）：读走镜像（排序保持 `updated_at DESC`）、
写走 `crud.upsert` / `crud.delete` 并同步本地镜像。

- **更新**采用"当前完整行 + 本次改动"整体 upsert（与消息索引同一条思路）：
  通用命令没有"只改部分列"的参数化形态，而传完整行语义等价且**不会漏列**（DOM-5 钉住）。
- **`setActiveAccount`** 是本域唯一有业务语义的写操作（"先清空所有 is_active，再置位目标"），
  必须保持**只有一个 active** 的不变量（DOM-6 钉住）。

**又踩了一次文本替换的坑**：用 PowerShell here-string 做 `String.Replace` 时，
文件是 CRLF 而 here-string 是 LF，**匹配不到也不报错**（我只看了一处 `.Contains` 的返回值，
另两处静默失败），于是 `listAccounts` 仍在读旧库、测试报"旧库不应被访问"。
改用 `edit` 工具后正常（它与文件实际行尾无关）。**教训：批量文本替换必须逐个验证命中**，
或者干脆用行尾无关的工具。

**验证**：域镜像契约 10 项（DOM-1..10：路由 / 排序一致 / 未加载不路由 / 写穿 + 立即可读 /
整体 upsert 不漏列 / active 唯一 / 删除 / 超限放弃镜像 / 端口未注册 / wasm 回滚）·
Rust 73 项 · tsc 0 错 · 六道 audit 门禁全绿 · 覆盖率 25.58% → **28.68%**（调用点 40.74%）。

### P3 第 12 段（第 92 波）—— 域存储骨架抽取 + v2_sessions 切换 + 修两个门禁的误报

**抽出域存储骨架**（`src/core/storage/domain-store.ts`）。剩余 13 个域模块形状完全一样，
每个模块各写一遍"检查端口 → 加载镜像 → 读 → 写穿 + 报错"就是 13 次重复。
重复本身不算问题，**重复里漏掉一条**才是问题：漏掉"失败上报"就退化成 B 类假成功，
漏掉"未加载不路由"就产生读写分裂。所以把骨架收进一个文件、由契约测试守住。

三条不变量：① 只有加载完成才路由；② 写 = 先本地镜像、再写穿（失败如实上报）；
③ 表超上限不镜像。`account.ts` 已改为使用骨架（去掉重复实现，10 项契约测试仍全绿）。

**`v2_sessions` 切换**：这是"整会话一把存"的形态 —— `messages` / `total_usage` 两列存的是
**JSON 文本**，所以必须逐行转换（对象 ←→ JSON 字符串），不能像普通列那样直传。

**修掉两个审计门禁的误报（真实缺陷，在扫描器里）**

新写的骨架被 B 类与 C 类门禁同时误报：
- B 类报 `domainDelete`「catch 里 return true」
- C 类报同一处「catch 里有放行返回但没有任何拒绝路径（fail-open）」

查根因：两个扫描器都用 `src.indexOf("catch")` 找 catch 子句，再只看"`catch` 后面跟 `(` 或 `{`"。
于是 **`.catch((e) => reportPersistFailure(…))` 里的 `catch` 子串**被当成 catch 块，
再向下配到一个**不相干**的 `}` —— 把整段代码误判成"假成功/fail-open"。

修复：加一个前字符判据 —— `catch` 前面若是 `.`（属性访问）或标识符字符，就不是子句。
修完 B 类 P1 从 4 降到 3、C 类命中从 5 降到 4，**而 GATE-4（门禁自检）仍然通过** ——
说明检测能力没有被削弱，只是不再误报。

> 这个误报本身值得记：门禁"会咬"是好事，但**咬错对象**会消耗信任 ——
> 如果这次是加豁免清单草草了事，以后真出现 fail-open 时大家会先怀疑是误报。

**验证**：域镜像契约 10 项 · Rust 73 项 · 完整套件 269 文件 / 5155 通过 · tsc 0 错 ·
六道 audit 门禁全绿 · 覆盖率 28.68% → **31.78%**（调用点 42.59%）。

### P4（第 92 波）—— 数据迁移与对账（已完成，真机验证通过）

**产物**

| 组件 | 作用 |
|---|---|
| `src-tauri/codem-db/src/migrate.rs` | 迁移原语：`import.begin/table/end/rollback`、`import.tables`、`migration.status/mark`、`digest.tables`、`digest.rows`、`rebuild_fts`；另有单进程批量入口 `import_all` |
| `src/bin/codem-db-cli.rs` 的 `import` 子命令 | **整批在同一个进程/连接里导入**（原因见下） |
| `tools/migrate/storage-migrate.mjs` | 端到端工具：预检 → 备份 → 单事务导入 → 重建 FTS → 逐表对账 → 打标记；含 `--dry-run/--verify/--apply/--strict-fk/--rollback-hint` |
| `tools/migrate/lib/digest.mjs` | 与 Rust 逐字节一致的摘要算法（对账的核心） |
| `tools/migrate/bite-reconcile.mjs` | **咬合测试**：制造 5 类破坏，证明对账会失败（7 项全部符合预期） |

**导入通道为什么不是"裸 SQL"**：`import.table` 的表名走白名单（由 `sql/tables.json` 生成）、
列名与真实列定义逐字核对、值参数化绑定、不接受任何 SQL 片段。
调用方只能说"把这些值放进这张表的这些列"，不能说"执行这条语句" —— 与裸 SQL 是**结构性**差别。

**先修正一个严重低估**：Rust 侧的表清单原来是**手写**的，漏了三张真实有数据可能性的表
（`agent_messages` / `message_feedback` / `needs_you_pending`）——迁移会**静默少搬**它们。
现在该清单由 `tools/audit/gen-schema-sql.mjs` 从 `database.ts` 的 SCHEMA DDL 生成
（`sql/tables.json`，39 张表），`IMPORT_ORDER` 必须覆盖它的每一项（有测试守住），
迁移工具还会在 dry-run/apply 时做**覆盖性硬检查**（未覆盖就退出 1）。

**实测数据（真实 11,137,024 B 生产库副本）**

| 项 | 结果 |
|---|---|
| 计划搬运 | 39 张表 / 3989 行（已排除 FTS 影子表） |
| 导入 | 单事务、22 批、7.1 MiB 负载，一次提交 3989 行 |
| **对账** | **16 张非空表全部一致**（行数 + 内容摘要，两端各自计算） |
| 全文索引 | 从 `messages` 重建，索引 777 条 |
| 旧库 | 迁移前后 sha256 未变（工具只读源库） |
| 咬合测试 | 7/7：少一行 / 值被改 / 覆盖性检查 / 外键预检 / `--strict-fk` / 回滚提示 / 正常通过 |

**四条只有真机才暴露的事实**

1. **生产库里本来就有 86 行外键孤儿**：67 行 `session_events` + 19 行 `telemetry_events`
   指向已不存在的 session（旧引擎时期没有级联清理）。新引擎开着 `foreign_keys=ON`，
   直接导入会**整个事务失败**。所以迁移必须**显式处置孤儿**：默认丢弃 + 打印明细，
   `--strict-fk` 则中止并把决定权交给操作者。这也顺带说明：迁移本身是一次数据清理。
2. **旧库的 `journal_mode = delete`（不是 WAL）**，`page_size=4096`、`synchronous=2`。
   也就是说渲染侧这些年**一直在用 DELETE 日志模式**，每次事务都要写回主库文件 ——
   规模基准里"单条写入成本随语料增长"的现象又多了一层解释。
3. **摘要必须跨语言逐字节一致**，而 `cost REAL` / `weight REAL` 存整数值时是个坑：
   Rust 看到 `Real(0.0)`、sql.js 给出 `number(0)`。两边编码规则不同的话，
   会出现"**行数一致、逐行一致、摘要不同**"这种最难定位的假失败。
   统一规则：**整数值一律按 `I` 编码**（Rust 侧改 `value_bytes`，JS 侧用 `Number.isInteger`），
   并加了跨语言回归样本（`wire-fixtures.json` 的 `digestSample`）锁住。
4. **导入必须单进程**：`--db` 每次调用新开连接，而事务属于连接 ——
   连续调用 `import.begin` / `import.table` 时，上一次的 `BEGIN` 会随进程退出被回滚，
   下一次调用报"没有进行中的事务"，而调用方明明按顺序调了。故提供单进程的 `import` 子命令。

**另外两个工具自身的 bug（都是"对账工具输出不可信"这类问题，已修）**：
`imported.tables` 按批**覆盖**而非累加（821 行的 `messages` 只报 321，看起来像少搬）；
以及逐表期望值取错来源（明明搬对了却打印 ✗）。对账工具的输出本身必须可信。

**回滚开关（已在 P3 段落实现，这里补齐文档）**：`localStorage[codem-storage-engine]`，
`wasm` 即回退；`node tools/migrate/storage-migrate.mjs --rollback-hint` 打印可执行步骤
（开关 + 备份路径 + 如何撤销迁移标记）。**旧库在 P5 之前一直是安全退路。**

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

