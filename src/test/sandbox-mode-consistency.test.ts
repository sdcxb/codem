/**
 * ★ 误拒级缺陷判据：**沙箱「关了」必须真的关** —— 而且两个方向都要钉。
 *
 * ## 缺陷形态（用户点名的历史 bug 复发）
 *
 * 用户原话：「之前修复的时候，遇到过关了沙箱后沙箱还是生效，导致项目读写出问题的情况」。
 *
 * 事实：T2 那次「读侧沙箱」修复给 `run-code.ts` 的 `sdk.read/write/glob/grep`、
 * `lsp-tool.ts`、`task-keyword-search.ts`、`seam/local-fs-provider.ts` 全部**无条件**传了
 * `workspace: ctx.cwd`，而 `file-api.ts` 的 `assertWithinWorkspace` **不看开关**：
 * 「`workspace` 有值就判、越界就抛」。于是 **沙箱关闭（全访问）时，工作区外的读写照样被拒** ——
 * 这正是"关了沙箱沙箱还生效"。
 *
 * 同一时刻，`tools.ts:220` 的 `checkSandbox` 是**看开关**的
 * （`getSetting("codem-sandbox-enabled") !== "true"` ⇒ 放行）⇒ 「同一规则两份实现、两个结论」。
 *
 * ## 判据（⚠️ 同一组越界路径，两个方向结果必须**相反**）
 *
 * | id | 钉什么 |
 * |---|---|
 * | `SB-OFF-1` | 沙箱**关** ⇒ `sdk.read` / `sdk.write` / `sdk.glob` / `sdk.grep` 对**工作区外**路径**成功**（且底层 IPC 真的发出） |
 * | `SB-OFF-2` | 沙箱**关** ⇒ lsp 工具、seam 读路径、关键词搜索的读/搜形状（`readTextWindow` / `grepSearch`）对工作区外路径**成功** |
 * | `SB-ON-1` | 沙箱**开** ⇒ **同一批越界调用**被拒（错误信息含 Sandbox 说明），且底层 IPC **一个都没发** |
 * | `SB-ON-2` | 沙箱**开** + 路径在**工作区内** ⇒ 允许（不许把好调用也拦了） |
 * | `SB-ONE-1` | 设置键 `codem-sandbox-enabled` 在**生产代码里只被读一处**（`sandbox-acl.ts`） |
 * | `SB-MODE-1` | **两个方向必须相反**：逐条比较同一批 case 在开/关下的结果 |
 *
 * ## 为什么"只测一个方向等于没测"
 *
 * 只断言「沙箱开 ⇒ 越界被拒」时，一个**无条件拦**的实现（就是本次要修的缺陷形态）
 * 会全绿 —— 它在两个方向下都拦。所以每个 case 都必须在两个方向下各跑一次，
 * 并且断言 `off.ok === true && on.ok === false`。
 *
 * ## 关于「关键词搜索」覆盖面的诚实说明
 *
 * `task-keyword-search.ts` 的装机版实现里，`workspace` 与它读的目录**是同一个 `root`**
 * （`createIpcFileSource(root)` 的 `workspace = root`，读的是 `` `${root}/${file}` ``）——
 * 所以它**不存在**"越界读"的场景。它的读/搜路径因此在这里按**调用形状**钉
 * （`readTextWindow(p, 0, max, { workspace })` 与 `grepSearch(pattern, dir, include, { workspace })`，
 * 与 `:145` / `:170` 逐字一致，且 `workspace` 与目标**不在同一棵树**），
 * 另加一条真函数跑通的反向对照（`SB-OFF-2d` / `SB-ON-2c`），防止出现"关了就全拦"的过度拦截。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { removeSetting, setSetting } from "../core/storage/settings";
import { SANDBOX_SETTING_KEY, __resetSandboxSettingCache } from "../core/sandbox/sandbox-acl";
import { grepSearch, readTextWindow, writeFile } from "../core/file-api";
import { createRunCodeTool, __setScriptRunnerForTests } from "../core/llm/tools/run-code";
import { createLSPTool } from "../core/llm/tools/lsp-tool";
import { LocalFileSystemProvider } from "../core/seam/local-fs-provider";
import { buildTaskSearchNotice } from "../core/llm/task-keyword-search";
import type { ToolContext } from "../core/llm/tools";

// ========== 同一组路径：两个方向共用 ==========

const WS = "C:/ws";
/** 工作区**外**的只读目标 */
const OUTSIDE_FILE = "C:/Users/x/notes/private.txt";
/** 工作区**外**的写入目标（不在 `isProtectedPath` 名单里，避免判据分不清是谁拒的） */
const OUTSIDE_WRITE = "C:/elsewhere/out/created.txt";
/** 工作区**外**的搜索目录 */
const OUTSIDE_DIR = "C:/elsewhere";

