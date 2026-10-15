/**
 * 开发中间产物清理（**先出计划，--apply 才真删**）
 *
 * ## 为什么有这个脚本
 * 开发过程中 `src-tauri/target/` 与打包产物会涨到离谱的量级 —— 2026-10-15 实测：
 * 项目占用 **116 GB**，其中
 *   · `target/release/bundle` 里累积了 **364 个历史版本的安装包（31 GB）**
 *   · `target/debug` 42.65 GB、`target/release/build` 27.96 GB（都是可再生缓存）
 *   · `.preview-shot` 的评测产物与下载的参考源码 2.6 GB、`.codem-cache` 1.1 GB
 * 手动删这些既容易误删（用户数据/当前版本产物）又容易漏，所以落成一个可审计的脚本：
 * **默认只打印计划**，`--apply` 才动手，且把"保留什么"写在代码里。
 *
 * ## 用法
 *   node tools/maintenance/clean-dev-artifacts.mjs            # 看计划（不删任何东西）
 *   node tools/maintenance/clean-dev-artifacts.mjs --apply    # 执行
 *
 * ## 明确不碰（脚本里逐条列着）
 * - **用户数据**：`%APPDATA%\com.codem.app\codem-db-rust.bin`（会话/记忆）、`-wal`、备份快照、旧库
 * - **当前版本产物**：`Codem_<package.json 里的版本>_*` 与仓库根 `latest.json`（发版/复核要用）
 * - **源码与工具链**：src、tools、docs、node_modules、.git、`.preview-shot` 里的脚本（.mjs/.js/.md/.json）
 * - **对照仓库**：`.eac-ref` / `.deepseek-harness-ref` / `.oh-my-ppt-ref` / `.dsh-desktop-ref` / `.wecode-ref`
 * - **编译缓存**：`target/release/deps` 与 `.fingerprint`（留着下次构建快很多；真要腾地方再单独删）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPDATA = process.env.APPDATA ?? "";
const KEEP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const targets = [];
const add = (p, kind, reason) => {
  if (fs.existsSync(p)) targets.push({ p, kind, reason });
};
const addDir = (p, reason) => add(p, "dir", reason);
const addFile = (p, reason) => add(p, "file", reason);

/* ① 历史版本的打包产物（只留当前版本） */
for (const dir of [
  path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis"),
  path.join(ROOT, "src-tauri", "target", "release", "bundle", "msi"),
]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.includes(KEEP_VERSION)) continue;
    addFile(path.join(dir, f), "历史版本打包产物");
  }
}
for (const extra of ["wix", "app", "dmg", "deb", "appimage", "updater"]) {
  addDir(path.join(ROOT, "src-tauri", "target", "release", "bundle", extra), "历史打包中间产物");
}

/* ② 可再生的构建缓存 */
addDir(path.join(ROOT, "src-tauri", "target", "debug"), "dev 构建缓存（可再生）");
addDir(path.join(ROOT, "src-tauri", "target", "release", "build"), "build 脚本产物（可再生）");
addDir(path.join(ROOT, "dist"), "前端构建产物（可再生）");

/* ③ 缓存与日志 */
const CACHE_DIR = path.join(ROOT, ".codem-cache");
for (const c of ["zg-lab", "zvec-release", "verify-node-x", "archify", "zg-clean", "feature-tree"]) {
  addDir(path.join(CACHE_DIR, c), "下载/构建缓存");
}
if (fs.existsSync(CACHE_DIR)) {
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, f);
    if (fs.statSync(full).isFile() && /\.(zip|log|txt)$/i.test(f)) addFile(full, "缓存/日志");
  }
}

/* .preview-shot：删评测产物与下载的参考源码，保留脚本与清单 */
const PS = path.join(ROOT, ".preview-shot");
const KEEP_PS_EXT = new Set([".mjs", ".js", ".cjs", ".md", ".json"]);
const PS_KEEP_JSON = new Set(["audit-walk-allowlist.json"]);
function sweepPreview(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(_src-|_aa-repo|_zcode-ref|_isolated|_dl$|_obf$)/.test(e.name)) {
        addDir(full, "下载的参考源码/隔离副本");
        continue;
      }
      sweepPreview(full, depth + 1);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (KEEP_PS_EXT.has(ext)) continue;
      if (/\.(log|jsonl|png|zip|patch|diff|txt|csv)$/i.test(e.name) && !PS_KEEP_JSON.has(e.name)) {
        addFile(full, "评测产物/日志");
      }
    }
  }
}
sweepPreview(PS);

/* 应用运行日志（不动库与快照） */
const APP = path.join(APPDATA, "com.codem.app");
if (APP && fs.existsSync(APP)) {
  for (const f of fs.readdirSync(APP)) {
    if (/^codem-runtime-.*\.log$/.test(f)) addFile(path.join(APP, f), "应用运行日志");
  }
}

/* 统计（目录递归求和；单项读不到不影响整体） */
const sizeOf = (t) => {
  const st = fs.statSync(t.p);
  if (st.isFile()) return st.size;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      } catch {
        /* 忽略单个不可读文件 */
      }
    }
  };
  walk(t.p);
  return total;
};

let totalBytes = 0;
for (const t of targets) {
  try {
    t.bytes = sizeOf(t);
  } catch {
    t.bytes = 0;
  }
  totalBytes += t.bytes;
}
const byReason = new Map();
for (const t of targets) {
  const cur = byReason.get(t.reason) ?? { n: 0, bytes: 0 };
  cur.n += 1;
  cur.bytes += t.bytes;
  byReason.set(t.reason, cur);
}
console.log(`保留版本：${KEEP_VERSION}（其安装包与根目录 latest.json 不删）`);
console.log(`计划清理 ${targets.length} 项，合计 ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);
for (const [reason, v] of [...byReason.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  - ${reason}: ${v.n} 项, ${(v.bytes / 1024 ** 3).toFixed(2)} GB`);
}

if (!APPLY) {
  console.log("\n（这是计划，没有删任何东西。加 --apply 才执行。）体积最大的 5 项：");
  for (const t of [...targets].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
    console.log(`    ${(t.bytes / 1024 ** 2).toFixed(1)} MB  ${t.p}`);
  }
  process.exit(0);
}

let freed = 0;
let failed = 0;
for (const t of targets) {
  try {
    fs.rmSync(t.p, { recursive: true, force: true });
    freed += t.bytes;
  } catch (e) {
    failed += 1;
    console.log("删除失败：", t.p, String(e).slice(0, 120));
  }
}
console.log(`\n已释放 ${(freed / 1024 ** 3).toFixed(2)} GB，失败 ${failed} 项`);
