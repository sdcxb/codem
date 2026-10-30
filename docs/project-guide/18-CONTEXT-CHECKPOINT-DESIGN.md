# 18 · 上下文检查点与完整历史（设计稿）

> **状态**：设计稿，2026-10-30；G0 核心已落地：读侧 cutoff 契约、marker metadata 写入、压缩检查点（不再软删/隐藏）、**主对话默认完整时间线 + 模型视图切换**、完整历史面板（含只读模型视图）、旧 hidden 回填 API/入口、回滚 API、spill 永久化、水位计入 system 提示与工具定义（引擎就绪时）。隔离真机冒烟已验证 278 历史/61 模型、回填 117+100/失败 0、reload 后保留；**未做**：安装器安装后的同一流程、索引重建/回滚演练、`context_epochs` 独立表。基线 1.16.333。
> **目标**：一次性做到终态——压缩不再删除/隐藏历史；人看完整时间线；模型/Agent 看「最新检查点 + 其后消息」；水位与模型视图同源；工具正文永久保留；旧数据 best-effort 迁移；提供一次性回滚迁移。
> **配套**：[19-CONTEXT-CHECKPOINT-CRITERIA.md](docs/project-guide/19-CONTEXT-CHECKPOINT-CRITERIA.md)（判据与施工清单）。
> **相关**：[03-RUNTIME-FLOWS.md](docs/project-guide/03-RUNTIME-FLOWS.md)（压缩/读路径）、[06-DATA-STORAGE.md](docs/project-guide/06-DATA-STORAGE.md)（JSONL/索引）、[08-ENGINEERING-GATES.md](docs/project-guide/08-ENGINEERING-GATES.md)（门禁）、[09-CURRENT-STATE.md](docs/project-guide/09-CURRENT-STATE.md)（基线）。

---

## 0. 决策记录

| 项 | 决策 | 说明 |
|---|---|---|
| 压缩语义 | **检查点，不删除、不隐藏** | 只写 summary marker + `context_epochs`；旧消息永远在时间线里 |
| 模型视图 | 最新 epoch 的 marker + `cutoff_message_id` 之后的消息 | 不用 timestamp、不用 marker 位置做边界 |
| 人的视图 | **完整时间线**，含旧 hidden/trimmed | 主对话默认完整历史；另有只读「模型视图」切换 |
| 水位 | 与模型视图同源，同批交付 | 完整 ContextView：system/tools/reasoning/content/tool args/results |
| 工具输出 | **全部永久** | `spill/` 不再按 14 天自动删；删会话则删其 spill |
| 旧会话 | best-effort 迁移 + 不可恢复报告 | 索引 hidden 行能救的救；索引已重建/正文已丢的如实报 |
| 回滚 | **一次性回滚迁移** | cutoff 之前写回 hidden，让旧版本按 visible 视图运行 |
| 中间态 | **不发布** | 内部 G0–G3 门禁，不对外分阶段 |

---

## 1. 问题与现状

### 1.1 当前压缩是破坏性的

