/**
 * SEAM-DEL：`src/core/seam/local-fs-provider.ts` 的 **`deleteFile` 静默失败**。
 *
 * ## 缺陷形态（改前）
 *
 * ```ts
 * async deleteFile(path) {
 *   try { const { invoke } = (window as any).__TAURI__?.core || {}; if (invoke) await invoke("delete_file", { path }); }
 *   catch { /* ignore *\/ }        // 删不掉也不说
 * }
 * ```
 *
 * 三重问题：① **删不掉也不说** —— 调用方以为删了（本仓库最忌讳的静默失败）；
 * ② 自己拼了**第二个** `invoke("delete_file")`（命令名的第二份定义）；
 * ③ 拿不到 IPC 时**什么都不做**（`invoke` 为 undefined ⇒ 直接 return）。
 * 这与刚修完的兄弟 `src/core/provider/fs-provider.ts`（判据 `fs-provider-invoke-surface.test.ts`）
 * 是同一形态；`exists()` 的 `catch { return false }`（假否定）同属一族，一并收掉。
 *
 * ## 路线选择：**接上**（不是下线）
 *
 * 下线前提是"没有消费者 **且** 没有可用通道"。grep 证据（`git grep -n deleteFile -- src`）：
 *  · 消费者 **0 个** —— `tools.ts:174` 的 `readViaSeam` 只取 `readFile`，
 *    全仓 `getProvider("filesystem")`（`s0-seam-integration` / `s0-regression-full` 之外）
 *    没有任何 `.deleteFile(` 调用点；
 *  · 但通道**可用**：`file-api.deleteFile`（`file-api.ts:307`）就是同一个操作，
 *    且 `delete_file` 在 `src-tauri/src/lib.rs:4422` 的 `invoke_handler` 里真实注册。
 * ⇒ 接上既有通道既恢复了 `FileSystemSeam.deleteFile`（`types.ts:120`）承诺的能力，
 *   又让命令名只剩一处定义；比"抛未实现/删空壳"更好。
 *
 * ## 判据（每条都能变红）
 *
 * | # | 钉什么 |
 * |---|---|
 * | `SEAM-DEL-1a` | **没有 IPC 通道**时 `deleteFile` 必须**抛错**（改前同一断言下它静默 resolve） |
 * | `SEAM-DEL-1b` | 底层删除失败时错误**原样冒泡**（不许被吞成"删除成功"） |
 * | `SEAM-DEL-2` | **通道唯一**：provider 源码（剥注释）里 0 个 `invoke(` / `__TAURI__`（不许再自己拼命令名） |
 * | `SEAM-DEL-3` | 反向对照：通道可用时删除**真的发生**（IPC 收到 `delete_file` + `{ path }`），且该命令在 Rust 侧真实注册 |
 * | `SEAM-EXISTS-1` | `exists` 的假否定：父目录读不到 ⇒ **抛错**，不许吞成 `false`；反向对照：列得到时 true/false 正确 |
 *
 * ⚠️ 驱动的是**真实 provider + 真实 `file-api` + 真实 `tauriInvoke`**（只把最底层 IPC 换掉），
 * 所以"判据长在没人走的那条链路上"这种假绿在这里不成立。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { LocalFileSystemProvider } from "../core/seam/local-fs-provider";

const ROOT = path.join(__dirname, "..", "..");
const PROVIDER_TS = path.join(ROOT, "src", "core", "seam", "local-fs-provider.ts");
const LIB_RS = path.join(ROOT, "src-tauri", "src", "lib.rs");
const WS = "C:/ws";

/** provider 的**代码**（注释剥掉：注释是解释"为什么"，不是调用面） */
function providerCode(): string {
  return fs
    .readFileSync(PROVIDER_TS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
}

const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installTauriMock(
  impl?: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): void {
  invokes.length = 0;
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        return impl ? impl(command, args) : null;
      }),
    },
  };
}

