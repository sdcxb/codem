/**
 * 第三方 Agent Skills 兼容性测试（AREX-Skill 集成驱动）
 *
 * 背景：GitHub 上的技能库（如 VectorSpaceLab/AREX-Skill，5000+ skills）使用标准
 * Agent Skills 约定：SKILL.md 的 frontmatter 可能是「带引号的标量」「跨行的双引号
 * 标量」「折叠/字面块标量（> / |）」。修复前的解析器会：
 *   - 把 `name: "repo-skills-router"` 解析成带引号的技能名 → load_skill 查不到
 *   - 把跨行标量截断到第一行 → vllm 的描述只剩 61 字符且带一个多余引号
 *   - 把 `description: >-` 解析成字面字符串 ">-" → 描述完全丢失
 *   - 正文没有 `# ` 一级标题时整个技能被判定为非法（返回 null）
 *
 * 本文件锁死这些行为，避免回归。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSkillMarkdown, SkillRegistry, getSkillRegistry } from "../core/skill/skill";

/** 上游真实 frontmatter：AREX-Skill vllm 技能（Apache-2.0，用于兼容性回归） */
const AREX_VLLM_SKILL = `---
name: vllm
description: "Route vLLM tasks across offline inference, OpenAI-compatible
  serving, structured/tool/reasoning, multimodal/LoRA/pooling, and
  deployment/performance workflows."
disable-model-invocation: true
metadata:
  disco-role: operating
license: Apache 2.0
---

# vLLM

Use this skill when the user asks how to install, use, serve, configure, troubleshoot, or optimize vLLM.

## First Checks

- Confirm whether the user wants **in-process Python inference** or an **OpenAI-compatible HTTP server**.
- Use \`references/repo-provenance.md\` to check whether this skill is aligned with the current vLLM checkout.
`;

