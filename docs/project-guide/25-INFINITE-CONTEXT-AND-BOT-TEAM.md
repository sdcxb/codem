# 25 · 无限上下文与 Bot 团队：DS-Bot ICM 源码对标 + Codem 演进计划

> **状态**：分析 / 规划稿；本文不改变任何运行行为。
> **DS-Bot 基线**：`github.com/Fei2411/DS-Bot`，浅克隆 commit `71d344bf193f3f18185f25de3d8e5c483046910a`（2026-11-03，v0.2.7 合并后）。
> **Codem 基线**：`master`，v1.18.13（2026-11-06）。
> **Codex 基线**：commit `da279f6f`，详见 [24-MEMORY-BENCHMARK-AND-ROADMAP.md](docs/project-guide/24-MEMORY-BENCHMARK-AND-ROADMAP.md)。
> **证据等级**：A = 源码 + 测试/文档直接可核；B = 代码阅读推断，未跑完整链路；C = 设计推断；D = 未知/需实测。

**目录**：0 结论 · 1 DS-Bot ICM 源码事实 · 2 DS-Bot 协作/记忆源码事实 · 3 三系统对比 · 4 Codem 目标架构 · 5 如何比两者更强 · 6 路线图 · 7 验收判据 · 8 风险/取舍 · 附录。

---

## 0. 结论先行

### 0.1 作者说的「一个窗口无限对话」是真的，但不是「无限注意力」

DS-Bot 的真实结构是：

```text
用户看到的一个 Bot / 一个聊天窗口
  = 一个长期身份（Bot）
  + 一串 DSH Session（内部叫 part / segment）
  + 当前只把一个 segment 放进模型上下文
  + 旧 segment 整份归档，靠 handoff + FTS 检索回读
```

所以：

- **线程长度**可以无限增长；
- **单次请求的上下文**仍然有上限，且由模型窗口决定；
- 旧细节不是「一直在模型脑子里」，而是「可检索地存在磁盘上」；
- 压缩/换段本身有成本、有丢失风险，不是无感魔法。

这句话很重要：**Codem 要抄的是「线程无限 + 分段 + 检索」，不是「让模型真的记住无限 token」。**

### 0.2 DS-Bot 的 ICM 确实实现了，不是空话

源码里能一一对上：

- 阈值按模型窗口计算，默认 `checkRatio=0.8`，硬线 `0.95`（`steward.js`）；
- 回合结束过线时，一个小模型（context steward）读最近约 6,000 tokens / 40 行，输出 `{"action":"switch"|"compact"}`（`steward.js`、`parts.js`）；
- `compact` 用检查点摘要，保留给 Bot 的原话，压缩后继续；
- `switch` 写 handoff note + 最近消息 + 锚点，开新 Session，旧 Session 整份归档；
- `read_own_chat` 用 SQLite FTS5 trigram 搜所有 part（含压缩掉的**文本消息**；tool call/result 不入索引）；
- Bot 有长期记忆 Markdown + 自动 memory review + journal/pending/snapshot；
- 群聊默认管理员先答，`@` 点名，Bot 之间可 `message_bot`，有状态、派活树、批次回收；
- 这些都有测试（`steward.test.js`、`group-work.test.js`、`memory.test.js` 等）。

### 0.3 但作者的说法有 7 个关键简化

1. **「不需要在乎上下文窗口」**：用户不用管，但系统仍受窗口限制；模型未声明 `contextWindow` 时按 500k 估算，可能高于真实窗口，随后 overflow 换段。
2. **「cm 判断任务是否结束」**：是一次 LLM 小请求，不是确定性状态机；失败/答不出直接 `switch`，可能把未完成任务切走。
3. **「旧 session 索引」**：不是完整语义索引；是 handoff note + 最近原文 + 锚点 + 独立 FTS。摘要没写的细节，只能靠搜索词碰运气。
4. **「旧段整份可搜」**：FTS 不索引 tool call/result；命令输出、文件 diff、工具结果**不能**靠 `read_own_chat` 找回；归档段还可能因 agent 不存在被静默漏掉。
5. **「Bot 协作更高效」**：群聊默认管理员确实省成本，但每个发言成员仍要带自己的上下文；并行成员互相看不到对方这一轮回复只是提示词声明；管理员可能 PASS/失败；没有全局超时。
6. **「长期记忆自己管理」**：自动 review 会新增、修改、删除条目；用户需要定期检查；当前 segment 开始后新保存的记忆不会出现在提示里，只能 `recall`。
7. **「无感」**：换段期间输入要等待/转发，换工作文件夹会显示状态；有段分隔线/切换文案；旧段归档但 UI 是拼接的；底层仍是多 Session。

### 0.4 Codem 应该学什么、不该学什么

**该学：**

- Thread（用户连续看到的会话）与 Segment（内部上下文段）分离；
- Steward 在「压缩」与「换段」之间做选择，而不是只会压缩；
- 换段用结构化 handoff + 最近原话 + 锚点，不用「摘要的摘要」；
- 所有旧段可检索、可回读、可审计；
- Bot 作为长期身份，而不是一次性 subagent；
- 群聊管理员默认路由，控制 fan-out 成本；
- 状态、邮箱、派活树、批次回收。

**不该照搬：**

- 自动记忆 review 直接删改（Codem 的 manual/pending/拒绝记录更可信）；
- 无超时等待、无全局预算的 Bot 协作；
- 「状态不进系统提示所以永远靠 list_bots」的完全隐式；
- 把 LLM steward 当唯一决策者；
- 为了「一个窗口」隐藏所有分段/成本；
- 依赖 DSH 的 Session/compact 机制（Codem 有自己的 AgenticLoop/存储）。

---

## 1. DS-Bot ICM 源码事实

### 1.1 数据模型：Bot 身份 vs Session 段

`docs/plans/2026-10-09-context-and-memory.md` 写得很清楚：

- 私聊：`bot.sessionId` 是当前段，`bot.segments[]` 是旧段；
- 群聊：每个 Bot 在每个群有自己的一段（`room.sessions[botId]`），旧段在 `room.segments[botId][]`；
- 一个 Bot 是长期身份，对话由多段 DSH Session 组成；
- 对用户是一条连续聊天，不显示上下文占用，也不给 Bot 切换工具；
- 唯一例外：换工作文件夹引起的换段会在会话尾部显示「正在切换工作文件夹」。

源码：

- `ds-bot/src/host/parts.js` 的 `partsOf()`（约 322–341 行）把 `bot.segments` + 当前 `chatOf(botId)` 拼成编号 parts；
- `docs/plans/2026-10-09-context-and-memory.md` 的「段」「线」「管家」「压缩」「换段」章节；
- `docs/plans/2026-10-16-bot-handoffs.md` 的 Bot 状态/派活树。

**这正是 Codem 需要补的 `Thread` 抽象**：用户看到 thread，模型只看到 current segment，存储层保留 segments。

### 1.2 阈值：全部跟着模型走，但仍是有限窗口

`ds-bot/src/host/steward.js` 的 `linesFor()`：

```text
W = 模型声明的 contextWindow；未声明时 500,000
R = 路由的 maxTokens（回复预留）
U = max(W - R, floor(W / 2))
H = floor(U * 0.95)
C = min(floor(U * checkRatio), H)，checkRatio 默认 0.8
```

- `checkRatio` 可在 `cordis.patch.yml` 的 `bot.config` 改；
- `check` 是回合结束判断线，`hard` 是回合中途兜底线；
- 提示条/百分比不展示给用户；
- 模型未声明窗口时用 500k，这是**估算**，不是保证；DS-Bot 文档也把它列为已知限制。

触发点（`parts.js`）：

