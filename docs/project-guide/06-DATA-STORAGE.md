# 06 · 数据结构与存储

> 基线：1.16.330 ｜ 2026-10-26
> 真源：`src-tauri/codem-db/sql/schema.sql`（595 行）+ `src-tauri/codem-db/src/{engine,repo,crud,migrate,authorizer,fts,schema}.rs` + `src/core/storage/*`。
> 原则：**JSONL 是权威追加日志，SQLite 是可重建索引**；设置是唯一允许的内存镜像；`session_events` 是既非权威也不可重建的特殊层。

---

## 1. 存储分层

| 层 | 载体 | 权威性 | 说明 |
|---|---|---|---|
| 权威副本 | `<数据根>/sessions/<sessionId>.jsonl` | **权威** | append-only；同 id 后写者胜；删除写墓碑；索引丢了可从这里重建 |
| 可重建索引 | `<数据根>/codem-db-rust.bin`（SQLite/WAL） | 索引 | 允许丢；由 JSONL 重建；FTS5 中文 bigram |
| 缓存/快照 | 设置内存镜像、消息/事件/域镜像、`recovery_data`、`turn_file_changes`、`v2_sessions` | 可丢/可重算 | 镜像有界，可逐出 |
| 特殊 | `session_events` | **既非权威也不可重建** | 含 JSONL 没有的压缩、工具配对、`turn_*` 时间线；维护刻意不压缩 |

### 1.1 数据流

```text
UI / AgenticLoop
 ├─ createMessage
 │   ├─ ① appendSessionMessage → sessions/<sid>.jsonl（权威，fire-and-forget）
 │   └─ ② writeMessageIndex → messages.upsert_index（SQLite，最佳努力）
 ├─ updateMessage
 │   ├─ ① 现有快照 + 改动 → 追加整行 JSONL
 │   ├─ ② upsert_index
 │   ├─ ③ 仅正文变化 → 重写 FTS
 │   └─ ④ status→done/error 补 assistant_text 事件
 ├─ deleteMessage
 │   ├─ ① 删索引（>50 行须 confirm_bulk）
 │   ├─ ② 删镜像 / FTS
 │   ├─ ③ 追加墓碑
 │   └─ ④ 清日志镜像
 └─ EventLog.append → 队列（5000/批 200）→ events.append → session_events

设置：setSetting → 内存 Map（同步读）+ 写穿队列 → settings 表
维护：JSONL → 重建索引 / 裁剪 / 对账
```

---

## 2. 数据根与路径

### 2.1 库路径优先级（`src-tauri/src/storage.rs`）

| 档 | 来源 | 语义 |
|---:|---|---|
| 0 | `CODEM_DATA_HOME` | **整个数据根**（库/日志/台账/附件/溢出/崩溃标记/技能）；优先于 `CODEM_DB_PATH`；空串 = 未设置 |
| 1 | `CODEM_DB_PATH` | **只**决定库文件位置；不搬日志/台账/附件 |
| 2 | `dirs::data_dir()` | 标准位置 `%APPDATA%\com.codem.app\codem-db-rust.bin` |
| 3 | `XDG_DATA_HOME` | 非 Windows 习惯 |
| 4 | `$HOME/.local/share` | 同上 |
| 5 | `%USERPROFILE%\.codem` | 已知文件夹取不到时的私有目录 |
| 6 | `./.codem-portable/` | 最后兜底；绝不退回裸相对文件名 |

- 隔离根会主动补齐 `sessions/`、`attachments/`、`spill/`、`.codem/skills/`；
- 两个环境变量同时存在：取 `CODEM_DATA_HOME` 并告警；
- 非标准位置：告警 + `storage_info` 暴露 `standard/reason`；
- 隔离根同样作用于 `runtime_log.rs`、`active-run.json`、`ofm.rs`。

### 2.2 `%APPDATA%\com.codem.app\`

