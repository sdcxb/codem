#!/usr/bin/env node
/**
 * 生成 updater 清单 `latest.json` —— **不带 BOM**、**键是 v2 写法**。
 *
 * 用法：
 * ```text
 * node tools/release/make-latest-json.mjs <version> ["更新提示里的一句说明"] [--out <path>] [--sig <path>]
 * ```
 * 缺省从 `src-tauri/target/release/bundle/nsis/Codem_<version>_x64-setup.exe.sig` 读签名，
 * 写到仓库根目录的 `latest.json`（`src/test/version-consistency.test.ts` 的 VERSION-5 校验的就是它）。
 *
 * ## 两条**踩过坑**的实现约束（别改回去）
 *
 * 1. **不能用 PowerShell 的 `Set-Content -Encoding UTF8`**：PS 5.1 会写 UTF-8 **BOM**（`EF BB BF`），
 *    而 Tauri updater 在 Rust 侧用 `serde_json` 解析，**不认识 BOM** ⇒ 直接报
 *    "expected value at line 1 column 1"，也就是**自动更新整个失效**。
 *    线上真出过这事（第一版生成的 latest.json 前 3 字节确实是 `ef bb bf`），所以这里用 Node 写无 BOM。
 * 2. **平台键必须是 `windows-x86_64-nsis` / `windows-x86_64`**（Tauri v2 的写法）。
 *    旧实现写的是 `platforms.windows`（v1 写法），v2 更新器两个候选键都找不到 ⇒
 *    「检查更新」报 `None of the fallback platforms [...] were found`。
 *    构造逻辑现在收口在 `tools/release/latest-json.mjs`（唯一一份），这里只做 I/O 与自检。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildLatestManifest, validateLatestManifest, assetName } from "./latest-json.mjs";

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--out") && !(i > 0 && argv[i - 1] === "--sig"));
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const version = positional[0];
if (!version) {
  console.error('用法: node tools/release/make-latest-json.mjs <version> ["说明"] [--out <path>] [--sig <path>]');
  process.exit(2);
}
const notes = positional[1] ?? `Codem v${version} — 见 CHANGELOG 的 [${version}] 段（完整修复清单与实测数字）`;
const sigPath = flag("--sig", `src-tauri/target/release/bundle/nsis/${assetName(version)}.sig`);
const outPath = flag("--out", "latest.json");

if (!existsSync(sigPath)) {
  console.error(`找不到签名文件：${sigPath}（没有签名就不该发布）`);
  process.exit(1);
}

const manifest = buildLatestManifest({ version, signature: readFileSync(sigPath, "utf8"), notes });
const problems = validateLatestManifest(manifest, { version });
if (problems.length) {
  console.error(`✗ 清单自检不通过，拒绝写出：\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

// 手写 JSON 而不是 JSON.stringify 的默认缩进：保证结尾有换行、字段顺序稳定（便于 diff 复核）
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });

// 回读验证（脚本自己的"成功"日志不算证据）
const bytes = readFileSync(outPath);
const back = JSON.parse(bytes.toString("utf8"));
const noBom = bytes.subarray(0, 3).toString("hex") !== "efbbbf";
console.log(
  `latest.json 已写入 ${outPath}：version=${back.version} sig_len=${manifest.platforms["windows-x86_64"].signature.length} ` +
  `平台键=${Object.keys(back.platforms).join(",")} 无 BOM=${noBom ? "✓" : "✗（更新器会解析失败）"}`,
);
if (!noBom) process.exit(1);
