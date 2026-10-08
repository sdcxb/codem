/**
 * **`core/storage/settings` 的导出面与各处 mock 不许漂移**（本轮记忆系统重构后新增）。
 *
 * ## 现场（这一批三个红文件里的两个）
 *
 * 记忆系统重构给 `settings.ts` 加了 `loadMemoryChecked` / `saveMemoryConfirmed` /
 * `isMemoryDomainReady` / `loadRecoveryData` 之外的几个导出，而 `MemoryService` 的**构造函数**
 * 就会调 `loadMemoryChecked()`。任何"整体 mock 掉 settings、只补老几个导出"的用例文件，
 * 在 `new LLMEngine()`（内部 `getMemoryService()`）时当场抛：
 *
 * ```
 * Error: [vitest] No "loadMemoryChecked" export is defined on the "../core/storage/settings" mock.
 * ```
 *
 * 现场是 `forked-agent.test.ts`（5 条全红）与 `engine-catalog-injection.test.ts`（ENG-1..4 全红）。
 * 这类漂移**只在运行时炸**、而且往往被生产代码自己的 `catch` 吞成"走了另一条路"——
 * 于是用例红得指向错误的地方（`persist-failure-mock-parity.test.ts` 第 90 轮记的就是这个形态，
 * 这里是同一个洞在另一个模块上复现）。
 *
 * ## 判据（都是**解析式对账**，不是"文件里含某个字符串"）
 *
 * | id | 钉什么 | 变异（必须红） |
 * | --- | --- | --- |
 * | SMP-1 | 每个 `vi.mock("../core/storage/settings")` 的覆盖面，必须涵盖**被测代码实际会用到**的 settings 导出 | 从某个 mock 里删掉一个真实用到的导出 |
 * | SMP-2 | mock 里给出的每个名字都必须**真的**是 `settings.ts` 的导出（不许 mock 幻觉 API） | 往 mock 里塞一个不存在的名字 |
 * | SMP-3 | 反向对照：判据本身能识别出"缺一个导出"的 mock 源 | — |
 *
 * ## "被测代码实际会用到"是怎么算的（口径必须写清楚，否则这条判据就是一句话）
 *
 * 1. 入口：用例文件（`src/test/*.test.ts(x)`）；
 * 2. 沿**非 `import type`** 的 import 边做传递闭包（`type` 边在运行期被完全擦除，不该算）；
 * 3. 闭包里每个 `src/**` 的非测试模块，取它对 `core/storage/settings` 的**具名导入**，
 *    以及对 `import * as ns` 形式的 `ns.<名字>` 访问；
 * 4. 这些名字必须被该用例文件的 mock 覆盖 —— 覆盖来源有两个：
 *    - 站点自己的工厂体里 `名字:`（顶层键，2 空格缩进）**或** 它 `...spread` 进来的
 *      `createSettingsMock(...)`（共享基座，`src/test/settings-mock.ts`）；
 *    - `importOriginal` 透传（自动满足）。
 *
 * ⚠️ 口径的**已知代价（如实写，不藏）**：第 3 步是静态可达性，比"这一次运行真的调到了"
 * 要宽 —— 所以它要求 mock 补齐一些"本次没调到、但同一批代码随时可能调到"的导出
 * （如 `mergeDefaults` / `loadRecoveryData`）。这是**有意选的方向**：这类导出补一个
 * 同语义实现零风险，而漏一个的代价是"用例红得指向错误的地方"（见上）。反过来，
 * 宁可收紧也不放宽：漏报（真缺却没报）才是这条判据存在的意义。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const TEST_DIR = path.join(SRC, "test");
const SETTINGS_FILE = path.join(SRC, "core", "storage", "settings.ts");

// ============================ 1. 真实导出面 ============================

/**
 * `settings.ts` 的顶层导出名。
 *
 * 只认**带 `export` 关键字的声明**（`export function` / `const` / `class` / `interface` / `type`），
 * 以及 `export { a, b }` 形式的再导出 —— 不认注释里提到的名字。
 */
