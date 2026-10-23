#!/usr/bin/env node
/**
 * 清理崩溃/强杀后残留的 Vite dev server（端口 1420）。
 *
 * 只在一个条件成立时动手：**当前没有 codem.exe**（应用没在跑，dev server 一定是孤儿）。
 * 默认只打印计划，`--apply` 才 taskkill 进程树。
 */
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const WIN = "C:/Windows/System32";

function run(cmd, args) {
  try {
    return execFileSync(`${WIN}/${cmd}`, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

const codem = run("tasklist.exe", ["/FI", "IMAGENAME eq codem.exe", "/FO", "CSV", "/NH"]);
if (/codem\.exe/i.test(codem)) {
  console.log("codem.exe 正在运行，跳过（不杀活跃 dev server）。");
  process.exit(0);
}

const netstat = run("netstat.exe", ["-ano"]);
const line = netstat.split(/\r?\n/).find((l) => /:1420\s+.*LISTENING/i.test(l));
if (!line) {
  console.log("没有发现监听 1420 的残留 dev server。");
  process.exit(0);
}
const pid = line.trim().split(/\s+/).pop();
console.log(`${APPLY ? "KILL" : "PLAN"} 端口 1420 残留 dev server pid=${pid}`);
if (APPLY) {
  try {
    execFileSync(`${WIN}/taskkill.exe`, ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
    console.log(`已清理 pid=${pid} 的进程树。`);
  } catch (e) {
    console.error(`清理失败：${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  console.log("加 --apply 执行清理。");
}
