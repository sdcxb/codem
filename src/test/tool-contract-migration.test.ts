/**
 * 过渡期门禁：把「旧的硬编码名单」与「工具自己的声明」对齐核对。
 *
 * ## 这个测试存在的理由
 *
 * 契约化要删掉 7 组名单，但**不能靠肉眼保证删得干净** ——
 * 漏声明一个工具，后果是静默的行为变化（例如 `subagent` 突然有了 60 秒超时、
 * `read` 突然不可并发）。所以要有一道机器判据：**旧名单里的每个名字，
 * 在新机制下必须得到同样的结论**。
 *
 * 具体核对三件事：
 *   A. 旧 `noTimeoutTools`（两份的并集）里的每个工具，声明后必须是 `NO_TIMEOUT`；
 *   B. 旧并发名单里的每个工具，声明后必须 `concurrencySafe === true`；
 *   C. 旧并发名单**之外**的只读工具，也必须可并发（这是修 `web_search` 那类漏洞）。
 *
 * ## 为什么用真实 registry
 *
 * 前面的测试都用 `concurrencySafeTools: [...]` 走名字兜底路径，**不覆盖生产路径**。
 * 生产路径是 `agentic-loop` 注入的 `contractOf`，它读真实注册表。所以这里必须
 * 构造真实 registry，否则测的是另一套逻辑。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { NO_TIMEOUT, resolveToolTimeout } from "../core/llm/tool-contract";
import {
  NEVER_PERSIST_TOOLS,
  shouldPersistResult,
} from "../core/llm/tool-result-storage";
import {
  createSubagentTool,
  createSendMessageTool,
  createInterruptAgentTool,
  createListAgentsTool,
  createReportTool,
} from "../core/llm/tools/subagent-tools";
import { createListSessionsTool } from "../core/session/tools";

/**
 * `wait_for_subagent` / `spawn_subagent` 是**幽灵名**：契约化前它们被写在
 * `noTimeoutTools` 里，但全仓没有任何工厂产出这两个 id。旧名单里这类的
 * 防御性条目一并列出，用来断言「它们的存在性」——不存在就不该出现在任何声明里。
 */
const GHOST_NO_TIMEOUT_NAMES = ["wait_for_subagent", "spawn_subagent"];

/** 旧 `runOneTool` 里的名单（11 个）—— 契约化前它决定「谁没有超时」。 */
const LEGACY_NO_TIMEOUT_RUN_ONE = [
  "bash",
  "wait_for_subagent",
  "spawn_subagent",
  "subagent",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "report",
  "write",
  "edit",
  "multi_edit",
];

/** 旧 `executeSingle` 里的名单（6 个）—— 与上面**不一致**，这就是多份真相的证据。 */
const LEGACY_NO_TIMEOUT_EXECUTE_SINGLE = [
  "bash",
  "wait_for_subagent",
  "spawn_subagent",
  "write",
  "edit",
  "multi_edit",
];

/** 旧并发名单（`concurrency-policy.ts`）。 */
const LEGACY_CONCURRENCY_SAFE = [
  "read",
  "grep",
  "glob",
  "lsp",
  "web_search",
  "zvec_grep_search",
  "zvec_grep_rg",
];

const DEFAULT_TIMEOUT = 60_000;

let registry: ReturnType<typeof createDefaultToolRegistry>;

beforeAll(() => {
  registry = createDefaultToolRegistry();
  // 这五个工具**不在**默认 registry 里 —— 它们由 `LLMEngine` 在 subagent runtime
  // 就绪后单独注册（`llm/index.ts:241`）。契约迁移的判据必须覆盖它们，
  // 否则「旧名单里有、新声明漏了」会在这几个工具上悄悄逃过门禁。
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
});

