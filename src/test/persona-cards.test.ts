/**
 * 测试：人设卡（persona，B2，对标 EAC dsh-soul-md）
 *
 * 覆盖 PERSONA-001 ~ PERSONA-007：
 *   - PERSONA-001: 保存/列出/读取人设卡
 *   - PERSONA-002: 更新卡（同 id 覆盖不新增）
 *   - PERSONA-003: 删除卡 + 清除激活状态
 *   - PERSONA-004: 激活/取消激活切换
 *   - PERSONA-005: 激活卡生成 # Persona 注入段（内联内容）
 *   - PERSONA-006: 未激活 / 无卡 → 段落为空串（不注入）
 *   - PERSONA-007: 文件模式——路径不可读时回落 fallback；fallback 空 → 不注入
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  listPersonaCards, savePersonaCard, deletePersonaCard, getPersonaCard,
  getActivePersonaId, setActivePersona, clearActivePersona,
  getActivePersonaPrompt, buildPersonaPromptSection,
} from "../core/persona/persona";

describe("persona — 人设卡（B2）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("PERSONA-001: 保存/列出/读取人设卡", () => {
    const card = savePersonaCard({ name: "严谨工程师", content: "你是严谨的工程师。任务质量优先。" });
    expect(card.id).toBeTruthy();
    expect(listPersonaCards()).toHaveLength(1);
    expect(getPersonaCard(card.id)?.name).toBe("严谨工程师");
  });

  it("PERSONA-002: 同 id 保存覆盖不新增", () => {
    const card = savePersonaCard({ name: "A", content: "v1" });
    savePersonaCard({ id: card.id, name: "A2", content: "v2" });
    const cards = listPersonaCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].content).toBe("v2");
  });

  it("PERSONA-003: 删除卡并清除其激活状态", () => {
    const card = savePersonaCard({ name: "临时", content: "x" });
    setActivePersona(card.id);
    expect(getActivePersonaId()).toBe(card.id);
    deletePersonaCard(card.id);
    expect(listPersonaCards()).toHaveLength(0);
    expect(getActivePersonaId()).toBe(""); // 激活自动清空
  });

  it("PERSONA-004: 激活/取消激活切换", () => {
    const a = savePersonaCard({ name: "A", content: "ca" });
    const b = savePersonaCard({ name: "B", content: "cb" });
    setActivePersona(a.id);
    expect(getActivePersonaId()).toBe(a.id);
    setActivePersona(b.id);
    expect(getActivePersonaId()).toBe(b.id);
    clearActivePersona();
    expect(getActivePersonaId()).toBe("");
  });

  it("PERSONA-005: 激活卡生成 # Persona 注入段（内联内容）", async () => {
    const card = savePersonaCard({ name: "创意作家", content: "你是富有想象力的创意作家。" });
    setActivePersona(card.id);
    const prompt = await getActivePersonaPrompt();
    expect(prompt).toContain("创意作家");
    const section = await buildPersonaPromptSection();
    expect(section).toContain("# Persona");
    expect(section).toContain("富有想象力的创意作家");
  });

  it("PERSONA-006: 未激活 / 无卡 → 段落为空（不注入）", async () => {
    savePersonaCard({ name: "未激活", content: "不应注入" });
    expect(await buildPersonaPromptSection()).toBe("");
    expect(await getActivePersonaPrompt()).toBeNull();
  });

  it("PERSONA-007: 文件模式不可读回落 fallback；fallback 空则不注入", async () => {
    const card = savePersonaCard({ name: "文件卡", path: "Z:/no/such/soul.md", fallback: "兜底人格" });
    setActivePersona(card.id);
    // readFile 抛错 → 用 fallback
    expect(await getActivePersonaPrompt()).toBe("兜底人格");

    // fallback 空 → 不注入
    savePersonaCard({ id: card.id, name: "文件卡2", path: "Z:/no/such/soul.md", fallback: "" });
    expect(await getActivePersonaPrompt()).toBeNull();
    expect(await buildPersonaPromptSection()).toBe("");
  });
});
