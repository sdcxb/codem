# 零缺口审计结论（可复核）

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。



> 维护者：每轮收尾时更新本文件。**每一项都必须附"证据 / 复现命令 / 实测数字"**，
> 否则不许写成"已闭合" —— 这是本仓库反复吃过的亏（"印出来的必须是真的"）。
> 更新时间：2026-09-19（第 64 轮，v1.16.93）

## 0. 怎么复核这份结论

```powershell
# ① 全量渲染侧用例（当前基线：329 文件 / 5784 通过 / 16 跳过 / 0 失败）
npx vitest run

# ② 类型 + 10 道 audit 门禁（当前基线：tsc 0；门禁 exit 0）
npx tsc --noEmit --incremental false
npm run audit

# ③ 引擎侧用例
cd src-tauri; cargo test

# ④ 发布链路（键 / 清单 / 签名 / 产物字节一致）
node tools\release\verify-update-manifest.mjs --remote     # 7/7 通过

# ⑤ 真机（打包版）：启动 + 维护数字 + 数据健康
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
node .preview-shot/cdp-boot.mjs 15000        # 抓启动维护汇总行
node .preview-shot/cdp.mjs "@.preview-shot/probe-health-11689.js"
```

## 1. 审计点名的四处已知缺口（用户最初指出的）

| 缺口 | 状态 | 证据 |
| --- | --- | --- |
| 损坏库备份**无等价物**（设置） | **已闭合**（v1.16.88） | 引擎 `salvage_projects_from_corrupt` 抢救 `settings` 到旁路文件；渲染侧 `restoreRecoveredSettings` 三条硬规则（只补缺键 / 黑名单不许继承 / 三类分别计数）；引擎用例 `salvage_sidecar_carries_settings_and_ownership`、`salvage_returns_zero_and_writes_nothing_for_unreadable_file`；渲染 `SET-RESTORE-1..4`。⚠️ 窗口很窄，已在 CHANGELOG 如实交代 |
| `tool_calls` 大 payload 在**真 CLI 契约**中的量级用例 | **已闭合**（v1.16.87） | `engine_tests.rs::tool_calls_payload_scale_is_byte_exact`：500 个调用 / 单条 args 2.11 MB + result 1.98 MB，**逐字节**比对（穿过 `args` 是 JSON 字符串那层编码）；实测写入 78 ms / 读回 13 ms |
| AR-1/AR-2/AR-3 覆盖移交**未逐条对齐** | **已闭合**（v1.16.85） | 逐条核对 12/12，并修掉两处指向不存在编号的注释（`MR-0`→`MR-6`、`AR-1~4`→`AR-1b/2b/3b/4/6`） |
| `PortKind` 里已不可达的 `"wasm"` 形状 | **已闭合** | 类型已收紧为字面量 `"rust"`；`event-log.ts` 里两处 `if (port.kind !== "rust")` 已删（恒不成立） |

## 2. 我自己在审计中"再次点名"并已闭合的（选择性列出，全部有真机数字）

| 项 | 版本 | 实测证据 |
| --- | --- | --- |
| 不变量审计把"读侧镜像没加载完"当成"没有缺口"（同一份数据两次维护报 **934** 与 **749**，934 恰好等于会话消息行总数） | v1.16.89 | 修复后打包版每次维护都报 **749**；`invariant-audit-load-window.test.ts` |
| 同一根因的其余四个消费方（对模型说"没有匹配"、对落盘报告说"会话没正常启动"、对面板说"没有轨迹"） | v1.16.90 | `event-read-readiness.test.ts`（13 条，成对断言）；真机口径是"无回归"（诚实交代） |
| 数据落点**两个来源**（`CODEM_DB_PATH` 只搬库、日志/附件/溢出/标记留在原地；隔离钻取会读写用户真日志）+ 权威日志回填静默 no-op + Windows `os error 3` 被误判成读失败 | v1.16.91 | 真机钻取：隔离目录出现 `sessions/` 与两个 `.jsonl`（504,338 + 316,635 字节）、`回填 777 条历史`；**用户真实目录逐文件未变**（6 个文件大小与 mtime 全等） |
| UI：三个（后补两个）按钮没有可访问名、一个计数显示两遍、几处点击目标 < 24×24 | v1.16.92 / v1.16.93 | 真机逐项复量：工具条**无名按钮 0 个**；「任务管理」可访问名 = `任务管理（1 条未读）`；「＋」命中 **24×24**；「置顶」命中 **18×24** |
| 更新清单用 v1 平台键 ⇒ 「检查更新」从未成功过 | v1.16.85 | `VERSION-5` 机器约束；真机：装的 1.11.0 → 发现 1.16.89/1.16.90/1.16.91 |

