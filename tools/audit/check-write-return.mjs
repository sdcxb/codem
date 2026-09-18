/**
 * ## 判据（第 55 轮实测后收紧：宁可少报，不许假阳）
 *
 * `false`（没接手）**不是随便哪个站点都会发生**的。真端口的行为给出了一个可静态判定的
 * 充分条件：
 *
 * > **同一个函数里先成功读过同一张表** ⇒ 这张表的镜像已就绪 ⇒ 同一张表的写入必然被接手
 * > ⇒ 这次 `domainWrite` 的 `false` 分支**不可达**。
 *
 * （`domainReadOne/Many` 在镜像未就绪时返回 `undefined`，而调用方要么当场 return、
 * 要么明确处理它 —— 所以"读成功"确实蕴含"已就绪"。）
 *
 * 因此判据是：
 *
 * 1. 若该函数体内**有对同一张表的成功读**（同一表常量/同名表字面量）→ 不判（不可达）；
 * 2. 否则要求返回值被处理：`if (domainWrite(…))` / `= domainWrite(…)` 且**该函数体内**有
 *    上报调用（`reportWriteNotAccepted` / `reportPersistFailure` / `reportActionFailure`）；
 * 3. 剩下的一律报出来（除非在 `ALLOWLIST` 里写明"为什么走不到 false"）。
 *
 * 第一版判据**没有第 1 条**，于是在真仓库上一次性报出 35 处 —— 全是"同表先读后写"的形态，
 * 意思是"这条规则太宽、报的都不是缺陷"。**收紧靠的是把真实现的保证写进判据**，
 * 而不是往允许清单里塞 35 条：后者会让这道门禁退化成装饰。
 *
 * ## 真凭实据
 *
 * `recovery-restore.ts` 的项目写回点就是判据 3 的形态：它读的是 `sessions`、
 * 写的是 `projects` —— **两张表就绪状态互相独立**，所以 `false` 真的会发生；
 * 而它原来 `if (ok) out.projects = …` 的 false 分支什么都不做（静默丢弃，
 * 后果"会话全部落到全局项目"只写在源码注释里）。现已修 + `REC-6` 用例守着。
 *
 * ## canary
 *
 * 合成片段证明判据会咬：**跨表**写且不处理返回值 → 必须报；
 * **同表**先读后写 → 不许报；带上报 → 不许报。并检查抽取器在真仓库上至少抽到
 * `SITES_MIN` 个写入点（抽不到 = 抽取器失效，而不是"代码变干净了"）。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SITES_MIN = 45; // 实测 73（domainWrite/domainDelete 全部调用点）

const REPORT_RE = /reportWriteNotAccepted|reportPersistFailure|reportActionFailure|reportFailure\(/;
const CALL_RE = /domainWrite\(|domainWriteMany\(|domainDelete\(/g;

/**
 * 允许"不处理返回值"的站点。**每一条都必须写清"为什么这里走不到 false"**，
 * 而且理由要能被复核（不是"看起来没事"）。
 */
const ALLOWLIST = [
  {
    file: "src/core/llm/feedback.ts",
    why:
      "`writeRow()` 只在 `existingRow !== undefined`（同表读成功）时被调用 —— " +
      "读成功意味着该表镜像已就绪，同一张表的写入必然被接手；" +
      "真正读不到时函数在更早的分支就返回了 `{ ok: false, error: … }`（第 347 行）。",
  },
];

/**
 * 找出包含某偏移的**最内层函数体**。
 *
 * ⚠️ 第一版用的是"往前找最近的 `=>` / `function` / `) {`"，在真代码上会**取错层**：
 * `if (…) {` 也以 `) {` 结尾，于是取到的是那个 `if` 块 —— 里面的"同表读"自然找不到，
 * `skippedSameTable` 于是恒为 0（判据退化成"全部报出来"）。
 *
 * 现在按**大括号深度**定位：先算出调用点所在的所有块，再从最内层往外找第一个
 * "看起来是函数体"的块（结尾是 `=>` 或参数表 `)`，且不是 if/for/while/switch/catch）。
 */