/** 工作区**内**的同形目标（SB-ON-2 的反向对照） */
const INSIDE_FILE = `${WS}/notes/private.txt`;
const INSIDE_WRITE = `${WS}/src/created.txt`;
const INSIDE_DIR = `${WS}/src`;

const BODY = "-----BEGIN OPENSSH PRIVATE KEY-----SUPER-SECRET";

// ========== 注入式 Tauri mock ==========

let invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installTauriMock() {
  invokes = [];
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (command === "check_path_in_workspace") {
          // 与 Rust 的 `resolve_sandbox_path` + `path_within_workspace` 同口径（按分量）
          const norm = (s: unknown) => String(s ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
          const ws = norm(args?.workspace);
          const t = norm(args?.path);
          return t === ws || t.startsWith(`${ws}/`);
        }
        if (command === "read_file") return BODY;
        if (command === "read_text_window") return { text: BODY, nextOffset: 0, eof: true, size: BODY.length };
        if (command === "glob_search")
          return { files: [`${OUTSIDE_DIR}/a.ts`], truncated: false, depth_limited: false, returned: 1 };
        if (command === "list_directory")
          return [{ name: "usage.test.ts", path: `${WS}/usage.test.ts`, isDirectory: false }];
        if (command === "path_exists") return true;
        if (command === "execute_command") return { stdout: `${OUTSIDE_DIR}/a.ts:1:KEY`, stderr: "", exitCode: 0 };
        return null;
      }),
    },
  };
}

function ctx(cwd = WS): ToolContext {
  return {
    sessionId: "s-mode",
    messageId: "m-mode",
    cwd,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    // auto：跳过覆盖确认，让「沙箱」成为唯一的拒绝来源（否则判据分不清是谁拒的）
    securityMode: "auto",
  } as never;
}

/** 开关：**写进真设置**，并清掉 sticky 记忆（判据自己不复制"读设置"的第二份实现）。 */
function setSandboxMode(on: boolean) {
  if (on) setSetting(SANDBOX_SETTING_KEY, "true");
  else removeSetting(SANDBOX_SETTING_KEY);
  __resetSandboxSettingCache();
}

beforeEach(() => {
  removeSetting(SANDBOX_SETTING_KEY);
  __resetSandboxSettingCache();
});

afterEach(() => {
  __setScriptRunnerForTests(null);
  removeSetting(SANDBOX_SETTING_KEY);
  __resetSandboxSettingCache();
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

// ========== 结果形状：两个方向共用同一把尺子 ==========

interface Outcome {
  /** SDK/API 层面是否**成功**（与工具怎么排版输出无关） */
  ok: boolean;
  error: string | null;
  /** 与本次操作对应的底层 IPC 命令实际发出了几次 */
  ipc: number;
  value?: unknown;
}

function countIpc(command: string): number {
  return invokes.filter((i) => i.command === command).length;
}

/** 驱动 run_code 的 `sdk`（与第 185 波 T2 判据同一套注入式脚本前端）。 */
async function callSdk(fn: (sdk: any) => Promise<unknown>, ipcCommand: string): Promise<Outcome> {
  installTauriMock();
  let captured: Outcome = { ok: false, error: "runner 未被调用", ipc: 0 };
  __setScriptRunnerForTests((async ({ sdk }: any) => {
    try {
      const value = await fn(sdk);
      captured = { ok: true, error: null, ipc: countIpc(ipcCommand), value };
      return { ok: true, value: JSON.stringify(value ?? null), stdout: "", stderr: "" };
    } catch (e: any) {
      captured = { ok: false, error: String(e?.message ?? e), ipc: countIpc(ipcCommand) };
      return { ok: false, error: JSON.stringify({ message: String(e?.message ?? e) }), stdout: "", stderr: "" };
    }
  }) as never);
  await createRunCodeTool().execute({ code: "await sdk.…" }, ctx());
  return captured;
}

async function callPlain(fn: () => Promise<unknown>, ipcCommand: string): Promise<Outcome> {
  installTauriMock();
  try {
    const value = await fn();
    return { ok: true, error: null, ipc: countIpc(ipcCommand), value };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), ipc: countIpc(ipcCommand) };
  }
}

