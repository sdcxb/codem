# 测量方案：把「水平与 token 消耗不差于 DSH」变成可判真假

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。

> 创建：2026-10-02（v1.16.222 之后）。对应交接单 §6 任务 2 的验收标准，用户选了 **A 案**：
> **先建尺子，再做对标** —— 「冻结 10–20 个真实编码任务集 + 补我方 token 埋点 + 定 DSH 对照跑法，
> 先拿到基线数字，再谈差异」。

---

## §0 现状（**已更正**，先说结论）

| 项 | 状态 |
|---|---|
| 计量可信（D6/D7） | ✅ 已修（见 `docs/DSH-ALIGNMENT-FIX-PLAN.md`） |
| 成对评测器 | ✅ `tools/eval/paired-report.mjs`（19 条自测 + **5/5 变异咬住**） |
| 冻结任务集 | ✅ 14 个任务 / 6 个覆盖口径（`tools/eval/tasks.mjs`） |
| 单臂执行器 | ✅ `tools/eval/run-arm.mjs` |
| 链路自证（判据真的会区分对错） | ✅ `tools/eval/pipeline.selftest.mjs`（11 条）+ **4/4 变异咬住** |
| **control 臂（DSH）driver** | ✅ **已跑通** —— `tools/eval/drivers/dsh-driver.mjs` 调 `dsh --profile headless --json` |
| **control 臂真实基线** | ✅ **已拿到：DSH 14/14 通过，2,463,850 tokens，其中 90.8% 是缓存读**（见 §5b） |
| **treatment 臂（Codem）driver** | ❌ **没做** —— 引擎活在 WebView 里，没有无头入口（唯一还缺的一块） |
| **成对结论** | ❌ **没有** —— 缺 treatment 臂，评测器正确地**拒绝**下结论 |

---

## §0b 我在第一版里写错的那件事（必须记档）

第一版 §4 我写过：「DSH 的 `dsh-headless`/`dsh-cmdline` **都没有声明 `bin`**，装机目录里也**没有任何 `dsh` 可执行文件**，
我们的 `package.json` 也没有 `bin` ⇒ **两条真实臂的 driver 都没做**」。用户当场质疑：
「你没有 dsh 源代码吗？我电脑里装了 dsh，现在咱们用的不就是 dsh 吗？」

**用户是对的，我错了。** 事实是：

| 我当时查了什么 | 当时的结论 | 实际 |
|---|---|---|
| `dsh-headless` / `dsh-cmdline` 的 `bin` | 空 | 对，但这两个不是入口 |
| `@deepseek-ai/dsh`（**主包**）的 `bin` | **我没查** | `bin: { dsh: "lib/bin.js" }` —— **有 CLI** |
| 装机 app 根目录里的 `dsh*` | 没有 | 对，但 `dsh.cmd` 在 `%APPDATA%\DSH Desktop\host-commands\...`，**不在 app 目录里**，而它在 PATH 上 |
| `dsh --help` | **我没跑** | 直接写着 `dsh headless "run the tests"` —— **回答一个任务、打印结果、退出** |

**错在同一个形状上**：查了两个子包和一处目录就下了"不存在"的结论，**中间那一步没有走到底**。
这与我这一轮反复记录的那几次（`.tmp`+rename、`apiMessages[0]`、变异脚本报错行）是**同一种错**。
教训：**"我没找到" ≠ "不存在"** —— 声称一个东西不存在，必须说清**在哪里找过、找的是什么形式的入口**。

---

## §1 验收标准拆成三个可判真假的量

用户原话：「**当前的项目移植到咱们平台开发，同样用 DS 模型的情况下，水平和 token 消耗都不差于 dsh。**」

| 原话里的词 | 变成什么 | 怎么测 |
|---|---|---|
| 「水平」 | **任务通过率**（客观判据：退出码） | 冻结任务集上每条臂的成对通过率；lift = treatment − control |
| 「token 消耗」 | **四个桶 + 总量**（input / output / cacheRead / cacheWrite） | 每条记录读实测用量；成对均值差 |
| 「不差于」 | 在**成对样本完整**且**重复次数 ≥ 2** 时才允许下结论 | `verdict()` 会把不满足的情况直接判为"不能下结论" |

