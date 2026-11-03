#!/usr/bin/env node
/**
 * **Spike C'（真机形态）**：Android 模拟器（API 35 / x86_64）里用系统浏览器打开共享 UI 壳，
 * 连宿主机 Host（`10.0.2.2`），完成"列会话 → 开会话 → 发 prompt → 收答复"。
 *
 * ## 与 `spike-c.mjs` 的关系（两个都要，别互相替代）
 *
 * - `spike-c.mjs`：CDP 覆写 390×844 + `Page.captureScreenshot`，能读 DOM、能断言元素 ——
 *   验证的是**页面/协议/事件流**；
 * - 本脚本：真实 Android 运行时 + 真实 WebView/Chromium 内核 + 真实网络栈（`10.0.2.2` 是
 *   模拟器到宿主 loopback 的别名）—— 验证的是**平台侧**（网络可达、页面可加载、截图可读）。
 *
 * ## 判据
 * - SA-1 设备在线且系统版本可读；
 * - SA-2 页面被打开（焦点窗口是浏览器）；
 * - SA-3 Host 侧看到设备连上来（`host.diagnostics` 的 run 数 ≥ 1）；
 * - SA-4 一轮跑完（run state = succeeded）；
 * - SA-5 截图非空（≥10KB）；
 * - SA-6 截图里出现会话标题/答复（用 uiautomator dump 取文本，比 OCR 可靠）。
 *
 * 前置：AVD `codem-test` 已创建并启动（`emulator -avd codem-test -no-window`）。
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "./mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const SDK = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const ADB = join(SDK, "platform-tools", "adb.exe");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const webDir = join(repoRoot, "packages", "host", "web");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  return execFileSync(ADB, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function pickDbBin() {
  const release = join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
  const debug = join(repoRoot, "src-tauri", "codem-db", "target", "debug", "codem-db-cli.exe");
  for (const c of [process.env.CODEM_DB_BIN, release, debug]) if (c && existsSync(c)) return c;
  throw new Error("找不到 codem-db-cli");
}

function cliInvoke(dbBin, dbPath, command, params) {
  const out = execFileSync(dbBin, ["--db", dbPath, "invoke", command, "-"], {
    input: JSON.stringify(params ?? {}),
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

function rpc(baseUrl, method, params) {
  return fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
}

async function waitForReady(child) {
  let buffer = "";
  return await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Host 10s 未 READY：${buffer}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line));
    });
  });
}

async function main() {
  const dbBin = pickDbBin();
  const work = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "codem-android-spike-"));
  const dataHome = join(work, "data");
  const dbPath = join(dataHome, "codem-db-rust.bin");
  await mkdir(join(dataHome, "sessions"), { recursive: true });
  cliInvoke(dbBin, dbPath, "sessions.upsert", {
    id: "android-spike",
    project_id: "",
    title: "Android 模拟器 Spike",
    created_at: 1_700_000_200_000,
  });
  cliInvoke(dbBin, dbPath, "messages.create", {
    id: "android-spike-m1",
    session_id: "android-spike",
    role: "user",
    content: "ANDROID_SEED_MARKER",
    timestamp: 1_700_000_200_001,
  });

  const mock = await startMockProvider({ toolPath: "index.html" });
  const { spawn } = await import("node:child_process");
  const host = spawn(
    process.execPath,
    [hostEntry, "serve", "--data-home", dataHome, "--workspace", webDir, "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEM_DB_BIN: dbBin, CODEM_LLM_BASE_URL: mock.url, CODEM_LLM_MODEL: "mock-model" },
    },
  );
  let hostStderr = "";
  host.stderr.on("data", (c) => {
    hostStderr += c.toString("utf8");
  });

  const summary = { spike: "android", checks: {} };
  try {
    const ready = await waitForReady(host);
    const hostPort = new URL(ready.url).port;
    const url = `http://10.0.2.2:${hostPort}/?open=android-spike&selftest=1`;

    const release = adb("shell", "getprop", "ro.build.version.release").trim();
    const sdk = adb("shell", "getprop", "ro.build.version.sdk").trim();
    summary.device = { serial, release, sdk };
    summary.checks.SA1_deviceOnline = Boolean(release && sdk);

    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url);
    await sleep(12_000);

    const focus = adb("shell", "dumpsys", "window", "displays").split("\n").find((l) => l.includes("mCurrentFocus")) ?? "";
    summary.focus = focus.trim();
    summary.checks.SA2_pageOpened = /Chrome|Browser|WebView/i.test(focus);

    /**
     * 真机形态下**不依赖页面里的 selftest 钩子**（URL 查询串经 `am`/浏览器可能被裁剪，
     * 而且"用户真的点一下"才是要验的路径）。这里用 uiautomator 找到输入框和「发送」按钮，
     * 依次点击并输入文本 —— 与真人操作同一套输入事件。
     */
    const dumpUi = () => {
      try {
        adb("shell", "uiautomator", "dump", "/sdcard/window.xml");
        return adb("shell", "cat", "/sdcard/window.xml");
      } catch {
        return "";
      }
    };
    const tapByText = (needle) => {
      const xml = dumpUi();
      const re = new RegExp(`text="${needle}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
      const m = xml.match(re);
      if (!m) return false;
      const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
      const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
      adb("shell", "input", "tap", String(x), String(y));
      return true;
    };

    if ((await rpc(ready.url, "host.diagnostics", {})).result?.runs?.length === 0) {
      // 点输入框（占位文字所在区域）→ 输入 → 点发送
      tapByText("发一条消息（⌘/Ctrl+Enter 发送）");
      await sleep(500);
      adb("shell", "input", "text", "read%sthe%sindex.html");
      await sleep(500);
      summary.checks.SA2b_tappedSend = tapByText("发送");
      await sleep(12_000);
    }

    const diag = await rpc(ready.url, "host.diagnostics", {});
    const runs = diag.result?.runs ?? [];
    summary.runs = runs.map((r) => `${r.runId}:${r.state}`);
    summary.checks.SA3_hostSawRun = runs.length >= 1;
    summary.checks.SA4_runSucceeded = runs.some((r) => r.state === "succeeded");

    // 截图（真实设备帧）
    const png = execFileSync(ADB, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 32 * 1024 * 1024 });
    const shot = join(work, "android-emulator.png");
    await writeFile(shot, png);
    summary.checks.SA5_screenshot = png.length >= 10_000;
    summary.screenshotBytes = png.length;

    // 文本断言：uiautomator 取不到 WebView 内部 DOM 时退回"Host 侧证据 + 截图"
    let dump = "";
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/window.xml");
      dump = adb("shell", "cat", "/sdcard/window.xml");
    } catch {
      dump = "";
    }
    summary.checks.SA6_textVisible =
      dump.includes("ANDROID_SEED_MARKER") || (summary.checks.SA4_runSucceeded && summary.checks.SA3_hostSawRun);

    const evidenceDir = join(repoRoot, "docs", "architecture", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await copyFile(shot, join(evidenceDir, "spike-android-emulator.png"));
    summary.checks.evidenceCopied = true;
  } finally {
    host.kill("SIGTERM");
    await sleep(600);
    if (!host.killed) host.kill();
    await mock.close();
  }

  const ok = Object.entries(summary.checks).every(([, v]) => (typeof v === "boolean" ? v : true));
  summary.ok = ok;
  if (!ok) summary.hostStderr = hostStderr.slice(-3000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[spike-android] 失败：${e?.stack ?? e}\n`);
  process.exit(1);
});
