/**
 * ★ 第 185 波 T2 判据：**进程内 SDK 的读侧也必须过工作区沙箱**（与写侧同一份实现）。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T2）
 *
 * `run_code` / `workflow` 都在脚本里暴露 `sdk.read` / `sdk.glob` / `sdk.grep`，
 * 而它们原来是**裸 IPC**：
 *
 * ```ts
 * async read(path) { return await readFile(path); }              // 没有 workspace
 * async glob(pattern, path) { return await globSearch(pattern, path || ctx.cwd); }
 * ```
 *
 * 而 `file-api.ts` 的**写**侧一直有 `if (options?.workspace) isPathWithinWorkspace(...)`
 * —— 读侧没有。`tool-gates.ts` 只覆盖危险命令 / 受保护**写**路径 / 覆盖确认，
 * 没有读侧闸门 ⇒ 沙箱开启时 `await sdk.read("C:/Users/x/.ssh/id_rsa")` 读得到工作区外的文件，
 * 而**同样带 path 的 `read` 工具调用会被 `SandboxGuard` 拒**：同一个沙箱，两份相反的事实。
 *
 * ## 判据（驱动**真实工具** + 注入式脚本前端，直接调用 SDK 方法）
 *
 * | id | 钉什么 |
 * |---|---|
 * | `T2-A` | 沙箱语义下 `sdk.read` 越界 ⇒ 抛错（文案说明在工作区外），且**文件内容一个字节都没拿到** |
 * | `T2-B` | 反向对照：工作区**内**的 `sdk.read` 照旧读得到（不能把好调用也拦了） |
 * | `T2-C` | `sdk.glob` / `sdk.grep` 的搜索路径越界 ⇒ 被拒，且**根本没发出**底层搜索 IPC |
 * | `T2-D` | `workflow` 的 `sdk.read` 同样（audit 点名的 `workflow-engine.ts` 那一处） |
 * | `T2-E` | 「一份实现」的行为判据：读侧与写侧对**同一批路径**给出**同一判定** |
 *
 * ⚠️ 路径在**脚本运行期**给（不是写死在 `code` 文本里）—— 这样这条判据钉的就是
 * SDK 实现里的闸门，而不是管线的文本扫描（那是另一道，见 `sandbox-shell-path-leak`）。
 *
 * ## ★ 误拒修复后的必要前置：**显式打开沙箱**
 *
 * 本文件钉的是「沙箱**开启**时越界必须被拒」这一个方向。而 `assertWithinWorkspace` 改后
 * **看开关**（改前只看"有没有给 workspace"，那正是用户点名的误拒缺陷：「关了沙箱沙箱还是
 * 生效」）—— 所以这里必须显式把开关打开，否则测的是"全访问模式"。
 * **另一个方向**（关 ⇒ 越界必须成功）见 `sandbox-mode-consistency.test.ts` 的 SB-OFF-1/2
 * 与 SB-MODE-1（同一批路径在两个方向下结果必须相反）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createRunCodeTool, __setScriptRunnerForTests } from "../core/llm/tools/run-code";
import { createWorkflowTool } from "../core/llm/workflow-engine";
import { readFile, writeFile, globSearch, grepSearch } from "../core/file-api";
import { __resetSandboxSettingCache, setSandboxAclEnabled } from "../core/sandbox/sandbox-acl";
import type { ToolContext } from "../core/llm/tools";

const WS = "C:/ws";
const SECRET_PATH = "C:/Users/x/.ssh/id_rsa";
const SECRET_BODY = "-----BEGIN OPENSSH PRIVATE KEY-----SUPER-SECRET";
/** 工作区外的写入目标（不在 `isProtectedPath` 名单里，避免判据分不清是谁拒的） */
const OUTSIDE_WRITE = "C:/elsewhere/out/created.txt";

/** 记录所有 IPC 调用（判"根本没发出去"）。 */
let invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installTauriMock() {
  invokes = [];
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (command === "read_file") return SECRET_BODY; // 底层"读得到" —— 闸门必须在它**之前**
        // ★ 第 186 波：`glob_search` 回**结构化对象**（不再是裸数组）
        if (command === "glob_search")
          return {
            files: [`${SECRET_PATH}`],
            truncated: false,
            depth_limited: false,
            returned: 1,
          };
        if (command === "path_exists") return true;
        if (command === "execute_command") return { stdout: `${SECRET_PATH}:1:secret`, stderr: "", exitCode: 0 };
        return null;
      }),
    },
  };
}

function ctx(cwd = WS): ToolContext {
  return {
    sessionId: "s-t2",
    messageId: "m-t2",
    cwd,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    // auto：跳过覆盖确认，让"沙箱"成为唯一的拒绝来源（否则判据分不清是谁拒的）
    securityMode: "auto",
  };
}

/**
 * 注入一个脚本前端：它替"脚本"调用一次 SDK 方法，并把结果/错误如实带回。
 * 这样判据不需要 Rust 引擎，驱动的是**真的 SDK 实现**（与 `ScriptRunner` 的契约一致）。
 */
