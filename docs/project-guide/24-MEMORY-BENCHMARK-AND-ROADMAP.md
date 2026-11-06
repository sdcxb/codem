# 24 · 记忆系统深度对标与演进规划

> **状态**：分析 / 规划稿，不是已实现设计；本文不改变任何运行行为。
> **Codem 基线**：`master`，v1.18.13（2026-11-06）。
> **Codex 基线**：`openai/codex` 浅克隆，commit `da279f6fd4a942261b3232feb515af4259922417`（2026-11-06）。
> **证据等级**：A = 源码路径 + 测试/真机读数可核；B = 源码代码阅读，未在当前机器跑完整链路；C = 由代码结构推出的风险；D = 未知 / 需实测。
> **目标**：解释「为什么 Codem 的记忆会时好时坏」，并把 Codex 真正值得借鉴的机制拆成可施工、可验收、可回滚的路线；不把 Codex 当默认成熟的模板。

**目录**：0 一页结论 · 1 Codex 源码事实 · 2 Codem 全景 · 3 差距/根因 · 4 目标架构 · 5 路线图 · 6 验收判据 · 7 风险/不可照搬 · 8 结论 · 9 与 DS-Bot 的融合裁决 · 附录 A–D。

> **续篇**：[25-INFINITE-CONTEXT-AND-BOT-TEAM.md](docs/project-guide/25-INFINITE-CONTEXT-AND-BOT-TEAM.md)（DS-Bot ICM / 长期 Bot / 群聊源码对标）。
> **最终方案以本文 §9 为准**；25 号文提供执行细节，若两文冲突，以 §9 为准。

---

## 0. 一页结论

### 0.1 不是「记忆没写进去」，而是「模型拿不到完整记忆」

Codem 已经有一整套长期记忆设施：

- 平台 / 项目 / 对话三级作用域；
- `manual` / `auto` 信任边界；
- 待批准、批量批准/拒绝、拒绝记录；
- 相似查重、同主题合并、批次撤销；
- 注入预算、截断披露、记忆体检、导入导出；
- 稳定/易变分块，保护 Prefix KV Cache。

但模型实际看到的每条记忆，**只注入前 200 字符**：

```ts
MEMORY_INJECT_LINE_MAX = 200
```

而一条记忆允许 10,000 字符。也就是说，一条 800 字的项目约定，模型每轮只看到开头 200 字；剩下 600 字虽然在库里，却没有任何 `memory_read` / `memory_search` 工具让它取回来。

这是「零星记不住」最直接、最可解释的结构原因，优先级高于任何提示词优化。

### 0.2 三个结构性缺口

1. **取不回**：没有模型可调用的**记忆全文**读取 / 搜索工具（历史侧有通用 `session_search` / `session_event_*`，见 2.9；记忆侧没有对应工具）；
2. **提取源太窄**：`extractMemoriesFromSession` 读 `listMessages()`（模型可见集合），压缩后的旧消息不在其中，提取器看不到；
3. **没有使用信号**：注入按创建序取每块前 20 条，没有 `usageCount` / `lastUsedAt`，旧的重要条目会被新条目挤出。

### 0.3 Codex 值得学的是「检索」，不是「自动删除」

Codex 当前源码真正有价值的三件事：

- 从**完整 rollout** 做离线提取；
- 用 **summary + memory/history/notes 工具**做两层检索；
- 用 **usage_count / last_usage** 选 Top-N。

但它也有三类不能照搬的东西：

- `MemoryTool` / `TokenBudget` 在当前源码中都是 **feature flag，默认关闭**；
- `TokenBudget` 不是 4KB 摘要，而是 window id + 最多 64K retained messages + history/notes 工具；
- 自动 consolidation 会改写/删除生成文件，和 Codem「不自动删除或改写任何条目」的产品承诺冲突。

### 0.4 建议的第一批改动

按 ROI：

1. `memory_search` / `memory_read`（只读，复用现有 `MemoryService.search` + `injectionTextFor`）；
2. **按 epoch/id 的 `history_read`**（不是从零做历史搜索：已有 `session_search` / `session_event_search` / `session_event_read`，但缺少“按压缩检查点精确回读”的一等入口）；
3. 提取源改为完整时间线 + 游标 + 单飞；
4. 加 `usageCount` / `lastUsedAt`，排序从「创建序」改为「手动置顶 + 使用信号」；
5. 压缩前提醒写 session notes、压缩后注入短 thread hint（现有 `create_note` 是 notebook 笔记，不是这个）；
6. 再做可选的后台 consolidation，但只归档/降权，不自动删 manual / pending。

### 0.5 症状 → 首选动作

| 症状 | 首选动作 |
|---|---|
| 只记住开头 / 长约定后半段失效 | P0-1 索引 + memory_read |
| 旧的重要条目被新条目挤掉 | P0-4 usage 排序 |
| 压缩后早期细节提取不到 | P0-3 完整时间线提取 |
| 压缩后模型找不到旧命令/错误 | P0-2 history_read（保留 session_search 兜底） |
| 面板说已生效、模型没用 | P0-1 修 injectionPlan 预算口径 + 逐条原因 |
| 待批准越积越多 | 批量审批 + 归属失效清理 + 降低候选噪声 |
| 点了整合没变化 | P1-3 统一中文相似度 |
| 压缩前没有交接 | P1-1 session notes + 提醒 |
| 压缩太频繁/太晚 | 先修压力口径，再实测调阈值；不要先改数字 |
| 自动记忆像指令 | 4.6 拆分 manual/auto 权威性 note |

---

## 1. Codex 源码事实：文章说对了什么，说错了什么

### 1.1 功能是默认关闭的，不能当成「所有用户已经在用」

源码：

- `Feature::MemoryTool`：`Stage::Stable`，但 `default_enabled = false`；
- `Feature::TokenBudget`：`Stage::UnderDevelopment`，`default_enabled = false`；
- `Feature::ContextManagement`：同样 under development；
- `MemoriesConfig::default()` 的 `version` 仍是 `V1`；
- `dedicated_tools` 默认 `false`；即使 `use_memories=true`，`memory_summary` 也要 `Feature::MemoryTool` 开启才会注入；
- 新 profile 的 v2 是**运行时判定**（`config/mod.rs` 约 3763–3775：MemoryTool 开、version 未显式设、dual_write != false、`~/.codex/memories` 不存在时才切 v2），不是 Toml 默认值。

证据：

- `codex-rs/features/src/lib.rs` 中 `MemoryTool` / `TokenBudget` 的 `FeatureSpec`；
- `codex-rs/config/src/types.rs` 中 `MemoriesConfig::default()`；
- `codex-rs/core/src/config/mod.rs` 的 v2 运行时判定。

结论：文章描述的是一套**可选的、实验中的**能力。Codem 对标时应当吸收机制，而不是假设「Codex 用户默认都有」。

补充：TokenBudget 的 `apply_experimental_context` 还要求 ChatGPT auth + Plus/Pro/ProLite/ProMax + codex backend 路由；API key / 非 codex 后端用户不满足。这是一个**账号/后端条件**，不是纯代码开关。

### 1.2 长期记忆：Phase 1 离线提取

Codex 不是在每个回合里提取，而是在**首个有输入的 turn 被 app-server 接受后**异步跑（不是 app 启动就扫）：

- 只处理交互式 root session；
- 默认每次启动最多 2 个 rollout；
- rollout 至少空闲 6 小时；
- 最多 10 天前的 rollout；
- 剩余额度低于 25% 时跳过；
- 从完整 rollout 中按 tier 取证据：
  `Human > Final > OtherAgent > Commentary > Context > Tool`；
- 单次最多 8MB，按模型窗口的 70% 截断，保留最新证据，再恢复时间顺序；
- 输出 `raw_memory` / `rollout_summary` 到 SQLite。

证据：

- `codex-rs/memories/write/src/phase1.rs`
- `codex-rs/memories/write/src/rollout_input.rs`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`（约 743–756 行：`turn_has_input && started` 才启动）
- `codex-rs/config/src/types.rs` 的 `DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP = 2`、`DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS = 6`、`DEFAULT_MEMORIES_MAX_ROLLOUT_AGE_DAYS = 10`、`DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT = 25`；`max_raw_memories_for_consolidation = 256`、`max_unused_days = 30`。

与 Codem 的差别不是「模型更强」，而是：

- **source 是完整 rollout**，不受压缩视图影响；
- **不在回合路径上**，不会和当前回合抢资源、不会连续回合重复跑；
- **有明确的空闲/年龄/额度门**，不是每轮都写。

### 1.3 长期记忆：Phase 2 使用信号选 Top-N

Phase 2 不是简单把全部 raw memory 拼成一段，而是：

- 从 `stage1_outputs` 最多选 256 条；
- 排序键：
  `usage_count DESC` → `last_usage DESC` → `source_updated_at DESC`；
- `max_unused_days = 30` 后失去资格；
- 把选中的 rollout summaries 同步到 memory workspace；
- 用 git 判断工作区是否真的变化；
- 启动受限的 consolidation agent 写 `memory_summary.md`；
- 最终以 git diff 落盘。

证据：

- `codex-rs/state/src/runtime/memories.rs` 的 `get_phase2_input_selection`（约 456 行起）；
- `codex-rs/memories/write/src/phase2.rs`；
- `codex-rs/memories/write/templates/memories/consolidation_v2.md`。

`usage_count` 的来源：模型在最终回复末尾输出 `<oai-mem-citation>`，解析出 rollout id 后 `usage_count += 1`：

- `codex-rs/state/src/runtime/memories.rs`（约 58–80 行）；
- `codex-rs/core/src/stream_events_utils.rs`（约 209–221 行）；
- `codex-rs/memories/read/src/citations.rs`。

注意：citation 是**模型自报**的，源码只校验 id/格式，不校验「这条记忆真的支持了结论」。所以它是「使用信号」，不是「正确性证明」。而且只有 `<rollout_ids>` 会驱动 `usage_count`；`<citation_entries>` 里的路径/行号只用于展示，不会提升任何记忆权重。Codem 若实现 citation，应把 path 映射到 memory id 或 `memory_read` 命中，否则会出现「引用了摘要但不涨 usage」。

### 1.4 读路径：2.5K summary + 工具，而不是把所有记忆塞进提示

Codex 注入：

- `memory_summary.md`，最多 **2,500 token**；v2 还要求 `memory_summary.md` 本身 < 10,000 UTF-8 bytes；
- 完整的 `MEMORY.md` / `rollout_summaries/` / `skills/` 通过工具按需读；
- 工具默认不暴露：`dedicated_tools=false` 时只有注入，没有 `memories.*` 工具；
- 工具：
  - `memories.list`（默认/上限 2,000）
  - `memories.read`（单次最多 20,000 token）
  - `memories.search`（默认/上限 200）
  - `memories.add_ad_hoc_note`（用户明确要求记住/忘记/更正时追加）

证据：

- `codex-rs/ext/memories/src/lib.rs`（`MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT = 2_500`）；
- `codex-rs/ext/memories/src/tools/read.rs`、`search.rs`、`list.rs`、`ad_hoc_note.rs`；
- `codex-rs/ext/memories/templates/memories/read_path_v2.md`。

它的 prompt 明确说：

> `memory_summary.md` 已提供；不要再次打开；先用 MEMORY.md 搜索；只有需要精确证据时才读 rollout summaries。

这把「静态注入」和「按需检索」分开了。Codem 目前只有前一半。

### 1.5 Token Budget：不是「4KB 摘要」，也不是「完全清空」

当前源码里确实存在 `MAX_THREAD_HINT_BYTES = 4_000`，但它不是 `memory_summary.md` 的 4KB 摘要：

- 它来自 `alpha/notes/v2/thread_hint`，是 notes 工具的后端 thread hint；
- 超过 4,000 bytes 时**整段丢弃并计失败**，不是截一段；
- 它作为 `PromptSlot::ContextWindow` 片段拼进 `<context_window>`；
- `TokenBudgetContext` 本身只注入 agent name、first/current/previous window id；没有内容摘要。

真正的衔接靠：

- 切窗口时保留最多 **64K token** 的 client tool outputs / developer messages；
- `history` 工具查完整历史；
- `notes` 工具维护任务状态；
- 接近上限时发 reminder；
- 到 0 时发 fallback prompt；
- 然后才 `start_new_context_window`。

证据：

- `codex-rs/core/src/session/token_budget.rs`；
- `codex-rs/core/src/session/mod.rs` 的 `start_new_context_window`（约 5379 行起）；
- `codex-rs/core/src/compact_remote_v2.rs` 的 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`；
- `codex-rs/core/src/compact_token_budget.rs`（不调模型摘要，直接安装新窗口）；
- `codex-rs/core/src/context/token_budget_context.rs`（只有 id 与 guidance，不是 4KB 内容）；
- `codex-rs/ext/history-notes/src/extension.rs` 的 `MAX_THREAD_HINT_BYTES = 4_000`（约 31–32 行，约 128–160 行）。

