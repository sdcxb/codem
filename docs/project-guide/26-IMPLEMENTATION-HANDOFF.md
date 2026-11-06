# 26 · Context OS 改进计划交接单（新会话专用）

> **用途**：把 24/25 两轮对标收敛成一份“新会话可执行契约”，避免新窗口通读 150KB 后走偏。
> **基线**：`master`，v1.18.13；最新相关提交 `7c92ff18`。
> **状态**：设计已定，**尚未开工代码**。
> **裁决优先级**：`24 §9` > `25 §9` > 本文；本文与源码冲突时，**以源码为准**，并立刻停下报告。

---

## 0. 一句话目标

> 不新建 Thread 表、不每次换段新建 Session；用 **Session = Thread，ContextEpoch = Segment** 管上下文；旧消息永不删；先补 **Manifest/Eval/Security/Durability**，再做 Pager/Document OS/Agents；复用 Codem 已有资产，不重造。

---

## 1. 新会话阅读清单（按顺序，限时，不要通读）

| 顺序 | 读什么 | 读到什么程度 |
|---|---|---|
| 1 | `AGENTS.md` | 全文；仓库纪律/命令/禁 goal mode |
| 2 | `docs/project-guide/00-AGENT-HANDBOOK.md` | 全文；开工清单/硬规则 |
| 3 | `docs/NEW-SESSION-START.md` | 全文；一屏开工说明 |
| 4 | `docs/project-guide/20-HEAVY-TASK-HANDOFF.md` | 全文；重型任务口径 |
| 5 | `docs/project-guide/24-MEMORY-BENCHMARK-AND-ROADMAP.md` | **只读 §0 / §8 / §9**；不要通读 |
| 6 | `docs/project-guide/25-INFINITE-CONTEXT-AND-BOT-TEAM.md` | **只读 §0 / §6 / §9 / §10 / §11**；不要通读 |
| 7 | 本文 §2–§6 | 全文 |

源码只在 Phase 1 按任务读，不要一上来全仓 grep。

**必须核对的源码入口**（按需）：

- `src/core/context/context-epochs.ts`、`context-view.ts`
- `src/core/llm/agentic-loop.ts`、`compaction-budget.ts`
- `src/core/storage/message.ts`、`session.ts`、`spill.ts`
- `src/core/memory/memory.ts`、`src/core/llm/tools/session-search.ts`
- `src/core/llm/tools/document-tools.ts`、`src/core/document/ledger.ts`、`citation.ts`
- `src/core/llm/tools/codegraph-tool.ts`、`zvec-tool.ts`
- `src/core/goal/runner.ts`、`src/core/agent-teams/engine.ts`
- `src/core/prompt/prompt.ts`（缓存边界）

---

## 2. 已定决策（D1–D10，不可在实现时重开）

| ID | 决策 | 含义 |
|---|---|---|
| D1 | **Session = Thread，Epoch = Segment** | 不新建 `threads` 表；不每次 switch 新建 Session；`context_epochs` 加 `segment_seq/kind/handoff` |
| D2 | **一个 pressure 模型** | 沿用 Codem 0.7 考虑线、0.9 hard；不引入第二套 80%/90%/0.95 阈值 |
| D3 | **compact 与 switch 分离** | compact 写 checkpoint epoch；switch 写 handoff epoch；旧消息都不删 |
| D4 | **记忆不自动删改** | 自动只产 candidate/pending/归档；manual/pinned 永不被自动删；不做全局 memory summary |
| D5 | **复用优先** | Document OS 复用 `document-tools/ledger/citation/vector/OCR`；代码复用 `CodeGraph/zvec`；任务复用 `agent-teams`；阶段复用 `goal runner` |
| D6 | **一套任务态** | `agent-teams` 的 claim/attempt/rollback 是唯一任务态；Bot 只是身份/记忆/工作区视图 |
| D7 | **不用 goal mode** | 开发本仓库用 `todo_write`；不用 DSH goal/自动续跑替代向用户提问 |
| D8 | **先设计门，后代码** | Phase 1 只读审计/文件级计划/测试矩阵；用户说「开工」前不改代码 |
| D9 | **判据先行** | 每个改动先有能变红的判据；变异自证；`tsc` + 定向 + 全量测试 |
| D10 | **独立复核** | 实现者不自审；fresh reviewer 只看契约 + diff + 测试；通过后才算完成 |

---

## 3. Phase 1：只读设计门（不改代码）

目标：验证 24/25 的关键事实在**当前代码**仍成立，并把 P0 切成可执行的小片。

必须交付：

1. **10 行摘要**：当前代码与 24/25 的差异，哪些结论仍成立、哪些已过时。
2. **D1–D10 合规表**：每条写“已满足/需改动/有冲突”，冲突必须给 path:line。
3. **P0 切片计划**：
   - 第一片建议：`P0-0 契约`（`context_epochs` 加字段 + `ContextView` 投影 + 兼容 + 测试），**不做 UI、不做 switch 行为**；
   - 第二片：`P0-1 memory_search/read + full timeline extraction + usage`；
   - 第三片：`P0-2 thread_history`；
   - 第四片：`P0-3 context manager + handoff`；
   - 第五片：`P0-4 UI/恢复`。
   - 每片列：改哪些文件/函数、加哪些测试、如何变异、回滚点。
4. **测试矩阵**：每条判据的“改前红/改后绿/变异红”。
5. **风险与未决问题**：只列真正需要用户拍板的产品分叉；不要用“自动续跑”代替提问。
6. **明确停点**：交付后停下，等用户说「开工」。

**Phase 1 禁止**：改代码、改 24/25、建新表、改 UI、跑全量构建。

---

## 4. Phase 2：按片实现（用户批准后）

每次只做**一片**，不跨片重构。

