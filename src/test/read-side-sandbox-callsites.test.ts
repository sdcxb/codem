/**
 * ★ 第 185 波（复审 R1-4）：**读侧沙箱的免费绕过口**（`lsp` 的入参叫 `file`、seam provider
 * 不传 workspace、TS 判定不 canonicalize）必须被堵上。
 *
 * ## 钉的是什么
 *
 * ① `lsp` 是**唯一**带 `file` 参数的只读工具，而沙箱守卫只认 `args.path` / `args.file_path`
 *    （`tool-pipeline.ts`）⇒ `lsp { operation: "hover", file: "C:\\…\\.ssh\\id_rsa" }`
 *    走 `readFile(file)`（**不传 workspace**）一路放行，同一路径上的 `read` 工具却被拒；
 * ② `local-fs-provider.readFile`（启动时由 `initDefaultSeams()` 注册）同样不传 workspace
 *    ⇒ `file-api.ts` 的 `if (!workspace) return;` 让检查整条失效（fail-open）；
 * ③ `isPathWithinWorkspace` 只是**词法**判定：工作区里一个指向外部的 junction/符号链接
 *    可以在读侧穿出去，而 Rust 写侧已改成真 `canonicalize` ⇒ 同一事实两份结论。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | RS-1 | `lsp` 越界 `file` ⇒ 被拒，且 `read_file` IPC **一个都没发** |
 * | RS-2 | 反向对照：工作区内的 `lsp` 照旧可用（不许把好调用也拦了） |
 * | RS-3 | **能 canonicalize 就 canonicalize**：`check_path_in_workspace` 说"不在"就必须拒（词法上它在里面）——junction 那条路 |
 * | RS-4 | `lsp` 的 `grepSearch` 搜索路径越界 ⇒ 被拒，且没有发出 `execute_command` |
 * | RS-5 | seam provider 的 `readFile(path, cwd)` 把 `cwd` 当工作区（与 `writeFile` 同形） |
 * | RS-6 | 管线守卫认 `file` 参数名（`lsp` 的入参叫 `file`，不是 `path`/`file_path`） |
 *
 * ⚠️ 路径都在**运行期**给（不是写在工具 schema 里）—— 钉的是闸门，不是文本扫描（那是另一道）。
 *
 * ## ★ 误拒修复后的必要前置：**显式打开沙箱**
 *
 * 本文件钉的是「沙箱**开启**时越界读必须被拒」这一个方向。`file-api.ts` 的
 * `assertWithinWorkspace` 改后**看开关**（改前只看"有没有给 workspace"——那正是用户点名的
 * 误拒缺陷：「关了沙箱沙箱还是生效，导致项目读写出问题」），所以这里必须显式开开关。
 * **另一个方向**（关 ⇒ 越界必须成功）见 `sandbox-mode-consistency.test.ts`
 * 的 SB-OFF-2 / SB-MODE-1。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

import { createLSPTool } from "../core/llm/tools/lsp-tool";
import { LocalFileSystemProvider } from "../core/seam/local-fs-provider";
import { readFile } from "../core/file-api";
import { __resetSandboxSettingCache, setSandboxAclEnabled } from "../core/sandbox/sandbox-acl";
import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";
import { createDefaultToolRegistry } from "../core/llm/tools";
import type { ToolContext } from "../core/llm/tools";

const WS = "C:/ws";
const SECRET_PATH = "C:/Users/x/.ssh/id_rsa";
const SECRET_BODY = "-----BEGIN OPENSSH PRIVATE KEY-----SUPER-SECRET";

let invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

/**
 * 注入式 Tauri mock。
 *
 * `check_path_in_workspace` 是 Rust 侧**与写侧守卫同一份实现**的判定（`lib.rs` 的
 * `resolve_sandbox_path` + `path_within_workspace`）。这里让它按 `link-to-outside`
 * 这个"junction"形态返回 false —— 用来钉"能 canonicalize 就 canonicalize"。
 */
function installTauriMock() {
  invokes = [];
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (command === "check_path_in_workspace") {
          const p = String(args?.path ?? "");
          // 词法上在 C:/ws 里，但把工作区指向工作区之外（模拟 junction）
          if (p.includes("link-to-outside")) return false;
          const ws = String(args?.workspace ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
          const t = p.replace(/\\/g, "/").toLowerCase();
          return t === ws || t.startsWith(`${ws}/`);
        }
        if (command === "read_file") return SECRET_BODY;
        if (command === "path_exists") return true;
        if (command === "execute_command") return { stdout: `${SECRET_PATH}:1:secret`, stderr: "", exitCode: 0 };
        return null;
      }),
    },
  };
}

