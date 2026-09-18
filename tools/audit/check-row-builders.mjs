/**
 * 门禁：**行构造器必须覆盖它那张表的所有列**（第 54 轮立门）
 *
 * ## 为什么需要它
 *
 * 渲染侧 ~50 处写入几乎全部走 `xxxToWire(实体)` 这类**行构造器**，而构造器漏一列的后果
 * 取决于该写入点用哪个 `mode`（`domainWrite` 的默认是 **`"insert"`**）：
 *
 * | 路径 | 引擎侧行为 | 漏掉一列的后果 |
 * | --- | --- | --- |
 * | `mode: "insert"`（**默认**，建行路径用它） | 裸 `INSERT INTO` | 落库行 = 构造器给的列 ⇒ 漏列 = **静默 NULL** |
 * | `mode: "replace"` | 先 `UPDATE` 只写提供的列，0 行才 `INSERT`（`crud.rs:412-429`） | 未提供的列**保持原值** ⇒ 漏列不丢数据，但"清空一列"必须显式 null |
 * | 旧库导入（`INSERT OR REPLACE`，`migrate.rs:290`） | 真 `INSERT OR REPLACE` | 漏列 = 静默 NULL |
 *
 * 所以判据是"**构造器要把它那张表的每一列都写出来**"：insert 路径上这是硬要求，
 * replace 路径上这是"读写同一个形状"的不变量（也免得分辨调用点落在哪条路上）。
 *
 * ## 真凭实据（第 54 轮实测）
 *
 * `sessions.parent_id` 是迁移加的列，`sessionToWire` 里**没有**它，而建行路径是 insert：
 * ⇒ **带 `parentId` 的实体建出来的会话行里这一列永远是 NULL**。第 45 轮给子智能体补的
 * `sessions` 行正是这个形态：行建出来了，谱系却是 NULL，`session_trace` 永远报
 * `Parent: (root)`、队长会话的 `Descendants: []`（真机可复核）。
 *
 * ⚠️ **同轮自查更正**：本门禁初版的理由写的是"`replace` = `INSERT OR REPLACE`，
 * 所以改名/置顶/拖拽排序会把 `parent_id` 清成 NULL，谱系退回根"。**这句是错的** ——
 * 引擎的 `replace` 只写提供的列（上面的表 + 引擎用例
 * `crud_upsert_replace_does_not_cascade_delete_children` 断言"只给 title 时 project_id 不许被清空"），
 * 渲染侧镜像也是合并写（`rust-port.ts:2063`）。当时"会清空"的只有测试基座
 * （`fake-storage-port.ts` 把 replace 写成整行替换，比引擎更严格），
 * 于是**假端口造出了一个产品里不存在的缺陷**。基座已按引擎改正。
 * 门禁本身（构造器要覆盖所有列）成立，但理由必须用上面这张表里的真话。
 *
 * ## 判据
 *
 * 1. 从 `schema.sql` + `migrations.json` 取每张表的列（两处**都要**：迁移-only 列
 *    `sessions.execution_mode` / `messages.hidden` / `notebooks.group_id` … 在老库新库上都存在，
 *    只读 schema.sql 会把它们报成"表里没这个键"—— 第一版就是这么误报 5 条的）；
 * 2. 在渲染侧找"表常量 → 行构造器"配对：`domainWrite(T_X, [xxxToWire(...)]`；
 * 3. 比 **构造器返回对象的键集合** 与 **该表列集合**：
 *    - 少列 → **危险**（insert 路径上静默 NULL）；
 *    - 多列（表里没有的键）→ 也报（拼错列名 = 静默丢字段）。
 *
 * ## 几处"看不见的地方"必须**有界且可见**（不许静默跳过）
 *
 * - 构造器返回值里含 `...spread` 的：无法静态判定，**跳过但计数**；
 * - `domainWrite(T, [{ …临时拼的行 }])` 这种**内联行**：不判（对新建一行来说，可空列不给值
 *   = 落库 NULL，那正是想要的），**单独计数并打印**，超过 `INLINE_MAX` 就失败
 *   —— 否则"提取器把构造器全判成内联"会静默变成"没有发现问题"；
 * - 配对到了构造器、却在渲染侧解析不出这个构造器（改名、定义在别处）：
 *   **不静默丢**，列出来并计数，超过 `UNRESOLVED_MAX` 就失败 ——
 *   否则"解析器悄悄失效"与"代码没问题"在输出上完全一样（假绿）。
 *
 * ## 自检（canary）
 *
 * 提取器自己也可能失效（正则改坏了 → 0 配对 → 0 发现 → 绿灯）。
 * 所以本脚本**内置一组合成样例**先证明判据有牙：少列必须报、齐列必须不报、
 * 多列必须报、含展开必须跳过。canary 不过直接失败，不看真实数据。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "src-tauri", "codem-db", "sql", "schema.sql");

/**
 * 真实数据上的**下界**（第 54 轮实测值，见文件末的实测记录）。
 *
 * 这些数字不是"随便写一个"：提取器一旦失效（正则不匹配、目录改名、文件扩展名变了），
 * 配对数会掉到 0，而"0 配对 → 0 发现 → 退出码 0"正是最危险的假绿形态。
 * 掉到下界以下 ⇒ 提取器坏了，而不是"代码干净了"。
 */