describe("过渡期对齐：旧超时豁免名单 → 声明", () => {
  it("旧 runOneTool 名单里的每个工具都必须声明 NO_TIMEOUT（否则会突然多出 60s 超时）", () => {
    const missing: string[] = [];
    for (const name of LEGACY_NO_TIMEOUT_RUN_ONE) {
      // 幽灵名没有真实工具，跳过（它们不该被声明，因为没有东西可声明）
      if (GHOST_NO_TIMEOUT_NAMES.includes(name)) continue;
      const c = registry.getContract(name);
      if (c.timeoutMs !== NO_TIMEOUT) missing.push(name);
    }
    expect(
      missing,
      `这些工具原来没有超时，现在会拿到 ${DEFAULT_TIMEOUT}ms 超时：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("旧名单里的幽灵名确实不存在（防御性条目不该被当成真工具）", () => {
    const real = new Set(registry.getAll().map((t) => t.id));
    for (const ghost of GHOST_NO_TIMEOUT_NAMES) {
      expect(real.has(ghost), `${ghost} 竟然存在了 —— 请更新本测试的分类`).toBe(false);
    }
  });

  it("旧 executeSingle 名单（另一份）里的工具同样必须声明 NO_TIMEOUT", () => {
    const missing: string[] = [];
    for (const name of LEGACY_NO_TIMEOUT_EXECUTE_SINGLE) {
      if (GHOST_NO_TIMEOUT_NAMES.includes(name)) continue;
      const c = registry.getContract(name);
      if (c.timeoutMs !== NO_TIMEOUT) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("两份旧名单的差集也要覆盖（正是它们不一致暴露了多份真相）", () => {
    // runOneTool 有、executeSingle 没有的那几个
    const onlyInRunOne = LEGACY_NO_TIMEOUT_RUN_ONE.filter(
      (n) => !LEGACY_NO_TIMEOUT_EXECUTE_SINGLE.includes(n) && !GHOST_NO_TIMEOUT_NAMES.includes(n),
    );
    expect(onlyInRunOne.length).toBeGreaterThan(0); // 先证明差集非空
    for (const name of onlyInRunOne) {
      expect(registry.getContract(name).timeoutMs).toBe(NO_TIMEOUT);
    }
  });

  it("只读的小工具**不该**声明 NO_TIMEOUT（要保留默认兜底）", () => {
    // 反面对照：不是所有工具都可以「永不超时」，否则超时机制等于没有
    for (const name of ["grep", "glob"]) {
      const c = registry.getContract(name);
      expect(c.timeoutMs, `${name} 不该是 NO_TIMEOUT`).not.toBe(NO_TIMEOUT);
      // 走 resolveToolTimeout 后应当是「用默认预算」
      const t = resolveToolTimeout(c, DEFAULT_TIMEOUT);
      expect(t.useTimeout).toBe(true);
      expect(t.timeoutMs).toBe(DEFAULT_TIMEOUT);
    }
  });
});

describe("过渡期对齐：旧并发名单 → 声明", () => {
  it("旧并发名单里的每个工具都仍然可并发", () => {
    const broken: string[] = [];
    for (const name of LEGACY_CONCURRENCY_SAFE) {
      if (!registry.getContract(name).concurrencySafe) broken.push(name);
    }
    expect(broken, `这些工具原来可并发，现在不行了：${broken.join(", ")}`).toEqual([]);
  });

  it("写工具一律不可并发（安全侧）", () => {
    for (const name of ["write", "edit", "multi_edit", "bash"]) {
      const c = registry.getContract(name);
      expect(c.concurrencySafe, `${name} 不该可并发`).toBe(false);
      expect(c.readOnly, `${name} 不该是只读`).toBe(false);
    }
  });
});

describe("过渡期对齐：旧落盘豁免名单 → 声明", () => {
  /**
   * 旧 `NEVER_PERSIST_TOOLS` 的完整内容（14 个）。
   *
   * 它们的共同点是「结果短但关键」：id、确认、清单。落盘会把模型必须引用的
   * 标识符换成一个文件路径 —— 模型拿不到 id 就没法继续（子智能体 id 就是典型）。
   *
   * 契约化后判据是 `contract.persistResult === false`，由
   * `shouldPersistResult()` 统一裁决；`NEVER_PERSIST_TOOLS` 只留作
   * 运行时注册工具的兜底（见该常量的注释）。
   */
  const LEGACY_NEVER_PERSIST = [
    "read",
    "subagent",
    "send_message",
    "interrupt_agent",
    "list_agents",
    "report",
    "list_sessions",
    "show_todo",
    "ask_clarification",
    "fact_check",
    "tts",
    "image_gen",
  ];

  it("旧落盘豁免的工具都必须声明 persistResult: false", () => {
    const missing: string[] = [];
    for (const name of LEGACY_NEVER_PERSIST) {
      const c = registry.getContract(name);
      if (c.persistResult !== false) missing.push(name);
    }
    expect(
      missing,
      `这些工具的结果原来不落盘，现在会落盘（模型可能拿不到里面的 id）：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("shouldPersistResult 优先读契约、契约缺失才用兜底表", () => {
    // 有契约：read 声明了 false ⇒ 不落盘
    expect(shouldPersistResult("read", (n) => registry.getContract(n))).toBe(false);
    // 有契约：write 没声明 ⇒ 落盘（缺省 true）
    expect(shouldPersistResult("write", (n) => registry.getContract(n))).toBe(true);
    // 没契约：兜底表里有的不落盘
    expect(shouldPersistResult("delegate_to_session")).toBe(false);
    // 没契约：兜底表里没有的落盘
    expect(shouldPersistResult("read")).toBe(true);
  });

  it("查询器抛错时不落盘（保守：宁可原样给模型，也不要凭空少掉 id）", () => {
    expect(
      shouldPersistResult("read", () => {
        throw new Error("boom");
      }),
    ).toBe(false);
  });

  it("旧兜底表已经缩短（不该继续承担主判据）", () => {
    // 只剩运行时注册的工具；若这里又变长，说明有人往兜底表里加东西而不是加声明
    expect(NEVER_PERSIST_TOOLS.size).toBeLessThanOrEqual(4);
  });
});

describe("过渡期对齐：只读工具都应可并发（修 web_search 那类漏洞）", () => {
  it("真实存在的只读工具都能并发 —— 不再依赖手写名单是否记得登记", () => {
    // 这些是「按契约应可并发」的只读工具；若某个只读工具漏声明 readOnly，
    // 它会掉进「独占」而不是「静默错并发」，所以这里只断言不空转。
    const known = registry.getAll();
    expect(known.length).toBeGreaterThan(5);

    const readOnly = known.filter((t) => t.contract?.readOnly === true);
    for (const t of readOnly) {
      const c = registry.getContract(t.id);
      // 例外：**会阻塞等用户输入**的只读工具不该并发（它等的是人，人不会因为
      // 并行就答得更快；而且它若与「等用户同意写文件」的确认框并发，两个框会互相盖住）。
      // 这正是 zcode 把 `userInteraction` 单列一类的原因 —— 我们用
      // `blocksOnUserInput` 表达同一件事。
      if (c.blocksOnUserInput) {
        expect(
          c.concurrencySafe,
          `${t.id} 声明了 blocksOnUserInput，必须不可并发`,
        ).toBe(false);
        continue;
      }
      expect(
        c.concurrencySafe,
        `${t.id} 声明了 readOnly 却不可并发`,
      ).toBe(true);
    }
    // 至少要有几个真的声明了（否则这条断言恒真）
    expect(readOnly.length).toBeGreaterThan(0);
    // 并且确实存在至少一个「只读但阻塞等人」的例外（否则上面那个分支是死代码）
    const blocking = readOnly.filter((t) => registry.getContract(t.id).blocksOnUserInput);
    expect(
      blocking.length,
      "没有任何「只读但阻塞等人」的工具 —— 若确实没有了，把上面那个分支删掉",
    ).toBeGreaterThan(0);
  });
});
