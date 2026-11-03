#!/usr/bin/env node
/**
 * 自包含 Android APK 构建（阶段 3 终态，**不需要 Gradle**）。
 *
 * 产物里带着：PRoot + Ubuntu rootfs + Node + 静态 codem-db + Host + 共享 UI。
 * 首次启动由 `MainActivity` 解压（纯 Java tar 解析），随后在本机起 Host，WebView 连 127.0.0.1。
 *
 * 用法：`node android-shell/build.mjs [--abi x86_64|arm64]`（默认 x86_64；arm64 需要对应资产）
 *
 * 关键约定：
 * - **可执行文件**放 `lib/<abi>/lib*.so` → 安装时由系统解到 nativeLibraryDir（可执行）；
 * - **数据**放 `assets/` → 首启解压到 filesDir；
 * - `targetSdk=28`（见 MainActivity 注释：Android 10+ 对 targetSdk≥29 禁止 app 数据目录 exec/ptrace）。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const repoRoot = resolve(root, "..");
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const javaHome = process.env.JAVA_HOME ?? "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.8-hotspot";

const debugBuild = process.argv.includes("--debug");
const abiArg = process.argv.indexOf("--abi");
const abi = abiArg >= 0 ? process.argv[abiArg + 1] : "x86_64";
const abiDir = abi === "arm64" ? "arm64-v8a" : "x86_64";
/**
 * 输出文件名（默认 `codem-shell-<abi>.apk`）。
 *
 * 为什么需要 `--out`：`--debug` 构建要用来跑"配置类 extras"的自动化（extras 只对
 * debuggable 构建生效），而它和 release 产物同名 ⇒ 直接覆盖。给个名字就能并存：
 *   node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk
 */
const outArg = process.argv.indexOf("--out");
const outName = outArg >= 0 ? String(process.argv[outArg + 1] ?? "") : `codem-shell-${abi}.apk`;
if (!outName || outName.includes("/") || outName.includes("\\") || outName.includes("..") || !outName.endsWith(".apk")) {
  throw new Error(`--out 必须是同目录下的 .apk 文件名（收到：${outName || "<空>"}）`);
}

const resolveTool = (base) => {
  for (const candidate of [base, `${base}.exe`, `${base}.bat`]) if (existsSync(candidate)) return candidate;
  return `${base}.exe`;
};
const bt = join(sdk, "build-tools", "35.0.0");
const aapt2 = resolveTool(join(bt, "aapt2"));
const d8 = resolveTool(join(bt, "d8"));
const zipalign = resolveTool(join(bt, "zipalign"));
const apksigner = resolveTool(join(bt, "apksigner"));
const androidJar = join(sdk, "platforms", "android-35", "android.jar");
const javac = resolveTool(join(javaHome, "bin", "javac"));
const keytool = resolveTool(join(javaHome, "bin", "keytool"));

const run = (cmd, args, opts = {}) => {
  process.stdout.write(`[android] ${cmd.split("\\").pop()} ${args.slice(0, 4).join(" ")}${args.length > 4 ? " …" : ""}\n`);
  const isBatch = /\.bat$/i.test(cmd);
  return execFileSync(isBatch ? "cmd.exe" : cmd, isBatch ? ["/c", cmd, ...args] : args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...opts,
  });
};

// ===== 资产检查 =====
const assetsDir = join(repoRoot, ".android-proot");
const prootDebDir = join(assetsDir, abi === "arm64" ? "proot-arm64-data" : "proot-data");
const rootfsName = `ubuntu-base-24.04.5-base-${abi === "arm64" ? "arm64" : "amd64"}.tar.gz`;
const nodeName = abi === "arm64" ? "node-v22.14.0-linux-arm64" : "node-v22.14.0-linux-x64";
const nodeDir = join(assetsDir, abi === "arm64" ? "node-arm64-extract" : "node-extract");
const dbTarget = abi === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-musl";
const webDir = join(repoRoot, "packages", "host", "web");

const required = {
  proot: join(prootDebDir, "data", "data", "com.termux", "files", "usr", "bin", "proot"),
  loader: join(prootDebDir, "data", "data", "com.termux", "files", "usr", "libexec", "proot", "loader"),
  rootfs: join(assetsDir, rootfsName),
  node: join(nodeDir, nodeName, "bin", "node"),
  db: join(repoRoot, ".linux-target", dbTarget, "release", "codem-db-cli"),
  host: join(repoRoot, "packages", "host", "dist", "host.mjs"),
  index: join(webDir, "index.html"),
  ui: join(webDir, "ui.js"),
  uiCss: join(webDir, "ui.css"),
  talloc: join(assetsDir, abi, "libtalloc.so.2"),
  shmem: join(assetsDir, abi, "libandroid-shmem.so"),
  cxx: join(assetsDir, abi, "libstdc++.so.6"),
  tinfo: join(assetsDir, abi, "libtinfo.so.6"),
  ca: join(assetsDir, "ca-certificates.crt"),
};
const missing = Object.entries(required).filter(([, p]) => !existsSync(p));
if (missing.length) {
  throw new Error(`缺少 ${abi} 资产：\n${missing.map(([k, p]) => `  - ${k}: ${p}`).join("\n")}\n见 android-shell/README.md`);
}

