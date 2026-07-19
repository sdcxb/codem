/**
 * quick-validate.ts — Quick validation of a skill directory.
 *
 * Checks:
 * - SKILL.md exists and has valid frontmatter
 * - name and description fields are present
 * - prompt body is non-empty
 * - No obvious issues (missing references, oversized files)
 *
 * Usage:
 *   npx tsx quick-validate.ts <path-to-skill>
 *
 * IP 声明：本脚本为 Codem 项目原创。
 */

import * as fs from "fs";
import * as path from "path";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: {
    name?: string;
    description?: string;
    hasPrompt: boolean;
    promptLines: number;
    hasScripts: boolean;
    hasReferences: boolean;
    hasAssets: boolean;
    totalFiles: number;
    totalSize: number;
  };
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return result;

  const frontmatter = content.substring(3, endIdx);

  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

/**
 * Validate a skill directory.
 */
export function validateSkill(skillDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: any = {
    hasPrompt: false,
    promptLines: 0,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
    totalFiles: 0,
    totalSize: 0,
  };

  // Check SKILL.md
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    errors.push("SKILL.md not found — this is required");
    return { valid: false, errors, warnings, info };
  }

  const content = fs.readFileSync(skillMdPath, "utf-8");
  info.totalFiles = 1;
  info.totalSize = content.length;

  // Check frontmatter
  if (!content.startsWith("---")) {
    errors.push("SKILL.md is missing YAML frontmatter (must start with ---)");
  } else {
    const endIdx = content.indexOf("---", 3);
    if (endIdx === -1) {
      errors.push("SKILL.md has unclosed YAML frontmatter (missing closing ---)");
    } else {
      const frontmatter = parseFrontmatter(content);

      if (!frontmatter.name) {
        errors.push("Frontmatter is missing 'name' field");
      } else {
        info.name = frontmatter.name;
        // Check name format (kebab-case)
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(frontmatter.name)) {
          warnings.push(`Skill name "${frontmatter.name}" is not in kebab-case format`);
        }
      }

      if (!frontmatter.description) {
        errors.push("Frontmatter is missing 'description' field");
      } else {
        info.description = frontmatter.description;
        // Warn if description is too short
        if (frontmatter.description.length < 20) {
          warnings.push("Description is very short — consider adding more context for better triggering");
        }
      }

      if (frontmatter.version && !/^\d+\.\d+\.\d+$/.test(frontmatter.version)) {
        warnings.push(`Version "${frontmatter.version}" is not in semver format (e.g. "1.0.0")`);
      }
    }
  }

  // Check prompt body
  const bodyStart = content.indexOf("---", 3);
  if (bodyStart !== -1) {
    const body = content.substring(bodyStart + 3).trim();
    if (body.length === 0) {
      errors.push("SKILL.md has empty body — prompt instructions are required");
    } else {
      info.hasPrompt = true;
      info.promptLines = body.split("\n").length;
      if (info.promptLines > 500) {
        warnings.push(`SKILL.md body is ${info.promptLines} lines — consider keeping under 500 lines`);
      }
    }
  }

  // Check for bundled resources
  const scriptsDir = path.join(skillDir, "scripts");
  const referencesDir = path.join(skillDir, "references");
  const assetsDir = path.join(skillDir, "assets");

  info.hasScripts = fs.existsSync(scriptsDir);
  info.hasReferences = fs.existsSync(referencesDir);
  info.hasAssets = fs.existsSync(assetsDir);

  // Count files and size
  function countFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        countFiles(path.join(dir, entry.name));
      } else {
        info.totalFiles++;
        info.totalSize += fs.statSync(path.join(dir, entry.name)).size;
      }
    }
  }

  countFiles(scriptsDir);
  countFiles(referencesDir);
  countFiles(assetsDir);

  // Warn on large total size
  if (info.totalSize > 1_000_000) {
    warnings.push(`Total skill size is ${(info.totalSize / 1_000_000).toFixed(1)}MB — consider keeping under 1MB`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  };
}

// ========== CLI Entry Point ==========

if (require.main === module) {
  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error("Usage: npx tsx quick-validate.ts <path-to-skill>");
    process.exit(1);
  }

  const result = validateSkill(skillDir);

  if (result.info.name) {
    console.log(`\nSkill: ${result.info.name}`);
  }
  if (result.info.description) {
    console.log(`Description: ${result.info.description.substring(0, 80)}${result.info.description.length > 80 ? "..." : ""}`);
  }
  console.log(`Files: ${result.info.totalFiles}, Size: ${(result.info.totalSize / 1024).toFixed(1)}KB`);
  console.log(`Prompt: ${result.info.promptLines} lines`);
  console.log(`Resources: scripts=${result.info.hasScripts}, references=${result.info.hasReferences}, assets=${result.info.hasAssets}`);

  if (result.errors.length > 0) {
    console.log("\n❌ Errors:");
    result.errors.forEach((e) => console.log(`   - ${e}`));
  }

  if (result.warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    result.warnings.forEach((w) => console.log(`   - ${w}`));
  }

  if (result.valid && result.warnings.length === 0) {
    console.log("\n✅ Skill is valid with no warnings.");
  } else if (result.valid) {
    console.log("\n✅ Skill is valid (with warnings).");
  } else {
    console.log("\n❌ Skill validation failed.");
    process.exit(1);
  }
}
