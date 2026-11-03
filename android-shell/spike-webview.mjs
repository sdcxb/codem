#!/usr/bin/env node
/**
 * **阶段 3 的端上验证**：真 Android WebView（手写 APK）加载共享 UI 并跑完一轮 Agent。
 *
 * 与 `packages/host/scripts/spike-c.mjs`（桌面 Chromium 覆写视口）的分工：
 * - C 验的是"页面/协议/事件流"；
 * - 本脚本验的是"**真 Android 外壳**"：安装手写 APK → 用 intent 传 Host URL →
 *   WebView 加载 → 页面连上 Host → 一轮工具调用 + 最终答复（Host 侧读数）。
 *
 * 退出码 0 = 全部通过；失败时打印 Host 侧日志尾巴（不猜）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "../packages/host/scripts/mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sdk = process.env.ANDROID_SDK_ROOT ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = join(here, "build", "codem-shell.apk");
const dbBin = join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const webDir = join(repoRoot, "packages", "host", "web");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function waitForBoot() {
  for (let i = 0; i < 40; i++) {
    const done = (execFileSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { encoding: "utf8" }) ?? "").trim();
    if (done === "1") return;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3"]);
  }
  throw new Error("模拟器未在 120s 内完成启动");
}

function cli(dbPath, command, params) {
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

async function main() {
  waitForBoot();
  const work = mkdtempSync(join(tmpdir(), "codem-android-shell-"));
  const dataHome = join(work, "data");
  mkdirSync(join(dataHome, "sessions"), { recursive: true });
  const dbPath = join(dataHome, "codem-db-rust.bin");
  cli(dbPath, "sessions.upsert", { id: "shell", project_id: "", title: "Android 外壳", created_at: 1_700_000_300_000 });
  cli(dbPath, "messages.create", {
    id: "shell-m1",
    session_id: "shell",
    role: "user",
    content: "SHELL_SEED",
    timestamp: 1_700_000_300_001,
  });

  // 让共享 UI 的 selftest 能读到文件：工作区用 web 目录（index.html 3668 字符）
  const mock = await startMockProvider({ toolPath: "index.html" });
  const host = (await import("node:child_process")).spawn(
    process.execPath,
    [hostEntry, "serve", "--data-home", dataHome, "--workspace", webDir, "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEM_DB_BIN: dbBin, CODEM_LLM_BASE_URL: mock.url, CODEM_LLM_MODEL: "mock-model" },
    },
  );
  let hostErr = "";
  host.stderr.on("data", (c) => {
    hostErr += c.toString("utf8");
  });

  const summary = { spike: "android-shell", checks: {} };
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      let buf = "";
      const timer = setTimeout(() => rejectReady(new Error(`Host 未 READY：${buf}`)), 15000);
      host.stdout.on("data", (c) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
        if (!line) return;
        clearTimeout(timer);
        resolveReady(JSON.parse(line));
      });
    });
    const port = new URL(ready.url).port;
    const url = `http://10.0.2.2:${port}/?open=shell&selftest=1`;

    try {
      a("uninstall", "com.codem.remote");
    } catch {
      /* 未安装过：正常 */
    }
    a("install", "-r", apk);
    summary.checks.SH1_installed = a("shell", "pm", "list", "packages", "com.codem.remote").includes("com.codem.remote");

    // selftest 走独立 extra：URL 里的 `&` 会被 adb shell 截断
    const baseUrlOnly = `http://10.0.2.2:${port}/?open=shell`;
    a("shell", "am", "start", "-n", "com.codem.remote/.MainActivity", "--es", "url", baseUrlOnly, "--ez", "selftest", "true");
    await sleep(15_000);

    const focus = a("shell", "dumpsys", "window", "displays");
    summary.checks.SH2_webviewFocused = /com\.codem\.remote/.test(focus);

    const diag = await rpc(ready.url, "host.diagnostics", {});
    const runs = diag.result?.runs ?? [];
    summary.runs = runs.map((r) => `${r.runId}:${r.state}`);
    summary.checks.SH3_hostSawRun = runs.length >= 1;
    summary.checks.SH4_runSucceeded = runs.some((r) => r.state === "succeeded");

    const png = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    const shot = join(work, "android-shell.png");
    writeFileSync(shot, png);
    summary.checks.SH5_screenshot = png.length >= 10_000;
    summary.screenshotBytes = png.length;
    const evidence = join(repoRoot, "docs", "architecture", "evidence");
    mkdirSync(evidence, { recursive: true });
    copyFileSync(shot, join(evidence, "spike-android-shell.png"));
  } finally {
    host.kill("SIGTERM");
    await mock.close();
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  if (!ok) summary.hostStderr = hostErr.slice(-3000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[android-shell] ${e?.stack ?? e}\n`);
  process.exit(1);
});
