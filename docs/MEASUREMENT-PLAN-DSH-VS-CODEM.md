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

## §0 一句话现状（先说结论，别让人误读）

**尺子建好了，而且已经证明它会区分对错。但还没有任何数字。**

| 项 | 状态 |
|---|---|
| 计量可信（D6/D7） | ✅ 已修（见 `docs/DSH-ALIGNMENT-FIX-PLAN.md`） |
| 成对评测器 | ✅ `tools/eval/paired-report.mjs`（19 条自测 + **5/5 变异咬住**） |
| 冻结任务集 | ✅ 14 个任务 / 6 个覆盖口径（`tools/eval/tasks.mjs`） |
| 单臂执行器 | ✅ `tools/eval/run-arm.mjs` |
| 链路自证（判据真的会区分对错） | ✅ `tools/eval/pipeline.selftest.mjs`（11 条）+ **4/4 变异咬住** |
| **两条真实臂的 driver** | ❌ **没做**（原因见 §4，这是剩下的主要工程） |
| **基线数字** | ❌ **没有** —— 所以**本文件不主张"已经不差于 dsh"** |

---

## §1 验收标准拆成三个可判真假的量

用户原话：「**当前的项目移植到咱们平台开发，同样用 DS 模型的情况下，水平和 token 消耗都不差于 dsh。**」

| 原话里的词 | 变成什么 | 怎么测 |
|---|---|---|
| 「水平」 | **任务通过率**（客观判据：退出码） | 冻结任务集上每条臂的成对通过率；lift = treatment − control |
| 「token 消耗」 | **四个桶 + 总量**（input / output / cacheRead / cacheWrite） | 每条记录读实测用量；成对均值差 |
| 「不差于」 | 在**成对样本完整**且**重复次数 ≥ 2** 时才允许下结论 | `verdict()` 会把不满足的情况直接判为"不能下结论" |

**「同样用 DS 模型」是硬约束**：两条臂必须写**同一个** `--model` 值。本方案里它是 `run-arm.mjs` 的必填参数，
不填直接拒绝运行 —— 免得跑出一堆"模型不同"的对比。

---

## §2 冻结任务集（14 个 / 6 个覆盖口径）

文件：`tools/eval/tasks.mjs`。任务是**数据**，改动要走 diff；`validateTaskSet()` 会检查字段齐全、id 不重复、
**六个覆盖口径各至少有一个任务**、以及**每个任务都带参考解**。

| id | 口径 | 要做什么 | 判据 |
|---|---|---|---|
| `read-01-which-functions-mutate` | 读代码 | 读两个文件，判断哪几个导出函数有副作用，写进 `ANSWER.md` | `node verify-answer.mjs` |
| `bug-01-paginate-off-by-one` | 改小 bug | 整除时页数多算一页 | `node --test` |
| `bug-02-debounce-drops-trailing` | 改小 bug | 等待期内的重复触发被直接丢掉（尾调用永不执行） | `node --test` |
| `bug-03-duration-missing-hour` | 改小 bug | 时长解析不认 `h` | `node --test` |
| `bug-04-swallowed-rejection` | 改小 bug | 读失败被吞成 `undefined`，分不清"没有数据"与"读失败" | `node --test` |
| `feat-01-chunk` | 加功能 | 实现 `chunk(array, size)` | `node --test` |
| `feat-02-format-bytes` | 加功能 | 实现 1024 进制的人类可读字节数 | `node --test` |
| `feat-03-retry-backoff` | 加功能 | 实现带退避上限的重试（sleep 注入） | `node --test` |
| `feat-04-csv-quoted-commas` | 加功能 | CSV 行解析要处理引号里的逗号 | `node --test` |
| `multi-01-rename-across-files` | 多文件改动 | 改名并更新所有调用点（含测试） | `node --test` |
| `multi-02-add-field-end-to-end` | 多文件改动 | 新字段贯通「写入 → 序列化 → 读回」 | `node --test` |
| `test-01-make-failing-suite-pass` | 跑测试 | 让已存在的失败套件变绿（**不许改测试**） | `node --test` |
| `test-02-unicode-codepoint-window` | 跑测试 | 按码点而不是 UTF-16 单元切窗口 | `node --test` |
| `refactor-01-extract-validation` | 重构 | 把两处重复校验抽成一个函数，行为不变 | `node --test` |

**判据一律是行为判据**（跑测试、比输出、退出码），没有一条是"源码里有没有某个词" ——
本仓库被源码文本断言咬过多次（见 `docs/DSH-ALIGNMENT-FIX-PLAN.md` §5）。

---

## §3 怎么跑（命令逐条）

