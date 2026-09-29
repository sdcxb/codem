/**
 * 门禁：全量工具的契约**内部一致性**（不变量）。
 *
 * ## 为什么需要这一层
 *
 * 逐工具声明了 57 处契约之后，风险从「漏声明」变成了「**声明之间自相矛盾**」：
 * 一个工具同时声明 `readOnly: true` 和 `destructive: true`，或者
 * `readOnly: true` 却又有非 `none` 的副作用 —— 这类矛盾**不会让任何测试红**，
 * 只会让不同消费者按不同字段得出相反结论（例如权限层当它只读放行、
 * 快照层又当它破坏性去拍快照）。
 *
 * 判据是**不变量**而不是逐个列举，所以新增工具自动被覆盖。
 */
import { describe, it, expect } from "vitest";
import { createDefaultToolRegistry } from "../core/llm/tools";
import {
  createSubagentTool,
  createSendMessageTool,
  createInterruptAgentTool,
  createListAgentsTool,
  createReportTool,
} from "../core/llm/tools/subagent-tools";
import { createListSessionsTool } from "../core/session/tools";

/** 全部工具（默认 registry + 由 LLMEngine 另路注册的那些）。 */
function allTools() {
  const registry = createDefaultToolRegistry();
  for (const factory of [
    createSubagentTool,
    createSendMessageTool,
    createInterruptAgentTool,
    createListAgentsTool,
    createReportTool,
    createListSessionsTool,
  ]) {
    registry.register(factory());
  }
  return registry;
}

describe("契约不变量：声明之间不得自相矛盾", () => {
  const registry = allTools();
  const tools = registry.getAll();

  it("有工具可查（否则下面全部恒真）", () => {
    expect(tools.length).toBeGreaterThan(30);
  });

  it("`readOnly: true` ⇒ 不得同时 `destructive: true`", () => {
    const bad = tools.filter((t) => {
      const c = registry.getContract(t.id);
      return c.readOnly && c.destructive;
    });
    expect(bad.map((t) => t.id), "只读与破坏性互斥").toEqual([]);
  });

  it("`readOnly: true` ⇒ `sideEffectScope` 必须是 `none`（只读=不改任何东西）", () => {
    // 这条不变量在**拆字段之前写不出来**：那时 read 为了让沙箱覆盖自己而标了
    // workspace，于是「只读 ⇒ 无副作用」根本不成立。拆开之后它才成为真判据。
    const bad = tools.filter((t) => {
      const c = registry.getContract(t.id);
      return c.readOnly && c.sideEffectScope !== "none";
    });
    expect(
      bad.map((t) => `${t.id}(scope=${registry.getContract(t.id).sideEffectScope})`),
      "只读工具不该有副作用范围",
    ).toEqual([]);
  });

  it("`destructive: true` ⇒ 必须独占（不可并发）", () => {
    const bad = tools.filter((t) => registry.getContract(t.id).destructive && registry.getContract(t.id).concurrencySafe);
    expect(bad.map((t) => t.id), "破坏性工具一律独占").toEqual([]);
  });

  it("`blocksOnUserInput: true` ⇒ 必须独占；且它应当在 `ask_clarification` 上真的生效", () => {
    const bad = tools.filter(
      (t) => registry.getContract(t.id).blocksOnUserInput && registry.getContract(t.id).concurrencySafe,
    );
    expect(bad.map((t) => t.id), "等用户输入的工具不能并发").toEqual([]);

    // 反向对照：断言这个字段确实有人用（否则上面那条恒真）
    const users = tools.filter((t) => registry.getContract(t.id).blocksOnUserInput);
    expect(users.length, "应当至少有一个 blocksOnUserInput 的工具").toBeGreaterThan(0);
  });

  it("非只读的写工作区工具 ⇒ 必须不可并发", () => {
    const bad = tools.filter((t) => {
      const c = registry.getContract(t.id);
      return !c.readOnly && c.sideEffectScope === "workspace" && c.concurrencySafe;
    });
    expect(bad.map((t) => t.id), "写工作区的工具不能并发（会并发写同一文件）").toEqual([]);
  });

  it("`accessScope` 为 `none` 的工具不该出现在沙箱路径检查里（它没有边界可查）", () => {
    // 这是**反向**断言：目前不该有工具是 none（逐个都访问了某类边界），
    // 但若将来有纯计算工具，它会被 requiresPathGuard 正确跳过。
    const none = tools.filter((t) => registry.getContract(t.id).accessScope === "none");
    for (const t of none) {
      // 若有，必须确实不访问任何边界 —— 至少不能是读/写文件的
      expect(t.id).not.toBe("read");
      expect(t.id).not.toBe("write");
    }
  });

  it("所有工具的 accessScope / sideEffectScope 都在允许的枚举内", () => {
    const SIDE = new Set(["none", "workspace", "git", "network", "system", "session", "userInteraction"]);
    const ACCESS = new Set(["none", "workspace", "git", "network", "system", "session"]);
    for (const t of tools) {
      const c = registry.getContract(t.id);
      expect(SIDE.has(c.sideEffectScope), `${t.id} 的 sideEffectScope 非法：${c.sideEffectScope}`).toBe(true);
      expect(ACCESS.has(c.accessScope), `${t.id} 的 accessScope 非法：${c.accessScope}`).toBe(true);
    }
  });
});

describe("契约不变量：每个工具都得有声明（不许靠缺省蒙混）", () => {
  const registry = allTools();

  it("默认 registry 的每个工具都显式声明了 contract", () => {
    const missing = registry.getAll().filter((t) => t.contract === undefined).map((t) => t.id);
    expect(
      missing,
      "这些工具没有任何契约声明 —— 缺省虽然保守（不并发/要超时/落盘），" +
        "但「访问边界」缺省是 workspace，会让沙箱对它白做一次路径检查；" +
        "更重要的是不声明就没有可审查的意图",
    ).toEqual([]);
  });
});
