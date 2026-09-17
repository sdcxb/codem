/**
 * 门控落点结构校验（B6 批，长期保留）
 *
 * `gate-l3-fallbacks.mjs` 按"锚点之后的第一处 `const db = getDatabase();`"插入门控，
 * 它**不检查**那处旧库调用是否真的属于该锚点所在的函数。
 *
 * 一旦某个锚点后面的旧库调用其实属于**下一个**函数（例如锚点所在函数已经没有
 * 直接旧库调用了），门控就会插错函数 —— 而 `tsc` 未必报错（返回类型可能恰好兼容）。
 *
 * 所以这里做一次纯结构校验：对每个锚点，
 *   锚点位置 < 该锚点之后第一处旧库调用位置
 *   且 **两者之间不存在任何其它锚点**（否则那处旧库调用属于后面的函数）。
 *
 * 用法：node tools/audit/verify-gate-placement.mjs <plan.json>
 */
import { readFileSync } from "node:fs";

const [, , planPath] = process.argv;
if (!planPath) {
  console.error("用法：node tools/audit/verify-gate-placement.mjs <plan.json>");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const plans = Array.isArray(plan) ? plan : [plan];

let problems = 0;
for (const p of plans) {
  const text = readFileSync(p.file, "utf8");
  const anchors = [];
  for (const site of p.sites) {
    const at = text.indexOf(site.anchor);
    if (at < 0) {
      console.log(`✗ ${p.file}: 锚点未找到 ${site.anchor}`);
      problems++;
      continue;
    }
    anchors.push({ anchor: site.anchor, at });
  }
  anchors.sort((a, b) => a.at - b.at);

  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    const dbAt = text.indexOf("const db = getDatabase();", cur.at);
    if (dbAt < 0) {
      console.log(`✗ ${p.file}: ${cur.anchor} 之后没有旧库调用`);
      problems++;
      continue;
    }
    const next = anchors[i + 1];
    if (next && next.at < dbAt) {
      console.log(`✗ ${p.file}: ${cur.anchor} 的旧库调用落到了 ${next.anchor} 之前（门控插错函数）`);
      problems++;
      continue;
    }
    // 门控语句必须紧贴在旧库调用之前
    const lineStart = text.lastIndexOf("\n", dbAt) + 1;
    const prevLineStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    const prevLine = text.slice(prevLineStart, lineStart);
    // 读门控叫 shouldFallbackToLegacy，写门控叫 writeShouldFallBackToLegacy（大写 B）—— 用共同片段匹配
    if (!prevLine.includes("ToLegacy")) {
      console.log(`✗ ${p.file}: ${cur.anchor} 的旧库调用前一行不是门控语句：${prevLine.trim()}`);
      problems++;
    }
  }
  if (problems === 0) console.log(`✓ ${p.file}: ${anchors.length} 处门控落点全部正确`);
}
process.exit(problems ? 1 : 0);
