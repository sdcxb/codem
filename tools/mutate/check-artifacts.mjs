/**
 * 变异产物闸门（`MUTATE-ARTIFACT-1`，第 191 波新增）。
 *
 * ## 它守什么
 *
 * 本仓纪律「变异不做等于没测」有一个**可复核性**前提：变异的**脚本与结果都要在仓库里**。
 * 第 189 波的记忆变异只写在报告文本里（O-53 正是这条的反面教材）⇒ 下一轮无法复核。
 * 本闸门把「有没有、真不真、过没过期」变成机器条件：
 *
 * 1. `tools/mutate/registry.json` 里登记的每个波次，`tools/mutate/results/<wave>.json` **必须存在**；
 * 2. 结果里 `restored === true`（跑完变异后源码**逐字节还原**，且复原后判据全绿）；
 * 3. 结果里**每一条**变异 `ok === true`（期望红 ⇒ 实测红；期望绿 ⇒ 实测绿）——
 *    恒真的判据会在这里被点名；
 * 4. 规格指纹与结果一致（规格改过 ⇒ 旧结果作废，必须重跑）；
 * 5. 每条变异的**锚点**在当前源码里仍唯一命中（代码改动让锚点过期 ⇒ 必须重跑，
 *    而不是拿一份对不上今天代码的旧结果交差）。
 *
 * ## 两处消费方，同一份实现
 *
 * - 命令行：`node tools/mutate/check-artifacts.mjs`（`npm run audit:mutations`）
 * - 判据：`src/test/mutation-artifacts.test.ts` 直接 import `checkArtifacts()` ⇒
 *   「闸门说通过」与「判据说通过」不可能各说各话。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSpec, specFingerprint } from "./run.mjs";

const norm = (s) => s.replace(/\r\n/g, "\n");

/**
 * @param {string} root 仓库根（默认 process.cwd()）—— 判据用一个临时根跑**反向对照**，
 *   所以这里必须是**可注入**的，而不是 `process.chdir()`（见 `src/test/mutation-artifacts.test.ts`）。
 * @returns {Promise<{problems: string[], notes: string[], waves: string[]}>}
 */
export async function checkArtifacts(root = process.cwd()) {
  const REGISTRY = path.join(root, "tools", "mutate", "registry.json");
  const RESULTS_DIR = path.join(root, "tools", "mutate", "results");
  const problems = [];
  const notes = [];
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const waves = registry.waves ?? [];
  if (waves.length === 0) problems.push("registry.json 里一个波次都没有登记 —— 那这道闸门等于不存在");

  for (const wave of waves) {
    const resultFile = path.join(RESULTS_DIR, `${wave}.json`);
    if (!existsSync(resultFile)) {
      problems.push(`${wave}：没有结果文件（${path.relative(root, resultFile)}）⇒ 跑 node tools/mutate/run.mjs ${wave}`);
      continue;
    }
    let spec;
    try {
      spec = await loadSpec(wave, root);
    } catch (e) {
      problems.push(`${wave}：规格读不出来（${e}）`);
      continue;
    }
    const result = JSON.parse(readFileSync(resultFile, "utf8"));

    if (result.restored !== true) {
      problems.push(`${wave}：结果里 restored !== true（源码可能没还原干净，或复原后判据没全绿）`);
    }
    const fp = specFingerprint(spec);
    if (result.specFingerprint !== fp) {
      problems.push(`${wave}：规格指纹对不上（规格改过 ⇒ 旧结果作废）⇒ 重跑 node tools/mutate/run.mjs ${wave}`);
    }
    const results = result.results ?? [];
    if (results.length !== (spec.mutations ?? []).length) {
      problems.push(`${wave}：结果条数 ${results.length} ≠ 规格条数 ${(spec.mutations ?? []).length} ⇒ 重跑`);
    }
    for (const r of results) {
      if (r.ok !== true) {
        problems.push(`${wave} / ${r.id}：期望红=${r.expectedRed} 实测红=${r.observedRed}（判据可能是恒真的）`);
      }
      if (r.error) problems.push(`${wave} / ${r.id}：执行失败 —— ${r.error}`);
    }
    // 锚点不许过期
    const seen = new Set();
    for (const m of spec.mutations ?? []) {
      for (const p of m.patches ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (!existsSync(path.join(root, p.file))) {
          problems.push(`${wave} / ${m.id}：锚点文件不存在 ${p.file}`);
          continue;
        }
        const hay = norm(readFileSync(path.join(root, p.file), "utf8"));
        const count = hay.split(norm(p.from)).length - 1;
        if (count !== 1) {
          problems.push(
            `${wave} / ${m.id}：锚点在 ${p.file} 里命中 ${count} 次（应为 1）⇒ 代码已变，重跑 node tools/mutate/run.mjs ${wave}`,
          );
        }
      }
    }
    notes.push(`${wave}：${results.length} 条变异全红、restored=true、锚点未过期 ✓`);
  }
  return { problems, notes, waves };
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  const { problems, notes, waves } = await checkArtifacts();
  console.log("=== 变异产物闸门（MUTATE-ARTIFACT-1）===");
  for (const n of notes) console.log(`  ✓ ${n}`);
  if (problems.length > 0) {
    console.log("\n❌ 不通过：");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`\n分诊闸门通过：登记波次 ${waves.length} 个，全部有可用且未过期的变异证据。`);
  }
}
