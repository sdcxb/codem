#!/usr/bin/env node
/**
 * **Spike B / 线协议 parity**：证明 `codem-db serve`（Host 走的路）与
 * `codem-db-cli invoke`（桌面 Tauri 命令层走的同一条 `dispatch`）**语义一致**。
 *
 * 判据：
 * - PB-1 每条命令的 `ok` 一致；
 * - PB-2 成功结果的 `result` **深度相等**（键序无关）；
 * - PB-3 失败的 `code` + `retryable` 一致（message 允许含路径差异，不比较）；
 * - PB-4 serve 是**单连接**：同一进程里先写后读能看见（CLI 每次新进程，靠库落盘也能看见，
 *        所以这一条只能由 serve 侧额外断言"没有重开"——见 SERVE-6）。
 *
 * 两边各用**同一份源库的两个副本**，命令序列完全一致，因此任何差异都只能来自传输层。
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function pickDbBin() {
  const release = join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
  const debug = join(repoRoot, "src-tauri", "codem-db", "target", "debug", "codem-db-cli.exe");
  const candidates = process.env.CODEM_DB_BIN ? [process.env.CODEM_DB_BIN] : [release, debug];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(`找不到 codem-db-cli：${candidates.join(" / ")}`);
}

function cliInvoke(dbBin, dbPath, command, params) {
  // 失败命令的退出码是 1：必须把 stdout 也读回来，否则 parity 看不到错误体（只能看到"命令失败"）
  try {
    const out = execFileSync(dbBin, ["--db", dbPath, "invoke", command, "-"], {
      input: JSON.stringify(params ?? {}),
      encoding: "utf8",
    });
    return JSON.parse(out.trim());
  } catch (e) {
    const out = String(e.stdout ?? "").trim();
    if (!out) throw e;
    return JSON.parse(out);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

class ServeProc {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const reply = JSON.parse(line);
        const waiter = this.pending.get(reply.id);
        if (waiter) {
          this.pending.delete(reply.id);
          waiter(reply);
        }
      }
    });
  }
  static async start(dbBin, dbPath) {
    const child = spawn(dbBin, ["--db", dbPath, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const proc = new ServeProc(child);
    // 等第一条 ping 通，确认 schema/迁移已完成（serve 在 main 里先开库再进循环）
    await proc.call({ op: "ping" });
    return proc;
  }
  call(payload) {
    const id = this.nextId++;
    return new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => rejectReply(new Error(`serve 超时：${JSON.stringify(payload).slice(0, 120)}`)), 30_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolveReply(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }
  invoke(command, params) {
    return this.call({ command, params });
  }
  async close() {
    try {
      await this.call({ op: "shutdown" });
    } catch {
      /* 已退出 */
    }
    this.child.kill();
  }
}

async function main() {
  const dbBin = pickDbBin();
  const work = await mkdtemp(join(tmpdir(), "codem-host-parity-"));
  const seed = join(work, "seed.bin");
  // 用一个全新库当种子：parity 要比较的是"两条通道对同一输入的响应"，不是用户数据
  cliInvoke(dbBin, seed, "health", {});
  const { copyFile: cp } = await import("node:fs/promises");
  const dbA = join(work, "cli.bin");
  const dbB = join(work, "serve.bin");
  await cp(seed, dbA);
  await cp(seed, dbB);

  const sequence = [
    ["sessions.upsert", { id: "parity-s1", project_id: "", title: "parity", created_at: 1_700_000_000_000 }],
    ["messages.create", { id: "parity-m1", session_id: "parity-s1", role: "user", content: "内容 🙂", timestamp: 1_700_000_000_001 }],
    ["messages.get", { id: "parity-m1" }],
    ["messages.list", { session_id: "parity-s1", limit: 10, include_hidden: true }],
    ["messages.count", { session_id: "parity-s1" }],
    ["counts", { tables: ["messages", "sessions"] }],
    ["settings.set", { key: "codem-parity", value: "1" }],
    ["settings.get_all", {}],
    // 失败面：缺参数 / 未知命令（两条通道必须给出同样的 code + retryable）
    ["messages.create", { id: "parity-bad" }],
    ["sql.raw", {}],
  ];

  const serve = await ServeProc.start(dbBin, dbB);
  const rows = [];
  let failures = 0;
  try {
    for (const [command, params] of sequence) {
      const viaCli = cliInvoke(dbBin, dbA, command, params);
      const viaServe = await serve.invoke(command, params);
      const cliOk = viaCli.ok === true;
      const serveOk = viaServe.ok === true;
      const sameOk = cliOk === serveOk;
      let sameBody;
      if (cliOk) {
        sameBody = JSON.stringify(stable(viaCli.result)) === JSON.stringify(stable(viaServe.result));
      } else {
        sameBody =
          viaCli.error?.code === viaServe.error?.code &&
          Boolean(viaCli.error?.retryable) === Boolean(viaServe.error?.retryable);
      }
      if (!sameOk || !sameBody) failures += 1;
      rows.push({
        command,
        ok: sameOk && sameBody ? "PASS" : "FAIL",
        cliOk,
        serveOk,
        detail: sameOk && sameBody ? "" : { cli: viaCli.error ?? viaCli.result, serve: viaServe.error ?? viaServe.result },
      });
    }
    // PB-4：serve 单连接里写的设置，必须同一进程读得到（CLI 每次新进程，天然看不到"未落盘"）
    const afterWrite = await serve.invoke("settings.get_all", {});
    const seesSetting = JSON.stringify(afterWrite.result ?? {}).includes("codem-parity");
    rows.push({ command: "serve 单连接可见性", ok: seesSetting ? "PASS" : "FAIL", detail: seesSetting ? "" : afterWrite });
    if (!seesSetting) failures += 1;
  } finally {
    await serve.close();
  }

  process.stdout.write(
    `${JSON.stringify({ spike: "B", dbBin, rows, failures, ok: failures === 0 }, null, 2)}\n`,
  );
  await rm(work, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

await main().catch((e) => {
  process.stderr.write(`[spike-b] 失败：${e?.stack ?? e}\n`);
  process.exit(1);
});
