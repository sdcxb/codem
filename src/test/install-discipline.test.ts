/**
 * 「安装纪律」判据（用户要求）：模型装**技能/插件**前必须被指向权威手册，不许反复试错。
 *
 * ## 守的缺陷（用户原话）
 * 「codem 接入的大模型总因为不知道机制而频繁试错安装」——
 * 技能与插件是**两套完全不同的机制**（技能=复制目录；插件=provider + 注册一行），
 * 而此前系统提示里只有技能那一段，插件**全仓零引导** ⇒ 模型只能靠试。
 *
 * ## 为什么断言分两半（用户要求：系统提示别太长）
 * 细则已**下沉到文档**：系统提示只留「事实 + 去读手册」，步骤在 `docs/*-INSTALL.md`。
 * 判据也跟着分两半，**保证跟随内容移动、不会因为搬走而失去守护**：
 * - 提示侧：必须点名两本手册（否则模型不会去读）；
 * - 文档侧：必须真的写清步骤（否则提示指向了空文档）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("INST：安装纪律（提示只给指针，步骤在文档）", () => {
  it("INST-1: 两本手册存在且含关键锚点", () => {
    const skills = read("docs/SKILLS-INSTALL.md");
    const plugins = read("docs/PLUGIN-INSTALL.md");
    for (const [name, doc, anchors] of [
      ["SKILLS-INSTALL", skills, [".codem/skills", "SKILL.md", "frontmatter", "description", "复制"]],
      [
        "PLUGIN-INSTALL",
        plugins,
        ["registerBuiltinPlugin", "provides", "ctx.provide", "getToolContext", "builtin-registry.ts", "codem.yml"],
      ],
    ] as const) {
      for (const a of anchors) {
        expect(doc.includes(a), `${name} 缺少关键锚点「${a}」`).toBe(true);
      }
    }
  });

  it("INST-2: 系统提示必须点名两本手册（只给指针，不再内嵌整段步骤）", async () => {
    const { getSkillRegistry } = await import("../core/skill/skill");
    const section = getSkillRegistry().buildSkillEnvironmentSection();
    expect(section, "必须点名技能手册").toContain("docs/SKILLS-INSTALL.md");
    expect(section, "必须点名插件手册").toContain("docs/PLUGIN-INSTALL.md");
    expect(section, "要给出「先读手册、不要试探」的纪律").toMatch(/先读手册|不要试探/);
    // 反向对照：细则不该还留在提示里（否则等于没下沉，白占稳定前缀）
    expect(section, "细则不该还内嵌在提示里（应只在文档里）").not.toContain("从仓库/URL 安装");
  });

  it("INST-3: 插件手册要写清四步机制（含「取不到就回退」）", () => {
    const doc = read("docs/PLUGIN-INSTALL.md");
    expect(doc).toContain("registerBuiltinPlugin");
    expect(doc).toContain("ctx.provide");
    expect(doc).toContain("getToolContext()");
    expect(doc, "必须写清回退，否则禁用/删除插件后应用会坏").toMatch(/回退/);
  });

  it("INST-4: 插件手册要写明「没有第三方插件包安装服务」这条禁行", () => {
    const doc = read("docs/PLUGIN-INSTALL.md");
    expect(doc).toMatch(/pluginInstaller|安装服务/);
    expect(doc, "要明确禁止试探").toMatch(/不要.*试|别去试/);
  });
});