/** run_code 工具层的可读输出（用来确认「拒绝被如实上报」，而不是被吞掉） */
async function runCodeOutput(fn: (sdk: any) => Promise<unknown>): Promise<string> {
  installTauriMock();
  __setScriptRunnerForTests((async ({ sdk }: any) => {
    try {
      const value = await fn(sdk);
      return { ok: true, value: JSON.stringify(value ?? null), stdout: "", stderr: "" };
    } catch (e: any) {
      return { ok: false, error: JSON.stringify({ message: String(e?.message ?? e) }), stdout: "", stderr: "" };
    }
  }) as never);
  const out = await createRunCodeTool().execute({ code: "await sdk.…" }, ctx());
  return String(out.output);
}

// ========== 判据 ==========

describe("SB-OFF-1：沙箱**关** ⇒ sdk 的越界读写必须成功（这就是用户点名的误拒）", () => {
  beforeEach(() => setSandboxMode(false));

  it("SB-OFF-1a: sdk.read 读工作区外的文件 ⇒ 成功，且内容真的拿到", async () => {
    const r = await callSdk((sdk) => sdk.read(OUTSIDE_FILE), "read_file");
    expect(r.ok, `关了就真的关：越界读不许被误拒（实际错误：${r.error}）`).toBe(true);
    expect(String(r.value)).toBe(BODY);
    expect(r.ipc, "底层读必须真的发生").toBeGreaterThan(0);
  });

  it("SB-OFF-1b: sdk.write 写工作区外的文件 ⇒ 成功，且真的写到那个路径", async () => {
    const r = await callSdk((sdk) => sdk.write(OUTSIDE_WRITE, "x"), "write_file");
    expect(r.ok, `关了就真的关：越界写不许被误拒（实际错误：${r.error}）`).toBe(true);
    const w = invokes.find((i) => i.command === "write_file");
    expect(w, "底层写必须真的发生").toBeTruthy();
    expect(String(w!.args?.path)).toBe(OUTSIDE_WRITE);
  });

  it("SB-OFF-1c: sdk.glob 搜工作区外的目录 ⇒ 成功，且底层搜索真的发出", async () => {
    const r = await callSdk((sdk) => sdk.glob("*.ts", OUTSIDE_DIR), "glob_search");
    expect(r.ok, `关了就真的关：越界 glob 不许被误拒（实际错误：${r.error}）`).toBe(true);
    expect(r.ipc, "底层搜索必须真的发出").toBeGreaterThan(0);
  });

  it("SB-OFF-1d: sdk.grep 搜工作区外的目录 ⇒ 成功，且真的跑了 PowerShell 搜索", async () => {
    const r = await callSdk((sdk) => sdk.grep("KEY", { path: OUTSIDE_DIR }), "execute_command");
    expect(r.ok, `关了就真的关：越界 grep 不许被误拒（实际错误：${r.error}）`).toBe(true);
    expect(r.ipc, "底层搜索必须真的发出").toBeGreaterThan(0);
  });
});

