/**
 * 部分配置的默认值**不许被显式 `undefined` 覆盖**（第 181 波，T-2，对标 Pi `cd60a5b99`）。
 *
 * ## 缺陷形态（Pi 1.0.4 修的正是这个）
 *
 * ```ts
 * const DEFAULT = { a: 100, b: 200 };
 * const saved = { b: 500, a: undefined };     // 键在、值是 undefined
 * { ...DEFAULT, ...saved }                    // { a: undefined, b: 500 }  ⇒ a 的默认值没了
 * ```
 *
 * 危害是**静默**的：拿到 `undefined` 的地方通常写成 `setTimeout(f, undefined)`（等价 0ms）、
 * `Math.max(undefined, x)`（NaN）之类，于是"节流失效 / 间隔变 0 / 阈值变 NaN"，
 * 而**没有任何地方会报错**（Pi 的现场就是"每个 token 都提交一次存储"的写放大）。
 *
 * 我们的形态与它同源：有一批配置是"**从持久化里读出来的部分对象**再展开到默认值上"
 * （`codem-notebook-config` / `codem-computer-user` / worktree 设置 / 心跳配置 / 同步配置），
 * 只要磁盘上出现过 `{"key": undefined}` 这种形状（外部编辑、旧版本写出、迁移残留），
 * 默认值就会被清掉。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | MD-1 | **行为**：`mergeDefaults` 跳过显式 `undefined`（复现 Pi 的原始算例） |
 * | MD-2 | **行为**：显式的 `null` **必须保留**（调用方要 null 是合法意图，不许被吞） |
 * | MD-3 | **行为**：值为 `0` / `""` / `false` 时**不许**被当成"没设置"（这三者最容易误伤） |
 * | MD-4 | **行为**：`partial` 为空/非对象时返回默认值的副本（且**不是同一个引用**） |
 * | MD-5 | **结构**：全生产源码里"`{...DEFAULT_x, ...<持久化读>`"这种**同名类型整体展开**必须为 0 —— 一律走 `mergeDefaults` |
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeDefaults } from "../core/storage/settings";

describe("部分配置合并：显式 undefined 不许覆盖默认值（T-2）", () => {
  it("MD-1: 复现 Pi 的原始算例 —— undefined 保留默认值，其余按持久化覆盖", () => {
    const DEFAULT = { a: 100, b: 200 };
    // 反向对照：先证明"朴素展开"确实会坏（否则本判据证明不了任何东西）
    const naive = { ...DEFAULT, ...{ b: 500, a: undefined as number | undefined } };
    expect(naive.a, "朴素展开确实会把默认值清成 undefined —— 这就是要修的形态").toBeUndefined();

    const merged = mergeDefaults(DEFAULT, { b: 500, a: undefined } as Partial<typeof DEFAULT>);
    expect(merged.a, "键存在但值是 undefined ⇒ 必须保留默认值").toBe(100);
    expect(merged.b, "真正存过的值照常覆盖").toBe(500);
  });

  it("MD-2: 显式 null 必须保留（不能把 null 也当「没设置」）", () => {
    const DEFAULT = { note: "default", n: 5 } as { note: string | null; n: number };
    const merged = mergeDefaults(DEFAULT, { note: null });
    expect(merged.note, "调用方显式要 null 是合法意图").toBeNull();
    expect(merged.n, "没提到的键保持默认").toBe(5);
  });

  it("MD-3: 0 / 空串 / false 都不许被当成「没设置」", () => {
    const DEFAULT = { intervalMs: 100, dir: "/tmp", enabled: true };
    const merged = mergeDefaults(DEFAULT, { intervalMs: 0, dir: "", enabled: false });
    expect(merged.intervalMs, "0 是合法值").toBe(0);
    expect(merged.dir, "空串是合法值").toBe("");
    expect(merged.enabled, "false 是合法值").toBe(false);
  });

  it("MD-4: partial 为空/非对象时返回默认值副本，且不是同一引用", () => {
    const DEFAULT = { a: 1, b: 2 };
    expect(mergeDefaults(DEFAULT, undefined)).toEqual(DEFAULT);
    expect(mergeDefaults(DEFAULT, null)).toEqual(DEFAULT);
    expect(mergeDefaults(DEFAULT, {} as Partial<typeof DEFAULT>)).toEqual(DEFAULT);
    const merged = mergeDefaults(DEFAULT, undefined);
    expect(merged, "必须是副本：调用方改它不该污染默认值对象").not.toBe(DEFAULT);
  });

  it("MD-5: 生产源码里「DEFAULT_x 与持久化读整体展开」必须为 0（一律走 mergeDefaults）", () => {
    const ROOT = process.cwd();
    const SRC = path.join(ROOT, "src");
    /**
     * 要抓的形状：`...DEFAULT_SOMETHING, ...<持久化读>`。
     * 持久化读包括 `getSettingJSON(...)` / `stored` / `saved` / `parsed`。
     * **不抓** `...DEFAULT, ...config`（构造参数是强类型 Partial，TS 层已经挡住
     * 「键存在但值 undefined」——因为 `Partial<T>` 的 `b?: number` 展开进 `T` 的 `b: number`
     * 是被类型系统允许的**唯一**情况就是它确实可能 undefined，而我们的 6 处配置读点
     * 全是"从磁盘 JSON 兑现"，那才是**运行时**无法保证的地方）。
     */
    const RISKY = /\.\.\.DEFAULT[A-Za-z_]*\s*,\s*\.\.\.\s*(getSettingJSON|stored|saved|parsed)/g;
    const SkipDir = new Set(["node_modules", "dist", "coverage", ".git"]);

    /**
     * ⚠️ **必须先剥注释**：`mergeDefaults` 的文档里就写着这个反例（`{ ...DEFAULT, ...saved }`），
     * 不剥的话判据会被自己的说明文字绊倒（第一版实测抓到 `settings.ts:136/139` 两处假阳）。
     * 只做粗粒度剥离（`//…` 与 `/* … *\/`）——判据只看"这行代码里有没有这个形状"。
     */
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SkipDir.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue; // 判据自己会提到这个形状
        const file = path.join(dir, entry.name);
        const text = stripComments(fs.readFileSync(file, "utf8"));
        for (const m of text.matchAll(RISKY)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(ROOT, file)}:${line}`);
        }
      }
    };
    walk(SRC);

    expect(
      offenders,
      `这些地方用对象展开合并持久化配置 ⇒ 磁盘上的显式 undefined 会清掉默认值（静默失效）：\n  - ${offenders.join("\n  - ")}\n` +
        `修法：改用 mergeDefaults(DEFAULTS, <持久化读>)，它跳过显式 undefined。`,
    ).toEqual([]);

    // 防空集守卫：扫描确实覆盖到了文件（否则正则写错也会"绿"）
    expect(
      fs.existsSync(path.join(SRC, "core", "storage", "settings.ts")),
      "扫描根必须含生产源码",
    ).toBe(true);
  });
});