## 3. 还没闭合的（**不许**说成零缺口）

| 项 | 现状 | 下一步 |
| --- | --- | --- |
| 深层面板（插件 / 技能 / 任务中心 / MCP）的**逐面板走查** | 遮罩类名不统一（`.modal-overlay` 与内部面板各自为政），走查脚本认不出来，那几步读数会"继承"上一个面板 | 按面板各写一个驱动步骤（下一轮） |
| 便携模式的**产品决策**：功能目录（宠物/技能缓存/zvec/克隆目标）与旧库 `codem-db.bin` 是否跟着库走 | 刻意保留在 `appDataDir`，已写进 CHANGELOG 与 PROJECT-GUIDE | 等你拍板范围 |
| `session_meta` 事件的消费者 | 复核后**没有任何生产读取者**（写它的 `recordSessionFeedback` 有调用者，三个候选读全部落空；`project/files.ts` 那段死读已删）。**第 84 波：已把这条事实写进代码的写入点与读取点**（`feedback.ts` 的 `recordSessionFeedback` / `listSessionFeedback`、`event-projection.ts` 的 `case "session_meta"`），详见下方 **3.1 第 C 段** | 若要恢复"会话级指令覆盖"，需先有写入侧产品设计 |
| 用户库里的历史遗留 | 一条形状不合契约的 compaction 行已按你的选择规范化（告警归零）；凭据形状字符串的位置已给出（活 key 在 `codem-settings.providers.[3].apiKey`） | 你决定是否轮换 |

| 设置面板关闭按钮（`settings-close`）无可访问名 | **已闭合**（1.16.94） | 发现：第 71 轮真机普查 —— 面板内 **127 个可见按钮中 1 个无名**；修法：补 `aria-label`；**复量（已安装的 1.16.94）**：同脚本 → 127 个按钮 / **无名 0 个**，且脚本能按名字点中关闭按钮（`closed: true`）。脚本：`.preview-shot/probe-settings-unnamed.js` |

| 深层面板走查（插件/技能/智能体/MCP） | **已闭合**（1.16.96–1.16.98） | 关键阻塞已解：选择器补 `.modal-overlay`；面板关闭按钮全部命名。**复量（已安装 v1.16.98）**：技能 20 个控件/无名 0、智能体 9/0、MCP 5/0；四个面板关闭按钮均可按名字找到（修前分别有 12 / 0 / 1 个无名 + 0 个可命名关闭按钮）。⚠️ 残留两项已在下方单列 |

| 密集列表 `.market-skill-link-btn` 命中区 24×18（170 个） | **未修**（1.16.98 复量发现） | 插件/MCP 面板的市场列表里密集排布；扩命中区会压到相邻控件 ⇒ 需要"列表已渲染"状态下的布局判断（本次探针在该状态下取不到元素，故未动） | 按布局判断后小步扩；或在列表行留出间距 |
| `.lo-link-btn` 命中区修复的复量 | **已改、未复量** | CSS 已进 1.16.95 构建（24×15 → ≥24），但当时那个面板里该元素计数为 0，**不声称已复量** | 在 library-ops 面板那一轮补读数 |

### 3.1 第 84 波（功能上下文审计第一批）：**已整改的"假陈述"与"零生产调用者登记"**

对应报告：**`.preview-shot/audit-feature-context.md`**（功能上下文静态审计，280 行；`.preview-shot/`
是 gitignore 的一次性目录，所以上面那段复核命令是本文件里**可独立复算**的证据，不依赖那份报告还在）。
本轮**只做注释/文案与实现对齐 + 登记，不新增功能、不改行为**。改动范围只限
`src/core/**`（`src/core/storage/**` 除外）、`src/App.tsx` 的 `/feedback` 回执一处、`src/test/**` 注释、`docs/**`。