**「同样用 DS 模型」是硬约束**。DSH 那一侧的实际配置（读 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 得来）：

- `provider: deepseek-account`
- `model: deepseek-flash`
- `reasoningEffort: high`
- `defaultPreset: danger-full-access`（sandbox `danger-full-access` / approval `never`）

所以基线记录里的 `model` 写的就是 **`deepseek-flash`**；treatment 臂必须用同一个模型，否则对比不成立。

---

## §2 冻结任务集（14 个 / 6 个覆盖口径）

文件：`tools/eval/tasks.mjs`。任务是**数据**，改动要走 diff；`validateTaskSet()` 会检查字段齐全、id 不重复、
**六个覆盖口径各至少有一个任务**、以及**每个任务都带参考解**。

| id | 口径 | 判据 |
|---|---|---|
| `read-01-which-functions-mutate` | 读代码 | `node verify-answer.mjs` |
| `bug-01-paginate-off-by-one` | 改小 bug | `node --test` |
| `bug-02-debounce-drops-trailing` | 改小 bug | `node --test` |
| `bug-03-duration-missing-hour` | 改小 bug | `node --test` |
| `bug-04-swallowed-rejection` | 改小 bug | `node --test` |
| `feat-01-chunk` | 加功能 | `node --test` |
| `feat-02-format-bytes` | 加功能 | `node --test` |
| `feat-03-retry-backoff` | 加功能 | `node --test` |
| `feat-04-csv-quoted-commas` | 加功能 | `node --test` |
| `multi-01-rename-across-files` | 多文件改动 | `node --test` |
| `multi-02-add-field-end-to-end` | 多文件改动 | `node --test` |
| `test-01-make-failing-suite-pass` | 跑测试 | `node --test` |
| `test-02-unicode-codepoint-window` | 跑测试 | `node --test` |
| `refactor-01-extract-validation` | 重构 | `node --test` |

**判据一律是行为判据**（跑测试、比输出、退出码），没有一条是"源码里有没有某个词"。

---

## §3 怎么跑（命令逐条，已实测）

```powershell
# control 臂（DSH）—— 已跑通
node tools/eval/run-arm.mjs --arm control --model deepseek-flash --runs 1 `
  --out .preview-shot/eval-records-control.jsonl `
  --agent-cmd "node C:\mimo-gui\tools\eval\drivers\dsh-driver.mjs"

# treatment 臂（Codem）—— 还缺 driver（见 §5）
node tools/eval/run-arm.mjs --arm treatment --model deepseek-flash --runs 1 `
  --out .preview-shot/eval-records-treatment.jsonl `
  --agent-cmd "node C:\mimo-gui\tools\eval\drivers\codem-driver.mjs"

# 出成对报告
node tools/eval/run-arm.mjs --report --out .preview-shot/eval-records-all.jsonl
```

`--agent-cmd` 必须写**绝对路径**：它在任务工作区（临时目录）里执行，相对路径会被解析到工作区里。

---

## §4 DSH 侧（control）—— **已经通了**，不需要写引擎

`dsh --profile headless` 就是一个无头任务执行器（`dsh --help` 原话：
「answer one task, print the result, and exit」）。`--json` 输出**逐行 JSON 事件**，其中带真实的四桶用量。

实测的事件契约（`tools/eval/drivers/dsh-driver.mjs` 依赖它）：

```
{"type":"session","sessionId":"session-…","cwd":"…"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6154,"outputTokens":138,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":6292}}
{"type":"tool_call","callId":"call_…","tool":"read","input":{"file_path":"src/a.js"}}
{"type":"final","text":"…"}
```