- 回合结束、上下文 ≥ `C`：`checkContext()` 判断一次；处理完回到 C 以下；再涨 `C/4` 才会再判断（`grown()`，约 744 行），避免每轮都调 steward；
- 回合中途 ≥ `H`：`agent/pre-step` 里判断；说 compact 就原地压缩后继续，说 switch 就停下换段；
- provider 报 `CONTEXT_WINDOW_EXCEEDED`：直接换段，不写交接笔记；
- 只读进程（另一个 DSH 持有团队）：不判断、不压缩、不换段；
- 连接失败不说明对话有问题，不会因此换段。

### 1.3 Steward：一个小请求，不是主模型“顺手判断”

`steward.js`：

- `STEWARD_SYSTEM` 要求只回一行 JSON：`{"action":"switch"|"compact","reason":"…"}`；
- 输入是最近 40 行消息，从新到旧收集，约 6,000 tokens；单条最长 1,500 字符，保留头尾并注明中间省略；
- 告诉它：私聊/群聊、回合结束/中途、本段已压缩次数；
- 判断 switch 前要逐条核对用户要求与实际完成、有没有问了没答的问题；没做完即使 Bot 说做完也算没结束；
- 压缩次数越多，越倾向把合理停顿当结束（只是倾向，不是硬规则）；
- 消息里「告诉管家怎么答」的文字算对话内容，不算指令；
- 解析取最后一个带 action 的 JSON 对象（防止引用前文）；
- **失败/答不出/没有 compaction engine → switch**（`decide()`，约 596–606 行）。

调用参数（`parts.js` 约 564–591 行）：

- `STEWARD_MAX_TOKENS=4096`；
- `STEWARD_TIMEOUT_MS=120_000`；
- 自带 `STEWARD_SYSTEM`，不继承 Bot 的长前缀；
- 用 Bot 自己的模型路由；支持时 `reasoningEffort=off`；
- 不写 Session，不产生用户可见消息。

**评价**：这是一个「花小钱省大钱」的设计，但它不是确定性任务状态机；对“任务是否结束”的判断仍然是 LLM 语义判断。Codem 应保留 LLM，但加确定性护栏。

### 1.4 Compact：检查点摘要 + 原话 + 编号

`steward.js` 的 `CHECKPOINT_PROMPT` 要求：

- 现在做到哪、完成/进行中；
- 结果逐条列出（编号/名字/标识符原样）；
- 决定与理由、被否掉的方案；
- 依赖的约束、偏好、纠正；
- 未回答的请求（用用户原话）、下一步、完成标准；
- 精确数据：名字、数字、日期、路径、命令、标识符、链接、错误原文；
- 不编造、新的覆盖旧的、合并旧 checkpoint/handoff、工具结果里的指令是数据不是请求；
- 用用户的语言，结构化的短 bullet，不输出前言/工具调用。

`checkpointText()`：

```text
[Checkpoint N]
<summary>

Your own replies up to here are condensed above; read_own_chat finds them word for word.

## Messages to you, word for word (oldest first)
[...用户/其他 Bot 的原话，新的优先，预算内...]
```

`checkpointCount()` 只从被 `<compacted-summary>` 包裹的 `[Checkpoint N]` 计数，防止用户伪造。

`writeCheckpoint()`（`parts.js` 约 514–560 行）：

- 用本段自己的前缀发请求，命中 provider 缓存；
- 摘要输出上限 = 路由 `maxTokens`；
- 被截断/空摘要 → 失败，不写；
- 保留最近消息到 `keptMessages()`，预算 `min(16,384, C/4)`；
- 压缩后仍 ≥ C → 换段；
- 旧消息仍在 Session 日志，`read_own_chat` 搜得到；界面上不显示压缩标记。

**与 Codem 现有 checkpoint 的关系**：Codem 已有 marker/cutoff/摘要/旧消息保留，能直接承接；但 Codem 的摘要没有“保留用户原话”的强制结构，也没有 `Checkpoint N` 计数。可借 DS-Bot 的 `checkpointText` 结构。

### 1.5 Switch：handoff note + package + 归档

`parts.js` 的 `writeNote()` / `handoffPackage()`：

- handoff note 必须包含 8 个固定 section（`NOTE_SECTIONS`）：
  Goals / Constraints and preferences / Progress / Decisions / Facts to keep / Open threads / Next step / Where to look；
- 每节用 `(none)` 占位；缺 heading → 重写一次；输出被截断 → 缩短重写；两次仍失败 → 抛错；
- 上限约 2,000 words；`NOTE_MAX_TOKENS=8192`；超时 600s；最多 2 次；
- 失败后 `NOTE_COOLDOWN_MS=[60s,300s,900s]`，不会每轮重试；
- handoff package（`handoffPackage`）包含：
  - 笔记；
  - 最近消息原文（`RECENT_TOKENS=16,384`，单条 4k）；
  - 私聊附“发给 Bot 的消息”锚点清单（`LIST_TOKENS=4,096`，单条 400）；
  - 旧内容在哪里（`read_own_chat around "part N #seq"`）；
- 新段开头是一条 `[Handoff · part N]` 消息，模型只看到这个 package；
- 旧段归档，不删；输入在换段期间等待并转交；
- 换工作文件夹也触发换段，但用 `FOLDER_PROMPT`，并在会话尾部显示状态。

**这里的关键不是“摘要”，是“交接包”**：note（理解）+ 最近原文（语气/细节）+ 锚点（可回查）+ 当前位置。Codem 现有压缩 marker 只有摘要+保留消息，没有 note/锚点/跨段交接。

### 1.6 `read_own_chat`：FTS5 + anchor，不是“模型自动记得”

`chat-index.js`：

- SQLite FTS5，`tokenize='trigram'`，中文不需要分词；短词（<3 字符）回退 `LIKE`；
- BM25 排序；`OWN_CHAT_SEARCH=20`，`OWN_CHAT_BRIEF=10`，`OWN_CHAT_READ=12`；
- 索引从 Session 日志派生：读取时补齐，段结束 60s 后封存；删索引只重建；没有 SQLite 时扫日志；
- anchor 是 `part N #seq`；`around` 看锚点全文 + 前后 6 条；`part` 看该段结束时的交接笔记；
- 历史分页 200 条 × 最多 50 页，20s 超时；
- 读全文时单条最多 8,000 字符（`ANCHOR_LINE_MAX`），普通行 400。

**重要修正**：作者说“生成旧 session 的索引”，实际是：

> handoff note + 最近原文 + 锚点清单 + 独立 FTS 索引；不是把旧段变成一份完整语义索引，也不是自动注入。

所以旧细节能不能找回，取决于：
- 关键词是否命中；
- FTS 索引是否已补齐；
- 旧段是否还在磁盘；
- 模型是否知道/愿意调用 `read_own_chat`。

**更硬的边界（源码确认）**：

- **tool call / tool result 从不入索引**（`parts.js` 约 132–153 行）；`read_own_chat` 只能搜用户/Bot 的文本，**不能搜回命令输出、文件 diff、工具结果**。对编程 Agent 来说这是很大的缺口。
- 单条锚点全文最多 8,000 字符；普通行 400；查询最长 80 字符、最多 6 个词、最多 20 条结果；不是真正的“整段全文”。
- 归档段需要 `resolveAgent` 成功；失败只 `warn`，可能**静默漏段**（`chat-index.js` 约 54/199 行）。
- 群聊不在 `read_own_chat` 范围；`read_group_chat` 只读最近 30 条，群日志只留 60 条（`groups.js` 约 31/238–239 行）。
- checkpoint 保留的原话只包括用户/其他 Bot，**不保留 Bot 自己的回复原话**；每条裁 4,000 字符；摘要上限只受路由 `maxTokens` 约束。
- 换段并非完全“无标记”：有 `bt-part-line` 分隔线/日期，切换中有 “Moving to a fresh conversation” 文案；交接包/ack 轮才隐藏。
- `decide()` 失败默认 `switch`，但 `canMakeRoom` 可能否决；极端情况下**既不压缩也不换段**，下轮重问。
- 模型未声明 `contextWindow` 时按 500k；`reserve` 未声明时为 0，`U` 可能等于 W；`reserve > W/2` 会被截到 W/2。
- 回合结束检查在错误回合会连尺寸检查一起跳过（约 1237 行），可能继续涨到 overflow。

