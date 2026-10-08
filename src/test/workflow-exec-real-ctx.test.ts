/**
 * ★ 第 185 波 T6 判据：`execWorkflow`（provider 路径）必须把**真实 ctx** 传给工具。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T6）
 *
 * `workflow-engine.ts` 的 `execWorkflow` 原来是 `tool.execute({ code, timeout_ms }, {} as any)`
 * —— **空对象**，于是工具内部三个读点全读到 `undefined`：
 *
 * - `sdk.bash` → `executeCommand(command, undefined, 60_000)`：命令在默认 cwd 下执行
 *   （相对路径落错地方）；
 * - `sdk.write` → `writeFile(path, content, { workspace: undefined })` ⇒ `file-api.ts` 的
 *   `if (options?.workspace)` 为假 ⇒ **S5 沙箱检查整条不做**（受保护路径与覆盖确认仍在，
 *   所以是"沙箱这一道被静默摘掉"）；
 * - `sdk.spawn` → `parentSessionId: undefined`。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | `T6-A` | workflow 里 `sdk.write` 到工作区外 ⇒ **被沙箱拒绝**（改动前静默写下去） |
 * | `T6-B` | `sdk.bash` 拿到的 cwd 就是调用方给的 cwd（不许丢成 undefined） |
 * | `T6-C` | `sdk.spawn` 拿到的 `parentSessionId` 就是调用方给的 sessionId |
 * | `T6-D` | 反向对照：工作区内的 `sdk.write` 照旧成功（不是"一律拒绝"） |
 *
 * ## ★ 误拒修复后的必要前置：**显式打开沙箱**
 *
 * `T6-A` 钉的是「沙箱**开启**时越界写被拒」。`file-api.ts` 的判定改后**看开关**
 * （改前只看"有没有给 workspace"—— 那正是用户点名的误拒缺陷：「关了沙箱沙箱还是生效」），
 * 所以这里必须显式开开关，否则测的是全访问模式。
 * **另一个方向**（关 ⇒ 越界必须成功）见 `sandbox-mode-consistency.test.ts` 的 SB-OFF-1/2。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { __resetSandboxSettingCache, setSandboxAclEnabled } from "../core/sandbox/sandbox-acl";

/** 记录 spawn 收到的父会话 id（`sdk.spawn` 内部动态 import 这个模块）。 */
let spawnedParentSessionId: string | undefined;
vi.mock("../core/subagent/index", () => ({
  getSubagentRuntime: () => ({
    startContinuable: async (req: { request?: { parentSessionId?: string } }) => {
      spawnedParentSessionId = req?.request?.parentSessionId;
      return { childId: "child-t6", messageId: "m-t6" };
    },
  }),
}));

import { execWorkflow } from "../core/llm/workflow-engine";
import { __setScriptRunnerForTests } from "../core/llm/tools/run-code";

const WS = "C:/ws";
const OUTSIDE = "C:/outside/escape.txt";

let invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installTauriMock() {
  invokes = [];
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (command === "read_file") throw new Error("ENOENT: no such file");
        if (command === "execute_command") return { stdout: "bash-ok", stderr: "", exitCode: 0 };
        return null;
      }),
    },
  };
}

/** 注入式脚本前端：替"脚本"调用一次 sdk 方法，错误如实带回（不需要 Rust 引擎）。 */
function runnerCalling(fn: (sdk: any) => Promise<unknown>) {
  return async ({ sdk }: { sdk: any }) => {
    try {
      const value = await fn(sdk);
      return { ok: true, value: value === undefined ? null : String(value), stdout: "", stderr: "" };
    } catch (e: any) {
      return { ok: false, error: JSON.stringify({ message: String(e?.message ?? e) }), stdout: "", stderr: "" };
    }
  };
}

beforeEach(() => {
  installTauriMock();
  spawnedParentSessionId = undefined;
  // 本文件钉的是「沙箱**开** ⇒ 越界写被拒」这一个方向（见文件头的说明）
  setSandboxAclEnabled(true);
  __resetSandboxSettingCache();
});

