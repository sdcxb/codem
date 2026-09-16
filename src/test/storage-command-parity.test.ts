/**
 * 存储命令的**部署面**一致性门禁（第 92 波）。
 *
 * ## 为什么需要这条门禁（踩了两次的真实教训）
 *
 * `codem-db` crate 里的命令要真正可用，必须**同时**满足三件事：
 * 1. 在 `codem-db/src/lib.rs` 的 `COMMANDS` 里登记；
 * 2. 在 `lib.rs` 的 `dispatch` 里有分支；
 * 3. 被 `src-tauri/src/lib.rs` 的 `invoke_handler!` 注册（经 `storage_invoke` 转发）。
 *
 * 第 3 条最容易漏 —— 它**不会让任何测试变红**：
 * - Rust 单测直接调 `dispatch`，看不见 Tauri 注册；
 * - TS 契约测试用**假 transport**，也看不见 Tauri 注册；
 * - 只有真机（打包/调试二进制）才会报"未实现的仓储命令"。
 *
 * 实测连续两轮踩同一个坑（新增 `config_warmup`、`events.list` 后只重建了 crate，
 * 没重建 Tauri 二进制；真机全部命令报"未实现"）。所以把它变成机器检查：
 * **凡是 crate 里登记的命令，Tauri 侧必须注册，且必须经 `storage_invoke` 转发。**
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const LIB_RS = path.join(ROOT, "src-tauri", "codem-db", "src", "lib.rs");
const TAURI_LIB_RS = path.join(ROOT, "src-tauri", "src", "lib.rs");
const STORAGE_RS = path.join(ROOT, "src-tauri", "src", "storage.rs");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** crate 里声明的命令（COMMANDS 常量 + dispatch 分支） */
function crateCommands() {
  const src = read(LIB_RS);
  const block = /pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error("无法解析 COMMANDS");
  const declared = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const dispatched = [...src.matchAll(/^\s*"([a-z_][a-z0-9_.]*)"\s*=>/gm)].map((m) => m[1]);
  return { declared, dispatched };
}

/** Tauri 侧注册的 storage 命令 */
function tauriCommands() {
  const src = read(TAURI_LIB_RS);
  const block = /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error("无法解析 invoke_handler");
  return [...block[1].matchAll(/storage::(\w+)/g)].map((m) => m[1]);
}

describe("存储命令部署面一致性", () => {
  it("DEPLOY-1: 凡是 COMMANDS 里声明的命令，dispatch 都必须有分支", () => {
    const { declared, dispatched } = crateCommands();
    const missing = declared.filter((c) => !dispatched.includes(c));
    expect(missing, `这些命令声明了但没有 dispatch 分支（调用会得到 UNSUPPORTED）：${missing.join(", ")}`).toEqual([]);
  });

  it("DEPLOY-2: 凡是 dispatch 的分支，都必须在 COMMANDS 里声明", () => {
    const { declared, dispatched } = crateCommands();
    // dispatch 里还有 "health"/"integrity_check" 这类；以 COMMANDS 为准做双向核对
    const extra = dispatched.filter((c) => !declared.includes(c));
    expect(
      extra,
      `这些命令有 dispatch 分支但没进 COMMANDS（capabilities 自省会漏报，契约测试也无法覆盖）：${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("DEPLOY-3: Tauri 侧必须注册存储命令，且经 storage_invoke 转发", () => {
    const storage = read(STORAGE_RS);
    expect(storage, "storage.rs 必须定义 storage_invoke").toContain("pub fn storage_invoke");
    // 仓储命令**只能**经 storage_invoke / storage_batch 进入，不允许逐命令注册
    // （逐个注册会让"新增命令忘记注册"变成静默失败，正是踩过两次的坑）
    expect(storage, "仓储命令必须经 dispatch 转发").toContain("dispatch(engine");
  });

  it("DEPLOY-4: Tauri 的 invoke_handler 里必须能看到全部 storage_* 命令", () => {
    const registered = tauriCommands();
    for (const required of [
      "storage_invoke",
      "storage_batch",
      "storage_health",
      "storage_integrity_check",
      "storage_checkpoint",
      "storage_capabilities",
      "storage_info",
    ]) {
      expect(registered, `invoke_handler 缺少 ${required}（真机会报「命令未注册」）`).toContain(required);
    }
  });

  it("DEPLOY-5: 命令清单规模合理（防止解析写坏导致「空集也通过」）", () => {
    const { declared } = crateCommands();
    expect(declared.length).toBeGreaterThan(40);
    expect(declared).toContain("events.list");
    expect(declared).toContain("config_warmup");
    expect(declared).toContain("messages.list");
  });

  it("DEPLOY-6: 真机验证前必须重建二进制（把这条教训写成可执行检查）", () => {
    // 这条不检查"有没有重建"（那需要比较时间戳，环境相关），而是检查
    // `storage.rs` 的注释里保留了这条教训 —— 让后来者读到为什么真机会报"未实现"。
    const storage = read(STORAGE_RS);
    const hasNote =
      storage.includes("Tauri") && (storage.includes("未实现") || storage.includes("重建") || storage.includes("invoke_handler"));
    expect(
      hasNote,
      "storage.rs 应当保留「新增命令后必须重建 Tauri 二进制」的说明（踩过两次）",
    ).toBe(true);
  });
});
