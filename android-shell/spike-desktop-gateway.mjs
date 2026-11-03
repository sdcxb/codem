#!/usr/bin/env node
/**
 * 真机用例：**手机访问 PC 桌面远程网关**
 * （ADR-0005 M2：写 + 审批 + 取消 + 事件流；M3：工作区文件 + 变更记录）。
 *
 * ## 与 `run-device-cases.mjs` 的区别
 *
 * 那一套测的是**手机本机 Host**（数据在手机上）。这一套测的是**桌面数据经网关**
 * （数据在 PC）：桌面 App 里启动网关 → 手机/浏览器打开 `http://127.0.0.1:<port>`。
 *
 * ## 前置（缺一项就报错，不猜）
 *
 * 1. 桌面 Codem 已启动，设置里「桌面远程网关」已**启动**（显示 `http://127.0.0.1:PORT`）；
 * 2. `CODEM_GATEWAY_PORT` = 那个端口（本脚本负责 `adb reverse`，手机与 PC 用同一 URL）；
 * 3. `CODEM_GATEWAY_PAIR_CODE` = 设置页点「生成配对码」得到的 6 位码；
 * 4. 协议用例默认会向 `CODEM_GATEWAY_SESSION_ID`（或列表第一条）发一条**无害**消息
 *    （`CODEM_GATEWAY_PROMPT`，默认只要求回一个标记），这会真实写入该会话历史；
 * 5. `--ui` 额外用模拟器里的 Chrome 打开页面并检查「写模式」。UI 配对码可以不给
 *    `CODEM_GATEWAY_UI_PAIR_CODE` —— 传了 `--probe` + `CODEM_GATEWAY_WEBVIEW_CDP`
 *    时脚本会**现生成**一个（配对码一次性，协议用例已经用掉前一个）。
 *
 * ## --probe：没有模型也能验证新增管道
 *
 * 传 `--probe` + `CODEM_GATEWAY_WEBVIEW_CDP=<桌面 WebView 的 CDP 端口>` 时：
 * 连到桌面 WebView，在页面里调用 `gateway_publish_event`（与生产发布同一条命令），
 * 再用本脚本的 SSE 客户端验证「命令 → 事件枢纽 → 手机」、续传去重与白名单校验。
 * 它证明的是**传输管道**，不证明 Agent 循环（GWD-7 会如实 skip）。**不产生真实回合、
 * 不写桌面存储。**
 *
 * 可选真机用例（需要模型配合，未给 prompt 时如实记为 skipped）：
 * - `CODEM_GATEWAY_APPROVAL_PROMPT`：会触发工具审批的提示词（如「用 bash 执行 echo GW_OK」）；
 * - `CODEM_GATEWAY_CANCEL_PROMPT`：一条会跑得足够久的提示词（如「用 bash sleep 60」）；
 * - `CODEM_GATEWAY_CHANGE_PROMPT`：会**改一个文件**的提示词（如「把 GW_CHANGE.txt 的内容改成 ok」）。
 *   GWD-15 会在回合后等 `session.changes` 出现新记录，并对首个文件取 diff。
 *
 * ## 产物
 *
 * `docs/architecture/evidence/gateway-m2-report.json`：
 * 每条用例的 `id / ok / detail / skipped`；**不含 cookie / 配对码 / 任何凭据**。
 *
 * 用法：
 *   $env:ANDROID_SDK_ROOT="C:\Users\abee\AppData\Local\Android\Sdk"
 *   $env:CODEM_GATEWAY_PORT="54321"; $env:CODEM_GATEWAY_PAIR_CODE="123456"
 *   node android-shell/spike-desktop-gateway.mjs
 *   node android-shell/spike-desktop-gateway.mjs --ui   # 再加一条真实 Chrome 的 UI 用例
 *   # 没有模型/只想验证传输管道（用桌面 WebView CDP 发布探针事件）：
 *   $env:CODEM_GATEWAY_WEBVIEW_CDP="9222"
 *   node android-shell/spike-desktop-gateway.mjs --probe --ui
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const port = Number(process.env.CODEM_GATEWAY_PORT ?? "");
const pairCode = String(process.env.CODEM_GATEWAY_PAIR_CODE ?? "").trim();
const uiPairCode = String(process.env.CODEM_GATEWAY_UI_PAIR_CODE ?? "").trim();
const prompt = String(process.env.CODEM_GATEWAY_PROMPT ?? "请只回复 GW_E2E_OK，不要调用任何工具").trim();
const approvalPrompt = String(process.env.CODEM_GATEWAY_APPROVAL_PROMPT ?? "").trim();
const cancelPrompt = String(process.env.CODEM_GATEWAY_CANCEL_PROMPT ?? "").trim();
const changePrompt = String(process.env.CODEM_GATEWAY_CHANGE_PROMPT ?? "").trim();
const wantUi = process.argv.includes("--ui");
/**
 * `--probe`：没有模型时也能验证**新增的传输管道**（不产生真实回合）。
 *
 * 做法：连到桌面 WebView 的 CDP，在页面里调用 `gateway_publish_event`（与生产
 * 发布同一条命令），再用本脚本的 SSE 客户端验证"命令 → 事件枢纽 → 手机"。
 * 它证明的是管道，不证明 Agent 循环（那需要模型；GWD-7 会如实 skip）。
 */
