/**
 * UI 文案棘轮（Batch 0）：禁用词 / greeting / 感叹号 / raw Markdown。
 *
 * ## 为什么这四条要单独成判据
 *
 * 方向稿的「文案规则」是一张词表 + 句式规则（不问候、不用感叹号、不写 `**…**`）。
 * 这类规则最容易在"下一批顺手加一句"时回退，而且**肉眼评审很难发现**（一句话里多一个"一键"）。
 * 所以把它变成数字：只许降。每清完一批 `--update` 收紧，数字就是进度。
 *
 * ## 判定口径（与 helpers/ui-text-scan.ts 一致）
 *
 * - 只看 JSX 文本与字符串/模板字面量；注释不参与；
 * - `!` 只在中文语境里算（`!token`、`!=` 不算）；
 * - `**…**` 只在**含 CJK** 的文本里算（glob 通配（星号加斜杠）不算）；
 * - 排除 `monopoly-game` 与测试文件。
 *
 * 更新基线：`$env:UNSLOP_UPDATE_BASELINE="1"; npx vitest run src/test/ui-copy-guard.test.ts`
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BANNED_WORDS, GREETING_PATTERNS, REPO_ROOT, SURFACE_EXCLUDES, SURFACE_ROOTS, scanUiTexts } from "./helpers/ui-text-scan";

const BASELINE_PATH = join(REPO_ROOT, "tools", "ui-audit", "copy-guard-baseline.json");
const UPDATE = process.env.UNSLOP_UPDATE_BASELINE === "1";

type Rule = "banned" | "greeting" | "exclamation" | "rawMarkdown";

interface Baseline {
  at: string;
  scope: { roots: readonly string[]; excludes: readonly string[] };
  emoji: { lines: number; files: number; byFile: Record<string, number> };
  copy: Record<Rule, number>;
  copyByFile: Record<string, Record<Rule, number>>;
}

const RULE_LABEL: Record<Rule, string> = {
  banned: "禁用词（营销/口语/夸张）",
  greeting: "greeting（不问候）",
  exclamation: "感叹号",
  rawMarkdown: "raw Markdown（**…**）",
};

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

const scan = scanUiTexts();

describe("UI 文案棘轮", () => {
  it("词表本身没有被删项（少一个词就是少一条判据）", () => {
    expect(BANNED_WORDS.length, "禁用词表被删项了").toBeGreaterThanOrEqual(30);
    expect(GREETING_PATTERNS.length, "greeting 表被删项了").toBeGreaterThanOrEqual(8);
    expect(existsSync(BASELINE_PATH), "缺 tools/ui-audit/copy-guard-baseline.json").toBe(true);
    const baseline = readBaseline();
    expect(baseline.scope.roots, "语料根被改过").toEqual([...SURFACE_ROOTS]);
    expect(baseline.scope.excludes, "排除项被改过").toEqual([...SURFACE_EXCLUDES]);
  });

  it("四条文案规则的计数都不超过基线", () => {
    if (UPDATE) {
      const next = readBaseline();
      next.at = new Date().toISOString();
      next.copy = { ...scan.copy };
      next.copyByFile = scan.copyByFile;
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
      return;
    }
    const baseline = readBaseline();
    const regressions: string[] = [];
    for (const rule of Object.keys(RULE_LABEL) as Rule[]) {
      const now = scan.copy[rule];
      const allowed = baseline.copy[rule] ?? 0;
      if (now > allowed) regressions.push(`${RULE_LABEL[rule]}: ${allowed} → ${now}`);
    }
    const detail = (Object.keys(RULE_LABEL) as Rule[])
      .filter((rule) => scan.copy[rule] > (baseline.copy[rule] ?? 0))
      .map((rule) =>
        scan.samples[rule]
          .slice(0, 6)
          .map((hit) => `    ${hit.file}:${hit.line}  ${hit.text}`)
          .join("\n"),
      )
      .filter(Boolean)
      .join("\n");
    expect(regressions, `以下文案规则回退：\n  ${regressions.join("\n  ")}\n样例：\n${detail}`).toEqual([]);
  });

  it("全局数字与逐文件账本一致（防止只盯总数）", () => {
    if (UPDATE) return;
    const baseline = readBaseline();
    const sum = (rule: Rule) => Object.values(baseline.copyByFile ?? {}).reduce((acc, row) => acc + (row[rule] ?? 0), 0);
    for (const rule of Object.keys(RULE_LABEL) as Rule[]) {
      expect(sum(rule), `基线的 ${rule} 总数与逐文件账本不一致`).toBe(baseline.copy[rule] ?? 0);
    }
  });
});
