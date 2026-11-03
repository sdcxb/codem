#!/usr/bin/env node
/**
 * 把 `packages/ui` 的浏览器入口打成 `packages/host/web/ui.js`（IIFE，全局 `CodemUI`），
 * 并把共享组件样式 `packages/ui/src/ui.css` 生成为 `packages/host/web/ui.css`。
 *
 * 阶段 2 的第一块：手机壳与未来的 React 组件共用**同一份**传输客户端。
 * 产物是构建物，不进 git（见 .gitignore）。
 *
 * M4：桌面网关复用同一份手机壳；`stage-host-sidecar.mjs` 只 stage 这三件套，
 * 所以 CSS 必须和 JS 在同一次构建里产出（不能依赖仓库里恰好存在的旧文件）。
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outfile = join(repoRoot, "packages", "host", "web", "ui.js");
const cssOutfile = join(repoRoot, "packages", "host", "web", "ui.css");

await build({
  entryPoints: [join(repoRoot, "packages", "ui", "src", "browser.tsx")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110", "safari16"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": "\"production\"" },
  legalComments: "none",
  logLevel: "warning",
});

await build({
  entryPoints: [join(repoRoot, "packages", "ui", "src", "ui.css")],
  outfile: cssOutfile,
  bundle: true,
  minify: true,
  logLevel: "warning",
});

process.stdout.write(`[build-ui] ${outfile}\n[build-ui] ${cssOutfile}\n`);
