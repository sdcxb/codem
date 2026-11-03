#!/usr/bin/env node
/**
 * **本机配置 → 真实回合**（阶段 3 的可用性判据 LT-1..4）。
 *
 * 自包含 APK 装好之后，用户要做的只有一件事：填模型服务地址/Key/模型名。
 * 本脚本用 intent extra 注入配置（等价于在启动页填写），然后通过协议：
 *   建会话 → 发 prompt → 等回合成功 → 用 `?open=` 打开该会话截图。
 *
 * 端口是内核随机分配的（`HostSupervisor.pickFreePort`），所以不能再用 8787：
 * 从 `CodemHost` logcat / `files/host.log` 的 READY 行发现端口。`local-auth` 下
 * `/rpc` 要本次启动的凭据，这里在**页面上下文**里发 RPC（同源 cookie 自动携带），
 * Node 侧不读取、不打印凭据。
 *
 * 前置：`node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk`（配置类 extras 只在
 * debuggable 构建生效）；模拟器在线；PC 上起假模型（脚本自己起）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "../packages/host/scripts/mock-provider.mjs";
import { DeviceHostEndpoint } from "./lib/host-endpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sdk = process.env.ANDROID_SDK_ROOT ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64-debug.apk");
const pkg = "com.codem.remote";
const FORWARD = 18792;
const CDP_PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function main() {
  if (!existsSync(apk)) throw new Error(`缺少 APK：${apk}（先跑 node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk）`);
  const summary = { spike: "android-local-turn", checks: {} };
  const mock = await startMockProvider({ toolPath: "index.html" });
  const mockForDevice = mock.url.replace("127.0.0.1", "10.0.2.2");
  const host = new DeviceHostEndpoint({ sh: a, pkg, rpcPort: FORWARD, cdpPort: CDP_PORT });

  try {
    a("install", "-r", apk);
    if (!/DEBUGGABLE/.test(a("shell", "dumpsys", "package", pkg))) {
      throw new Error(
        "当前安装的 APK 不是 debuggable 构建，--es llmBase/llmModel 会被忽略。\n" +
          "请先：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk",
      );
    }
    a("shell", "am", "force-stop", pkg);
    // 清掉上一次运行遗留的 Host 子进程（否则旧实例会继续占着库/端口）
    try {
      a("shell", "ps -A | grep -E 'libnode|libproot|proot' | awk '{print $2}' | xargs -r kill");
    } catch {
      /* 没有 */
    }
    a("shell", "pm", "clear", pkg);
    host.clearLogcat();
    a(
      "shell", "am", "start", "-n", `${pkg}/.MainActivity`,
      "--es", "llmBase", mockForDevice,
      "--es", "llmModel", "mock-model",
      "--ez", "webviewDebug", "true",
    );
    summary.checks.LT1_configuredStart = true;

    await host.ensureForward();
    let hello = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        const res = await host.rpc("host.hello", { protocolVersion: 1, client: { name: "lt", version: "0", platform: "node" } });
        if (res.result?.hostId) {
          hello = res.result;
          break;
        }
      } catch {
        /* 首次解压中 / 页面还没加载完 */
      }
    }
    if (!hello) throw new Error("Host 未在 180s 内就绪");
    summary.checks.LT2_providerConfigured = hello.hostId != null;

    const created = await host.rpc("session.create", { title: "本机真实回合" });
    const sessionId = created.result?.session?.id;
    if (!sessionId) throw new Error(`session.create 失败：${JSON.stringify(created)}`);
    summary.sessionId = sessionId;
    summary.checks.LT3_sessionCreated = true;

    await sleep(4000); // 等首页先落地，避免 setup 的根路径加载覆盖深链
    // 不 force-stop：Host 是本应用进程的子进程，杀掉就没了；用 onNewIntent 直接打开会话
    a("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "url", `http://127.0.0.1:${host.port}/?open=${sessionId}`);
    // 深链可能让 WebView 重新加载：旧 CDP 连接可能失效，让 host.rpc 重新附着到当前页面
    host.closeCdp();

    const sent = await host.rpc("prompt.send", {
      sessionId,
      text: "请读取 index.html 的第一行并回答",
      requestId: `lt-${Date.now()}`,
    });
    summary.runId = sent.result?.runId ?? null;

    let state = "running";
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const diag = await host.rpc("host.diagnostics", {});
      const run = (diag.result?.runs ?? []).find((r) => r.runId === summary.runId);
      if (run && run.state !== "running") {
        state = run.state;
        break;
      }
    }
    summary.runState = state;
    summary.checks.LT4_turnSucceeded = state === "succeeded";

    await sleep(8000);
    const png = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(repoRoot, "docs", "architecture", "evidence", "spike-android-local-turn.png"), png);
    summary.checks.LT5_screenshot = png.length >= 10_000;
    summary.screenshotBytes = png.length;
  } finally {
    host.close();
    await mock.close();
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[local-turn] ${e?.stack ?? e}\n`);
  process.exit(1);
});
