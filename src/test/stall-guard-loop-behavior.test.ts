/**
 * 停滞守卫在**真实循环里**的行为判据（第 93 波治本）。
 *
 * ## 修的是什么（一手证据）
 *
 * 用户报「任务提前停掉，然后说完成了」。一手证据：在咱们自己仓库上跑真实任务的会话
 * `1790981803954-u5dmdoahw`（211 条事件）里，模型正在**逐文件读代码**
 * （"Now I have the full picture. Let me read the actual edit tool implementation…"），
 * 事件流里却留下：
 *
 * ```
 * loop_stopped seq=9530 {"reason":"plan_stale_ask","stalledFor":12}
 * loop_stopped seq=9599 {"reason":"plan_stale",    "stalledFor":24}
 * ```
 *
 * 缺陷是：停滞判据只认「有没有写盘 / 改计划」，**不认「有没有获得新信息」** ——
 * 于是在真实大仓库里，称职的探索被判成"没推进"，第 12 轮提醒、第 24 轮直接把循环杀掉。
 *
 * ## 判据（全部落在**循环可观测的结果**上，不看源码文本）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | STALL-LOOP-1 | 26 个迭代，每个迭代读**不同**的文件（每次返回**不同**内容 ⇒ 有信息增益） | 循环必须跑满 26 个读迭代；`reason === "completed"`；**不许**出现 `plan_stale`；**不许**注入「进度自查」 |
 * | STALL-LOOP-2 | 反向对照：读不同文件但内容**一模一样**（零信息增益） | 循环必须被**停下来**，且 `reason !== "completed"`（已在行的零增益阀门 `repeat_guard` 先响 —— 见下面"两个阀门的关系"） |
 * | STALL-LOOP-3 | 24 个**零进展**迭代（读缓存命中 + 有指引待消费 ⇒ 循环继续） | 必须走到 `plan_stale` 这一终态，且 `detail.stalledFor === 24`（证明停滞阀门**在循环里真的接上了**） |
 *
 * ## 变异自证（回归锁）
 *
 * 把 `agentic-loop.ts` 里那行 `if (guardGain?.gained) this.iterationGainedInformation = true;`
 * 改坏（或把 `gainedInformation` 从 `noteIteration` 的入参里去掉）⇒ **STALL-LOOP-1 必须变红**
 * （循环会在第 24 个迭代以 `plan_stale` 收场、`provider.requests.length` 变成 24）。
 * 这是"这条判据真的咬住了信息增益"的唯一证据。
 *
 * ## 两个阀门的关系（如实记录，别当成 bug）
 *
 * `RepeatGuard`（零信息增益）与 `StallGuard`（零进展）**数的是同一类证据**，但阈值不同：
 * 前者在**连续 6 次**零增益就停（`DEFAULT_GUARD_LIMITS.noGainStop`），后者要到 24。
 * 因此当"反复拿到同一份内容"时，**先响的必然是 `repeat_guard`** —— 交接单 §3.1 里
 * 那句"零信息增益 ⇒ 必须出现 `plan_stale`"在**循环层面**只可能由"零进展但**没有**被零增益
 * 阀门覆盖"的迭代形态满足（读缓存命中 / 无工具调用），见 STALL-LOOP-3 的造法。
 * 这条关系写在这里，是为了不让下一个人以为 `plan_stale` 是坏掉的。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getGuidanceQueue } from "../core/llm/guidance-queue";

const CWD = "C:\\stall-loop";
const SESSION = "test-stall-loop-session";

/** 脚本化 provider：每次 `stream()` 消费一个脚本（顺序即迭代顺序） */
class ScriptedProvider {
  id = "stall-loop-provider";
  name = "Stall Loop Mock";
  config: any = { apiKey: "sk-test" };
  requests: any[] = [];
  /** 每次 `stream()` 被调用时触发（STALL-LOOP-3 用它制造"有指引待消费"） */
  onStream: (() => void) | null = null;
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
    this.onStream?.();
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

/** 一个"读文件"迭代：调用 read，然后 finishReason=tool_use（循环继续） */
function readIteration(id: string, path: string): any[] {
  return [
    { type: "tool_use_start", id, name: "read" },
    { type: "tool_use_delta", id, input: JSON.stringify({ path }) },
    { type: "tool_use_end", id, input: { path } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 收尾迭代：只有文本、没有工具调用 ⇒ 自然结束 */
function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/**
 * 把 `read` 换成**纯夹具**实现（不碰磁盘），内容由 `contentOf` 决定。
 *
 * 为什么必须能控制内容：本组的自变量就是「拿回来的内容是不是已经见过的」——
 * 而"是不是新的"由 `RepeatGuard.noteResult` 的摘要判据决定，所以内容必须可证。
 * 用真 `read` 读真文件也行，但那样判据会依赖磁盘状态（本仓库的既有教训：别让判据看易变的东西）。
 */
function registryWithFakeRead(contentOf: (path: string) => string) {
  const registry = createDefaultToolRegistry();
  const executed: string[] = [];
  registry.register({
    id: "read",
    description: "假 read（判据夹具：内容由测试给，不读磁盘）",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    contract: {
      readOnly: true,
      sideEffectScope: "none",
      accessScope: "none",
      persistResult: false,
    },
    async execute(args: any) {
      executed.push(String(args?.path ?? ""));
      return { title: "read", output: contentOf(String(args?.path ?? "")) };
    },
  } as any);
  return { registry, executed };
}

async function drain(loop: AgenticLoop): Promise<any[]> {
  const events: any[] = [];
  for await (const e of loop.run(SESSION, "把 edit 的二义性修复找出来", CWD, "system prompt")) {
    events.push(e);
  }
  return events;
}

function endResult(events: any[]): any {
  const ends = events.filter((e) => e.type === "end");
  expect(ends.length, "每一轮都必须以恰好一个 end 事件收场").toBe(1);
  return ends[0].result;
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => String(e.text ?? ""))
    .join("");
}

describe("停滞守卫在真实循环里的行为（第 93 波治本）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGuidanceQueue().clearAll();
  });

  it("STALL-LOOP-1: 逐文件读**新内容**的大仓库探索，绝不许被判成停滞", async () => {
    const READS = 26; // > stopAfter(24)：只要判据漏掉信息增益，第 24 个迭代就会被杀
    const provider = new ScriptedProvider();
    provider.setScript([
      ...Array.from({ length: READS }, (_, i) => readIteration(`c${i}`, `${CWD}\\src\\f${i}.ts`)),
      finalIteration("读完了，开始改。"),
    ]);
    const { registry, executed } = registryWithFakeRead(
      (p) => `// ${p}\nexport function f${p.length}() {\n  return ${p.length};\n}\n`,
    );

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 60,
      model: "stall-loop-model",
      securityMode: "full",
    });
    const events = await drain(loop);
    const result = endResult(events);

    // 前置：每个读都真的执行了（不同文件不是读缓存命中）——否则"有信息增益"这个自变量不成立
    expect(executed.length, "26 个不同文件的读必须全部真的执行").toBe(READS);
    // 前置：真的跑到了第 25 个迭代之后（变异时必须在这里变红）
    expect(
      provider.requests.length,
      "循环必须跑满 26 个读迭代 + 1 个收尾迭代；若小于 26 就说明它在第 24 轮被杀掉了",
    ).toBe(READS + 1);

    expect(result.reason, "逐文件读、越读越准是称职的探索，不是停滞").not.toBe("plan_stale");
    expect(result.reason).toBe("completed");
    expect(textOf(events), "不许注入「进度自查」（那是误杀的前奏）").not.toContain("进度自查");
  });

  it("STALL-LOOP-2 反向对照: 零信息增益（内容一模一样）必须被停下来，且不许报成完成", async () => {
    // 每个迭代读**不同**文件、但**内容完全相同** ⇒ 可证明的零信息增益
    const provider = new ScriptedProvider();
    provider.setScript(
      Array.from({ length: 30 }, (_, i) => readIteration(`z${i}`, `${CWD}\\same\\f${i}.ts`)),
    );
    const { registry, executed } = registryWithFakeRead(() => "同一份内容：没有任何新信息\n");

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 60,
      model: "stall-loop-model",
      securityMode: "full",
    });
    const events = await drain(loop);
    const result = endResult(events);

    // 已在行的零增益阀门（noGainStop=6）先响 —— 它是更早、更严的那一道（见文件头"两个阀门的关系"）
    expect(result.reason, "零信息增益必须被停下").not.toBe("completed");
    expect(result.reason, "零增益由 RepeatGuard 先拦下（它的阈值 6 < 停滞阀门的 24）").toBe(
      "repeat_guard",
    );
    expect(
      provider.requests.length,
      "必须在零增益窗口内就停下（远早于 30 个迭代），而不是无限跑",
    ).toBeLessThan(15);
    expect(executed.length, "被守卫拦下的那次调用不许真的执行").toBe(provider.requests.length - 1);
  });

  it("STALL-LOOP-3: 24 个零进展迭代真的会走到 plan_stale（停滞阀门在循环里是接上的）", async () => {
    /**
     * 造法：读**同一个**文件（第 2 个迭代起是读缓存命中 ⇒ `noteResult` 不参与 ⇒
     * 零增益阀门看不到它），同时每个迭代都留一条待消费的指引
     * （`agentic-loop` 的 `guidanceQueue.hasPending → continue`）⇒
     * `toolCallsInIteration === 0` 不会把循环当成"模型自然结束"。
     * 于是"零进展迭代"能真的累积到停滞窗口 —— 这正是判据要钉的那条通路。
     */
    const ITER = 40;
    const provider = new ScriptedProvider();
    provider.setScript(
      Array.from({ length: ITER }, (_, i) => readIteration(`r${i}`, `${CWD}\\one.ts`)),
    );
    provider.onStream = () => {
      getGuidanceQueue().enqueue(SESSION, "继续（判据脚手架：让循环能累积到停滞窗口）");
    };
    const { registry, executed } = registryWithFakeRead(() => "同一个文件的内容\n");

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 60,
      model: "stall-loop-model",
      securityMode: "full",
    });
    const events = await drain(loop);
    const result = endResult(events);

    expect(executed.length, "前置：只有第 1 次是真读，其余是读缓存命中").toBe(1);
    expect(result.reason, "零进展累积到停止窗口 ⇒ 必须是 plan_stale 终态").toBe("plan_stale");
    expect(result.detail?.stalledFor, "停在哪一档要带出去（界面要用它说清「停滞了多久」）").toBe(24);
    expect(textOf(events), "第 12 个迭代必须先提醒过一次（先问、再停）").toContain("进度自查");
  });
});