| 路径 | 用途 |
|---|---|
| `codem-db-rust.bin` | Rust 引擎库（与旧 WASM `codem-db.bin` 刻意分开） |
| `codem-db-rust.bin-wal` / `-shm` | WAL / 共享内存 |
| `codem-db-rust.bin.corrupt-<ts>[,-wal,-shm]` | 判损坏时整组改名备份 |
| `sessions/<sid>.jsonl` | 权威会话日志 |
| `attachments/<id>-<name>`（+ `.tmp`） | 外置附件正文（>64 KB；DB 存 `file:<路径>`） |
| `spill/<sid>/<tool>-<id>-<ms>.txt\|.bin` | 超大工具结果溢出；默认保留 14 天 |
| `.codem/skills/` | 技能安装目录 |
| `workspace/` + `AGENTS.md` | 全局对话默认工作目录 |
| `extensions/our-free-model/` | 免费模型插件（独立 Node 进程与数据） |
| `data-home.json`（+ `.tmp` / `.corrupt-*`） | 数据目录台账 |
| `codem-index-rebuild-needed.json` | 索引重建标记（自愈入口） |
| `codem-runtime-YYYY-MM-DD[.N].log` | Rust 运行日志（4 MB/段、24 MB 目录、14 天、脱敏） |
| `codem-crash.log` | panic 现场 |
| `active-run.json` | 崩溃检测标记（正常退出删除） |
| `codem-db.bin` | 旧 WASM 库（迁移源，只读打开） |

**不在数据根内**：`~/.codem/settings.json`、`<项目>/.codem/settings.json`、`.codem/settings.local.json`；插件自己的 `settings.json`（`extensions/our-free-model/`）。其余功能目录是否跟随隔离根是产品决策（`data-root.ts` 刻意不跟随）。

---

## 3. SQLite：40 张实表

> `schema.sql`：`CREATE TABLE` ×40、`CREATE INDEX` ×44、`CREATE TRIGGER` ×3；`tables.json` 同列 40 名；`migrations.json` 29 条 ALTER。
> 另有 `session_fts`（FTS5 虚拟表）、`storage_audit`（审计表）、3 个会话级联触发器。

### A. 会话 / 消息 / 事件（11）

| 表 | 用途 | 关键列/说明 |
|---|---|---|
| `projects` | 项目 | `id/name/path/description/pinned/created_at/last_accessed_at`；`""` 行是“全局对话”种子 |
| `sessions` | 会话目录 | `id/project_id/title/model/created_at/last_message_at/message_count/pinned/is_internal`；+迁移列 `parent_id/sort_order/execution_mode/worktree_path/worktree_branch/correction_mode/deep_thinking_mode/preserve_executor` |
| `messages` | 消息索引 | `id/session_id/role/content/reasoning/timestamp/model/tokens/cost/status/generated_files`；+迁移列 `retrieved_sources/parent_message_id/metadata/hidden/trimmed` |
| `context_epochs` | 检查点派生索引 | `id/session_id/seq/cutoff_message_id/removed_count/kept_count/trigger_kind/created_at`；权威仍是 marker metadata，表只供查询/审计 |
| `tool_calls` | 工具调用 | `id/message_id/tool/args/result/status/metadata`（args/result/metadata 为 JSON 文本） |
| `attachments` | 附件元数据 | `id/session_id/message_id/name/type/path/content/preview/sandbox_path/mime_type/size/added_at`；`content` 内联或 `file:` 外置 |
| `message_feedback` | 赞/踩 + 备注 | `feedback CHECK('like'\|'dislike')`、`note/version/created_at/updated_at` |
| `session_events` | append-only 事件 | `seq AUTOINCREMENT/session_id/event_type/payload/timestamp`；`idx(session_id,seq)` |
| `turn_file_changes` | 回合文件变更 | `before_tree/after_tree/patch/patch_sha256/changed_files/current_brief/status` |
| `needs_you_pending` | “待你确认”提问 | 无外键；触发器级联；**当前模块零读写，队列在内存** |
| `agent_messages` | 智能体间消息 | 触发器级联；**当前模块零读写** |
| `v2_sessions` | 历史整会话 JSON | `messages/total_usage` 为 JSON 文本；仅迁移/测试触及 |