所以文章里「4KB Thread Hint」和「完全清空」两个说法，与当前 commit 不一致。正确的理解是：

> 新窗口基本清空，但保留最多 64K 的客户端工具/开发者消息；状态靠 history/notes 查，不靠一段 4KB 摘要。4KB 是 notes 后端 thread hint 的硬上限，不是 memories 的注入内容。

### 1.6 History / Notes 工具真实能力

`history`：

- `history.list_windows`
- `history.list_items`
- `history.read_item`（必须 `item_id` + `window_id`）
- `history.search_contents`

`notes`：

- `notes.list_files_by_prefix`
- `notes.read_file`（支持负行号从尾部计）
- `notes.search_contents`
- `notes.append_to_file`
- `notes.write_file`

约束：

- notes 是虚拟路径，不是真实文件系统；
- 单文件 ≤ 1,000,000 UTF-8 bytes；
- history 是 read-only、最终一致；
- 工具结果对用户隐藏，是模型私有状态；
- 按 agent 隔离；
- 工具描述明确写「survive context-window transitions within this rollout」；
- 只对 OpenAI provider + codex backend auth 生效，依赖后端。

证据：

- `codex-rs/ext/history-notes/src/tools.rs`；
- `codex-rs/ext/history-notes/src/backend.rs`。

这仍是 Codem 目前没有一等公民的两件事：

- 按 compaction epoch / message id 的**精确历史回读**；
- **session 级 notes scratchpad**，用来在压缩前写任务状态；
- 注意：Codem **有**通用 `session_search` / `session_event_search` / `session_event_read` / `session_trace`，也能读回压缩前正文（见 2.9）；但它们是 FTS/事件日志语义，不是按 epoch 的专用回读，也没有 session notes。`create_note` / `edit_note` 是 notebook 知识库笔记，不是上下文交接笔记。

限制：

- history/notes 是**远端 Codex backend**，要求 OpenAI provider + codex backend auth，不是本地能力；
- notes 是模型私有状态，源码靠 prompt 要求「不要向用户披露」，没有 UI 层强制；
- `history` 最终一致，`notes` 的 read 立即、list/search 可能延迟；
- 不支持 code mode；
- 依赖后端账号，API key 用户可能不可用。

### 1.7 Codex 的自动整理会真的删除/改写

这点必须说清，因为它和 Codem 的产品承诺冲突：

- stale `rollout_summaries/*.md` 会直接删除；
- stage-1 输出超过 `max_unused_days` 会按最旧优先批量删；
- consolidation agent 有 memory root 的写权限，按模板删除「仅由已删来源支撑」的条目；
- 成功后 `reset_memory_workspace_baseline` 把 git 基线前移；
- 源码里**没有 manual memory API**；用户唯一「手动记一条」的通道是模型 `add_ad_hoc_note`，或 TUI 的两个开关 + Reset。

所以 Codex 的自动记忆更接近「模型维护的全局摘要」，不是 Codem 那种「用户可审批、可编辑、可撤销的条目」。Codem 不应为了「对标」而放弃 manual 保护。

### 1.8 压缩提示词：短 handoff，而不是八段强制摘要

Codex 的 summary prompt 只有：

> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

证据：

- `codex-rs/prompts/templates/compact/prompt.md`；
- `codex-rs/prompts/src/compact.rs`。

Codem 的八段式摘要更细，理论上保真更高；但它也更容易被分块、裁剪、charBudget 和模型自由发挥破坏（`buildCompactionSystemPrompt` 的 1,500 字符上限**没有生产调用**，不要把它当实际约束）。Codex 的做法是把「细节」交给 history/notes，摘要只做索引。两者不是谁绝对更好，而是**摘要职责不同**。

### 1.9 源码纠偏表

| 文章说法 | 当前源码 | 影响 |
|---|---|---|
| 新窗口注入约 4KB Thread Hint | 4KB 是 notes 后端 thread hint 的硬上限（超限整段丢弃），不是 memories 摘要；`TokenBudgetContext` 只有 window id | 不要把「4KB 摘要」当既定实现 |
| 新窗口完全清空 | 保留最多 64K 的 client tool/developer 消息 | 新窗口并非零上下文 |
| 固定 80% 触发 | 默认 auto compact 上限是 `context_window * 9 / 10`（90%），还可被 config limit 取 min；另有 post-turn/async/reminder 三套阈值 | 不要照搬数字 |
| Global Consolidation 按 citation Top-N | 是 usage_count/last_usage 选 stage1 outputs（默认最多 256 条） | 机制存在，但选的是 rollout summaries，不是最终记忆事实 |
| Codex Memory 是默认能力 | MemoryTool/TokenBudget 默认关闭，TokenBudget under development，dedicated_tools 默认 false | 不能假设所有 Codex 用户已用上 |
| 自动记忆会删除/改写 | consolidation 会生成/改写 memory_summary，并清理 stale rollout summaries；没有 manual 概念 | Codem 不应照搬这种删除/改写 |
| 启动即提取记忆 | 首个有输入的 turn 被接受后才启动 | 不要把「启动」当触发点 |
| 20K 是压缩输入上限 | 20K `COMPACT_USER_MESSAGE_MAX_TOKENS` 是压缩后保留的 user 消息预算 | 不要误读为输入预算 |

### 1.10 两轮判断合并

第一轮（读文章 + Codem 代码）的判断：

- Codex 的「长期记忆 + 压缩衔接」方向值得学；
- Codem 的 trust / scope / 审批 / 审计比 Codex 更成熟，不能丢；
- 最可疑的三个点：200 字截断、20 条创建序、压缩后提取源。

第二轮（Codex 源码）修正后的判断：

- Codex 的 MemoryTool / TokenBudget 仍是**默认关闭的实验能力**，不能按「成熟默认功能」对标；
- 「4KB Thread Hint」「完全清空」「固定 80%」都不准确；真实机制是 64K retained + history/notes + 90% 上限 + 四套阈值；
- Codex 的自动 consolidation 会**真的删除/改写**，Codem 不能照搬；
- 真正该学的是：**完整 rollout 提取、usage 排序、summary + 按需工具、压缩前 notes/历史入口**；
- Codem 已有的 `session_search` / `session_event_*` 是意外的“半条历史检索”，说明不必从零造搜索，但需要把它变成**当前任务可解释的 history 入口**。

这两轮不是互相推翻，而是把「文章印象」收敛成「源码事实 + Codem 可施工的取舍」。

---

## 2. Codem 记忆系统全景

这一节是「不漏」的主体：把数据、写入、审批、注入、UI、压缩、测试和交互都列出来。

### 2.1 数据模型与信任边界

`MemoryEntry` 的核心字段：

- `id`、`key`、`content`、`timestamp`；
- `scope: platform | project | conversation`；
- `source: manual | auto`；
- `status?: active | pending`；
- `projectId`（项目级必填）、`sessionId`（对话级必填）；
- `batchId`（自动批次，用于撤销）；
- `legacyPool?: true`（旧版跨项目池标记）；
- `demotedFrom?: MemoryScope`（积压降级留痕）；
- `order?: number`（持久化创建序，防止 JSON 整数键重排）；
- 可选 `tags`、`filePath`。

关键设计：

- `manual` 是用户维护；任何自动流程不得改写/删除；
- `auto` 自动提取；注入时单独成块并标注「未经人工确认」；
- `pending` **不进上下文**；
- 平台级只能手写；自动提取把 `platform` 降为 `project`；
- 缺归属键的 `project` / `conversation` 条目是「孤儿」，**任何上下文都不注入**。

证据：

- `src/core/memory/memory.ts` 的 `MemoryEntry`、`MemoryScope`、`MemorySource`、`MemoryStatus`、`memoryScopeFromExtraction`、`visibleIn`、`injectedIn`。

这是 Codem 比 Codex 更强的地方：Codex 的 memory summary 是全局的，没有项目/对话作用域；Codem 有明确归属和 fail-closed 语义。

### 2.2 存储、payload 与迁移

- 记忆存在设置配置域的 `memory` 字段，整份 JSON payload；序列化版本是 `{version:2, entries, batches, rejections}`，空 rejections 不写字段；
- 默认 `maxEntries = 1000` / 桶，`maxTotalEntries = 5000`，单条 `maxContentLength = 10000`；
- payload 预算 `2 MiB`；
- 每次改动整份写，`save()` 有 `lastPersistedPayload` 无变化捷径；
- 读路径 `loadMemoryChecked()`：
  - 没有存储端口 → `MEMORY_DOMAIN_NO_PORT`；
  - 记忆域未预热 → `MEMORY_DOMAIN_NOT_WARMED`；
  - 形状不认识 / JSON 半截 → 可见失败，不把 fallback 写回；
- 启动顺序：单例可能早于端口注册，`load()` 用 `finally` 恰好通知一次，`MEMORY-LOAD-QUIET` 不让暂时失败弹用户错误；
- 旧数据迁移：
  - 旧 `global` → `platform`；
  - 旧 `session` → `conversation`，但没有 `sessionId` ⇒ 不注入，进体检的「归属未知」；
  - 旧 `project` 无 `projectId` ⇒ 保留旧可见范围，标 `legacyPool`，并给「暂停注入旧版跨项目记忆」开关；
  - 迁移前有 snapshot / 导出 / 回滚接口。

**容易被忽略的硬约束**：

- 反序列化是**字段白名单**（`normalizeLoadedEntry`，`memory.ts` 约 1109–1164 行）；新增 `usageCount` / `lastUsedAt` 等字段必须同步加进白名单，否则重启就丢；
- `key` 不是只注入时截断：写入时就截到 **120**（`MEMORY_INJECT_KEY_MAX`），所以「恢复原标题」不能只改注入；
- `content` 写入截到 10,000；`add()` 返回 `ok:true` 但 `save()` 失败时条目仍留在内存（返回里带 `persist` 错误），不是「完全没写」；
- 导入只守 per-bucket 容量，不守总量/体积，但回执会如实给 `overTotalCap` / `overPayloadBudget`；
- `reload()` 会清 `pendingPersist`，但不等待在途确认链；「旧 payload 后落地」是待验证风险，不能假设 reload 一定最新。

