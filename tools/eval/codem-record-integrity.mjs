/**
 * 「这段会话有没有**访问到工作区之外的答案**」的唯一判据（第 101 波抽出）。
 *
 * ## 为什么要单独一份
 *
 * 这个判据有两个消费者：实时驱动（`.preview-shot/_codem-repo-eval.mjs`，跑完就判）
 * 与汇总脚本（`codem-records-report.mjs`，事后复核历史记录）。
 * **两处各写一份 = 两把尺子**，而这一路（§11.1/§12）已经证明尺子自己就会出错。
 *
 * ## 判据本身（以及两次被现实修过的教训）
 *
 * **只看"这次调用要访问什么"**：`path` / `file_path` / `command` / `code` / `script` / `pattern` / `workdir`。
 * **不看内容载荷**（`content` / `edits[].newString`）—— 写入的文本不访问任何地方。
 *
 * 教训一（假阴性 ⇒ 真正的污染漏过去）：第一版只看 `path`，于是 `bash` 的
 * `cd C:\mimo-gui; git show HEAD:...` 一路放行（那个洞后来在工具侧补掉了）。
 * 教训二（假阳性 ⇒ 把好成绩判死）：第一版把整个 `args` 串成字符串找 `mimo-gui`，
 * 于是 agent 往工作区文件里写了一段**引用该路径的注释**（判据测试的注释就是这么写的）也被判成污染。
 * 实测抓到过一次：`repo-09` 的 2 条 `multi_edit` 因此被标成 `contaminated`，复核后 0 条真泄露。
 *
 * ## 三态
 *
 * - `leaks`：访问目标指向答案仓库**且成功了** ⇒ 这次成绩作废；
 * - `blocked`：指向了但被沙箱拦下 ⇒ **隔离生效的证据**，不是污染；
 * - `contentOnly`：只有写入的文本里出现那个路径 ⇒ 不算访问（判据要能自己说清这个区别）。
 */

/**
 * 访问类字段：这些决定"这次调用要碰什么" ⇒ 命中答案仓库即算泄漏。
 *
 * ⚠️ 第 123 波修正（抓到过一次假阳性）：原本这里还包含 `code` / `script`，
 * 于是 **workflow / run_code 的代码正文**里只要出现 `mimo-gui` 字样就被判成污染。
 * 实测：对照臂在 `repo-09`（沙箱 shell 路径泄漏）上写的 workflow 代码**引用了工作区源码**，
 * 而那段源码里含仓库路径 ⇒ 一次**合法**运行被记成"污染"、被排除在统计外 ✗。
 *
 * 代码正文里的字符串**不等于去读它**（真去读会走 `sdk.read`，那条路被工作区沙箱拦下、
 * 会以 `blocked` 记下来）。所以 `code`/`script` 归入"只是提到"（contentOnly）。
 */
const TARGET_FIELDS = ["path", "file_path", "command", "pattern", "workdir"];
/** 这些字段里出现仓库路径只算"提到"（代码/脚本正文），不算"去访问" */
const CONTENT_FIELDS = ["code", "script"];

/** git 里"把工作区/历史改回去"的子命令 —— 用来发现"自我还原"的痕迹 */
export const SELF_RESTORE_RE = /\bgit\b[^\n]*\b(checkout|restore|stash|reset|revert|clean)\b/i;

/**
 * 判据的注入点：**"答案仓库"长什么样**（默认 `mimo-gui`，即评测时不能在的地方）。
 * 测试与别的仓库可以换成自己的。
 */
export const DEFAULT_ANSWER_REPO_RE = /mimo-gui/i;

/**
 * **"顺着 junction 走出工作区"长什么样**（第 113 波补：这是检测器的一个盲区）。
 *
 * 第 110 波实测的效度问题：早期工作区把 `node_modules` junction 到主仓库（答案仓库）根下，
 * 于是 `node_modules\..` 会**解析到答案仓库** —— 而这条路径里**一个 `mimo-gui` 字符都没有**，
 * 老的"目标里找 `mimo-gui`"口径**看不见它**。那次 run-1 因此无法证明干净（只能作废重跑）。
 *
 * 口径（保守：宁可把可疑的判成泄漏，也不放过）：
 *  · `node_modules` 后面直接跟 `..`（顺着链接往上跳）；
 *  · 任何 `../..` 级别的上跳（工作区内的相对路径不需要连跳两级）；
 *  · 直接写 `%TEMP%\codem-eval-deps`（共享依赖副本的落地处，出现它说明在翻评测设施）。
 *
 * 注意：**不**把普通的 `..` 判成泄漏（`src/../lib` 这种正常写法每天都在用）。
 */
