/**
 * 门禁：**活跃目标必须真的注入给模型**（而不是只写进日志）。
 *
 * ## 修的是什么
 *
 * `agentic-loop.ts` 里原有一段注释写着
 * 「Inject goal status into the system prompt for LLM awareness」，
 * 但代码只做了 `console.log(...)`，`goalSummary` 算完就丢掉 ——
 * 模型**从头到尾没看到过目标**。
 *
 * 后果是 `create_goal` 的 guidance 承诺「enable automatic continuation」变成空话：
 * 目标建了、`update_goal` 也改了状态，但循环里没有任何一处把它回灌给模型，
 * 模型自然「不记得」目标，也就谈不上自动续做。
 *
 * 这类缺陷很难被现有测试发现：没有任何东西**崩**，日志里甚至还能看到
 * 「Active goals: …」这种看起来正常的输出。只能靠断言「有没有真的进 prompt」。
 *
 * ## 断言策略（为什么不只做静态断言）
 *
 * 静态断言（源码包含注入代码）是必要的，但会假绿 ——
 * 只要注入代码被写在 `if (false)` 里同样能通过。
 * 所以这里同时做**行为**断言：用真实的 `update_goal` 工具 + 真实的 goal 存储，
 * 验证目标能被写入并被 `listGoals` 取回（注入所依赖的数据链成立），
 * 并解析源码确认注入确实发生在 `apiMessages[0].content +=` 这条路径上。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGoal, listGoals, updateGoal } from "../core/goal/goal";

const AGENTIC_LOOP = join(__dirname, "..", "core", "llm", "agentic-loop.ts");
const SESSION = "test-goal-injection-session";

describe("活跃目标注入：数据链成立", () => {
  beforeEach(() => {
    // 清掉本会话可能残留的目标，保证用例互不影响
    for (const g of listGoals(SESSION)) {
      updateGoal(g.id, { status: "cancelled" } as never);
    }
  });

  it("in_progress 目标能被 listGoals 取回（注入的数据来源）", () => {
    const created = createGoal({
      sessionId: SESSION,
      title: "注入测试目标",
      status: "in_progress",
      priority: "normal",
      successCriteria: "目标出现在 system prompt 里",
    } as never);

    const found = listGoals(SESSION, "in_progress");
    expect(found.map((g) => g.id)).toContain(created.id);
    const g = found.find((x) => x.id === created.id)!;
    expect(g.title).toBe("注入测试目标");
    // successCriteria 必须可读 —— 注入文案要把判据一起给模型，
    // 否则模型无法判断「是否已满足目标」
    expect(g.successCriteria).toBe("目标出现在 system prompt 里");
  });

  it("blocked 目标单独可查（注入会把 blocked 一并列出）", () => {
    const created = createGoal({
      sessionId: SESSION,
      title: "被阻塞的目标",
      status: "blocked",
      priority: "normal",
    } as never);

    expect(listGoals(SESSION, "blocked").map((g) => g.id)).toContain(created.id);
    // 反向对照：同一目标不应同时出现在 in_progress 列表里
    expect(listGoals(SESSION, "in_progress").map((g) => g.id)).not.toContain(created.id);
  });
});

describe("活跃目标注入：源码必须真的注入而不是只打日志", () => {
  const src = readFileSync(AGENTIC_LOOP, "utf8");

  it("存在把目标摘要拼进 system 消息的代码路径", () => {
    // 注入点特征：goalSummaryForPrompt 出现在 `sysMsg.content +=` 附近
    expect(src).toContain("goalSummaryForPrompt");
    const injectIdx = src.indexOf("# Active Goals");
    expect(injectIdx, "注入段标题 # Active Goals 必须存在").toBeGreaterThan(0);

    // 该段必须真的做字符串拼接（而不是只算出来）
    const around = src.slice(Math.max(0, injectIdx - 400), injectIdx + 1200);
    expect(around).toMatch(/content\s*\+=/);
  });

  it("声明出来的摘要变量必须真的被读用，而不是赋值后没人用", () => {
    // 这条补的是「写了变量但从不使用」这种空转（赋值完就没人读）。
    //
    // 第一版这里做的是「每一处出现都要在 40 行内看到 content +=」——
    // 那是**距离启发式**，正确代码也会红（赋值处离注入点有两百多行，
    // 中间隔着技能提示、时间上下文、surface notice 等好几段）。
    // 距离不是要守的性质，「被不被读」才是。
    const lines = src.split("\n");
    const reads = lines.filter(
      (l) =>
        l.includes("goalSummaryForPrompt") &&
        !/^\s*let\s+goalSummaryForPrompt\s*=/.test(l) && // 声明
        !/^\s*goalSummaryForPrompt\s*=/.test(l) && // 赋值
        !/^\s*\/\//.test(l), // 注释
    );
    expect(
      reads.length,
      "goalSummaryForPrompt 只有声明/赋值，没有任何地方读它 —— 目标摘要算了但没进 prompt",
    ).toBeGreaterThanOrEqual(1);

    // 且读用点必须和注入段在一起
    const injectIdx = src.indexOf("# Active Goals");
    expect(injectIdx).toBeGreaterThan(0);
    const injectSection = src.slice(injectIdx, injectIdx + 400);
    expect(injectSection).toContain("goalSummaryForPrompt");
  });

  it("注入措辞明确要求「不要重复已完成的工作」", () => {
    // 这条是刻意的：只陈述事实 + 防止模型因为看到 in_progress 就重做一遍。
    // 模型可能已经做完、只是状态没更新，硬命令「继续做」会导致重复劳动。
    const idx = src.indexOf("# Active Goals");
    const section = src.slice(idx, idx + 1200);
    expect(section).toMatch(/Do NOT redo work that is already done/i);
    expect(section).toMatch(/update_goal/);
    // 也要允许模型如实说「被卡住了」，而不是硬绕
    expect(section).toMatch(/blocked on something only the/i);
  });

  it("注入受 iteration > 1 约束（第一轮不必重复自己刚说过的目标）", () => {
    expect(src).toMatch(/this\.state\.iteration\s*>\s*1/);
  });
});