证据：

- `src/core/storage/settings.ts` 的 `loadMemoryChecked` / `writeMemoryConfirmed` / `patchMemoryMirror`；
- `src/core/memory/memory.ts` 的 `DEFAULT_CONFIG`、`MEMORY_PAYLOAD_BUDGET_BYTES`、`migrateScopeModel`、`restorePreMigrationSnapshot`；
- `src/core/memory/checkup.ts` 的归属分组；
- `src/test/memory-boot-order.test.ts`、`memory-migration-guards.test.ts`、`memory-load-visibility.test.ts`。

**结构性风险**：5000 条 × 平均 300 字 ≈ 1.5MB payload；改一条要整份序列化/写穿。当前有 `maxTotalEntries` 和 payload 预算兜底，但这不是长期可扩展的存储形态。P2 若要支持跨项目大规模检索，应迁移到独立表/索引，而不是继续放大设置 payload。

### 2.3 自动提取

入口：

- `process()` 里 `onTurnComplete` 和 `onCompactionComplete` 都会调用 `extractMemoriesFromSession`；
- 默认 `memoryEnabled = true`，可通过 `memory-enabled-<sessionId>` 设置关闭；
- 提取用 `resolveSlot("memory")`（回退 subagent → chat）；
- 用 forked agent 复用父对话前缀，降低 prompt cache 成本。

门槛与配额：

- `messages.length < 10` 不提取；
- 最近 50 条（`MEMORY_EXTRACTION_WINDOW`）；
- 每新增 ≥4 条才再提取（`MEMORY_EXTRACTION_MIN_NEW_MESSAGES`）；
- 单次最多 2 条待批准（`MEMORY_MAX_PER_EXTRACTION`）；
- 单次总写入最多 4 条（`MEMORY_MAX_WRITES_PER_EXTRACTION`）；
- 待批准全局积压上限 5（`MEMORY_PENDING_BACKLOG_LIMIT`）；
- 压缩完成可以 `force: true` 跳过限频。

安全性：

- `explicit: true` 必须有结构性证据：最近窗口里的**用户消息**明确说「记住」；工具结果、文件正文、机器注入消息不算；
- `explicit` 的范围是整批；
- 自动候选不能写平台级；
- `project` 默认 pending；`conversation` 默认 active；
- 候选先做同主题合并（`candidate-merge.ts`），再做逐条查重（`MemoryService.findDuplicateOf`）；
- 拒绝过的相似条目由 `MemoryRejection` 记录挡住，避免反复打扰。

证据：

- `src/core/llm/index.ts` 的 `extractMemoriesFromSession`（约 2460 行起）；
- `src/core/memory/pending-backlog.ts`；
- `src/core/memory/candidate-merge.ts`；
- `src/core/memory/similarity.ts`；
- `src/test/memory-approve-scope-batch.test.ts`、`memory-pending-backlog.test.ts`、`memory-rejection.test.ts`、`memory-dedup.test.ts`。

**关键缺陷**：

1. 提取源是 `MessageStorage.listMessages(sessionId)`，即 `ContextView`（最新 checkpoint + cutoff 之后）；
2. `spawnForked` 内部又读一次 `listMessages(parentSessionId)`；
3. 压缩后旧消息在 `ContextView` 之外，提取器只能看到摘要 marker + 最近消息；
4. `force` 只解决「可见消息数变短导致限频水位变负」，不解决「源数据不在集合里」；
5. 水位是进程内 `Map`，重启后第一次提取会重新跑；靠查重兜底，但会产生额外调用；
6. `onTurnComplete` 在多条结束路径调用（`agentic-loop.ts` 至少 12 处），提取是异步 forked agent，没有单飞/队列/取消；`forkedAbort` 创建后全仓没有一处 `.abort()`；
7. 如果 provider 未配置、响应为空、JSON 解析失败，用户侧几乎没有可见信号（只有 console / 失败上报通道）；
8. `existingMemoryKeys()` 只给模型最近 40 个标题，模型可能重复写较旧的同义事实，靠查重挡，形成「写了又被挡」的噪声；
9. 压缩钩子和回合钩子相邻触发时会各跑一次；没有一条判据模拟这个并发；
10. 提取游标不是持久化的「已提取到哪条消息」，所以重启/压缩后的语义依赖可见消息长度，而不是事件 id。

### 2.4 审批、待批准与积压

- 默认：`platform` 需批准、`project` 需批准、`conversation` 直接生效；
- `pending` 在面板待批准区；批量批准/拒绝；单选/全选；
- 待批准条目显示作用域、归属、来源、截断原因；
- 积压 ≥5 时：project 候选降级为 conversation 直接生效（有 `demotedFrom` 留痕）；如果 conversation 也需批准，则拒绝新增；
- 拒绝记录用于阻止同义重复；
- 用户可以在面板里一键关闭 project 审批，但平台级仍保留。

证据：

- `src/core/memory/memory.ts` 的 `ApprovalScopeSetting`、`approve` / `reject` / `addMany`；
- `src/components/MemoryManager.tsx`；
- `src/test/memory-pending-badge.test.tsx`、`memory-pending-batch.test.tsx`、`memory-pending-scroll.test.tsx`、`memory-demoted-signal.test.tsx`。

**风险**：

- 积压降级会「少一次否决机会」，虽然留痕，但用户不一定看得到；
- 待批准条目按当前位置过滤，归属失效的 pending 只在「记忆体检」可见；真机曾出现 27 条待批准、归属全是已删临时目录的形态；
- pending **没有 TTL**：用户不批，它永久占 bucket 容量，并计入 5 条积压；之后的新候选会被降级或拒写。也就是「越不批，越多东西悄悄生效」；
- 项目删除/会话删除不会自动清理记忆；孤儿 pending 会占总量、让用户困惑；
- 角标按当前项目/会话过滤，全局积压只在面板里有一行；用户可能看不到别处的待批准；
- `approve` / `approveMany` 的容量判定是 `bucketCount > maxEntries`，而 `add` 是 `>=`；批准本身不新增条目，但「导入后已超限」的边界行为尚无判据，需补。

### 2.5 去重、同主题合并与整理

- `similarity.ts`：归一化 + 字符 2-gram Jaccard，阈值 0.30；低档 0.22 + keySim 0.40 辅助；
- 写入前 `findDuplicateOf` 按作用域/归属查重；
- 入队前 `mergeSameTopicCandidates` 做全批两两比较 + 传递闭包，合并正文，保留最严作用域；
- 合并正文上限 1500 字符；超长时只保留标题并如实记录 `droppedContentKeys`；
- `consolidate()`：
  - 只在用户显式动作（「整合」/ `/memory consolidate`）运行；
  - 删除/改写 auto 重复/过期/容量；
  - manual / pending 不参与；
  - 结果用 `reportAdvisory` 如实回执；
- 自动整合在 `llm/index.ts` 中被删除，原因写在代码注释：界面承诺「程序不会自动删除或改写任何条目」，旧实现每回合调用会静默删掉正在使用的旧记忆。

证据：

- `src/core/memory/similarity.ts`
- `src/core/memory/candidate-merge.ts`
- `src/core/memory/memory.ts` 的 `consolidate`（约 5000 行起）
- `src/test/memory-dedup.test.ts`、`memory-duplicate-scale.test.ts`、`memory-audit-228.test.ts`

**没有的东西**：

- `MemoryEntry` 没有 `usageCount` / `lastUsedAt` / `citationCount`；
- 没有「按使用频率排序」；
- 没有跨会话的 Top-N 摘要；
- 没有模型可调用的 `memory_search`（`MemoryService.search` 只供 UI / 内部）。

**其它容易漏掉的能力/边界**：

- `search(query, scope, limit, ctx)` 是词项 OR + key/content/tag 打分，缺 `ctx` 直接返回空（fail-closed）；但它是 UI/内部接口，不是模型工具；
- `findDuplicateGroups()` 是同步 O(n²)；5000 条理论上是 ~1250 万对，`findDuplicateGroupsAsync()` 用分块扫描、让出主线程、进度/取消和 `truncated` 披露，但 UI 仍可能在大库上卡顿；
- `[[link-name]]` 双向链接只在允许的作用域内展开；`findBacklinks` 用于面板；有 `memory-link-scope` 判据防止项目 A 的条目展开项目 B 的正文；
- `tags` 支持 `listByTag`，但注入不按 tag 选；
- 拒绝记录 `MemoryRejection`：`REJECTION_KEEP_MAX = 60`、单条文本 2000；批次上限 50，修剪只进日志；
- `batchId` 可整批撤销；`undoBatch()` 只删该批；导入导出包含 batches + rejections；
- `filePath` 字段存在于类型/导入导出，但读码未见生产写入点；
- `MemoryService.search` 会返回 pending（它用 `visibleIn`），所以新增模型工具必须另走 `injectedIn`；
- `serialize()` 用展开写整个对象，新增字段需要同步 `normalizeLoadedEntry` 白名单，否则读回即丢。

**更容易被忽略的整理缺陷**：

- `consolidate()` 用的是另一套相似度（`calculateSimilarity`：key 按空格切词 × 0.6 + 前 200 字符字符集 Jaccard × 0.4，阈值 0.7），**不是** `similarity.ts` 的 2-gram 尺；
- 中文 key 没有空格 ⇒ keyScore 只有 0/1，两个说法不同的中文 key 往往 ≤0.4，永远过不了 0.7；用户点「整合」会觉得「几乎没变化」；
- 过期清理按 `timestamp`（最后修改时间）而不是 `lastUsedAt`；在加上 usage 之前，不能直接把「按时间清理」当「按冷热清理」；
- 自动整合已被删除是**产品承诺**，不是遗漏；要恢复也只能做「可撤销归档」，不能直接恢复删除。

### 2.6 注入、预算与缓存

注入路径：

- `buildSystemPrompt` 把平台级 manual 放进稳定前缀；
- 项目级 / 对话级 / 自动 / 来源未知放进易变尾部；
- 两块各自带 `MEMORY_AUTHORITY_NOTE`；
- `computeInjection` 统一决定哪些条目进、哪些被截断；
- 每作用域每来源最多 20 条；
- 总字符预算 12,000；
- 单条正文只取前 200 字符；
- key 上限 120；
- 结算时超限如实披露，面板/体检用同一函数判断 `injected`；
- 排序是 `order`（创建序）从新到旧，**不是 relevance**。

证据：

- `src/core/memory/memory.ts` 的 `MEMORY_INJECT_MAX_PER_BLOCK`、`MEMORY_INJECT_CHAR_BUDGET`、`MEMORY_INJECT_LINE_MAX`、`computeInjection`、`formatLine`、`composeMemoryBlock`；
- `src/core/prompt/prompt.ts` 的 `memoryInstructions` / `memoryTailInstructions`；
- `src/test/memory-placement-boundary.test.ts`、`memory-placement-overhead.test.ts`、`memory-redact-shape.test.ts`。

**关键问题**：

