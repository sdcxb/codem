/**
 * generate-review.ts — Generate a standalone HTML review page for eval results.
 *
 * Reads benchmark.json and eval outputs from an iteration directory,
 * produces a self-contained HTML file for the user to review results.
 *
 * Usage:
 *   npx tsx generate-review.ts <workspace>/iteration-N --skill-name <name> [--static <output.html>]
 *
 * IP 声明：本脚本为 Codem 项目原创，参考了通用 eval viewer 模式。
 */

import * as fs from "fs";
import * as path from "path";
import { aggregateBenchmark, benchmarkToMarkdown } from "./aggregate-benchmark";

interface ReviewData {
  skillName: string;
  iteration: number;
  benchmark: any;
  evals: Array<{
    id: number;
    name: string;
    prompt: string;
    withSkillOutput?: string;
    withoutSkillOutput?: string;
    grading?: any;
  }>;
}

/**
 * Load review data from an iteration directory.
 */
function loadReviewData(iterationDir: string, skillName: string): ReviewData {
  const evals: ReviewData["evals"] = [];

  // Try to load existing benchmark.json, or generate it
  let benchmark: any;
  const benchmarkPath = path.join(iterationDir, "benchmark.json");
  if (fs.existsSync(benchmarkPath)) {
    benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf-8"));
  } else {
    benchmark = aggregateBenchmark(iterationDir, skillName);
  }

  // Load eval data
  const entries = fs.readdirSync(iterationDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const evalDir = path.join(iterationDir, entry.name);
    const metadataPath = path.join(evalDir, "eval_metadata.json");

    let evalId = 0;
    let evalName = entry.name;
    let prompt = "";

    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      evalId = metadata.eval_id;
      evalName = metadata.eval_name || entry.name;
      prompt = metadata.prompt || "";
    }

    const evalData: ReviewData["evals"][0] = { id: evalId, name: evalName, prompt };

    // Load with_skill output
    const withSkillDir = path.join(evalDir, "with_skill", "outputs");
    if (fs.existsSync(withSkillDir)) {
      const files = fs.readdirSync(withSkillDir);
      if (files.length > 0) {
        const firstFile = files[0];
        const content = fs.readFileSync(path.join(withSkillDir, firstFile), "utf-8");
        evalData.withSkillOutput = content.substring(0, 5000); // Limit size
      }
    }

    // Load without_skill output
    const withoutSkillDir = path.join(evalDir, "without_skill", "outputs");
    if (fs.existsSync(withoutSkillDir)) {
      const files = fs.readdirSync(withoutSkillDir);
      if (files.length > 0) {
        const firstFile = files[0];
        const content = fs.readFileSync(path.join(withoutSkillDir, firstFile), "utf-8");
        evalData.withoutSkillOutput = content.substring(0, 5000);
      }
    }

    // Load grading
    const gradingPath = path.join(evalDir, "with_skill", "grading.json");
    if (fs.existsSync(gradingPath)) {
      evalData.grading = JSON.parse(fs.readFileSync(gradingPath, "utf-8"));
    }

    evals.push(evalData);
  }

  return {
    skillName,
    iteration: 1, // Default
    benchmark,
    evals,
  };
}

/**
 * Generate HTML review page.
 */