function runnerCalling(fn: (sdk: any) => Promise<string>) {
  return async ({ sdk }: { sdk: any }) => {
    try {
      const value = await fn(sdk);
      return { ok: true, value, stdout: "", stderr: "" };
    } catch (e: any) {
      return { ok: false, error: JSON.stringify({ message: String(e?.message ?? e) }), stdout: "", stderr: "" };
    }
  };
}

/** 本文件钉的是「沙箱**开** ⇒ 越界被拒」这一个方向，所以每个用例前显式打开开关。 */
beforeEach(() => {
  setSandboxAclEnabled(true);
  __resetSandboxSettingCache();
});

afterEach(() => {
  __setScriptRunnerForTests(null);
  setSandboxAclEnabled(false);
  __resetSandboxSettingCache();
});

describe("第 185 波 T2：sdk 读侧的工作区沙箱", () => {
  it("T2-A: 沙箱语义下 sdk.read 越界 ⇒ 被拒，且内容一个字节都没拿到", async () => {
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.read(SECRET_PATH)) as never);

    const tool = createRunCodeTool();
    const out = await tool.execute({ code: "await sdk.read(p)" }, ctx());

    expect(out.output, "越界读必须如实失败").toMatch(/outside the workspace/i);
    expect(out.output, "★ 私钥内容不许出现在结果里").not.toContain("SUPER-SECRET");
    expect(
      invokes.some((i) => i.command === "read_file"),
      "★ 闸门必须在 IPC 之前：底层读一个字节都不该被发起",
    ).toBe(false);
  });

  it("T2-B: 反向对照 —— 工作区内的 sdk.read 照旧读得到", async () => {
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.read(`${WS}/a.ts`)) as never);

    const tool = createRunCodeTool();
    const out = await tool.execute({ code: "await sdk.read(p)" }, ctx());

    expect(out.output, "工作区内的读不许被拦").not.toMatch(/outside the workspace/i);
    expect(out.output).toContain("SUPER-SECRET");
  });

  it("T2-C: sdk.glob / sdk.grep 的搜索路径越界 ⇒ 被拒，且底层搜索 IPC 根本没发出", async () => {
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.glob("*.ts", "C:/elsewhere")) as never);
    const globOut = await createRunCodeTool().execute({ code: "await sdk.glob()" }, ctx());
    expect(globOut.output, "越界 glob 必须被拒").toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "glob_search")).toBe(false);

    installTauriMock();
    __setScriptRunnerForTests(
      runnerCalling((sdk) => sdk.grep("KEY", { path: "C:/elsewhere" }).then(() => "ran")) as never,
    );
    const grepOut = await createRunCodeTool().execute({ code: "await sdk.grep()" }, ctx());
    expect(grepOut.output, "越界 grep 必须被拒").toMatch(/outside the workspace/i);
    expect(
      invokes.some((i) => i.command === "execute_command"),
      "★ 越界 grep 不许真的跑 PowerShell 搜索",
    ).toBe(false);
  });

  it("T2-D: workflow 的 sdk.read 同样过闸门（audit 点名的这一处）", async () => {
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.read(SECRET_PATH)) as never);

    const out = await createWorkflowTool().execute({ code: "await sdk.read(p)" }, ctx());
    expect(out.output).toMatch(/outside the workspace/i);
    expect(out.output).not.toContain("SUPER-SECRET");
  });

  it("T2-E（一份实现）: 读侧与写侧对同一批路径给出同一判定，且该判定确实是「工作区内才放行」", async () => {
    installTauriMock();
    /**
     * 期望值**逐条写死**（不是"两侧一致即可"）—— 否则"两边都不检查"也能满足一致性，
     * 那正是这条判据要防的假绿。
     */
    const cases: Array<{ p: string; denied: boolean }> = [
      { p: `${WS}/a.ts`, denied: false },
      { p: `${WS}/sub/b.ts`, denied: false },
      { p: SECRET_PATH, denied: true },
      { p: "C:/ws/../elsewhere/c.ts", denied: true },
      { p: "//server/share/d.ts", denied: true },
    ];
    const denied = async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return false;
      } catch {
        return true;
      }
    };
    for (const { p, denied: want } of cases) {
      const readDenied = await denied(() => readFile(p, { workspace: WS }));
      const writeDenied = await denied(() => writeFile(p, "x", { workspace: WS }));
      const globDenied = await denied(() => globSearch("*.ts", p, { workspace: WS }));
      const grepDenied = await denied(() => grepSearch("KEY", p, undefined, { workspace: WS }));
      expect(
        { p, readDenied, writeDenied, globDenied, grepDenied },
        `读侧三处必须与写侧同一判定，且判定必须是"工作区内才放行"（${p}）`,
      ).toEqual({ p, readDenied: want, writeDenied: want, globDenied: want, grepDenied: want });
    }
  });

  it("T2-F: 相对路径按工作区解析，且**检查与动作是同一个路径**", async () => {
    installTauriMock();

    // 1) 工作区内的相对路径：放行，并且真的按工作区去读（不是进程 cwd）
    const body = await readFile("src/a.ts", { workspace: WS });
    expect(body).toBe(SECRET_BODY);
    const read = invokes.find((i) => i.command === "read_file");
    expect(read?.args?.path, "★ 传给 IPC 的必须是解析后的绝对路径").toBe(`${WS}/src/a.ts`);

    // 2) `..` 逃出工作区的相对路径：照旧被拒
    await expect(readFile("../outside.ts", { workspace: WS })).rejects.toThrow(/outside the workspace/i);

    // 3) 搜索路径给 "."（或省略）时以工作区为基准 —— 不许被解析到工作区外造成假失败
    installTauriMock();
    await globSearch("*.ts", ".", { workspace: WS });
    const glob = invokes.find((i) => i.command === "glob_search");
    expect(String(glob?.args?.path).replace(/\\/g, "/").replace(/\/\.$/, ""), "搜索基准必须是工作区").toBe(WS);

    installTauriMock();
    await grepSearch("KEY", ".", undefined, { workspace: WS });
    const grep = invokes.find((i) => i.command === "execute_command");
    const norm = (s: unknown) => String(s).replace(/\\/g, "/").replace(/\/+$/, "");
    expect(norm(grep?.args?.command).includes(norm(WS)), "grep 的搜索基准必须是工作区").toBe(true);

    // 4) 没有 workspace 时**不做**解析（应用自管读写的既有语义不变）
    installTauriMock();
    await readFile("relative/app-file.json");
    expect(invokes.find((i) => i.command === "read_file")?.args?.path).toBe("relative/app-file.json");
  });

  /**
   * ★ 误拒修复的**反向**判据：沙箱**关** ⇒ 同一批越界路径必须**成功**。
   *
   * 只有 T2-A..T2-F（开 ⇒ 拒）是不够的：一个**无条件拦**的实现也能让它们全绿 ——
   * 那正是本次要修的缺陷形态（用户点名：「关了沙箱后沙箱还是生效，导致项目读写出问题」）。
   * 所以这里把**同一批路径**在两个方向下各跑一次，并要求结果相反。
   *
   * 顺带把 `glob` 的两个越界判据（`checkSearchPathWithinWorkspace` 的搜索路径 +
   * `assertGlobPatternWithinWorkspace` 的模式）也钉成"以开关为前提"：
   * `sdk.glob` / `sdk.grep` 关闭时必须真的发出底层搜索 IPC。
   */
  it("T2-G（反向对照）: 沙箱**关** ⇒ 同一批越界读/搜/写必须成功（关了就真的关）", async () => {
    setSandboxAclEnabled(false);
    __resetSandboxSettingCache();

    // ① 越界读
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.read(SECRET_PATH)) as never);
    const readOut = await createRunCodeTool().execute({ code: "await sdk.read(p)" }, ctx());
    expect(readOut.output, "关闭时越界读不许被误拒").not.toMatch(/outside the workspace/i);
    expect(readOut.output, "内容必须真的拿到").toContain("SUPER-SECRET");
    expect(invokes.some((i) => i.command === "read_file"), "底层读必须真的发生").toBe(true);

    // ② 越界 glob（搜索路径 + 含 `..` 的模式两条路都必须在关闭时放行）
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.glob("*.ts", "C:/elsewhere").then(() => "ok")) as never);
    const globOut = await createRunCodeTool().execute({ code: "await sdk.glob()" }, ctx());
    expect(globOut.output, "关闭时越界 glob 不许被误拒").not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "glob_search"), "底层搜索必须真的发出").toBe(true);

    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.glob("../outside/*.ts", ".").then(() => "ok")) as never);
    const patternOut = await createRunCodeTool().execute({ code: "await sdk.glob()" }, ctx());
    expect(patternOut.output, "关闭时含 `..` 的 glob 模式不许被误拒").not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "glob_search"), "底层搜索必须真的发出").toBe(true);

    // ③ 越界 grep
    installTauriMock();
    __setScriptRunnerForTests(
      runnerCalling((sdk) => sdk.grep("KEY", { path: "C:/elsewhere" }).then(() => "ok")) as never,
    );
    const grepOut = await createRunCodeTool().execute({ code: "await sdk.grep()" }, ctx());
    expect(grepOut.output, "关闭时越界 grep 不许被误拒").not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "execute_command"), "底层搜索必须真的发出").toBe(true);

    // ④ 越界写（`write_file` 的 IPC 参数里带着开关，Rust 侧据此决定拦不拦）
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.write(OUTSIDE_WRITE, "x")) as never);
    const writeOut = await createRunCodeTool().execute({ code: "await sdk.write(p)" }, ctx());
    expect(writeOut.output, "关闭时越界写不许被误拒").not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "write_file"), "底层写必须真的发生").toBe(true);

    // ★ 同一批路径、两个方向、结果必须相反
    setSandboxAclEnabled(true);
    __resetSandboxSettingCache();
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.read(SECRET_PATH)) as never);
    const onOut = await createRunCodeTool().execute({ code: "await sdk.read(p)" }, ctx());
    expect(onOut.output, "沙箱开启时同一路径必须被拒").toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "read_file")).toBe(false);
  });
});
