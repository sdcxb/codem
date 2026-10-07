# Pi Agent Harness 1.0.4 对标修复计划（第 181 波 · 起于 v1.16.298）

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。

> **对标对象**：<https://github.com/earendil-works/pi>，tag **v1.0.4**（`7c10bd43`，2026-10-05）。
> 本地真身副本：`.preview-shot/_pi-repo`（已 checkout `v1.0.4`，工作区干净）。
> **上游区间**：`v1.0.0..v1.0.4` = **86 个提交 / 292 个文件 / +17233 −4931**。
> **口径**：结论只用 `git show/log/diff/tag` 与读源码得出，**不采信二手文章**。

---

## §0 本轮的两条纪律约束

1. **用户口径**：任务①（找潜在 bug/隐患 → 详细修复计划 → 逐一修复）走仓库纪律
   （判据 → **变异自证** → 真机验证 → `tsc` 0 + 全量测试 → 提交）；
   任务②（Pi 有我们没有的功能/机制）**只给建议，不改代码**。
2. **不重复劳动**：`v1.0.0` 那一轮（2026-10-02，`PI-ALIGNMENT-FIX-PLAN.md`）已经做过
   P-0…P-4，本轮**先核实那批的现状**，再只看 `v1.0.0→v1.0.4` 的新增修复。

### 上一轮的现状核实（避免重复投工）

| 上轮项 | 现状 | 证据 |
|---|---|---|
| P-1 截断的 tool-call 一律不执行 | ✅ **已落地** | `src/test/pi-p1-truncated-toolcall-not-executed.test.ts`（4 条）实测通过 |
| P-2 `run_code` 闸门接回 + 边界说实话 | ✅ **已落地** | `pi-p2-*` + `pi-p2b-*`（16 条）通过 |
| P-2b `workflow` 同一开口 | ✅ **已落地** | `workflow-permission-parity.test.ts`（10 条）通过 |
| P-2 的**根因**（`new Function`） | ✅ **已治根** | `run_code` 已迁到 **Rust `boa` 沙箱**（`src-tauri/src/js_sandbox.rs`），不再 `new Function` |
| P-3 工具失败显式化 | 🟡 具体实例已收口，**`isError` 必填化普查未做** | 见 §3 待办 |
| P-4 成对评测尺子 | ✅ 已在（且比上轮记录更全） | `tools/eval/paired-report.mjs` + `report.ts` 口径；见 §4 |

**为什么 P-2 的"已治根"很重要**：`new Function` 在装好的应用里会被 CSP 拒（无 `unsafe-eval`），
所以上轮的 P-2 修复其实只保住了判据、真机上是另一条路。本轮在 Rust 侧看到的是**真执行路径**。

---

## §1 `v1.0.0 → v1.0.4` 的修复分布（先看规模，再决定投入）

只有 **9 个提交**碰 `packages/ai/src`（调用层），`packages/codemode/**` 只有 **2 个**实质提交。
其余大量改动集中在三块**新东西**上（`packages/env/` 远端执行新包、`packages/durable` 的
watch/read 有界化、Nix flake 与打包），**那三块属于"功能对标"（任务②）而不是"修 bug"**。

真正值得我们照镜子的修复分四类：

| 类别 | 提交 | 一句话 |
|---|---|---|
| **资源无上限** | `319fecb89` | 脚本死循环打印 ⇒ 宿主内存被吃光（沙箱本该隔离，却打死了宿主） |
| **生命周期/进程** | `8c911797c` | 关闭时"还在连接中"的 MCP 连接不会关（transport/进程泄漏） |
| **重试分诊** | `3874b3e98`、`5b6c792b4` | 容量/过载与瞬态传输错误**没被登记** ⇒ 一次抖动 = 整段失败 |
| **截断/一致性** | `cd60a5b99`、`cdf79797b`、`a19c09d9b` | 有界读与全量读必须**逐字节等价**；截断必须带**精确计数**并告诉模型 |
| （改口径，非 bug） | `bde882c74` | 令牌刷新被取消 ⇒ 已轮换的新令牌丢失（"取消一次，账号就坏了"） |

---

## §2 本轮**已修**（判据 + 变异自证 + 结果）

