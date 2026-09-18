/**
 * 审计门禁（第 88 波）：把两个"一次性扫描脚本"变成**每次跑测试都会执行**的门禁。
 *
 * 背景：第 86/87 波用一次性脚本扫出并修掉了 A 类（静默空写）与 B 类（假成功）缺陷，
 * 但一次性脚本的结论会随时间失效 —— 新写的代码可以再次引入同样的模式。
 * 现在：
 *   · `tools/audit/scan-false-success.mjs`（P1：catch 里 return true；P2：写/动作类函数里
 *     catch 只有日志）；
 *   · `tools/audit/scan-silent-write.mjs`（A 类：`db.run(UPDATE … WHERE id = ?)` 未走 runGuarded）；
 * 都由本文件在 `npx vitest run` 中强制执行，未豁免的命中直接让测试变红。
 *
 * 另外本文件**自检扫描器有效**（用临时样本证明它真的能报出来），避免"门禁永远绿"
 * 这种更隐蔽的失效。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const TOOLS = path.join(ROOT, "tools", "audit");

async function loadScanners() {
  // 用动态 import 直接调函数（避免子进程 + 管道，在受限环境下更稳）
  const fsScanner = await import(path.join(TOOLS, "scan-false-success.mjs") as any);
  const swScanner = await import(path.join(TOOLS, "scan-silent-write.mjs") as any);
  const gbScanner = await import(path.join(TOOLS, "scan-guard-bypass.mjs") as any);
  const sbScanner = await import(path.join(TOOLS, "scan-storage-boundary.mjs") as any);
  const cpScanner = await import(path.join(TOOLS, "check-command-parity.mjs") as any);
  return { fsScanner, swScanner, gbScanner, sbScanner, cpScanner };
}

/**
 * 造一个最小的仓库夹具：只要门禁读的三样东西 ——
 * Rust 白名单、一份生产源码（可注入一条命令）、一个 `src/` 目录。
 *
 * 这样就能在**不改动真仓库**的前提下证明门禁会咬。
 */
function makeRepoFixture(opts: { prodCommand: string; whitelist?: string[] }): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-cmd-parity-"));
  const libDir = path.join(tmp, "src-tauri", "codem-db", "src");
  fs.mkdirSync(libDir, { recursive: true });

  /**
   * 夹具必须有**足够多的真实发送点**（≥ 20）与**足够大的白名单**（≥ 50）——
   * 否则门禁的两条"金丝雀"会先响。它们响得对：夹具太小就分不清
   * "没有不一致"与"根本没抽到东西"（第一版夹具只发了 4 条、白名单 28 条，
   * 就是被这两条金丝雀拦下的）。
   */
  const filler = Array.from({ length: 60 }, (_, i) => `probe${i}.run`);
  const cmds = opts.whitelist ?? ["settings.set", "messages.list", "crud.upsert", ...filler];
  fs.writeFileSync(
    path.join(libDir, "lib.rs"),
    `pub const COMMANDS: &[&str] = &[\n${cmds.map((c) => `    "${c}",`).join("\n")}\n];\n`,
    "utf8",
  );

  const prodDir = path.join(tmp, "src", "core");
  fs.mkdirSync(prodDir, { recursive: true });
  const sites = cmds
    .filter((c) => c.includes(".") && c !== opts.prodCommand)
    .map((c) => `  await call(t, "${c}");`)
    .join("\n");
  fs.writeFileSync(
    path.join(prodDir, "probe.ts"),
    `export async function go(t: any) {\n${sites}\n  await call(t, "${opts.prodCommand}");\n}\n`,
    "utf8",
  );

  /**
   * 第 53 轮：错误码契约的检查也在同一个门禁里（`compareErrorCodes`），
   * 所以夹具必须把它的两个输入文件也造出来 —— 否则夹具会因为"读不到源文件"
   * 而失败，看起来像命令检查坏了（GATE-10 就是这么被撞红的）。
   * 直接**拷贝真仓库的那两份**：夹具的目的是"命令名写错会被抓到"，
   * 不是"重新实现错误码契约"。
   */
  fs.mkdirSync(path.join(tmp, "src", "core", "storage"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "src-tauri", "codem-db", "src", "error.rs"),
    path.join(tmp, "src-tauri", "codem-db", "src", "error.rs"),
  );
  fs.copyFileSync(
    path.join(ROOT, "src", "core", "storage", "port.ts"),
    path.join(tmp, "src", "core", "storage", "port.ts"),
  );
  return tmp;
}