const probeMode = process.argv.includes("--probe");
const webviewCdp = Number(process.env.CODEM_GATEWAY_WEBVIEW_CDP ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

if (!sdk) throw new Error("请设置 ANDROID_SDK_ROOT（需要 platform-tools/adb）");
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error("请设置 CODEM_GATEWAY_PORT（桌面设置页显示的网关端口）");
}
if (!pairCode) throw new Error("请设置 CODEM_GATEWAY_PAIR_CODE（桌面设置页生成的一次性配对码）");

const base = `http://127.0.0.1:${port}`;
const report = [];
let cookie = "";
let sessionId = String(process.env.CODEM_GATEWAY_SESSION_ID ?? "").trim();
let lastEventSeq = 0;

function record(id, ok, detail, skipped = false) {
  report.push({ id, ok, skipped, detail });
  const tag = skipped ? "SKIP" : ok ? "PASS" : "FAIL";
  process.stdout.write(`[${tag}] ${id}: ${detail}\n`);
}

async function rpc(method, params = {}, opts = {}) {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

function rpcResult(r) {
  if (!r.body?.result) {
    throw new Error(`RPC 失败：${r.body?.error?.data?.kind ?? r.body?.error?.message ?? r.status}`);
  }
  return r.body.result;
}

/** SSE：解析 `id:` + `data:` 帧，回调每条事件；返回一个中止函数。 */
function openEvents(query, { lastEventId = 0, onEvent, onError } = {}) {
  const controller = new AbortController();
  const headers = cookie ? { cookie } : {};
  if (lastEventId > 0) headers["last-event-id"] = String(lastEventId);
  const ready = (async () => {
    const res = await fetch(`${base}/events?${query}`, { headers, signal: controller.signal });
    if (res.status !== 200) throw new Error(`/events 未通过鉴权（status=${res.status}）`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) throw new Error(`/events content-type=${type}`);
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx < 0) break;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let id = 0;
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) id = Number(line.slice(4));
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (!dataLines.length) continue;
        let event;
        try {
          event = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        if (id > 0) lastEventSeq = Math.max(lastEventSeq, id);
        onEvent?.(event, id);
      }
    }
  })().catch((e) => {
    if (e?.name !== "AbortError") onError?.(e);
  });
  return { close: () => controller.abort(), done: ready };
}

function checkEventOrder(events, runId) {
  let sawStarted = false;
  let terminal = null;
  let last = 0;
  for (const e of events) {
    if (e.seq && e.seq <= last) throw new Error(`事件 seq 不单调：${last} → ${e.seq}`);
    if (e.seq) last = e.seq;
    if (e.type === "run.started") {
      if (terminal) throw new Error("run.started 出现在终态之后");
      sawStarted = true;
    }
    if (["run.finished", "run.failed", "run.cancelled"].includes(e.type)) terminal = e;
    if (e.type === "assistant.text" && !sawStarted) {
      throw new Error("assistant.text 早于 run.started（手机不知道这次 run 的 id）");
    }
  }
  if (!sawStarted) throw new Error("没有收到 run.started");
  if (!terminal) throw new Error("没有收到终态事件（不丢终态是硬要求）");
  if (runId) {
    const withRun = events.filter((e) => e.runId === runId);
    if (!withRun.length) throw new Error("事件里没有本次 runId（无法归属/取消）");
    if (terminal.runId !== runId) throw new Error(`终态 runId 不一致：${terminal.runId}`);
  }
  return terminal;
}

/**
 * GWD-12..15：桌面变更记录（`session.changes` / `session.change.diff`）。
 *
 * 期望形态是"桌面那份 `turn_file_changes`"：不是 Host 库、不是手机缓存。
 * 没有变更记录时 GWD-13 如实 skip（不是 fail）；GWD-15 需要模型提示词。
 */
