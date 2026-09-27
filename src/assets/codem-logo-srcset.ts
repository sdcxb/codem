/**
 * 状态栏 logo 的 `srcset`（**自动生成**，见 `.preview-shot/_gen-logo-sizes-192.mjs`）。
 *
 * ## 为什么需要它（第 192 轮）
 *
 * 状态栏把 logo 画在 **18 CSS px** 上。在 dpr=3 的屏上那就是 **54 物理像素**，
 * 而源图是 256px ⇒ 比例 **4.74:1**。Chromium 在大比例降采样时用**固定小核**，
 * 会丢掉源图高频、把刃口抹开 —— 用户看到的就是"装机版 logo 变糊了"。
 * 给出 1x/2x/3x 三档，浏览器按 dpr 选最接近的一档，比例≈1:1，不再需要它自己降。
 *
 * ⚠️ **1x 档必须写出来**。第一版只写了 2x/3x，结果在 dpr=1 的环境里浏览器
 * **没有 1x 候选可挑，退回到最小的那一档**（实测 natural 变成 18×18，等于把 2x 图
 * 当 1x 用）—— 那是"修 A 引入 B"，所以这里显式给全三档。
 *
 * ## 事实澄清（别被"换个 logo"带偏）
 *
 * · **不是用错 logo**：装机版运行时加载的字节与源文件**逐字节相同**
 *   （64889 B / sha256 `795e2f00c1b78f49`）。
 * · 36/54 两档是**从 `codem-logo.png` 本身派生的**（离线 Lanczos-3，预乘 α 空间），
 *   颜色逐像素忠于现状；**绝不能**改用 `src-tauri/icons/codem-logo.svg` ——
 *   那是**旧品牌**，`e2cb281`（2026-09-08）已明确移除它并换成当前品牌位图。
 */
import logo256 from "./codem-logo.png";
import logo36 from "./codem-logo-36.png";
import logo54 from "./codem-logo-54.png";

/** 1x / 2x / 3x 三档，都源自同一张品牌位图 */
export const CODEM_LOGO_SRCSET = [logo256, logo36, logo54].map((u, i) => `${u} ${i + 1}x`).join(", ");