- `order` 是创建序，不是「最近被使用」；旧的重要条目会在第 21 条之后永远不注入；
- 单条 200 字符上限使长条目只有开头可见；UI 会披露，但模型没有读取工具；
- **面板/体检与真实提示可能分叉**：`injectionPlan` / `injectionExplanations` 调 `computeInjection` 时**不传** `budgetTracker`，而真实提示传了共享 tracker（`llm/index.ts` 约 917 行）⇒ 面板可能标「已生效」，真实请求却被聚合预算挡下；面板也没有逐条原因，只有块末聚合披露；
- `MemoryManager` 没有渲染 `injection.truncated` 的聚合数字；单条截断能看到，跨块预算挤掉看不到；
- `MEMORY_AUTHORITY_NOTE` 同时挂在 manual 和 auto 块上：自动提取内容也被说成「权威且持续生效」，与 auto 块「未经人工确认」的标注存在语义冲突，也放大 prompt injection 风险；
- 记忆块在稳定/易变边界上，排序变化会 churn volatile 前缀；如果未来改成 usage 排序，需要固定 selection/排序稳定性，否则 prefix cache 收益下降。

### 2.7 UI、体检与可观测

- `MemoryManager`：
  - 搜索（当前作用域，fail-closed）；
  - 作用域筛选、待批准、批量批准/拒绝；
  - 来源三态徽标、作用域徽标；
  - 截断提示（前 200 字符）；
  - 双击展开详情；
  - 导入/导出、撤销批次、拒绝记录；
- `MemoryCheckupView`：
  - 跨项目/会话全量；
  - 平台级 / 旧池 / 项目级 / 对话级 / 归属未知 / 作用域未知；
  - `injected` / `notInjectedReason` 与注入侧同口径；
  - 孤儿归属、失效项目、待批准批量处理；
  - 旧池暂停注入开关。
- 角标：待批准数量与面板同一个 `getStats(ctx).pendingEntries`；
- `notifyMemoryChanged()` 是记忆域变化的唯一通知出口；`load()` 用 `finally` 保证成功/失败/迁移各路径恰好通知一次，避免面板显示旧内存态；
- 面板/角标的 scope 由 `panel-scope.ts` 的 `memoryPanelScope(projectPath, sessionId)` 唯一推导；角标按当前位置过滤，全局积压另有读数；
- 体检 `createMemoryCheckup()` 是跨项目全量视图，与面板的当前位置视图互补；`injected` / `notInjectedReason` 与注入侧共用 `computeInjection`，但**预算 tracker 口径仍有分叉**（见 2.6）。

证据：

- `src/components/MemoryManager.tsx`
- `src/components/MemoryCheckupView.tsx`
- `src/core/memory/checkup.ts`
- `src/core/memory/panel-scope.ts`
- `src/test/memory-checkup.test.tsx`、`memory-pending-badge.test.tsx`、`memory-other-projects-pending.test.tsx`

这是 Codem 的强项：可解释、可处置、可审计，不能为了对标 Codex 而丢掉。

### 2.8 压缩与上下文检查点

- 默认 `compactionThreshold = 0.7`；生产从 `codem-context-config` 读并钳制 `(0.1,0.95]`，读失败回落 **0.8**（UI 文案也常见 0.8）；压力按**整窗口 W** 计算；
- 首轮压力有一个实际缺陷：`estimateContextPressure` 传 `this.currentToolDefs`，但该字段全仓无赋值 ⇒ 无真实 usage 时**漏算 system prompt + 工具 schema**，压缩可能偏晚；
- 连续压缩最多 3 次；有效压缩按压力是否下降计（降幅 <2pp 视为无效）；反应式压缩路径是裸 `consecutiveCompactions++`，且**没有**隐藏状态权威门；
- `planCompactionKeep`：
  - 保留最近轮次（3 轮保底、最多 60 条、下限 4）；
  - 保留集预算约窗口 40%（`max(8000, W*0.4)`）；
  - 超预算成半收缩；
  - 对齐轮次边界，避免切断 tool_use / tool_result；
- 摘要：
  - **生产只用 `buildCompactionInstruction()`**（user 消息尾部，八段式，无 1500 字符上限）；
  - `buildCompactionSystemPrompt()`（六段、规则含“总长度 ≤1500 字符”）**没有生产调用点**；1500 字符上限实际不生效；
  - 中间档 `renderStructuredHistorySummary` 确定性要点；
  - 溢出档只保留可检索要点；
  - `composeCompactionMarkerText` 按 charBudget 分权重裁剪；标记下界 `max(800, removedChars)`，自动路径的 `removedChars` 含旧标记正文，极端情况下会写回近等长标记，造成“压缩空转”，靠熔断兜底；
  - 摘要失败时保留累积摘要/片段兜底，不假装完整；
- 写路径：
  - 先写 marker + `metadata.contextEpoch`（cutoffMessageId、seq、removed/kept、excluded ids）；
  - **不删除、不隐藏旧消息**（检查点模式）；
  - `listMessages` 按 cutoff 投影出模型视图；
  - `listTimelineMessages` 返回完整时间线；
  - cutoff 缺失/无效时 **fail-open 返回全量 + warning**，不静默返回空；
  - 失败方向是「多摘要/多可见」，不是「删了却没摘要」；
- 水位：
  - `water-level.ts` 是唯一计算入口；
  - exact 分支用真实 promptTokens，分母 `W-outputReserve`；
  - estimate 分支分母 `0.9W`，并加 system/tools overhead；
  - 面板另算一次且不含 system/tools、夹到预算 ⇒ **估算态下，面板百分比与提示条百分比不是同一个数**；
  - 提示条只在 ≥90% 点亮；70–89% 交给自动压缩；`WaterLevelBanner.tsx` 里仍有“≥70% 显示”的过时注释；
  - 工具输出折叠阶梯；
- 压缩提示词明确「持久记忆权威，不得因摘要降级」。

**与 Codex 的差异**：

- Codem 仍是同一会话的检查点，不是新的 context window；全仓没有 `windowId`（只有 tmux 插件）；
- 模型能看到摘要 marker + 最近消息；旧消息**并非完全不可读**：`session_search` / `session_event_search` / `session_event_read` 可以绕过 cutoff 读回正文（这是现有“隐藏的第二条路”，但没有按 epoch 的专用入口）；
- 摘要 marker 的尾部仍写「已移除 N 条旧消息」，虽然实际上只是模型视图裁剪；这会让模型/用户以为历史被删了，建议改成「已折叠/模型视图已裁剪」；
- 摘要提示词说「无损恢复」，但 charBudget/分块会裁剪，存在语义不一致；
- 没有压缩前「写 notes」的模型侧提醒，也没有 session notes 工具；
- 压缩调用**不复用主请求前缀**（system 只有一句「你是一个对话摘要专家」），压缩成功后历史前缀从第一条保留消息起改变 ⇒ prefix cache 有机制性损失。

证据：

- `src/core/llm/agentic-loop.ts` 的 `buildCompactionInstruction`、`doCompactMessages`、`compactMessages`；
- `src/core/llm/compaction-budget.ts` 的 `planCompactionKeep`、`renderStructuredHistorySummary`、`composeCompactionMarkerText`；
- `src/core/context/context-view.ts`、`src/core/context/water-level.ts`；
- `src/core/llm/token-tracker.ts`（压力分母/真实 usage）；
- `src/core/llm/tools/session-search.ts`（通用历史检索）；
- `src/test/compaction-audit-228.test.ts`、`compaction-budget.test.ts`、`compaction-gradient.test.ts`、`compaction-headroom.test.ts`、`context-water-level-banner.test.tsx`。

### 2.9 跨功能交互

- 记忆归属：`resolveMemoryProjectId` 统一写入侧和注入侧；worktree 用项目身份，不用 worktree cwd；
- **但归属键本质仍是归一化工作目录**：移动项目、worktree 目录删除、临时目录提取都会让旧桶失效；`projectIdFromCwd` 只做大小写/尾分隔符归一，不做项目 id 映射；
- 子智能体：`processSubagent` 走独立 loop，默认不接入 memory 回调；但委派/后台 `executeSessionTurn` 可能仍是普通 session，需确认它是否应提取记忆；
- 文档索引 / 知识库：注入是独立 `knowledgeContext`，不经过 MemoryService；两者都占用上下文预算，但预算没有统一核算；
- 标题生成 / fork / 导出 / 搜索：`listMessages` vs `listTimelineMessages` 的口径不同；记忆提取目前用 `listMessages`，历史面板用 `listTimelineMessages`；
- **已有历史搜索/事件工具**：`session_search`（FTS，可跨会话/按 session 过滤，limit≤50）、`session_event_search`（按 session 搜事件，limit≤100）、`session_event_read`（按 seq 读事件及上下文）、`session_trace`（fork 谱系）。它们读 FTS/事件日志，压缩不清这些索引，所以模型**有可能**通过关键词/事件 seq 读回压缩前正文；但：
  - 不是按 epoch/cutoff 的精确回读，模型得自己知道用哪个工具、搜什么词；
  - `session_event_read` 需要 session_id + seq，模型通常不知道 seq；
  - 事件日志是否保留完整 tool output 需验证；
  - 这些工具是“通用历史搜索”，不是“当前任务的记忆/历史交接”，也没有 notes；
- `create_note` / `edit_note` / `link_notes` / `delete_note` 是 **notebook 知识库**笔记，不是 session scratchpad；不要把它们当 Codex Notes；
- 远程/手机 Host：记忆在 Host 数据目录；多客户端同一 Host 时共享记忆，需要确认作用域/并发；
- 平台设置：审批开关、旧池暂停、记忆启用是不同键，读失败时 fail-closed 的方向不完全相同（审批读失败按需批准；记忆 enable 读失败默认 true）。

### 2.10 测试与真机证据

Codem 记忆相关测试文件约 30 个，重点覆盖：

- 迁移/旧 id/key 形状：`memory-migration-guards.test.ts`、`memory-legacy-idmap-shape.test.ts`；
- 作用域/归属：`memory-scope-trust.test.ts`、`memory-project-id-paths.test.ts`；
- 注入边界/预算：`memory-placement-boundary.test.ts`、`memory-placement-overhead.test.ts`；
- 审批/积压/降级：`memory-pending-backlog.test.ts`、`memory-approve-scope-batch.test.ts`、`memory-demoted-signal.test.tsx`；
- 去重/合并：`memory-dedup.test.ts`、`memory-duplicate-scale.test.ts`；
- 拒绝记录/撤销：`memory-rejection.test.ts`、`memory-audit-228.test.ts`；
- UI/体检/角标：`memory-checkup.test.tsx`、`memory-pending-badge.test.tsx`、`memory-panel-layout.test.tsx`；
- 启动顺序/读写可见性：`memory-boot-order.test.ts`、`memory-load-visibility.test.ts`。

但**没有**这些判据：

- 长会话压缩后，早期事实仍能被提取并注入；
- 500 字记忆的完整正文能被模型读取；
- 30 条记忆中，旧的高使用条目仍能进上下文；
- 面板/体检的 `injected` 与真实提示（含聚合预算）逐条一致；
- 压缩前提醒写 notes + 压缩后按需读 notes；
- 两个连续回合触发提取时不重复/不竞争；
- 归属失效的 pending 不产生/可迁移；
- 自动记忆内容中的 prompt injection 不会升级为权威指令；
- 中文近重复（不同 key）在 `consolidate` 中能合并；
- `reload()` 与在途确认链不会互相覆盖；
- 项目删除 / 移动 / worktree 删除后的记忆归属迁移；
- 压缩后 `session_search` / `session_event_read` 能读回旧正文（现有能力，无判据）；
- 面板/提示条/压缩阈值在 exact 与 estimate 两种口径下的一致性。