这些不是“实现很差”，而是说明：**“无限线程”是产品层承诺，不是无限保真**。Codem 若要更强，必须补上工具结果检索、锚点全文、归档段可用性和覆盖率披露。

### 1.7 长期记忆：Markdown + 自动 review，不是只靠 `remember`

`memory.js`：

- 目录：
  - `memory/bots/<botId>/`：Bot 自己的 `MEMORY.md` + topics；
  - `memory/groups/<roomId>/`：群共享记忆；
  - `memory/team/`：团队共享；
  - `journal.jsonl` / 私有 journal / `pending.json` / `snapshots/` / `summaries/` / `archive/`；
- 大小：
  - 一条 300 字符；
  - `MEMORY.md` 4,000 字符；
  - 两个 `MEMORY.md`（自己+团队）约 8,000 字符随每次请求发送；
  - 一个 topic 16,000 字符，整份 `recall`；
  - 最多 40 个 topic；
- `remember` / `forget` / `recall`：
  - 私聊默认写自己的；群聊默认写群；`scope:"own"` 写自己，`scope:"team"` 有权限才写；
  - 拒绝密钥/密码/身份证号等；
  - 超大小、没权限、找不到要删的条目 → 明确报错，不假装保存；
- 自动 memory review：
  - 一段对话 idle 后（代码默认 2s 延迟）由模型读新增消息，保留/修改/删除条目；
  - 私聊用 Bot 自己的模型；群聊用管理员模型（没有管理员用第一个成员），只写群记忆；
  - 一次最多 8 个 change，最多 4 个 batch pass；review 串行；
  - 用户可在记忆面板查看/修改/按 journal 撤销；
- 记忆冻结：
  - Session 第一次渲染时把记忆段冻结，保证提示词逐字节稳定、prefix cache 命中；
  - 换段/checkpoint 后重新冻结；
  - 因此本段开始后新增的记忆**不会出现在提示词里**，提示词要求 Bot 在说“不知道”前先 `recall`（已知限制 #214）；
- 群记忆：
  - 只进群成员的群会话，不进私聊/别的群；
  - 成员被移出群后立即拒绝读写；
  - 群会话系统提示与私聊逐字节相同，群记忆作为快照消息放进会话开头（首轮可共享前缀缓存）。

**评价**：这套长期记忆比 Codex 的全局 summary 更可管理、更可审计；但自动 review **会删改**，与 Codem 的「不自动删除/改写」承诺冲突。Codem 应保留自动提取，但将“删除/合并”改为 pending/可撤销归档。

### 1.8 协作：管理员默认路由 + 状态 + 派活树

`groups.js`：

- 群有两种模式：`admin`（新群默认）和 `everyone`；
- `openingCall()`：
  - 无 `@` 普通消息：admin 模式只给管理员；everyone 模式按顺序全员，管理员第一；
  - `@名字`：只给被点名成员；
  - `@all`：管理员说才算，普通成员说 `@all` 不算；
  - kickoff / goal / done / progress / late 各有路由；
  - 同一条消息点到的成员同时开工，彼此看不到这一轮回复；需要接力时先叫一个再 `@` 下一个；
- 成员一次只回答一个 call；一轮中用户消息立即进入；成员 PASS 可跳过；
- 有工具调用的 15s 后仍在干活，本轮继续，结果晚点发回；
- 无进展的 Bot 接力 6 轮暂停，等用户发言；
- `handoffs.js`：
  - `message_bot` 的请求是一棵树；B 下面还有未交回的活，B 的回复先不交回 A，等子活交回再继续；
  - 等待关系写 `state.json`，重启后继续等；
  - `request_id` 幂等；同名同内容重试返回原回执；同名不同内容拒绝；结果不确定不重发；
  - 结果全文落 `handoff-results/` 文件，`state.json` 只存开头，防重启截断；
  - 状态：等用户批准 / 换新会话中 / 在干活 / 在等别的 Bot / 空闲；`list_bots` 暴露；状态不进系统提示（保缓存）；
  - **没有超时**：下面的活一直不交回（比如等用户批准），上面一直等；用户可停；代码文档明确列为已知限制；
  - 没有全局链长/总量上限；靠用户观察和停止；
- 群成员最多 12；公告 2000 字；一轮回复超时 4 分钟；停止按钮可停整个群。

**评价**：这套协作比“一次性并行子代理”更接近长期团队，但：
- 不是所有 Bot 都永远在线；状态是内存 + `state.json` 等待关系；
- 没有超时/预算硬闸，可能挂起或烧钱；
- 并行成员互相不可见是**提示词层面**的声明，不是硬隔离；后建提示词者可能已看到前者落盘行；
- 管理员是瓶颈，PASS/失败会留下空轮；
- 成本仍随实际发言成员线性增长；
- “每个发件人最多一条未读”不成立：只有同一父活 / `toUser` 可合并，不同父活可以各留一条；
- `state.requests` 单调增长、`state.json` 全量写；长期使用需要分表/归档；
- 4 分钟群回复超时会被事件重置，被切断的成员可能“再也不会被叫”；
- “有工具就不算空转”使 6 轮 idle guard 可被绕过；返工环 A→B→C→B 无深度限制。

### 1.9 作者说法逐条对照（源码版）

| 作者说法 | 源码支持 | 需要修正 |
|---|---|---|
| 一个 Bot 持续对话，不用管窗口 | 是，Thread 多段 | 单次仍受窗口限制；旧细节靠检索 |
| 固定百分比阈值，跟随模型 | 是，check 0.8 / hard 0.95 | 模型未声明窗口按 500k；reserve 未声明为 0 |
| CM 判断压缩还是换段 | 是，小模型 + JSON | 不是确定性；失败默认 switch，但可能被 canMakeRoom 否决 |
| 换段生成旧 session 索引 | 部分 | note + recent + anchors + FTS；tool 结果不入索引 |
| Bot 间协作比子代理高效 | 有条件 | 管理员路由省成本；fan-out 线性；无超时 |
| Bot 知道彼此状态 | 是 | 靠 list_bots/UI；状态不进系统提示 |
| 长期记忆自己管理 | 是 | 自动 review 会删改；新记忆当前段不可见 |
| 群聊默认管理员回答省成本 | 是 | 管理员瓶颈；PASS/失败需用户兜底 |
| 不需要手动切换会话 | 是 | 有分隔线/切换文案；底层多段 |
| 子代理低效，所以用长期 Bot | 理念成立 | DS-Bot 仍用 DSH Session/部分子代理；不是绝对 |

## 2. DS-Bot 协作/记忆的源码级限制

### 2.1 「无限」的真实边界

