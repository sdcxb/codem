/**
 * LOGO-192：状态栏 logo 的 `srcset`（第 192 轮）
 *
 * ## 为什么要有这一套
 *
 * 用户报「安装包和安装后运行时状态栏的 logo 出问题了，变的很模糊了，是用错 logo 了吗？
 * 现在你开发模式状态栏这个 logo 是对的。」
 *
 * 逐项查下来的结论（都留了证据，别被"换 logo"带偏）：
 *
 * 1. **不是用错 logo**。装机版运行时 `currentSrc` 的字节与 `src/assets/codem-logo.png`
 *    **逐字节相同**（64889 B / sha256 `795e2f00c1b78f49`）。
 * 2. **不能拿 `src-tauri/icons/codem-logo.svg` 去重渲**。`git log` 显示
 *    `src/assets/codem-logo.png` 只有一次提交 `e2cb281`（2026-09-08）：
 *    「修复: 标题栏 logo 换成当前品牌 — 自 icos/codem.ico 提取 256px PNG,
 *      移除误用的旧 svg logo」。svg 是**被移除的旧品牌**，两者不是同一张图
 *    （实测实心像素 p50：位图 (110,92,180)，svg (120,97,244)，蓝通道差 64）。
 *    拿 svg 重渲 = 把已修好的问题改回去。
 * 3. **真因是降采样比例**。状态栏画 18 CSS px，dpr3 ⇒ **54 物理像素**，
 *    而源图 256px ⇒ **4.74:1**。Chromium 大比例降采样用固定小核，丢掉高频、抹开刃口。
 *    补 1x/2x/3x 三档后浏览器选 54px 档 ⇒ 比例≈1:1。
 *
 * ## 这里断言什么
 *
 * 单测跑在 jsdom 里，**没有真实渲染管线**，量不出刃口宽度（那个由
 * `.preview-shot/_probe-192-logo-sharp-compare.mjs` 用 CDP 在真 dpr3 下量：
 * 刃口 3.91→3.59 px，边缘能量 9.915→11.777，A/B 都校验过确实选了不同的文件）。
 * 所以这里只钉**静态契约** —— 它们是那个实测结论能被复现的前提，一旦被改动就会失效：
 *
 *   · `srcset` 必须**含 1x 档**（第一版只有 2x/3x，dpr1 下浏览器没有 1x 候选可挑，
 *     退回最小档 —— 修 A 引入 B）
 *   · 三档必须来自 `codem-logo.png` 及其派生 36/54，**不得**出现 `codem-logo.svg`
 *   · 档位像素尺寸必须与文件名一致（读 PNG 头，不信文件名）
 *   · 派生图必须与源图**同色系**（防止哪天有人把它换成别的图还自称"修糊了"）
 *   · TitleBar 必须真的用上 `srcset`，且**不得**出现 `sizes`（x 描述符配 sizes 是语义错配）
 *   · 显示尺寸仍是 18px（改了这个值，档位就得重新算）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = process.cwd();
const ASSETS = path.join(ROOT, "src/assets");

/** 读 PNG IHDR 的真实宽高（不信文件名） */
function pngSize(file) {
  const b = readFileSync(file);
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (!isPng) throw new Error(`${file} 不是 PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

/** 解 PNG 成 RGBA（8 位 ct=2/6），用于"同色系"断言 */
function decodePng(file) {
  const b = readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), depth = b[24], colorType = b[25];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`${file}: depth=${depth} ct=${colorType} 不支持`);
  const bpp = colorType === 6 ? 4 : 3;
  const idat = [];
  let p = 8;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, bb = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += bb; else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

/** 实心像素（alpha≥250）的平均 RGB —— 用于判断"是不是同一张图" */
function solidMeanRgb(file) {
  const { w, h, bpp, data } = decodePng(file);
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp;
    const a = bpp === 4 ? data[s + 3] : 255;
    if (a < 250) continue;
    r += data[s]; g += data[s + 1]; b += data[s + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

const SRCSET_MODULE = path.join(ASSETS, "codem-logo-srcset.ts");
const TITLEBAR = path.join(ROOT, "src/components/TitleBar.tsx");

describe("LOGO-192 状态栏 logo 多档尺寸", () => {
  it("LOGO-192-1 srcset 模块存在且导出 1x/2x/3x 三档", () => {
    expect(existsSync(SRCSET_MODULE), `缺 ${SRCSET_MODULE}`).toBe(true);
    const src = readFileSync(SRCSET_MODULE, "utf8");
    /* 三个档位描述符都必须在 */
    expect(src, "缺 1x 档：dpr1 下浏览器会退回最小档").toMatch(/\$\{i \+ 1\}x/);
    /* 三张图都必须被 import */
    for (const f of ["codem-logo.png", "codem-logo-36.png", "codem-logo-54.png"]) {
      expect(src, `srcset 模块没有 import ${f}`).toContain(`./${f}`);
    }
  });

  it("LOGO-192-2 srcset 不得引用 svg 旧品牌（e2cb281 已移除）", () => {
    const src = readFileSync(SRCSET_MODULE, "utf8");
    const imports = src.split("\n").filter((l) => l.trim().startsWith("import "));
    expect(imports.length, "应当恰好 import 三张位图").toBe(3);
    for (const l of imports) {
      expect(l, `srcset 里出现了 svg 引用：${l}`).not.toMatch(/\.svg/);
    }
    /* 整个 src/assets 下不该有 svg（svg 在 src-tauri/icons，属旧品牌，别复制过来） */
    expect(existsSync(path.join(ASSETS, "codem-logo.svg"))).toBe(false);
  });

  it("LOGO-192-3 每档的真实像素尺寸等于文件名里的数字", () => {
    for (const s of [18, 36, 54, 72]) {
      const f = path.join(ASSETS, `codem-logo-${s}.png`);
      if (!existsSync(f)) continue;   // 只校验存在的那几档
      const { w, h } = pngSize(f);
      expect(`${w}x${h}`, `codem-logo-${s}.png 的实际尺寸不是 ${s}×${s}`).toBe(`${s}x${s}`);
    }
    /* 本设计用到的三档必须都在（1x 复用 256px 原图） */
    for (const f of ["codem-logo.png", "codem-logo-36.png", "codem-logo-54.png"]) {
      expect(existsSync(path.join(ASSETS, f)), `缺 ${f}`).toBe(true);
    }
    /* 2x/3x 的尺寸必须正好是 18 的 2 倍 / 3 倍（对齐 dpr2 / dpr3） */
    expect(pngSize(path.join(ASSETS, "codem-logo-36.png")).w).toBe(18 * 2);
    expect(pngSize(path.join(ASSETS, "codem-logo-54.png")).w).toBe(18 * 3);
  });

  it("LOGO-192-4 派生图与源图同色系（防止被换成别的图还自称修糊了）", () => {
    const base = solidMeanRgb(path.join(ASSETS, "codem-logo.png"));
    for (const f of ["codem-logo-36.png", "codem-logo-54.png"]) {
      const m = solidMeanRgb(path.join(ASSETS, f));
      for (let c = 0; c < 3; c++) {
        /* 容差 12 灰阶：同一张图不同采样方式的均值差远小于这个
           （实测 54px 档 vs 源图逐通道最大差 ≈ 8）。
           而"换成 svg 旧品牌"的蓝通道会差 60+，会被这条直接拦下。 */
        expect(
          Math.abs(m[c] - base[c]),
          `${f} 第 ${c} 通道均值 ${m[c].toFixed(1)} 与源图 ${base[c].toFixed(1)} 差得太多（疑似换了图）`,
        ).toBeLessThanOrEqual(12);
      }
    }
  });

  it("LOGO-192-5 TitleBar 用上 srcset，且不写 sizes（x 描述符配 sizes 是语义错配）", () => {
    const src = readFileSync(TITLEBAR, "utf8");
    expect(src, "TitleBar 没有 import srcset 模块").toContain("CODEM_LOGO_SRCSET");
    expect(src, "TitleBar 的 img 没有用上 srcSet").toMatch(/srcSet=\{CODEM_LOGO_SRCSET\}/);
    /* 取那段 img 的 JSX，确认没有 sizes */
    const imgBlock = src.match(/<img[\s\S]{0,600}?className="titlebar-logo-img"[\s\S]{0,120}?\/>/);
    expect(imgBlock, "没找到 titlebar-logo-img 的 img 标签").toBeTruthy();
    expect(imgBlock[0], "x 描述符不该配 sizes").not.toMatch(/\bsizes\s*=/);
    /* 必须仍有 src 兜底（不支持 srcset 的环境行为与改动前一致） */
    expect(imgBlock[0]).toMatch(/\bsrc=\{codemLogoUrl\}/);
    expect(imgBlock[0]).toContain('alt="Codem"');
  });

  it("LOGO-192-6 显示尺寸仍是 18px（改了它，档位就得重算）", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const m = css.match(/\.titlebar-logo-img\s*\{([^}]*)\}/);
    expect(m, "styles.css 里没有 .titlebar-logo-img 规则").toBeTruthy();
    expect(m[1], "显示宽度变了 ⇒ 36/54 两档不再对齐 dpr2/dpr3").toMatch(/width:\s*18px/);
    expect(m[1]).toMatch(/height:\s*18px/);
  });
});