**一次任务的用量 = 所有 `step_end` 的四个桶各自求和**。注意每个 step 的 `totalTokens` 是**该步**的
`input+output+cacheRead+cacheWrite`，**不是累计值** —— 实测 step1 `6292 = 6154+138`、
step2 `6978 = 322+384+6272`。求和后得到的是整轮的真实计费口径。

driver 刻意**不算钱**：我不掌握真实计费口径，凭空写 `estimatedCostUsd` 就是往尺子里掺假数。
宁可让这个指标"不可用"（评测器会拒绝据此下结论），也不编。

---

## §5 treatment 侧（Codem）—— **这是唯一还缺的一块**

我们这边**没有无头入口**：`package.json` 没有 `bin`，引擎逻辑活在 **WebView 的 TypeScript** 里，
靠 Tauri IPC 调 Rust 的文件/执行能力（交接单 §1 第 2 条）。两条路：

1. **加一个 headless 入口**（推荐）：把 `src/core/llm` 的引擎接到 Node 侧的文件/执行适配器上
   （即把 `file-api` 换成 Node 实现），跑完把 `LoopResult.usage` 的四桶写进 `.arm-usage.json`。
   **这一条同时解决三件事**：拿到数字、让引擎脱离桌面可被独立测试、把 D6/D7 修好的计量真正用起来。
   注意：现有测试已经在 Node 里驱动真实 `AgenticLoop`（`setStoragePort(createFakeStoragePort())` + 假 provider），
   所以这条路是"接线"而不是"从零造引擎"。
2. **用装机版 + CDP 驱动**：在真实应用里发一条消息、等回合结束、从「用量统计」页读用量。
   好处是"验的就是用户跑的东西"；代价是需要一个机器可读的"回合结束 + 用量"出口（现在只有 UI），
   且要把应用指到任务工作区。

两条都需要**用你的 API 额度**（每个任务 × 每条臂 × 每次重复都是一轮真实 LLM 调用）。
这一段我没有擅自开始 —— 见 §8 的待决事项。

---

## §5b control 臂的真实基线（**已拿到**，2026-10-02）

`deepseek-flash`，`--runs 1`，14 个任务，工作区是各自全新的临时目录。

| 任务 | 结果 | total | input | output | cacheRead | 工具调用 | 秒 |
|---|---|---|---|---|---|---|---|
| read-01-which-functions-mutate | passed | 19,694 | 6,459 | 307 | 12,928 | 3 | 4.7 |
| bug-01-paginate-off-by-one | passed | 234,321 | 12,192 | 5,041 | 217,088 | 27 | 89.3 |
| bug-02-debounce-drops-trailing | passed | 159,076 | 10,206 | 4,358 | 144,512 | 19 | 218.1 |
| bug-03-duration-missing-hour | passed | 215,659 | 12,544 | 7,019 | 196,096 | 23 | 76.9 |
| bug-04-swallowed-rejection | passed | 122,666 | 9,656 | 3,570 | 109,440 | 17 | 78.5 |
| feat-01-chunk | passed | 89,499 | 8,171 | 1,712 | 79,616 | 15 | 19.6 |
| feat-02-format-bytes | passed | 171,059 | 10,146 | 4,497 | 156,416 | 26 | 35.7 |
| feat-03-retry-backoff | passed | 177,624 | 10,391 | 5,441 | 161,792 | 24 | 57.7 |
| feat-04-csv-quoted-commas | passed | 166,432 | 9,968 | 4,400 | 152,064 | 23 | 34.0 |
| multi-01-rename-across-files | passed | 196,206 | 11,411 | 4,315 | 180,480 | 32 | 74.1 |
| multi-02-add-field-end-to-end | passed | 170,613 | 10,775 | 6,238 | 153,600 | 22 | 91.1 |
| test-01-make-failing-suite-pass | passed | 257,540 | 17,297 | 7,667 | 232,576 | 31 | 84.7 |
| test-02-unicode-codepoint-window | passed | 300,023 | 13,015 | 8,864 | 278,144 | 29 | 94.2 |
| refactor-01-extract-validation | passed | 183,438 | 11,595 | 8,259 | 163,584 | 26 | 66.0 |
| **合计** | **14/14** | **2,463,850** | **153,826** | **71,688** | **2,238,336** | **317** | **≈1024** |

