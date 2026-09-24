/**
 * **按文件覆盖率地板**的自证（第 96 轮，GAP-LIST 的 O-6）。
 *
 * ## 为什么要它（聚合阈值的盲区）
 *
 * 现有棘轮是**全局 + 按目录**的（全局 lines 52 / storage 81 / llm 60 …）。
 * 那种阈值挡不住最危险的一种退化：**某个文件掉到 0，而总量被别的文件补回来**。
 * 所以这一轮加了**按文件地板**（`tools/audit/coverage-per-file.mjs`）：
 * 地板 = 实测 × 0.8 向下取整（≥20 行的文件才建），写进
 * `tools/audit/coverage-per-file-baseline.json`。
 *
 * ## 这条用例测什么、不测什么（说清楚，免得误以为它守住了真实覆盖率）
 *
 * - **测**：闸门**逻辑**本身（地板比对、新文件零覆盖的拦截）—— 用**合成**的 summary/baseline，
 *   结果确定，不受"当前有没有跑过覆盖率"影响；
 * - **不测**：真实覆盖率数据 —— 那一步由 `npm run verify` 里的
 *   `node tools/audit/coverage-per-file.mjs --check` 负责（它跑在覆盖率报告生成**之后**）。
 *
 * ⚠️ 为什么不能用真实 summary：在 `vitest run --coverage` **进行中**，`coverage/coverage-summary.json`
 * 还没生成（或正被清理）—— 第一版就是这么写的，`npm run verify` 里直接红（"找不到 summary"）。
 *
 * 判据：COV-FILE-1（地板之上的合成数据通过）/ COV-FILE-2（地板表非空且非全零）/
 * COV-FILE-3（变异：地板抬到 100 ⇒ 红）/ COV-FILE-4（变异：新文件 0 覆盖 ≥50 行 ⇒ 红）。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const TOOL = join(ROOT, "tools", "audit", "coverage-per-file.mjs");
const BASELINE = join(ROOT, "tools", "audit", "coverage-per-file-baseline.json");

function check(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [TOOL, "--check", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 造一个合成 summary：`files` 里每项 [相对路径, 行总数, 行覆盖率%] */
function syntheticSummary(dir: string, files: Array<[string, number, number]>, extra: Array<[string, number, number]> = []): string {
  const summary: Record<string, unknown> = { total: {} };
  for (const [rel, lines, pct] of [...files, ...extra]) {
    const covered = Math.round((lines * pct) / 100);
    summary[join(ROOT, rel)] = {
      lines: { total: lines, covered, skipped: 0, pct },
      statements: { total: lines, covered, skipped: 0, pct },
      functions: { total: Math.max(1, Math.round(lines / 10)), covered: Math.max(1, Math.round((lines / 10) * (pct / 100))), skipped: 0, pct },
      branches: { total: Math.max(1, Math.round(lines / 4)), covered: Math.max(1, Math.round((lines / 4) * (pct / 100))), skipped: 0, pct },
    };
  }
  const p = join(dir, "summary.json");
  writeFileSync(p, JSON.stringify(summary), "utf8");
  return p;
}

describe("按文件覆盖率地板（第 96 轮）", () => {
  it("COV-FILE-1 逻辑：地板之上的合成数据必须通过", () => {
    const dir = mkdtempSync(join(tmpdir(), "covfloor-ok-"));
    try {
      // 地板 = 实测 × 0.8 ⇒ 实测 80% 时地板 64%，实测 80% 应当通过
      const summary = syntheticSummary(dir, [["src/core/fake-a.ts", 200, 80]]);
      const baseline = join(dir, "baseline.json");
      writeFileSync(
        baseline,
        JSON.stringify({ _count: 1, floors: { "src/core/fake-a.ts": { lines: 64, statements: 64, functions: 64, branches: 64 } } }),
        "utf8",
      );
      const res = check(["--baseline", baseline, "--summary", summary]);
      expect(res.status, `应通过，实际：\n${res.out.slice(0, 500)}`).toBe(0);
      expect(res.out).toContain("按文件地板闸门通过");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COV-FILE-2 真实地板表不是空表，也不是全 0（否则这条闸门形同没有）", () => {
    const doc = JSON.parse(readFileSync(BASELINE, "utf8")) as { _count: number; floors: Record<string, Record<string, number>> };
    expect(doc._count, "地板表应当覆盖一批文件").toBeGreaterThan(100);
    expect(Object.keys(doc.floors).length).toBe(doc._count);
    const nonZero = Object.values(doc.floors).filter((f) => (f.lines ?? 0) > 0).length;
    expect(nonZero, "地板全为 0 就没有意义").toBeGreaterThan(20);
  });

  it("COV-FILE-3 变异：地板被抬到 100 ⇒ 闸门必须红（证明它真会拦）", () => {
    const dir = mkdtempSync(join(tmpdir(), "covfloor-bad-"));
    try {
      const summary = syntheticSummary(dir, [["src/core/fake-a.ts", 200, 80]]);
      const baseline = join(dir, "baseline.json");
      writeFileSync(
        baseline,
        JSON.stringify({ _count: 1, floors: { "src/core/fake-a.ts": { lines: 100, statements: 100, functions: 100, branches: 100 } } }),
        "utf8",
      );
      const res = check(["--baseline", baseline, "--summary", summary]);
      expect(res.status, `抬到 100 竟然没红：\n${res.out.slice(0, 400)}`).toBe(1);
      expect(res.out).toContain("src/core/fake-a.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COV-FILE-4 变异：新文件 0 覆盖且 ≥50 行 ⇒ 闸门必须红（挡住大块零测试代码）", () => {
    const dir = mkdtempSync(join(tmpdir(), "covnew-"));
    try {
      const summary = syntheticSummary(dir, [], [["src/core/__brand-new-module.ts", 120, 0]]);
      const baseline = join(dir, "baseline.json");
      writeFileSync(baseline, JSON.stringify({ _count: 0, floors: {} }), "utf8");
      const res = check(["--baseline", baseline, "--summary", summary]);
      expect(res.status, `新文件零覆盖竟然没红：\n${res.out.slice(0, 400)}`).toBe(1);
      expect(res.out).toContain("__brand-new-module.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COV-FILE-5 反向对照：新文件 0 覆盖但**不足 50 行** ⇒ 不拦（小文件抖动大，不搞一刀切）", () => {
    const dir = mkdtempSync(join(tmpdir(), "covsmall-"));
    try {
      const summary = syntheticSummary(dir, [], [["src/core/tiny-new.ts", 30, 0]]);
      const baseline = join(dir, "baseline.json");
      writeFileSync(baseline, JSON.stringify({ _count: 0, floors: {} }), "utf8");
      const res = check(["--baseline", baseline, "--summary", summary]);
      expect(res.status, `30 行的小文件不该被这条拦住：\n${res.out.slice(0, 400)}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
