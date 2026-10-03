/**
 * 「改了文件却一次都没验证，不许安静地当作完成」守卫 —— **行为判据**（第 93 波补）。
 *
 * ## 为什么需要补（交接单 §3.2）
 *
 * 提交 `e8a89a0` 加了这个守卫（`agentic-loop.ts` 的 `turnModifiedFiles` /
 * `turnRanVerification` / `verificationNudgeIssued`），但**它当时没有自己的判据**，
 * 也没做变异自证 —— 按本仓库的规矩它只算「实现就绪」，不算「验证通过」。
 * 本文件把那条缺口补上：**用假 provider 驱动真循环**，判据落在
 * 「模型实际收到的提示文本」「迭代次数」这些可观测产物上（不看源码文本）。
 *
 * ## 判据
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | VERIF-1 | 迭代 1 `write` 成功 → 迭代 2 只有文本、不调工具 | 出现「没有验证」提示，**并且**循环被推着多跑一个迭代（`requests.length === 3`）；仍然不验证 → 明说「未经证实」 |
 * | VERIF-2 反向对照 | 迭代 1 `write` → 迭代 2 跑一条 `npx vitest …`（`looksLikeVerificationCommand` 认的命令）→ 迭代 3 收尾 | **不许**出现任何「没有验证 / 未经证实」的提示；`requests.length === 3`（不被推着多跑） |
 *
 * ## 变异自证
 *
 * 删掉 `agentic-loop.ts` 里那行
 * `if (isBashLike && looksLikeVerificationCommand(cmd)) this.turnRanVerification = true;`
 * ⇒ **VERIF-2 必须变红**（它会开始提示"没有验证"，并且多跑一个迭代）。
 *
 * ## 顺手确认（交接单 §3.2 的最后一条）
 *
 * 这个守卫**对「停滞误杀」那个 bug 不生效**：`plan_stale` 是在迭代末尾
 * **直接 `return`** 杀掉循环的（见 `agentic-loop.ts` 的停滞停止分支），
 * 根本走不到 `completed` 分支里的这段守卫。所以它**不是** §3.1 的替代品 ——
 * 停滞那块的行为判据在 `stall-guard-loop-behavior.test.ts`（STALL-LOOP-*）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { looksLikeVerificationCommand } from "../core/llm/agentic-loop";

const CWD = "C:\\verify-guard";
const SESSION = "test-verify-guard-session";
const FILE = `${CWD}\\src\\edit-matchers.ts`;

class ScriptedProvider {
  id = "verify-guard-provider";
  name = "Verify Guard Mock";
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

function toolIteration(id: string, name: string, input: Record<string, unknown>): any[] {
  return [
    { type: "tool_use_start", id, name },
    { type: "tool_use_delta", id, input: JSON.stringify(input) },
    { type: "tool_use_end", id, input },
    { type: "end", finishReason: "tool_use" },
  ];
}

function textIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/**
 * 夹具工具：`write` 与 `bash` 都换成不碰磁盘的实现。
 *
 * 契约刻意用 `sideEffectScope: "session"`（不是 "workspace"）：那会触发执行前快照
 * （`needsPreCallSnapshot`）——判据要的是"改了文件"这个**已登记的事实**，
 * 不是快照机制本身，别让判据被无关的磁盘/ git 状态带偏。
 */
function buildRegistry() {
  const registry = createDefaultToolRegistry();
  const executed: string[] = [];
  registry.register({
    id: "write",
    description: "假 write（判据夹具：不写磁盘，只回成功）",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path"],
    },
    contract: {
      readOnly: false,
      concurrencySafe: false,
      sideEffectScope: "session",
      accessScope: "workspace",
      persistResult: false,
    },
    async execute(args: any) {
      executed.push(`write:${args?.path}`);
      return { title: "write", output: `Successfully wrote 1 file to ${args?.path}` };
    },
  } as any);
  registry.register({
    id: "bash",
    description: "假 bash（判据夹具：不跑真命令）",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    contract: {
      readOnly: false,
      concurrencySafe: false,
      sideEffectScope: "session",
      accessScope: "workspace",
      persistResult: false,
    },
    async execute(args: any) {
      executed.push(`bash:${args?.command}`);
      return { title: "bash", output: "Test Files 1 passed | Tests 12 passed (12)" };
    },
  } as any);
  return { registry, executed };
}