**复核命令（先跑它，再读下面的结论；行号以收尾时的文件状态为准）**。
它按"**生产文件里、非注释行**"计数 —— 本轮给这些函数补的登记注释本身也会提到函数名，
所以必须排除注释行，否则读数会被自己的注释灌水：

```powershell
cd C:\mimo-gui
$prod = Get-ChildItem -Recurse -Include *.ts,*.tsx -File src |
        Where-Object { $_.FullName -notmatch '\\src\\test\\' -and $_.Name -notmatch '\.test\.' }
foreach ($t in 'deriveMessagesFromEvents','projectIncremental','getActiveGenerations','replaceGeneration','isCompactCommand','listSessionFeedback','getSessionPreset') {
  $hits = @($prod | Select-String -SimpleMatch $t | Where-Object { $_.Line -notmatch '^\s*(//|\*|/\*)' })
  "$t : 非注释命中 $(@($hits).Count) 处"
  $hits | ForEach-Object { "      $($_.Filename):$($_.LineNumber)" }
}
# 本轮实测：deriveMessagesFromEvents 1（只是它自己的定义行）、projectIncremental 1、
# getActiveGenerations 1、replaceGeneration 1、isCompactCommand 2（定义 + 内部 self-call）、
# listSessionFeedback 1、getSessionPreset 1 —— **全部只有定义 / 内部 self-call，零调用点**。
# （`registerHandler` 是同名方法，命中散在 command-goal / host-webserver / sdk-protocol 等
#   无关 provider 上，所以不列进这条命令；要单独看 command-compact 那一处，
#   把上表的 `isCompactCommand` 换成 `commandCompact` 即可。）
```

#### A. 注释/文案与实现相反 → 已改到与实现一致

| 编号 | 文件:行号 | 改前是什么（假陈述） | 改后是什么 | 依据（实现侧） |
| --- | --- | --- | --- | --- |
| P1 | `src/core/storage/event-projection.ts:728-756`（`deriveMessagesFromEvents`） | "This is the primary function used by `buildMessages()` in agentic-loop." | 明确写它是**零生产调用者**（含测试也是 0），只是投影能力的**测试/诊断入口**；`buildMessages()` 走消息表 | `src/core/llm/agentic-loop.ts:31`（墓碑 `deriveMessagesFromEvents removed`）、`:2853-2862`（"DB CRUD is the single source of truth … NOT for message projection"） |
| P1' | `src/core/storage/event-projection.ts:1-36`（模块头） | "events → LLM messages"＋"incremental projection (only process new events)" 让人以为投影=模型上下文 | 模块头写明**消息权威是 JSONL / `messages` 表**，投影只供 telemetry/audit，活消费者仅 `projectSurface` 与 `validateReplay` | 同上；`src/core/storage/session-jsonl.ts:10-19` |
| P2/P3/P4 | `src/core/storage/event-projection.ts:63-82`（类头登记表） | 四个方法各自只有"设计上做什么"，读者会以为 `buildMessages()` 还在走投影 | 类头加一张登记表：`projectAll:93` / `projectIncremental:111` / `getActiveGenerations:614` / `replaceGeneration:701` 的**生产调用者 = 0**、谁在驱动它、保留或该删的理由；4 处方法注释各加一条"零生产调用者"（`replaceGeneration` 另加"唯一写路径 + 直接调用会毁一致性"的红字） | 见 B 段每行的证据 |
| P5 | `src/core/storage/event-types.ts:1-26`（模块头） | "Events are the source of truth; messages are derived projections" | 改成**消息是权威、事件不是**；补"事件自身是唯一没有等价物、不可重建的存储"三行对照表；删掉"fork"这个不实能力词 | `src/core/llm/agentic-loop.ts:2853-2862`；`src/core/storage/session-jsonl.ts:10-19`；`src/core/storage/maintenance.ts:1223` |
| P5 | `src/core/storage/event-log.ts:1-28`（模块头） | "- Source of truth for session state"、"Phase 2: buildMessages() reads from event projection"（该 Phase 从未发生且已被否决） | 改成"事件是 telemetry/audit 与派生读的来源，**不是**消息的权威"；并写明 Phase 2/3 未走这条路 | 同上两处 + `event-log.ts` 自身 `append` 的 `seq=0` 语义 |
| C1 | `src/core/provider/plugin-registry-provider.ts:142` | description "…/compact 命令，手动触发上下文压缩"；riskDescription "关闭后 /compact 命令不可用"（对用户承诺一个没接线的命令） | description 改为"`/compact` 命令的服务壳（当前未接线）"；riskDescription 改为"该命令当前未接线：`/compact` 没有接入 App 的命令分发，输入它会被当作普通消息发给模型；手动压缩请用上下文面板的压缩按钮。关闭本插件对现有行为无影响" | `src/core/provider/command-compact-provider.ts` 全文件（`registerHandler`/`execute`/`isCompactCommand` 零调用者）；`src/App.tsx` 命令分发里只有 `/feedback`（本轮不动分发，**不新增功能**） |
| F3 | `src/test/fork.test.ts:28-49`（文件头注释） | "这条用例在端口模式下仍红…**真机上 fork 出来的消息会丢掉工具调用**" | 改为**已过期**：列出本轮实测命令与结果（2 文件 / 16 用例全绿），并给出机制依据 | `src/core/storage/message.ts:548-562`（`withToolCalls` 用 `toolCallCache` 回填，且刻意放在所有返回路径之前） |
| F3 | `src/test/encoding-toolcalls.test.ts:42-57`（文件头注释） | "已知产品缺口（本文件最后那条 fork 用例因此仍红）：端口模式下同步读路径拿不到 tool_calls" | 同上改为已过期 + 实测读数 + 机制依据（断言未改，仍读端口表） | 同上 |

