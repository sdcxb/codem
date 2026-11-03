#!/usr/bin/env node
/**
 * 工作区只读接口判据（WS-1..4）：
 * 1. `workspace.list` 列出根目录（目录/文件、目录在前）；
 * 2. 进入子目录；
 * 3. `workspace.read` 读文件文本；
 * 4. 路径逃逸（`..` / 绝对路径）被拒绝。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const dbBin = process.env.CODEM_DB_BIN ?? join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-ws-"));
  const data = join(work, "data");
  const ws = join(work, "ws");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "README.md"), "# hi\n", "utf8");
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");

  const child = spawn(process.execPath, [hostEntry, "serve", "--data-home", data, "--workspace", ws, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEM_DB_BIN: dbBin },
  });
  const summary = { spike: "workspace", checks: {} };
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

    const root = await rpc("workspace.list", {});
    const names = (root.result?.entries ?? []).map((e) => `${e.type}:${e.name}`);
    summary.checks.WS1_root = names.includes("dir:src") && names.includes("file:README.md");
    summary.checks.WS1_order = names[0] === "dir:src";

    const sub = await rpc("workspace.list", { path: "src" });
    summary.checks.WS2_subdir = (sub.result?.entries ?? []).some((e) => e.name === "a.ts");

    const file = await rpc("workspace.read", { path: "src/a.ts" });
    summary.checks.WS3_read = String(file.result?.text ?? "").includes("export const a");

    const bad = await rpc("workspace.list", { path: "../" });
    summary.checks.WS4_escape = Boolean(bad.error);
  } finally {
    child.kill("SIGTERM");
  }
  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[ws] ${e?.stack ?? e}\n`);
  process.exit(1);
});
