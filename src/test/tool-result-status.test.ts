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
   * ========== 第 181/182 波（T-1）：必填化**已完成**，这里守新契约 ==========
   *
   * ## 缺口与修法（已落地）
   *
   * 第 181 波发现的缺口：`isError` 是**可选**的，省略时由 `classifyToolResult` 按输出**推断** ——
   * 而推断表里有一份 `CONTENT_TOOLS`（`read`/`grep`/`glob`/`web_fetch`/`load_skill`…）
   * **明确不推断**（理由正当：它们的输出是"数据"，首行恰好是 `Error:` 也可能就是文件内容）。
   * 于是这些工具**真的失败**时会落到 `completed` —— 一个**静默缺口**。
   *
   * 第 182 波把 `isError` 改成**必填**：187 处编译错误逐条判成败（149 处由脚本按
   * "失败词 + 失败守卫"判定、其余逐条手工），并给 34 处 `execute` 补上显式返回类型注解
   * ⇒ 类型系统转为**逐分支检查**（又暴露出 67 处此前看不见的缺字段）。
   *
   * ## 这组判据现在守什么
   *
   * · TRS-1：显式声明优先于文本（**这条契约不变**，别为"更聪明"去改推断）；
   * · TRS-2：**绕过类型的地方**（动态插件等第三方工具）仍然可能不声明 ⇒ 推断的兜底行为
   *   保持原样并被钉住（它是兜底，不再是主路径）；
   * · TRS-3：非内容型工具未声明时仍按首行前缀推断；
   * · TRS-4：**`isError` 必须保持必填** —— 退回可选会让上面那个静默缺口重新长出来。
   */
  describe("T-1：显式声明优先，且 isError 必填（缺口已修）", () => {
    it("TRS-1: 显式 `isError: false` 优先于文本 —— 输出以 Error: 开头也必须是 completed", () => {
      const v = classifyToolResult("bash", "Error: 这只是被 cat 出来的文件内容", false);
      expect(v.status, "显式声明优先（这条是现行契约，别为修缺口而改掉它）").toBe("completed");
    });

    it("TRS-2: 绕过类型（未声明）时，内容型工具仍按「不推断」兜底 —— 兜底行为被钉住", () => {
      for (const toolName of ["read", "grep", "glob", "web_fetch"]) {
        const v = classifyToolResult(toolName, "Error: ENOENT: no such file or directory", undefined);
        expect(
          v.status,
          `「${toolName}」未声明时仍判 completed（这是**兜底**：类型层已强制声明，` +
            `只有绕过类型的第三方工具才会走到这里）`,
        ).toBe("completed");
      }
    });

    it("TRS-3: 非内容型工具未声明时仍按首行前缀推断（兜底不许丢）", () => {
      expect(classifyToolResult("bash", "Error: command not found", undefined).status).toBe("error");
      expect(classifyToolResult("bash", "错误：命令失败", undefined).status).toBe("error");
      expect(classifyToolResult("bash", "ok", undefined).status).toBe("completed");
    });

    it("TRS-4: `ToolExecuteResult.isError` 必须**必填** —— 退回可选会让静默缺口重新长出来", async () => {
      const fs = await import("node:fs");
      const text = fs.readFileSync("src/core/llm/tools.ts", "utf8");
      expect(
        /^  isError: boolean;/m.test(text),
        "字段必须是必填（`isError: boolean`）。退回 `isError?:` 会让「内容型工具真失败却被判成功」" +
          "这个静默缺口重新出现 —— 那正是第 182 波花 187 处逐条判定修掉的东西。",
      ).toBe(true);
      expect(
        /isError\?:\s*boolean/.test(text),
        "不许同时留下可选版本（否则必填形同虚设）",
      ).toBe(false);
    });
  });
});
