/**
 * 第 84 波审计修正（B 类：假成功）：**把失败写成文本 ≠ 成功**。
 *
 * 修复前：`ToolRegistry.execute` 与 `AgenticLoop` 的内联 handler 都无条件返回
 * `status: "completed"`，而本仓库 100+ 处工具失败路径写成 `output: "Error: ..."`。
 * 于是失败在界面上是绿的、在守卫眼里是"写下来了"、在委派/子智能体那里是成功。
 *
 * 修复后：统一按 `classifyToolResult` 判定 —— 显式 `isError` 优先，
 * 内容型工具（read/grep/web_fetch…）的输出是数据、不推断，其余看首行前缀。
 */

import { describe, it, expect } from "vitest";
import { classifyToolResult } from "../core/llm/tool-result-status";
import { ToolRegistry } from "../core/llm/tools";
import type { ToolDef, ToolContext } from "../core/llm/tools";
import { StreamingToolExecutorImpl } from "../core/llm/streaming-executor";
import { initDefaultPipeline } from "../core/llm/tool-pipeline";
import type { StreamingToolCall, ToolExecutorEvent } from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

const ctx = {} as ToolContext;

function tool(id: string, output: string, isError?: boolean): ToolDef {
  return {
    id,
    description: "test",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { title: id, output, ...(isError === undefined ? {} : { isError }) };
    },
  };
}

function throwingTool(id: string): ToolDef {
  return {
    id,
    description: "test",
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("kaboom");
    },
  };
}

describe("classifyToolResult 判定规则", () => {
  it("TRS-1: 首行 Error: → error", () => {
    expect(classifyToolResult("write", "Error: disk full").status).toBe("error");
    expect(classifyToolResult("exit_plan_mode", "Error: plan parameter is required.").error).toContain(
      "plan parameter is required",
    );
  });

  it("TRS-2: 中文失败前缀与 ERROR- 也算失败", () => {
    expect(classifyToolResult("note_operations", "错误：笔记不存在").status).toBe("error");
    expect(classifyToolResult("bash", "失败：命令未找到").status).toBe("error");
    expect(classifyToolResult("bash", "ERROR - bad flag").status).toBe("error");
  });

  it("TRS-3: 内容型工具不做推断（文件内容首行就叫 Error: 也是数据）", () => {
    expect(classifyToolResult("read", "Error: this is a file body line").status).toBe("completed");
    expect(classifyToolResult("grep", "Error: also a data line").status).toBe("completed");
    expect(classifyToolResult("web_fetch", "Error: page text").status).toBe("completed");
  });

  it("TRS-4: 正常输出、以及把失败写在非首行 → 仍是 completed", () => {
    expect(classifyToolResult("write", "Successfully wrote 3 lines").status).toBe("completed");
    expect(classifyToolResult("bash", "line1\nError: nested").status).toBe("completed");
  });

  it("TRS-5: 显式 isError 优先（含显式声明成功）", () => {
    expect(classifyToolResult("read", "Error: data", true).status).toBe("error");
    expect(classifyToolResult("write", "Error: weird but reported ok", false).status).toBe("completed");
  });
});

describe("ToolRegistry.execute 的状态与元数据", () => {
  it("TRS-6（修复点）: 工具用文本报告失败时，结果必须是 error", async () => {
    const reg = new ToolRegistry();
    reg.register(tool("write", "Error: This path is protected and cannot be written to."));

    const result = await reg.execute("c1", "write", {}, ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("protected");
    expect(result.output).toContain("Error:");
  });

  it("TRS-7: 抛异常仍是 error（原有行为不回退）", async () => {
    const reg = new ToolRegistry();
    reg.register(throwingTool("bash"));
    const result = await reg.execute("c1", "bash", {}, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("kaboom");
  });

  it("TRS-8: 工具不存在时也给出明确的 error（消息不再自相矛盾）", async () => {
    const reg = new ToolRegistry();
    const result = await reg.execute("c1", "nope", {}, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toMatch(/^Error: Tool "nope" not found/);
  });

  it("TRS-9: metadata 透传（原来被丢掉，子智能体据此注册 settlement）", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...tool("subagent", "spawned"),
      async execute() {
        return { title: "subagent", output: "spawned", metadata: { subagentId: "sa-1" } };
      },
    });
    const result = await reg.execute("c1", "subagent", {}, ctx);
    expect(result.status).toBe("completed");
    expect(result.metadata).toEqual({ subagentId: "sa-1" });
  });

  it("TRS-10: 作用域注册表（子智能体）走同一套判定 —— 父域工具失败也是 error", async () => {
    const parent = new ToolRegistry();
    parent.register(tool("write", "Error: nope"));
    parent.register(tool("read", "Error: data line"));
    const scoped = parent.createScope();

    const failed = await scoped.execute("c1", "write", {}, ctx);
    expect(failed.status, "父域工具经子作用域调用也必须判失败").toBe("error");

    const content = await scoped.execute("c2", "read", {}, ctx);
    expect(content.status, "内容型工具不误判").toBe("completed");

    const missing = await scoped.execute("c3", "ghost", {}, ctx);
    expect(missing.status).toBe("error");
  });
});