| 维度 | 真实情况 |
|---|---|
| 线程长度 | 可无限增长（旧段归档） |
| 单次上下文 | 仍 ≤ 模型窗口；超了 compact/switch |
| 旧细节 | 只在磁盘/FTS；handoff 没写就丢上下文 |
| 上下文占用提示 | 不显示；用户不知道当前段多大 |
| 换段延迟 | 写 note + package；有超时/重试/冷却 |
| 换段失败 | 重试/回退；最坏可能丢 note，但旧段仍在 |
| 模型窗口未知 | 按 500k 估算，可能高估 |
| 旧段可读性 | `read_own_chat` 关键词/锚点；不是语义检索 |
| 旧工具结果 | tool call/result 不入 FTS；命令输出/diff/结果不可用 `read_own_chat` 找回 |
| 记忆 | 自动 review 会删改；新记忆当前段不可见，需 recall |

### 2.2 「Bot 协作更高效」不是无条件成立

- 省成本的前提是 **admin 模式 + 少叫成员**；如果每条消息都 @all，成本仍然线性甚至更高；
- 每个成员都要带自己的上下文；长期 Bot 的上下文比一次性子代理更大，单次调用更贵；
- 并行成员看不到彼此这一轮是提示词声明，不是硬隔离；冲突/重复需要接力或管理员收口；
- 派活树能避免“结果交不回来”，但没有超时/预算，可能永久等待；
- 管理员 PASS/失败需要用户兜底；`admin-passed` 只是提示；
- 状态靠 `list_bots`/UI，不进系统提示；模型不查就不知道对方忙；
- 群记忆只在该群可见，跨群协作需要团队记忆或 `message_bot`，不是自动共享。

---

## 3. 三系统对比：Codex / DS-Bot / Codem

### 3.1 对比矩阵

| 维度 | Codex | DS-Bot | Codem 现状 |
|---|---|---|---|
| 上下文形态 | 新 context window + 64K retained + summary | 同 Bot 多 Session 段 + handoff | 同 Session checkpoint + cutoff（无段） |
| 谁决定压缩/换段 | 阈值自动；TokenBudget 直接切 | steward LLM 决定 compact/switch | 阈值自动 compact；无 switch |
| 旧内容 | history/notes 工具；rollout 文件 | read_own_chat FTS + 旧段归档 | 完整时间线 + session_search/event 工具；无专用 thread history |
| 长期记忆 | 全局 memory_summary + usage Top-N + 工具 | Bot/群/团队 Markdown + 自动 review | 平台/项目/对话 + 审批 + 检索 UI；无 thread 级 |
| 信任模型 | 自动 consolidation 可删改；无 manual | 自动 review 可删改；用户可撤销 | manual/pending/拒绝记录/不自动删改 |
| 协作 | 子代理/多 agent，非用户群聊 | 长期 Bot + 群聊管理员 + 派活树 | agent-teams 任务板/邮箱/状态；无群聊；成员重启易 absent |
| 成本控制 | 阈值/模型路由/工具按需 | admin 默认 + 少叫成员 | 任务板/模型路由；无群聊 fan-out 控制 |
| 可观测 | 部分实验 flag | 状态/用量 UI；决策隐藏 | 水位/记忆体检/任务中心；无 steward 审计 |
| 本地/模型 | 依赖 Codex/OpenAI 后端 | 依赖 DSH/DeepSeek | 本地 SQLite + 多 provider |
| 成熟度 | 实验/默认关 | 社区项目，设计细 | 生产功能，测试多 |

### 3.2 Codem 已有的可复用件（不要重复造）

| 件 | 现状 | 能支撑 | 缺 |
|---|---|---|---|
| `Session` / `Message` / `ContextEpoch` | checkpoint，不删旧消息；`listTimelineMessages` 完整时间线 | Thread/Segment 的物理载体 | 只有 compact epoch；无 switch/handoff |
| `session_search` / `session_event_*` / spill | FTS/事件/永久工具正文 | thread history 的原料 | 无 epoch/段维度；工具结果是否入 FTS 需补 |
| `agent-teams` | captain/member/task/dependency/claim/attempt/mailbox/reassign | Bot Team 的协调内核 | 无 Bot 身份、无群聊、成员重启易 absent |
| `SubagentRuntime` | `startContinuable`、child session、status、followup | Bot 执行器 | 生命周期是 runtime activation，不是长期身份 |
| `squad` / `TaskCenter` / `inbox` | 模板/任务板/通知 | 团队 UI | 无群聊/管理员路由 |
| `goal` | 阶段/证据/预算 | 长任务状态，steward 可用 | 不切上下文 |
| `remote` | 手机/Host 复用 `executeSessionTurn` | 跨端 | 读 `session.get` 是 ContextView，不是 DisplayView |

**结论**：Codem 不是从零做 DS-Bot；已经有 70% 的“团队/任务/子会话/完整历史”零件。缺的是：

1. 把 `SubagentRuntime` 的短期 activation 升级为 **持久 Bot 身份**；
2. 把 `agent-teams` 的邮箱/状态扩展成 **peer message + 群聊 + 管理员路由**；
3. 把 `ContextEpoch` 扩展成 **switch epoch + handoff**；
4. 把 `session_search`/spill 升级成 **thread history 工具**。

---

## 4. Codem 目标架构：Thread + Segment + Steward + Bot Team

### 4.1 总原则

1. **用户看到 Thread，模型只看 Segment**；
2. **旧段永不删**；换段只是换“当前工作上下文”；
3. **Steward 只做建议，确定性护栏兜底**；
4. **handoff 是结构化交接包，不是摘要**；
5. **检索是一等公民**：thread history + memory + spill；
6. **长期 Bot 是身份，不是一次性 subagent**；
7. **群聊默认管理员路由，成本/停止/超时可见**；
8. **Codem 的信任模型不后退**：manual/pending/不自动删改。

### 4.2 数据模型

> **融合裁决**：第一版**不新建 `threads` 表，也不每次换段新建 Session**。直接复用 Codem 现有 `Session` + `ContextEpoch`；`Session = Thread`，`Epoch = Segment`。下面先给逻辑模型，物理分片放到 P2。

#### Thread（逻辑概念）

```ts
// 第一版：threadId = sessionId，不落新表。
interface ThreadRef {
  threadId: string;      // = session.id
  projectId: string;
  title: string;
}
```

#### Segment（逻辑段 = epoch）

```ts
// 复用 context_epochs；新增字段：
interface ContextEpoch {
  epochId: string;             // compact-/compact-manual-/switch-
  sessionId: string;           // = threadId
  seq: number;                 // 全局 epoch 序
  segmentSeq: number;          // 第几段（switch 时 +1）
  kind: "compact" | "switch";  // 原地压缩 / 换段
  cutoffMessageId: string;
  removedCount: number;
  keptCount: number;
  handoff?: Handoff;           // kind=switch 时
  createdAt: number;
}
```

- `compact` epoch：沿用现有 checkpoint，旧消息不删；模型看 marker + 尾部。
- `switch` epoch：写 handoff marker；`segmentSeq+1`；模型看 handoff + 尾部；旧消息仍完整。
- `DisplayView = listTimelineMessages(sessionId)`；`ContextView` 仍取最新 epoch。
- **不需要** `sessions.thread_id`、`MemoryEntry.threadId` 或 conversation scope 迁移。

#### Handoff

```ts
interface Handoff {
  id: string;
  sessionId: string;           // = threadId
  fromEpochId: string;
  toEpochId: string;
  reason: "steward-switch" | "overflow" | "folder" | "manual";
  note: string;                // 8 段结构
  anchors: Array<{ segmentSeq: number; seq: number; label: string }>;
  recentMessageIds: string[];
  createdAt: number;
  status: "pending" | "committed" | "failed";
}
```

**兼容策略**：