这解释了一个重要现象：**单元测试很多、单个机制很硬，但用户看到的「偶尔不对」往往发生在机制之间**，尤其是「面板/真实提示」「提取/压缩」「写入/重载」「项目/归属」的接缝上。

### 2.11 失败模式清单
| # | 用户症状 | 代码机制 | 证据/置信度 |
|---|---|---|---|
| 1 | 「它只记得开头」 | 注入 `substring(0, 200)`，无全文读取工具 | A |
| 2 | 「这条明明在库里，模型不用」 | 每块 20 条 + 创建序，无 usage 排序 | A |
| 3 | 「压过一次就忘了早期细节」 | 提取源 `listMessages`，旧消息在 cutoff 之外 | A |
| 4 | 「刚说完的重要事实没记住」 | 10 条门槛 / 4 条限频 / 异步提取未完成 | A/B |
| 5 | 「同一条反复问、反复写」 | 只给最近 40 个标题；同义查重有阈值 | B |
| 6 | 「待批准越积越多」 | 速率上限 ≠ 存量；积压 5 条后降级 | A |
| 7 | 「批准了还是不生效」 | 缺归属键/项目/会话已删/旧池暂停 | A |
| 8 | 「换项目后记忆串了」 | 旧 `project` 无 `projectId` 的 legacy pool | A |
| 9 | 「重启后记忆顺序变了」 | JSON 整数键重排；`order` 已修复 | A |
| 10 | 「压缩后对话没变短」 | 摘要 marker 很大 / 压缩失败 / 连续压缩 | A/B |
| 11 | 「压缩后模型重跑工具」 | 保留集切进工具块 / 孤儿 tool result | A |
| 12 | 「历史面板有，模型没有」 | `listMessages` 与 `listTimelineMessages` 两套视图；模型有 `session_search`，但没有按 epoch 的专用回读 | A（部分） |
| 13 | 「自动记忆像指令」 | auto 块与 manual 共用权威性 note；工具内容可被提取 | B/C |
| 14 | 「删除项目后还有幽灵记忆」 | 项目删除不清理 memory，孤儿条目仍在 | A/B |
| 15 | 「记忆越写越慢」 | 设置 payload 整份读写；5000 条/2MB | A |
| 16 | 「压缩后 prefix cache 变差」 | volatile memory 排序/内容变化 | B |
| 17 | 「换模型/换会话记忆行为不同」 | memory slot/provider 未配置、模型差异 | B |
| 18 | 「记忆启动期丢失/报错」 | 端口未预热、配置域未预热 | A（已有修复） |
| 19 | 「面板说已生效，模型却没用」 | `injectionPlan` 无 tracker vs 真实提示有共享 12000 预算 | A（读码确证，缺判据） |
| 20 | 「点了整合几乎没变化」 | consolidate 用空格切词相似度，中文近重复过不了 0.7 | B（读码推定） |
| 21 | 「移动项目/删 worktree 后记忆不见」 | 归属键 = 归一化工作目录，不是稳定 project id | A/B |
| 22 | 「刷新面板后旧内容回来了」 | `reload()` 清 pendingPersist 但不等待在途写 | B（竞态待判据） |
| 23 | 「标题被改短」 | key 写入即截 120 | A |
| 24 | 「拒绝/待批准很久也不消失」 | pending 无 TTL，占 bucket 容量 | A |
| 25 | 「第一次压缩偏晚」 | 首轮压力传的 `currentToolDefs` 从未赋值，漏算 system/tools | A（读码） |
| 26 | 「溢出了才发现压缩」 | 反应式压缩路径没有隐藏状态权威门 | A（读码） |
| 27 | 「面板 70%、提示条 90%、压缩又不动」 | exact/estimate 分母不同；面板不含 overhead；提示条 ≥90%；压缩按压力 | A/B |
| 28 | 「压了等于没压」 | 自动路径 removedChars 含旧标记，标记下界 800，可能写回近等长标记 | B |
| 29 | 「第二次压缩把前次摘要裁了」 | 自动路径 prior 摘要参与 clip；手动路径有级联保护 | B |
| 30 | 「提示条 70% 才显示」 | 代码是 ≥90%；`WaterLevelBanner.tsx` 注释过时 | A |

---

## 3. 差距与根因

### 3.1 差距矩阵

| 维度 | Codex 源码 | Codem 现状 | 差距性质 |
|---|---|---|---|
| 提取源 | 完整 rollout，tier 取样 | `ContextView` 最近 50 条 | **结构性** |
| 提取时机 | 首个有输入的 turn 后 + 空闲/年龄/额度门 | 回合结束异步 | **噪声/竞争** |
| 全局巩固 | 256 条 usage Top-N + summary | 手动 consolidate，无 usage | **缺失** |
| 注入 | 2.5K summary + tools | 12K 字符、每条 200 字 | **检索缺失** |
| 单条全文 | read 20K token | 无工具 | **直接功能缺口** |
| 历史 | history list/read/search（按 window/item） | 有 `session_search` / `session_event_search` / `session_event_read` / `session_trace`，但没有按 epoch 的专用回读 | **部分有，入口不对** |
| 笔记 | notes append/read（session 级） | 只有 notebook 的 `create_note` 等；无 session scratchpad | **压缩衔接缺失** |
| 压缩前提醒 | reminder/fallback | 只有 UI 水位 | **模型侧缺失** |
| 新窗口 | window id + 64K retained | 同会话 epoch | **形态差异** |
| 默认状态 | MemoryTool/TokenBudget 默认关 | 记忆默认开 | **风险面不同** |
| 作用域 | 全局 summary | 平台/项目/对话 | **Codem 更强** |
| 审批/信任 | 无 manual 概念 | manual/pending/拒绝记录 | **Codem 更强** |
| 自动删除 | consolidation 会改写 | 明确不自动删改 | **不能照搬** |

### 3.2 根因排序

1. **记忆检索层缺失**：模型只有静态注入，没有 `memory_read` 读全文；历史侧虽有通用 `session_search`，但不是当前任务的记忆入口；
2. **静态注入被 200 字符截断**：长记忆只有开头；
3. **选择信号缺失**：20 条 + 创建序，旧重要条目被挤出；
4. **提取源与压缩视图耦合**：压缩后提取看不到原文；
5. **提取路径没有单飞/空闲门**：每回合异步、可能重复/竞争；
6. **没有模型侧压缩前交接**：摘要漏了，模型不一定知道/会用 `session_search` 找回；也没有 session notes；
7. **首轮压力漏算 system/tools + 反应式压缩无权威门**：压缩偏晚或在错误可见集上跑；
8. **水位/面板口径不一致**：用户看到 70% / 压缩阈值 / 提示条 90% 不是同一个数；
9. **归属/积压/迁移的边缘态**：孤儿 pending、旧池、项目删除、worktree；
10. **安全语义冲突**：auto 内容与 manual 共用「权威」note。

---

## 4. 目标架构

### 4.1 分层

```text
写入层
  JSONL 完整时间线 / event log
    → 按 tier 取样（Human / Final / Agent / Commentary / Context / Tool）
    → 候选校验（scope、manual 保护、去重、合并）
    → pending / approve
    → usage 反馈
    → memory 索引（只投影，不删除）

读取层
  系统提示
    ├─ 稳定：平台 manual（pinned）
    └─ 易变：项目/对话 manual + auto 索引（按 score）
  工具
    ├─ memory_search / memory_read
    ├─ history_read（按 epoch/message id；复用 listTimelineMessages）
    ├─ 保留现有 session_search / session_event_* 作为通用兜底
    └─ notes_list / notes_read / notes_append（session 级）

压缩层
  80% → 提醒写 notes
  100% → fallback prompt / checkpoint
  checkpoint = 短 thread hint + 最近轮次 + notes/history 可查
```

### 4.2 关键原则

1. **静态注入只放索引**，全文按需读；不要让 200 字符成为事实边界；
2. **提取源是完整时间线**，不是模型可见集合；
3. **提取离线化/单飞**，不要每轮抢资源；
4. **使用信号决定 Top-N**，但 manual/pinned 永不自动删除；
5. **压缩前模型侧交接**，不能只靠 UI 提示；
6. **历史/笔记/记忆都是数据，不是指令**；auto 内容明确 untrusted；
7. **保留 Codem 的审计/回滚/披露**，不为了「像 Codex」而破坏。

### 4.3 建议的数据模型增量

```ts
interface MemoryUsage {
  usageCount?: number;    // 被 read / citation 命中
  lastUsedAt?: number;
  pinned?: boolean;       // 可选；manual 默认视为 pinned
}

interface MemoryIndexEntry {
  id: string;
  scope: MemoryScope;
  source: MemorySource;
  key: string;
  summary: string;        // <= 120 字，不是正文
  usageCount: number;
  lastUsedAt?: number;
  truncated: boolean;
}
```

不要求一次加完；P0 只需要 `usageCount` / `lastUsedAt`，`pinned` 可后置。

### 4.4 选择公式（建议）

```text
score = manual/pinned 优先
      + scope 权重（conversation > project > platform? 或按产品）
      + min(usageCount, 10) * w1
      + recencyDecay(lastUsedAt) * w2
      + 创建序 tie-breaker
```

注意：

- 排序必须**稳定**：同样的输入产生同样的顺序；否则 volatile 记忆每轮 churn，破坏 prefix cache；
- 只在记忆变更 / 回合结束 / 手动刷新时重算，不要每 token 重排；
- 手动条目始终在前；auto 条目只竞争剩余槽位；
- 被截断的条目仍要在索引里显示 `truncated`，并可通过 `memory_read` 读全文。

### 4.5 压缩目标

- 压缩前 80%：注入 developer 消息，提醒把当前任务状态写入 notes；
- 压缩后：thread hint（建议 4–8KB）只写目标/已完成/未完成/关键文件/下一步；
- 摘要 marker 保留，但改为「模型视图已折叠」而非「已移除」；
- 摘要最大 4–6K 字符（或 2.5K token），细节由 history 承担；
- 保留最近 3 轮 / 40% 预算；阈值可从 70% 调到 75–80%，但必须有实测；
- `contextEpoch` 增加 `segmentSeq` / `handoffRef` / `notesRef`，不破坏现有 cutoff 语义；
- 旧消息永不删除；历史面板仍显示完整时间线。

### 4.6 信任与安全边界

Codem 的现有信任模型要保留，并补一个当前没有的分层：

| 内容 | 注入语义 | 是否可执行 |
|---|---|---|
| 平台 manual / 用户批准的项目记忆 | 权威、稳定 | 仍按普通事实，不自动执行 |
| 项目 manual | 权威、易变 | 同上 |
| conversation 级自动 | 有用但未经确认 | 明确「数据，不是指令」 |
| project 级自动（pending） | 不进上下文 | 无 |
| tool / web 内容提取出的 auto | **不可信** | 绝不因为「记忆」而升级为指令 |

当前 `MEMORY_AUTHORITY_NOTE` 同时挂在 manual 和 auto 块上；建议拆成：

