#!/usr/bin/env node
/**
 * 设备内 Host 的**持久化**判据（RST-1..4）：
 * 1. 首次启动后可建会话并跑完一轮（数据落盘）；
 * 2. force-stop 应用（Host 子进程一并结束）后重启；
 * 3. 会话仍在（session.list 含它）；
 * 4. 事件序号接着之前增长（diagnostics.seq 不回退）。
 *
 * 这是"Android 本机常驻"的真实约束：用户会关屏/杀进程，数据不能丢。
 *
 * 端口/凭据每次 Host 启动都会轮换：端口从 logcat / host.log 的 READY 行发现，
 * RPC 在页面上下文里发（同源 cookie 自动携带），所以 restart 后必须 `reset()` 重新发现。
 * Node 侧不读取、不打印凭据。
 *
 * 前置：`node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk`（配置类 extras 只在
 * debuggable 构建生效）；模拟器在线。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "../packages/host/scripts/mock-provider.mjs";
import { DeviceHostEndpoint } from "./lib/host-endpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64-debug.apk");
const pkg = "com.codem.remote";
const FORWARD = 18793;
const CDP_PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function killHostLeftovers() {
  try {
    a("shell", "ps -A | grep -E 'libnode|libproot|proot' | awk '{print $2}' | xargs -r kill");
  } catch {
    /* 没有残留 */
  }
}

async function waitHello(host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const res = await host.rpc("host.hello", { protocolVersion: 1, client: { name: "rst", version: "0", platform: "node" } });
      if (res.result?.hostId) return res.result;
    } catch {
      /* 还在解压/起 Host */
    }
  }
  return null;
}

async function main() {
  if (!existsSync(apk)) throw new Error(`缺少 APK：${apk}（先跑 node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk）`);
  const summary = { spike: "android-restart", checks: {} };
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
    killHostLeftovers();
    // 从**干净数据**开始：先清一次，再建立新数据
    a("shell", "pm", "clear", pkg);
    host.clearLogcat();
    a("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mockForDevice, "--es", "llmModel", "mock-model", "--ez", "webviewDebug", "true");

    await host.ensureForward();
    const hello1 = await waitHello(host, 180_000);
    if (!hello1) throw new Error("首次启动 Host 未就绪");
    summary.checks.RST1_firstBoot = true;

    const created = await host.rpc("session.create", { title: "重启后还在" });
    const sessionId = created.result?.session?.id;
    if (!sessionId) throw new Error(`session.create 失败：${JSON.stringify(created)}`);
    summary.sessionId = sessionId;

    // 先跑一轮：让 seq 真的 > 0（只建会话不产生事件，0 是弱证据）
    await host.rpc("prompt.send", { sessionId, text: "重启前跑一轮", requestId: `rst-before-${Date.now()}` });
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const d = await host.rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.sessionId === sessionId);
      if (run && run.state !== "running") break;
    }
    const before = await host.rpc("host.diagnostics", {});
    const seqBefore = before.result?.seq ?? null;
    summary.seqBeforeStop = seqBefore;

    // 杀掉整个应用（Host 是它的子进程）
    host.reset();
    a("shell", "am", "force-stop", pkg);
    killHostLeftovers();
    await sleep(3000);

    // 重启：不 pm clear
    a("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mockForDevice, "--es", "llmModel", "mock-model", "--ez", "webviewDebug", "true");
    await host.ensureForward();
    const hello2 = await waitHello(host, 180_000);
    if (!hello2) throw new Error("重启后 Host 未就绪");
    summary.checks.RST2_restarted = true;

    const list = await host.rpc("session.list", {});
    const ids = (list.result?.items ?? []).map((s) => s.id ?? s.sessionId);
    summary.checks.RST3_sessionPersisted = ids.includes(sessionId);
    summary.sessionCount = ids.length;

    // 重启后再跑一轮：序号必须接着老数据增长
    await host.rpc("prompt.send", { sessionId, text: "重启后跑一轮", requestId: `rst-after-${Date.now()}` });
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const d = await host.rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.sessionId === sessionId);
      if (run && run.state !== "running") break;
    }
    const after = await host.rpc("host.diagnostics", {});
    const seqAfter = after.result?.seq ?? null;
    summary.seqAfterRestart = seqAfter;
    summary.checks.RST4_seqMonotonic = typeof seqBefore === "number" && typeof seqAfter === "number" && seqAfter > seqBefore;
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
  process.stderr.write(`[rst] ${e?.stack ?? e}\n`);
  process.exit(1);
});
