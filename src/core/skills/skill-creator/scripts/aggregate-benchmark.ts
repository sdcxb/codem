/**
 * aggregate-benchmark.ts — Aggregate eval results into a benchmark report.
 *
 * Reads all grading.json and timing.json files from an iteration directory
 * and produces benchmark.json and benchmark.md with pass rates, timing,
 * and token usage for each configuration (with_skill vs without_skill).
 *
 * Usage:
 *   npx tsx aggregate-benchmark.ts <workspace>/iteration-N --skill-name <name>
 *
 * IP 声明：本脚本为 Codem 项目原创，参考了通用 benchmark 聚合模式。
 */

import * as fs from "fs";
import * as path from "path";

interface GradingResult {
  expectations: Array<{ text: string; passed: boolean; evidence: string }>;
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
}

interface TimingData {
  total_tokens: number;
  duration_ms: number;
  total_duration_seconds: number;
}

interface RunResult {
  eval_id: number;
  eval_name: string;
  configuration: "with_skill" | "without_skill";
  run_number: number;
  result: {
    pass_rate: number;
    passed: number;
    failed: number;
    total: number;
    time_seconds: number;
    tokens: number;
    errors: number;
  };
  expectations: Array<{ text: string; passed: boolean; evidence: string }>;
}

interface Benchmark {
  metadata: {
    skill_name: string;
    timestamp: string;
    evals_run: number[];
    runs_per_configuration: number;
  };
  runs: RunResult[];
  run_summary: {
    with_skill: StatsSummary;
    without_skill: StatsSummary;
    delta: { pass_rate: string; time_seconds: string; tokens: string };
  };
  notes: string[];
}

interface StatsSummary {
  pass_rate: { mean: number; stddev: number; min: number; max: number };
  time_seconds: { mean: number; stddev: number; min: number; max: number };
  tokens: { mean: number; stddev: number; min: number; max: number };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function statsSummary(values: number[]): { mean: number; stddev: number; min: number; max: number } {
  return {
    mean: mean(values),
    stddev: stddev(values),
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
  };
}

function formatDelta(withSkill: number, withoutSkill: number): string {
  const delta = withSkill - withoutSkill;
  return delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
}

/**
 * Aggregate results from an iteration directory.
 */
export function aggregateBenchmark(iterationDir: string, skillName: string): Benchmark {
  const runs: RunResult[] = [];
  const evalIds = new Set<number>();

  // Find all eval directories
  const entries = fs.readdirSync(iterationDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const evalDir = path.join(iterationDir, entry.name);
    const metadataPath = path.join(evalDir, "eval_metadata.json");

    let evalId = 0;
    let evalName = entry.name;

    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      evalId = metadata.eval_id;
      evalName = metadata.eval_name || entry.name;
    }

    evalIds.add(evalId);

    // Look for configuration subdirectories
    for (const config of ["with_skill", "without_skill"] as const) {
      const configDir = path.join(evalDir, config);
      if (!fs.existsSync(configDir)) continue;

      const gradingPath = path.join(configDir, "grading.json");
      const timingPath = path.join(configDir, "timing.json");

      let passRate = 0;
      let passed = 0;
      let failed = 0;
      let total = 0;
      let expectations: Array<{ text: string; passed: boolean; evidence: string }> = [];
      let timeSeconds = 0;
      let tokens = 0;
      let errors = 0;

      if (fs.existsSync(gradingPath)) {
        const grading: GradingResult = JSON.parse(fs.readFileSync(gradingPath, "utf-8"));
        passRate = grading.summary?.pass_rate ?? 0;
        passed = grading.summary?.passed ?? 0;
        failed = grading.summary?.failed ?? 0;
        total = grading.summary?.total ?? 0;
        expectations = grading.expectations || [];
      }

      if (fs.existsSync(timingPath)) {
        const timing: TimingData = JSON.parse(fs.readFileSync(timingPath, "utf-8"));
        timeSeconds = timing.total_duration_seconds ?? 0;
        tokens = timing.total_tokens ?? 0;
      }

      runs.push({
        eval_id: evalId,
        eval_name: evalName,
        configuration: config,
        run_number: 1,
        result: {
          pass_rate: passRate,
          passed,
          failed,
          total,
          time_seconds: timeSeconds,
          tokens,
          errors,
        },
        expectations,
      });
    }
  }

  // Compute summary statistics
  const withSkillPassRates = runs.filter((r) => r.configuration === "with_skill").map((r) => r.result.pass_rate);
  const withoutSkillPassRates = runs.filter((r) => r.configuration === "without_skill").map((r) => r.result.pass_rate);
  const withSkillTimes = runs.filter((r) => r.configuration === "with_skill").map((r) => r.result.time_seconds);
  const withoutSkillTimes = runs.filter((r) => r.configuration === "without_skill").map((r) => r.result.time_seconds);
  const withSkillTokens = runs.filter((r) => r.configuration === "with_skill").map((r) => r.result.tokens);
  const withoutSkillTokens = runs.filter((r) => r.configuration === "without_skill").map((r) => r.result.tokens);

  const withSkillSummary: StatsSummary = {
    pass_rate: statsSummary(withSkillPassRates),
    time_seconds: statsSummary(withSkillTimes),
    tokens: statsSummary(withSkillTokens),
  };

  const withoutSkillSummary: StatsSummary = {
    pass_rate: statsSummary(withoutSkillPassRates),
    time_seconds: statsSummary(withoutSkillTimes),
    tokens: statsSummary(withoutSkillTokens),
  };

