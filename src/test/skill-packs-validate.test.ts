/**
 * P2-7：技能包校验器（`tools/audit/check-skill-packs.mjs`）的判据。
 *
 * 校验器本身是一个**门禁脚本**，但它必须自己也被判据钉住 —— 否则"改坏校验器"
 * 只会让门禁更宽松，而没人发现。这里用真实目录 + 一组故意坏的夹具两侧夹住它：
 *
 * | 夹具 | 期望 |
 * | --- | --- |
 * | 规整的技能 | 0 错误 |
 * | 缺 description | 报错（没有描述 ⇒ 技能永远不会被触发） |
 * | name 与目录不一致 | 报错 |
 * | 带 BOM | 报错（`no-bom.test.ts` 同一纪律） |
 * | 没有 frontmatter | 报错 |
 * | description 超 1024 字 | 报错（与运行时 `clampSkillDescription` 同一条预算） |
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanSkillPacks,
  DESCRIPTION_LIMIT,
} from "../../tools/audit/check-skill-packs.mjs";

const REPO_SKILLS = path.join(__dirname, "..", "core", "skills");
const tmpRoots: string[] = [];

function makeFixture(skills: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codem-skill-pack-"));
  tmpRoots.push(root);
  for (const [id, content] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "SKILL.md"), content);
  }
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("P2-7 技能包校验器", () => {
  it("仓库自带的技能目录：0 错误，且每个 description 都在预算内", () => {
    const result = scanSkillPacks(REPO_SKILLS);
    expect(result.errors, `仓库技能包不该有错误：\n${result.errors.join("\n")}`).toEqual([]);
    expect(result.skills.length).toBeGreaterThanOrEqual(11);
    for (const skill of result.skills) {
      expect(skill.descriptionChars).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    }
  });

  it("缺 description / name 不一致 / 无 frontmatter / 带 BOM / 超预算 都会被报出来", () => {
    const root = makeFixture({
      "good-skill": "---\nname: good-skill\ndescription: A valid skill.\n---\n\n# Body\n",
      "no-description": "---\nname: no-description\n---\n\n# Body\n",
      "wrong-name": "---\nname: something-else\ndescription: Name does not match.\n---\n",
      "no-frontmatter": "# Just markdown, no frontmatter\n",
      "bom-skill": Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("---\nname: bom-skill\ndescription: Has a BOM.\n---\n"),
      ]),
      "too-long": `---\nname: too-long\ndescription: ${"x".repeat(DESCRIPTION_LIMIT + 1)}\n---\n`,
    });

    const result = scanSkillPacks(root);
    const joined = result.errors.join("\n");
    expect(joined).toMatch(/no-description.*缺 description/u);
    expect(joined).toMatch(/wrong-name.*不一致/u);
    expect(joined).toMatch(/no-frontmatter.*frontmatter/u);
    expect(joined).toMatch(/bom-skill.*BOM/u);
    expect(joined).toMatch(/too-long.*超过预算/u);
    // 规整的那个不该被误报
    expect(joined).not.toMatch(/good-skill/u);
  });

  it("description 偏长只警告、不阻塞（软预算）", () => {
    const root = makeFixture({
      "soft-long": `---\nname: soft-long\ndescription: ${"y".repeat(500)}\n---\n`,
    });
    const result = scanSkillPacks(root);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/soft-long.*偏长/u);
  });
});
