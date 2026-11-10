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

  it("不同分钟的 prompt 逐字节相同（date 已整体移出 system）", () => {
    const a = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:00" });
    const b = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:01" });
    // 日期不再进 system ⇒ 跨分钟前缀 100% 稳定（缓存断点在 system 上）
    expect(a).toBe(b)
    expect(commonPrefixRatio(a, b)).toBe(1)
    expect(a.includes("# Current Date"), "system 不许再含 # Current Date").toBe(false)
  })

  it("无 date 与有 date 的 system 逐字节相同（date 不再影响 system）", () => {
    const base = buildSystemPrompt({ agent: buildMinimalAgent() as any })
    const withDate = buildSystemPrompt({ agent: buildMinimalAgent() as any, date: "2026-09-04 10:05" })
    expect(withDate).toBe(base)
  })

  it("date 不出现在 # Environment，也不出现在 system 任何位置（防止回退）", () => {
    const p = buildSystemPrompt({
      agent: buildMinimalAgent() as any,
      date: "2026-09-04 10:00",
      workingDirectory: "C:/repo",
    })
    const envSection = p.split("\n\n---\n\n").find(s => s.startsWith("# Environment"))
    expect(envSection).toBeTruthy()
    expect(envSection!.includes("Current date")).toBe(false)
    expect(envSection!.includes("Working directory: C:/repo")).toBe(true)
    expect(p.includes("Current Date"), "system 任何位置都不许出现 date 段").toBe(false)
    expect(p.includes("2026-09-04 10:00"), "system 里不许出现分钟时间戳").toBe(false)
  })

  it("同会话连续请求（同 date/同配置）prompt 完全一致 → 前缀 100% 稳定（API 命中前提）", () => {
    const cfg = { agent: buildMinimalAgent() as any, date: "2026-09-04 10:00", workingDirectory: "C:/repo" }
    const a = buildSystemPrompt(cfg)
    const b = buildSystemPrompt({ ...cfg })
    expect(a).toBe(b)
  })
})

/**
 * 夹具专用：把条目 id 固定成确定值（`mem-fixture-0..n`，按插入序）。
 *
 * 为什么需要它：产品里**同一条记忆的 id 跨回合不变**；而 `add()` 生成的是
 * `mem-<时间>-<随机>` —— 每次重建服务都会拿到不同 id。索引式注入把 id **恒写在行内**
 * （`- [date] (id) key — 摘要…`），不固定的话「跨分钟只顶掉 date」这条判据会先被
 * **夹具抖动**打断（差异点落在记忆那一行），量到的就不是 date 的位移了。
 */
function pinFixtureIds(svc: MemoryService): void {
  const holder = svc as unknown as { entries: Map<string, { id: string }> };
  const pinned = new Map<string, { id: string }>();
  let i = 0;
  for (const entry of holder.entries.values()) {
    entry.id = `mem-fixture-${i++}`;
    pinned.set(entry.id, entry);
  }
  holder.entries = pinned;
}

/** 带**真实记忆块**的系统提示（产品形态：稳定块 + 哨兵 + 易变块 + date 收尾） */
function promptWithMemory(date?: string): string {
  saveMemory("");
  const svc = new MemoryService();
  svc.add({ scope: "platform", key: "平台手写", content: "PREFIX_STABLE_MARKER", source: "manual", timestamp: 1_760_000_000_000 });
  svc.add({ scope: "project", projectId: "c:\\work\\alpha", key: "项目手写", content: "PREFIX_VOLATILE_MARKER", source: "manual", timestamp: 1_760_000_000_001 });
  // 两次调用必须落在**同一批条目 id**上（见 `pinFixtureIds`），否则量到的是夹具抖动
  pinFixtureIds(svc);
  const budget = createMemoryInjectBudgetTracker();
  return buildSystemPrompt({
    agent: buildMinimalAgent() as any,
    date,
    memoryInstructions: composeMemoryBlock(svc, MEMORY_STABLE_BLOCK_SELECTION, MEMORY_STABLE_HEADER, "c:\\work\\alpha", "s1", budget),
    memoryTailInstructions: composeMemoryBlock(
      svc,
      MEMORY_VOLATILE_BLOCK_SELECTIONS,
      MEMORY_VOLATILE_HEADER,
      "c:\\work\\alpha",
      "s1",
      budget,
      /* MEM-AUTH-1：与产品注入点同形（易变块 = mixed 框架） */
      "mixed",
    ),
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

  it("MEM-PLACE-18-F2：跨分钟 system 逐字节相同（date 已移出，记忆与哨兵不受影响）", () => {
    const a = promptWithMemory("2026-09-04 10:00");
    const b = promptWithMemory("2026-09-04 10:01");

    // 缓存边界与易变记忆都在（否则这条判据在测一个不含记忆的形态）
    expect(a).toContain(MEMORY_VOLATILE_HEADER);
    expect(a).toContain("PREFIX_VOLATILE_MARKER");
    // date 不再进 system ⇒ 跨分钟必须逐字节相同、前缀 100% 稳定
    expect(a.includes("# Current Date"), "system 不许再含 date 段").toBe(false);
    expect(a).toBe(b);
    expect(commonPrefixRatio(a, b)).toBe(1);

    // 无 date 参数同样不影响 system（避免“参数变化仍可复现”的假红）
    const noDate = promptWithMemory();
    expect(noDate).toBe(a);
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