  // Generate notes
  const notes: string[] = [];
  const deltaPassRate = mean(withSkillPassRates) - mean(withoutSkillPassRates);
  if (deltaPassRate > 0) {
    notes.push(`Skill improves pass rate by ${(deltaPassRate * 100).toFixed(0)}%`);
  } else if (deltaPassRate < 0) {
    notes.push(`Skill decreases pass rate by ${Math.abs(deltaPassRate * 100).toFixed(0)}% — may need improvement`);
  }

  const deltaTime = mean(withSkillTimes) - mean(withoutSkillTimes);
  if (deltaTime > 0) {
    notes.push(`Skill adds ${deltaTime.toFixed(1)}s average execution time`);
  }

  // Check for non-discriminating assertions
  const allExpectations = runs.filter((r) => r.configuration === "with_skill").flatMap((r) => r.expectations);
  const allExpectationsWithout = runs.filter((r) => r.configuration === "without_skill").flatMap((r) => r.expectations);
  for (const exp of allExpectations) {
    const withoutMatch = allExpectationsWithout.find((e) => e.text === exp.text);
    if (withoutMatch && exp.passed && withoutMatch.passed) {
      notes.push(`Assertion "${exp.text.substring(0, 50)}..." passes in both configurations — may not discriminate skill value`);
    }
  }

  const benchmark: Benchmark = {
    metadata: {
      skill_name: skillName,
      timestamp: new Date().toISOString(),
      evals_run: Array.from(evalIds).sort((a, b) => a - b),
      runs_per_configuration: 1,
    },
    runs,
    run_summary: {
      with_skill: withSkillSummary,
      without_skill: withoutSkillSummary,
      delta: {
        pass_rate: formatDelta(mean(withSkillPassRates), mean(withoutSkillPassRates)),
        time_seconds: formatDelta(mean(withSkillTimes), mean(withoutSkillTimes)),
        tokens: formatDelta(mean(withSkillTokens), mean(withoutSkillTokens)),
      },
    },
    notes,
  };

  return benchmark;
}

/**
 * Generate a Markdown report from benchmark data.
 */
export function benchmarkToMarkdown(benchmark: Benchmark): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Report: ${benchmark.metadata.skill_name}`);
  lines.push(`\nGenerated: ${benchmark.metadata.timestamp}\n`);

  lines.push("## Summary\n");
  lines.push("| Metric | With Skill | Without Skill | Delta |");
  lines.push("|--------|-----------|--------------|-------|");
  lines.push(`| Pass Rate | ${(benchmark.run_summary.with_skill.pass_rate.mean * 100).toFixed(1)}% ± ${(benchmark.run_summary.with_skill.pass_rate.stddev * 100).toFixed(1)}% | ${(benchmark.run_summary.without_skill.pass_rate.mean * 100).toFixed(1)}% ± ${(benchmark.run_summary.without_skill.pass_rate.stddev * 100).toFixed(1)}% | ${benchmark.run_summary.delta.pass_rate} |`);
  lines.push(`| Time (s) | ${benchmark.run_summary.with_skill.time_seconds.mean.toFixed(1)} ± ${benchmark.run_summary.with_skill.time_seconds.stddev.toFixed(1)} | ${benchmark.run_summary.without_skill.time_seconds.mean.toFixed(1)} ± ${benchmark.run_summary.without_skill.time_seconds.stddev.toFixed(1)} | ${benchmark.run_summary.delta.time_seconds} |`);
  lines.push(`| Tokens | ${benchmark.run_summary.with_skill.tokens.mean.toFixed(0)} ± ${benchmark.run_summary.with_skill.tokens.stddev.toFixed(0)} | ${benchmark.run_summary.without_skill.tokens.mean.toFixed(0)} ± ${benchmark.run_summary.without_skill.tokens.stddev.toFixed(0)} | ${benchmark.run_summary.delta.tokens} |`);

  lines.push("\n## Per-Eval Results\n");
  lines.push("| Eval | Configuration | Pass Rate | Passed | Total | Time (s) | Tokens |");
  lines.push("|------|--------------|-----------|--------|-------|----------|--------|");
  for (const run of benchmark.runs) {
    lines.push(`| ${run.eval_name} | ${run.configuration} | ${(run.result.pass_rate * 100).toFixed(0)}% | ${run.result.passed} | ${run.result.total} | ${run.result.time_seconds.toFixed(1)} | ${run.result.tokens} |`);
  }

  if (benchmark.notes.length > 0) {
    lines.push("\n## Analysis Notes\n");
    for (const note of benchmark.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

// ========== CLI Entry Point ==========

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx aggregate-benchmark.ts <workspace>/iteration-N --skill-name <name>");
    process.exit(1);
  }

  const iterationDir = args[0];
  const skillNameIdx = args.indexOf("--skill-name");
  const skillName = skillNameIdx !== -1 ? args[skillNameIdx + 1] : "unknown-skill";

  try {
    const benchmark = aggregateBenchmark(iterationDir, skillName);

    // Write benchmark.json
    const jsonPath = path.join(iterationDir, "benchmark.json");
    fs.writeFileSync(jsonPath, JSON.stringify(benchmark, null, 2));
    console.log(`Benchmark JSON written to: ${jsonPath}`);

    // Write benchmark.md
    const mdPath = path.join(iterationDir, "benchmark.md");
    fs.writeFileSync(mdPath, benchmarkToMarkdown(benchmark));
    console.log(`Benchmark Markdown written to: ${mdPath}`);

    // Print summary
    console.log("\n" + benchmarkToMarkdown(benchmark));
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
