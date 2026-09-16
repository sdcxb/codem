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
- 第 92 波 P3 第 13 段：**三个域接入骨架**（v2_sessions JSON 列 / prompt_drafts 版本号 /
  turn_file_changes 的 A 类返回值）
  （**已完成**，覆盖率 31.78% → 36.43%）
- 后续：P3 第 14 段（其余 8 个域模块：图谱/笔记本/卡片/目标/团队/问题/收件箱/笔记/委派）
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

### P3 第 13 段（第 92 波）—— 三个域接入骨架（v2_sessions / prompt_drafts / turn_file_changes）

骨架（`domain-store.ts`）就位后，接入变成机械工作。这一段接了三个形状各异的域，
用来验证骨架对"非普通列"的适应性：

| 域 | 特殊之处 | 处理 |
|---|---|---|
| `v2_sessions` | `messages` / `total_usage` 两列存的是 **JSON 文本**（"整会话一把存"） | 逐行转换：对象 ←→ JSON 字符串，不能像普通列直传 |
| `prompt_drafts` | `version` 由 `MAX(version)+1` 决定；`tags` 是 JSON | 版本号改在**同一份数据**（镜像）上算，语义与旧实现一致 |
| `turn_file_changes` | `updateStatus` 有**元数据返回值**（0 = 目标不存在） | 保留 A 类语义：目标不在镜像里就返回 0，不静默当成成功 |

**第三条最关键**：`turn_file_changes.updateStatus` 是第 84 波专门修过的 A 类问题
（原来 `UPDATE` 影响 0 行没有任何痕迹）。接入骨架时如果图省事写成"写回即成功"，
就会把这个修复退回去。DOM-13 逐条钉住：存在 → 返回 1 且立刻可读；不存在 → 返回 0。

**验证**：域镜像契约 **14 项**（新增 4 项：JSON 列往返、版本号等价、A 类返回值、按会话删除不牵连）
· Rust 73 项 · 完整套件 269 文件 / 5159 通过 · tsc 0 错 · 六道 audit 门禁全绿 ·
覆盖率 31.78% → **36.43%**（调用点 45.93%）。

### P3 第 14 段（第 92 波）—— 七个域接入骨架（goal / inbox / agent_profiles / issues / squads / flashcards / delegation）

上一段验证了骨架对"特殊列"的适应性，这一段把**剩下所有小域**一次性接完，
只留最大的 `knowledge/storage.ts`（988 行、9 张表）单独做。

| 域 | 表 | 需要注意的语义 |
|---|---|---|
| `goal/goal.ts` | `goals` | `listGoals` 的 `ORDER BY priority DESC` 是 **TEXT 的 BINARY 排序**（`normal → low → high`），不是语义序 |
| `inbox/inbox-storage.ts` | `inbox` | `create` 顺带做 30 天 TTL 清理；`markRead`/`archive` 打不到行时**不写** |
| `storage/agent-profile-storage.ts` | `agent_profiles` | `skills` 是 JSON；`update` 的 keys 来自调用方，镜像路径只认已知列 |
| `issue/issue-storage.ts` | `issues` + `issue_comments` | `update` 返回行数（A 类）；`addComment` 要顶起议题 `updated_at` 但**不能**凭空造议题 |
| `squad/squad-storage.ts` | `squads` + `squad_members` | 归档可见性；空更新不写库（第 86 波的修复） |
| `knowledge/flashcard-store.ts` | `flashcards` | `tags` JSON；SM-2 复习整体写回；按笔记本批量删是**范围条件** |
| `session/delegation-storage.ts` | `delegation_tasks` | `clearCompletedDelegations` 是"保留最近 N 条"的子查询删除 |

#### 为范围条件补的原语：`domainDeleteWhere` / `domainDeleteBeyond`

线协议的 `crud.delete` 只支持**等值** where（且明确拒绝空 where，防清空整表），
所以 `created_at < ?`（收件箱 TTL）、`notebook_id = ?`（按笔记本删卡）、
`id NOT IN (… ORDER BY completed_at DESC LIMIT ?)`（只留最近 N 条）这三类**范围删除**
只能由渲染进程按镜像算出具体 id 再逐个写穿。两条原语都保持"**先本地删、再写穿**"：

- 先本地删是**必须**的：这类清理往往紧跟在"写新行"之后，若等到写穿返回才删本地，
  调用方紧接着的同步读就会看到"早该过期的行"；
- `domainDeleteBeyond` 的并列顺序自己定（次级键 = id）。旧 SQL 的
  `id NOT IN (… LIMIT ?)` 在**并列**时保留哪几条是任意的 —— 做不到"逐行一致"，
  就必须换成确定的顺序，否则同一批数据两次运行会删掉不同的行。

#### 这一段踩到的三个坑（都不是"跑一遍就过去"的那种）

1. **`!current` 是假值判断，不是判空**：`domainReadOne` 用 `undefined` 表示"没接手"、
   `null` 表示"确实没有这行"，我一度写成 `if (!current) return`。对 `inbox` 表
   恰好不出事（`wireToInbox` 返回对象总是真值），但语义是错的，已全部改成 `=== null`。
2. **假端口必须按表返回行**：`portWith` 原来对所有 `table` 都回同一份行，
   于是"评论行"会出现在 `squads` 镜像里，断言以莫名其妙的方式失败（DOM-25/26/27 三条）。
   改成 `{ 表名: 行数组 }` 之后立刻全绿 —— **假替身比被测代码更容易写错**。
3. **时间算术不要靠心算**:我"算出"`now-5天 > now-2天`，据此写了一条注定失败的断言。
   用 `node -e` 核对一眼就发现是自己算错了。断言里现在留了这条教训。

另外 `reviewFlashcard` 原来是**漏掉的一处**（读走镜像、写还走旧库），
被"旧库不应在已路由的域上被访问"这条 mock 直接抓出来 —— 这正是该 mock 存在的意义。

**验证**：域镜像契约 **30 项**（新增 16 项）· 完整套件 269 文件 / 5168 通过 ·
tsc 0 错 · 六道 audit 门禁全绿（A 类 0 / B 类 P1 3+P2 1 / C 类 4 / D 类 519，全在允许清单内）·
覆盖率 36.43%（调用点 45.93%）—— 覆盖率只按**文件级**统计（这些文件仍含旧路径回退代码），
所以本段不推高数字，推高的是"实际读写的域"。

#### 附带查出并补上的一道**真门禁缺口**：列级 schema 契约

这一段接 `notebooks` 域时，我据"`schema.sql` 里没有 `group_id`"得出过"Rust 侧缺 14 列"的结论。
**这个结论是错的** —— 真源里有一半的列是后来用 `ALTER TABLE … ADD COLUMN` 加的（23 条），
运行期由 `schema::apply()` 的迁移补齐；实测新建库后 `crud.upsert` 能正常写入
`messages.hidden` / `notebooks.group_id` / `sessions.parent_id` 等全部列。

但这次误判暴露了一个**真实的门禁缺口**，而且是危险的：

- `npm run audit:schema-parity` 比的是 **`schema.sql` 这个文件**有没有被重新生成过 ——
  它只能证明"生成物没被手改"，**不能证明"库能接受真源声明的所有列"**；
- 真源里 23 条 `ALTER` 列**根本不在** `schema.sql` 里，它们靠运行期的
  `migrations.json` 补齐，而这段逻辑**当时没有任何门禁**；
- 一旦生成漏一条、或迁移被 `migrations_ignored` 静默吞掉，表现是"渲染侧写某列失败 / 静默丢列"，
  而六道门禁全绿。这正是本项目一直在消灭的那类"静默失真"。

补上 `src-tauri/codem-db/tests/schema_columns.rs`（Rust 契约，2 项）：

| 测试 | 断言 |
|---|---|
| `fresh_db_accepts_every_column_the_ts_source_declares` | 从**真源 TS 文本**解析出 `CREATE TABLE` 的列 ∪ 23 条 `ALTER` 的列，新建库后逐表逐列核对 `PRAGMA table_info`；顺带核对 `migrations_ignored` 正好等于"与 CREATE TABLE 重叠的迁移条数" |
| `every_migration_column_lands_even_on_a_fresh_database` | 每条迁移声明的列都必须真的落到库里（专抓"迁移被静默吞掉"） |

两项都**不写具体列名字面量**：清单来自真源，真源改了就自动跟着变；解析不到 DDL 会直接 panic，
不会静默通过。**并且验证了它会失败**：临时往真源里插一条 `ALTER TABLE notebooks ADD COLUMN zz_probe_column`，
`cargo test` 立刻报 `迁移声明的列没落到库里：["notebooks.zz_probe_column"]`；还原后 0 残留、重新全绿。

（教训记在这里：这次误判本身也说明"用脚本比对两个文件"得到的结论，
必须再用一次**运行期实测**去确认；`Select-String` 里 `\b` 的匹配结果是**易读错的证据**，
不是结论。列级契约测试比人工比对可靠。）

### P3 第 15 段（第 92 波）—— 知识域接入（9 张表，P3-14 收尾）

这一段把最后、也是最大的一个域接进骨架：`knowledge/storage.ts`（原 988 行、9 张表）。
接完之后，**渲染侧所有业务域都只有一条读写路径**（要么走域端口，要么整体回退旧库）。

| 表 | 特殊之处 | 处理 |
|---|---|---|
| `notebooks` | `refreshNotebookCounts` 是"两条 COUNT + 一条 UPDATE" | 计数在**同一份镜像**上算完，再整体写回一行 |
| `notebook_sources` | `key_topics` 是 JSON | 逐行转换；`summary` 列来自 ALTER |
| `notebook_chunks` | 每行带 **Base64 embedding**（1536 维 ≈ 8KB 文本） | **单独调小镜像上限**（见下） |
| `notes` | `tags` JSON；`pin_order DESC, updated_at DESC` | 逐行转换 + 排序等价 |
| `note_links` | 无唯一约束，`INSERT OR IGNORE` 形同虚设 | 先在镜像判重再写（见下） |
| `graph_nodes` | `source_ids` / `chunk_ids` 是 JSON；`findOrCreateNode` 有读-改-写 | 合并语义与返回值归一（见下） |
| `graph_edges` | 同 `note_links`；按节点级联删除 | 先判重；删节点时按谓词删相连的边 |
| `notebook_groups` | 删分组要把组内笔记本移到未分组 | 两步都走域端口 |
| `note_versions` | 快照 / 回滚（回滚前自动存一份） | 组合已接管的 `getNote`/`updateNote`/`saveNoteVersion` |

#### 为"大行表"加的每表镜像上限

`notebook_chunks` 每行带一个 Base64 编码的 embedding（1536 维 ≈ 8KB 文本）。
默认上限 5000 行意味着**几十 MB 常驻渲染进程内存** —— 这正是 P6 要消灭的那类占用。
因此给 `domainPort` / `domainReadMany` / `domainWrite` 等加了可选的 `maxRows`，
渲染侧对 `notebook_chunks` 声明 `CHUNK_MIRROR_MAX = 2000`（约 16MB），超过就放弃镜像、
回退旧路径。**宁可慢，也不把渲染进程压死。**

