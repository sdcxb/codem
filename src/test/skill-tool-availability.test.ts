/**
 * 技能工具的**可用性声明**必须与实际注册一致（第 184 波 F4）。
 *
 * ## 缺陷形态
 *
 * 用户在技能 frontmatter 里写 `tools: [{name: x}]`（没有对应的 Provider 工厂；
 * `registerFactory` 在生产代码里**零调用点**）⇒ `SkillToolRegistry.loadProvider` 把声明的名字
 * 塞进 `registeredToolNames` 并**原样返回**，`toolRegistry.register` 一次未调；
 * `load_skill` 据此输出「Tools from this skill are now available: x」
 * ⇒ 模型调用不存在的工具、反复失败；卸载时还会对这些从未注册的名字调 `toolRegistry.remove()`
 * ⇒ **误删同名真工具**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SKILL-F4-1 | 声明而无工厂 ⇒ `loadProvider` 返回 `[]`（不许谎称可用）+ 声明名单独记账 |
 * | SKILL-F4-2 | 卸载不许误删同名**真**工具 |
 * | SKILL-F4-3 | 说话口径：没真注册就不许出现 "now available"；声明未实现要如实说明 |
 * | SKILL-F4-4 反向对照 | 有工厂时照常注册、`getLoadedTools` 真的有名字 |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SkillToolRegistry } from "../core/skill/registry";
import { ToolRegistry, type ToolDef } from "../core/llm/tools";
import type { SkillDefinition } from "../core/skill/skill";
import { describeSkillTools } from "../core/llm/tools/load-skill";

function makeTool(id: string): ToolDef {
  return {
    id,
    description: `tool ${id}`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { title: id, output: "ok", isError: false };
    },
  } as ToolDef;
}

/** 造一个"声明了 tools、但没有工厂"的技能 */
function declaredOnlySkill(name: string, tools: string[]): SkillDefinition {
  return {
    name,
    description: "d",
    prompt: "p",
    enabled: true,
    tools: tools.map((t) => ({ name: t })),
  } as unknown as SkillDefinition;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("技能工具可用性声明（第 184 波 F4）", () => {
  it("SKILL-F4-1: 声明了 tools 但没有工厂 ⇒ 一个都不许说成「已注册」", async () => {
    const registry = new SkillToolRegistry();
    const tools = new ToolRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await registry.loadProvider(
      declaredOnlySkill("ghost-skill", ["ghost_tool"]),
      "C:\\skills\\ghost-skill",
      tools,
    );

    expect(loaded, "没调过一次 toolRegistry.register，就不许把这些名字当成已加载").toEqual([]);
    expect(registry.getLoadedTools("ghost-skill"), "getLoadedTools 也必须为空").toEqual([]);
    expect(
      registry.getDeclaredOnlyTools("ghost-skill"),
      "但声明本身要如实记账（供 load_skill 说明「声明了但没实现」）",
    ).toEqual(["ghost_tool"]);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("ghost_tool");
    expect(tools.get("ghost_tool"), "ToolRegistry 里当然没有它").toBeUndefined();
  });

  it("SKILL-F4-2: 卸载不许误删同名**真**工具", async () => {
    const registry = new SkillToolRegistry();
    const tools = new ToolRegistry();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // 一个真实注册的工具，恰好与技能声明的名字相同
    tools.register(makeTool("read_file"));
    expect(tools.get("read_file")).toBeTruthy();

    await registry.loadProvider(
      declaredOnlySkill("impostor", ["read_file"]),
      "C:\\skills\\impostor",
      tools,
    );
    await registry.unloadProvider("impostor", tools);

    expect(
      tools.get("read_file"),
      "改前会把「仅声明」的名字当自己的工具 remove 掉 ⇒ 真工具被误删",
    ).toBeTruthy();
    expect(registry.getDeclaredOnlyTools("impostor"), "卸载也要清账").toEqual([]);
    expect(registry.isLoaded("impostor")).toBe(false);
  });

  it("SKILL-F4-3: 说话口径 —— 没真注册就不许出现「now available」", () => {
    // ① 只声明、没实现
    const declaredOnly = describeSkillTools({ registered: [], declaredOnly: ["ghost_tool"] });
    expect(declaredOnly, "不许说可用").not.toContain("now available");
    expect(declaredOnly, "要如实说：声明了但没实现").toContain("没有实现");
    expect(declaredOnly).toContain("ghost_tool");
    expect(declaredOnly).toContain("不可调用");

    // ② 加载抛错
    const errored = describeSkillTools({ registered: [], loadError: "boom" });
    expect(errored).not.toContain("now available");
    expect(errored).toContain("未能加载");
    expect(errored).toContain("boom");

    // ③ 真的注册成功
    const ok = describeSkillTools({ registered: ["real_tool"] });
    expect(ok).toContain("Tools from this skill are now available: real_tool");

    // ④ 部分实现 + 部分仅声明：两句话都要有，且"可用"只覆盖真的那份
    const mixed = describeSkillTools({ registered: ["real_tool"], declaredOnly: ["ghost_tool"] });
    expect(mixed).toContain("now available: real_tool");
    expect(mixed).not.toContain("now available: real_tool, ghost_tool");
    expect(mixed).toContain("没有实现");
  });

  it("SKILL-F4-4 反向对照：有工厂时照常真注册（别把好的弄坏）", async () => {
    const registry = new SkillToolRegistry();
    const tools = new ToolRegistry();
    registry.registerFactory("real-skill", () => ({
      getTools: () => [makeTool("real_tool")],
    }));

    const skill = {
      name: "real-skill",
      description: "d",
      prompt: "p",
      enabled: true,
      tools: [{ name: "real_tool" }],
    } as unknown as SkillDefinition;

    const loaded = await registry.loadProvider(skill, "C:\\skills\\real-skill", tools);

    expect(loaded).toEqual(["real_tool"]);
    expect(tools.get("real_tool"), "真的注册进 ToolRegistry 了").toBeTruthy();
    expect(registry.getLoadedTools("real-skill")).toEqual(["real_tool"]);
    expect(registry.getDeclaredOnlyTools("real-skill")).toEqual([]);

    await registry.unloadProvider("real-skill", tools);
    expect(tools.get("real_tool"), "真注册的才该被卸载移除").toBeUndefined();
  });
});
