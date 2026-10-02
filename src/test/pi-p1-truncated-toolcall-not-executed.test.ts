/**
 * 被输出上限截断的回复：**工具调用一个都不许执行**（fail closed）。
 *
 * ## 缺陷形态（第 67 波只做了事后提示，不够）
 *
 * 模型一次 `write` 一个大文件 → 参数 JSON 在输出上限处被切断。流式参数由 provider 侧
 * **尽力而为**地收尾解析，于是一个**内容不完整**的调用既能解析、又能校验，
 * 被照旧执行 —— 半个文件写下去、报告成成功。当年的注释自己也承认
 * 「我们不能证明它完整」，处置却只是"执行完了再让模型核对"。
 *
 * 对标 Pi Agent Harness `.preview-shot/_pi-repo/packages/agent/src/agent-loop.ts:471-503`
 * 的 `failToolCallsFromTruncatedMessage`：截断 ⇒ 这批调用**一个都不执行**，
 * 每个各报一条可操作的失败。
 *
 * ## 判据（全部是可观测事实，不看源码文本）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | TRUNC-CALL-A | `finishReason: "length"` + 一个 `write` 调用 | handler **一次都没被调用**、磁盘逐字节不变、tool_error 文案要求"重新发出完整参数" |
 * | TRUNC-CALL-B | 反向对照：同一调用 + `finishReason: "stop"` | handler 被调用、文件真的写了、tool_complete |
 * | TRUNC-CALL-C | 截断回复里 `read` + `write` 两个调用 | **整批**都不执行（不只内容型）——`bash` 的截断命令同样危险 |
 * | TRUNC-CALL-D | 截断回复自动续写预算仍在 | 截断后循环**继续请求**（不是就此收尾） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { createWriteFileTool, type ToolContext, type ToolResult } from "../core/llm/tools";

const SESSION = "pi-p1-truncated-toolcall";
const TOOL_CALL_ID = "call_write_1";

class RecordingProvider {
  id = "pi-p1-provider";
  name = "Pi P1 Mock";
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
    const script = this.queue.shift() ?? [
      { type: "text_delta", text: "（脚本耗尽）" },
      { type: "end", finishReason: "stop" },
    ];
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

let dir: string;
let originalTauri: unknown;
let writeCalls: Array<Record<string, unknown>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-p1-trunc-"));
  writeCalls = [];
  const w = globalThis as unknown as Record<string, unknown>;
  originalTauri = w.__TAURI__;
  w.__TAURI__ = {
    core: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
          case "read_file":
            return existsSync(args.path as string) ? readFileSync(args.path as string, "utf8") : "";
          case "write_file":
            writeCalls.push(args);
            const { writeFileSync, mkdirSync } = await import("node:fs");
            mkdirSync(join(args.path as string, ".."), { recursive: true });
            writeFileSync(args.path as string, args.content as string, "utf8");
            return null;
          default:
            throw new Error(`test stub: unhandled tauri command "${command}"`);
        }
      },
    },
  };
});

afterEach(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  if (originalTauri === undefined) delete w.__TAURI__;
  else w.__TAURI__ = originalTauri;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 注册一个**可观测的** `write`：直接包住真实工具，记下每次 handler 调用。
 * 断言落在"handler 有没有被调用"这个事实上 —— 这正是缺陷的判据
 * （旧实现会带着半截参数调用它）。
 */
function registryWithSpyWrite(calls: Array<{ path: string; content: string }>) {
  const registry = createDefaultToolRegistry();
  const real = createWriteFileTool();
  registry.register({
    ...real,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      calls.push({
        path: String(args.path ?? ""),
        content: String(args.content ?? ""),
      });
      return real.execute(args, ctx);
    },
  } as never);
  return registry;
}

/** 一次 `write` 调用的流式事件；`finishReason` 决定这轮是不是被输出上限截断 */
function writeIteration(path: string, content: string, finishReason: string): any[] {
  return [
    { type: "tool_use_start", id: TOOL_CALL_ID, name: "write" },
    { type: "tool_use_delta", id: TOOL_CALL_ID, input: JSON.stringify({ path, content }) },
    { type: "tool_use_end", id: TOOL_CALL_ID, input: { path, content } },
    { type: "end", finishReason },
  ];
}

async function run(script: any[][], maxIterations = 3) {
  const provider = new RecordingProvider();
  provider.setScript(script);
  const handlerCalls: Array<{ path: string; content: string }> = [];
  const loop = new AgenticLoop(provider as any, registryWithSpyWrite(handlerCalls), {
    maxIterations,
    model: "pi-p1-model",
    securityMode: "full",
  });
  const events: any[] = [];
  for await (const e of loop.run(SESSION, "写一个文件", dir, "system prompt")) events.push(e);
  return { provider, handlerCalls, events };
}

