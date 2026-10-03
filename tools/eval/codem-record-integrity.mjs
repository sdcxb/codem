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

/** 访问类字段：这些决定"这次调用要碰什么" */
const TARGET_FIELDS = ["path", "file_path", "command", "code", "script", "pattern", "workdir"];

/** git 里"把工作区/历史改回去"的子命令 —— 用来发现"自我还原"的痕迹 */
export const SELF_RESTORE_RE = /\bgit\b[^\n]*\b(checkout|restore|stash|reset|revert|clean)\b/i;

/**
 * 判据的注入点：**"答案仓库"长什么样**（默认 `mimo-gui`，即评测时不能在的地方）。
 * 测试与别的仓库可以换成自己的。
 */
export const DEFAULT_ANSWER_REPO_RE = /mimo-gui/i;

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
      pending = {
        tool: payload.tool ?? "?",
        target,
        whole,
        mentions: answerRepoRe.test(target),
        contentOnly: !answerRepoRe.test(target) && answerRepoRe.test(whole),
      };
      const cmd = String(args.command ?? args.text ?? "");
      if (cmd && SELF_RESTORE_RE.test(cmd)) selfRestore.push(cmd.replace(/\s+/g, " ").slice(0, 200));
      continue;
    }

    // tool_result：与上一条 tool_call 配对（一次调用可能有多条结果事件，按第一条判）
    if (!pending || row.event_type !== "tool_result") continue;
    const failed = payload.status === "error" || /Sandbox:/.test(String(payload.result ?? ""));
    if (pending.mentions) {
      const entry = `${pending.tool}: ${pending.target.slice(0, 200)}`;
      (failed ? blocked : leaks).push(entry);
    } else if (pending.contentOnly) {
      contentOnly.push(`${pending.tool}: ${pending.whole.slice(0, 160)}`);
    }
    pending = null;
  }

  return { leaks, blocked, contentOnly, selfRestore };
}
