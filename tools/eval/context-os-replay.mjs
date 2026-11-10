/**
 * 25 号文 P2：上下文 OS 的**纯函数回放**（`tools/eval/context-os-replay.mjs`）。
 *
 * ## 这是什么
 *
 * 把 `tools/eval/scenarios/*.jsonl` 里的场景逐条喂给**产品同一份实现**：
 * - `decideEpochAction`（段式决策，含 P2 自适应策略的 consider/hard）；
 * - `judgeDocumentSyncGate`（C06 文档同步硬闸的纯判定）；
 * - `planWorkingSet`（C03 最小工作集：移出最旧、marker 保护）。
 *
 * 输出 PASS/FAIL 与具体差异；`--check` 供 CI 用（任何一条失败 ⇒ 退出码 1）。
 *
 * ## 为什么不是「在脚本里再写一遍规则」
 *
 * 那样脚本与产品会各走一条路：产品改坏、脚本还是绿的（本仓把这种形态叫假证据）。
 * 这里用本地 **esbuild**（devDependency，不联网）把三个 `.ts` 模块当场打包成
 * 一个 ESM data URL 再 import —— 回放跑的就是产品代码本身。
 *
 * ## 场景格式（JSONL，一行一个用例）
 *
 * 公共字段：`id`（必填、文件内唯一）、`description`、`kind`、`expect`。
 *
 * ```jsonc
 * // kind=epoch：单次决策
 * { "kind": "epoch", "id": "...", "settings": { "threshold": 0.7, "hardThreshold": 0.9,
 *   "modelContextWindow": 128000, "observedAvgTurnTokens": 0 },
 *   "input": { "pressure": 0.75, "turnCompleted": false, "consecutiveCompactions": 0 },
 *   "expect": { "action": "compact", "reasonIncludes": "mid-turn" } }
 *
 * // kind=epoch-sequence：逐轮决策（例如 200 轮/3 段）
 * { "kind": "epoch-sequence", "id": "...", "settings": { ... },
 *   "turns": [ { "pressure": 0.11, "turnCompleted": true }, ... ],
 *   "expect": { "switches": 3, "switchTurns": [55, 110, 165] } }
 *
 * // kind=doc-gate：文档同步硬闸
 * { "kind": "doc-gate", "id": "...",
 *   "input": { "codeEdited": true, "versionedDocuments": 1,
 *     "changedDocuments": [ { "documentId": "d1", "name": "A.md", "updatedAt": 1, "sha256": "aa" } ],
 *     "unreadableDocuments": [], "blockedKeys": [], "blocksIssued": 0, "maxBlocks": 3 },
 *   "expect": { "verdict": "block", "newlyBlocked": ["d1@1:aa"] } }
 *
 * // kind=working-set：工作集计划（消息用显式 tokens，避免估算器差异）
 * { "kind": "working-set", "id": "...",
 *   "input": { "messages": [ { "id": "m1", "role": "user", "content": "…", "tokens": 10 } ],
 *     "budgetTokens": 100, "keepRecent": 2, "indexLineMax": 3, "protectedIds": ["compact-1"] },
 *   "expect": { "selectedIds": ["compact-1", "m4"], "evictedIds": ["m1", "m2"], "indexLines": 2 } }
 * ```
 *
 * ## 边界（诚实标注）
 *
 * - 只回放**纯函数**：不加载会话、不读数据库、不调模型、不联网；
 * - 场景里的 `tokens` 是**输入**（不是本脚本估的）—— 所以同一场景在哪台机器上都一样；
 * - 本脚本不进 knip 门面（`knip.json` 的 `project` 只含 `src/**`）；
 * - 场景与产品实现同源，但**不等于**真机验收：UI、存储、provider 不在回放范围内。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCENARIO_DIR = path.join(HERE, "scenarios");

/** 回放要用的产品导出（只列这三个纯函数；入口写死，避免脚本自己长规则）。 */
const PRODUCT_ENTRY = [
  'export { decideEpochAction } from "./src/core/context/segment-switch.ts";',
  'export { planWorkingSet } from "./src/core/context/working-set.ts";',
  'export { judgeDocumentSyncGate } from "./src/core/llm/document-sync-gate.ts";',
].join("\n");

