#!/usr/bin/env node
/**
 * 把**桌面网关共享 UI**放进安装包（ADR-0005 M4）。
 *
 * 产物（`src-tauri/resources/host/web/`，被 `tauri.conf.json` 的
 * `resources/host/web/**` 白名单打进安装包）：
 * - `index.html`：手机壳
 * - `ui.js`：共享 UI bundle（`npm run host:build:ui` 生成）
 * - `ui.css`：共享组件样式（同一次 build:ui 生成）
 *
 * 桌面 Host sidecar 已退役：本脚本**不再**生成/复制 `host.mjs` 与
 * `codem-db-cli.exe`，并会主动清掉输出目录里旧版本遗留的这两份文件，
 * 防止覆盖安装时又被 `tauri.conf.json` 带进安装包。Android 本机 Host 的
 * 产物由 `android-shell/` 自己的构建链准备，不走这里。
 *
 * 幂等、可重复执行；`--check` 只校验不写（三件套齐全且没有旧 sidecar 残留）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outDir = join(repoRoot, "src-tauri", "resources", "host");
const webOut = join(outDir, "web");
const checkOnly = process.argv.includes("--check");

const sources = {
  index: join(repoRoot, "packages", "host", "web", "index.html"),
  ui: join(repoRoot, "packages", "host", "web", "ui.js"),
  css: join(repoRoot, "packages", "host", "web", "ui.css"),
};

/** 桌面 Host sidecar 退役后不应再出现在安装包里的旧产物。 */
const staleFiles = ["host.mjs", "codem-db-cli.exe"];

const missing = Object.entries(sources).filter(([, p]) => !existsSync(p));
if (missing.length) {
  console.error(`[stage-host] 缺少输入：\n${missing.map(([k, p]) => `  - ${k}: ${p}`).join("\n")}`);
  process.exit(1);
}

const stale = staleFiles.filter((name) => existsSync(join(outDir, name)));

if (checkOnly) {
  const missingOutputs = Object.entries({
    "index.html": join(webOut, "index.html"),
    "ui.js": join(webOut, "ui.js"),
    "ui.css": join(webOut, "ui.css"),
  })
    .filter(([, p]) => !existsSync(p))
    .map(([name]) => name);
  if (missingOutputs.length || stale.length) {
    if (missingOutputs.length) console.error(`[stage-host] 缺少产物：${missingOutputs.join(", ")}`);
    if (stale.length) console.error(`[stage-host] 旧 Host sidecar 产物仍在：${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("[stage-host] OK");
  process.exit(0);
}

mkdirSync(webOut, { recursive: true });
for (const name of stale) {
  rmSync(join(outDir, name), { force: true });
  console.log(`[stage-host] 已移除旧产物 ${name}`);
}
copyFileSync(sources.index, join(webOut, "index.html"));
copyFileSync(sources.ui, join(webOut, "ui.js"));
copyFileSync(sources.css, join(webOut, "ui.css"));

const size = (p) => statSync(p).size;
console.log(
  `[stage-host] OK → ${webOut}\n` +
    `  index.html ${(size(join(webOut, "index.html")) / 1024).toFixed(0)} KB\n` +
    `  ui.js      ${(size(join(webOut, "ui.js")) / 1024).toFixed(0)} KB\n` +
    `  ui.css     ${(size(join(webOut, "ui.css")) / 1024).toFixed(0)} KB`,
);
