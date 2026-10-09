/**
 * 记忆注入的**每轮固定开销**与**附录落点**（第 191 波：O-49 + O-50）。
 *
 * ## 这两条问的是同一件事的两半
 *
 * | 判据 | 问什么 | 为什么必须有 |
 * | --- | --- | --- |
 * | `MEM-PLACE-25` | 技能 / MCP / deferred 提示（`extraSystemPrompt`）在**同一轮的不同迭代之间**变化时，会不会把**稳定前缀**顶掉？ | O-49：读码推定"落在易变尾部、影响有限"，但**从未实测**；而"同一簇"的教训是推定经常错 |
 * | `MEM-PLACE-26` | 每轮的**固定开销**（两块抬头 + 哨兵 + 两份权威句 + 分隔）有没有棘轮盯着？ | O-50：84 字符/份、170 字符/轮这些数是**交付报告里的数**，文案再被加长时**不会有东西变红**（104 字符重复正是这么被发现的） |
 * | `MEM-PLACE-27` | 空记忆时是不是**只有**哨兵（没有抬头、没有豁免）？ | 空记忆不该有任何 token 白占（第 189 波实测：旧形态空记忆也不出现，但没有任何判据钉住） |
 *
 * ## 附录为什么必须跟在整份系统提示的**最后**
 *
 * 服务端前缀缓存的命中范围 = 请求前缀到**首个差异点**（`messages[0]` 是系统提示）。
 * 附录每轮都可能变（deferred 工具表随工具搜索变化）⇒ 放在最后时，差异点落在提示末尾，
 * 它前面的稳定前缀 + 哨兵 + 易变记忆 + date **逐字节不变**；塞进稳定侧（哨兵之前）则会
 * 把**整段稳定前缀**顶掉（下面 `MEM-PLACE-25` 的反向对照把这两种落点的差距**量出来**）。
 *
 * 位置本身由 `appendVolatileAppendix()`（唯一实现）决定，`agentic-loop.ts` 调它 ——
 * 判据既钉那个函数的行为，也钉 `agentic-loop.ts` 真的在用它（源码级接线检查，与
 * `TIME-WINDOW-4a` 同一手法）。
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSystemPrompt,
  findCacheBoundary,
  appendVolatileAppendix,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../core/prompt/prompt";
import {
  MemoryService,
  MEMORY_STABLE_BLOCK_SELECTION,
  MEMORY_STABLE_HEADER,
  MEMORY_VOLATILE_BLOCK_SELECTIONS,
  MEMORY_VOLATILE_HEADER,
  MEMORY_AUTHORITY_NOTE,
  composeMemoryBlock,
  createMemoryInjectBudgetTracker,
} from "../core/memory/memory";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import { setLang } from "../core/i18n/lang";

const ROOT = process.cwd();
const SEPARATOR = "\n\n---\n\n";

function buildMinimalAgent() {
  return { id: "test", name: "Test Agent", description: "Test", mode: "build" as const, prompt: "You are a test agent.", permissions: [] };
}

/** 公共前缀长度（码元级；"差异点落在哪一段"要用它，不能用比例反推） */
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i;
}
function commonPrefixRatio(a: string, b: string): number {
  return commonPrefixLength(a, b) / Math.max(a.length, b.length);
}
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

/**
 * **每轮固定开销的棘轮**（MEM-PLACE-26，只许降不许升）。
 *
 * 口径（全部按 UTF-16 码元，与第 189 波那批读数同口径）：
 * 两块抬头 + 哨兵 + **两份**权威句 + 它们各自的分隔符（`\n\n---\n\n` = 7）。
 *
 * 第 191 波实测（`MEM-PLACE-26` 的读数日志）：**246** =
 * 哨兵 77 + 稳定块抬头 34 + 易变块抬头 40 + 权威句 37×2 + 分隔 7×3。
 * 其中"权威句 37×2 = 74"与第 189 波把豁免文案从 104 压到 37 的交付口径一致；
 * "哨兵 77 + 分隔 7 = 84"也正好等于交付口径里「空记忆时只有哨兵」的 +84。
 *
 * ## 净值（O-50 要的"固定开销 vs 缓存收益"）
 *
 * 同一批语料（`.preview-shot/_audit-memplace-cache-README.md`，本机实测）：
 * - **固定开销**：每轮 +246 码元（≈350 字节）；
 * - **收益**：易变侧一变（回合结束自动提取，**每回合都会变**）若没有两分与边界，
 *   顶掉的是**整段稳定前缀**（实测稳定前缀 20,788 码元 / 29,181 字节）；两分之后
 *   只顶掉易变尾部（实测 802 字节）⇒ 每回合保住 ≈ 28 KB 的缓存前缀。
 * ⇒ 净值约 **+28 KB / 回合 对 +0.35 KB / 回合**（约 80 倍）。这就是"固定开销是正当取舍"
 *   的量化依据；而**只许降不许升**保证将来文案被加长时会有东西变红（O-50 的正面要求）。
 */