#### B. "能力已实现但零生产调用者" → 已在代码原处登记（并在此留一行）

| # | 能力 | 定义 | 生产调用者 | 谁在驱动它 | 处置 / 为什么 |
| --- | --- | --- | --- | --- | --- |
| P2 | `projectIncremental` | `src/core/storage/event-projection.ts:111` | **0** | `src/test/event-sourcing.test.ts:249,277` | **保留 + 登记**：唯一可能用到增量的 `buildMessages()` 已改用**消息表指纹缓存**（`agentic-loop.ts:2864-2932`），增量投影在生产里被另一套机制取代；但删它会连带删掉"压缩必须全量重建"这条语义的唯一表达，而那条语义与 `applyCompaction` 同源 |
| P3 | `getActiveGenerations` | `src/core/storage/event-projection.ts:614` | **0** | `src/test/replay-validation.test.ts:307`（**只断言"不抛"**，不断言世代语义） | **保留 + 登记**：它是 R3-3.2"世代追踪 + 压缩取代"设计的一半，另一半 `replaceGeneration` 也没人用；今天既不是活能力，也没有判据钉住它 |
| P4 | `replaceGeneration` | `src/core/storage/event-projection.ts:701` | **0（连测试都没有）** | 无 | **不删、不改行为，只登记**：它是**只读投影模块里唯一的写路径**（`append` 一条 `compaction`），且没做真实压缩的四件事（软删 / 标记消息 / 并发闸门 / 整轮边界），直接调用会让**投影与真实可见集永久劈开**。要不要把它接到产品路径（"替换某代回答"）上需要产品决策 |
| — | `EventLog.compactWithSnapshot`（事件日志压缩，**唯一的删事件路径**） | `src/core/storage/event-log.ts:343` | **0** | `src/test/snapshot-compaction.test.ts`、`src/test/dsh-integration-full.test.ts` | **保留 + 登记**：启动维护刻意不接（本文件第 3 节上方表里 `prunedEvents`/`compactedSessions` 恒为 0 的长注释就是那条决定）；它是"高危但只靠注释守着"的能力 —— 一旦接上，`session_events` 是**唯一没有等价物**的存储（`maintenance.ts:1223`） |
| — | `commandCompact`（`/compact` 命令服务壳） | `src/core/provider/command-compact-provider.ts`（`registerHandler`/`isCompactCommand`） | **0** | 无（**全仓零测试**） | **不新增功能**：只把面向用户的插件文案改成与实现一致（见 A 段 C1）；注册仍在（`builtin-registry.ts:393`），但功能未接线这件事现在**在用户看得见的地方**也写着 |

