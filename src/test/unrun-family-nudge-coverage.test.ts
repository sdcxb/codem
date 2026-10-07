/**
 * 第 41 波：`unrun-family` 收尾提醒的**文案必须自洽** ✓ —— 真机读数驱动 ✓（不是推断 ✗）。
 *
 * ## 为什么（一条能逐字对上的证据链 ✓）
 *
 * `repo-02` / run-2（`1.16.289` ✓，**败** ✗）的控制台侧车（`.console.jsonl`）里逐字留着：
 * ```
 * 收尾：族里没跑过的判据 {"family":"repro","unrun":50,
 *                        "sample":["src/test/core-chat-message-storage.test.ts", …]}
 * ```
 * 而**紧接着**模型跑的那条命令就是提醒里给它的那条 ✓：
 * ```
 * [AgenticLoop] Tool executed: bash, path: npx vitest run "src/test/repro-*.test.ts" 2>&1 | …
 *              output length: 101      ← ★ 没跑出东西（101 字节 ≈ 一句"没有匹配文件"✓）
 * ```
 * ⇒ ★ **提醒说的族（`repro-*`）与它点名列出的缺口（`core-*`）不是一回事** ✗ ——
 * 模型**照做了**，却一条缺口都没补上 ✓；而 `unrunSiblingsNudged` 已经置位 ⇒ **不再提醒** ✓
 * ⇒ 那一轮 35 轮就收尾 ✗（通过的两轮是 79 / 99 轮 ✓，§13.245/13.246 的靶子 ✓）。
 *
 * 根因在 `agentic-loop.ts`：缺口列表 `unrun` 取的是**所有跑过的族**的并集 ✓，
 * 而族名取的是 `ranFamilies[0]` ✗（**跑过的第一条**判据的族 ✗）——
 * 两个集合的来路不同 ⇒ 文案必然可能自相矛盾 ✗。
 *
 * ## 判据（每一条都钉"模型看到的那句话"✓，不是钉某个中间变量 ✗）
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `UNC-1` | 命令里的过滤器 **覆盖它自己点名的每一条缺口的族** ✓ | 族名取单个元素（`ranFamilies[0]` ✗） |
 * | `UNC-2` | 反向对照：**单族**输入 ⇒ 恰好一个过滤器（正常路径不许被改坏 ✗） | 无条件罗列所有族 ⇒ 红 |
 * | `UNC-3` | `.tsx` 判据也在覆盖范围内 ✓ | 过滤器带上扩展名 ⇒ 红 |
 * | `UNC-4` | 空输入 ⇒ **不产出**提醒 ✓ | 无条件产文案 ⇒ 红 |
 * | `UNC-5` | 结构：那句话**只由** `buildUnrunFamilyNudge` 造 ✓（循环里不许再手写一份 ✗） | 循环里内联模板 ⇒ 红 |
 * | `UNC-6` | 文案里两个计数（跑过 / 没跑）与实际输入一致 ✓ | 计数写死 ⇒ 红 |
 * | `UNC-7` | ★ 命令**真的能跑出东西**：过滤器里不许有通配符 ✓（vitest 位置参数是**子串匹配** ✗ 不是 glob） | 写成 `dsh-*.test.ts` ⇒ 红 |
 *
 * ## `UNC-7` 的实测依据（**这一条是第二遍才补上的** ✗→✓）
 *
 * 第一版修复我把过滤器写成了 `src/test/dsh-*` ✓（以为 vitest 认 glob ✗），实测：
 * ```
 * npx vitest list 'src/test/dsh-*.test.ts'   ⇒ 0 个文件 ✗
 * npx vitest list 'src/test/dsh-'            ⇒ 137 条测试 ✓
 * npx vitest list 'src/test/chunk-' 'src/test/app-'  ⇒ 5 个文件 ✓（2 + 3 ⇒ 多参数是"或"✓）
 * npx vitest list 'src/test/app-'            ⇒ 3 个文件，其中 2 个是 `.tsx` ✓
 * ```
 * ⇒ ★ 旧文案那条命令**从来就跑不出东西** ✗ —— 与真机侧车里的 `output length: 101` 逐字吻合 ✓。
 * ⇒ 所以"命令可执行"必须是**判据** ✓，不能靠我"记得 vitest 怎么解析参数"✗。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUnrunFamilyNudge } from "../core/llm/task-keyword-search";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = process.cwd();

/**
 * 从文案里抠出建议命令里的**过滤器** ✓（单引号里那几段 ✓）。
 *
 * ⚠️ 刻意**不**去读构建函数的中间变量 ✗：要钉的是"**模型真能看到的那句话**" ✓ ——
 * 缺陷正是"内部两个集合来路不同、而模型只看到合成后的话" ✓。
 */