describe("SB-OFF-2：沙箱**关** ⇒ lsp / seam / 关键词搜索的读路径同样不许误拒", () => {
  beforeEach(() => setSandboxMode(false));

  it("SB-OFF-2a: lsp 读工作区外的 file ⇒ 成功（不许出 Sandbox 拒绝）", async () => {
    installTauriMock();
    const out = await createLSPTool().execute(
      { operation: "hover", file: OUTSIDE_FILE, line: 1, column: 1 },
      ctx(),
    );
    expect(String(out.output), `关了就真的关：lsp 不许被误拒（实际：${out.output}）`).not.toMatch(
      /outside the workspace/i,
    );
    expect(out.isError, "越界读在沙箱关闭时是合法操作").toBe(false);
    expect(countIpc("read_file"), "底层读必须真的发生").toBeGreaterThan(0);
  });

  it("SB-OFF-2b: seam 的读路径（LocalFileSystemProvider.readFile）对工作区外路径 ⇒ 成功", async () => {
    const provider = new LocalFileSystemProvider();
    const r = await callPlain(() => provider.readFile(OUTSIDE_FILE, WS), "read_file");
    expect(r.ok, `关了就真的关：seam 的读不许被误拒（实际错误：${r.error}）`).toBe(true);
    expect(r.value).toBe(BODY);
    expect(r.ipc).toBeGreaterThan(0);
  });

  it("SB-OFF-2c: 关键词搜索的读/搜调用形状（readTextWindow / grepSearch）越界 ⇒ 成功", async () => {
    // 与 createIpcFileSource / createIpcSearcher 的调用形状逐字一致，且 workspace 与目标不在同一棵树
    const win = await callPlain(
      () => readTextWindow(OUTSIDE_FILE, 0, 4096, { workspace: WS }),
      "read_text_window",
    );
    expect(win.ok, `窗口读不许被误拒（实际错误：${win.error}）`).toBe(true);
    expect(win.ipc).toBeGreaterThan(0);

    const grep = await callPlain(() => grepSearch("KEY", OUTSIDE_DIR, undefined, { workspace: WS }), "execute_command");
    expect(grep.ok, `搜索不许被误拒（实际错误：${grep.error}）`).toBe(true);
    expect(grep.ipc).toBeGreaterThan(0);
  });

  it("SB-OFF-2d: 关键词搜索真函数照常跑通（反向对照：关机不等于乱放行/乱拦）", async () => {
    installTauriMock();
    const notice = await buildTaskSearchNotice(WS, "KEY private", {});
    expect(notice, "前置：确实产出了清单").toBeTruthy();
    expect(String(notice), "自己的读不许被误拒").not.toMatch(/outside the workspace/i);
  });
});

describe("SB-ON-1：沙箱**开** ⇒ 同一批越界调用必须被拒（拦截不许被削弱）", () => {
  beforeEach(() => setSandboxMode(true));

  it("SB-ON-1a: sdk.read 越界 ⇒ 被拒，且 read_file 一个都不发", async () => {
    const r = await callSdk((sdk) => sdk.read(OUTSIDE_FILE), "read_file");
    expect(r.ok, "沙箱开着时越界读必须失败").toBe(false);
    expect(String(r.error)).toMatch(/outside the workspace/i);
    expect(r.ipc, "★ 闸门必须在 IPC 之前").toBe(0);
    expect(String(r.error)).not.toContain("SUPER-SECRET");
  });

  it("SB-ON-1b: sdk.write 越界 ⇒ 被拒，且 write_file 一个都不发", async () => {
    const r = await callSdk((sdk) => sdk.write(OUTSIDE_WRITE, "x"), "write_file");
    expect(r.ok, "沙箱开着时越界写必须失败").toBe(false);
    expect(String(r.error)).toMatch(/outside the workspace/i);
    expect(r.ipc, "★ 闸门必须在 IPC 之前").toBe(0);
  });

  it("SB-ON-1c: sdk.glob 越界 ⇒ 被拒，且 glob_search 一个都不发", async () => {
    const r = await callSdk((sdk) => sdk.glob("*.ts", OUTSIDE_DIR), "glob_search");
    expect(r.ok, "沙箱开着时越界 glob 必须失败").toBe(false);
    expect(String(r.error)).toMatch(/outside the workspace/i);
    expect(r.ipc).toBe(0);
  });

  it("SB-ON-1d: sdk.grep 越界 ⇒ 被拒，且没跑 PowerShell 搜索", async () => {
    const r = await callSdk((sdk) => sdk.grep("KEY", { path: OUTSIDE_DIR }), "execute_command");
    expect(r.ok, "沙箱开着时越界 grep 必须失败").toBe(false);
    expect(String(r.error)).toMatch(/outside the workspace/i);
    expect(r.ipc).toBe(0);
  });

  it("SB-ON-1e: lsp / seam 的越界读同样被拒（不许只在 sdk 那一层拦）", async () => {
    installTauriMock();
    const out = await createLSPTool().execute(
      { operation: "hover", file: OUTSIDE_FILE, line: 1, column: 1 },
      ctx(),
    );
    expect(out.isError, "沙箱开着时 lsp 越界读必须如实失败").toBe(true);
    expect(String(out.output)).toMatch(/outside the workspace/i);
    expect(countIpc("read_file")).toBe(0);

    const provider = new LocalFileSystemProvider();
    const r = await callPlain(() => provider.readFile(OUTSIDE_FILE, WS), "read_file");
    expect(r.ok, "沙箱开着时 seam 的越界读必须失败").toBe(false);
    expect(String(r.error)).toMatch(/outside the workspace/i);
    expect(r.ipc).toBe(0);
  });

  it("SB-ON-1f: 关键词搜索的读/搜形状越界 ⇒ 被拒", async () => {
    const win = await callPlain(() => readTextWindow(OUTSIDE_FILE, 0, 4096, { workspace: WS }), "read_text_window");
    expect(win.ok).toBe(false);
    expect(String(win.error)).toMatch(/outside the workspace/i);
    expect(win.ipc).toBe(0);

    const grep = await callPlain(() => grepSearch("KEY", OUTSIDE_DIR, undefined, { workspace: WS }), "execute_command");
    expect(grep.ok).toBe(false);
    expect(String(grep.error)).toMatch(/outside the workspace/i);
    expect(grep.ipc).toBe(0);
  });

  it("SB-ON-1g: 拒绝会被如实上报到工具输出（不许被吞成空结果）", async () => {
    const output = await runCodeOutput((sdk) => sdk.read(OUTSIDE_FILE));
    expect(output, "★ 拒绝必须可见").toMatch(/outside the workspace/i);
    expect(output).not.toContain("SUPER-SECRET");
  });
});

