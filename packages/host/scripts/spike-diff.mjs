#!/usr/bin/env node
/**
 * 只读 diff 判据（DIFF-1..2）：
 * 1. git 工作区里 `workspace.diff` 返回真实 diff（含 `-旧` / `+新`）；
 * 2. 非 git 工作区返回 `supported=false`（客户端应隐藏入口，而不是显示空 diff）。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const dbBin = process.env.CODEM_DB_BIN ?? join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");

async function startHost(ws) {
  const data = join(ws, "..", "data");
  mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, [hostEntry, "serve", "--data-home", data, "--workspace", ws, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEM_DB_BIN: dbBin },
  });
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
  return { child, ready };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-diff-"));
  const summary = { spike: "workspace-diff", checks: {} };

  // git 工作区
  const ws = join(work, "repo");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "README.md"), "# old\n", "utf8");
  const git = (...args) => execFileSync("git", ["-C", ws, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(ws, "README.md"), "# new\n", "utf8");

  let host = await startHost(ws);
  try {
    const rpc = async (method, params) =>
      (
        await fetch(`${host.ready.url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
    const got = await rpc("workspace.diff", { path: "README.md" });
    summary.checks.DIFF1_supported = got.result?.supported === true;
    summary.checks.DIFF2_content = String(got.result?.diff ?? "").includes("-# old") && String(got.result?.diff ?? "").includes("+# new");
    summary.diffPreview = String(got.result?.diff ?? "").split("\n").slice(0, 6);
  } finally {
    host.child.kill("SIGTERM");
  }

  // 非 git 工作区
  const plain = join(work, "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "a.txt"), "x\n", "utf8");
  host = await startHost(plain);
  try {
    const rpc = async (method, params) =>
      (
        await fetch(`${host.ready.url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
    const got = await rpc("workspace.diff", { path: "a.txt" });
    summary.checks.DIFF3_notGit = got.result?.supported === false;
  } finally {
    host.child.kill("SIGTERM");
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[diff] ${e?.stack ?? e}\n`);
  process.exit(1);
});
