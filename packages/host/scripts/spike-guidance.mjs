#!/usr/bin/env node
/**
 * 运行中引导判据（STEER-1..3）：
 * 1. 运行中 `run.guidance` 被接受；
 * 2. 引导内容真的进入**下一轮模型请求**（provider 记录到）；
 * 3. 运行结束后再引导 ⇒ CONFLICT（不假装接收）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const dbBin = process.env.CODEM_DB_BIN ?? join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProvider() {
  const requests = [];
  let callId = null;
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* empty */
      }
      const messages = body.messages ?? [];
      requests.push(messages);
      const done = Boolean(callId) && messages.some((m) => m?.tool_call_id === callId);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const finish = (content, reason) => {
        send({ id: "s", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] });
        if (content) send({ id: "s", model: "m", choices: [{ index: 0, delta: { content } }] });
        if (!content) {
          send({
            id: "s",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: (callId = `call_${Date.now()}`), type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } },
                  ],
                },
              },
            ],
          });
        }
        send({ id: "s", model: "m", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
        res.write("data: [DONE]\n\n");
        res.end();
      };
      // 故意慢：给客户端留出发引导的窗口
      setTimeout(() => finish(done ? "GUIDANCE_DONE" : "", done ? "stop" : "tool_calls"), 1500);
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((x) => server.close(x)),
        requests,
      }),
    );
  });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-steer-"));
  const data = join(work, "data");
  mkdirSync(data, { recursive: true });
  const provider = await startProvider();
  const child = spawn(process.execPath, [hostEntry, "serve", "--data-home", data, "--workspace", data, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEM_DB_BIN: dbBin, CODEM_LLM_BASE_URL: provider.url, CODEM_LLM_MODEL: "m" },
  });
  const summary = { spike: "guidance", checks: {} };
  try {
    const ready = await new Promise((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error(`Host 未 READY：${buf}`)), 15000);
      child.stdout.on("data", (c) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
        if (line) {
          clearTimeout(t);
          res(JSON.parse(line));
        }
      });
    });
    const rpc = async (method, params) =>
      (
        await fetch(`${ready.url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();

    const session = (await rpc("session.create", { title: "steer" })).result?.session?.id;
    const sent = await rpc("prompt.send", { sessionId: session, text: "开始", requestId: "s1" });
    const runId = sent.result?.runId;
    await sleep(600);
    const guided = await rpc("run.guidance", { runId, text: "STEER_MARKER 请优先做这件事" });
    summary.checks.STEER1_accepted = guided.result?.accepted === true;

    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const d = await rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.runId === runId);
      if (run && run.state !== "running") break;
    }
    const saw = provider.requests.some((msgs) => msgs.some((m) => String(m?.content ?? "").includes("STEER_MARKER")));
    summary.checks.STEER2_injected = saw;

    const late = await rpc("run.guidance", { runId, text: "太晚了" });
    summary.checks.STEER3_afterFinishConflict = late.error?.data?.kind === "CONFLICT";
  } finally {
    child.kill("SIGTERM");
    await provider.close();
  }
  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[steer] ${e?.stack ?? e}\n`);
  process.exit(1);
});