顺带把 `addChunksBulk` 旧实现的"N 条 `db.run`"改成**一次 `crud.upsert` 批量写**
（大文档批处理时这是最直接的瓶颈之一）。

#### 这一段查出的三个"旧实现本来就没生效"的问题

审计的 D 类（存储边界）只关心"有没有绕过端口"，不关心"那行代码到底有没有用"。
接这一段时逐条对照，发现三处**看着有防护、实际不生效**的代码：

1. **`note_links` / `graph_edges` 上根本没有唯一约束**（schema 里只有普通索引
   `idx_note_links_source` / `idx_graph_edges_*`），所以：
   - `addNoteLink` 的 `INSERT OR IGNORE` 从来不会 IGNORE，
     `getRowsModified() > 0` **永远是 true** —— 它返回的"是否真的新增"是假的；
   - `addGraphEdge` 的 `try/catch → return null` **永远不会触发**，重复边照落库。
   - 已用真机 CLI 实测确认：同一对节点连写两次，`counts graph_edges` 返回 **2**。
   修法：在镜像上**写入之前**判重（不依赖数据库约束），重复时 `addNoteLink` 返回 false、
   `addGraphEdge` 返回已存在的那条边。落库行为因此变成真正的"不产生重复行"。
2. **`findOrCreateNode` 的返回值与落库内容不一致**：命中已有节点时它把"合并后的
   ids + 真实 weight"写进库，却返回 `sourceIds: sourceId ? [sourceId] : []`、
   `weight: 2` 这样的**字面量**。镜像路径改为返回真实状态（落库内容与旧实现完全一致，
   只是返回值不再骗人）。
3. **`deleteGroup` 不级联删子分组**：旧实现只删自己，子分组会变成指向已删父分组的孤儿。
   这一条**没有改**，只在测试里如实钉住旧行为 —— 顺手"修好"它属于行为变更，不在本段范围。

#### 关于覆盖率数字的一处口径说明

`npm run audit:coverage` 报的"已实现 47 个方法 / 36.43%"**没有把这一段算进去**，
因为它统计的是"有没有对应的**具名** Rust 仓储命令"，而这一段（以及上一段的 7 个域）
走的是 P3 第 10 段引入的**通用命令** `crud.list` / `crud.upsert` / `crud.delete`。
两个数字因此是**两回事**：

- **命令可用性 129/129（100%）**：Rust 侧有命令能服务这个调用点（含通用命令）；
- **已实现 47 / 36.43%**：渲染侧调用点是否切到**具名**命令。

所以本段真实推进的既不是 36.43% 也不是 100%，而是"**实际走 Rust 读写的域**"
（9 张表 / 40+ 个导出函数）。这一点必须写清楚，否则这两个数字都会被误读。
把通用命令纳入统计口径是覆盖工具的事，留到 P5 与"删除 WASM 路径"一起做（那时
真源切换到 Rust，统计口径要重写一遍）。

**验证**：域镜像契约 **30 → 38 项**（新增 8 项：计数、分组过滤、embedding 往返与
按来源删除、笔记排序与版本回滚、链接判重、节点合并语义、边去重与级联、分组删除）·
完整套件 **269 文件 / 5183 通过 / 15 跳过** · tsc 0 错 · 六道 audit 门禁全绿
（D 类 519 → **518**，调用点覆盖率 45.93% → **46.1%**）。

### P6 第 1 段（第 92 波）—— 先把"内存越界"变成可测的数字（已完成）

**这一步的意义**：在此之前，"大文档会不会把渲染进程压死"一直是**推断**。
这一轮把它变成了在**同一份数据形状、同一套操作**下压两个实现的实测数字。
新增 `tools/bench/memory-bound.mjs`（`npm run bench:mem`）：

- 两个实现各自跑在**子进程**里（这样 WASM 崩溃不会带走基准自身，崩溃本身也算结果）；
- 父进程每 40ms 采样子进程的**峰值工作集**（Windows `tasklist`、Linux `/proc/<pid>/status`）；
- 子进程做真实动作：插入 N 条 KB 级大文档 → **立刻落盘**（sql.js 走 `db.export()`，
  Rust 走 `messages.create_many`）→ 分页读一页。

**实测结果（正文总量 = 行数 × 每行大小）**

| 实现 | 1000 × 200KB（195MB） | 4000 × 200KB（781MB） | 8000 × 200KB（1.53GB） |
|---|---|---|---|
| **wasm(sql.js)** | 峰值 **659MB**（= 正文 3.4×） | 峰值 **2.86GB**（= 3.7×） | 峰值 **5.70GB**（= 3.7×） |
| **rust** | 峰值 **162MB**（= 0.8×） | — | — |
| 分页读一页（5 条） | wasm 无分页概念（整库在堆里）；rust **1.0MB**，逐行 ≈ 205KB | | |

**这几个数字把历史事故解释清楚了**

1. **WASM 的内存是"正文的 3.7 倍"**，而且这个倍数是**稳定**的（3.4 / 3.7 / 3.7）：
   整库在堆里一份 + `db.export()` **再复制一整份** + 导出过程中两份同时存在。
2. **wasm32 的线性内存上限是 2GB**，所以浏览器里的实际崩溃点比上面这张表**更早**：
   按 3.7 倍反推，**约 550MB 正文（≈2800 条 200KB）就会顶到 2GB** ——
   这正好对上"批量大文档时出现 `memory access out of bounds`"。
   （Node 里能跑到 5.7GB 是因为宿主允许 WASM 线性内存超出 wasm32 的常规上限，
   不能据此认为浏览器里也不会崩。）
3. **Rust 侧是 0.8 倍、恒定**，而且**不随行数倍数增长**：写入是 WAL 页级增量，
   没有"导出整库"这一步；读一页只搬一页（5 条 = 1.0MB）。
   峰值 162MB 里主要是 CLI 那一刻的参数/结果 JSON 缓冲（200 条 × 200KB 一批），
   属于**跨边界一次**的成本，不是"把语料常驻内存"。

**结论（用于 P6 后续设计）**：渲染进程里**不能**再出现"整份语料 + 一整份副本"。
这条实测也直接给出了两个必须做的东西：① 附件正文外置化（别再以 base64/整段 JSON
形式把大正文搬进渲染进程）；② 大文档走分页读写（每页 5 条 ≈ 1MB 是这个形态的实测依据）。

**验证**：`npm run bench:mem --rows 1000 --kb 200` 与 4000/8000 档均实测如上；
两个实现都完成（rust 侧 1000 档无崩溃，wasm 侧 8000 档 5.7GB 未崩但已远超浏览器可用上限）。

### P6 第 2 段（第 92 波）—— 读路径的驻留内存也必须有界（已完成）

第 1 段量的是**写路径**。顺着同一把尺子量**读路径**，发现一处真实缺口：

`RustMessageMirror` 是"按会话加载"的索引镜像，但加载过的会话**原先永不释放**。
用户浏览过 N 个大会话，N 份语料就全留在渲染进程里；而且 `bySession` 与 `byId`
两份引用虽然指向同一批对象（不额外复制字符串），但**会话数**是没有上限的。
这正是"大文档把渲染进程压死"在读路径上的同一种形态。

修法：给镜像加**跨会话总行数预算 + LRU 逐出**。

| 机制 | 取值 | 理由 |
|---|---|---|
| 单会话上限 | 5000 行（原有 `maxBatch`，超出标记 `truncated` 并回退） | 极端单会话不能无上限拉取 |
| **跨会话总预算** | **20000 行**（新增，可注入便于测试） | 浏览多个大会话时的驻留上界 |
| 逐出策略 | LRU，只逐出"刚好降到预算以下"的那些 | 逐出动作本身不该引发抖动 |
| 逐出后的行为 | `isLoaded` 为 false → 该会话**自动回退旧路径**；下次访问重新分页加载 | 路由规则本来就是"未加载完不路由"，所以逐出**不会**造成读写分裂 |
| 留痕 | 每次逐出都走失败上报通道（`messages.evict`） | 否则用户只看到"卡了一下"，查不出原因 |

新增契约测试 `src/test/message-mirror-budget.test.ts`（**MEM-1…MEM-4**，4 项）：

1. **MEM-1**：预算 250 行 + 三个各 100 行的会话 → 逐出最久未使用的那个，
   `stats().rows ≤ 250` 且 `evictions > 0`，并留下"内存预算"痕迹；
2. **MEM-2**：被逐出的会话 `list()` 返回**空数组**（而不是"只剩一部分"的残缺集合），
   读取因此整体回退旧路径；再次访问能重新加载且内容与逐出前一致（并确认真的又发了分页请求）；
3. **MEM-3**：6000 行的单会话能在轮次上限内全部拉到，且**不**误标 `truncated`；
4. **MEM-4**：没超预算时**不逐出**（否则会造成无谓的重复加载）。

**验证**：新增 4 项全绿 · 完整套件 269 → **270 文件 / 5187 通过 / 15 跳过** ·
tsc 0 错 · 六道 audit 门禁全绿。

### 目标验收（第 92 波结束）—— 两个条件都实测达成；剩余为"删旧代码"的清理

#### 一、验收清单（打包版真机，逐项都有"读得出真数据"的证据）

| 条件 | 证据 |
|---|---|
| **渲染进程不再持有 WASM 数据库** | 启动日志明确"不加载 WASM 数据库"；CDP 抓网络：**sql.js 请求 0 个、.wasm 请求 0 个**；`initDatabase()` 从未被调用 |
| **大文档批处理不再触发内存越界** | 消息路径：12MB 正文 → 渲染进程 **+12.0MB（1.0×）**（旧架构实测 3.4~3.7×，wasm32 上限 2GB → 约 550MB 正文必崩）；知识库路径：4MB 文档 / 2048 块（带 embedding）→ 渲染进程 **+0.0MB** |
| 类型化仓储 IPC（非裸 SQL） | 渲染侧读写走 `crud.*` / `messages.*` / `fts.*` 等结构化命令；Rust 侧 `crud` 拒绝未知列 |
| 单写者事务 + WAL 增量落盘 | `journal_mode=wal`（真机 health 确认）；无整库导出路径 |
| ATTACH 等被 authorizer 禁止 | `attach_is_denied_by_authorizer` 测试守住 |
| 分页与上限 | `messages.list` 分页（真机：page=20 / hasMore=true / total=277）；镜像有单表与跨会话预算 |
| 结构化错误码 | `StorageReply{ok,result,error{code,retryable,hint}}`，错误是值 |
| 契约测试可驱动 Rust | 76 项 Rust 测试（引擎 46 / 线协议 2 / 列级 2 / 其余） |
| 数据迁移与对账 | 自动迁移 39 表 / 3990 行；15 张表逐表**行数 + 内容摘要**比对一致；`integrity_check=ok` |
| 回滚开关 | 打包版双向实测：置 `wasm` → 真的回到旧引擎（日志出现 sql.js）；清键 → 回到 rust |

**功能面巡检**（同一份脚本，打包版实测）：
```
ui:  显示项目 mimo-gui / 无"暂无项目" / 无"面板不可用"
db:  messages=821 projects=3 sessions=3
三级路径: 项目 → 会话["对话 1","对话 2"] → 消息(20/277，读到真实正文)
搜索: 中文"消息" → 21 条；英文"ChatPanel" → 33 条
知识库: 1 个笔记本，读到大文档切块正文
配置面: 设置读回 27 项；崩溃恢复数据写读删正常
控制台错误: 无
```

