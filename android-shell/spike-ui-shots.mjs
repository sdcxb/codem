#!/usr/bin/env node
/**
 * UI 取证脚本：按真实操作路径截取 Android 端共享 UI 的各状态，供设计对标评审。
 *
 * 状态：会话列表（窄屏）→ 对话（工具卡+回答+继续）→ 审批卡 → 文件弹层 →
 *       宽屏 900（双列）→ 900（列表折叠）→ 宽屏 1200（三列）→ 1200（第三列「差异」页签）。
 *
 * 用确定性 provider（glob / bash），只验证 UI 形态，不验证模型。
 *
 * 端口是内核随机分配的，不能再用 8787：从 `CodemHost` logcat / `files/host.log` 的
 * READY 行发现端口；`local-auth` 下的 RPC 在页面上下文里发（同源 cookie 自动携带），
 * Node 侧不读取、不打印凭据。
 *
 * 前置：`node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk`（配置类 extras 只在
 * debuggable 构建生效）。
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DeviceHostEndpoint } from "./lib/host-endpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64-debug.apk");
const pkg = "com.codem.remote";
const RPC = 18797;
const CDP = 9335;
const outDir = join(here, "..", "docs", "architecture", "evidence");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...a) => execFileSync(adb, ["-s", serial, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function startProvider() {
  let callId = null;
  let lastUserContent = null;
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* ignore */
      }
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m?.role === "user" && !/^(当前执行计划|<system-reminder>|\[Context:)/.test(String(m.content ?? "")));
      if ((lastUser?.content ?? null) !== lastUserContent) {
        lastUserContent = lastUser?.content ?? null;
        callId = null;
      }
      const done = Boolean(callId) && messages.some((m) => m?.tool_call_id === callId);
      const wantsBash = /bash/i.test(String(lastUser?.content ?? ""));
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ id: "ui", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] });
      if (done) {
        send({ id: "ui", model: "m", choices: [{ index: 0, delta: { content: "已完成这一步。\n\n- 读取了工作区\n- 检查了文件\n\n可以继续下一步。" } }] });
        send({ id: "ui", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        const name = wantsBash ? "bash" : "glob";
        const args = wantsBash ? { command: "echo UI_APPROVAL_DEMO" } : { pattern: "*" };
        send({
          id: "ui",
          model: "m",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: (callId = `call_${Date.now()}`), type: "function", function: { name, arguments: JSON.stringify(args) } }],
              },
            },
          ],
        });
        send({ id: "ui", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) })));
}


async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(800);
  }
  throw new Error(`等待超时：${label}`);
}

async function shotCdp(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(r.data, "base64");
  writeFileSync(join(outDir, name), png);
  return png.length;
}