### B. 恢复 / 草稿 / 待办（3）

| 表 | 用途 |
|---|---|
| `recovery_data` | `PK=session_id` 的恢复快照（`settings.ts:726`） |
| `prompt_drafts` | 提示词草稿/版本 |
| `todo_lists` | Todo 列表（`todos` JSON） |

### C. 知识库 / 笔记 / 图谱（10）

| 表 | 用途 |
|---|---|
| `notebooks` | 笔记本（名称/描述/摘要/来源数/分块数） |
| `notebook_sources` | 来源（PDF/DOCX/文本/URL；`status/chunk_count/error_message`） |
| `notebook_chunks` | 分块 + `embedding BLOB` + token 数 |
| `notes` | Markdown 笔记（`content/tags/pin_order`） |
| `note_links` | 笔记双链 |
| `note_versions` | 笔记版本历史 |
| `flashcards` | 闪卡（SM-2：`ease_factor/interval_days/repetitions/next_review`） |
| `graph_nodes` | 知识图谱节点（`entity_type/description/source_ids/chunk_ids/community_id`） |
| `graph_edges` | 图谱边（`relation_type/weight`；无唯一约束） |
| `notebook_groups` | 笔记本分组（自引用 `parent_id`） |

### D. 任务 / 团队（7）

| 表 | 用途 |
|---|---|
| `squads` | 团队模板（leader/instructions/project/archived） |
| `squad_members` | 成员（agent/role） |
| `issues` | 结构化任务（status/priority/assignee/project/squad/session/labels） |
| `issue_comments` | 评论（author/is_system） |
| `inbox` | 全局通知（category/source/read/archived/priority） |
| `delegation_tasks` | 跨会话委派（source/target/task/status/result/project；4 索引） |
| `goals` | 目标（status/priority/parent/success_criteria；自引用） |

### E. 配置 / 凭据 / 账号（6）

| 表 | 用途 |
|---|---|
| `settings` | `key/value/updated_at`，一行一键 |
| `mcp_servers` | MCP 服务器配置（JSON） |
| `quick_phrases` | 快速短语（category/usage_count） |
| `accounts` | 账号（`access_token/refresh_token` 明文列） |
| `agent_profiles` | Agent 画像（identity/domain/scope/skills/experience） |
| `memory` | 实际只有 `id='default'` 一行；真正记忆在 `settings` JSON |

### F. 成本 / 遥测（2）

| 表 | 用途 |
|---|---|
| `cost_records` | 每次调用 token/成本/时长；孤儿由触发器清理 |
| `telemetry_events` | turn/tool/错误事件；按水位裁剪 |

### 虚拟表 / 审计

- `session_fts`：FTS5，列 `session_id/message_id/timestamp UNINDEXED` + 正文；tokenize `unicode61`；只在缺失时创建，老库保持 FTS4；中文靠 bigram。
- `storage_audit`：对 9 张表装 AFTER DELETE/UPDATE 触发器；每次打开重装。
- 3 个会话级联触发器：`needs_you_pending` / `agent_messages` / `cost_records`。

> **“38 表”口径**：`docs/STORAGE-INVENTORY.md` 的“涉及表 38”是 P0 扫描**渲染侧 SQL 调用点**的结果，不是 schema 计数。它 = 39 − `needs_you_pending` − `agent_messages` + `session_fts`。`health.tables` 走 `sqlite_master` 计数，会把 FTS5 影子表与 `storage_audit` 算进去，新库约 45（推断，未实测）。

---

## 4. 核心数据模型（TypeScript）

