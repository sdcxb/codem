/**
 * ★ 第 185 波 T5 判据：`ToolRegistry.execute` 出来的结果**必须带 `value`**，
 * 且与 `agentic-loop` 那条路径**同形**（失败时不许把有用的 output 顶掉）。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T5）
 *
 * `tools.ts` 的 `execute` 重建结果对象时只带 `id/name/input/output/status/metadata` ——
 * **没有 `value`**；而 `agentic-loop.ts:4944` 那条路径显式带了 `value: result.value`。
 * 下游 `OutputContractValidationMiddleware` 的判据是
 * `result.value === undefined ⇒ status:"error" + "… declared outputSchema but returned no value"`，
 * 而声明了 `outputSchema` 的正好是四个主力工具：`bash` / `read` / `glob` / `grep`
 * ⇒ 经 registry 入口（`provider/tools-provider.ts:120`、`dsh-compat/index.ts:154`）
 * 的一次**成功**调用会被改写成契约错误（第 97 波在 agentic-loop 那条路上修掉的同一场事故）。
 *
 * ## 判据（走**真实管线** + **真实 registry**，不是只测函数）
 *
 * | id | 钉什么 |
 * |---|---|
 * | `T5-A` | `read` 经 registry → 管线 ⇒ **completed**，且输出是渲染后的正文（不是契约错误） |
 * | `T5-B` | `bash` 同上（退出码按 renderOutput 拼进文本） |
 * | `T5-C` | `glob` 同上，且 `value` 逐字保留（结构化值可被下游消费） |
 * | `T5-D` | `grep` 同上 |
 * | `T5-E` | 直接判 `registry.execute` 的返回对象带 `value`（与 `agentic-loop.ts:4944` 同形） |
 * | `T5-F` | 失败分支：`isError` 为真时 `output` 里的**部分成功事实**（`Applied 2/3 edits … Errors: …`）必须原样保留 |
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";
import { createDefaultToolRegistry, ToolRegistry } from "../core/llm/tools";
import type { ToolExecutorContext } from "../core/llm/streaming-executor";
import type { ToolContext } from "../core/llm/tools";

const WS = "C:/ws";
const registry = createDefaultToolRegistry();

function toolCtx(): ToolContext {
  return {
    sessionId: "s-t5",
    messageId: "m-t5",
    cwd: WS,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    securityMode: "auto",
  };
}

function execCtx(id: string): ToolExecutorContext {
  return { ...toolCtx(), toolCallId: id } as ToolExecutorContext;
}

beforeAll(async () => {
  await initDefaultPipeline({
    isPlanMode: () => false,
    isSandboxEnabled: () => false,
    isPathWithinWorkspace: () => true,
    checkPermission: async () => ({ allowed: true }),
    contractOf: (n: string) => registry.getContract(n),
    rawContractOf: (n: string) => registry.getRawContract(n),
    toolDefOf: (n: string) => registry.get(n),
  });
});

beforeEach(() => {
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "read_file" || command === "read_file_lines") {
          return {
            text: "1: file content line\n2: second line\n",
            content: "file content line\nsecond line\n",
            totalLines: 2,
            hasMore: false,
            droppedLines: 0,
            droppedChars: 0,
          };
        }
        // ★ 第 186 波：`glob_search` 的契约是**结构化对象**（截断是数据，不是异常）
        if (command === "glob_search")
          return {
            files: [`${WS}\\a.ts`, `${WS}\\b.ts`],
            truncated: false,
            depth_limited: false,
            returned: 2,
          };
        if (command === "path_exists") return true;
        if (command === "file_version") return "12:345";
        if (command === "execute_command") {
          const cmd = String(args?.command ?? "");
          if (/Select-String/.test(cmd)) return { stdout: "C:\\ws\\a.ts:2:KEY found", stderr: "", exitCode: 0 };
          return { stdout: "hello", stderr: "", exitCode: 0 };
        }
        return null;
      }),
    },
  };
});

/** 走真实管线 + **真实 registry** 的执行体（`provider/tools-provider.ts` 那条组合方式）。 */
async function runThroughRegistry(
  toolName: string,
  args: Record<string, unknown>,
  callId = `call-${toolName}`,
) {
  const r = await getToolPipeline().execute(toolName, args, execCtx(callId), (name, a, c) =>
    registry.execute(callId, name, a as Record<string, unknown>, c as unknown as ToolContext),
  );
  return r.result;
}

