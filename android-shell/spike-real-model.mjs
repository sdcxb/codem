#!/usr/bin/env node
/**
 * **真模型** Android 端到端判据（REAL-1..4）：
 * 1. 设备内 Host 用真实 provider（DeepSeek）跑通一轮（RPC）；
 * 2. 助手正文是**真实模型回答**（不是 mock 的 DEVICE_DONE）；
 * 3. 通过 WebView UI 再发一条，页面出现真实回答；
 * 4. 全程截图 + 运行状态 succeeded。
 *
 * 端口是内核随机分配的（`HostSupervisor.pickFreePort`），所以不能再用 8787：
 * 从 `CodemHost` logcat / `files/host.log` 的 READY 行发现端口。`local-auth` 下
 * `/rpc` 要本次启动的凭据，这里在**页面上下文**里发 RPC（同源 cookie 自动携带），
 * Node 侧不读取、不打印凭据。UI 操作仍走 WebView CDP。
 *
 * 用法（key 只从环境读，不落盘）：
 *   $env:CODEM_TEST_KEY="sk-..."
 *   node android-shell/spike-real-model.mjs
 *
 * 跑完会 `pm clear`，把测试期间写进应用 prefs 的 key 清掉。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DeviceHostEndpoint } from "./lib/host-endpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64-debug.apk");
const pkg = "com.codem.remote";
const RPC_PORT = 18796;
const CDP_PORT = 9334;
const KEY = process.env.CODEM_TEST_KEY ?? "";
const BASE = process.env.CODEM_TEST_BASE ?? "https://api.deepseek.com/v1";
const MODEL = process.env.CODEM_TEST_MODEL ?? "deepseek-chat";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
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
  if (!KEY) throw new Error("缺少 CODEM_TEST_KEY");
  /*
   * 报告里**只写 hasKey**：不写 Key，也不写它的哈希（12 位哈希仍是可关联的标识符）。
   * 这条真机脚本走的是 debuggable 构建的一次性 extras（见下方 preflight）。
   */
  const summary = { spike: "android-real-model", base: BASE, model: MODEL, hasKey: KEY.length > 0, checks: {} };
  sh("install", "-r", apk);
  // 配置类 extras 只对 debuggable 构建生效（release 构建会忽略，跑出来是假失败）
  const pkgDump = sh("shell", "dumpsys", "package", pkg);
  if (!/DEBUGGABLE/.test(pkgDump)) {
    throw new Error(
      "当前安装的 APK 不是 debuggable 构建，--es llmKey/llmBase/llmModel 会被忽略。\n" +
        "请先：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk\n" +
        "再： $env:CODEM_SHELL_APK = \"$PWD\\android-shell\\build\\codem-shell-x86_64-debug.apk\"",
    );
  }
  sh("shell", "am", "force-stop", pkg);
  sh("shell", "pm", "clear", pkg);
  const host = new DeviceHostEndpoint({ sh, pkg, rpcPort: RPC_PORT, cdpPort: CDP_PORT });
  host.clearLogcat();
  try {
    sh(
      "shell", "am", "start", "-n", `${pkg}/.MainActivity`,
      "--es", "llmBase", BASE,
      "--es", "llmKey", KEY,
      "--es", "llmModel", MODEL,
      "--ez", "webviewDebug", "true",
    );
  } catch {
    /*
     * ⚠ 这条 am start 的 argv 里有真 Key：`execFileSync` 抛错时会把**完整命令行**拼进
     * 错误消息（= 打到终端）。所以这里必须吞掉原始异常，只报一句没有凭据的话。
     */
    host.close();
    throw new Error("启动 Activity 失败：命令里带有模型 Key，已隐藏原始错误详情");
  }
  try {
    await host.ensureForward();
    const hello = await waitUntil(async () => {
      try {
        const r = await host.rpc("host.hello", { protocolVersion: 1, client: { name: "real", version: "0", platform: "node" } });
        return r.result?.hostId ? r.result : null;
      } catch {
        return null;
      }
    }, 240_000, "Host READY");
    summary.hostId = hello.hostId;

    const sessionId = (await host.rpc("session.create", { title: "真模型测试" })).result?.session?.id;
    const sent = await host.rpc("prompt.send", { sessionId, text: "只回答一个词：中国的首都", requestId: `real-${Date.now()}` });
    const runId = sent.result?.runId;
    const run = await waitUntil(async () => {
      const d = await host.rpc("host.diagnostics", {});
      const r = (d.result?.runs ?? []).find((x) => x.runId === runId);
      return r && r.state !== "running" ? r : null;
    }, 180_000, "真实回合结束");
    summary.checks.REAL1_runSucceeded = run.state === "succeeded";
    summary.runState = run.state;

    const got = await host.rpc("session.get", { sessionId });
    const msgs = got.result?.messages ?? [];
    const assistant = [...msgs].reverse().find((m) => m.role === "assistant" && String(m.content ?? "").trim());
    const text = String(assistant?.content ?? "");
    summary.assistantPreview = text.slice(0, 80);
    summary.checks.REAL2_realAnswer = text.includes("北京") && !text.includes("DEVICE_DONE") && !text.includes("MOCK");
    console.error("PART1", JSON.stringify({ run: run.state, preview: summary.assistantPreview, real2: summary.checks.REAL2_realAnswer }));

    // UI 路径再发一条（真实模型 + WebView 操作）：用深链直接打开刚才的会话（列表可能是旧的）
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "url", `http://127.0.0.1:${host.port}/?open=${sessionId}`);
    await sleep(5000);
    // 深链可能让 WebView 重新加载：先断开旧 CDP，再附着到当前页面
    host.closeCdp();
    const cdp = await host.connectCdp();
    await waitUntil(async () => {
      const t = await cdp.eval("document.body.innerText");
      return String(t).includes("新建会话") || String(t).includes("文件") ? t : null;
    }, 60_000, "页面加载");
    await waitUntil(async () => ((await cdp.eval("document.querySelectorAll('textarea').length")) ?? 0) > 0, 60_000, "输入框");
    await cdp.eval(`(() => { const t=document.querySelector('textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,'只回答一个词：法国的首都'); t.dispatchEvent(new Event('input',{bubbles:true})); return t.value; })()`);
    await waitUntil(async () => await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); return Boolean(b && !b.disabled); })()"), 10_000, "发送可用");
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); b.click(); return true; })()");
    let uiText = "";
    try {
      uiText = await waitUntil(async () => {
        const t = await cdp.eval("document.body.innerText");
        return String(t).includes("巴黎") ? t : null;
      }, 180_000, "UI 出现真实回答");
    } catch (e) {
      const body = await cdp.eval("document.body.innerText").catch(() => "");
      const diag = await host.rpc("host.diagnostics", {}).catch(() => null);
      console.error("UI_DIAG body=", String(body).slice(0, 800));
      console.error("UI_DIAG runs=", JSON.stringify(diag?.result?.runs ?? []).slice(0, 500));
      throw e;
    }
    summary.checks.REAL3_uiRealAnswer = uiText.includes("巴黎") && !uiText.includes("DEVICE_DONE");

    const png = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(here, "..", "docs", "architecture", "evidence", "android-real-model.png"), png);
    summary.checks.REAL4_screenshot = png.length > 10_000;
  } finally {
    host.close();
    try {
      sh("shell", "pm", "clear", pkg);
    } catch {
      /* ignore */
    }
  }
  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  writeFileSync(join(here, "..", "docs", "architecture", "evidence", "android-real-model.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[real] ${e?.stack ?? e}\n`);
  process.exit(1);
});