async function drain(loop: AgenticLoop): Promise<any[]> {
  const events: any[] = [];
  for await (const e of loop.run(SESSION, "修掉 edit 的二义性", CWD, "system prompt")) {
    events.push(e);
  }
  return events;
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => String(e.text ?? ""))
    .join("");
}

function endResult(events: any[]): any {
  const ends = events.filter((e) => e.type === "end");
  expect(ends.length, "每一轮都必须以恰好一个 end 事件收场").toBe(1);
  return ends[0].result;
}

describe("「改了但没验证」守卫的行为判据（第 93 波补 §3.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("VERIF-1: 改了文件、一次都没验证就想收尾 → 必须先提示「没有验证」，仍不改就明说「未经证实」", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      toolIteration("w1", "write", { path: FILE, content: "export const x = 1;\n" }),
      textIteration("改完了。"),
      textIteration("真的改完了。"),
    ]);
    const { registry, executed } = buildRegistry();

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "verify-guard-model",
      securityMode: "full",
    });
    const events = await drain(loop);
    const text = textOf(events);

    expect(executed, "前置：write 必须真的执行过（否则'改过文件'这个自变量不成立）").toEqual([
      `write:${FILE}`,
    ]);
    expect(
      provider.requests.length,
      "守卫必须把循环**推着多跑一个迭代**去验证（不是只打印一句就收尾）",
    ).toBe(3);
    expect(text, "第一次必须提示「没有验证」并说明要跑测试/构建").toContain("没有验证");
    expect(text, "第二次仍然不验证 → 必须明说这一轮「未经证实」").toContain("未经证实");
    expect(
      endResult(events).reason,
      "这个守卫故意**不改** reason（下游很多地方按 completed 匹配）—— 它是提示，不是终态",
    ).toBe("completed");
  });

  it("VERIF-2 反向对照: 跑过验证（npx vitest）就不该有任何「没有验证」提示", async () => {
    const cmd = "npx vitest run src/test/stall-guard.test.ts";
    // 前置：夹具命令必须真的被判据认成「验证命令」，否则这条反向对照测的是别的东西
    expect(looksLikeVerificationCommand(cmd), "夹具命令必须被 looksLikeVerificationCommand 认出").toBe(
      true,
    );

    const provider = new ScriptedProvider();
    provider.setScript([
      toolIteration("w1", "write", { path: FILE, content: "export const x = 2;\n" }),
      toolIteration("b1", "bash", { command: cmd }),
      textIteration("改完并跑过测试了。"),
      // 变异路径（把 turnRanVerification 的赋值删掉）会多跑一个迭代，给它留个脚本，
      // 免得测试因为"脚本耗尽"这种无关原因变红 —— 变异必须在**判据那一行**变红。
      textIteration("（变异路径的收尾）"),
    ]);
    const { registry, executed } = buildRegistry();

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "verify-guard-model",
      securityMode: "full",
    });
    const events = await drain(loop);
    const text = textOf(events);

    expect(executed, "前置：write 与验证命令都必须真的执行过").toEqual([
      `write:${FILE}`,
      `bash:${cmd}`,
    ]);
    expect(
      provider.requests.length,
      "跑过验证就正常收尾，不该被守卫推着多跑",
    ).toBe(3);
    expect(text, "跑过验证却还在提示「没有验证」= 误报，会白烧一个迭代").not.toContain("没有验证");
    expect(text, "跑过验证却还说「未经证实」= 误报").not.toContain("未经证实");
    expect(endResult(events).reason).toBe("completed");
  });
});