describe("SB-ON-2：沙箱**开** + 路径在**工作区内** ⇒ 允许（不许把好调用也拦了）", () => {
  beforeEach(() => setSandboxMode(true));

  it("SB-ON-2a: sdk 的四个方向在工作区内全部成功", async () => {
    const read = await callSdk((sdk) => sdk.read(INSIDE_FILE), "read_file");
    expect(read.ok, `工作区内的读不许被拦（${read.error}）`).toBe(true);

    const write = await callSdk((sdk) => sdk.write(INSIDE_WRITE, "x"), "write_file");
    expect(write.ok, `工作区内的写不许被拦（${write.error}）`).toBe(true);

    const glob = await callSdk((sdk) => sdk.glob("*.ts", INSIDE_DIR), "glob_search");
    expect(glob.ok, `工作区内的 glob 不许被拦（${glob.error}）`).toBe(true);

    const grep = await callSdk((sdk) => sdk.grep("KEY", { path: INSIDE_DIR }), "execute_command");
    expect(grep.ok, `工作区内的 grep 不许被拦（${grep.error}）`).toBe(true);
  });

  it("SB-ON-2b: lsp / seam 在工作区内照旧可用", async () => {
    installTauriMock();
    const out = await createLSPTool().execute(
      { operation: "hover", file: INSIDE_FILE, line: 1, column: 1 },
      ctx(),
    );
    expect(String(out.output), `工作区内的 lsp 不许被拦（实际：${out.output}）`).not.toMatch(
      /outside the workspace/i,
    );
    expect(countIpc("read_file"), "底层的读必须真的发生").toBeGreaterThan(0);

    const provider = new LocalFileSystemProvider();
    const r = await callPlain(() => provider.readFile(INSIDE_FILE, WS), "read_file");
    expect(r.ok, `工作区内的 seam 读不许被拦（${r.error}）`).toBe(true);
  });

  it("SB-ON-2c: 关键词搜索真函数在沙箱开启下照常跑通（工作区内）", async () => {
    installTauriMock();
    const notice = await buildTaskSearchNotice(WS, "KEY private", {});
    expect(notice).toBeTruthy();
    expect(String(notice)).not.toMatch(/outside the workspace/i);
  });
});