### 修复 1 ｜ MCP 连接生命周期：中途断开/被替换

**对标**：Pi `8c911797c`（#10249）。

**现象（真机可观察）**：`connect()` 里有三个 `await`（spawn → `initialize` 握手 → `tools/list`），
每个都可能秒级。用户在这段时间里点「断开」或删服务器（`MCPRegistry.removeServer` **不 await**
就调 `disconnect`）时：

1. **子进程孤儿** —— `mcp_stdio_connect` 是**先 spawn 再握手**，所以那时 Rust 侧进程已经在跑了；
   旧代码把句柄从 `mcp_processes` 里摘掉却**没人杀** ⇒ 退出 Codem 后 `npx`/`node` 还赖着；
2. **状态自相矛盾** —— `connect()` 的 `await` 返回后继续把 `status = "connected"` 写回
   **那个已经被删掉的**连接对象。

**根因（file:line，改前）**：`src/core/mcp/mcp.ts` `connect()` 的 `await` 之后无条件写
`connection.status = "connected"`；`disconnect()` 只做 `connections.delete(name)`。

**修法**：
- `MCPConnection` 新增 `generation`；`disconnect()` 先把代次 +1、状态置 `disconnected`，
  **再**删条目并杀进程；
- `connect()` 在**每个 `await` 之后**核对"我还是 Map 里那一份、且代次没被加过吗"；
  过期就走 `abandonStaleConnection()`：按"是否被新连接顶替"决定要不要收进程，
  **绝不写回 connected**。

**判据**：`src/test/mcp-lifecycle-race.test.ts` — MCP-L1…L5（含反向对照 L4：正常连接仍成功，
且 `tools/list` 成功之前不许报 connected）。

**变异自证**（6/6 咬住，实测）：

| 变异 | 红点 |
|---|---|
| 去掉"过期连接按已取消结束" | **3 条**（L1/L3/L5）；L5 直接抓到 `expected 'connected' to be 'disconnected'` |
| 断开/顶替时都不收进程 | **3 条**（L1/L2/L5），`expected +0 to be 1` |

**顺带查明的既有缺口（本轮一并修）**：
- `mcp_stdio_disconnect` 原来只 `Child::kill` —— 而 MCP 服务器几乎都是**启动器**
  （`npx` / `cmd.exe /c codegraph.cmd`），真正干活的是它的子进程。已改为复用
  `kill_process_tree`（Windows `taskkill /T /F`，Unix 杀进程组）。
- **退出时根本没有收 MCP 进程的路径**（全仓 `RunEvent` 里没有相关代码）。已新增
  `kill_all_mcp_processes()` 并接进 `RunEvent::ExitRequested` **与** `RunEvent::Exit`（兜底），
  另给 `mcp_stdio_connect` 的 `Command` 加 `kill_on_drop(true)` 作为最后一道网。
  `cargo check` 通过，`cargo test --lib js_sandbox` 17/17。

### 修复 2 ｜ JS 沙箱输出无上限（宿主被自己的沙箱打死）

**对标**：Pi `319fecb89`（#10283）。

**现象**：`for (;;) console.log("x".repeat(1e6))` —— `console.log` 把每一行 `push_str` 进一个
**无界 `String`**；唯一的兜底是"循环迭代上限 1e6"与宿主调用上限，在撞到它们之前内存就被吃光。

**根因**：`src-tauri/src/js_sandbox.rs` 的 `push_to()` 直接 `s.push_str(text)`，没有任何水位线。

**修法**：
- 新增 `MAX_OUTPUT_BYTES = 16 MiB`，**stdout + stderr 合计算账**（只记一边的话，
  脚本交替写两个流就能绕过去）；
- 超限即**中断脚本**并给出可操作文案（`请只打印摘要，大块数据请用工具写进文件`）——
  **刻意不静默截断**（静默截断会让模型以为看到了全部输出，那是本仓库最忌讳的一类缺陷）；
- 把"输出超限"与"循环/宿主调用超预算"**分开报告**（两者的修法不同）；
- 在**唯一的报告出口**做归一化 —— 因为脚本自己的 `try/catch` 会接住那个异常、
  走 guest 错误信封那条路，实测不归一化的话 `budget_exceeded` 仍是 false、给模型看的还是英文原话。

