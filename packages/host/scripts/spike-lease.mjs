#!/usr/bin/env node
/**
 * 租约的**线上契约**判据（LSE-1..4，D-5）：
 * 1. 第一个 hello 获得租约；
 * 2. 第二个 hello 拿不到（`leaseGranted=false`，holder 仍是前者）；
 * 3. takeover 必须二次确认（第一次 needsConfirmation，第二次才 granted 并返回前任）；
 * 4. 接管后：旧 clientId 发 prompt 被 LEASE_HELD 拒绝，新 clientId 可以。
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

async function rpc(baseUrl, method, params) {
  const res = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-lease-"));
  const dataHome = join(work, "data");
  mkdirSync(dataHome, { recursive: true });
  const mock = await startMockProvider({ toolPath: "index.html" });
  const child = spawn(process.execPath, [hostEntry, "serve", "--data-home", dataHome, "--workspace", dataHome, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEM_DB_BIN: dbBin, CODEM_LLM_BASE_URL: mock.url, CODEM_LLM_MODEL: "mock-model" },
  });
  const summary = { spike: "lease", checks: {} };
  try {
    const ready = await new Promise((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error(`Host 未 READY：${buf}`)), 15000);
      child.stdout.on("data", (c) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
        if (!line) return;
        clearTimeout(t);
        res(JSON.parse(line));
      });
    });

    const hello = (name) =>
      rpc(ready.url, "host.hello", { protocolVersion: 1, client: { name, version: "0", platform: "web" }, deviceName: name, claim: true });

    const a = await hello("phone-A");
    summary.checks.LSE1_firstGranted = a.result?.leaseGranted === true && a.result?.lease?.clientId === "phone-A";

    const b = await hello("desktop-B");
    summary.checks.LSE2_secondDenied = b.result?.leaseGranted === false && b.result?.lease?.clientId === "phone-A";

    const first = await rpc(ready.url, "host.lease.takeover", { clientId: "desktop-B", deviceName: "desktop-B" });
    summary.checks.LSE3_confirmRequired =
      first.result?.granted === false && first.result?.needsConfirmation === true && first.result?.previousHolder === "phone-A";

    const second = await rpc(ready.url, "host.lease.takeover", { clientId: "desktop-B", deviceName: "desktop-B", confirm: true });
    summary.checks.LSE3b_takeoverGranted = second.result?.granted === true && second.result?.previousHolder === "phone-A";

    const created = await rpc(ready.url, "session.create", { title: "lease" });
    const sessionId = created.result?.session?.id;
    const stale = await rpc(ready.url, "prompt.send", { sessionId, text: "hi", requestId: "lse-1", clientId: "phone-A" });
    summary.checks.LSE4_staleRejected = stale.error?.data?.kind === "LEASE_HELD";

    const fresh = await rpc(ready.url, "prompt.send", { sessionId, text: "hi", requestId: "lse-2", clientId: "desktop-B" });
    summary.checks.LSE4b_holderAccepted = fresh.result?.accepted === true;
  } finally {
    child.kill("SIGTERM");
    await mock.close();
  }
  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[lease] ${e?.stack ?? e}\n`);
  process.exit(1);
});