#### C. `session_meta` 只写不读 → 写入点与读取点各写一条

| 位置 | 写的内容 | 依据 |
| --- | --- | --- |
| **写入点** `src/core/llm/feedback.ts:62-88`（`recordSessionFeedback`，定义 `:90`，实际 `append` 在 `:99`） | "⚠️ 关于 `session_meta` 这条通道的现状（同一轮登记，写入点）：**它只写不读**。全仓生产写方只有本函数；另一个写方 `preset-discovery.ts::selectPresetForSession` 零调用者；两个读函数 `listSessionFeedback`（本文件）与 `getSessionPreset` 都零生产调用者；投影里 `case "session_meta"` 是 no-op" | 该函数是唯一生产写方（`App.tsx:2721` 调）；另一写方 `preset-discovery.ts` 零调用者 |
| **读取点** `src/core/llm/feedback.ts:108-116`（`listSessionFeedback`，定义 `:117`） | "第 84 波：**零生产调用者**（功能上下文审计 B1）…也就是说 `/feedback` 写进去的东西，今天在**产品里没有任何读路径**" | 调用点只有 `dsh-integration-full.test.ts:249-251`、`functional-chain-closed-loop.test.ts:132-135` |
| **读取点（投影侧）** `src/core/storage/event-projection.ts:207-224`（`case "session_meta"` 在 `:207`，说明在 `:215-224`） | 写明这里"被读到但什么都不产生"，并列写方 / 读方现状，指明"要加语义先定写入侧产品设计" | `event-projection.ts` 的 `applyEvent`；`maintenance.ts` 同结论 |
| **读取点（维护侧，原有）** `src/core/storage/maintenance.ts`（`session_meta` 论据段） | 原文已如实写着"今天没有任何生产读取者"（第 60 轮结论，本轮未改其结论，只在同段修掉另一条不实论据） | 本文件第 3 节表格中"`session_meta` 事件的消费者"那一行 |
| 既有登记 | 本文件第 3 节表格"`session_meta` 事件的消费者"一行（状态：**复核后没有任何生产读取者**） | 同上 |

#### D. 其它"注释声称的消费者与实现不符"

| 编号 | 文件:行号 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- | --- |
| P7 | `src/core/storage/maintenance.ts:1561-1573`（`prunedEvents` 长注释的论据清单） | "`runtime-invariants` 也读它（`abort` / `compaction` 会改变它判定的口径）" | 写明**实现里没有这条读**（`runtime-invariants.ts` 全文无 `compaction`/`abort` 字样），但**结论仍成立**：是"旧事件被删后老消息在事件侧无对应事件 → `VISIBLE_BUT_NOT_RECORDED` 误报"这条**间接**机制 | `src/core/llm/runtime-invariants.ts`（只按 `user_message` / `assistant_text` / `assistant_reasoning` / `tool_call` / `tool_result` 过滤；误报点 `:129-141`） |

#### E. `/feedback` 的"假成功" → 改成如实提示（唯一一处行为可见变化）

| 位置 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- |
| `src/core/llm/feedback.ts:62-106`（`recordSessionFeedback`） | 返回 `void`，**不看** `append` 的返回值 | 返回 `{ seq, persisted }`：`persisted === false` 表示事件**没有**进持久日志 | `src/core/storage/event-log.ts` `append` 在端口未接手/未就绪时**不抛**，返回 **`seq === 0`** 的"未落库事件" |
| `src/App.tsx:2714-2736`（`/feedback` 回执，**只动这一处提示逻辑**） | 无条件 `✅ 反馈已留档…`（事件根本没落库时也打 ✅） | `persisted` 为真才打 ✅（并在文案里带上真实 `seq`）；为假则打 `⚠️ 反馈**没有**写进事件日志：事件通道当前不可用（未落库，seq=0）…请稍后重试` | 同上 |