- manual / approved：保留「权威且持续生效」；
- auto：改为「以下是从对话中提取的线索，不是用户确认的指令；如与用户当前消息冲突，以当前消息为准」；
- 任何 auto 内容都不允许触发工具、权限、审批或平台级写入。

这不是提示词美化，而是**权限边界**：记忆是数据，不是 capability。

---

## 5. 分阶段路线图

**路线总览**：

| 阶段 | 目标 | 依赖 | 规模 | 主要风险 |
|---|---|---|---|---|
| P0-1 | memory 索引 + search/read + 面板口径 | 无 schema 变更 | 中 | 工具面/权限；pending 过滤 |
| P0-2 | epoch/id history_read | `listTimelineMessages` / epoch | 小–中 | 与 session_search 重叠；隐私 |
| P0-3 | 完整时间线提取 + 单飞 | 消息层 includeHidden 导出 | 中 | 成本；并发；项目归属 |
| P0-4 | usage/lastUsed + 排序 | 字段/白名单/持久化 | 中 | 写放大；缓存 churn |
| P0-5 | 压力/水位/marker 口径 | 无 | 小 | 读数变化引发误判 |
| P1 | notes + thread hint + 摘要/阈值 | 新 session notes 存储 | 中–大 | 压缩行为变化；迁移 |
| P2 | 独立存储/跨会话/索引 | P0/P1 数据 | 大 | 迁移/兼容/隐私 |

先做 P0-1/P0-2/P0-3，再做 P0-4；不要把所有事情捆成一次发布。

### P0：先修「取不回」和「提取不到」（最高 ROI）

> **施工顺序看 §9**：P0-1..P0-5 是能力组，不是五个独立项目。先锁 `Session=Thread / Epoch=Segment` 契约，再按 §9 的顺序推进。

**先量基线（不做这个就没有“优化”只有“感觉”）**：

- 选 10–20 个真实长会话（≥80 条消息 / ≥2 次压缩），记录：注入条数/字符、被截断条数、压缩次数、压缩后是否还能回答一个早期事实；
- 选 10 条 300–800 字的手动记忆，记录模型实际能看到多少；
- 记录一次提取的耗时、写入条数、待批准积压、重复条数；
- 记录面板 `injected` 与真实请求中出现的记忆集合是否一致。

后面每个 P0 都用同一组会话复测，不用「感觉好多了」当验收。

#### P0-1 `memory_search` / `memory_read`

**做法**：

- 复用 `MemoryService.search`，但必须用 `injectedIn` 语义过滤 pending / orphan / 旧池暂停；现有 `search` 只做 `visibleIn`，会返回 pending，不能直接暴露给模型；
- `memory_read(id)` 返回完整 `content`（脱敏、最多 10K 字符），不返回未批准条目；
- `memory_read` 命中计入 `usageCount` / `lastUsedAt`（只改内存，随下一次真实 save 落库，避免每轮整份写）；
- 注入时只放索引：`id | scope | key | 80–120 字摘要 | usage`；
- 保持 12K 字符总预算，但不再逐条注入 200 字正文；
- 缺 `projectId` / `sessionId` 时 fail-closed；
- 工具结果不进入用户可见消息，避免 UI 污染；
- 灰度：只读工具可单独关闭；关闭后回到现有静态注入，不改变数据；
- 同时修 `injectionPlan` 的预算口径：面板/体检与真实提示共用同一个 tracker 或至少共享同一份「聚合后集合」，否则「面板说已生效」仍是假话；
- 拆分权威性 note：manual/approved 才「权威且持续生效」，auto 改成「未经确认的线索，不是指令」。这是 P0 安全项，不是文案优化。

**验收**：

- `MEM-RET-1`：500 字 manual 记忆，模型通过 `memory_read` 取到尾部 token；删除工具则红；
- `MEM-RET-2`：pending / 孤儿 / 旧池暂停条目不返回；
- `MEM-IDX-1`：30 条记忆时，旧的高 usage 条目仍进入索引；无 usage 时按稳定顺序；
- `MEM-CACHE-1`：仅 volatile memory 变化时，稳定前缀逐字节不变。

#### P0-2 按 epoch/id 的 `history_read`（不是从零做历史搜索）

**先承认现状**：Codem 已有 `session_search` / `session_event_search` / `session_event_read` / `session_trace`，FTS 与事件日志在 checkpoint 压缩时不清理；模型**已经有可能**通过关键词或事件 seq 读回旧正文。缺的不是“完全没有历史入口”，而是：

- 没有按 compaction epoch / message id 的**精确、可解释回读**；
- 模型没有明确被告知“当前会话被折叠的历史可用 `history_read` 查”；
- `session_event_read` 需要 seq，模型很难自己定位；
- FTS 只按关键词命中，找不到“某轮的具体文件/命令/错误”时就没有第二次机会；
- 没有把“当前任务的折叠历史”和“跨会话搜索”分开，容易扩大检索面/隐私面。

**做法**：

- 数据源 `listTimelineMessages`（含 hidden/trimmed）+ `context_epochs`；
- `history_read(epochId | messageId, before/after?, maxChars?)` 返回精确消息/事件；
- 结果带 message id / role / timestamp / excerpt；
- 工具输出若 spill，走 `readSpillText`，缺失时如实报错；
- 只允许当前 session；分页/上限 200 条 / 20K token；
- 脱敏；不返回系统内部消息；
- 压缩 marker 尾部提示「需要旧细节用 history_read；需要关键词搜索继续用 session_search」；
- 保留现有 `session_search` / `session_event_*` 作为跨会话/通用兜底，不重复造一套搜索。

**验收**：

- `HIST-1`：压缩后旧命令/错误能按 epoch/message id 读回；按关键词仍可用 `session_search`；
- `HIST-2`：spill 全文可读；伪造 locator 被拒；
- `HIST-3`：跨 session 查询 fail-closed，除非显式 `session_search` 跨会话；
- `HIST-4`：`history_read` 不会把当前模型视图之外的全部历史自动注入；只返回调用者请求的范围。

#### P0-3 提取源与单飞

**做法**：

- `extractMemoriesFromSession` 改用完整时间线；数据层已有 `listTimelineMessages` / `listMessagesFromIndex(..., includeHidden=true)`；如果只加一个导出，建议 `listMessagesIncludingHidden(sessionId, limit)`，明确「含 hidden/trimmed、按时间序」；
- `spawnForked` 不能内部再读 `listMessages`；增加 `sourceMessages` / `timeline` 参数，或独立的 extraction prompt 输入；否则主函数换了源，forked agent 仍然读旧视图；
- tier 取样：Human > Final > Agent > Commentary > Context > Tool；
- 8MB / 70% 窗口上限，头尾保留；
- 排除 compaction marker、机器注入消息、系统消息；
- 水位按**事件 id / epoch** 持久化，不再按可见消息长度；否则源一变、水位差变负，提取又会被限频门挡住；
- 每 session 单飞：in-flight Promise，新回合只标记 dirty；关闭会话取消；`forkedAbort` 目前没有 `.abort()`，要接上；
- 空闲/延迟批次（例如 30–120 秒或用户离开会话后），不要每回合立即跑；
- 归属键缺失时写 conversation 或跳过并上报，不创建临时 project 条目；
- 提取后再做一次「可提取性」校验：压缩前的旧消息必须真的被读入，不能只看摘要 marker。

**验收**：

- `MEM-EXTRACT-1`：100 轮会话、事实在第 2 轮、压缩 3 次，提取仍能写入/召回；把 source 改回 `listMessages` 则红；
- `MEM-EXTRACT-2`：两个连续回合触发时只跑一次；
- `MEM-EXTRACT-3`：provider 失败/空响应/坏 JSON 不更新水位、不产生幽灵批次；
- `MEM-EXTRACT-4`：无项目身份时不产生孤儿 project 条目。

#### P0-4 使用信号与排序

**做法**：

- `MemoryEntry` 增加 `usageCount` / `lastUsedAt`；
- **必须同步 `normalizeLoadedEntry` 白名单**，否则重启即丢；
- 在 `memory_read` 命中、模型 citation（若实现）、用户查看全文时累加；不要只用「被注入」；
- 注入选择改为 manual/pinned + scope + usage + recency；创建序只做 tie-breaker；
- `memory_search` 可返回未注入但可见的条目；
- 不自动删除；低分条目只降权/归档；
- 写入只改内存 + 标记 dirty，随下一次真实 save 落库，避免每轮整份 payload 写放大。

**验收**：

- `MEM-RANK-1`：旧的高 usage 条目优先于新的低 usage 条目；
- `MEM-RANK-2`：manual/pinned 永不被挤出；
- `MEM-RANK-3`：重启后顺序稳定（持久化 usage/order）。

#### P0-5 压缩计量口径（小改动、先修假结论）

- 修首轮压力：`estimateContextPressure` 当前传的 `this.currentToolDefs` 全仓无赋值，应改为当前真实工具定义（或显式传 `0` 并在日志/面板说明「未计入」，不能静默漏算）；
- 反应式压缩补隐藏状态权威门，与自动/手动路径一致；
- 统一 `exact` / `estimate` 的水位分母，或至少在面板标注「估算/真实」与两种百分比差异；不要让用户同时看到 70% / 90% / 压缩阈值三个数；
- 修 `injectionPlan` 的 tracker 分叉（与 P0-1 一起做）；
- 修自动路径 `removedChars` 含旧标记导致的等长标记空转：计算待压字符时排除旧 marker 正文，或对 marker-only 投影直接返回「无可压」。

**验收**：

- `CMP-P-1`：首轮压力包含 system + tools；去掉工具定义则压力明显偏低（用固定夹具读数）；
- `CMP-P-2`：反应式压缩在隐藏状态未就绪时不运行；
- `CMP-P-3`：同一会话、同一时刻的面板/提示条/压缩阈值使用同一分母与口径，或明确标注差异；
- `CMP-P-4`：marker-only 压缩不会写回近等长标记，不会触发假「窗口已满」。

### P1：压缩衔接与模型侧交接

#### P1-1 Notes 工具 + 压缩前提醒

- `notes_append` / `notes_read` / `notes_list`（session 级；不是长期记忆）；
- 80% 时注入 developer 提醒：把目标/进度/卡点写进 notes；
- 压缩后注入 thread hint（4–8KB）读取 notes；
- notes 不可用时回退到摘要 marker；
- notes 内容对用户可见（至少可查），不搞完全隐藏的模型私有状态；
- 把 auto/记忆内容标为 untrusted，不把 notes 当权限或审批来源。

#### P1-2 摘要质量与阈值

- 摘要 prompt 保留结构化，但加「历史仍可用 history_read / session_search 查」；
- 摘要最大 4–6K 字符；不要出现「已移除」这种与实际不符的措辞；
- **只维护一个 pressure 模型**：沿用当前阈值（默认 0.7）作为考虑线；实测微调可以，但不要引入第二套 80%/90% 阈值；`switch` 由 §9 的 context manager 决定，不是另一个自动压缩器；
- 连续压缩最多 2 次；
- `contextEpoch` 写 `segmentSeq` / `handoffRef` / `notesRef`；
- 不删除旧消息；历史面板/模型视图分离保持。

#### P1-3 可选 consolidation