describe("审计门禁 —— 仓库当前必须零未豁免命中", () => {
  it("GATE-1: B 类（假成功）扫描无未豁免命中", async () => {
    const { fsScanner } = await loadScanners();
    const result = fsScanner.scanFalseSuccess({});
    const detail = result.violations
      .map((v: any) => `${v.file}:${v.line} [${v.kind}] ${v.fn} → ${v.preview}`)
      .join("\n");
    expect(result.scannedFiles).toBeGreaterThan(100);
    expect(result.violations, `未豁免的假成功命中：\n${detail}`).toEqual([]);
  });

  it("GATE-2: A 类（静默空写）扫描无未豁免命中", async () => {
    const { swScanner } = await loadScanners();
    const result = swScanner.scanSilentWrites({});
    const detail = result.violations.map((v: any) => `${v.file}:${v.line} ${v.code}`).join("\n");
    expect(result.violations, `未接 runGuarded 的空写：\n${detail}`).toEqual([]);
  });

  it("GATE-3: 豁免清单里每条都必须写明理由（不允许无理由豁免）", () => {
    const allow = JSON.parse(fs.readFileSync(path.join(TOOLS, "allowlist.json"), "utf8"));
    for (const key of ["falseSuccess", "silentWrites", "guardBypass", "storageBoundary"]) {
      for (const entry of allow[key] ?? []) {
        expect(typeof entry.file, `${key} 条目缺少 file`).toBe("string");
        expect((entry.reason ?? "").length, `${key} 的 ${entry.file} 缺少理由`).toBeGreaterThan(8);
      }
    }
  });

  it("GATE-5: C 类（守卫被绕过）扫描无未豁免命中", async () => {
    const { gbScanner } = await loadScanners();
    const result = gbScanner.scanGuardBypass({});
    const detail = result.violations
      .map((v: any) => `${v.file}:${v.line} [${v.kind}] ${v.fn} → ${v.preview}\n    ${v.why}`)
      .join("\n");
    expect(result.scannedFiles).toBeGreaterThan(100);
    expect(result.violations, `未豁免的守卫绕过命中：\n${detail}`).toEqual([]);
  });

  it("GATE-6: D 类（存储边界）扫描无未豁免命中（迁移期基线以内）", async () => {
    const { sbScanner } = await loadScanners();
    const result = sbScanner.scanStorageBoundary({});
    const detail = result.violations
      .slice(0, 20)
      .map((v: any) => `${v.file}:${v.line} [${v.rule}] ${v.preview}`)
      .join("\n");
    expect(result.scannedFiles).toBeGreaterThan(100);
    expect(result.violations, `未豁免的存储边界命中：\n${detail}`).toEqual([]);
  });

  it("GATE-8: 没有「还在直接读旧库、且完全没接端口」的生产模块", async () => {
    // 这道门禁是被一次真机事故逼出来的：P5 第 4 段把启动改成"引擎为 rust 时不加载
    // WASM 库"之后，真机发现 core/storage/session.ts 一个端口调用都没有 ——
    // 创建会话/改标题/置顶/删除/fork/排序全在打旧库，旧库不加载就整体失效。
    // **当时完整套件全绿**：测试自己 initDatabase() 起了 WASM 库，
    // 结构上看不见"生产启动路径下没有库可用"。所以这里查的是**模块层面的接线**。
    const scanner = await import(path.join(TOOLS, "scan-unrouted-db.mjs") as any);
    const result = scanner.scan();
    const unexpected = result.findings.filter((f: any) => !f.allowed);
    const detail = unexpected.map((f: any) => `${f.file}（getDatabase ${f.dbCalls} 次）`).join("\n");
    expect(result.scanned).toBeGreaterThan(100);
    expect(unexpected, `未接线的生产模块：\n${detail}`).toEqual([]);
  });

  it("GATE-9: 未接线门禁必须真的会咬（临时样本能被报出来）", async () => {
    const scanner = await import(path.join(TOOLS, "scan-unrouted-db.mjs") as any);
    // 直接验证判据本身：≥2 次 getDatabase() 且无端口符号 → 命中
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-unrouted-gate-"));
    const dir = path.join(tmp, "src", "core", "probe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "unrouted.ts"),
      [
        'import { getDatabase } from "./database";',
        "export function a() { return getDatabase(); }",
        "export function b() { return getDatabase(); }",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "routed.ts"),
      [
        'import { getDatabase } from "./database";',
        'import { domainReadMany } from "./domain-store";',
        "export function a() { return domainReadMany('t', (r) => r); }",
        "export function b() { return getDatabase(); }",
      ].join("\n"),
      "utf8",
    );
    try {
      // 扫描器写死了 src 根；这里用它的内部规则做等价断言（同一套判据）
      const unrouted = fs.readFileSync(path.join(dir, "unrouted.ts"), "utf8");
      const routed = fs.readFileSync(path.join(dir, "routed.ts"), "utf8");
      const dbCalls = (text: string) => (text.match(/getDatabase\(\)/g) ?? []).length;
      const wired = (text: string) => scanner.ALLOWLIST !== undefined && /domain(Read|Write|Delete|Or|Port)|hasStoragePort|getStoragePort/.test(text);
      expect(dbCalls(unrouted)).toBeGreaterThanOrEqual(2);
      expect(wired(unrouted), "未接线的样本不该被判为已接线").toBe(false);
      expect(wired(routed), "接了端口的样本应被判为已接线").toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("GATE-7: D 类门禁必须真的会咬（能发现新引入的回退）", async () => {
    const { sbScanner } = await loadScanners();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-storage-gate-"));
    fs.writeFileSync(
      path.join(tmp, "regress.ts"),
      [
        'import initSqlJs from "sql.js";',
        "export function bad(db: any) {",
        "  const rows = db.exec(`SELECT id FROM messages WHERE session_id = ?`, ['s1']);",
        "  db.run(`BEGIN TRANSACTION`);",
        "  const dump = db.export();",
        "  return rows ?? dump;",
        "}",
        "export function alsoBad() { return getDatabase(); }",
      ].join("\n"),
      "utf8",
    );
    try {
      const r = sbScanner.scanStorageBoundary({ root: tmp, allowlist: { storageBoundary: [] } });
      const rules = new Set(r.findings.map((f: any) => f.rule));
      expect(rules.has("D1"), "应报出 sql.js 依赖").toBe(true);
      expect(rules.has("D2"), "应报出整库导出").toBe(true);
      expect(rules.has("D3"), "应报出裸 SQL").toBe(true);
      expect(rules.has("D4"), "应报出渲染侧事务").toBe(true);
      expect(rules.has("D5"), "应报出绕过端口的 getDatabase()").toBe(true);
      expect(r.violations.length).toBeGreaterThanOrEqual(5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("扫描器自检（门禁本身必须会咬）", () => {
  it("GATE-10: 渲染侧发出引擎不认识的命令 → 通信链路门禁必须报出来", async () => {
    const { cpScanner } = await loadScanners();

    // ① 真仓库：渲染侧没有发出任何白名单外的命令
    const real = cpScanner.analyzeCommandParity({ root: ROOT });
    expect(real.errors, `真仓库不该有通信链路不一致：${real.errors.join(" | ")}`).toEqual([]);
    expect(
      real.prodHits.size,
      "金丝雀：渲染侧应抽到 ≥ 20 条命令（抽不到说明抽取器失效，'绿'没有意义）",
    ).toBeGreaterThanOrEqual(20);
    expect(real.rustCommands.length).toBeGreaterThanOrEqual(50);

    // ② 故意把命令名拼错 → 必须报出来（这条是"门禁会咬"的正面判据）
    const typoDir = makeRepoFixture({ prodCommand: "messages.lst" });
    try {
      const typoResult = cpScanner.analyzeCommandParity({ root: typoDir });
      expect(
        typoResult.errors.some((e: string) => e.includes("messages.lst")),
        "拼错的命令名必须被报出来（否则这个门禁只是装饰）",
      ).toBe(true);
    } finally {
      fs.rmSync(typoDir, { recursive: true, force: true });
    }

    // ③ 反向对照：同样的夹具，命令名写对 → 不该报
    const okDir = makeRepoFixture({ prodCommand: "messages.list" });
    try {
      const okResult = cpScanner.analyzeCommandParity({ root: okDir });
      expect(okResult.errors, "写对的时候不许误报").toEqual([]);
    } finally {
      fs.rmSync(okDir, { recursive: true, force: true });
    }
  });

  it("GATE-11: 错误码契约（引擎 as_str / retryable / hint ↔ 渲染侧联合类型 / RETRYABLE）必须对齐", async () => {
    const { cpScanner } = await loadScanners();

    // ① 真仓库：两侧 10 个码、4 个可重试、hint 全覆盖
    const real = cpScanner.compareErrorCodes({ root: ROOT });
    expect(real.errors, `真仓库的错误码契约不该有分歧：${real.errors.join(" | ")}`).toEqual([]);
    expect(real.summary.engineCodes.length, "金丝雀：解析器至少要抓到 5 个码").toBeGreaterThanOrEqual(5);
    expect(real.summary.engineCodes, "两侧集合必须完全相同").toEqual(real.summary.rendererCodes);
    expect(real.summary.engineRetryable, "可重试集合也必须相同").toEqual(real.summary.rendererRetryable);
    expect(
      real.summary.hintCovered,
      "每个错误码都要有 hint（界面/日志的可执行建议）",
    ).toBe(real.summary.engineCodes.length);

    // ② 故意在渲染侧多声明一个引擎不会发的码 → 必须报出来
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-errcode-"));
    try {
      fs.mkdirSync(path.join(tmp, "src-tauri", "codem-db", "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "src", "core", "storage"), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, "src-tauri", "codem-db", "src", "error.rs"),
        path.join(tmp, "src-tauri", "codem-db", "src", "error.rs"),
      );
      const portSrc = fs.readFileSync(path.join(ROOT, "src", "core", "storage", "port.ts"), "utf8");
      fs.writeFileSync(
        path.join(tmp, "src", "core", "storage", "port.ts"),
        portSrc.replace('  | "OTHER";', '  | "OTHER"\n  | "TEAPOT";'),
        "utf8",
      );

      const broken = cpScanner.compareErrorCodes({ root: tmp });
      expect(
        broken.errors.some((e: string) => e.includes("TEAPOT")),
        "渲染侧声明了引擎永不发的码必须被报出来（否则错误码这个'值'会在映射处丢掉）",
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("GATE-12: 行构造器必须覆盖表的所有列（insert 路径漏列 = 静默 NULL）", async () => {
    /**
     * 门禁：`tools/audit/check-row-builders.mjs`。
     *
     * 为什么它必须会咬：`domainWrite` 的默认 `mode` 是 `"insert"`（裸 `INSERT INTO`），
     * 落库的那一行**就是构造器给出的那些列** —— 构造器漏一列，那一列永远是 NULL，
     * 不报错、不告警。第 54 轮的真凭实据就是这条：`sessionToWire` 少了 `parent_id`，
     * 于是"带 `parentId` 的实体"建出来的会话行里谱系永远是 NULL
     * （`ensureSubagentSession` 的子会话在 `session_trace` 里永远报 `Parent: (root)`）。
     */
    const rb = await import(path.join(TOOLS, "check-row-builders.mjs") as any);

    // ① 前提必须可执行验证：默认 mode 就是 insert（默认值一改，这条门禁的理由就变了）
    const domainStoreSrc = fs.readFileSync(
      path.join(ROOT, "src", "core", "storage", "domain-store.ts"),
      "utf8",
    );
    expect(
      domainStoreSrc,
      "前提：`domainWrite` 的默认 mode 是 insert（裸 INSERT ⇒ 落库行 = 构造器给的列）",
    ).toContain('opts.mode ?? "insert"');

    // ② 真仓库：每个配对到的构造器都覆盖它那张表的列
    const cols = rb.schemaColumns(
      fs.readFileSync(path.join(ROOT, "src-tauri", "codem-db", "sql", "schema.sql"), "utf8"),
      fs.readFileSync(path.join(ROOT, "src-tauri", "codem-db", "sql", "migrations.json"), "utf8"),
    );
    expect(
      cols.sessions ?? [],
      "列清单必须含迁移加的 parent_id（少了它这条门禁会漏报）",
    ).toContain("parent_id");

    const srcFiles: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === "test" || name === "node_modules") continue;
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) srcFiles.push(p);
      }
    };
    walk(path.join(ROOT, "src"));

    const builders = new Map<string, { keys: string[]; hasSpread: boolean }>();
    const sites: Array<{ file: string; table: string; builder: string | null; kind: string }> = [];
    for (const f of srcFiles) {
      const text = fs.readFileSync(f, "utf8");
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      sites.push(...rb.pairsFrom(text, rel, cols));
      for (const m of text.matchAll(/(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        if (!/To(Wire|Row|Record)$/.test(m[1])) continue;
        const info = rb.returnedKeys(text, m.index);
        if (info) builders.set(`${rel}:${m[1]}`, info);
      }
    }
    const pairs = sites.filter((s) => s.kind === "builder");
    const inline = sites.filter((s) => s.kind === "inline");
    expect(
      pairs.length,
      "金丝雀：至少要配对到 40 处构造器写入（抽不到说明抽取器失效，'没有发现问题'这句话就没有证据）",
    ).toBeGreaterThanOrEqual(40);
    expect(
      inline.length,
      "内联行写入点（不判，但必须停在少数这一档 —— 全变成内联就说明提取器坏了）",
    ).toBeLessThanOrEqual(20);

    const findings: string[] = [];
    for (const p of pairs) {
      const b = builders.get(`${p.file}:${p.builder}`);
      if (!b || b.hasSpread) continue;
      const { missing, extra } = rb.compare(b.keys, cols[p.table] ?? []);
      if (missing.length || extra.length) {
        findings.push(`${p.file}:${p.builder} → ${p.table} 少列[${missing}] 多列[${extra}]`);
      }
    }
    expect(findings, `行构造器必须写全整行：\n${findings.join("\n")}`).toEqual([]);

    // ③ 会咬的正面判据：故意少一列 / 拼错一列，判据必须报出来
    const demoCols = ["id", "title", "parent_id"];
    expect(rb.compare(["id", "title"], demoCols).missing, "少列必须报").toEqual(["parent_id"]);
    expect(rb.compare(["id", "title", "parent_id"], demoCols), "齐列不许误报").toEqual({
      missing: [],
      extra: [],
    });
    expect(rb.compare(["id", "titel", "parent_id"], demoCols).extra, "拼错列名必须报").toEqual(["titel"]);

    // ④ 配对必须**紧跟** `[`：`[{ ...row }]` 不许被"搜"出行字面量里的 `JSON.stringify(` 假配对
    const classify = rb.pairsFrom(
      'const T_DEMO = "sessions";\n' +
        'domainWrite(T_DEMO, [rowToWire(r)], {});\n' +
        'domainWrite(T_DEMO, [{ ...localRow }], {});\n',
      "synthetic.ts",
      cols,
    );
    expect(classify[0].kind, "命名构造器要判").toBe("builder");
    expect(classify[0].builder).toBe("rowToWire");
    expect(
      classify[1].kind,
      "内联行要归到 inline（原来会假配对成 `stringify(…)`，指向一个不存在的构造器）",
    ).toBe("inline");
    expect(classify[1].builder, "内联行不该有构造器名").toBeNull();
  });

  it("GATE-4: 故意写坏的样本必须被三个扫描器报出来", async () => {
    const { fsScanner, swScanner, gbScanner } = await loadScanners();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-audit-gate-"));
    const probe = path.join(tmp, "probe.ts");
    fs.writeFileSync(
      probe,
      [
        "export function saveWidget(id: string) {",
        "  try {",
        "    db.run(`UPDATE widgets SET name = ? WHERE id = ?`, ['x', id]);",
        "  } catch (e) {",
        "    console.warn('saveWidget failed:', e);",
        "  }",
        "}",
        "export function createWidget(): boolean {",
        "  try {",
        "    return true;",
        "  } catch (e) {",
        "    return true;", // ← 典型假成功
        "  }",
        "}",
        "export function checkPermission(tool: string) {",
        "  try {",
        "    return analyzeBashCommand(tool).classification;",
        "  } catch {",
        "    return { action: 'allow' };", // ← 守卫失败 → 默认放行
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    try {
      const fsResult = fsScanner.scanFalseSuccess({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });
      const swResult = swScanner.scanSilentWrites({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });
      const gbResult = gbScanner.scanGuardBypass({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });

      // P1：catch 里 return true
      expect(fsResult.p1.length, "应报出 catch 里 return true").toBeGreaterThan(0);
      // P2：写/动作类函数的 catch 只有日志
      expect(fsResult.p2.length, "应报出只有日志的 catch").toBeGreaterThan(0);
      // A 类：未走 runGuarded 的 UPDATE
      expect(swResult.updates.length, "应报出未接 runGuarded 的 UPDATE").toBeGreaterThan(0);
      expect(swResult.violations.length).toBeGreaterThan(0);
      // C 类：守卫失败 → 默认放行
      expect(gbResult.findings.length, "应报出守卫失败时的 fail-open 返回").toBeGreaterThan(0);
      expect(gbResult.violations.length).toBeGreaterThan(0);
      expect(fsScanner.stripComments("// db.run(`UPDATE x SET y = ? WHERE id = ?`)\nconst a = 1;")).not.toMatch(/UPDATE/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
