# 19 · 上下文检查点：判据与施工清单

> **状态**：配套 [18-CONTEXT-CHECKPOINT-DESIGN.md](docs/project-guide/18-CONTEXT-CHECKPOINT-DESIGN.md) 的判据/施工清单，2026-10-30；G0 核心已落地（`context-view-cutoff` 10 条、时间线 4 条、迁移 3 条、回滚 2 条、完整历史面板 5 条、分块 3 条、epoch 表 3 条；主对话默认完整时间线；水位真实请求优先；打开会话自动回填；隔离真机：安装后 278/61、回填 117+100/0、reload 保留、索引重建 278/hidden 217/模型 61、合成回滚 2/0、spill 目录 UI 删除与缺失查看均通过；完整历史与主对话可视区虚拟列表（主对话 >160 条启用，未知视口 fail-open）；全量 796 文件 / 8842 用例 8825 通过 / 17 skipped / 0 失败）。基线 1.16.334。
> **纪律**：先写判据 → 变异自证 → 真机验证；判据只许收紧，不许放宽。
> **目标**：把「压缩不删历史 + 模型看检查点 + 水位同源 + 工具正文永久 + 旧数据迁移 + 回滚」拆成可执行、可判红的清单。

---

## 0. 使用方式

1. 先做 G0 契约评审；未通过不写实现。
2. 每条判据先红后绿；每条关键判据至少做一次变异（把实现改坏必须红）。
3. 存储/迁移类判据必须能在**副本库**上复跑，不碰真库。
4. UI 判据必须覆盖三皮肤、窄容器、可访问性；性能判据用固定夹具。
5. 真机取证单独记录版本、构建时间、PID、数据根、操作序列、读数。

---

## 1. 判据层级

| 层 | 位置 | 说明 |
|---|---|---|
| 纯函数/单元 | `src/test/*.test.ts` | epoch/cutoff、ContextView、水位估算、spill 策略 |
| 存储/集成 | `src/test/*.test.ts` + 假端口/假 provider | 压缩协议、JSONL/索引重建、迁移、回滚 |
| Rust 契约 | `src-tauri/codem-db/tests/*.rs` + `wire-fixtures.json` | `context_epochs` CRUD/分页/重建 |
| 组件/真 DOM | `src/test/*.test.tsx` | 完整时间线、检查点卡、模型视图、只读动作 |
| 真渲染探针 | `src/test/fixtures/*-probe.html` | 600/2000 条性能、滚动标记、窄容器 |
| 真机 | 打包 exe + 隔离数据根 | 迁移、重建、回滚、spill 全文、磁盘 |

---

## 2. 纯函数/单元判据

### 2.1 `context-epoch-cutoff.test.ts`

| 用例 | 断言 |
|---|---|
| EPOCH-1 | 最新 epoch 的 marker + `cutoff_message_id` 之后的消息 = ContextView；cutoff 之前不出现 |
| EPOCH-2 | 多 epoch：只取 max(seq)，旧 marker/旧消息不进入 ContextView |
| EPOCH-3 | `cutoff_message_id` 缺失/不在 Timeline：fail-open 全量 + `warning`，不返回空 |
| EPOCH-4 | 同毫秒消息、旧时间戳新消息：按 id 定位 cutoff，不按 timestamp/位置 |
| EPOCH-5 | 用户粘贴「[上下文已自动压缩]」正文：不构成 epoch（id 前缀 + metadata 双校验） |
| EPOCH-6 | marker 被删除/编辑：ContextView 不得猜 cutoff；fail-open + 告警 |
| EPOCH-7 | 旧 marker 无 metadata：走 legacy hidden 兼容；标记 `legacyUncut` |
| EPOCH-8 | epoch 表缺失但 marker metadata 在：从 marker 恢复，结果一致 |

### 2.2 `context-view.test.ts`

| 用例 | 断言 |
|---|---|
| CV-1 | ContextView 不含 `legacy-hidden`；DisplayView 含 |
| CV-2 | ContextView 含最新 marker；DisplayView 含全部 marker（历史检查点） |
| CV-3 | cutoff 之后若出现 hidden（异常）：ContextView 仍过滤；DisplayView 保留 |
| CV-4 | `listMessages` = ContextView；`listTimelineMessages` = DisplayView（同一夹具对比） |
| CV-5 | 返回 `contextState`：visible/compacted/legacy-hidden/index-trimmed |
| CV-6 | 没有 epoch、没有 hidden：返回全量 + 告警（fail-open） |
| CV-7 | 分页：timeline 的 before/limit 不改变 ContextView 语义 |

### 2.3 `context-water-accounting.test.ts`