#### 二、剩余工作：**删旧代码**（不影响已达成的能力，但值得做）

现状是"**默认不加载 WASM，但旧引擎代码与依赖都还在**"。剩余量已量化
（`tools/audit/wasm-removal-readiness.mjs`）：

| 层级 | 剩余 | 处理 |
|---|---|---|
| L1 依赖 | 2 处（都在 `database.ts`） | 删 sql.js 依赖与 wasm 资源 |
| L2 本体外泄 | 0 处 | — |
| **L3 回退分支** | **23 文件 / ~160 处** | 逐个"删回退、只留端口" |
| L4 开关与引导 | 3 处 | 退休 `DEFAULT_ENGINE` 与回滚开关 |

**关键约束（这一段最重要的判断）**：L3 与 L4 必须**一起动**。
因为"回退分支"就是**回滚开关的实现** —— 摘掉回退分支 = 回滚开关失效。
所以删除必须作为一个整体推进，而它需要用户先确认新版稳定（已经连续 5 个版本、
真机逐项验证通过，具备条件）。

**建议的删除顺序**（每一步都能独立验证、可停在任意一步）：
1. 每个文件内部先删回退分支、跑全量测试 + 真机确认（23 个文件可分批）；
2. 全部删完后，删 `DEFAULT_ENGINE`/回滚开关与 `markLegacyDbNotUsed`；
3. 最后删 `sql.js` 依赖、wasm 资源与 `database.ts` 里的引擎本体
   （那时 `getDatabase` 可以直接变成"抛错并说明已迁移"）。

### P5 第 7 段（第 92 波）—— 让 sql.js 变成"按需加载"，并量化剩余删除面

#### 一、先量化：到底什么挡着删掉 WASM 引擎

新增 `tools/audit/wasm-removal-readiness.mjs`，按"阻挡层级"列出全部残留
（凭印象说"大概还有几十处"是不可接受的）：

| 层级 | 数量 | 含义 |
|---|---|---|
| **L1 依赖** | 2 处（都在 `database.ts`） | `import type { Database } from "sql.js"` + wasm 资源引用 |
| **L2 本体外泄** | 0 处（真正的 sql.js API 只在 `database.ts`） | 其余 16 个"命中"是**注释里提到 sql.js**，属扫描器噪声，已记录 |
| **L3 回退分支** | **23 个文件 / 167 处 `getDatabase()`** | 每个都要"删回退、只留端口" |
| **L4 开关与引导** | 3 处（`App.tsx` / `bootstrap.ts`） | `DEFAULT_ENGINE` 与回滚开关 |

结论：删依赖的真正工作量在 L3（23 个文件）。这是**明确可执行的清单**，不再是估算。

#### 二、这一段先做了一个"物有所值且低风险"的改动：sql.js 按需加载

`database.ts` 顶部原来是**静态 import**：

```ts
import initSqlJsWasm from "sql.js/dist/sql-wasm.js";
import initSqlJsAsm from "sql.js/dist/sql-asm-memory-growth.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
```

静态 import 会把 sql.js（连同那份 .wasm）**打进主 chunk** —— 于是
"引擎是 rust、根本不加载 WASM 数据库"的产物里，**每次启动仍然要下载与解析 sql.js**。
功能上没影响，但它与"渲染进程不再持有 WASM"这个目标在**产物层面**是矛盾的。

改成动态 `import()` 后 Vite 把 sql.js 拆成独立 chunk，**只有真正走 WASM 回退时才会加载**。

**真机验证（打包版 + CDP 抓网络请求）**：
```
启动期间总请求数: 124
包含 sql.js 的请求: **0 个**
包含 .wasm 的请求: 无
```
而回滚到 wasm 时它照常加载（测试套件走的就是 asm 分支，全部通过）。

#### 三、顺带修掉一个被这次改动"引爆"的测试竞态

把加载改成异步之后，`core-worktree-environment.test.ts` 里 **5 个测试变红**。
我没有一口咬定"是测试太脆弱"，而是 `git stash` 后在干净树上跑了一遍确认**是我的改动引入的**，
再定位到根因：

```ts
try { resetDatabase(); } catch { initDatabase(); }   // 没有 await！
```

`resetDatabase()` 是 async —— 不 await 时它返回一个 promise（**永远不抛**），
于是 `initDatabase()` 分支永不执行，而清库在后台进行，后续读写撞上
`Database not initialized`。这是**测试自己长期潜伏的竞态**，被异步时序变化暴露出来。
修法是把异步正确地 await 掉（5 处 `beforeEach` 改为 `async`）。

这条值得记住：**"改了 A 之后 B 变红"必须先用干净树复现确认归属**，
否则很容易把真实回归误判成"测试本来就脆弱"。

**验证**：完整套件 **271 文件 / 5198 通过 / 15 跳过** · tsc 0 错 · 七道 audit 门禁全绿 ·
打包版实测 **0 个 sql.js 请求 / 0 个 .wasm 请求**。

### P6 第 5 段（第 92 波）—— 知识库大文档入库实测 + 全功能域真实路径巡检

#### 一、全功能域巡检（打包版真机）

上一轮的教训是"只验启动会漏掉真问题"（中文搜索就是这样漏掉的）。这一段把左侧栏
每个入口背后的**数据路径**都走一遍。26 个域里 **24 个直接通过**，2 个"失败"经查是
**我的探针写错了**（`notebooks` 没有 `archived` 列；memory 的命令是 `memory.get/set`
而不是 `memory.list`）—— 修正后知识库整条链路读出来都是真数据：

| 项 | 实测 |
|---|---|
| 笔记本 | `标准2`：8 来源 / 26 块 / 状态 completed |
| 来源 | 8 个全部 `indexed`（"01、生产管控名词解释专题.docx" 等真实文档） |
| 文本块 | 读出真实正文（`【生产管控】专题：从 MES/MOM 到生产管控的深度解读` 等） |
| 图谱节点 | `生产管控`/`ISA-95`/`ISO 62264`/`MOM`/`MES`（带 entity_type 与 weight） |

#### 二、大文档入库实测（走真实入库路径，不是"写消息"）

用户要的是"批量大文档"，那是**知识库路径**（文档 → 切块 → 带 embedding 入库 → 检索），
形态与消息路径完全不同，必须单独量。实测一份 **4MB 文档、每块 2KB → 2048 块**：

| 步骤 | 耗时 |
|---|---|
| 写来源（4MB 正文） | **79 ms** |
| 切块 + 批量入库 2048 行（每行带 Base64 embedding，200 行/批） | **153 ms** |
| 检索读 100 块（分页） | **4 ms** |

**渲染进程 JS 堆：基线 16.4MB → 入库后 16.4MB（+0.0MB）。**

也就是说：4MB 文档、2048 个带 embedding 的块，**渲染进程一点内存都没多留** ——
因为正文与向量都不落在渲染侧，只有它当前要渲染的那一小部分会进来。
旧架构下这些内容会进 WASM 堆并再被 `db.export()` 复制一份（3.4~3.7×）。

#### 三、回滚开关在打包版里也验过了

置 `localStorage["codem-storage-engine"] = "wasm"` 后重启：日志出现
`[Database] sql.js 引擎：wasm` + `Loaded 11137024 bytes from file`，
说明**回滚确实能回滚**（带回滚开关最怕的就是"写着能回滚、其实回不去"）。
清掉该键后回到 rust 引擎，界面正常显示项目、检索正常。

（一个容易误读的点：`storage_health` 无论当前引擎是谁都报 rust 库的路径 ——
它是"Rust 引擎自身的健康"，不是"当前生效的引擎"。判断当前引擎要看
`selectedEngine()` / `localStorage` 键。）

**验证**：26 个功能域读取巡检 · 大文档入库 4MB/2048 块/153ms/内存 +0.0MB ·
打包版回滚开关双向验证 · 探针数据全部清理（`notebook_chunks` 残留 0，用户笔记本完好）。

### P5 第 6 段（第 92 波）—— **首次启动自动迁移**（老用户的数据不会"消失"）

第 4/5 段之后，引擎默认 rust、渲染进程不再加载 WASM 库 —— 但也因此暴露出一个
**产品级问题**：用户的会话/消息只存在于旧库里，新库是空的。
上一段是手工跑迁移工具解决的；让用户自己跑 `node tools/migrate/…` 不是产品行为。
这一段把它做成**自动的**。

#### 为什么必须由 Rust 侧做

渲染侧读旧库会把**整库拉回内存**，正好把第 4 段省下来的全花回去。
所以迁移放在 Rust 侧：**直接只读打开旧库文件**。

**这不是"绕过 authorizer"**：authorizer 禁止的是 SQL 里的 `ATTACH`（把另一个库挂进当前连接），
而这里用的是 SQLite 自己的**多连接**能力 ——
`Connection::open_with_flags(旧库, READ_ONLY)` 开一个普通只读连接去读它，
两个库各自独立、没有任何 SQL 级别的挂载。安全性不靠 SQL 开关，
而靠"只对旧库执行固定的 SELECT"。铁律四条：

1. **只读旧库**（`OPEN_READONLY`）——回滚开关还要用它；
2. **先对账再宣告成功**：逐表比对行数与内容摘要（用与 `digest.rows` 同一套
   `value_bytes` 规则），不一致就**不写标记**并如实报错；
3. **失败不留半截**：导入走一个事务（全成或全不成）；
4. **孤儿行**：旧库没有级联清理，子行可能指向不存在的父行。直接导入会触发外键失败并
   整个事务回滚，所以按 `IMPORT_ORDER` 逐表导入时**跳过孤儿**并如实计数上报。

#### 触发条件（三条同时满足才搬）

1. 端口是 rust 且已预热；
2. **新库里没有任何会话**（`sessions = 0`）—— 有会话就说明用户已在新库上工作过，
   绝不能再用旧库覆盖；
3. 旧库文件存在、且新库里没有迁移标记（`codem-storage-migrated-at`）。

#### 实测（真机 debug 构建 + CDP）

把新库清成"首次启动"状态（备份后清掉 sessions/messages/session_events + 标记），
然后启动应用：

| 验证项 | 结果 |
|---|---|
| 启动后自动迁移 | `sessions=3 messages=821 session_events=2131 tool_calls=883`（与手工迁移一致） |
| 启动日志 | `已从旧库自动迁移：39 张表 / 3990 行（对账通过；丢弃 86 行外键孤儿（父行不存在））` |
| 再启动一次 | `skipped：新库已有会话数据（不覆盖）` —— 幂等 |
| 直接再调一次 | `{kind:"skipped", reason:"新库已有会话数据（不覆盖）"}` |
| 控制台错误 | 0 |
| 内容对账 | 15 张表逐表摘要比对：**14 张完全一致**；`session_events` 旧库 2198 / 新库 2131（见下） |
| `PRAGMA integrity_check` | ok |

关于 `session_events` 的 2131 vs 2198：迁移时两边都是 **2131 且摘要一致**
（`4490260b1caee825`），旧库后来多出的 67 条是**会话早已不存在的孤儿事件**
（正是迁移会丢弃的那一类）。**不是丢数据**：迁移集合本身完好。

