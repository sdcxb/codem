/**
 * Bug 1 判据：**tool_search 命中之后，延迟工具必须真的可调用**。
 *
 * 真机现场（`docs/marketing/evidence/bot-peer-real.txt` §3）：模型反复
 * `tool_search("doc_compile")`，每次都拿到 schema 文本，但下一轮请求的 `tools`
 * 列表里**没有 doc_compile** —— 搜到了仍然调不了，plan 又把「搜索工具」写成步骤，
 * 于是原地打转，最后被 REPEAT GUARD 停下。
 *
 * 这里不读源码文本，而是**真跑 AgenticLoop + 假 provider**，直接检查下一轮请求的
 * `tools` 列表：
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | DACT-1 | 先 tool_search(doc_compile) ⇒ 下一轮请求 tools 含其完整 schema，且能执行 | 只回文本不激活 ⇒ 红 |
 * | DACT-2 | 未搜索 ⇒ 不激活（常驻 schema 预算不变） | 无条件注入 ⇒ 红 |
 * | DACT-3 | 激活按会话记忆、去重、上限 8（FIFO 淘汰） | 无上限/不去重 ⇒ 红 |
 * | DACT-4 | plan 模式里 tool_search 不推进宏步骤（仍是第 1 步） | 把 tool_search 当执行步 ⇒ 红 |
 *
 * 变异自证（本轮实测过）：把 `tool-search.ts` 里的 `activationNote(...)` 换成空串
 * （只返回文本）⇒ DACT-1 红；把 `agentic-loop.ts` 的 activatedDefs 追加删掉 ⇒ DACT-1 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop, RECON_TOOL_NAMES } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import {
  DEFERRED_ACTIVATION_LIMIT,
  activateDeferredTool,
  getActivatedDeferredTools,
} from "../core/llm/deferred-activation";

/**
 * 把生产用的 Tauri IPC 文件接口 mock 成真实 Node fs（与 `task-keyword-search-wiring`
 * 同一口径）：loop 启动时会做一次「任务关键词搜索」，空工作区才不会去扫全仓。
 */
vi.mock("../core/file-api", () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  return {
    listDirectory: async (dir: string) =>
      readdirSync(dir, { withFileTypes: true }).map((e: any) => ({
        name: e.name,
        path: join(dir, e.name),
        isDirectory: e.isDirectory(),
      })),
    readFile: async (path: string) => readFileSync(path, "utf8"),
    readTextWindow: async (path: string, _offset = 0, maxBytes?: number) => {
      const text = readFileSync(path, "utf8");
      return { text: maxBytes ? text.slice(0, maxBytes) : text, totalLines: text.split("\n").length };
    },
  };
});

/** 只按脚本吐事件的假 provider；每次请求都留档，供判据检查 tools 列表。 */
class ScriptedProvider {
  id = "deferred-activation-provider";
  name = "Deferred Activation Mock";
  config: any = { apiKey: "sk-test" };
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
    const script = this.queue.shift() ?? [];
    for (const ev of script) yield ev;
  }
  async complete() {
    return { content: "ok" };
  }
}

