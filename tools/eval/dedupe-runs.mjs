/**
 * **收尾整理重复运行号（按 (caseId, 原始 run 号) 归一）** —— 第 122 波，纯函数 + CLI。
 *
 * ## 为什么需要"按 `parkedFrom` 归一"
 *
 * 我们有两个机制在动 run 号，而**它们的规则原本是相反的**：
 *
 * | 机制 | 何时 | 原本的行为 | 后果 |
 * |---|---|---|---|
 * | 写入守卫 `planRecordAppend()` | 跑批中，实时 | 把**新来**的重复记录挪到 900+ | 键干净 ✓，但**旧（脏）记录留在正位** ✗ |
 * | 收尾整理（本文件） | 全部跑完之后 | 每个键**保留最新**那条 | 干净记录回到正位 ✓ |
 *
 * 两者叠加时会出现这种情况（实测）：`repo-06` 的干净 run 被守卫挪成 `run-901:passed`，
 * 而正位 `run-2/run-3` 上留着脏记录 ⇒ 如果按"键"去重，那条**干净记录会被当成多余的排除掉** ✗✗。
 *
 * 所以收尾整理必须**先按 `parkedFrom` 把记录归回它原本的键**，再在组内保留**最后出现**的那条
 * （文件顺序 = 写入顺序 = 时间顺序）为正规 run 号，其余挪到 900+。
 * 这样"取最新"这条规则才真正等价于"取干净期那一条"。
 *
 * ## CLI
 *
 * ```
 * node tools/eval/dedupe-runs.mjs                     # 预演（只打印）
 * node tools/eval/dedupe-runs.mjs --apply             # 真写
 * node tools/eval/dedupe-runs.mjs --apply --files a.jsonl,b.jsonl
 * ```
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const PARK_FROM = 900;

/**
 * 纯函数：算出一份记录里"谁该留在正位、谁该被挪走"。
 *
 * @param rows 记录（按写入顺序）
 * @returns `{ rows: 整理后的记录, moves: [{caseId, from, to, outcome}], canonicals: number }`
 */
export function planDedupe(rows) {
  /** 归一后的键 = caseId + 它**原本**的 run 号（被挪过的用 parkedFrom 还原） */
  const keyOf = (r) => `${r.caseId}\u0000${r.parkedFrom ?? r.runNumber}`;
  const lastIndex = new Map();
  rows.forEach((r, i) => lastIndex.set(keyOf(r), i));

  let nextPark = PARK_FROM;
  const used = new Set(rows.filter((r) => typeof r.runNumber === "number" && r.runNumber >= PARK_FROM).map((r) => r.runNumber));
  while (used.has(nextPark)) nextPark++;

  const moves = [];
  const out = rows.map((r, i) => {
    const key = keyOf(r);
    const original = r.parkedFrom ?? r.runNumber;
    if (lastIndex.get(key) === i) {
      // 胜出者：回到它**原本**的 run 号，并清掉"挪位"痕迹
      const { parkedFrom, parkNote, ...rest } = r;
      if (r.parkedFrom !== undefined) moves.push({ caseId: r.caseId, from: r.runNumber, to: original, outcome: r.outcome, note: "回到正位（本组最后一条）" });
      return { ...rest, runNumber: original };
    }
    const to = nextPark++;
    moves.push({ caseId: r.caseId, from: r.runNumber, to, outcome: r.outcome, note: `让位给更新的那条（本组共 ${rows.filter((x) => keyOf(x) === key).length} 条）` });
    return {
      ...r,
      runNumber: to,
      parkedFrom: original,
      parkNote: `本应是 run-${original}，但同一 (caseId, runNumber) 只能有一条（否则配对会被阻塞）；按"不丢数据"原则挪到高位 run 号`,
    };
  });
  return { rows: out, moves, canonicals: lastIndex.size };
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("dedupe-runs.mjs")) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const filesIndex = args.indexOf("--files");
  const files =
    filesIndex >= 0
      ? args[filesIndex + 1].split(",").map((s) => s.trim())
      : [".preview-shot/eval-records-codem-repo-v2.jsonl", ".preview-shot/eval-records-repo-control.jsonl"];

  for (const file of files) {
    if (!existsSync(file)) {
      console.log(`（跳过不存在的 ${file}）`);
      continue;
    }
    const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const { rows: fixed, moves, canonicals } = planDedupe(rows);
    console.log(`${file}：${rows.length} 条记录、${canonicals} 个 (任务, 原始 run) 组；${moves.length} 处变动${apply ? "（已写盘）" : "（预演，未写盘）"}`);
    for (const m of moves) {
      console.log(`  ${m.caseId}：run-${m.from} → run-${m.to}（${m.outcome}）${m.note}`);
    }
    if (apply && moves.length > 0) {
      writeFileSync(file, fixed.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }
  }
  if (!apply) console.log("\n（这是预演。要真改，加 --apply。）");
}