| 用例 | 断言 |
|---|---|
| WATER-1 | reasoning 计入估算；去掉 reasoning → 红 |
| WATER-2 | system/tools 计入 raw；final 另算 |
| WATER-3 | raw > 100% 不 clamp；final 单独读数 |
| WATER-4 | 水位返回 `sourceViewId`，与 ContextView 一致 |
| WATER-5 | 改用水位读 DisplayView → 红 |
| WATER-6 | 长会话不再恒 ~100%（构造选择前/后差异） |

### 2.4 `spill-permanence.test.ts`

| 用例 | 断言 |
|---|---|
| SPILL-P1 | 超过 14 天的被引用文件不自动删 |
| SPILL-P2 | `.tmp` 仍清；普通旧文件默认不删 |
| SPILL-P3 | 删会话 ⇒ 删该会话 spill 目录；其他会话不动 |
| SPILL-P4 | ToolCall metadata 的 `spill` 往返（locator/bytes/sha256/complete） |
| SPILL-P5 | 文件缺失/损坏：查看器返回不可读状态，不伪造全文 |
| SPILL-P6 | 显式清理只删明确孤儿；有引用时拒绝或报告 |

### 2.5 `context-marker-protection.test.ts`

| 用例 | 断言 |
|---|---|
| MARK-1 | `deleteMessage(markerId)` 失败且可见 |
| MARK-2 | `deleteMessagesBefore` 覆盖 marker 时拒绝/改写为新建检查点 |
| MARK-3 | regenerate 路径不删除 marker |
| MARK-4 | UI 无删除/编辑 marker 入口 |
| MARK-5 | 删除 epoch 表行不能改变 ContextView（marker metadata 仍是权威） |

---

## 3. 存储/集成判据

### 3.1 `compaction-checkpoint-protocol.test.ts`

| 用例 | 断言 |
|---|---|
| CP-1 | 压缩只写 marker + epoch；无 hidden/墓碑/FTS 删除 |
| CP-2 | marker 严格写：append → flush → 读回校验；失败中止 |
| CP-3 | 表失败、事件失败：marker 仍在；ContextView 正确；上报 |
| CP-4 | 进程在 marker 后崩溃：重启后 ContextView 正确；消息完整 |
| CP-5 | 自动/手动共用 `commitCompaction`；两份逻辑不漂移 |
| CP-6 | 重试同 epoch 幂等；不产生第二个 cutoff |
| CP-7 | 压缩锁并发：第二次拒绝且有回执 |
| CP-8 | UI autosave 在压缩窗口内不写 hidden/不复活 |

### 3.2 `context-timeline-read.test.ts`

| 用例 | 断言 |
|---|---|
| TL-1 | 索引 hidden + 日志合并：timeline 含旧压缩消息 |
| TL-2 | 日志墓碑排除；用户删除不复活 |
| TL-3 | `trimmed=1` 行在 timeline 可见；ContextView 按 cutoff 处理 |
| TL-4 | 同 id 索引/日志去重，日志优先；toolCalls 补齐 |
| TL-5 | 分页不整读日志；大结果不一次进内存 |

### 3.3 `context-migration.test.ts`

| 用例 | 断言 |
|---|---|
| MIG-1 | 旧 hidden 行回填为正常记录，位于墓碑之后 |
| MIG-2 | cutoff 读路径先上线；回填后 ContextView 不包含旧消息 |
| MIG-3 | 幂等：重复回填不重复、不改内容 |
| MIG-4 | 部分失败：保留现场、可重试、逐会话报告 |
| MIG-5 | 索引已重建/正文缺失：报告不可恢复，不写「已恢复」 |
| MIG-6 | 旧 marker 补 epoch；无法推导时 legacy 兼容 |

### 3.4 `context-rollback.test.ts`

| 用例 | 断言 |
|---|---|
| RB-1 | 取最新 epoch cutoff，之前消息写回 hidden=1 |
| RB-2 | 旧版本读 visible 视图 = 压缩后上下文 |
| RB-3 | 回滚幂等、可中断、逐会话报告 |
| RB-4 | 回滚后重新升级，迁移可重跑；不双写 |

### 3.5 `context-counts-fts.test.ts`

| 用例 | 断言 |
|---|---|
| CNT-1 | total/visible/compacted/trimmed 四数口径明确 |
| CNT-2 | 侧栏未读不把压缩旧消息算成新消息 |
| CNT-3 | FTS 不再因压缩删行；完整历史可搜 |
| CNT-4 | 模型搜索命中「已压缩」时有标签/过滤契约 |

### 3.6 `context-late-write.test.ts`

| 用例 | 断言 |
|---|---|
| LW-1 | 压缩后 update 旧消息：不复活、不改变 cutoff |
| LW-2 | 旧时间戳消息插入：ContextView 按 cutoff id 排除/包含正确 |
| LW-3 | marker 后新消息：进入 ContextView |
| LW-4 | 后写 visible 行不能覆盖 epoch/hidden 语义 |

