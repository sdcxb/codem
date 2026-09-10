/**
 * 版面探针（开发工具）：抓取 ?audit=1 页面写入的 #layout-audit，打印指定子视图的
 * 关键容器矩形与溢出量，用于定位「被遮挡 / 被裁切」类问题。
 *
 * 用法：node tools/preview/probe-layout.mjs [tab] [url]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const tab = process.argv[2] ?? "board";
const url = process.argv[3] ?? "http://localhost:4599";
const edge = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!edge) {
  console.error("✗ 找不到 msedge.exe");
  process.exit(1);
}

const dom = execFileSync(
  edge,
  [
    "--headless=old",
    "--disable-gpu",
    "--no-sandbox",
    "--virtual-time-budget=15000",
    "--window-size=1440,900",
    "--dump-dom",
    `${url}/?audit=1`,
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
const m = /<pre id="layout-audit">([\s\S]*?)<\/pre>/.exec(dom);
if (!m) {
  console.error("✗ 没有拿到 #layout-audit");
  process.exit(1);
}
const decoded = m[1]
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");
const report = JSON.parse(decoded);
const view = report.views.find((v) => v.tab === tab);
if (!view) {
  console.error(`✗ 报告里没有 ${tab} 视图（有：${report.views.map((v) => v.tab).join(", ")}）`);
  process.exit(1);
}
console.log(JSON.stringify({ viewport: report.viewport, tab, ...view }, null, 2));