**判据**：`src-tauri/src/js_sandbox.rs::js_sandbox_tests`
（`unbounded_printing_is_stopped_by_output_limit` / `normal_output_is_not_truncated` /
`empty_print_loop_is_also_bounded` / `stderr_counts_towards_the_same_limit`）。

**变异自证**：去掉上限检查 ⇒ `memory allocation of 34359738368 bytes failed`
（**32 GB**，即宿主进程真的被吃光）—— 这是判据有效性的最强证据。

**判据设计上踩到的两个坑（都记档，避免后人重犯）**：
1. `"x".repeat(1024*1024)` **本身就按字符计入 boa 的循环迭代预算**（实测：默认 1e6 预算下它
   直接抛"循环太久"，一个字都没打印）。所以验证**新**防线时必须抬高本次的 `loop_limit`，
   否则量到的是**旧**那道防线。
2. `for(;;) console.log("")` 撞的是**循环迭代上限**（累计输出很小）⇒ 它是"有界性"的判据，
   **不是**输出上限的判据。两条防线各自覆盖一类失控，判据要分清。

### 修复 3 ｜ 重试分诊不认容量/瞬态文案

**对标**：Pi `3874b3e98`（#10278）、`5b6c792b4`（#10379）。

**现象**：供应商常用 **200 或 400** 带回一句"模型忙"，或在连接层抛一个纯文案的传输错误：
`Selected model is at capacity` / `The pending stream has been canceled`
（Node `ERR_HTTP2_STREAM_CANCEL`）。而我们的 `classifyError` **只认 HTTP 状态码**
（429/5xx/529）与少数 `code`/`name` ⇒ 一次本可自愈的抖动被判成**确定性失败**，
整段对话就此结束（用户看到的是"突然报错，重发一次又好了"）。

**根因（file:line，改前）**：`src/core/retry/retry.ts::classifyError` 末尾直接
`return { type: null, isRetryable: false }`，**没有任何文案分诊**。

**修法**：
- 新增两张**有界**文案表：`RETRYABLE_MESSAGE_PATTERNS`（`at capacity` / `overloaded` /
  `high demand` / `pending stream has been canceled` / `ERR_HTTP2_STREAM_CANCEL` …）与
  `NON_RETRYABLE_MESSAGE_PATTERNS`（模型不支持 / 上下文超限 / 401 / 配额…）；
- **确定性错误优先**：先查"不可重试"表，再查"可重试"表 —— 防"模型名里恰好带
  `overloaded`"这类同名巧合被误捞成可重试。

**顺带修掉一处既有缺陷**：`status === 529` 那一支**原来排在 `5xx` 之后 ⇒ 永远不可达**，
`RetryableErrorType` 里的 `capacity` **从来没被产出过**（用户看到的仍可重试，
所以不是行为 bug，但它让"容量类"无法被单独识别）。顺序调换后与 Pi 1.0.4 对齐。

**判据**：`src/test/retry-classification-capacity.test.ts` — RTC-1…RTC-6
（含两条反向对照：确定性错误不许被捞成可重试；不可重试优先于可重试）。

**变异自证**（3/3 咬住，实测）：摘掉 `at capacity` 文案 ⇒ RTC-1 红；
去掉"不可重试优先" ⇒ RTC-4 红；529 顺序调回 ⇒ RTC-5 红。

---

## §3 审计结论：**同形态隐患在 Codem 的排查结果**（这一节才是"找潜在 bug"的产出）

把每一路取证给的"通用隐患类"当作**镜面尺**回照本仓库，逐条给结论：