**本轮全量验证（改动后实测，原始输出逐字照抄）**：

```text
$ npx tsc --noEmit --incremental false
（无输出）                       EXIT=0        ← 本轮最后一次改动（纯注释）之后又跑了一次，仍 0

$ npx vitest run
 Test Files  339 passed (339)
      Tests  5844 passed | 16 skipped (5860)
   Start at  08:58:44
   Duration  74.76s (transform 19.79s, setup 36.35s, import 81.32s, tests 179.52s, environment 89.62s)
（vitest 退出码 0；原始输出：.preview-shot/r84-vitest-full-final.txt；
 前一次全量（改动中途）读数相同：339 / 5844 / 16 skipped / 0 失败，见 .preview-shot/r84-vitest-full.txt）

$ npx vitest run src/test/fork.test.ts src/test/encoding-toolcalls.test.ts
 ✓ src/test/encoding-toolcalls.test.ts (6 tests) 167ms
 ✓ src/test/fork.test.ts (10 tests) 183ms
 Test Files  2 passed (2)      Tests  16 passed (16)      （退出码 0）

$ npm run audit
（10 道门禁全部通过；末道输出：[write-return] 扫描 808 个文件 / 写入点 88 处 / … 未处理返回值的 0 处（允许清单 1 条））
```

⚠️ 说明：339 文件 / 5844 通过 是**本机本轮实测**（基线 336 文件 / 5830 通过见第 5 节，本仓库同时有
其他改动方在加用例，所以读数只保证"如实照抄本次运行"，不声称与旧基线逐位可比；**0 失败**是本轮的结论）。

⚠️ 本轮**不声称**闭合的：`replaceGeneration` 要不要接产品路径、`/compact` 要不要真正接线、
`projectIncremental`/`getActiveGenerations` 要不要删 —— 三条都是**产品决策**，本轮只登记。
本项目既有的**已点名、本轮未动**的另两条（`MessageActions` 零渲染点、`uiMessageFeedback` 死服务 +
插件面板承诺）也不在本批范围：它们的文件（`src/components/**`、`src/core/ui-plugins/**`）本轮不许改。

## 4. 复现用的一次性脚本（`.preview-shot/`，gitignore）

| 脚本 | 用途 |
| --- | --- |
| `measure-invariant-gaps.js` | 直读 DB 重算"历史缺口"真值（与维护报的数字对照） |
| `drill-data-root-r62.mjs` | 隔离钻取：数据根目录 / 真实目录是否被改动 |
| `ui-walk-r63.mjs`、`ui-walk-r63-verify.js` | 真机逐面板走查 / 修复后逐项复量 |
| `cmp-dbs.mjs`、`verify-round47.js` | 旧库与新库逐 id 比对、水位复核 |

## 5. 第 62 轮（1.16.101 → 1.16.104）的收口记录

出包 4 个（**每个都装了、跑了、真机量过**）：

