/**
 * 「复选框/单选框必须有可访问名」扫描器（第 95 轮）。
 *
 * ## 为什么要它（与 O-4 ② 的"小命中区"是同一件事的两面）
 *
 * 走查把 **13×13 的原生复选框**报成"命中区不足 24×24"。但真机上量到的是：
 * **有 `<label>` 包裹的那些，label 是 856×26 —— 有效目标其实是 label**（点 label 也能切换，
 * 已用 `label.click()` 实测确认），所以它们**不该被报**。
 * 真正的问题是**没有被 label 兜住的那些**：13×13 就是它的全部可点范围，读屏也念不出它是干什么的。
 *
 * 所以判据落在这里（静态、可机检）：每个 `input[type=checkbox|radio]` 必须满足其一：
 *  ① 被 `<label>` 包裹（最近的祖先里有 label）；② 有 `aria-label`；③ 有 `id` 且文件里有 `htmlFor={id}`。
 *
 * ## 边界（如实写）
 *
 * - 只扫 `.tsx`；动态拼出来的 `type={x}` 不认（会漏报，但那属于极少数）；
 * - 不做 JSX 解析，用"向前找最近的 `<label` 与最近的 `</label>`"这条保守近似：
 *   找不到 label 就再看 aria-label / id+htmlFor，都没有才算违规。
 *
 * 用法：
 *   node tools/ui-audit/scan-labeled-inputs.mjs            # 列清单
 *   node tools/ui-audit/scan-labeled-inputs.mjs --json
 *   node tools/ui-audit/scan-labeled-inputs.mjs --check    # 与基线对账（只许降不许升）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findTags, stripJsxTags } from "./jsx-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = path.resolve(argOf("--root") ?? process.cwd());
const BASELINE = path.resolve(argOf("--baseline") ?? path.join(HERE, "labeled-inputs-baseline.json"));

function prodTsx() {
  const out = [];
  const stack = ["src"];
  while (stack.length) {
    const dir = stack.pop();
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "src/test" || e.name === "node_modules") continue;
        if (rel === "src/core/skills/skill-creator/scripts") continue;
        stack.push(rel);
      } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) out.push(rel);
    }
  }
  return out.sort();
}

const findings = [];
for (const rel of prodTsx()) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const m of findTags(code, "input")) {
    const tag = m.tag;
    if (!/type=\s*(?:"(?:checkbox|radio)"|'(?:checkbox|radio)'|\{["']?(?:checkbox|radio)["']?\})/.test(tag)) continue;
    const before = code.slice(0, m.start);
    const line = m.line;
    const hasAria = /aria-label\s*=|aria-labelledby\s*=/.test(tag);
    /**
     * 最近的 `<label …>` 与 `</label>`：谁更近。
     *
     * ⚠️ 第 95 轮补的一个**假阴性**：只判断"在 label 里面"不够 —— 一个**空 label**
     * （里面只有 `<input/>`、没有任何文字）**给不出可访问名**。
     * `AutomationTab` 的触发器开关原来就是这种写法：label 包着 input，读屏照样念不出它是干什么的。
     * 所以这里要求 label 的内容**去掉 input 标签后还有文字/表达式**才算"有名字"。
     */
    const lastOpen = before.lastIndexOf("<label");
    const lastClose = before.lastIndexOf("</label>");
    let labeled = false;
    if (lastOpen > lastClose) {
      const closeIdx = code.indexOf("</label>", m.start); // ⚠️ 必须是 m.start：findTags 给的是 start/end，没有 index（用 m.index 会退化成从 0 找 ⇒ 假阳性）
      const openEnd = code.indexOf(">", lastOpen);
      const inner = closeIdx > 0 && openEnd > 0 ? code.slice(openEnd + 1, closeIdx) : "";
      const withoutInputs = stripJsxTags(inner);
      labeled = withoutInputs.replace(/\s+/g, "").length > 0;
    }
    // id + htmlFor（同文件里出现 htmlFor={"x"} 或 htmlFor="x"）
    const idMatch = tag.match(/\bid=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/);
    const id = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3]) : null;
    const hasHtmlFor = id ? new RegExp(`htmlFor=(?:"${id}"|\\{"${id}"\\}|\\{\`${id}\`\\})`).test(code) : false;
    if (labeled || hasAria || hasHtmlFor) continue;
    findings.push({ rel, line, tag: tag.replace(/\s+/g, " ").slice(0, 120) });
  }
}

const mode = argv.includes("--check") ? "check" : argv.includes("--json") ? "json" : "list";

if (mode === "json") {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 1));
} else if (mode === "list") {
  console.log(`没有可访问名的复选框/单选框：${findings.length} 处`);
  for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.tag}`);
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (findings.length > baseline.count) {
    console.error(`🔴 没名字的复选框/单选框从 ${baseline.count} 涨到 ${findings.length}：`);
    for (const f of findings.slice(0, 20)) console.error(`   ${f.rel}:${f.line}`);
    console.error("处置：用 <label> 包住它、或加 aria-label（读屏要能念出这个开关是干什么的；顺带它的可点范围也变成整行）。");
    process.exit(1);
  }
  console.log(`labeled-inputs 闸门通过：${findings.length} 处 ≤ 基线 ${baseline.count}`);
}
