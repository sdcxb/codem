/**
 * package-skill.ts — Package a skill directory into a .zip file.
 *
 * Validates the skill structure first, then creates a ZIP archive
 * containing all files (excluding node_modules and .git).
 *
 * Usage:
 *   node package-skill.ts <path-to-skill-folder> [output.zip]   (Node ≥ 22.18)
 *   npx tsx package-skill.ts <path-to-skill-folder> [output.zip]
 *
 * 第 97 轮：本文件原来**无条件**在模块顶层调 `main()`（import 即执行），且兄弟 import 没有
 * `.ts` 后缀 ⇒ 原生 `node` 跑不起来。现在同样走 `is-main.ts` 的入口判定。
 *
 * IP 声明：本脚本为 Codem 项目原创。
 */

import * as fs from "fs";
import * as path from "path";
import { isMainModule } from "./is-main.ts";
import { validateSkill } from "./quick-validate.ts";

async function main() {
  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error("Usage: node package-skill.ts <path-to-skill-folder> [output.zip]");
    process.exit(1);
  }

  // Resolve absolute path
  const absSkillDir = path.resolve(skillDir);
  if (!fs.existsSync(absSkillDir)) {
    console.error(`Error: Directory not found: ${absSkillDir}`);
    process.exit(1);
  }

  // Validate skill structure
  const validation = validateSkill(absSkillDir);
  if (!validation.valid) {
    console.error("❌ Skill validation failed:");
    validation.errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    console.log("⚠️  Warnings:");
    validation.warnings.forEach((w) => console.log(`   - ${w}`));
  }

  console.log(`\nPackaging skill: ${validation.info.name || path.basename(absSkillDir)}`);

  // Determine output path
  const skillName = validation.info.name || path.basename(absSkillDir);
  const outputPath = process.argv[3] || path.join(process.cwd(), `${skillName}.zip`);

  // Collect all files
  const { zipSync } = await import("fflate");
  const files: Record<string, Uint8Array> = {};

  function walk(dir: string, base: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip unwanted directories
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store") continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const content = fs.readFileSync(fullPath);
        files[relPath] = content;
      }
    }
  }

  walk(absSkillDir);

  console.log(`Files to package: ${Object.keys(files).length}`);

  // Create ZIP
  const zipped = zipSync(files);
  fs.writeFileSync(outputPath, zipped);

  const sizeKB = (zipped.length / 1024).toFixed(1);
  console.log(`\n✅ Skill packaged: ${outputPath} (${sizeKB} KB)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