- `doCompactMessages` 先写 marker，再 `deleteMessagesByIds`（[agentic-loop.ts](src/core/llm/agentic-loop.ts#L6503-L6512)）。
- `deleteMessagesByIds` 同时做四件事：索引 `hidden=1`、权威日志写墓碑、删 FTS、清日志镜像（[message.ts](src/core/storage/message.ts#L3410-L3487)）。
- JSONL 回放遇到墓碑会丢掉该 id（[session-jsonl.ts](src/core/storage/session-jsonl.ts#L712-L719)）；日志压缩只保留每个 id 的最后一行（[session-jsonl.ts](src/core/storage/session-jsonl.ts#L1012)）⇒ 旧正文最终被物理丢弃。
- `listMessagesMerged` 统一排除 hidden（[message.ts](src/core/storage/message.ts#L571-L707)）；UI、Agent、fork、导出、搜索共用这条读路径，所以「人看的那套」不存在。

### 1.2 现在是三套口径，不是两套

| 口径 | 实际集合 | 差异 |
|---|---|---|
| 压缩触发 | `buildMessages` 结果 + TokenTracker actual usage | 不是最终请求；reasoning/system/tools 只间接计入 |
| 水位/面板 | `listVisibleMessages` → `estimateRawContextTokens` → fold | 不含 reasoning/system/tools/select/pairing/micro |
| 最终请求 | `system + processedMessages + tools` | 唯一真实集合 |

证据：[water-level.ts](src/core/context/water-level.ts#L134-L177)、[compaction-budget.ts](src/core/llm/compaction-budget.ts#L753-L777)、[message.ts](src/core/storage/message.ts#L4170)。

### 1.3 工具正文会被 spill 清理

- 超大工具结果落 `spill/<sid>/`，`pruneSpillFiles` 默认 14 天删除（[spill.ts](src/core/storage/spill.ts#L160-L238)）。
- 消息里只有 preview + locator；全文只在 spill 文件里。
- 因此「工具输出全部永久」必须同时改 spill 保留策略，不能只做 B。

### 1.4 文档与代码不一致

[16-MCODE-STACK-AUDIT.md](docs/project-guide/16-MCODE-STACK-AUDIT.md#L43-L49) 声称「压缩只改模型视图、用户历史不动——通过」；按用户可读路径看不成立。本设计把这句变成真正的不变量。

---

## 2. 目标与非目标

### 2.1 目标

1. 压缩不删除、不隐藏任何消息；重启、索引重建、日志压缩后完整历史仍在。
2. 模型/Agent 只看「最新检查点 + cutoff 之后」；旧消息不会泄漏进模型上下文。
3. 水位与 ContextView 同源；reasoning/system/tools 按实际请求口径计入；raw/final 分开。
4. 主对话默认完整时间线；检查点卡可见；另提供只读「模型视图」。
5. 工具正文永久；spill 不自动过期；磁盘可观测；不静默删。
6. 旧会话 best-effort 迁移；不可恢复如实报告；不伪造「已恢复」。
7. 一次性回滚迁移可用；回滚后旧版本能按 hidden 视图运行。
8. 搜索/导出/fork 默认完整历史；子代理/委派/记忆/标题明确读 ContextView 或 DisplayView。

### 2.2 非目标

- 不做云端同步/多端一致。
- 不改变「用户主动删除消息/会话」的破坏性语义（这是唯一允许的删除）。
- 不把完整历史自动喂给模型；模型检索是后续可选能力，不在本设计范围。
- 不保留旧的 hidden/tombstone 压缩写路径作为长期双写；只在回滚迁移里使用。

---

## 3. 终态架构

```text
JSONL 权威时间线（全量消息、思考、工具调用）
  ├─ context_epochs（marker + cutoff_message_id + seq）
  │     ├─ ContextView = 最新 epoch 的 marker + cutoff 之后的消息
  │     │     ├─ 模型 / Agent / 子代理 / 委派 / 记忆
  │     │     └─ 水位（system + tools + reasoning + content + tool args/results）
  │     └─ 模型视图（只读排障）
  └─ DisplayView = 全部消息（含旧 hidden/trimmed）
        ├─ 主对话完整时间线 + 检查点卡
        ├─ 搜索 / 导出 / fork
        └─ 工具全文按 locator 从永久 spill 读取
```

### 3.1 术语

| 术语 | 含义 |
|---|---|
| Timeline | 全量消息序列，按 `timestamp, id` 排序；权威在 JSONL，索引可重建 |
| Epoch | 一次压缩产生的检查点；含 summary marker、cutoff、seq、计数 |
| ContextView | 模型可见集合：最新 epoch 的 marker + cutoff 之后的消息 |
| DisplayView | 人可见集合：完整 Timeline（含旧 hidden/trimmed） |
| ModelView | UI 的只读调试视图，展示 ContextView，不是第二个可编辑对话 |
| LegacyHidden | 旧压缩留下的 `hidden=1, trimmed=0` 行；迁移后作为 Display 历史 |

### 3.2 不变量

1. 压缩不写 hidden、不写墓碑、不删 FTS。
2. Epoch 的 cutoff 按 `cutoff_message_id` 定位，不用 timestamp/位置。
3. Marker/epoch 不可删除、不可编辑。
4. `listMessages` = ContextView；`listTimelineMessages` = DisplayView。
5. UI 不把 Timeline 放进 `useAppStore().messages`。
6. 水位只由 ContextView 计算；DisplayView 不计入。
7. 旧 hidden 行只在 DisplayView 出现；ContextView 按 cutoff 排除。
8. Epoch 缺失/不一致 ⇒ fail-open 全量 + 告警，不猜、不返回空。
9. 工具正文永久；spill 不按时间自动删。
10. 只有用户主动删除消息/会话才写墓碑。

---

## 4. 数据契约

### 4.1 `context_epochs` 表

```sql
CREATE TABLE IF NOT EXISTS context_epochs (
  session_id          TEXT NOT NULL,
  epoch_id            TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  summary_message_id  TEXT NOT NULL,
  cutoff_message_id   TEXT NOT NULL,
  removed_count       INTEGER NOT NULL,
  kept_count          INTEGER NOT NULL,
  trigger             TEXT NOT NULL,
  policy_json         TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_epochs_session_seq
  ON context_epochs(session_id, seq);
```

- `seq` 每会话单调递增；最新 epoch = max(seq)。
- `cutoff_message_id` 必须是 Timeline 中真实存在的消息 id；缺失时 fail-open + 告警。
- 表是**索引/查询缓存**；JSONL 里的 marker metadata 是权威。索引重建时从 marker 恢复；表丢了不丢语义。

> **实现说明（2026-10-30）**：当前版本**没有建这张表**。`listMessages` 是同步读，
> 不能为取 epoch 发异步 IPC；实际做法是把 `messages.metadata` 补进消息索引投影与镜像，
> marker 的 `metadata.contextEpoch` 随索引同步返回。表仍可作为后续的审计/多 epoch 查询索引，
> 但不是当前读路径的前置条件。相应地，`19` 里的 Rust `context_epochs` 判据属于“若建表”分支。

### 4.2 Marker metadata（JSONL 权威）

summary marker 仍是一条 `role=user` 的机器消息，id 前缀 `compact-` / `compact-manual-`，metadata 增加：

```json
{
  "contextEpoch": {
    "epochId": "compact-1750000000000-1",
    "seq": 3,
    "cutoffMessageId": "assistant-...",
    "removedCount": 239,
    "keptCount": 23,
    "trigger": "auto",
    "createdAt": 1750000000000
  }
}
```

- `isCompactionMarker` 仍可用于显示识别；**cutoff 判定必须同时校验 id 前缀 + metadata + epoch 表**，不能只靠正文前缀（用户粘贴可伪造）。
- 旧 marker 无 metadata：迁移时补 epoch；无法补的按 hidden/事件推导，并标记 `legacy: true`。

### 4.3 Message / ToolCall / Spill 字段

- 消息新增可选 `contextState`（读模型字段，不落库）：`visible | compacted | legacy-hidden | index-trimmed`。
- ToolCall metadata 增加：

```json
{
  "spill": {
    "locator": "C:\\...\\spill\\<sid>\\bash-call-1-1750000000000.txt",
    "bytes": 123456,
    "sha256": "...",
    "createdAt": 1750000000000,
    "complete": true
  }
}
```

- `complete=false` 表示当时落盘失败、消息里是内联全文；查看器不得再去找 spill。
- spill 文件缺失/损坏：查看器显示「工具正文不可读」，不是空结果。

### 4.4 Marker 保护

- `deleteMessage` / `deleteMessagesBefore` / regenerate / 清空更早上下文：遇到 marker/epoch 目标必须拒绝，或改写为「新建检查点」。
- UI 不提供删除/编辑 marker 的入口。
- 判据：删除 marker 的尝试必须失败且可见，epoch 表与 JSONL 保持一致。

### 4.5 Schema / 命令 / 门禁

若新增 `context_epochs` 表：

1. `src-tauri/codem-db/sql/schema.sql`；
2. `migrations.json` 幂等 `ALTER`（首次建表走 schema）；
3. `tables.json` 同步；
4. `repo.rs` 仓储方法；
5. `codem-db/lib.rs` `COMMANDS` 白名单；
6. `rust-port.ts` 端口方法 + 类型；
7. `npm run db:test`、`gen-schema-sql.mjs --check`、`check-command-parity.mjs`；
8. 契约测试与 `wire-fixtures.json`。

---

## 5. 压缩协议

### 5.1 写序

1. 计算保留集与摘要（现有 `planCompactionKeep` / summary 逻辑保留）。
2. 生成 marker（含 metadata.contextEpoch）。
3. **严格写 marker**：append → flush → 读回校验（id/内容/metadata）。
4. 写 `context_epochs`（失败可重建，不阻断；但必须上报）。
5. 写 `compaction` 事件（失败不阻断，但必须上报）。
6. **不隐藏、不删除任何消息。**

### 5.2 自动与手动共用

- 抽 `commitCompaction(sessionId, plan, marker)`；自动（`agentic-loop`）与手动（`ContextMonitor`）共用，防止两套逻辑漂移。
- 压缩锁仍按会话；手动/自动并发仍拒绝。

### 5.3 失败矩阵

| 失败点 | 结果 | 模型 | 显示 | 处理 |
|---|---|---|---|---|
| marker 写失败 | 无 epoch、无删除 | 旧上下文 | 不变 | 中止，报错，可重试 |
| marker 成功、表失败 | 有 epoch（JSONL） | 新 ContextView | 完整 | 表可由 marker 重建；上报 |
| marker 成功、事件失败 | 有 epoch | 新 ContextView | 完整 | 事件缺失；上报 |
| 进程在 marker 后崩溃 | marker 在、无删除 | 新 ContextView | 完整 | 重启后按 marker/epoch 恢复 |
| UI autosave 穿插 | 不应发生 | — | — | 压缩标志 + 严格写；测试覆盖 |
| marker 被删/改 | epoch 缺失 | **fail-open 全量** | 完整 | 拒绝删除；告警 |

### 5.4 幂等

- 同一 `epoch_id` 重复提交：表 `PRIMARY KEY` 幂等；marker 同 id 覆盖；事件按 `epoch_id` 去重。
- 重试不得产生第二个 cutoff 不同的 epoch；若已存在，返回既有 epoch。

---

## 6. 读路径

### 6.1 API

```ts
listTimelineMessages(sessionId, { before?, limit? }): Message[]
listContextMessages(sessionId): Message[]
```

- `listMessages` 保留为 `listContextMessages` 的兼容别名。
- `listVisibleMessages` 保留为 ContextView（现有调用方语义不变）。
- 新增 `listModelContextView(sessionId)` 供水位/调试返回结构体（含 epoch、cutoff、counts、estimate、sourceViewId）。

### 6.2 消费者分类

| 消费者 | 读 | 说明 |
|---|---|---|
| UI 主对话 / 历史 / 导出 / 用户搜索 | DisplayView | 完整时间线；不写回 `messages` |
| Agent `buildMessages` / 水位 / 压缩规划 | ContextView | 模型只看压缩后 |
| 记忆提取 / 标题生成 / 子代理 / 跨会话委派 / `query_session_result` | ContextView | 不把完整历史喂给模型 |
| fork | 两边都要 | 复制完整时间线 + epoch；子会话 ContextView 保留 cutoff |
| phone-link / 插件 `sessionPersistence.listMessages` | ContextView | 兼容现有语义；另提供 timeline API |
| 事件投影 / 不变量检查 | 明确按用途 | 事件侧与消息侧分开，不混用 |

### 6.3 旧 hidden 与 fail-open

- DisplayView 含 `hidden=1, trimmed=0` 的旧压缩行；`trimmed=1` 的索引裁剪行也显示（正文来自日志）。
- ContextView 先按最新 epoch cutoff 排除；cutoff 之后若仍有旧 hidden（异常），再按 hidden 过滤。
- 没有 epoch：
  - 有旧 hidden：按旧 hidden 规则（兼容模式）；
  - 没有 hidden：返回全量并告警（fail-open；模型可能变大，但不静默丢）。
- 不能返回空，除非会话确实没有消息。

### 6.4 计数与 FTS

- `message_count` 拆为：`total`（全部）、`visible`（模型可见）、`compacted`（cutoff 之前）、`trimmed`（索引裁剪）。
- 侧栏未读不能直接用 `message_count` 含 hidden 的口径；单独用 Display 已读水位。
- FTS：压缩不再删 FTS；完整历史可搜；模型搜索工具对 cutoff 之前的命中标注「已压缩」，是否过滤由工具契约决定。

---

## 7. 水位

### 7.1 三套口径必须收口

- 触发、水位、最终请求必须共享 `ContextView` 的估算；
- `buildMessages` 与水位用同一个 builder，水位返回 `sourceViewId`；
- 估算按 `toAPIMessage` 后的字段：system、tools、content、reasoning、tool_calls arguments、tool result content、多模态块。

### 7.2 raw 与 final

- **raw model-context**：未做 priority select / micro-compact 的模型可见内容；用于水位与压缩触发。
- **final request**：实际发出的 `system + messages + tools`；用于调试/对账。
- 主显示 raw；final 作为副读数。
- 不 clamp >100%：显示 `>100% + 超出 N`，否则长会话会恒 100%。

### 7.3 UI 标签

- 主视图：`模型上下文 58%`（一个百分比）。
- 历史视图：`模型可见 23 条 / 历史总数 262 条（不计入水位）`。
- 不再把「上下文将满」挂在历史条数上。

---

## 8. Spill 永久化

### 8.1 现状

- `pruneSpillFiles` 默认 14 天删除；判据 `SPILL-6` 断言旧文件被清理（[spill.ts](src/core/storage/spill.ts#L160-L238)）。
- 消息里只有 preview + locator；全文只在 spill。

### 8.2 新契约

1. **不按时间自动删**；只清 `.tmp`。
2. 被消息引用的正文永久保留；孤儿清理必须显式、可审计，默认不跑。
3. **删会话 ⇒ 删该会话的 spill 目录**（用户显式删除 = 删该会话全部本地数据）。
4. 压缩永不触发 spill 删除。
5. 文件缺失/损坏：查看器显示不可读；不伪造全文。
6. 磁盘用量可见：数据根、spill、历史总量、阈值告警；磁盘满时写入失败可见，不静默删。

### 8.3 引用与完整性

- 在 ToolCall metadata 写 `spill`（locator/bytes/sha256/createdAt/complete）。
- 查看器按 locator 读全文；读前校验存在性/大小；可选 sha256 校验。
- 旧消息只有文本 locator：迁移时解析并补 metadata；无法解析的标记 `spillRefUnknown`。

### 8.4 旧 spill

- 升级前已被 14 天清掉的正文：不可恢复；查看器明确写「工具正文已被旧保留策略清理」。
- 仍在的旧 spill：保留，不自动删。

### 8.5 测试影响

- `SPILL-6` 改为：被引用/普通旧文件**不删**；`.tmp` 删；显式清理才删。
- 新增：会话删除清 spill；缺失文件可见；磁盘统计；manifest/metadata 往返。

---

## 9. 旧数据迁移

### 9.1 旧 hidden 行

1. 读 `messages.list { include_hidden: true }`；筛 `hidden=1, trimmed=0`。
2. 按 `session_events` 的 `compaction` 事件分组；无事件时按连续 hidden 段分组。
3. 在墓碑之后、cutoff 之前，把每条写成 JSONL **正常记录**（`hidden` 不写或写 0）；这一步让 Display 历史在索引重建后仍存在。
4. 用 marker/事件补 `context_epochs` 与 marker metadata；cutoff = 该 epoch 保留集的首条消息 id。
5. 不写墓碑、不改用户删除语义。

### 9.2 旧 marker

- 有 metadata：直接用。
- 无 metadata：从事件 `removedMessageIds` / 保留集边界推导 cutoff；无法推导的标 `legacyUncut`，ContextView 走旧 hidden 兼容模式并告警。

### 9.3 旧 spill

- 文件存在：保留；补 metadata（能解析 locator 的）。
- 文件缺失：记录 `missingSpill`，查看器显示不可读。

### 9.4 顺序与幂等

- 必须先部署 cutoff 读路径，再回填正常记录；否则回填的旧历史会进入模型。
- 回填在墓碑之后写，避免被回放丢弃。
- 幂等判据：manifest/epoch 存在 + 行数/id 集合/内容摘要校验通过；不能只看 id（墓碑 id 不算存活）。
- 分批、限速、可中断、逐会话报告；不阻塞启动。

### 9.5 不可恢复报告

- 索引已重建/清空，hidden 行不存在；JSONL 已是墓碑；事件只有 id/summary ⇒ 正文不可恢复。
- 报告粒度：会话、epoch、缺失条数、原因；不写「已恢复」。

---

## 10. 回滚迁移

### 10.1 触发

- 新版本在真机出现上下文错误、性能崩溃、数据不一致，且短时间无法修复。
- 回滚不是日常开关；是一次性迁移。

### 10.2 步骤

1. 停用新压缩写。
2. 取每个会话最新 epoch 的 `cutoff_message_id`。
3. 把 cutoff 之前的消息写回 `hidden=1`（并写 hidden 快照到 JSONL，保证旧版本重建一致）。
4. 旧版本按 `listMessages` 的 visible 视图运行。
5. 在副本库演练通过；记录每会话影响条数。

### 10.3 限制

- 回滚后 Display 历史仍可在旧版本里用 hidden 行查看（旧版本没有 viewer，但数据在）。
- 回滚迁移不是双向同步；再次升级需要重新迁移。
- 回滚脚本必须幂等、可中断、逐会话报告。

---

## 11. UI / UX

### 11.1 主对话

- 默认完整时间线；压缩点渲染为检查点卡：
  - `上下文压缩点 · 已折叠 N 条 · 模型从这里开始看`；
  - 摘要可展开；
  - 旧 marker 作为历史检查点。
- 顶部持久条：`历史 262 条 · 模型可见 23 条`；不依赖 3 秒横幅。
- 模型视图切换：只读，展示 ContextView；标注「模型看到的是这些」。

### 11.2 只读与动作

- 完整历史中的旧消息只读：编辑/重发/回退/重新生成/删除产出文件禁用。
- fork 从完整时间线分叉：复制到分叉点 + epoch；子会话 ContextView 保留 cutoff。
- 搜索/导出默认完整历史；模型视图可选。
- pin/搜索跳转：先加载目标块，再滚动；分母用 Display 总数。

### 11.3 性能

- 块级加载：首屏只挂检查点块头 + 最近消息；展开/搜索按 ≤50/100 条加载。
- 600/2000 条不能靠 10+20/300ms 翻页；不整读 JSONL。
- ScrollbarMarkers 不含 hidden/archived；MessageBubble memo 不被 unified 分组击穿。
- 600 条夹具只挂 ≤50 个 bubble。

### 11.4 计数与文案

- 主视图一个百分比；历史只报条数。
- 压缩回执从「移除 N 条」改「折叠 N 条（历史仍保留）」。
- 侧栏未读与 `message_count` 脱钩，避免把已压缩旧消息算成新消息。

### 11.5 可访问性与皮肤

- 完整历史视图/模型视图：`role=dialog` 或独立页面、`aria-modal`、Esc、焦点归还。
- 三皮肤 + 320/384/480/576/760 窄容器；CSS 契约 `--write`。
- 加载/错误/空态独立；分页读取失败不能显示「没有历史」。

---

## 12. 可靠性门禁

| Gate | 内容 | 通过条件 |
|---|---|---|
| G0 契约 | epoch/cutoff/marker 保护、读路径分类、迁移/回滚、spill 永久化 | 评审通过 + 迁移 dry-run |
| G1 影子对账 | 副本库上旧 hidden 视图 vs 新 ContextView 逐会话比对 | 差异 0 或有解释 |
| G2 UI/性能 | 完整时间线、检查点卡、模型视图、块级加载、三皮肤 | 组件/性能/a11y 判据通过 |
| G3 真机/回滚 | 打包安装、旧库迁移、重启/索引重建、回滚演练、spill 全文可读 | 真机读数 + 回滚成功 |

---

## 13. 风险与开放问题

| # | 风险 | 缓解 |
|---:|---|---|
| 1 | 读路径漏改，模型看到完整历史 | 消费者分类表 + 假 provider 判据 + G1 影子对账 |
| 2 | marker/epoch 被删除，cutoff 丢失 | 删除路径拒绝 + fail-open + 告警 + 测试 |
| 3 | 旧 hidden 回填顺序错误，复活/泄漏 | 墓碑之后写、cutoff 先上线、幂等校验 |
| 4 | 旧 spill 已清理，工具正文缺失 | 如实报告；查看器标注；不伪造 |
| 5 | 磁盘无限增长 | 用量监控 + 显式清理 + 容量告警；不静默删 |
| 6 | 水位口径改动导致压缩更频繁 | 单独判据 + 真机读数；raw/final 分开 |
| 7 | UI 性能/分页退化 | 块级加载 + 600/2000 夹具 + 不整读 |
| 8 | 回滚迁移不可用 | G3 副本演练；逐会话报告 |

---

## 14. 未决项

- `context_epochs` 是否必须建表，还是 marker metadata + 派生缓存即可（本设计倾向前者，表是索引不是权威）。
- 旧 marker 无 metadata 时，cutoff 推导的精度与告警口径。
- 模型搜索工具对「已压缩」命中的默认策略（返回并标注 vs 过滤）。
- 完整历史视图是否允许 feedback（建议允许，但逐条懒加载）。
- 工具正文 sha256 校验是否默认开启（建议读时校验，失败标注）。