export function realSettingsExports(src: string): Set<string> {
  const names = new Set<string>();
  const decl =
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * `settings.ts` 里**只存在于类型层**的导出名（`interface` / `type` 别名，以及
 * `export type { … }` 再导出）。
 *
 * 必须把它们从"被测代码用到的导出"里剔掉：**运行期根本没有这些名字**
 * （`import type { MemoryReadResult } from "…/settings"` 被 TypeScript 完全擦除），
 * 要求 mock 去覆盖它们等于要求 mock 一个不存在的值 —— 第一版没剔，实测对
 * `forked-agent` / `engine-catalog-injection` 报出 4 条 `MemoryReadResult` / `QuickPhrase`
 * 之类的**假红**。
 */
export function typeOnlySettingsExports(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+type\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// ============================ 2. 源码解析（去注释/字符串，保留结构） ============================

/**
 * 把注释与字符串字面量换成等长空白。
 *
 * **这是"不含某字符串"式判据的解药**：任何"名字出现在注释/文案/日志里"都不算用到它。
 * 长度保持不变（不做删除），所以不需要另算偏移。
 */
export function stripNonCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ImportClause {
  spec: string;
  names: string[];
  namespaceAlias: string | null;
  typeOnly: boolean;
}

const IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

export function parseImports(text: string): ImportClause[] {
  const out: ImportClause[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const typeOnly = !!m[1];
    const clause = m[2];
    const spec = m[3];
    if (spec === "vitest") {
      // vitest 的具名导入不是被测代码；除 vi 之外没有别的用途，直接跳过
      continue;
    }
    const names: string[] = [];
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) names.push(name);
      }
    }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    out.push({ spec, names, namespaceAlias: ns ? ns[1] : null, typeOnly });
  }
  return out;
}