const CONTRACT_ERROR = /declared outputSchema but returned no/i;

describe("第 185 波 T5：registry 入口的结果形状与 agentic-loop 同形", () => {
  it("T5-A: read 经 registry ⇒ completed（成功结果不许被改写成契约错误）", async () => {
    const res = await runThroughRegistry("read", { path: `${WS}/a.ts` });
    expect(res.status, `改前这里会是契约错误：${String(res.output).slice(0, 120)}`).toBe("completed");
    expect(String(res.output)).not.toMatch(CONTRACT_ERROR);
    expect(String(res.output)).toContain("file content line");
  });

  it("T5-B: bash 经 registry ⇒ completed，且退出码按 renderOutput 拼进文本", async () => {
    const res = await runThroughRegistry("bash", { command: "echo hello" });
    expect(res.status, String(res.output).slice(0, 120)).toBe("completed");
    expect(String(res.output)).not.toMatch(CONTRACT_ERROR);
    expect(String(res.output)).toContain("hello");
  });

  it("T5-C: glob 经 registry ⇒ completed，且 value 逐字保留", async () => {
    const res = await runThroughRegistry("glob", { pattern: "*.ts" });
    expect(res.status, String(res.output).slice(0, 120)).toBe("completed");
    expect(String(res.output)).not.toMatch(CONTRACT_ERROR);
    // ★ 第 186 波：`returned` / `truncated` 也是结构化事实的一部分（"后面还有没有"）
    expect(res.value, "★ 结构化值必须原样带出来（下游要结构化消费）").toEqual({
      files: [`${WS}\\a.ts`, `${WS}\\b.ts`],
      count: 2,
      pattern: "*.ts",
      returned: 2,
      truncated: false,
    });
  });

  it("T5-D: grep 经 registry ⇒ completed（内容型工具的结果同样不许被契约层改写成错误）", async () => {
    const res = await runThroughRegistry("grep", { pattern: "KEY", path: WS });
    expect(res.status, String(res.output).slice(0, 120)).toBe("completed");
    expect(String(res.output)).not.toMatch(CONTRACT_ERROR);
    expect(String(res.output)).toContain("KEY found");
  });

  it("T5-E: registry.execute 的返回对象带 value（与 agentic-loop.ts:4944 同形）", async () => {
    const r = await registry.execute("call-direct", "glob", { pattern: "*.ts" }, toolCtx());
    expect(r.status).toBe("completed");
    expect(r.value).toEqual({
      files: [`${WS}\\a.ts`, `${WS}\\b.ts`],
      count: 2,
      pattern: "*.ts",
      returned: 2,
      truncated: false,
    });

    const r2 = await registry.execute("call-direct-2", "bash", { command: "echo hello" }, toolCtx());
    expect(r2.value, "bash 也声明了 outputSchema，value 同样必须带出来").toBeTruthy();
  });

  it("T5-F: 失败分支不许把「部分成功」的事实顶掉", async () => {
    /**
     * 用注册表里的一个探针工具复现 `multi_edit` 的形态（`tools.ts:2036-2056`）：
     * 输出本身是**有用的事实**（哪几条成功、哪几条失败、lint 结果），失败与否由显式
     * `isError` 表达。判据要能区分"只回首行"与"原样回 output" —— 所以夹具**必须多行**
     * （单行时两者恰好相等，判据就成了恒真；真机上 multi_edit 的输出也会带上 lint 行）。
     */
    const probeOutput = [
      "Applied 2/3 edits to x.ts.",
      "Errors: edit #2: oldString not found",
      "[lint] 3 problems",
    ].join("\n");
    const probe = new ToolRegistry();
    probe.register({
      id: "multi_edit_probe",
      description: "probe",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { title: "probe", output: probeOutput, isError: true };
      },
    });

    const r = await probe.execute("c-probe", "multi_edit_probe", {}, toolCtx());
    expect(r.status, "显式 isError ⇒ 必须判失败").toBe("error");
    expect(String(r.output), "★ output 必须原样保留（部分成功的事实 + lint 都在里面）").toBe(probeOutput);
    expect(String(r.output)).toContain("Errors: edit #2");
    expect(String(r.output)).toContain("[lint] 3 problems");
    expect(String(r.error), "error 字段只放首行原因，不许把 output 换成它").toBe(
      "Applied 2/3 edits to x.ts.",
    );
  });
});
