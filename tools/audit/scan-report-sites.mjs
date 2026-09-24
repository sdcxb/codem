/**
 * 全仓**上报点分诊**扫描（第 90 轮，承接第 88 轮的"发现 ≠ 失败"）。
 *
 * ## 它解决的问题
 *
 * `reportPersistFailure` / `reportActionFailure` / `reportAdvisory` 三种语气各有各的语义：
 * - `persist`：**写盘失败**（重启会丢）；
 * - `action`：**动作失败**（功能没生效）；
 * - `advisory`：**发现/提醒**（功能跑成了，报的是结果）。
 *
 * 第 88 轮把"维护"这一个文件里的 13 个上报点逐个分诊过了（四个"发现"搬去 advisory），
 * 但**维护之外还有约 200 个上报点**没分诊。这一轮把它们**列出来**并让分诊结果**可机检**：
 * 每一处都要在 `report-site-classification.json` 里写明它是哪一种语气，理由是"发现 / 失败"；
 * 新出现的站点没有登记 ⇒ 闸门红（逼人先判语气，而不是顺手借一个通道）。
 *
 * ## 判定方式（刻意保守，不假装能自动判语义）
 *
 * 脚本**不猜**语义：它只做机械的三件事 ——
 * 1. 找出所有上报调用点（`report<Kind>(...)`，括号配平后取全，避免只看第一行）；
 * 2. 读出 area（第一个字符串字面量）与实际用的通道；
 * 3. 与登记表对账：缺登记 ⇒ 报"未分诊"；登记与实际通道不符 ⇒ 报"通道漂移"；
 *    登记表里有代码里已不存在的站点 ⇒ 报"过期登记"（防止登记表变成没人管的忽略名单）。
 *
 * ## 已知边界（如实写）
 *
 * - 只看**字符串字面量**形式的 area：动态拼的 area（如 `eventLog.unknownType.${type}`）
 *   会被归到 `<动态>`，登记表用 `文件::<动态>` 记，**不逐条判语义**；
 * - 不解析别名/包装函数（例如某处再包一层 `reportX()` 转发）——那种情况会被算在包装函数那一处；
 * - `console.warn/error` 的"该不该上报"**不在本工具范围**（那是另一类判断，见 GAP-LIST 的分诊工具说明）。
 *
 * 用法：
 *   node tools/audit/scan-report-sites.mjs            # 列清单（人类看）
 *   node tools/audit/scan-report-sites.mjs --json
 *   node tools/audit/scan-report-sites.mjs --check    # 闸门：与登记表对账
 *   node tools/audit/scan-report-sites.mjs --root <dir> --allowlist <file>   # 自证用
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = path.resolve(argOf("--root") ?? process.cwd());
const REGISTRY = path.resolve(argOf("--allowlist") ?? path.join(HERE, "report-site-classification.json"));

/** 生产源码（排除测试与技能自带脚本：后者跑在没有 WebView 的环境里） */
function prodSources() {
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
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/** 抓出所有上报调用（括号配平） */
function sitesIn(code) {
  const found = [];
  const re = /report(PersistFailure|ActionFailure|Advisory)\(/g;
  let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let inStr = null;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const call = code.slice(m.index, i);
    const line = code.slice(0, m.index).split(/\r?\n/).length;
    const kind = m[1] === "PersistFailure" ? "persist" : m[1] === "ActionFailure" ? "action" : "advisory";
    // area 取第一个"看起来像区域名"的字符串字面量（调用后的第一个字符串参数）
    const areaMatch = call.slice(m[0].length).match(/^\s*\n?\s*"([^"]+)"/);
    const area = areaMatch ? areaMatch[1] : "<动态>";
    const hasTitle = /title:/.test(call);
    found.push({ file: null, line, kind, area, hasTitle, snippet: call.replace(/\s+/g, " ").slice(0, 120) });
  }
  return found;
}

const findings = [];
for (const rel of prodSources()) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  /**
   * ⚠️ key 里必须带**同 file+area 的第几次出现**（`::#n`）：
   * 同一个 area 在一个文件里可能有两个语义不同的站点 —— 典型是 `maintenance.eventStructure`
   * 既报"没跑成"（失败）又报"结构异常 N 处"（发现）。第一版用 `file::area` 做 key，
   * 于是两次出现互相覆盖，闸门直接报出 7 处"通道漂移"（其实是我的 key 撞了）。
   */
  const seq = new Map();
  for (const s of sitesIn(code)) {
    const n = (seq.get(s.area) ?? 0) + 1;
    seq.set(s.area, n);
    findings.push({ ...s, file: rel, occurrence: n });
  }
}

const keyOf = (f) => `${f.file}::${f.area}::#${f.occurrence ?? 1}`;

const mode = argv.includes("--check") ? "check" : argv.includes("--json") ? "json" : "list";

if (mode === "json") {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 1));
} else if (mode === "list") {
  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  console.log(`上报点合计 ${findings.length} 处，涉及 ${byFile.size} 个文件`);
  const kindCount = findings.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {});
  console.log(`通道分布：persist=${kindCount.persist ?? 0}  action=${kindCount.action ?? 0}  advisory=${kindCount.advisory ?? 0}`);
  console.log("（逐处清单：--json；分诊对账：--check）");
} else {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const declared = new Map(reg.sites.map((s) => [s.site, s]));
  const seen = new Set();
  const unclassified = [];
  const drifted = [];
  for (const f of findings) {
    const key = keyOf(f);
    seen.add(key);
    const d = declared.get(key);
    if (!d) {
      unclassified.push(`${key}  →  实际走 ${f.kind}（第 ${f.line} 行）`);
      continue;
    }
    if (d.kind !== f.kind) drifted.push(`${key}：登记 ${d.kind}，实际 ${f.kind}（第 ${f.line} 行）`);
  }
  const stale = reg.sites.filter((s) => !seen.has(s.site)).map((s) => s.site);

  if (unclassified.length || drifted.length || stale.length) {
    if (unclassified.length) {
      console.error(`🔴 未分诊的上报点 ${unclassified.length} 处（新出现的站点必须先判语气再登记）：`);
      for (const u of unclassified) console.error(`   ${u}`);
    }
    if (drifted.length) {
      console.error(`🔴 通道漂移 ${drifted.length} 处（登记与实际不一致）：`);
      for (const d of drifted) console.error(`   ${d}`);
    }
    if (stale.length) {
      console.error(`🔴 登记过期 ${stale.length} 处（代码里已不存在）：`);
      for (const s of stale) console.error(`   ${s}`);
    }
    console.error(
      "处置：真失败 ⇒ persist/action；自检/普查/对账的**发现** ⇒ advisory（参考 docs/GAP-LIST.md C-21）；" +
        "然后登记进 report-site-classification.json（每条带一句理由）。",
    );
    process.exit(1);
  }
  console.log(
    `上报点分诊闸门通过：${findings.length} 处全部已登记（persist/action/advisory 各自就位；未分诊 0、漂移 0、过期 0）`,
  );
}