function resolveModule(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = path.resolve(SRC, spec.slice(2));
  else return null;
  for (const candidate of [
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ============================ 3. 传递闭包与被用到导出名 ============================

const fileCache = new Map<string, string>();
function readText(file: string): string {
  if (!fileCache.has(file)) fileCache.set(file, readFileSync(file, "utf8"));
  return fileCache.get(file)!;
}

/** 沿**非 type-only** import 边求传递闭包，只走 `src/**` */
export function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !file.startsWith(SRC)) continue;
    seen.add(file);
    for (const imp of parseImports(readText(file))) {
      if (imp.typeOnly) continue;
      const target = resolveModule(file, imp.spec);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

/** 某个模块**实际引用**到的 settings 导出名（具名导入 + `ns.名字` 访问） */
export function settingsNamesUsedBy(
  file: string,
  realNames: Set<string>,
  typeOnly: Set<string> = new Set(),
): Map<string, string> {
  const text = readText(file);
  const code = stripNonCode(text);
  const used = new Map<string, string>();
  for (const imp of parseImports(text)) {
    const target = resolveModule(file, imp.spec);
    if (!target || path.resolve(target) !== path.resolve(SETTINGS_FILE)) continue;
    for (const name of imp.names) {
      /**
       * ⚠️ **类型层的导出必须剔掉**：`import type { MemoryReadResult } …` 在运行期被完全擦除，
       * mock 里也不该（不需要）有它 —— 不剔会变成"要求 mock 一个不存在的值"，实测报假红。
       * 顺带：`typeOnly` 里的名字一律不算"被测代码会用到"。
       */
      if (realNames.has(name) && !typeOnly.has(name)) used.set(name, "具名导入");
    }
    if (imp.namespaceAlias) {
      const re = new RegExp(`\\b${imp.namespaceAlias}\\.([A-Za-z_$][\\w$]*)`, "g");
      for (const m of code.matchAll(re)) {
        if (realNames.has(m[1]) && !typeOnly.has(m[1])) used.set(m[1], "命名空间访问");
      }
    }
  }
  return used;
}

/** 用例文件闭包里所有非测试模块用到的 settings 导出 → 出处 */
export function neededSettingsExports(
  testFile: string,
  realNames: Set<string>,
  typeOnly: Set<string> = new Set(),
): Map<string, string> {
  const needed = new Map<string, string>();
  for (const file of runtimeClosure(testFile)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    if (file === testFile) continue;
    /**
     * ⚠️ **测试辅助模块不算"被测代码"**：`src/test/**` 下的共享基座
     * （`settings-mock.ts`）只是**被 import 的类型名**（`MemoryReadResult` / `QuickPhrase` /
     * `SettingsWriteProbe`）—— 把测试自己的脚手架算进"被测代码用到的导出"，
     * 会要求每个 mock 都去 mock 一堆**接口名**（第一次跑实测报了 4 条这种假红）。
     */
    if (file.startsWith(TEST_DIR)) continue;
    for (const [name, why] of settingsNamesUsedBy(file, realNames, typeOnly)) {
      if (!needed.has(name)) needed.set(name, `${path.relative(ROOT, file)}（${why}）`);
    }
  }
  return needed;
}

// ============================ 4. mock 站点 ============================

export interface SettingsMockSite {
  file: string;
  /** 工厂体源码 */
  body: string;
  /** 工厂里自己给出的顶层导出名（2 空格缩进的 `名字:`） */
  declared: Set<string>;
  /**
   * 工厂里**又把它们摘掉**的名字：`const { x: _y, ...rest } = createSettingsMock()` 与
   * `delete mock.x` / `Reflect.deleteProperty(mock, "x")` 三种写法。
   * 它们长得像"给出了"，实际是"移出了导出面" —— 必须扣掉（否则变异能骗过判据）。
   */
  dropped: Set<string>;
  /** 是否 `...spread` 了共享基座 `createSettingsMock(...)` */
  usesSharedBase: boolean;
  /** 是否 `importOriginal` 透传（那样自动满足覆盖） */
  passthrough: boolean;
  /** 是不是"只是从别处 import 进来的一个 mock 对象"（工厂体里没有对象字面量的 `名字:`） */
  aliasOnly: boolean;
}

const MOCK_CALL_RE =
  /vi\.mock\(\s*"((?:\.\.\/)+core\/storage\/settings)"\s*,\s*(async\s*)?\([^)]*\)\s*=>\s*([\s\S]*?)\n?\)\);/g;

/** 工厂体里"被摘掉"的导出名（解构重命名丢弃 / delete / Reflect.deleteProperty） */
export function droppedNames(body: string): Set<string> {
  const dropped = new Set<string>();
  // const { a: _x, b, ...rest } = createSettingsMock()
  const destructuring = /\{[^{}]*\}/g;
  for (const m of body.matchAll(destructuring)) {
    if (!/\.\.\.\s*\w+/.test(m[0])) continue; // 只有带 rest 的才是"摘掉一部分"
    for (const part of m[0].slice(1, -1).split(",")) {
      const pair = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
      // `{ loadMemoryChecked: _dropped, ...rest }` ⇒ loadMemoryChecked 被摘掉
      if (pair) dropped.add(pair[1]);
    }
  }
  for (const m of body.matchAll(/delete\s+[\w$.]*\.\s*([A-Za-z_$][\w$]*)/g)) dropped.add(m[1]);
  for (const m of body.matchAll(/Reflect\.deleteProperty\(\s*[\w$.]+\s*,\s*["']([A-Za-z_$][\w$]*)["']/g)) {
    dropped.add(m[1]);
  }
  return dropped;
}

export function settingsMockSites(dir = TEST_DIR): SettingsMockSite[] {
  const out: SettingsMockSite[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...settingsMockSites(full));
      continue;
    }
    if (!entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) continue;
    const text = readText(full);
    for (const m of text.matchAll(MOCK_CALL_RE)) {
      const body = m[3];
      const declared = new Set(
        [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1]),
      );
      const usesSharedBase = /createSettingsMock\s*\(/.test(body);
      out.push({
        file: path.relative(ROOT, full),
        body,
        declared,
        dropped: droppedNames(body),
        usesSharedBase,
        passthrough: /importOriginal/.test(body),
        aliasOnly: declared.size === 0 && !usesSharedBase && !/importOriginal/.test(body),
      });
    }
  }
  return out;
}

/**
 * 从工厂体里取"这个 mock **给出**了哪些 settings 导出"。
 *
 * 覆盖两种写法：
 * 1. 顶层键（2 空格缩进的 `名字:`）—— 手写 mock 与"基座 + 覆盖"都是这一种；
 * 2. `...createSettingsMock(...)` —— 共享基座。
 *
 * ⚠️ 还要**扣掉"被丢掉的"**：`const { loadMemoryChecked: _x, ...rest } = createSettingsMock()`
 * 这种写法里 `loadMemoryChecked` 也长得像"顶层键"，但它恰恰是被**移出**导出面的那一个。
 * 不扣的话，这条判据会被"把基座的某个导出摘掉"这种变异骗过去（实测第一版就是绿的）。
 */
export function mockedExports(site: SettingsMockSite, baseNames: Set<string>): Set<string> {
  const extracted = new Set(site.declared);
  if (site.usesSharedBase) for (const n of baseNames) extracted.add(n);
  for (const n of site.dropped) extracted.delete(n);
  return extracted;
}

/** 站点缺了哪些"被测代码实际会用到"的导出 */
export function missingExports(
  site: SettingsMockSite,
  needed: Map<string, string>,
  baseNames: Set<string>,
): string[] {
  if (site.passthrough) return [];
  const given = mockedExports(site, baseNames);
  return [...needed.keys()].filter((n) => !given.has(n)).sort();
}

// ============================ 5. 判据 ============================

const REAL_EXPORTS = realSettingsExports(readText(SETTINGS_FILE));
const TYPE_ONLY_EXPORTS = typeOnlySettingsExports(readText(SETTINGS_FILE));

/** 共享基座的覆盖：**运行时**从工厂拿（不是解析源码里的字符串） */
async function sharedBaseNames(): Promise<Set<string>> {
  const mod = await import("./settings-mock");
  return new Set(Object.keys(mod.createSettingsMock()));
}

describe("settings 导出面 × mock 面 不许漂移（解析式对账）", () => {
  it("SMP-1 每个 settings mock 都必须覆盖被测代码实际用到的导出", async () => {
    const baseNames = await sharedBaseNames();
    const sites = settingsMockSites();
    expect(sites.length, "一个 settings mock 都没找到 ⇒ 解析器失效（判据在空转）").toBeGreaterThan(20);

    const problems: string[] = [];
    for (const site of sites) {
      if (site.aliasOnly) {
        problems.push(`${site.file}：工厂体里既没有导出声明、也没有用共享基座（${site.body.trim().slice(0, 60)}…）`);
        continue;
      }
      const needed = neededSettingsExports(path.join(ROOT, site.file), REAL_EXPORTS, TYPE_ONLY_EXPORTS);
      const missing = missingExports(site, needed, baseNames);
      if (missing.length) {
        problems.push(
          `${site.file} 缺 ${missing.map((n) => `${n} ← ${needed.get(n)}`).join("；")}`,
        );
      }
    }
    expect(
      problems,
      "这些用例的 settings mock 少给了被测代码会调用的导出 —— 运行时会抛 " +
        '`No "…" export is defined on the "../core/storage/settings" mock`，' +
        "而且常常被生产代码的 catch 吞成『走了另一条路』，红得指向错误的地方：\n  " +
        problems.join("\n  "),
    ).toEqual([]);
  });

  it("SMP-2 mock 里给出的每个名字都必须是 settings 的真实导出（不许幻觉 API）", () => {
    const bad: string[] = [];
    for (const site of settingsMockSites()) {
      /**
       * ⚠️ **`spread 基座 + 覆盖`的站点也要查**：第一版对它们直接 `continue`，
       * 于是 `{ ...createSettingsMock(), loadMemoryCheked: vi.fn() }`（拼错一个字母）逃过了判据
       * —— 实测这条变异是绿的。`...spread` 只解释"基座带来的那些名字"，不解释**本文件自己写的**名字。
       */
      for (const name of site.declared) {
        if (!REAL_EXPORTS.has(name)) bad.push(`${site.file} → ${name}`);
      }
    }
    expect(bad, "mock 了一个 settings.ts 里不存在的导出名").toEqual([]);
  });

  it("SMP-2b 共享基座自己的导出面也必须是真实导出的子集", async () => {
    const baseNames = await sharedBaseNames();
    const fake = [...baseNames].filter((n) => !REAL_EXPORTS.has(n)).sort();
    expect(fake, "settings-mock.ts 的基座里出现了 settings.ts 没有的导出").toEqual([]);
    expect(baseNames.size, "基座一个导出都没有 ⇒ SMP-1 的覆盖判定会退化成空转").toBeGreaterThan(15);
  });

  it("SMP-3 反向对照：判据能识别出「缺一个导出」与「幻觉导出」", async () => {
    const baseNames = await sharedBaseNames();
    const needed = new Map([
      ["loadMemoryChecked", "core/memory/memory.ts（具名导入）"],
      ["getSetting", "core/storage/secret-store.ts（具名导入）"],
    ]);

    const badSite: SettingsMockSite = {
      file: "fixture.test.ts",
      body: "\n  getSetting: vi.fn(),\n",
      declared: new Set(["getSetting"]),
      dropped: new Set(),
      usesSharedBase: false,
      passthrough: false,
      aliasOnly: false,
    };
    expect(missingExports(badSite, needed, baseNames), "缺 loadMemoryChecked 必须被指出来").toEqual([
      "loadMemoryChecked",
    ]);

    const goodSite: SettingsMockSite = {
      file: "fixture.test.ts",
      body: "\n  ...createSettingsMock(),\n",
      declared: new Set(),
      dropped: new Set(),
      usesSharedBase: true,
      passthrough: false,
      aliasOnly: false,
    };
    expect(missingExports(goodSite, needed, baseNames), "spread 了基座就该算覆盖").toEqual([]);

    /**
     * 变异 2：`const { loadMemoryChecked: _x, ...rest } = createSettingsMock()` ——
     * "长得像给出了、其实摘掉了"。第一版判据在这条上是**绿的**（被文本形态骗过），
     * 现在靠 `dropped` 扣掉。
     */
    const dropBody = "\n  const { loadMemoryChecked: _dropped, ...rest } = createSettingsMock();\n  return rest;\n";
    const droppingSite: SettingsMockSite = {
      file: "fixture.test.ts",
      body: dropBody,
      declared: new Set(["loadMemoryChecked"]),
      dropped: droppedNames(dropBody),
      usesSharedBase: true,
      passthrough: false,
      aliasOnly: false,
    };
    expect(
      missingExports(droppingSite, needed, baseNames),
      "从基座里摘掉一个真实用到的导出必须被指出来",
    ).toEqual(["loadMemoryChecked"]);

    // 变异 3：`delete mock.getSetting` 同样必须被扣掉
    const deleteBody = "\n  const m = createSettingsMock();\n  delete m.getSetting;\n  return m;\n";
    expect([...droppedNames(deleteBody)]).toEqual(["getSetting"]);

    // 幻觉导出必须被抓住
    expect(REAL_EXPORTS.has("loadMemoryCheked"), "拼错的名字不许被当成真实导出").toBe(false);
    expect(REAL_EXPORTS.has("loadMemoryChecked")).toBe(true);
    // type-only 边不该把无关模块拖进来（否则 SMP-1 会大面积假红）
    expect(parseImports(readText(SETTINGS_FILE)).every((i) => typeof i.typeOnly === "boolean")).toBe(true);
  });

  it("SMP-4 口径自检：settings.ts 的真实导出面必须被解析出来（不是空集/过期名单）", () => {
    expect(REAL_EXPORTS.size, "解析不到导出 ⇒ 下面所有对账都是空转").toBeGreaterThan(20);
    // 本批新加的那几个必须在里面（判据不能对"新增导出"视而不见）
    for (const name of [
      "loadMemoryChecked",
      "saveMemoryConfirmed",
      "patchMemoryMirror",
      "writeMemoryConfirmed",
      "isMemoryDomainReady",
    ]) {
      expect(REAL_EXPORTS.has(name), `新导出 ${name} 没被解析到`).toBe(true);
    }
    /**
     * **类型层的导出必须单独识别**（`MemoryReadResult` / `QuickPhrase` / `SettingsWriteProbe`…）：
     * 它们在运行期不存在，不该要求 mock 覆盖（第一版没剔，实测报出 4 条假红）。
     * 反向也要钉住：真实的**值**导出绝不能被误判成类型层（否则就漏检了）。
     */
    for (const name of ["MemoryReadResult", "QuickPhrase", "SettingsWriteProbe", "SettingsWriteReport"]) {
      expect(TYPE_ONLY_EXPORTS.has(name), `${name} 应被识别为类型层导出`).toBe(true);
      expect(TYPE_ONLY_EXPORTS.has("loadMemoryChecked"), "值导出不许被当成类型层").toBe(false);
    }
  });
});
