# 对标取证（带出处）：三家提示装配 / 记忆落点 / 前缀缓存

> **本文件是 GAP-LIST `O-54` 第 ① 项的交付**：把原来只落在 `.preview-shot/`（该目录在 `.gitignore` 内
> ⇒ **不进仓库**）里的三份对标取证，做成**带出处的摘要**落进仓库，clone 下来的人不必重做取证。
> 原始长文继续留在 `.preview-shot/`（`_bench-*.md`、`_dsh-*.md`、`_audit-memplace-*.md`、`_reaudit-memplace.md`）——
> 它们是**过程材料**，本文件是**结论与出处**，两者用「素材索引行」对接（见 §一 每组的 `-0` 行）。
> 判据：`src/test/docs-bench-evidence.test.ts`（`BENCH-EVIDENCE-1` 的 `BE-1`…`BE-5`）。
> 落库波次：第 191 波；落库时仓库 HEAD `999d7e8e`、版本 `1.16.300`（**快照事实**，不是长期不变量）。

## 〇、三档证据等级（只有这三档）

| 等级 | 判定标准 | 能不能当依据 |
|---|---|---|
| **确证** | 有上游源码 `文件:行`，或有**本机可复现的读数** | 可以当依据 |
| **疑似** | 只有文档、二手笔记，或从现象推断（没有源码、没有读数） | 只能当线索 |
| **不可用** | 本地**根本没有**那份上游文件 / 那份快照 | **不许当证据**，只能当「待核实的引用」 |

三条硬纪律（本文件先守，由 `src/test/docs-bench-evidence.test.ts` 的 `BE-1` / `BE-2` / `BE-4` / `BE-5` 守着）：

1. **不编出处** —— 拿不到上游 commit / 版本号就写「版本未知」；这样的行**可复现性**一律按 `疑似` 处理
   （源码 / 读数在场 ⇒ 证据本身仍是 `确证`，但别人无法定位同一快照 ⇒ 只能当线索复核）。
2. **本地没有 = 不可用** —— 上游文件在本地快照里不存在时，一律标 `不可用`（例见 §三.②）。
3. **每条结论都要能指到一个仓库内文件**（不许只指原始长文目录），由 `BE-2` 在 `src/test/docs-bench-evidence.test.ts` 里守着。

**两份取证打架时以哪份为准**（不处理会让读者各取所需）：「三家落点取证」是**先**写的（它自述本机没有 OpenClaw / Hermes 的 clone），
「DSH reminder 取证」「OpenClaw 源码取证」「Hermes 源码取证」是**后**写的。落库时读到的文件时间（`LastWriteTime`，只读属性）依次是
`20:14:47` → `20:29:04` → `20:37:31` → `20:41:25`。**这个顺序本身只能算 `疑似`**（mtime 不等于写作顺序），
但方向上与内容自述一致 ⇒ 冲突处**一律以后写的、带源码行号的那份为准**，并在下表逐条注明。
第 189 波在仓库内的摘要见 `docs/HANDOFF-NEXT-SESSION.md:3924-3945`。

## 一、结论一览（逐条：结论 / 上游出处 / 等级 / 我方依据）

每组表的 `-0` 行是**素材索引行**：它把「原始长文文件名」与本文件对接起来；组内其余行只写**上游出处**（文件 : 行 / commit），
不重复长文文件名（这样素材引用只有一处，改动/核对都只有一个入口）。

### A. DSH（本机安装面：`C:\Program Files\DSH Desktop\resources\app\`；**版本未知**）