- 只在用户显式触发或后台空闲时运行；
- 只处理 auto、非 pending；
- manual 永不删除/改写；
- 合并生成 diff，可撤销；
- 低使用条目「归档」而非删除；归档可恢复；
- **统一相似度实现**：`consolidate` 现在用空格切词 + 字符集 Jaccard（中文 key 几乎合不了），应改用 `similarity.ts` 的 2-gram 尺，或至少让同一事实两种说法可被检索；
- 不照搬 Codex 的自动改写 `memory_summary.md`。

### P2：规模与跨会话

- 记忆从设置 payload 迁到独立表/索引（FTS + 可选向量），保留设置镜像兼容；
- 跨会话/跨项目检索（显式 opt-in，作用域过滤）；
- 记忆摘要/索引缓存；
- 观测面板：注入条数、token、截断、usage、search 命中、压缩后召回；
- 多客户端（桌面/手机 Host）并发写记忆的冲突策略。

---

## 6. 验收判据清单

| ID | 场景 | 通过条件 | 变异自证 |
|---|---|---|---|
| MEM-RET-1 | 500 字 manual 记忆 | 模型能读到尾部唯一 token | 删 `memory_read` ⇒ 红 |
| MEM-RET-2 | pending / 孤儿 / 旧池暂停 | 工具不返回 | 改回 `visibleIn` ⇒ 红 |
| MEM-IDX-1 | 30 条、旧高 usage | 旧条目仍在索引/可读 | 改成创建序 Top-20 ⇒ 红 |
| MEM-CACHE-1 | volatile 变化 | stable 前缀逐字节不变 | 排序引入时间戳 ⇒ 红 |
| HIST-1 | 压缩后旧命令 | `history_read` 按 epoch/id 命中；`session_search` 仍可关键词命中 | 改读 `listMessages` ⇒ 红 |
| HIST-2 | spill 全文 | 能读；伪造 locator 拒绝 | 去掉根目录校验 ⇒ 红 |
| HIST-3 | 跨 session | 默认 fail-closed；显式 session_search 才跨会话 | 去掉 scope 校验 ⇒ 红 |
| MEM-EXTRACT-1 | 3 次压缩后早期事实 | 仍可召回 | `listMessages` 源 ⇒ 红 |
| MEM-EXTRACT-2 | 连续两回合 | 单飞，只一个批次 | 去掉锁 ⇒ 红 |
| MEM-EXTRACT-3 | 空响应/坏 JSON | 不更新水位、无幽灵批次 | 提前更新水位 ⇒ 红 |
| MEM-EXTRACT-4 | 无项目身份 | 不写孤儿 project | 回退临时 cwd ⇒ 红 |
| MEM-RANK-1 | 旧高 usage vs 新低 usage | 旧条目优先 | 去掉 usage ⇒ 红 |
| MEM-RANK-2 | manual 满 20 条 | manual 不被 auto 挤出 | auto 先选 ⇒ 红 |
| MEM-PANEL-1 | 面板/体检 vs 真实提示 | `injected=true` 的集合与真实提示一致，聚合预算挡下也要有逐条原因 | 去掉 tracker / 原因 ⇒ 红 |
| CMP-P-1 | 首轮压力 | 计入 system + tools | 删工具定义 ⇒ 红 |
| CMP-P-2 | 反应式压缩 | 隐藏状态未就绪时不运行 | 去掉门 ⇒ 红 |
| CMP-P-3 | 水位口径 | 面板/提示条/阈值同源或明确标注差异 | 改回两套分母 ⇒ 红 |
| CMP-P-4 | marker-only 压缩 | 不写回近等长标记，不假报满 | 去掉排除 ⇒ 红 |
| NOTE-1 | 80% 水位 | 提醒写入 notes；压缩后能读 | 去掉提醒 ⇒ 红 |
| COMPACT-1 | 压缩后摘要 | 不超过预算；历史仍完整 | 删历史 ⇒ 红 |
| COMPACT-2 | 压缩 marker | 不再宣称「已移除」 | 文案回退 ⇒ 红 |
| CONS-1 | 用户整合 | manual/pending 不动；auto 可撤销 | 自动删 manual ⇒ 红 |
| CONS-2 | 中文近重复 | 同一事实两种说法能合并/至少可检索 | 恢复空格切词 ⇒ 红 |
| RELOAD-1 | 写入 + reload | 不出现旧 payload 覆盖新 payload | 去掉等待/排队 ⇒ 红 |
| SEC-1 | 工具输出含「记住…」 | 不升级为 manual/权威；不自动平台级 | 去掉 structural explicit 判据 ⇒ 红 |
| UI-1 | 长记忆 | 面板显示截断原因 + 可读全文 | 隐藏原因 ⇒ 红 |
| PERF-1 | 5000 条 | 索引生成不阻塞 UI；搜索有界 | 恢复 O(n²) 同步 ⇒ 红 |

所有判据按仓库纪律做**变异自证**：把实现改坏能让判据变红，否则判据无效。

---

## 7. 风险、不可照搬与待决策

### 7.1 不能照搬 Codex 的部分

1. **自动 consolidation 删除/改写**：违反 Codem「不自动删除或改写任何条目」承诺；
2. **全局 memory summary 无项目作用域**：Codem 的三级作用域是优势；
3. **默认开启实验性 MemoryTool/TokenBudget**：Codex 自己默认关闭；
4. **citation 作为唯一正确性/使用信号**：模型可以误引/刷引用；
5. **完全清空的新窗口**：Codex 仍保留 64K client messages；Codem 的完整历史/审计也有价值；
6. **把 4KB Thread Hint 当事实**：当前源码没有这个实现。

### 7.2 主要风险

- **Prompt injection**：auto memory 来自用户/助手/工具内容；`MEMORY_AUTHORITY_NOTE` 同时覆盖 auto 块，可能把外部指令升级为权威；需要把 auto 标为 untrusted，manual/approved 才权威；
- **隐私/成本**：完整时间线提取会把更多内容发给模型；需要 redact、opt-out、空闲批次、额度门；
- **缓存 churn**：usage 排序改变 volatile 记忆顺序，可能降低 prefix cache 命中；需要稳定 selection/排序 epoch；
- **数据迁移**：usage 字段、notes、历史工具都可能触碰旧库；必须可回滚，不删除；
- **工具面扩大**：`memory_read`/`history_read` 会暴露更多本地内容；必须作用域、脱敏、只读、审计；
- **性能**：5000 条 payload 整份读写、搜索 O(n)；P2 前不要无限放大；
- **UX 复杂度**：索引、全文、notes、history 都可能让用户困惑；面板必须显示「模型看到了什么」。

### 7.3 需要产品决策

1. `memory_search` 是否默认暴露给模型，还是只在记忆条数 > N 时启用？
2. auto 记忆是否一律标为 untrusted，manual/approved 才用权威性 note？
3. `conversation` 级自动记忆是否继续直接生效，还是也需审批（安全 vs 打扰）？
4. history 是否允许跨 session 搜索（默认否）？
5. 压缩阈值是否在同一 pressure 模型内微调（**不引入第二套 80%/90% 阈值**）？必须先有 P0 检索能力再调；
6. 是否允许后台 consolidation（默认仅用户触发）？
7. 记忆独立表迁移的时机/兼容策略。

---

## 8. 结论

Codem 的记忆系统不是「缺一张表」或「提示词不够好」。它已经有很强的信任、审批、审计、迁移和压缩基础；真正缺的是**记忆侧检索层**、**完整提取源**和**按 epoch 的历史入口**。历史侧不是零：`session_search` / `session_event_*` 已能搜回压缩前正文，但模型没有一条明确的「当前任务折叠历史」路径，也没有 session notes。

最优先的三件事：

1. 让模型能 `memory_read` / `memory_search` 读记忆全文；
2. 让提取器读完整时间线，而不是压缩后的可见集合；
3. 让注入按 usage 选，而不是按创建时间。

再加两件压缩衔接：

4. 压缩前提醒写 session notes，压缩后注入短 thread hint；
5. 加按 epoch/id 的 `history_read`，把现有 `session_search` 从“碰巧能搜到”变成“明确可回读”。

这几件事做完，Codem 的「零星记忆问题」才会从不可解释的模型行为，变成可观测、可复现、可优化的检索/排序问题。

> 以上是**能力优先级**；实际施工顺序已由 §9 融合裁决调整为：`契约 → memory 检索 → thread history → context manager → UI`。不要按本节的三件事单独排期，否则会先按 `sessionId` 造完再迁移。

Codex 的 Token Budget / History / Notes 值得借鉴，但应按 Codem 的信任模型改造：

> **保留检查点与完整历史，增加索引与按需读取；不自动删除，不把摘要当唯一记忆。**

---

## 9. 与 DS-Bot 对标的融合裁决（最终方案）

> 本节是 24 / 25 两轮对标的**唯一裁决**；25 号文提供 DS-Bot/ICM 的实现细节，若与本节冲突，以本节为准。
> 目标不是把 Codex 的 window 和 DS-Bot 的 segment 各做一套，而是合成一个 Codem 原生机制。

### 9.1 唯一模型：Session = Thread，Epoch = Segment

第一版**不要新建 Thread 表，也不要每次换段新建 Session**。直接复用 Codem 已有的三层：

```text
Session（用户看到的一个对话 = Thread）
  └─ ContextEpoch（一次上下文边界）
       ├─ kind=compact：原地压缩，旧消息保留，模型看 marker + 尾部
       └─ kind=switch：换段，写 handoff marker，模型看 handoff + 尾部
```

- **Thread** 是产品概念，不是新存储实体；`session.id` 就是 thread id。
- **Segment** 是逻辑段：两次 `kind=switch` 之间的 epoch 序列；不是新 Session。
- **Compact** 是段内压缩；**Switch** 是段边界；两者都写 `context_epochs`，旧消息永不删。
- `DisplayView = listTimelineMessages` 始终完整；`ContextView` 只投影最新 epoch。
- 这样 `conversation` 记忆仍然按 `sessionId` 生效，不需要把 5000 条记忆迁到新 `threadId`；`session_search` 的跨会话语义不变，但 **remote / fork / 导出必须改读 `listTimelineMessages`**（否则 switch 后手机会少一段，fork 的旧 cutoff id 会 fail-open）。
- 如果将来单 Session 的 JSONL/索引真的过大，再把“物理分片”藏到存储层（一个逻辑 thread 映射多个物理 session），但**不要在第一版引入这个复杂度**。

**为什么这是最优融合**：

- Codex 的 Token Budget 新窗口 = 我们的 `kind=switch` epoch；
- DS-Bot 的换段新 Session = 我们的 `kind=switch` epoch（语义相同，物理实现更轻）；
- Codem 现有 checkpoint = `kind=compact` epoch；
- 不需要 Thread/Session 双身份，不会出现“换段后对话记忆丢了”“侧边栏多出会话”“fork 复制两份历史”；
- 仍然能做到用户一个窗口无限对话。

### 9.2 冲突裁决表

