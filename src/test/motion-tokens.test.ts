/**
 * MOTION：动效令牌 + 裸 cubic-bezier 棘轮。
 *
 * 背景（对标 open-claude-ui 的命名 ease 集）：我们此前只有 4 条基础曲线令牌，
 * 各处 transition/animation 直接写曲线也不会被挡。现在：
 * - `--ease-*` 是唯一允许出现 `cubic-bezier(...)` 的地方；
 * - 其它 CSS 规则里出现裸曲线 ⇒ `tools/audit/scan-motion-tokens.mjs` 红（基线 0）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanMotion } from "../../tools/audit/scan-motion-tokens.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

describe("MOTION 动效令牌", () => {
  it("MOTION-1: 除令牌定义外没有裸 cubic-bezier（基线 0）", () => {
    const result = scanMotion();
    expect(result.baseline).toBe(0);
    expect(result.rawCount, JSON.stringify(result.violations, null, 1)).toBe(0);
  });

  it("MOTION-2: 语义曲线令牌确实定义在 :root 且是 cubic-bezier", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
    for (const token of ["--ease-swift", "--ease-pop", "--ease-out", "--ease-standard"]) {
      const m = css.match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(m, `${token} 未定义`).toBeTruthy();
      expect(m![1]).toContain("cubic-bezier(");
    }
  });

  it("MOTION-3: 时长令牌按档位存在（fast/normal/slow，且 fast < normal < slow）", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
    const num = (name: string) => {
      const m = css.match(new RegExp(`--duration-${name}:\\s*(\\d+)ms`));
      expect(m, `--duration-${name} 未定义`).toBeTruthy();
      return Number(m![1]);
    };
    expect(num("fast")).toBeLessThan(num("normal"));
    expect(num("normal")).toBeLessThan(num("slow"));
  });
});
