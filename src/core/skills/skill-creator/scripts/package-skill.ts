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
import { isMainModule, fail } from "./is-main.ts";
import { validateSkill } from "./quick-validate.ts";
/**
 * 字节数 → 人读形态。
 *
 * ⚠️ 为什么这里自带一份而**不** import `src/core/utils/bytes.ts`：本文件会被
 * `SkillInstaller` 整份复制进技能目录（`~/.codem/skills/<name>/scripts/`），那里没有应用源码树
 * ⇒ 相对 import 必然 `ERR_MODULE_NOT_FOUND`（第 191 波第一版就是这么把真机脚本弄崩的，
 * 判据 `skill-creator-scripts.test.ts` 的 CLI-1 当场抓到）。口径由
 * `bytes-single-source.test.ts` 的 `BYTES-3` 与共享实现逐字对齐。
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function main() {
  const skillDir = process.argv[2];
  if (!skillDir) {
    fail("Usage: node package-skill.ts <path-to-skill-folder> [output.zip]");
    return;
  }

  // Resolve absolute path
  const absSkillDir = path.resolve(skillDir);
  if (!fs.existsSync(absSkillDir)) {
    fail(`Error: Directory not found: ${absSkillDir}`);
    return;
  }

  // Validate skill structure
  const validation = validateSkill(absSkillDir);
  if (!validation.valid) {
    console.error("❌ Skill validation failed:");
    validation.errors.forEach((e) => console.error(`   - ${e}`));
    // ⚠️ 用 exitCode + return 而不是 process.exit(1)：见 is-main.ts 的 fail() 说明
    process.exitCode = 1;
    return;
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

  // 第 191 波：字节数的人读形态走全仓**唯一**实现（原来这里自己写了一份无空格口径）
  console.log(`\n✅ Skill packaged: ${outputPath} (${formatBytes(zipped.length)})`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    fail(`Error: ${err.message}`);
  });
}
