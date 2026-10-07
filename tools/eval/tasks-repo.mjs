/**
 * 第三档任务集 —— **真实仓库档**：在我们自己的代码库上做，测的是"能不能在大工程里找到并修对"。
 *
 * ## 为什么必须要有这一档（前两档都证明了不够）
 *
 * 基线档 DSH **14/14**、编码档 DSH **8/8** —— 两档都 `control-saturated`。
 * 自包含小工程测不出 harness 之间的水平差。而真实仓库档 DSH **4/5 → 5/5**（两次之间翻转），
 * 是唯一不饱和的一档。**要测编码水平，就必须用真实仓库任务。**
 *
 * ## 怎么做得客观（关键设计）
 *
 * 每个任务 = **把本次会话里已经修好、且判据已经变异自证过的一个修复回退掉**，
 * 然后让被测 agent 只看到"现象"，自己找出来修好。
 *
 *   工作区 = `git worktree add --detach <tmp> HEAD`（轻量，不拷 node_modules，用 junction 指回主仓库）
 *   造 bug = `git checkout <buggyCommit> -- <revertPaths>`（把实现回退到修复前）
 *   判据   = 先 `git checkout HEAD -- <判据文件 + 回归子集>`（**反作弊**），
 *            再 `npx vitest run <判据文件 + 回归子集>`
 *
 * ## 判据为什么包含 `relatedTests`（这一版新增）
 *
 * 上一版每个任务只跑**一个**测试文件 ⇒ **改坏别处不扣分**，那是这一档最大的局限。
 * 现在每个任务额外带一组**必须保持绿的回归子集**：只把判据改绿、却把同模块的其它行为改坏了，
 * **分数会掉**。这样"修 bug"才不只是"把一条测试弄绿"。
 *
 * ## 局限（写清，不藏）
 *
 * · 回归子集是**手挑的**，不是完整的"全量测试" —— 全量要跑几分钟，做精细排序后续再说。
 * · 它测"给定失败判据，能不能找到并修对"，**不测需求理解与设计**。
 * · `buggyCommit` 是把这次会话的修复回退掉，所以这些 bug 都是**真出现过的**，
 *   但它们是"我们自己的 bug"，不比外部基准更有代表性。
 */

export const REPO_ROOT = "C:/mimo-gui";

/**
 * 每个任务：
 *   prompt       给 agent 的**现象描述**（刻意不提文件名 —— 找入口本身就是被测能力）
 *   revertPaths  从 buggyCommit 回退哪些**实现**文件（造出 bug）
 *   testFiles    判据文件（评分前从 HEAD 还原，反作弊）
 *   relatedTests 必须**保持绿**的回归子集（同一模块的其它判据）—— 改坏别处会扣分
 *   buggyCommit  回退的来源提交（= 该修复进入仓库之前的那个提交）
 */
