/**
 * 系统提示前缀稳定性测试（服务端 KV 缓存命中最大化）
 *
 * DeepSeek 前缀缓存：命中范围 = 请求前缀到首个差异点。date 每分钟变化，
 * 若其位于系统提示中段会切断其后所有稳定内容的缓存（工具指引/MCP/历史
 * 规则每轮都要重新计算）。修复：date **收尾**（系统提示最后一段）——
 * 不同分钟的两份 prompt 公共前缀应覆盖除末尾 date 段外的全部内容。
 *
 * ⚠️ 第 189 波（F2）：下面 4 个用例**都不带记忆**，而产品形态里系统提示**带记忆块**。
 * 只测"无记忆"形态会给出**假绿**（两条 `endsWith(date)` / `startsWith(base)` 断言在
 * 带记忆时曾经全绿，但真实缺陷 —— date 之后还有内容 —— 不会被它们发现）。
 * 所以补一个「带记忆」的用例，并把度量改成**易变块首字节 / date 段起点**，
 * 而不是 `endsWith`。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSystemPrompt, minutePrecisionDate, setPromptClock } from "../core/prompt/prompt";
import {
  MemoryService,
  MEMORY_STABLE_BLOCK_SELECTION,
  MEMORY_STABLE_HEADER,
  MEMORY_VOLATILE_BLOCK_SELECTIONS,
  MEMORY_VOLATILE_HEADER,
  composeMemoryBlock,
  createMemoryInjectBudgetTracker,
} from "../core/memory/memory";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import { getLang, setLang } from "../core/i18n/lang";

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

function commonPrefixRatio(a: string, b: string): number {
  let i = 0
  const max = Math.min(a.length, b.length)
  while (i < max && a[i] === b[i]) i++
  return i / Math.max(a.length, b.length)
}

/** 公共前缀长度（码元级；"差异点落在哪一段"要用它，不能用比例反推） */
function commonPrefixLength(a: string, b: string): number {
  let i = 0
  const max = Math.min(a.length, b.length)
  while (i < max && a[i] === b[i]) i++
  return i
}

describe("系统提示前缀稳定性", () => {
  beforeAll(async () => {
    setLang("en");
  });

  it("不同分钟的 prompt 公共前缀覆盖绝大部分内容（date 已尾置）", () => {
    const a = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:00" });
    const b = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:01" });
    const ratio = commonPrefixRatio(a, b)
    // date 段极短：公共前缀应覆盖几乎全部稳定内容（语言/规则/工具指引）
    expect(ratio).toBeGreaterThan(0.95)
    // 差异只出现在末尾的 Current Date 段
    expect(a.endsWith("# Current Date\n\n2026-09-04 10:00")).toBe(true)
    expect(b.endsWith("# Current Date\n\n2026-09-04 10:01")).toBe(true)
  })

  it("无 date 与有 date 的差异同样只在末尾（date 不污染中段缓存）", () => {
    const base = buildSystemPrompt({ agent: buildMinimalAgent() as any })
    const withDate = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:05" })
    // 公共前缀应覆盖 base 全文（withDate 仅在尾部追加）
    expect(base.length < withDate.length).toBe(true)
    expect(withDate.startsWith(base)).toBe(true)
  })

  it("date 段未出现在中段的 # Environment（防止回退）", () => {    const p = buildSystemPrompt({
      agent: buildMinimalAgent() as any,
      date: "2026-09-04 10:00",
      workingDirectory: "C:/repo",
    })
    // # Environment 段不应再包含 Current date（已在末尾独立段）
    const envSection = p.split("\n\n---\n\n").find(s => s.startsWith("# Environment"))
    expect(envSection).toBeTruthy()
    expect(envSection!.includes("Current date")).toBe(false)
    expect(envSection!.includes("Working directory: C:/repo")).toBe(true)
  })

  it("同会话连续请求（同 date/同配置）prompt 完全一致 → 前缀 100% 稳定（API 命中前提）", () => {
    const cfg = { agent: buildMinimalAgent() as any, date: "2026-09-04 10:00", workingDirectory: "C:/repo" }
    const a = buildSystemPrompt(cfg)
    const b = buildSystemPrompt({ ...cfg })
    expect(a).toBe(b)
  })
})

/** 带**真实记忆块**的系统提示（产品形态：稳定块 + 哨兵 + 易变块 + date 收尾） */
function promptWithMemory(date?: string): string {
  saveMemory("");
  const svc = new MemoryService();
  svc.add({ scope: "platform", key: "平台手写", content: "PREFIX_STABLE_MARKER", source: "manual" });
  svc.add({ scope: "project", projectId: "c:\\work\\alpha", key: "项目手写", content: "PREFIX_VOLATILE_MARKER", source: "manual" });
  const budget = createMemoryInjectBudgetTracker();
  return buildSystemPrompt({
    agent: buildMinimalAgent() as any,
    date,
    memoryInstructions: composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, "c:\\work\\alpha", "s1", budget),
    memoryTailInstructions: composeMemoryBlock(svc, MEMORY_VOLATILE_BLOCK_SELECTIONS, MEMORY_VOLATILE_HEADER, "c:\\work\\alpha", "s1", budget),
  });
}