async function runChangesCases(realSessionId) {
  let listed;
  try {
    listed = rpcResult(
      await rpc("session.changes", { sessionId: realSessionId, offset: 0, limit: 20 }),
    );
  } catch (e) {
    record("GWD-12", false, `session.changes 失败：${String(e?.message ?? e)}`);
    return;
  }
  const items = Array.isArray(listed.items) ? listed.items : [];
  const shapeOk =
    typeof listed.supported === "boolean" &&
    Array.isArray(listed.items) &&
    typeof listed.hasMore === "boolean" &&
    (listed.supported || typeof listed.reason === "string");
  record(
    "GWD-12",
    shapeOk,
    `session.changes supported=${listed.supported} items=${items.length} hasMore=${listed.hasMore}` +
      (listed.reason ? ` reason=${listed.reason}` : ""),
  );

  const change = items.find(
    (c) => c && typeof c.changeId === "string" && Array.isArray(c.files) && c.files.length > 0,
  );
  const file = change?.files?.find((f) => f && typeof f.path === "string");
  if (!change || !file) {
    record(
      "GWD-13",
      true,
      "暂无可取 diff 的变更记录（不是失败：先让 Agent 改一个文件，或用 CODEM_GATEWAY_CHANGE_PROMPT 跑 GWD-15）",
      true,
    );
  } else {
    try {
      const got = rpcResult(
        await rpc("session.change.diff", {
          sessionId: realSessionId,
          changeId: change.changeId,
          path: file.path,
        }),
      );
      const diffOk =
        typeof got.path === "string" &&
        typeof got.status === "string" &&
        typeof got.patch === "string" &&
        typeof got.truncated === "boolean" &&
        typeof got.supported === "boolean" &&
        (got.supported ? got.patch.length > 0 || got.truncated : typeof got.reason === "string");
      record(
        "GWD-13",
        diffOk,
        `session.change.diff path=${got.path} supported=${got.supported} patch=${got.patch.length}字符` +
          (got.reason ? ` reason=${got.reason}` : ""),
      );
    } catch (e) {
      record("GWD-13", false, `session.change.diff 失败：${String(e?.message ?? e)}`);
    }
  }

  const missing = await rpc("session.change.diff", {
    sessionId: realSessionId,
    changeId: "gwd-does-not-exist",
    path: "x.txt",
  });
  record(
    "GWD-14",
    missing.body?.error?.data?.kind === "NOT_FOUND" && missing.body?.error?.code === -32003,
    `未知 changeId → ${missing.body?.error?.data?.kind ?? missing.status}（必须是 NOT_FOUND）`,
  );

  await runChangePromptCase(realSessionId, new Set(items.map((c) => c?.changeId).filter(Boolean)));
}

/**
 * GWD-15：真实改文件后，桌面变更记录应出现**新的一行**，且首个文件能取 diff。
 * 没有 `CODEM_GATEWAY_CHANGE_PROMPT` 时如实 skip（不假绿）。
 */
async function runChangePromptCase(realSessionId, beforeIds) {
  if (!changePrompt) {
    record(
      "GWD-15",
      true,
      "未提供 CODEM_GATEWAY_CHANGE_PROMPT，真实改文件后的变更记录用例未执行",
      true,
    );
    return;
  }
  try {
    rpcResult(
      await rpc("prompt.send", {
        sessionId: realSessionId,
        text: changePrompt,
        requestId: `gwd-change-${Date.now()}`,
        clientId: "android-e2e",
      }),
    );
    const deadline = Date.now() + 4 * 60 * 1000;
    let found = null;
    while (Date.now() < deadline && !found) {
      await sleep(2_500);
      const page = rpcResult(
        await rpc("session.changes", { sessionId: realSessionId, offset: 0, limit: 20 }),
      );
      found = (page.items ?? []).find((c) => c?.changeId && !beforeIds.has(c.changeId)) ?? null;
    }
    if (!found) throw new Error("等待新变更记录超时（提示词可能没有改文件）");
    const file = (found.files ?? []).find((f) => f && typeof f.path === "string");
    if (!file) throw new Error(`新记录 ${found.changeId} 没有文件清单`);
    const got = rpcResult(
      await rpc("session.change.diff", {
        sessionId: realSessionId,
        changeId: found.changeId,
        path: file.path,
      }),
    );
    record(
      "GWD-15",
      typeof got.supported === "boolean" && (got.supported || typeof got.reason === "string"),
      `真实改文件后出现新记录 changeId=${found.changeId} file=${file.path} ` +
        `supported=${got.supported}${got.reason ? ` reason=${got.reason}` : ""}`,
    );
  } catch (e) {
    record("GWD-15", false, String(e?.message ?? e));
  }
}

