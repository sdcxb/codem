/**
 * ★ 第 185 波 T1 判据：**进程级单例的装配必须幂等，且闸门回调来自当轮调用上下文**。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T1）
 *
 * 工具管线是**进程级单例**，而主会话与每个子智能体各持一个 `AgenticLoop`
 * （`index.ts` 的 `getAgenticLoop(agentId, sessionId, scopedTools)` 带
 * `toolRegistryOverride` ⇒ 与主 loop 是两个实例）。改动前每个 loop 在自己回合开头都调
 * `initDefaultPipeline(...)`，而它**第一步是 `clear()`**：
 *
 * 1. `clear()` 到重装完成之间有一个**真实的挂起窗口**（唯一的 `await` 是
 *    `await import("./spill-policy")`）⇒ 撞上它的调用拿到的管线**缺层**
 *    （权限/守卫已在，溢出与 EventLog **一层都没跑** ⇒ 连 `tool_result` 事件都不落）；
 * 2. 即使没撞上窗口，守卫读的也是**最后初始化那个 loop 的闭包** ⇒ 主 loop 的调用
 *    落到子智能体的 `checkPermission` 上，而子智能体通常没有 `onPermissionRequest`
 *    ⇒ 按 fail-closed 被拒（**本该弹的确认框永远不弹**）；计划模式 / 沙箱开关同样互相覆盖。
 *
 * ## 判据（全部**行为**：驱动真实单例管线，读它吐出的结果与事件）
 *
 * | id | 钉什么 | 改前会怎样 |
 * |---|---|---|
 * | `T1-A` | 权限处理器来自**当轮** `ctx.pipelineHost`（不是最后初始化那个 loop 的闭包） | 红：闭包那份被判、当轮那份一次没被调用 |
 * | `T1-A2` | 计划模式开关同理 | 红：按闭包判 |
 * | `T1-A3` | 沙箱开关与"在不在工作区内"同理 | 红：按闭包判 |
 * | `T1-B` | 与**首次装配并发**发出的调用：闸门照旧生效 + `tool_result` 照旧落 | 红：装配中的 await 窗口里 finalize 层是空的 ⇒ 事件丢失 |
 * | `T1-C` | 多个 loop **并发**初始化之后再调用：闸门照旧（不因"最后一次初始化"而变） | 红：最后一次 init 把管线重新指向别人的闭包 |
 *
 * ⚠️ 事件日志用记录式假实现（与 `tool-pipeline-finalize-all-exits.test.ts` 同一手法）——
 * 这里要判的是"管线有没有真的写到事件"，不是数据库能不能写。
 */
import { describe, it, expect, vi } from "vitest";

/** 记录式假事件日志 */
const appended: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }> = [];
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({
    append: (sessionId: string, type: string, payload: Record<string, unknown>) => {
      appended.push({ sessionId, type, payload });
      return { seq: appended.length, sessionId, type, payload };
    },
  }),
}));

import {
  initDefaultPipeline,
  getToolPipeline,
  type ToolPipelineHost,
} from "../core/llm/tool-pipeline";
import type { ToolExecutorContext } from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

/** 一个"够用的"宿主：默认全放行，按需覆盖。 */
function host(overrides: Partial<ToolPipelineHost> = {}): ToolPipelineHost {
  return {
    isPlanMode: () => false,
    isSandboxEnabled: () => false,
    isPathWithinWorkspace: () => true,
    checkPermission: async () => ({ allowed: true }),
    ...overrides,
  };
}

/** 调用上下文：`pipelineHost` 就是"这一轮是谁在调"（缺省表示只依赖兜底宿主）。 */
function ctx(pipelineHost?: ToolPipelineHost, cwd = "C:/proj"): ToolExecutorContext {
  return {
    sessionId: "s-t1",
    messageId: "m-t1",
    cwd,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    ...(pipelineHost ? { pipelineHost } : {}),
  } as ToolExecutorContext;
}

const handler = async (
  name: string,
  args: Record<string, unknown>,
  c: ToolExecutorContext,
): Promise<ToolCallResult> => ({
  id: typeof c.toolCallId === "string" ? c.toolCallId : "",
  name,
  input: args,
  output: "written",
  status: "completed",
});

function toolResults(id: string) {
  return appended.filter((a) => a.type === "tool_result" && a.payload.toolCallId === id);
}

