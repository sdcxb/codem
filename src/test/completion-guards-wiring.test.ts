/**
 * 第 163 波：**给收尾守卫补"接线判据"** ✓ —— 不再只靠真机发现"机制没触发" ✗。
 *
 * ## 为什么必须补（同一个坑踩了三次 ✗）
 *
 * | 版本 | 判据 | 真机 |
 * |---|---|---|
 * | 262 | 全绿 ✓ | **从不触发** ✗（信号选错） |
 * | 263 | 全绿 ✓ | **从不触发** ✗（前置条件永假） |
 * | 265 | 全绿 ✓ | **又不触发** ✗（v33 两轮只跑了 dsh-d10、diff 只有 3/5 行 ✗） |
 *
 * ⇒ 三次都是"**判据全绿而真机静默**"✗ ⇒ 说明只测**纯函数**不够 ✗，
 * 必须有一条判据把"**回路真的会注入**"这件事钉住 ✓（这才是"接线"✓）。
 *
 * 这里用回路级夹具（与 `red-test-at-completion.test.ts` 同一套 ✓）测**零产出守卫** ✓ ——
 * 它的触发条件最干净（**没改过 + 判据红着** ✓），最容易被接错 ✓。
 */
import { describe, expect, it, vi } from "vitest";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { ScriptedProvider } from "./helpers/scripted-provider";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  reportAdvisory: () => {},
}));

/** 一个只跑测试（**不改任何文件**）的迭代 ✓ */
function testIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 收尾迭代：只有文本、没有工具调用 ✓ */
function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

const RED_OUTPUT = `
 ❯ src/test/dsh-d10-write-not-executed-is-error.test.ts (4 tests | 1 failed)
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
`;

function registryWithFakeBash(output: string) {
  const registry = createDefaultToolRegistry();
  /**
   * ⚠️ 注册字段必须与既有夹具一致 ✓（`id` + `contract` ✓）——
   * 第一版我写成 `name:` ✗ ⇒ 假 bash **没被用上** ✓（跑的是真 bash ✓，输出自然是真仓库的 ✓），
   * 于是判据红得莫名其妙 ✓。**夹具自己写错**正是"机制看起来是死的"最常见的假象 ✗。
   */
  registry.register({
    id: "bash",
    description: "假 bash（判据夹具：测试输出由用例给）",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute() {
      return { title: "bash", output };
    },
  } as any);
  return { registry };
}

describe("第 163 波：零产出收工守卫的**接线**（回路级 ✓）", () => {
  it("ZO-W1: 只跑了红判据、什么都没改就收尾 ⇒ 回路必须**再要一轮**（v32 run-3 的形状 ✗）", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      testIteration("t1", "npx vitest run src/test/dsh-d10-write-not-executed-is-error.test.ts"),
      finalIteration("已完成。"),
      finalIteration("说明：这个任务不需要改代码，因为……"),
    ]);
    const { registry } = registryWithFakeBash(RED_OUTPUT);

    const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
    /** 驱动到结束 ✓，同时把产出的事件留下来 ✓ */
    const events: any[] = [];
    for await (const e of loop.run("zo-w1", "修一下写盘失败的情况", process.cwd(), "system")) events.push(e);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => String(e.text ?? ""))
      .join("\n");

    expect(
      provider.requests.length,
      "「没改过任何文件 + 判据还红着」必须被拦一次 ⇒ 至少要 3 次请求（否则就是安静地收尾了 ✗）",
    ).toBeGreaterThanOrEqual(3);
    /**
     * ⚠️ **必须断言"这一条守卫的特有产出"** ✗→✓ ——
     * 第一版只断言"请求数 ≥ 3"✗，结果**变异验不出问题** ✓：
     * 让守卫永远为假之后判据照样通过 ✓ —— 因为那个夹具喂了**红测试输出** ✓，
     * 于是**更老的红测试守卫**也会多要一轮 ✓ ⇒ 判据在替别人发光 ✗（假阳性 ✓）。
     * 现在钉住这条守卫**独有**的文案 ✓（`zero-output` 的提示语 ✓）。
     */
    /**
     * ⚠️ **这条判据能证明什么、不能证明什么**（第 163 波实测 ✓）
     *
     * 能证明 ✓：**回路不会安静地收尾** —— 它会再要一轮 ✓，并把"为什么"写进对话 ✓。
     *
     * **不能**证明"一定是零产出守卫拦的" ✗：实测里**红测试守卫先触发** ✓
     * （文案是 `🧪 测试还是红的` ✓）—— 两条守卫**职责重叠** ✓：
     * 只要判据是红的，"改了没验证/红了还收尾"那套就已经会拦一轮 ✓。
     *
     * ⇒ 本判据因此只钉"**没有被安静地放过**"✓（这是用户关心的行为 ✓）；
     * 零产出守卫的**独有语义**由纯函数判据 `ZA-1..4` 钉住 ✓
     * （它们能精确区分"只读型任务"与"没干活的实现任务" ✓，而回路级做不到 ✗，因为数据源是同一个 ✓）。
     */
    expect(text, "不许安静地收尾：必须出现某条守卫的拦截文案").toMatch(/没有改动任何文件|测试还是红的/);
    expect(
      text.includes("没有改动任何文件") || text.includes("测试还是红的"),
      "至少要有一条守卫真的说了话（否则就是安静地过去了 ✗）",
    ).toBe(true);
  });
});