#### 这一段自己踩到的两个坑（都修了）

1. **`PRAGMA quick_check` 在只读连接上会失败**（实测）：
   旧库里有 **FTS4** 的 `session_fts`，而 FTS4 的完整性检查要重建倒排索引 →
   `unable to validate the inverted index for FTS4 table main.session_fts:
   attempt to write a readonly database`。
   既然旧库必须只读打开，就改用**只读探针**（能列举表即可），
   真正的硬证据交给导入后的逐表对账。
2. **`data.execute` 会把结果压成 `{ written }`**，于是 `migration.auto` 的
   `{tables, rows, …}` 全读不到，日志打出
   **"已从旧库自动迁移：0 张表 / 0 行（对账通过）"** —— 一次真实迁移被记成"0 行"的假成功。
   修法：给数据面加 `command()` 返回**完整结构化结果**（`execute` 保持不变，
   它对"写入类"调用仍然是合适的）；调用方读不到契约字段时**直接抛错，不猜**。
   —— 这正是本项目一直在消灭的"字段读不到就静默取默认值"。

#### 剩下还没做的

- **回滚开关退休 + 删 `sql.js` 依赖**：删依赖前要先删那 25 处 `persistDatabase()` 回退分支，
  并跑一次完整真机回归；
- **打开大会话的分页读**（现在仍是整个集合，只是成本已降到 1.0×）。

**验证**：Rust 76 项 · 完整套件 271 文件 / 5198 通过 / 15 跳过 · tsc 0 错 ·
七道 audit 门禁全绿 · 真机 6 项验证如上。

### P6 第 4 段（第 92 波）—— 附件正文的两处驻留问题（缓存无界 + 每消息复制）

顺着"大行表"的线索查附件路径，发现两处会让渲染进程为附件正文付出无谓代价的写法：

#### 1. 外置内容缓存是**无界的**

`attachment-files.ts` 里的 `externalContentCache` 是"读过就永不释放"的 `Map`。
外置阈值是 64KB，而附件正文动辄几 MB —— 用户翻过十个长文档附件，
**几十 MB 永久留在渲染进程**。这与 P6 第 2 段给消息镜像加预算治的是同一种病
（驻留无界），只是长在另一处。

修法：**总字节预算 32MB + LRU 逐出**（`EXTERNAL_CACHE_BUDGET_BYTES`）。
- 32MB 足以装下真实文档附件，保持"同步命中"的既有体验，但堆不会再无界增长；
- 超预算时逐出最久未用的**单条**；逐出后该路径下一次读取走"补一次异步预取"的既有路径
  （返回 undefined、下次命中）——**退化一次，绝不读到错内容**；
- 新增 `externalContentCacheStats()`（条目数/字节/逐出次数/预算），让"驻留是否有界"**可断言**。

#### 2. `loadAttachmentsForMessage` 会把**外置标记当正文**交给上层

这个函数原来对每一行都直接返回 `content` 列。而外置附件的该列存的是**标记**
`file:<绝对路径>` —— 也就是说它把 `file:C:\...` 当成正文交给了气泡渲染。
正确做法是 `isExternalContent()` 分支：命中缓存返回正文（字符串共享、不额外占内存），
未命中返回 `undefined` 并补一次预取（这正是 `getAttachmentContent` 一直以来的既有约定，
调用方无感）。

两者合起来的效果：**附件正文不再被整体搬进渲染进程，且缓存占用有上界。**

新增契约测试 `src/test/attachment-cache-budget.test.ts`（**ATT-1…ATT-4**）：

1. 超过预算时逐出最久未使用的，且总字节不超预算；
2. 命中会把该条移到"最新使用"（LRU 语义：刚访问过的不该被逐出）；
3. 逐出后重读走"补一次预取"，拿回的是**它自己的**内容、不是别人的；
4. 覆盖同一路径不重复计入字节（否则预算被虚耗）。

（写测试时又踩了一次自己的算术：两份"40% 预算"是装得下的，所以第一版 ATT-3
根本没触发逐出。改成 60% 才有意义 —— 断言里的每个数字都要先算清楚。）

**验证**：新增 4 项全绿 · 附件相关既有测试 10 项全绿 · 完整套件结果见下 ·
tsc 0 错 · 七道 audit 门禁全绿。

### P6 第 3 段（第 92 波）—— **把"大文档不越界"从结构论证变成数字**

P5 第 4 段之后渲染进程不再加载 WASM 库，所以"3.7 倍内存"那条路径**默认不执行了** ——
但那是**结构论证**，不是数字。这一段直接在**运行中的应用**上量。

#### 前两次测量为什么都不算数（记下来，避免下次再犯）

1. 第一版探针用 `Runtime.evaluate` 把正文当 JSON 传进页面 —— 大字符串在页面堆里
   被复制成好几份，量出来的全是噪声；
2. 第二版想"自己造 10/50/100MB 假会话"，结果探针在测量前就把数据删了，
   而且**造出来的大文档不是真实形态**。

最终做法：**正文在页面内生成**（只把"多大、多少条"两个数字经 CDP 传过去），
生成用的临时字符串随 evaluate 作用域变成垃圾，而**镜像持有的那份是真实留存**，
所以"GC 后基线 → 加载后（GC 后）"的差值是可解释的。

#### 实测：渲染进程为一份 12MB 正文付出 12MB

| 阶段 | 渲染进程 JS 堆 |
|---|---|
| GC 后基线 | 56.9 MB |
| 写入后（GC） | 57.2 MB |
| **镜像加载后** | **69.0 MB** |
| 镜像加载后（GC） | **68.9 MB** |

正文 **12.0 MB**（192 条 × 64KB），镜像行数 1063 → **增量 12.0 MB = 正文的 100%**。

**和旧架构对比（同一套测量口径下的引擎数据，P6 第 1 段）**：

| 实现 | 语料 → 峰值内存 | 倍数 |
|---|---|---|
| wasm(sql.js) | 195MB → 659MB；781MB → 2.86GB；1.53GB → 5.70GB | **3.4 ~ 3.7×** |
| **rust（当前默认）** | 12MB → **12.0MB**（渲染进程增量） | **1.0×** |

结论：**语料在渲染进程里的代价从 3.4~3.7 倍降到 1.0 倍，而且没有"整库副本"这一步**
（`db.export()` 那条分支已经不在默认路径上执行）。旧架构下 wasm32 的 2GB 线性内存上限
意味着约 550MB 正文就会顶爆；新架构下这条**整库复制**的路径不存在了。

#### 顺带量到的一件事：用户真实语料很小

用户这台机器的 821 条消息**总共只有 70,843 字节**（平均 86 字节/条）。
所以"用真实会话展示随规模增长"是做不到的 —— 必须**主动喂大文档**才能量出形态。
这也是为什么这一段要造数据，而不是只测现状。

#### 仍然没做的（不要把它读成已完成）

- **附件正文外置化**没做：附件正文仍可能整体进渲染进程（不在消息镜像里，但会被整段读取）；
- **打开大会话时的分页读**没做：现在 `listMessages` 仍返回整个集合（只是集合本身不在
  渲染进程常驻，成本 1.0×）；真正的"只搬一页"要改读路径；
- 已确认 `notebook_chunks` 这类"大行表"有单独的镜像上限（P3 第 15 段），
  但**附件表**还没有同类上限。

**验证**：真机实测（debug 构建 + CDP），探针数据用 CLI 批量删除后核对
`messages=821 sessions=3 projects=3 settings=25`（与喂入前一致，无残留）。

### P5 第 5 段（第 92 波）—— 真机复验抓出 `session.ts` 完全没接端口 + 新增一道门禁

第 4 段把启动改成"引擎为 rust 时不加载 WASM 库"之后，我在真机上按"真实读写路径"
又走了一遍，结果抓到一个**足以让应用不可用**的缺口。

#### 缺口：`core/storage/session.ts` 一个端口调用都没有

按"全仓 `getDatabase()`"重新扫了一遍（不是只看我这轮改过的文件）：

| 文件 | getDatabase 调用 | 端口调用 |
|---|---|---|
| `core/storage/session.ts` | **9** | **0** |
| 其余生产模块 | — | 均已接线 |

也就是说**创建会话、改标题、置顶、删除、fork、拖拽排序**全都还在打旧库。
旧库不加载之后这些会直接失败 —— 而这是应用最核心的一条用户路径
（"新对话"按钮就是它）。

**为什么完整测试套件没抓到**：那 5192 项测试里，绝大多数自己 `initDatabase()`
起了一个 WASM 库，于是模块的旧路径"看起来正常工作"。单元测试**结构上**看不见
"这个模块在生产启动路径下没有库可用"。这一类问题只能靠**真机验证**
或**模块层面的接线检查**发现。

修法：9 个函数全部接入域端口（`listSessions` / `getSession` / `createSession` /
`updateSession` / `deleteSession` / `togglePinned` / `searchSessions` /
`forkSession` / `reorderSessions`），并保住各自的语义：
`pinned DESC, last_message_at DESC` 排序、未改动列保留、`forkSession` 显式带
`parent_id`、`reorderSessions` **只改 `sort_order`**。

真机复验（无 WASM 库）：

| 操作 | 结果 |
|---|---|
| `createSession` | ok |
| `getSession` | `{title:"P5 会话探针", model:"probe", messageCount:0}` |
| `updateSession`（只改标题） | 标题变了、`model` 保留、`createdAt` 未变 |
| `togglePinned` | 返回值 `true`、库里也是 `true` |
| `listSessions` | 能查到刚建的会话 |
| `deleteSession` | 删后 `getSession` 为 `null` |
| **已迁移的真实会话** | 仍可读：`["对话 2", "对话 1"]` |
| 控制台 | 0 error |

#### 新增第 7 道门禁：`audit:unrouted-db`

`tools/audit/scan-unrouted-db.mjs`（并接进 `npm run audit` 与 `audit-gates.test.ts`
的 GATE-8/GATE-9）。规则刻意保守、避免噪声：

> 一个生产模块若 `getDatabase()` **≥2 次**且**完全没有**任何端口符号
> （`domainRead*` / `domainWrite` / `domainDelete*` / `domainOr` / `hasStoragePort` /
> `getStoragePort`），即判定为"未接线"。

允许清单里的每一条都必须**写明理由**（不允许"因为现在通过"就放进去）。
它盯的正是测试探测不到的那一半：**模块层面的接线**，而不是运行结果。

**反向验证过它会咬**：临时把 `inbox-storage.ts` 的端口符号改掉 → 门禁立刻报
`✗ src/core/inbox/inbox-storage.ts（getDatabase 8 次）` 且 exit 1；还原后重新全绿。

**验证**：完整套件 270 文件 / **5194 通过** / 15 跳过（新增 GATE-8/GATE-9）·
tsc 0 错 · 七道 audit 门禁全绿 · 真机 7 项操作全通过。

### P5 第 4 段（第 92 波）—— **启动不再加载 WASM 数据库**（目标的核心那一步）

前几段把一切"接线"都接好了，但**目标其实一寸没动** —— 因为启动路径是这样的：

```
App.tsx:  await initDatabase();          ← 无条件把整个 codem-db.bin 读进渲染进程堆
然后:      registerRustStoragePort()     ← 再注册 Rust 端口
```