| 类型 | 字段 | 位置 |
|---|---|---|
| `Message` | `id/role/content/reasoning?/timestamp/model?/toolCalls?/attachments?/status?/generatedFiles?/retrievedSources?/metadata?` | `src/store.ts:63` |
| `MessageAttachment` | `id/name/type(file/image/code/url/video/audio)/content?/preview?/mimeType?/size?/sandboxPath?` | `store.ts:80` |
| `ToolCall` | `id/tool/args/result?/status/metadata?` | `store.ts:93` |
| `RetrievedSource` | `sourceId/sourceName/chunkIndex/snippet/score` | `store.ts:55` |
| `Session` | `id/projectId/title/createdAt/lastMessageAt/messageCount/model?/attachments?/pinned?/worktreePath?/executionMode?/worktreeBranch?/correctionMode?/deepThinkingMode?/preserveExecutor?/parentId?/isInternal?` | `core/types.ts:11` |
| `Project` | `id/name/path/createdAt/lastAccessedAt/description?/pinned?` | `types.ts:1` |
| `SessionEvent` | `seq/sessionId/type/payload/timestamp` | `storage/event-types.ts:283` |
| `DelegationTask` | `id/source/target/task/status/result?/error?/projectId/createdAt/startedAt?/completedAt?/squadId?/memberId?/progress?/waitedMs?` | `session/types.ts:38` |
| `MessageRow`（线协议） | `id/session_id/role/content/reasoning/timestamp/model/prompt_tokens/completion_tokens/cost/status/generated_files/retrieved_sources` | `storage/message.ts:66` |
| `JsonlMessageRecord` | `v/id/sessionId/role/content/reasoning?/timestamp/model?/status?/toolCalls?/generatedFiles?/retrievedSources?/attachments?/metadata?/hidden?/trimmed?/deleted?` | `session-jsonl.ts:108` |

> `messages` 的实列 = schema 28–42 + 迁移列；`MessageRow` 只覆盖一部分。结构化字段（`generated_files`、`retrieved_sources`、`metadata`、`tool_calls.args/result/metadata`、`v2_sessions.*`）都是 JSON 文本列。

---

## 5. 写入路径与一致性

### 5.1 单写者与事务

- Rust 侧一个 `Mutex<Connection>`；所有写走 `Engine::write_tx`（`BEGIN → 闭包 → COMMIT/ROLLBACK`）；
- 导入事务期间拒绝普通写；
- 复合命令 `messages.upsert_index` 一个事务写主行 + 两个 JSON 列 + 整批替换 `tool_calls`；
- `messages.rebuild_index` 重建。

### 5.2 PRAGMA / authorizer

```text
journal_mode=WAL
synchronous=NORMAL
busy_timeout=5000
foreign_keys=ON
temp_store=MEMORY
auto_vacuum=INCREMENTAL（空库最先设置）
```

- **IPC 不接受裸 SQL**：`storage_invoke` 只接受命令白名单（78 条）；未登记 = `UNSUPPORTED`。
- authorizer 拒绝：`ATTACH/DETACH`、`load_extension`、`writable_schema` 读写、12 个危险 PRAGMA 写（读放）；
- `storage.compact` 走 VACUUM 且临时摘 authorizer。

### 5.3 软删三态

| 参数 | 行为 |
|---|---|
| `soft: true` | `hidden=1`（压缩） |
| `trim: true` | `hidden=1, trimmed=1`（索引裁剪，行保留） |
| 缺省 | 硬删 + 级联 |

- 硬删净影响 > 50 行须 `confirm_bulk`；
- 判定收口：`hiddenFlagOf/trimmedFlagOf/isRecordHidden/isCompressedHidden`；
- 矛盾态 `hidden=0,trimmed=1` 是可能的（repo 不禁止）。

### 5.4 计数

