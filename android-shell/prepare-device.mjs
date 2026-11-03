#!/usr/bin/env node
/**
 * 准备 Android 设备上的 PRoot 运行时（阶段 3，**可重复执行**）。
 *
 * 做四件事（幂等）：
 * 1. 把 `proot` + `loader` + `libtalloc.so.2` + `libandroid-shmem.so` 推到设备；
 * 2. 解压 Ubuntu base rootfs 到 `/data/local/tmp/codem/ubuntu`；
 * 3. 解压 Node（linux-x64）到 rootfs 的 `/opt`；
 * 4. 推 `codem-db`（Linux 静态二进制）、Host bundle、共享 UI、种子数据。
 *
 * 输入都放在 `.android-proot/`（gitignored），由 README 的下载命令准备。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const assets = join(repoRoot, ".android-proot");
const sdk = process.env.ANDROID_SDK_ROOT ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const DEV = "/data/local/tmp/codem";

const run = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const required = {
  proot: join(assets, "proot-data", "data", "data", "com.termux", "files", "usr", "bin", "proot"),
  loader: join(assets, "proot-data", "data", "data", "com.termux", "files", "usr", "libexec", "proot", "loader"),
  talloc: join(assets, "libtalloc.so.2"),
  shmem: join(assets, "shmem-data", "data", "data", "com.termux", "files", "usr", "lib", "libandroid-shmem.so"),
  rootfs: join(assets, "ubuntu-base-24.04.5-base-amd64.tar.gz"),
  node: join(assets, "node-v22.14.0-linux-x64.tar.gz"),
  db: join(repoRoot, ".linux-target", "x86_64-unknown-linux-musl", "release", "codem-db-cli"),
  host: join(repoRoot, "packages", "host", "dist", "host.mjs"),
  web: join(repoRoot, "packages", "host", "web", "index.html"),
  ui: join(repoRoot, "packages", "host", "web", "ui.js"),
  uiCss: join(repoRoot, "packages", "host", "web", "ui.css"),
};
for (const [name, p] of Object.entries(required)) {
  if (!existsSync(p)) throw new Error(`缺少 ${name}：${p}（见 android-shell/README.md 的下载命令）`);
}

run("shell", `mkdir -p ${DEV}/app/web ${DEV}/app/data/sessions ${DEV}/tmp`);

// 1) proot 运行时
for (const [src, dst] of [
  [required.proot, "proot"],
  [required.loader, "loader"],
  [required.talloc, "libtalloc.so.2"],
  [required.shmem, "libandroid-shmem.so"],
]) {
  run("push", src, `${DEV}/${dst}`);
}
run("shell", `chmod 755 ${DEV}/proot ${DEV}/loader`);

// 2) rootfs（首次解压；已有就跳过）
const hasRootfs = run("shell", `[ -x ${DEV}/ubuntu/bin/sh ] && echo yes || echo no`).includes("yes");
if (!hasRootfs) {
  run("push", required.rootfs, `${DEV}/rootfs.tar.gz`);
  // 硬链接在 /data/local/tmp 会被 SELinux 拒绝：失败可容忍（Ubuntu base 里只有少量硬链接）
  try {
    run("shell", `mkdir -p ${DEV}/ubuntu && tar -xzf ${DEV}/rootfs.tar.gz -C ${DEV}/ubuntu`);
  } catch {
    /* 见上 */
  }
}

// 3) Node（解压进 rootfs）
const hasNode = run("shell", `[ -x ${DEV}/ubuntu/opt/node-v22.14.0-linux-x64/bin/node ] && echo yes || echo no`).includes("yes");
if (!hasNode) {
  run("push", required.node, `${DEV}/node.tar.gz`);
  const prootEnv = `PROOT_TMP_DIR=${DEV}/tmp PROOT_LOADER=${DEV}/loader LD_LIBRARY_PATH=${DEV}`;
  run(
    "shell",
    `cd ${DEV} && ${prootEnv} ./proot -0 -r ubuntu -b /dev -b /proc -b /sys -b ${DEV}:/mnt -w /root --link2symlink -L ` +
      `/usr/bin/env PATH=/usr/bin:/bin sh -c 'mkdir -p /opt && tar -xzf /mnt/node.tar.gz -C /opt'`,
  );
}

// 4) 二进制 / bundle / UI
run("push", required.db, `${DEV}/app/codem-db`);
run("push", required.host, `${DEV}/app/host.mjs`);
run("push", required.web, `${DEV}/app/web/index.html`);
run("push", required.ui, `${DEV}/app/web/ui.js`);
run("push", required.uiCss, `${DEV}/app/web/ui.css`);
run("shell", `chmod 755 ${DEV}/app/codem-db`);

process.stdout.write(`[android-prepare] OK → ${DEV}\n`);