### 3.7 Rust 契约

- `context_epochs` 插入/查询/最新 seq/分页/删除级联；
- `messages.rebuild_index` 后 epoch 表可从 marker 恢复；
- `wire-fixtures.json` 加 epoch 金样本；
- `cargo test --lib` / `npm run db:test`。

---

## 4. UI 判据

### 4.1 `context-timeline-ui.test.tsx`

| 用例 | 断言 |
|---|---|
| UI-TL-1 | 主对话默认完整时间线；检查点卡可见 |
| UI-TL-2 | 顶部持久条：`历史 N 条 · 模型可见 M 条`；滚动到 0 仍可见 |
| UI-TL-3 | 检查点卡文案：`已折叠 N 条 · 模型从这里开始` |
| UI-TL-4 | 块级加载：展开/搜索按 ≤50/100 条；不是 10+20 翻页 |
| UI-TL-5 | 历史消息只读：编辑/重发/回退/重新生成/删除产出文件为 null |
| UI-TL-6 | 打开历史期间 `saveMessages` spy 不写任何 hidden/消息 |
| UI-TL-7 | 模型视图切换只读；标注「模型看到的是这些」 |
| UI-TL-8 | 压缩回执写「折叠 N 条（历史仍保留）」 |

### 4.2 `context-timeline-performance.test.tsx`

| 用例 | 断言 |
|---|---|
| PERF-1 | 600 条夹具只挂 ≤50 个 MessageBubble |
| PERF-2 | 2000 条不一次性渲染；块头 + 懒加载 |
| PERF-3 | ScrollbarMarkers 不含 hidden/archived |
| PERF-4 | 不整读 JSONL/600MB；不出现 `readFile` 全量 |
| PERF-5 | 首屏时间/内存预算（以脚本读数为准） |

### 4.3 `context-timeline-a11y.test.tsx`

| 用例 | 断言 |
|---|---|
| A11Y-1 | 历史视图 role=dialog/aria-modal 或独立页面；Esc 关闭；焦点归还 |
| A11Y-2 | 检查点卡可键盘展开；aria-expanded |
| A11Y-3 | 三皮肤 + 320/384/480/576/760 不溢出 |
| A11Y-4 | 加载/错误/空态独立；分页失败不显示「没有历史」 |

### 4.4 `context-fork-search-export.test.ts`

| 用例 | 断言 |
|---|---|
| FSE-1 | fork 复制完整时间线 + epoch；子 ContextView 保留 cutoff |
| FSE-2 | 搜索 hidden 文本：先加载块，再跳转；分母是 Display 总数 |
| FSE-3 | pin 所在块自动展开；跳转可达 |
| FSE-4 | 导出默认完整历史；可选模型视图 |
| FSE-5 | 子代理/委派/记忆/标题读 ContextView，不读 Display |

---

## 5. 变异矩阵

| 变异 | 预期变红 |
|---|---|
| ContextView 改读 DisplayView | CV-1/CV-4、WATER-5、MODEL-REQUEST |
| cutoff 改按 timestamp/位置 | EPOCH-4、LW-2 |
| 去掉 marker metadata/id 双校验 | EPOCH-5、MARK-1 |
| 允许删除 marker | MARK-1/2/3、EPOCH-6 |
| 压缩改回 hidden/墓碑 | CP-1、TL-1、MIG-1 |
| 回填写在墓碑之前 | MIG-1 |
| 水位去掉 reasoning | WATER-1 |
| 水位 clamp >100% | WATER-3 |
| spill 恢复 14 天自动删 | SPILL-P1 |
| Timeline 塞进 `messages` | UI-TL-6、PERF-1 |
| UI 历史开放编辑/fork | UI-TL-5、FSE-1 |
| 模型搜索不标注已压缩 | CNT-4 |

---

## 6. 真机取证清单

1. 版本/构建时间/PID/数据根/是否静默安装。
2. 旧库副本：先备份 `.bin + -wal + -shm` 与 `sessions/`；只读迁移 dry-run。
3. 压缩 200+ 条会话：记录 `message_count` 四数、epoch、cutoff、ContextView id 集合。
4. 刷新页面、重启应用：完整时间线仍在；模型视图仍是 cutoff 后。
5. 索引重建：`rebuild_index` 后 timeline/marker/epoch 仍在；ContextView 不变。
6. 旧会话迁移：迁移条数、不可恢复条数、逐会话报告。
7. 回滚演练：副本上执行 cutoff→hidden；旧版本可读 compressed 视图。
8. spill：构造 >14 天的被引用文件，重启后仍可读；缺失文件显示不可读。
9. 性能：600/2000 条首屏、展开、搜索、滚动标记；记录内存/耗时。
10. 模型请求 vs 水位：假 provider/真实请求抓取，核对 id 集合与 token 读数。

