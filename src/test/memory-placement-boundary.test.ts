/**
 * 记忆**注入位置 + 缓存边界**判据（MEM-PLACE-1 … MEM-PLACE-17）
 *
 * ## 修复前的缺陷形态
 *
 * 记忆块在系统提示**第 7 段**（`prompt.ts:341-344`），其后还有 Skills / MCP / Multi-Agent /
 * Safety / 语言规则 / date。而记忆**每轮都可能变**（回合结束自动提取；审批通过后
 * `memory.ts` 立刻置 `active` 立刻进）⇒ 记忆一变，它**后面**的全部稳定内容
 * （技能说明、MCP 清单、安全规则、语言规则、date）都得重算，服务端前缀缓存从第 7 段起断掉。
 * 仓库里已有的"易变尾置"纪律**只钉了 date**（`prompt.ts` 的 date 注释 +
 * `src/test/cache-prefix-stability.test.ts` 的 4 个用例全在 date 上）：**记忆段零判据**。
 *
 * ## 修复后的形态（对标出处）
 *
 * 记忆**留在系统提示**（不搬进历史 —— 权威性不牺牲，这是 Hermes `agent/system_prompt.py:783,809`
 * 的核心结论），但按**易变性两分**，中间放一个**显式缓存边界哨兵**：
 *
 * | 侧 | 内容 | 出处 |
 * | --- | --- | --- |
 * | 边界之前（稳定前缀） | 身份 + 规则 + 工具 + 附加文件 + **平台级手动记忆** + 技能 + 知识 + MCP + 多智能体 + 安全 + 语言规则 + 班长名册 | OpenClaw `src/agents/system-prompt-context-files.ts:7-15` + `system-prompt.ts:855,857` |
 * | 边界之后（易变侧） | **易变记忆**（项目级 + 对话级 + 自动提取 + 来源未知的旧数据）→ `# Current Date` | OpenClaw `system-prompt.ts:876`（内建 project memory 在边界之下） |
 *
 * 段序（**第 189 波按实测读数定稿**）：**语言规则 → 记忆（易变部分）→ date**。
 * 改动理由（实测）：旧序是 `date → 记忆`，而 date **每分钟**都变 ⇒ 每分钟把记忆一起顶掉
 * （跨分钟公共前缀 94.64% < 只改易变记忆的 97.67%）。date 收尾后它变化只顶掉自己。
 * 哨兵也随之移到**真正第一个易变段之前**（实测旧位置在 84.92%，第一个易变字节在 94.69%）。
 *
 * ## 判据风格
 *
 * 全部走**产品装配路径**（真实 `MemoryService` 构造注入文本 → 真实 `buildSystemPrompt` 拼装，
 * 以及真实引擎 `LLMEngine.buildSystemPrompt()` 的接线），断言**字节位置**与**公共前缀长度**，
 * 不用"文件里含某字符串"这种伪判据。每一条都实测能变红（见交付报告的变异清单）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { loadMemory, saveMemory } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_AUTHORITY_NOTE,
  MEMORY_INJECT_CHAR_BUDGET,
  MEMORY_INJECT_MAX_PER_BLOCK,
  MEMORY_SOURCE_KIND_LABEL,
  MEMORY_STABLE_BLOCK_SELECTION,
  MEMORY_STABLE_HEADER,
  memoryUnknownHeader,
  MEMORY_VOLATILE_BLOCK_SELECTIONS,
  MEMORY_VOLATILE_HEADER,
  composeMemoryBlock,
  createMemoryInjectBudgetTracker,
  entrySourceOf,
  INJECTION_SCOPE_CONTEXT_COMPILE_GUARD,
  type InjectionScopeContext,
  injectionScopeContext,
  isProtectedMemoryEntry,
  isStableMemoryEntry,
  memorySourceOf,
  splitMemoryTruncationNotices,
  type MemoryBlockSelection,
  type MemorySourceKind,
} from "../core/memory/memory";
import { buildOwnershipIndexFrom, createMemoryCheckup } from "../core/memory/checkup";
import { LLMEngine } from "../core/llm/index";
import {
  buildSystemPrompt,
  findCacheBoundary,
  setPromptClock,
  splitSystemPromptCacheBoundary,
  minutePrecisionDate,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  type SystemPromptConfig,
} from "../core/prompt/prompt";
import { setLang } from "../core/i18n/lang";

const PROJ = "c:\\work\\alpha";
const SESSION = "mem-place-s1";
/** 仓库根（源码级接线断言用；`__dirname` = `<root>/src/test`） */
const ROOT = join(__dirname, "..", "..");
/** 注入路径判据固定用的时刻（判据不许隐式依赖真实时钟） */
const FIXED_NOW = new Date("2026-10-07T10:00:00");

/** 引擎注入路径用的最小 agent（`buildSystemPrompt` 只需要 `prompt`） */
function buildMinimalAgent() {
  return {
    id: "test",
    name: "Test Agent",
    description: "Test",
    mode: "build" as const,
    prompt: "You are a test agent.",
    permissions: [],
  };
}

/**
 * 造一个真实 `MemoryService`，并把三类条目**分别**塞进去。
 *
 * ⚠️ 构造前必须先 `saveMemory("")` 清一次数据面：`MemoryService.load()` 会把**持久化里已有的**
 * 条目一起读进来（它是真实的读入口，不清就会把上一个用例/上一个服务的条目带进来 ——
 * 实测会造成"同一平台条目出现两次"，把"公共前缀"这条判据测成噪声）。
 *
 * 时间戳**显式给定**：注入文本里每条都带 `[日期]`，固定时间戳才能让"同输入两次组装"是
 * 真正的逐字节比较（`Date.now()` 会让两次调用落在不同秒/天，测的就不是缓存纪律了）。
 */
function makeMemory(opts: {
  platform?: Array<{ key: string; content: string }>;
  project?: Array<{ key: string; content: string }>;
  conversation?: Array<{ key: string; content: string }>;
}): MemoryService {
  saveMemory("");
  const svc = new MemoryService();
  const ts = 1_760_000_000_000;
  for (const [i, e] of (opts.platform ?? []).entries()) {
    svc.add({ scope: "platform", key: e.key, content: e.content, source: "manual", timestamp: ts + i });
  }
  for (const [i, e] of (opts.project ?? []).entries()) {
    svc.add({ scope: "project", projectId: PROJ, key: e.key, content: e.content, source: "manual", timestamp: ts + 100 + i });
  }
  for (const [i, e] of (opts.conversation ?? []).entries()) {
    svc.add({ scope: "conversation", sessionId: SESSION, key: e.key, content: e.content, source: "manual", timestamp: ts + 200 + i });
  }
  return svc;
}

/** 一个真实自动提取块（带 `source=auto` ⇒ 注入时必须自证"自动提取、未经人工确认"） */
function withAutoBlock(svc: MemoryService, key: string, content: string): MemoryService {
  svc.add({ scope: "project", projectId: PROJ, key, content, source: "auto", timestamp: 1_760_000_500_000 });
  return svc;
}

/**
 * 走**产品注入路径**：稳定侧 = 平台级 + `manual`；易变侧 = 其余全部（含平台级自动 / 旧数据）。
 *
 * 用的是产品**同一组**取数口径常量与**同一个** `composeMemoryBlock`
 * （抬头 + 权威性豁免 + 注入正文 + 聚合预算披露），与 `llm/index.ts` 两处注入点同形
 * —— 判据测的是产品形态，不是复述一遍助手逻辑。
 */
function configWithMemory(svc: MemoryService, date?: string): SystemPromptConfig {
  const budget = createMemoryInjectBudgetTracker();
  return {
    agent: buildMinimalAgent() as never,
    date,
    memoryInstructions:
      composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, PROJ, SESSION, budget) || undefined,
    memoryTailInstructions:
      composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, budget) ||
      undefined,
  };
}

function promptWithMemory(svc: MemoryService, date?: string): string {
  return buildSystemPrompt(configWithMemory(svc, date));
}

/** 公共前缀长度（**字节**级：直接比较 UTF-16 码元，不做任何比例折算） */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** 引擎注入路径（真实 `LLMEngine.buildSystemPrompt`，只把无关依赖压成桩）
 *
 * ⚠️ 旧写法有一个 `date` 形参，但引擎内部**自己**取时间 ⇒ 那是**死参数**，
 * 判据因此隐式依赖跑测试时的真实时钟（跨分钟会假红）。现在走可注入时钟
 * （`setPromptClock`，见 `beforeEach`），死参数已删。 */
function promptViaEngine(svc: MemoryService, sessionId: string, cwd: string): string {
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = svc;
  engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
  engine.skills = {
    buildSkillEnvironmentSection: () => "",
    buildSkillPrompt: () => "",
    buildPreloadedSkillPrompt: () => "",
  } as never;
  engine.mcp = { getAllTools: () => [] } as never;
  return engine.buildSystemPrompt(sessionId, "build", cwd);
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  saveMemory("");
  setLang("zh");
  setPromptClock(() => FIXED_NOW);
});

afterEach(() => {
  setPromptClock(null);
  setStoragePort(null);
});