describe("执行器：工具自报失败 ≠ 执行层异常", () => {
  async function drive(handler: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>) {
    await initDefaultPipeline({
      isPlanMode: () => false,
      isSandboxEnabled: () => false,
      isPathWithinWorkspace: () => true,
      checkPermission: async () => ({ allowed: true }),
    });
    const executor = new StreamingToolExecutorImpl({ maxConcurrent: 1 });
    const toolCalls: StreamingToolCall[] = [
      { id: "tc1", name: "edit", input: { path: "C:/proj/a.ts" }, status: "pending" } as StreamingToolCall,
    ];
    const execCtx: any = {
      sessionId: "s1",
      messageId: "m1",
      cwd: "C:/proj",
      messages: [],
      abort: new AbortController().signal,
      metadata: () => {},
    };
    const events: ToolExecutorEvent[] = [];
    for await (const ev of executor.execute(toolCalls, execCtx, handler)) {
      events.push(ev);
    }
    return events;
  }

  it("TRS-11（修复点）: 工具自报的失败要作为 tool_complete 返回，模型能看到文本并纠正", async () => {
    const events = await drive(async (name, args) => ({
      id: "tc1",
      name,
      input: args,
      output: "Error: oldString not found in a.ts",
      status: "error",
      error: "Error: oldString not found in a.ts",
      errorSource: "tool",
    }));

    expect(events.some((e) => e.type === "tool_complete")).toBe(true);
    expect(events.some((e) => e.type === "tool_error")).toBe(false);
    const complete: any = events.find((e) => e.type === "tool_complete");
    expect(complete.result.status).toBe("error");
    expect(String(complete.result.output)).toContain("oldString not found");
  });

  it("TRS-12: 管线层拒绝（权限/守卫）语义不回退 —— 仍然是 tool_error", async () => {
    const events = await drive(async (name, args) => ({
      id: "tc1",
      name,
      input: args,
      output: "Blocked: 计划模式只读",
      status: "error",
      error: "Blocked: 计划模式只读",
      errorSource: "pipeline",
    }));

    expect(events.some((e) => e.type === "tool_error")).toBe(true);
    expect(events.some((e) => e.type === "tool_complete")).toBe(false);
  });

  /**
   * ========== 第 181 波（T-1）：把「推断缺口」钉住 ==========
   *
   * ## 这一组判据要守的是什么
   *
   * `isError` 目前是**可选**的，省略时由 `classifyToolResult` 按输出**推断** ——
   * 而推断表里有一份 `CONTENT_TOOLS`（`read`/`grep`/`glob`/`web_fetch`/`load_skill`…）
   * **明确不推断**（理由正当：它们的输出是"数据"，首行恰好是 `Error:` 也可能就是文件内容）。
   *
   * 于是这些工具**真的失败**时会落到 `completed` —— 一个**静默缺口**。本轮的结论是
   * **不能机械把 `isError` 改成必填**（153 处里 123 处的输出是模板串/表达式，无法静态判成败；
   * 而且本仓库的成功路径一律省略 `isError`，填 `false` 会改掉"按 `Error:` 前缀判失败"的现行语义 ——
   * 详见 `tools.ts` 里 `isError` 字段的说明）。所以本轮**只把缺口的形状钉住**：
   * 谁想"顺手修好"这条推断，必须先让 TRS-2 红 —— 那是**有意的路障**。
   */
  describe("T-1：显式声明优先，内容型工具的推断缺口被钉住", () => {
    it("TRS-1: 显式 `isError: false` 优先于文本 —— 输出以 Error: 开头也必须是 completed", () => {
      const v = classifyToolResult("bash", "Error: 这只是被 cat 出来的文件内容", false);
      expect(v.status, "显式声明优先（这条是现行契约，别为修缺口而改掉它）").toBe("completed");
    });

    it("TRS-2: 内容型工具**真的失败**且未声明时，会被判成 completed —— 缺口的形状", () => {
      for (const toolName of ["read", "grep", "glob", "web_fetch"]) {
        const v = classifyToolResult(toolName, "Error: ENOENT: no such file or directory", undefined);
        expect(
          v.status,
          `「${toolName}」没有显式 isError 时会被判成 completed —— ` +
            `这正是 T-1 要治的静默缺口（修法见 tools.ts 里 isError 的说明，不要只改这一条判据）`,
        ).toBe("completed");
      }
    });

    it("TRS-3: 非内容型工具未声明时仍按首行前缀推断（现行兜底不许丢）", () => {
      expect(classifyToolResult("bash", "Error: command not found", undefined).status).toBe("error");
      expect(classifyToolResult("bash", "错误：命令失败", undefined).status).toBe("error");
      expect(classifyToolResult("bash", "ok", undefined).status).toBe("completed");
    });

    it("TRS-4: `ToolExecuteResult.isError` 保持可选 —— 改成必填会牵连 153 处（其中 123 处无法静态判定）", async () => {
      const fs = await import("node:fs");
      const text = fs.readFileSync("src/core/llm/tools.ts", "utf8");
      expect(
        /isError\?:\s*boolean/.test(text),
        "字段一旦改成必填，`tsc` 会报 187 处；其中 123 处的 output 是模板串/表达式，" +
          "机械填值会静默改掉『按 Error: 前缀判失败』的现行语义 ⇒ 必须逐条判成败（见 T-1 说明）",
      ).toBe(true);
    });
  });
});