### 这份基线说出的四件事

1. **DSH 在这个任务集上是 14/14。** 也就是这一档任务**测不出水平差异** —— 评测器自己把它标成了
   `control-saturated`（control 通过率 = 1 时的旗标）。**想让"水平不差于"这句话有意义，任务集必须更难**
   （见 §7 第 1 条与 §8 第 3 步）。
2. **token 量的 90.8% 是缓存读**（2,238,336 / 2,463,850）。真正的"新输入"只有 153,826。
   这直接说明：**要比 token 消耗，比的其实是缓存命中率** —— 而不是模型读了多少字符。
3. **这正好回证了 D1/D5/D5b 那几条修复的价值**：如果请求前缀每轮都变（时间戳、计划段混在前缀里），
   这一栏 2.24M 的缓存读会全部塌成全价输入。**修前缀稳定性不是洁癖，它是这张表里最大的一栏。**
4. **任务之间差 15 倍**（19,694 → 300,023）。所以报"平均"时必须报**成对**的，不能只报一个总数 ——
   否则任务集里换一个任务就能让结论翻转。这正是成对评测器存在的理由。

评测器对这份记录的输出（**它正确地拒绝下结论**）：

```
Pass rate  withheld because pairs are blocked
    Tokens  n/a (no pair reported this metric)
Flags: control-saturated, blocked-pairs, insufficient-repetition, headline-withheld
还不能下结论：有成对样本被阻塞 —— 缺数据不等于 0，先补齐再谈结论
```

---

## §5c 编码档（第二档）的实测结论 —— **两档都饱和，这是个重要发现**

用户澄清重点之后，我专门做了第二档（`tools/eval/tasks-coding.mjs`，8 个"根因不在症状处 / 一个根因三处失败 /
丢唤醒 / 只砍尾就够不到最新上下文"这类刻意做难的任务）。自证：noop 臂 **8/8 全红**、参考解臂 **8/8 全绿**（5/5 检查通过）。

**然后 DSH 跑它：8/8 全过。** 两档对比：

| | 基线档（14 任务） | 编码档（8 任务） |
|---|---|---|
| DSH 通过率 | **14/14** | **8/8** |
| total tokens | 2,463,850 | 2,212,833 |
| 每任务 total 中位数 | 177,624 | **274,884** |
| 每任务工具调用 中位数 | 24 | **33** |
| 最大 | 300,023 | 431,211 |

**结论（对"能不能评估编码水平"这个问题是决定性的）**：

1. **自包含任务测不出 harness 之间的水平差** —— 无论我做多难，`deepseek-flash` + DSH 都 100% 通过。
   评测器对两档都报 `control-saturated`（这是它该做的）。
2. **成本/轮次维度是有区分度的**：编码档中位数比基线档高 **55%**（274,884 vs 177,624）、
   工具调用高 **37%**（33 vs 24）。所以"同样做对，谁花的代价更小"这一栏**可以用**。
3. **要测"水平"，任务必须换成真实仓库那一档**（大代码库、跨几十个文件、需求有歧义、要自己找入口），
   而不是继续在自包含小工程里加难度。**这是下一步该做的，不是继续加难自包含任务。**

### treatment 臂（Codem）跑不起来的**确切**原因（以及我为什么没有硬来）

- DeepSeek 的 key 在 Codem 里是**密封存储**的（读 `%APPDATA%\com.codem.app\codem-db-rust.bin` 可见
  `"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKeySealed":"dsh1:0100…"`），
  外部进程拿不到；我不会去逆向用户的凭据库 —— 对一个安全敏感的平台那是错的选择。
- 引擎活在 **WebView** 里：Rust 侧 77 个命令里**没有任何**能跑一轮 agent 的命令
  （只有 `run` / `storage_invoke` / `truncate_utf8` 这类基础设施）。