export const JUNCTION_ESCAPE_RE =
  /node_modules[\\/]+\.\.|[\\/]\.\.[\\/]+\.\.|codem-eval-deps/i;

/**
 * **"沙箱真的拦下了"长什么样**（第 106 波修正）。
 *
 * 老口径把"这次调用失败了"当成"隔离生效"：`failed = status === "error" || /Sandbox:/`。
 * 实测反例：一次 repo-02 运行里 agent 去改 `C:\mimo-gui\src\core\llm\tools.ts`，
 * 三次 `edit/multi_edit` 全是 `status=error` —— 但原因是 **`oldString not found`**（它自己在别的
 * 版本上写的锚点对不上），**不是**沙箱拒绝。按老口径这三次会被记成"隔离生效"，
 * 而实际上 agent **已经读到了答案仓库**（否则它不会知道那些行的内容）。
 *
 * 新口径：只有**明确的拒绝证据**才算 blocked；其它失败一律按"没能证明被拦下"处理 ⇒ 算污染。
 * 这与本仓的纪律一致：**证明不了干净，就不算干净**（宁可作废）。
 */
export const SANDBOX_DENIAL_RE =
  /sandbox|沙箱|denied|deny|not allowed|outside the workspace|工作区之外|超出工作区|被拒绝|拒绝访问|EACCES|EPERM/i;

/**
 * @param rows 会话事件行（`{event_type, payload}`，**按 seq 升序**）；
 *             `payload` 可以是字符串（数据库里的原样）或已解析的对象。
 * @param answerRepoRe "答案仓库"的匹配（默认见上）
 */
export function classifySessionAccess(rows, answerRepoRe = DEFAULT_ANSWER_REPO_RE) {
  const leaks = [];
  const blocked = [];
  const contentOnly = [];
  const selfRestore = [];
  let pending = null;

  for (const row of rows) {
    let payload = row.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    if (!payload || typeof payload !== "object") continue;

    if (row.event_type === "tool_call") {
      const args = payload.args ?? {};
      const target = TARGET_FIELDS.filter((f) => typeof args[f] === "string")
        .map((f) => args[f])
        .join(" ");
      const whole = JSON.stringify(args).replace(/\s+/g, " ");
      /**
       * `mentions`：目标指向答案仓库（老口径，按 `mimo-gui` 这类特征词）。
       * `escapes`：目标**顺着 junction/上跳走出工作区**（第 113 波补的盲区口径）——
       * 这种路径不含特征词，但一样能摸到答案仓库（`node_modules\..` 就是当年的实例）。
       */
      const escapes = JUNCTION_ESCAPE_RE.test(target);
      pending = {
        tool: payload.tool ?? "?",
        target,
        whole,
        mentions: answerRepoRe.test(target) || escapes,
        contentOnly: !(answerRepoRe.test(target) || escapes) && answerRepoRe.test(whole),
      };
      const cmd = String(args.command ?? args.text ?? "");
      if (cmd && SELF_RESTORE_RE.test(cmd)) selfRestore.push(cmd.replace(/\s+/g, " ").slice(0, 200));
      continue;
    }

    // tool_result：与上一条 tool_call 配对（一次调用可能有多条结果事件，按第一条判）
    if (!pending || row.event_type !== "tool_result") continue;
    /**
     * 真的被沙箱拦下才算 blocked（见 SANDBOX_DENIAL_RE 的说明）：
     * 其它任何失败都不能证明"没读到答案" ⇒ 按污染处理。
     */
    const resultText = String(payload.result ?? "");
    const denied = SANDBOX_DENIAL_RE.test(resultText) && /error|失败|拒绝|denied/i.test(`${payload.status} ${resultText}`);
    if (pending.mentions) {
      const entry = `${pending.tool}: ${pending.target.slice(0, 200)}`;
      (denied ? blocked : leaks).push(entry);
    } else if (pending.contentOnly) {
      contentOnly.push(`${pending.tool}: ${pending.whole.slice(0, 160)}`);
    }
    pending = null;
  }

  return { leaks, blocked, contentOnly, selfRestore };
}