- 引擎 `MAX(0, message_count + delta)`，夹断回 `count_clamped`；
- 重建按索引行数，不按日志行数；
- 渲染侧 `updateSession` **刻意不回写** `message_count`（单一写入者）；
- 维护任务对账。

### 5.5 崩溃自愈

```text
打开前检查坏 WAL → 备份
open 判 Corrupt → 三件套改名备份 + 抢救项目归属 + 建新库
→ health 上报 → 写 codem-index-rebuild-needed.json
→ 维护先重建索引，再从 JSONL 回填/裁剪
→ 主动对账「索引行数 < 日志唯一 id 数」⇒ 当场重建
→ 会话墓碑可作废
```

### 5.6 附件 / spill

- 附件 > 64 KB 外置到 `attachments/<id>-<name>`；DB 存 `file:<路径>`；
- 大工具结果落 `spill/<sid>/`，默认保留 14 天；
- 消息镜像预算：3 个会话；`notebook_chunks` 上限 2000 行。

---

## 6. 设置与凭据

### 6.1 两种形态

- **块**：`codem-settings` 一个 JSON 键，含 `providers[]`、UI 偏好等；
- **扁平键**：`codem-policy`、`codem-secrets-plaintext`、`codem-storage-migrated-at`、`codem-fts-bigram-rebuilt`、`codem-invariant-watermark`、`codem-free-model-health`、`codem-disabled-tools` 等。

### 6.2 文件分层（不落 DB）

优先级：`cli > policy > flag > user > project > local > default`。
路径：`~/.codem/settings.json`、`<项目>/.codem/settings.json`、`.codem/settings.local.json`。

### 6.3 凭据封存

- 格式 `dsh1:<hex>`；Windows 裸 FFI DPAPI，密文绑当前用户/机器；未知版本 `UNAVAILABLE`；
- 三条规则：不可用不降级；迁移全成或不动；解封失败保留密文；
- 回退明文需显式打开 `codem-secrets-plaintext`；
- 启动水合：`secret_unseal` → 内存缓存；设置面读出后才打标记；
- **唯一水合点**：`getSettingJSON("codem-settings")` 把 `providers[].apiKey` 换成缓存明文，磁盘不动；
- **写收口**：`setSettingJSON` → `gateSettingsWrite` 同步回封（原密钥换回自己的密文；新密钥先落盘再异步补封存）；
- **导出脱敏**：键名 + 值形状（`credential-shapes.ts`），只替换+计数，不打印值；记忆导出同口径。

> 重要：**原始库里 `apiKey` 是空串不代表用户没填**。判断有没有 Key 要走设置层水合。

---

## 7. 迁移与维护

### 7.1 schema / 迁移

- 无 `PRAGMA user_version`：40 条 `CREATE IF NOT EXISTS` + 29 条 `ALTER` 容忍重复列；
- 种子：`projects` 的 `""` 行、`last_message_at` 只抬不降回填；
- 列级一致由 `tools/audit/gen-schema-sql.mjs --check` 守；
- 旧库迁移：目标库有消息则拒绝（除非 force）；旧库只读、不用 quick_check（FTS4 只读会失败）；逐表行数 + 列清单 + 多重集摘要对账；孤儿过滤；
- 渲染侧触发：新库 core 四表全空 + 旧库有内容 + 无标记。

### 7.2 维护任务（`runDatabaseMaintenance`）

```text
索引重建标记 → 落后对账 → 日志回填 → 索引裁剪（keep 500，软删 trim）
→ 附件预热/孤儿清理 → 日志压缩 → 遥测裁剪（7 天）→ 审计裁剪/规模
→ storage.compact → 完整性检查（节流）→ 文本事件去重
→ 内部会话回填 → 计数对账 → 不变量审计
```

启动维护延迟 30 秒，避开首屏与首条输入；24 小时间隔按 elapsed 计，不按本地日历日。

### 7.3 备份 / 校验 / 回收