| # | 结论（它支撑我方哪条机制 / 哪条判据） | 上游出处（文件 : 行 / commit） | 等级 | 仓库内依据 |
|---|---|---|---|---|
| A-0a | **素材索引**：三家落点取证（含 DSH 段）—— 本组所有 DSH「记忆放哪 / 每步重算 / 缓存纪律」结论的原始长文 | `.preview-shot/_bench-memory-placement.md`（读本机安装包 `@deepseek-ai/dsh-system-prompt/lib/index.js:10-48`、`dsh-agent-instructions/lib/index.js:111-115` / `README.zh.md:86,151`；**版本未知**：本机安装包，未记录版本号 / commit） | **确证** | `docs/HANDOFF-NEXT-SESSION.md:3924-3945`；`src/test/docs-bench-evidence.test.ts`（`BE-1` 的素材匹配） |
| A-0b | **素材索引**：DSH `<system-reminder>` 生命周期取证 —— 本组所有「压缩 / 重放 / 嵌套 scope」结论的原始长文 | `.preview-shot/_dsh-reminder-lifecycle.md`（读本机安装包 `dsh-agent-instructions/lib/index.js:1074-1080,1125-1132,1160,1213-1220`、`dsh-compaction-basic/lib/index.js:410-432`、`dsh-session/lib/index.js:410-419`；**版本未知**） | **确证** | `src/test/context-consistency.test.ts`（`COMPACT-MEM-1`）；`docs/HANDOFF-NEXT-SESSION.md:3930-3932` |
| A-1 | DSH 的跨会话知识**根本不进系统提示**：它把 `$DSH_HOME/AGENTS.md` + 项目 `AGENTS.md`/`CLAUDE.md` 链渲染成 **user 角色 `<system-reminder>`** 追加进**派生历史**；段表 `SECTION_ORDERS` 里**没有记忆槽** ⇒「记忆该放哪」不是只有「系统提示的哪一段」一解 | `dsh-agent-instructions/lib/index.js:111-115`、`dsh-system-prompt/lib/index.js:10-48`、`dsh-agent-instructions/README.zh.md:86`（本机安装包，**版本未知**） | **确证** | `src/core/prompt/prompt.ts:133-143`（我方仍留在系统提示里的理由）；`docs/HANDOFF-NEXT-SESSION.md:3926-3932` |
| A-2 | DSH **每个模型步骤**重新 assemble 系统提示；保前缀靠「渲染未变则节点不动」+ 协议字段 `systemPromptUpdate:"in-history"`（变更后的提示**追加到已缓存历史之后**）。默认模型条目就声明了它 | `dsh-system-prompt/README.zh.md:12,151`、`dsh-llm-deepseek/lib/index.js:47`（**版本未知**） | **确证**（源码／打包 JS）；**运行时是否触发过该分支 = `疑似`**（44 个会话里 `system/message` 节点数全为 1，见 A-3） | `src/test/cache-prefix-stability.test.ts`；`docs/GAP-LIST.md:135`（O-48 的分水岭） |
| A-3 | DSH 的 `<system-reminder>` **只在内容变化时**追加一次（三条独立闸门），未变时**一个字节都不发**；压缩**不豁免**它（先被摘要器逐字回放一遍），但压缩后**完整基线整份重放**（实测 3 次压缩 ⇒ 3 条 7,661 B、同 digest 的基线） | `dsh-agent-instructions/lib/index.js:1125-1132,1160,1213-1220`、`dsh-compaction-basic/lib/index.js:410-432`、`dsh-session/lib/index.js:410-419`（**版本未知**） | **确证**（判定条件原文 + 会话日志实测一致） | `src/test/context-consistency.test.ts`（`COMPACT-MEM-1`：我方取 Hermes 的「豁免」口径，不取 DSH 的「不豁免 + 重放」） |
| A-4 | 不对称：只有**完整基线**会自动重放；`Additional instructions from: …`（按需发现的嵌套 scope）被遮蔽后**不会**自动回来 | `dsh-agent-instructions/lib/index.js:914-940`（判定条件；**版本未知**） | 判定条件 **确证**／后果 **疑似**（44 个会话无该形态样本） | `docs/GAP-LIST.md:137`（O-49 对 `extraSystemPrompt` 位置的实测要求） |
| A-5 | DSH 的缓存纪律是**机制级**的：几乎每个包 README 都有独立的 `#### KV Cache 影响` 小节（130+ 处），明说「仅追加，不使现有 KV Cache 条目失效」 | `dsh-agent-instructions/README.zh.md:181`、`dsh-tool-skill:206`、`dsh-fs-observation-policy:111` 等约 30 处（**版本未知**） | **确证**（本机 README 原文）；**对标三家的服务端命中率 = 不可观测**（见 §三.③） | `docs/PROJECT-GUIDE.md`（§五 开发纪律）；`src/test/cache-prefix-stability.test.ts` |