describe("带记忆的系统提示前缀稳定性（F2 补测）", () => {
  beforeAll(() => {
    setLang("en");
    setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  });
  afterAll(() => {
    setStoragePort(null);
  });

  it("MEM-PLACE-18-F2：date 收尾，跨分钟差异只在 date 段（易变记忆不许被一起顶掉）", () => {
    const a = promptWithMemory("2026-09-04 10:00");
    const b = promptWithMemory("2026-09-04 10:01");

    // 缓存边界与易变记忆都在（否则这条判据在测一个不含记忆的形态）
    expect(a).toContain(MEMORY_VOLATILE_HEADER);
    expect(a).toContain("PREFIX_VOLATILE_MARKER");
    // date **仍是最后一段**（旧序 date → 记忆 时这里会红）
    expect(a.endsWith("# Current Date\n\n2026-09-04 10:00"), "date 必须是最后一段").toBe(true);
    expect(b.endsWith("# Current Date\n\n2026-09-04 10:01"), "date 必须是最后一段").toBe(true);

    /*
     * 度量改成"跨分钟公共前缀必须覆盖到**易变记忆块首字节**"：
     * 这直接对应第 189 波第 4 条的实测依据 —— 旧序里 date 每分钟一变就把记忆一起顶掉
     * （跨分钟公共前缀 94.64% < 只改易变记忆的 97.67%）。date 收尾后记忆不再被波及。
     */
    const volatileAt = a.indexOf(MEMORY_VOLATILE_HEADER);
    expect(volatileAt).toBeGreaterThan(-1);
    expect(
      commonPrefixLength(a, b),
      "跨分钟时公共前缀必须覆盖易变记忆块（date 收尾 ⇒ 只顶掉自己）",
    ).toBeGreaterThanOrEqual(volatileAt);
    expect(a.slice(0, volatileAt)).toBe(b.slice(0, volatileAt));
    /*
     * P4 合并（第 189 波复审）：`memory-placement-boundary.test.ts` 的 `MEM-PLACE-7` 第三段
     * 与这条同形重复，已删除；它**更强**的两条断言搬到这里（覆盖不下降）：
     * ① 跨分钟公共前缀必须覆盖到 **date 段起点**（不只是易变块抬头）；
     * ② date 段起点之前的内容逐字节相同。
     */
    const dateAt = a.indexOf("# Current Date");
    expect(dateAt, "date 段必须在").toBeGreaterThan(volatileAt);
    expect(
      commonPrefixLength(a, b),
      "date 之前的一切（含稳定前缀、哨兵、稳定记忆、易变记忆）都必须逐字节相同",
    ).toBeGreaterThanOrEqual(dateAt);
    expect(a.slice(0, dateAt)).toBe(b.slice(0, dateAt));
    // 而且确实有差异（date 那一段）
    expect(a).not.toBe(b);

    // 无 date 的提示仍是有 date 的提示的**前缀**（date 只追加在末尾）
    const noDate = promptWithMemory();
    expect(noDate.length < a.length).toBe(true);
    expect(a.startsWith(noDate), "date 段只能追加在末尾，不许插进中段").toBe(true);
  });

  it("MEM-PLACE-18：date 的时区标注必须与实际一致（不许拿本地时间带 Z 后缀）", () => {
    const clock = new Date("2026-10-08T06:30:00.000Z");
    setPromptClock(() => clock);
    try {
      const s = minutePrecisionDate();
      // ① 最硬的形式：这个字符串解析回来必须与时钟**同一分钟**（"标注 == 实际"）
      const parsed = new Date(s);
      expect(Number.isNaN(parsed.getTime()), `date 必须是可解析的时间串，实际：${s}`).toBe(false);
      expect(
        Math.floor(parsed.getTime() / 60000),
        `date 标注的瞬时必须与真实时刻同一分钟，实际：${s}`,
      ).toBe(Math.floor(clock.getTime() / 60000));

      // ② 后缀必须是**真实偏移**（±HH:MM），不许硬编码 Z（旧实现就是本地时分 + Z）
      const m = /([+-])(\d{2}):(\d{2})$/.exec(s);
      expect(m, `带本地时分的 date 不许再挂 Z 后缀，实际：${s}`).toBeTruthy();
      const offset = (m![1] === "-" ? -1 : 1) * (Number(m![2]) * 60 + Number(m![3]));
      expect(offset, `偏移必须是本机真实时区偏移，实际：${s}`).toBe(-clock.getTimezoneOffset());

      // ③ 时分必须是**本地**时分（不是把 UTC 时分当本地）
      const pad = (n: number) => String(n).padStart(2, "0");
      expect(s.slice(11, 16)).toBe(`${pad(clock.getHours())}:${pad(clock.getMinutes())}`);
      expect(s.slice(0, 10)).toBe(
        `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`,
      );
    } finally {
      setPromptClock(null);
    }
  });
});
