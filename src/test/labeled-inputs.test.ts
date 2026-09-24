/**
 * 复选框/单选框的**可访问名** + 三类窄按钮的**命中区下限**（第 95 轮，O-20 的落地）。
 *
 * ## 现场（真机走查量出来的，第 94/95 轮）
 *
 * 走查把一批 **13×13 的原生复选框**报成"命中区不足 24×24"。真机上逐个量下来发现两件事：
 *  ① **有 `<label>` 包裹的那些不算问题** —— label 是 856×26，点 label 也能切换
 *     （`label.click()` 实测确认），有效目标其实就是 label；
 *  ② **没被 label 兜住的那些才是真问题**：13×13 是它的全部可点范围，而且**读屏念不出它管什么**。
 *
 * 于是判据落成两条：
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | LBL-1 | 每个 `input[type=checkbox\\|radio]` 必须有可访问名（`<label>` 包裹 / `aria-label` / `id`+`htmlFor`）—— 棘轮只许降不许升 |
 * | LBL-2 | 三类**窄按钮**（`.api-key-toggle` / `.session-recovery-close` / `.usage-stats-close`）必须有 24×24 下限 |
 * | LBL-3 | 反向对照：扫描器必须认得"有 label 的"与"没 label 的"两种写法 |
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const SCANNER = join(ROOT, "tools", "ui-audit", "scan-labeled-inputs.mjs");
const BASELINE = join(ROOT, "tools", "ui-audit", "labeled-inputs-baseline.json");
const CSS = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

function scan(root: string): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCANNER, "--root", root, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? -1, out: err.stdout ?? "" };
  }
}

/** 造一棵最小假树（自证用；不动真仓库） */
function fakeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lbl-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}
const countIn = (root: string): number => JSON.parse(scan(root).out || "{}").count ?? -1;

describe("复选框可访问名 + 窄按钮命中区（第 95 轮）", () => {
  it("LBL-1 真实仓库：没名字的复选框/单选框数 ≤ 基线（只许降不许升）", () => {
    const res = scan(ROOT);
    expect(res.status, `扫描器应当成功（拿不到结果说明工具坏了）：${res.out.slice(0, 200)}`).toBe(0);
    const { count } = JSON.parse(res.out) as { count: number };
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { count: number };
    expect(
      count,
      `没名字的复选框/单选框从 ${baseline.count} 涨到 ${count}（清单：node tools/ui-audit/scan-labeled-inputs.mjs）`,
    ).toBeLessThanOrEqual(baseline.count);
  });

  it("LBL-2 三类窄按钮必须有 24×24 下限", () => {
    for (const [cls, must] of [
      [".api-key-toggle", /min-height:\s*24px/],
      [".session-recovery-close", /min-width:\s*24px[\s\S]{0,60}?min-height:\s*24px/],
      [".usage-stats-close", /min-width:\s*24px[\s\S]{0,60}?min-height:\s*24px/],
    ] as const) {
      const block = CSS.slice(CSS.indexOf(`${cls} {`), CSS.indexOf(`${cls} {`) + 400);
      expect(block, `${cls} 缺少 24 命中区下限`).toMatch(must);
    }
    // 自动化触发器那一行的复选框：外层的 label 要有 24×24
    const tc = readFileSync(join(ROOT, "src", "styles", "task-center.css"), "utf8");
    expect(tc, ".automation-checkbox-hit 必须有 24×24 下限").toMatch(
      /\.automation-checkbox-hit \{[\s\S]{0,220}?min-width:\s*24px[\s\S]{0,120}?min-height:\s*24px/,
    );
  });

  it("LBL-3 反向对照：扫描器认得「有 label」与「没 label」两种写法", () => {
    const labelWithText = fakeTree({
      "src/a.tsx": `<div><label className="x"><input type="checkbox" checked={v} onChange={f} /> 启用自动刷新</label></div>`,
    });
    /**
     * ⚠️ **空 label 不算名字**（第 95 轮补的假阴性）：
     * `<label><input/></label>` 里没有任何文字 ⇒ 读屏仍然念不出这个开关是干什么的。
     * `AutomationTab` 的触发器开关原来就是这种写法。
     */
    const emptyLabel = fakeTree({
      "src/a.tsx": `<div><label className="x"><input type="checkbox" checked={v} onChange={f} /></label></div>`,
    });
    const withoutLabel = fakeTree({
      "src/a.tsx": `<div><input type="checkbox" checked={v} onChange={f} /></div>`,
    });
    const withAria = fakeTree({
      "src/a.tsx": `<div><input type="checkbox" aria-label="启用" checked={v} onChange={f} /></div>`,
    });
    try {
      expect(countIn(labelWithText), "label 里带文字的不该被报").toBe(0);
      expect(countIn(emptyLabel), "**空 label** 给不出可访问名 ⇒ 必须被报").toBe(1);
      expect(countIn(withoutLabel), "没 label 的必须被报").toBe(1);
      expect(countIn(withAria), "有 aria-label 的不该被报").toBe(0);
    } finally {
      for (const d of [labelWithText, emptyLabel, withoutLabel, withAria]) rmSync(d, { recursive: true, force: true });
    }
  });
});