export const TASKS = [
  {
    id: "repo-01-edit-ambiguity",
    category: "改小 bug",
    title: "模型改重复代码时改错了地方",
    prompt:
      "我在用咱们这个项目改代码的时候发现一个问题：让 agent 改一段在文件里出现多次的代码时，它**改错了地方** —— " +
      "明明我要改的是第 3 处，它改了第 1 处，而且**它还告诉我改成功了**。这个太危险了，改错了还不吭声。\n" +
      "你去查一下是哪里出的问题并修好。**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/tools.ts", "src/core/llm/edit-matchers.ts"],
    testFiles: ["src/test/dsh-d8-edit-ambiguity.test.ts"],
    relatedTests: ["src/test/tool-result-status.test.ts", "src/test/agent-tool-name-integrity.test.ts"],
    buggyCommit: "d2f53d0",
  },
  {
    id: "repo-02-write-false-success",
    category: "改小 bug",
    title: "写文件被拒绝却报成功",
    prompt:
      "有个用户反馈：他在写入确认里选「按我的一次性要求改」，也就是**不让 agent 直接覆盖**，结果 agent 说「已经写好了」，" +
      "可是**文件根本没变**。界面也是绿的成功状态。这种「假成功」必须修掉。\n" +
      "你查一下哪里出的问题并修好。**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/tools.ts"],
    testFiles: ["src/test/dsh-d10-write-not-executed-is-error.test.ts"],
    relatedTests: ["src/test/dsh-d9-multi-edit-partial-failure.test.ts", "src/test/tool-result-status.test.ts"],
    buggyCommit: "d2f53d0",
    /**
     * ★ 第 41 波：**显式声明"回归里本来就有一条红的"** ✓（新字段 ✓，见 `run-repo-arm.mjs --verify-bug-tests` ✓）。
     *
     * 为什么可以接受 ✓（与 repo-03/04 的区别就在这一条 ✓）：
     * 这条红是**题面那个缺陷的同一族** ✓ —— 题面说的是"写文件被拒绝却报成功"✗（**假成功** ✓），
     * 而 D9-1 是"`multi_edit` 三条里有一条失败、却整批报成功"✗ ⇒ **同一个病** ✓，
     * 修好题面那个缺陷时通常**顺手就修掉了** ✓（实测：289 批 run-3 过 ✓、290 批两轮都过 ✓）。
     *
     * ⚠️ 与 `repo-03/04` 的差别是**实测出来的** ✓：那两格的回归红指向**另一个特性** ✗
     * （缓存桶口径 / 会话日志版本校验 ✓）⇒ 那两格收窄了 `revertPaths` ✓，这一格**保留** ✓
     * （它同时是真实的回归网 ✓）。
     */
    relatedRedAtBaseline: {
      "src/test/dsh-d9-multi-edit-partial-failure.test.ts": "同一族（假成功）：multi_edit 部分失败也报成功；修题面那个缺陷时顺手就修（实测两批都能过）",
    },
  },
  {
    id: "repo-03-usage-accounting",
    category: "改小 bug",
    title: "用量统计只记了最后一次调用",
    prompt:
      "用量统计面板的数字**明显偏低**：一个跑了十几次工具调用的任务，账单上只看到很少的输入 token。" +
      "我怀疑是记账的地方只记了最后一轮。另外失败的回合好像**完全没有记录**。\n" +
      "你去查一下并修好，保证一轮任务的总量是**累加**的、失败/中止的回合也留下记录。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/index.ts"],
    testFiles: ["src/test/dsh-d6-usage-accounting.test.ts"],
    relatedTests: ["src/test/dsh-d7-usage-cache-buckets.test.ts", "src/test/usage-normalize.test.ts"],
    buggyCommit: "d2f53d0",
    /**
     * ⚠️ 第 41 波：`revertPaths` **从三个文件收窄到一个** ✗→✓（实测 ✓）。
     *
     * 原来还回退 `token-tracker.ts` 与 `usage-normalize.ts` ✓ —— 而那两个文件里
     * **另有一次更晚的修复**（"缓存桶只信 provider 上报，绝不猜"✓）✗ ⇒
     * 整份文件回退 ⇒ `dsh-d7` / `usage-normalize` 在 **bug 状态下就是红的** ✗ ⇒
     * 计分要求 agent 修一条**题面一个字都没提、且与本题无关**的缺陷 ✗
     * （真机上 agent **正确地**判断为"既有、与本次无关"⇒ 记 0 分 ✗；另一批"顺手修了"⇒ 通过 ✓
     * ⇒ **这一格量的是范围判断的掷硬币，不是题面那个能力** ✗）。
     *
     * 实测（`.preview-shot/_bug-baseline-split.mjs` ✓）：
     * `index.ts` 单文件 ⇒ 判据 **3 条红** ✓、回归 **9 条全绿** ✓；
     * 而 `index.ts + token-tracker.ts` ✗ 与 `index.ts + usage-normalize.ts` ✗ 两种组合回归都还红 ✓
     * ⇒ **必须一起收窄** ✓。
     */
  },
  {
    id: "repo-04-session-update-drops-fields",
    category: "改小 bug",
    title: "更新一次正文会顺带丢掉附件和元数据",
    prompt:
      "用户报告：一段对话里如果某条消息带**附件**，之后这条消息只要被更新过一次（比如流式写完、状态变化），" +
      "**附件就没了**；有时候元数据也没了。重启并重建索引之后也恢复不了，像是被写没了。\n" +
      "你去查一下并修好。**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/storage/message.ts"],
    testFiles: ["src/test/dsh-d11-update-message-preserves-fields.test.ts"],
    relatedTests: ["src/test/dsh-d12-session-log-version.test.ts", "src/test/silent-write-guard.test.ts"],
    buggyCommit: "d2f53d0",
    /**
     * ⚠️ 第 41 波：同上，`revertPaths` **从两个文件收窄到一个** ✗→✓（实测 ✓）。
     *
     * `session-jsonl.ts` 里另有一次更晚的修复（会话日志**格式版本校验** ✓ —— `E_SESSION_LOG_VERSION` ✓），
     * 回退它 ⇒ `dsh-d12` 的 D12-1/2/3 在 **bug 状态下就是红的** ✗ ⇒
     * 题面讲的是"更新消息会丢附件/元数据"✗，一个字都没提版本校验 ✗。
     *
     * 实测：`message.ts` 单文件 ⇒ 判据 **3 条红** ✓、回归 **9 条全绿** ✓。
     */
  },
  {
    id: "repo-05-workflow-bypasses-permission",
    category: "改小 bug",
    title: "有的工具能绕过危险命令检查",
    prompt:
      "安全上有个洞：**危险命令只要包在某个工具里执行，就不会走危险命令检查**，也不会弹写确认。" +
      "我怀疑是那个用来跑编排/脚本的工具没接上闸门（另一个同类工具已经接上了）。\n" +
      "你去核对一下、把缺的那一道闸门补上。**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/workflow-engine.ts"],
    testFiles: ["src/test/workflow-permission-parity.test.ts"],
    relatedTests: ["src/test/pi-p2-run-code-permission-parity.test.ts"],
    buggyCommit: "86a21be",
  },
  {
    id: "repo-06-llm-failure-not-completed",
    category: "改小 bug",
    title: "模型调用失败却报「任务完成」",
    prompt:
      "有个很坑的现象：**接口报错的时候，界面显示的是「任务完成」**。用户的模型名填错了、或者服务端 500，" +
      "那一轮明明什么都没干成，结果被当成成功收尾 —— 委派出去的子任务也会把失败当成功交回父会话。\n" +
      "你去查一下循环是怎么判定「结束」的，把这种情况改成明确的失败。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/agentic-loop.ts"],
    testFiles: ["src/test/dsh-d1-llm-failure-not-completed.test.ts"],
    relatedTests: ["src/test/dsh-d3-abort-not-completed.test.ts"],
    buggyCommit: "d2f53d0",
    /** ★ 第 41 波：同族红（**收场必须如实** ✓）—— 题面讲"失败不许报完成"✗，D3-A 讲"中止不许报完成"✗ ⇒ 同一个病 ✓ */
    relatedRedAtBaseline: {
      "src/test/dsh-d3-abort-not-completed.test.ts": "同一族（收场必须如实）：abort 也要报 aborted；与题面的「失败不许报 completed」同一次修复",
    },
  },
  {
    id: "repo-07-plan-not-in-system-prefix",
    category: "改小 bug",
    title: "每轮都变的东西混进了系统提示，把缓存打掉",
    prompt:
      "成本上有个问题：**同样一个任务，我们这边的 token 消耗比 DSH 高**。我怀疑是请求前缀不稳定 —— " +
      "有些**每一轮都会变**的内容（比如执行计划进行到第几步）被拼进了系统提示里，" +
      "于是服务端的前缀缓存**每轮都失效**，整段历史按全价重算。\n" +
      "你去查一下请求是怎么拼的，把易变内容从**稳定前缀**里挪出去（但要保证它仍然能到达模型）。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/agentic-loop.ts"],
    testFiles: ["src/test/dsh-d5b-plan-prefix-stability.test.ts"],
    relatedTests: ["src/test/dsh-d5-prefix-cache-stability.test.ts"],
    buggyCommit: "86a21be",
  },
  {
    id: "repo-08-truncated-toolcall-executed",
    category: "改小 bug",
    title: "被截断的工具调用还是被执行了",
    prompt:
      "出了个很隐蔽的事故：模型的回复**撞到输出上限被截断**，那一批工具调用的**参数可能是残的**，" +
      "可我们还是**照样执行了**，只在结果后面加了一句「请自行核对完整性」。" +
      "半截的写入会写下一个半截文件并且报成功。\n" +
      "你去查一下：**被输出上限截断的那批调用应当整批不执行**，并给模型一个可操作的重发指引。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/agentic-loop.ts", "src/core/llm/tool-args-guard.ts"],
    testFiles: ["src/test/pi-p1-truncated-toolcall-not-executed.test.ts"],
    relatedTests: ["src/test/tool-args-truncation.test.ts"],
    /**
     * ⚠️ 这里是 `d2f53d0`（**不是** `86a21be`）—— 一个把任务变成"谁都能过"的坑。
     *
     * `86a21be` **正是引入截断守卫的那个提交**（它给 `agentic-loop.ts` 加了
     * `buildTruncatedToolCallError` 的接线，并新增了 `pi-p1` 那条判据）。
     * 所以"把实现回退到 `86a21be`"= 把**修好的版本**装回去：工作区里根本没有这个 bug，
     * 判据一开始就是绿的。
     *
     * 后果实测（第 100 波）：一次真实评测里 agent **一个字符都没改**（`diffChars: 0`），
     * 判据 12/12 全绿 —— 记录上写着"通过"。那 2.07M token 换来的分数毫无意义。
     * 抓到它的是 `node tools/eval/run-repo-arm.mjs --verify-bug-tests`（bug 状态下判据必须红）。
     *
     * 教训：`buggyCommit` 必须是"**该行为还没被修**"的那一版。某个提交顺手修掉了这个 bug 时，
     * 它就不能再当 `buggyCommit` —— 这条判据现在由 `--verify-bug-tests` 强制。
     */
    buggyCommit: "d2f53d0",
  },
  /**
   * ===== 第 101 波：用本仓**最近几次真实修复**再扩 4 个任务 =====
   *
   * 选材标准（都满足才收）：
   *  1. `buggyCommit` = 那次修复的**父提交**（所以"该行为还没被修"是定义上的，不靠猜）；
   *  2. `revertPaths` 只包含那次修复动过的**实现**文件（改动窄 ⇒ 不会顺带回退出别的问题）；
   *  3. 判据是那次修复新增/修改的测试文件（在工作区里存在 = HEAD 版本）；
   *  4. **三重自证都要过**：`--verify-workspace`（历史只有 bug 状态）、
   *     `--verify-bug-tests`（bug 状态下判据必须红）、`reference` 臂（还原实现后必须全绿）。
   *
   * ⚠️ 已知局限（对 8 个老任务同样成立，记在这里免得被当成"新任务的问题"）：
   * 判据文件在工作区里是**可读**的（评分需要它），而这些测试的注释常常写明了根因。
   * 所以这一档测的是"**能不能按判据把修复做对**"，而不是"能不能独立诊断"。
   * 要测诊断，得把判据挪出工作区（评分时再放回去）—— 见交接单 §13.3 的待办。
   */
  {
    id: "repo-09-sandbox-shell-path-leak",
    category: "改小 bug",
    title: "开着沙箱，命令里照样能读到工作区外的文件",
    prompt:
      "开了沙箱模式之后，文件类的工具都老实了（读工作区外面的路径会被拒），" +
      "但**执行命令的那个工具**像是没接上闸门：用 `Get-Content`、`type` 这类命令照样能把工作区外的文件读出来，" +
      "`cd` 到别的目录再干活也没人管。这等于沙箱开了一半。\n" +
      "你去把这条口子补上：**命令里的路径也要按沙箱判定**。注意别把工作区内的正常命令也拦了。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/tool-pipeline.ts"],
    testFiles: ["src/test/sandbox-shell-path-leak.test.ts"],
    relatedTests: ["src/test/sandbox-path.test.ts", "src/test/sandbox-glob-hardening.test.ts"],
    buggyCommit: "e6041cd",
  },
  {
    id: "repo-10-tool-result-value-dropped",
    category: "改小 bug",
    title: "声明了结果契约的工具，一调用就报「你没给 value」",
    prompt:
      "用户报告：`bash`、`read`、`glob`、`grep` 这几个工具**几乎每次调用都失败**，" +
      "界面上给出的原因是 `declared outputSchema but returned no value` —— 可这些工具明明返回了内容，" +
      "而且它们自己声称**给了**结构化的结果值。模型看到这条内部话术之后就放弃这些工具、改用别的路子，" +
      "整个体验断崖式下跌。\n" +
      "你去查一下：工具返回的结构化结果是在**哪一层被丢掉的**，把它补回去。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/agentic-loop.ts", "src/core/llm/types.ts", "src/core/llm/tools.ts"],
    testFiles: ["src/test/output-contract-real-loop.test.ts"],
    relatedTests: ["src/test/tool-contract-pipeline-e2e.test.ts"],
    buggyCommit: "5be439f",
  },
  {
    id: "repo-11-contract-error-not-masked",
    category: "改小 bug",
    title: "失败的原因被一句契约话术顶掉了",
    prompt:
      "用户报告：读一个**不存在的文件**时，模型收到的不是「文件不存在」，而是" +
      "`read declared outputSchema but returned no value` 这种内部话术 —— 真正的原因消失了，" +
      "模型也就没法纠正（它会以为是自己调用方式的问题）。命令类工具报错时也有同样的现象。\n" +
      "你去查一下：**工具自己给出的失败原因为什么会在这条链路上被替换掉**，把它改成" +
      "「失败就如实透传失败原因」，并且让内容型工具的失败被明确地判成失败。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/tool-pipeline.ts", "src/core/llm/tools.ts"],
    testFiles: ["src/test/tool-contract-pipeline-e2e.test.ts"],
    relatedTests: ["src/test/output-contract-real-loop.test.ts"],
    buggyCommit: "2d0852a",
    /** ★ 第 41 波：同族红（**失败原因不许被顶掉** ✓）—— 题面讲"失败原因被契约话术顶掉"✗，OUTCON-3 讲"内容型工具的失败要显式 isError"✗ ⇒ 同一个病 ✓ */
    relatedRedAtBaseline: {
      "src/test/output-contract-real-loop.test.ts": "同一族（失败不许被顶掉/掩盖）：read/glob/grep 的失败路径要显式 isError；与题面同一次修复",
    },
  },
  {
    id: "repo-12-usage-non-completion",
    category: "改小 bug",
    title: "被守卫杀掉/被用户中止的那一轮，还是被记成了成功用量",
    prompt:
      "成本面板的数字对不上：**明明是被停掉的那些轮次**（停滞守卫判定原地打转、用户点了中止、" +
      "上下文溢出、被判定为停滞而收场），在用量统计里却和正常完成一样被算进去，" +
      "于是「成功率」永远虚高、失败的成本也被算成有效产出。\n" +
      "你去查一下：**收场原因是「非完成」时，用量该怎么记**，把这几种情况改成明确的失败口径。" +
      "**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/llm/index.ts"],
    testFiles: ["src/test/usage-non-completion.test.ts"],
    relatedTests: ["src/test/usage-normalize.test.ts", "src/test/dsh-d6-usage-accounting.test.ts"],
    buggyCommit: "30ed631",
  },
];