也就是说：**默认走 Rust，但整库仍然被加载**。P6 第 1 段量出来的"3.7 倍内存"
在那段代码删掉之前一点都没变。这一步就是把顺序与条件反过来：

```
① 先 registerRustStoragePort()        ← 只看回滚开关，不碰旧库
② 引擎是 rust → **整段跳过 initDatabase()**
   引擎是 wasm（回滚）→ 才加载旧库
```

## 为什么顺序是"语义"而不是"风格"

旧注释写着"刻意放在 initDatabase 之后、且失败不阻塞启动"。前一句是**反的**：
`initDatabase()` 才是那个"整库进内存"的动作，把它放在前面等于无条件付出这份代价。

## 跳过之后会发生什么（以及为什么这正是我们要的）

旧库不再被加载 → `getDatabase()` 会抛 "Database not initialized"。
于是**所有还写着"回退旧路径"的代码都会拿到"旧库不可用"** ——
这正是把"**还没真正切到端口的路径**"暴露出来的方式，而不是让它们继续悄悄读写旧库。
（这也是本项目一贯的做法：宁可让问题可见，也不要一个看起来正常的假象。）

## 必须先做数据迁移，否则用户数据会"消失"

这是本段最重要的一条操作性结论。实测这台机器上的两个库：

| 库 | projects | sessions | messages | settings |
|---|---|---|---|---|
| 旧库 `codem-db.bin`（WASM） | 3 | 3 | **821** | 24 |
| Rust 库 `codem-db-rust.bin`（迁移前） | 1（仅全局种子） | 0 | 0 | 25 |

**如果不先把数据搬过去就让引擎只用 Rust，用户的 821 条消息与 3 个项目会直接看不见。**
所以本段按顺序做了两件事：

1. 用 P4 的迁移工具把**真实数据**搬过去（不是只搬 settings）：
   `node tools/migrate/storage-migrate.mjs --dry-run` → `--apply`。
   实测：计划 **39 张表 / 3990 行**，其中 `messages 821` / `session_events 2131` /
   `tool_calls 883`；源库有 86 行外键孤儿（67 `session_events` + 19 `telemetry_events`，
   旧引擎时期没有级联清理留下的），工具在**内存副本**上丢弃它们（源文件不动）。
2. **对账**（这是"搬得对不对"的唯一证据）：16 张有数据的表逐表比对行数与内容摘要，
   **两端摘要完全一致**（例如 `messages: 821 行，摘要 3cc5b009 / 3cc5b009`）；
   FTS 重建索引 777 条；`PRAGMA integrity_check` = ok；旧库 sha256 未变化。

## 真机验证（debug 构建 + CDP，实测）

| 验证项 | 结果 |
|---|---|
| `initDatabase()` 是否被调用 | **否** —— `getDatabase()` 报 "Database not initialized. Call initDatabase() first." |
| 端口 | `hasPort=true`、`kind="rust"` |
| 控制台 | **0 个 error / 0 个未捕获异常** |
| 用户数据是否可见 | 是：界面显示 `项目 \| mimo-gui`、`知识笔记本 1`、`任务管理 1`（迁移前是"暂无对话/暂无项目"） |
| 迁移后行数 | `projects=3 sessions=3 messages=821 tool_calls=883 session_events=2131` |

## 还没做完的

- **老用户的首次迁移是手工步骤**。自动迁移需要"Rust 侧直接读旧库文件"，
  而 authorizer 明确禁止 `ATTACH` —— 所以自动迁移要**新开一个属于 Rust 的连接**去读
  `codem-db.bin`（`Connection::open` 是库自己的 API，不经 SQL 的 ATTACH），
  并在对账通过前不删旧库、失败要能回滚。这是下一段该做的事。
- 25 处 `persistDatabase()` 回退分支仍在（现在是**不可达**的代码，除非回滚开关打开）。
  删它们之前要先决定"回滚开关还要不要"——回滚开关一旦退休，sql.js 依赖才能删。
  **删依赖之前必须再跑一次完整的真机回归**（会话、消息、知识、任务、仪表盘）。

**验证**：完整套件 270 文件 / 5192 通过 / 15 跳过 · tsc 0 错 · 六道 audit 门禁全绿。

### P5 第 3 段（第 92 波）—— 门禁之外的两处遗漏（UI 组件与工具实现）

第 2 段清完清单后，我按"还有谁在直接碰数据库"又扫了一遍全仓（不只看 storage 目录，
也不只看门禁允许清单）。又找到两处 **D 类违例**，都不在 storage 目录下、因此一直藏得很好：

| 位置 | 原来在做什么 | 为什么危险 |
|---|---|---|
| `components/PerformanceDashboard.tsx` | **UI 组件**直接 `getDatabase()` + `db.run("DELETE FROM telemetry_events")` | 组件不该知道表名；切到 rust 后这个 DELETE 打在**旧库**上 → 仪表盘"清空了、刷新又回来" |
| `core/llm/tools/show-todo.ts` | **工具实现**自己拥有 `todo_lists` 的 `INSERT` / `SELECT` / `UPDATE` | 同上：切到 rust 后待办"看起来保存了、重启就没了" |

修法与前面一致：清空逻辑收进 `TelemetryCollector.clearAll()`（走域端口按 id 逐个删，
线协议 where 不支持整表删除），待办三个函数（`saveTodoList` / `loadTodoList` /
`updateTodoStatus`）接入域端口、保留旧路径回退。

**这两处的意义不只是"多接了三个函数"**：它们说明"查 `storage/` 目录"这种排查方式
**必然漏项** —— 存储违例会长在组件层和工具层。以后每轮收尾都应该按
"全仓 `getDatabase()` / `persistDatabase()`"扫一遍，而不是只看审计门禁的允许清单
（允许清单是"已知遗留在迁移期内被容忍"，不是"正确清单"）。

扫描后的剩余情况（**这一条很重要，别把它读成"已经干净了"**）：
`persistDatabase()` 仍出现在 **25 个生产文件**里，但**全部**是"端口未接手时回退旧路径"
的第二个分支（`if (domainWrite(...)) return;` 之后那段）。也就是说：
默认路径已经不碰 WASM，但只要 WASM 代码还在，这些回退分支就还在，
`sql.js` 依赖也还不能删。删依赖之前必须先**删掉这些回退分支**（那是 P5 第 4 段的事）。

**验证**：完整套件 270 文件 / 5192 通过 / 15 跳过 · tsc 0 错 · 六道 audit 门禁全绿。

### P5 第 2 段（第 92 波）—— 清掉剩下四个"仍直接读旧库"的模块

上一段列了四处的清单，这一段逐个处理完。**其中一处根本不是"要迁移的模块"，
而是早就死掉的代码** —— 先把它认出来，比盲目迁移更省事也更正确。

| 模块 | 处理 | 关键点 |
|---|---|---|
| `core/storage/persistence-provider.ts` | **删除**（238 行） | 见下：它从未接管过任何读写 |
| `core/knowledge/note-manager.ts` | 接入端口 | `deleteNoteLinksBySource` 的"同步删除"性质必须保住 |
| `core/storage/session-log-bridge.ts` | 接入端口（新增一条 Rust 复合命令） | 索引重建必须是**一个事务** |
| `core/telemetry/telemetry.ts` | 接入端口（写 + 读 + 聚合都在同一份数据上算） | 遥测表可能十万行 → 单独的镜像上限 |

#### 1. 删掉"假障碍"：`persistence-provider.ts` 是死代码

它的注释写着"allows swapping the storage backend"，但实测：

- `configurePersistenceProvider()` **只把对象存进一个变量**，注释里自己承认
  "currently EventLog uses SQLite directly"；
- 全仓只有**类型**引用（`import("./persistence-provider").PersistenceProvider`），
  **零个值调用点**（连编译器都在报它）；
- 唯一提到它的测试只是注释里的一行标题。

也就是说：它是一份完整的、直接操作旧库的 `session_events` 实现（238 行），
却从来没被任何真实路径用过。**它是"删除 WASM 依赖"清单上的假障碍。**
已连同 `event-log.ts` 里的两个再导出函数、`llm/index.ts` 的类型再导出一起删除。
（与第 11 段删掉的 `core/auth/storage.ts` 是同一类问题：死代码会虚增迁移面。）

#### 2. 索引自愈改走端口 —— 新增 `messages.rebuild_index`

`session-log-bridge.ts` 里有两件事必须走 Rust，因为**读的已经是 Rust 侧了**：

- `hydrateAllAttachments`：只读"外置标记"（`content` = `file:<路径>`），
  正文在文件里按需预热 → 用 `message.ts` 新增的
  `listExternalAttachmentMarkers()` 走域端口即可；
- `rebuildIndexFromSessionLogs`：原来是一整套裸 SQL
  （`BEGIN; INSERT sessions; INSERT messages; DELETE tool_calls; INSERT tool_calls; COMMIT`）。

第二条**必须是一个事务**：拆成多条 IPC 时，中途失败会留下
"会话行在、消息只写了一半、工具调用还是旧的"半截索引 —— 比不重建更糟。
因此 Rust 侧新增一条复合命令 `messages.rebuild_index`：

```json
{ "sessions": [ { "id": "...", "messages": [ { ...message..., "tool_calls": [...] } ] } ] }
```

它在一个事务里写 `sessions` 行 + 消息 + 工具调用（整体替换），并且**显式还原
`hidden` / `parent_message_id` / `metadata`** —— 日志里记着压缩状态与消息链，
重建后不一致会让**被压缩的消息复活**（这正是历史上修过的一类 bug）。

#### 3. 顺带修掉 `upsert_index` 的一个真缺口：它从不写 `hidden`

做上一件事时发现：`messages.upsert_index` 的 UPDATE 分支只更新
content/reasoning/model/status/timestamp + 几个可选列，**`hidden` 完全没碰**。

这在"普通写路径"下恰好是**正确的**（不传就不该动压缩状态），
但对**索引重建**就是错的（重建的目的就是把 hidden 还原回去），
而且 `hidden = 0` 是合法值，不能像其它列那样用 `COALESCE(?n, col)` 一把梭。

修法：`hidden` 做成"显式区分给没给"的可选参数 ——
`upsert_index` 先读出当前值，没传就原样保留、传了就（包括传 0）覆盖。
新增 Rust 回归测试 `upsert_index_preserves_hidden_unless_explicitly_given` 钉住两条：
**不传的普通更新不得复活已隐藏消息**；**显式 0 必须真的取消隐藏**。

#### 4. 遥测：写、读、聚合都在同一份数据上算

`telemetry_events` 是只增不改的日志（可能十万行），所以给了一个**单独的镜像上限
5000 行**：超过就放弃镜像、回退旧路径（宁可仪表盘在超大遥测表上退回旧库，
也不把渲染进程压死）。

聚合（`COUNT` / `COUNT(DISTINCT)` / `GROUP BY event_name` / `MIN/MAX` 分组 /
时间桶 / 延迟分位）**全部改成在同一份数据上用 JS 算**，而不是给每个查询新增一条 Rust 命令 ——
后者要把同样的逻辑在两门语言里各写一遍，正是最容易漂移的那种重复。

