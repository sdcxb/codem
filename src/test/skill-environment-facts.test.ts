/**
 * **技能环境事实 + 装完即可见** 的判据（第 47 波 ✓）。
 *
 * 缘起（用户实报 ✓）：让模型装一个 GitHub 上的技能时，它**分析安装目录与安装方式很久**，
 *   还要去翻别的技能**反推** ✗。查实三处根因 ✓：
 *   ① 模型可见的唯一说法是 `skill-creator/SKILL.md` 里的 `~/.codem/skills` ✗ ——
 *      **实现用的是 `<appData>/.codem/skills`** ✓（Windows 真值：
 *      `C:\Users\<u>\AppData\Roaming\com.codem.app\.codem\skills` ✓）⇒ 写进去平台也发现不了 ✗
 *   ② 一个技能都没有时 `buildSkillPrompt()` 返回空串 ✗ ⇒ 恰恰在"装第一个技能"时零环境事实 ✗
 *   ③ `loadInstalledSkills()` 只在启动时跑 ✗ ⇒ 对话中刚装好的技能 `load_skill` 找不到 ✗
 * 本文件钉住修好后的三条 ✓（外加"错路径不许回归" ✓）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSkillRegistry } from "../core/skill/skill";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("技能环境事实（第 47 波 ✓）", () => {
  it("ENV-1 ★ 提示词里出现**运行时真值**的技能根（不是写死的 ~/ ✗）", () => {
    const reg = getSkillRegistry();
    const FAKE = "C:\\Users\\probe\\AppData\\Roaming\\com.codem.app\\.codem\\skills";
    reg.setSkillRootsForPrompt({ user: FAKE });
    const env = reg.buildSkillEnvironmentSection();
    expect(env, "必须给出本机真值").toContain(FAKE);
    expect(env, "★ 不许再出现写死的家目录写法").not.toContain("$HOME/.codem/skills");
  });

  it("ENV-2 ★ 环境段**与技能数量无关** ⇒ 一个技能都没有时也在 ✓（用户场景）", () => {
    const reg = getSkillRegistry();
    const composed = reg.buildSkillEnvironmentSection() + reg.buildSkillPrompt();
    expect(composed, "布局要说清").toContain("<根>/<技能名>/SKILL.md");
    expect(composed, "发现是自动的要说清").toMatch(/发现是自动的|no registration|没有注册步骤/);
    expect(composed, "要给出从仓库安装的步骤").toMatch(/从仓库\/URL 安装/);
    expect(composed, "要有验证步骤").toMatch(/验证/);
    expect(composed, "要提醒别把技能装成同名目录").toMatch(/名为 `SKILL\.md` 的目录/);
  });

  it("ENV-3 `buildSkillPrompt()` 自身输出**未被改动** ✓（既有 30+ 条判据的前提 ✓）", () => {
    const reg = getSkillRegistry();
    const p = reg.buildSkillPrompt();
    // 无技能时它仍是空串 ✓（环境段由调用点前置 ✓，不在这里 ✗）
    if (reg.getAll().filter((s) => s.enabled !== false).length === 0) {
      expect(p, "无技能 ⇒ 仍是空串（契约不变 ✓）").toBe("");
    }
    expect(reg.buildSkillEnvironmentSection(), "环境段是独立方法 ✓").not.toBe("");
  });
});

describe("装完即可见（对标 DSH 的「无需重启」✓）", () => {
  it("WIRE-1 `load_skill` 未命中时会**重扫技能根** ✓（否则对话中装的技能永远找不到 ✗）", () => {
    const src = read("src/core/llm/tools/load-skill.ts");
    expect(src, "必须调用 loadInstalledSkills").toContain("loadInstalledSkills");
    expect(src, "必须在「未找到」之后才重扫（命中路径零成本 ✓）").toMatch(
      /loadSkillFromFilesystem\(skillName\)[\s\S]{0,900}?loadInstalledSkills\(\)/,
    );
    expect(src, "重扫失败不许抛错 ✓").toMatch(/重扫失败（不影响本次查找结论）/);
  });

  it("WIRE-2 提示词组装点前置了环境段 ✓（两个调用点都要有 ✓）", () => {
    const src = read("src/core/llm/index.ts");
    const hits = (src.match(/buildSkillEnvironmentSection\(\) \+ this\.skills\.buildSkillPrompt\(/g) || []).length;
    expect(hits, "两个组装点都要前置（否则有一条路径拿不到事实 ✗）").toBe(2);
  });

  it("WIRE-3 真值由 `loadInstalledSkills()` 灌入 ✓（扫目录**之前** ✓）", () => {
    const src = read("src/core/skill/installer.ts");
    expect(src).toContain("setSkillRootsForPrompt({ user: skillsDir })");
    const iSet = src.indexOf("setSkillRootsForPrompt({ user: skillsDir })");
    const iScan = src.indexOf("const entries = await listDirectory(skillsDir)");
    expect(iSet, "必须先灌真值再扫（顺序要紧 ✓）").toBeLessThan(iScan);
  });
});

describe("错路径不许回归（文档与实现不一致的那个 bug ✗）", () => {
  it("DOC-1 `skill-creator/SKILL.md` 里不再有写死的 `$HOME/.codem/skills` ✗", () => {
    const doc = read("src/core/skills/skill-creator/SKILL.md");
    expect(doc, "★ 写死的家目录路径会把技能装到平台看不见的地方 ✗").not.toContain("$HOME/.codem/skills");
    expect(doc, "要指向提示词里的运行时真值").toContain("SKILLS_DIR=");
  });

  it("DOC-2 `skill.ts` 内嵌的同一份说明也修了 ✓", () => {
    const src = read("src/core/skill/skill.ts");
    expect(src, "内嵌副本同样不许写死 ✗").not.toContain("$HOME/.codem/skills");
    expect(src, "要给出运行时真值的取法 ✓").toContain("SKILLS_DIR=");
  });
});