| Pi 的隐患类 | Codem 现状 | 结论 |
|---|---|---|
| 沙箱内建可被脚本 patch ⇒ 桥序列化崩 | 我们的 guest 在 **Rust boa** 里，桥只走 `JSON.stringify/parse` 且宿主侧不用 guest 的对象 | **不成立**（架构不同） |
| 脚本输出无上限 | **成立** | ✅ 本轮已修（修复 2） |
| `read` 没声明结构化输出 ⇒ 静默降级 | 我们无此鸭子分派（工具返回形状固定） | **不成立** |
| 迟绑定路径（安装被更新/删除后仍按磁盘路径解析） | 我们的 `run_code` 资产是**编译进二进制**的，不在运行时解析外部路径 | **不成立** |
| 落盘产物权限过宽 / 符号链接劫持 | 我们的 `run_code` 产物走 `write` 工具（受保护路径 + 覆盖确认），**没有"临时产物"通道** | **不成立**（但也说明我们没有该功能，见 §4） |
| **隐藏 ≠ 移除**（隐藏的工具仍出现在提示词规则里） | 我们的工具可见性只有"注册/未注册"一种状态，**没有"隐藏但可调用"这一层** | **不成立**（缺的是功能，不是缺陷） |
| **断开后不等 in-flight**（close 提前返回） | **成立**（MCP） | ✅ 本轮已修（修复 1） |
| 进程退出时资源没关 | **成立**（MCP 子进程、且只杀直接子进程） | ✅ 本轮已修（修复 1） |
| 重试文案白名单漏登记瞬态错误 | **成立** | ✅ 本轮已修（修复 3） |
| 令牌刷新被取消 ⇒ 已轮换的新令牌丢失 | AA 路径**不缓存令牌、服务端也不轮换 refresh token**（`aa_connector.rs`：每次现取、`AA_NO_TOKEN_CACHE`） | **不成立**（如实排除，不假修） |
| 有界读 vs 全量读**行号错位** | 我们的 `read_file_lines` 是**单次扫描**同时算 `total_lines` 与截断（`src-tauri/src/lib.rs:606-635`）；`offset`/`limit` 是 Rust `usize` ⇒ NaN/小数/负数**在类型层被拒** | **不成立**（比 Pi 的旧实现更安全） |
| 截断没告诉模型 | 我们的 read 输出带 `[lines: a-b of N]` 与分页提示 | **已具备**（可再强化，见待办 T-3） |
| BOM 在分块边界被吞 | 我们的行读取走 `BufReader::lines()`（按字节切、不经过流式 BOM 解码） | **不成立** |
| Windows 监视器持有目录句柄 ⇒ 阻碍父目录重命名 | 我们用 git 轮询比对（`file-change-tracker.ts`），**不用 `fs.watch`** | **不成立** |
| 把"环境消失/正常终止"当成崩溃 | 我们已有 `previous-run-unclean` 与崩溃标记区分（第 71 轮） | **已具备** |
| `{...defaults, ...partial}` 被显式 `undefined` 覆盖 | 需逐个配置点排查 | 🟡 **待办 T-2** |
| 工具失败靠文本启发式判断 | 我们 P-3 只做了具体实例 | 🟡 **待办 T-1** |
| 会话身份（provider sessionId）没落盘 ⇒ 缓存冷启动 | 我们靠**稳定前缀**（date 尾置）拿缓存命中，机制不同 | 🟡 **观察**（§4 有建议） |

### 本轮没能做完的（如实登记，不假装关闭）

| # | 待办 | 为什么值得做 | 大致的判据形状 |
|---|---|---|---|
| T-1 | **`isError` 必填化普查**（P-3 残留） | 工具失败靠文本启发式 ⇒ 模型可能把失败当成功 | 全生产源码扫描：每个 `ToolResult` 的失败分支必须显式带 `isError`/`status`；变异：抽掉一处必红 |
| T-2 | **`{...defaults, ...partial}` 覆盖默认值**的普查 | 显式 `undefined` 会静默清掉默认值（Pi `cd60a5b99` 修的正是这个） | 找到所有"部分配置展开合并"点，逐点补 `??` 并加一条用例 |
| T-3 | **截断诊断强化**：把 `[lines: a-b of N]` 升级为"精确 lines/bytes + 续读 offset" | 我们对齐了 Pi 的一半（有提示），但**没有字节计数**；模型无法判断"还差多少" | 断言完整拼接串（不是子串），含 dropped lines/bytes |
| T-4 | **有界读的差分测试** | 我们现在只有手写用例；Pi 用"整文件算法做参照"跑 1600 组（含 NaN/分数/负数/超界/故意劈开的多字节） | 把 `read_file_lines` 的旧实现抄成 `referenceRead()`，`expect(actual).toEqual(expected)` |

---

## §3.5 本轮**第二轮**：待办 T-1…T-4 的推进结果

