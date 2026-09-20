# 稳定性审计 · 测量部分（Codem / mimo-gui）

- 测量时间：2026-09-20
- 测量方式：**只测量**。未改任何源码、未提交 git、未安装任何东西、**未杀 `codem.exe`**（测量期间 PID 33404 全程运行）。
- 被测二进制：`C:\mimo-gui\src-tauri\target\debug\codem-db-cli.exe`（size=4585984，mtime=2026-09-19 02:05:49）。
  `target\release\codem-db-cli.exe` **不存在**，因此使用 debug 版（未另行 cargo build）。

## 铁律执行记录（数据库安全）

| 项 | 事实 |
| --- | --- |
| 真实库路径 | `%APPDATA%\com.codem.app\codem-db-rust.bin` = **18,984,960 B**（+ `-wal` 4,136,512 B / `-shm` 32,768 B） |
| 是否被碰过 | **没有**。只做了 `Copy-Item` 读取。测量结束后原库仍是 18,984,960 B / mtime 2026-09-20 00:07:27（未变） |
| 破坏对象 | 仅**临时目录里的副本**，共 5 个临时目录，全部在 `%TEMP%\codem-stab-*` |
| `codem.exe` | 未杀、未重启、未安装 |

副本目录（供复核）：

```
C:\Users\abee\AppData\Local\Temp\codem-stab-h246udpm      ← 变体 A：仅主文件（头部覆 0）
C:\Users\abee\AppData\Local\Temp\codem-stab-nr4sy3jp      ← 变体 B：主文件+WAL+SHM（头部覆 0）
C:\Users\abee\AppData\Local\Temp\codem-stab-w2-bjt0u8     ← 变体 C：仅 WAL 头部覆 0
C:\Users\abee\AppData\Local\Temp\codem-stab-salv-tnwqzn   ← 变体 D：页级损坏（抢救路径）
```

---

## 1. 损坏库自愈（引擎层，CLI 对副本做）

### 1.0 CLI 命令清单（`--help` 原始输出，写在 stderr，exit=1）

```
codem-db-cli.exe : codem-db-cli --db <path> <init|health|integrity|checkpoint|counts|commands|invoke|batch> [args]
```

可用子命令：`init` `health` `integrity` `checkpoint` `counts` `commands` `invoke` `batch`。

### 1.1 ① 正常打开（变体 A 副本，破坏前）

`--db <副本> health`：

```json
{"health":{"engine":"rust","fts_module":"fts5","journal_mode":"wal","last_error_code":null,"path":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-h246udpm\\codem-db-rust.bin","ready":true,"size_bytes":18984960,"tables":46,"wal_size_bytes":0},"ok":true}
```

`--db <副本> counts`：

```json
{"attachments":0,"messages":934,"notebook_sources":8,"notebooks":1,"ok":true,"projects":3,"session_events":3592,"sessions":3,"settings":27,"telemetry_events":0,"tool_calls":991}
```

`--db <副本> integrity`：

```json
{"detail":"ok","ok":true}
```

- **行数**：`health` 出 1 行 JSON；`counts` 出 1 行 JSON；`integrity` 出 1 行 JSON。
- **健康字段**：`ready=true`、`tables=46`、`journal_mode="wal"`、`fts_module="fts5"`、`last_error_code=null`。
- **基线数据量**：messages=934、sessions=3、projects=3、settings=27、tool_calls=991、session_events=3592。

### 1.2 ② 把头 4 KB 覆写成 0 后再打开（变体 A）

破坏动作（只对副本）：