const PAIRS_MIN = 40; // 实测 48
const BUILDERS_MIN = 20; // 实测 27
const UNRESOLVED_MAX = 0; // 实测：0（没有"配对到了却解析不出"的构造器）
const INLINE_MAX = 20; // 实测 7（内联行不判，但必须停在"少数"这一档）

/** 表名 → 列名[]（schema.sql 建表列 + migrations.json 的 ALTER 列） */
export function schemaColumns(sqlText, migText) {
  const out = {};
  for (const a of migText.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)) {
    (out[a[1]] = out[a[1]] ?? []).push(a[2]);
  }
  for (const m of sqlText.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = [];
    for (const line of m[2].split("\n")) {
      const c = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c[1])) cols.push(c[1]);
    }
    out[m[1]] = [...new Set([...(out[m[1]] ?? []), ...cols])];
  }
  return out;
}

/** 一个函数体里 `return { ... }`（或箭头函数直接返回对象）的顶层键 + 是否含展开 */
export function returnedKeys(text, fnStart) {
  const slice = text.slice(fnStart, fnStart + 4000);
  const retIdx = slice.search(/return\s*\{/);
  const arrowIdx = slice.search(/\)\s*(?::[^=]*)?=>\s*\(\s*\{/);
  const at = retIdx >= 0 ? slice.indexOf("{", retIdx) : arrowIdx >= 0 ? slice.indexOf("{", arrowIdx) : -1;
  if (at < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = at; i < slice.length; i++) {
    if (slice[i] === "{") depth++;
    else if (slice[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const body = slice.slice(at + 1, end);
  const keys = [];
  let hasSpread = false;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith("...")) hasSpread = true;
    const m = t.match(/^([a-z_][a-z0-9_]*)\s*[:,]/i);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return { keys, hasSpread };
}

/**
 * 一个文件里的写入点，分成两类（**分类必须显式，不许静默丢**）：
 *
 * - `kind: "builder"` —— `domainWrite(T_X, [xxxToWire(…)]`：行由**命名构造器**产出，
 *   这是本门禁能守、也必须守的形态；
 * - `kind: "inline"` —— `domainWrite(T_X, [{ …本地变量 }])`：行在调用点**上一行临时拼的**
 *   （典型：`const row: TodoListRow = {…}; domainWrite(T, [{ ...row }])`）。
 *   静态解析不出它的键集合，所以**不判**，但要**计数并打印**（有界、可见）。
 *
 * ## 为什么 inline 这一档可以"不判"（而不是偷懒）
 *
 * 本门禁要抓的缺陷是"**实体里带着的值被构造器丢了**"（`sessionToWire` 丢 `parent_id`）
 * 与"同一个构造器既用于建行又用于整行写回、于是必须写全"。
 * 而 inline 那一档几乎都是**新建一行的 insert**：对一条新行来说，某个可空列不给值
 * = 落库 NULL，这正是代码**想要**的（例如 `todo_lists.message_id`：
 * 这条待办本来就没有关联消息）。把它判成缺陷就是假阳。
 */
export function pairsFrom(text, rel, cols) {
  const tableConsts = new Map();
  for (const m of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z_]+)"/g)) {
    if (cols[m[2]]) tableConsts.set(m[1], m[2]);
  }
  const out = [];
  for (const m of text.matchAll(/domainWrite\(\s*([A-Z][A-Z0-9_]*)\s*,\s*\[([^\]]{0,200})/g)) {
    const table = tableConsts.get(m[1]);
    if (!table) continue;
    const body = m[2].trim();
    /*
     * ⚠️ 构造器必须**紧跟** `[`（允许空白）。
     *
     * 原来用的是 `body.match(/([A-Za-z_]\w*)\s*\(/)`（全串搜索），于是
     * `[{ ...row }]` 这种行会被"搜到"行字面量里的 `JSON.stringify(` ——
     * 报出一条 `stringify(…) → todo_lists` 的**假配对**（第 54 轮实测）。
     * 假配对比漏配对更坏：它指向一个不存在的构造器，读的人只能去猜。
     */
    const b = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body);
    if (b) out.push({ file: rel, table, builder: b[1], kind: "builder" });
    else out.push({ file: rel, table, builder: null, kind: "inline", head: body.slice(0, 40) });
  }
  return out;
}

/** 键集合 vs 表列集合 */
export function compare(builderKeys, tableCols) {
  return {
    missing: tableCols.filter((c) => !builderKeys.includes(c)),
    extra: builderKeys.filter((k) => !tableCols.includes(k)),
  };
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "test") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

// ============ 自检（canary）：先证明判据有牙，再看真实数据 ============

function selfCheck() {
  const problems = [];
  const cols = schemaColumns(
    `CREATE TABLE demo (\n id TEXT PRIMARY KEY,\n title TEXT\n);`,
    `[{"sql":"ALTER TABLE demo ADD COLUMN extra_col TEXT"}]`,
  );
  const demoCols = cols["demo"] ?? [];
  if (!demoCols.includes("extra_col")) {
    problems.push("迁移-only 列没被解析出来（migrations.json 解析失效）");
  }

  // 少列 → 必须报（列清单是有序的：迁移列在前，所以按集合比）
  const a = compare(["id"], demoCols);
  if ([...a.missing].sort().join(",") !== "extra_col,title") {
    problems.push(`少列样例没有如实报出（拿到 missing=${JSON.stringify(a.missing)}）`);
  }
  // 齐列 → 必须不报
  const b = compare(["id", "title", "extra_col"], demoCols);
  if (b.missing.length || b.extra.length) problems.push("齐列样例被误报");
  // 多列（拼错）→ 必须报
  const c = compare(["id", "title", "extra_col", "titel"], demoCols);
  if (c.extra.length !== 1 || c.extra[0] !== "titel") {
    problems.push(`拼错列名样例没有如实报出（拿到 extra=${JSON.stringify(c.extra)}）`);
  }
  // 配对提取器 → 必须真能配到
  const synthetic = `const T_DEMO = "demo";\ndomainWrite(T_DEMO, [demoToWire(d)], { mode: "replace" });`;
  const pairs = pairsFrom(synthetic, "synthetic.ts", cols);
  if (pairs.length !== 1 || pairs[0].builder !== "demoToWire" || pairs[0].table !== "demo") {
    problems.push(`配对提取器样例失效（拿到 ${JSON.stringify(pairs)}）`);
  }
  // 展开 → 解析出 hasSpread（据此跳过，而不是当成"齐列"）
  const spread = returnedKeys(`function demoToWire(d) {\n  return {\n    ...d,\n    id: d.id,\n  };\n}`, 0);
  if (!spread || !spread.hasSpread) problems.push("含展开的构造器没有被识别（会被误当成齐列 → 漏报真实缺列）");

  return problems;
}

/**
 * 跑一遍完整门禁，返回"是否失败"。
 *
 * ⚠️ **不能在模块顶层 `process.exit`**：`src/test/audit-gates.test.ts` 会 `import` 这个文件
 * 调里面的纯函数来证明"判据会咬"，顶层 exit 会把**测试进程**直接杀掉
 * （实测报错：`process.exit unexpectedly called with "1"`）。
 * 所以入口判定放在文件末（与 `check-command-parity.mjs` 同形）。
 */
export function runGate() {
  const canaryProblems = selfCheck();

  // ============ 真实数据 ============

  const cols = schemaColumns(
    readFileSync(SCHEMA, "utf8"),
    readFileSync(join(ROOT, "src-tauri", "codem-db", "sql", "migrations.json"), "utf8"),
  );

  // 迁移-only 列必须真在表列里（第 54 轮的两个当事人）
  let colsBroken = false;
  for (const [table, col] of [
    ["sessions", "parent_id"],
    ["sessions", "execution_mode"],
    ["messages", "hidden"],
  ]) {
    if (!(cols[table] ?? []).includes(col)) {
      console.error(`✗ 列清单里没有 ${table}.${col} —— migrations.json 解析失效，本门禁会漏报（拒绝放行）`);
      colsBroken = true;
    }
  }

  const files = walk(join(ROOT, "src"));
  const sites = [];
  const byBuilder = new Map();

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    sites.push(...pairsFrom(text, rel, cols));
    for (const m of text.matchAll(/(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      if (!/To(Wire|Row|Record)$/.test(name)) continue;
      const info = returnedKeys(text, m.index);
      // 按 file:name 作键：`sessionToWire` 在 `session.ts` 与 `v2-session.ts` 里各有一个，只按名字会串味
      if (info) byBuilder.set(`${rel}:${name}`, { file: rel, ...info });
    }
  }

  const pairs = sites.filter((s) => s.kind === "builder");
  const inlineSites = sites.filter((s) => s.kind === "inline");
  const findings = [];
  const unresolved = [];
  let skippedSpread = 0;

  for (const p of pairs) {
    const b = byBuilder.get(`${p.file}:${p.builder}`);
    if (!b) {
      unresolved.push(p);
      continue;
    }
    if (b.hasSpread) {
      skippedSpread++;
      continue; // 含展开：无法静态判定，跳过（计数上报，不当成失败）
    }
    const { missing, extra } = compare(b.keys, cols[p.table] ?? []);
    if (missing.length || extra.length) {
      findings.push({ file: b.file, builder: p.builder, table: p.table, missing, extra });
    }
  }

  console.log(
    `[row-builders] 写入点 ${sites.length} 处（构造器 ${pairs.length} / 内联 ${inlineSites.length}）/ ` +
      `解析出 ${byBuilder.size} 个构造器 / 含展开跳过 ${skippedSpread} / 未解析 ${unresolved.length} / ` +
      `发现问题 ${findings.length}`,
  );

  if (canaryProblems.length) {
    console.error("\n✗ 自检不过（判据本身失效，真实数据不可信）：");
    for (const p of canaryProblems) console.error(`   - ${p}`);
  }

  if (pairs.length < PAIRS_MIN || byBuilder.size < BUILDERS_MIN) {
    console.error(
      `\n✗ 提取器疑似失效：配对数 ${pairs.length}（下界 ${PAIRS_MIN}）、` +
        `构造器 ${byBuilder.size}（下界 ${BUILDERS_MIN}）—— 掉到下界以下意味着"没发现问题"这句话没有证据。`,
    );
  }

  if (unresolved.length > UNRESOLVED_MAX) {
    console.error(
      `\n✗ 有 ${unresolved.length} 处写入的构造器解析不出（上限 ${UNRESOLVED_MAX}）—— 这些写入没有被守：`,
    );
    for (const u of unresolved) console.error(`   - ${u.file}: ${u.builder}(…) → ${u.table}`);
  }

  if (inlineSites.length > INLINE_MAX) {
    console.error(
      `\n✗ 内联行写入点 ${inlineSites.length} 处（上限 ${INLINE_MAX}）—— 可能提取器把构造器误判成内联了：`,
    );
    for (const s of inlineSites) console.error(`   - ${s.file}: ${s.head}… → ${s.table}`);
  }

  for (const f of findings) {
    console.error(`\n✗ ${f.builder} → ${f.table}（${f.file}）`);
    if (f.missing.length) {
      console.error(`   少列（insert 路径上落库就是 NULL）：${f.missing.join(", ")}`);
    }
    if (f.extra.length) console.error(`   多列（表里没有这个键）：${f.extra.join(", ")}`);
  }

  const failed =
    colsBroken ||
    findings.length > 0 ||
    canaryProblems.length > 0 ||
    pairs.length < PAIRS_MIN ||
    byBuilder.size < BUILDERS_MIN ||
    unresolved.length > UNRESOLVED_MAX ||
    inlineSites.length > INLINE_MAX;

  if (failed) {
    console.error(
      "\n修法：在对应的 `xxxToWire` 里把缺的列补上（读-改-写的写入点必须**整行**写回；" +
        "要清空某列时见 `updateSession` 对 `message_count` 的处置：显式 delete 或显式 null，" +
        "而不是让构造器漏掉它 —— `replace` 路径上省略键 = 保持原值，清不掉）。",
    );
  }
  return failed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(runGate() ? 1 : 0);
}