| 两轮对标的拉扯 | 如果各做一套的后果 | 融合裁决 |
|---|---|---|
| Codex TokenBudget 新窗口 vs DS-Bot 换新 Session | 两套切上下文逻辑、两套恢复/缓存 | **只保留一种 `switch` epoch**；不实现第二个 window 机制 |
| Codex 64K retained vs DS-Bot 16K recent | 上下文预算失控/两套 handoff | handoff 用 **16–24K recent + 用户原话 + 锚点**；不默认保留 64K 原始消息 |
| Codex summary 2.5K vs DS-Bot handoff note 8 段 | 每次压缩都写两份摘要 | `compact` 用 checkpoint summary；`switch` 用 handoff note；**每个事件只写一种** |
| Codex 90% 自动切 vs DS-Bot 0.8/0.95 vs Codem 0.7/0.4 | 三套阈值互相打架 | **一个 pressure 模型**：沿用 Codem 现有阈值（默认 0.7）作为“考虑线”；hard 线 0.9；连续压缩 ≥2 倾向 switch；不把 90% 当自动压缩线 |
| Codex 自动 consolidation vs DS-Bot 自动 memory review vs Codem 不自动删改 | 记忆被静默删/改 | 自动只做**候选提取 + pending/归档**；manual/pending 永不被自动删改 |
| Codex 全局 memory summary vs Codem 三级 scope | 跨项目泄漏/作用域失效 | **不做全局 summary**；用 scoped memory index + `memory_read/search` |
| DS-Bot `read_own_chat` FTS vs Codex history/notes 工具 | 两套历史工具、两套截断 | **一个 `thread_history_*`**：FTS + 锚点 + spill；现有 `session_search` 作兜底；notes 独立 |
| DS-Bot 长期 Bot vs Codem agent-teams 子代理 | 两套团队/两套状态 | **一个 Bot 身份层**，架在 agent-teams 任务/邮箱之上；不另造团队系统 |
| DS-Bot 群聊 vs Codem 任务板 | 群聊/任务板各说一套状态 | **一个 Team/Work 模型**：群聊是 UI/传输，任务板是协调视图 |
| DS-Bot 隐藏段 vs Codem 水位条 | 用户被误导或被打扰 | **默认安静，可检查**：不显示百分比，但保留段/决策/成本诊断 |
| 两轮都默认关闭的实验能力 | 误以为生产可用 | Thread/Segment 与 Bot Team 都走 feature flag；先影子/灰度 |

### 9.3 融合后的施工顺序（覆盖 24/25 的小节顺序）

```text
P0-0 契约：Session=Thread；context_epochs 加 segment_seq/kind/handoff；
      DisplayView 用 listTimelineMessages；remote/export/fork 统一读 DisplayView。
P0-1 记忆检索：memory index + memory_search/read；full timeline extraction；
      usageCount/lastUsedAt；修面板/真实注入预算分叉。
P0-2 Thread History：thread_history_search/read（FTS + 锚点 + spill）；
      保留 session_search 作跨会话兜底。
P0-3 Context Manager：回合结束规则版 compact/switch + thread notes；
      规则稳定后再上小模型影子；单飞/超时/回退；handoff 写 switch epoch。
P0-4 UI/恢复：段分隔卡、诊断、重启恢复；不显示默认百分比。
P1 Bot Team：Bot 身份 + 持久恢复；群聊 admin 路由；peer message/handoff tree。
P2 规模化：物理分片、混合检索、跨设备、自动归档（仅 pending/archive）。
```

**顺序理由**：

- 先锁 `Session=Thread / Epoch=Segment` 契约，避免先按 `sessionId` 做完记忆/检索再迁移；
- 先做记忆/历史检索，再做 switch；否则换段后模型只能“失忆”，会重跑工具；
- 先规则版 Context Manager，再上小模型；否则无法判断小模型是否真的比规则好；
- Bot Team 最后做，因为它依赖稳定的 thread/segment/handoff 和审计。

### 9.4 对 24 号文原有 P0/P1 的修订

- 24 的 P0-1（memory tools）、P0-3（完整时间线提取）、P0-4（usage 排序）**仍然成立**，但都挂在“当前 Session/Thread”上；`conversation` scope 不需要迁移到新 thread id。
- 24 的 P0-2 改为 **thread_history**，不是另造一个与 `session_search` 平行的系统；现有 `session_search` / `session_event_*` 保留为兜底。
- 24 的 P1-1 notes：**基础版（压缩前提醒 + handoff 读取）并入 P0-3**；P1-1 只保留更完整的 notes UI/可编辑能力。
- 24 的 P1-2 的“调阈值/摘要”只在 `compact` epoch 内做；**不要再实现 Codex 式 new window**。
- 24 的 P1-3 consolidation 仍然只做可撤销归档，不采用 Codex 自动改写或 DS-Bot 自动 review 的删除路径。
- 24 的 P2（独立存储/跨会话）保留；但第一版不为了“无限”拆 Session。

### 9.5 最终一句话

> **Codem 的最优方案不是“Codex 的 window”加“DS-Bot 的 segment”，而是：一个 Session 作为用户线程，用 `compact` / `switch` 两种 epoch 管理上下文；旧消息永不删；记忆/历史按需检索；长期 Bot 复用同一 Thread/Team 模型。**
>
> 无预算约束下的终极形态（Context OS + Document OS + Memory Graph + Artifact-centric Agents）见 25 号文 §10；本节的 P0 是它的第一版可落地子集。

---

## 附录 A：Codex 源码索引

- commit：`da279f6fd4a942261b3232feb515af4259922417`
- 仓库：<https://github.com/openai/codex>
- 关键文件：
  - `codex-rs/memories/write/src/phase1.rs`
  - `codex-rs/memories/write/src/rollout_input.rs`
  - `codex-rs/memories/write/src/phase2.rs`
  - `codex-rs/memories/write/src/prompts.rs`
  - `codex-rs/memories/write/templates/memories/stage_one_system_v2.md`
  - `codex-rs/memories/write/templates/memories/consolidation_v2.md`
  - `codex-rs/memories/read/src/citations.rs`
  - `codex-rs/memories/read/src/usage.rs`
  - `codex-rs/ext/memories/src/lib.rs`
  - `codex-rs/ext/memories/src/tools/{list,read,search,ad_hoc_note}.rs`
  - `codex-rs/ext/history-notes/src/tools.rs`
  - `codex-rs/state/src/runtime/memories.rs`
  - `codex-rs/core/src/compact_token_budget.rs`
  - `codex-rs/core/src/session/token_budget.rs`
  - `codex-rs/core/src/session/mod.rs`
  - `codex-rs/core/src/compact_remote_v2.rs`
  - `codex-rs/core/src/context/token_budget_context.rs`
  - `codex-rs/prompts/templates/compact/prompt.md`
  - `codex-rs/features/src/lib.rs`
  - `codex-rs/config/src/types.rs`

## 附录 B：Codem 源码索引

- `src/core/memory/memory.ts`（模型、存储、注入、审批、整理）
- `src/core/memory/similarity.ts`（查重）
- `src/core/memory/candidate-merge.ts`（同主题合并）
- `src/core/memory/checkup.ts`（体检）
- `src/core/memory/pending-backlog.ts`（积压闸门）
- `src/core/memory/panel-scope.ts`（面板/角标同源）
- `src/core/llm/index.ts`（提取、forked agent、memory 配置）
- `src/core/llm/agentic-loop.ts`（压缩触发、摘要、marker）
- `src/core/llm/compaction-budget.ts`（保留集、摘要渲染、marker 预算）
- `src/core/context/context-view.ts`（epoch/cutoff）
- `src/core/context/water-level.ts`（水位唯一入口）
- `src/core/prompt/prompt.ts`（记忆注入落点/缓存边界）
- `src/core/storage/settings.ts`（记忆域读写）
- `src/core/storage/message.ts`（`listMessages` vs `listTimelineMessages`）
- `src/core/storage/spill.ts`（spill 全文）
- `src/components/MemoryManager.tsx`
- `src/components/MemoryCheckupView.tsx`

## 附录 C：本文未做的事

- 没有修改任何代码；
- 没有把 Codex 当默认生产基线；
- 没有把 `memory_summary.md` 的自动删除/改写照搬；
- 没有宣称当前 Codem 已有 `memory_search` / `memory_read`；历史侧确实已有 `session_search` / `session_event_*`，但本文把它们标为“通用兜底”，不是一等 `history_read`；
- 没有在 arm64/手机 Host 上验证记忆行为（记忆在 Host 侧，需另测）。

## 附录 D：关键证据 path:line

**Codem 记忆**

- 注入单行 200：`src/core/memory/memory.ts:712`、`:3437`
- 每块 20 / 总 12000：`src/core/memory/memory.ts:690`、`:699`、`:3480`、`:3486`
- 排序按 `order`：`src/core/memory/memory.ts:3477`
- key 写入截 120：`src/core/memory/memory.ts:702`、`:2424`
- 字段白名单：`src/core/memory/memory.ts:1109-1164`
- 持久化整份 payload：`src/core/memory/memory.ts:1929-1931`、`:2116-2173`
- 2 MiB 预算：`src/core/memory/memory.ts:1481`
- pending 全局上限 5：`src/core/memory/pending-backlog.ts:53`
- 提取源 `listMessages`：`src/core/llm/index.ts:2468`
- 10 条 / 4 条 / 50 窗口 / 2 pending / 4 total：`src/core/llm/index.ts:2469`、`:2490`、`:2516`、`:275`、`:290`
- 无单飞/`forkedAbort` 无 abort：`src/core/llm/index.ts:2560`、`:2628`
- 面板无 tracker 的真实分叉：`src/core/memory/memory.ts:3517`、`:3543` vs `src/core/llm/index.ts:917`、`memory.ts:3495-3498`
- 中文整合相似度：`src/core/memory/memory.ts:5183-5213`、`:4980`
- 归属键：`src/core/memory/memory.ts:877-881`、`src/core/llm/index.ts:344-352`
- 通用历史工具：`src/core/llm/tools/session-search.ts:33`、`:228`、`:446`
- 压缩阈值 0.7：`src/core/context/context.ts:100`、`src/core/llm/agentic-loop.ts:586`
- 首轮漏算 system/tools：`src/core/llm/agentic-loop.ts:6282-6283`
- 保留预算 0.4W / 3 轮 / 60：`src/core/llm/agentic-loop.ts:6456`、`:6505-6520`
- 生产摘要 prompt：`src/core/llm/agentic-loop.ts:722-758`、`:6724`
- checkpoint 不删旧消息：`src/core/llm/agentic-loop.ts:6949-6956`
- epoch/cutoff：`src/core/context/context-view.ts:74-104`、`:139-239`
- 水位 exact/estimate：`src/core/context/water-level.ts:180`、`:210`、`:240-245`
- 面板水位分叉：`src/components/ContextMonitor.tsx:654-662`
- 提示条 ≥90%：`src/core/context/water-level.ts:306-335`

**Codex 源码**

- `codex-rs/memories/write/src/phase1.rs`
- `codex-rs/memories/write/src/rollout_input.rs`
- `codex-rs/memories/write/src/phase2.rs`
- `codex-rs/state/src/runtime/memories.rs:456-551`
- `codex-rs/ext/memories/src/lib.rs:16`（2500 tokens）
- `codex-rs/ext/memories/src/tools/mod.rs:28-53`
- `codex-rs/ext/history-notes/src/tools.rs:28-58`
- `codex-rs/core/src/compact_token_budget.rs:16-69`
- `codex-rs/core/src/session/mod.rs:5379-5434`
- `codex-rs/core/src/compact_remote_v2.rs:92`（64K）
- `codex-rs/core/src/context/token_budget_context.rs:58-88`（只有 window id）
- `codex-rs/prompts/templates/compact/prompt.md`
- `codex-rs/features/src/lib.rs:1439-1444`、`:2191-2202`（默认关闭）
- `codex-rs/config/src/types.rs:382-402`（MemoriesConfig 默认）