function enclosingFunctionBody(src, offset) {
  const stack = [];
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "{") stack.push(i);
    else if (src[i] === "}") stack.pop();
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const open = stack[k];
    const head = src.slice(Math.max(0, open - 300), open);
    const ctrl = /(^|[^\w.$])(if|for|while|switch|catch)\s*\([^()]*\)\s*$/.test(head.trimEnd());
    const arrow = /=>\s*$/.test(head.trimEnd());
    const parenParams = /\)\s*(?::[^;{]*)?\s*$/.test(head.trimEnd());
    const fnKeyword = /function\b[^{]*$/.test(head);
    if (!ctrl && (arrow || parenParams || fnKeyword)) {
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(open, i + 1);
        }
      }
      return src.slice(open);
    }
  }
  return src;
}

/** 一行里是不是注释（避免把注释里的示例代码当成真实调用点） */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** 表常量 → 表名（与行构造器门禁同一套做法） */
function tableConstsOf(src) {
  const map = new Map();
  for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z_]+)"/g)) map.set(m[1], m[2]);
  return map;
}

/** 取调用点的表标识（常量名或字面量） */
function tableTokenOf(src, callIndex) {
  const open = src.indexOf("(", callIndex);
  if (open < 0) return null;
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*|"[a-z_]+")/.exec(src.slice(open + 1, open + 80));
  return m ? m[1].replace(/"/g, "") : null;
}

/** 函数体内是否"已经证明该表镜像就绪"（⇒ 写必然被接手） */
function readsSameTable(body, token, consts) {
  const table = consts.get(token) ?? token;
  // ⚠️ 两个读入口都要算：只匹配 `domainReadOne` 会让第一版判据在真仓库上一处都匹配不到
  // （`skippedSameTable` = 0 就是这么来的 —— 于是判据退化成"全部报出来"）
  const readRe = /domainRead(?:One|Many)(?:<[^>]*>)?\(\s*([A-Za-z_][A-Za-z0-9_]*|"[a-z_]+")/g;
  let m;
  while ((m = readRe.exec(body))) {
    const t = m[1].replace(/"/g, "");
    if ((consts.get(t) ?? t) === table) return true;
  }
  /**
   * 还有一种等价的证据：`domainPort(T)`。
   *
   * `domain-store.ts:630-634` 把它的语义写得很清楚：`domainPort()` 回答
   * "**现在能不能读/写**"，镜像未就绪时返回 null。所以
   * ```ts
   * const port = domainPort(TABLE);
   * if (port) { …; domainWrite(TABLE, rows, …); return; }
   * ```
   * 里那次写入的 `false` 同样是**不可达**的（第 55 轮实测：`account.ts::setActiveAccount`
   * 就是这一形态；不把它算进来就会留下一处假阳）。
   */
  const portRe = /domainPort\(\s*([A-Za-z_][A-Za-z0-9_]*|"[a-z_]+")/g;
  while ((m = portRe.exec(body))) {
    const t = m[1].replace(/"/g, "");
    if ((consts.get(t) ?? t) === table) return true;
  }
  return false;
}

export function scanWriteReturns(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "test") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, "src"));

  const findings = [];
  let sites = 0;
  let skippedSameTable = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = relative(root, f).replace(/\\/g, "/");
    const lines = src.split("\n");
    const consts = tableConstsOf(src);
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(src))) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      const callLine = lines[lineNo - 1] ?? "";
      if (isCommentLine(callLine)) continue;
      // 函数**定义**行不算调用点（`export function domainWrite(` / `function domainDelete(`）
      if (/^\s*(export\s+)?(async\s+)?function\s+domain(Write|Delete|WriteMany)/.test(callLine)) continue;
      sites++;

      const token = tableTokenOf(src, m.index);
      const body = enclosingFunctionBody(src, m.index);

      // 判据 1：同一函数里成功读过同一张表 ⇒ false 不可达
      if (token && readsSameTable(body, token, consts)) {
        skippedSameTable++;
        continue;
      }
      // 判据 2：返回值被处理（用了，且函数体内有上报）
      /**
       * ⚠️ "用了"必须看**调用点之前的一小段**：全仓的既有形态是多行写法
       * ```ts
       * if (
       *   domainDelete(TABLE, { id }, { … })
       * ) { return; }
       * reportWriteNotAccepted(…);
       * ```
       * 只看那一行会把它判成"没处理"（第 55 轮实测：`session.ts:372` / `:525` 就是被这么误报的）。
       */
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      const used =
        /=\s*domain(Write|Delete|WriteMany)|if\s*\(\s*$|if\s*\(\s*domain|return\s+domain|!\s*domain(Write|Delete)/.test(
          callLine,
        ) || /if\s*\(\s*$/.test(before);
      const reportedInside = REPORT_RE.test(body);
      if (used && reportedInside) continue;
      if (ALLOWLIST.some((a) => a.file === rel)) continue;
      findings.push({
        file: rel,
        line: lineNo,
        text: callLine.trim().slice(0, 100),
        used,
        reportedInside,
      });
    }
  }
  return { sites, skippedSameTable, findings, files: files.length };
}

