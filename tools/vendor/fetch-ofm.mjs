/**
 * 构建前拉取「免费模型插件」的内置副本（第 201 波）。
 *
 * ## 为什么内置代码**不进 git**，而是构建时按固定 commit 拉
 *
 * 第一版把上游的运行树直接拷进 `src-tauri/resources/ofm/` 提交进仓库 —— **推不上去**：
 * GitHub 的推送保护（GH013 / push protection）在两个渠道包里扫出
 * **Google OAuth 的 client id / client secret**（上游为 Google Code Assist 渠道内嵌的公共客户端凭据：
 * `packages/standalone/channels/business.mjs` 与 `vendor/channel-pack/pack.js` 各一处）。
 * 那是**上游的选择**，不该由 Codem 的仓库替它保管 —— 于是改成：
 *
 * - 仓库里只留**溯源与校验**：`tools/vendor/ofm/{VENDOR.json,PATCHES.md,patch-cors.json,closure.json}`；
 * - 运行树由本脚本按 `VENDOR.json` 里的 commit **现拉现建**，逐文件比对 `closure.json` 的 sha256
 *   （对不上就**停下**，不带着不一致的副本去打包）；
 * - 拉完自动**重新施加我们那一行 CORS 补丁**（`patch-cors.json`），并断言它确实生效
 *   —— 上游只在预检与 SSE 里发 CORS 头，JSON 那条路没有，浏览器侧会 `Failed to fetch`。
 *
 * 用法：
 *   node tools/vendor/fetch-ofm.mjs              # 按 VENDOR.json 的 commit 拉取 + 打补丁 + 校验
 *   node tools/vendor/fetch-ofm.mjs --check      # 只校验现有副本（不联网）：文件齐、补丁在、哈希对
 *   node tools/vendor/fetch-ofm.mjs --from-local <clone 目录> --init-manifest
 *                                                # 从本地 clone 建副本并**重新生成** closure.json
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const DEST = path.join(REPO, "src-tauri/resources/ofm");
const META = path.join(REPO, "tools/vendor/ofm");

/** 与上游 `scripts/pack-standalone.mjs` 无关：那份清单**已过期**（缺 src/image-pricing.js 等） */
const EXCLUDE_DIRS = [
  ".git",
  ".github",
  "docs",
  ".trae-html-share-packages",
  "scripts",
  "packages/standalone/frontend",
  "vendor/channel-pack/src",
  "node_modules",
];
const EXCLUDE_FILE_RE = /\.map$/;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
};
const MODE_CHECK = args.includes("--check");
const FROM_LOCAL = flag("--from-local");
const INIT_MANIFEST = args.includes("--init-manifest");

const vendor = JSON.parse(fs.readFileSync(path.join(META, "VENDOR.json"), "utf8"));
const patches = JSON.parse(fs.readFileSync(path.join(META, "patch-cors.json"), "utf8"));

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rel = (p) => path.relative(DEST, p).split(path.sep).join("/");

/** 收集一棵树的 {相对路径: sha256} */
function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[rel(full)] = sha256(full);
    }
  };
  walk(root);
  return out;
}

function applyPatches(root) {
  const applied = [];
  for (const p of patches.patches) {
    const file = path.join(root, p.file);
    let text = fs.readFileSync(file, "utf8");
    if (text.includes(p.to)) {
      applied.push({ file: p.file, state: "已是目标形态" });
      continue;
    }
    const hits = text.split(p.from).length - 1;
    if (hits !== 1) throw new Error(`补丁锚点在 ${p.file} 命中 ${hits} 次（应为 1）—— 上游结构变了，请人工核对`);
    text = text.replace(p.from, p.to);
    fs.writeFileSync(file, text);
    applied.push({ file: p.file, state: "已施加" });
  }
  return applied;
}

function assertPatched(root) {
  for (const p of patches.patches) {
    const text = fs.readFileSync(path.join(root, p.file), "utf8");
    if (!text.includes(p.to)) throw new Error(`补丁没生效：${p.file}（${p.why}）`);
  }
}

