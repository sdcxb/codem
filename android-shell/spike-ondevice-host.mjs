#!/usr/bin/env node
/**
 * **设备内 Host** 的端到端验证（阶段 3 核心）。
 *
 * 与 `spike-webview.mjs` 的区别：
 * - 那个是"PC 上的 Host + 手机 WebView"；
 * - 这个是"**Host 也在手机里**"：PRoot + Node + 静态 codem-db 全在设备上跑，
 *   PC 只提供假模型（设备的 `10.0.2.2` 指向宿主机）。
 *
 * 端口由内核随机分配（`--port 0`），所以从子进程 stdout 的 READY 行取 `port`，
 * 再 `adb forward` 到它；不再假设 8787。
 *
 * 判据（DH-1..4）：
 *   DH-1 设备内 Host READY        DH-2 端口转发后 RPC 可用
 *   DH-3 种子会话可读              DH-4 直接发 prompt 跑成功（工具 + 最终回答）
 *
 * 注意：这条脚本**不安装/启动 APK**。APK 的 WebView 只能连它自己启动的本机 Host
 * （`MainActivity` 会把 loopback 深链重写到当前端点），所以"手动 Host + APK 页面"
 * 在当前端点策略下原理上不可能同时成立。APK 端的完整回合由
 * `android-shell/run-device-cases.mjs` 覆盖。
 *
 * 前置：`node android-shell/prepare-device.mjs`（幂等）。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "../packages/host/scripts/mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? "C:\\Users\\abee\\AppData\\Local\\Android\\Sdk";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const DEV = "/data/local/tmp/codem";
const FORWARD = 18787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function prootPrefix() {
  return (
    `cd ${DEV} && PROOT_TMP_DIR=${DEV}/tmp PROOT_LOADER=${DEV}/loader LD_LIBRARY_PATH=${DEV} ` +
    `./proot -0 -r ubuntu -b /dev -b /proc -b /sys -b ${DEV}:/mnt -w /root --link2symlink -L ` +
    `/usr/bin/env PATH=/opt/node-v22.14.0-linux-x64/bin:/usr/bin:/bin`
  );
}

function seed() {
  const work = mkdtempSync(join(tmpdir(), "codem-seed-"));
  const session = join(work, "s.json");
  const message = join(work, "m.json");
  writeFileSync(session, JSON.stringify({ id: "deviceshell", project_id: "", title: "设备内 Host", created_at: 1700000400000 }));
  writeFileSync(message, JSON.stringify({ id: "deviceshell-m1", session_id: "deviceshell", role: "user", content: "DEVICE_SEED", timestamp: 1700000400001 }));
  a("push", session, `${DEV}/seed-session.json`);
  a("push", message, `${DEV}/seed-message.json`);
  a(
    "shell",
    `${prootPrefix()} CODEM_DB_BIN=/mnt/app/codem-db sh -c '/mnt/app/codem-db --db /mnt/app/data/codem-db-rust.bin invoke sessions.upsert - < /mnt/seed-session.json; /mnt/app/codem-db --db /mnt/app/data/codem-db-rust.bin invoke messages.create - < /mnt/seed-message.json'`,
  );
}

async function waitReady(child, getStderr = () => "") {
  let buf = "";
  return await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`设备内 Host 未 READY：${buf.slice(-1500)}\n--- stderr ---\n${getStderr().slice(-1500)}`)),
      60_000,
    );
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      const line = buf.split("\n").find((l) => {
        const t = l.trim();
        return t.startsWith("{") && t.includes('"ready":true');
      });
      if (!line) return;
      clearTimeout(timer);
      try {
        resolveReady(JSON.parse(line));
      } catch (e) {
        rejectReady(new Error(`无法解析 Host READY 行：${String(e?.message ?? e)}`));
      }
    });
  });
}

async function rpc(method, params) {
  const res = await fetch(`http://127.0.0.1:${FORWARD}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(1000);
  }
  throw new Error(`等待超时：${label}${last ? `（${last}）` : ""}`);
}

async function main() {
  const summary = { spike: "android-ondevice-host", checks: {} };
  seed();
  const mock = await startMockProvider({ toolPath: "index.html" });
  const mockForDevice = mock.url.replace("127.0.0.1", "10.0.2.2");

  const child = spawn(
    adb,
    [
      "-s",
      serial,
      "shell",
      `${prootPrefix()} CODEM_DB_BIN=/mnt/app/codem-db CODEM_LLM_BASE_URL=${mockForDevice} CODEM_LLM_MODEL=mock-model ` +
        `/opt/node-v22.14.0-linux-x64/bin/node /mnt/app/host.mjs serve --data-home /mnt/app/data --workspace /mnt/app/web --web /mnt/app/web --port 0`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });

  try {
    const ready = await waitReady(child, () => stderr);
    summary.port = Number(ready.port);
    summary.checks.DH1_hostReady = Boolean(ready.ready) && Number.isInteger(summary.port);
    a("forward", `tcp:${FORWARD}`, `tcp:${summary.port}`);

    const hello = await waitUntil(async () => {
      try {
        const r = await rpc("host.hello", { protocolVersion: 1, client: { name: "spike", version: "0", platform: "node" } });
        return r.result?.hostId ? r.result : null;
      } catch {
        return null;
      }
    }, 30_000, "Host /rpc 可用");
    summary.checks.DH2_rpcViaForward = Boolean(hello.hostId);

    const sessions = await rpc("session.list", {});
    const items = sessions.result?.items ?? [];
    summary.checks.DH3_seedSession = items.some((s) => s.id === "deviceshell");

    const sent = await rpc("prompt.send", {
      sessionId: "deviceshell",
      text: "请读取 index.html 的第一行并回答",
      requestId: `dh-${Date.now()}`,
    });
    const runId = sent.result?.runId;
    const run = await waitUntil(async () => {
      const d = await rpc("host.diagnostics", {});
      const r = (d.result?.runs ?? []).find((x) => x.runId === runId);
      return r && r.state !== "running" ? r : null;
    }, 120_000, "设备内 Host 回合结束");
    summary.runs = [`${run.runId}:${run.state}`];
    summary.checks.DH4_runSucceeded = run.state === "succeeded";
  } finally {
    try {
      a("forward", "--remove", `tcp:${FORWARD}`);
    } catch {
      /* 已移除 */
    }
    child.kill("SIGTERM");
    await mock.close();
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  if (!ok) summary.deviceStderr = stderr.slice(-3000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[ondevice] ${e?.stack ?? e}\n`);
  process.exit(1);
});