### B. OpenClaw（上游 `openclaw/openclaw`，`refs/heads/main` HEAD `b3196dfd`，2026-10-08 depth-1 clone）

| # | 结论（它支撑我方哪条机制 / 哪条判据） | 上游出处（文件 : 行 / commit） | 等级 | 仓库内依据 |
|---|---|---|---|---|
| B-0 | **素材索引**：OpenClaw 源码只读取证 | `.preview-shot/_bench-openclaw-src.md`（主仓 HEAD `b3196dfd` depth-1；第三方仓 `coolmanns/openclaw-memory-architecture` HEAD `0bcc44a`） | **确证** | `src/test/memory-placement-boundary.test.ts`；`src/core/prompt/prompt.ts:36-37` |
| B-1 | OpenClaw 把记忆**留在系统提示里**，而且有**硬编码段序表**（`memory.md = 70` 排最后），渲染完**立刻** push 缓存边界常量 ⇒「稳定前缀的最末」是代码决定的一等事实 | `src/agents/system-prompt-context-files.ts:7-15`、`src/agents/system-prompt.ts:855,857`（commit `b3196dfd`） | **确证**（源码行号 + commit） | `src/core/prompt/prompt.ts:641-653`（我方 `SYSTEM_PROMPT_CACHE_BOUNDARY` + 无条件哨兵，形态照抄此处） |
| B-2 | OpenClaw 的**内建 project memory recall 落在缓存边界之下**（`:876`），memorySection 在中部（`:784`），workspace 文件在最后（`:855`）⇒「边界之前 = 稳定」这条语义**必须由代码写清**，否则会把边界之后的稳定内容当成易变内容 | `src/agents/system-prompt.ts:636-871,876`（commit `b3196dfd`） | **确证**（源码行号） | `src/core/prompt/prompt.ts:14-17`（我方边界语义注释，第 189 波按同一形态校正） |
| B-3 | OpenClaw **每轮** prepend，但「未变则不改写」是**显式判定**（`promptDelta` + 非 restart 时沿用旧 `prefix`），只有内容真的变了才发生一次前缀改写 | `src/agents/embedded-agent-runner/session-prompt-state.ts:160,174,178`、`src/agents/embedded-agent-runner/run/attempt-thread-helpers.ts:9`（commit `b3196dfd`） | **确证**（源码行号） | `src/test/cache-prefix-stability.test.ts`；`docs/GAP-LIST.md:135`（我方今天没有跨轮状态，靠等价形态） |
| B-4 | `[GRAPH MEMORY]` 走的是 `prependContext`（**user-prompt 空间**，进消息历史、会被一起摘要），而 continuity / stability 插件已迁到 `prependSystemContext`（system 提示空间） | 第三方仓 `CHANGELOG.md:293`、`README.md:352`（HEAD `0bcc44a`） | **疑似**（只有文档与 CHANGELOG；该插件已被删除 ⇒ 实现读不到） | `src/core/prompt/prompt.ts:133-143`；`src/core/llm/agentic-loop.ts`（我方易变内容放尾部） |
| B-5 | OpenClaw 的 `plugin-graph-memory/` **已退役**：「Removed `plugin-graph-memory/` (retired — replaced by integrated facts search in continuity)」 | 第三方仓 `CHANGELOG.md:138`（HEAD `0bcc44a`）；主仓全仓 grep `GRAPH MEMORY` / `graphMemory` / `graph_memory` = **0 命中** | **确证**（退役这件事）；**`[GRAPH MEMORY]` 实现细节 = 不可用**（插件已不在任何可取快照里） | `docs/GAP-LIST.md:141`（O-54 ① 原文）；本文件 §三.① |
| B-6 | 「12 层」**不是**提示内段序：它出自第三方部署文档，维度是**延迟 + 加载时机**（每层标 `0ms / <1ms / 7ms / on demand`），与代码实际拼接顺序不一致 | 第三方仓 `docs/ARCHITECTURE.md:9-89`（HEAD `0bcc44a`） | **疑似**（Layer 1–3 确实映射段序，其余不映射；该文档从未自称段序） | `src/core/prompt/prompt.ts`（我方段序写在一处并由判据钉住） |

