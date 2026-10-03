/**
 * **单条 Codem 记录的判定辅助**（第 106 波）：给一个 session id（或任务 id），
 * 回答"这次运行到底做没做活、是怎么做的、有没有碰不该碰的东西"。
 *
 * ## 为什么需要它
 *
 * 第 106 波发现的尺子问题：`git diff` 单独用会**漏掉已提交的改动**，
 * 于是"真的做了活"和"什么都没做却通过"长得一样（老口径里混进过 3 次）。
 * 记录里现在有 `suspiciousNoDiffPass` 标记，但**标记只是报案**：
 *   · 是假绿（工作区带着上次的修复）⇒ 这次成绩作废、任务要重跑；
 *   · 是 agent 自己 commit 了 ⇒ 改动真实存在，diff 口径要按"相对根提交"算。
 * 两者的区别只能从**会话里到底调了什么工具**看出来 —— 这个脚本就是把那件事打印出来。
 *
 * 用法：
 *   node tools/eval/audit-codem-record.mjs --session <sessionId>
 *   node tools/eval/audit-codem-record.mjs --last            # 最新会话
 *   node tools/eval/audit-codem-record.mjs --task repo-04-session-update-drops-fields
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DB_PATH = join(process.env.APPDATA ?? "", "com.codem.app", "codem-db-rust.bin");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.session = argv[++i];
    else if (argv[i] === "--task") out.task = argv[++i];
    else if (argv[i] === "--last") out.last = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else throw new Error(`不认识的参数：${argv[i]}`);
  }
  return out;
}

const USAGE = `用法：
  node tools/eval/audit-codem-record.mjs --session <sessionId> | --last | --task <taskId>

输出：该会话里
  · 每个工具调用（名字 + 参数摘要）与结果状态；
  · **写类**调用（write / edit / bash 里的重定向、git 操作）单独归类 —— 这是"做没做活"的直接证据；
  · 触碰工作区外路径的调用（污染口径与 \`codem-record-integrity.mjs\` 一致）。`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function resolveSession() {
  if (args.session) return args.session;
  if (args.last) {
    const row = db
      .prepare("SELECT session_id FROM session_events GROUP BY session_id ORDER BY MAX(timestamp) DESC LIMIT 1")
      .get();
    return row?.session_id;
  }
  if (args.task) {
    // 任务 id 出现在该会话的 tool_call 参数/结果里（任务提示是发进去的第一条消息）
    const rows = db
      .prepare("SELECT session_id, MAX(timestamp) t FROM session_events GROUP BY session_id ORDER BY t DESC LIMIT 200")
      .all();
    for (const row of rows) {
      const hit = db
        .prepare("SELECT COUNT(*) n FROM session_events WHERE session_id = ? AND payload LIKE ?")
        .get(row.session_id, `%${args.task}%`);
      if (hit?.n > 0) return row.session_id;
    }
    return null;
  }
  return null;
}

const sessionId = resolveSession();
if (!sessionId) {
  console.error("找不到会话（用 --session / --last / --task 指定）");
  process.exit(2);
}

const rows = db
  .prepare("SELECT event_type, payload FROM session_events WHERE session_id = ? ORDER BY seq")
  .all(sessionId);
db.close();

/** 写类工具：真的会改文件/仓库的那些 */
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch", "notebook_edit"]);
/** 读类工具 */
const READ_TOOLS = new Set(["read", "glob", "grep", "list_dir"]);

const calls = [];
for (const row of rows) {
  if (row.event_type !== "tool_call") continue;
  const payload = JSON.parse(String(row.payload));
  calls.push({ tool: payload.tool, args: payload.args ?? {} });
}

const writes = calls.filter((c) => WRITE_TOOLS.has(c.tool));
const bash = calls.filter((c) => c.tool === "bash");
const bashMutating = bash.filter((c) => {
  const command = String(c.args?.command ?? "");
  return /\b(git\s+(commit|checkout|restore|stash|reset|clean)|rm\b|mv\b|cp\b|Set-Content|Out-File|>>?\s*\S|sed\s+-i)/i.test(
    command,
  );
});
const gitOps = bash
  .map((c) => String(c.args?.command ?? ""))
  .filter((command) => /\bgit\b/.test(command));

console.log(`会话 ${sessionId}：事件 ${rows.length}，工具调用 ${calls.length}`);
console.log(`  写类工具调用：${writes.length}（${[...new Set(writes.map((c) => c.tool))].join(", ") || "无"}）`);
console.log(`  bash 调用：${bash.length}，其中**会改状态**的 ${bashMutating.length}`);
for (const c of writes.slice(0, 12)) {
  const target = c.args?.path ?? c.args?.file_path ?? c.args?.filePath ?? "?";
  console.log(`     write → ${String(target)}`);
}
for (const c of bashMutating.slice(0, 12)) {
  console.log(`     bash(${String(c.args?.command ?? "").replace(/\s+/g, " ").slice(0, 140)})`);
}
if (gitOps.length > 0) {
  console.log(`  git 相关命令 ${gitOps.length} 条：`);
  for (const command of [...new Set(gitOps)].slice(0, 10)) {
    console.log(`     ${command.replace(/\s+/g, " ").slice(0, 140)}`);
  }
}

const verdict =
  writes.length + bashMutating.length > 0
    ? "**做过活**（有写类调用）—— 若这次是零改动通过，优先怀疑驱动的改动口径（漏了已提交的改动）"
    : "**没有任何写类调用** —— 若这次通过，几乎可以确定是工作区带着上次的修复（假绿），成绩作废";
console.log(`\n判定：${verdict}`);