async function main() {
  // 手机与 PC 使用同一个 URL：端口反向映射（真机走 USB；模拟器同样适用）。
  try {
    sh("reverse", "--remove", `tcp:${port}`);
  } catch {
    /* 没有旧映射不算失败 */
  }
  sh("reverse", `tcp:${port}`, `tcp:${port}`);
  record("GWD-0", true, `adb reverse tcp:${port} → PC 网关（手机与 PC 同一 URL）`);

  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  record(
    "GWD-1",
    health.status === 200 && healthBody?.service === "codem-gateway",
    `GET /health → ${health.status} ${JSON.stringify(healthBody)}`,
  );
  if (!healthBody || healthBody.service !== "codem-gateway") return finish(1);

  const unauth = await fetch(`${base}/events?sessionId=x`);
  record("GWD-2", unauth.status === 401, `未配对访问 /events → ${unauth.status}（必须是 401）`);

  const claim = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "pair.claim",
      params: { code: pairCode, deviceName: "Android E2E", platform: "android" },
    }),
  });
  const claimBody = await claim.json();
  if (!claimBody?.result?.deviceId) throw new Error(`配对失败：${claimBody?.error?.message ?? claim.status}`);
  const setCookie = claim.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error("配对成功但没有 Set-Cookie");
  record("GWD-3", true, `pair.claim 成功（deviceId=${claimBody.result.deviceId}）`);

  const hello = rpcResult(await rpc("host.hello", { protocolVersion: 1 }));
  const supported = hello.capabilities?.supported ?? [];
  const needed = ["prompt.send", "run.cancel", "approval.list", "approval.respond"];
  record(
    "GWD-4",
    needed.every((m) => supported.includes(m)) && !supported.includes("events"),
    `host.hello capabilities=${supported.length} 条；写/审批四条齐全=${needed.every((m) => supported.includes(m))}`,
  );

  const list = rpcResult(await rpc("session.list", { limit: 50 }));
  const sessions = Array.isArray(list.items) ? list.items : [];
  if (!sessionId) sessionId = sessions[0]?.id ?? "";
  if (!sessionId && probeMode) {
    // 探针只验证事件管道，不需要真实会话；用一个占位 id（SSE 不要求会话存在）。
    sessionId = "probe-session";
    record("GWD-5", true, "桌面没有会话；--probe 用占位 sessionId 验证事件管道", true);
  } else if (!sessionId) {
    record("GWD-5", false, "桌面没有可用的会话 —— 先在桌面建一个会话再跑本用例");
    return finish(1);
  } else {
    const detail = rpcResult(await rpc("session.get", { sessionId, limit: 5 }));
    record(
      "GWD-5",
      detail.session?.id === sessionId && Array.isArray(detail.messages) && "run" in detail,
      `session.get 返回 ${detail.messages?.length ?? 0} 条消息，run=${JSON.stringify(detail.run)}`,
    );
  }

  const approvals = rpcResult(await rpc("approval.list", {}));
  record(
    "GWD-6",
    Array.isArray(approvals.approvals),
    `approval.list 形状正确（当前 ${approvals.approvals?.length ?? 0} 条待批）`,
  );

  // M3 变更面：必须真的是桌面 `turn_file_changes` + 桌面 git 对象。
  if (probeMode) {
    for (const id of ["GWD-12", "GWD-13", "GWD-14", "GWD-15"]) {
      record(id, true, "--probe：没有真实会话，变更记录用例未执行", true);
    }
  } else {
    await runChangesCases(sessionId);
  }

  if (probeMode) {
    await runBridgeProbe();
    for (const id of ["GWD-7", "GWD-7b", "GWD-8", "GWD-9", "GWD-10"]) {
      record(id, true, "--probe：没有模型，真实回合用例未执行（管道由 GWD-P1..P4 验证）", true);
    }
  } else {
  // ---- GWD-7：真实一轮（写路径 + 事件流 + 终态） ----
  const events = [];
  let expectedRunId = "";
  let resolveTerminal;
  const terminalSeen = new Promise((r) => (resolveTerminal = r));
  const stream = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
    onEvent: (event) => {
      events.push(event);
      if (
        ["run.finished", "run.failed", "run.cancelled"].includes(event.type) &&
        (!expectedRunId || event.runId === expectedRunId)
      ) {
        resolveTerminal(event);
      }
    },
    onError: (e) => process.stderr.write(`[gateway] SSE 断开：${e?.message ?? e}\n`),
  });
  // 等 ready（连接建立）再发，避免"发送早于订阅"的竞态。
  await sleep(300);
  const sent = rpcResult(await rpc("prompt.send", { sessionId, text: prompt, requestId: `e2e-${Date.now()}`, clientId: "android-e2e" }));
  expectedRunId = sent.runId;
  const terminal = await Promise.race([
    terminalSeen,
    sleep(8 * 60 * 1000).then(() => {
      throw new Error("等待终态事件超时");
    }),
  ]);
  stream.close();
  const terminalState = terminal.payload?.state;
  const runEvents = events.filter((e) => e.runId === sent.runId);
  let orderOk = false;
  let orderDetail = "";
  try {
    checkEventOrder(runEvents, sent.runId);
    orderOk = true;
    orderDetail = `事件 ${runEvents.length} 条，顺序正确，终态=${terminalState}`;
  } catch (e) {
    orderDetail = String(e?.message ?? e);
  }
  record(
    "GWD-7",
    orderOk && terminalState === "succeeded",
    `prompt.send → runId=${sent.runId}；${orderDetail}`,
  );

  // ---- GWD-7b：桌面历史落库（手机看到的那一轮真的进了桌面会话） ----
  try {
    const after = rpcResult(await rpc("session.get", { sessionId, limit: 20 }));
    const messages = Array.isArray(after.messages) ? after.messages : [];
    const contents = messages.map((m) => String(m.content ?? ""));
    const hasUser = contents.some((c) => c.includes(prompt.slice(0, 20)));
    const hasAssistant = messages.some((m) => m.role === "assistant" && String(m.content ?? "").trim().length > 0);
    record(
      "GWD-7b",
      hasUser && hasAssistant,
      `发送后 session.get：${messages.length} 条；用户消息=${hasUser}；助手回复=${hasAssistant}`,
    );
  } catch (e) {
    record("GWD-7b", false, `历史落库检查失败：${String(e?.message ?? e)}`);
  }

  // ---- GWD-8：断线重连不重复、不丢终态 ----
  try {
    const firstSeq = runEvents.find((e) => e.seq > 0)?.seq ?? 0;
    const replayed = [];
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const resume = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
      lastEventId: firstSeq,
      onEvent: (event) => {
        replayed.push(event);
        if (["run.finished", "run.failed", "run.cancelled"].includes(event.type)) resolveDone();
      },
    });
    await Promise.race([done, sleep(15_000)]);
    resume.close();
    const bad = replayed.filter((e) => e.seq > 0 && e.seq <= firstSeq);
    const hasTerminal = replayed.some((e) => e.runId === sent.runId && ["run.finished", "run.failed", "run.cancelled"].includes(e.type));
    record(
      "GWD-8",
      bad.length === 0 && hasTerminal,
      `Last-Event-ID=${firstSeq} 补发 ${replayed.length} 条；重复 ${bad.length} 条；终态补发=${hasTerminal}`,
    );
  } catch (e) {
    record("GWD-8", false, `重连补发失败：${String(e?.message ?? e)}`);
  }

  // ---- GWD-9：审批（需要模型配合的提示词） ----
  if (!approvalPrompt) {
    record("GWD-9", true, "未提供 CODEM_GATEWAY_APPROVAL_PROMPT，审批真机用例未执行", true);
  } else {
    try {
      const approvalEvents = [];
      let resolveApproval;
      const approvalHit = new Promise((r) => (resolveApproval = r));
      const approvalStream = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
        onEvent: (event) => {
          approvalEvents.push(event);
          if (event.type === "approval.requested") resolveApproval(event);
        },
      });
      await sleep(300);
      rpcResult(await rpc("prompt.send", { sessionId, text: approvalPrompt, requestId: `e2e-ap-${Date.now()}`, clientId: "android-e2e" }));
      const requested = await Promise.race([
        approvalHit,
        sleep(4 * 60 * 1000).then(() => {
          throw new Error("等不到审批请求（模型可能没调用需要批准的工具）");
        }),
      ]);
      const approvalId = requested.payload?.approval?.approvalId;
      const listNow = rpcResult(await rpc("approval.list", { sessionId }));
      const listed = (listNow.approvals ?? []).some((a) => a.approvalId === approvalId);
      const answered = rpcResult(await rpc("approval.respond", { approvalId, decision: "deny" }));
      // 桌面/手机任何一方处理后，代理都会推 resolved；轮询也是为了不依赖"恰好推给这条流"。
      let resolved = false;
      for (let i = 0; i < 50; i++) {
        if (approvalEvents.some((e) => e.type === "approval.resolved" && e.payload?.approvalId === approvalId)) {
          resolved = true;
          break;
        }
        await sleep(300);
      }
      approvalStream.close();
      record(
        "GWD-9",
        listed && answered.decision === "deny" && resolved,
        `approval.list 可见=${listed}；respond=${answered.decision}；resolved 事件=${resolved}`,
      );
    } catch (e) {
      record("GWD-9", false, String(e?.message ?? e));
    }
  }

  // ---- GWD-10：取消（需要会跑得足够久的提示词） ----
  if (!cancelPrompt) {
    record("GWD-10", true, "未提供 CODEM_GATEWAY_CANCEL_PROMPT，取消真机用例未执行", true);
  } else {
    try {
      const cancelEvents = [];
      let resolveStarted;
      const started = new Promise((r) => (resolveStarted = r));
      let resolveCancelled;
      const cancelled = new Promise((r) => (resolveCancelled = r));
      const cancelStream = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
        onEvent: (event) => {
          cancelEvents.push(event);
          if (event.type === "run.started") resolveStarted(event);
          if (event.type === "run.cancelled") resolveCancelled(event);
          if (event.type === "run.finished" || event.type === "run.failed") resolveCancelled(null);
        },
      });
      await sleep(300);
      const sentCancel = rpcResult(await rpc("prompt.send", { sessionId, text: cancelPrompt, requestId: `e2e-cc-${Date.now()}`, clientId: "android-e2e" }));
      await Promise.race([started, sleep(30_000).then(() => {
        throw new Error("30s 内没收到 run.started");
      })]);
      const cancelledResp = rpcResult(await rpc("run.cancel", { runId: sentCancel.runId, clientId: "android-e2e" }));
      const terminalEvent = await Promise.race([cancelled, sleep(60_000).then(() => null)]);
      cancelStream.close();
      record(
        "GWD-10",
        cancelledResp.cancelled === true && terminalEvent?.type === "run.cancelled",
        `run.cancel cancelled=${cancelledResp.cancelled}；终态=${terminalEvent?.type ?? "未在 60s 内收到（可能已正常跑完）"}`,
      );
    } catch (e) {
      record("GWD-10", false, String(e?.message ?? e));
    }
  }
  } // end of !probeMode

  // ---- GWD-11（可选）：真实 Chrome 打开网关页面，检查写模式与手机入口（可见 + 可点开） ----
  if (!wantUi) {
    record("GWD-11", true, "未传 --ui，Chrome UI 用例未执行", true);
  } else {
    await runChromeUiCheck();
  }
  return finish(report.every((r) => r.ok) ? 0 : 1);
}