### C. Hermes（上游 `NousResearch/hermes-agent`，`main` @ `cbe5e53e2826b949e4ab33dbd6d045e339fa162b`，tarball 快照）

| # | 结论（它支撑我方哪条机制 / 哪条判据） | 上游出处（文件 : 行 / commit） | 等级 | 仓库内依据 |
|---|---|---|---|---|
| C-0 | **素材索引**：Hermes 记忆／提示装配源码只读取证 | `.preview-shot/_bench-hermes-src.md`（快照 `main @ cbe5e53e…`；`git clone` 两次被 `schannel / early EOF` 打断 ⇒ 只有 tarball，**无 git 历史**） | **确证** | `src/test/memory-placement-boundary.test.ts`；`src/core/memory/memory.ts`（我方两分形态的对照） |
| C-1 | Hermes 的缓存系统提示分 `stable→context→volatile` 三档并**顺序 join 成一个** system 字符串（三档是**字节排序**，不是三条通道）；**记忆快照（`MEMORY.md` / `USER.md`）在 volatile 尾档**，运行环境块永远收尾 | `agent/system_prompt.py:729-731,783,793-796,809`（commit `cbe5e53e…`） | **确证**（源码行号 + 固定 commit） | `src/core/memory/memory.ts`；`src/test/memory-placement-boundary.test.ts`（`MEM-PLACE-*`） |
| C-2 | Hermes **会话内冻结**：中途写入只落盘、不动已构建的缓存提示；唯一**自动**重建点是压缩边界（另有显式失效入口） | `tools/memory_tool_store.py:187-188,218,524-527`、`agent/system_prompt.py:812-830`、`agent/conversation_compression.py:3137-3138`（commit `cbe5e53e…`） | **确证**（源码行号） | 不照搬的理由写在 `src/core/prompt/prompt.ts:133-143`（我方审批语义是「批准即生效」） |
| C-3 | Hermes 把「**per-conversation prompt caching is sacred**」写成项目第一不变量，并把 `cache_control` 的 **4 个断点**常量化（`{"type":"ephemeral"}` / `ttl:"1h"`）；工作区路径为何后置也写了理由 | 根 `AGENTS.md`、`agent/prompt_caching.py:3-5,102-104`、`agent/system_prompt.py:762-763`（commit `cbe5e53e…`） | **确证**（源码 + 文档一致） | `src/test/cache-prefix-stability.test.ts`（我方等价纪律：易变字段尾置） |
| C-4 | Hermes 的「**字节相等 ⇒ 保留原字符串对象**」有源码 **+ 判据文本**双证，但**未实跑测试** | `agent/conversation_compression.py:3162-3168`、`tests/agent/test_413_compression.py:579,615,618`（commit `cbe5e53e…`） | **确证（源码级 / 文本级）**；**「测试真的通过」= 未取证**（素材 §4 自述未执行任何测试） | `src/test/cache-prefix-stability.test.ts`（同性质断言在我方是**实跑**的） |
| C-5 | **修正 `O-54` ② 的「未判明」**：Hermes 文档里那处层序自相矛盾**已被源码判明** —— volatile 档数组里 **skills 在记忆之前**（`volatile_parts = [skills_prompt, *_memory_parts(agent)]`），文档「concrete example」把 Skills 画在 memory 之后（Layer 7 vs Layer 5/6）与实现不符 | `agent/system_prompt.py:783`（commit `cbe5e53e…`）；矛盾原文见 §三.② | 源码侧 **确证**（判明了「实现是什么」）；**「文档哪个版本是当前实现」仍未核**（单次快照、无 git 历史） | `docs/GAP-LIST.md:141`（O-54 ②，本条是它的修正与收窄） |