```
BEFORE: size=18984960 first16=53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00
AFTER : size=18984960 first16=00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

`health`（**原始输出**）：

```json
{"health":{"engine":"rust","fts_module":"fts5","journal_mode":"wal","last_error_code":null,"path":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-h246udpm\\codem-db-rust.bin","ready":true,"size_bytes":565248,"tables":46,"wal_size_bytes":2233072},"ok":true,"recovered":true,"recovered_from":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-h246udpm\\codem-db-rust.bin.corrupt-1789862081320"}
```

`counts`（**原始输出**）：

```json
{"attachments":0,"messages":0,"notebook_sources":0,"notebooks":0,"ok":true,"projects":1,"session_events":0,"sessions":0,"settings":0,"telemetry_events":0,"tool_calls":0}
```

`integrity`（**原始输出**）：

```json
{"detail":"ok","ok":true}
```

**结论：是。** 坏文件被**改名备份**（`.corrupt-<ts>`）+ **建了空库**，并且恢复这件事被**报出来**而不是悄悄发生：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `recovered` | `true` | 发生过恢复 |
| `recovered_from` | `...codem-db-rust.bin.corrupt-1789862081320` | 备份路径（时间戳=毫秒 UNIX，1789862081320） |
| `ok` | `true`（exit=0） | **没有向调用方报错** —— 自愈对上层透明 |
| `last_error_code` | `null` | 恢复后引擎自身不残留错误码 |
| `size_bytes` | 18984960 → **565248** | 主文件换成全新空库 |
| `tables` | **46 → 46** | schema 完整重建（表数不变） |
| `counts.*` | 全部归 0（`projects`=1） | 空库：消息/会话/设置全为 0 |

> ⚠️ 我**没有测到**错误码 `CORRUPT` 的原文：CLI 的 `health` 在恢复成功后只回 `recovered/recovered_from`，不打印原始 `ErrorCode`。构造"非损坏"失败以观察错误码**不在本次测量范围内**。

### 1.3 ③ 破坏后目录里的文件（名字 + 大小）

变体 A 破坏后：

```
codem-db-rust.bin                        565248
codem-db-rust.bin.corrupt-1789862081320  18984960
```

**备份与坏文件同大小（18,984,960 B）= 改名而非改写**（与 `engine.rs:277` 注释一致）。

再次打开恢复后的库（幂等性）与 checkpoint：

```json
{"health":{"engine":"rust",...,"size_bytes":565248,"tables":46,"wal_size_bytes":0},"ok":true}
{"ok":true}
```

→ **未再次触发恢复**（无 `recovered` 字段），`checkpoint` 后目录仍只有 2 个文件。

### 1.4 变体 B：主文件 + WAL + SHM 一起复制（更接近真机形态）

破坏前目录与基线：

```
codem-db-rust.bin      18984960
codem-db-rust.bin-shm     32768
codem-db-rust.bin-wal   4136512
{"health":{...,"size_bytes":19042304,"tables":46,"wal_size_bytes":4136512},"ok":true}
```

⚠️ 注意：**基线 `health` 这一次调用就把 WAL 折进主文件了**（`-wal` 文件随后消失，主文件变 19,042,304 B = 18,984,960 + 4,136,512）。这对可靠性是**好消息**：那 4.1 MB 未 checkpoint 的写入没有在恢复中丢失。

随后把头 4 KB 覆 0（**此时 `-wal` 已不存在**）：

```json
{"health":{...,"size_bytes":565248,"tables":46,"wal_size_bytes":2233072},"ok":true,"recovered":true,"recovered_from":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-nr4sy3jp\\codem-db-rust.bin.corrupt-1789862136368"}
```

```json
{"attachments":0,"messages":0,"notebook_sources":0,"notebooks":0,"ok":true,"projects":1,"session_events":0,"sessions":0,"settings":0,"telemetry_events":0,"tool_calls":0}
```

目录：

```
codem-db-rust.bin                        565248
codem-db-rust.bin.corrupt-1789862136368  19042304   ← = 主文件 18984960 + WAL 4136512
```

**备份大小精确等于"主文件+WAL"之和**，说明备份拿到的是 WAL 已折叠后的完整内容。

### 1.5 变体 C：只覆写 WAL 头 4 KB（主文件头完好）

```
wal BEFORE first16: 37 7f 06 82 00 2d e2 18 00 00 10 00 00 00 00 04
wal AFTER  first16: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

```json
{"health":{...,"size_bytes":18984960,"tables":46,"wal_size_bytes":4136512},"ok":true}
```

**WAL 头损坏被静默忽略**：没有 `recovered`、没有备份、`ok=true`、`ready=true`。且 `-wal` 文件在本次打开后被删除（目录只剩主文件 18,984,960 B）。

> 意义：**"WAL 坏掉"这条路上引擎不会报损坏、也不会备份**。因为主文件头有效，SQLite 直接判定该 WAL 无效并丢弃它 —— **WAL 里那些未 checkpoint 的写入会被无声丢弃，而用户拿不到任何备份**。这是本次测量里唯一一个"数据可能静默少掉且无备份"的形态。`backup_corrupt_file` 里那句 `for suffix in ["", "-wal", "-shm"]`（`engine.rs:290`）在本轮**没能被实测触发**（见下）。

### 1.6 我**没有做到**的测量（如实记录）

| 想测的 | 结果 | 原因 |
| --- | --- | --- |
| 观察 `backup_corrupt_file` 把 `-wal` / `-shm` **一并改名**（`engine.rs:290-295`） | **没测到** | 要触发必须"开库时 `-wal`/`-shm` 仍存在且被判损坏"。实测：只要**先**成功打开过一次（基线 `health`），WAL 就被折叠/删除；而 WAL 头损坏又被静默忽略（变体 C）。所以这条分支本轮**观测不到**，只有代码级证据 |
| 抢救**成功**（非 0 条 + 生成旁路文件） | **没测到**（抢救正确返回 0） | 两种破坏都让 `projects`/`sessions`/`settings` 三张表全部读不出。用 Python `sqlite3` 只读打开备份验证：三张表与 `PRAGMA quick_check` 全部报 `database disk image is malformed` → 正是 `engine.rs:135-140/165-168` 的"任一表读不出就返回 0"设计。**不是缺陷，是设计** |
| 错误码 `CORRUPT` 的原始文本 | **没测到** | CLI `health` 恢复后不回显 `ErrorCode` |
| 长跑/内存实测 | **未做**（第 4 项按题目要求只做静态核对） | — |

---

## 2. 引擎与渲染侧的恢复契约（代码级核对）

### ① 坏文件改名备份的**命名规则**

`src-tauri/codem-db/src/engine.rs:282-314`（`fn backup_corrupt_file`）：

- 时间戳：`SystemTime::now().duration_since(UNIX_EPOCH).as_millis()`（`engine.rs:283-286`）→ **毫秒 UNIX 时间戳**。
- 命名：``format!("{}.corrupt-{stamp}", path.display())``（**`engine.rs:287`**）。
  → 规则 = **`<库文件全路径>.corrupt-<毫秒UNIX时间戳>`**。实测产物：`codem-db-rust.bin.corrupt-1789862081320`。
- 三个后缀一起搬迁：`for suffix in ["", "-wal", "-shm"]`（**`engine.rs:290`**），目标各自加 `.corrupt-<ts>`（`engine.rs:295`）。
- **改名优先、失败退回 copy**（`engine.rs:296-304`）：`std::fs::rename` 失败（Windows 占用）→ `std::fs::copy` 再删原文件；仍失败则如实报 `ErrorCode::Io`（`engine.rs:302`），**不假装成功**。
- 一个都没搬动 → 报 `Io` "库被判损坏但文件不存在，无法备份"（`engine.rs:307-312`）。
- 触发点：`open_with_recovery`（**`engine.rs:342-369`**）仅在 `e.code == ErrorCode::Corrupt` 时走备份分支（`engine.rs:346`），随后 `salvage`（`engine.rs:355`）再 `open_inner` 重建（`engine.rs:364`）。

### ② 从备份里**抢救了什么**

`salvage_projects_from_corrupt`（**`engine.rs:120-248`**），只读打开备份（`engine.rs:122-125`，`SQLITE_OPEN_READ_ONLY`，注释点名"绝不动那份备份——它可能是用户唯一的物证"），`busy_timeout(500ms)`（`engine.rs:130`，注释：太长会拖住应用启动）。

| 抢救对象 | 读法 | 落到哪里 |
| --- | --- | --- |
| **项目** | `SELECT id, name, path, description, pinned, created_at, last_accessed_at FROM projects`（`engine.rs:136`），塞进 8 元组、第 8 位是"保留位给未来列，当前恒 0"（`engine.rs:150-151`） | 旁路文件 `projects[]`（`engine.rs:209-221`） |
| **会话归属** | `SELECT id, project_id FROM sessions`（`engine.rs:165`），`project_id` 用 `unwrap_or_default()`（`engine.rs:170`） | 旁路文件 `sessions[]`（`engine.rs:223-230`） |
| **设置** | `SELECT key, value, updated_at FROM settings`（`engine.rs:188`），**独立尽力**：失败即空表、不连累前两张表（`engine.rs:187-200`） | 旁路文件 `settings[]`（`engine.rs:232-240`） |

- **为什么必须救归属**：日志记的是"消息"不是"会话归属"（`engine.rs:71-75`）；重建发生在**空库**上 → `projectOf` 取不到 → 所有复活会话 `project_id` 落成 `""`，而 `""` 在引擎里是"全局项目"→ 用户会话全掉进"全局对话"（`engine.rs:77-79`）。
- **为什么必须救设置**：设置（模型/provider、安全模式、主题、语言、水位与标记、插件禁用清单…）**只存在于索引库里**，会话 JSONL 里没有（`engine.rs:84-91`）。
- **旁路文件路径**：`salvage_sidecar_path` = **`<库文件全路径>.recovered-projects.json`**（**`engine.rs:250-253`**）。
- **为什么写旁路文件而不直接写新库**：抢救时机在 `open()` 里、渲染侧还没开始重建，而重建自己会 upsert `sessions` → 两个写入者（`engine.rs:99-106`）；旁路文件是**一次性只读输入**，删掉它=放弃这次抢救，无需回滚新库。
- **失败处置**：整个函数返回结果不抛错；任一表读不出 → `return 0`（`engine.rs:127/139/156/167/174`）；三张表全空 → `return 0` 且**不留空文件**（`engine.rs:203-205`）；写文件失败 → `return 0`（`engine.rs:244-246`）。设计意图："这一步只可能变好，不可能把恢复弄坏"（`engine.rs:108-114`）。
- **返回值**：`sessions.len() + settings.len()`（`engine.rs:247`），只用于日志（`engine.rs:356-362`）。
- 渲染侧消费：`src/core/storage/recovery-restore.ts:173`（`restoreRecoveredProjects`，项目先写、会话归属后写）、`recovery-restore.ts:120`（`restoreRecoveredSettings`）。

### ③ **明确不抢救**的东西

`src/core/storage/recovery-restore.ts:81-103` → `BLOCKED_RESTORE_KEYS`，共 **3 条**：

| # | 键 | 行号 | 明确不继承的理由（原文要点） |
| --- | --- | --- | --- |
| 1 | `codem-storage-content-watermark` | `recovery-restore.ts:83-89` | 自愈水位记的是上次 messages/sessions 行数；新库此刻**是空的**，而自愈判据是"上次很多、现在 0 ⇒ 疑似丢失"⇒ 跑 `migration.auto`，那是 **replace 语义的整库重写**（会用陈旧内容覆盖新库）→ **恢复水位等于在新库上主动武装一条破坏性路径**。不恢复时没有基线，自愈只会记录新水位、什么都不做（"这才是正确的沉默"） |
| 2 | `codem-fts-bigram-rebuilt` | `recovery-restore.ts:92-95` | 新库全文索引是空的；继承"已经重建过"会让 FTS 重建被**跳过** → **中文搜索从此搜不到东西，而且是静默的** |
| 3 | `codem-storage-integrity-checked-at` | `recovery-restore.ts:98-101` | 该时间戳给完整性检查上了最长 **12 小时**节流；而此时**刚从一个坏文件里爬出来**，磁盘/文件系统可能还有问题 → 新库应当尽快自检，而不是被旧时间戳推迟半天 |

另外两条相关边界（同文件）：

- **只补缺失、不覆盖已有**：`restoreRecoveredSettings` 中 `getSetting(key) !== null` 即 `keptExisting++` 跳过（`recovery-restore.ts:143-146`）；理由=启动早期渲染侧已写入"这一版真正想要的当前状态"，抢救来的是**旧库那一刻的快照**，覆盖会让设置自己跳回去（`recovery-restore.ts:110-113`）。
- **会话归属同样只补空**：只对 `project_id` 为空的行补（`recovery-restore.ts:262-276`）。
- **明文密钥要过闸门**：恢复写回走 `gateSettingsRawWrite`（`recovery-restore.ts:147-152`），否则"从损坏库恢复"= 把明文 `apiKey` 静默请回来。
- **明确不抢救的整体对象**（不在 `settings` 表里的）：**消息正文 / 工具调用 / 事件** —— 它们不由备份抢救，而是由渲染侧 `rebuildIndexFromSessionLogs()` 从**权威 JSONL 日志**重建（`engine.rs:68-69`）。**归属与设置**才必须靠备份，因为它们在日志里**没有等价物**（`engine.rs:90-91`、`recovery-restore.ts:76`）。

---

## 3. 崩溃自愈的测试覆盖

`src/test/` 下与本主题直接相关的测试文件（含用例数 = 文件内 `it(`/`test(` 调用数）：

| 文件 | 用例数 | 断言的核心契约（一句话一条） |
| --- | --- | --- |
| `src/test/self-heal-safety.test.ts` | **8** | SH-1 计数读不到时**绝不恢复**（读不到 ≠ 是 0）；SH-2 首次 0、复核非 0 → 判读抖动、不恢复；SH-3 连续两次 0 + 高水位 + 旧库有内容 → 才允许恢复；SH-4 水位不高（用户本来就只有几条）→ 不判异常；SH-5 旧库无可恢复内容时只上报、不恢复（避免用空数据覆盖）；SH-6 水位读不到时不判定也不覆盖水位；SH-7 恢复后复核不通过 → 保持原水位、不谎报 `restored`；SH-8 恢复成功且复核通过 → 才写水位、才报 `restored` |
| `src/test/recovery-restore.test.ts` | **7** | REC-1 项目先写、会话归属后写（外键顺序不能反）；REC-1b 会话行已存在且归属为空 → 补上抢救到的归属；REC-2 **不覆盖**用户已设好的归属；REC-3 没有抢救数据/形状不对 → 什么都不做且**不报错**；REC-4 `sessions` 镜像未就绪 → 归属不写（也不抛）、项目照写；REC-5 项目名/路径缺失的行**照样写**（保住外键目标比保住名字重要）；REC-6 `projects` 端口接不了这次写 → **必须如实上报**，不许静默丢弃 |
| `src/test/invariant-watermark.test.ts` | **8** | WATERMARK-1 会话集合变小 → 水印不许丢、缺口回来不许报新；WATERMARK-2 水位只增不减；WATERMARK-3 真新缺口仍要报成新产生；WATERMARK-4 第一次审计 → 全算历史缺口并写水位；WATERMARK-5 水位形状不对 → 按没有水位处理、不伪造"全是新的"；WATERMARK-6 零个可检查会话 → 三件事实一起为零且**不动**水位；WATERMARK-7 水位保留**插入顺序**（超限时丢最旧的键）；WATERMARK-8 水位**有界** —— 上限内正常并集且不丢键 |
| `src/test/corrupt-marks-rebuild.test.ts` | **4** | CORRUPT-1 端口已注册 + 命令回 `CORRUPT` → 写标记 + 上报（错误仍照常抛出）；CORRUPT-2 同进程后续命令也报损坏 → 标记只写一次、只上报一次；CORRUPT-3 端口未注册（启动引导阶段）→ 不写标记；CORRUPT-4 非损坏失败（`BUSY`）完全不碰标记 |
| `src/test/integrity-throttle-policy.test.ts` | **7** | INTEG-1 小库 + 上次 2 小时前 → **要检查**（1 小时窗口）；INTEG-2 小库 + 上次 30 分钟前 → 跳过；INTEG-3 大库（≥256 MB）+ 上次 2 小时前 → 跳过（不许被顺手放宽）；INTEG-4 大库 + 上次 13 小时前 → 要检查；INTEG-5 读不到库大小 → 按**小库**处理；INTEG-6 时间戳读不到 → 要检查（不把"读不到"当"刚查过"）；INTEG-7 检查失败 → 写重建标记 + 如实上报 |
| `src/test/recovery-settings-restore.test.ts` | **4** | SET-RESTORE-1 新库缺的键**要补上**（否则偏好永久丢失）；SET-RESTORE-2 新库已有的键不许覆盖；SET-RESTORE-3 派生状态标记**按策略拒绝继承**（自愈水位 / FTS 标记 / 检查时间戳）；SET-RESTORE-4 形状不对/无这一节 → 安静地什么都不做（不是错误） |
| `src/test/regression-session-recovery.test.ts` | **15** | RECV-001…015：会话恢复数据的存取/排序/删除/追加/更新/状态/摘要/导出/导入/清空、消息超限自动裁剪、项目过滤、设置当前会话、`trimSessions` 裁剪旧会话、`forceSave` 不崩溃（`SessionRecoveryService` 回归） |
| `src/test/db-fatal-cascade.test.ts` | **2** | DBF-6 没有可用存储时 `saveMessages` 跳过并**一次性**上报（不再每几秒打一行）；DBF-7 没有可用存储时遥测不再无限重排定时器。（DBF-1..5 及同族 4 个文件已随 sql.js 退役，文件头有**逐条移交台账**） |
| `src/test/recovery-keys.test.ts` | **2** | recovery 数据存 `codem-recovery`（非 `mimo-recovery`）；`recovery.ts` 的 `DEFAULT_CONFIG.storagePrefix` 为 `codem-recovery` |

**合计：57 条** `it/test` 调用（9 个文件）。

另外**不是**独立文件但直接守着"损坏 → 备份 → 重建"契约的用例（题目未点名，但属于同一契约，一并列出以免漏计）：

| 位置 | 用例 | 核心契约 |
| --- | --- | --- |
| `src/test/db-contract.test.ts:449` | **C28** | 走**真 CLI**：造"SQLite 头 + 乱码正文"文件 → `init` 必须成功 → 目录里必须出现 `.corrupt-<ts>` 改名备份 → 重建库 `integrity` ok → `init.result.recovered_from` 必须含 `corrupt`（本次对副本的实测与它完全一致） |
| `src/test/db-contract.test.ts:361` | **C25** | 主库+WAL+SHM 全删后重开 = 全新库、`integrity` ok |
| `src/test/db-contract.test.ts:383` | **C26** | 真实生产库副本能被打开且完整性通过 |
| `src-tauri/codem-db/tests/engine_tests.rs:28` | `corrupt_database_is_backed_up_and_rebuilt` | ①普通 `open` 必须报 `ErrorCode::Corrupt`（`engine_tests.rs:42`）②`open_with_recovery` 给出备份路径且**备份与坏文件同长度**=改名而非改写（`engine_tests.rs:48-49`）③重建库 schema 就位（`tables >= 30`）、完整性通过、可读可写（`engine_tests.rs:56-66`）④正常库不得产生备份（`engine_tests.rs:68-72`） |
| `src-tauri/codem-db/tests/engine_tests.rs:90` | `corrupt_recovery_salvages_project_attribution` | 头部有效 + 页级损坏时，抢救**真的能拿到**项目/会话归属。该测试文件头（`engine_tests.rs:109-116`）明确写了为什么不用"正确头+乱码正文"：那种文件**任何表都读不出来**、抢救必然是 0，只能验证"失败不影响恢复"——**正是本次在真库副本上遇到的形态** |

自愈相关用例总计：**57 + 3（C25/C26/C28）+ 2（Rust）= 62 条**；若把题目点名的 9 个文件算作"自愈族"，则为 **9 个文件 / 57 条**。

---

## 4. 长时间运行 / 内存上界（**只做静态核对**，未跑长跑测试）

### 4.1 `src/core/llm/`

| 文件:行 | 结构 | 装什么 | 上界 |
| --- | --- | --- | --- |
| `src/core/llm/agent-message-queue.ts:28` | `consumedReplies` | `messageId → 回复正文`（**整段正文**） | **无上界**。只在 `send()` 里 `set`（`:81`），`getReply()` 只读（`:119`），**全文件没有任何 `delete`/`clear`/上限** |
| `src/core/llm/agent-message-queue.ts:26` | `queues` | `toAgent → AgentMessage[]` | **无上界**（条目数）。`consume()` 只把数组**换成空数组**（`:102`）而**不删键**，`clearSession()` 同理只置空（`:126-129`）→ **agent 键永久驻留** |
| `src/core/llm/agent-message-queue.ts:27` | `sequenceCounter` | `toAgent → 序号` | **无上界**（`:64` 只增，无删除） |
| `src/core/llm/request-header.ts:48` | `headerHistory` | `sessionId → HeaderChange[]`，**每次请求头变化都 `push`**（`:98`） | **无上界**。删除路径只有 `clearHeaderTracking()`（`:139`），那是全会话重置用，不是容量上界 |
| `src/core/llm/needs-you-queue.ts:34` | `pendingAnswers` | `id → { resolve }`（**Promise resolver**） | **无上界**；残留会同时钉住闭包与 Promise |
| `src/core/llm/needs-you-queue.ts:33` | `queues` | `sessionId → NeedsYouItem[]` | **无上界**（按会话累积，无条目上限） |
| `src/core/llm/agentic-loop.ts:326` | `readCache` | `path → { offset, limit, output }`，**存文件原文**（注释："path → last read content"） | 有"清空"但**无容量上界**：`run()` 起始清空（`:861`）、上下文压缩时清空（`:1313`、`:2179`）、bash/execute 成功后整体清空（`:2745-2748`）。**单轮任务内**读过的所有文件原文同时驻留，**无上界** |
| `src/core/llm/agentic-loop.ts:347` | `writeCache` | `path → 写入的完整内容` | 同上：有清空路径（`:862`、`:1314`、`:2180`），**单轮内无上界** |
| `src/core/llm/agentic-loop.ts:359` | `settledSubagentIds` | 已 settled 子智能体 ID | **无上界**（`:1653` 只增；`:1645` 会在消费时删，但仅在残留未结算项被 `pendingBackgroundSubagents` 遍历到时） |
| `src/core/llm/agentic-loop.ts:366/367/372/373` | `delegatedTasks` / `waitedDelegations` / `delegationProgressAtWait` / `delegationStuckPeeks` | 委派任务 ID 与缓存的**结果正文** | **无上界**（`:2730` 增；`:2709` 在 wait 时删 `delegatedTasks`；`waitedDelegations` 缓存 `result.output` 全文、`:2708` 只增）。清空仅 `run()` 起始（`:805-806` 只清后两个） |
| `src/core/llm/agentic-loop.ts:334` | `appendedStepTitles` | 追加过的步骤标题 | 有上界：`MAX_APPENDED_STEPS = 2`（`:336`，由 `shouldAppendStep` 强制） |
| `src/core/llm/cost-tracker.ts:124` | `records` | 用量记录数组 | **有上界**：`maxRecords = 10000`（`:82`），超出 `slice(-maxRecords)`（`:158-159`） |
| `src/core/llm/cost-tracker.ts:125` | `sessionCosts` | `sessionId → SessionCost` | **无上界**（按会话累积，无逐出） |
| `src/core/llm/token-tracker.ts:116` | `history` | `TurnTokenUsage[]` | **有上界**：`maxHistory = 20`（`:117`），超出 `shift()`（`:161`） |
| `src/core/llm/tools/terminal-tools.ts:99` → `:132-133` | `sessions[].lines` | 终端滚动缓冲 | **有上界**：`MAX_SCROLLBACK_LINES = 10000`（`:21`），`splice` 裁剪（`:133`）；视口另有 `MAX_VIEWPORT_CHARS = 262144`（`:31`） |
| `src/core/llm/tools/terminal-tools.ts:335` | `backgroundJobs` | 后台 PTY 任务（含 `stdout`/`stderr` 全文） | **无上界**（`kill` 只改状态 `:441`，不删除条目；`clear()` 才清 `:452`） |
| `src/core/llm/tools/job-manager.ts:32` | `jobs` | 后台任务（含 stdout/stderr） | 有删除：`:135` 清理已完成条目（相对可接受） |
| `src/core/llm/guidance-queue.ts:33` | `queues` | 每会话 FIFO | 条目数**无上界**，但空队列会删键（`:114-115`） |
| `src/core/llm/tools/load-skill.ts:200` | `pendingPromptInjections` | `sessionId → 技能正文`（字符串**拼接** `:577-579`） | **无上界**（消费时删 `:209`，但同一会话反复注入则字符串持续增长） |
| `src/core/llm/tools/load-skill.ts:321` | `catalogHistory` | `sessionId → { digest, published }` | 每会话 1 条、有删除（`:391`），条目数**无上界** |
| `src/core/llm/model-output-limit.ts:81` | `learnedLimits` | `modelId → 上限` | 键数受模型数约束（小）；仅 `clear()`（`:85`） |
| `src/core/llm/output-contract.ts:120` | `outputContracts` | `toolName → 契约` | 键数受工具名数约束（小） |

其余为**只读常量集合**（不随时间增长，不计入风险）：`loop-guard.ts:85/92/97/117/270/281`、`micro-compact.ts:27/41`、`tool-args-guard.ts:29`、`tool-result-status.ts:21`、`tool-result-storage.ts:128`、`agentic-loop.ts:258`、`stream-reveal.ts:16`、`tool-pipeline.ts:141`。
`time-context.ts:54 injectionHistory` 为**每会话单条**（`set` 覆盖，`:192`），不计入无上界。
`request-header.ts:51 lastFingerprints` 为每会话 1 条（键数=会话数）。

### 4.2 `src/core/storage/`

**静态核对结论：18 个结构无上界，28 个结构有上界**（本目录共核对 46 个长生命周期容器；函数局部变量与标量标志不计入）。

#### 无上界（风险项，18 个）

| 文件:行 | 结构 | 装什么 | 上界 |
| --- | --- | --- | --- |
| `src/core/storage/message.ts:704` | `cachedLogMessages` | `sessionId → 该会话全部消息正文`的内存镜像 | **无上界**。复位入口 `clearSessionLogCache` 在 `src/core` 内**只有测试调用者**；生产路径只在 `reloadSessionMessages`（`message.ts:525-544`，调用点 `store.ts:540`）里逐会话删除 |
| `src/core/storage/rust-port.ts:1087` | `RustEventMirror.bySession` | `sessionId → MirrorEvent[]`（含事件 payload 全文） | **无上界**。`warmupEvents` 仅由 `App.tsx:1594` 以 `[activeId]` 调用，**无跨会话预算、无 LRU** |
| `src/core/storage/rust-port.ts:1089` | `RustEventMirror.loaded` | 已完整加载事件的会话 id（路由到镜像的唯一依据） | **无上界**（与 `bySession` 同生命周期） |
| `src/core/storage/rust-port.ts:1865` | `RustDomainMirror.byTable` | 表名 → 该表全部镜像行 | **无上界**。载入路径有 `maxRows = 5000` 拒绝（`rust-port.ts:2022`、`2040-2058`），但 `applyWrite`（`rust-port.ts:2088-2095`）的 `push` **不受该上限约束且无逐出** |
| `src/core/storage/message.ts:1985` | `writtenTextEventFingerprints` | `sessionId\0类型\0messageId → 长度:字符和`；每个定稿消息一条 | **无上界**（复位入口 `__resetTextEventFingerprints` 为**测试专用**） |
| `src/core/storage/message.ts:37` | `attachmentContentCache` | 附件 id → 正文 | **无上界**（索引路径只入 ≤ `DEFAULT_EXTERNALIZE_THRESHOLD` = 64 KB 的内联正文 `message.ts:1899`；但 `warmAttachmentContent` 的写入 `message.ts:54` **无大小判断**） |
| `src/core/storage/message.ts:2843` | `feedbackCache` | 消息 id → `like`/`dislike`/`null` | **无上界**（失效点仅 `invalidateFeedbackCache`，`llm/feedback.ts:332,503`） |
| `src/core/storage/message.ts:787` | `logReadFailures` | 日志读失败过的会话 id | **无上界**（成功 hydrate 时单条删 `message.ts:750`；整体清空 = 测试用 `message.ts:820`） |
| `src/core/storage/message.ts:1444` | `localHiddenIds` | `sessionId → 本进程隐藏过的消息 id 集合` | **无上界**（每会话 Set 有 `LOCAL_HIDDEN_MAX = 50_000` 逐出 `message.ts:1454-1461`，但**外层 Map 无 delete**）→ "每会话有界、跨会话无界" |
| `src/core/storage/session.ts:38` | `sessionSortOrder` | 会话 id → `sort_order` | **无上界**（`session.ts:45` 每次读会话都写，全文件无 delete/clear） |
| `src/core/storage/event-types.ts:80` | `customEventTypes` | 插件注册的自定义事件类型名 → 元数据 | **无上界**（`event-types.ts:100-102` 只注册，**无注销路径**） |
| `src/core/storage/persist-failure.ts:76` | `failures` | 失败区域名 → `{count,lastMessage,lastAt,kind}` | **无上界**。唯一复位 = `AppErrorBoundary.tsx:256` 的"重试"按钮 + 测试用 `persist-failure.ts:211` |
| `src/core/storage/secret-cache.ts:30` | `cache` | providerId → **解封后明文密钥** | **无上界**（唯一清空 = 测试用 `secret-cache.ts:106`） |
| `src/core/storage/secret-cache.ts:42` | `sealedBlobs` | providerId → 该明文对应的密文 | **无上界**（仅 `forgetSealedBlob` 单条删 `secret-cache.ts:64`） |
| `src/core/storage/secret-cache.ts:43` | `failed` | 解封失败的 providerId | **无上界**（仅 `clearSealedKeyUnreadable` 单条删 `secret-cache.ts:85`） |
| `src/core/storage/rust-port.ts:976` | `RustConfigDomainCache.snapshot` | `quickPhrases` / `mcpServers` / `memory` 三域整表内存镜像 | **无上界**（`settings.ts:327,396,442` 的 `patch` 会 append 用户新建行） |
| `src/core/storage/rust-port.ts:589` | `RustDataPort.retriesByCommand` | 命令名 → 重试次数 | **无上界**（键域 = 端口命令白名单，实际条目受白名单约束，但无逐出逻辑） |
| `src/core/storage/rust-port.ts:2207` | `RustStoragePort.retryByCommand` | 命令名 → 重试次数 | **无上界**（写入点 `rust-port.ts:2179`） |

#### 有上界（28 个，逐个写出上界值）

| 文件:行 | 结构 | 上界 |
| --- | --- | --- |
| `rust-port.ts:1435` `RustMessageMirror.bySession` | 消息索引行（含 `content` 正文） | `totalBudgetRows = 20_000`（默认值 `rust-port.ts:1470`；`enforceBudget` `rust-port.ts:1553-1578` 超预算按 **LRU 逐出整会话**）；单会话载入上限 `maxBatch = 5000` × `maxRounds = 60`（`rust-port.ts:1446-1447`） |
| `rust-port.ts:1436` `RustMessageMirror.byId` | 消息 id → 镜像行（与 bySession 同一批对象） | 随会话逐出一并删（`rust-port.ts:1562-1566`），总行数同受 20 000 约束 |
| `rust-port.ts:1464` `RustMessageMirror.lru` | 会话访问序 | 同受 20 000 约束（touch `1521-1525`，逐出 delete `1557-1571`） |
| `rust-port.ts:1437/1438` `RustMessageMirror.loaded/loading` | 已加载 / 在途会话 | 逐出时 delete（`1568`）、`finally` delete（`1600-1602`） |
| `rust-port.ts:844` `RustAppendPort.queue` | 待落库事件/遥测发件箱 | `maxQueue = 5000`（`rust-port.ts:857`）；满则 shift 最旧并计 `dropped`（`872-877`）；单批 `batchSize = 200`（`859`、`888`） |
| `rust-port.ts:855` `RustAppendPort.inFlight` | 在途落库条数 | 受 `maxQueue = 5000` 约束（backlog 判满 `872`，批次结束回减 `911`） |
| `rust-port.ts:737` `RustConfigPort.cache` | settings 整表镜像 | `warmup()` 清空重装（`754-760`）；水位部分另受 `maintenance.ts:963 MAX_INVARIANT_WATERMARK_KEYS = 20_000` |
| `rust-port.ts:747` `RustConfigPort.inFlight` | 在途设置写 Promise | `finally` delete（`812-815`） |
| `rust-port.ts:1866/1867` `RustDomainMirror.loaded/loading` | 已加载表名 / 在途表加载 | 表名集合封闭；`finally` delete（`1959-1961`） |
| `rust-port.ts:1868/1889/1992` `refused/refusedAt/refusedMisses` | 超限被拒表名 / 上次被拒时间 / 连续被拒次数 | 键域 = 表名；退避窗口 `REFUSED_RETRY_BASE_MS = 30_000` 起、上限 `REFUSED_RETRY_MAX_MS = 10 * 60_000`（`1891-1893`）；成功加载时 delete（`2064-2065`、`2124-2126`） |
| `maintenance.ts:1362` 水位键集合 | 持久化的不变量水位键 | `MAX_INVARIANT_WATERMARK_KEYS = 20_000`（`maintenance.ts:963`）；超限 `slice(droppedForCap)` 丢最旧并打印条数（`1389-1394`） |
| `transcript-cache.ts:25` `memoryCache` | 请求指纹 → LLM 响应（含响应全文 + tool_calls JSON） | `MAX_CACHE_SIZE = 100`（`100-103` 超限逐出最旧）；另 `CACHE_TTL_MS = 10*60*1000` 惰性淘汰（`77-80`） |
| `attachment-files.ts:102` `externalContentCache` | 外置文件路径 → 正文全文 | `EXTERNAL_CACHE_BUDGET_BYTES = 32 * 1024 * 1024`（`130-137` LRU 循环逐出单条） |
| `write-audit.ts:42` `buffer` | 最近写穿记录环形缓冲 | `CAPACITY = 400`（`write-audit.ts:58` `splice(0, len - CAPACITY)`） |
| `domain-store.ts:231` `deferQueue` | 镜像未就绪时排队的域写 | `DEFER_MAX_PER_TABLE = 100` + `DEFER_MAX = 500`（`311-322` 满则**显式上报丢弃**）+ `DEFER_STALE_MS = 15_000` 老化结算（`248-269`） |
| `message.ts:1465` `toolCallCache` | 消息 id → `ToolCall[]` | `TOOL_CALL_CACHE_LIMIT = 200`（`1471-1475` while 循环删最旧 = LRU） |
| `message.ts:1444` 内层 Set | 每会话隐藏 id | `LOCAL_HIDDEN_MAX = 50_000`（`1454-1461`）—— 注意外层 Map 仍无界（见上表） |
| 瞬时/`finally` 清理族 | `attachmentWarmInFlight`（`message.ts:38`）、`hydrationInFlight`（`789`）、`pendingExternalization`（`962`）、`toolCallWarmInFlight`（`1486`）、`RustEventMirror.loading`（`rust-port.ts:1090`）、`RustEventMirror.inFlight`（`1093`）、`session-jsonl.pendingAppends`（`session-jsonl.ts:113`）、`secret-write-guard.pending`（`secret-write-guard.ts:85`）、`port.portListeners`（`port.ts:287`） | 由 Promise `finally` / 取消函数回收，条目数 ≤ 在途任务数 |

**一句话总结（风险项）：`src/core/storage` 里最重的两条无上界结构是 `message.ts:704 cachedLogMessages`（每个访问过的会话的**全部消息正文**常驻，且清理入口在生产代码里没有调用者）与 `rust-port.ts:1087 RustEventMirror.bySession`（事件 payload 全文，**无跨会话预算、无 LRU**）—— 后者与 `RustMessageMirror` 的 `totalBudgetRows = 20_000` 形成明显不对称：**消息镜像有预算、事件镜像没有**。**

另注（非风险但值得记）：`event-log.ts:49 pendingDuringLoad` 的唯一写入者 `notePendingDuringLoad`（`event-log.ts:52`）**没有任何调用点** = 死代码。

---

## 5. 未做 / 未量到的部分（汇总）

1. **`-wal`/`-shm` 一并改名的分支（`engine.rs:290`）**：未观测到，原因见 §1.6（WAL 要么先被折叠、要么头损坏被静默忽略）。
2. **抢救非 0 条（成功生成 `.recovered-projects.json`）**：未观测到。§1.4/§1.5 两种破坏都让三张表全 `malformed`。变体 D 专门做了"页级损坏"（保留前 4096 B 的 SQLite 头与 schema 页，其后全部覆 0）想复现成功路径，结果仍是三表全废 → 抢救返回 0、无旁路文件。Python 只读验证输出见 §1.6。
3. **错误码 `CORRUPT` 的原始文本**：CLI 未回显。
4. **长跑 / 内存实测**：未做（按题目要求第 4 项只做静态核对）。
5. **Python `sqlite3` 只读探测**是本次唯一的第三方工具使用，且**只对副本**；未安装任何东西（`sqlite3` 命令行不存在，Python 3.14 是系统已有的）。

---

## 6. 要点列表（结论）

### ① 副本上"坏库改名备份 + 建空库"**真的发生了**（关键原始输出）

```json
{"health":{"engine":"rust","fts_module":"fts5","journal_mode":"wal","last_error_code":null,"path":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-h246udpm\\codem-db-rust.bin","ready":true,"size_bytes":565248,"tables":46,"wal_size_bytes":2233072},"ok":true,"recovered":true,"recovered_from":"C:\\Users\\abee\\AppData\\Local\\Temp\\codem-stab-h246udpm\\codem-db-rust.bin.corrupt-1789862081320"}
```

- **改名备份**发生：目录出现 `codem-db-rust.bin.corrupt-1789862081320`，大小 **18,984,960 B = 与坏文件完全同大小** → 是**改名**而非改写；`recovered=true` + `recovered_from` 指向它。
- **建空库**发生：主文件 18,984,960 → **565,248 B**，`counts` 全部归 0（messages/sessions/settings 全 0），而 **`tables` 仍是 46**（schema 完整重建）。
- **对上层透明**：`ok:true`、`exit=0`、`last_error_code:null`；再次打开不再触发恢复（幂等）。
- 变体 B（带 WAL）：备份 = **19,042,304 B = 主文件 18,984,960 + WAL 4,136,512 之和** → WAL 已折叠进备份，恢复**没有丢掉那 4.1 MB 未 checkpoint 的写入**。
- ⚠️ **一个负面发现**：只覆写 **WAL 头** 4 KB 时（主文件头完好）引擎**不报损坏、不备份、静默忽略**（`ok:true` 且 `-wal` 随后被删除）→ 这是唯一"数据可能静默少掉且无备份"的形态。
- ⚠️ **未量到**：`-wal`/`-shm` 一并改名的分支（`engine.rs:290`）本轮**没能触发**，只有代码级证据。

### ② 恢复契约里**明确不抢救**的东西（3 条 + 2 条边界）

`src/core/storage/recovery-restore.ts:81-103` → `BLOCKED_RESTORE_KEYS`：

1. **`codem-storage-content-watermark`**（自愈水位）— `recovery-restore.ts:83-89`：继承它会让"上次很多、现在 0"判据成立 → 触发 `migration.auto`（**replace 语义整库重写**）= 在空库上**主动武装破坏性路径**。
2. **`codem-fts-bigram-rebuilt`**（FTS 重建标记）— `recovery-restore.ts:92-95`：继承会让 FTS 重建被跳过 → **中文搜索静默搜不到东西**。
3. **`codem-storage-integrity-checked-at`**（完整性检查时间戳）— `recovery-restore.ts:98-101`：它给自检上 12 小时节流，而刚从一个坏文件爬出来 → 新库应尽快自检。

边界：**只补缺失、不覆盖已有**（`recovery-restore.ts:143-146`）、**会话归属只补空**（`recovery-restore.ts:262-276`）、明文密钥必须过 `gateSettingsRawWrite`（`recovery-restore.ts:147-152`）。
不靠备份抢救的：**消息正文/工具调用/事件**由渲染侧从**权威 JSONL 日志**重建（`engine.rs:68-69`）；**归属与设置**没有日志等价物，所以必须靠备份（`engine.rs:90-91`）。

### ③ 自愈相关用例数

- 题目点名的自愈族：**9 个文件 / 57 条** `it/test`（`self-heal-safety` 8、`recovery-restore` 7、`invariant-watermark` 8、`corrupt-marks-rebuild` 4、`integrity-throttle-policy` 7、`recovery-settings-restore` 4、`regression-session-recovery` 15、`db-fatal-cascade` 2、`recovery-keys` 2）。
- 加上同契约的**非独立文件**用例 **8 条**（`db-contract.test.ts` C28/C25/C26、`db-fatal-cascade` 移交台账里挂靠的 C5/C24/C26、Rust `engine_tests.rs` 2 条：`corrupt_database_is_backed_up_and_rebuilt`、`corrupt_recovery_salvages_project_attribution`）。
- **合计 65 条**（其中直接钉住"改名备份 + 重建"的是 `db-contract.test.ts:449` **C28** 与 `engine_tests.rs:28`，且 C28 走**真 CLI**，与本次对副本的实测形态完全一致）。

### ④ 无上界的内存结构（**风险项，突出**）

**渲染侧 `src/core/llm`（9 个）**：

- **`agent-message-queue.ts:28` `consumedReplies`** — 存**整段回复正文**，全文件无 delete/clear → **无上界**。
- **`agent-message-queue.ts:26/27` `queues` / `sequenceCounter`** — `consume()` 只置空数组不删键 → agent 键**永久驻留**。
- **`request-header.ts:48` `headerHistory`** — 每次请求头变化都 `push` → **无上界**（`clearHeaderTracking` 是重置不是容量上限）。
- **`needs-you-queue.ts:33/34` `queues` / `pendingAnswers`** — 后者存 **Promise resolver**，无上界。
- **`agentic-loop.ts:326/347` `readCache` / `writeCache`** — **存文件原文**；单轮任务内读/写过的所有文件全文同时驻留，**无容量上界**（只有清空路径）。
- **`agentic-loop.ts:359/366/367/372/373`** `settledSubagentIds` / `delegatedTasks` / `waitedDelegations`（缓存**结果正文**）/ `delegationProgressAtWait` / `delegationStuckPeeks` — 无逐出。
- 对比：`cost-tracker.ts:124` `maxRecords = 10000`、`token-tracker.ts:116` `maxHistory = 20`、`terminal-tools.ts` `MAX_SCROLLBACK_LINES = 10000`、`agentic-loop.ts:336` `MAX_APPENDED_STEPS = 2` **都有上界**。

**`src/core/storage`（18 个无上界 / 28 个有上界）**，最重的两条：

- **`message.ts:704` `cachedLogMessages`** — 每个访问过的会话的**全部消息正文**常驻；`clearSessionLogCache` 在 `src/core` 内**只有测试调用者** → **无上界**。
- **`rust-port.ts:1087` `RustEventMirror.bySession`**（+ `:1089 loaded`）— 事件 payload 全文，**无跨会话预算、无 LRU**；而消息镜像 `RustMessageMirror` 有 `totalBudgetRows = 20_000`（`rust-port.ts:1470`）→ **明显不对称：消息镜像有预算、事件镜像没有**。
- 其次：`rust-port.ts:1865` `RustDomainMirror.byTable`（载入有 `maxRows = 5000` 拒绝，但 `applyWrite` 的 `push` **不受约束且无逐出**）、`message.ts:1985` `writtenTextEventFingerprints` 与 `message.ts:787` `logReadFailures`（复位入口**测试专用**）、`message.ts:1444` `localHiddenIds`（**每会话有界 50 000、跨会话无界**）、`message.ts:37` `attachmentContentCache`、`message.ts:2843` `feedbackCache`、`session.ts:38` `sessionSortOrder`、`secret-cache.ts:30/42/43`（含**明文密钥**）、`persist-failure.ts:76` `failures`、`event-types.ts:80` `customEventTypes`、`rust-port.ts:976` `RustConfigDomainCache.snapshot`、`rust-port.ts:589/2207` 两个 `retriesByCommand`。

---

## 7. 铁律遵守自证

| 铁律 | 结果 |
| --- | --- |
| 不碰真实库 | ✅ `%APPDATA%\com.codem.app\codem-db-rust.bin` 测量后仍是 **18,984,960 B / mtime 2026-09-20 00:07:27**（与开始时一致），只做过读取与复制 |
| 只破坏副本 | ✅ 全部破坏操作只发生在 `%TEMP%\codem-stab-*` 的 5 个副本目录 |
| 不杀 `codem.exe` | ✅ 测量全程 PID 33404 存活，结束时仍为 1 个进程 |
| 不安装任何东西 | ✅ 未执行任何安装；只用系统已有的 Python 3.14 标准库 `sqlite3` 做只读探测 |
| 不改源码 / 不提交 git | ✅ `git status --porcelain` 输出为**空**；本报告是本任务唯一的文件产物 |
