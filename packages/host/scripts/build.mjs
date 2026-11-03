#!/usr/bin/env node
/**
 * 把 `codem-host` 打成**单文件 ESM**（`packages/host/dist/host.mjs`）。
 *
 * 为什么必须打包而不是直接 `node src/cli.ts`：
 * - Host 要被当 sidecar 拉起（Tauri）与在 PRoot 里被前台服务拉起（Android），
 *   两者都希望"一个入口文件 + 相对资源"，而不是"先装依赖再跑"；
 * - 打包会把 `src/core/**` 里 Host 用到的部分（agent 循环、存储层、提示构建…）
 *   一并固化，**同一份产物**在 PC 与 Android 上跑 —— 这是"两端行为一致"的前提。
 *
 * 刻意 external 的依赖：
 * - `@huggingface/transformers` / `onnxruntime-node`：本地 embedding 用的原生模块，
 *   只有真正做语义检索时才加载（动态 import），打进 bundle 会让体积膨胀 hundreds MB；
 * - `@tauri-apps/*`：渲染侧模块的静态 import（Host 路径不会调用它）。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

await build({
  entryPoints: [join(pkgRoot, "src", "cli.ts")],
  outfile: join(pkgRoot, "dist", "host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
  absWorkingDir: repoRoot,
  // 让 `@codem/protocol` 与仓库内相对引用都能被解析到源码（不依赖 npm workspaces）
  alias: {
    "@codem/protocol": join(repoRoot, "packages", "protocol", "src", "index.ts"),
  },
  external: [
    // 只外置**原生/可选**依赖。设备（PRoot）上没有 node_modules，
    // 纯 JS 的包（含 @tauri-apps/api）必须打进来，否则运行时报 ERR_MODULE_NOT_FOUND。
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ],
  banner: {
    // ESM 里 `require` 不存在，而被打包进来的部分 CommonJS 依赖可能探测它。
    js: "import { createRequire as __codemCreateRequire } from 'node:module'; const require = __codemCreateRequire(import.meta.url);",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
});

process.stdout.write(`[build-host] ${join(pkgRoot, "dist", "host.mjs")}\n`);