function verifyAgainstManifest(root) {
  const manifestPath = path.join(META, "closure.json");
  if (!fs.existsSync(manifestPath)) throw new Error("缺 tools/vendor/ofm/closure.json（先跑 --from-local … --init-manifest）");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const actual = hashTree(root);
  const missing = Object.keys(manifest.files).filter((f) => !(f in actual));
  const extra = Object.keys(actual).filter((f) => !(f in manifest.files));
  const changed = Object.keys(manifest.files).filter((f) => f in actual && actual[f] !== manifest.files[f]);
  const problems = [
    missing.length ? `缺 ${missing.length} 个文件（例：${missing.slice(0, 3).join(", ")}）` : null,
    extra.length ? `多 ${extra.length} 个文件（例：${extra.slice(0, 3).join(", ")}）` : null,
    changed.length ? `内容变了 ${changed.length} 个（例：${changed.slice(0, 3).join(", ")}）` : null,
  ].filter(Boolean);
  if (problems.length) throw new Error(`内置副本与 closure.json 不一致：${problems.join("；")}`);
  return { files: Object.keys(manifest.files).length, commit: manifest.commit };
}

if (MODE_CHECK) {
  if (!fs.existsSync(DEST)) {
    console.log(`（未拉取内置副本：${path.relative(REPO, DEST)} 不存在 —— 打包前请先跑 node tools/vendor/fetch-ofm.mjs）`);
    process.exit(0);
  }
  assertPatched(DEST);
  const info = verifyAgainstManifest(DEST);
  console.log(`内置副本校验通过：${info.files} 个文件与 closure.json 逐字节一致，CORS 补丁在（上游 commit ${info.commit.slice(0, 7)}）`);
  process.exit(0);
}

/* ---------- 拉取 ---------- */
let source = FROM_LOCAL;
let tmp = null;
if (!source) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-fetch-"));
  const run = (cmd, argv, cwd = tmp) => execFileSync(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  run("git", ["init", "--quiet"]);
  run("git", ["remote", "add", "origin", vendor.upstream]);
  /* --depth 1 + 指定 commit：只拉这一个快照（GitHub 允许按 sha 浅拉） */
  run("git", ["fetch", "--quiet", "--depth", "1", "origin", vendor.commit]);
  run("git", ["checkout", "--quiet", "FETCH_HEAD"]);
  source = tmp;
  console.log(`已从上游拉取 commit ${vendor.commit.slice(0, 7)}（浅拉）`);
} else {
  console.log(`从本地目录建立副本：${source}`);
}

/* ---------- 组装运行树 ---------- */
fs.rmSync(DEST, { recursive: true, force: true });
let count = 0;
let bytes = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const relPath = path.relative(source, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.includes(relPath)) continue;
      walk(full);
      continue;
    }
    if (EXCLUDE_FILE_RE.test(relPath)) continue;
    const target = path.join(DEST, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(full, target);
    count += 1;
    bytes += fs.statSync(full).size;
  }
};
walk(source);
console.log(`已组装 ${count} 个文件（${(bytes / 1024 / 1024).toFixed(2)} MB）→ ${path.relative(REPO, DEST)}`);

if (tmp) fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 打补丁 + 校验 ---------- */
const applied = applyPatches(DEST);
for (const a of applied) console.log(`  补丁 ${a.file}：${a.state}`);
assertPatched(DEST);

fs.writeFileSync(
  path.join(DEST, "VENDOR.json"),
  `${JSON.stringify({ ...vendor, fileCount: count, bytes, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
);
fs.copyFileSync(path.join(META, "PATCHES.md"), path.join(DEST, "PATCHES.md"));

if (INIT_MANIFEST) {
  const files = hashTree(DEST);
  fs.writeFileSync(
    path.join(META, "closure.json"),
    `${JSON.stringify(
      {
        note: "内置副本的逐文件 sha256（构建时由 tools/vendor/fetch-ofm.mjs 比对；对不上就停下，不带着不一致的副本打包）",
        upstream: vendor.upstream,
        commit: vendor.commit,
        fileCount: Object.keys(files).length,
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`已写出 closure.json（${Object.keys(files).length} 个文件的 sha256）`);
} else {
  const info = verifyAgainstManifest(DEST);
  console.log(`内置副本校验通过：${info.files} 个文件与 closure.json 一致`);
}