- `context_epochs` 加 `segment_seq`、`kind`、`handoff_json`（可空）；现有行 `kind=compact`、`segment_seq=1`；
- `context_epochs` 是派生索引；权威仍是 marker metadata。两边都要写，索引丢了可从 marker 重建；
- marker id 可以继续用 `compact-*` 前缀（避免 `readContextEpoch`/`isCompactionMarker` 的兼容改动），用 `metadata.kind="switch"` 区分；若改用 `switch-*`，必须同步 `readContextEpoch`、`isCompactionMarker`、迁移和判据；
- `messages` / `sessions` / `MemoryEntry` **不改**；`conversation` scope 仍按 `sessionId`，换段不丢；
- `thread_history_*` 按 `sessionId` + `context_epochs` 过滤；
- 旧 marker 无 metadata 时按现有 fail-open 兼容；新 switch 必须有完整 handoff 才生效；
- P2 如果单 Session 太大，再引入 `sessions.thread_id` 做**物理分片**；逻辑 thread 不变，UI/记忆/检索不改。

#### Bot / Team / Work（P1 再落表）

```ts
interface Bot {
  id: string;
  name: string;
  role?: string;
  provider?: string;
  model?: string;
  projectId: string;
  workspace?: string;
  memoryScope: string;        // bot:<id>
  status: "idle" | "working" | "waiting_approval" | "switching" | "waiting_on_bot" | "absent";
  personalSessionId?: string; // 第一版 Bot 的个人 thread 就是一个 session
  createdAt: number;
  archived?: boolean;
}

interface Team {
  id: string;
  name: string;
  adminBotId: string;
  mode: "admin" | "everyone";
  memberBotIds: string[];
  projectId: string;
  groupSessionId?: string;    // 群聊 thread = 一个 session
  memoryScope: string;        // group:<id>
}

interface Work {
  id: string;
  teamId: string;
  fromBotId: string;
  toBotId: string;
  parentWorkId?: string;
  request: string;
  requestId?: string;
  status: "pending" | "running" | "waiting" | "done" | "failed" | "cancelled";
  result?: string;
  deadlineAt?: number;
  createdAt: number;
}
```

**关键**：`Bot` 与 `Thread` 解耦。Bot 的私聊 thread、群聊 thread 都可以多段；Bot 不在线不代表身份/记忆/历史丢失。第一版 Bot 的个人 thread 就是 `personalSessionId`，群聊 thread 就是 `groupSessionId`；不需要新 thread 表。

### 4.3 Steward 设计

**挂点（Codem 现状）**：

- Codem 现在只有 `onCompactionComplete` / `onToolResult` 回调；但有 `turn_end` 事件（`session/executor.ts`、telemetry）。第一版在 **turn_end 之后、下一条用户消息之前**触发，不每迭代问模型。
- P1 再考虑 pre-step：`contextPressure` 已算好，可让 steward 决定 switch 而非 compact；但不要每步都调小模型。
- overflow 已有反应式压缩，可加“switch”分支；手动压缩复用现有按钮。
- 锁：现有 `compaction-control` 是进程内 Set、无 owner/TTL；steward 需要独立锁 + 超时 + owner，避免与 compact/manual 三路并发。

**触发**：

- 回合结束（默认）：当前段 token ≥ check 线（**Codem 沿用现有 0.7，不照搬 DS-Bot 0.8**）；
- 回合中途（P1）：≥ hard 线（**Codem 目标 0.9**，不是 DS-Bot 0.95）在下一个 LLM step 前；
- provider overflow：直接 switch；
- 手动“整理”按钮：compact/switch 可选；
- 只读/后台/子代理不触发。

**决策顺序（确定性优先）**：

```text
if no segment capability / no handoff possible -> compact
if overflow / >= hard -> switch
if compressionCount >= N (e.g. 2) -> switch
if midTurn && task incomplete -> compact
if no room for handoff -> compact
else -> LLM steward
if LLM fails/no answer -> deterministic fallback (compact if unfinished, switch if finished?)
```

**Steward 输入**：

- 最近 40 条 / 6K tokens；
- 当前段已压缩次数；
- 当前 thread 的目标/未完成项（从 goal/plan/notes 读，若有）；
- 是否 mid-turn；
- 当前模型窗口/可用预算（只作上下文，不让它算）；
- 不给它工具、不给长前缀；JSON 输出。

**护栏**：

- 单飞 per thread；锁 + `switching` 状态；
- 超时 60–120s；失败不阻塞；
- 决策理由持久化（审计/UI 可查，不注入用户消息）；
- 不允许 steward 直接写记忆或改任务；
- 不允许在工具调用中间切段；只在 step 边界或回合结束。

**与 DS-Bot 的差异**：

- DS-Bot 失败直接 switch；Codem 先看“任务是否真的完成”/“handoff 是否可用”，失败回退 compact 或继续；
- DS-Bot 只有 LLM；Codem 有 goal/plan/notes 等结构化状态可辅助；
- Codem 记录决策，用户可查；DS-Bot 隐藏。

### 4.4 Handoff 生成

**结构**（比 DS-Bot 更贴近 Codem 的审计）：

```markdown
## Goals
## Constraints and preferences
## Progress（Done / In progress / Blocked）
## Decisions（含 rejected）
## Facts to keep（路径/命令/ID/错误原文）
## Open threads（未回答问题、承诺、等谁）
## Next step
## Where to look（锚点 + 关键词）
```

**生成规则**：

- 从完整 thread timeline 读，不只当前段；
- 保留用户/其他 Bot 原话到预算；`recent` 16K + `list` 4K；
- 每条事实带来源锚点 `[segment N #seq]`；
- 摘要失败 → 用确定性结构化摘要 + 最近原话；
- handoff 写入新段第一条消息（`role=user` 或专用 `handoff` 消息），并在 UI 显示一条“继续”卡片；
- 旧段 `ended`，不删；
- 输入队列：切换中收到用户消息，等新段 commit 后投递；失败回旧段；
- 幂等：同一 thread 同时只允许一个 switch；崩溃恢复按 `handoff.status` 决定。

**与 Codex 的结合**：

- Codex 的 summary 保留用户消息相邻；DS-Bot 的 handoff 保留 note/recent/anchors；Codem 两者都做：
  - summary（理解）+ 用户原话（事实）+ 锚点（检索）+ 最近消息（语气）；
  - 不把整个 thread 塞进新段。

### 4.5 Thread 历史/检索

新增工具（模型可调用）：

- `thread_history_search(query, segment?, limit?)`：跨当前 thread 的所有段，FTS5/trigram；返回 `segmentSeq#seq` + excerpt；
- `thread_history_read(anchor | messageId, before/after?)`：按锚点读原文；spill 走 `readSpillText`；
- `thread_segment_list()`：列出段、起止、摘要、handoff 锚点；
- `memory_search` / `memory_read`（见 24 号文）；
- 保留现有 `session_search` / `session_event_*` 作为跨会话兜底，但默认 thread 过滤。

**关键**：不要只给 UI 一个“历史面板”；模型必须有一等入口。否则“无限线程”只是 UI 假象。

**读路径约束（Codem 现状）**：

- `remote session.get` 现在读的是 `ContextView`，不是 `listTimelineMessages`；手机端在 switch/compact 后会“凭空少一段”，必须改成 DisplayView 或显式分页。
- `fork` 现在复制 `ContextView`，且新消息 id 加 `-fork-`；旧 epoch 的 `cutoffMessageId` 在子会话不存在 ⇒ 可能 fail-open 成全量。fork 必须复制 timeline 并重写 cutoff id，或显式从全量开始。
- 导出/完整历史面板已经读 `listTimelineMessages` 的路径要保持；新 `thread_history_*` 与它们共用同一投影，避免两套口径。
- `session_search` / `session_event_*` 保留，但默认加 `sessionId`/epoch 过滤；跨会话搜索需要显式开关。