beforeEach(() => {
  installTauriMock();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("SEAM-DEL-1: 删不掉不许静默成功", () => {
  it("SEAM-DEL-1a: 没有 IPC 通道 ⇒ 抛错（改前这里会静默 resolve）", async () => {
    delete (window as any).__TAURI__;
    const provider = new LocalFileSystemProvider();

    /**
     * ★ 反向对照写在这里：改前那句 `catch { }` 会把同一个调用**变成 resolve** ——
     * 所以 `rejects` 这一条就是"静默成功"的照妖镜（把 catch 放回去 ⇒ 本用例必红）。
     */
    await expect(
      provider.deleteFile(`${WS}/x.ts`),
      "★ 删不掉必须说出来，调用方不能以为删了",
    ).rejects.toThrow();
    expect(
      invokes.some((i) => i.command === "delete_file"),
      "没有通道时更不该装作发出过命令",
    ).toBe(false);
  });

  it("SEAM-DEL-1b: 底层删除失败（文件被占用）⇒ 错误原样冒泡", async () => {
    installTauriMock(async (command) => {
      if (command === "delete_file") throw new Error("拒绝访问：文件被占用 (os error 32)");
      return null;
    });
    const provider = new LocalFileSystemProvider();

    const out = await provider.deleteFile(`${WS}/x.ts`).catch((e: unknown) => e);
    expect(out, "★ 底层失败必须变成一次失败，而不是一次成功的假象").toBeInstanceOf(Error);
    expect(String((out as Error).message), "错误信息要保留底层事实，便于排查").toMatch(/文件被占用/);
    expect(
      invokes.some((i) => i.command === "delete_file"),
      "前置：确实走到了真实通道（否则这条只证明了「没调」）",
    ).toBe(true);
  });
});

describe("SEAM-DEL-2: 命令名的定义只剩一处（不许再自己拼 invoke）", () => {
  it("SEAM-DEL-2: provider 代码里没有 invoke( / __TAURI__（唯一通道是 file-api）", () => {
    const src = providerCode();
    expect(src, "★ 自己拼一个 invoke('delete_file') 就是第二份命令名定义").not.toMatch(/invoke\s*\(/);
    expect(src, "★ 也不许自己摸 __TAURI__（那是 file-api 的事）").not.toMatch(/__TAURI__/);
    expect(src, "删除要走既有通道 file-api.deleteFile").toMatch(/import\("\.\.\/file-api"\)/);
  });
});

describe("SEAM-DEL-3: 反向对照 —— 通道可用时删除真的发生", () => {
  it("SEAM-DEL-3: resolve 且 IPC 收到 delete_file + { path }（不是「一律抛错」）", async () => {
    const provider = new LocalFileSystemProvider();
    const target = `${WS}/x.ts`;

    await expect(provider.deleteFile(target)).resolves.toBeUndefined();

    const call = invokes.find((i) => i.command === "delete_file");
    expect(call, "★ 删除必须真的发到 IPC").toBeTruthy();
    expect(call!.args, "参数形状与 file-api 的既有调用一致").toEqual({ path: target });
  });

  it("SEAM-DEL-3b: 接上的命令在 Rust 侧真实注册（不是死接线）", () => {
    const rust = fs.readFileSync(LIB_RS, "utf8");
    const block = /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(rust);
    expect(block, "解析器工作证明：必须能读到 invoke_handler 块").toBeTruthy();
    const names = block![1]
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .map((l) => (l.split("::").pop() as string).replace(/,$/, ""));
    expect(names, "★ delete_file 必须在 Rust 的真实命令清单里").toContain("delete_file");
  });
});

describe("SEAM-EXISTS-1: 读不到 ≠ 不存在（同一形态的静默失败）", () => {
  it("SEAM-EXISTS-1a: 父目录读不到 ⇒ 抛错，不许吞成 false", async () => {
    installTauriMock(async (command) => {
      if (command === "list_directory") throw new Error("拒绝访问：无法枚举目录");
      return null;
    });
    const provider = new LocalFileSystemProvider();

    const out = await provider.exists(`${WS}/a.ts`).catch((e: unknown) => e);
    expect(out, "★ 「我读不了」不许被说成「它不存在」").toBeInstanceOf(Error);
    expect(out === false, "★ 更不许是 false").toBe(false);
  });

  it("SEAM-EXISTS-1b: 反向对照 —— 列得到时判定仍然正确", async () => {
    installTauriMock(async (command) => {
      if (command === "list_directory") {
        return [{ name: "a.ts", path: `${WS}/a.ts`, isDirectory: false }];
      }
      return null;
    });
    const provider = new LocalFileSystemProvider();

    await expect(provider.exists(`${WS}/a.ts`)).resolves.toBe(true);
    await expect(provider.exists(`${WS}/missing.ts`)).resolves.toBe(false);
  });
});