// ===== 清场 + staging =====
const build = join(root, "build", abi);
const stage = join(build, "stage");
rmSync(build, { recursive: true, force: true });
mkdirSync(join(stage, "lib", abiDir), { recursive: true });
mkdirSync(join(stage, "assets", "web"), { recursive: true });
mkdirSync(join(build, "classes"), { recursive: true });
mkdirSync(join(build, "dex"), { recursive: true });

// libs（可执行，nativeLibraryDir）
cpSync(required.proot, join(stage, "lib", abiDir, "libproot.so"));
cpSync(required.loader, join(stage, "lib", abiDir, "libproot_loader.so"));
cpSync(required.db, join(stage, "lib", abiDir, "libcodem_db.so"));
cpSync(required.node, join(stage, "lib", abiDir, "libnode.so"));
// 共享库与数据走 assets（首启解压）
cpSync(required.talloc, join(stage, "assets", "libtalloc.so.2"));
cpSync(required.shmem, join(stage, "assets", "libandroid-shmem.so"));
cpSync(required.cxx, join(stage, "assets", "libstdc++.so.6"));
cpSync(required.tinfo, join(stage, "assets", "libtinfo.so.6"));
cpSync(required.ca, join(stage, "assets", "ca-certificates.crt"));
cpSync(required.rootfs, join(stage, "assets", "rootfs.tar.gz"));
cpSync(required.host, join(stage, "assets", "host.mjs"));
cpSync(required.index, join(stage, "assets", "web", "index.html"));
cpSync(required.ui, join(stage, "assets", "web", "ui.js"));
cpSync(required.uiCss, join(stage, "assets", "web", "ui.css"));
writeFileSync(join(stage, "assets", "abi.txt"), abi);

// ===== 1) 清单/资源 → base.apk =====
run(aapt2, [
  "link",
  "-o", join(build, "base.apk"),
  "-I", androidJar,
  "--manifest", join(root, "AndroidManifest.xml"),
  "--min-sdk-version", "26",
  "--target-sdk-version", "28",
  ...(debugBuild ? ["--debug-mode"] : []),
  "--java", join(build, "gen"),
]);

// ===== 2) javac =====
const sources = [];
for (const dir of [join(root, "src"), join(build, "gen")]) {
  if (!existsSync(dir)) continue;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java")) sources.push(p);
    }
  };
  walk(dir);
}
run(javac, ["-source", "17", "-target", "17", "-classpath", androidJar, "-d", join(build, "classes"), ...sources]);

// ===== 3) d8 =====
const classes = [];
const walkClasses = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walkClasses(p);
    else if (e.name.endsWith(".class")) classes.push(p);
  }
};
walkClasses(join(build, "classes"));
run(d8, ["--lib", androidJar, "--min-api", "26", "--release", "--output", join(build, "dex"), ...classes]);

// ===== 4) 组包（classes.dex + lib/<abi>/*） =====
const staging = join(build, "staging");
mkdirSync(staging, { recursive: true });
cpSync(join(build, "base.apk"), join(staging, "app.apk"));
const zipScript = [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
  `$z=[System.IO.Compression.ZipFile]::Open('${join(staging, "app.apk")}','Update');`,
  `[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,'${join(build, "dex", "classes.dex")}','classes.dex') | Out-Null;`,
  `$libDir='${join(stage, "lib", abiDir)}';`,
  `Get-ChildItem $libDir -File | ForEach-Object { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$_.FullName,'lib/${abiDir}/'+$_.Name) | Out-Null };`,
  // assets 必须用「/」分隔：aapt2 的 -A 在 Windows 上会留下反斜杠，AssetManager 找不到
  `$assetsDir='${join(stage, "assets")}';`,
  `$sep=[char]92; Get-ChildItem $assetsDir -Recurse -File | ForEach-Object { $rel=$_.FullName.Substring($assetsDir.Length+1).Replace($sep,'/'); [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$_.FullName,'assets/'+$rel) | Out-Null };`,
  "$z.Dispose()",
].join(" ");
run("powershell.exe", ["-NoProfile", "-Command", zipScript]);

// ===== 5) 对齐 + 签名 =====
run(zipalign, ["-f", "-p", "4", join(staging, "app.apk"), join(build, "aligned.apk")]);
const keystore = join(root, "debug.keystore");
if (!existsSync(keystore)) {
  run(keytool, [
    "-genkeypair", "-keystore", keystore, "-storepass", "android", "-keypass", "android",
    "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
    "-dname", "CN=Android Debug,O=Android,C=US",
  ]);
}
const out = join(root, "build", outName);
run(apksigner, [
  "sign", "--ks", keystore, "--ks-pass", "pass:android", "--key-pass", "pass:android",
  "--out", out, join(build, "aligned.apk"),
]);
run(apksigner, ["verify", out]);
process.stdout.write(`\n[android] OK → ${out}\n`);