- 应用**没有**把 store 或调试钩子挂到 `window` 上（只有 Tauri 自己的 `__TAURI__`），
  UI 也**没有**给聊天输入框/发送按钮稳定的 `data-testid` ⇒ 用 CDP 驱动 UI 会非常脆。

**正当且推荐的路（也是产品能力升级，不只是测试便利）**：给应用加一个**无头入口**，
把引擎接到 Node/可编程宿主上，让它能"收一个 prompt、跑完、把四桶用量交出来"。
好处有三：能测、引擎可脱离桌面被独立测试、以及**可被 CI/脚本调用**（这是顶级 agent 平台该有的能力）。
落点建议：`src/core/llm` 已经能在 Node 里被驱动（现有测试就是这么干的：`setStoragePort(createFakeStoragePort())`
+ 假 provider），所以这是**接线**，不是重造引擎。

---

## §5d 打通 treatment 臂的**具体配方**（已把卡点定位到可直接执行的程度）

用户口径：**模型调用全都配好了，deepseek-flash 两边都能直接用**。所以卡点从来不是密钥，而是
**没有任何程序化入口能让 Codem 的引擎跑一个任务**。下面是查证到的事实与可执行步骤。

### 已查证的事实（都不是推测）

| 事实 | 证据 |
|---|---|
| 引擎在 WebView，Rust 侧没有能跑一轮 agent 的命令 | `src-tauri/src/*.rs` 里 77 个命令，与 agent/turn 相关的只有 `run` / `storage_invoke` / `truncate_utf8` |
| 应用**没有**把 store / 调试钩子挂到 window | 全仓只有 `(window as any).__TAURI__`，没有 `window.__codem*` |
| 工作目录来自 `useProjectStore().currentProject?.path`，并 `setGlobalCwd(...)` | `App.tsx:418,436` |
| **「上次打开的项目」是持久化的** ⇒ 重启后会自动恢复该项目 | `App.tsx:979,993` 的 `writeLastProjectId(...)`；`:810` 的注释说明启动时会恢复 |
| 密钥是密封的（外部拿不到） | DB 里 `"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKeySealed":"dsh1:0100…"` |
| **Node 24 的 `node:sqlite` 可用** ⇒ 外部能读写应用数据库 | 实测 `require('node:sqlite').DatabaseSync` 可用 |

### 配方 A：不改产品，用「数据库 + CDP」驱动（最快能拿到数字）