- 损坏库改名备份；坏 WAL 打开前备份；
- `PRAGMA quick_check`（命令 `storage_integrity_check`）；
- `storage.compact` = VACUUM（临时摘 authorizer）；
- `storage_checkpoint` = `wal_checkpoint(TRUNCATE)`。

### 7.4 只读钻取

`tools/maintenance/read-only-db.mjs` 是**库**，不是 CLI；它复制 `.bin` + `-wal` + `-shm` 到临时目录，再让调用方读副本：

```js
import { withReadOnlyDb } from "../../tools/maintenance/read-only-db.mjs";
const { result, changes } = await withReadOnlyDb(REAL_DB, (db) =>
  db.prepare("select count(*) as n from messages").all()
);
// changes 必须为空；非空会抛 ReadOnlyDbTouchedError
```

- 不要直接“只读打开”真库：会更新 `-shm` 的 mtime（内容不变但仍是痕迹）。
- 临时手工查看：先把三件套复制到临时目录，再对**副本**用 `codem-db-cli --db <副本>`；
- `codem-db-cli --db <path>` 是**读写打开**（会 apply schema/装触发器）；读旧库必须走 `legacy.read_table`（内部 READ_ONLY）。对旧库用 `--db` 可能毁掉唯一回滚副本。

---

## 8. 风险与已知缺口

1. **`session_events` 只增不减、无 TTL**：含不可重建信息，维护刻意不压缩；长会话库会持续增长。
2. **`needs_you_pending` / `agent_messages` 有表无实现**：模块零读写，队列实际在内存；也是“38 vs 39”差 2 的来源。
3. **渲染侧重复 DDL**：`event-log.ts:175` 的 `EVENT_SCHEMA` 零引用，与 Rust 真源并存。
4. **`message_count` 多口径**：引擎增量、重建按索引行数、渲染侧不回写、维护对账；`session.ts` 注释引用的 `repo.rs::bump_session_message_count` 实际不存在（文档漂移）。
5. **“未预热即拒绝写”是静默失败面**：`config.set` 会直接丢弃；记忆域双重就绪判据。
6. **数据根仍有两个来源**：库/日志/附件/溢出走 `resolveDataRoot`，但 `legacyDbPath` 只认 `getAppDataDir`；设置文件在 `~/.codem` 与项目 `.codem`。
7. **`codem-db-cli --db` 会改文件**：对旧库 = 毁回滚副本。
8. **镜像预算可把“读不到”伪装成“没内容”**：消息镜像 3 会话、`notebook_chunks` 2000 行；未就绪/截断必须显式报。
9. **软删三态易再分叉**：`hidden=0,trimmed=1` 是矛盾态；判定曾因“数字比布尔”从未生效。
10. **中文 FTS 依赖一次性重建标记**：迁移来的 FTS4 老库不重建则中文恒 0 条。

---

## 9. 改存储时的检查清单

- [ ] schema 改了：`schema.sql` + `migrations.json` + `tables.json` + `schema.rs` 种子，跑 `gen-schema-sql.mjs --check`。
- [ ] 新增仓储命令：`codem-db/lib.rs` 的 `COMMANDS` 白名单 + `repo.rs` 实现 + 前端 `rust-port.ts` + 契约测试。
- [ ] 新增表：检查 `scan-unrouted-db.mjs`（有没有表没人读/写）、`storage-boundary`（渲染侧不许裸 SQL）。
- [ ] 新增列：老库 `ALTER` 幂等；`MessageRow` / 映射函数同步；migration 对账。
- [ ] 删除/软删：`confirm_bulk`、墓碑、FTS、镜像、事件日志、会话计数。
- [ ] 凭据：只走 `setSettingJSON`；不要在日志/导出/错误里打印明文。
- [ ] 测试：`npm run db:test`（Rust 金样本 `wire-fixtures.json`）必须真跑；`WIRE-0` 会检查最近是否真跑过。
