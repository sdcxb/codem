#!/usr/bin/env node
/**
 * Phase 1 C「桌面 Host 共用当前工作区」端到端判据（WS-S1..S7）。
 *
 * 与单测的分工：
 * - `host-shared-workspace.test.ts` 守纯函数（list/read、配置、换工作区不换数据根）；
 * - 这个脚本**真的拉起 Host**，用同一份 data-home 换 workspace 重启，证明：
 *
 * | 判据 | 钉什么 |
 * |---|---|
 * | WS-S1 | `--workspace <桌面项目>` ⇒ `workspace.list` 列出该项目文件（不是默认空目录） |
 * | WS-S2 | `--workspace-shared` ⇒ `host.diagnostics.workspaceSharedWithDesktop === true` |
 * | WS-S2b | 桌面侧往项目里写文件 ⇒ 下一次 `workspace.list` 立刻看到（手机看到的是磁盘真相，不是快照） |
 * | WS-S3 | 重启前的会话能创建成功（为 WS-S6 提供证据） |
 * | WS-S4 | 同 data-home 重启到另一个项目 ⇒ `hostId` 不变（手机端看到的还是同一台机器） |
 * | WS-S5 | 重启后 `workspace.list` 变成新项目 |
 * | WS-S6 | 重启后 `session.list` 仍含重启前创建的会话（库在 data-home 下，没被换掉） |
 * | WS-S7 | 重启复用同一端口（手机端 URL 不失效） |
 *
 * 依赖已构建的产物：`packages/host/dist/host.mjs`（`npm run host:build`）与
 * `codem-db-cli`（`npm run db:build`；也可用 `CODEM_DB_BIN` 指定）。与 `spike-workspace.mjs`
 * 同一口径：**不 mock Host**，只 mock 桌面侧（这里由脚本自己扮演桌面）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const webDir = join(repoRoot, "packages", "host", "web");
const dbBin =
  process.env.CODEM_DB_BIN ??
  [
    join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe"),
    join(repoRoot, "src-tauri", "codem-db", "target", "debug", "codem-db-cli.exe"),
  ].find((p) => existsSync(p));

function startHost(workspace, dataHome, port) {
  const child = spawn(
    process.execPath,
    [
      hostEntry,
      "serve",
      "--data-home",
      dataHome,
      "--workspace",
      workspace,
      "--workspace-shared",
      "--web",
      webDir,
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEM_DB_BIN: dbBin } },
  );
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Host 未 READY：${stderr}`)), 25_000);
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolve({ child, ready: JSON.parse(line) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Host 退出（code=${code}）：${stderr}`));
    });
  });
}

async function rpc(url, method, params = {}) {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function stopHost(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 3_000);
  });
}

async function main() {
  if (!existsSync(hostEntry)) throw new Error(`缺少 ${hostEntry}：先跑 npm run host:build`);
  if (!dbBin) throw new Error("找不到 codem-db-cli：先跑 npm run db:build 或设置 CODEM_DB_BIN");

  const work = mkdtempSync(join(tmpdir(), "codem-ws-shared-"));
  const dataHome = join(work, "data");
  const projectP = join(work, "project-p");
  const projectQ = join(work, "project-q");
  mkdirSync(join(projectP, "src"), { recursive: true });
  mkdirSync(projectQ, { recursive: true });
  writeFileSync(join(projectP, "README.md"), "# P\n", "utf8");
  writeFileSync(join(projectP, "src", "p.ts"), "export const p = 1;\n", "utf8");
  writeFileSync(join(projectQ, "ONLY_Q.txt"), "Q\n", "utf8");

  const summary = { spike: "workspace-shared", checks: {} };
  let sessionId = "";
  try {
    const first = await startHost(projectP, dataHome, 0);
    const firstPort = first.ready.port;
    const hostId = first.ready.hostId;
    try {
      const listing = await rpc(first.ready.url, "workspace.list", {});
      const names = (listing.result?.entries ?? []).map((e) => `${e.type}:${e.name}`);
      summary.checks.WS_S1_list_project = names.includes("file:README.md") && names.includes("dir:src");

      const diag = await rpc(first.ready.url, "host.diagnostics", {});
      summary.checks.WS_S2_shared_flag =
        diag.result?.workspaceSharedWithDesktop === true && diag.result?.workspaceRoot === projectP;

      // 桌面侧（脚本扮演）写一个文件：手机下一次 list 必须立刻看到（读的是磁盘，不是快照）
      writeFileSync(join(projectP, "desktop-new.txt"), "written by desktop\n", "utf8");
      const after = await rpc(first.ready.url, "workspace.list", {});
      summary.checks.WS_S2b_desktop_write_visible = (after.result?.entries ?? []).some(
        (e) => e.name === "desktop-new.txt",
      );

      const created = await rpc(first.ready.url, "session.create", { title: "survive-restart" });
      sessionId = created.result?.session?.id ?? "";
      summary.checks.WS_S3_session_created = sessionId.length > 0;
    } finally {
      await stopHost(first.child);
    }

    // 无延迟重启（与 Rust 的 kill + wait 后立即 spawn 同一形态）
    const second = await startHost(projectQ, dataHome, firstPort);
    try {
      const listing = await rpc(second.ready.url, "workspace.list", {});
      const names = (listing.result?.entries ?? []).map((e) => e.name);
      const sessions = await rpc(second.ready.url, "session.list", { limit: 50 });
      const ids = (sessions.result?.items ?? []).map((s) => s.id);
      summary.checks.WS_S4_host_id_stable = second.ready.hostId === hostId;
      summary.checks.WS_S5_workspace_switched = names.includes("ONLY_Q.txt") && !names.includes("README.md");
      summary.checks.WS_S6_session_preserved = ids.includes(sessionId);
      summary.checks.WS_S7_port_reused = second.ready.port === firstPort;
    } finally {
      await stopHost(second.child);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

process.on("uncaughtException", (e) => {
  process.stderr.write(`[workspace-shared] ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});

await main();