### D. 我方读数（作为对照，**不是**对标取证）

| # | 结论（它支撑我方哪条机制 / 哪条判据） | 出处（本仓库内材料 + 原始读数位置） | 等级 | 仓库内依据 |
|---|---|---|---|---|
| D-1 | 我方「公共前缀比例」实测：只改易变侧 **97.67%**（顶掉 802 B）、只改平台级自动 95.66%、只改对话级 99.26%、只改平台级手动 **83.69%**（顶掉 5,603 B）⇒ 两分形态真的成立（反向对照差 14 个百分点） | `.preview-shot/_audit-memplace-cache-README.md`（原始读数 `.preview-shot/_audit/memplace-readings.json`；测量脚本已按纪律删除） | **确证**（本机实测）；口径是**客户端字节**，见 §三.③ | `src/test/memory-placement-boundary.test.ts`（`MEM-PLACE-2`/`MEM-PLACE-3` 用同一口径）；`src/core/memory/memory.ts` |
| D-2 | 无条件哨兵的固定成本 = **84 字符/份**（哨兵 77 + 段分隔 7），换来「稳定前缀到此结束」这个可解析的一等事实；空记忆时**只剩**这 84 | `.preview-shot/_reaudit-memplace.md`（§五 的实测长度） | **确证**（实测长度） | `docs/GAP-LIST.md:137`（O-50：这笔净成本还没有棘轮判据）；`src/core/prompt/prompt.ts` |

## 二、这些结论**怎么用在**我方机制上（一句话逐条）

- **A-1 / A-2 / A-3 / A-4（DSH）**：我们的「易变内容放尾部 + 无跨轮状态」是**另一条路**；DSH 那条路（搬进历史 + `in-history` 追加）**需要跨轮提示状态**，
  而我方装配是纯函数、每轮从零拼（`src/core/prompt/prompt.ts:133-143`）⇒ 抄它要先付「纯函数性质丢失」的代价，这正是 `O-48` 的分水岭。
- **B-1 / B-2 / B-3（OpenClaw）**：段序表 + 边界常量 + 「未变则不改写」三件套，是第 189 波「无条件哨兵 + 两分块」的直接来源；
  **B-2** 额外说明「边界语义必须写清」（否则边界之后的稳定内容会被误读成易变内容）。
- **C-1 / C-2 / C-3 / C-4（Hermes）**：权威性纪律（记忆块自带豁免 + 压缩摘要提示词里再写一句）取它的口径；
  但**不照搬它的会话内冻结**（C-2）—— 那会把我方的「批准即生效」变成「下次新会话才生效」。
- **B-4 / B-5 / B-6 + §三**：三处证据缺口，写在这里是为了**未来补齐**，并防止下一个人拿摘要当证据。

## 三、`O-54` 三处证据缺口的**现状**（逐条，写清「确证到哪一步」）

### ① OpenClaw `[GRAPH MEMORY]` 的实现已退役 ⇒ 只能靠文档

- **确证的部分**：主仓 grep 0 命中；`plugin-graph-memory/` 已从第三方仓删除
  （`CHANGELOG.md:138`「retired — replaced by integrated facts search in continuity」）。出处与 commit 见 B-4 / B-5。
- **不可用的部分**：`[GRAPH MEMORY]` 的**实现文件**（怎么选实体、怎么渲染那段文本）—— 插件已退役、本机无该 clone
  ⇒ **不能从源码证明**，只能引文档（`docs/knowledge-graph.md:119,139`、`docs/ARCHITECTURE.md:85`、`docs/COMPARISON.md:165`）。
