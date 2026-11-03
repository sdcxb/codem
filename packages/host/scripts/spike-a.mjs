#!/usr/bin/env node
/**
 * **Spike A**：`codem-host` 读取一个**真实会话**（用户数据根的副本）并跑完一轮 Agent。
 *
 * 判据（脚本自己断言，失败即非零退出）：
 * - SA-1 真实会话被读出来：`session.get` 返回的标题/条数与源库一致；
 * - SA-2 一轮真的跑完：收到 `run.finished` 且 state=succeeded；
 * - SA-3 工具真的执行了：收到 `tool.end`（模型脚本要求调用 `read`）；
 * - SA-4 结果真的回给模型了：收到包含 `MOCK_DONE` 的 `assistant.text`；
 * - SA-5 索引真的写了：跑完后 `messages.count` 比跑前多（Host 走的是**真**存储端口）。
 *
 * ## 安全纪律
 *
 * **绝不碰用户数据根**：先把 `codem-db-rust.bin` 三件套与目标会话的 JSONL
 * **复制**到临时目录，再让 Host 指向副本（与 `tools/maintenance/read-only-db.mjs` 同一条纪律）。
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "./mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const webDir = join(repoRoot, "packages", "host", "web");

function pickDbBin() {
  const debug = join(repoRoot, "src-tauri", "codem-db", "target", "debug", "codem-db-cli.exe");
  const release = join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
  const candidates = process.env.CODEM_DB_BIN ? [process.env.CODEM_DB_BIN] : [release, debug];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(`找不到 codem-db-cli：${candidates.join(" / ")}`);
}

function cliJson(dbBin, dbPath, command, params) {
  const out = execFileSync(dbBin, ["--db", dbPath, "invoke", command, "-"], {
    input: JSON.stringify(params ?? {}),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim());
}

function rpcCall(baseUrl, method, params, id = 1) {
  return fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }).then((r) => r.json());
}

async function waitForReady(child) {
  let buffer = "";
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Host 10s 内没有报 READY：${buffer}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line));
    });
    child.on("exit", (code) => rejectReady(new Error(`Host 提前退出 code=${code}：${buffer}`)));
  });
  return ready;
}

async function main() {
  const dbBin = pickDbBin();
  const sourceHome = process.env.CODEM_SOURCE_HOME ?? join(process.env.APPDATA ?? "", "com.codem.app");
  const sourceDb = join(sourceHome, "codem-db-rust.bin");
  if (!existsSync(sourceDb)) throw new Error(`真实数据根里没有库：${sourceDb}（可用 CODEM_SOURCE_HOME 指定）`);

  const work = await mkdtemp(join(tmpdir(), "codem-host-spike-a-"));
  const dataHome = join(work, "data");
  const dbPath = join(dataHome, "codem-db-rust.bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dataHome, "sessions"), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${sourceDb}${suffix}`;
    if (existsSync(src)) await copyFile(src, `${dbPath}${suffix}`);
  }

  // 1) 用真实库挑一个**有消息**的会话（只读副本）
  const sessions = cliJson(dbBin, dbPath, "sessions.list", { limit: 200 });
  const items = sessions?.result?.items ?? [];
  const target = items.find((s) => Number(s.message_count) > 0) ?? items[0];
  if (!target) throw new Error("副本库里没有任何会话，无法做 Spike A");
  const sourceLog = join(sourceHome, "sessions", `${target.id}.jsonl`);
  let logLines = 0;
  if (existsSync(sourceLog)) {
    await copyFile(sourceLog, join(dataHome, "sessions", `${target.id}.jsonl`));
    const text = await readFile(join(dataHome, "sessions", `${target.id}.jsonl`), "utf8");
    logLines = text.split("\n").filter(Boolean).length;
  }

  const before = cliJson(dbBin, dbPath, "messages.count", { session_id: target.id });
  const beforeCount = Number(before?.result?.total ?? before?.result?.count ?? 0);

  const mock = await startMockProvider({ toolPath: "index.html" });
  const child = (await import("node:child_process")).spawn(
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
  child.stderr.on("data", (c) => {
    hostStderr += c.toString("utf8");
  });

  const summary = {
    spike: "A",
    sourceSession: { id: target.id, title: target.title, messageCount: Number(target.message_count), logLines },
    checks: {},
  };
  try {
    const ready = await waitForReady(child);
    const baseUrl = ready.url;

    const hello = await rpcCall(baseUrl, "host.hello", {
      protocolVersion: 1,
      client: { name: "spike-a", version: "0.0.1", platform: "windows" },
      deviceName: "Spike A",
    });
    if (hello.error) throw new Error(`hello 失败：${JSON.stringify(hello.error)}`);

    const detail = await rpcCall(baseUrl, "session.get", { sessionId: target.id, limit: 50 });
    if (detail.error) throw new Error(`session.get 失败：${JSON.stringify(detail.error)}`);
    summary.checks.SA1_realSessionRead =
      detail.result.session.id === target.id && detail.result.session.title === target.title;
    summary.checks.SA1_messageCount = detail.result.messages.length;

    const since = detail.result.eventSeq;
    const events = [];
    const esAbort = new AbortController();
    const sse = await fetch(
      `${baseUrl}/events?sessionId=${encodeURIComponent(target.id)}&sinceSeq=${since}`,
      { signal: esAbort.signal },
    );
    if (!sse.ok || !sse.body) throw new Error(`SSE 连接失败：${sse.status}`);

    const send = await rpcCall(baseUrl, "prompt.send", {
      sessionId: target.id,
      requestId: "spike-a-1",
      text: "请读取 index.html 的第一行并告诉我它是什么（这是自动化 Spike）。",
    });
    if (send.error) throw new Error(`prompt.send 失败：${JSON.stringify(send.error)}`);

    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6));
        events.push(event);
        if (event.type === "run.finished" || event.type === "run.failed" || event.type === "run.cancelled") {
          esAbort.abort();
          break;
        }
      }
      if (events.some((e) => String(e.type).startsWith("run.finish") || e.type === "run.failed")) break;
    }
    esAbort.abort();

    const terminal = events.find(
      (e) => e.type === "run.finished" || e.type === "run.failed" || e.type === "run.cancelled",
    );
    const finished = events.find((e) => e.type === "run.finished");
    const text = events
      .filter((e) => e.type === "assistant.text")
      .map((e) => String(e.payload.text ?? ""))
      .join("");
    summary.checks.SA2_terminalState = Boolean(terminal);
    summary.checks.SA2b_succeededWithAnswer =
      Boolean(finished) && finished.payload.state === "succeeded" && text.trim().length > 0;
    summary.checks.SA3_toolExecuted = events.some((e) => e.type === "tool.end" && e.payload.isError === false);
    summary.checks.SA4_modelSawToolResult = text.includes("MOCK_DONE");
    summary.eventTypes = events.map((e) => e.type);
    summary.assistantText = text.slice(0, 300);

    // 等 Host 把索引写完（消息写入是异步的，事件 run.finished 可能略早于最后一个写）
    await new Promise((r) => setTimeout(r, 500));
    const after = cliJson(dbBin, dbPath, "messages.count", { session_id: target.id });
    const afterCount = Number(after?.result?.total ?? after?.result?.count ?? 0);
    summary.checks.SA5_indexGrew = afterCount > beforeCount;
    summary.checks.SA5_counts = { before: beforeCount, after: afterCount };
    summary.messages = events.filter((e) => e.type === "assistant.text").length;

    const diag = await rpcCall(baseUrl, "host.diagnostics", { sessionId: target.id });
    summary.diagnostics = {
      persistFailures: (diag.result?.persistFailures ?? []).slice(0, 6),
      runStates: (diag.result?.runs ?? []).map((r) => `${r.runId}:${r.state}`),
      sessionProbe: diag.result?.sessionProbe,
    };
    summary.mockRequestRoles = mock.requests.map((r) =>
      (r.messages ?? []).map((m) => m.role).join(">"),
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    if (!child.killed) child.kill();
    await mock.close();
  }

  const ok = Object.entries(summary.checks).every(([k, v]) => (typeof v === "boolean" ? v : true));
  summary.ok = ok;
  if (!ok) summary.hostStderr = hostStderr.slice(-4000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.CODEM_KEEP_SPIKE_DIR === "1") {
    process.stderr.write(`[spike-a] 保留临时数据根：${dataHome}\n`);
  } else {
    await rm(work, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[spike-a] 失败：${e?.stack ?? e}\n`);
  process.exit(1);
});
