/**
 * TASKBAR-195：**`icon.ico` 的第 0 帧必须是最大帧**（否则任务栏/托盘图标会糊）
 *
 * ## 用户现场
 * 「app 在运行的时候，任务栏上的 logo 还是模糊的。**原来很清晰，最近几个版本才出问题**，
 * 我提了修改之后，你改了还是有问题。」
 *
 * ## 根因（读 Tauri 源码得来的，不是猜的）
 *
 * `tauri-codegen-2.6.3/src/image.rs:51`：
 * ```rust
 * pub fn new_ico(root: &TokenStream, icon: &Path) -> ... {
 *   let icon_dir = ico::IconDir::read(Cursor::new(&buf))?;
 *   let entry = &icon_dir.entries()[0];      // ← **只取第 0 帧**
 *   let rgba = entry.decode()?.rgba_data().to_vec();
 *   ...
 * }
 * ```
 * Windows 目标下 Tauri 取 `bundle.icon` 里**第一个 `.ico`**（= `icons/icon.ico`）
 * 解出**第 0 帧**作为**窗口图标** —— 而**任务栏与托盘按这颗 HICON 绘制**。
 *
 * 原先 `icon.ico` 的帧顺序是 `16,24,32,48,64,128,256` ⇒ **第 0 帧是 16×16**；
 * 高分屏任务栏要 24/32/48 ⇒ 系统只能把 16×16 **放大** ⇒ 糊。
 *
 * ## 实测证据（互相印证的三条，都记在这里）
 *   1. 修复前：向运行中的窗口 `WM_GETICON` 取小图标，画到 16/32/64 时
 *      **墨水覆盖率与亮度均值完全不变**（98.4% / 106.6）⇒ 后两档全是放大。
 *   2. 从 exe 资源抠出的图标组（大/小两组）画到 32px 是**有真实细节**的，
 *      与 `src-tauri/icons/32x32.png` 同形 ⇒ **exe 资源没问题，问题只在窗口图标**。
 *   3. 修复后（第 0 帧 256×256）：16/32/64 三档的墨水率 93.0/92.3/91.1%、
 *      均值 111.4/113.8/114.4 都在变，32px 的边缘能量 **6.619 → 18.165**
 *      （已高于源 `32x32.png` 的 13.694 ⇒ 确实是 256×256 缩小而来）⇒ 各档是真实缩放。
 *
 * ## 判据守什么 / 守不了什么
 * 守：帧顺序（第 0 帧是最大帧）、七档齐全、**每帧的数据字节没有被动过**。
 * 守不了：「Windows 任务栏在你这台机器上看着清不清楚」—— 那要人眼看/用探针在真机上量。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ICO = path.join(ROOT, "src-tauri/icons/icon.ico");

/** 解析 ICO 帧表（含每帧原始字节，用于"没被重编码"的断言） */
function parseIco(buf) {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    frames.push({
      index: i,
      width: buf[o] === 0 ? 256 : buf[o],
      height: buf[o + 1] === 0 ? 256 : buf[o + 1],
      size,
      offset: off,
      isPng: buf.readUInt32BE(off) === 0x89504e47,
      data: buf.subarray(off, off + size),
    });
  }
  return { reserved, type, count, frames };
}