单臂执行器 `tools/eval/run-arm.mjs` 的契约：agent 命令在工作区里执行，拿到
`EVAL_TASK_ID` / `EVAL_TASK_PROMPT` / `EVAL_WORKSPACE` / `EVAL_MODEL` / `EVAL_RUN_NUMBER` / `EVAL_ARM`；
命令**可选**地写 `<ws>/.arm-usage.json` 把实测用量交回来。

```powershell
# 1) 对照臂（DSH）。--agent-cmd 换成 DSH 的 driver（见 §4）
node tools/eval/run-arm.mjs --arm control --model deepseek-chat `
  --agent-cmd "node tools/eval/drivers/dsh-driver.mjs" --runs 2 --out .preview-shot/eval-records.jsonl

# 2) 处理臂（Codem）。同一个 --model
node tools/eval/run-arm.mjs --arm treatment --model deepseek-chat `
  --agent-cmd "node tools/eval/drivers/codem-driver.mjs" --runs 2 --out .preview-shot/eval-records.jsonl

# 3) 出成对报告（不跑任务，只读记录）
node tools/eval/run-arm.mjs --report --out .preview-shot/eval-records.jsonl
```

**一条纪律**：`--runs` 建议 ≥ 2。`--runs 1` 时报告会带 `insufficient-repetition` 并且 `verdict` **拒绝下结论**
（"一次重复不足以说明稳定性"，这条是从 Pi 的 `packages/evals` 学来的）。

---

## §4 两条臂的 driver：**这就是还没做的那部分**（诚实清单）

我核对了事实，不是推测：

| 臂 | 现状 | 证据 |
|---|---|---|
| **control（DSH）** | 有 `@deepseek-ai/dsh-headless` 与 `@deepseek-ai/dsh-cmdline` 两个包，但**都没有声明 `bin`** —— 它们是可编程 bundle，不是命令行程序；装机目录里也**没有任何 `dsh` 可执行文件/`.cmd` shim** | `dsh-headless/package.json`、`dsh-cmdline/package.json` 的 `bin` 均为空；`Get-ChildItem "C:\Program Files\DSH Desktop\resources\app" -File` 无 `dsh*` / `*.cmd` |
| **treatment（Codem）** | 我们的 `package.json` **没有 `bin`**，仓库里也没有 headless 入口。引擎逻辑活在 **WebView 的 TypeScript** 里，靠 Tauri IPC 调 Rust 的文件/执行能力（交接单 §1 第 2 条） | `package.json` 的 `bin` 为空；`src/core/llm/index.ts` 是引擎入口，但其能力依赖 `src-tauri` 的命令 |

**所以"先拿到基线数字"还差两段工程，各自有两条路**：

**control（DSH）** —— 二选一：
1. **包一层 headless**：按 `packages/bundle/headless` 的形状起 DSH 的 headless 组合，把「收到 prompt → 跑完 → 报用量」包成 `dsh-driver.mjs`。
   （它已经是 DSH 自己支持的形态，代价应在"接线"而不是"改造"。）
2. 用 DSH Desktop 的 UI 驱动（CDP）—— 可行但脆，且容易把"UI 等待时间"混进 `totalMs`。

**treatment（Codem）** —— 二选一：
1. **加一个 headless 入口**：把 `src/core/llm` 的引擎接到 Node 侧的文件/执行适配器上（即把 `file-api` 换成 Node 实现），
   跑完输出 `LoopResult.usage` 写进 `.arm-usage.json`。**这是干净的一条，也是长期最有用的一条**
   （它同时会让引擎可被独立测试 —— 也就是 Pi 那三个钩子带来的好处，见 `docs/PI-ALIGNMENT-FIX-PLAN.md` §1）。
2. 用**装机版 + CDP** 驱动：在真实应用里发一条消息、等回合结束、从 `cost-tracker` 读用量。
   好处是"验的就是用户跑的东西"；代价是需要一个可机器读的"回合结束 + 用量"出口（现在只有 UI）。

**我的建议**：先做 **treatment 的路线 1**。因为它同时解决三件事：拿到数字、让引擎脱离桌面可测、
把 D6/D7 修好的计量真正用起来。control 侧先做**路线 1**（DSH 本来就是为 headless 设计的）。

**在两条 driver 接通之前，本方案给不出任何对比数字** —— 这一点不模糊。

---

## §5 为什么可以相信这把尺子（本轮已做的自证）

一个"评测器"如果对「什么都不做」和「做对了」给出同样的结果，它的所有数字都是假的。
所以本轮专门做了这件事，并且它是**可复跑的判据**，不是声明：

```powershell
npm run eval:selftest           # 成对评测器本体：19/19
npm run eval:pipeline           # 整条链路：11/11
npm run eval:pipeline:mutation  # 链路自测会不会红：4/4 咬住
```