const FIXED_OVERHEAD_RATCHET_CHARS = 246;

/** 带真实记忆块的系统提示（产品形态：稳定块 + 哨兵 + 易变块 + date + 附录） */
function promptWithMemory(opts: {
  date?: string;
  volatileContent?: string;
  skills?: boolean;
  appendix?: string;
  emptyMemory?: boolean;
  /** 空记忆时**显式传空块**（与"完全不传记忆参数"必须逐字相同） */
  emptyBlocks?: boolean;
} = {}): string {
  saveMemory("");
  const svc = new MemoryService();
  const cfg: Parameters<typeof buildSystemPrompt>[0] = { agent: buildMinimalAgent() as never, date: opts.date };
  if (!opts.emptyMemory) {
    svc.add({ scope: "platform", key: "平台手写", content: "PREFIX_STABLE_MARKER", source: "manual" });
    svc.add({
      scope: "project",
      projectId: "c:\\work\\alpha",
      key: "项目手写",
      content: opts.volatileContent ?? "PREFIX_VOLATILE_MARKER",
      source: "manual",
    });
    const budget = createMemoryInjectBudgetTracker();
    cfg.memoryInstructions = composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, "c:\\work\\alpha", "s1", budget);
    cfg.memoryTailInstructions = composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, "c:\\work\\alpha", "s1", budget);
  } else if (opts.emptyBlocks) {
    // 空记忆：块**存在但内容为空**（一条条目都没有）
    const budget = createMemoryInjectBudgetTracker();
    cfg.memoryInstructions = composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, "c:\\work\\alpha", "s1", budget);
    cfg.memoryTailInstructions = composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, "c:\\work\\alpha", "s1", budget);
  }
  if (opts.skills) {
    // 技能 / MCP / 项目指令都在**稳定侧**（这是产品形态：它们属于稳定内容）
    cfg.skillInstructions = "# Skills\n\n- code-review：审查改动";
    cfg.mcpInstructions = "# MCP\n\n- filesystem：读文件";
    cfg.toolGuidance = "## Tool guidance\n\n- read：读文件前先确认路径";
  }
  return appendVolatileAppendix(buildSystemPrompt(cfg), opts.appendix);
}

beforeAll(() => {
  setLang("en");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
});
afterAll(() => setStoragePort(null));

