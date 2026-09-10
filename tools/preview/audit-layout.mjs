/**
 * 版面自检脚本（开发工具）。
 *
 * 用 headless 浏览器在**多个窗口宽度**下渲染 `tools/preview?audit=1`：页面会逐个
 * 切到「图书馆」页签的每个子视图（场景/用量/会话/工具/成本/错误/时间线/设置），
 * 逐元素检查「被裁切」「元素互相重叠」，结果写进 `#layout-audit`。
 *
 * 用法：node tools/preview/audit-layout.mjs [url] [--verbose]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const URL_BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:4599";
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
      "--virtual-time-budget=15000",
      `--window-size=${vp.w},${vp.h}`,
      "--dump-dom",
      `${URL_BASE}/?audit=1`,
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
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
  const views = (report.views ?? []).map((v) => ({
    tab: v.tab,
    clipped: v.clipped.length,
    overlapping: v.overlapping.length,
    minFontPx: v.minFontPx,
    ...(verbose && (v.clipped.length || v.overlapping.length)
      ? { detail: { clipped: v.clipped.slice(0, 6), overlapping: v.overlapping.slice(0, 6) } }
      : {}),
  }));
  const bad = views.filter((v) => v.clipped > 0 || v.overlapping > 0);
  if (bad.length > 0) failed++;
  results.push({ viewport: vp.label, panelWidth: report.views?.[0]?.rootWidth ?? 0, views, badViews: bad.map((b) => b.tab) });
}

console.log(JSON.stringify({ results, failed }, null, 2));
process.exit(failed > 0 ? 1 : 0);