用户口径是"按你的建议推进"（T-2 → T-1 → T-3 → T-4）。**逐条如实交代**：

### T-2 ✅ 已完成（`{...defaults, ...partial}` 的显式 `undefined` 覆盖）

- **新增共享 helper** `mergeDefaults(defaults, partial)`（`src/core/storage/settings.ts`）：
  **跳过显式 `undefined`**、保留显式 `null`、不做深合并。约束刻意用 `T extends object`
  （不是 `Record<string, unknown>`）—— 后者会让普通 `interface`
  **无法传参**（实测 TS2740）。
- **落地点 7 处**（全是"从持久化兑现**部分**配置"的形态）：`knowledge/indexer.ts`、
  `knowledge/retriever.ts`、`computer-use/computer-use.ts`、`environment/worktree-manager.ts`、
  `heartbeat/heartbeat.ts`、`storage/sync-engine.ts`、`plugins/library-ops/store.ts`
  （最后一个是**门禁自己扫出来的漏网点**：它读 localStorage，原来靠后面的"边界收敛"逐字段兜底，
  但整块仍依赖默认值）。
- **判据** `src/test/partial-config-defaults.test.ts` 5 条：MD-1（复现 Pi 的原始算例，
  **先证明朴素展开确实会坏**）、MD-2（`null` 必须保留）、MD-3（`0`/`""`/`false` 不许被当"没设置"）、
  MD-4（空 partial 返回副本、非同一引用）、MD-5（**结构门禁**：全生产源码零该形状）。
- **变异 2/2 咬住**：helper 不再跳过 `undefined` ⇒ MD-1 红；把一处改回朴素展开 ⇒ MD-5 红。
- **判据自身的坑（记档）**：MD-5 第一版**没剥注释**，被 `mergeDefaults` 文档里的反例绊倒
  （抓到 `settings.ts:136/139` 两处假阳）。已改成"剥注释后再扫"。
- **测试桩缺件**：`sync-engine.test.ts` 用 `vi.mock` 桩了整个 settings 模块，
  新导出的 `mergeDefaults` 不在桩里 ⇒ 8 条红（`No "mergeDefaults" export is defined`）。
  按仓库规矩**补桩而不是绕开**（桩里写真语义的实现）。
  ⚠️ 全仓还有 26 个 test 文件 mock 了该模块，但**只有真正走到改动点的那个会红** ——
  已用全量测试确认（见下）。

### T-1 🟡 **尝试后按纪律撤回**（这是本轮最重要的一条发现，不是"没做"）

**发现**：`ToolExecuteResult.isError` 是**可选**的，省略时由 `classifyToolResult` **推断**；
而推断表里有一份 `CONTENT_TOOLS`（`read`/`grep`/`glob`/`web_fetch`/`load_skill`…）
**明确不推断**（理由正当：它们的输出是"数据"）。于是这些工具**真的失败**时会落到 `completed`
—— 一个**静默缺口**。

**测量**：把 `isError` 改成必填后 `tsc` 报 **187 处 / 33 文件**：
153 处"缺字段" + **34 处"返回类型与 `execute` 签名不匹配"的执行点**（此前编译期完全看不见）。

**为什么不能机械做（这条是撤回的依据）**：

1. 153 处里 **123 处的 `output` 是模板串/表达式**（`` output: `Error: ${e.message}` ``）
   ⇒ **无法静态判定成败**；
2. 更关键：本仓库的**成功路径一律省略 `isError`**，而现行推断会对它们**按文本判**
   （首行 `Error:` ⇒ 失败）。把 `isError` 填 `false` 会**改掉**这条语义（原本判失败的变成显式成功），
   填 `true` 会把成功误标成失败 —— **两种都是看不见的行为改变**。

**我实际做了什么**：先写脚本机械化（第一版**错了**：没剥字符串/模板串 ⇒ 把 `isError` 插进了
`` `${…}` `` 里的字符串内部，`tsc` 报 TS1109；用 `git checkout` 精确还原 21 个受害文件、
保留 T-2 成果）。修正版剥串后只敢机械插 **30/153**。据此判定"**不能机械化**"，
遂**撤回类型改动**、只落地判据把缺口钉住：

