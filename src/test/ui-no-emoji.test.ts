/**
 * UI emoji 棘轮（Batch 0）。
 *
 * ## 为什么是棘轮而不是"清零"
 *
 * 方向稿要求「核心 UI / 插件 chrome 的 emoji = 0」，但仓库里现有 **55 个文件 / 280 行**
 * 带 emoji（`SettingsPanel` 41、`App` 23、`GitInfoPanel` 17、PPT 工具条 17 …）。
 * 一次清完不可能同时保证每页截图可评审；分到 Batch 1B–5B 清才是可验证的路线。
 * 所以这里只做一件事：**数字只许降**。任何一批清掉的量都要在批次结束时 `--update` 收紧，
 * 让"下一批又能少一点"成为账本上的事实，而不是记忆。
 *
 * ## 口径
 *
 * 见 `src/test/helpers/ui-text-scan.ts` 的文件头：只统计 JSX 文本与字符串/模板字面量，
 * 注释天然不参与；排除 `monopoly-game`（游戏美术）与测试文件。
 *
 * ## 更新基线
 *
 * ```powershell
 * $env:UNSLOP_UPDATE_BASELINE="1"; npx vitest run src/test/ui-no-emoji.test.ts
 * ```
 * 只允许在"确实清掉了一批"之后跑；数字上涨时不要更新，要修代码。
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, SURFACE_EXCLUDES, SURFACE_ROOTS, scanUiTexts } from "./helpers/ui-text-scan";

const BASELINE_PATH = join(REPO_ROOT, "tools", "ui-audit", "copy-guard-baseline.json");
const UPDATE = process.env.UNSLOP_UPDATE_BASELINE === "1";

interface Baseline {
  at: string;
  scope: { roots: readonly string[]; excludes: readonly string[] };
  emoji: { lines: number; files: number; byFile: Record<string, number> };
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(next: Baseline): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
}

const scan = scanUiTexts();

describe("UI emoji 棘轮", () => {
  it("基线存在且口径没被悄悄改宽", () => {
    expect(existsSync(BASELINE_PATH), "缺 tools/ui-audit/copy-guard-baseline.json").toBe(true);
    const baseline = readBaseline();
    expect(baseline.scope.roots, "语料根被改过（改宽会稀释棘轮）").toEqual([...SURFACE_ROOTS]);
    expect(baseline.scope.excludes, "排除项被改过").toEqual([...SURFACE_EXCLUDES]);
  });

  it("emoji 行数与文件数不超过基线", () => {
    if (UPDATE) {
      const next = readBaseline();
      next.emoji = { lines: scan.emojiLines, files: scan.emojiFiles, byFile: scan.emojiByFile };
      writeBaseline(next);
      return;
    }
    const baseline = readBaseline();
    expect(
      scan.emojiLines,
      `emoji 行数从 ${baseline.emoji.lines} 涨到 ${scan.emojiLines}。样例：\n` +
        Object.entries(scan.emojiByFile)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([f, n]) => `  ${String(n).padStart(3)}  ${f}`)
          .join("\n"),
    ).toBeLessThanOrEqual(baseline.emoji.lines);
    expect(scan.emojiFiles, `emoji 文件数从 ${baseline.emoji.files} 涨到 ${scan.emojiFiles}`).toBeLessThanOrEqual(baseline.emoji.files);
  });

  it("单个文件的 emoji 行数不许上涨（防止「清一个文件、弄脏另一个」）", () => {
    if (UPDATE) return;
    const baseline = readBaseline();
    const regressions: string[] = [];
    for (const [file, count] of Object.entries(scan.emojiByFile)) {
      const allowed = baseline.emoji.byFile[file] ?? 0;
      if (count > allowed) regressions.push(`${file}: ${allowed} → ${count}`);
    }
    expect(regressions, `以下文件的 emoji 变多了：\n  ${regressions.join("\n  ")}`).toEqual([]);
  });

  it("清掉之后要收紧基线（读数已低于基线时给出提示，不判红）", () => {
    if (UPDATE) return;
    const baseline = readBaseline();
    if (scan.emojiLines < baseline.emoji.lines) {
      console.info(
        `[unslop] emoji 行数 ${baseline.emoji.lines} → ${scan.emojiLines}，可跑 UNSLOP_UPDATE_BASELINE=1 收紧基线`,
      );
    }
    expect(scan.emojiLines).toBeLessThanOrEqual(baseline.emoji.lines);
  });
});