**验证**：Rust 76 项（引擎 45 + 契约 27 + 线协议 2 + 列级 2）· 完整套件 270 文件 /
**5192 通过** / 15 跳过 · tsc 0 错 · 六道 audit 门禁全绿，
**D 类命中 522 → 500**（删掉死模块 + 四个模块接入端口的直接结果）。

### P5 第 1 段（第 92 波）—— **默认引擎切到 rust**，并补上切换前必须补的两个域

这一段的目标是"渲染进程不再持有 WASM 数据库"的第一步：**让默认路径走 Rust**。
做法不是直接改常量，而是先把**默认路径上仍然只能靠 WASM 工作的域**补完 ——
这一步是真机验证逼出来的，不是我事先列全的。

#### 真机查出的两个真实缺口

1. **`projects` 域从没接过端口。**
   在 rust 引擎下调用 `createProject` 直接抛
   `Wrong API use : tried to bind a value of an unknown type (undefined)`
   —— 这是 **sql.js** 的报错，说明这个核心域一直在用 WASM 数据库。
   也就是说：默认引擎切到 rust 之后，只要 WASM 库那一天被删掉（P5 后半段要做的事），
   **项目域会整体失效**。整表接入域端口（含 `id != ''` / 非 `notebook:` 的可见性过滤、
   `pinned DESC, last_accessed_at DESC` 排序、以及"缺省时间补齐"）。
2. **`message_feedback` 的四个列在真源与 Rust 侧都不存在。**
   `note` / `version` / `created_at` / `updated_at` 原来只由 `llm/feedback.ts` 的
   `ensureNoteColumn()` 在**运行期** `ALTER TABLE … ADD COLUMN` 添加 ——
   而 `gen-schema-sql.mjs` 只读 SCHEMA，**看不见这些 ALTER**。
   实测两个库（Rust 与旧 WASM 库）的 `message_feedback` 都只有 5 列；用 CLI 写九列被引擎拒绝：
   `表 message_feedback 没有列 created_at`。
   结论：**宽松版反馈（评分 + 备注 + 乐观并发版本）在 Rust 路径下根本写不进去。**
   修法：四列进 SCHEMA 真源 + 四条幂等 ALTER 进 migrations（老库自动补上，实测已生效），
   并把 `llm/feedback.ts` 的四个操作（put / get / delete / list）全部改走域端口。

顺带修掉一处**易碎点**：`createProject` 原来直接绑 `project.createdAt`，
调用方漏传时 sql.js 会抛异常；镜像路径显式补 `Date.now()` 缺省值。

#### 切换本身

`DEFAULT_ENGINE: "wasm" | "rust"` 由 `"wasm"` 改为 **`"rust"`**。
回滚开关（`localStorage["codem-storage-engine"] = "wasm"`）**保留且实测有效** ——
本段刻意**不删 sql.js 依赖**，因为回滚开关必须真的能回滚；删除依赖要等真机验证过
"没有回退需求"之后再单独做。

#### 真机验证（debug 构建 + CDP，逐条实测）

| 验证项 | 结果 |
|---|---|
| 默认引擎（**删掉 localStorage 开关键**后） | `DEFAULT_ENGINE="rust"`、`selectedEngine="rust"`、端口 `kind="rust"` |
| 回滚开关置 `wasm` | 端口不注册（`hasPort=false`），应用正常回退到 WASM 库（旧库数据可见） |
| 项目域 | `createProject → getProject → updateProject → deleteProject` 全部通过，删后 `null` |
| 消息反馈（宽松版） | 写入 → 读回（含备注）→ **版本冲突被拒** → 正确版本可改 → 删除 → 复查 `null` |
| 迁移落到真实库 | `codem-db-rust.bin` 的 `message_feedback` 由 5 列变 **9 列** |
| 探针清理 | 真实库回到"全局项目 1 行 + settings 25 行"，无 `p5probe*` 残留 |

#### 还有一个门禁自身的 bug 被顺手修掉

列级契约测试在本次改动后误报（"被忽略的迁移条数应当正好等于重叠列数"）。
原因是**我在 SQL 注释里写了反引号** —— SCHEMA 是模板字符串，
那个反引号提前把模板字符串结束掉了，于是测试解析到的 schema 少了一段。
测试已同时加固两点：解析时**跳过 SQL 注释行**（注释不该被当成列名）、
并在真源注释里明确写"SCHEMA 区间内不要出现反引号"。

**验证**：域镜像契约 **38 → 43 项**（projects 3 项 + message_feedback 2 项）·
完整套件 **270 文件 / 5187 通过 / 15 跳过** · Rust **75 项** · tsc 0 错 ·
六道 audit 门禁全绿。

#### 还没做完的部分（P5 需要继续）

删掉 WASM 路径之前，还有三个模块仍在直接读**旧库**（端口调用 0 次）：

| 模块 | 涉及的表 | 状态 |
|---|---|---|
| `core/telemetry/telemetry.ts` | `telemetry_events` | 在用（agentic-loop / cost-tracker / 插件） |
| `core/storage/persistence-provider.ts` | `session_events` | 在用（`SqlitePersistenceProvider` 是默认实现） |
| `core/storage/session-log-bridge.ts` | `messages` / `sessions` / `tool_calls` / `attachments` | 在用（启动期索引回填/重建） |
| `core/knowledge/note-manager.ts` | `note_links`（一条删除） | 在用（一行即可接入） |

这四处就是"真正删除 sql.js 依赖"的前置条件，下一段按此清单继续。

### P6 与 P5 的先后（第 92 波，基于本轮实测的排序决定）

P6 第 1 段的实测把一件事说清楚了：**只要 `DEFAULT_ENGINE` 还是 `wasm`，
渲染进程就仍然持有那份 3.7 倍的语料 + `db.export()` 的整库副本** ——
P6 在 Rust 路径上做的任何内存约束（镜像预算、每表上限、分页）
**都不会作用到默认路径**。所以：

1. **先做 P5（删掉 WASM 路径）**：把 `DEFAULT_ENGINE` 切到 `rust`、删除 sql.js 依赖与
   `db.export()`、把域端口变成唯一路径。**在那之后，P6 的约束才真正生效。**
   回滚开关仍然保留（切回 wasm 需要重新引入 sql.js）—— 所以 P5 的正确做法是
   **先保持 sql.js 依赖在位、只切默认值并真机验证**，确认无回退需求后再单独删依赖。
2. **再做 P6 剩下的部分**（按实测给出的优先级）：
   - **附件正文外置化**：`attachments` 的正文目前会整体进渲染进程；实测每行 200KB
     的量级下，这就是"3.7 倍"里最容易被忽略的一块（附件不进消息镜像，但会被单独整段读取）；
   - **大文档分页读写**：分页读一页 5 条 ≈ 1MB 是本次实测的形态依据，
     渲染侧要保证"打开大会话时只搬一页"，而不是整个会话；
   - **规模基准纳入门禁**：把 `bench:mem` 的关键档位（1000 × 200KB）固化成一条可比对的记录，
     避免"以后悄悄退化却没人发现"。

这三条是下一轮的执行顺序，**P6 第 2 段（读路径预算）已经先行落地**，
因为它与 P5 无关（消息镜像是 rust 路径独有的）。

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



---

## P5 第 10 段：把测试基座切到端口（删回退分支的前置条件）

### 为什么这一步必须先做

删掉 L3 回退分支（22 个模块、约 150 个 `getDatabase()`）之前，必须先让**测试跑在端口上**。

否则会出现最坏的一种情况：测试全绿，但它们验证的是我们**马上就要删掉的那条路**，
而生产走的是端口那条路。这就是"假传输掩盖真实契约"在存储层的版本。

结论用一句话说清：**端口一开，套件从 5199 全绿变成 96 个失败 —— 而这 96 个全是真实缺陷。**

### 对照实验（同一套件，只切一个开关）

| 形态 | 命令 | 通过 | 失败 |
| --- | --- | --- | --- |
| 纯旧引擎（对照） | `CODEM_TEST_PORT=0 npx vitest run` | **5199** | 0 |
| 端口模式（新默认） | `npx vitest run` | 5103 | **96** |

对照那一路全绿，恰恰说明旧引擎路径被测试照顾得很好 —— 而它正是要删掉的那条。

### 这一轮由"端口模式"逼出来并已修掉的真实缺陷（7 个）

1. **`getMessage` 只读旧库**（`message.ts`）：`createMessage` / `updateMessage` 早就把索引写
   发往 Rust，按 id 读却仍查旧库。Rust 接手之后新建的消息**在旧库里根本没有行**，
   于是"消息明明存在、按 id 取却取不到"取决于某个缓存有没有预热过。
   修法：与 `listMessagesFromIndex` 同一条路由规则（会话镜像已完整加载且未截断 → 读镜像）。
2. **`tool_calls` 读写分裂**：消息正文写 Rust、工具调用写旧库。失效形态正是用户现场的
   **"模型看不到自己这次调用的结果"（于是反复重发同一个工具调用）**。
   修法：端口可用时走 `tool_calls.replace`（Rust 侧单事务），并加一条按 `messageId`
   的有界同步缓存（`TOOL_CALL_CACHE_LIMIT`），让"刚写的立刻读得到"。
3. **`currentSessionIdForMessage` 只查旧库 + 日志镜像**：对 Rust 接手后的新消息返回 null，
   连带三处静默降级 —— 更新不走 Rust、更新不进权威日志（内容会回退）、
   删除不写墓碑（**下次从日志重建时消息复活**）。修法：先问镜像（`byIdLookup`）。
4. **镜像同步晚于 IPC**（`writeIndexViaRust`）：`applyMessageWrite` 原来挂在 `.then()` 里，
   存在"写成功、紧接着同步读却是旧值"的窗口。修法：与 `domainWrite` 一致 —— 本地先生效、
   再写穿；写穿失败则重新拉一次镜像收敛（不留假的最新值）。
5. **`compactWithSnapshot` 在 rust 引擎下是空操作**（`event-log.ts`）：读走镜像、
   而写快照 / 删事件**只对旧库生效**。后果是压缩"压缩了 N 条、上下文一点没小"，
   机制与第 83 波那次不同但症状一样。修法：与 `deleteAllForSession` 同写法。
6. **`cutoff_seq` 语义用错**：Rust `events.compact` 的 `cutoff_seq` 是**排他上界**
   （`DELETE ... WHERE seq < cutoff_seq`）。传锚点自己会在 `INSERT OR REPLACE` 之后
   **把刚写进去的快照又删掉**。正确取值 = **第一条被保留的尾部事件的 seq**，
   没有尾部时取 `anchorSeq + 1`。
7. **`anchor.seq` 可能是字符串**：`anchorSeq + 1` 于是变成**字符串拼接**（锚点 81 → `"811"`），
   传给 Rust 之后把快照自己也算进删除范围。这个坑极隐蔽：算出来的界线"看起来"是对的，
   只在"没有尾部事件"时才暴露。修法：进出端口一律 `Number(...)`。

另有 1 个 Rust 侧加固建议（**尚未实施**）：`events_compact` 的 DELETE 建议加
`AND event_type <> 'session_snapshot'` —— 快照行在任何调用参数下都不该被删。

### 测试基座本身（`src/test/fake-storage-port.ts`）

