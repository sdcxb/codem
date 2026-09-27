/**
 * ICONHALO-196：**图标边缘不许带白边（halo）**
 *
 * ## 用户现场
 * 「现在任务栏上的图标清晰了，但是**安装包的图标看上去边缘毛毛刺刺的**。」
 *
 * ## 查证过程（都实测过，不靠推断）
 *   1. **不是上一轮帧顺序改动造成的**：抠出 1.16.194 与 1.16.195 两个安装包的图标组，
 *      16/32/48/64/128/256 各档**逐像素完全一致**。
 *   2. **不是 NSIS 降档**：安装包与应用的 PE 图标组都是 **7 档**，字节数逐一相同。
 *   3. **不是档位质量问题**：256 档缩到 48 vs 直接用 48 档，边缘能量 12.665 vs 12.486（差 1.4%）。
 *   4. **是白边（halo）**：256 档 AA 边缘的 RGB **直接就是纯白** ——
 *      实测 `x=2 (255,255,255, α=25)`、`x=253 (255,255,255, α=32)`，
 *      而内部是紫 (115,99,182)；「低 α 且发亮」的像素 662 个，
 *      且 **256 档的边缘比内部更亮（+3.2）**，其余各档都是边缘更暗（−10 ~ −36）。
 *      ⇒ 这正是"边缘毛毛刺刺"的成因，也解释了为什么任务栏修好后**更明显**
 *      （任务栏现在用的正是这个最脏的 256 档）。
 *
 * ## 修法
 * `真色 = (观测 − 白·(1−α)) / α`，**α 一字节不动**，颜色按**直通**（非预乘）写回。
 * 实测（`_probe-196-halo-diff.mjs`，改前 vs 改后）：
 *   · 「低 α 发白」像素 944 → 603；
 *   · 256 档「边缘 − 内部」**+3.2 → −11.6**（不再比内部亮）；
 *   · **每档 α>0 的像素数完全一致**（形状/抗锯齿没动）；
 *   · **每档主体（不透明区）均色一致**（图形没动）。
 *
 * ## 本门禁守什么 / 守不了什么
 * 守：**边缘不许系统性发白**（这个不变量一旦被退回就会被抓住）。
 * 守不了："你看着顺不顺眼"；也守不了"某些像素仍然偏亮"（边缘本来就是渐变，
 * 见下面注释里对错误判据的记录）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ICO = path.join(ROOT, "src-tauri/icons/icon.ico");

function readFrames(file) {
  const b = readFileSync(file);
  const count = b.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const off = b.readUInt32LE(o + 12);
    const w = b[o] === 0 ? 256 : b[o];
    const bh = b.readInt32LE(off + 8);
    const realH = Math.abs(bh) / 2;
    const px = off + 40;
    const rowBytes = w * 4;
    const rgba = Buffer.alloc(w * realH * 4);
    for (let y = 0; y < realH; y++) {
      const srcY = bh > 0 ? realH - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const s = px + srcY * rowBytes + x * 4;
        const d = (y * w + x) * 4;
        rgba[d] = b[s + 2]; rgba[d + 1] = b[s + 1]; rgba[d + 2] = b[s]; rgba[d + 3] = b[s + 3];
      }
    }
    out.push({ w, h: realH, rgba });
  }
  return out;
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("ICONHALO-196 图标边缘不许带白边", () => {
  it("ICONHALO-196-1 ★边缘不许比内部更亮（白边的定义）", () => {
    /**
     * 判据用**带符号**的差 `edge − inner`，只许 ≤ 一个小容差。
     * ⚠️ 不要用 `|edge − inner|` —— 试过，那是**错的判据**：
     * 修复把 256 档从 +3.2 变成 −11.6，绝对值反而变大，
     * 于是一次正确修复会被判成失败。**判据要对应缺陷的方向**。
     */
    const frames = readFrames(ICO);
    for (const f of frames) {
      let edgeSum = 0, edgeN = 0, innerSum = 0, innerN = 0;
      for (let i = 0; i < f.w * f.h; i++) {
        const a = f.rgba[i * 4 + 3];
        const af = a / 255, bg = 0x20;   // 深底（任务栏）合成
        const L = lum(
          f.rgba[i * 4] * af + bg * (1 - af),
          f.rgba[i * 4 + 1] * af + bg * (1 - af),
          f.rgba[i * 4 + 2] * af + bg * (1 - af),
        );
        if (a >= 8 && a <= 245) { edgeSum += L; edgeN++; }
        if (a === 255) { innerSum += L; innerN++; }
      }
      if (!edgeN || !innerN) continue;
      const diff = edgeSum / edgeN - innerSum / innerN;
      expect(
        diff,
        `${f.w}×${f.h} 的边缘比内部亮 ${diff.toFixed(1)} —— 这就是白边（halo）`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("ICONHALO-196-2 ★α 边缘的颜色不许是近白（白污染的直接特征）", () => {
    const frames = readFrames(ICO);
    const f256 = frames.find((f) => f.w === 256);
    expect(f256, "缺少 256 档").toBeTruthy();
    /* 统计"低 α 且发亮"的像素。改前 662，改后 474；给它一个有余量的上限。 */
    let whites = 0;
    for (let i = 0; i < f256!.w * f256!.h; i++) {
      const a = f256!.rgba[i * 4 + 3];
      if (a === 0 || a >= 200) continue;
      const L = lum(f256!.rgba[i * 4], f256!.rgba[i * 4 + 1], f256!.rgba[i * 4 + 2]);
      if (L > 200) whites++;
    }
    expect(
      whites,
      `256 档有 ${whites} 个"低α且发亮"的像素（改前 662、修好后 474）—— 疑似白边回来了`,
    ).toBeLessThan(560);
  });

  it("ICONHALO-196-3 反向守卫：形状与主体不许被这次颜色修复动到", () => {
    /* 这一条是"修复只该改颜色、不该改形状"的守卫：
       α>0 的像素数与"完全不透明"的像素数必须落在合理范围（改前改后实测完全相等）。
       若有人拿重采样工具重做整个图标，这两个数会明显变化 ⇒ 本门禁会提醒复核。 */
    const f256 = readFrames(ICO).find((f) => f.w === 256)!;
    let on = 0, full = 0;
    for (let i = 0; i < f256.w * f256.h; i++) {
      const a = f256.rgba[i * 4 + 3];
      if (a > 0) on++;
      if (a === 255) full++;
    }
    expect(on, `256 档 α>0 的像素数变成 ${on}（修复时实测 62325）`).toBe(62325);
    expect(full, `256 档完全不透明的像素数变成 ${full}`).toBeGreaterThan(50000);
  });
});