`npm run eval:pipeline` 做的是：跑两个**桩臂**（`stubs/noop-agent.mjs` 什么都不做、`stubs/reference-solver.mjs` 抄参考解），
**真实走 `--agent-cmd` 那条路**（不是绕过执行器直接写文件），然后断言：

| 断言 | 说明 |
|---|---|
| 什么都不做的臂 **14/14 全 FAILED** | **判据确实在区分对错**（这条是整套东西的地基） |
| 抄参考解的臂 **14/14 全 PASSED** | 判据在正确解上会亮绿 |
| 通过率 0 → 1，lift = 1.0，成对完整时允许发布头部结论 | 报告算得对 |
| 两侧都上报用量时 token 指标可用、方向正确 | 正值 = 我方更贵 |
| **不写用量文件时记录里根本没有 token 字段** | 「没上报」≠「0」 |
| **计量没接通时，即使 lift = 1.0，`verdict` 也拒绝下结论** | 防"拿假数对比实测" |
| 一侧缺用量的对 ⇒ `eligiblePairs=0 / meanDelta=null`，渲染写 `n/a` | 缺数据不当 0 |
| agent 跑超时 ⇒ `errored`，通过率算 `null` 而不是 0 | 「没跑起来」≠「跑了没做对」 |

`npm run eval:pipeline:mutation` 会逐条改坏关键行并确认自测**变红**（4/4 咬住）：
① 把某个任务的判据换成恒成功 ⇒「什么都不做必须全红」变红；
② 把唯一的「读代码」任务改类别 ⇒ 覆盖口径断言变红；
③ 把「没上报用量」填成 0 ⇒ 纪律 2 断言变红；
④ 把 `errored` 并进 `failed` ⇒ 纪律 3 断言变红。

### 本轮我在这一步自己犯的错（记档）

- **第一版任务集有真问题，是被自测抓出来的**：`bug-02` 的"有 bug 的初始代码"**本来就通过测试** ——
  也就是说那个任务在测空气。自测的「什么都不做的臂必须全红」当场判红，我才发现。
  **这正是"判据必须会红"这条规矩的价值：它不仅管产品代码，也管尺子自己。**
- 第一版还**声称为六个覆盖口径，实际只写了五个**（「读代码」一个任务都没有）—— 同样是自测抓的。
- 造「跑超时」这条断言时，我先用 `process.kill(SIGTERM)`，**不成立**：`shell: true` 时直接子进程是 shell，
  它被杀掉后自己返回非零码，于是走到"判据失败"而不是"没跑起来"。改成**真的超时**才对。
- 顺带观察到一件与产品 D4 **同形**的事：超时把 shell 杀掉之后，真正的子进程**可能还活着**并占着工作目录
  （清理时报 `EPERM`）。这在 Windows 上是常态，也是 D4「超时只放弃等待、不杀进程树」的同一个根。

---

## §6 本方案**不**衡量什么（不说清就会被误读）

1. **不衡量大仓库定位能力**。任务集是**自包含小工程**（可复现、无网络、判据确定），
   它主要衡量**链路与成本**。真实仓库那一档（改我们自己的代码、跨几十个文件）要另加一层，现在没有。
2. **重构类的判据是软的**。`refactor-01` 只判「行为不变 + 要求的出口存在」，**不判"真的没有重复代码"**。
   所以重构类的分数不能当强证据。
3. **不衡量主观质量**（命名、可读性、解释是否到位）。判据全是机器可读的，散文里的好坏它看不见。
4. **不衡量人工纠偏次数**。交接单建议记录「是否需要人工纠偏」，但那需要人工标注流程，本轮没有。
   现在的替代物只有 `errored` 与失败率。
5. **没有 DSH 侧的对照数据**（§4）。所以**现在无法回答"是不是不差于 dsh"**。

---

## §7 下一步（按优先级）

| 序 | 做什么 | 为什么排这个位置 |
|---|---|---|
| 1 | **treatment driver**：给引擎加 headless 入口（把 `file-api` 换成 Node 适配器），产出 `.arm-usage.json` | 它是拿到任何数字的前置；且同时让引擎可被独立测试 |
| 2 | **control driver**：按 `packages/bundle/headless` 起 DSH headless，包成 `--agent-cmd` | 没有它就没有对照 |
| 3 | 两条 driver 各跑 `--runs 3`，出第一份成对报告 | **这才叫"先拿到基线数字"** |
| 4 | 把真实仓库档的任务加进任务集（改自己仓库的小 bug） | 补 §6 第 1 条的缺口 |
| 5 | 人工纠偏记录流程 | 补 §6 第 4 条的缺口 |