export function generateReviewHtml(data: ReviewData): string {
  const md = benchmarkToMarkdown(data.benchmark);

  const evalsHtml = data.evals
    .map((evalItem) => {
      const gradingHtml = evalItem.grading
        ? `<div class="grading">
            <h4>Grading (Pass Rate: ${(evalItem.grading.summary?.pass_rate * 100 || 0).toFixed(0)}%)</h4>
            ${(evalItem.grading.expectations || [])
              .map(
                (exp: any) =>
                  `<div class="expectation ${exp.passed ? "pass" : "fail"}">
                    <span class="badge">${exp.passed ? "✓ PASS" : "✗ FAIL"}</span>
                    <span class="text">${exp.text}</span>
                  </div>`,
              )
              .join("")}
          </div>`
        : "";

      return `<div class="eval-card">
        <h3>${evalItem.name}</h3>
        <div class="prompt"><strong>Prompt:</strong> ${evalItem.prompt}</div>
        ${evalItem.withSkillOutput ? `<div class="output"><h4>With Skill Output</h4><pre>${evalItem.withSkillOutput}</pre></div>` : ""}
        ${evalItem.withoutSkillOutput ? `<div class="output"><h4>Without Skill Output</h4><pre>${evalItem.withoutSkillOutput}</pre></div>` : ""}
        ${gradingHtml}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skill Eval Review: ${data.skillName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
    h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 10px; }
    h2 { color: #58a6ff; margin-top: 30px; }
    h3 { color: #f0f6fc; margin-top: 20px; }
    h4 { color: #8b949e; margin-top: 15px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .eval-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .prompt { background: #21262d; padding: 10px; border-radius: 6px; margin: 10px 0; }
    .output { margin: 10px 0; }
    pre { background: #0d1117; border: 1px solid #30363d; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
    .grading { margin: 10px 0; }
    .expectation { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .pass { color: #3fb950; }
    .fail { color: #f85149; }
    .badge:has(span) { }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    th, td { border: 1px solid #30363d; padding: 8px 12px; text-align: left; }
    th { background: #21262d; color: #8b949e; }
    .notes { background: #161b22; border-left: 3px solid #58a6ff; padding: 10px 15px; margin: 10px 0; }
    .notes ul { margin: 5px 0; }
    .feedback-box { margin: 20px 0; }
    textarea { width: 100%; min-height: 80px; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 10px; border-radius: 6px; font-family: inherit; }
    button { background: #238636; color: white; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    button:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Skill Eval Review: ${data.skillName}</h1>
    
    <h2>Benchmark Summary</h2>
    <table>
      <tr><th>Metric</th><th>With Skill</th><th>Without Skill</th><th>Delta</th></tr>
      <tr><td>Pass Rate</td><td>${(data.benchmark.run_summary?.with_skill?.pass_rate?.mean * 100 || 0).toFixed(1)}%</td><td>${(data.benchmark.run_summary?.without_skill?.pass_rate?.mean * 100 || 0).toFixed(1)}%</td><td>${data.benchmark.run_summary?.delta?.pass_rate || "N/A"}</td></tr>
      <tr><td>Time (s)</td><td>${(data.benchmark.run_summary?.with_skill?.time_seconds?.mean || 0).toFixed(1)}</td><td>${(data.benchmark.run_summary?.without_skill?.time_seconds?.mean || 0).toFixed(1)}</td><td>${data.benchmark.run_summary?.delta?.time_seconds || "N/A"}</td></tr>
      <tr><td>Tokens</td><td>${(data.benchmark.run_summary?.with_skill?.tokens?.mean || 0).toFixed(0)}</td><td>${(data.benchmark.run_summary?.without_skill?.tokens?.mean || 0).toFixed(0)}</td><td>${data.benchmark.run_summary?.delta?.tokens || "N/A"}</td></tr>
    </table>

    ${data.benchmark.notes?.length > 0 ? `<div class="notes"><strong>Analysis Notes:</strong><ul>${data.benchmark.notes.map((n: string) => `<li>${n}</li>`).join("")}</ul></div>` : ""}

    <h2>Eval Outputs (${data.evals.length})</h2>
    ${evalsHtml || "<p>No eval outputs found.</p>"}

    <div class="feedback-box">
      <h2>Feedback</h2>
      <p>Leave feedback for each eval above. Empty feedback means it looks good.</p>
      <textarea id="feedback" placeholder="Overall feedback..."></textarea>
      <br><br>
      <button onclick="downloadFeedback()">Submit All Reviews</button>
    </div>
  </div>

  <script>
    function downloadFeedback() {
      const feedback = document.getElementById('feedback').value;
      const data = {
        reviews: [{ run_id: 'overall', feedback: feedback, timestamp: new Date().toISOString() }],
        status: 'complete'
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'feedback.json';
      a.click();
      URL.revokeObjectURL(url);
      alert('Feedback downloaded as feedback.json');
    }
  </script>
</body>
</html>`;
}

// ========== CLI Entry Point ==========

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx generate-review.ts <workspace>/iteration-N --skill-name <name> [--static <output.html>]");
    process.exit(1);
  }

  const iterationDir = args[0];
  const skillNameIdx = args.indexOf("--skill-name");
  const skillName = skillNameIdx !== -1 ? args[skillNameIdx + 1] : "unknown-skill";
  const staticIdx = args.indexOf("--static");
  const staticOutput = staticIdx !== -1 ? args[staticIdx + 1] : null;

  try {
    const data = loadReviewData(iterationDir, skillName);
    const html = generateReviewHtml(data);

    if (staticOutput) {
      fs.writeFileSync(staticOutput, html);
      console.log(`Review HTML written to: ${staticOutput}`);
    } else {
      // Try to open in browser
      const tmpFile = path.join(require("os").tmpdir(), `skill-review-${Date.now()}.html`);
      fs.writeFileSync(tmpFile, html);
      console.log(`Review HTML written to: ${tmpFile}`);
      // Open in default browser
      const { exec } = require("child_process");
      const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
      exec(`${openCmd} "${tmpFile}"`);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