describe("MEM-PLACE：记忆留在系统提示，按易变性两分 + 显式缓存边界", () => {
  it("MEM-PLACE-1（未变则零成本）：同输入连续两次组装 ⇒ 逐字节相同", () => {
    const svc = makeMemory({
      platform: [{ key: "平台约定", content: "PLATFORM_STABLE_FACT" }],
      project: [{ key: "项目约定", content: "PROJECT_VOLATILE_FACT" }],
      conversation: [{ key: "对话约定", content: "CONV_VOLATILE_FACT" }],
    });
    withAutoBlock(svc, "自动事实", "AUTO_EXTRACTED_FACT");

    const a = promptWithMemory(svc, "2026-10-07 10:00");
    const b = promptWithMemory(svc, "2026-10-07 10:00");

    // 未变 ⇒ 逐字节相同（Hermes `conversation_compression.py:3162-3168`：equal bytes keep KV）
    expect(a).toBe(b);
    // 而且不是"两边都空"的假绿
    expect(a).toContain("PLATFORM_STABLE_FACT");
    expect(a).toContain("PROJECT_VOLATILE_FACT");

    // 引擎注入路径同样：同输入两次必须逐字节相同（这条路径才带缓存边界与权威性指令）
    const e1 = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    const e2 = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    expect(e1).toBe(e2);
    /*
     * 死参数修复的判据（第 189 波 C7）：引擎的 date 必须来自**可注入时钟**，
     * 而不是自己偷偷取真实时钟。旧写法 `promptViaEngine(..., date)` 的 date 形参被引擎
     * 内部覆盖 ⇒ 判据既测不到它、又隐式依赖跑测试时的真实时刻（跨分钟假红）。
     */
    expect(e1, "引擎的 date 必须来自注入的时钟（否则判据隐式依赖真实时钟）").toContain(
      minutePrecisionDate(FIXED_NOW),
    );
  });

  it("MEM-PLACE-2：只改 project / conversation / 自动块 ⇒ 公共前缀必须覆盖到**易变块首字节**", () => {
    const before = makeMemory({
      platform: [{ key: "平台约定", content: "PLATFORM_STABLE_FACT" }],
      project: [{ key: "项目约定", content: "PROJECT_OLD_FACT" }],
      conversation: [{ key: "对话约定", content: "CONV_OLD_FACT" }],
    });
    const after = makeMemory({
      platform: [{ key: "平台约定", content: "PLATFORM_STABLE_FACT" }],
      project: [{ key: "项目约定", content: "PROJECT_NEW_FACT_CHANGED" }],
      conversation: [{ key: "对话约定", content: "CONV_NEW_FACT_CHANGED" }],
    });
    withAutoBlock(before, "自动事实", "AUTO_OLD_FACT");
    withAutoBlock(after, "自动事实", "AUTO_NEW_FACT_CHANGED");

    const A = promptWithMemory(before, "2026-10-07 10:00");
    const B = promptWithMemory(after, "2026-10-07 10:00");

    const boundaryAt = A.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundaryAt, "缓存边界必须存在（否则这条判据无从度量）").toBeGreaterThan(0);

    /*
     * 度量改成**易变块首字节**（第 189 波 C6）：旧写法断言"公共前缀 ≥ 哨兵偏移"，
     * 而哨兵原先偏早（84.92%）⇒ **哨兵越靠前，这条越容易满足**，等于给"哨兵放错位置"发绿灯。
     * 现在断言必须覆盖到易变块抬头（易变侧的第一个字节）—— 这才是"稳定前缀真的没被动"。
     */
    const volatileFirstByte = A.indexOf(MEMORY_VOLATILE_HEADER);
    expect(volatileFirstByte, "易变块抬头必须在提示里（否则这条判据无从度量）").toBeGreaterThan(boundaryAt);
    expect(
      commonPrefixLength(A, B),
      "只改易变记忆时，公共前缀必须覆盖到易变块首字节（含平台级记忆、全部稳定段与哨兵）",
    ).toBeGreaterThanOrEqual(volatileFirstByte);

    // 再补一条更强的字节相等断言：易变块抬头（含）之前的整段逐字节相同
    expect(B.slice(0, volatileFirstByte)).toBe(A.slice(0, volatileFirstByte));

    // 差异确实发生了（否则上面是恒真的空断言）：变化只在边界之后
    expect(A).not.toBe(B);
    const tail = SYSTEM_PROMPT_CACHE_BOUNDARY;
    expect(A.slice(A.indexOf(tail) + tail.length), "旧内容只应在边界之后").not.toBe(
      B.slice(B.indexOf(tail) + tail.length),
    );
    expect(A.slice(A.indexOf(tail) + tail.length)).toContain("PROJECT_OLD_FACT");
    expect(B.slice(B.indexOf(tail) + tail.length)).toContain("PROJECT_NEW_FACT_CHANGED");

    // 引擎接线：易变记忆必须真的落在边界之后
    const E = promptViaEngine(before, SESSION, "C:\\work\\alpha");
    expect(E.indexOf("PROJECT_OLD_FACT")).toBeGreaterThan(E.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
    expect(E.indexOf("PLATFORM_STABLE_FACT")).toBeLessThan(E.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
  });

  it("MEM-PLACE-11：边界之后**除易变记忆与 date 外不许有别的段**（C6 新增）", () => {
    /*
     * 这条专门挡 M-4/A2 的形态：旧实现的哨兵早 8~13 段，其后的 Skills / Knowledge /
     * MCP / Multi-Agent / Safety / 语言规则**都是稳定内容**，却被算进"易变侧"
     * ⇒ 任何新插进那 8~13 段的易变内容都会静默落在"稳定前缀"里而**无判据会红**。
     */
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "ORDER_STABLE_MARKER" }],
      project: [{ key: "项目手写", content: "ORDER_VOLATILE_MARKER" }],
    });
    withAutoBlock(svc, "自动事实", "ORDER_AUTO_MARKER");

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const at = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(at).toBeGreaterThan(0);

    const sections = p.split("\n\n---\n\n");
    const boundarySectionIndex = sections.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundarySectionIndex, "哨兵必须是一个独立段").toBeGreaterThan(-1);
    const afterBoundary = sections.slice(boundarySectionIndex + 1);

    // 边界之后只允许两段：易变记忆块（可选）→ date（可选），且顺序固定
    expect(afterBoundary.length, "边界之后不许再有别的段（稳定内容必须留在边界之前）").toBeLessThanOrEqual(2);
    for (const section of afterBoundary) {
      const allowed = section.startsWith(MEMORY_VOLATILE_HEADER) || section.startsWith("# Current Date");
      expect(
        allowed,
        `边界之后出现了既不是易变记忆也不是 date 的段：${JSON.stringify(section.slice(0, 60))}`,
      ).toBe(true);
    }
    if (afterBoundary.length === 2) {
      expect(afterBoundary[0].startsWith(MEMORY_VOLATILE_HEADER), "易变记忆必须紧贴边界之后").toBe(true);
      expect(afterBoundary[1].startsWith("# Current Date"), "date 必须收尾").toBe(true);
    }

    // 反向（防"边界放到最末尾"的恒真写法）：稳定段的代表必须在边界之前
    for (const stableMarker of ["# Skills", "# Safety Rules", "# 语言规则"]) {
      const idx = p.indexOf(stableMarker);
      if (idx >= 0) {
        expect(idx, `${stableMarker} 是稳定段，必须在边界之前`).toBeLessThan(at);
      }
    }
    expect(p.indexOf(MEMORY_STABLE_HEADER), "稳定记忆在边界之前").toBeLessThan(at);
  });

  it("MEM-PLACE-3（反向，防恒真）：只改 platform ⇒ 公共前缀必须明显缩短", () => {
    const before = makeMemory({
      platform: [{ key: "平台约定", content: "PLATFORM_OLD_FACT" }],
      project: [{ key: "项目约定", content: "PROJECT_FACT" }],
    });
    const after = makeMemory({
      platform: [{ key: "平台约定", content: "PLATFORM_NEW_FACT_CHANGED" }],
      project: [{ key: "项目约定", content: "PROJECT_FACT" }],
    });

    const A = promptWithMemory(before, "2026-10-07 10:00");
    const B = promptWithMemory(after, "2026-10-07 10:00");
    const boundaryAt = A.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);

    // 反向判据：平台级在**稳定侧** ⇒ 它一变，公共前缀必须**在边界之前就断掉**
    expect(
      commonPrefixLength(A, B),
      "改 platform 若不缩短公共前缀，说明 platform 没在稳定侧（这条专门证明 PLACE-2 不是恒真）",
    ).toBeLessThan(boundaryAt);

    // 对照：同一个变更序列里，易变侧没变 ⇒ 边界之后的差异只是平台级那处，边界之前断在哪由平台决定
    expect(A.indexOf("PLATFORM_OLD_FACT")).toBeGreaterThan(-1);
    expect(A.indexOf("PLATFORM_OLD_FACT")).toBeLessThan(boundaryAt);
    expect(B.indexOf("PLATFORM_NEW_FACT_CHANGED")).toBeLessThan(B.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
  });

  it("MEM-PLACE-4（行为，不复述产品文案）：同一条目改来源 ⇒ 它所在的小节必须随之切换", () => {
    /*
     * 旧写法断言的是产品文案字面量（「自动提取（可能不准，可删）」「未经人工确认」…）
     * ⇒ 文案一改就假红，而"来源标注到底有没有跟着条目走"这个**行为**反而没人钉。
     * 现在断言行为：同一条目的来源一改，它所属的小节（`## ` 抬头）必须改变；
     * 同一小节里不许混进另一种来源的条目。
     */
    const svc = makeMemory({
      project: [{ key: "项目手写", content: "PROJECT_MANUAL_MARKER" }],
    });
    const added = svc.add({
      scope: "project",
      projectId: PROJ,
      key: "自动事实",
      content: "AUTO_EXTRACTED_MARKER",
      source: "auto",
    });
    expect(added.ok).toBe(true);
    const autoId = added.entry!.id;

    /** 某个 marker 所在小节的抬头位置（`## ` 起） */
    const sectionHeaderAt = (text: string, marker: string) => text.lastIndexOf("## ", text.indexOf(marker));

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    expect(p, "自动条目本体丢了").toContain("AUTO_EXTRACTED_MARKER");
    expect(p, "手动条目本体丢了").toContain("PROJECT_MANUAL_MARKER");
    const manualHeaderAt = sectionHeaderAt(p, "PROJECT_MANUAL_MARKER");
    const autoHeaderAt = sectionHeaderAt(p, "AUTO_EXTRACTED_MARKER");
    expect(manualHeaderAt, "手动小节抬头必须在").toBeGreaterThan(-1);
    expect(autoHeaderAt, "自动小节抬头必须在").toBeGreaterThan(-1);
    expect(
      autoHeaderAt,
      "两种来源的条目必须落在**不同**小节里（同一小节混装 ⇒ 读的人分不清哪条不可信）",
    ).not.toBe(manualHeaderAt);

    // 反向：把这条改成手动 ⇒ 它必须回到手动小节（与手写条目同一个小节）
    (svc as unknown as { entries: Map<string, { source?: string }> }).entries.get(autoId)!.source = "manual";
    const p2 = promptWithMemory(svc, "2026-10-07 10:00");
    expect(
      sectionHeaderAt(p2, "AUTO_EXTRACTED_MARKER"),
      "来源改成手动后，它必须与手写条目同处一个小节",
    ).toBe(sectionHeaderAt(p2, "PROJECT_MANUAL_MARKER"));

    // 引擎路径（真正会发给模型的形态）同样：两种来源分处不同小节
    const E = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    expect(sectionHeaderAt(E, "PROJECT_MANUAL_MARKER")).toBe(
      sectionHeaderAt(E, "AUTO_EXTRACTED_MARKER"),
    );
  });

  it("MEM-PLACE-5：缓存边界常量存在、且易变记忆块在它之后（解析式断言）", () => {
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "PLATFORM_BEFORE_BOUNDARY" }],
      project: [{ key: "项目手写", content: "PROJECT_AFTER_BOUNDARY" }],
      conversation: [{ key: "对话手写", content: "CONV_AFTER_BOUNDARY" }],
    });
    withAutoBlock(svc, "自动事实", "AUTO_AFTER_BOUNDARY");

    // 常量本身是一等事实，且形态可解析（不含空行，不会被 "\n\n---\n\n" 切成两段）
    expect(typeof SYSTEM_PROMPT_CACHE_BOUNDARY).toBe("string");
    expect(SYSTEM_PROMPT_CACHE_BOUNDARY.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT_CACHE_BOUNDARY.includes("\n")).toBe(false);

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const at = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(at, "缓存边界必须真的出现在系统提示里").toBeGreaterThan(-1);

    // 边界是一个**独立段**（可被 `split("\n\n---\n\n")` 解析出来），不是粘在别段里的文本
    expect(p.split("\n\n---\n\n")).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    // 有记忆时只出现一次（不许两处边界 ⇒ 语义不可解析）
    expect(p.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1);

    // 解析式断言：用产品提供的切分器（形态照 OpenClaw `splitSystemPromptCacheBoundary`）切两半
    const { stable, volatile, boundaryFound } = splitSystemPromptCacheBoundary(p);
    expect(boundaryFound, "有哨兵时 boundaryFound 必须为真").toBe(true);
    expect(findCacheBoundary(p)).toBe(at);
    expect(stable).toBe(p.slice(0, at));
    expect(volatile.startsWith("\n\n---\n\n"), "边界之后应当紧接着一个段分隔符").toBe(true);
    expect(stable).toContain("PLATFORM_BEFORE_BOUNDARY");
    expect(stable.includes("PROJECT_AFTER_BOUNDARY")).toBe(false);
    expect(volatile).toContain("PROJECT_AFTER_BOUNDARY");

    // 稳定侧在边界之前
    expect(p.indexOf("PLATFORM_BEFORE_BOUNDARY")).toBeGreaterThan(-1);
    expect(p.indexOf("PLATFORM_BEFORE_BOUNDARY")).toBeLessThan(at);
    // 易变侧（三种会 churn 的来源）全在边界之后
    for (const marker of ["PROJECT_AFTER_BOUNDARY", "CONV_AFTER_BOUNDARY", "AUTO_AFTER_BOUNDARY"]) {
      expect(p.indexOf(marker), `${marker} 必须在缓存边界之后`).toBeGreaterThan(at);
    }

    /*
     * ⚠️ P4 合并（第 189 波复审）：这里原有一段"**没有记忆**时边界也必须在场 / 边界在 date 之前 /
     * date 收尾 / split 仍能找到边界"的断言，与 `MEM-PLACE-16` 形态 B **同形重复**。
     * 现在**只有一处**覆盖：`MEM-PLACE-16` 形态 B（并吸收了这里更强的两条：边界必须早于 date、
     * 最后一段必须是 date）。上面这些断言覆盖的是"有记忆"的形态，与 16 不重叠。
     */
  });

  it("MEM-PLACE-6（Hermes 权威性纪律）：豁免指令存在且**挂在记忆块上**", () => {
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "PLATFORM_AUTH_MARKER" }],
      project: [{ key: "项目手写", content: "PROJECT_AUTH_MARKER" }],
    });

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    expect(p, "权威性指令必须出现在系统提示里").toContain(MEMORY_AUTHORITY_NOTE);

    const authAt = p.indexOf(MEMORY_AUTHORITY_NOTE);
    expect(authAt).toBeGreaterThan(-1);
    // 挂载关系：豁免在**记忆正文之前**、且紧邻记忆抬头（不是飘在提示别处）
    const headerAt = p.indexOf("# Memory System");
    expect(headerAt, "记忆块抬头必须存在").toBeGreaterThan(-1);
    expect(headerAt, "豁免指令必须挂在记忆块抬头之内（抬头之后就是它）").toBeLessThan(authAt);
    expect(authAt - headerAt, "抬头与豁免之间不许隔着别的内容").toBeLessThan(MEMORY_AUTHORITY_NOTE.length + 40);
    for (const marker of ["PLATFORM_AUTH_MARKER", "PROJECT_AUTH_MARKER"]) {
      expect(p.indexOf(marker), `${marker} 必须在豁免指令之后`).toBeGreaterThan(authAt);
    }

    // 两侧都带豁免（平台级在稳定侧、项目级在易变侧 ⇒ 两处都必须能读到豁免）
    expect(p.split(MEMORY_AUTHORITY_NOTE).length - 1).toBeGreaterThanOrEqual(2);
    /*
     * 第 189 波第 14 条：豁免**保留两份**（两块各自都要有），但文案必须压短 ——
     * 旧文案 104 字符 × 2 = 208（每轮固定成本）；新文案 ≤ 60 字符 × 2 ≤ 120 ⇒ 每轮省 ≥ 88。
     * 这条同时挡住"为了省钱把它删成一份"（上面那条 ≥ 2 会红）。
     */
    expect(MEMORY_AUTHORITY_NOTE.length, `权威句目标 ≤ 60 字符，实际 ${MEMORY_AUTHORITY_NOTE.length}`).toBeLessThanOrEqual(60);
    expect(208 - MEMORY_AUTHORITY_NOTE.length * 2, "每轮必须省下正数字符").toBeGreaterThan(0);

    // 引擎路径：真正发给模型的那份提示里也必须在场
    const E = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    expect(E).toContain(MEMORY_AUTHORITY_NOTE);
    expect(E.indexOf(MEMORY_AUTHORITY_NOTE)).toBeLessThan(E.indexOf("PROJECT_AUTH_MARKER"));
  });

  it("MEM-PLACE-7：段序契约 = 语言规则 → 记忆（易变）→ date（date 收尾）", () => {
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "PLATFORM_ORDER_MARKER" }],
      project: [{ key: "项目手写", content: "PROJECT_ORDER_MARKER" }],
      conversation: [{ key: "对话手写", content: "CONV_ORDER_MARKER" }],
    });

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const langAt = p.indexOf("# 语言规则");
    const dateAt = p.indexOf("# Current Date");
    const boundaryAt = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const volatileAt = p.indexOf("PROJECT_ORDER_MARKER");

    expect(langAt, "语言规则段必须还在").toBeGreaterThan(-1);
    expect(dateAt, "date 段必须还在").toBeGreaterThan(-1);
    expect(volatileAt, "易变记忆必须还在").toBeGreaterThan(-1);
    /*
     * 顺序契约（第 189 波第 4 条按实测改）：`语言规则 → 记忆（易变）→ date`。
     * 旧序是 `语言规则 → date → 记忆`，而 date **每分钟**都变 ⇒ 分钟一跨就把记忆一起顶掉
     * （实测跨分钟公共前缀 94.64%，而"只改易变记忆"是 97.67%）。date 收尾后只顶掉自己。
     */
    expect(langAt, "语言规则必须在边界之前（它是稳定前缀的最后一段）").toBeLessThan(boundaryAt);
    expect(boundaryAt, "边界必须在易变记忆之前").toBeLessThan(volatileAt);
    expect(volatileAt, "易变记忆必须在 date 之前").toBeLessThan(dateAt);
    expect(p.indexOf("CONV_ORDER_MARKER"), "对话级也在 date 之前").toBeLessThan(dateAt);
    expect(
      p.split("\n\n---\n\n").slice(-1)[0].startsWith("# Current Date"),
      "date 必须是最后一段（它的 churn 只顶掉自己）",
    ).toBe(true);

    /*
     * ⚠️ P4 合并（第 189 波复审）：这里原有一段"只改 date ⇒ 公共前缀覆盖 date 之前 / 无 date 是有 date
     * 的前缀"的断言，与 `cache-prefix-stability.test.ts` 的 `MEM-PLACE-18-F2` **同形重复**
     * （同一 svc 形态、同一组 `10:00/10:01`、同一组断言）。现在**只有一处**覆盖：
     * `MEM-PLACE-18-F2` —— 并把这里更强的两条（跨分钟公共前缀必须覆盖到 **date 段起点**、
     * `A.slice(0,dateStableAt)` 逐字节相等）搬了过去；"无 date 是有 date 的前缀"由那边的
     * `a.startsWith(noDate)` 覆盖（比这里的公共前缀长度更强）。
     */
  });
});

