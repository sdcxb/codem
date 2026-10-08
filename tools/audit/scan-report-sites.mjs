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
 * ## 单一来源（第 189 波口径收敛，★ 别退回"两份实现"）
 *
 * 站点 key（`文件::area::#出现序号`）**只在这里构造一次**，写进 `--json` 的每条 finding（字段 `key`）。
 * 谁要对账（用例、登记表生成器）都必须消费这个 `key`，**不许自己再拼一遍字符串** ——
 * 第 188 波就吃过这个亏：另一个口径把 `_counts` 缓存当成"清单条数"，
 * 于是 `--check` 打印 247（扫描命中）而 `_counts.total` 停在 245（缓存），
 * 用例 RPT-2 红在"expected 245 to be 247"，可**一个站点都没少**（见 `--check` 现在也校验 `_counts`）。
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
 *   node tools/audit/scan-report-sites.mjs --json     # 每条 finding 带 `key`（对账方只许用它）
 *   node tools/audit/scan-report-sites.mjs --check    # 闸门：与登记表对账（含 `_counts` 缓存）
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

/**
 * 站点 key 的**唯一实现**（`--json` 的每条 finding 都带 `key`）。
 *
 * ⚠️ 对账方一律消费 finding 里的 `key`，不要自己拼一遍 —— 拼两遍就是"同一规则两份实现"，
 * 迟早漂移（第 188 波的 245/247 事故就是这么来的）。
 */
const keyOf = (f) => `${f.file}::${f.area}::#${f.occurrence ?? 1}`;

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
    const finding = { ...s, file: rel, occurrence: n };
    findings.push({ ...finding, key: keyOf(finding) });
  }
}

const mode = argv.includes("--check") ? "check" : argv.includes("--json") ? "json" : "list";

if (mode === "json") {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 1));
} else if (mode === "list") {
  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  console.log(`上报点合计 ${findings.length} 处，涉及 ${byFile.size} 个文件`);
  const kindCount = findings.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {});
  console.log(`通道分布：persist=${kindCount.persist ?? 0}  action=${kindCount.action ?? 0}  advisory=${kindCount.advisory ?? 0}`);
  console.log("（逐处清单：--json（每条带 `key`）；分诊对账：--check）");
} else {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const declared = new Map(reg.sites.map((s) => [s.site, s]));
  const seen = new Set();
  const unclassified = [];
  const drifted = [];
  for (const f of findings) {
    // ★ 单一来源：用 findings 自带的 key，别在这里或别处再拼一遍
    seen.add(f.key);
    const d = declared.get(f.key);
    if (!d) {
      unclassified.push(`${f.key}  →  实际走 ${f.kind}（第 ${f.line} 行）`);
      continue;
    }
    if (d.kind !== f.kind) drifted.push(`${f.key}：登记 ${d.kind}，实际 ${f.kind}（第 ${f.line} 行）`);
  }
  const stale = reg.sites.filter((s) => !seen.has(s.site)).map((s) => s.site);

  /**
   * ★★ 第 189 波补的第四条对账：`_counts` **缓存**也必须与 `sites` 一致。
   *
   * 起因（真事故）：上一轮往登记表末尾补了 20 条站点，`_counts` 只从 227 加到 245（漏记 2 条）。
   * 于是出现了**两个数字**：`--check`（扫描口径）打印 247、`_counts`（缓存口径）停在 245，
   * 用例 RPT-2 红在 `expected 245 to be 247`，而**一个站点都没少**（逐个对齐是过的）。
   * 缓存没人核对 ⇒ 它会一直骗人；所以在这里当场判红，而不是等用例去发现。
   */
  const counted = {
    total: reg.sites.length,
    triaged: reg.sites.filter((s) => s.status === "triaged").length,
    pending: reg.sites.filter((s) => s.status === "pending").length,
  };
  const countsBad = [];
  for (const name of ["total", "triaged", "pending"]) {
    const cached = reg._counts?.[name];
    if (cached !== counted[name]) countsBad.push(`_counts.${name} = ${cached}，实际 ${counted[name]}`);
  }

  if (unclassified.length || drifted.length || stale.length || countsBad.length) {
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
    if (countsBad.length) {
      console.error(
        `🔴 登记表的 \`_counts\` 缓存与实际不符 ${countsBad.length} 项（缓存会骗人：它是"另一个数字口径"）：`,
      );
      for (const c of countsBad) console.error(`   ${c}`);
      console.error(`   登记表实际：扫描命中 ${findings.length} 处 / 登记条目 ${counted.total} 条；请把 _counts 按 sites 现算。`);
    }
    console.error(
      "处置：真失败 ⇒ persist/action；自检/普查/对账的**发现** ⇒ advisory（参考 docs/GAP-LIST.md C-21）；" +
        "然后登记进 report-site-classification.json（每条带一句理由）；" +
        "`_counts` 一律从 `sites` 现算，别手写。",
    );
    process.exit(1);
  }
  console.log(
    `上报点分诊闸门通过：扫描命中 ${findings.length} 处 = 登记表 ${counted.total} 条` +
      `（triaged ${counted.triaged} / pending ${counted.pending}）；未分诊 0、漂移 0、过期 0、缓存漂移 0`,
  );
  /**
   * ⚠️ 上一波就被这两个数字误导过：`--check` 打印的是**扫描命中数**，与登记表的 `_counts` 是
   * **两回事**（一个是现算、一个是缓存）。现在两者都被本闸门钉住并各自标了名字 ⇒ 不会再"看着 245
   * 却以为有 245 个站点"。
   */
  console.log("（两个口径都要相等：扫描命中 = 登记表条目 = `_counts.total`；任何一个对不上，上面就会红）");
}
