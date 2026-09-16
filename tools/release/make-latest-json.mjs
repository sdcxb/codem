#!/usr/bin/env node
/**
 * 生成 updater 清单 latest.json —— **不带 BOM**。
 *
 * ## 为什么不能用 PowerShell 的 Set-Content -Encoding UTF8
 *
 * PowerShell 5.1 的 `-Encoding UTF8` 会写 **UTF-8 BOM**（`EF BB BF`）。
 * 而 Tauri updater 在 Rust 侧用 `serde_json` 解析这个文件，
 * `serde_json::from_str` / `from_slice` **不认识 BOM** —— 会直接报
 * "expected value at line 1 column 1"，也就是**自动更新整个失效**。
 *
 * 实测确认过：第一版用 Set-Content 生成的 latest.json 线上确实带 BOM
 * （前 3 字节 ef bb bf）。所以这里用 Node 写无 BOM 的 UTF-8。
 */

import fs from "node:fs";
import path from "node:path";

const version = process.argv[2] ?? "1.16.44";
const repo = "sdcxb/codem";
const sigPath = path.join(
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Codem_${version}_x64-setup.exe.sig`,
);
if (!fs.existsSync(sigPath)) {
  console.error(`找不到签名文件：${sigPath}`);
  process.exit(1);
}
const signature = fs.readFileSync(sigPath, "utf8").trim();
const manifest = {
  version,
  notes: `Codem v${version} — SQLite 搬出渲染进程，默认走 Rust 原生实现（第 92 波）`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    windows: {
      signature,
      url: `https://github.com/${repo}/releases/download/v${version}/Codem_${version}_x64-setup.exe`,
    },
  },
};
const out = path.join("src-tauri", "target", "release", "latest.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2), { encoding: "utf8" });
const bytes = fs.readFileSync(out);
console.log(`已写入 ${out}（${bytes.length} 字节）`);
console.log("前 3 字节:", bytes.subarray(0, 3).toString("hex"), bytes.subarray(0, 3).toString("hex") === "efbbbf" ? "← 仍有 BOM（不该）" : "← 无 BOM ✓");
console.log("version:", manifest.version, "| sig 长度:", signature.length);