function lspCtx(cwd = WS): ToolContext {
  return {
    sessionId: "s-rs",
    messageId: "m-rs",
    cwd,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    securityMode: "auto",
  } as never;
}

/** 本文件钉的是「沙箱**开** ⇒ 越界读被拒」这一个方向，所以每个用例前显式打开开关。 */
beforeEach(() => {
  setSandboxAclEnabled(true);
  __resetSandboxSettingCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  setSandboxAclEnabled(false);
  __resetSandboxSettingCache();
  delete (window as any).__TAURI__;
});

describe("R1-4：读侧沙箱（lsp / seam / canonicalize）", () => {
  it("RS-1: lsp 越界 `file` ⇒ 被拒，且 read_file IPC 一个都没发", async () => {
    installTauriMock();
    const out = await createLSPTool().execute({ operation: "hover", file: SECRET_PATH, line: 1, column: 1 }, lspCtx());

    expect(out.isError, "越界读必须如实失败").toBe(true);
    expect(out.output, `实际输出：${out.output}`).toMatch(/outside the workspace/i);
    expect(out.output, "★ 私钥内容不许出现在结果里").not.toContain("SUPER-SECRET");
    expect(
      invokes.some((i) => i.command === "read_file"),
      "★ 闸门必须在 IPC 之前：越界读一个字节都不该被发起",
    ).toBe(false);
  });

  it("RS-2: 反向对照 —— 工作区内的 lsp 照旧可用", async () => {
    installTauriMock();
    const out = await createLSPTool().execute({ operation: "hover", file: `${WS}/a.ts`, line: 1, column: 1 }, lspCtx());

    expect(out.isError, `工作区内的读不许被拦（实际：${out.output}）`).toBe(false);
    expect(invokes.some((i) => i.command === "read_file"), "底层的读必须真的发生").toBe(true);
    expect(
      invokes.find((i) => i.command === "check_path_in_workspace")?.args,
      "工作区必须传给 Rust 判定（不是 undefined —— 那等于没有检查）",
    ).toEqual({ path: `${WS}/a.ts`, workspace: WS });
  });

  it("RS-3: 能 canonicalize 就 canonicalize —— 词法上在工作区内、Rust 说不在 ⇒ 必须拒", async () => {
    installTauriMock();
    const inside = `${WS}/link-to-outside/secret.txt`;
    await expect(
      readFile(inside, { workspace: WS }),
      "词法判定会放行这种路径（工作区里的 junction）；与 Rust 写侧同口径就必须拒",
    ).rejects.toThrow(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "read_file")).toBe(false);
  });

  it("RS-4: lsp 的 grep 搜索路径越界 ⇒ 被拒，且没有发出 execute_command", async () => {
    installTauriMock();
    const out = await createLSPTool().execute(
      { operation: "definition", symbol: "findAmbiguousLiteral", file: `${WS}/a.ts`, path: "C:/elsewhere" },
      lspCtx(),
    );
    expect(out.output, `越界搜索必须被拒（实际：${out.output}）`).toMatch(/outside the workspace/i);
    expect(
      invokes.some((i) => i.command === "execute_command"),
      "★ 越界搜索不许真的跑 PowerShell",
    ).toBe(false);
  });

  it("RS-5: seam provider 的 readFile(path, cwd) 把 cwd 当工作区（不许裸读）", async () => {
    installTauriMock();
    const provider = new LocalFileSystemProvider();

    await expect(provider.readFile(SECRET_PATH, WS), "seam 的读侧必须过闸门").rejects.toThrow(
      /outside the workspace/i,
    );
    expect(invokes.some((i) => i.command === "read_file"), "越界时底层读不许发出").toBe(false);

    installTauriMock();
    await expect(provider.readFile("src/a.ts", WS)).resolves.toBe(SECRET_BODY);
  });

  /**
   * ★ 误拒修复的**反向**判据：沙箱**关** ⇒ 同一批越界读必须**成功**。
   *
   * 只有 RS-1..RS-5（开 ⇒ 拒）是不够的：一个**无条件拦**的实现也能让它们全绿 ——
   * 那正是本次要修的缺陷形态（用户点名：「关了沙箱后沙箱还是生效，导致项目读写出问题」）。
   * 所以这里把**同一批路径**在两个方向下各跑一次，并要求结果相反。
   */
  it("RS-7（反向对照）: 沙箱**关** ⇒ 同一批越界读必须成功（关了就真的关）", async () => {
    setSandboxAclEnabled(false);
    __resetSandboxSettingCache();

    // lsp：越界 `file` 在关闭时是**合法**读，且底层读必须真的发生
    installTauriMock();
    const lspOff = await createLSPTool().execute(
      { operation: "hover", file: SECRET_PATH, line: 1, column: 1 },
      lspCtx(),
    );
    expect(String(lspOff.output), `关闭时越界 lsp 不许被误拒（实际：${lspOff.output}）`).not.toMatch(
      /outside the workspace/i,
    );
    expect(invokes.some((i) => i.command === "read_file"), "底层读必须真的发生").toBe(true);

    // seam provider
    installTauriMock();
    await expect(
      new LocalFileSystemProvider().readFile(SECRET_PATH, WS),
      "关闭时越界 seam 读不许被误拒",
    ).resolves.toBe(SECRET_BODY);

    // file-api 本体（RS-3 的那条路径，关闭时不再 canonicalize 拦）
    installTauriMock();
    await expect(
      readFile(SECRET_PATH, { workspace: WS }),
      "关闭时越界 readFile 不许被误拒",
    ).resolves.toBe(SECRET_BODY);

    // lsp 的 grep 搜索路径
    installTauriMock();
    const grepOff = await createLSPTool().execute(
      { operation: "definition", symbol: "findAmbiguousLiteral", file: `${WS}/a.ts`, path: "C:/elsewhere" },
      lspCtx(),
    );
    expect(String(grepOff.output), `关闭时越界搜索不许被误拒（实际：${grepOff.output}）`).not.toMatch(
      /outside the workspace/i,
    );
    expect(invokes.some((i) => i.command === "execute_command"), "底层搜索必须真的发出").toBe(true);

    // ★ 同一批路径、两个方向、结果必须相反
    setSandboxAclEnabled(true);
    __resetSandboxSettingCache();
    installTauriMock();
    await expect(readFile(SECRET_PATH, { workspace: WS })).rejects.toThrow(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "read_file")).toBe(false);
  });
});