function commandFilters(text: string): string[] {
  const line = text.split("\n").find((l) => l.includes("一条命令"));
  if (!line) return [];
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 只支持**子串匹配** ✓ —— 与 vitest 位置参数的语义**一致** ✓（`UNC-7` 钉住这个前提 ✓） */
function filterMatches(filter: string, file: string): boolean {
  return file.includes(filter);
}

const MIXED = [
  "src/test/repro-write-rejected-false-positive.test.ts",
  "src/test/core-chat-message-storage.test.ts",
  "src/test/core-context-memory.test.ts",
  "src/test/dsh-d9-multi-edit-partial-failure.test.ts",
];

describe("第 41 波：族口径收尾提醒的文案自洽（UNC-1..7）", () => {
  it("UNC-1: 命令里的过滤器必须覆盖**每一条被点名的缺口的族**（旧实现只覆盖第一条 ✗）", () => {
    const text = buildUnrunFamilyNudge({ runCount: 11, unrun: MIXED });
    const filters = commandFilters(text);
    console.log("[UNC-1] 文案：\n" + text + "\n[UNC-1] filters=" + JSON.stringify(filters));
    expect(filters.length, "命令必须给出来（否则模型无处可去 ✗）").toBeGreaterThan(0);
    for (const file of MIXED) {
      const covered = filters.some((f) => filterMatches(f, file));
      expect(covered, `命令必须覆盖它自己点名的那条缺口：${file}（filters=${JSON.stringify(filters)}）`).toBe(true);
    }
  });

  it("UNC-2 反向对照: 单族输入 ⇒ 恰好一个过滤器（正常路径不许被改坏 ✗）", () => {
    const single = ["src/test/dsh-d9-multi-edit-partial-failure.test.ts", "src/test/dsh-d8-edit-ambiguity.test.ts"];
    const filters = commandFilters(buildUnrunFamilyNudge({ runCount: 1, unrun: single }));
    expect(filters, "只有一个族时只该给一条命令").toEqual(["src/test/dsh-"]);
  });

  it("UNC-3: `.tsx` 判据也在覆盖范围内（过滤器不许带扩展名 ✗）", () => {
    const withTsx = ["src/test/app-error-boundary.test.tsx", "src/test/app-menu-bar.test.tsx"];
    const filters = commandFilters(buildUnrunFamilyNudge({ runCount: 3, unrun: withTsx }));
    for (const file of withTsx) {
      expect(filters.some((f) => filterMatches(f, file)), `${file} 必须被命令覆盖（filters=${JSON.stringify(filters)}）`).toBe(true);
    }
  });

  /**
   * ★ `UNC-7`：**命令必须真的能跑出东西** ✓。
   *
   * 实测（第 41 波，主仓库里跑的原文 ✓）：
   * ```
   * npx vitest list 'src/test/dsh-*.test.ts'   ⇒ 0 个文件 ✗（vitest 位置参数是子串匹配，不认 `*`）
   * npx vitest list 'src/test/dsh-'            ⇒ 137 条测试 ✓
   * ```
   * ⇒ 所以过滤器里出现 `*` / `?` / `[` 就是**一条跑不出东西的命令** ✗ —— 旧实现正是这样 ✗，
   * 而它`output length: 101` 的痕迹**在真机侧车里留着** ✓。
   */
  it("UNC-7: 过滤器里不许有通配符（vitest 位置参数是子串匹配 ⇒ 带 `*` 一条都匹配不到 ✗）", () => {
    const filters = commandFilters(buildUnrunFamilyNudge({ runCount: 11, unrun: MIXED }));
    for (const f of filters) {
      expect(/[*?[\]]/.test(f), `过滤器 ${f} 里有通配符 ⇒ vitest 一个文件都匹配不到 ✗（UNC-7）`).toBe(false);
    }
    expect(filters.length, "每个族一条过滤器（MIXED 有 3 个族）").toBe(3);
  });

  it("UNC-4: 空输入 ⇒ 不产出提醒（不许无条件产文案 ✗）", () => {
    expect(buildUnrunFamilyNudge({ runCount: 0, unrun: [] })).toBe("");
    expect(buildUnrunFamilyNudge({ runCount: 7, unrun: [] })).toBe("");
  });

  it("UNC-5 结构: 那句话只由 `buildUnrunFamilyNudge` 造（循环里不许再手写一份 ✗）", () => {
    /**
     * ⚠️ ★ **先剥注释** ✓（本仓库的注释里逐字引用被修掉的坏写法 ✗ —— 这条规矩吃过四次亏 ✓）。
     */
    const src = stripComments(readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8"));
    expect(src, "循环必须调用这个构造器（否则判据钉的纯函数与真机无关 ✗）").toContain("buildUnrunFamilyNudge(");
    /**
     * ⚠️ 这条第一版写的是 `/npx vitest run '\$\{/` ✗ —— **它一次都咬不住** ✓：
     * 旧写法是 `` npx vitest run 'src/test/${family}-*.test.ts' `` ✓，
     * 引号后面紧跟的是 `src/test/` ✗，根本没有 `${` 贴着引号 ✓（第 41 波变异时发现 ✓）。
     * 现在钉的是"循环里**不许出现**任何建议命令" ✓ —— 命令是纯函数的事 ✓。
     */
    expect(src, "不许在循环里再手写一条建议命令（两份文案一定会漂移 ✗）").not.toContain("npx vitest run");
    expect(src, "族名不许再取自单个元素（`ranFamilies[0]` 就是这次的缺陷 ✗）").not.toContain("ranFamilies[0]");
  });

  it("UNC-6: 两个计数与输入一致（跑过 N 条 / 没跑 M 条）", () => {
    const text = buildUnrunFamilyNudge({ runCount: 11, unrun: MIXED });
    expect(text, "跑过的条数要写进文案").toContain("11");
    expect(text, `没跑的条数要写进文案（实际 ${MIXED.length}）`).toContain(String(MIXED.length));
  });

  /**
   * ★ `UNC-8`：**侧车里必须留下"族名"与"样本"** ✓。
   *
   * 为什么它值得一条判据（这是本仓库最贵的一课 ✓）：§13.247 那次能找到根因**不是因为推理** ✗，
   * 而是因为侧车里**恰好**留着那一行 ✓：
   * ```
   * 收尾：族里没跑过的判据 {"family":"repro","unrun":50,"sample":["src/test/core-…"]}
   * ```
   * ⇒ 只留一个数字（`unrun: 50`）的话，"文案自相矛盾"这种形态**事后根本看不出来** ✗。
   *
   * ⚠️ ★ **本判据第一版是假绿** ✓（第 41 波真机发现 ✓）：它钉的是"**源码里有那两个字段**" ✗，
   * 而真机侧车里逐字是
   * ```
   * "text":"[agent-loop] 收尾：族里没跑过的判据 Object"
   * ```
   * —— ★ **CDP 的控制台捕获把对象压成了 `Object`** ✗ ⇒ 字段**根本没进侧车** ✗。
   * ⇒ 所以现在钉的是"**必须自己 `JSON.stringify` 成字符串**" ✓（字符串不会被压 ✓）。
   */
  it("UNC-8: 侧车留档 —— 族名与样本都要记，且**必须字符串化**（对象会被压成 `Object` ✗）", () => {
    const src = stripComments(readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8"));
    expect(
      src,
      "必须先 JSON.stringify 再打进日志（直接传对象 ⇒ 侧车里只有 `Object` ✗ —— 第 41 波真机实测 ✓）",
    ).toMatch(/收尾：族里没跑过的判据 \$\{JSON\.stringify\(\{/);
    const call = /收尾：族里没跑过的判据 \$\{JSON\.stringify\(\{([\s\S]*?)\}\)\}/.exec(src);
    expect(call, "拿不到那一行 ⇒ 判据自己先失效（别让它静默变成恒绿 ✗）").not.toBeNull();
    const body = call?.[1] ?? "";
    expect(body, "族名要进侧车（单数 `family` 字段就是缺陷的形状 ✗）").toContain("families:");
    expect(body, "样本要进侧车（只留计数 = 事后看不出来 ✗）").toContain("sample:");
  });
});