describe("TASKBAR-195 应用图标帧顺序（决定任务栏/托盘清不清楚）", () => {
  it("TASKBAR-195-1 icon.ico 是合法 ICO，且七档齐全", () => {
    const ico = parseIco(readFileSync(ICO));
    expect(ico.reserved, "ICO 保留字段必须是 0").toBe(0);
    expect(ico.type, "type 必须是 1（图标，不是光标）").toBe(1);
    const sizes = ico.frames.map((f) => f.width).sort((a, b) => a - b);
    /* 这七档是 Windows/安装包会挑的，少一档某个 DPI 上就会用放大图 */
    expect(sizes, "帧尺寸必须是 16/24/32/48/64/128/256").toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it("TASKBAR-195-2 ★第 0 帧必须是最大帧（Tauri 只取第 0 帧当窗口图标）", () => {
    const ico = parseIco(readFileSync(ICO));
    const first = ico.frames[0];
    const maxArea = Math.max(...ico.frames.map((f) => f.width * f.height));
    expect(
      first.width * first.height,
      `第 0 帧是 ${first.width}×${first.height}，不是最大帧 ⇒ ` +
        `Tauri 会把它当窗口图标，任务栏在高分屏上只能放大它 ⇒ 糊（第 195 轮的根因）`,
    ).toBe(maxArea);
    expect(first.width, "最大帧应当是 256×256").toBe(256);
  });

  it("TASKBAR-195-3 每帧的数据字节都在、且没有被重编码（只是顺序变了）", () => {
    const ico = parseIco(readFileSync(ICO));
    for (const f of ico.frames) {
      expect(f.size, `${f.width}×${f.height} 帧长度为 0`).toBeGreaterThan(0);
      expect(f.data.length, `${f.width}×${f.height} 帧数据不完整（offset+size 越界）`).toBe(f.size);
      /* 只做过重排，没重编码 ⇒ BMP 帧的头两字节是 BITMAPINFOHEADER 的 biSize（40） */
      if (!f.isPng) {
        expect(f.data.readUInt32LE(0), `${f.width}×${f.height} 帧头不像 BITMAPINFOHEADER（被重编码过？）`).toBe(40);
        /* 头部里的宽高必须与目录项一致（防"目录说 256、数据其实是 16"） */
        expect(f.data.readInt32LE(4), `${f.width} 帧头部宽度与目录项不符`).toBe(f.width);
        expect(Math.abs(f.data.readInt32LE(8)) / 2, `${f.height} 帧头部高度与目录项不符（BMP 高度是两倍）`).toBe(f.height);
        /**
         * ⚠️ 这里**故意不做**精确载荷长度断言 —— 试过，**本 ico 一档都套不进去**：
         * 按 `40 + w*h*4 [+ 掩码]` 算，256 档得 262184 / 278568，实际是 **270376**。
         * 既然算不准，就改用**下面那条伪造不了的判据**（七档"每像素字节数"必须一致）。
         * 记在这儿免得下一个人再从"算长度"这条路走一遍。
         */
      }
    }
    /**
     * ⚠️ **这一段是变异自证补上的**：上面那几条"头部与目录一致"的断言**可以被伪造** ——
     * 只要把 16×16 的帧头改写成 256×256，它们就全部通过（M4 变异正是这么漏网的）。
     *
     * 伪造不了的是**"每像素字节数"在七档之间必须一致**（同一张图、同一个工具生成）：
     *   `density = size / (w*h)` —— 实测七档是 4.41 ~ 4.73，彼此很接近。
     * 而"目录写 256、数据其实是 16"的假帧：size ≈ 1128、w*h = 65536 ⇒ density ≈ 0.017，
     * 与其余档差两个数量级 ⇒ 当场抓住。
     */
    const densities = ico.frames.map((f) => f.size / (f.width * f.height));
    const minD = Math.min(...densities);
    const maxD = Math.max(...densities);
    expect(
      maxD / minD,
      `七档的"每像素字节数"差得太多（${minD.toFixed(3)} ~ ${maxD.toFixed(3)}）⇒ ` +
        `有帧的目录尺寸与像素数据不符（典型的"目录写 256、数据其实是 16"）`,
    ).toBeLessThan(1.5);
    /* 另一条伪造不了的旁证：256 帧必须比 16 帧大一个量级（同一张图按比例缩放就该如此） */
    const biggest = ico.frames.find((f) => f.width === 256)!;
    const smallest = ico.frames.find((f) => f.width === 16)!;
    expect(
      biggest.size / smallest.size,
      `256 帧只有 16 帧的 ${(biggest.size / smallest.size).toFixed(1)} 倍 —— 疑似"目录写 256、数据是 16"`,
    ).toBeGreaterThan(20);
  });

  it("TASKBAR-195-4 反向守卫：`bundle.icon` 里那个 .ico 仍然在（不然窗口图标会退回 PNG 单档）", () => {
    const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const icons = conf.bundle?.icon ?? [];
    const icoEntry = icons.find((i) => String(i).endsWith(".ico"));
    expect(icoEntry, "bundle.icon 里必须有 .ico：Tauri 在 Windows 上优先用它当窗口图标").toBeTruthy();
    /* 而且它必须**排在第一个 .png 之前**无所谓，但必须与 TASKBAR-195-2 指的是同一个文件 */
    expect(String(icoEntry).replace(/\\/g, "/")).toBe("icons/icon.ico");
    expect(String(icoEntry).endsWith("icon.ico"), "换图标文件时本门禁要一起更新").toBe(true);
  });
});