describe("SB-MODE-1：**两个方向必须相反** —— 只测一个方向等于没测", () => {
  /** 同一批 case：每个都在「关」与「开」两种模式下各跑一次 */
  const cases: Array<{
    id: string;
    ipc: string;
    outside: () => Promise<Outcome>;
    inside: () => Promise<Outcome>;
  }> = [
    {
      id: "sdk.read",
      ipc: "read_file",
      outside: () => callSdk((sdk) => sdk.read(OUTSIDE_FILE), "read_file"),
      inside: () => callSdk((sdk) => sdk.read(INSIDE_FILE), "read_file"),
    },
    {
      id: "sdk.write",
      ipc: "write_file",
      outside: () => callSdk((sdk) => sdk.write(OUTSIDE_WRITE, "x"), "write_file"),
      inside: () => callSdk((sdk) => sdk.write(INSIDE_WRITE, "x"), "write_file"),
    },
    {
      id: "sdk.glob",
      ipc: "glob_search",
      outside: () => callSdk((sdk) => sdk.glob("*.ts", OUTSIDE_DIR), "glob_search"),
      inside: () => callSdk((sdk) => sdk.glob("*.ts", INSIDE_DIR), "glob_search"),
    },
    {
      id: "sdk.grep",
      ipc: "execute_command",
      outside: () => callSdk((sdk) => sdk.grep("KEY", { path: OUTSIDE_DIR }), "execute_command"),
      inside: () => callSdk((sdk) => sdk.grep("KEY", { path: INSIDE_DIR }), "execute_command"),
    },
    {
      id: "seam.read",
      ipc: "read_file",
      outside: () => callPlain(() => new LocalFileSystemProvider().readFile(OUTSIDE_FILE, WS), "read_file"),
      inside: () => callPlain(() => new LocalFileSystemProvider().readFile(INSIDE_FILE, WS), "read_file"),
    },
    {
      id: "keyword.readTextWindow",
      ipc: "read_text_window",
      outside: () => callPlain(() => readTextWindow(OUTSIDE_FILE, 0, 4096, { workspace: WS }), "read_text_window"),
      inside: () => callPlain(() => readTextWindow(INSIDE_FILE, 0, 4096, { workspace: WS }), "read_text_window"),
    },
    {
      id: "keyword.grepSearch",
      ipc: "execute_command",
      outside: () => callPlain(() => grepSearch("KEY", OUTSIDE_DIR, undefined, { workspace: WS }), "execute_command"),
      inside: () => callPlain(() => grepSearch("KEY", INSIDE_DIR, undefined, { workspace: WS }), "execute_command"),
    },
  ];

  it("SB-MODE-1: 越界路径在「关」下成功、在「开」下被拒；工作区内两边都成功", async () => {
    const observed: Record<string, unknown> = {};

    for (const c of cases) {
      setSandboxMode(false);
      const offOutside = await c.outside();
      const offInside = await c.inside();

      setSandboxMode(true);
      const onOutside = await c.outside();
      const onInside = await c.inside();

      observed[c.id] = {
        offOutside: offOutside.ok,
        onOutside: onOutside.ok,
        offInside: offInside.ok,
        onInside: onInside.ok,
      };

      // ① 关 ⇒ 越界成功（且底层 IPC 真的发出）—— 误拒判据
      expect(offOutside.ok, `${c.id}: 沙箱关闭时越界调用必须成功（错误：${offOutside.error}）`).toBe(true);
      expect(offOutside.ipc, `${c.id}: 沙箱关闭时底层 IPC 必须真的发出`).toBeGreaterThan(0);
      // ② 开 ⇒ 同一路径被拒（且 IPC 一个都不发）—— 拦截不许削弱
      expect(onOutside.ok, `${c.id}: 沙箱开启时越界调用必须被拒`).toBe(false);
      expect(String(onOutside.error), `${c.id}: 拒绝文案必须说清是沙箱`).toMatch(/outside the workspace/i);
      expect(onOutside.ipc, `${c.id}: 被拒的调用不许发出 IPC`).toBe(0);
      // ③ **同一组路径、两个方向结果相反** —— 这就是"只测一个方向等于没测"的那条
      expect(onOutside.ok, `${c.id}: 关与开必须给出相反结果`).not.toBe(offOutside.ok);
      // ④ 工作区内：两个方向都必须成功（不许过度拦截）
      expect(offInside.ok, `${c.id}: 沙箱关闭时工作区内必须成功（错误：${offInside.error}）`).toBe(true);
      expect(onInside.ok, `${c.id}: 沙箱开启时工作区内必须成功（错误：${onInside.error}）`).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log("[SB-MODE-1] 双向结果：", JSON.stringify(observed, null, 2));
  });
});

describe("SB-ONE-1：「沙箱是否启用」只有一处实现（同一规则不许两份）", () => {
  const REPO = join(__dirname, "..", "..");
  const SRC = join(REPO, "src");
  const RUST_SRC = join(REPO, "src-tauri", "src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "node_modules" || name === ".git") continue;
        walk(p, out);
      } else if (/\.(ts|tsx|rs)$/.test(name)) {
        out.push(p);
      }
    }
    return out;
  }

  /** 生产代码 = 排除判据目录（判据自己可以读写设置来做前置条件） */
  function productionFiles(): string[] {
    return [...walk(SRC), ...walk(RUST_SRC)].filter((f) => {
      const rel = relative(REPO, f).split(sep).join("/");
      return !rel.startsWith("src/test/") && !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx");
    });
  }

  it("SB-ONE-1a: 全仓生产代码里只有一处**读**沙箱设置", () => {
    const readers: string[] = [];
    for (const file of productionFiles()) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        // 读：getSetting(SANDBOX_SETTING_KEY) / getSetting("codem-sandbox-enabled")
        const readsKey =
          /getSetting\s*(<[^>]*>)?\s*\(\s*(SANDBOX_SETTING_KEY|["']codem-sandbox-enabled["'])\s*\)/.test(line);
        // 注释里的键名引用是允许的（解释历史），所以先排掉整行注释
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (readsKey && !isComment) {
          readers.push(`${relative(REPO, file).split(sep).join("/")}:${i + 1}`);
        }
      });
    }
    expect(
      readers,
      `「沙箱是否启用」必须只有一处读设置的实现，实际读到：${JSON.stringify(readers)}`,
    ).toEqual(["src/core/sandbox/sandbox-acl.ts:58"]);
  });

  /**
   * 只留**代码行**（去掉整行注释）。
   *
   * 为什么需要：注释里**允许**引用键名（本仓库大量中文注释在解释"改前是怎么写的"，
   * 那正是"为什么会有这一处判定"的证据）。要钉的是「有没有**读**设置」这个动作，
   * 不是「有没有提到这个键」。
   */
  function codeOnly(text: string): string {
    return text
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
  }

  it("SB-ONE-1b: 两个消费者都走同一个入口（tools.checkSandbox 与 file-api 的读侧判定）", () => {
    const toolsSrc = codeOnly(readFileSync(join(SRC, "core", "llm", "tools.ts"), "utf8"));
    const fileApiSrc = codeOnly(readFileSync(join(SRC, "core", "file-api.ts"), "utf8"));

    // 两处都必须委托给**同一个**判定
    expect(toolsSrc, "tools.ts 必须委托给统一入口").toContain("isSandboxAclEnabled");
    expect(fileApiSrc, "file-api.ts 必须委托给统一入口").toContain("isSandboxAclEnabled");
    // 谁都不许自己再读一遍设置（那就是第二份实现）
    expect(toolsSrc, "tools.ts 不许再自己读设置").not.toMatch(
      /getSetting\(\s*["']codem-sandbox-enabled["']\s*\)/,
    );
    expect(fileApiSrc, "file-api.ts 不许自己读设置").not.toMatch(
      /getSetting\(\s*["']codem-sandbox-enabled["']\s*\)/,
    );
  });

  it("SB-ONE-1c: checkSandbox 与 assertWithinWorkspace 的行为判定同源（同一批路径同一结论）", async () => {
    // checkSandbox 是 tools.ts 里给 write/edit 用的**文本**判定；assertWithinWorkspace 是 file-api 的
    // 读侧判定。两者必须在同一模式下给出同一结论 —— 这里用 sdk.write 与 file-api.writeFile 对照。
    for (const on of [false, true]) {
      setSandboxMode(on);
      const viaSdk = await callSdk((sdk) => sdk.write(OUTSIDE_WRITE, "x"), "write_file");
      const viaApi = await callPlain(() => writeFile(OUTSIDE_WRITE, "x", { workspace: WS }), "write_file");
      expect({ on, sdk: viaSdk.ok, api: viaApi.ok }, `模式=${on} 时两个入口必须同结论`).toEqual({
        on,
        sdk: !on,
        api: !on,
      });
    }
  });
});