function toolIteration(id: string, name: string, input: Record<string, unknown>): any[] {
  return [
    { type: "tool_use_start", id, name },
    { type: "tool_use_delta", id, input: JSON.stringify(input) },
    { type: "tool_use_end", id, input },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

interface RunResult {
  provider: ScriptedProvider;
  events: any[];
  registry: ReturnType<typeof createDefaultToolRegistry>;
}

async function runSession(params: {
  sessionId: string;
  cwd: string;
  scripts: any[][];
  config?: Record<string, unknown>;
  message?: string;
}): Promise<RunResult> {
  const provider = new ScriptedProvider();
  provider.setScript(params.scripts);
  const registry = createDefaultToolRegistry();
  const loop = new AgenticLoop(provider as any, registry, {
    maxIterations: 6,
    model: "m",
    securityMode: "full",
    ...(params.config ?? {}),
  } as any);
  const events: any[] = [];
  for await (const event of loop.run(params.sessionId, params.message ?? "你好", params.cwd, "system prompt")) {
    events.push(event);
  }
  return { provider, events, registry };
}

function toolNames(request: any): string[] {
  return (request?.tools ?? []).map((tool: any) => tool.name);
}

function toolDef(request: any, name: string): any {
  return (request?.tools ?? []).find((tool: any) => tool.name === name);
}

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "codem-deferred-activation-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("Bug 1：tool_search 动态激活延迟工具", () => {
  it("DACT-1：先搜 doc_compile ⇒ 下一轮请求 tools 含完整 schema，且目标工具可执行", async () => {
    const sessionId = "dact-session-1";
    const { provider, events, registry } = await runSession({
      sessionId,
      cwd,
      scripts: [
        toolIteration("search-1", "tool_search", { query: "doc_compile" }),
        toolIteration("compile-1", "doc_compile", { action: "status", document_id: "missing-doc" }),
        finalIteration("完成"),
      ],
    });

    expect(provider.requests.length, "必须有至少 3 次请求：搜索 / 调用 / 收尾").toBeGreaterThanOrEqual(3);
    expect(toolNames(provider.requests[0]), "第一轮还没搜索，不能提前激活").not.toContain("doc_compile");
    expect(
      toolNames(provider.requests[1]),
      "tool_search 之后的那一轮请求必须带上 doc_compile 的真实定义",
    ).toContain("doc_compile");

    const def = toolDef(provider.requests[1], "doc_compile");
    expect(def, "激活的定义不能是空壳").toBeTruthy();
    expect(def.parameters, "必须是完整 schema（不是只把 schema 文本塞回对话）").toBeTruthy();
    expect(def.parameters.required, "schema 的 required 必须来自真实定义").toContain("action");
    expect(String(def.description ?? "").length, "description 不能为空").toBeGreaterThan(20);

    // 可调用证明：脚本发起的 doc_compile 真的执行了，而不是「Tool not found」
    const completed: any = events.find(
      (event: any) => event.type === "tool_complete" && event.toolCall?.name === "doc_compile",
    );
    expect(completed, "doc_compile 必须被执行并产生 tool_complete").toBeTruthy();
    expect(String(completed.result?.output ?? "")).not.toContain("not found");

    expect(getActivatedDeferredTools(sessionId)).toEqual(["doc_compile"]);
    // 请求侧激活不许改写常驻预算：同一条 loop 用的注册表里它仍然是 deferred
    expect(registry.getCoreDefinitions().map((item) => item.name)).not.toContain("doc_compile");
    expect(registry.get("doc_compile")!.shouldDefer).toBe(true);
  });

  it("DACT-2：没有 tool_search ⇒ 不激活（延迟工具仍然不进 tools 列表）", async () => {
    const sessionId = "dact-session-2";
    const { provider } = await runSession({
      sessionId,
      cwd,
      scripts: [finalIteration("你好")],
    });
    expect(provider.requests.length).toBeGreaterThanOrEqual(1);
    expect(toolNames(provider.requests[0])).not.toContain("doc_compile");
    expect(getActivatedDeferredTools(sessionId), "没搜索就不许有激活状态").toEqual([]);
  });

  it("DACT-3：激活按会话隔离、去重、上限 8（FIFO 淘汰最久未激活）", () => {
    const sessionA = "dact-session-a";
    const sessionB = "dact-session-b";

    const first = activateDeferredTool(sessionA, "doc_compile");
    expect(first.activated).toBe(true);
    expect(getActivatedDeferredTools(sessionA)).toEqual(["doc_compile"]);

    const again = activateDeferredTool(sessionA, "doc_compile");
    expect(again.activated, "重复搜索同一个工具不该重复占位").toBe(false);
    expect(again.names).toEqual(["doc_compile"]);

    expect(getActivatedDeferredTools(sessionB), "激活必须按会话隔离").toEqual([]);

    for (let index = 0; index < DEFERRED_ACTIVATION_LIMIT + 1; index++) {
      activateDeferredTool(sessionB, `deferred_${index}`);
    }
    const afterCap = getActivatedDeferredTools(sessionB);
    expect(afterCap).toHaveLength(DEFERRED_ACTIVATION_LIMIT);
    expect(afterCap, "上限 8 时必须淘汰最久未激活的那个").not.toContain("deferred_0");
    expect(afterCap).toContain(`deferred_${DEFERRED_ACTIVATION_LIMIT}`);

    const evicted = activateDeferredTool(sessionB, "deferred_0");
    expect(evicted.evicted, "再激活新工具时要如实报告淘汰了谁").toBe("deferred_1");
    expect(getActivatedDeferredTools(sessionB)).toHaveLength(DEFERRED_ACTIVATION_LIMIT);
  });

  it("DACT-4：plan 模式里 tool_search 不推进宏步骤（仍停在第 1 步）", async () => {
    expect(RECON_TOOL_NAMES.has("tool_search"), "tool_search 必须登记为 recon（只读侦查）").toBe(true);

    const sessionId = "dact-session-plan";
    const { provider, events } = await runSession({
      sessionId,
      cwd,
      config: { collaborationMode: "plan" },
      scripts: [
        toolIteration("search-plan", "tool_search", { query: "doc_compile" }),
        finalIteration("完成"),
      ],
    });

    const steps = events
      .filter((event: any) => event.type === "step_progress")
      .map((event: any) => event.step as number);
    expect(steps.length, "至少要有两次 step_progress 才能观察是否推进").toBeGreaterThanOrEqual(2);
    expect(
      steps.every((step) => step === 1),
      `tool_search 被当成推进步骤了（实测 step 序列：${steps.join(",")}）`,
    ).toBe(true);
    expect(toolNames(provider.requests[1]), "plan 模式同样要激活（只读工具不受写工具过滤影响）").toContain(
      "doc_compile",
    );
  });
});
