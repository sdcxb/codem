/**
 * LO-LOOK — 角色外观生成
 *
 * 覆盖：确定性、取值范围、岗位倾向（队长/运维/研究/写作/编码的帽子与道具）、
 * 调色板令牌化（零硬编码色值）、CSS 变量生成。
 */
import { describe, it, expect } from "vitest";
import {
  CHARACTER_PALETTES,
  characterStyleVars,
  generateLook,
  hashString,
  paletteOf,
} from "../plugins/library-ops/data/characters";
import { shortId } from "../plugins/library-ops/core/format";
import { findHardcodedColors } from "../core/theme/skin-tokens";

describe("LO-LOOK 角色外观", () => {
  it("LO-LOOK-1: 同一 id 生成完全一致的外观（确定性）", () => {
    const a = generateLook("member-abc", "成员 · 前端实现");
    const b = generateLook("member-abc", "成员 · 前端实现");
    expect(a).toEqual(b);
  });

  it("LO-LOOK-2: 不同 id 能产生不同外观（差异化）", () => {
    const looks = Array.from({ length: 60 }, (_, i) => generateLook(`actor-${i}`));
    const signatures = new Set(looks.map((l) => `${l.paletteId}-${l.body}-${l.hair}-${l.hat}-${l.prop}-${l.face}`));
    // 60 个角色至少 40 种不同外观组合
    expect(signatures.size).toBeGreaterThanOrEqual(40);
    const palettes = new Set(looks.map((l) => l.paletteId));
    expect(palettes.size).toBeGreaterThanOrEqual(6);
  });

  it("LO-LOOK-3: 外观字段全部在合法取值范围内", () => {
    for (let i = 0; i < 200; i++) {
      const l = generateLook(`id-${i}`, `角色-${i % 7}`);
      expect(l.paletteId).toBeGreaterThanOrEqual(0);
      expect(l.paletteId).toBeLessThan(CHARACTER_PALETTES.length);
      expect(l.body).toBeGreaterThanOrEqual(0);
      expect(l.body).toBeLessThanOrEqual(3);
      expect(l.hair).toBeGreaterThanOrEqual(0);
      expect(l.hair).toBeLessThanOrEqual(4);
      expect(l.hat).toBeGreaterThanOrEqual(0);
      expect(l.hat).toBeLessThanOrEqual(5);
      expect(l.prop).toBeGreaterThanOrEqual(0);
      expect(l.prop).toBeLessThanOrEqual(5);
      expect(l.face).toBeGreaterThanOrEqual(0);
      expect(l.face).toBeLessThanOrEqual(3);
      expect(l.scale).toBeGreaterThanOrEqual(0.88);
      expect(l.scale).toBeLessThanOrEqual(1.13);
      expect(Math.abs(l.hueShift)).toBeLessThanOrEqual(24);
    }
  });

  it("LO-LOOK-4: 岗位倾向 —— 队长戴礼帽、运维戴工帽、研究戴学者帽、写作戴贝雷帽、编码戴耳机", () => {
    expect(generateLook("x", "队长 · 调度").hat).toBe(1);
    expect(generateLook("x", "成员 · 运维部署").hat).toBe(4);
    expect(generateLook("x", "成员 · 研究分析").hat).toBe(2);
    expect(generateLook("x", "成员 · 文档写作").hat).toBe(5);
    expect(generateLook("x", "成员 · 前端编码").hat).toBe(3);
  });

  it("LO-LOOK-5: 岗位倾向 —— 编码拿终端、研究拿书、写作拿笔、审查拿夹板", () => {
    expect(generateLook("x", "成员 · 代码实现").prop).toBe(1);
    expect(generateLook("x", "成员 · 阅读研究").prop).toBe(2);
    expect(generateLook("x", "成员 · 文档写作").prop).toBe(3);
    expect(generateLook("x", "成员 · 评审测试").prop).toBe(4);
  });

  it("LO-LOOK-6: 调色板全部由皮肤令牌构成，零硬编码色值", () => {
    const source = CHARACTER_PALETTES.map((p) => `${p.uniform}|${p.trim}|${p.hair}|${p.legs}`).join("\n");
    // 允许的表达式：var(--token) 或 color-mix(...var(--token)...)
    expect(findHardcodedColors(source.replace(/color-mix\([^)]*\)/g, ""))).toEqual([]);
    for (const p of CHARACTER_PALETTES) {
      expect(p.uniform.startsWith("var(--")).toBe(true);
      expect(p.trim.startsWith("var(--")).toBe(true);
      expect(p.hair.startsWith("var(--")).toBe(true);
      expect(p.skin).toContain("var(--");
      expect(p.legs).toContain("var(--");
    }
  });

  it("LO-LOOK-7: paletteOf 越界安全，characterStyleVars 输出令牌变量", () => {
    expect(paletteOf({ ...generateLook("a"), paletteId: -3 }).id).toBeGreaterThanOrEqual(0);
    expect(paletteOf({ ...generateLook("a"), paletteId: 999 }).id).toBeLessThan(CHARACTER_PALETTES.length);
    const vars = characterStyleVars(generateLook("seed", "成员 · 编码"));
    for (const key of ["--lo-uniform", "--lo-trim", "--lo-hair", "--lo-skin", "--lo-legs", "--lo-scale", "--lo-hue"]) {
      expect(vars[key], `${key} 应存在`).toBeTruthy();
    }
    expect(vars["--lo-hue"]).toMatch(/deg$/);
    // 派生色同样只含令牌
    expect(vars["--lo-uniform-dark"]).toContain("var(--");
    expect(vars["--lo-outline"]).toContain("var(--");
  });

  it("LO-LOOK-8: hashString 稳定且区分大小写；shortId 安全", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toBe(0x811c9dc5);
    expect(shortId("session:abcdef123456", 6)).toBe("sessio…");
    expect(shortId("short", 12)).toBe("short");
    expect(shortId("")).toBe("—");
    expect(shortId(undefined)).toBe("—");
  });
});
