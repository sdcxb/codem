/**
 * 版面自检脚本（开发工具）。
 *
 * 用 headless 浏览器在**多个窗口宽度**下渲染 `tools/preview?audit=1`
 * （只渲染「任务管理 → 图书馆」视图，容器尺寸 = 宿主面板尺寸
 * `min(1180px, 96vw) × min(720px, 88vh)`），读取页面自检写出的
 * `#layout-audit` 报告，检查：
 * - 有没有元素横向/纵向溢出被裁切（挤在一起、看不全）
 * - 最小字号是否低于可读阈值
 *
 * 用法：node tools/preview/audit-layout.mjs [url]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const URL_BASE = process.argv[2] ?? "http://localhost:4599";
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error("✗ 找不到 msedge.exe");
  process.exit(1);
}

/** 覆盖常见分辨率：大屏 / 笔记本 / 窄窗口 / 半屏 / 小窗 */
const VIEWPORTS = [
  { w: 1600, h: 1000, label: "1600×1000" },
  { w: 1440, h: 900, label: "1440×900" },
  { w: 1280, h: 800, label: "1280×800" },
  { w: 1100, h: 720, label: "1100×720" },
  { w: 980, h: 700, label: "980×700" },
  { w: 860, h: 640, label: "860×640" },
  { w: 760, h: 600, label: "760×600" },
];

const results = [];
let failed = 0;

for (const vp of VIEWPORTS) {
  const dom = execFileSync(
    edge,
    [
      "--headless=old",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=9000",
      `--window-size=${vp.w},${vp.h}`,
      "--dump-dom",
      `${URL_BASE}/?audit=1`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const m = /<pre id="layout-audit">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) {
    results.push({ viewport: vp.label, error: "没有拿到 #layout-audit（页面没渲染出来？）" });
    failed++;
    continue;
  }
  const report = JSON.parse(
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
  const overflow = report.overflow ?? [];
  const tooSmall = (report.minFontPx ?? 12) < 10;
  const ok = overflow.length === 0 && !tooSmall;
  if (!ok) failed++;
  results.push({
    viewport: vp.label,
    panelWidth: report.rootWidth,
    overflow: overflow.length,
    overflowSample: overflow.slice(0, 4),
    minFontPx: report.minFontPx,
    ok,
  });
}

console.log(JSON.stringify({ results, failed }, null, 2));
process.exit(failed > 0 ? 1 : 0);