/**
 * 用本地 esbuild 把三个纯函数模块打包后 import（等价于「跑产品同一份实现」）。
 *
 * @returns {Promise<{decideEpochAction: Function, planWorkingSet: Function, judgeDocumentSyncGate: Function}>}
 */
export async function loadProductCore(root = ROOT) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (e) {
    throw new Error(
      "回放需要本地 esbuild（devDependency，不联网）：先 npm install；" +
        `加载失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const built = await esbuild.build({
    stdin: { contents: PRODUCT_ENTRY, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  const code = built.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  for (const name of ["decideEpochAction", "planWorkingSet", "judgeDocumentSyncGate"]) {
    if (typeof mod[name] !== "function") {
      throw new Error(`产品入口缺少 ${name}（打包结果不完整）`);
    }
  }
  return mod;
}

/** 读一个 JSONL 场景文件；空行忽略，坏行直接报错（不静默跳过）。 */
export function readScenarioCases(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const cases = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`${path.relative(ROOT, filePath)}:${i + 1} 不是合法 JSON：${e.message}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${path.relative(ROOT, filePath)}:${i + 1} 必须是 JSON 对象`);
    }
    if (typeof parsed.id !== "string" || !parsed.id) {
      throw new Error(`${path.relative(ROOT, filePath)}:${i + 1} 缺少字符串 id`);
    }
    if (seen.has(parsed.id)) {
      throw new Error(`${path.relative(ROOT, filePath)}:${i + 1} id 重复：${parsed.id}`);
    }
    seen.add(parsed.id);
    cases.push(parsed);
  }
  return cases;
}

/** 默认场景文件：`tools/eval/scenarios/*.jsonl`，按文件名排序（输出稳定）。 */
export function defaultScenarioFiles() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(SCENARIO_DIR, name));
}

function fmt(value) {
  return JSON.stringify(value);
}

function pushDiff(diffs, label, expected, actual) {
  diffs.push(`${label}：期望 ${fmt(expected)}，实际 ${fmt(actual)}`);
}

/** 单条 `kind=epoch`。 */
function replayEpoch(core, testCase) {
  const settings = testCase.settings ?? {};
  const input = testCase.input ?? {};
  const actual = core.decideEpochAction({
    pressure: Number(input.pressure),
    turnCompleted: input.turnCompleted === true,
    consecutiveCompactions: Number(input.consecutiveCompactions ?? 0),
    threshold: settings.threshold,
    hardThreshold: settings.hardThreshold,
    modelContextWindow: settings.modelContextWindow,
    observedAvgTurnTokens: settings.observedAvgTurnTokens,
  });
  const expected = testCase.expect ?? {};
  const diffs = [];
  if (actual.action !== expected.action) pushDiff(diffs, "action", expected.action, actual.action);
  if (expected.reasonIncludes && !String(actual.reason).includes(expected.reasonIncludes)) {
    diffs.push(`reason 必须包含 ${fmt(expected.reasonIncludes)}，实际 ${fmt(actual.reason)}`);
  }
  return { diffs, actual: { action: actual.action, reason: actual.reason } };
}

/** `kind=epoch-sequence`：逐轮决策，按「第几轮发生 switch」对账。 */
function replayEpochSequence(core, testCase) {
  const settings = testCase.settings ?? {};
  const turns = Array.isArray(testCase.turns) ? testCase.turns : [];
  const expected = testCase.expect ?? {};
  const diffs = [];
  if (turns.length === 0) return { diffs: ["turns 为空（场景无效）"], actual: {} };
  const switchTurns = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i] ?? {};
    const decision = core.decideEpochAction({
      pressure: Number(turn.pressure),
      turnCompleted: turn.turnCompleted !== false,
      consecutiveCompactions: Number(turn.consecutiveCompactions ?? 0),
      threshold: settings.threshold,
      hardThreshold: settings.hardThreshold,
      modelContextWindow: settings.modelContextWindow,
      observedAvgTurnTokens: settings.observedAvgTurnTokens,
    });
    if (decision.action === "switch") switchTurns.push(i + 1);
  }
  const actual = { switches: switchTurns.length, switchTurns };
  if (actual.switches !== expected.switches) pushDiff(diffs, "switches", expected.switches, actual.switches);
  if (Array.isArray(expected.switchTurns) && fmt(actual.switchTurns) !== fmt(expected.switchTurns)) {
    pushDiff(diffs, "switchTurns", expected.switchTurns, actual.switchTurns);
  }
  return { diffs, actual };
}

