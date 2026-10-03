/**
 * 第 108 波：**红测试收尾守卫的行为判据**（真实循环里跑，不是单元桩）。
 *
 * ## 证据（这一条判据是"测量测出来的产品缺陷"的直接产物）
 *
 * 真实仓库档评测 `repo-03` 那一轮（1.16.232 装机版）：
 *  · agent 跑了 `usage-normalize.test.ts` 等三个文件，输出 **4 failed**
 *    （其中就有最后让它没过的 D7-B/C 与"缺报不产出 cache 键"两条）；
 *  · 它还专门 `git stash` 回基线复跑确认同样红；
 *  · 然后只跑了另一组绿的（9 passed）就收工，回执写"已完成"。
 *
 * **它看见了红，还是把红说成了完成。** 既有的"改了但没验证"守卫抓不到这种情况
 * （那条只看"有没有跑过验证"，而这里验证过了、结果是红的）。
 *
 * ## 本判据钉什么
 *
 *  · RT-1：收尾时最近一次测试是红的 ⇒ **不许直接结束**，要注入提醒并要求二选一，然后继续；
 *  · RT-2（反向对照）：测试是绿的 ⇒ **不许**注入（否则每次收尾都被多问一轮）；
 *  · RT-3：提醒**只来一次** —— 第二遍收尾就放行（绝不把模型困在循环里）；
 *  · RT-4：提醒要**说清楚红了几条、哪条命令**（不能只说"有测试失败"）。
 *
 * 变异自证：把收尾守卫那段删掉 ⇒ RT-1/RT-3/RT-4 立刻红（`_probe` 里验证过）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

const CWD = "C:\\red-test-loop";
const SESSION = "test-red-test-session";

/** 脚本化 provider（与 stall-guard 判据同款：每次 `stream()` 消费一段脚本） */
class ScriptedProvider {
  id = "red-test-provider";
  name = "Red Test Mock";
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
    for (const item of script) yield item;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
}

/** 一个"跑测试"的迭代：调用 bash，然后 finishReason=tool_use（循环继续） */
function testIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 收尾迭代：只有文本、没有工具调用 */
function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/** 把 `bash` 换成纯夹具：命令照收，返回脚本化的测试输出（不碰磁盘） */
function registryWithFakeBash(outputOf: (command: string) => string) {
  const registry = createDefaultToolRegistry();
  const executed: string[] = [];
  registry.register({
    id: "bash",
    description: "假 bash（判据夹具：测试输出由用例给）",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute(args: any) {
      const command = String(args?.command ?? "");
      executed.push(command);
      return { title: `bash: ${command}`, output: outputOf(command) };
    },
  } as any);
  return { registry, executed };
}

async function drain(loop: AgenticLoop): Promise<any[]> {
  const events: any[] = [];
  // 第 4 个参数是 system prompt（与 stall-guard 判据同款调用形状）
  for await (const event of loop.run(SESSION, "把仓库里的缺陷修掉，并跑测试验证。", CWD, "system prompt")) {
    events.push(event);
  }
  return events;
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => String(e.text ?? ""))
    .join("");
}

/** 红测试输出（vitest 形状） */
const RED_OUTPUT = `
 ❯ src/test/usage-normalize.test.ts (4 tests | 1 failed)
 ❯ src/test/dsh-d7-usage-cache-buckets.test.ts (5 tests | 3 failed)
 Test Files  2 failed | 1 passed (3)
      Tests  4 failed | 8 passed (12)
`;
const GREEN_OUTPUT = `
 ✓ src/test/usage-normalize.test.ts (4 tests)
 Test Files  3 passed (3)
      Tests  12 passed (12)
`;

describe("第 108 波：红测试收尾守卫（真实循环行为）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("RT-1: 收尾时最近一次测试是红的 ⇒ 必须再要一轮，不许直接完成", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      testIteration("t1", "npx vitest run src/test/usage-normalize.test.ts"),
      finalIteration("已完成：修好了缓存口径。"),
      finalIteration("已完成：这次真的好了。"),
    ]);
    const { registry } = registryWithFakeBash(() => RED_OUTPUT);

    const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
    const events = await drain(loop);

    // 关键：模型第一次收尾之后**又被问了一轮**（脚本被消耗了 3 次）
    expect(provider.requests.length, "应当被要求再走一轮（否则就是直接放行了红测试）").toBe(3);
    expect(textOf(events), "要在界面上说清测试还红着").toMatch(/测试还是红的/);
  });

  it("RT-2 反向对照: 测试是绿的 ⇒ **不许**注入提醒（否则每次收尾都被多问一轮）", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      testIteration("t1", "npx vitest run src/test/usage-normalize.test.ts"),
      finalIteration("已完成。"),
    ]);
    const { registry } = registryWithFakeBash(() => GREEN_OUTPUT);

    const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
    const events = await drain(loop);

    expect(provider.requests.length, "绿测试就该一轮收尾").toBe(2);
    expect(textOf(events), "不许出现红测试提醒").not.toMatch(/测试还是红的/);
  });

  it("RT-3/RT-4: 提醒只来一次，且必须点名条数与命令", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      testIteration("t1", "npx vitest run src/test/dsh-d7-usage-cache-buckets.test.ts"),
      finalIteration("已完成。"),
      finalIteration("已完成（这次不改了）。"),
      finalIteration("已完成（真的不改了）。"),
    ]);
    const { registry } = registryWithFakeBash(() => RED_OUTPUT);

    const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
    const events = await drain(loop);

    const nudges = (textOf(events).match(/测试还是红的/g) ?? []).length;
    expect(nudges, "提醒只应当出现一次").toBe(1);
    // 第二遍收尾必须放行：脚本只用掉 3 段（测试 + 两次收尾）
    expect(provider.requests.length, "上限 1 次之后必须放行").toBe(3);
    expect(textOf(events), "要点名红了几条").toMatch(/4 条失败/);
  });
});
