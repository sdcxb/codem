/**
 * 把一局会话里**工具调用的最终形态**（args / status / result / metadata）抽成一份
 * 取证用 JSON。会话日志里 `toolCalls` 会随流式推进被反复重写，所以按 id 取
 * 「最后一次带 result 的那份」—— 只认已经落盘的最终结果，不猜。
 *
 * 用法：node .preview-shot/_extract-toolcalls.mjs <会话.jsonl> <输出.json>
 */
import fs from "node:fs";

const [sessionPath, outPath] = process.argv.slice(2);
if (!sessionPath || !outPath) throw new Error("用法: _extract-toolcalls.mjs <session.jsonl> <out.json>");

const msgs = fs
  .readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const byId = new Map();
for (const m of msgs) {
  if (!Array.isArray(m.toolCalls)) continue;
  for (const t of m.toolCalls) {
    if (!t || !t.id) continue;
    const prev = byId.get(t.id) || {};
    const merged = { ...prev, ...t };
    // result 只在非空时覆盖（流式期间是 null/空串）
    merged.result = typeof t.result === "string" && t.result.length > 0 ? t.result : (prev.result ?? t.result ?? null);
    if (t.status === "running" && prev.status === "done") merged.status = prev.status;
    byId.set(t.id, merged);
  }
}

const user = msgs.find((m) => m.role === "user");
const finalAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.content);

const out = {
  sessionFile: sessionPath.split(/[\\/]/).pop(),
  userMessage: user ? user.content : null,
  assistantMessage: finalAssistant ? finalAssistant.content : null,
  toolCalls: [...byId.values()].map((t) => ({
    id: t.id,
    tool: t.tool,
    args: t.args,
    status: t.status,
    metadata: t.metadata,
    resultChars: typeof t.result === "string" ? t.result.length : null,
    result: t.result,
  })),
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log("written", outPath, "bytes", fs.statSync(outPath).size, "toolCalls", out.toolCalls.length);
for (const t of out.toolCalls) {
  console.log(
    "=== " + t.tool + " status=" + t.status + " resultChars=" + t.resultChars + " duration=" + (t.metadata && t.metadata.duration),
  );
}