/** `kind=doc-gate`：文档同步硬闸。 */
function replayDocGate(core, testCase) {
  const input = testCase.input ?? {};
  const actual = core.judgeDocumentSyncGate({
    codeEdited: input.codeEdited === true,
    versionedDocuments: Number(input.versionedDocuments ?? 0),
    changedDocuments: Array.isArray(input.changedDocuments) ? input.changedDocuments : [],
    unreadableDocuments: Array.isArray(input.unreadableDocuments) ? input.unreadableDocuments : [],
    blockedKeys: Array.isArray(input.blockedKeys) ? input.blockedKeys : [],
    blocksIssued: Number(input.blocksIssued ?? 0),
    maxBlocks: input.maxBlocks,
  });
  const expected = testCase.expect ?? {};
  const diffs = [];
  if (actual.verdict !== expected.verdict) pushDiff(diffs, "verdict", expected.verdict, actual.verdict);
  if (expected.reason !== undefined && actual.releaseReason !== expected.reason) {
    pushDiff(diffs, "releaseReason", expected.reason, actual.releaseReason);
  }
  if (Array.isArray(expected.keys) && fmt(actual.keys) !== fmt(expected.keys)) {
    pushDiff(diffs, "keys", expected.keys, actual.keys);
  }
  if (Array.isArray(expected.newlyBlocked) && fmt(actual.newlyBlocked) !== fmt(expected.newlyBlocked)) {
    pushDiff(diffs, "newlyBlocked", expected.newlyBlocked, actual.newlyBlocked);
  }
  return {
    diffs,
    actual: { verdict: actual.verdict, releaseReason: actual.releaseReason, keys: actual.keys, newlyBlocked: actual.newlyBlocked },
  };
}

/** `kind=working-set`：工作集计划（tokens 由场景显式给出）。 */
function replayWorkingSet(core, testCase) {
  const input = testCase.input ?? {};
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const expected = testCase.expect ?? {};
  const diffs = [];
  for (const message of messages) {
    if (!message || typeof message.id !== "string" || typeof message.tokens !== "number" || !Number.isFinite(message.tokens)) {
      return { diffs: [`消息 ${fmt(message)} 缺少合法 tokens（场景必须显式给数字）`], actual: {} };
    }
  }
  const plan = core.planWorkingSet({
    messages,
    budgetTokens: Number(input.budgetTokens ?? 0),
    estimate: (message) => message.tokens,
    keepRecent: input.keepRecent,
    indexLineMax: input.indexLineMax,
    protectedIds: new Set(Array.isArray(input.protectedIds) ? input.protectedIds : []),
  });
  const actual = {
    selectedIds: plan.selected.map((message) => message.id),
    evictedIds: plan.evicted.map((message) => message.id),
    indexLines: plan.indexLines.length,
    tokens: plan.tokens,
  };
  if (Array.isArray(expected.selectedIds) && fmt(actual.selectedIds) !== fmt(expected.selectedIds)) {
    pushDiff(diffs, "selectedIds", expected.selectedIds, actual.selectedIds);
  }
  if (Array.isArray(expected.evictedIds) && fmt(actual.evictedIds) !== fmt(expected.evictedIds)) {
    pushDiff(diffs, "evictedIds", expected.evictedIds, actual.evictedIds);
  }
  if (typeof expected.indexLines === "number" && actual.indexLines !== expected.indexLines) {
    pushDiff(diffs, "indexLines", expected.indexLines, actual.indexLines);
  }
  if (typeof expected.tokens === "number" && actual.tokens !== expected.tokens) {
    pushDiff(diffs, "tokens", expected.tokens, actual.tokens);
  }
  if (Array.isArray(expected.indexTextIncludes)) {
    const text = plan.indexLines.join("\n");
    for (const needle of expected.indexTextIncludes) {
      if (!text.includes(needle)) diffs.push(`indexLines 必须包含 ${fmt(needle)}，实际 ${fmt(text)}`);
    }
  }
  return { diffs, actual };
}