- **判据** `tool-result-status.test.ts` 的 `TRS-1…4`：显式声明优先；**内容型工具真的失败且未声明时
  会被判成 completed（缺口的形状）**；非内容型工具仍按前缀推断；`isError` **保持可选**
  （谁想"顺手改成必填"，TRS-4 会红 —— 那是**有意的路障**）。
- **缺口与修法**写进了 `tools.ts` 里 `isError` 字段的说明（下一轮动手的人先读那里）。

### T-3 ✅ 已完成（截断诊断给出精确 lines/chars）

- Rust `ReadFileLinesResult` 新增 `dropped_lines` / `dropped_chars`，
  与 `text` **出自同一次遍历**（零额外 IO、一定自洽）；
- 主体抽成同步 `read_file_lines_impl`（与 `read_text_window_impl` 同惯例）⇒ 判据能直接驱动；
- 前端提示从 `offset + Math.ceil(text.length / 80) - 1`（**猜**结束行号）改成
  `showing lines {offset}-{endLine} of {total}; {N} lines / {M} chars not shown; ...`；
- **顺带修掉一个老缺口**：被 `max_chars` 截断时原来直接 `break` ⇒ 连 `total_lines`
  都停在截断处（模型看到"共 2 行"而文件有几百行）。现在照常数完。
- **判据** 4 条（Rust）：计数对全量参照**逐条相符**、恰好读满时 `has_more=false`、
  `max_chars` 截断仍统计全量、行号随 `offset` 对齐。
- **变异 1/1 咬住**（offset 分支不计数 ⇒ `tail: 丢弃行数` 红）。
- **判据自身的坑（记档，第一版假绿）**：最早的样例每行只有 **1 个字符**、且期望值是用
  **同一套代数**推出来的（`total - kept.len()`）—— 那是**恒等式**，实现漏统计时两边一起变，
  **变异不咬**。修法：用**长度不等**的行 + 期望值**独立硬编码**。

### T-4 ✅ 已完成（对"全量参照算法"的差分测试）

- 就地保留一份朴素参照实现（整个文件 `split('\n')` → 取区间 → 加行号 → 数总计/丢弃），
  与生产实现**逐字段比对**；8 种内容 × 5 种 offset × 4 种 limit = **160 组**，
  覆盖多字节中文/emoji、5000 字符超长行、CRLF、以/不以换行结尾、空文件、offset 超界、
  `offset=0`、`limit=0`。
- **差分当场咬出两个真实契约边界**（这正是它的价值）：
  1. **空文件的 `total_lines`**：参照按 `split('\n')` 得 1，生产得 **0** ⇒
     确认"空文件 = 0 行"才是契约（行是"有内容的行"）；
  2. **CRLF 的字符计数**：参照把 `\r` 算进去了，生产走 `BufRead::lines()` 会归一 ⇒
     确认"按**行内容**计（不含行尾 `\r`）"才是契约。
- **变异 2/2 咬住**：行号从 0 起 ⇒ 返回文本红；丢弃行数漏算 1 ⇒ 丢弃行数红。

---


> 用户口径：**「不要太复杂、不要让用户面对看不懂的机制。」**
> 所以"它很好但我们不该做"是合法且常常正确的结论。下面把**用户能感知的收益**与
> **内部复杂度**分开写，最后给「做 / 不做 / 观察」。

### 4.1 `packages/env/` —— 远端执行环境（SSH + 自带 Rust daemon）｜**建议：观察（暂不做）**

- **它是什么**：把 agent 的文件/命令/监视操作搬到**另一台机器**上跑（通常经 SSH），
  在远端跑一个自带的小 Rust daemon，用 stdin/stdout 定长帧协议通信；本地用
  `RemoteExecutionEnv` 实现同一个 `ExecutionEnv` 接口。
- **解决什么**：想在 GPU 机 / 远端服务器 / Termux 上编译跑测试时，不必让用户自己 ssh 手敲，
  也不必把整个 agent（含凭据）装到远端。
- **证据**：`packages/env/src/ssh.ts:72-120`（一整套保守的 ssh 选项 + `--` 防参数注入）、
  `:370-375`（远端落点按 sha256 命名，避免版本冲突）、`docs/protocol.md:12-35`（帧格式、
  单帧 ≤16 MiB）、`daemon/src/main.rs:1-41`（5s ping / 30s 静默自杀 / 杀自己起的进程组）。