describe("R1-4e：管线守卫必须认 `lsp` 的 `file` 参数名", () => {
  const registry = createDefaultToolRegistry();
  let handlerCalls = 0;

  beforeAll(async () => {
    await initDefaultPipeline({
      isPlanMode: () => false,
      isSandboxEnabled: () => true,
      isPathWithinWorkspace: (p: string, cwd: string) => {
        const t = p.replace(/\\/g, "/").toLowerCase();
        const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        return t === c || t.startsWith(`${c}/`);
      },
      contractOf: (n: string) => registry.getContract(n),
      rawContractOf: (n: string) => registry.getRawContract(n),
      toolDefOf: (n: string) => registry.get(n),
      checkPermission: async () => ({ allowed: true }),
    });
  });

  async function runLsp(args: Record<string, unknown>) {
    handlerCalls = 0;
    const r = await getToolPipeline().execute("lsp", args, lspCtx() as never, async () => {
      handlerCalls++;
      return {
        id: "call-lsp",
        name: "lsp",
        input: args,
        output: "SHOULD-NOT-RUN",
        status: "completed" as const,
      };
    });
    return r.result;
  }

  it("RS-6: 沙箱开启时 `lsp { file: 工作区外 }` 必须被守卫拦下（改前它取不到 path ⇒ 放行）", async () => {
    const denied = await runLsp({ operation: "hover", file: SECRET_PATH, line: 1, column: 1 });
    expect(denied.output, `守卫必须拦下它（实际：${denied.output}）`).toMatch(/outside the workspace/i);
    expect(handlerCalls, "★ 被拒的调用不许真的执行").toBe(0);

    // 反向对照：工作区内的 lsp 照旧放行
    const allowed = await runLsp({ operation: "hover", file: `${WS}/a.ts`, line: 1, column: 1 });
    expect(handlerCalls, "工作区内的调用必须照旧执行").toBe(1);
    expect(allowed.output).toBe("SHOULD-NOT-RUN");
  });
});