afterEach(() => {
  __setScriptRunnerForTests(null);
  setSandboxAclEnabled(false);
  __resetSandboxSettingCache();
});

describe("第 185 波 T6：provider 路径的 workflow 必须带真实 ctx", () => {
  it("T6-A: workflow 里 sdk.write 到工作区外 ⇒ 被沙箱拒绝（不许静默写出去）", async () => {
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.write(OUTSIDE, "x")) as never);

    const out = await execWorkflow("await sdk.write(p, 'x')", {
      cwd: WS,
      sessionId: "s-t6",
      securityMode: "auto",
    });

    expect(out, "★ 沙箱检查必须在写盘之前生效").toMatch(/outside the workspace/i);
    expect(
      invokes.some((i) => i.command === "write_file"),
      "★ 被拒的写不该真的落到 IPC（改动前它会一路写出去）",
    ).toBe(false);
  });

  it("T6-B: sdk.bash 拿到的 cwd 就是调用方给的 cwd", async () => {
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.bash("echo hi")) as never);

    await execWorkflow("await sdk.bash('echo hi')", { cwd: WS, sessionId: "s-t6" });

    const exec = invokes.find((i) => i.command === "execute_command");
    expect(exec, "命令必须真的发出去了").toBeTruthy();
    expect(exec!.args?.cwd, "★ 丢 cwd 会让相对路径落错地方").toBe(WS);
  });

  it("T6-C: sdk.spawn 拿到的 parentSessionId 就是调用方给的 sessionId", async () => {
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.spawn("explore", "find things")) as never);

    await execWorkflow("await sdk.spawn('explore', 'find things')", {
      cwd: WS,
      sessionId: "session-t6-xyz",
    });

    expect(spawnedParentSessionId, "★ 子智能体的父会话必须是真的那一个").toBe("session-t6-xyz");
  });

  it("T6-D: 反向对照 —— 工作区内的 sdk.write 照旧成功", async () => {
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.write(`${WS}/ok.txt`, "x")) as never);

    const out = await execWorkflow("await sdk.write(p, 'x')", {
      cwd: WS,
      securityMode: "auto",
    });

    expect(out).not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "write_file")).toBe(true);
  });

  /**
   * ★ 误拒修复的**反向**判据：沙箱**关** ⇒ 同一组越界路径必须**成功**。
   *
   * 只有 `T6-A`（开 ⇒ 拒）是不够的：一个**无条件拦**的实现也能让 `T6-A` 全绿 ——
   * 那正是本次要修的缺陷形态（用户点名：「关了沙箱后沙箱还是生效，导致项目读写出问题」）。
   * 所以这里把**同一路径**在两个方向下各跑一次，并要求结果相反。
   */
  it("T6-E（反向对照）: 沙箱**关** ⇒ 工作区外的 sdk.write 必须成功（关了就真的关）", async () => {
    setSandboxAclEnabled(false);
    __resetSandboxSettingCache();
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.write(OUTSIDE, "x")) as never);

    const off = await execWorkflow("await sdk.write(p, 'x')", { cwd: WS, securityMode: "auto" });
    expect(off, "沙箱关闭时工作区外的写不许被误拒").not.toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "write_file"), "底层写必须真的发出").toBe(true);

    // ★ 同一路径、两个方向、结果必须相反
    setSandboxAclEnabled(true);
    __resetSandboxSettingCache();
    installTauriMock();
    __setScriptRunnerForTests(runnerCalling((sdk) => sdk.write(OUTSIDE, "x")) as never);

    const on = await execWorkflow("await sdk.write(p, 'x')", { cwd: WS, securityMode: "auto" });
    expect(on, "沙箱开启时同一路径必须被拒").toMatch(/outside the workspace/i);
    expect(invokes.some((i) => i.command === "write_file")).toBe(false);
  });
});
