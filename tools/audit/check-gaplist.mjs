/**
 * 「唯一当前缺口清单」完整性门禁（第 127 轮，audit 第 17 道）。
 *
 * 起因：`docs/GAP-LIST.md` 是这份审计**唯一的当前缺口清单**，但它一直靠人维护格式 ——
 * 第 111/113 轮我自己就把它粘坏过两次（单元格里混进多余竖线、整行渲染错位），
 * 第 98 轮还把一条**已经作废的结论**留在里面（后来更正）。清单一旦坏了，
 * 「审计结论可复核」这句话就落空了。
 *
 * 所以这里把它变成机器判据：
 *   ① 未关闭项的表行**列数必须与表头一致**（防止粘坏）；
 *   ② 每个未关闭项必须有**非空的现状与关闭条件**（没有"关闭条件"的缺口 = 永远关不掉）；
 *   ③ 打印当前**未关闭项清单**（这句话要能一眼复核）。
 *
 * 只读；不改文件。用法：node tools/audit/check-gaplist.mjs
 */
import fs from "node:fs";

const FILE = "docs/GAP-LIST.md";
const lines = fs.readFileSync(FILE, "utf8").split("\n");
const pipes = (s) => (s.match(/(?<!\\)\|/g) ?? []).length;

const start = lines.findIndex((l) => /^##\s*二、/.test(l));
if (start < 0) throw new Error("找不到「当前未关闭的项」这一节");
const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
const rows = [];
for (let i = start; i < (end < 0 ? lines.length : end); i += 1) {
  if (!/^\|\s*O-\d+\s*\|/.test(lines[i])) continue;
  const cols = lines[i].split(/(?<!\\)\|/).map((c) => c.trim());
  // cols: ['', id, 现状, 关闭条件, ''] —— 表头是 4 列（#/项/现状/关闭它的条件）
  const id = cols[1];
  const title = cols[2] ?? "";
  const status = cols[3] ?? "";
  const closeCond = cols[4] ?? "";
  const closed = /~~.*~~|已关闭|已收口|已定位并消除|已标准化/.test(title);
  rows.push({ id, title, status, closeCond, closed, pipeCount: pipes(lines[i]), line: i + 1 });
}

/*
 * ⚠️ 表头分隔行要**从本节往下找**：往上找会命中上一张表的（4 竖线）⇒ 第一版把 23 行全报成"粘坏了"，
 * 和第 115 轮修 O-10 那行时踩的是同一个坑（向上找最近的分隔行）。这次方向反过来，并留下这句。
 */
let sepIdx = -1;
for (let i = start; i < (end < 0 ? lines.length : end); i += 1) {
  if (/^\|\s*-{3,}/.test(lines[i])) {
    sepIdx = i;
    break;
  }
}
const headerPipes = sepIdx >= 0 ? pipes(lines[sepIdx]) : 5;

const problems = [];
for (const r of rows) {
  if (r.pipeCount !== headerPipes) problems.push(`${r.id}（第 ${r.line} 行）：列数 ${r.pipeCount} ≠ 表头 ${headerPipes}（单元格被粘坏了）`);
  if (!r.closed && r.status.length < 10) problems.push(`${r.id}：未关闭项没有写清现状`);
  if (!r.closed && r.closeCond.length < 5) problems.push(`${r.id}：未关闭项没有写「关闭它的条件」（关不掉的缺口不算缺口）`);
}

const open = rows.filter((r) => !r.closed);
console.log(`缺口清单：共 ${rows.length} 项，**未关闭 ${open.length} 项**`);
for (const r of open) console.log(`   ⬜ ${r.id} ${r.title.replace(/\*\*/g, "").slice(0, 46)}…  → ${r.closeCond.replace(/\*\*/g, "").slice(0, 60)}…`);

if (problems.length) {
  console.log(`\n❌ ${problems.length} 处问题：`);
  for (const p of problems) console.log(`   - ${p}`);
  process.exit(1);
}
console.log("\n✅ 清单格式与「未关闭项必须写关闭条件」都成立");