export const CATEGORIES = ["改小 bug", "多文件改动", "跑测试"];

export function validateTaskSet(tasks = TASKS) {
  const problems = [];
  const seen = new Set();
  for (const task of tasks) {
    for (const field of ["id", "category", "title", "prompt", "revertPaths", "testFiles", "buggyCommit"]) {
      if (task[field] === undefined) problems.push(`${task.id ?? "?"} 缺字段 ${field}`);
    }
    if (seen.has(task.id)) problems.push(`任务 id 重复：${task.id}`);
    seen.add(task.id);
    if (!CATEGORIES.includes(task.category)) problems.push(`${task.id} 的类别不认识：${task.category}`);
    if (!Array.isArray(task.revertPaths) || task.revertPaths.length === 0) problems.push(`${task.id} 没有 revertPaths`);
    if (!Array.isArray(task.testFiles) || task.testFiles.length === 0) problems.push(`${task.id} 没有 testFiles`);
    if (!Array.isArray(task.relatedTests) || task.relatedTests.length === 0) {
      problems.push(`${task.id} 没有 relatedTests —— 那样改坏别处不会被发现`);
    }
    // 反作弊的前提：判据/回归文件**不能**出现在被回退的实现里
    const protectedFiles = [...(task.testFiles ?? []), ...(task.relatedTests ?? [])];
    for (const t of protectedFiles) {
      if ((task.revertPaths ?? []).includes(t)) problems.push(`${task.id} 把判据文件也回退了 —— 那就不是反作弊了`);
    }
    /**
     * ★ 第 41 波：`relatedRedAtBaseline` 的**键必须是本任务的回归文件** ✓。
     * 为什么：它是"这一条在 bug 状态下本来就红，我们接受了"的**声明** ✓ ——
     * 键打错（或指到别的任务的文件）会让那句声明**形同虚设** ✗，
     * 而自证那边只会看到"实测红集合 ≠ 声明集合"✗ ⇒ 报出来的理由是错的 ✓。
     */
    for (const f of Object.keys(task.relatedRedAtBaseline ?? {})) {
      if (!(task.relatedTests ?? []).includes(f)) {
        problems.push(`${task.id} 的 relatedRedAtBaseline 声明了 ${f}，但它不在 relatedTests 里（声明形同虚设）`);
      }
    }
    if (!/^[0-9a-f]{7,40}$/.test(String(task.buggyCommit))) problems.push(`${task.id} 的 buggyCommit 不像提交号`);
  }
  return problems;
}

/** 判据命令：判据文件 + 回归子集**一起**跑，全绿才算通过。 */
export function gradeCommand(task) {
  return `npx vitest run ${[...task.testFiles, ...(task.relatedTests ?? [])].join(" ")}`;
}

/** 评分前要从 HEAD 还原的文件（判据 + 回归子集），防止 agent 改测试。 */
export function filesToRestore(task) {
  return [...task.testFiles, ...(task.relatedTests ?? [])];
}