- **代价：大**。5 个 TS 源文件（`ssh.ts` 24KB、`remote-env.ts` **34KB**）+ Rust daemon
  13 个源文件（`watch.rs` 27.7KB、`sys/windows.rs` **25KB**）+ 4 份文档 + 5 个测试；
  **前置依赖是"先有 `ExecutionEnv` 抽象层"**（我们的 `file-api.ts` 是函数式直调，没有这一层）。
- **不做的后果**：用户要跨机工作只能自己 ssh；**但本产品的定位是 Windows 桌面
  AI 编程助手，用户的工作区本来就在本机**。
- **⚠️ 一个关键事实**：这个包在 Pi 自己的仓库里**没有任何消费者**
  （除它自己与构建配置外无引用）。也就是说**上游自己都还没把它接进产品**。
- **建议：观察**。等上游把它接进 CLI 并证明有用，我们再评估；现在做等于替上游趟一条
  他自己都没走的路，而且要先把我们的文件层重构成 `ExecutionEnv`（那是伤筋动骨的重构）。

### 4.2 `FileSystem.watch` 一等 API（含 Windows 用轮询）｜**建议：不做**

- **它是什么**：把"目录/文件变了"做成 API，事件只有 `{paths}` / `{overflow}` / `{error}` 三种，
  且**返回即"覆盖已建立"**；`mode`（native/polling）由环境决定并**上报给调用方**。
- **和"轮询有没有变"的区别**：能回答**哪些路径变了**（不必全量重扫）；有 `overflow`
  这个**明确的不确定态**（"这段时间覆盖不可信，请全量重扫"）；Identity 绑 inode 而不是路径。
- **代价：中**（`node-watch.ts` 439 行 + 一致性测试），但**风险实在**：
  Windows 上原生 watcher 会让父目录无法重命名 ⇒ 只能**默认 2 秒轮询**，
  而轮询在大仓库里是周期性全量 `readdir + lstat`（上限 10000 目录）。
- **不做的后果**：我们用 git 状态比对（`file-change-tracker.ts`）已经覆盖了"本轮改了什么"
  这个真实需求；**没有"实时看到外部改动"这个需求**。
- **⚠️ 同样的事实**：上游 `docs/spec.md:2860` 明写 **"Durable itself never calls it"**。
- **建议：不做**。引入它会把"每 2 秒扫全工作区"的 CPU/磁盘开销装进一个桌面应用，
  而收益（实时感知外部改动）我们的用户场景里并不存在。

### 4.3 有界读 + 精确省略计数（`scanLines` / `skipped`）｜**建议：部分做（见 T-3/T-4）**

- **它是什么**：read 只读"文件头（判图片）+ 一次行扫描 + 要展示的那几行"，不再整文件进内存；
  远端 shell 可以把"调用方注定丢弃的输出"**不传**，但必须带上**精确计数**
  （`{bytes, newlines, endsWithNewline}`），且只能在"其后还跟着超过窗口至少一字节/一行"时省略。
- **收益（用户能感知）**：读 GB 级日志不再卡死/爆内存（我们已有 `read_file_lines` 分页，
  但**是整文件逐行扫**，超大文件仍会慢）；截断提示能给出精确的"还差多少"。
- **代价：中**；**前置依赖**是"可寻址的二进制读取接口（pread）"。
- **建议**：**T-3/T-4 做**（截断诊断强化 + 差分测试，纯本地、判据强）；
  **"省略传输"不做**（我们是本地文件系统，没有 SSH 带宽问题 ⇒ 收益为零）。

### 4.4 MCP OAuth 2.1 + resources 工具｜**建议：观察（先问用户）**

- **它是什么**：MCP 客户端自带 OAuth 子集（发现 / PKCE / 动态注册 / CIMD / 刷新 /
  401 自动重认证 / `insufficient_scope` 权限升级）；resources 三件套把
  `resources/list|templates|read` 暴露成模型可调用的工具。
