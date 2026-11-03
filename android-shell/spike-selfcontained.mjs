#!/usr/bin/env node
/**
 * **自包含 APK** 的端到端验证（阶段 3 终态判据 SC-1..5）。
 *
 * 这条链路里**没有 PC 上的 Host**，也没有 `adb push` 任何运行时：
 * 安装 APK → 首次启动解压 rootfs/Node/Host/UI → 本机起 Host → WebView 连 127.0.0.1。
 *
 * 端口是内核随机分配的（`HostSupervisor.pickFreePort`），所以不能再用 8787：
 * 从 `CodemHost` logcat / `files/host.log` 的 READY 行发现端口，再走 `adb forward`。
 * RPC 在页面上下文里发（`local-auth` 的 cookie 只随同源请求走），Node 侧不接触凭据。
 *
 * 前置：`node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk`（配置类 extras 只在
 * debuggable 构建生效；release 构建会忽略它们，跑出来是假失败）
 * 用法：`node android-shell/spike-selfcontained.mjs`
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeviceHostEndpoint } from "./lib/host-endpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sdk = process.env.ANDROID_SDK_ROOT ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64-debug.apk");
const pkg = "com.codem.remote";
const FORWARD = 18788;
const CDP_PORT = 9338;
const sh = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function main() {
  if (!existsSync(apk)) throw new Error(`缺少 APK：${apk}（先跑 node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk）`);
  const summary = { spike: "android-selfcontained", checks: {} };

  sh("install", "-r", apk);
  if (!/DEBUGGABLE/.test(sh("shell", "dumpsys", "package", pkg))) {
    throw new Error(
      "当前安装的 APK 不是 debuggable 构建，--es llmBase 会被忽略，本机 Host 不会启动。\n" +
        "请先：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk\n" +
        "并设置： $env:CODEM_SHELL_APK = \"$PWD\\android-shell\\build\\codem-shell-x86_64-debug.apk\"",
    );
  }
  const host = new DeviceHostEndpoint({ sh, pkg, rpcPort: FORWARD, cdpPort: CDP_PORT });
  try {
    sh("shell", "pm", "clear", pkg);
    host.clearLogcat();
    // 首启有「配置模型」启动页；这里给一个（不会被调用的）地址，触发本机启动路径
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", "http://127.0.0.1:9/", "--ez", "webviewDebug", "true");
    summary.checks.SC1_installed = true;

    const health = await host.ensureForward();
    summary.hostId = health?.hostId ?? null;
    summary.checks.SC2_firstRunHost = Boolean(health?.hostId);

    let items = [];
    try {
      const sessions = await host.rpc("session.list", {});
      items = sessions.result?.items ?? [];
    } catch {
      /* 下面判据会失败并打印 */
    }
    summary.sessions = items.map((s) => s.title);
    summary.checks.SC3_welcomeSession = items.some((s) => String(s.title).includes("欢迎"));

    const focus = sh("shell", "dumpsys", "window", "displays");
    summary.checks.SC4_webviewFocused = /com\.codem\.remote/.test(focus);

    const png = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(repoRoot, "docs", "architecture", "evidence", "spike-android-selfcontained.png"), png);
    summary.checks.SC5_screenshot = png.length >= 10_000;
    summary.screenshotBytes = png.length;
  } finally {
    host.close();
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[selfcontained] ${e?.stack ?? e}\n`);
  process.exit(1);
});
