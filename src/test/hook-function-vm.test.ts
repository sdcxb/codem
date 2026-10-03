/**
 * 第 103 波：**函数型钩子已迁到 QuickJS/WASM**（不再用 `new Function`）。
 *
 * ## 为什么这是必须的（真机事实）
 *
 * 装好的应用里 CSP 没有 `unsafe-eval`，所以 `new Function("ctx", hook.function)` 在真机上
 * **直接抛 CSP 违规** ⇒ 函数型钩子**根本没生效**。而钩子是守卫：
 * "守卫没生效"意味着"该拦的没拦"（这类缺陷在本仓叫假成功/假安全，出过多次）。
 *
 * ## 判据
 *
 * · HOOKVM-1：把全局 `Function`/`eval` 换成会抛的桩之后，函数型钩子**仍然按判据工作**；
 * · HOOKVM-2：钩子体里看不到应用全局（`window`/`process`/`__TAURI__`），但 `ctx` 拿得到；
 * · HOOKVM-3：钩子里的死循环被**超时打断**，且 PreToolUse 侧 **fail-closed**（默认拦下）——
 *   旧实现里这一条会让整个应用卡死；
 * · HOOKVM-4：返回值语义没变（未识别 action 仍然拦下，不是静默放行）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookDefinition, HookContext } from "../core/hooks/hook-types";

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn(() => ({ hooks: [] })),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
}));

const ctx: HookContext = {
  sessionId: "s1",
  toolName: "bash",
  input: { command: "echo hi" },
  cwd: "C:/proj",
};

function functionHook(body: string, extra: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: `h-${Math.random().toString(36).slice(2)}`,
    event: "PreToolUse",
    name: "guard",
    type: "function",
    function: body,
    enabled: true,
    condition: { tool: "bash" },
    ...extra,
  };
}

async function runPreTool(hook: HookDefinition) {
  const { getHookManager, resetHookManager } = await import("../core/hooks/hook-manager");
  resetHookManager();
  const manager = getHookManager();
  manager.setEnabled(true);
  manager.setSubAgentMode(false);
  manager.addHook(hook);
  return manager.executePreToolHooks("bash", { command: "echo hi" }, {
    ...ctx,
    input: { command: "echo hi" },
  });
}

/** 把 `Function` / `eval` 换成"一用就抛"的桩（证明执行路径不依赖它们） */
function stubOutEval() {
  const originalFunction = globalThis.Function;
  const originalEval = globalThis.eval;
  const boom = () => {
    throw new Error("CSP: 'unsafe-eval' is not allowed");
  };
  // @ts-expect-error 故意替换
  globalThis.Function = function Blocked() {
    boom();
  };
  // @ts-expect-error 故意替换
  globalThis.eval = boom;
  return () => {
    globalThis.Function = originalFunction;
    globalThis.eval = originalEval;
  };
}

describe("第 103 波：函数型钩子跑在 JS VM 里（不依赖 eval）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("HOOKVM-1: 全局 Function/eval 被桩掉之后，函数型钩子仍然按判据裁决", async () => {
    const restore = stubOutEval();
    try {
      const result = await runPreTool(
        functionHook(`return ctx.input.command.includes("echo") ? { action: "allow" } : { action: "deny", denyMessage: "not echo" };`),
      );
      expect(result?.action).toBe("allow");
    } finally {
      restore();
    }
  });

  it("HOOKVM-2: 钩子体里看不到应用全局，但 ctx 拿得到（JSON 注入）", async () => {
    const result = await runPreTool(
      functionHook(
        `const exposed = [typeof window, typeof document, typeof process, typeof globalThis.__TAURI__, typeof require].join(",");
         const sawCtx = ctx && ctx.toolName === "bash" && ctx.input.command === "echo hi";
         return sawCtx && exposed === "undefined,undefined,undefined,undefined,undefined"
           ? { action: "allow" }
           : { action: "deny", denyMessage: "exposed=" + exposed + " sawCtx=" + sawCtx };`,
      ),
    );
    expect(result?.action, result?.denyMessage).toBe("allow");
  });

  it("HOOKVM-3: 钩子里的死循环被超时打断，且 PreToolUse **fail-closed**（旧实现会卡死应用）", async () => {
    const started = Date.now();
    const result = await runPreTool(functionHook(`while (true) {}`, { timeoutMs: 800 }));
    const elapsed = Date.now() - started;
    expect(result?.action, "守卫跑不起来时必须拦下").toBe("deny");
    expect(String(result?.denyMessage)).toMatch(/超时|timed out|threw/i);
    expect(elapsed, `应当 ~0.8s 返回，实际 ${elapsed}ms`).toBeLessThan(6000);
  });

  it("HOOKVM-4: 返回未识别的 action 仍然拦下（第 84 波的语义没被迁移改掉）", async () => {
    const result = await runPreTool(functionHook(`return { action: "denied" };`));
    expect(result?.action).toBe("deny");
    expect(String(result?.denyMessage)).toMatch(/unrecognized action/i);
  });

  it("HOOKVM-5: 钩子里抛错 → 默认 fail-closed；allowOnError 才放行", async () => {
    const denied = await runPreTool(functionHook(`throw new Error("inner failure");`));
    expect(denied?.action).toBe("deny");

    const allowed = await runPreTool(functionHook(`throw new Error("inner failure");`, { allowOnError: true }));
    expect(allowed?.action).toBe("allow");
  });
});
