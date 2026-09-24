/**
 * **上报通道 mock 的三件套一致性**（第 90 轮）。
 *
 * ## 现场（这一轮真的踩到了）
 *
 * `migrate-guard.test.ts` 的 MG-4 在我把 `bootstrap.ts` 里一处上报从
 * `reportActionFailure` 改成 `reportAdvisory` 之后**从 'migrated' 变成了 'skipped'**。
 * 原因不是守卫判错了，而是那些用例把通道**整体 mock 掉**、只实现了两个 API：
 * 调到 `reportAdvisory` 就 `TypeError: reportAdvisory is not a function`，
 * 而这个异常被生产代码自己的 `catch` 吞掉 ⇒ 走出来的是"读不到守卫数据 → 不迁移"那条路。
 *
 * 危害是双重的：① 用例红得**指向错误的地方**（看起来像业务逻辑坏了）；
 * ② 更糟的是，如果那条路径上没有 catch，这个异常会**变成真实的运行期错误**。
 *
 * ## 判据
 *
 * PFP-1：任何 `vi.mock("../core/storage/persist-failure")` 的用例文件，必须**同时** mock
 *   `reportPersistFailure` / `reportActionFailure` / `reportAdvisory` 三个导出
 *   （或者用 `importOriginal` 透传——那样自动满足）；
 * PFP-2：被 mock 的导出名必须都在通道的真实导出里（不许 mock 一个不存在的名字）；
 * PFP-3：反向对照 —— 判据必须**真的能红**（用一段构造出来的缺一件套的 mock 源验证）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const TEST_DIR = join(ROOT, "src", "test");

const CHANNEL_EXPORTS = ["reportPersistFailure", "reportActionFailure", "reportAdvisory", "reportFailure"] as const;
const REQUIRED_IN_MOCK = ["reportPersistFailure", "reportActionFailure", "reportAdvisory"] as const;
const MOCK_RE = /vi\.mock\(\s*"\.\.\/core\/storage\/persist-failure"\s*,\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)\)/;

interface MockSite {
  file: string;
  body: string;
}

function mockSites(): MockSite[] {
  const out: MockSite[] = [];
  for (const f of readdirSync(TEST_DIR)) {
    if (!f.endsWith(".test.ts") && !f.endsWith(".test.tsx")) continue;
    /**
     * 排除本文件自己：PFP-3 里**故意**放了一段"缺一件套"的坏样本当反向对照，
     * 不排除的话这条闸门会把自己当违规报出来（第一次跑就是这样）。
     */
    if (f === "persist-failure-mock-parity.test.ts") continue;
    const text = readFileSync(join(TEST_DIR, f), "utf8");
    const m = text.match(MOCK_RE);
    if (m) out.push({ file: f, body: m[1] });
  }
  return out;
}

describe("上报通道 mock 三件套（第 90 轮）", () => {
  it("PFP-1 每个 mock 掉通道的用例都必须给出三个导出", () => {
    const sites = mockSites();
    expect(sites.length, "一个 mock 都没找到？判据可能过期了").toBeGreaterThan(5);
    const missing = sites
      .filter((s) => !/importOriginal/.test(s.body))
      .map((s) => ({ file: s.file, lack: REQUIRED_IN_MOCK.filter((n) => !s.body.includes(`${n}:`)) }))
      .filter((x) => x.lack.length > 0)
      .map((x) => `${x.file} 缺 ${x.lack.join(", ")}`);
    expect(
      missing,
      "这些用例只 mock 了部分导出 —— 被测代码调到没 mock 的那个会抛 TypeError，" +
        "而它常常被 catch 吞掉，于是红得指向错误的地方：\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("PFP-2 mock 的导出名必须是通道真实存在的导出（不许 mock 出幻觉 API）", () => {
    /**
     * ⚠️ 只看**顶层键**（缩进恰好 2 空格的 `名字:`）——
     * 第一版用 `/(\w+)\s*:/g` 扫全文，把实现体里的对象字面量
     * （`reported.push({ scope, note, error })`）也当成"导出名"，报了 4 处假阳性。
     */
    const topLevelKeys = (body: string): string[] =>
      body
        .split(/\r?\n/)
        .map((l) => l.match(/^ {2}(\w+)\s*:/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => m[1]);

    const bad: string[] = [];
    for (const s of mockSites()) {
      for (const name of topLevelKeys(s.body)) {
        if (!CHANNEL_EXPORTS.includes(name as (typeof CHANNEL_EXPORTS)[number])) bad.push(`${s.file} → ${name}`);
      }
    }
    expect(bad, "mock 了一个通道里不存在的导出名").toEqual([]);
  });

  it("PFP-3 反向对照：判据能识别出「缺一件套」的 mock 源", () => {
    const bad = `vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
}))`;
    const m = bad.match(MOCK_RE);
    expect(m, "判据的正则必须认得出这种 mock 形状").toBeTruthy();
    const lack = REQUIRED_IN_MOCK.filter((n) => !m![1].includes(`${n}:`));
    expect(lack, "缺 reportAdvisory 必须被指出来").toEqual(["reportAdvisory"]);

    // 齐全的那种不许被误报
    const good = `vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  reportAdvisory: () => {},
}))`;
    const g = good.match(MOCK_RE);
    expect(REQUIRED_IN_MOCK.filter((n) => !g![1].includes(`${n}:`))).toEqual([]);
  });
});