要求：

- 先写/改判据，确认改前红；
- 最小实现；
- `npx tsc --noEmit`；
- 定向 `npx vitest run <file>`；
- 需要时全量 `npx vitest run`；
- 变异自证（把实现改坏，判据必须红）；
- `git diff --check`；
- 只改本片相关文件；不顺手重构、不修无关失败；
- 不 commit/push，除非用户明确要求；留下 diff 给复核。

**第一片 P0-0 的 Done 定义**：

- `context_epochs` 有 `segment_seq/kind/handoff`（或等价字段），旧行兼容；
- `ContextView` 对旧 compact epoch 行为不变；`kind=switch` 有投影测试；
- `listTimelineMessages` 不受影响；
- 旧 marker 无 metadata 不崩；
- 定向测试 + 变异红；
- 不改 `sessions`/`messages`/`MemoryEntry`/conversation scope；
- 不新建 `threads` 表。

---

## 5. 硬约束 / 非目标

**必须**：

- 先读源码再改；不拿 24/25 当“代码事实”；
- 每个改动映射到 D1–D10 中至少一条；
- 保持旧消息完整、可搜索、可导出；
- 保持 `conversation` memory 按 `sessionId`（D1 下不需要迁移）；
- 新逻辑有 feature flag/灰度（`context.segmentEpochs` 或等价）；
- 出错时报告，不静默吞。

**非目标（本阶段不做）**：

- 不做新 Thread 表/新 Session-per-switch；
- 不做第二套 window/compact；
- 不做记忆自动删除/自动改写；
- 不做全局 memory summary；
- 不做新 Document/Code Graph（先复用）；
- 不做第二套 Bot/Team 状态；
- 不做群聊 UI、浏览器隔离、多端同步（P1/P2）；
- 不做“绝对不上下文满”的承诺；只做可降级/可检索/可恢复。

---

## 6. 防走偏的 8 条操作规则

1. **决策 ID 制**：每个文件改动注明 D1–D10；没有对应决策就停。
2. **源码优先**：交接单与源码冲突，源码赢；改交接单前先问用户。
3. **小片交付**：一次只做一片；不跨片“顺手优化”。
4. **停点制**：Phase 1 结束必须停；Phase 2 每片结束必须停。
5. **证据包**：每条结论带 `path:line` + 命令 + 输出摘要；不写“应该可以”。
6. **失败可见**：测试失败/环境问题/不确定，原样报告；不伪装通过。
7. **不复用旧对话结论**：新窗口必须重新核对关键源码；24/25 是地图，不是地面。
8. **独立复核**：实现完成后，起一个 fresh reviewer，只给它契约、diff、测试；它说 PASS 才算完成。

---

## 7. 新会话开场白（直接复制）

```text
你是 Codem 的接手工程师。先不要改任何代码。

项目：C:\mimo-gui
基线：master / v1.18.13 / 相关提交 7c92ff18
任务：接手 Context OS 改进计划，先做 Phase 1 只读设计门，等我确认后再按片实现。

第一步，按顺序读：
1) AGENTS.md
2) docs/project-guide/00-AGENT-HANDBOOK.md
3) docs/NEW-SESSION-START.md
4) docs/project-guide/20-HEAVY-TASK-HANDOFF.md
5) docs/project-guide/24-MEMORY-BENCHMARK-AND-ROADMAP.md 的 §0/§8/§9
6) docs/project-guide/25-INFINITE-CONTEXT-AND-BOT-TEAM.md 的 §0/§6/§9/§10/§11
7) docs/project-guide/26-IMPLEMENTATION-HANDOFF.md 全文

不要通读 24/25 全文；不要一上来全仓 grep；不要改代码；不要用 goal mode。

然后只做 Phase 1，交付：
A. 10 行摘要（当前代码 vs 24/25 的差异）
B. D1–D10 合规表（已满足/需改/冲突，冲突给 path:line）
C. P0 切片计划（第一片建议只做 P0-0 契约，不做 UI/switch 行为）
D. 测试矩阵（改前红/改后绿/变异红）
E. 真实需要我拍板的问题
F. 风险与停点

硬约束：
- Session=Thread，Epoch=Segment；不新建 threads 表；不每次 switch 新建 Session
- 旧消息不删；记忆不自动删改；不做全局 summary
- 复用 document-tools/ledger/citation、CodeGraph/zvec、agent-teams、goal runner
- 判据先行；tsc + 定向 + 全量；变异自证
- 不 commit/push；只留 diff

交付后停下，等我说「开工」。
```

---

## 8. 复核用的 fresh reviewer 提示（Phase 2 用）

```text
你是独立复核者，不参与实现。只根据以下材料判断：
1) docs/project-guide/26-IMPLEMENTATION-HANDOFF.md（契约）
2) git diff（实现）
3) 测试命令与输出（含变异自证）

逐条检查：
- D1–D10 是否被违反
- 是否新建了 threads/第二套 window/第二套任务态
- 是否删/隐藏旧消息、自动删改记忆、做全局 summary
- 测试是否真的改前红、改后绿、变异红
- 旧数据/旧 marker/remote/fork/export 是否兼容
- 是否有 scope creep、无关重构、静默吞错
- 并发/锁/超时/崩溃恢复是否说明

只输出：
PASS / FAIL / UNKNOWN
每条 FAIL 给 path:line + 违反的决策 + 最小修复建议。
不要给“整体不错”这类评价。
```

---

## 9. 交接完成标准

- 新会话能复述 D1–D10，且不查旧对话；
- Phase 1 交付有 path:line，不是泛泛而谈；
- 第一片 P0-0 的测试矩阵可执行；
- 用户明确说「开工」后才进入 Phase 2；
- Phase 2 每片有 fresh reviewer PASS，才进入下一片。