/**
 * 回放一条场景。返回 `{ id, kind, description, ok, diffs, expected, actual }`。
 *
 * 纯同步：测试可以直接给一个由 TS 产品函数组成的 `core`，与脚本用 esbuild 得到的那份对账。
 */
export function replayCase(core, testCase) {
  const kind = testCase.kind;
  const base = {
    id: testCase.id,
    kind,
    description: testCase.description ?? "",
    expected: testCase.expect ?? {},
  };
  let outcome;
  try {
    if (kind === "epoch") outcome = replayEpoch(core, testCase);
    else if (kind === "epoch-sequence") outcome = replayEpochSequence(core, testCase);
    else if (kind === "doc-gate") outcome = replayDocGate(core, testCase);
    else if (kind === "working-set") outcome = replayWorkingSet(core, testCase);
    else outcome = { diffs: [`未知 kind：${fmt(kind)}（支持 epoch / epoch-sequence / doc-gate / working-set）`], actual: {} };
  } catch (e) {
    outcome = { diffs: [`执行抛错：${e instanceof Error ? e.message : String(e)}`], actual: {} };
  }
  return { ...base, ...outcome, ok: outcome.diffs.length === 0 };
}

/** 回放一组场景。 */
export function replayCases(core, cases) {
  return cases.map((testCase) => replayCase(core, testCase));
}

function formatFailure(fileLabel, result) {
  const lines = [`FAIL ${fileLabel} / ${result.id}（${result.kind}）`];
  if (result.description) lines.push(`  场景：${result.description}`);
  for (const diff of result.diffs) lines.push(`  - ${diff}`);
  return lines.join("\n");
}

/**
 * CLI 入口。
 *
 * 用法：
 *   node tools/eval/context-os-replay.mjs                  # 跑全部场景，逐条打印
 *   node tools/eval/context-os-replay.mjs --check          # CI：只打失败 + 摘要
 *   node tools/eval/context-os-replay.mjs <file.jsonl> ... # 只跑指定场景
 */
export async function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes("--check");
  const fileArgs = argv.filter((arg) => !arg.startsWith("--"));
  const files = fileArgs.length > 0 ? fileArgs.map((arg) => path.resolve(process.cwd(), arg)) : defaultScenarioFiles();

  if (files.length === 0) {
    console.error(`❌ 没有场景文件（期望目录：${path.relative(ROOT, SCENARIO_DIR)}/*.jsonl）`);
    process.exitCode = 1;
    return;
  }

  let core;
  try {
    core = await loadProductCore();
  } catch (e) {
    console.error(`❌ 产品纯函数加载失败（回放不能静默跳过）：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  let total = 0;
  let failed = 0;
  const failedFiles = [];
  if (!checkOnly) {
    console.log(`上下文 OS 回放：${files.length} 个场景文件`);
  }
  for (const file of files) {
    const fileLabel = path.relative(ROOT, file).replace(/\\/g, "/");
    let cases;
    try {
      cases = readScenarioCases(file);
    } catch (e) {
      failed += 1;
      failedFiles.push(fileLabel);
      console.error(`FAIL ${fileLabel}：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (cases.length === 0) {
      failed += 1;
      failedFiles.push(fileLabel);
      console.error(`FAIL ${fileLabel}：文件里没有用例（空场景不算通过）`);
      continue;
    }
    total += cases.length;
    let fileFailed = 0;
    for (const result of replayCases(core, cases)) {
      if (result.ok) {
        if (!checkOnly) console.log(`PASS ${fileLabel} / ${result.id}（${result.kind}）`);
      } else {
        fileFailed += 1;
        failed += 1;
        console.error(formatFailure(fileLabel, result));
      }
    }
    if (fileFailed > 0) failedFiles.push(fileLabel);
  }

  const summary = `回放摘要：${total - failed} 通过 / ${failed} 失败（用例总数 ${total}，文件 ${files.length} 个）`;
  console.log(summary);
  if (failed > 0) {
    console.log(`❌ 失败文件：${failedFiles.join("、")}`);
    process.exitCode = 1;
  } else {
    console.log("✅ 全部场景与产品实现一致");
  }
}

/* 只有直接执行时才跑 CLI；被 vitest import 时只提供上面的纯函数。 */
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  await main();
}
