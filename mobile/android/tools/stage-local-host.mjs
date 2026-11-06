#!/usr/bin/env node
/**
 * 把 android-shell 已经构建好的「本机运行时」搬进 Flutter Android 工程。
 *
 * ## 为什么要有这个脚本
 *
 * 本机 Host 需要 PRoot + Ubuntu rootfs + Node + codem-db + Host/Web 资源，合计 ~155 MB/ABI。
 * 这些东西由 `android-shell/build.mjs` 产出（它自己会检查 `.android-proot/` 与交叉编译产物），
 * Flutter 工程只负责**搬运 + 打包**，不重复实现另一套资产来源。
 *
 * ## 落点（与 LocalHostRuntime 的读取路径一一对应）
 *
 * - `android-shell/build/<abi>/stage/assets/*` → `app/src/main/assets/*`
 *   （rootfs.tar.gz / host.mjs / web/* / ca-certificates.crt / libstdc++.so.6 / libtalloc.so.2 /
 *    libandroid-shmem.so / libtinfo.so.6），首启由 Java 端解压到 `filesDir`。
 * - `android-shell/build/<abi>/stage/lib/<abiDir>/*.so` → `app/src/main/jniLibs/<abiDir>/`
 *   （libproot.so / libproot_loader.so / libcodem_db.so / libnode.so），安装时由系统解出到
 *   `nativeLibraryDir`（可执行），运行时复制到 `files/bin`。
 *
 * ## 一次只放一个 ABI
 *
 * `assets/` 里的 rootfs 与几个 .so 都是 ABI 相关的，`jniLibs/` 里 node 单个就 ~120 MB。
 * 两个 ABI 同时放会让 APK 超过 300 MB，所以本脚本每次只铺一个 ABI（换 ABI 会先清空目标目录）：
 *
 *   node mobile/android/tools/stage-local-host.mjs --abi x86_64   # 模拟器（默认）
 *   node mobile/android/tools/stage-local-host.mjs --abi arm64    # 真机
 *
 * 目标目录是**生成物**，不要往里放手写文件（每次都会整体重建）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, ".."); // mobile/android
const repoRoot = resolve(androidDir, "..", ".."); // 仓库根
const stageRoot = join(repoRoot, "android-shell", "build");

const argv = process.argv.slice(2);
const abiIndex = argv.indexOf("--abi");
const abiArg = abiIndex >= 0 ? String(argv[abiIndex + 1] ?? "") : "x86_64";
if (abiArg !== "x86_64" && abiArg !== "arm64") {
  throw new Error(`--abi 只支持 x86_64 或 arm64（收到：${abiArg || "<空>"}）`);
}
const abiDir = abiArg === "arm64" ? "arm64-v8a" : "x86_64";

const stage = join(stageRoot, abiArg, "stage");
const stageAssets = join(stage, "assets");
const stageLibs = join(stage, "lib", abiDir);
for (const dir of [stageAssets, stageLibs]) {
  if (!existsSync(dir)) {
    throw new Error(
      `找不到 ${abiArg} 的 stage 目录：\n  ${dir}\n` +
        `先生成它：node android-shell/build.mjs --abi ${abiArg}（arm64 见 android-shell/README.md）`
    );
  }
}

const required = [
  join(stageAssets, "rootfs.tar.gz"),
  join(stageAssets, "host.mjs"),
  join(stageAssets, "web", "index.html"),
  join(stageAssets, "web", "ui.js"),
  join(stageAssets, "libstdc++.so.6"),
  join(stageAssets, "libtalloc.so.2"),
  join(stageAssets, "libandroid-shmem.so"),
  join(stageLibs, "libproot.so"),
  join(stageLibs, "libproot_loader.so"),
  join(stageLibs, "libcodem_db.so"),
  join(stageLibs, "libnode.so"),
];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  throw new Error(`stage 里缺少必需文件：\n${missing.map((p) => `  - ${p}`).join("\n")}`);
}

const destAssets = join(androidDir, "app", "src", "main", "assets");
const destJni = join(androidDir, "app", "src", "main", "jniLibs");
// 整体重建：避免上一个 ABI 的残留（尤其是 jniLibs 里另一个 ABI 的 node）被打进包里
rmSync(destAssets, { recursive: true, force: true });
rmSync(destJni, { recursive: true, force: true });
mkdirSync(destAssets, { recursive: true });
mkdirSync(join(destJni, abiDir), { recursive: true });

cpSync(stageAssets, destAssets, { recursive: true });
cpSync(stageLibs, join(destJni, abiDir), { recursive: true });

const walk = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push({ rel: full.slice(base.length + 1).replace(/\\/g, "/"), bytes: statSync(full).size });
  }
  return out;
};

const toMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const total = (files) => files.reduce((sum, f) => sum + f.bytes, 0);
const assetsFiles = walk(destAssets).sort((a, b) => a.rel.localeCompare(b.rel));
const jniFiles = walk(destJni).sort((a, b) => a.rel.localeCompare(b.rel));

console.log(`[stage-local-host] abi=${abiArg} (jniLibs/${abiDir})`);
console.log(`  app/src/main/assets/  ${assetsFiles.length} 个文件, ${toMb(total(assetsFiles))}`);
for (const f of assetsFiles) console.log(`    - ${f.rel}  ${toMb(f.bytes)}`);
console.log(`  app/src/main/jniLibs/${abiDir}/  ${jniFiles.length} 个文件, ${toMb(total(jniFiles))}`);
for (const f of jniFiles) console.log(`    - ${f.rel}  ${toMb(f.bytes)}`);
console.log(`  合计 ${toMb(total(assetsFiles) + total(jniFiles))}（APK 里会被压缩，实际更小）`);