### 4.6 Memory：Session=Thread 下的作用域 + usage + 审批

融合裁决后的关键变化：**第一版 conversation scope 仍按 `sessionId`，不迁 `threadId`**；因为 `Session = Thread`，换段只是在同一 Session 内加 `switch` epoch，不会产生新 session。

- `MemoryEntry` 不新增 `threadId`；`conversation` scope 的可见性仍按 `sessionId`；
- 自动提取：从完整 `listTimelineMessages(sessionId)`（含旧段）按 tier 取样，不只看当前段；
- 注入：memory index（conversation/project/platform）+ `memory_read` 全文；
- 使用信号：`usageCount/lastUsedAt`，manual/pinned 优先；
- 审批：project pending；conversation auto 默认 active（可配置）；platform 只 manual；
- **不自动删改**；整理只做可撤销归档；
- 群/团队/个人 scope 到 P1 再增加；先复用 `project`/`conversation`，不要一次扩六种 scope；
- 记忆快照/冻结：当前段注入稳定；新记忆通过 recall/read 取，不强行改前缀。

**与 DS-Bot 的差异**：

- DS-Bot 每段开始冻结记忆，新记忆当前段不可见；Codem 可以用“稳定索引 + read 工具”避免这个限制；
- DS-Bot 自动 review 删改；Codem 只 pending/归档；
- DS-Bot 群/团队/个人三层；Codem 第一版不扩，P1 再用 `bot/group/team` 扩展。

### 4.7 Bot Team / Group Chat

**复用现有**：

- `agent-teams`：任务、依赖、claim/attempt、mailbox、status、reassign、TaskCenter UI；
- `SubagentRuntime`：可续聊子会话；成员执行；
- `squad`：团队模板；
- `goal`：阶段/证据；
- `inbox`：通知。

**新增**：

1. **Bot 身份**：`Bot` 表 + 个人 session（=个人 thread）+ memory scope + provider/model/workspace；
2. **持久化/恢复**：Bot 的 child session 已存在；重启后不依赖 activation 内存，能 `processSubagent` 恢复；恢复失败标记 absent，提供“重建/接管”；
3. **群聊**：`Team` + `groupSessionId`（=群聊 thread）；用户消息默认 admin；`@` 直达；`@all` 仅 admin；状态/停止；
4. **Peer message**：`message_bot`，requestId 幂等，mailbox 合并未读，handoff tree；
5. **状态**：idle/working/waiting_approval/switching/waiting_on_bot/absent；`list_bots` + UI；
6. **成本**：admin 默认、只叫需要的成员、每轮预算/上限、超时、停止；
7. **超时/恢复**：Work `deadlineAt`；上游等待可见；超时转 failed/waiting，不无限挂；
8. **群记忆**：`group` scope；只在该群 thread 注入；成员移出即失效；
9. **权限**：admin 才能改群/加人；普通 bot 只能 @ 本群；Main Bot 高权限但删除需用户确认。

**分阶段**：

- P1a：Bot 身份 + 持久化恢复 + 个人 session；先把 agent-teams 成员升级为 Bot；
- P1b：群聊 admin 路由 + 状态 + 停止；不做复杂派活树；
- P1c：peer message + handoff tree + deadline；
- P2：跨群/团队记忆、Main Bot 管理、跨设备。

### 4.8 UI / 可观测

- Sidebar：一个 Session（用户眼里的 Thread）一行；不显示每个 segment；展开可看“段历史”（可选）；
- Chat：连续消息，段边界显示一条淡淡的 `继续` 分隔；不显示 70%/90% 默认；诊断面板可看；
- Header：当前模型/段号/状态；不打断；
- TaskCenter：Bot/团队/群聊；成员状态、任务、邮箱、等待关系、停止；
- Memory：conversation scope、注入原因、usage、pending；
- Audit：steward 决策、handoff、token/成本；可导出；
- 错误：handoff 失败/恢复中/等待用户，明确显示，不静默。

### 4.9 安全/信任

- 自动记忆/自动 handoff 都是数据，不是指令；
- 群聊/peer message 可能被注入；不自动执行；
- Bot 只能读自己/群/团队允许的记忆；不能读别的 Bot 私有；
- 跨 bot 写需要权限；删除需用户确认；
- 所有段保留；用户可导出/删除 session（=thread）；
- 工具结果/网页/文件中的“记住/转发”不升级为记忆或消息。

---

## 5. 如何比 Codex 和 DS-Bot 更强

不是「功能更多」，而是**在三个维度同时更强**：

| 维度 | Codex | DS-Bot | Codem 目标 |
|---|---|---|---|
| 上下文连续性 | 强（新窗口+retained+history） | 强（段+handoff） | 强（段+handoff+checkpoint+检索） |
| 细节可回读 | 中（history/notes，依赖后端） | 中（FTS+锚点） | 强（thread FTS + 锚点 + spill 全文） |
| 记忆可信 | 弱（自动 summary/删改） | 中（自动 review/可撤销） | 强（manual/pending/不自动删改） |
| 协作 | 中（子代理/多 agent） | 强（长期 Bot/群聊/派活树） | 强（长期 Bot + 任务板 + 群聊 + 审批/超时） |
| 成本控制 | 中（阈值/按需） | 中（admin 默认） | 强（admin + 检索 + 预算 + 停止） |
| 可观测/可测试 | 弱（实验/隐藏） | 中（UI 状态/隐藏决策） | 强（审计/判据/指标） |
| 本地/模型自由 | 弱（Codex 后端） | 弱（DSH/DeepSeek） | 强（本地 SQLite + 多 provider） |
| 数据安全 | 中 | 中（本地） | 强（审批/scope/不回退） |

**五个“更强”的具体点**：

1. **可审计的无限线程**：DS-Bot 隐藏段/决策；Codem 保留段卡/决策/成本，用户可查但不被打扰。
2. **检索优先，而不是摘要优先**：旧段全文 + FTS + 锚点 + spill；不是“摘要的摘要”。
3. **可信长期记忆**：自动提取但不自动删改；manual/pending/usage/全文读取；比 Codex 全局 summary、DS-Bot 自动 review 更可控。
4. **有边界的 Bot 团队**：admin 默认 + deadline + 停止 + 审批 + 成本；不是无超时等待。
5. **模型/平台中立**：不绑定 DSH/OpenAI；本地优先，可接多 provider，适合 Codem 桌面/手机 Host。

---

## 6. 路线图

### P0：先锁契约，再做检索，再做 switch

> **融合后的施工顺序**以 [24 号文 §9](docs/project-guide/24-MEMORY-BENCHMARK-AND-ROADMAP.md) 为准：
> `契约 → memory 检索 → thread history → context manager → UI`。
> 下面的 P0-0..P0-4 是**施工顺序**，不是五个独立项目；不要先做 switch 再补检索。

目标：一个 Codem Session 可以持续工作，超过阈值时自动 compact 或 switch；用户无感；旧段可查；不破坏现有会话。

**P0-0 契约：Session=Thread，Epoch=Segment**

- `context_epochs` 加 `segment_seq`、`kind("compact"|"switch")`、`handoff_json` 可空；
- 不新建 `threads` / `thread_segments`，不改 `sessions` / `messages` / `MemoryEntry` / conversation scope；
- `DisplayView` 统一用 `listTimelineMessages`；`ContextView` 仍取最新 epoch；
- remote `session.get`、导出、fork 改读 DisplayView；fork 需重写 cutoff id 或显式全量；
- 旧 epoch 默认 `kind=compact, segment_seq=1`；旧 marker 无 metadata 保持兼容；
- 功能开关 `context.segmentEpochs`（默认 off，灰度）。