describe("第 185 波 T1：单例管线的装配幂等 + 闸门来自当轮上下文", () => {
  /**
   * ⚠️ 本用例必须是**本文件里第一次**触发装配的用例：它要判"首次装配期间并发发出的调用"。
   */
  it("T1-B: 与首次装配并发发出的调用 —— 闸门照旧生效，tool_result 照旧落（装配不得有挂起点）", async () => {
    appended.length = 0;

    /** 装配（首次）：拒绝一切写操作 —— 装配与下面那次调用**并发**。 */
    const installing = initDefaultPipeline(
      host({
        checkPermission: async () => ({ allowed: false, denyMessage: "T1-B-DENIED" }),
        maxInlineBytes: 32768,
      }),
    );

    /**
     * 这一行在 `installing` 恢复之前执行（同步段之后立刻发调用）。
     * 用 **ctx 里的当轮宿主** 而不是兜底：这条同时排除"兜底宿主还没登记"的干扰。
     */
    const perCall = host({
      checkPermission: async () => ({ allowed: false, denyMessage: "T1-B-DENIED" }),
    });
    const { result } = await getToolPipeline().execute(
      "write",
      { path: "C:/proj/a.ts", content: "x" },
      ctx(perCall),
      handler,
    );
    await installing;

    expect(result.status, "闸门必须生效（装配窗口里不许出现无闸门的执行）").toBe("error");
    expect(String(result.output)).toContain("T1-B-DENIED");
    expect(
      toolResults("m-t1").length,
      "★ finalize 层也必须在装配窗口里就位：否则同一次调用既没有事件、界面还会停在 running",
    ).toBe(1);
    expect(String(toolResults("m-t1")[0].payload.status)).toBe("error");
  });

  it("T1-A: 权限处理器来自**当轮** ctx.pipelineHost（不是最后初始化那个 loop 的闭包）", async () => {
    const calledByA: string[] = [];
    const calledByB: string[] = [];

    /** 最后初始化的是 A（它的闭包"接管"了单例）—— 这正是改动前的形态。 */
    await initDefaultPipeline(
      host({
        checkPermission: async () => {
          calledByA.push("A");
          return { allowed: false, denyMessage: "A-DENIED" };
        },
      }),
    );

    /** 这一轮调用其实属于 B（另一个 loop）。 */
    const b = host({
      checkPermission: async () => {
        calledByB.push("B");
        return { allowed: true };
      },
    });

    const { result } = await getToolPipeline().execute(
      "write",
      { path: "C:/proj/b.ts", content: "x" },
      ctx(b),
      handler,
    );

    expect(calledByB, "当轮的权限处理器必须被调用").toEqual(["B"]);
    expect(calledByA, "★ 别人的权限处理器一次都不许被调用（否则确认框弹不出来 / 被 fail-closed 静默拒绝）").toEqual([]);
    expect(result.status).toBe("completed");
  });

  it("T1-A2: 计划模式开关同理（当轮说 plan ⇒ 拦下；兜底那份说 default）", async () => {
    await initDefaultPipeline(host({ isPlanMode: () => false }));

    const { result } = await getToolPipeline().execute(
      "write",
      { path: "C:/proj/c.ts", content: "x" },
      ctx(host({ isPlanMode: () => true })),
      handler,
    );

    expect(result.status, "★ 当轮处于计划模式 ⇒ 写操作必须被拦").toBe("error");
    expect(String(result.output)).toMatch(/Plan mode/i);
  });

  it("T1-A3: 沙箱开关与工作区判定同理（当轮开沙箱 ⇒ 工作区外被拒；兜底那份是关的）", async () => {
    await initDefaultPipeline(host({ isSandboxEnabled: () => false }));

    const { result } = await getToolPipeline().execute(
      "write",
      { path: "C:/outside/secret.txt", content: "x" },
      ctx(
        host({
          isSandboxEnabled: () => true,
          isPathWithinWorkspace: (p, cwd) =>
            p.replace(/\\/g, "/").toLowerCase().startsWith(cwd.replace(/\\/g, "/").toLowerCase()),
        }),
      ),
      handler,
    );

    expect(result.status, "★ 当轮开着沙箱 ⇒ 工作区外写入必须被拒").toBe("error");
    expect(String(result.output)).toMatch(/outside the workspace/i);
  });

  it("T1-C: 多个 loop 并发初始化之后再调用 —— 闸门不因「最后一次初始化」而换人", async () => {
    const calls: string[] = [];
    const loopA = host({
      checkPermission: async () => {
        calls.push("A");
        return { allowed: false, denyMessage: "A-DENIED" };
      },
    });
    const loopB = host({
      checkPermission: async () => {
        calls.push("B");
        return { allowed: false, denyMessage: "B-DENIED" };
      },
    });
    await Promise.all([initDefaultPipeline(loopA), initDefaultPipeline(loopB)]);

    /** 第三轮调用（属于 loop C）：它必须走自己的处理器。 */
    const c = host({
      checkPermission: async () => {
        calls.push("C");
        return { allowed: false, denyMessage: "C-DENIED" };
      },
    });
    const { result } = await getToolPipeline().execute(
      "write",
      { path: "C:/proj/d.ts", content: "x" },
      ctx(c),
      handler,
    );

    expect(calls, "只许调用当轮那一份，A/B 的处理器都不许被碰到").toEqual(["C"]);
    expect(String(result.output)).toContain("C-DENIED");
  });
});
