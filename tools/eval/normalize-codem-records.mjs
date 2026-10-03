/**
 * **Codem 臂记录 → 成对比较记录**的规范化（第 106 波）。
 *
 * ## 为什么需要这一层
 *
 * 两个臂的记录是**两套驱动**写出来的，字段形状不同：
 *
 * | 指标 | 对照臂（DSH，`dsh-driver.mjs`） | Codem 臂（`_codem-repo-eval.mjs`） |
 * |---|---|---|
 * | 臂名 | `arm: "control"` | `agent: "codem-app"` |
 * | 模型 | `model`（驱动写的） | 现在也写（第 106 波补的） |
 * | 总 token | `totalTokens`（各 step 求和） | `usage.totalTokens` |
 * | 输入 token | `inputTokens`（**不含**缓存读） | `usage.uncachedInputTokens` |
 * | 缓存读 | `cacheReadTokens` | `usage.cacheHitTokens` |
 * | 输出 token | `outputTokens` | `usage.completionTokens` |
 * | 缓存写 | `cacheWriteTokens` | **没有**（→ 该指标在这一对上"不可用"） |
 *
 * ## 三条纪律（照抄 `paired-report.mjs` 的口径，绝不放松）
 *
 * 1. **缺数据不等于 0** —— 没上报的指标返回 `undefined`，`paired-report.mjs` 会把它从该指标的
 *    均值里排除，并在报告里显示"可用对数"。把缺失当 0 会让"没上报"看起来像"省了钱"。
 * 2. **不猜运行号** —— 记录里没有 `runNumber` 就**拒绝**规范化（报错），不按出现顺序编号：
 *    猜错会把两次真实重复误判成一对矛盾数据（`resolvePair` 会因此阻塞整份报告）。
 * 3. **污染照搬** —— `contaminated` 必须原样带过去（哪怕它让某些对作废）。
 */
import { readFileSync } from "node:fs";

/** 该规范化器认得的 Codem 记录版本（字段少一个就报错，不静默降级） */
const REQUIRED_FIELDS = ["evalSet", "caseId", "outcome", "arm", "runNumber", "model"];

/**
 * 把一条 Codem 臂记录规范化成成对比较记录。
 *
 * @param record `_codem-repo-eval.mjs` 写出的记录
 * @returns 成对比较记录（`arm: "treatment"`）
 * @throws 记录缺少必需字段时（明确报错，而不是给一条看起来能用的记录）
 */
export function normalizeCodemRecord(record) {
  const missing = REQUIRED_FIELDS.filter((field) => record?.[field] === undefined || record?.[field] === null);
  if (missing.length > 0) {
    throw new Error(
      `Codem 记录缺少字段：${missing.join(", ")}` +
        (missing.includes("runNumber")
          ? "（运行号必须由驱动显式写入 —— 见 .preview-shot/_codem-repo-eval.mjs 的 --run；本规范化器**不猜**）"
          : ""),
    );
  }
  const usage = record.usage ?? {};
  /** 只在**确实上报了**的时候才给数值；否则留 undefined（纪律 1） */
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const diffChars = num(record.diffChars);

  /**
   * **"通过了但工作区没有任何改动"必须被标出来**（第 106 波）。
   *
   * 记录里显式带了就用它；老记录没有这个字段时**当场算**：`passed && diffChars < 50`。
   * 这种"通过"要么是尺子坏了（工作区带着上一次的修复），要么是驱动漏算了已提交的改动 ——
   * 两种情况都**不能**当成一次真实通过（老口径里正是这样混进了 3 次）。
   */
  const suspiciousNoDiffPass =
    typeof record.suspiciousNoDiffPass === "boolean"
      ? record.suspiciousNoDiffPass
      : record.outcome === "passed" && typeof diffChars === "number" && diffChars < 50;

  return {
    evalSet: record.evalSet,
    caseId: record.caseId,
    arm: "treatment",
    agent: record.agent ?? "codem-app",
    model: record.model,
    runNumber: record.runNumber,
    outcome: record.outcome,
    contaminated: Boolean(record.contaminated),
    /**
     * "通过了但工作区没有改动" —— 尺子完整性问题，不是产品成绩。
     * 报告里会单独点名（见 `repo-paired-report.mjs`），成对比较时也据此提示。
     */
    suspiciousNoDiffPass,
    // —— 与对照臂同口径的四个桶 ——
    totalTokens: num(usage.totalTokens),
    inputTokens: num(usage.uncachedInputTokens),
    cacheReadTokens: num(usage.cacheHitTokens),
    outputTokens: num(usage.completionTokens),
    // cacheWriteTokens：Codem 侧没有这个口径 ⇒ 不给值（不是 0）
    // —— 其它可比指标 ——
    toolCalls: num(record.toolCalls),
    totalMs: num(record.totalMs),
    // —— 审计字段（评测器只读上面的指标键）——
    appVersion: record.appVersion,
    session: record.session,
    loopStops: num(record.loopStops?.length ?? record.loopStops),
    trajectorySteps: num(record.trajectorySteps),
    diffChars: num(record.diffChars),
  };
}

/** 读一个 JSONL 记录文件 */
export function readRecords(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
}

/** 规范化一整个文件 */
export function normalizeCodemRecords(records) {
  return records.map(normalizeCodemRecord);
}

/**
 * 检查两个臂是否**同模型**（不同模型就没有可比性 —— 这是这份比较的地基）。
 *
 * @returns `{ ok, controlModels, treatmentModels, reason? }`
 */
export function checkSameModel(controlRecords, treatmentRecords) {
  const models = (rows) => [...new Set(rows.map((r) => r.model).filter(Boolean))];
  const controlModels = models(controlRecords);
  const treatmentModels = models(treatmentRecords);
  if (controlModels.length === 0 || treatmentModels.length === 0) {
    return { ok: false, controlModels, treatmentModels, reason: "有一侧没有记录模型名（无法证明同模型）" };
  }
  if (controlModels.length > 1 || treatmentModels.length > 1) {
    return { ok: false, controlModels, treatmentModels, reason: "同一臂里出现了多个模型" };
  }
  if (controlModels[0] !== treatmentModels[0]) {
    return {
      ok: false,
      controlModels,
      treatmentModels,
      reason: `模型不同：对照 ${controlModels[0]} vs 处理 ${treatmentModels[0]}`,
    };
  }
  return { ok: true, controlModels, treatmentModels };
}