**P0-1 Memory 检索（先于 switch）**

- `memory_search` / `memory_read`：只读、scope/pending 过滤、全文；
- 注入改索引（id/scope/key/摘要/usage），不再只靠 200 字正文；
- 提取从完整 `listTimelineMessages`（含旧段）按 tier 取样；
- `usageCount` / `lastUsedAt` + 排序；
- 修面板/真实注入的 tracker 分叉；
- 不自动删改；pending/manual 保护。

**P0-2 Thread History**

- `thread_history_search` / `thread_history_read` / `thread_segment_list`；
- 数据源 `listTimelineMessages` + `context_epochs`；FTS + 锚点 + spill；
- 保留现有 `session_search` / `session_event_*` 作跨会话兜底；
- 压缩/switch marker 尾部提示可用 thread history；
- 旧消息只读、可导出。

**P0-3 Context Manager + Handoff**

- 回合结束版：当前段 token 过阈值 → 规则版 compact/switch；
- 先影子小模型（只记录不生效），再灰度生效；
- 规则护栏：未完成/中途 → compact；完成/连续压缩≥2/接近 hard → switch；失败回退；
- `compact` 复用现有 checkpoint；
- `switch` 写 handoff epoch（8 段 note + recent + anchors），不新建 Session；
- 同时落 **thread notes**（压缩前提醒/switch 前交接；短任务状态，不是长期记忆）；
- 单飞、超时、崩溃恢复；输入队列；
- 决策写 `steward_decision` 事件，不注入用户消息；
- 顺带修 24 P0-5 的计量问题：`currentToolDefs` 未赋值、反应式压缩无权威门、水位/面板分母不一致、marker 空转。

**P0-4 UI/恢复**

- 连续对话视图；段分隔卡（默认淡）；诊断面板；
- 不默认显示上下文百分比；只有“整理中/继续”状态；
- 重启恢复：`switch` epoch 的 handoff 状态决定是否重新投影；
- 指标：段数、switch/compact 次数、handoff 成本、注入/检索命中。

**P0 验收**：

- 200 轮/3 次 switch 后，早期事实仍能通过 thread history 找回；
- 未完成任务在阈值处 compact，不 switch；完成任务 switch；
- steward 失败不丢输入；切换中消息不重复/不丢；
- 旧消息完整、可搜索、不可变；
- conversation memory 换段后仍可见（session 不变）；
- 仍是一个 Session/对话，不出现重复会话；
- 24 号文的 memory/history 判据全绿，且没有被 switch 破坏。

### P1：长期 Bot / 群聊 / 协作

**P1-1 Bot 身份 + 持久恢复**

- Bot 表；个人 session（=thread）；memory scope；provider/model；
- 复用 SubagentRuntime 的 child session，但增加 `resume`/`processSubagent` 直接运行；
- 重启后 bot 不因 activation 丢失而 absent；失败可重建/接管；
- TaskCenter 显示 Bot。

**P1-2 群聊管理员模式**

- Team + group session（=群聊 thread）；admin 默认；
- 无 @ 只 admin；@ 只目标；@all 仅 admin；
- 状态/停止/超时；
- 群记忆 scope；
- 成本读数。

**P1-3 Peer message / handoff tree**

- `message_bot`、requestId、mailbox、未读合并；
- Work 树、deadline、结果文件/摘要；
- 禁止发给等待本 work 的上游；失败/停止/删除的结算；
- 与 agent-teams task board 打通。

**P1-4 UI**

- 群聊页；Bot 状态；等待关系；停止；审批；
- 不泄露私有记忆；权限。

### P2：自适应/规模化

- Steward 策略按模型/任务/成本自适应；
- 语义/混合检索（FTS + embedding）但保留锚点；
- 跨 session/跨项目记忆（显式 opt-in）；
- 多设备 Host 同步；
- 自动化 consolidation（仅归档/待批准）；
- 评测集/回放。

---

## 7. 验收判据

| ID | 场景 | 通过 | 变异 |
|---|---|---|---|
| ICM-1 | 200 轮、3 段 | 当前请求只含当前段；旧事实可 `thread_history_search` 找回 | 只读 `listMessages` ⇒ 红 |
| ICM-2 | 未完成任务过阈值 | 选 compact，不 switch | 去掉任务状态 ⇒ 红 |
| ICM-3 | 完成任务过阈值 | 选 switch，handoff 成功 | 强制 compact ⇒ 红 |
| ICM-4 | steward 超时/坏 JSON | 回退不丢输入 | 抛错/静默 switch ⇒ 红 |
| ICM-5 | 切换中用户发消息 | 消息转到新段一次，不重复 | 不排队/双写 ⇒ 红 |
| ICM-6 | 旧段 | 完整、可读、不可编辑、可导出 | 删除旧段 ⇒ 红 |
| MEM-T1 | 换段后对话记忆 | 仍 injection/read | 按 sessionId ⇒ 红 |
| MEM-T2 | 自动提取旧段事实 | 能从 thread timeline 提取 | 只读当前段 ⇒ 红 |
| HIST-T1 | 旧命令/错误 | thread_history_read 按锚点命中 | 只 FTS 摘要 ⇒ 红 |
| BOT-1 | 重启 | Bot 身份/个人 session 恢复；不因 activation 丢失变 absent | 只看 runtime map ⇒ 红 |
| BOT-2 | 群聊无 @ | 只 admin 回答 | 全员 fan-out ⇒ 红 |
| BOT-3 | 群聊 @ | 只目标回答 | 叫全员 ⇒ 红 |
| BOT-4 | admin PASS | 提示空轮，不静默 | 无提示 ⇒ 红 |
| BOT-5 | peer work | 结果回上游一次，不重复 | 无树/重复 ⇒ 红 |
| BOT-6 | 下游卡住 | deadline/可见等待，不无限挂 | 无超时 ⇒ 红 |
| COST-1 | 群聊普通消息 | 只 1 次 admin 调用 | 多成员调用 ⇒ 红 |
| TRUST-1 | 自动记忆 | manual/pending 不自动删改 | auto delete ⇒ 红 |
| CACHE-1 | stable prefix | session/epoch 变化不破坏 stable 部分 | 重排 ⇒ 红 |
| OBS-1 | steward 决策 | 可审计，不注入用户消息 | 无记录 ⇒ 红 |

所有判据按仓库纪律做变异自证。

---

## 8. 风险、取舍与待决策

### 8.1 不能照搬

- 自动 memory review 的删改；
- 无超时等待/无预算 fan-out；
- 纯 LLM steward 决定一切；
- 把旧段“索引”当完整语义索引；
- 为了无感而隐藏所有成本/失败；
- 依赖 DSH 的 Session/compact API；
- 把长期 Bot 当成一次性 subagent。

### 8.2 主要风险

- **epoch 契约分散**：`context_epochs` / marker metadata / `ContextView` / UI 读路径任一处漂移，都可能 fail-open 成全量或误裁；
- **fork/remote/export 读路径**：现有 fork 复制 ContextView，switch 后 cutoff 指向的 id 可能不存在；必须改读 timeline 或重写 cutoff，否则 fork 出现两份/全量；
- **steward/压缩锁**：进程内 `Set` 无 owner/TTL；steward 与 compact/manual 三路并发需要独立锁/超时；
- **steward 误判**：切走未完成任务；需要结构化任务状态/护栏；
- **handoff 丢失**：note 漏细节；需要 anchors/recent/检索兜底；
- **旧工具结果不可检索**：DS-Bot 的 FTS 不索引 tool call/result；Codem 必须把 `spill` 全文纳入 thread history，否则“无限”对编程场景不成立；
- **成本**：steward + handoff + 检索；需要预算/开关；
- **prefix cache**：换段/重排会断；需要稳定前缀；
- **群聊成本/挂起**：admin/fan-out/deadline；
- **多客户端/远程 Host**：同一 Session 的 epoch/消息并发；
- **测试**：现有测试以单 session 为前提，需新增 epoch/switch/恢复/fork/remote 判据。