/**
 * 探针：桌面 WebView CDP → `gateway_publish_event` → 网关事件枢纽 → SSE。
 *
 * 只证明**传输管道**（命令注册/序号/直播/续传/校验），不产生真实回合、不写桌面存储。
 * 需要桌面以 `--remote-debugging-port=9222` 启动，且 `CODEM_GATEWAY_WEBVIEW_CDP=9222`。
 */
async function runBridgeProbe() {
  if (!Number.isInteger(webviewCdp) || webviewCdp <= 0) {
    record("GWD-P0", false, "--probe 需要 CODEM_GATEWAY_WEBVIEW_CDP（桌面 WebView 的 CDP 端口）");
    return;
  }
  const runId = `probe-${Date.now()}`;
  const evaluate = await openWebViewEval(webviewCdp);
  if (!evaluate) {
    record("GWD-P0", false, `连不上桌面 WebView CDP（127.0.0.1:${webviewCdp}）`);
    return;
  }
  record("GWD-P0", true, `已连上桌面 WebView CDP（127.0.0.1:${webviewCdp}），用真实命令发布探针事件`);

  const live = [];
  const stream = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
    onEvent: (event) => live.push(event),
  });
  await sleep(400);
  try {
    await evaluate(
      `window.__TAURI__.core.invoke("gateway_publish_event", ${JSON.stringify({
        sessionId,
        eventType: "assistant.text",
        payload: { text: "GW_PROBE_TEXT" },
        runId,
      })})`,
    );
    for (let i = 0; i < 40 && !live.some((e) => e.payload?.text === "GW_PROBE_TEXT"); i++) await sleep(100);
    const first = live.find((e) => e.payload?.text === "GW_PROBE_TEXT");
    record(
      "GWD-P1",
      Boolean(first?.seq > 0),
      first ? `SSE 收到探针正文（seq=${first.seq}, runId=${first.runId}）` : "SSE 没收到探针正文",
    );

    await evaluate(
      `window.__TAURI__.core.invoke("gateway_publish_event", ${JSON.stringify({
        sessionId,
        eventType: "run.finished",
        payload: { state: "succeeded" },
        runId,
      })})`,
    );
    for (let i = 0; i < 40 && !live.some((e) => e.type === "run.finished"); i++) await sleep(100);
    const terminal = live.find((e) => e.type === "run.finished");
    record(
      "GWD-P2",
      Boolean(terminal) && (!first || terminal.seq > first.seq),
      terminal ? `SSE 收到终态（seq=${terminal.seq}）` : "SSE 没收到终态",
    );
    stream.close();

    // 续传：从第一条的 seq 重连 ⇒ 只应收到后面的终态，不能重复正文。
    const replayed = [];
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const resume = openEvents(`sessionId=${encodeURIComponent(sessionId)}`, {
      lastEventId: first?.seq ?? 0,
      onEvent: (event) => {
        replayed.push(event);
        if (event.type === "run.finished" && event.runId === runId) resolveDone();
      },
    });
    await Promise.race([done, sleep(8000)]);
    resume.close();
    // 只统计**真实事件**：gateway.ready 的 seq=0 是合成帧（不占序号、不算重复）。
    const dup = replayed.filter((e) => e.seq > 0 && e.seq <= (first?.seq ?? 0));
    const gotTerminal = replayed.some((e) => e.type === "run.finished" && e.runId === runId);
    record(
      "GWD-P3",
      dup.length === 0 && gotTerminal,
      `Last-Event-ID=${first?.seq ?? 0} 补发 ${replayed.length} 条；重复 ${dup.length}；终态=${gotTerminal}`,
    );

    // 白名单校验：未知事件类型必须被网关拒绝（渲染层不能把任意东西推给手机）。
    let rejected = false;
    try {
      await evaluate(
        `window.__TAURI__.core.invoke("gateway_publish_event", ${JSON.stringify({
          sessionId,
          eventType: "gateway.reset",
          payload: {},
        })})`,
      );
    } catch {
      rejected = true;
    }
    record("GWD-P4", rejected, `gateway.reset 由渲染层发布会${rejected ? "被拒绝（正确）" : "成功（错误！）"}`);
  } finally {
    stream.close();
  }
}