- **结论**：涉及 graph 记忆的**任何比较**，等级最高只能是 `疑似`；我方对照结论只引用「退役」这一件事。
- **仓库内依据**：`docs/GAP-LIST.md:141`（O-54 原文）；本文件 §一 B-4 / B-5。

### ② Hermes 未跑测试，且它引用的 `references/system-prompt-invariant.md` **本地没有**

- **`references/system-prompt-invariant.md` 是上游文件、本地快照里没有**：上游 `agent/system_prompt.py:8` 引用它，
  但快照里 `references/` 目录不存在（`Test-Path` = False、glob 无命中）；本仓按该文件名递归搜命中 **0**
  ⇒ 等级 **不可用**：**不许当证据**，只能当「**待核实的引用**」。将来要拿它做依据，**必须**写成
  「上游 `NousResearch/hermes-agent` @ `<commit>` 的 `references/system-prompt-invariant.md`」并附取回方式；
  在此之前，替代证据只能用代码注释与上游 `agent/AGENTS.md`（见 §一 C-0 的素材索引行）。
- **Hermes 未执行任何测试**：`tests/agent/test_413_compression.py:579` 那条判据是**读文本**确认的
  ⇒ C-4 的「字节相等保留原对象」是**源码 + 判据文本**双证，**不是执行证明**。
- **文档内部层序自相矛盾**：档位描述把 skills 索引列在 volatile **首位**，同一页的「concrete example」把它画在 memory **之后**。
  **现已由源码判明**（见 C-5）：`agent/system_prompt.py:783` 的 `volatile_parts = [skills_prompt, *_memory_parts(agent)]`
  ⇒ skills 在前、记忆在后，**文档图示与实现不符**；但「文档哪个版本是当前实现」仍未核（只有单次快照、无 git 历史）。
- **仓库内依据**：`docs/GAP-LIST.md:141`；本文件 §一 C-4 / C-5；`src/test/docs-bench-evidence.test.ts`（`BE-5` 钉这三句必须在场）。

### ③ **对标三家**的服务端 KV 命中率 = 不可观测

- **口径**：**对标三家**（OpenClaw / Hermes / DSH）的服务端 KV 命中率**不可观测** —— 它们没给我们 provider 侧读数
  （`cache_read` / `cache_hit`），我们只能读它们的**请求构造**（`cache_control` 断点、边界常量、`in-history` 协议字段）。
  ⇒ 对这三家：**确证到「请求怎么构造」，未取证到「服务端到底命中多少」**（两份素材都自述「命中率 / 计费 / 影响未量化」）。
- **替代量（只有这一个）**：本地**公共前缀比例** = 按头对齐的公共**字节**数 ÷ 总字节数（口径与实测见 D-1 / D-2）。
- **它的边界**（逐条，防止把替代量当命中率用）：
  1. **只是客户端字节口径**，不是服务端 token 口径 —— 两者**不能互相换算**（见 §四）。
  2. 只覆盖**系统提示**这一段，**不含**历史正文与工具定义。
  3. 「字节相同」不等于「服务端一定命中」：服务端还有 TTL、驱逐、路由、批处理等我们看不见的因素。
  4. 语料是 11 条记忆 / 约 2.6 KB（`MEMORY_INJECT_CHAR_BUDGET=12000` 远未触顶）⇒ 不能外推到真实会话规模。
- **仓库内依据**：`docs/GAP-LIST.md:135`（O-48 的「收益未量化」）、`docs/GAP-LIST.md:141`（O-54 ③）；
  口径与断言见 `src/test/memory-placement-boundary.test.ts`。

## 四、**我们自己的**服务端 KV 命中率是**可观测**的（第 191 波更正）

> ⚠️ 分界：`O-54` ③ 说的是**对标三家**（OpenClaw / Hermes / DSH）的服务端 KV 命中率**不可观测**；
> **我们自己的**是**可观测**的（下面三行给出读法）。两者**不许混写成一句无主语的话**（`BE-4` 就是钉这一点的）。

