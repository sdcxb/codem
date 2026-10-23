#!/usr/bin/env node
/**
 * 清理多轮测试遗留的无头 Edge。
 *
 * 只匹配测试专用标记（codem-site-e2e / codem-shot / remote-debugging-port=933x），
 * 不碰用户正常打开的 Edge。默认只打印计划，`--apply` 才杀进程树。
 *
 * 用法：node tools/maintenance/clean-orphan-test-browsers.mjs [--apply]
 */
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const PS = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function listProcesses() {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync(PS, ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (!out.trim()) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const MARKERS = ["codem-site-e2e-", "codem-shot-", "remote-debugging-port=933"];
const rows = listProcesses().filter((p) => MARKERS.some((m) => String(p.CommandLine || "").includes(m)));
if (rows.length === 0) {
  console.log("没有发现测试遗留的 Edge 进程。");
  process.exit(0);
}

for (const p of rows) {
  const cmd = String(p.CommandLine || "").replace(/\s+/g, " ").slice(0, 160);
  console.log(`${APPLY ? "KILL" : "PLAN"} pid=${p.ProcessId} parent=${p.ParentProcessId} ${cmd}`);
  if (APPLY) {
    try {
      execFileSync("taskkill", ["/PID", String(p.ProcessId), "/T", "/F"], { stdio: "ignore" });
    } catch (e) {
      console.error(`kill ${p.ProcessId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
console.log(APPLY ? `已清理 ${rows.length} 个进程。` : `共 ${rows.length} 个；加 --apply 执行清理。`);