/** 连桌面 WebView 的 CDP；返回 `evaluate(expression)`（失败返回 null）。 */
async function openWebViewEval(portNumber) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json();
    const page = targets.find((t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"));
    if (!page) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    return (expression) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {
          resolve: (r) => {
            if (r?.exceptionDetails) reject(new Error(r.exceptionDetails.text ?? "页面执行失败"));
            else resolve(r?.result?.value);
          },
          reject,
        });
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("CDP Runtime.evaluate 超时"));
          }
        }, 30_000);
      });
  } catch {
    return null;
  }
}


async function runChromeUiCheck() {
  const cdpPort = Number(process.env.CODEM_GATEWAY_CDP_PORT ?? 9339);
  /** 协议用例已经用掉一个一次性码；UI 用码可以现生成（需要桌面 WebView CDP）。 */
  let codeForUi = uiPairCode;
  if (!codeForUi && Number.isInteger(webviewCdp) && webviewCdp > 0) {
    const evaluate = await openWebViewEval(webviewCdp);
    if (evaluate) {
      try {
        const fresh = await evaluate(`window.__TAURI__.core.invoke("gateway_pair_start")`);
        codeForUi = String(fresh?.code ?? "");
      } catch {
        /* 下面按缺少 UI 码处理 */
      }
    }
  }
  if (!codeForUi) {
    record("GWD-11", false, "缺少 UI 配对码（CODEM_GATEWAY_UI_PAIR_CODE 或桌面 WebView CDP）");
    return;
  }
  try {
    sh("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `${base}/`);
    await sleep(6000);
    let socket = "";
    for (let i = 0; i < 20 && !socket; i++) {
      try {
        const unix = sh("shell", "cat", "/proc/net/unix");
        socket = /@?(chrome_devtools_remote)\b/.exec(unix)?.[1] ?? "";
      } catch {
        /* 还没起来 */
      }
      if (!socket) await sleep(500);
    }
    if (!socket) throw new Error("Chrome 没暴露 chrome_devtools_remote（Chrome 是否真的启动了？）");
    try {
      sh("forward", "--remove", `tcp:${cdpPort}`);
    } catch {
      /* ignore */
    }
    sh("forward", `tcp:${cdpPort}`, `localabstract:${socket}`);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = targets.find((t) => String(t.url ?? "").startsWith(base));
    if (!page) throw new Error("Chrome 里没有网关页面 target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome CDP 连接失败")), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP ${method} 超时`));
          }
        }, 30_000);
      });
    const evalJs = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return r?.result?.value;
    };
    // 每次都用**当前**页面重新导航一次：清掉旧 tab 的横幅/旧构建物状态。
    await send("Page.navigate", { url: `${base}/` });
    await sleep(2000);
    // 等页面挂载
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs("Boolean(document.querySelector('#app')?.children?.length)");
      if (ready) break;
      await sleep(500);
    }
    const title = await evalJs("document.title");
    const hasGate = await evalJs("Boolean(document.querySelector('[data-testid=\"pairing-gate\"]'))");
    if (hasGate) {
      await evalJs(`(() => {
        const input = document.querySelector('[data-testid="pairing-code"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(codeForUi)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await sleep(1500);
    }
    for (let i = 0; i < 30; i++) {
      const listed = await evalJs("document.querySelectorAll('.session').length");
      if (listed > 0) break;
      await sleep(500);
    }
    // 选中**会话行**（`＋ 新建会话` 也是 `.session`，必须按文案排除）。
    const selected = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.session')].filter((el) => !el.textContent.includes('新建会话'));
      if (!rows.length) return false;
      rows[0].click();
      return true;
    })()`);
    await sleep(1200);
    const hasComposer = await evalJs("Boolean(document.querySelector('textarea'))");
    const hasReadOnlyBanner = await evalJs("Boolean(document.querySelector('[data-testid=\"gateway-read-only\"]'))");
    // 能力表没有 session.create ⇒ 这个入口不许出现。
    const hasCreate = await evalJs("[...document.querySelectorAll('button')].some((b) => b.textContent.includes('新建会话'))");
    /*
     * 入口判据 = **可见 + 点得开**。
     *
     * 只看 DOM 会把 <1000px 被 CSS 隐藏的第三列页签判成通过 —— M4 安装验收就在这里
     * 吃过假绿：querySelector 里有「变更」，手机上根本点不到。fixed 浮层的
     * `offsetParent` 恒为 null，所以可见性用 getBoundingClientRect + computed style。
     */
    await evalJs(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      window.__gwdUi = {
        header: (text) => [...document.querySelectorAll('button.files-button')].find((b) => b.textContent.trim() === text) || null,
        headerVisible: (text) => visible(window.__gwdUi.header(text)),
        clickHeader: (text) => {
          const b = window.__gwdUi.header(text);
          if (!b || !visible(b)) return false;
          b.click();
          return true;
        },
        overlay: (label) => [...document.querySelectorAll('.file-browser')].find((el) =>
          el.getAttribute('aria-label') === label && visible(el) && !el.classList.contains('inline')) || null,
        closeOverlay: (label) => {
          const box = window.__gwdUi.overlay(label);
          const b = box ? [...box.querySelectorAll('button')].find((x) => x.textContent.trim() === '关闭') : null;
          if (!b) return false;
          b.click();
          return true;
        },
      };
      return true;
    })()`);
    const hasFiles = await evalJs("window.__gwdUi.headerVisible('文件')");
    const hasChanges = await evalJs("window.__gwdUi.headerVisible('变更')");

    const filesOpened = await evalJs("window.__gwdUi.clickHeader('文件')");
    let filesPane = null;
    for (let i = 0; i < 30 && !filesPane; i++) {
      filesPane = await evalJs(`(() => {
        const box = window.__gwdUi.overlay('workspace files');
        if (!box) return null;
        const tree = box.querySelector('.file-tree');
        const err = box.querySelector('.file-browser-error');
        const loaded = box.querySelector('.file-entry') || box.querySelector('.empty-hint') ||
          err || box.querySelector('.file-browser-empty');
        if (!loaded) return null;
        return {
          entries: box.querySelectorAll('.file-entry').length,
          unsupported: Boolean(box.querySelector('.file-browser-empty')),
          error: err ? err.innerText.slice(0, 160) : null,
          text: (tree || box).innerText.slice(0, 160),
        };
      })()`);
      if (!filesPane) await sleep(500);
    }
    const filesClosed = await evalJs("window.__gwdUi.closeOverlay('workspace files')");
    await sleep(500);

    const changesOpened = await evalJs("window.__gwdUi.clickHeader('变更')");
    let changesPane = null;
    for (let i = 0; i < 40 && !changesPane; i++) {
      changesPane = await evalJs(`(() => {
        const box = window.__gwdUi.overlay('workspace changes');
        const list = box ? box.querySelector('.file-changes-list') : null;
        if (!list) return null;
        const empty = box.querySelector('.file-changes-empty');
        const loaded = box.querySelector('.turn-change-group') ||
          (empty && !/读取中/.test(empty.innerText)) ||
          box.querySelector('.file-changes-error-banner');
        if (!loaded) return null;
        return {
          groups: box.querySelectorAll('.turn-change-group').length,
          empty: empty?.innerText?.slice(0, 120) ?? null,
          text: list.innerText.slice(0, 160),
        };
      })()`);
      if (!changesPane) await sleep(500);
    }
    const changesClosed = await evalJs("window.__gwdUi.closeOverlay('workspace changes')");
    const marker = await evalJs("typeof window.__CODEM_GATEWAY_READ_ONLY__");
    ws.close();
    const filesUsable = Boolean(filesPane) && !filesPane.unsupported;
    /*
     * 变更面只看「入口真的把面板打开了」：这个会话的工作区可能不是 git 仓库，
     * 面板会如实显示「此 Host 不记录文件变更」——那也是可用入口，不是 UI 失败。
     * 真实记录/真实 diff 由 M4 的 `mobile-changes-overlay.mjs` 用有变更的会话另行验证。
     */
    const changesUsable = Boolean(changesPane?.text?.includes("只读变更记录"));
    const ok = Boolean(title) && selected === true && hasComposer && !hasReadOnlyBanner && !hasCreate &&
      hasFiles && hasChanges && filesOpened === true && filesUsable && filesClosed === true &&
      changesOpened === true && changesUsable && changesClosed === true && marker === "undefined";
    record(
      "GWD-11",
      ok,
      `Chrome 打开网关：title=${JSON.stringify(title)}；选中会话=${selected}；发送框=${hasComposer}；` +
        `只读横幅=${hasReadOnlyBanner}；新建会话入口=${hasCreate}；` +
        `文件入口可见=${hasFiles}/可点开=${filesOpened}（${filesPane?.entries ?? 0} 条，错误=${filesPane?.error ?? "无"}）/关闭=${filesClosed}；` +
        `变更入口可见=${hasChanges}/可点开=${changesOpened}（${changesPane?.groups ?? 0} 组${changesPane?.empty ? `，空态=${changesPane.empty}` : ""}）/关闭=${changesClosed}；` +
        `只读标记=${marker}`,
    );
  } catch (e) {
    record("GWD-11", false, `Chrome UI 用例失败：${String(e?.message ?? e)}`);
  }
}

function finish(code) {
  const ok = report.every((r) => r.ok);
  const outDir = join(here, "..", "docs", "architecture", "evidence");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "gateway-m2-report.json"),
    `${JSON.stringify({ raw: false, ok, finishedAt: new Date().toISOString(), cases: report }, null, 2)}\n`,
    "utf8",
  );
  const failed = report.filter((r) => !r.ok);
  const skipped = report.filter((r) => r.skipped);
  process.stdout.write(
    `\n结果：${ok ? "ok=true" : "ok=false"}；用例 ${report.length} 条` +
      `（failed=${failed.length}, skipped=${skipped.length}）` +
      `\n报告：docs/architecture/evidence/gateway-m2-report.json\n`,
  );
  process.exit(code);
}

await main();
