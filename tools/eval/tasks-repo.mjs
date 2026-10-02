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
    revertPaths: ["src/core/llm/index.ts", "src/core/llm/token-tracker.ts", "src/core/llm/usage-normalize.ts"],
    testFiles: ["src/test/dsh-d6-usage-accounting.test.ts"],
    relatedTests: ["src/test/dsh-d7-usage-cache-buckets.test.ts", "src/test/usage-normalize.test.ts"],
    buggyCommit: "d2f53d0",
  },
  {
    id: "repo-04-session-update-drops-fields",
    category: "改小 bug",
    title: "更新一次正文会顺带丢掉附件和元数据",
    prompt:
      "用户报告：一段对话里如果某条消息带**附件**，之后这条消息只要被更新过一次（比如流式写完、状态变化），" +
      "**附件就没了**；有时候元数据也没了。重启并重建索引之后也恢复不了，像是被写没了。\n" +
      "你去查一下并修好。**不要改 test/ 或 src/test/ 下的任何测试文件。**",
    revertPaths: ["src/core/storage/message.ts", "src/core/storage/session-jsonl.ts"],
    testFiles: ["src/test/dsh-d11-update-message-preserves-fields.test.ts"],
    relatedTests: ["src/test/dsh-d12-session-log-version.test.ts", "src/test/silent-write-guard.test.ts"],
    buggyCommit: "d2f53d0",
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
    buggyCommit: "86a21be",
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