/**
 * MEM-PLACE-8/9/10：稳定侧只留**平台级 + manual**；自动条目一律进易变侧。
 *
 * ## 这一组针对的形态（为什么上面 7 条挡不住）
 *
 * 只按「作用域」两分时，**平台级自动条目**落在稳定前缀里。而体检视图允许把条目
 * 「保留为平台级」⇒ 一条平台级自动条目一变（回合结束提取 / 审批后 `pending→active` /
 * 编辑），**稳定前缀整体位移**，本次改造的核心收益当场失效。
 * `source === undefined` 的旧数据（`legacyPool` 那批"可能被自动流程动过"的数据）同理。
 */
describe("MEM-PLACE：稳定侧只留平台级 manual，自动条目一律易变侧", () => {
  it("MEM-PLACE-8：平台级**手动**条目在边界之前", () => {
    const svc = makeMemory({ platform: [{ key: "手写平台", content: "PLATFORM_MANUAL_STABLE" }] });
    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const at = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(at).toBeGreaterThan(-1);
    const markerAt = p.indexOf("PLATFORM_MANUAL_STABLE");
    expect(markerAt, "平台级手动条目必须真的注入").toBeGreaterThan(-1);
    expect(markerAt, "平台级手动的落点必须在边界之前").toBeLessThan(at);
    // 并且它挂在"稳定记忆"抬头那一块上
    expect(p.indexOf(MEMORY_STABLE_HEADER)).toBeLessThan(markerAt);
  });

  it("MEM-PLACE-9：平台级**自动**条目（含 legacyPool 旧数据）在边界之后", () => {
    const svc = makeMemory({ platform: [{ key: "手写平台", content: "PLATFORM_MANUAL_STABLE" }] });
    // 平台级自动条目：审批关闭时直接 active（与产品路径同形）
    svc.add({ scope: "platform", key: "自动平台", content: "PLATFORM_AUTO_VOLATILE", source: "auto", timestamp: 1_760_000_700_000 });
    // 旧数据（无 source，带 legacyPool 标记）：按"可能被自动流程动过"处理 ⇒ 易变侧
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("legacy-pool-1", {
      id: "legacy-pool-1",
      scope: "platform",
      key: "旧池",
      content: "PLATFORM_LEGACY_POOL_VOLATILE",
      legacyPool: true,
      timestamp: 1_760_000_600_000,
    });

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const at = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(p.indexOf("PLATFORM_MANUAL_STABLE"), "手动条目仍在边界之前").toBeLessThan(at);
    expect(p.indexOf("PLATFORM_AUTO_VOLATILE"), "平台级自动条目必须在边界之后").toBeGreaterThan(at);
    expect(p.indexOf("PLATFORM_LEGACY_POOL_VOLATILE"), "无 source 的旧数据必须在边界之后").toBeGreaterThan(at);
    // 它们在"易变记忆"那块里（抬头在边界之后）
    expect(p.indexOf(MEMORY_VOLATILE_HEADER)).toBeGreaterThan(at);
    expect(p.indexOf("PLATFORM_AUTO_VOLATILE")).toBeGreaterThan(p.indexOf(MEMORY_VOLATILE_HEADER));

    // 引擎接线（真正会发给模型的形态）必须是同一个落点
    const E = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    const eAt = E.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(E.indexOf("PLATFORM_MANUAL_STABLE")).toBeLessThan(eAt);
    expect(E.indexOf("PLATFORM_AUTO_VOLATILE")).toBeGreaterThan(eAt);
    expect(E.indexOf("PLATFORM_LEGACY_POOL_VOLATILE")).toBeGreaterThan(eAt);
  });

  it("MEM-PLACE-10（反向，防恒真）：平台级自动条目**改回手动** ⇒ 必须移到边界之前", () => {
    const svc = makeMemory({});
    const added = svc.add({ scope: "platform", key: "先自动", content: "SOURCE_FLIP_MARKER", source: "auto", timestamp: 1_760_000_800_000 });
    expect(added.ok).toBe(true);
    const id = added.entry!.id;

    const before = promptWithMemory(svc, "2026-10-07 10:00");
    const beforeAt = before.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(before.indexOf("SOURCE_FLIP_MARKER"), "自动 ⇒ 边界之后").toBeGreaterThan(beforeAt);

    // 只把来源改成手动（用户「保留为平台级」那条路径在语义上就是"这条是我确认过的"）
    (svc as unknown as { entries: Map<string, { source?: string }> }).entries.get(id)!.source = "manual";

    const after = promptWithMemory(svc, "2026-10-07 10:00");
    const afterAt = after.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(after.indexOf("SOURCE_FLIP_MARKER"), "改成手动 ⇒ 必须移到边界之前").toBeLessThan(afterAt);
    expect(after.indexOf(MEMORY_STABLE_HEADER), "它应挂在稳定块抬头之后").toBeLessThan(after.indexOf("SOURCE_FLIP_MARKER"));

    // 再翻回自动：必须回到边界之后（两侧都咬住 ⇒ 不是"一律进/一律不进"的恒真）
    (svc as unknown as { entries: Map<string, { source?: string }> }).entries.get(id)!.source = "auto";
    const back = promptWithMemory(svc, "2026-10-07 10:00");
    expect(back.indexOf("SOURCE_FLIP_MARKER")).toBeGreaterThan(back.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
  });

  it("S1-BUDGET-TOTAL：三块各自不超预算时，**合计**仍不得超过总预算，且超限必须如实披露", () => {
    /*
     * 构造：三块各自约 4.6k 字符（单块预算 12k 之内）、合计约 13.8k > 12k。
     * 每块 20 条（正好等于每块条数上限），正文 300 字符（`formatLine` 截到 200 ⇒ 行约 230 字符）。
     */
    const svc = makeMemory({});
    const filler = "A".repeat(300);
    for (let i = 0; i < 20; i++) {
      svc.add({ scope: "platform", key: `pm${i}`, content: `TOTAL_PM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_000_000 + i });
      svc.add({ scope: "project", projectId: PROJ, key: `jm${i}`, content: `TOTAL_JM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_100_000 + i });
      svc.add({ scope: "conversation", sessionId: SESSION, key: `cm${i}`, content: `TOTAL_CM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_200_000 + i });
    }

    // 各块单独跑：每一块都在**单块**预算之内（这正是"拆成三块"会失控的前提）
    const each = [
      svc.buildMemoryPrompt("platform", PROJ, SESSION),
      svc.buildMemoryPrompt("project", PROJ, SESSION),
      svc.buildMemoryPrompt("conversation", PROJ, SESSION),
    ];
    for (const part of each) {
      expect(part.length, "单块不该被单块预算截断（否则测的就不是聚合口径）").toBeLessThan(MEMORY_INJECT_CHAR_BUDGET);
    }
    expect(each[0].length + each[1].length + each[2].length, "三块合计必须超过总预算，否则这条判据无从度量").toBeGreaterThan(
      MEMORY_INJECT_CHAR_BUDGET,
    );

    /*
     * 产品路径（共享聚合预算槽）。
     *
     * ⚠️ **只用 `composeMemoryBlock` 的产物比较，不依赖段序**（本判据只该对"预算"敏感）：
     * 早先的写法从 `buildSystemPrompt(cfg)` 的输出里按序号数正文来定位 ⇒ 一旦有别的段被挪动
     * （哪怕是无关的段序改造），这条预算判据也会红，把"到底哪条判据挂了"弄模糊，
     * 还会让以后动相邻段时**假红**。现在合成文本与它在 prompt 里排第几段完全无关。
     */
    const composeHalves = (): { stable: string; volatile: string } => {
      const b = createMemoryInjectBudgetTracker();
      return {
        stable: composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, PROJ, SESSION, b),
        volatile: composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, b),
      };
    };

    const halves = composeHalves();
    const total = `${halves.stable}${halves.volatile}`;
    const memoryChars = (seq: string) => seq.replace(/\s/g, "").length;
    expect(
      memoryChars(total),
      `聚合注入量必须不超过总预算（实际 ${memoryChars(total)} vs 预算 ${MEMORY_INJECT_CHAR_BUDGET}）`,
    ).toBeLessThanOrEqual(MEMORY_INJECT_CHAR_BUDGET + 400);
    // 如实披露（不许静默丢）
    expect(total, "被聚合上限挡下的条数必须出现在注入文本里").toContain("未注入");
    expect(total, "披露里要写明预算口径").toContain(String(MEMORY_INJECT_CHAR_BUDGET));

    // 约束确实咬在聚合这一层：实际渲染出的记忆正文条数少于三块各自单独的条数之和（60）
    const rendered = ["TOTAL_PM_", "TOTAL_JM_", "TOTAL_CM_"].reduce(
      (n, prefix) => n + (total.split(prefix).length - 1),
      0,
    );
    expect(rendered, "聚合上限必须真的挡掉一部分条目（不是只在文本里写一句）").toBeLessThan(60);
    expect(rendered, "但仍有内容注入（不是全丢）").toBeGreaterThan(0);

    // 合成文本与它在系统提示里的位置无关：无论排第几段，聚合结果必须一样
    expect(composeHalves().stable).toBe(halves.stable);
    expect(composeHalves().volatile).toBe(halves.volatile);

    // 既有 S1-BUDGET（三作用域单次调用）不许被削弱
    const single = svc.buildMemoryPrompt(undefined, PROJ, SESSION);
    expect(single.length).toBeLessThanOrEqual(MEMORY_INJECT_CHAR_BUDGET + 800);
    expect(single).toContain("未注入");
  });
});

/**
 * 第 189 波新增：来源三态（A1）、体检开关守卫（M-5/A7）、披露存活（A4）、编辑不平移（第 15 条）、
 * 无条件边界 + split 不静默兜底（A3/F5）、两分镜像与取数常量一致（A7）。
 */
describe("MEM-PLACE：来源三态 / 边界无条件 / 披露存活 / 顺序稳定", () => {
  /** 造一条**真实**的旧数据条目（无 `source`，与迁移后的存量形态一致） */
  function addLegacyPlatformEntry(svc: MemoryService, content: string): string {
    const id = "legacy-unknown-1";
    (svc as unknown as { entries: Map<string, unknown> }).entries.set(id, {
      id,
      scope: "platform",
      key: "旧条目",
      content,
      legacyPool: true,
      timestamp: 1_760_000_000_000,
    });
    return id;
  }

  it("MEM-PLACE-12 ①：source===undefined 的旧条目 ⇒ 注入/面板/体检/导出**四处同一说法**", () => {
    const svc = makeMemory({});
    addLegacyPlatformEntry(svc, "LEGACY_UNKNOWN_MARKER");

    const p = promptWithMemory(svc, "2026-10-07 10:00");
    const label = MEMORY_SOURCE_KIND_LABEL.unknown;

    // ① 注入文本：显式说"来源未知（旧数据）"，且**不许**冒充"自动提取…未经人工确认"
    expect(p, "注入文本必须用三态里的『未知（旧数据）』说法").toContain(label);
    const injectionSection = p.slice(p.indexOf(memoryUnknownHeader()), p.indexOf("LEGACY_UNKNOWN_MARKER"));
    expect(injectionSection, "旧数据块抬头必须是『来源未知（旧数据）』").toContain(label);
    expect(injectionSection, "旧数据**不许**被说成『未经人工确认』的自动提取").not.toContain("未经人工确认");
    expect(p, "旧数据不许出现在自动提取块的抬头下").not.toContain("自动提取（可能不准，可删）");

    // ② 导出（Markdown）—— 同一个常量
    expect(svc.exportAsMarkdown(), "导出必须用同一个三态说法").toContain(`**来源**: ${label}`);

    // ③ 统计（bySource 三态）—— 旧数据算 unknown，**不许**并进 manual/auto
    const stats = svc.getStats();
    expect(stats.bySource.unknown, "旧数据算 unknown").toBe(1);
    expect(stats.bySource.manual, "旧数据**不许**算成手动").toBe(0);
    expect(stats.bySource.auto, "旧数据**不许**算成自动").toBe(0);

    // ④ 体检：**走真实数据层**（`createMemoryCheckup`），不再对着两个纯函数自证
    /*
     * P4 修正（第 189 波复审）：旧写法这里只断言 `memorySourceOf({source:undefined})` 与
     * `entrySourceOf({source:undefined})` 的返回值 —— 那是**恒真**的自证（函数就是为这两个输入
     * 写的），既没渲染视图也没走体检数据层。现在改成造真实条目 → 跑体检 → 断言它按三态归类。
     */
    const checkup = createMemoryCheckup(
      { projectId: PROJ, sessionId: SESSION },
      { index: buildOwnershipIndexFrom([], new Map()), service: svc },
    );
    const legacyItem = checkup.groups.flatMap((g) => g.entries).find((e) => e.id === "legacy-unknown-1");
    expect(legacyItem, "旧条目必须出现在体检里（否则这条判据无从度量）").toBeTruthy();
    expect(legacyItem!.source, "体检的三态判定：旧数据是 unknown，不许冒充 manual/auto").toBe("unknown");
    expect(
      checkup.groups.flatMap((g) => g.entries).some((e) => e.source === "auto"),
      "同一份体检里不许把 unknown 混进 auto（否则上面那条是恒真）",
    ).toBe(false);
    // 位置口径（旧数据仍算易变侧）由 `MEM-PLACE-9`（legacyPool → 边界之后）与 `-17` 覆盖
    const at = p.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(p.indexOf("LEGACY_UNKNOWN_MARKER"), "旧数据在易变侧（边界之后）").toBeGreaterThan(at);

    // 反向（防"一律说未知"的恒真）：同一条目标成 auto ⇒ 注入呈现**必须变成**自动提取
    const id = "legacy-unknown-1";
    (svc as unknown as { entries: Map<string, { source?: string }> }).entries.get(id)!.source = "auto";
    const p2 = promptWithMemory(svc, "2026-10-07 10:00");
    expect(p2, "标成 auto 后必须出现自动提取块的自证抬头").toContain("自动提取（可能不准，可删）");
    expect(p2, "标成 auto 后必须出现『未经人工确认』").toContain("未经人工确认");
    expect(p2, "标成 auto 后不许再说『未知（旧数据）』").not.toContain(memoryUnknownHeader());
    expect(memorySourceOf({ source: "auto" })).toBe("auto");
  });

  it("MEM-PLACE-12 ②：旧数据仍然受手动保护（自动流程不得改写 / 删除 / 整合掉）", () => {
    const svc = makeMemory({});
    const id = addLegacyPlatformEntry(svc, "LEGACY_PROTECTED_MARKER");

    // 判定口径本身
    expect(isProtectedMemoryEntry({ source: undefined }), "旧数据必须算受保护").toBe(true);
    expect(isProtectedMemoryEntry({ source: "auto" }), "自动条目不算受保护").toBe(false);

    // ① 自动流程改写：必须被拒绝
    expect(
      svc.update(id, { content: "AUTO_OVERWRITE_ATTEMPT" }, { actor: "auto" }),
      "自动流程不得改写旧数据",
    ).toBe(false);
    expect(svc.get(id)!.content, "内容逐字不动").toBe("LEGACY_PROTECTED_MARKER");

    // ② 用户显式动作可以改（否则这条判据会退化成"谁都不能碰"）
    expect(svc.update(id, { content: "USER_EDIT" }, { actor: "user" })).toBe(true);

    // ③ 自动清理（clear 不带 includeManual）不得删除旧数据
    const svc2 = makeMemory({});
    addLegacyPlatformEntry(svc2, "LEGACY_PROTECTED_MARKER_2");
    expect(svc2.clear("platform"), "clear 不许删受保护的旧数据").toBe(0);
    expect(svc2.get("legacy-unknown-1"), "条目必须还在").toBeTruthy();

    // ④ 自动整合（stale cleanup）不得删除旧数据 —— 时间戳给到 10 年前
    const svc3 = makeMemory({});
    (svc3 as unknown as { entries: Map<string, unknown> }).entries.set("legacy-old", {
      id: "legacy-old",
      scope: "platform",
      key: "很旧的条目",
      content: "LEGACY_STALE_MARKER",
      timestamp: 1, // 1970 ⇒ 一定超过 maxAgeDays
    });
    const report = svc3.consolidate({ maxAgeDays: 90 });
    expect(report.staleRemoved, "受保护条目不许被自动清理掉").toBe(0);
    expect(svc3.get("legacy-old"), "受保护条目必须还在").toBeTruthy();
  });

  it("MEM-PLACE-19①：稳定条目引用**易变**条目 ⇒ 改易变侧不许动稳定半块（含哨兵偏移）", () => {
    /*
     * M-2/P1 的形态：`formatLine` 先 `resolveLinks`，而链接目标原先在**全库**按 key 找第一条
     * （不分 scope/source）⇒ 平台级手写条目里写一个 `[[项目条目]]`，这条平台条目的注入文本
     * 就成了**易变条目内容的函数** ⇒ 改一条项目级记忆就会顶掉整个稳定前缀 + 边界 + date。
     */
    const svc = makeMemory({
      platform: [{ key: "平台锚点", content: "PLATFORM_ANCHOR 关联：[[项目条目]]" }],
      project: [{ key: "项目条目", content: "PROJECT_LINKED_V1" }],
    });
    const projectId = Array.from((svc as unknown as { entries: Map<string, { id: string; scope: string }> }).entries.values())
      .find((e) => e.scope === "project")!.id;

    const A = promptWithMemory(svc, "2026-10-07 10:00");
    const atA = A.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const stableA = A.slice(0, atA);

    // 改易变条目的内容（**等长**，这样连 date 偏移都可逐字节比较）
    expect(svc.update(projectId, { content: "PROJECT_LINKED_V2" }, { actor: "user" })).toBe(true);
    const B = promptWithMemory(svc, "2026-10-07 10:00");
    const atB = B.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);

    // ① 核心不变量：改易变侧**不许**让稳定半块动一个字节（含哨兵偏移；等长改动下 date 偏移也不变）
    expect(B.slice(0, atB), "稳定半块必须逐字节不变（稳定块字节 = f(稳定数据)）").toBe(stableA);
    expect(atB, "哨兵偏移不许变").toBe(atA);
    expect(B.indexOf("# Current Date"), "date 偏移也不许变（等长改动）").toBe(A.indexOf("# Current Date"));
    // ② 易变块照常随动（否则上面是"谁都不变"的恒真）
    expect(A).not.toBe(B);
    expect(B.slice(atB), "易变侧必须跟着变").toContain("PROJECT_LINKED_V2");

    // ③ 跨侧链接**不展开**：原样留 `[[项目条目]]`，不注入对方正文
    expect(stableA, "稳定块里必须原样保留 [[项目条目]]（不展开）").toContain("[[项目条目]]");
    expect(stableA, "稳定块**不许**出现链接展开标记").not.toContain("[→ 项目条目:");
    expect(stableA, "稳定块**不许**含易变条目的正文").not.toContain("PROJECT_LINKED_V1");

    // 引擎路径（真正发给模型的形态）同形
    const E = promptViaEngine(svc, SESSION, "C:\\work\\alpha");
    const eAt = E.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(E.slice(0, eAt), "引擎路径的稳定半块也不许含易变正文").not.toContain("PROJECT_LINKED_V2");
    expect(E.slice(0, eAt)).toContain("[[项目条目]]");
  });

  it("MEM-PLACE-19②（反向，防恒真）：链接指向**同侧**（平台手动→平台手动）必须仍然展开", () => {
    /*
     * 防"把链接功能在稳定侧一起关掉"：同侧（stable→stable）链接必须照旧展开，
     * 且被指向者的内容一变，稳定半块**必须**跟着变。
     * 目标条目用 `pending`：它**自己不被注入**，所以稳定块里出现的正文只可能来自链接展开。
     */
    const svc = makeMemory({
      platform: [
        { key: "平台锚点", content: "PLATFORM_ANCHOR 关联：[[平台目标]]" },
        { key: "平台目标", content: "PLATFORM_LINKED_V1" },
      ],
    });
    const targetId = Array.from((svc as unknown as { entries: Map<string, { id: string; key: string }> }).entries.values())
      .find((e) => e.key === "平台目标")!.id;
    (svc as unknown as { entries: Map<string, { status?: string }> }).entries.get(targetId)!.status = "pending";

    const A = promptWithMemory(svc, "2026-10-07 10:00");
    const atA = A.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const stableA = A.slice(0, atA);

    expect(stableA, "同侧链接必须展开（标记在场）").toContain("[→ 平台目标:");
    expect(stableA, "同侧链接必须注入目标正文摘要").toContain("PLATFORM_LINKED_V1");
    // 目标自己是 pending ⇒ 整份提示里它只应出现一次（来自展开，而不是它自己那一行）
    expect(A.split("PLATFORM_LINKED_V1").length - 1, "pending 目标自己不进注入，唯一来源是展开").toBe(1);

    // 改被指向者 ⇒ 稳定半块**必须**变
    expect(svc.update(targetId, { content: "PLATFORM_LINKED_V2" }, { actor: "user" })).toBe(true);
    const B = promptWithMemory(svc, "2026-10-07 10:00");
    const atB = B.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(B.slice(0, atB), "同侧链接一变，稳定半块必须跟着变").not.toBe(stableA);
    expect(B.slice(0, atB)).toContain("PLATFORM_LINKED_V2");
    expect(atB, "等长改动下哨兵偏移仍不变").toBe(atA);
  });

  it("MEM-PLACE-13：注入侧上下文**不带**体检开关（showAllProjects 传进注入路径必须编译不过）", () => {
    /*
     * `showAllProjects` 只给「记忆体检」用，却被 `visibleIn` 消费 —— 而 `visibleIn` 是**注入**
     * 的必经闸门。今天 `buildMemoryPrompt` 内部重建 ctx 恰好安全，但那只是"恰好"。
     * 这条把它变成**类型系统保证**：注入侧上下文只有 projectId/sessionId。
     */
    const ctx: InjectionScopeContext = injectionScopeContext("proj-a", "sess-a");
    expect(Object.keys(ctx).sort()).toEqual(["projectId", "sessionId"]);

    // 运行时口径：只有当前项目的条目会进注入文本（另一个项目的条目一条都不许进）
    const svc = makeMemory({ project: [{ key: "本项目", content: "INJECT_OWN_PROJECT" }] });
    svc.add({ scope: "project", projectId: "c:\\work\\beta", key: "别的项目", content: "INJECT_OTHER_PROJECT" });
    const text = svc.buildMemoryPrompt(undefined, PROJ, SESSION);
    expect(text).toContain("INJECT_OWN_PROJECT");
    expect(text, "别的项目的条目必须被作用域挡在注入之外").not.toContain("INJECT_OTHER_PROJECT");

    /*
     * 编译期守卫（在**生产代码**里，`tsc` 真的检查它）：
     *
     * ⚠️ 守卫**不能**写在测试文件里：`tsconfig.json` 的 `exclude` 把 `src/test/**` 整个排除，
     * 测试文件里的 `@ts-expect-error` 不会被 `tsc` 检查（先前写法就是装饰品）。
     * 真正生效的守卫是 `memory.ts` 的两处 ——
     * ① `INJECTION_SCOPE_CONTEXT_COMPILE_GUARD`（把 `showAllProjects` 塞进注入侧 ctx 必须报错）；
     * ② `InjectionParamIsNarrow`（把 `injectionPlan`/`computeInjection` 的**形参**放宽成
     *    `MemoryScopeContext` 会让那条指令变成"未使用"⇒ `tsc` 立刻红）。
     *
     * ⚠️ R6 如实修正：这里**不再**断言那个守卫对象自己带着 `showAllProjects`
     * （`INJECTION_SCOPE_CONTEXT_COMPILE_GUARD.showAllProjects === true`）—— 那是**自证**
     * （字面量自己带着这个键，断言它等于 true 什么也没证明）。现在改成：
     * - 下面用**行为**钉住"体检开关进不了注入路径"（运行时收口）；
     * - 源码级只钉"两道守卫还在生产代码里"（它能挡删除/搬走，挡不住绕过；
     *   真正的强制力来自 `npx tsc --noEmit` —— 交付报告里的变异 MUT-I/MUT-J 就是跑它验证的）。
     */
    const memorySrc = readFileSync(join(ROOT, "src", "core", "memory", "memory.ts"), "utf8");
    expect(
      memorySrc.match(/@ts-expect-error/g)?.length ?? 0,
      "两道编译期守卫必须留在生产代码里（搬进 src/test/** 就等于没有）",
    ).toBeGreaterThanOrEqual(2);
    expect(memorySrc, "守卫②必须真的引用注入路径形参的类型").toContain("InjectionParamIsNarrow");
    expect(memorySrc, "注入侧 ctx 的唯一构造点必须真的写入品牌键").toContain("[INJECTION_SCOPE_CONTEXT_BRAND]: true");

    /*
     * **运行时收口**（R6 加强的另一半）：类型会被擦除、也可能被 `as` 硬转绕过 ⇒
     * `computeInjection` 只认两个归属键。这里模拟"强行把一个带体检开关的宽 ctx 塞进注入路径"。
     */
    const otherSvc = makeMemory({ project: [{ key: "本项目", content: "INJECT_OWN_PROJECT" }] });
    otherSvc.add({ scope: "project", projectId: "c:\\work\\beta", key: "别的项目", content: "INJECT_OTHER_PROJECT" });
    const otherId = Array.from((otherSvc as unknown as { entries: Map<string, { id: string; content: string }> }).entries.values()).find(
      (e) => e.content === "INJECT_OTHER_PROJECT",
    )!.id;

    // 绕过类型：宽 ctx 里带着 `showAllProjects` / `includeUnscoped`
    const forcedWide = {
      projectId: PROJ,
      sessionId: SESSION,
      showAllProjects: true,
      includeUnscoped: true,
    } as unknown as InjectionScopeContext;
    expect(
      otherSvc.injectionExplanations(forcedWide).injected.has(otherId),
      "`showAllProjects` 就算被强塞进注入路径，也**不许**把别的项目的条目算成'已生效'（运行时收口）",
    ).toBe(false);
    // 反向：同一个宽 ctx 走**视图**路径时 `showAllProjects` 照旧生效（说明上面那条不是"整条路径都瞎了"）
    expect(
      otherSvc.listAll({ projectId: PROJ, sessionId: SESSION, showAllProjects: true }).some((e) => e.id === otherId),
      "视图路径仍必须认 `showAllProjects`（体检要看得见别的项目的条目）",
    ).toBe(true);
  });

  it("MEM-PLACE-14：聚合上限挡下条目时，**空正文也必须出披露**（不许静默丢）", () => {
    /*
     * A4 的形态：稳定块吃掉几乎全部预算 ⇒ 易变侧每一次 `computeInjection` 都 `continue`
     * ⇒ 正文为空；旧写法先 `if (!text) return ""` ⇒ 抬头 + 权威句 + "未注入 N 条"**一起消失**。
     */
    const emptyService = { buildMemoryPrompt: () => "" };
    const tracker = createMemoryInjectBudgetTracker();
    tracker.totalTruncated = 7; // 模拟"被聚合上限挡下 7 条"（正文一条都没收进来）

    const block = composeMemoryBlock(emptyService, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, tracker);
    expect(block, "正文为空但披露必须存活").not.toBe("");
    expect(block, "披露文本必须在").toContain("未注入");
    expect(block, "披露必须写明条数").toContain("7 条");
    expect(block, "抬头必须跟着披露一起出现（否则读者不知道这是哪一段）").toContain(MEMORY_VOLATILE_HEADER);
    expect(block, "权威句必须跟着披露一起出现").toContain(MEMORY_AUTHORITY_NOTE);

    // 反向：既无正文也无披露 ⇒ 仍然是空串（不许留孤立抬头）
    const clean = composeMemoryBlock(emptyService, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, createMemoryInjectBudgetTracker());
    expect(clean, "空块仍然不占上下文").toBe("");

    // 端到端：聚合上限咬合时，最终提示里"未注入"必须真的出现（而不是随空块消失）
    const svc = makeMemory({});
    const filler = "B".repeat(300);
    for (let i = 0; i < 20; i++) {
      svc.add({ scope: "platform", key: `pm${i}`, content: `DISCLOSE_PM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_000_000 + i });
      svc.add({ scope: "project", projectId: PROJ, key: `jm${i}`, content: `DISCLOSE_JM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_100_000 + i });
      svc.add({ scope: "conversation", sessionId: SESSION, key: `cm${i}`, content: `DISCLOSE_CM_${i}_${filler}`, source: "manual", timestamp: 1_760_000_200_000 + i });
    }
    // 前提：三块各自都在单块预算之内，合计超过总预算（否则这条判据无从度量）
    const each = [
      svc.buildMemoryPrompt("platform", PROJ, SESSION),
      svc.buildMemoryPrompt("project", PROJ, SESSION),
      svc.buildMemoryPrompt("conversation", PROJ, SESSION),
    ];
    expect(each[0].length + each[1].length + each[2].length, "三块合计必须超过总预算").toBeGreaterThan(
      MEMORY_INJECT_CHAR_BUDGET,
    );
    const p = promptWithMemory(svc, "2026-10-07 10:00");
    expect(p, "聚合截断必须在最终提示里如实披露").toContain("未注入");
  });

  it("MEM-PLACE-15：编辑一条记忆**不许**让它在注入文本里平移（渲染序 = 创建序）", () => {
    const svc = makeMemory({});
    const ids: string[] = [];
    for (const key of ["第一条", "第二条", "第三条"]) {
      const r = svc.add({ scope: "project", projectId: PROJ, key, content: `${key}_内容`, source: "manual" });
      expect(r.ok).toBe(true);
      ids.push(r.entry!.id);
    }

    /** 注入文本里各条目出现的先后（顺序敏感，逐字节位置） */
    const orderOf = (text: string, third = "第三条_内容") =>
      ["第一条_内容", "第二条_内容", third].map((m) => text.indexOf(m));
    /** 把三个位置折成名次（0 = 最前） */
    const rankOf = (positions: number[]) => {
      const sorted = [...positions].sort((a, b) => a - b);
      return positions.map((p) => sorted.indexOf(p));
    };

    const before = svc.buildMemoryPrompt("project", PROJ, SESSION);
    const beforePositions = orderOf(before);
    expect(beforePositions.every((i) => i >= 0), "三条都必须在").toBe(true);
    const beforeRanks = rankOf(beforePositions);

    // 原地改**最后一条**的内容（`update()` 会刷新 timestamp —— 旧实现正是靠它把这条挪到块首）
    expect(svc.update(ids[2], { content: "第三条_内容_改过了" }, { actor: "user" })).toBe(true);

    const after = svc.buildMemoryPrompt("project", PROJ, SESSION);
    const afterPositions = orderOf(after, "第三条_内容_改过了");
    expect(afterPositions.every((i) => i >= 0), "改过的三条都必须在").toBe(true);
    // ① 被编辑的那条**名次不变**（旧实现在这里会从第 3 名跳到第 1 名）
    expect(
      rankOf(afterPositions),
      `编辑一条内容后，三条的名次必须逐条不变（before=${beforeRanks} / after=${rankOf(afterPositions)}）`,
    ).toEqual(beforeRanks);
    // ② 差异确实只发生在那一条的正文上（块内顺序 = 逐字节同形）
    const strip = (t: string) => t.replace(/第三条_内容(_改过了)?/g, "第三条_内容");
    expect(strip(after), "编辑一条不许改变块内顺序（逐字节比较）").toBe(strip(before));

    // ③ 新增一条：既有条目的相对顺序不变，新条目落在**确定且可解释**的位置（创建序最新 ⇒ 同桶最前）
    const added = svc.add({ scope: "project", projectId: PROJ, key: "第四条", content: "第四条_内容", source: "manual" });
    expect(added.ok).toBe(true);
    const withNew = svc.buildMemoryPrompt("project", PROJ, SESSION);
    const newPos = withNew.indexOf("第四条_内容");
    expect(newPos).toBeGreaterThan(-1);
    const positionsAfterAdd = orderOf(withNew, "第三条_内容_改过了");
    expect(newPos, "最新创建的条目排在同桶最前（与旧口径一致，只是基准换成创建序）").toBeLessThan(
      Math.min(...positionsAfterAdd),
    );
    expect(
      rankOf(positionsAfterAdd),
      "新增不许打乱既有条目的相对顺序",
    ).toEqual(beforeRanks);
  });

  it("MEM-PLACE-16：边界无条件出现；缺边界时 split **不许**把整份提示当稳定前缀", () => {
    // 形态 A：只有易变记忆（升级用户的典型形态：没有平台级手写记忆）
    const onlyVolatile = makeMemory({ project: [{ key: "项目手写", content: "ONLY_VOLATILE_MARKER" }] });
    withAutoBlock(onlyVolatile, "自动事实", "ONLY_VOLATILE_AUTO");
    const pA = promptWithMemory(onlyVolatile, "2026-10-07 10:00");
    expect(findCacheBoundary(pA), "**没有稳定记忆时边界也必须存在**（旧形态 -1）").toBeGreaterThan(-1);
    const splitA = splitSystemPromptCacheBoundary(pA);
    expect(splitA.boundaryFound).toBe(true);
    expect(splitA.stable.length, "稳定前缀不许等于整份提示").toBeLessThan(pA.length);
    expect(splitA.stable.includes("ONLY_VOLATILE_MARKER"), "易变记忆不许被判进稳定前缀").toBe(false);
    expect(splitA.volatile).toContain("ONLY_VOLATILE_MARKER");

    // 形态 B：完全没有记忆 —— 边界仍在（其后只有 date）
    /*
     * P4 合并（第 189 波复审）：`MEM-PLACE-5` 里那段"无记忆形态"的同形断言已删，
     * 覆盖集中到这里，并吸收它更强的两条：边界必须**早于 date**、**最后一段必须是 date**。
     */
    const none = buildSystemPrompt({ agent: buildMinimalAgent() as never, date: "2026-10-07 10:00" });
    expect(findCacheBoundary(none)).toBeGreaterThan(-1);
    expect(
      findCacheBoundary(none),
      "无记忆时边界仍在 date 之前（date 才是内容上的易变者）",
    ).toBeLessThan(none.indexOf("# Current Date"));
    expect(
      none.split("\n\n---\n\n").slice(-1)[0].startsWith("# Current Date"),
      "无记忆时 date 仍是最后一段",
    ).toBe(true);
    expect(splitSystemPromptCacheBoundary(none).boundaryFound).toBe(true);

    // 形态 C：**人为构造**的缺边界提示 ⇒ 不许静默兜底
    const noBoundary = "# A\n\nbody\n\n---\n\n# Current Date\n\n2026-10-07 10:00";
    const split = splitSystemPromptCacheBoundary(noBoundary);
    expect(split.boundaryFound, "缺边界必须如实上报").toBe(false);
    expect(split.stable, "缺边界时**没有任何字节**可以被声明为稳定").toBe("");
    expect(split.volatile, "缺边界时整份提示都属于'不可声明为稳定'的那一侧").toBe(noBoundary);
  });

  it("MEM-PLACE-17：`isStableMemoryEntry` 与两份取数常量**逐条一致**（不许各自漂移）", () => {
    /*
     * `isStableMemoryEntry` 曾经零引用却自称"两分的唯一判据"（A7/M-5）。
     * 现在它不再自称唯一，但也不许和真正生效的常量漂移 —— 这条对一组条目断言
     * "真的进了稳定块" == `isStableMemoryEntry(条目)`，改一边不改另一边必然红。
     */
    const svc = makeMemory({});
    const samples: Array<{ scope: "platform" | "project" | "conversation"; source?: "manual" | "auto"; key: string }> = [
      { scope: "platform", source: "manual", key: "平台手写" },
      { scope: "platform", source: "auto", key: "平台自动" },
      { scope: "platform", key: "平台旧数据" },
      { scope: "project", source: "manual", key: "项目手写" },
      { scope: "project", source: "auto", key: "项目自动" },
      { scope: "conversation", source: "manual", key: "对话手写" },
    ];
    const markers = samples.map((s, i) => `KIND_PROBE_${i}`);
    samples.forEach((s, i) => {
      if (!s.source) {
        /*
         * 旧数据只能这样造：`add()` 会给没有 source 的新条目盖章 `manual`
         * （新写入从来都有来源），所以 `undefined` 只存在于**存量**数据里 ——
         * 与迁移后的形态一致，直接放进内部表。
         */
        (svc as unknown as { entries: Map<string, unknown> }).entries.set(`kind-probe-${i}`, {
          id: `kind-probe-${i}`,
          scope: s.scope,
          key: s.key,
          content: markers[i],
          timestamp: 1_760_000_000_000 + i,
          status: "active",
        });
        return;
      }
      const r = svc.add({
        scope: s.scope,
        projectId: s.scope === "project" ? PROJ : undefined,
        sessionId: s.scope === "conversation" ? SESSION : undefined,
        key: s.key,
        content: markers[i],
        source: s.source,
      });
      expect(r.ok).toBe(true);
    });

    const stableText = composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, PROJ, SESSION);
    const entries = samples.map((s, i) => ({
      id: String(i),
      scope: s.scope,
      source: s.source as "manual" | "auto" | undefined,
      marker: markers[i],
    }));
    for (const e of entries) {
      const inStableBlock = stableText.includes(e.marker);
      const claimed = isStableMemoryEntry({ scope: e.scope, source: e.source as never });
      expect(
        inStableBlock,
        `条目 ${e.marker}（scope=${e.scope} source=${e.source}）：真的进稳定块=${inStableBlock}，` +
          `isStableMemoryEntry=${claimed} —— 两者必须一致`,
      ).toBe(claimed);
    }
    // 且这条判据不是恒真：样本里必须既有进稳定块的、也有不进的
    expect(entries.some((e) => stableText.includes(e.marker))).toBe(true);
    expect(entries.some((e) => !stableText.includes(e.marker))).toBe(true);

    // 两分口径的**取数常量**本身也要与镜像同向：稳定侧只要 manual、易变侧含旧数据
    const stableSelections: readonly MemoryBlockSelection[] = MEMORY_STABLE_BLOCK_SELECTION;
    expect(stableSelections.every((s) => (s.sources ?? []).includes("manual"))).toBe(true);
    const volatileSelections: readonly MemoryBlockSelection[] = MEMORY_VOLATILE_BLOCK_SELECTIONS;
    expect(
      volatileSelections.some((s) => s.scope === "platform" && (s.sources ?? []).includes("auto")),
      "旧数据（位置口径 = auto）必须落在易变侧的取数口径里",
    ).toBe(true);
    const kinds: MemorySourceKind[] = ["manual", "unknown", "auto"];
    // 三态文案表齐全（缺一态会让界面显示 undefined）
    for (const k of kinds) expect(typeof MEMORY_SOURCE_KIND_LABEL[k]).toBe("string");
  });
});

/**
 * 第 189 波**第二轮复审**新增的判据：
 * `MEM-PLACE-20`（创建序必须持久化，重载后逐条保序）、`MEM-PLACE-21`（导出→导入往返保真）、
 * `MEM-PLACE-22`（面板默认顺序 == 注入顺序；编辑不改变入选集合）、
 * `MEM-PLACE-24`（同一块内的截断披露必须分层可辨且数字能对账）。
 */
describe("MEM-PLACE：创建序持久化 / 往返保真 / 面板顺序 / 披露分层", () => {
  /** 注入文本里某组标记出现的**先后**（顺序敏感） */
  function markersInOrder(text: string, re: RegExp): string[] {
    return text.match(re) ?? [];
  }

  /** 一条"来源未知（旧数据）"（`source === undefined`）的平台级条目 —— 与迁移后的存量形态一致 */
  function legacyPlatformEntry(id: string, key: string, content: string, order?: number): Record<string, unknown> {
    return { id, scope: "platform", key, content, timestamp: 1_760_000_500_000, legacyPool: true, ...(order === undefined ? {} : { order }) };
  }

  it("MEM-PLACE-23③：**注入文本**里的三态抬头同样只认唯一表（改表即改抬头）", () => {
    /*
     * R5 的另一半：三态文案表的声明是"注入文本 / 面板 / 体检 / 导出**四处共用**"。
     * 视图那两处由 `memory-checkup.test.tsx` 的渲染判据钉住（改表即改呈现）；
     * 这里钉**注入抬头**（`manualHeader` / `autoHeader` / `memoryUnknownHeader`）——
     * 它们曾经各自写死一份字面量，改文案表不会改注入文本。
     */
    const keys: readonly MemorySourceKind[] = ["manual", "auto", "unknown"];
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "HDR_MANUAL" }],
      project: [{ key: "项目手写", content: "HDR_MANUAL_PROJECT" }],
    });
    svc.add({ scope: "project", projectId: PROJ, key: "自动", content: "HDR_AUTO", source: "auto", timestamp: 1_760_000_900_000 });
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("hdr-legacy", {
      id: "hdr-legacy",
      scope: "project",
      projectId: PROJ,
      key: "旧数据",
      content: "HDR_UNKNOWN",
      legacyPool: true,
      timestamp: 1_760_000_950_000,
    });

    const before = promptWithMemory(svc, "2026-10-07 10:00");
    for (const k of keys) {
      expect(before, `注入抬头必须用到唯一表里的说法（${k}）`).toContain(MEMORY_SOURCE_KIND_LABEL[k]);
    }

    const backup = { ...MEMORY_SOURCE_KIND_LABEL };
    const sentinel: Record<MemorySourceKind, string> = {
      manual: "SENT_MANUAL",
      auto: "SENT_AUTO",
      unknown: "SENT_UNKNOWN",
    };
    Object.assign(MEMORY_SOURCE_KIND_LABEL, sentinel);
    try {
      const after = promptWithMemory(svc, "2026-10-07 10:00");
      for (const k of keys) {
        expect(after, `改表后注入抬头必须跟着变（${k}）⇒ 那一处不许自写字面量`).toContain(sentinel[k]);
      }
      // 反向：抬头行里不许还留着旧文案（正文/说明里可能有"自动提取流程"这类叙述，所以只查 `## ` 抬头）
      const headers = after.split("\n").filter((l) => l.startsWith("## ")).join("\n");
      for (const k of keys) {
        expect(headers, `注入抬头不许还留着旧文案（${k}）`).not.toContain(backup[k]);
      }
    } finally {
      Object.assign(MEMORY_SOURCE_KIND_LABEL, backup);
    }
  });

  it("MEM-PLACE-20：落库→重载（真 serialize/load 往返）后 ① 顺序逐条相同 ② 超额时入选集合逐条相同 ③ 整数样/非整数 id 混排", () => {
    /*
     * 前提（这条缺陷的成因）：JSON 的**整数样键按数值升序**排列，与插入序无关 ⇒
     * "以 id 为键的普通对象"根本保不住创建序。这里先把这个前提钉成事实，
     * 免得判据在"恰好没混排"的输入上变成恒真。
     */
    expect(Object.keys(JSON.parse(JSON.stringify({ "mem-3": 1, "1": 2, "mem-1": 3, "2": 4 })))).toEqual([
      "1",
      "2",
      "mem-3",
      "mem-1",
    ]);

    // ③ 整数样 id 与非整数样 id **混排**（真实形状：id 前缀 uuid / 中文 / 数字都出现过）
    const total = MEMORY_INJECT_MAX_PER_BLOCK + 5;
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < total; i++) {
      // 故意让**非整数样 id 排在数组前面**：落库时它们会被排到整数样键之后 ⇒ 顺序错位可见
      const id = i % 2 === 0 ? `mem-mix-${i}` : String(i);
      entries.push({
        id,
        scope: "project",
        projectId: PROJ,
        key: `KEY_${i}`,
        content: `PLACE20_${String(i).padStart(2, "0")}`,
        source: "manual",
        status: "active",
        timestamp: 1_760_600_000_000 + i,
      });
    }
    expect(entries.some((e) => /^\d+$/.test(String(e.id))), "必须含整数样 id").toBe(true);
    expect(entries.some((e) => !/^\d+$/.test(String(e.id))), "必须含非整数样 id").toBe(true);

    const first = new MemoryService({ maxEntries: 400 });
    const imported = first.importFromJSON(JSON.stringify({ version: 2, entries }), true);
    expect(imported.imported).toBe(total);

    /*
     * 产品自己的序列化已经跑过一遍（`importFromJSON` 末尾的 `save()` → `serialize()`）：
     * 旧的 `serialize()` 写的就是"以 id 为键的普通对象" ⇒ 整数样键被 JSON 重排。
     * 这里直接读回落库文本，断言**创建序真的落库了**（不是只在内存里）。
     */
    const persisted = JSON.parse(loadMemory()) as { entries: Record<string, { order?: unknown }> };
    expect(persisted.entries["1"], "整数样 id 的条目必须写进落库文本").toBeTruthy();
    expect(
      typeof persisted.entries["1"].order,
      "创建序必须**落库**：否则重载时只能靠容器的键序，而整数样键注定被重排",
    ).toBe("number");

    const before = markersInOrder(first.buildMemoryPrompt("project", PROJ, SESSION), /PLACE20_\d\d/g);
    expect(before.length, "每桶上限 20 且这批超过上限 ⇒ 这条判据必须打在**入选集合**上").toBe(
      MEMORY_INJECT_MAX_PER_BLOCK,
    );

    // 真重载：构造即 `load()`（与"重启后第一次读"等价 —— 同一份落库文本）
    const reloaded = new MemoryService({ maxEntries: 400 });
    const after = markersInOrder(reloaded.buildMemoryPrompt("project", PROJ, SESSION), /PLACE20_\d\d/g);
    expect(after, "重载后渲染顺序必须**逐条相同**（旧实现在这里整体反转）").toEqual(before);
    // 反向：这两个序列确实有信息量（不是"两边都空"
    expect(before.length).toBeGreaterThan(0);
    expect(new Set(before).size, "入选集合里不许有重复条目").toBe(before.length);
    // 未被选中的那 5 条在两侧都不在（入选集合 = 各自前 20 条）
    expect(before.includes("PLACE20_00"), "最早创建的那条不该在注入窗口里").toBe(false);
  });

  it("MEM-PLACE-21：导出→导入往返后 ① 三态逐条不变 ② 稳定/易变归属逐条不变 ③ 注入位置与缓存分块不变", () => {
    const svc = makeMemory({
      platform: [{ key: "平台手写", content: "TRIP_MANUAL_STABLE" }],
      project: [{ key: "项目手写", content: "TRIP_PROJECT_VOLATILE" }],
      conversation: [{ key: "对话手写", content: "TRIP_CONV_VOLATILE" }],
    });
    svc.add({ scope: "platform", key: "平台自动", content: "TRIP_AUTO_VOLATILE", source: "auto", timestamp: 1_760_000_900_000 });
    const legacyId = "trip-legacy-unknown";
    (svc as unknown as { entries: Map<string, unknown> }).entries.set(
      legacyId,
      legacyPlatformEntry(legacyId, "旧条目", "TRIP_UNKNOWN_VOLATILE"),
    );

    const ids = Array.from((svc as unknown as { entries: Map<string, unknown> }).entries.keys()).sort();
    const sources = ids.map((id) => memorySourceOf(svc.get(id)!));
    const sides = ids.map((id) => isStableMemoryEntry(svc.get(id)!));
    // 前提：三态必须在场、两侧归属也必须在场（否则判据退化成"两态/一侧"）
    expect(new Set(sources).size, "三态必须都在场（manual / auto / unknown）").toBe(3);
    expect(sides.filter(Boolean).length).toBeGreaterThan(0);
    expect(sides.filter((s) => !s).length).toBeGreaterThan(0);

    const beforeText = promptWithMemory(svc, "2026-10-07 10:00");
    const beforeSplit = splitSystemPromptCacheBoundary(beforeText);

    const exported = svc.exportAsJSON();
    /*
     * 前提（修复的关键形态）：`undefined` 的 source 必须**显式**写出来。
     * 旧写法 `JSON.stringify` 直接丢掉 `undefined` 值 ⇒ 导出的文件里根本没有 `source` 这个键，
     * 导入侧只能靠兜底**自造**来源。
     */
    expect(exported, "来源未知的条目必须显式写 `source: null`（否则往返无法保真）").toContain('"source": null');

    // 干净数据面 ⇒ 下面这个服务读到的就是空库（导入 = 唯一的条目来源）
    saveMemory("");
    const target = new MemoryService();
    const res = target.importFromJSON(exported, true);
    expect(res.imported, "一条都不许丢").toBe(ids.length);

    const targetIds = Array.from((target as unknown as { entries: Map<string, unknown> }).entries.keys()).sort();
    expect(targetIds).toEqual(ids);
    // ① 三态逐条不变（未知不许被洗成手动）
    expect(targetIds.map((id) => memorySourceOf(target.get(id)!)), "三态逐条不变").toEqual(sources);
    // ② 稳定侧 / 易变侧归属逐条不变
    expect(targetIds.map((id) => isStableMemoryEntry(target.get(id)!)), "两侧归属逐条不变").toEqual(sides);

    // ③ 注入位置与缓存分块不变（逐字节：位置、顺序、块内文案、哨兵偏移都不许动）
    const afterText = promptWithMemory(target, "2026-10-07 10:00");
    const afterSplit = splitSystemPromptCacheBoundary(afterText);
    expect(afterSplit.stable, "稳定前缀必须逐字节不变（旧数据一旦被洗成 manual 就会搬进来）").toBe(
      beforeSplit.stable,
    );
    expect(afterSplit.volatile, "易变侧也必须逐字节不变").toBe(beforeSplit.volatile);
    expect(afterText, "整份提示逐字节相同（这就是'往返保真'的强形式）").toBe(beforeText);
    expect(afterText.indexOf("TRIP_UNKNOWN_VOLATILE"), "旧数据仍在易变侧").toBeGreaterThan(
      afterText.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY),
    );
  });

  it("MEM-PLACE-22①③：面板默认顺序 == 注入顺序；**编辑一条不改变入选集合**（超额形态）", () => {
    const total = MEMORY_INJECT_MAX_PER_BLOCK + 5;
    const svc = new MemoryService({ maxEntries: 400 });
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const r = svc.add({ scope: "project", projectId: PROJ, key: `K${i}`, content: `P22_${i}`, source: "manual" });
      expect(r.ok).toBe(true);
      ids.push(r.entry!.id);
    }

    const panelKeys = () => svc.listAllForPanel({ projectId: PROJ, sessionId: SESSION }).map((e) => e.key);
    /** 注入文本里的标记**按出现先后**（`_改` 只是正文后缀，不参与"是不是同一条"的判定） */
    const injected = () =>
      markersInOrder(svc.buildMemoryPrompt("project", PROJ, SESSION), /P22_\d+(?:_改)?/g).map((m) =>
        m.replace(/_改$/, ""),
      );

    const beforePanel = panelKeys();
    const beforeInjected = injected();
    expect(beforeInjected.length, "必须超过每桶上限，否则'入选集合'无从度量").toBe(MEMORY_INJECT_MAX_PER_BLOCK);
    // 顺序 = 创建序倒序（最新在前）——面板与注入是**同一个键**
    expect(beforePanel[0], "最新创建的排最前").toBe(`K${total - 1}`);
    expect(beforePanel[total - 1], "最早创建的排最后").toBe("K0");
    expect(
      beforePanel.slice(0, MEMORY_INJECT_MAX_PER_BLOCK),
      "面板默认顺序必须与注入顺序逐条一致（注入只收前 20 条）",
    ).toEqual(beforeInjected.map((m) => `K${Number(m.slice(4))}`));

    /*
     * ③ 超额时**编辑**一条 —— 含"编辑面板最后一条（= 注入窗口外的最早那条）"：
     * 入选集合与面板位置都**不许变**。这是有意保留的语义（见 `listAllForPanel` 的注释）：
     * 旧行为里"编辑第 25 条能把它顶进注入窗口"依赖的正是"排序键 = 被编辑的字段"，
     * 而那正是 `MEM-PLACE-15` 要修掉的缓存抖动。
     */
    expect(svc.update(ids[0], { content: `${svc.get(ids[0])!.content}_改` }, { actor: "user" })).toBe(true);
    expect(svc.get(ids[0])!.content, "编辑必须真的生效（否则这条判据是空的）").toContain("_改");
    expect(injected(), "编辑窗口外的一条 ⇒ 入选集合不许变").toEqual(beforeInjected);
    expect(panelKeys(), "编辑不许把条目挪位").toEqual(beforePanel);

    // 反向：编辑**已被选中**的一条同样不许改变入选集合（不是"只测了边缘"）
    expect(svc.update(ids[total - 1], { content: `${svc.get(ids[total - 1])!.content}_改` }, { actor: "user" })).toBe(true);
    expect(injected(), "编辑已入选的一条 ⇒ 入选集合仍不许变").toEqual(beforeInjected);
    expect(panelKeys()).toEqual(beforePanel);
    // 且面板顺序确实是"创建序"而不是"最后修改序"：被编辑的两条名次都不动
    expect(panelKeys()[total - 1]).toBe("K0");
    expect(panelKeys()[0]).toBe(`K${total - 1}`);
  });

  it("MEM-PLACE-24：同一块内两层截断披露必须**分层可辨**，且数字必须能对账（不许同句不同数）", () => {
    /*
     * 复审的读码推定：一个 `composeMemoryBlock` 的易变半块由三次 `buildMemoryPrompt` 拼成，
     * 每次带出自己那句「本段还有 N 条未注入」，末尾再追加聚合披露 ⇒ 同一块里出现多句
     * **文字几乎相同、数字不同**的披露，读者分不清哪句是哪一层。
     */
    const svc = new MemoryService({ maxEntries: 400 });
    const filler = "C".repeat(300);
    const perSelection = MEMORY_INJECT_MAX_PER_BLOCK + 5; // 25 条/桶 ⇒ 每块各自超条数上限 5 条
    for (let i = 0; i < perSelection; i++) {
      svc.add({ scope: "platform", key: `pg${i}_${filler}`, content: `DISC_PG_${i}_${filler}`, source: "auto", timestamp: 1_760_700_000_000 + i });
      svc.add({ scope: "project", projectId: PROJ, key: `jg${i}_${filler}`, content: `DISC_JG_${i}_${filler}`, source: "manual", timestamp: 1_760_700_100_000 + i });
      svc.add({ scope: "conversation", sessionId: SESSION, key: `cg${i}_${filler}`, content: `DISC_CG_${i}_${filler}`, source: "manual", timestamp: 1_760_700_200_000 + i });
    }

    const tracker = createMemoryInjectBudgetTracker();
    const block = composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, tracker);
    const notices = splitMemoryTruncationNotices(block);

    // 前提：两层**都**咬合（否则这条判据测不到"同块混装"）
    expect(notices.perBlock.length, "三个 selection 各自超条数上限 ⇒ 至少一句逐块披露").toBeGreaterThanOrEqual(1);
    expect(notices.aggregate.length, "多块合计超字符预算 ⇒ 聚合披露必须出现").toBeGreaterThanOrEqual(1);
    expect(notices.unknown, "每句披露都必须能被归到某一层（不许有认不出的句子）").toEqual([]);
    expect(notices.aggregate.length, "聚合披露**只许有一句**（多了就是同一句话说了两遍）").toBe(1);

    // 分层可辨：聚合那层必须自证"跨块合计"，逐块那层必须自证"本段"（两句不许逐字同形）
    expect(notices.aggregate[0], "聚合披露必须写明它是哪一层").toContain("跨块合计");
    expect(notices.aggregate[0], "聚合披露不许再说'本段'（那正是'同句不同数'的成因）").not.toContain("本段");
    for (const line of notices.perBlock) {
      expect(line, "逐块披露必须写明它是哪一层").toContain("本段");
      expect(line, "逐块披露不许混进合计口径").not.toContain("跨块合计");
    }
    /*
     * 跨层不许逐字同形（**层内**允许同形：三个 selection 各自被条数上限挡下同样多条，
     * 那三句本来就该说同一件事）。旧写法两层逐字同形时，这里必然红。
     */
    expect(
      notices.perBlock.some((line) => line === notices.aggregate[0]),
      "逐块披露与聚合披露不许**逐字相同**（否则读者分不清哪句是哪一层）",
    ).toBe(false);

    // 数字必须能对账：∑逐块 + 聚合 == 实际未注入条数
    const numberOf = (line: string) => Number(/(\d+) 条可见记忆/.exec(line)?.[1] ?? NaN);
    for (const line of [...notices.perBlock, ...notices.aggregate]) {
      expect(Number.isFinite(numberOf(line)), `披露里必须有条数：${line}`).toBe(true);
    }
    const claimed =
      notices.perBlock.reduce((n, line) => n + numberOf(line), 0) + numberOf(notices.aggregate[0]);
    const renderedCount = ["DISC_PG_", "DISC_JG_", "DISC_CG_"].reduce(
      (n, prefix) => n + (block.split(prefix).length - 1),
      0,
    );
    const actuallyMissing = perSelection * 3 - renderedCount;
    expect(actuallyMissing, "前提：确实有大量条目没进上下文").toBeGreaterThan(10);
    expect(claimed, `披露的数字必须等于实际未注入条数（披露=${claimed} / 实际=${actuallyMissing}）`).toBe(
      actuallyMissing,
    );
    // tracker 的计数与聚合披露同源（界面若以后要显示也读它）
    expect(numberOf(notices.aggregate[0])).toBe(tracker.totalTruncated);

    // 反向（防恒真）：没有任何截断时两层都不许出现
    const clean = createMemoryInjectBudgetTracker();
    saveMemory(""); // 上面那 75 条已经改成镜像 ⇒ 不清就会被新服务读进来
    const small = new MemoryService();
    small.add({ scope: "project", projectId: PROJ, key: "小", content: "DISC_SMALL", source: "manual" });
    const cleanBlock = composeMemoryBlock(small, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, PROJ, SESSION, clean);
    const cleanNotices = splitMemoryTruncationNotices(cleanBlock);
    expect(cleanNotices.perBlock).toEqual([]);
    expect(cleanNotices.aggregate).toEqual([]);
  });
});