describe("MEM-PLACE-25：技能 / MCP / deferred 提示不许顶掉稳定前缀（O-49）", () => {
  it("MEM-PLACE-25a: 附录变化时，公共前缀必须覆盖稳定前缀 + 哨兵 + 易变记忆 + date", () => {
    const a = promptWithMemory({ date: "2026-10-08 10:00", skills: true, appendix: "DEFERRED-TOOLS-A" });
    const b = promptWithMemory({ date: "2026-10-08 10:00", skills: true, appendix: "DEFERRED-TOOLS-B（工具表变了，长了 24 个字符）" });
    expect(a).toContain("DEFERRED-TOOLS-A");
    expect(b).toContain("DEFERRED-TOOLS-B");

    const boundary = findCacheBoundary(a);
    expect(boundary, "夹具前提：哨兵在场").toBeGreaterThan(-1);
    const volatileAt = a.indexOf(MEMORY_VOLATILE_HEADER);
    const dateAt = a.indexOf("# Current Date");
    expect(volatileAt).toBeGreaterThan(boundary);
    expect(dateAt).toBeGreaterThan(volatileAt);

    expect(
      commonPrefixLength(a, b),
      "附录一变就把差异点推到 date / 易变记忆之前 ⇒ 稳定前缀连同缓存边界一起被顶掉（这正是 O-49 要挡的形态）",
    ).toBeGreaterThanOrEqual(dateAt + "# Current Date".length);
    expect(a.slice(0, dateAt), "date 之前（稳定前缀 + 哨兵 + 稳定记忆 + 易变记忆）必须逐字节相同").toBe(b.slice(0, dateAt));
  });

  it("MEM-PLACE-25b: 只改易变记忆时，带技能/MCP/附录的读数不得低于不带它们的读数", () => {
    const base = { date: "2026-10-08 10:00", skills: false, appendix: undefined } as const;
    const plain1 = promptWithMemory({ ...base, volatileContent: "PREFIX_VOLATILE_MARKER" });
    const plain2 = promptWithMemory({ ...base, volatileContent: "PREFIX_VOLATILE_MARKER-改了一条" });
    const plainRatio = commonPrefixRatio(plain1, plain2);

    const rich1 = promptWithMemory({ date: "2026-10-08 10:00", skills: true, appendix: "DEFERRED-TOOLS-A", volatileContent: "PREFIX_VOLATILE_MARKER" });
    const rich2 = promptWithMemory({ date: "2026-10-08 10:00", skills: true, appendix: "DEFERRED-TOOLS-A", volatileContent: "PREFIX_VOLATILE_MARKER-改了一条" });
    const richRatio = commonPrefixRatio(rich1, rich2);

    // 结构那半（比比例更硬）：公共前缀必须覆盖到**易变记忆块首字节**
    expect(commonPrefixLength(rich1, rich2)).toBeGreaterThanOrEqual(rich1.indexOf(MEMORY_VOLATILE_HEADER));
    // 比例那半：不许因为技能/MCP 在场就掉到门槛以下（同一门槛，带余量）
    expect(richRatio, `带技能/MCP/附录时只改易变侧的前缀比例 ${richRatio.toFixed(4)} 低于门槛 0.95`).toBeGreaterThan(0.95);
    expect(
      richRatio,
      `带它们时（${richRatio.toFixed(4)}）不许比不带时（${plainRatio.toFixed(4)}）低 —— 附录在尾部，不该吃掉易变侧的比例`,
    ).toBeGreaterThanOrEqual(plainRatio - 0.01);
  });

  it("MEM-PLACE-25c 反向对照: 把附录塞进稳定侧（哨兵之前）⇒ 差异点落回稳定前缀之内（量出差距）", () => {
    // 坏落点：附录当作 skillInstructions（稳定侧的一段）参与拼接
    const bad = (appendix: string) =>
      buildSystemPrompt({
        agent: buildMinimalAgent() as never,
        date: "2026-10-08 10:00",
        skillInstructions: `# Skills\n\n- code-review：审查改动\n${appendix}`,
        memoryInstructions: "# Memory System — 稳定记忆\n\n- [2026-10-08] 甲: 乙",
      });
    const bad1 = bad("DEFERRED-TOOLS-A");
    const bad2 = bad("DEFERRED-TOOLS-B");
    const badPrefix = commonPrefixLength(bad1, bad2);
    const badBoundary = findCacheBoundary(bad1);

    const good1 = appendVolatileAppendix(bad1, "DEFERRED-TOOLS-A");
    const good2 = appendVolatileAppendix(bad1, "DEFERRED-TOOLS-B");
    const goodPrefix = commonPrefixLength(good1, good2);

    expect(badBoundary).toBeGreaterThan(-1);
    expect(badPrefix, "坏落点：附录一变，公共前缀就断在稳定前缀之内（哨兵之前）").toBeLessThan(badBoundary);
    expect(
      goodPrefix - badPrefix,
      `好落点必须比坏落点保住更多字节（好=${goodPrefix}，坏=${badPrefix}）`,
    ).toBeGreaterThan(0);
    expect(goodPrefix, "好落点：公共前缀必须越过哨兵（稳定前缀整段保住）").toBeGreaterThan(badBoundary);
  });

  it("MEM-PLACE-25d: 接线检查 —— agentic-loop 必须用唯一实现拼附录（不许内联第二份）", () => {
    const code = readFileSync(path.join(ROOT, "src/core/llm/agentic-loop.ts"), "utf8");
    expect(code, "agentic-loop 必须调用 appendVolatileAppendix（唯一实现）").toContain("appendVolatileAppendix(systemPrompt, extraSystemPrompt)");
    expect(code, "摘要说明：附录落点是判据对象，不许再内联一份拼接").toContain("appendVolatileAppendix");
  });
});