- **解决什么**：OAuth 不解决 ⇒ 只能连**无认证或静态 token** 的远端 MCP 服务器，token 过期
  就得手工重贴；resources 不解决 ⇒ 服务器通过 resources 暴露的只读数据（文档/schema/日志）
  完全看不见（工具描述原文 `Prefer resources over web search when possible`）。
- **⚠️ 事实更正**：`resources` 三件套**在 v1.0.0 就已存在**（区间内只改 15 行）；
  OAuth 也是既有。1.0.4 的新增只有两处：`application_type`（OIDC 服务器默认把客户端当
  `web`，从而**拒绝 http 环回重定向 URI** ⇒ 登录直接 `invalid_redirect_uri` 失败）
  与回调多路径精确匹配（RFC 9700 §4.4.2.2）。
- **代价：大**（OAuth 单独 ~50KB 源码 + 22KB 测试；resources 339 行 + UI 渲染）。
- **建议：观察 + 先问用户**。决定性的一个问题是：**用户实际要连的 MCP 服务器里，
  有没有需要 OAuth 登录的？** 如果只有 stdio 本地服务（如 codegraph/zvec），
  这个成本换不来可感知收益。**反过来，`application_type` 那条经验值得记住**：
  "缺省字段被对端按另一语义补齐"是互操作里的通用坑。

### 4.5 codemode `image()` 产物落临时文件并回报路径｜**建议：做（小）**

- **它是什么**：脚本 `image(...)` 展示图片时，除了把图给模型看，**还把字节写进临时文件**，
  并在图片前插一条文本项给出路径（`[Image saved to <path> (image/png, 12.3KB)]`）。
- **解决什么**：模型能"看"到图却**拿不到字节**（脚本不能写文件、`write` 只收文本）⇒
  下一回合无法复制/移动/用其他工具处理它，只能重新生成（重传 base64 还吃上下文 token）。
- **代价：小**（新 helper 34 行 + 调用点改造）；**且它的实现细节值得照抄**：
  ①`flag: "wx"`（**独占创建**，不跟随别人放的符号链接）+ `mode: 0o600`（输出可能含私有数据）；
  ②同一张图**只存一次**（按内容去重）；③**写盘失败不丢结果**，把失败写进标签（fail-soft + 标注）；
  ④**先截断后落盘**，否则路径标签会被截断掉。
- **不做的后果**：我们的 `run_code` 目前**没有 `image()` 通道**，所以现在"没有可感知的损失"；
  但如果将来给它加图片输出，**必须**同时把这四件事做对。
- **建议：做**（作为"如果我们加图片输出"的规格先记下来）；单独为它开工的优先级**低于** T-1/T-2。

### 4.6 按思考档位的采样参数（`samplingParamsByThinkingLevel`）｜**建议：观察**

- **它是什么**：同一模型在不同 thinking level 用不同采样参数（如高 effort 下 temperature 更低）。
- **代价：小**；**但有一个语义坑值得记住**：三级合并 `{...model, ...档位, ...请求}` 中，
  **显式的 `undefined` 也会覆盖** ⇒ 若某档位表把键写成 `undefined` 表示"该档不设此参数"，
  会**清掉**模型默认值（Pi 自己也没为这个语义写测试）。
- **建议：观察**。我们已有 `reasoningEffort` 贯通，但"按档位调温度"没有真实需求证据。

---

## §5 结论

1. **`v1.0.0→v1.0.4` 里真正值得照镜子的只有四类隐患**，其中三类在 Codem **成立且已修**
   （MCP 生命周期、沙箱输出上限、重试分诊），第四类（截断一致性）我们的实现**比 Pi 的旧实现
   更安全**（单次扫描 + 类型层拒绝非法参数）。
2. **`packages/env/` 与 `FileSystem.watch` 这两块最大的新东西，上游自己都还没接进产品**
   （`pi-env` 无消费者、`watch` 明写 "Durable itself never calls it"）⇒ **这两块不建议跟**。
3. **任务②的净建议**：**只做 §4.5（小、规格清晰）**，其余**观察**
   （都有"上游自己没用"或"我们没有该需求"的硬理由）。
4. **本轮如实留下的待办**：T-1（`isError` 必填化）、T-2（`??` 逐字段默认值）、
   T-3（截断诊断精确计数）、T-4（有界读差分测试）。**没有假装关闭**。
