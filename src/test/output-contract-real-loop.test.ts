/**
 * 第 97 波：**声明了 `outputSchema` 的工具，在真实循环里不许被误判成「没给 value」**。
 *
 * ## 缺陷形态（真机实测，不是推测）
 *
 * 最近 12 个会话的工具健康度（`.preview-shot/_probe-tool-health.mjs`，按事件顺序配对）：
 *
 * ```
 *   bash      46 次调用 → 42 error（其中 32 条是「缺 value」）
 *   read      11 次调用 →  8 error（8 条都是「缺 value」）
 *   glob       7 次调用 →  7 error（7 条都是「缺 value」）
 *   grep       2 次调用 →  2 error（2 条都是「缺 value」）
 *   terminal_* 0 error（它们没声明 outputSchema）
 * ```
 *
 * 模型看到的是 `Error: bash declared outputSchema but returned no \`value\``——一条**内部话术**，
 * 于是它会放弃 bash、绕道 `terminal_send`（真机会话里 81 次 terminal_send 就是这么来的），
 * 或者干脆宣布做不到。**四个主力工具在真机上等于废掉。**
 *
 * ## 根因
 *
 * `agentic-loop.ts` 交给执行器的 **execute 层 handler** 在返回时**重建了结果对象**，
 * 只带 `id/name/input/output/status/metadata` —— 把工具自己产出的 `value`（结构化值）**丢了**。
 * 而 `tool-pipeline.ts` 的 `OutputContractValidationMiddleware` 正是靠 `result.value` 做校验：
 * 声明了契约却没值 ⇒ 判为「实现漏了」并把**成功结果改写成 error**。
 *
 * 为什么既有 e2e 判据没抓到：`tool-contract-pipeline-e2e.test.ts` 的夹具 handler 自己写了
 * `value: out.value`（测试比生产"更对"）—— 判据长在一条**生产里不执行**的链路上（本文件 §5.2 第 1 条）。
 *
 * ## 判据（驱动**真实循环**，断言**模型实际收到的请求**）
 *
 * 造一个声明了 `outputSchema` 的探针工具，让它返回 `value`；跑一轮真实循环；
 * 断言模型收到的工具结果是**渲染后的文本**，且**不含**那句契约错误。
 * 前置还断言 `bash` / `read` / `glob` / `grep` 四个真工具确实声明了 `outputSchema`
 * （否则本判据覆盖不到它们）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

const CWD = "C:\\output-contract";
const SESSION = "test-output-contract-session";
const PROBE = "contract_probe";

/** 脚本化 provider：记下每个请求（判据就是"模型实际收到了什么"） */
class RecordingProvider {
  id = "output-contract-provider";
  name = "Output Contract Mock";
  requests: any[] = [];
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift();
    if (!script) throw new Error("脚本耗尽（不该发生的额外调用）");
    for (const item of script) {
      if (item instanceof Error) throw item;
      yield item;
    }
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 第 1 轮：调用探针工具 ⇒ 循环进入第 2 轮（工具结果会出现在第 2 个请求里） */
function probeIteration(): any[] {
  const id = "call_probe";
  return [
    { type: "tool_use_start", id, name: PROBE },
    { type: "tool_use_delta", id, input: JSON.stringify({ note: "go" }) },
    { type: "tool_use_end", id, input: { note: "go" } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/** 注册一个**声明了 outputSchema 且真的给了 value** 的探针工具 */
function registryWithContractProbe() {
  const registry = createDefaultToolRegistry();
  registry.register({
    id: PROBE,
    description: "测试探针：声明 outputSchema 并返回结构化 value",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: [] },
    contract: {
      readOnly: true,
      sideEffectScope: "none",
      accessScope: "none",
      persistResult: false,
      outputSchema: {
        type: "object",
        properties: { n: { type: "number" }, label: { type: "string" } },
        required: ["n", "label"],
        additionalProperties: false,
      },
      // 渲染与旧行为同形：注册契约不该改变模型看到的东西
      renderOutput: (v: any) => `rendered:${v.label}:${v.n}`,
    },
    async execute() {
      return { title: "probe", output: "RAW-OUTPUT-SHOULD-BE-REPLACED", value: { n: 7, label: "ok" } };
    },
  } as any);
  return registry;
}

function allToolText(request: any): string {
  return (request?.messages ?? [])
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
}

describe("第 97 波：真实循环里 outputSchema 的校验不许把成功结果改写成错误", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("前置：四个主力工具确实声明了 outputSchema（否则这条判据覆盖不到它们）", () => {
    const registry = createDefaultToolRegistry();
    for (const name of ["bash", "read", "glob", "grep"]) {
      expect(
        registry.getRawContract(name)?.outputSchema,
        `${name} 应当声明了 outputSchema —— 若哪天不声明了，本判据的覆盖面要重新评估`,
      ).toBeTruthy();
    }
  });

  it("OUTCON-1: 声明了 outputSchema 且给了 value 的工具，模型必须收到**渲染后的结果**", async () => {
    const provider = new RecordingProvider();
    provider.setScript([probeIteration(), finalIteration("第二轮")]);

    const loop = new AgenticLoop(provider as any, registryWithContractProbe(), {
      maxIterations: 4,
      model: "contract-model",
      securityMode: "full",
    });
    const events: any[] = [];
    for await (const e of loop.run(SESSION, "跑一下探针", CWD, "system prompt")) events.push(e);

    expect(provider.requests.length, "前置：探针调用必须把循环推进到第 2 轮").toBeGreaterThanOrEqual(2);

    /**
     * 判据落在**循环交给下游的那条结果**上（`tool_complete` 的 `toolCall.result`）——
     * 它就是模型与界面看到的东西，也是契约校验的产物。
     */
    const completed = events.find((e) => e.type === "tool_complete" && e.toolCall?.name === PROBE);
    expect(completed, "前置：事件流里必须有探针的 tool_complete").toBeTruthy();
    const result = completed.toolCall.result;

    expect(
      String(result?.output ?? ""),
      "工具产出了 value 却被告知没给 —— 这正是真机上 bash/read/glob/grep 全废的那条错误",
    ).not.toContain("declared outputSchema but returned no");
    expect(result?.status, "有合法 value 的调用必须判成 completed").toBe("completed");
    expect(String(result?.output ?? ""), "模型应当看到 renderOutput 的产物").toContain("rendered:ok:7");
    expect(String(result?.output ?? ""), "占位文本不该漏出去").not.toContain("RAW-OUTPUT-SHOULD-BE-REPLACED");
    expect(result?.value, "结构化 value 必须一路透传到下游（UI/微压缩/结构化消费都靠它）").toEqual({ n: 7, label: "ok" });
  });

  it("OUTCON-3: 真实 read/glob/grep 的失败路径必须显式 isError（否则被报成 completed）", async () => {
    // 用真实工具 + 真实文件 API 的桩：read_file_lines 直接抛"找不到文件"，
    // 与真机上 Rust 侧返回的错误同形（文本判据见 file-api/session-jsonl 的既有说明）。
    const w = globalThis as unknown as Record<string, unknown>;
    const original = w.__TAURI__;
    w.__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          if (command === "get_app_data_dir") return "C:\\appdata\\";
          throw new Error(`系统找不到指定的文件。 (os error 2) [${command}]`);
        },
      },
    };
    try {
      const registry = createDefaultToolRegistry();
      for (const name of ["read", "glob", "grep"]) {
        const tool = registry.get(name)!;
        const args = name === "read" ? { path: "C:\\definitely\\missing.txt" } : { pattern: "*.ts" };
        const res: any = await tool.execute(args as any, { cwd: "C:\\definitely", sessionId: "s-criterion" } as any);
        expect(String(res.output), `${name}: 失败文本要留下`).toMatch(/Error/);
        expect(res.isError, `${name}: 失败必须**显式**声明 isError —— 它们是内容型工具，不会被文本推断`).toBe(true);
      }
    } finally {
      if (original === undefined) delete w.__TAURI__;
      else w.__TAURI__ = original;
    }
  });
});
