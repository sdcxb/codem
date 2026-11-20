#!/usr/bin/env node
/**
 * 构建 **aarch64 Linux** 的 `codem-db-cli`（移动端本机 Host 用）。
 *
 * ## 为什么需要这个脚本（而不是手敲 cargo）
 *
 * `android-shell/build.mjs --abi arm64` 只认一个固定路径：
 * `.linux-target/aarch64-unknown-linux-gnu/release/codem-db-cli`。
 * 而 `cargo build --target aarch64-unknown-linux-gnu` 在 Windows 上默认**没有链接器**
 * （没有 aarch64 的 gcc/clang sysroot），于是会停在链接阶段。
 *
 * 这里用 **zig 当交叉链接器**（`cargo-zigbuild`）：zig 自带 glibc 的 crt/libc 桩，
 * 不需要再装一套 aarch64 sysroot，Windows 上一条命令就能产出可执行的 aarch64 ELF。
 *
 * ## 前置（一次性）
 *
 * ```powershell
 * rustup target add aarch64-unknown-linux-gnu
 * # 下载 zig（0.13.x）并解压，把 zig.exe 所在目录加进 PATH
 * #   https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip
 * cargo install cargo-zigbuild --locked
 * ```
 *
 * ## 判据（脚本自己会检查，不靠人看）
 *
 * - 产物必须是 `ELF64 / AArch64`，解释器必须是 `/lib/ld-linux-aarch64.so.1`（rootfs 里跑）；
 * - 产物路径必须正好是 `build.mjs` 期望的那一个。
 *
 * 退出码 0 = 产物就绪；1 = 缺前置或产物不对（错误信息会写清缺什么）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET = "aarch64-unknown-linux-gnu";
const OUT = join(ROOT, ".linux-target", TARGET, "release", "codem-db-cli");
const MANIFEST = join(ROOT, "src-tauri", "codem-db", "Cargo.toml");

function fail(msg) {
  console.error(`\n[db:arm64] ${msg}\n`);
  process.exit(1);
}

/**
 * 命令探测：Windows 上 execFileSync 不会替你补 .exe/.cmd（三个候选都试）；
 * 且 **zig 的版本子命令是 `zig version`（没有 --）**，不能用统一的 --version。
 */
function has(cmd, versionArgs = ["--version"]) {
  for (const candidate of [cmd, `${cmd}.exe`, `${cmd}.cmd`]) {
    try {
      execFileSync(candidate, versionArgs, { stdio: "ignore" });
      return true;
    } catch {
      /* 试下一个 */
    }
  }
  return false;
}

if (!existsSync(MANIFEST)) fail(`找不到 crate：${MANIFEST}`);
if (!has("cargo-zigbuild")) fail("缺 cargo-zigbuild。先跑：cargo install cargo-zigbuild --locked");
if (!has("zig", ["version"])) fail("PATH 里没有 zig。下载 https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip 并解压后把目录加进 PATH");

try {
  execFileSync("rustup", ["target", "list", "--installed"], { stdio: "pipe", encoding: "utf8" });
} catch {
  /* rustup 不在也不致命：cargo 自己会报缺 target */
}
const installed = (() => {
  try {
    return execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  } catch {
    return "";
  }
})();
if (!installed.includes(TARGET)) {
  fail(`缺 rust target。先跑：rustup target add ${TARGET}`);
}

console.log(`[db:arm64] cargo zigbuild --release --target ${TARGET} …`);
try {
  execFileSync(
    "cargo",
    ["zigbuild", "--manifest-path", MANIFEST, "--release", "--target", TARGET, "--bin", "codem-db-cli"],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(ROOT, ".linux-target") } },
  );
} catch (e) {
  fail(`cargo zigbuild 失败：${e?.message ?? e}`);
}

if (!existsSync(OUT)) fail(`构建结束但没找到产物：${OUT}`);
const buf = readFileSync(OUT);
const isElf = buf[0] === 0x7f && buf.toString("ascii", 1, 4) === "ELF";
if (!isElf) fail("产物不是 ELF");
const machine = buf.readUInt16LE(18);
if (machine !== 183) fail(`产物不是 AArch64（e_machine=${machine}）`);

/* PT_INTERP：必须能在 Ubuntu arm64 rootfs 里找到 */
let interp = null;
const phoff = Number(buf.readBigUInt64LE(32));
const phentsize = buf.readUInt16LE(54);
const phnum = buf.readUInt16LE(56);
for (let i = 0; i < phnum; i++) {
  const off = phoff + i * phentsize;
  if (buf.readUInt32LE(off) !== 3) continue;
  const po = Number(buf.readBigUInt64LE(off + 8));
  const sz = Number(buf.readBigUInt64LE(off + 32));
  interp = buf.slice(po, po + sz).toString("utf8").replace(/\0.*$/, "");
}
if (interp !== "/lib/ld-linux-aarch64.so.1") {
  fail(`解释器不对：${interp ?? "(none)"}（rootfs 里是 /lib/ld-linux-aarch64.so.1）`);
}

const mb = (statSync(OUT).size / 1048576).toFixed(2);
console.log(`[db:arm64] OK → ${OUT.replace(ROOT + "\\", "").replace(ROOT + "/", "")}（${mb} MB, AArch64）`);