function selfCheck() {
  const problems = [];
  const { sites, findings } = scanWriteReturns(ROOT);
  if (sites < SITES_MIN) {
    problems.push(`真仓库只抽到 ${sites} 个写入点（下界 ${SITES_MIN}）—— 抽取器疑似失效，"没问题"这句话就没有证据`);
  }
  // ① 跨表写入 + 不处理返回值 → 必须报（这就是本轮真缺陷的形态）
  const bug = scanWriteReturns(dirWith(
    "bug.ts",
    [
      "const T_A = \"sessions\";",
      "const T_B = \"projects\";",
      "export function bad(rows: any) {",
      "  const read = domainReadMany(T_A, (r: any) => r);",
      "  if (!read) return 0;",
      "  const ok = domainWrite(T_B, rows, { scope: \"x\", note: \"y\" });",
      "  if (ok) return 1;",
      "  return 0;",
      "}",
    ].join("\n"),
  ));
  if (bug.findings.length !== 1) {
    problems.push(`少报了：跨表写入不处理返回值必须被报出来（实际 ${bug.findings.length} 条）`);
  }
  // ② 同表先读后写 → false 不可达，不许报
  const sameTable = scanWriteReturns(dirWith(
    "same.ts",
    [
      "const T_A = \"sessions\";",
      "export function okSameTable(rows: any) {",
      "  const read = domainReadMany(T_A, (r: any) => r);",
      "  if (!read) return 0;",
      "  domainWrite(T_A, rows, { scope: \"x\", note: \"y\" });",
      "  return 1;",
      "}",
    ].join("\n"),
  ));
  if (sameTable.findings.length !== 0) problems.push("误报了：同表先读后写不该被报（false 不可达）");
  // ③ 带上报的形态 → 不许报
  const ok = scanWriteReturns(dirWith(
    "ok.ts",
    [
      "const T_A = \"sessions\";",
      "const T_B = \"projects\";",
      "export function good(rows: any) {",
      "  if (domainWrite(T_B, rows, { scope: \"x\", note: \"y\" })) return 1;",
      "  reportWriteNotAccepted(\"x\", \"y\");",
      "  return 0;",
      "}",
    ].join("\n"),
  ));
  if (ok.findings.length !== 0) problems.push("误报了：带上报的形态不该被报出来");
  return problems;
}

/** 造一个只含一个文件的临时仓库（供 canary 用） */
function dirWith(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "codem-write-return-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", name), content, "utf8");
  return dir;
}

export function runGate() {
  const canary = selfCheck();
  const { sites, skippedSameTable, findings, files } = scanWriteReturns(ROOT);
  console.log(
    `[write-return] 扫描 ${files} 个文件 / 写入点 ${sites} 处 / 其中同表先读后写（false 不可达）${skippedSameTable} 处 / ` +
      `未处理返回值的 ${findings.length} 处（允许清单 ${ALLOWLIST.length} 条）`,
  );
  for (const p of canary) console.error(`  ✗ canary：${p}`);
  for (const f of findings) {
    console.error(
      `  ✗ ${f.file}:${f.line} 写入点的返回值没被处理（也没在这个函数里上报）\n      ${f.text}\n` +
        `      → 加 `+'`if (domainWrite(...)) return …; reportWriteNotAccepted(scope, note);`' +
        ` 两行形态；若这一处**确实走不到 false**，请写进 ALLOWLIST 并说明理由`,
    );
  }
  const failed = canary.length > 0 || findings.length > 0;
  if (failed) {
    console.error(
      "\n为什么这条重要：`false` = 端口没接手这次写 → 行没进库。不处理返回值就等于" +
        "把它变成静默丢弃（第 55 轮在损坏恢复的项目写回点上真实发生过）。",
    );
  }
  return failed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--list")) {
    const r = scanWriteReturns(ROOT);
    console.log(JSON.stringify(r, null, 1));
    process.exit(0);
  }
  process.exit(runGate() ? 1 : 0);
}
