/**
 * STAB：水位提示条**防抖**（2026-10-19 用户实报：打开 Codem 时提示条出现 1–2 秒又消失、几秒后重现）。
 *
 * ## 被守的缺陷
 *
 * 会话一打开，水位要经过几拍：索引镜像未就绪（UNKNOWN，不可见）→ 就绪后先读到"高"→
 * 同一轮里折叠/压缩把读数拉下来 → 又可能升回去。提示条直接跟每一拍变化 ⇒ 闪烁。
 *
 * 判据 `STAB-1..5`；变异 `water-banner-stability`。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INITIAL_WATER_BANNER_STATE,
  reduceWaterBanner,
  UNKNOWN_WATER_LEVEL,
  WATER_LEVEL,
  type ContextWaterLevel,
} from "../core/context/water-level";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function level(ratio: number, opts: { authoritative?: boolean } = {}): ContextWaterLevel {
  const authoritative = opts.authoritative ?? true;
  const pct = Math.min(100, Math.round(ratio * 100));
  const lvl = ratio >= 0.9 ? WATER_LEVEL.CRITICAL : ratio >= 0.7 ? WATER_LEVEL.HIGH : ratio >= 0.5 ? WATER_LEVEL.ELEVATED : WATER_LEVEL.NORMAL;
  return {
    used: Math.round(ratio * 100_000),
    available: 100_000,
    ratio,
    percent: pct,
    level: lvl,
    messageCount: 10,
    authoritative,
  };
}

describe("STAB 提示条防抖", () => {
  it("STAB-1: 单拍高水位不显示；连续两拍才显示", () => {
    let s = reduceWaterBanner(INITIAL_WATER_BANNER_STATE, level(0.75));
    expect(s.visible, "第一拍就显示 = 打开时闪一下").toBe(false);
    s = reduceWaterBanner(s, level(0.76));
    expect(s.visible, "连续两拍（≈6 秒）后才显示").toBe(true);
  });

  it("STAB-2: 读不到（authoritative=false）不改变可见性", () => {
    let s = reduceWaterBanner(reduceWaterBanner(INITIAL_WATER_BANNER_STATE, level(0.8)), level(0.8));
    expect(s.visible).toBe(true);
    s = reduceWaterBanner(s, level(0, { authoritative: false }));
    expect(s.visible, "读不到既不证明满也不证明不满 ⇒ 保持显示").toBe(true);
    const t = reduceWaterBanner(INITIAL_WATER_BANNER_STATE, { ...UNKNOWN_WATER_LEVEL });
    expect(t.visible).toBe(false);
  });

  it("STAB-3: 低一拍不隐藏；连续两拍低才隐藏", () => {
    let s = reduceWaterBanner(reduceWaterBanner(INITIAL_WATER_BANNER_STATE, level(0.8)), level(0.8));
    s = reduceWaterBanner(s, level(0.6));
    expect(s.visible, "刚掉下来一拍就隐藏 = 用户看到闪一下").toBe(true);
    s = reduceWaterBanner(s, level(0.55));
    expect(s.visible).toBe(false);
  });

  it("STAB-4: 高/低交替（正是启动现场的闪烁）永远不会显示", () => {
    let s = INITIAL_WATER_BANNER_STATE;
    for (const r of [0.8, 0.6, 0.8, 0.6, 0.8, 0.6]) {
      s = reduceWaterBanner(s, level(r));
      expect(s.visible, "交替波动不许点亮提示条").toBe(false);
    }
  });

  it("STAB-5: 提示条接线到防抖 hook（不是裸 useContextWaterLevel）", () => {
    const banner = read("src/components/WaterLevelBanner.tsx");
    expect(banner, "必须解构出防抖可见性（不是自己用 level 再算一遍）").toContain(
      "const { level, visible: stableRiskVisible } = useStableContextWaterLevel(sessionId);",
    );
    expect(banner, "风险分支必须走防抖可见性").toContain("if (!stableRiskVisible) return false;");
  });
});