- **归一化早就有**：`src/core/llm/usage-normalize.ts:35-37` 把 DeepSeek 的 `prompt_cache_hit_tokens`
  与 OpenAI 形状的 `cache_read_input_tokens` 归一化进 `cacheHitTokens`；`:47-58` 保证「provider 没报」与「报了 0」可区分
  （没报 ⇒ 字段不产出，`undefined ≠ 0`）。计价侧按它走：`src/core/llm/cost-tracker.ts:270-271,329-330`。
- **读法（一行日志，第 191 波新增）**：`src/core/llm/cache-percent.ts:114-123` 的 `formatPromptCacheLog(usage)`
  输出 `[prompt-cache] hit=… miss=… prompt=… ratio=…%`；接线在 usage 落账处
  `src/core/llm/agentic-loop.ts:4515`（`console.log(formatPromptCacheLog(usage))`）。
  **缺报时输出 `hit=? miss=? ratio=?` 并写明「provider 本次未上报缓存字段」，绝不写 `hit=0`**（编造一个「全未命中」的读数会把 O-48 的判断弄反）。
  判据：`src/test/prompt-cache-observability.test.ts`（`PC-1` / `PC-1b` / `PC-2`）。
- **它把「公共前缀比例」取代到什么程度**：**没有取代，是两个口径**。
  - 「公共前缀比例」= **客户端字节口径**（按头对齐的公共字节 ÷ 总字节）；
  - `[prompt-cache] hit=…` = **服务端 token 口径**（provider 上报的命中 token ÷ prompt token）；
  - **两者不能互相换算**：① 字节 ≠ token（tokenizer 未知，中文 1 码元 ≈ 1.4 字节只是本机语料的经验值）；
    ② 比例只量系统提示，`hit` 覆盖整请求（系统提示 + 历史 + 工具定义）；③ 服务端 TTL / 驱逐 / 路由会让「字节没变」也全 miss
    ⇒ 反方向同样不成立。
  - **分工**：比例回答「**我们这一侧的改动**会不会顶掉前缀」；`hit` 回答「服务端**实际**命中到哪一段」——
    这正是 `O-48`「要不要做 delta 通道」的分水岭数据（语义 A：整请求前缀匹配 ⇒ 省的是历史重算，收益大；
    语义 B：只有稳定前缀进缓存 ⇒ 几乎不额外省，收益小。详见 `src/core/llm/cache-percent.ts:90-113`）。

## 五、例外表（`BE-2` 的豁免登记；**不许过期**）

规则：`docs/**/*.md` 里提到原始长文目录的文件，**必须在同一文件里**指到一个仓库内文件
（例如 `src/`、`tools/`、`docs/PROJECT-GUIDE.md` 这类可解析路径）—— 即「不许只指原始长文目录」。
确有必要保留「只指原始长文目录」的历史记录时，在下表**逐条登记 + 写明理由**；判据会复核每条登记**是否仍然必要**：
被登记的文件若已不再提该目录，或已补上仓库内指针，这条登记就是**过期**的 ⇒ `BE-2` 判红（删掉该行）。
对标结论的**载体**（本文件自己）要求**更严**：段级 / 表格行级也必须自带仓库内指针（见 §六）。

| 文件 | 理由 | 登记波次 |
|---|---|---|
| （当前为空） | 落库时实测：`docs/**/*.md` 里提到原始长文目录的共 32 份，其中**只有** `docs/evidence-270-tfc-real-machine.md` 缺仓库内指针 ⇒ 已按「只允许加指针句子」的规定给它补了一句（该文件本身被 `docs/*.md` 忽略、**未进仓库**，那句指针只对本机读者有效 —— 如实标注） | 第 191 波 |

## 六、判据口径（`src/test/docs-bench-evidence.test.ts`）