function skillMd(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe("Agent Skills frontmatter 兼容性", () => {
  // ===== FRONT: 标量解析 =====

  it("FRONT-1: 双引号技能名被去引号，可用原名查表", () => {
    const skill = parseSkillMarkdown(
      skillMd(`name: "quoted-name"\ndescription: "One line description."`, "# Heading\nBody"),
      "/fake/skills/quoted-name/SKILL.md",
    );
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("quoted-name");
    expect(skill!.description).toBe("One line description.");

    const registry = new SkillRegistry();
    registry.register(skill!);
    expect(registry.get("quoted-name")).toBeDefined();
    // 修复前：注册名是 '"quoted-name"'，按正常名字查不到
    expect(registry.get('"quoted-name"')).toBeUndefined();
  });

  it("FRONT-2: 单引号标量被去引号且保留内部撇号", () => {
    const skill = parseSkillMarkdown(
      skillMd(`name: 'single'\ndescription: 'It''s a single quoted value.'`, "# Heading\nBody"),
      "/fake/skills/single/SKILL.md",
    );
    expect(skill!.name).toBe("single");
    expect(skill!.description).toBe("It's a single quoted value.");
  });

  it("FRONT-3: 双引号内的转义引号被还原", () => {
    const skill = parseSkillMarkdown(
      skillMd(`name: escaped\ndescription: "Has a \\"quoted\\" word inside."`, "# Heading\nBody"),
      "/fake/skills/escaped/SKILL.md",
    );
    expect(skill!.description).toBe('Has a "quoted" word inside.');
  });

  it("FRONT-4: 跨行双引号标量被折行拼接，不再截断到第一行", () => {
    const skill = parseSkillMarkdown(AREX_VLLM_SKILL, "/fake/skills/vllm/SKILL.md");
    expect(skill!.name).toBe("vllm");
    expect(skill!.description).toBe(
      "Route vLLM tasks across offline inference, OpenAI-compatible serving, " +
        "structured/tool/reasoning, multimodal/LoRA/pooling, and deployment/performance workflows.",
    );
    // 修复前长度为 61（第一行 + 一个多余的前引号）
    expect(skill!.description.length).toBeGreaterThan(100);
    expect(skill!.description.startsWith('"')).toBe(false);
    expect(skill!.description.endsWith('"')).toBe(false);
  });

  it("FRONT-5: 折叠块标量 >- 被解析为单行文本", () => {
    const skill = parseSkillMarkdown(
      skillMd(
        `name: folded\ndescription: >-\n  First part of the description\n  continues on the second line.`,
        "# Heading\nBody",
      ),
      "/fake/skills/folded/SKILL.md",
    );
    expect(skill!.description).toBe("First part of the description continues on the second line.");
  });

  it("FRONT-6: 折叠块标量 > 保留结尾换行但不留多余空白", () => {
    const skill = parseSkillMarkdown(
      skillMd(`name: foldedclip\ndescription: >\n  Folded with clip chomping.`, "# Heading\nBody"),
      "/fake/skills/foldedclip/SKILL.md",
    );
    expect(skill!.description.trim()).toBe("Folded with clip chomping.");
  });

  it("FRONT-7: 字面块标量 | 保留换行，|- 去掉结尾换行", () => {
    const literal = parseSkillMarkdown(
      skillMd(`name: literal\ndescription: |\n  Line one\n  Line two`, "# Heading\nBody"),
      "/fake/skills/literal/SKILL.md",
    );
    expect(literal!.description).toContain("Line one");
    expect(literal!.description).toContain("Line two");
    expect(literal!.description.split("\n").length).toBeGreaterThanOrEqual(2);

    const stripped = parseSkillMarkdown(
      skillMd(`name: literalstrip\ndescription: |-\n  Line one\n  Line two`, "# Heading\nBody"),
      "/fake/skills/literalstrip/SKILL.md",
    );
    expect(stripped!.description.endsWith("\n")).toBe(false);
  });

  it("FRONT-8: 正文没有一级标题时技能仍然合法（prompt 取正文）", () => {
    const skill = parseSkillMarkdown(
      skillMd(`name: noheading\ndescription: No H1 heading in body.`, "Just body text without any heading."),
      "/fake/skills/noheading/SKILL.md",
    );
    // 修复前直接返回 null —— 整份 SKILL.md 被静默丢弃
    expect(skill).not.toBeNull();
    expect(skill!.prompt).toContain("Just body text without any heading.");
  });

  it("FRONT-9: 跨行标量之后的键仍能被解析（跳过已消费行）", () => {
    const skill = parseSkillMarkdown(
      skillMd(
        [
          "name: multiline",
          'description: "A description that spans',
          '  two source lines."',
          "whenToUse: when the task needs multiline parsing",
          "version: 2.1",
          "forcePreload: true",
        ].join("\n"),
        "# Heading\nBody",
      ),
      "/fake/skills/multiline/SKILL.md",
    );
    expect(skill!.description).toBe("A description that spans two source lines.");
    expect(skill!.whenToUse).toBe("when the task needs multiline parsing");
    expect(skill!.version).toBe("2.1");
    expect(skill!.forcePreload).toBe(true);
  });

  it("FRONT-10: 未知键（disable-model-invocation / metadata / license）不污染 name 与 description", () => {
    const skill = parseSkillMarkdown(AREX_VLLM_SKILL, "/fake/skills/vllm/SKILL.md");
    expect(skill!.name).toBe("vllm");
    expect(skill!.description).not.toContain("disable-model-invocation");
    expect(skill!.description).not.toContain("disco-role");
    expect(skill!.description).not.toContain("Apache 2.0");
  });

  it("FRONT-11: 块数组与嵌套对象解析未受多行标量改动影响", () => {
    const skill = parseSkillMarkdown(
      skillMd(
        [
          'name: arrays',
          'description: "Array and nested object regression."',
          "tags:",
          "  - alpha",
          "  - beta",
          "tags2: [x, y]",
          "provider:",
          "  module: ./provider.js",
          "  entry: run",
          "tools:",
          "  - name: my_tool",
          "    description: does a thing",
        ].join("\n"),
        "# Heading\nBody",
      ),
      "/fake/skills/arrays/SKILL.md",
    );
    expect(skill!.tags).toEqual(["alpha", "beta"]);
    expect(skill!.provider?.module).toBe("./provider.js");
    expect(skill!.tools?.[0]?.name).toBe("my_tool");
  });

  it("FRONT-12: 没有 frontmatter 的纯文本仍然不是技能", () => {
    expect(parseSkillMarkdown("not a valid skill", "/test/invalid.md")).toBeNull();
    // 有 frontmatter 但没有正文 → 依然非法
    expect(parseSkillMarkdown("---\nname: empty\ndescription: \"No body\"\n---\n", "/test/empty.md")).toBeNull();
  });
});

describe("AREX-Skill 目录布局集成", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codem-arex-"));
    const write = (rel: string, content: string) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    };

    write(
      "repo-skills-router/SKILL.md",
      skillMd(
        'name: "repo-skills-router"\ndescription: "Routes requests to managed repository skills."',
        "# Repo Skills Router\n\nOpen the selected root at `../repo-skills/<skill-id>/SKILL.md`.",
      ),
    );
    write("repo-skills-router/references/areas/llm-applications.md", "# LLM Applications\n");
    write("repo-skills/vllm/SKILL.md", AREX_VLLM_SKILL);
    write("repo-skills/vllm/sub-skills/openai-serving/SKILL.md", skillMd('name: "openai-serving"\ndescription: "Serving."', "# Serving\nSub-skill body text."));
    write("repo-skills/vllm/references/repo-provenance.md", "# Provenance\n");
    write("repo-skills/vllm/scripts/vllm_skill_doctor.py", "print('ok')\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** 复刻 installer.loadInstalledSkills 的发现规则：只认 skills 目录的直接子目录 */
  function loadableSkillNames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name, "SKILL.md"))
      .filter((p) => fs.existsSync(p))
      .map((p) => parseSkillMarkdown(fs.readFileSync(p, "utf8"), p))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => s.name)
      .sort();
  }

  it("AREX-1: 原样安装时只有 router 进入技能目录，repo 根技能保持按需读取", () => {
    expect(loadableSkillNames(root)).toEqual(["repo-skills-router"]);
  });

  it("AREX-2: router 里的相对路径能落到真实文件（渐进式展开可用）", () => {
    const routerDir = path.join(root, "repo-skills-router");
    expect(fs.existsSync(path.resolve(routerDir, "references/areas/llm-applications.md"))).toBe(true);
    expect(fs.existsSync(path.resolve(routerDir, "../repo-skills/vllm/SKILL.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(root, "repo-skills/vllm/sub-skills/openai-serving/SKILL.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "repo-skills/vllm/scripts/vllm_skill_doctor.py"))).toBe(true);
  });

  it("AREX-3: router 与子技能都能按 frontmatter 原名注册并被 load_skill 命中", () => {
    const registry = getSkillRegistry();
    const routerDir = path.join(root, "repo-skills-router");
    const router = parseSkillMarkdown(
      fs.readFileSync(path.join(routerDir, "SKILL.md"), "utf8"),
      path.join(routerDir, "SKILL.md"),
    );
    expect(router!.name).toBe("repo-skills-router");
    registry.register(router!);
    expect(registry.get("repo-skills-router")).toBeDefined();

    const subPath = path.join(root, "repo-skills/vllm/sub-skills/openai-serving/SKILL.md");
    const sub = parseSkillMarkdown(fs.readFileSync(subPath, "utf8"), subPath);
    expect(sub!.name).toBe("openai-serving");
    // prompt 从一级标题之后开始，一级标题本身不进 prompt
    expect(sub!.prompt).toContain("Sub-skill body text.");
    expect(sub!.prompt).not.toContain("# Serving");
  });

  it("AREX-4: 技能根目录成为 <skill_resources> 基准目录（相对路径可解析）", () => {
    const vllmPath = path.join(root, "repo-skills/vllm/SKILL.md");
    const vllm = parseSkillMarkdown(fs.readFileSync(vllmPath, "utf8"), vllmPath);
    // renderResourceHint 依赖 filePath 推导基准目录
    expect(vllm!.filePath).toBe(vllmPath);
    const baseDir = vllm!.filePath!.replace(/[/\\]SKILL\.md$/i, "");
    expect(fs.existsSync(path.join(baseDir, "references/repo-provenance.md"))).toBe(true);
  });
});