describe("Pi P1：截断回复里的工具调用不许执行（fail closed）", () => {
  it("TRUNC-CALL-A: finishReason=length 的 write → handler 没被调用、磁盘没变、模型收到「重新发出」的失败", async () => {
    const target = join(dir, "half.txt");
    const truncatedContent = "line1\nline2\nline3（这里其实被切断了";
    const { handlerCalls, events } = await run([
      writeIteration(target, truncatedContent, "length"),
      [{ type: "text_delta", text: "重新发一次" }, { type: "end", finishReason: "stop" }],
    ]);

    expect(
      handlerCalls,
      "被输出上限截断的回复里，write 的 handler 一次都不许被调用（旧实现会带着半截参数执行）",
    ).toHaveLength(0);
    expect(writeCalls, "写盘命令一次都不许发出").toHaveLength(0);
    expect(existsSync(target), "磁盘必须逐字节不变 —— 目标文件根本不该出现").toBe(false);

    const errEvents = events.filter((e) => e.type === "tool_error" && e.toolCall?.id === TOOL_CALL_ID);
    expect(errEvents, "每个被拒绝的调用都要有一条结构化失败（isError 语义）给模型看").toHaveLength(1);
    expect(
      errEvents[0].toolCall.status,
      "失败必须是**显式声明**（status=error + isError），不能只写在文本里靠分类器猜",
    ).toBe("error");
    expect((errEvents[0].toolCall as { isError?: boolean }).isError).toBe(true);
    const msg = String(errEvents[0].error);
    expect(msg, "要说清这次**没有执行**").toContain("was not executed");
    expect(msg, "要指出原因是撞到输出上限").toMatch(/output token limit/);
    expect(msg, "要给出可操作的下一步：重新发出完整参数").toContain("Re-issue the tool call with complete arguments");
    expect(msg, "长文件要走分块写入").toMatch(/append: true/);
  });

  it("TRUNC-CALL-B 反向对照：同一个 write + finishReason=stop → 真的执行、文件写下去", async () => {
    const target = join(dir, "full.txt");
    const content = "完整内容\n";
    const { handlerCalls, events } = await run([writeIteration(target, content, "stop")]);

    expect(handlerCalls, "正常结束的回复里 write 必须照旧执行").toHaveLength(1);
    expect(readFileSync(target, "utf8"), "内容要逐字节写下去").toBe(content);
    expect(events.some((e) => e.type === "tool_complete" && e.toolCall?.id === TOOL_CALL_ID)).toBe(true);
  });

  it("TRUNC-CALL-C: 截断回复里的**整批**调用都不执行（不只内容型）", async () => {
    const target = join(dir, "batched.txt");
    const probePath = join(dir, "probe.txt");
    const { handlerCalls, events } = await run([
      [
        { type: "tool_use_start", id: "call_read_1", name: "read" },
        { type: "tool_use_delta", id: "call_read_1", input: JSON.stringify({ path: probePath }) },
        { type: "tool_use_end", id: "call_read_1", input: { path: probePath } },
        { type: "tool_use_start", id: TOOL_CALL_ID, name: "write" },
        { type: "tool_use_delta", id: TOOL_CALL_ID, input: JSON.stringify({ path: target, content: "半截" }) },
        { type: "tool_use_end", id: TOOL_CALL_ID, input: { path: target, content: "半截" } },
        { type: "end", finishReason: "length" },
      ],
      [{ type: "text_delta", text: "重发" }, { type: "end", finishReason: "stop" }],
    ]);

    expect(
      handlerCalls,
      "整批拒绝：只有最后一个调用能被证明是被切的那个，其余同样无法证明完整",
    ).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
    const refused = events.filter((e) => e.type === "tool_error" && /was not executed/.test(String(e.error)));
    expect(refused.map((e: any) => e.toolCall.name).sort(), "两个调用各报一条失败").toEqual(["read", "write"]);
  });

  it("TRUNC-CALL-D: 截断后的自动续写照旧（拒绝执行 ≠ 就此收尾）", async () => {
    const target = join(dir, "resume.txt");
    const { provider, events } = await run([
      writeIteration(target, "半截", "length"),
      [{ type: "text_delta", text: "续写：这次完整了" }, { type: "end", finishReason: "stop" }],
    ]);

    expect(
      provider.requests.length,
      "截断后必须再请求一次（MAX_TRUNCATED_CONTINUATIONS 的自动续写不许被这次改动弄丢）",
    ).toBe(2);
    // 续写提示本身是**可见事件**（同一份文案也会写进消息存储供下一轮读取）。
    // 两种文案（"正在自动续写" / "只输出了思考、正文为空"）都以"输出上限"起头。
    const announce = events.filter(
      (e) => e.type === "text_delta" && /输出上限/.test(String(e.text)),
    );
    expect(announce, "用户/模型都要能看到『撞到输出上限、正在续写』").toHaveLength(1);
  });
});