| 判据 | 钉什么 | 反向对照（防恒真） |
|---|---|---|
| `BE-1` | `docs/BENCH-EVIDENCE.md` 存在；**至少 3 份**对标素材被引用（按文件名匹配）；每份都出现在**带等级标记**（`确证`/`疑似`/`不可用`）的同一行；带等级标记的行总数 ≥ 10 | 把两份素材索引行一起去掉（变异波次 `bench-evidence-191` 的 `MUT-1`）⇒ 判红 |
| `BE-2` | `docs/**/*.md` 里提到原始长文目录的文件必须在**同一文件**里指到一个**可解析**的仓库内路径（不存在的路径不算）；本文件还要**段级 / 表格行级**自洽；例外表逐条登记且**不许过期** | 伪造一份「只指原始长文目录」的文档 / 伪造一条过期例外 ⇒ 纯函数判红（`BE-3`） |
| `BE-3` | `BE-2` 的判定逻辑是**纯函数**（`repoInternalRefs` / `textUnits` / `auditPreviewPointers`），并用**伪造的坏文档**证明它会红 | 好文档（同段指了 `src/test/docs-bench-evidence.test.ts`）必须**不**被判红 ⇒ 证明判据不是恒真 |
| `BE-4` | 凡是「命中率 + 不可观测」的句子，**必须**同时写明是**对标三家**（`三家`/`对标`/`OpenClaw`/`Hermes`/`DSH`）；并断言文档给了我方读法 `[prompt-cache]`、`cacheHitTokens`、`prompt_cache_hit_tokens`、替代口径（公共前缀）与「不能互相换算」 | 把 §三.③ 那句改写成一句无主语的断言（`MUT-2`）⇒ 判红；纯函数对伪造的坏句子也判红 |
| `BE-5` | 三处缺口现状必须在场：`GRAPH MEMORY` **退役**、`references/system-prompt-invariant.md` 是**上游文件且本地没有**（等级 `不可用`）、Hermes **未跑测试**、文档层序**自相矛盾**；并断言本文件**真的在仓库里**（`git check-ignore -q` 退出码必须为 1） | 删掉 `.gitignore` 里的 `!docs/BENCH-EVIDENCE.md` 白名单（`MUT-4`）⇒ 判红 |

## 七、本文件自己的「未能取证」清单（如实留白，**不许编**）

1. **DSH / OpenClaw 安装面与文档的版本号**：A 组两份素材读的是本机安装面（`@deepseek-ai/*` 打包 JS 与 README）与第三方部署文档，
     原报告**没有记录版本号 / commit** ⇒ 相关条目一律标「版本未知」（已逐行写在上表）。
2. **A-2 的 `in-history` 追加分支是否在真实会话里触发过**：44 个会话 `system/message` 节点数全为 1 ⇒ 只读到源码，无运行时实证。
3. **A-4 的后果无实测**：没有「嵌套 scope 提醒 → 压缩遮蔽 → 不再重放」的真实样本 ⇒ 判定条件确证、后果疑似。
4. **OpenClaw `[GRAPH MEMORY]` 的实现**：插件已退役、本机无 clone ⇒ `不可用`（§三.①）。
5. **Hermes 的 `references/system-prompt-invariant.md`**：本地没有 ⇒ `不可用`（§三.②）。
6. **Hermes 未跑测试**；`git clone` 两次被 `schannel / early EOF` 打断 ⇒ 只有 tarball 单次快照，**没有 git 历史**可追设计演进。
7. **对标三家的服务端 KV 命中率**：不可观测（§三.③）。**我方**的可观测读法今天**还没有一份真机日志样本**归档到仓库
     —— `[prompt-cache]` 是第 191 波新加的读法（`src/core/llm/cache-percent.ts`），
     截至本文件落库**尚无真机样本** ⇒「语义 A 还是语义 B」**仍未判定**，`O-48` 的结论不能提前下。
8. **原始长文目录里的过程脚本**（`_audit/`、`_dsh-session-*.mjs`、`_verify-tfc-console.mjs` 等）**不在仓库里**
     ⇒ 上面所有「实测」读数的**复现脚本**对 clone 者不可用。本文件给的是**可复核的口径**（怎么算、算出来多少）与**上游出处**，
     不是可一键复跑的证据 —— 这条限制就是 `O-54` 的根因，登记在此以免被当成已解决。
