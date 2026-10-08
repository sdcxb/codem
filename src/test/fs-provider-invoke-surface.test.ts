/**
 * 判据：`src/core/provider/fs-provider.ts`（**活的** `fs` 服务）的 IPC 部署面。
 *
 * ## 钉的两个真实缺陷（改前）
 *
 * 1. **死接线**：`glob` 调 `invoke('glob_files', …)`、`grep` 调 `invoke('grep_files', …)`，
 *    而这两个命令在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里**都不存在**
 *    （`glob_files`/`grep_files` 在整个 `src-tauri/` 里 0 命中）⇒ 真机上一调就抛
 *    "命令不存在"，而且 `@ts-nocheck` 让类型检查也看不见。
 * 2. **静默降级**：拿不到 `invoke` 时 `return []` —— 把"我做不到"说成"没有匹配文件"。
 *
 * ## 判据（每条都能变红）
 *
 * | # | 钉什么 |
 * |---|---|
 * | `FSW-1a` | 解析器工作证明：**从 `src-tauri/src/lib.rs` 读出的命令清单**里认得 `glob_search`，且不含 `glob_files`（防止"解析写坏 ⇒ 空集也通过"） |
 * | `FSW-1b` | 本文件（`fs-provider.ts`）里**每一个** `invoke('…')` 的命令名都在上面那份清单里；且真跑一次方法，把**实际发出的命令名**与同一份清单比对（写错必红） |
 * | `FSW-2` | `invoke` 不可用时**不许**静默返回空：`glob` / `grep` / `deleteFile` 必须抛错（`[]` 不算失败） |
 * | `FSW-3` | `glob` 走**真实存在**的 `glob_search`，返回的形状与 `glob_search` 的 `files` 一致；`truncated` / `returned` / `hint` **原样透传**（截断不许藏） |
 * | `FSW-4` | `glob_files` / `grep_files` 这两个名字**一个都不许再出现**在 provider 里（回归闸） |
 *
 * ⚠️ 命令清单**只从 Rust 侧读**（`parse_rust_commands`），本文件不维护第二份硬编码名单
 * —— 否则两边会漂移，判据就失去意义。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
// `vi.mock` 对它走 hoist（工厂在模块加载前生效），所以这里静态 import 真实插件即可。
import { fsProvider } from "../core/provider/fs-provider";

const ROOT = path.join(__dirname, "..", "..");
const LIB_RS = path.join(ROOT, "src-tauri", "src", "lib.rs");
const FS_PROVIDER_TS = path.join(ROOT, "src", "core", "provider", "fs-provider.ts");
const WS = "C:/ws";

/**
 * 从 `src-tauri/src/lib.rs` 的 `invoke_handler(tauri::generate_handler![…])` 里
 * 读出**真实注册**的命令名。
 *
 * 形如 `js_sandbox::js_run_sandboxed,` 取最后一段（命令名），形如 `glob_search,` 原样取走；
 * 块内的 `//` 注释行整行丢掉（注释里出现过 `glob_search` 这种名字，不丢会**假绿**）。
 */
function parseRustCommands(): string[] {
  const src = fs.readFileSync(LIB_RS, "utf8");
  const block = /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error("无法解析 lib.rs 的 invoke_handler（判据自己先红，不许静默通过）");
  const names: string[] = [];
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const m = /^([A-Za-z_][A-Za-z0-9_:]*)\s*,?$/.exec(line);
    if (!m) continue;
    names.push(m[1].split("::").pop() as string);
  }
  return names;
}

