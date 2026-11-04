/**
 * 拉取 PDFium 动态库（Windows x64）到 `src-tauri/resources/pdfium/win32-x64/`。
 *
 * 为什么不在仓库里放二进制：与 `fetch-ofm.mjs` / `fetch-node.mjs` 同一套规矩 ——
 * 固定版本 + 校验 sha256 + 运行时资源不进 git；发布前由构建流程现拉。
 *
 * 用法：
 *   node tools/vendor/fetch-pdfium.mjs          # 缺失才拉（已存在则跳过）
 *   node tools/vendor/fetch-pdfium.mjs --check  # 只校验现有副本（发布前用）
 *   node tools/vendor/fetch-pdfium.mjs --force  # 强制重拉
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const VENDOR = JSON.parse(fs.readFileSync(path.join(HERE, "pdfium", "VENDOR.json"), "utf8"));
const DEST = path.join(REPO, VENDOR.dest);
const DLL = path.join(DEST, VENDOR.dll);
const STAMP = path.join(DEST, ".vendor.json");

const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, "utf8"));
  } catch {
    return null;
  }
}

function verifyExisting() {
  if (!fs.existsSync(DLL)) return { ok: false, reason: "pdfium.dll 不存在" };
  const stamp = readStamp();
  if (!stamp) return { ok: false, reason: "缺少 .vendor.json（无法证明版本）" };
  if (stamp.sha256 !== VENDOR.sha256) {
    return { ok: false, reason: `版本不符：期望 ${VENDOR.sha256}，实际 ${stamp.sha256}` };
  }
  return { ok: true, size: fs.statSync(DLL).size };
}

async function download() {
  const tmp = path.join(REPO, ".preview-shot", `pdfium-${VENDOR.platform}.tgz`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  console.log(`[pdfium] 下载 ${VENDOR.tag} / ${VENDOR.asset} …`);
  const res = await fetch(VENDOR.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  if (buf.length !== VENDOR.size) {
    throw new Error(`大小不符：期望 ${VENDOR.size}，实际 ${buf.length}`);
  }
  const digest = crypto.createHash("sha256").update(buf).digest("hex");
  if (digest !== VENDOR.sha256) {
    throw new Error(`sha256 不符：期望 ${VENDOR.sha256}，实际 ${digest}`);
  }

  const extractDir = path.join(REPO, ".preview-shot", `pdfium-${VENDOR.platform}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tmp, "-C", extractDir], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("解包失败（需要 tar/bsdtar）");

  // 包内布局：bin/pdfium.dll 或 pdfium.dll；两种都兼容
  const candidates = [
    path.join(extractDir, "bin", VENDOR.dll),
    path.join(extractDir, VENDOR.dll),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`包内找不到 ${VENDOR.dll}`);

  fs.mkdirSync(DEST, { recursive: true });
  fs.copyFileSync(found, DLL);
  fs.writeFileSync(
    STAMP,
    JSON.stringify({ tag: VENDOR.tag, asset: VENDOR.asset, sha256: VENDOR.sha256, size: VENDOR.size }, null, 2) + "\n",
    "utf8",
  );
  fs.rmSync(tmp, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log(`[pdfium] 已就绪：${DLL}（${(fs.statSync(DLL).size / 1024 / 1024).toFixed(1)} MB）`);
}

const existing = verifyExisting();
if (CHECK) {
  if (existing.ok) {
    console.log(`[pdfium] ✓ 已就绪（${VENDOR.tag}，${(existing.size / 1024 / 1024).toFixed(1)} MB）`);
    process.exit(0);
  }
  console.error(`[pdfium] ✗ ${existing.reason} —— 跑 node tools/vendor/fetch-pdfium.mjs`);
  process.exit(1);
}

if (existing.ok && !FORCE) {
  console.log(`[pdfium] 已存在（${VENDOR.tag}），跳过。--force 可重拉`);
  process.exit(0);
}

try {
  await download();
} catch (e) {
  console.error(`[pdfium] 失败：${e?.message ?? e}`);
  process.exit(1);
}
