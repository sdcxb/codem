/**
 * WF-GLOB-5：`sdk.glob` 的越界判定必须**跟着沙箱开关走**（两个方向都要绿）。
 *
 * ## 为什么这份判据必须存在（用户亲自提醒的历史 bug）
 *
 * 第 185 波（T2）给 `sdk.read/write/glob/grep`、lsp、关键词搜索、seam provider 都补上了
 * 「把工作区传下去」—— 但 `file-api.ts:92` 的 `assertWithinWorkspace()` **只看"有没有传 workspace"，
 * 不看沙箱开关**（`if (!workspace) return;`），而 `tools.ts:219` 的 `checkSandbox()` 才是
 * **看开关**的那份实现（`getSetting("codem-sandbox-enabled") !== "true"` ⇒ 放行）。
 *
 * 后果（用户报的现象）：**沙箱关闭（全访问）时，读写工作区外文件被误拒** ——
 * 也就是「关了沙箱，沙箱还在生效，项目读写出问题」。
 *
 * ## 本文件钉的两个方向
 *
 * | # | 钉什么 |
 * |---|---|
 * | `WF-GLOB-5a` | 沙箱**开** + 越界搜索路径 ⇒ **被拒**（错误说清在工作区外），且底层 `glob_search` 一个都不发 |
 * | `WF-GLOB-5b` | 沙箱**关** + **同一个**越界调用 ⇒ **必须成功**（不许误拒）；底层 `glob_search` 真的发出 |
 * | `WF-GLOB-5c` | 反向对照：工作区**内**的搜索在两种模式下都成功（不许"一律拒绝"） |
 *
 * ⚠️ 判定逻辑（mode-aware 的 `assertWithinWorkspace`）**不归本层改**（另一条线负责，避免两线冲突）；
 * 本层只保证把 `workspace` 传下去（`WF-GLOB-2`），让那份共用实现有机会做正确的判定。
 * 本文件驱动的是**真实 `file-api` + 真实设置 + 真实 `sdk.glob`**，只把最底层 IPC 换掉。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { SANDBOX_SETTING_KEY, __resetSandboxSettingCache } from "../core/sandbox/sandbox-acl";
import { setSetting, removeSetting } from "../core/storage/settings";
import { createWorkflowTool } from "../core/llm/workflow-engine";
import type { ToolContext, ToolExecuteResult } from "../core/llm/tools";
import { installScriptRunnerDouble, uninstallScriptRunnerDouble } from "./helpers/script-runner-double";

const WS = "C:/ws";
const OUTSIDE = "C:/outside";

const PAYLOAD = {
  files: [`${OUTSIDE}/a.ts`],
  truncated: false,
  depth_limited: false,
  returned: 1,
};

const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installTauriMock(): void {
  invokes.length = 0;
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        // 与写侧同一份判定的替身：词法上在不在工作区里
        if (command === "check_path_in_workspace") {
          const p = String(args?.path ?? "").replace(/\\/g, "/").toLowerCase();
          const ws = String(args?.workspace ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
          return p === ws || p.startsWith(`${ws}/`);
        }
        if (command === "glob_search") return PAYLOAD;
        if (command === "get_default_cwd") return WS;
        return null;
      }),
    },
  };
}

function ctx(): ToolContext {
  return {
    sessionId: "s-wf-glob-sbx",
    messageId: "m-wf-glob-sbx",
    cwd: WS,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    securityMode: "auto",
  } as ToolContext;
}

/**
 * **同一个**越界调用 —— 两个方向共用它，保证"关掉时成功"钉的确实是"开时被拒"的那一次调用。
 *
 * ⚠️ 断言落在**输出文本**上（不是 `isError`）：`workflow` 的 `execute()` 对"脚本内的失败"
 * 一直是 `isError: false` + `output` 里带 `[error]: …`（与 `run_code` 同一形状，
 * 见 `workflow-engine.ts` 的 execute 尾部）。要看的是**拒绝有没有如实说给模型**。
 */
async function runGlob(target: string): Promise<ToolExecuteResult> {
  return await createWorkflowTool().execute(
    // `return` 让完成值走 `[Result]: …`（成功时判据要看拿回来的结构化结果）
    { code: `return JSON.stringify(await sdk.glob('*.ts', ${JSON.stringify(target)}));` },
    ctx(),
  );
}

function setSandbox(enabled: boolean): void {
  // 与设置面板/`checkSandbox` 同一个键、同一个值域（`=== "true"` 才算开）
  if (enabled) setSetting(SANDBOX_SETTING_KEY, "true");
  else setSetting(SANDBOX_SETTING_KEY, "false");
  __resetSandboxSettingCache();
}

function globSearchCalls(): Array<Record<string, unknown>> {
  return invokes.filter((i) => i.command === "glob_search").map((i) => i.args as Record<string, unknown>);
}

beforeEach(() => {
  installScriptRunnerDouble();
  installTauriMock();
});

afterEach(() => {
  uninstallScriptRunnerDouble();
  removeSetting(SANDBOX_SETTING_KEY);
  __resetSandboxSettingCache();
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("WF-GLOB-5：sdk.glob 的越界判定跟着沙箱开关走", () => {
  it("WF-GLOB-5a: 沙箱开 + 越界 ⇒ 被拒，且 glob_search 一个都不发", async () => {
    setSandbox(true);
    expect(
      (await import("../core/storage/settings")).getSetting(SANDBOX_SETTING_KEY),
      "前置：开关确实处于「开」",
    ).toBe("true");

    const out = await runGlob(OUTSIDE);

    expect(out.output, `越界搜索必须如实失败（实际输出：${out.output}）`).toMatch(
      /\[error\][\s\S]*outside the workspace/i,
    );
    expect(globSearchCalls(), "★ 闸门必须在 IPC 之前：越界搜索一个字节都不该被发起").toEqual([]);
  });

  it("WF-GLOB-5b: 沙箱关 + 同一个越界调用 ⇒ 必须成功（不许误拒）", async () => {
    setSandbox(false);
    expect(
      (await import("../core/storage/settings")).getSetting(SANDBOX_SETTING_KEY),
      "前置：开关确实处于「关」（不是读不到）",
    ).toBe("false");

    const out = await runGlob(OUTSIDE);

    /**
     * ★ 这就是用户报的那个 bug 的照妖镜：`assertWithinWorkspace` 若只认「传没传 workspace」，
     * 这里会得到一句 `outside the workspace` 的**误拒** —— 本用例必红。
     */
    expect(
      out.output,
      `★ 沙箱关掉（全访问）时，同一个越界搜索不许被拒 —— 实际输出：${out.output}`,
    ).not.toMatch(/outside the workspace/i);
    expect(out.output, "越界搜索必须真的跑起来并把结果带回来").toContain("a.ts");
    expect(globSearchCalls(), "★ 只有真的放行，底层搜索才会发出").toEqual([
      { pattern: "*.ts", path: OUTSIDE },
    ]);
  });

  it("WF-GLOB-5c: 反向对照 —— 工作区内的搜索在两种模式下都成功", async () => {
    for (const enabled of [true, false]) {
      installTauriMock(); // 清掉上一条的 IPC 记账
      setSandbox(enabled);
      const out = await runGlob(`${WS}/src`);
      expect(
        out.output,
        `开关=${enabled ? "开" : "关"} 时工作区内的搜索都必须照常（不许一律拒绝）：${out.output}`,
      ).not.toMatch(/outside the workspace/i);
      expect(globSearchCalls().length, "工作区内的搜索必须真的发出").toBe(1);
    }
  });
});