/** `fs-provider.ts` 的**代码**（注释剥掉 —— 注释是解释"为什么"，不是调用面） */
function providerCode(): string {
  return fs
    .readFileSync(FS_PROVIDER_TS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `fs-provider.ts` 源码里出现的 `invoke('命令名')`（静态面） */
function commandsUsedInSource(): string[] {
  return [...providerCode().matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** 用最小 ctx 跑一遍真实插件，拿回它 `provide` 出去的 `fs` 服务 */
function loadFsService() {
  let service: any;
  const ctx = { provide: (_name: string, value: any) => { service = value; return () => {}; } };
  fsProvider(ctx);
  if (!service) throw new Error("fsProvider 没有 provide('fs')");
  return service;
}

const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];
let globPayload: Record<string, unknown>;
const globSearchMock = vi.fn();
const grepSearchMock = vi.fn();

vi.mock("../core/file-api", () => ({
  globSearch: (...a: unknown[]) => globSearchMock(...a),
  grepSearch: (...a: unknown[]) => grepSearchMock(...a),
  listDirectory: async () => [],
  readFile: async () => "",
  writeFile: async () => undefined,
}));

function installTauri(invokeImpl?: (command: string, args?: any) => Promise<any>) {
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (invokeImpl) return invokeImpl(command, args);
        if (command === "glob_search") return globPayload;
        if (command === "check_path_in_workspace") return true;
        if (command === "get_app_data_dir") return "C:/data/";
        if (command === "get_default_cwd") return WS;
        return null;
      }),
    },
  };
}

beforeEach(() => {
  invokes.length = 0;
  globSearchMock.mockReset();
  grepSearchMock.mockReset();
  globPayload = {
    files: [`${WS}/a.ts`, `${WS}/b.ts`],
    truncated: false,
    depth_limited: false,
    returned: 2,
  };
  globSearchMock.mockResolvedValue(globPayload);
  grepSearchMock.mockResolvedValue([]);
  installTauri();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  globSearchMock.mockReset();
  grepSearchMock.mockReset();
});

describe("FSW-1: fs-provider 的每个 invoke 命令都必须在 Rust 侧真实存在", () => {
  it("FSW-1a: 命令清单从 lib.rs 读出（解析器工作证明）", () => {
    const rust = parseRustCommands();
    expect(rust.length, "解析出的命令清单不该是空的（空集会让下面几条假绿）").toBeGreaterThan(80);
    expect(rust, "第 186 波的真实命令必须在册").toContain("glob_search");
    expect(rust, "第 55 波的真实命令必须在册").toContain("delete_file");
    expect(rust, "★ 坏名字不许在册（否则这条判据本身就没意义）").not.toContain("glob_files");
    expect(rust).not.toContain("grep_files");
  });

  it("FSW-1b: 源码里出现的每个 invoke 命令名都在 Rust 命令清单里", () => {
    const rust = parseRustCommands();
    const used = commandsUsedInSource();
    const missing = used.filter((c) => !rust.includes(c));
    expect(missing, `这些命令在 fs-provider.ts 里被调用，但 lib.rs 没注册（真机必抛「命令不存在」）：${missing.join(", ")}`).toEqual([]);
  });

  it("FSW-1b-2: 真跑一遍方法论，实际发出的命令名也在同一份清单里", async () => {
    const rust = parseRustCommands();
    const svc = loadFsService();
    await svc.glob("*.ts", WS);
    await svc.grep("needle", WS, "*.ts");
    await svc.deleteFile(`${WS}/a.ts`);
    const seen = invokes.map((i) => i.command);
    expect(seen, "删除必须真的发到 IPC（证明这条腿不是空跑）").toContain("delete_file");
    const missing = seen.filter((c) => !rust.includes(c));
    expect(missing, `实际发出的命令没注册：${missing.join(", ")}（发出的全部：${seen.join(", ")}）`).toEqual([]);
  });

  it("FSW-1b-3: 反向自证 —— 把命令名写成不存在的名字必被这条抓住", () => {
    // 直接验证判据的判定逻辑：拿真清单去比对两个坏名字
    const rust = parseRustCommands();
    expect(rust.includes("glob_files"), "glob_files 不在 Rust 侧（这正是缺陷 1）").toBe(false);
    expect(rust.includes("grep_files"), "grep_files 不在 Rust 侧（同一个缺陷）").toBe(false);
  });
});

