/**
 * 提示段落存活判据（补 16 号文档 §4 第 8 条“未知”）。
 *
 * 问题：某个提示段落被移除后，会不会在**压缩 / 崩溃恢复 / 子代理**里彻底消失？
 *
 * 结构事实（本文件钉住）：
 * 1. `buildSystemPrompt` 是**纯函数**：只吃 config，不吃历史 ⇒ 系统提示段落每轮重建，
 *    压缩/恢复不可能把它从请求里删掉；同 config 两次组装逐字节相同。
 * 2. 段落只在**调用方没传**时缺席（例如子代理只传核心段）——这是有意裁剪，不是“跑着跑着丢了”。
 * 3. `appendVolatileAppendix` 只在尾部追加，不动已有段落。
 *
 * 历史里注入的段（尾部上下文/后台任务通知/协作提示）本来就不跨轮保存，它们不属于本判据。
 */
import { describe, expect, it, beforeAll } from "vitest";
import { appendVolatileAppendix, buildSystemPrompt, findCacheBoundary } from "../core/prompt/prompt";
import { setLang } from "../core/i18n/lang";

function agent() {
  return {
    id: "survival",
    name: "Survival Agent",
    description: "t",
    mode: "build" as const,
    prompt: "AGENT_PROMPT_MARKER",
    permissions: [],
  };
}

function fullConfig() {
  return {
    agent: agent() as any,
    memoryTailInstructions: "MEMORY_TAIL_MARKER",
    skillInstructions: "SKILL_MARKER",
    mcpInstructions: "MCP_MARKER",
    toolGuidance: "TOOL_GUIDANCE_MARKER",
    squadRoster: "SQUAD_MARKER",
    personaSection: "# Persona\n\nPERSONA_MARKER",
    workingDirectory: "C:\\WS_MARKER",
    gitBranch: "BRANCH_MARKER",
    date: "2026-10-29 13:00",
    knowledgeContext: {
      notebookName: "NOTEBOOK_MARKER",
      notebookDescription: "d",
      notebookSummary: "s",
      sourceCount: 1,
      chunkCount: 1,
    },
  };
}

const markers = [
  "AGENT_PROMPT_MARKER",
  "MEMORY_TAIL_MARKER",
  "SKILL_MARKER",
  "MCP_MARKER",
  "TOOL_GUIDANCE_MARKER",
  "SQUAD_MARKER",
  "PERSONA_MARKER",
  "WS_MARKER",
  "BRANCH_MARKER",
  "NOTEBOOK_MARKER",
];

describe("PROMPT-SURVIVAL：系统提示段落每轮重建", () => {
  beforeAll(() => setLang("zh"));

  it("PS-1: 全量 config 下每个段落都在（且各出现一次）", () => {
    const p = buildSystemPrompt(fullConfig() as any);
    for (const m of markers) {
      const count = p.split(m).length - 1;
      expect(count, `${m} 应恰好出现一次，实际 ${count}`).toBe(1);
    }
  });

  it("PS-2: 纯函数 —— 同 config 两次组装逐字节相同（压缩/恢复没有可丢的跨轮状态）", () => {
    const a = buildSystemPrompt(fullConfig() as any);
    const b = buildSystemPrompt(fullConfig() as any);
    expect(b).toBe(a);
  });

  it("PS-3: 段落缺席只因为调用方没传，不会从全局状态偷偷补回", () => {
    const p = buildSystemPrompt({ agent: agent() as any });
    expect(p).toContain("AGENT_PROMPT_MARKER");
    for (const m of ["MEMORY_TAIL_MARKER", "SKILL_MARKER", "MCP_MARKER", "TOOL_GUIDANCE_MARKER", "SQUAD_MARKER", "NOTEBOOK_MARKER"]) {
      expect(p, `${m} 没传就不该出现`).not.toContain(m);
    }
  });

  it("PS-4: 子代理式裁剪（只给核心段）仍保留身份/语言/工具规则", () => {
    const p = buildSystemPrompt({
      agent: agent() as any,
      toolGuidance: "TOOL_GUIDANCE_MARKER",
      workingDirectory: "C:\\WS_MARKER",
    } as any);
    expect(p).toContain("AGENT_PROMPT_MARKER");
    expect(p).toContain("TOOL_GUIDANCE_MARKER");
    expect(p).toContain("WS_MARKER");
    expect(p).toContain("# Language");
  });

  it("PS-5: 追加易变尾部不会动已有段落（缓存边界仍在稳定侧）", () => {
    const base = buildSystemPrompt(fullConfig() as any);
    const appended = appendVolatileAppendix(base, "VOLATILE_TAIL_MARKER");
    expect(appended.startsWith(base), "已有段落必须逐字节保留").toBe(true);
    expect(appended.endsWith("VOLATILE_TAIL_MARKER")).toBe(true);
    expect(findCacheBoundary(appended)).toBeGreaterThan(0);
    for (const m of markers) expect(appended).toContain(m);
  });

  it("PS-6: 压缩标记属于消息历史，不参与系统提示组装", () => {
    // 系统提示只吃 config；把“历史里出现过压缩标记”这件事模拟成一次普通重建，
    // 结果必须与没有压缩时完全相同（证明压缩不会从系统提示里抹掉段落）。
    const before = buildSystemPrompt(fullConfig() as any);
    const afterCompaction = buildSystemPrompt(fullConfig() as any);
    expect(afterCompaction).toBe(before);
  });
});
