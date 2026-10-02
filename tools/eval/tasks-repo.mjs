/**
 * 第三档任务集 —— **真实仓库档**：在我们自己的代码库上做，测的是"能不能在大工程里找到并修对"。
 *
 * ## 为什么必须要有这一档（前两档都证明了不够）
 *
 * 基线档 DSH **14/14**、编码档 DSH **8/8** —— 两档都 `control-saturated`。
 * 自包含小工程测不出 harness 之间的水平差。用户真正关心的是"写代码/改 bug/调试不弱于 dsh"，
 * 那么任务就必须发生在一个**真实的、大的、有历史的**代码库里：要自己找入口、读懂上下文、
 * 认出"这里为什么这么写"，而不是在一个 30 行的小文件里改一行。
 *
 * ## 怎么做得客观（关键设计）
 *
 * 每个任务 = **把本次会话里已经修好、且判据已经变异自证过的一个修复回退掉**，
 * 然后让被测 agent 只看到"现象"，自己找出来修好。判据就是**我已经写好并变异自证过的那个测试文件**。
 *
 *   工作区 = `git worktree add --detach <tmp> HEAD`（轻量，不拷 node_modules，用 junction 指回主仓库）
 *   造 bug = `git checkout <buggyCommit> -- <revertPaths>`（把实现回退到修复前）
 *   判据   = 先 `git checkout HEAD -- <testFiles>`（**反作弊**：把测试还原，agent 改测试没用），
 *            再 `npx vitest run <testFiles>`
 *
 * 这样做有三个好处：
 * ① **判据是真的** —— 每条都在这轮里跑红过、也变异自证过，不是新写的；
 * ② **反作弊天然** —— 测试从 HEAD 还原，agent 改测试无效；
 * ③ **难度是真的** —— 这才是"我们自己的项目"，也是用户实际用 dsh 在做的事。
 *
 * ## 局限（写清，不藏）
 *
 * · 它只测"给定一个失败判据，能不能找到并修对"，**不测需求理解与设计**。
 * · 每个任务只跑一个测试文件，所以它**不衡量回归影响**（改坏别处不会被扣分）。
 *   要补这一点，可以把判据扩成"相关测试子集全绿" —— 见 §局限的后续项。
 * · `buggyCommit` 是把这次会话的修复回退掉，所以**这些 bug 都是真出现过的**，
 *   但它们是"我们自己的 bug"，不比外部基准更有代表性。
 */

export const REPO_ROOT = "C:/mimo-gui";

/**
 * 每个任务：
 *   prompt      给 agent 的**现象描述**（刻意不提文件名 —— 找入口本身就是被测能力）
 *   revertPaths 从 buggyCommit 回退哪些**实现**文件（造出 bug）
 *   testFiles   判据文件（评分前从 HEAD 还原，反作弊）
 *   buggyCommit 回退的来源提交（= 该修复进入仓库之前的那个提交）
 *   grade       判据命令（在工作区里跑，退出码 0 = 通过）
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
    buggyCommit: "d2f53d0",
    grade: 'npx vitest run src/test/dsh-d8-edit-ambiguity.test.ts',
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
    buggyCommit: "d2f53d0",
    grade: 'npx vitest run src/test/dsh-d10-write-not-executed-is-error.test.ts',
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
    buggyCommit: "d2f53d0",
    grade: 'npx vitest run src/test/dsh-d6-usage-accounting.test.ts',
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
    buggyCommit: "d2f53d0",
    grade: 'npx vitest run src/test/dsh-d11-update-message-preserves-fields.test.ts',
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
    buggyCommit: "86a21be",
    grade: 'npx vitest run src/test/workflow-permission-parity.test.ts',
  },
];

export const CATEGORIES = ["改小 bug", "多文件改动", "跑测试"];

export function validateTaskSet(tasks = TASKS) {
  const problems = [];
  const seen = new Set();
  for (const task of tasks) {
    for (const field of ["id", "category", "title", "prompt", "revertPaths", "testFiles", "buggyCommit", "grade"]) {
      if (task[field] === undefined) problems.push(`${task.id ?? "?"} 缺字段 ${field}`);
    }
    if (seen.has(task.id)) problems.push(`任务 id 重复：${task.id}`);
    seen.add(task.id);
    if (!CATEGORIES.includes(task.category)) problems.push(`${task.id} 的类别不认识：${task.category}`);
    if (!Array.isArray(task.revertPaths) || task.revertPaths.length === 0) problems.push(`${task.id} 没有 revertPaths`);
    if (!Array.isArray(task.testFiles) || task.testFiles.length === 0) problems.push(`${task.id} 没有 testFiles`);
    // 反作弊的前提：判据文件**不能**出现在被回退的实现里
    for (const t of task.testFiles ?? []) {
      if ((task.revertPaths ?? []).includes(t)) problems.push(`${task.id} 把判据文件也回退了 —— 那就不是反作弊了`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(String(task.buggyCommit))) problems.push(`${task.id} 的 buggyCommit 不像提交号`);
  }
  return problems;
}
