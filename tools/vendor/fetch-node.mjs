/**
 * 构建前拉取「内置便携版 Node」（第 203 波，用户选的方案 A）。
 *
 * ## 为什么内置而不是现场下载
 *
 * 免费模型插件是个 Node 程序。上一版是"缺 Node 就现场下载"，而真机实测：官方与 4 个国内镜像
 * **会成片瞬时 404**（同一批 URL 隔一会儿单独下又成功）——用户点一次拿到的是"安装失败、请自行安装"，
 * 正是他要我们避免的。方案 A 把 Node 直接放进安装包：从此不存在"缺 Node"，也不受网络环境影响。
 *
 * ## 纪律（与插件内置同一套）
 *
 * - 运行树**不进 git**：仓库只留版本 + sha256（`tools/vendor/node/VENDOR.json`）；
 * - **必须按官方 SHASUMS256.txt 校验**（不是自己算一遍就算数）——包从网上来，就要有来源侧的凭据；
 * - **只取 `node.exe`**（npm/头文件/文档一概不进安装包）；
 * - 目标目录 `src-tauri/resources/node/` 进 `.gitignore`，由 `bundle.resources` 打进安装包。
 *
 * 用法：
 *   node tools/vendor/fetch-node.mjs          # 下载 + 校验 sha256 + 取 node.exe + 写元数据
 *   node tools/vendor/fetch-node.mjs --check  # 只校验现有副本（不联网）：node.exe 在、大小合理、元数据齐
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const DEST = path.join(REPO, "src-tauri/resources/node");
const META = path.join(REPO, "tools/vendor/node");
const vendor = JSON.parse(fs.readFileSync(path.join(META, "VENDOR.json"), "utf8"));
const version = vendor.version;

const MODE_CHECK = process.argv.includes("--check");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

if (MODE_CHECK) {
  const exe = path.join(DEST, "node.exe");
  if (!fs.existsSync(exe)) {
    console.log(
      `（未内置便携 Node：${path.relative(REPO, exe)} 不存在 —— 打包前请先跑 node tools/vendor/fetch-node.mjs）`,
    );
    process.exit(0);
  }
  const size = fs.statSync(exe).size;
  if (size < 50 * 1024 * 1024) throw new Error(`内置的 node.exe 只有 ${size} 字节，明显不完整`);
  const meta = JSON.parse(fs.readFileSync(path.join(DEST, "NODE.json"), "utf8"));
  if (meta.version !== version) throw new Error(`内置版本（${meta.version}）与 VENDOR.json（${version}）不一致`);
  console.log(`内置便携 Node 校验通过：v${meta.version}（node.exe ${(size / 1024 / 1024).toFixed(1)}MB）`);
  process.exit(0);
}

/* ---------- 下载 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-node-"));
const zipPath = path.join(tmp, "node.zip");
const sumsPath = path.join(tmp, "SHASUMS256.txt");

const download = (url, dest) => {
  console.log(`下载 ${url}`);
  /* 用系统 node 的 fetch 落盘（构建机上一定有 node，不然这个脚本也跑不起来） */
  execFileSync(
    process.execPath,
    [
      "-e",
      `const fs=require('fs');(async()=>{const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(600000)});if(!r.ok)throw new Error('HTTP '+r.status+' '+${JSON.stringify(url)});const b=Buffer.from(await r.arrayBuffer());fs.writeFileSync(${JSON.stringify(dest)},b);console.log('  '+b.length+' 字节');})()`,
    ],
    { stdio: "inherit" },
  );
};

download(vendor.shasums, sumsPath);
download(vendor.source, zipPath);

/* ---------- 按官方 SHASUMS256.txt 校验 ---------- */
const wanted = path.basename(vendor.source);
const line = fs
  .readFileSync(sumsPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l.endsWith(wanted));
if (!line) throw new Error(`SHASUMS256.txt 里没有 ${wanted}`);
const expected = line.split(/\s+/)[0].toLowerCase();
const actual = sha256(zipPath);
if (expected !== actual) throw new Error(`sha256 不一致：官方 ${expected}，实测 ${actual}`);
console.log(`sha256 与官方一致：${actual}`);

/* ---------- 只取 node.exe ---------- */
const extractDir = path.join(tmp, "unzip");
fs.mkdirSync(extractDir, { recursive: true });
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
  { stdio: "inherit" },
);
const inner = path.join(extractDir, `node-v${version}-win-x64`);
const exe = path.join(inner, "node.exe");
if (!fs.existsSync(exe)) throw new Error(`包里没有 node.exe（结构变了？）：${inner}`);

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(exe, path.join(DEST, "node.exe"));
/* 许可与溯源一起带上（随安装包分发第三方二进制要有这两样） */
const license = path.join(inner, "LICENSE");
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(DEST, "LICENSE"));
fs.writeFileSync(
  path.join(DEST, "NODE.json"),
  `${JSON.stringify(
    {
      version,
      source: vendor.source,
      sha256: actual,
      sizeBytes: fs.statSync(path.join(DEST, "node.exe")).size,
      fetchedAt: new Date().toISOString().slice(0, 10),
      note: "只取了 node.exe；sha256 已按官方 SHASUMS256.txt 校验。",
    },
    null,
    2,
  )}\n`,
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`已内置便携 Node v${version} → ${path.relative(REPO, DEST)}`);