---

## 7. 文件级施工清单

> 顺序即依赖顺序；每一步先写判据再实现。

| # | 文件/模块 | 改什么 | 判据/门禁 |
|---:|---|---|---|
| 0 | `docs/project-guide/18/19` | 设计+判据（本文） | 文档评审 |
| 1 | `src/core/context/context-view.ts`（新） | Epoch/ContextView/DisplayView 纯函数、类型 | EPOCH/CV |
| 2 | `src-tauri/codem-db/sql/schema.sql`、`migrations.json`、`tables.json` | `context_epochs` 表 | schema parity、db:test |
| 3 | `src-tauri/codem-db/src/repo.rs`、`lib.rs` | epoch 仓储/命令 | Rust 契约、command parity |
| 4 | `src/core/storage/rust-port.ts` | epoch 端口、分页、重建 | wire、storage boundary |
| 5 | `src/core/storage/session-jsonl.ts` | marker metadata、epoch 恢复、严格写辅助 | CP-2、EPOCH-8 |
| 6 | `src/core/storage/message.ts` | `listTimelineMessages`/`listContextMessages`、hidden 兼容、toolCalls 补齐 | TL-1..5、CV-1..7 |
| 7 | `src/core/llm/compaction-commit.ts`（新） | 自动/手动共用提交、失败矩阵 | CP-1..8 |
| 8 | `src/core/llm/agentic-loop.ts`、`src/components/ContextMonitor.tsx` | 改用 `commitCompaction`，不删/不隐藏 | CP-1、CP-5 |
| 9 | `src/core/llm/compaction-budget.ts`、`src/core/context/water-level.ts`、`src/components/ContextMonitor.tsx` | ContextView 估算、reasoning/system/tools、raw/final | WATER-1..6 |
| 10 | `src/core/storage/spill.ts`、`spill-policy.ts`、`session/executor.ts`、`maintenance.ts` | spill 永久化、metadata、磁盘统计 | SPILL-P1..6 |
| 11 | `src/core/storage/session.ts` | 删会话清 spill；marker 保护 | SPILL-P3、MARK-1..3 |
| 12 | `src/core/storage/context-migration.ts`（新） | 旧 hidden 回填、epoch 补全、报告 | MIG-1..6 |
| 13 | `src/core/storage/context-rollback.ts`（新） | cutoff→hidden 回滚迁移 | RB-1..4 |
| 14 | `src/store.ts`、`src/components/ChatPanel.tsx`、`MessageBubble.tsx`、`App.tsx` | 完整时间线读模型、检查点卡、模型视图；不写 `messages` | UI-TL-1..8、PERF-1..5 |
| 15 | `src/components/ContextTimeline.tsx`、`CheckpointCard.tsx`、`ModelViewPanel.tsx`（新） | 只读 transcript/检查点/模型视图 | UI/A11Y |
| 16 | `src/core/session/fork-index.ts`、`core/store.ts`、`session-log-export-provider.ts`、`session-search.ts` | fork/导出/搜索完整历史；模型视图可选 | FSE-1..5 |
| 17 | `src/test/*` | 上述判据 + 变异 | 全量 |
| 18 | `docs/project-guide/03/06/09` | 压缩/读路径/当前状态 | audit:docs |

---

## 8. 门禁命令

```powershell
npx tsc --noEmit
npx vitest run <相关判据>
npx vitest run
npm run db:test
node tools/audit/gen-schema-sql.mjs --check
node tools/audit/check-command-parity.mjs
node tools/audit/scan-storage-boundary.mjs
node tools/audit/scan-unrouted-db.mjs --check
node tools/audit/reachability-scan.mjs --check
node tools/audit/knip-gate.mjs
node tools/audit/scan-report-sites.mjs --check
node tools/mutate/check-artifacts.mjs
node tools/ui-audit/css-contract.mjs
npm run audit:docs
```

---

## 9. Definition of Done

- [ ] 压缩不写 hidden/墓碑/FTS 删除；marker+epoch 严格写。
- [ ] ContextView 与模型请求 id 集合一致；假 provider 判据通过。
- [ ] 完整时间线默认显示；检查点卡、持久条、模型视图切换可用。
- [ ] 历史消息只读；`saveMessages` 不写 hidden；fork/搜索/导出完整历史。
- [ ] 水位含 reasoning/system/tools；raw/final 分开；不 clamp。
- [ ] spill 永久；删会话清 spill；缺失正文可见。
- [ ] 旧会话迁移幂等；不可恢复报告；不伪造。
- [ ] 回滚迁移副本演练通过。
- [ ] 600/2000 性能、三皮肤、窄容器、a11y 判据通过。
- [ ] `tsc` 0、相关判据 + 全量测试、门禁全绿、真机取证完成。