### 8.3 需要产品决策

1. 默认是否开启自动换段？还是先“只 compact，手动换段”灰度？
2. 段切换是否显示“继续”卡？还是完全无感？
3. 是否显示上下文百分比？建议默认不显示，诊断可查。
4. 是否在 P2 做物理分片（一个逻辑 Session 映射多个物理 Session）？第一版不做，conversation memory 不迁移。
5. 群聊是否默认 admin？是否允许多 admin？
6. 长期 Bot 是否共享项目工作区？权限/审批如何？
7. 是否允许 Bot 之间自动派活？是否要用户确认/预算？
8. 是否保留 `agent-teams` 任务板与群聊两种视图，但共用一套 Team/Work 数据？

---

## 9. 与 24 号文的融合裁决（必须一起读）

> 24 号文 §9 是**唯一裁决**；本节是执行说明。若两文冲突，以 24 §9 为准。

### 9.1 一句话方案

**不要做两套上下文机制。** 采用：

```text
Session = 用户看到的 Thread（一个连续对话）
ContextEpoch = Segment 边界
  kind=compact：段内压缩（旧消息不动）
  kind=switch：换段（handoff，旧消息不动）
Memory / Notes / History 都是 Session 级，不需要 threadId 迁移。
```

这与 24 号文的 Codex 结论完全兼容：

- Codex 的 Token Budget 新窗口 = 我们的 `kind=switch` epoch；
- Codex 的 64K retained = handoff 的 recent 预算（Codem 建议 16–24K，不默认 64K）；
- Codex 的 summary = `compact` 的 checkpoint；
- Codex 的 history/notes = `thread_history_*` + thread notes；
- Codex 的 memory summary = Codem 的 scoped memory index（不做全局 summary）；
- Codex 的自动 consolidation = 只做候选/归档，不自动删改。

### 9.2 施工顺序（覆盖 24/25 的小节顺序）

```text
P0-0  Session=Thread / Epoch=Segment 契约；context_epochs 加 segment_seq/kind/handoff
P0-1  Memory 检索：index + search/read + full timeline extraction + usage
P0-2  Thread History：FTS + 锚点 + spill；session_search 兜底
P0-3  Context Manager：规则版 compact/switch → 影子 LLM → 灰度
P0-4  UI/恢复：段分隔、诊断、重启恢复
P1    Bot Team：身份/恢复/群聊/peer work/handoff tree
P2    物理分片、混合检索、跨设备、自动归档（pending/archive）
```

**不要**先做 switch 再做 memory/history；否则换段后模型没有检索入口，会重跑工具、丢事实。
**不要**先建 `threads` 表；第一版 `threadId = sessionId`，否则会引发记忆、fork、remote、侧边栏的连锁迁移。

### 9.3 两轮结论的合并表

| 主题 | 24 号文（Codex） | 25 号文（DS-Bot） | 最终裁决 |
|---|---|---|---|
| 上下文边界 | 新 window + 64K retained | 新 Session + handoff | **同一个 `switch` epoch**，不新建 Session |
| 压缩 | 检查点摘要 | checkpoint + 原话 | `compact` epoch；保留用户原话/锚点 |
| 阈值 | 90% 自动 | 0.8 check / 0.95 hard | **一个 pressure 模型**；沿用 Codem 0.7 考虑线，0.9 hard；不引第二套 |
| 历史 | history/notes 工具 | FTS + anchor | **一个 `thread_history_*`**；现有 search 兜底 |
| 记忆 | 全局 summary + usage | Markdown + auto review | **scoped index + read + usage**；不自动删改 |
| 长期 Bot | 子代理/多 agent | 长期 Bot + 群聊 | **一个 Bot 身份层**，复用 agent-teams；不另造团队 |
| 成本 | 阈值/按需 | admin 默认 | admin + retrieval + deadline + stop |
| 可观测 | 弱 | 中 | **强**：段/决策/handoff/成本可审计 |

### 9.4 不能出现的“融合反模式”

1. 同时实现 Codex 新 window 和 DS-Bot 新 Session（两套恢复/缓存/记忆语义）。
2. 先按 `sessionId` 做完 memory/history，再引入 `threadId` 迁移（5000 条记忆 + pending + checkin 全受牵连）。
3. 同时维护 `session_search` 和 `thread_history_*` 两套检索（重复索引/不一致）。
4. 同时保留 agent-teams 和 DS-Bot 式 Bot 两套团队/状态（双写/双查）。
5. 自动 memory review + Codex consolidation + Codem manual 三套写路径（必然互相覆盖）。
6. 把“无限”理解成“不用检索/不用压缩”（只是 UI 无限，单次仍有限）。
7. 为了无感隐藏失败/成本/段边界（用户无法诊断）。

---

## 附录 A：DS-Bot 源码索引

- `ds-bot/src/host/steward.js`：阈值、steward prompt、checkpoint、parseDecision、checkpointCount/Text
- `ds-bot/src/host/parts.js`：parts、handoff、writeNote、writeCheckpoint、checkContext、pre-step、switch/condense
- `ds-bot/src/host/chat-index.js`：FTS5 trigram、补齐/封存、search/around/part
- `ds-bot/src/host/groups.js`：群聊 round、admin 路由、@、batch、状态、stop
- `ds-bot/src/host/handoffs.js`：Work 树、request_id、结果、等待、状态
- `ds-bot/src/host/memory.js`：Markdown memory、remember/forget/recall、review、journal/pending/snapshot
- `ds-bot/src/host/constants.js`：ROOM/OWN_CHAT/HISTORY 常量
- `docs/plans/2026-10-09-context-and-memory.md`
- `docs/plans/2026-10-16-bot-handoffs.md`
- `docs/plans/2026-10-07-group-chat.md`
- `docs/vision.zh.md`

## 附录 B：Codem 改造面

- `src/core/llm/agentic-loop.ts`：回合/压缩/工具循环，新增 steward 触发与 switch epoch
- `src/core/llm/compaction-budget.ts`：现有 checkpoint 保留/摘要，可复用
- `src/core/context/context-view.ts`：epoch/cutoff，扩展 `kind=switch`
- `src/core/context/context-epochs.ts`：加 `segment_seq/kind/handoff`
- `src/core/storage/session.ts`：Session=Thread，不改 thread_id
- `src/core/storage/message.ts`：DisplayView 用 listTimelineMessages；模型仍用 listMessages
- `src/core/memory/memory.ts`：conversation scope 保持 sessionId；memory index/read/usage
- `src/core/subagent/runtime.ts`：Bot 执行/恢复
- `src/core/agent-teams/*`：任务板/邮箱/状态，升级为 Bot 团队
- `src/core/goal/*`：长任务状态/阶段证据，steward 可用
- `src/components/ChatPanel.tsx` / `Sidebar.tsx` / `TaskCenter`：Session 连续视图/群聊/Bot 状态
- `src/core/remote/*`：DisplayView / 段投影

## 附录 C：与 24 号文的关系

- 24 号文解决「记忆/压缩/检索」的 Codex 对标；
- 25 号文解决「线程无限 + 长期 Bot 团队」的 DS-Bot 对标；
- P0 建议先做 24 号文的 memory index/read + thread history，再做本 25 号文的 segment switch；
- 两者共享：full timeline extraction、usage ranking、session-scoped conversation memory、不自动删改、可审计。