一个**如实的内存端口**，不是"让测试变绿"的开关：

- `kind: "rust"`：`domainPort` 只认 rust，表示"路由契约生效"；
- 写穿失败会**真抛**、镜像未加载会如实 `isLoaded=false`，所以路由层与上报层的 bug 照样暴露；
- 实现了三张面 + 三个会话作用域镜像（`messages` / `events` / `domains`），
  列名与语义对齐真实列（`session_events.event_type`、主键 `seq` 而非 `id`）；
- 与真实端口的**唯一刻意差异**：`appendLocal` 直接分配"从 1 递增的真实 seq"，
  而不是 `MAX_SAFE_INTEGER` 附近的占位值（真实端口的占位是 IPC 往返期间的无奈之举，
  测试里这个往返是同步的，用占位只会让"seq 从 1 连续递增"这类断言失去意义）。

### 剩下 96 个失败 = 删除工作的待办清单

它们**不是回归**（对照那一路 0 失败），而是"旧路径还在被测试照顾"的那部分账。
按下表逐文件推进；每修完一类，删回退分支的风险就小一分。
失败用例 **96** 个，通过 **5103** 个，
分布在 **25** 个文件（端口模式：测试跑在存储端口上，不再回退旧引擎）。

| 测试文件 | 失败数 |
| --- | --- |
| `core-chat-message-storage.test.ts` | 16 |
| `core-message-chain-storage.test.ts` | 9 |
| `core-p1-integration.test.ts` | 9 |
| `core-reasoning-feedback.test.ts` | 9 |
| `encoding-toolcalls.test.ts` | 6 |
| `compaction-budget.test.ts` | 5 |
| `core-worktree-notebook-impact.test.ts` | 5 |
| `regression-message-chain.test.ts` | 5 |
| `session-jsonl-index.test.ts` | 5 |
| `silent-write-guard.test.ts` | 4 |
| `attachment-externalization.test.ts` | 3 |
| `global-chat-persistence.test.ts` | 3 |
| `compact-resurrect-repro.test.ts` | 2 |
| `dsh-integration-full.test.ts` | 2 |
| `regression-knowledge-full.test.ts` | 2 |
| `repro-large-session-db.test.ts` | 2 |
| `authority-first-storage.test.ts` | 1 |
| `core-storage-persistence.test.ts` | 1 |
| `encoding-project-session.test.ts` | 1 |
| `fork.test.ts` | 1 |
| `regression-git-worktree-env.test.ts` | 1 |
| `snapshot-compaction.test.ts` | 1 |
| `sql-injection.test.ts` | 1 |
| `task-center-audit-fixes-2.test.tsx` | 1 |
| `trigger-call-execute-loop.test.ts` | 1 |

---

## 第 31 轮真机事故：查询索引被清空（未完全定位）+ 面板崩溃（已修）

这一轮本来只打算做"测试基座切到端口"，结果真机验收连续抓到两个更严重的问题。
按"如实记录、不掩盖"的规矩，把它们连**没查清的部分**一起写在这里。

### 事故 A：`app.conversation` 面板整体崩溃（**已修**）

**症状**：打包版启动后对话区一条消息都不渲染，控制台
`Database not initialized. Call initDatabase() first.`，
`[SlotBridge] Plugin component crashed for slot "app.conversation"`（ChatPanel 兜底也崩）。

**根因**：`prompt-draft.ts` 的 `loadPromptDrafts` 在渲染期被调用，端口分支
（`domainReadMany`）在**镜像尚未加载完**时返回 `undefined`（这是设计：未加载完不路由），
于是落到 `const db = getDatabase()` 回退；而 rust 模式下旧库**刻意不加载**，
`getDatabase()` 按设计抛错（`database.ts:1263`）→ 渲染期异常 → 面板被错误边界卸载。

**性质**：**既有缺陷，非本轮引入** —— 已核对 `HEAD~1` 的同名文件，该模式与 v1.16.48 一致。

**修法**：引入 `legacyDb()` = `tryGetDatabase()`，把该文件 4 处回退改为
"旧库不存在 → 返回该域在 rust 模式下的合理结果（空列表 / 如实上报）"。
`getDatabase()` 本身**仍保持抛错**（写路径上"没有库"是真错误，不该被静默吞掉）。

**遗留风险（重要）**：全仓仍有约 **150 处** `const db = getDatabase()` 回退分支，
它们每一个都可能在渲染期抛同样的异常。这不是"少调了一次 init"，而是
**把"旧库不存在"当成异常**这类设计债 —— 真正的收敛方式是逐个改为 `tryGetDatabase()`
并给出该域的合理空结果（这份清单见本文档末尾的待办表）。

### 事故 B：查询索引被清空，而迁移标记还在（**未完全定位，数据可恢复**）

**症状**：迁移**对账通过并写了标记**（`codem-storage-migrated-at` 在）之后，
新库的 `messages / sessions / session_events / tool_calls` 变回 0
（`sessions` 只剩 1 个笔记本会话）。用户看到的形态是"项目在、会话和消息全空"。

**已知事实（都是命令输出，不是推测）**：

| 事实 | 证据 |
| --- | --- |
| 旧库**始终完好** | `codem-db-cli --db codem-db.bin counts` → `messages=821 sessions=3 session_events=2198` |
| 迁移能成功恢复 | `migration.auto` → `per_table` 对账通过：`messages=821 tool_calls=883 sessions=3` |
| 恢复后完整性正常 | `integrity` → `{"ok":true,"detail":"ok"}` |
| 清空**不经过端口** | 在端口 `data.execute/write/command` 三层都装了审计缓冲，复现期间只记录到 3 条写（`fts.rebuild_all` / `settings.set` / `crud.upsert projects`），**没有任何删除** |
| 可复现 | 恢复 → 启动应用 → 点击项目/会话 → 数据变 0（发生 3 次） |
| 标记仍在 | 清空后 `settings` 里 `codem-storage-migrated-at` 存在 |

**结论**：确认存在一条**绕过渲染进程存储端口**的删除路径，在"进会话"这条用户路径上触发。
本轮**没有定位到它**，因此**不声称已修复**。

**已做的加固（都不是"修好了"，只是降低危害）**：

1. **迁移守卫可续做**：原来"新库有用户项目就不覆盖"会把**半迁移**状态永久挡住
   （用户看到的空列表永不恢复）。现在判据是"**有项目却没有任何用户消息/会话**"= 明显不完整
   → 允许重跑一次（`replace: true` 幂等，内容是旧库那份权威副本）。
2. **迁移标记不再等于"数据在"**：标记存在时额外做一次对账 ——
   "新库核心表全空（messages/sessions/session_events/tool_calls 四张都空）+ 旧库有数据（`dry_run` 只读探测）"
   → 允许重跑迁移自愈。判据刻意保守：**只在"新库为空且旧库非空"时触发，绝不覆盖任何非空数据**。
   （本轮实测该自愈**没有触发**，因为清空后仍残留 1 个笔记本会话 → 未满足"四张全空"。所以它覆盖不了这次的形态，需要继续收紧。）
3. **端口写审计**：端口 `data.execute/write/command` 上的审计缓冲作为排障能力保留建议
   （本轮它给出了"删除不经过端口"这条关键结论）。

**下一步（按顺序）**：

1. 在 Rust 侧给 `crud_delete` / `messages.delete` / `events.delete_session` / `sessions.delete`
   加"调用来源"标记与只增的审计表（写一行谁删了什么）—— 下一次复现就能直接读出凶手；
2. 用 `codem-db-cli` 只读打开清空后的库，确认 `messages` 是**真空了**还是"表还在、行被删"
   （本轮受限于工具，`crud.list` 只返回 1 行而 `counts` 报 3 行，这个不一致本身也要查清）；
3. 定位后，在"进会话"路径上找到那条绕过端口的删除，并让它走端口（或在端口层拒绝）。

### 本轮同时完成的正面工作

- **测试基座切到端口**（`src/test/fake-storage-port.ts`）：见上一节，逼出并修掉 7 个真实读写分裂；
- **新增两个审计工具**：`tools/audit/port-failure-table.mjs`、`tools/audit/show-failures.mjs`；
- 七个审计门禁保持全绿（exit 0），`tsc` 0 错误。

---

## 第 31 轮（下）：删除审计已经落地，事故根因缩到"点开会话"这一步

### 做了什么：让数据库自己记账

新增 `src-tauri/codem-db/src/audit.rs`：在**引擎打开时**给四张核心表装
`AFTER DELETE` / `AFTER UPDATE(hidden 0→1)` 触发器，把每一次"行消失/被隐藏"
记进只增的 `storage_audit` 表。配套：

- 命令：`audit.recent` / `audit.summary` / `audit.clear`（白名单 + dispatch + 单元测试 4 个）；
- CLI：`codem-db-cli --db <path> audit [N|summary|clear]` —— **不启动应用即可取证**
  （事故现场常常是"应用一开就变"，必须能在应用外读）；
- 4 个 Rust 单元测试：删除被记账、整表清空可聚合、重复安装幂等、软删除（隐藏）被记账。

**为什么必须是触发器**：这次事故的形态是"渲染侧的端口审计里没有任何删除"。
只在命令层记账抓不到它 —— 触发器在 SQLite 内部执行，无论删除来自哪条路径都会留下记录。

### 审计给出的结论（硬证据）

复现（恢复数据 → 启动 → 点会话）后，`audit.summary`：

| 表 | 被删行数 |
| --- | --- |
| `session_events` | 2131 |
| `tool_calls` | 883 |
| `messages` | 821 |
| `sessions` | **2** |

关键判读：

- **被删的 2 个会话正是用户的两个真实会话**（`1788321681911-bzonm7mel`、
  `1788268497135-31x6vdt97`），笔记本会话 `nb-ses-…` 保留 —— 是**有选择的删除**，不是清表；
- 子表那些行的 `session_id`/`key_sample` 显示它们是被**级联**删掉的
  （`tool_calls` 行的 `session` 字段是 `assistant-…`，那是消息 id）；
- 所有 3000 条记录的 `at` **完全相同** → 单条 `DELETE FROM sessions` 触发的 FK 级联。

### 触发条件的精确刻画（本轮把范围缩到这一步）

| 实验 | 结果 |
| --- | --- |
| 恢复数据 → 启动 → **不点任何东西**，等 30 秒 | **821/3 完好** |
| 恢复数据 → 启动 → 点项目 | 821/3 完好 |
| 恢复数据 → 启动 → 点项目 → **点会话** | **821→0、3→1**（可重复） |

也就是说：**不是启动即坏，而是"打开会话"这条用户路径上触发**。

### 仍然没定位的部分（如实记录，不声称已修）

`domain-store.ts` 里所有写穿路径（`domainWrite` / `domainDelete` /
`domainDeleteBeyond` / `domainDeleteWhere` / `domainReplaceTable`）现在都过
`write-audit.ts` 的 `recordWrite()`（含调用栈）。而静态排查显示，**全仓只有 3 处
直接写穿端口、且都不删除行**：

- `bootstrap.ts`：`settings.set`（迁移标记）、`migration.auto`；
- `session-log-bridge.ts`：`messages.rebuild_index`（只 upsert，不删行）。

