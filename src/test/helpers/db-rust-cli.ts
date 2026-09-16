/**
 * 契约测试驱动：通过 CLI 驱动**真实的 Rust 存储实现**。
 *
 * ## 为什么这么做（而不是 mock 一个 TS 版 Rust 客户端）
 *
 * 迁移最大的风险是**双实现漂移**：测试跑 WASM 实现、生产跑 Rust 实现，两边语义悄悄分叉
 * （默认值不同、错误码不同、分页边界差一行）。vitest 跑在 Node 里，**无法调用 Tauri IPC**，
 * 所以唯一能"测试的就是生产的"办法，是让生产实现本身可被进程调用 —— 这正是 codem-db-cli 的作用。
 *
 * 于是三层共用**同一份 Rust 代码**：
 * - 生产：Tauri 命令 → `codem_db::dispatch`
 * - 契约测试：CLI → `codem_db::dispatch`
 * - Rust 单元测试：直接调 `codem_db::dispatch`
 *
 * ## 前提
 *
 * 需要先构建 CLI：`npm run db:build`（`npm run test:db` 已包含）。
 * 二进制不存在时**直接失败并给出构建命令**，不静默跳过 —— 跳过等于让契约测试形同虚设。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXE = process.platform === "win32" ? "codem-db-cli.exe" : "codem-db-cli";

export const CLI_PATH = path.join(ROOT, "src-tauri", "codem-db", "target", "debug", EXE);

/** 结构化错误形状（与 Rust `DbError` / 渲染侧 `StorageErrorCode` 对应） */
export interface CliError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CliResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: CliError;
  /** 进程退出码（0=成功、1=错误） */
  status: number;
}

export function assertCliBuilt(): void {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `Rust 存储引擎 CLI 未构建：${CLI_PATH}\n` +
        `请先运行：npm run db:build（等价于 cargo build --manifest-path src-tauri/codem-db/Cargo.toml）`,
    );
  }
}

/** 一个临时库（每个测试独立，避免相互污染） */
export class TempDb {
  readonly dir: string;
  readonly path: string;
  private static readonly live = new Set<TempDb>();

  constructor(tag = "contract") {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `codem-db-${tag}-`));
    this.path = path.join(this.dir, "codem-db.bin");
    TempDb.live.add(this);
  }

  /** 调用 CLI：`invoke <command> -`，参数经 stdin 传（绕开各 shell 的引号转义差异） */
  invoke<T = unknown>(command: string, params: Record<string, unknown> = {}): CliResult<T> {
    assertCliBuilt();
    const res = spawnSync(CLI_PATH, ["--db", this.path, "invoke", command, "-"], {
      input: JSON.stringify(params),
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    const out = (res.stdout ?? "").trim();
    if (!out) {
      throw new Error(`CLI 无输出（status=${res.status}）：${res.stderr}`);
    }
    const parsed = JSON.parse(out) as CliResult<T>;
    // 契约：每条响应都必须自描述（`ok` 一定有值），且 `ok` 与退出码必须一致。
    // 这两条曾经都被违反过（成功响应漏了 ok），所以在这里硬性守住。
    if (typeof parsed.ok !== "boolean") {
      throw new Error(`CLI 响应缺少自描述的 ok 字段：${out}`);
    }
    if (parsed.ok && res.status !== 0) {
      throw new Error(`CLI 报成功但退出码为 ${res.status}：${out}`);
    }
    if (!parsed.ok && res.status === 0) {
      throw new Error(`CLI 报错误但退出码为 0：${out}`);
    }
    return parsed;
  }

  /** 调用并断言成功，直接返回结果 */
  must<T = unknown>(command: string, params: Record<string, unknown> = {}): T {
    const r = this.invoke<T>(command, params);
    if (!r.ok) {
      throw new Error(`${command} 失败：${r.error?.code} ${r.error?.message}`);
    }
    return r.result as T;
  }

  /** 调用并断言失败，返回结构化错误（用于验证错误码契约） */
  mustFail(command: string, params: Record<string, unknown> = {}): CliError {
    const r = this.invoke(command, params);
    if (r.ok) {
      throw new Error(`${command} 本应失败却成功了：${JSON.stringify(r.result)}`);
    }
    return r.error as CliError;
  }

  /**
   * 非 invoke 子命令（health / integrity / counts / commands / checkpoint / init）。
   *
   * 返回形状刻意区分：`result` = 解析后的 JSON 主体，`stdout` = 原始文本。
   * （早先版本把主体摊平到顶层、又把原始文本也叫 `raw`，导致调用方写出
   *  `raw(["init"]).raw.ok` 这种既冗长又容易错的表达式 —— 契约测试当场抓到。）
   */
  raw(args: string[]): { result: any; stdout: string; status: number } {
    assertCliBuilt();
    const res = spawnSync(CLI_PATH, ["--db", this.path, ...args], { encoding: "utf8" });
    const stdout = (res.stdout ?? "").trim();
    if (!stdout) {
      throw new Error(`CLI 无输出（${args.join(" ")}，status=${res.status}）：${res.stderr}`);
    }
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.ok !== "boolean") {
      throw new Error(`CLI 响应缺少自描述的 ok 字段：${stdout}`);
    }
    return { result: parsed, stdout, status: res.status ?? -1 };
  }

  /** 关闭：删除临时目录（WAL/SHM 一并清掉） */
  dispose(): void {
    TempDb.live.delete(this);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// 兜底清理：测试失败/超时会让 `afterAll` 里的 dispose 不执行，
// 于是真实库副本（11 MB 起）会一直留在 %TEMP% 里堆积 —— 这里在进程退出前兜住。
// 注意：`force: true` 已经能容忍文件已被删除；这里只处理"目录还在"的情况。
process.on("exit", () => {
  for (const db of TempDb.live) {
    try {
      fs.rmSync(db.dir, { recursive: true, force: true });
    } catch {
      /* 退出阶段尽力而为：清不掉也不该阻止进程退出 */
    }
  }
});

/** 便捷：建库 + 建会话，供"消息类"测试复用 */
export function seededSession(db: TempDb, sessionId = "s1"): string {
  db.must("projects.upsert", { id: "p1", name: "项目" });
  db.must("sessions.upsert", { id: sessionId, project_id: "p1", title: "契约会话" });
  return sessionId;
}