1. 给任务工作区在 `projects` 表建一行（path = 临时工作区），并把 `lastProjectId` 指到它 —— 用 `node:sqlite` 写。
2. **重启应用**（启动时会恢复该项目 ⇒ cwd 就是任务工作区）。启动前设
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`。
3. 用 CDP 把 prompt 写进聊天输入框（用 `HTMLTextAreaElement.prototype.value` 的 native setter +
   `dispatchEvent(new Event('input',{bubbles:true}))`，与 `.preview-shot/_verify-219.mjs` 同一手法），再点发送。
4. 轮询"流式结束"（找"停止"按钮消失 / 助手消息落库），再用 `node:sqlite` 读最新一条 usage 记录
   （字段形如 `model/provider/inputTokens/outputTokens/cacheReadTokens/cost`，D6 修好之后每轮恰好一条），
   写成 `<ws>/.arm-usage.json`，交给 `run-arm.mjs` 当 `--agent-cmd`。

**风险**：第 3 步依赖 DOM 结构（**聊天输入框没有稳定 `data-testid`**，只有 `messages-loading/unavailable`），
所以这条路脆；UI 一改就断。

### 配方 B（推荐，且是产品能力升级）：加一个无头入口

让引擎能被脚本/CI 调用：「收一个 prompt + 一个 cwd，跑完，输出四桶用量」。它同时解决三件事：
**能测**、**引擎可脱离桌面被独立测试**、**平台可被脚本化调用**（顶级 agent 平台该有的能力）。
落点是**接线而不是重造**：现有测试已经在 Node 里驱动真实 `AgenticLoop`
（`setStoragePort(createFakeStoragePort())` + 假 provider，见 `src/test/` 多处），
缺的只是把 `file-api` 换成 Node 适配器（或者做成应用内的一条 Tauri 命令，让它用 Rust 侧已解封的凭据）。

**建议先做配方 B**：配方 A 能最快出数，但脆、且对产品没有沉淀；B 一次投入长期可用。

---

## §6 为什么可以相信这把尺子（已做的自证，可复跑）

```powershell
npm run eval:selftest           # 成对评测器本体：19/19
npm run eval:pipeline           # 整条链路：11/11
npm run eval:pipeline:mutation  # 链路自测会不会红：4/4 咬住
```

`npm run eval:pipeline` 跑两个**桩臂**（什么都不做 / 抄参考解），**真实走 `--agent-cmd` 那条路**，断言：

| 断言 | 说明 |
|---|---|
| 什么都不做的臂 **14/14 全 FAILED** | **判据确实在区分对错**（整套东西的地基） |
| 抄参考解的臂 **14/14 全 PASSED** | 判据在正确解上会亮绿 |
| 通过率 0 → 1，lift = 1.0，成对完整时才允许发布头部结论 | 报告算得对 |
| 两侧都上报用量时 token 指标可用、方向正确 | 正值 = 我方更贵 |
| **不写用量文件时记录里根本没有 token 字段** | 「没上报」≠「0」 |
| **计量没接通时，即使 lift = 1.0，`verdict` 也拒绝下结论** | 防"拿假数对比实测" |
| 一侧缺用量的对 ⇒ `eligiblePairs=0 / meanDelta=null`，渲染写 `n/a` | 缺数据不当 0 |
| agent 跑超时 ⇒ `errored`，通过率算 `null` 而不是 0 | 「没跑起来」≠「跑了没做对」 |

---

## §7 本方案**不**衡量什么（不说清就会被误读）

1. **这一档任务测不出"水平"** —— DSH 14/14（§5b 第 1 条）。要测水平必须加**更难**的任务
   （真实仓库里定位问题、跨几十个文件的改动、有歧义的需求）。现在这一档能测的是**成本与链路**。
2. **不衡量大仓库定位能力**：任务是自包含小工程（可复现、无网络、判据确定）。
3. **重构类的判据是软的**：`refactor-01` 只判「行为不变 + 要求的出口存在」，**不判"真的没有重复代码"**。
4. **不衡量主观质量**（命名、可读性、解释是否到位）。
5. **不衡量人工纠偏次数**（需要人工标注流程，本轮没有）。
6. **没有成本数字**：我刻意不编 `estimatedCostUsd`（§4）。要比钱需要接入真实计费口径。

---

## §8 下一步

| 序 | 做什么 | 为什么排这个位置 |
|---|---|---|
| 1 | **treatment driver**：给引擎加 headless 入口（`file-api` → Node 适配器），四桶写进 `.arm-usage.json` | 唯一还缺的一块；它同时让引擎可脱离桌面被独立测试 |
| 2 | 两条臂各跑 `--runs 3`，出第一份**成对**报告 | 这才叫"先拿到基线数字"完成 |
| 3 | 加**更难**的任务档（真实仓库的小 bug、跨文件改动） | 修 §7 第 1 条：现在这一档对 DSH 是饱和的 |
| 4 | 接入真实计费口径，才有"钱"这一栏 | 修 §7 第 6 条 |
| 5 | 人工纠偏记录流程 | 修 §7 第 5 条 |

**待用户决定**：第 1 步要改产品（新增一个无头入口），第 2 步要用你的 API 额度
（14 任务 × 2 臂 × 3 次 ≈ 84 轮真实任务；control 侧单轮一次已实测 ≈ 2.46M tokens / 14 任务 ≈ 176k tokens/任务）。