所以"谁删的"仍缺最后一环。已收敛的线索：

1. `[MessageStorage] 索引暂不可用（Database not initialized…）` 这条日志与删除**在同一秒**出现
   ——说明删除发生在"打开会话"的处理链里，且当时有代码走了**旧库回退**；
2. `currentSessionIdForMessage()` 对"迁移进来的消息"会返回 null（镜像 `byIdLookup` 未命中、
   旧库又不存在）→ 依赖它的 `updateMessage` / `deleteMessage` 会走进旧回退路径；
3. 下一步应在 `SessionStorage.deleteSession` 与 `store.ts` 的删除入口
   （而非 domain-store）加同一个 `recordWrite` + 栈，即可一次定位。

### 本轮同时完成的

- 审计能力（含 CLI 与测试）**作为长期能力保留**，不回滚 —— 它就是"下次这类问题一条命令查清"的基础设施；
- 46 个 Rust 测试全绿；七个审计门禁 exit 0；`tsc` 0 错误；
- 数据已恢复：`messages=821 / sessions=3 / tool_calls=883`，旧库那份始终完好。

---

## 第 33 轮：两个问题其实是**同一个根因链**

### 关键事实（真机、打包版，逐步取证）

一直有两个看似独立的症状：**① 打开会话会清空数据；② 打开会话气泡数为 0**。
本轮证明 **② 是 ① 的下游表现**，不是独立的渲染缺陷：

| 证据 | 观察 |
| --- | --- |
| 加 `__codemDb` 诊断入口后直接问应用 | `messages.list` **曾返回 8 行** —— 命令、参数、数据都没问题 |
| 同一调用、数分钟后 | 返回 **0 行** —— 不是读路径坏了，是**消息已经被删掉了** |
| 读路径内部状态 | 第一次读 `routed=no, loaded=false`（镜像未加载）；第二次 `routed=yes, loaded=true` 但 **`mirrorRows=0`** |
| SQLite 侧审计 | 一次批量删除 **2999 条**（单一时间戳）+ 之后一条单行删除（笔记本会话） |

**因果链**：打开会话 → 数据被清空 → 镜像"加载成功但为空" → 界面空白。
所以"气泡为 0"不需要单独修；**修掉清空，它自己就好**。

### 本轮新增的两个能力（长期保留）

1. **`__codemDb(command, params)`**（`bootstrap.ts`）：在**应用自己的上下文**里跑一条白名单
   仓储命令并返回结果。真机排查最痛的是"CLI 读得到、应用读不到"这类分歧 ——
   CLI 是另一个进程、另一次 `Engine::open`，看不见渲染侧端口的真实行为。
   与 `codem-db-cli` 的 `invoke` 同形、不接受 SQL，所以不放松任何安全边界。
   （它与上一轮的删除审计互补：审计回答"删了什么"，它回答"应用此刻能读到什么"。）

2. **`onSessionMessagesReady` + `loadMessages` 就绪重读**：镜像未就绪导致首次读为空时，
   订阅一次"已加载"回调并重读（**有界，不轮询**）。这条修的是
   "异步存储 + 同步读 + 无人重试"这一类启动竞态 —— 与第 92 波"首屏暂无项目"同源。

### 下一步（收敛方向已经明确）

既然两个症状同源，剩下要做的只有一件事：**找到那条删除的调用者**。
已有两道兜底（批量删除闸门 + 启动自愈），所以它不再造成实际损失；
下一步应在**应用的删除入口**（`store.ts` 的 `deleteSession` / `deleteProject`，
以及 `SessionStorage.deleteSession`）打上与 `write-audit` 同源的记录，
一次真机复现即可定位 —— 本轮已把"应用内可观测"这块短板补上（`__codemDb`）。

---

## 第 34 轮：把"排除法"做彻底 —— 四条路径全部排除，问题被夹到一个点上

给 `RustDataPort.execute` / `.command` 加了破坏性命令留痕（`[StorageTrace]`，带调用栈），
它是**所有**仓储命令的唯一出口（`domain-store`、`session-log-bridge`、`bootstrap` 都经过这里）。
先确认代码确实在运行的 bundle 里（应用加载的入口 chunk 不含它，但懒加载的
`bootstrap-*.js` 里有 —— 这一条本轮专门验证过，避免又出现"插了桩却没生效"的假阴性）。

### 排除矩阵（每一行都是真机实测）

| 被排除的路径 | 仪器 | 结果 |
| --- | --- | --- |
| 端口三层（`data.execute` / `write` / `command`） | 端口层审计缓冲 | **0 命中** |
| `domain-store` 全部 5 个写穿点 | `write-audit.recordWrite`（含栈） | **0 命中** |
| 删除类写操作 | `write-audit` 控制台输出 | **0 命中** |
| `RustDataPort.execute/.command`（仓储命令唯一出口） | `[StorageTrace]` | **0 命中** |

而 SQLite 侧的触发器**每次都记下了删除**（本轮：`sessions` 1 行 + `messages` 821 行 +
`tool_calls` 883 行 + `session_events` 2131 行，单一时间戳）。

### 由此得到的确定结论

那条 `DELETE FROM sessions` **不是渲染进程通过任何已插桩的入口发出的**。
渲染侧已经"无处可查"，所以问题被夹到两个可能：

1. 还有一条我尚未覆盖的渲染侧入口（例如某个模块直接持有 transport 调 `call()` —— 
   `RustMessageMirror` / `RustEventMirror` / `RustDomainMirror` **确实是直接调 `call(this.t, …)`**，
   不经过 `RustDataPort`。这是**下一个最该查的点**）；
2. 或者删除来自渲染进程之外（另一个连接/进程）。

### 附带确认的两件事（都有实测依据）

- **闲置时数据是安全的**：应用运行中、不点任何东西，30 秒后 `821/3` 完好、审计为空 ——
  所以这不是"开着就掉"，而是**必须走"打开会话"这条交互路径**才触发；
- **应用加载的 bundle 与刚构建的一致**：入口 `main-*.js` 里没有 `__codemDb`/`StorageTrace`，
  但它们在懒加载的 `bootstrap-*.js` 里 —— 排查时必须以"运行中实际加载的 chunk"为准，
  否则很容易把"代码没生效"误判成"代码没执行"。

### 下一步（一条命令就能验证）

在 `RustMessageMirror` / `RustEventMirror` / `RustDomainMirror` 的 `call(this.t, …)`
（即 `transport.invokeCommand`）上装同一个留痕 —— 那是唯一还没覆盖的渲染侧出口。
若那里仍为 0 命中，就可以确定删除来自渲染进程之外，转而查"第二个连接/进程"。

### 第 34 轮补充：镜像类与端口实例数也已排除，边界收敛完成

上一条把"未覆盖的出口"指向三个镜像类。本轮**用静态证据把它们排除**：

- 三个镜像类（`RustMessageMirror` / `RustEventMirror` / `RustDomainMirror`）里出现的命令名
  **只有读**：`messages.list`、`messages.load`、`events.list`、`events.load`、`crud.list`；
  它们内部的 `delete(` / `removeByIds(` 都是**改内存镜像**（`bySession` / `byId`），不发任何写命令。
- **端口实例数 = 1**（新增计数暴露在 `globalThis.__codemStoragePorts`，真机读数为 1）。
  这条排除了"装了仪器的端口与某些模块拿到的端口不是同一个对象"这个解释 —— 
  它是本轮之前最后剩下的"仪器失效"类可能。

于是边界如下（全部真机实测）：

| 可能发出 `DELETE FROM sessions` 的渲染侧出口 | 仪器 | 命中 |
| --- | --- | --- |
| `data.execute` / `data.write` / `data.command` | 端口层缓冲 | 0 |
| `domain-store` 5 个写穿点 | `write-audit.recordWrite` | 0 |
| 删除类写操作（控制台） | `write-audit` | 0 |
| 仓储命令唯一出口 `RustDataPort.execute/.command` | `[StorageTrace]` | 0 |
| 三个镜像类 | 静态：只发读命令 | 不适用 |
| 端口实例数 | `__codemStoragePorts` | **1** |

**结论（可以写进结论的部分）**：那条删除**不是渲染进程通过任何可插桩的仓储入口发出的**。
渲染侧的排查空间已经穷尽 —— 下一步应当转向**渲染进程之外**：
核查是否存在第二个连接/进程（或某条绕过 `StoragePort` 抽象直连数据库的代码路径）。
在此之前，两道兜底（批量删除闸门 + 启动自愈）继续保证用户数据不真的丢。

**排查方法论（本轮最大收获，值得记下）**：

1. 加仪器之前，先确认**运行中实际加载的 chunk** 里有没有这段代码
   （本轮就踩到：入口 chunk 没有、懒加载 chunk 有 —— 差一点把"没生效"当成"没执行"）；
2. 仪器要装在**唯一汇聚点**（`RustDataPort` 是所有仓储命令的唯一出口），
   而不是逐个调用点 —— 前两轮"插了 A、漏了 B"的返工就是这么来的；
3. 每排除一条路径就**记进矩阵**：排查的产出不只是"找到原因"，
   也包括"把可能性一条条划掉"，后者同样可复用。

### 第 35 轮：把问题**缩小到"删的正是我点开的那个会话"**，并把下一步钉在唯一出口上

本轮又复现三次，得到一条此前没有的**精度**：

| 观察 | 证据 |
| --- | --- |
| 删除的会话**正是刚刚点开的那个** | 最近 20 条审计里，`sessions` DELETE 只有 1 条，key 与我点击的会话 id 一致 |
| 一次点击 = 一个会话被删（级联带走它的消息/工具调用/事件） | `messages` 0、`sessions` 1、其余两张表同样归零 |
| **点开之前数据完好** | 点击前 `821/3`、点击后 `0/1`（同一进程内，无重启） |
| 控制台**依旧 0 命中** | `[StorageTrace]`（`RustDataPort.execute/.command`）与 `write-audit` 均无输出 |

**Rust 侧的静态排查也已完成**：全 crate 里删除核心表的语句只有两处 ——
`sessions_delete`（`repo.rs:1297`）与 `messages_rebuild_index` 里的 tool_calls 整批替换（`repo.rs:1115`）。
`messages_rebuild_index` **不删会话**，所以唯一的会话删除入口就是 `sessions_delete`（仓储命令 `sessions.delete`）。

**于是问题被钉到一个非常窄的点上**：`sessions.delete` 这条命令被发出去了，
但它**没有经过** `RustDataPort`（那里装了留痕）——那么它只能来自
**直接持有 transport 的调用方**，即 `transport.invokeCommand` 的其它使用者。

**下一步（唯一未覆盖的出口，一条命令即可验证）**：
在 `tauriTransport.invokeCommand`（`rust-port.ts` 顶部那个常量对象）上装同一个留痕。
它是**所有** IPC 的最终出口 —— `RustDataPort` 与三个镜像类都经过它。
那里若仍为 0 命中，就只剩"渲染进程之外"这一种解释（第二个连接/进程）。

**本轮另外确认**：启动自愈在打包版上**连续两轮**都正常工作 ——
复现清空（`0/1`）→ 重启 → 自动恢复 `821/3/2131/883`。
也就是说，即使用户装上现在的版本遇到这条删除，**数据也不会真的丢**。
