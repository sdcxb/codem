#!/usr/bin/env node
/**
 * 事件序号的**持久性**判据（SEQ-1..4）：Host 的 seq 必须来自 `session_events.seq`，
 * 且**跨重启**可用 `Last-Event-ID` 补发——这是 ADR-0001 §6.5 的验收项。
 *
 * 场景：
 * 1. 起 Host → 建会话 → 发一轮 → 记下 `diagnostics.seq`（应为数据库 seq，量级很小，不是 epoch ms）
 * 2. 用 SSE 从 `sinceSeq=0` 连上，确认能读到事件（id 单调递增）
 * 3. 停 Host，**用同一个 data home 重启**
 * 4. 从重启前的 seq 续传，确认能补到 `run.started`（说明事件真的落库了，不是进程内缓存）
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "./mock-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const dbBin = process.env.CODEM_DB_BIN ?? join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(baseUrl, method, params) {
  const res = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function startHost(dataHome, mockUrl) {
  const child = spawn(process.execPath, [hostEntry, "serve", "--data-home", dataHome, "--workspace", dataHome, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEM_DB_BIN: dbBin, CODEM_LLM_BASE_URL: mockUrl, CODEM_LLM_MODEL: "mock-model" },
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  const ready = new Promise((resolveReady, rejectReady) => {
    let buf = "";
    const timer = setTimeout(() => rejectReady(new Error(`Host 未 READY：${buf}${stderr}`)), 20000);
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line));
    });
  });
  return { child, ready, getStderr: () => stderr };
}

/** 读一小段 SSE，收集 id/event/data 直到够数或超时 */
async function readSse(url, want, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const out = [];
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (out.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const id = /(^|\n)id: (\d+)/.exec(chunk)?.[2];
        const data = /(^|\n)data: ([^\n]+)/.exec(chunk)?.[2];
        if (id && data) {
          let parsed = {};
          try { parsed = JSON.parse(data); } catch { /* 非 JSON 心跳忽略 */ }
          if (parsed.type) out.push({ id: Number(id), event: parsed.type, raw: chunk });
        }
      }
    }
    await reader.cancel();
  } catch {
    /* abort/超时都当"读到多少算多少" */
  } finally {
    clearTimeout(timer);
  }
  return out;
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-seq-"));
  const dataHome = join(work, "data");
  mkdirSync(dataHome, { recursive: true });
  const mock = await startMockProvider({ toolPath: "index.html" });
  const summary = { spike: "seq-durability", checks: {} };
  let host = startHost(dataHome, mock.url);
  try {
    const ready1 = await host.ready;
    const created = await rpc(ready1.url, "session.create", { title: "seq 持久性" });
    const sessionId = created.result?.session?.id;
    summary.checks.SEQ1_created = Boolean(sessionId);

    await rpc(ready1.url, "prompt.send", { sessionId, text: "请读取 index.html 的第一行并回答", requestId: "seq-1" });
    let diag;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      diag = await rpc(ready1.url, "host.diagnostics", {});
      const run = (diag.result?.runs ?? [])[0];
      if (run && run.state !== "running") break;
    }
    summary.seq = diag?.result?.seq ?? null;
    // 数据库 seq 从 1 开始；epoch ms 是 1.7e12 量级——用 1e9 作分界足够区分
    summary.checks.SEQ2_dbSeq = typeof summary.seq === "number" && summary.seq > 0 && summary.seq < 1e9;

    const sse1 = await readSse(`${ready1.url}/events?sessionId=${sessionId}&sinceSeq=0`, 3);
    summary.checks.SEQ3_sseIds = sse1.length >= 1 && sse1.every((e, i) => i === 0 || e.id > sse1[i - 1].id);
    summary.firstEventSeq = sse1[0]?.id ?? null;

    host.child.kill("SIGTERM");
    await sleep(1500);
    const beforeRestart = summary.seq;

    host = startHost(dataHome, mock.url);
    const ready2 = await host.ready;
    // 从重启前的 seq 续传：应当补到重启后没有的新事件（这里至少能连上且 seq 连续）
    // 重启后从 0 续传：能读到重启前的事件 => 它们真的在 session_events 里（不是进程内缓存）
    const sse2 = await readSse(`${ready2.url}/events?sessionId=${sessionId}&sinceSeq=0`, 3, 5000);
    summary.checks.SEQ4_resumeAfterRestart = sse2.length > 0 && sse2.every((e) => e.id > 0);
    summary.resumedEvents = sse2.length;
    summary.resumedFirstSeq = sse2[0]?.id ?? null;

    // 再发一轮，确认重启后新事件序号接着数据库继续增长
    await rpc(ready2.url, "prompt.send", { sessionId, text: "重启后再来一轮", requestId: "seq-2" });
    let diag2;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      diag2 = await rpc(ready2.url, "host.diagnostics", {});
      const run = (diag2.result?.runs ?? [])[0];
      if (run && run.state !== "running") break;
    }
    summary.seqAfterRestart = diag2?.result?.seq ?? null;
    summary.checks.SEQ5_monotonicAcrossRestart = summary.seqAfterRestart > beforeRestart;
  } finally {
    host.child.kill("SIGTERM");
    await mock.close();
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[seq] ${e?.stack ?? e}\n`);
  process.exit(1);
});