| 版本 | 这一版关掉的缺口 | 关键实测数字 |
| --- | --- | --- |
| 1.16.101 | 维护期凭据普查（0-c）：改用引擎 `settings.get_all`；`scanned===0` 必须说"未跑成" | 真机 `27 个设置项里命中 2 处` |
| 1.16.102 | 凭据封存（阶段 1）+ **写回闸门** + 字节级残留回收 + 明文回退（此前只有读点、没有写入方） | 库文件 `sk-` **1→0**、WAL `sk-` **27→0**、库 19.51 MB → 18.01 MB；CLI 直读 `apiKey=False / apiKeySealed=True`；渲染侧读到的密钥调 DeepSeek 余额 **HTTP 200 / is_available=true** |
| 1.16.103 | 真机复量抓到的两处界面缺陷：更新提示被重渲染抹掉（改 React state）；小按钮命中区 24×18 → 26×24 | 更新按钮 `T+1.6s` 显示"未发现更新（当前 v1.16.103）…"且**不再消失**；`.market-skill-link-btn` 172 个 **minH 24 / minW 26、两两重叠 0**、可见的 2 个命中测试 **2/2** |
| 1.16.104 | 数据目录台账（第 62 轮清单最后一项） | 真机：首次 `generation=1 / source=standard / targetState=existing`；重启后 mtime **未变**（未重写）+ 日志"数据目录未变化（第 1 代）" |
| 1.16.105 | 旧库凭据清洗（按用户选择"先备份再清洗"）+ 普查不再把密文说成"明文凭据" | 旧库 `sk-×4`+`gho_×3` **7 → 0**（等长替换、长度 11,137,024 不变、`integrity=ok`、逐表行数不变）；备份里仍 4+3；真机维护日志变为 `27 个设置项，未命中**明文**凭据形状；另有 1 处**已加密保存**（codem-settings，不是明文）` |
| 1.16.106 | 清理遗留脚手架（按用户"旧的遗留物就清理"）：删 27 个文件 + 修掉恢复面板"多层"这处假话 | `capabilities/**` 25 文件 + `multi-layer(.ts/-index.ts)` 删除；删前三确认（目录外零 import 说明符 / `provider/` 无反向依赖 / 动态 import 与配置无引用）；删后 **336 文件 / 5830 通过 / 16 跳过 / 0 失败**（vitest 退出码 0）、`tsc` 0、10 道门禁 exit 0（未接线扫描 825 文件）；真机 1.16.106：面板标题「会话恢复」、页面再无 "多层/Multi-layer"、无异常 |

**基线（1.16.106）**：渲染侧 **336 文件 / 5830 通过 / 16 跳过 / 0 失败**（vitest 退出码 0）；`tsc` 0；10 道 audit 门禁 exit 0；
额外审计工具 `check-hot-tables` / `wasm-removal-readiness`（L1–L4 全 0）/ `l1-legacy-engine-dependents` 均 exit 0；
引擎侧 `src-tauri` 53 条 / `codem-db` 85 + 54 条。

### 5.1 尚未处理 / 需用户决定

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 旧库 `codem-db.bin` 里的 `sk-×4`（历史明文）+ `gho_×3` | **已处理（1.16.105，按你选的"先备份再清洗"）** | 原地等长替换为占位符：备份经字节校验（`backup-pre-sanitize-<ts>/`）、长度不变、`integrity=ok`、逐表行数不变、该文件命中 **7→0**。⚠️ 副作用：旧库是"损坏库恢复设置"的来源，清洗后恢复出来的是占位符（需重填）；**不声称**物理不可恢复 |
| 新库里剩下的 3 处 `gho_` | **已定位、判定为会话数据** | 上下文是 `protocol=https host=github.com username=sdcxb password=gho_…`（`git credential fill` 的输出被记进工具结果）；**不是** provider 的 API key（封存管的是"设置里的密钥"） |
| knip 报的"未使用文件"（76 项） | **已分诊并出报告**（1.16.105：`docs/DEAD-CODE-TRIAGE.md`，按你选的"只报告不动代码"） | 一批是**误报**：全局类型增强文件（无需被 import 也生效）、Vite 入口（`pet-main.tsx`）、技能自带脚本（运行期调用）、`stubs/*`（构建期别名）。**不能按 knip 的字面结论直接删**，要逐类判断 |
| `.lo-link-btn` 命中区复量 | **仍未复量** | 该面板里元素计数为 0，需在 library-ops 面板那一轮补读数 |

### 5.2 一次"差点变成假修复"的记录（方法教训）

knip 把 `core/slots/declarations.ts` 与 `core/ui-plugins/slots.ts` 报成未使用文件，两份文件顶部都有 `// @ts-nocheck`，
而注释写着"让插件在编译期就知道有哪些可用的槽位" —— 看上去是**假能力**（`@ts-nocheck` 把声明合并废掉）。
按规矩先做 A/B：写探针（`SlotMap["definitely.not.a.slot"]` 必须报错、`"app.layout" extends keyof SlotMap` 必须为真），
**带/不带 `@ts-nocheck` 各跑一次 `tsc`** —— 两次都报错：`@ts-nocheck` 只抑制**本文件内**的错误报告，
**不影响声明合并**。那句注释是**对的**，差点被我"修"掉一个不存在的问题。
（教训：**类型系统层面的结论也要用探针双向量一次**，不能只看代码形状就下判断。）
