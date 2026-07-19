/**
 * run-eval.ts — Skill eval runner.
 *
 * Runs a single eval case against a skill, recording outputs, timing, and metrics.
 * This is a standalone script that can be executed via `npx tsx` or compiled.
 *
 * Usage:
 *   npx tsx run-eval.ts --skill <path> --eval-id <id> --output <dir>
 *
 * IP 声明：本脚本为 Codem 项目原创，参考了通用 eval 框架模式。
 */

import * as fs from "fs";
import * as path from "path";

interface EvalCase {
  id: number;
  prompt: string;
  expected_output?: string;
  files?: string[];
  expectations?: string[];
}

interface EvalsFile {
  skill_name: string;
  evals: EvalCase[];
}

interface TimingData {
  total_tokens: number;
  duration_ms: number;
  total_duration_seconds: number;
}

interface MetricsData {
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  total_steps: number;
  files_created: string[];
  errors_encountered: number;
  output_chars: number;
}

/**
 * Load evals from a skill's evals/evals.json file.
 */
export function loadEvals(skillDir: string): EvalsFile {
  const evalsPath = path.join(skillDir, "evals", "evals.json");
  if (!fs.existsSync(evalsPath)) {
    throw new Error(`No evals.json found at ${evalsPath}`);
  }
  return JSON.parse(fs.readFileSync(evalsPath, "utf-8"));
}

/**
 * Get a single eval case by ID.
 */
export function getEvalCase(skillDir: string, evalId: number): EvalCase {
  const evals = loadEvals(skillDir);
  const evalCase = evals.evals.find((e) => e.id === evalId);
  if (!evalCase) {
    throw new Error(`Eval ID ${evalId} not found. Available: ${evals.evals.map((e) => e.id).join(", ")}`);
  }
  return evalCase;
}

/**
 * Save timing data to a run directory.
 */
export function saveTiming(runDir: string, timing: TimingData): void {
  fs.writeFileSync(path.join(runDir, "timing.json"), JSON.stringify(timing, null, 2));
}

/**
 * Save metrics data to an outputs directory.
 */
export function saveMetrics(outputsDir: string, metrics: MetricsData): void {
  fs.writeFileSync(path.join(outputsDir, "metrics.json"), JSON.stringify(metrics, null, 2));
}

/**
 * Save eval metadata to a run directory.
 */
export function saveEvalMetadata(runDir: string, evalCase: EvalCase, evalName: string): void {
  const metadata = {
    eval_id: evalCase.id,
    eval_name: evalName,
    prompt: evalCase.prompt,
    assertions: evalCase.expectations || [],
  };
  fs.writeFileSync(path.join(runDir, "eval_metadata.json"), JSON.stringify(metadata, null, 2));
}

/**
 * Validate a skill directory structure.
 * Returns an array of error messages (empty if valid).
 */
export function validateSkillStructure(skillDir: string): string[] {
  const errors: string[] = [];

  // Check SKILL.md exists
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    errors.push("SKILL.md not found");
  } else {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    // Check for YAML frontmatter
    if (!content.startsWith("---")) {
      errors.push("SKILL.md is missing YAML frontmatter");
    } else {
      // Extract frontmatter
      const endIdx = content.indexOf("---", 3);
      if (endIdx === -1) {
        errors.push("SKILL.md has unclosed YAML frontmatter");
      } else {
        const frontmatter = content.substring(3, endIdx);
        if (!frontmatter.includes("name:")) {
          errors.push("SKILL.md frontmatter is missing 'name' field");
        }
        if (!frontmatter.includes("description:")) {
          errors.push("SKILL.md frontmatter is missing 'description' field");
        }
      }
    }
  }

  return errors;
}

/**
 * Package a skill directory into a ZIP file.
 * Uses fflate (available in the project dependencies).
 */
export async function packageSkill(skillDir: string, outputPath: string): Promise<void> {
  const { zipSync, strToU8 } = await import("fflate");

  const files: Record<string, Uint8Array> = {};

  function walk(dir: string, base: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip node_modules and .git
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(fullPath, relPath);
      } else {
        const content = fs.readFileSync(fullPath);
        files[relPath] = content;
      }
    }
  }

  walk(skillDir);

  const zipped = zipSync(files);
  fs.writeFileSync(outputPath, zipped);
}

// ========== CLI Entry Point ==========

if (require.main === module) {
  const args = process.argv.slice(2);
  const skillIdx = args.indexOf("--skill");
  const evalIdx = args.indexOf("--eval-id");
  const outputIdx = args.indexOf("--output");

  if (skillIdx === -1 || evalIdx === -1 || outputIdx === -1) {
    console.error("Usage: npx tsx run-eval.ts --skill <path> --eval-id <id> --output <dir>");
    process.exit(1);
  }

  const skillDir = args[skillIdx + 1];
  const evalId = parseInt(args[evalIdx + 1], 10);
  const outputDir = args[outputIdx + 1];

  try {
    // Validate skill
    const errors = validateSkillStructure(skillDir);
    if (errors.length > 0) {
      console.error("Skill validation failed:");
      errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }

    // Load eval case
    const evalCase = getEvalCase(skillDir, evalId);

    // Create output directories
    const runDir = path.join(outputDir, `eval-${evalId}`);
    const outputsDir = path.join(runDir, "outputs");
    fs.mkdirSync(outputsDir, { recursive: true });

    // Save eval metadata
    const evalName = `eval-${evalId}`;
    saveEvalMetadata(runDir, evalCase, evalName);

    console.log(`Eval case loaded: ${evalCase.prompt}`);
    console.log(`Output directory: ${runDir}`);
    console.log(`\nTo run this eval, use the AI agent with the skill loaded and execute:`);
    console.log(`  "${evalCase.prompt}"`);
    console.log(`\nSave outputs to: ${outputsDir}`);
    console.log(`\nExpectations to check:`);
    (evalCase.expectations || []).forEach((e, i) => {
      console.log(`  ${i + 1}. ${e}`);
    });
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