describe("MEM-PLACE-26/27：每轮固定开销的棘轮与空记忆形态（O-50）", () => {
  it("MEM-PLACE-26: 两块抬头 + 哨兵 + 两份权威句 + 分隔 ≤ 棘轮（只许降不许升）", () => {
    const full = promptWithMemory({ date: "2026-10-08 10:00" });
    // 夹具前提：稳定块的抬头 + 易变块的抬头 + 两份权威句都在场
    expect(full).toContain(MEMORY_STABLE_HEADER);
    expect(full).toContain(MEMORY_VOLATILE_HEADER);
    const authorityOccurrences = countOf(full, MEMORY_AUTHORITY_NOTE);
    expect(authorityOccurrences, "权威句必须**两份**（稳定块与易变块各一份）—— 这也是实测里 104 字符重复的来源").toBe(2);

    /*
     * 分隔符：这一轮有 3 个"块"各自带一个分隔（稳定记忆、易变记忆；哨兵自己也占一段）。
     * 只数**与记忆/哨兵直接相关**的那几个，避免把别的段算进来。
     */
    const separators = SEPARATOR.length * 3;
    const fixed =
      MEMORY_STABLE_HEADER.length +
      MEMORY_VOLATILE_HEADER.length +
      SYSTEM_PROMPT_CACHE_BOUNDARY.length +
      authorityOccurrences * MEMORY_AUTHORITY_NOTE.length +
      separators;

    expect(
      fixed,
      `每轮固定开销 ${fixed} 超过棘轮 ${FIXED_OVERHEAD_RATCHET_CHARS}；组成 = 哨兵 ${SYSTEM_PROMPT_CACHE_BOUNDARY.length}` +
        ` + 稳定抬头 ${MEMORY_STABLE_HEADER.length} + 易变抬头 ${MEMORY_VOLATILE_HEADER.length}` +
        ` + 权威句 ${MEMORY_AUTHORITY_NOTE.length}×${authorityOccurrences} + 分隔 ${separators}` +
        ` —— 文案被加长了？改文案要么压短、要么连同棘轮一起改并写明理由（O-50）`,
    ).toBeLessThanOrEqual(FIXED_OVERHEAD_RATCHET_CHARS);
  });

  it("MEM-PLACE-27: 空记忆时**只有**哨兵（两块抬头与豁免都不许出现）", () => {
    const empty = promptWithMemory({ emptyMemory: true });
    // 空记忆形态仍然必须有哨兵（"稳定前缀到此结束"是一等事实，不依赖恰好有记忆）
    expect(findCacheBoundary(empty), "空记忆时边界也必须在（旧形态 -1）").toBeGreaterThan(-1);
    expect(empty).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    // 两块抬头与豁免都不许出现（空记忆不该有任何 token 白占）
    expect(empty.includes(MEMORY_STABLE_HEADER), "空记忆不许出现稳定块抬头").toBe(false);
    expect(empty.includes(MEMORY_VOLATILE_HEADER), "空记忆不许出现易变块抬头").toBe(false);
    expect(empty.includes(MEMORY_AUTHORITY_NOTE), "空记忆不许出现权威句（豁免挂在记忆块上）").toBe(false);

    /*
     * 「显式传空块」与「完全不传记忆参数」必须**逐字相同** ——
     * 否则说明空块也会额外塞字节（那正是"空记忆白占 token"的形态）。
     */
    const emptyBlocks = promptWithMemory({ emptyMemory: true, emptyBlocks: true });
    expect(emptyBlocks, "空块与不传块必须逐字相同").toBe(empty);

    /*
     * 空记忆时（且无 date）哨兵的代价 == 哨兵字符数 + 一个段分隔：除它自己之外没有任何
     * 记忆相关字节。判据用"哨兵之前那一段"做差，避免把 date 之类别的段算进来。
     */
    const noDate = promptWithMemory({ emptyMemory: true });
    const beforeSentinel = noDate.slice(0, noDate.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
    expect(beforeSentinel).not.toContain(MEMORY_STABLE_HEADER);
    expect(
      noDate.length - beforeSentinel.length,
      "空记忆形态里除「哨兵」外不该再有任何字节（哨兵是最后一段 ⇒ 它后面没有分隔）",
    ).toBe(SYSTEM_PROMPT_CACHE_BOUNDARY.length);

    // 有 date 时，哨兵之后**只有** date 那一段（段序：… 哨兵 → date）
    const withDate = promptWithMemory({ emptyMemory: true, date: "2026-10-08 10:00" });
    const tail = withDate.slice(withDate.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
    expect(tail).toBe(`${SYSTEM_PROMPT_CACHE_BOUNDARY}${SEPARATOR}# Current Date\n\n2026-10-08 10:00`);
  });
});
