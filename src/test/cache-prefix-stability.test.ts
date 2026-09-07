/**
 * 系统提示前缀稳定性测试（服务端 KV 缓存命中最大化）
 *
 * DeepSeek 前缀缓存：命中范围 = 请求前缀到首个差异点。date 每分钟变化，
 * 若其位于系统提示中段会切断其后所有稳定内容的缓存（工具指引/MCP/历史
 * 规则每轮都要重新计算）。修复：date 独立段置于系统提示最末——
 * 不同分钟的两份 prompt 公共前缀应覆盖除末尾 date 段外的全部内容。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { buildSystemPrompt } from "../core/prompt/prompt";
import { getLang, setLang } from "../core/i18n/lang";
import { resetDatabase, initDatabase } from "../core/storage/database";

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

describe("系统提示前缀稳定性", () => {
  beforeAll(async () => {
    await resetDatabase();
    await initDatabase();
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