async function shot(name) {
  const png = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(outDir, name), png);
  return png.length;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const provider = await startProvider();
  const mock = provider.url.replace("127.0.0.1", "10.0.2.2");
  const summary = { shots: {} };
  sh("install", "-r", apk);
  if (!/DEBUGGABLE/.test(sh("shell", "dumpsys", "package", pkg))) {
    throw new Error(
      "当前安装的 APK 不是 debuggable 构建，--es llmBase/llmModel 会被忽略。\n" +
        "请先：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk",
    );
  }
  sh("shell", "am", "force-stop", pkg);
  sh("shell", "pm", "clear", pkg);
  const host = new DeviceHostEndpoint({ sh, pkg, rpcPort: RPC, cdpPort: CDP });
  host.clearLogcat();
  sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mock, "--es", "llmModel", "m", "--ez", "webviewDebug", "true");
  try {
    await host.ensureForward();
    await waitUntil(async () => {
      try {
        return (await host.rpc("host.hello", { protocolVersion: 1, client: { name: "shot", version: "0", platform: "node" } })).result?.hostId;
      } catch {
        return null;
      }
    }, 240_000, "Host READY");
    const cdp = await host.connectCdp();
    await waitUntil(async () => String(await cdp.eval("document.body.innerText")).includes("新建会话"), 120_000, "列表");

    summary.shots["ui-list.png"] = await shot("ui-list.png");

    await cdp.eval("(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建会话')).click(); return true; })()");
    await waitUntil(async () => (await cdp.eval("document.querySelectorAll('textarea').length")) > 0, 30_000, "输入框");
    await cdp.eval(`(() => { const t=document.querySelector('textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,'看一下工作区'); t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await waitUntil(async () => await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); return Boolean(b&&!b.disabled); })()"), 10_000, "发送可用");
    await cdp.eval("(() => { [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送').click(); return true; })()");
    await waitUntil(async () => String(await cdp.eval("document.body.innerText")).includes("已完成这一步"), 120_000, "回答");
    summary.shots["ui-chat.png"] = await shot("ui-chat.png");

    // 审批卡
    await cdp.eval(`(() => { const t=document.querySelector('textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,'请 bash 一下'); t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await waitUntil(async () => await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); return Boolean(b&&!b.disabled); })()"), 10_000, "发送可用2");
    await cdp.eval("(() => { [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送').click(); return true; })()");
    await waitUntil(async () => (await cdp.eval("Boolean(document.querySelector('.decision-tray'))")), 60_000, "审批卡");
    summary.shots["ui-approval.png"] = await shot("ui-approval.png");
    await cdp.eval("(() => { [...document.querySelectorAll('.decision-tray button')].find(b=>b.textContent.includes('批准')).click(); return true; })()");
    await sleep(3000);

    // 信息面板（只读）
    await cdp.eval("(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='信息').click(); return true; })()");
    await sleep(1200);
    summary.shots["ui-info.png"] = await shot("ui-info.png");
    await cdp.eval("(() => { [...document.querySelectorAll('.info-panel button')].find(b=>b.textContent.trim()==='关闭')?.click(); return true; })()");
    await sleep(400);

    // 文件弹层
    await cdp.eval("(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='文件').click(); return true; })()");
    await sleep(1200);
    summary.shots["ui-files.png"] = await shot("ui-files.png");
    await cdp.eval("(() => { const b=[...document.querySelectorAll('.file-browser:not(.inline) button')].find(x=>x.textContent.trim()==='关闭'); if(b)b.click(); return true; })()");

    // 宽屏双列 / 三列
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(2000);
    await cdp.send("Page.captureScreenshot", { format: "png" });
    await sleep(400);
    summary.shots["ui-wide-900.png"] = await shotCdp(cdp, "ui-wide-900.png");

    // 平板列表折叠（DC-16 的截图取证）：900px 下点 Header 的「收起列表」
    await waitUntil(async () => {
      const v = await cdp.eval("(() => { const b=document.querySelector('.sidebar-collapse-toggle'); return Boolean(b && getComputedStyle(b).display !== 'none'); })()");
      return v ? true : null;
    }, 10_000, "折叠按钮");
    summary.collapsed = await cdp.eval("(() => { const b=document.querySelector('.sidebar-collapse-toggle'); if(!b) return false; b.click(); return true; })()");
    await sleep(1200);
    summary.shots["ui-wide-900-collapsed.png"] = await shotCdp(cdp, "ui-wide-900-collapsed.png");
    summary.folded = await cdp.eval("JSON.stringify({sidebar:getComputedStyle(document.querySelector('.sidebar')).display,layout:document.querySelector('.layout').className})");
    await cdp.eval("(() => { const b=document.querySelector('.sidebar-collapse-toggle'); if(!b) return false; b.click(); return true; })()");
    await sleep(1000);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);
    await cdp.send("Page.captureScreenshot", { format: "png" });
    await sleep(600);
    summary.dom1200 = await cdp.eval("JSON.stringify({sidebars:document.querySelectorAll('.sidebar').length,headers:document.querySelectorAll('header').length,layouts:document.querySelectorAll('.layout').length,appChildren:document.querySelector('#app')?.children.length, body:document.body.innerText.slice(0,80)})");
    summary.shots["ui-wide-1200.png"] = await shotCdp(cdp, "ui-wide-1200.png");

    // 宽屏第三列切换（DC-17 的截图取证）：选中一个文件 → 切「差异」
    summary.pickedFile = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#detail-panel-files .file-entry.file')];
      if (!rows.length) return false;
      rows[0].click();
      return true;
    })()`);
    await sleep(1600);
    summary.diffTab = await cdp.eval("(() => { const b=document.querySelector('#detail-tab-diff'); if(!b) return false; b.click(); return true; })()");
    await sleep(2000);
    summary.diffPane = await cdp.eval("JSON.stringify({tab:document.querySelector('#detail-tab-diff')?.getAttribute('aria-selected')??'',path:document.querySelector('#detail-panel-diff .file-browser-path')?.textContent??'',text:(document.querySelector('#detail-panel-diff')?.innerText??'').slice(0,120)})");
    summary.shots["ui-wide-1200-diff.png"] = await shotCdp(cdp, "ui-wide-1200-diff.png");
    await cdp.eval("(() => { document.querySelector('#detail-tab-files')?.click(); return true; })()");
    await sleep(600);
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // 三列的“干净截图”：CDP 的 device-metrics 在 SwiftShader 下会留下旧帧，
    // 改用物理分辨率（1200x800 / density 160）重启页面再 screencap。
    sh("shell", "wm", "size", "1200x800");
    sh("shell", "wm", "density", "160");
    sh("shell", "am", "force-stop", pkg);
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mock, "--es", "llmModel", "m", "--ez", "webviewDebug", "true");
    await sleep(12000);
    summary.shots["ui-wide-1200-physical.png"] = await shot("ui-wide-1200-physical.png");
    sh("shell", "wm", "size", "reset");
    sh("shell", "wm", "density", "reset");
  } finally {
    await provider.close();
    host.close();
    try {
      sh("shell", "pm", "clear", pkg);
    } catch {
      /* ignore */
    }
  }
  summary.ok = Object.values(summary.shots).every((n) => n > 10_000);
  writeFileSync(join(outDir, "ui-shots.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[ui-shots] ${e?.stack ?? e}\n`);
  process.exit(1);
});
