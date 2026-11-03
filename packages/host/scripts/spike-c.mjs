#!/usr/bin/env node
/**
 * **Spike C**：移动视口（390×844，DPR 3）的 **Chromium（WebView 同引擎）** 加载共享 UI 壳，
 * 经 HTTP/SSE 连本机 Host，完成「列会话 → 开会话 → 发 prompt → 看工具卡 → 收最终答复」。
 *
 * ## 为什么是 Chromium 而不是 Android 模拟器
 *
 * 本机 Android SDK 只有 platform-tools / build-tools / platforms（**没有** emulator 与
 * system-image）。装模拟器需要数 GB 下载 + WHPX 硬件加速，且在无管理员权限的会话里
 * 无法确认虚拟化已启用。Android System WebView 就是 Chromium —— 所以这一段验证的是
 * **同一个渲染引擎 + 同一个协议 + 同一套页面**；剩下没被覆盖的只有"Kotlin 壳与系统桥"，
 * 那一段在 ADR-0002 里被明确标为 blocked（附前置条件），不假装验证过。
 *
 * 判据：
 * - SC-1 页面连上 Host（`已连接`）并列出会话；
 * - SC-2 自动打开会话后能看到种子消息正文；
 * - SC-3 自动发一条 prompt 后，**最终答复（MOCK_DONE）出现在 DOM 里**（说明 SSE 事件流闭环）；
 * - SC-4 工具卡出现（`read`）；
 * - SC-5 截图非空（≥10KB），且页面无未捕获异常；
 * - SC-6 视口确实是 390×844（CDP 覆写后读回 `innerWidth/innerHeight`）。
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "./mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const webDir = join(repoRoot, "packages", "host", "web");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function pickDbBin() {
  const release = join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
  const debug = join(repoRoot, "src-tauri", "codem-db", "target", "debug", "codem-db-cli.exe");
  const candidates = process.env.CODEM_DB_BIN ? [process.env.CODEM_DB_BIN] : [release, debug];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error("找不到 codem-db-cli");
}

function cliInvoke(dbBin, dbPath, command, params) {
  const out = execFileSync(dbBin, ["--db", dbPath, "invoke", command, "-"], {
    input: JSON.stringify(params ?? {}),
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push(msg.params?.exceptionDetails?.exception?.description ?? "exception");
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        this.errors.push(
          (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" "),
        );
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveSend) => {
      this.pending.set(id, resolveSend);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const reply = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
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
    child.on("exit", (code) => rejectReady(new Error(`Host 提前退出 code=${code}：${buffer}`)));
  });
}

async function main() {
  const dbBin = pickDbBin();
  const work = await mkdtemp(join(tmpdir(), "codem-host-spike-c-"));
  const dataHome = join(work, "data");
  const dbPath = join(dataHome, "codem-db-rust.bin");
  await mkdir(join(dataHome, "sessions"), { recursive: true });

  // 确定性的种子会话：不依赖用户数据（Spike C 验的是端到端链路，不是真实数据规模）
  cliInvoke(dbBin, dbPath, "sessions.upsert", {
    id: "spike-c-session",
    project_id: "",
    title: "移动端 Spike 会话",
    created_at: 1_700_000_100_000,
  });
  cliInvoke(dbBin, dbPath, "messages.create", {
    id: "spike-c-m1",
    session_id: "spike-c-session",
    role: "user",
    content: "这是种子消息 SEED_MARKER",
    timestamp: 1_700_000_100_001,
  });
  cliInvoke(dbBin, dbPath, "messages.create", {
    id: "spike-c-m2",
    session_id: "spike-c-session",
    role: "assistant",
    content: "种子答复",
    timestamp: 1_700_000_100_002,
  });

  const mock = await startMockProvider({ toolPath: "index.html" });
  const host = spawn(
    process.execPath,
    [hostEntry, "serve", "--data-home", dataHome, "--workspace", webDir, "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEM_DB_BIN: dbBin,
        CODEM_LLM_BASE_URL: mock.url,
        CODEM_LLM_MODEL: "mock-model",
      },
    },
  );
  let hostStderr = "";
  host.stderr.on("data", (c) => {
    hostStderr += c.toString("utf8");
  });

  const profile = join(work, "edge-profile");
  let edge;
  let cdp;
  const summary = { spike: "C", checks: {} };
  try {
    const ready = await waitForReady(host);
    const url = `${ready.url}/?open=spike-c-session&selftest=1`;
    edge = spawn(
      EDGE,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--window-size=390,844",
        url,
      ],
      { stdio: "ignore" },
    );

    // 等 DevToolsActivePort（Edge 把实际端口写在这个文件里）
    const portFile = join(profile, "DevToolsActivePort");
    let debugPort = null;
    for (let i = 0; i < 100 && !debugPort; i++) {
      await sleep(200);
      if (existsSync(portFile)) {
        const text = (await readFile(portFile, "utf8")).split("\n");
        if (text[0] && Number(text[0]) > 0) debugPort = Number(text[0]);
      }
    }
    if (!debugPort) throw new Error("拿不到 Edge 的 DevTools 端口");
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = list.find((t) => t.type === "page" && String(t.url).startsWith("http://127.0.0.1"));
    if (!page) throw new Error(`没有找到我们的页面：${JSON.stringify(list.map((t) => t.url))}`);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    // 移动视口（模拟 Pixel 类设备）
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(1500);

    let text = "";
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      text = (await cdp.eval("document.body.innerText")) ?? "";
      if (text.includes("MOCK_DONE")) break;
      await sleep(500);
    }

    const viewport = await cdp.eval("[window.innerWidth, window.innerHeight]");
    summary.checks.SC1_connected = (await cdp.eval("document.body.getAttribute('data-connected')")) === "1";
    summary.checks.SC2_seedVisible = text.includes("SEED_MARKER") || text.includes("种子消息");
    summary.checks.SC3_finalAnswer = text.includes("MOCK_DONE");
    summary.checks.SC4_toolCard = /read/.test(text) && (text.includes("index.html") || text.includes("tool"));
    summary.checks.SC6_viewport = Array.isArray(viewport) && viewport[0] === 390 && viewport[1] === 844;
    summary.viewport = viewport;

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const b64 = shot.result?.data ?? "";
    const png = Buffer.from(b64, "base64");
    const outPng = join(work, "spike-c-mobile.png");
    await writeFile(outPng, png);
    summary.checks.SC5_screenshot = png.length >= 10_000;
    summary.screenshotBytes = png.length;
    summary.checks.SC5_noPageErrors = cdp.errors.length === 0;
    summary.pageErrors = cdp.errors.slice(0, 5);
    summary.domPreview = text.slice(0, 400);
    summary.screenshotPath = outPng;

    // 落一份到仓库（ADR 里引用；体积很小）
    const evidenceDir = join(repoRoot, "docs", "architecture", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await copyFile(outPng, join(evidenceDir, "spike-c-mobile-390x844.png"));
    summary.checks.evidenceCopied = true;
  } finally {
    cdp?.close();
    try {
      edge?.kill();
    } catch {
      /* 已退出 */
    }
    host.kill("SIGTERM");
    await sleep(600);
    if (!host.killed) host.kill();
    await mock.close();
  }

  const ok = Object.entries(summary.checks).every(([k, v]) => (typeof v === "boolean" ? v : true));
  summary.ok = ok;
  if (!ok) summary.hostStderr = hostStderr.slice(-4000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.CODEM_KEEP_SPIKE_DIR !== "1") await rm(work, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[spike-c] 失败：${e?.stack ?? e}\n`);
  process.exit(1);
});