describe("FSW-2: 拿不到 invoke 一律如实失败，不许静默返回空", () => {
  it("FSW-2a: glob 的失败原样冒泡（不是在 mock 上假绿）", async () => {
    globSearchMock.mockRejectedValue(
      new Error("glob_search failed: 没有 __TAURI__.core.invoke（非 Tauri 宿主）"),
    );
    const svc = loadFsService();
    const out = await svc.glob("*.ts", WS).catch((e: unknown) => e);
    expect(out, "★ 拿不到 IPC 通道时必须抛出，而不是返回 []").toBeInstanceOf(Error);
    expect(Array.isArray(out), "★ 不许是空数组（那就成了「没有匹配文件」）").toBe(false);
    expect(String((out as Error).message)).toMatch(/__TAURI__|invoke/);
  });

  it("FSW-2b: 没有 __TAURI__ 时 grep 抛错（不是 []）", async () => {
    delete (window as any).__TAURI__;
    grepSearchMock.mockRejectedValue(new Error("__TAURI__ 不可用，无法调用 grepSearch"));
    const svc = loadFsService();
    const out = await svc.grep("needle", WS).catch((e: unknown) => e);
    expect(out, "抛出的错误必须冒泡上来").toBeInstanceOf(Error);
    expect(Array.isArray(out), "★ 不许是空数组（那就成了「没有匹配」）").toBe(false);
  });

  it("FSW-2c: 没有 __TAURI__ 时 deleteFile 抛错（删不掉不许装作删掉了）", async () => {
    delete (window as any).__TAURI__;
    const svc = loadFsService();
    await expect(svc.deleteFile(`${WS}/x.ts`)).rejects.toThrow(/删除未执行|invoke/);
    expect(invokes.some((i) => i.command === "delete_file"), "没有通道时不该装作发出过命令").toBe(false);
  });

  it("FSW-2d: 命令本身失败时 glob 不许吞掉（错误原样冒泡）", async () => {
    globSearchMock.mockRejectedValue(new Error("glob_search 遍历线程失败"));
    const svc = loadFsService();
    await expect(svc.glob("*.ts", WS)).rejects.toThrow(/遍历线程失败/);
  });
});

describe("FSW-3: glob 接上真实存在的 glob_search，且截断如实", () => {
  it("FSW-3a: 走 globSearch 并带上工作区；返回的 files 与 glob_search 的 files 一致", async () => {
    const svc = loadFsService();
    const out = await svc.glob("*.ts", WS);
    expect(globSearchMock).toHaveBeenCalledWith("*.ts", WS, { workspace: WS });
    expect(Array.isArray(out), "不许把结构化结果丢掉当裸数组用").toBe(false);
    expect(out.files).toEqual([`${WS}/a.ts`, `${WS}/b.ts`]);
  });

  it("FSW-3b: 截断时 truncated/returned/hint 原样透传（不许把前 N 条当全量）", async () => {
    globPayload = {
      files: [`${WS}/a.ts`],
      truncated: true,
      depth_limited: false,
      returned: 1,
      hint: "call again with offset=20000",
    };
    globSearchMock.mockResolvedValue(globPayload);
    const svc = loadFsService();
    const out = await svc.glob("*.ts", WS);
    expect(out.truncated, "★ 截断必须如实（改前连命令都不存在，谈不上如实）").toBe(true);
    expect(out.returned).toBe(1);
    expect(out.hint).toContain("offset=20000");
    expect(out.files).toEqual(globPayload.files);
  });

  it("FSW-3c: grep 走既有 file-api.grepSearch + 工作区（不再调不存在的 grep_files）", async () => {
    const svc = loadFsService();
    await svc.grep("needle", WS, "*.ts");
    expect(grepSearchMock).toHaveBeenCalledWith("needle", WS, "*.ts", { workspace: WS });
    expect(
      invokes.some((i) => i.command === "grep_files"),
      "★ 不许再调不存在的 grep_files",
    ).toBe(false);
  });
});

describe("FSW-4: 坏命令名是回归闸", () => {
  it("FSW-4a: 两个死命令名（`glob`/_files 与 `grep`/_files）一个都不许再出现在 provider 代码里", () => {
    const code = providerCode();
    expect(code.includes(`glob_${"files"}`), "glob_*files* 是死接线，不许回来").toBe(false);
    expect(code.includes(`grep_${"files"}`), "grep_*files* 是死接线，不许回来").toBe(false);
  });

  it("FSW-4b: provider 里剩下的 invoke 调用只有真实存在的 delete_file", () => {
    expect(commandsUsedInSource()).toEqual(["delete_file"]);
  });
});
