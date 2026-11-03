/**
 * 计划校验：**防「短步目标」的硬门禁**。
 *
 * 设计依据 `GOAL-MODE-PLAN.md` §5.3。规划器产出的是**草稿**（模型 JSON），
 * 这里把它变成类型化计划，并在下面七条上做**确定性**检查；任何一条不过 ⇒ 计划作废
 * （planner 会带着错误清单让模型重写，最多 3 次），**不允许把动作型 phase 硬塞进去**。
 *
 * | # | 检查 | 失败码 |
 * |---|---|---|
 * | 1 | 结果导向（不是「读文件/跑测试」这类动作） | `action-phase` |
 * | 2 | 每阶段至少一条确定性验收 | `missing-acceptance` / `invalid-acceptance` |
 * | 3 | 覆盖整体（目标验收每条都被某阶段覆盖） | `coverage` / `unknown-cover` |
 * | 4 | 依赖无环 | `dag-cycle` / `unknown-dependency` / `self-dependency` |
 * | 5 | 粒度 3–12 | `phase-count` |
 * | 6 | 不重复（两个阶段同一 outcome） | `duplicate-outcome` |
 * | 7 | 不变式明确 | `no-invariants` |
 *
 * 这里**只有纯函数**：不读存储、不调模型、不跑命令 —— 所以每条规则都能单测，
 * 也能被 planner 反复调用（重写循环）。
 */

import type {
  Acceptance,
  GoalBudget,
  GoalPlan,
  PlanPhase,
  TaskClassification,
} from "./types";

/** 阶段数量范围（少于 3 说明该走 run 自主；多于 12 要求按结果合并） */
const MIN_PHASES = 3;
const MAX_PHASES = 12;

type PlanViolationCode =
  | "invalid-draft"
  | "unknown-field"
  | "no-statement"
  | "no-goal-acceptance"
  | "no-strategy"
  | "no-invariants"
  | "phase-count"
  | "phase-missing-outcome"
  | "phase-missing-title"
  | "action-phase"
  | "missing-acceptance"
  | "invalid-acceptance"
  | "coverage"
  | "unknown-cover"
  | "duplicate-outcome"
  | "dag-cycle"
  | "unknown-dependency"
  | "self-dependency";

export interface PlanViolation {
  code: PlanViolationCode;
  /** 定位（`phases[2].outcome` / `acceptance[0].command` …） */
  path: string;
  message: string;
}

interface PlanValidationFailure {
  ok: false;
  violations: PlanViolation[];
}

interface PlanValidationSuccess {
  ok: true;
  plan: GoalPlan;
  /** 目标级验收（带 A1..An id） —— 由草稿推导，交给 store 建契约 */
  acceptance: Acceptance[];
  statement: string;
  principles: string[];
  nonGoals: string[];
  constraints: string[];
}

export type PlanValidationResult = PlanValidationSuccess | PlanValidationFailure;

/** 规划器草稿（模型 JSON 的结构化投影；字段全部可选 —— 缺失要给出结构化错误） */
export interface PlanDraft {
  classification?: TaskClassification;
  statement?: string;
  principles?: string[];
  nonGoals?: string[];
  constraints?: string[];
  goalAcceptance?: Array<Partial<Acceptance>>;
  strategy?: string;
  invariants?: string[];
  phases?: Array<Partial<PlanPhase>>;
}

const DETERMINISTIC_KINDS = new Set(["command", "test", "artifact"]);
/**
 * 动作型 outcome 的判定（**这是 GOAL-3 的核心**）。
 *
 * 刻意只拒绝**明确的**动作短语（动词 + 工具/文件名词），不做「长度/模糊」那种会误杀
 * 正常结果的启发式：
 *
 * - 拒绝：「读取 src/core/x.ts」「跑一次测试」「运行 npm test」「看一下日志」「list files」
 * - 保留：「登录流程通过端到端测试」「X 模块的缓存层可用」「迁移完成且旧数据可读」
 *
 * 为什么用「动词 + 名词」而不是「动词开头就拒」：中文里「验证 X 可用」这种 outcome 很常见，
 * 单看开头会误杀；而「读/跑/查看」后面跟的宾语几乎总是工具对象。
 */
const ACTION_VERB_ZH =
  "(?:读|读取|查看|看|浏览|列出|枚举|搜索|查找|检索|打开|扫描|运行|执行|跑|调用|检查|测试|grep|ripgrep|read|open|list|view|check|run|execute|search|scan|browse|cat|ls)";
const TOOL_NOUN_ZH =
  "(?:文件|目录|代码|仓库|日志|测试|用例|命令|配置|分支|提交|这个文件|那个文件|一下|一遍|一次)";
const ACTION_PATTERN_ZH = new RegExp(`^\\s*${ACTION_VERB_ZH}[^，。；;]{0,12}?${TOOL_NOUN_ZH}`);
/** 「读/看/改 <路径>」——路径本身就是工具对象，不需要命中名词表 */
const PATH_LIKE = "[`\"'（(]?[\\w.\\-/\\\\]+\\.(?:ts|tsx|js|jsx|json|md|rs|py|go|java|css|html|yml|yaml|toml|sh|ps1)";
const ACTION_PATTERN_PATH = new RegExp(`^\\s*${ACTION_VERB_ZH}\\s*${PATH_LIKE}`, "i");
const ACTION_PATTERN_EN = new RegExp(
  "^\\s*(?:read|open|list|view|check|run|execute|search|scan|browse|cat|grep)\\s+(?:the\\s+|a\\s+|all\\s+)?(?:file|files|dir|dirs|directory|directories|code|repo|repository|log|logs|test|tests|command|commands|config)\\b",
  "i",
);
/** 「修改/编辑某个文件」也是动作（文件级改动 ≠ 可验收的结果） */
const FILE_EDIT_PATTERN = new RegExp(
  "^(?:\\s*)(?:修改|编辑|改写|重写|写入|更新|改动|新增|添加|删除|移除|edit|modify|update|write|rewrite|add|delete|remove)\\s*(?:一下|一个|一份|这个|那个)?\\s*(?:文件|目录|代码行|文档|测试文件|file|files|dir|directory)",
);

/** outcome 的规范化（去重口径：去空白/标点/大小写） */
function outcomeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。；：、,.!?;:'"「」『』()（）\-—_/\\]+/g, "");
}

function isActionOutcome(outcome: string): boolean {
  const text = outcome.trim();
  if (!text) return false;
  return (
    ACTION_PATTERN_ZH.test(text) ||
    ACTION_PATTERN_PATH.test(text) ||
    ACTION_PATTERN_EN.test(text) ||
    FILE_EDIT_PATTERN.test(text)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 一条验收是否「可确定性执行」（当前三种类型都是；保留这个判定点，防将来加回弱类型） */
function isDeterministicAcceptance(a: Acceptance): boolean {
  return DETERMINISTIC_KINDS.has(a.kind);
}

/**
 * 规范化一条验收：补 id/默认值 + 结构性校验。
 *
 * @param raw 模型给的原始对象
 * @param id  分配的 id
 * @param path 出错的定位前缀（给 violation 用）
 */
function normalizeAcceptance(
  raw: Partial<Acceptance> | undefined,
  id: string,
  path: string,
  violations: PlanViolation[],
): Acceptance | null {
  if (!raw || typeof raw !== "object") {
    violations.push({ code: "invalid-acceptance", path, message: "验收必须是一个对象" });
    return null;
  }
  const kind = raw.kind;
  if (kind !== "command" && kind !== "test" && kind !== "artifact") {
    violations.push({
      code: "invalid-acceptance",
      path: `${path}.kind`,
      message: `验收类型必须是 command/test/artifact 之一（收到 ${String(kind)}）—— 验收必须能被确定性执行`,
    });
    return null;
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) {
    violations.push({ code: "invalid-acceptance", path: `${path}.description`, message: "验收缺少 description（门禁失败时要给人看）" });
    return null;
  }
  if (kind === "command" || kind === "test") {
    if (!isNonEmptyString(raw.command)) {
      violations.push({ code: "invalid-acceptance", path: `${path}.command`, message: `${kind} 验收必须给 command` });
      return null;
    }
  }
  if (kind === "artifact" && !isNonEmptyString(raw.path)) {
    violations.push({ code: "invalid-acceptance", path: `${path}.path`, message: "artifact 验收必须给 path" });
    return null;
  }
  if (raw.expectExitCode !== undefined && !Number.isInteger(raw.expectExitCode)) {
    violations.push({ code: "invalid-acceptance", path: `${path}.expectExitCode`, message: "expectExitCode 必须是整数" });
    return null;
  }
  if (raw.timeoutMs !== undefined && (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) {
    violations.push({ code: "invalid-acceptance", path: `${path}.timeoutMs`, message: "timeoutMs 必须是正数" });
    return null;
  }
  return {
    id,
    kind,
    description,
    ...(isNonEmptyString(raw.command) ? { command: raw.command.trim() } : {}),
    ...(raw.expectExitCode !== undefined ? { expectExitCode: raw.expectExitCode } : {}),
    ...(isNonEmptyString(raw.expectOutput) ? { expectOutput: raw.expectOutput } : {}),
    ...(isNonEmptyString(raw.path) ? { path: raw.path.trim() } : {}),
    ...(isNonEmptyString(raw.contains) ? { contains: raw.contains } : {}),
    ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
  };
}

/** DAG 环检测（返回环上的 key 链；无环返回 null） */
function findCycle(phases: PlanPhase[]): string[] | null {
  const byKey = new Map(phases.map((p) => [p.key, p]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 栈上 / 2 完成
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const s = state.get(key) ?? 0;
    if (s === 1) {
      const at = stack.indexOf(key);
      return [...stack.slice(at), key];
    }
    if (s === 2) return null;
    state.set(key, 1);
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };
  for (const p of phases) {
    const hit = visit(p.key);
    if (hit) return hit;
  }
  return null;
}

export interface PlanValidateOptions {
  budget?: GoalBudget;
  now?: number;
  /** 重规划：已完成阶段已经覆盖过的目标验收 id（这些不算「没被覆盖」） */
  coveredByDone?: string[];
  /**
   * 重规划：契约本身不变，草稿**不需要**重述 statement/principles/goalAcceptance。
   * 此时覆盖检查用 `contractAcceptanceIds` 作为目标验收全集。
   */
  allowContractOmission?: boolean;
  /** 重规划时的目标验收全集（来自现有契约） */
  contractAcceptanceIds?: string[];
  minPhases?: number;
  maxPhases?: number;
}

/**
 * 校验一份规划草稿。
 *
 * 失败时**一次性返回全部** violation（不是遇到第一个就停）：模型重写需要看到完整清单，
 * 否则它会一轮修一条。
 */
export function validatePlanDraft(
  draft: PlanDraft | null | undefined,
  opts: PlanValidateOptions = {},
): PlanValidationResult {
  const violations: PlanViolation[] = [];
  if (!draft || typeof draft !== "object") {
    return { ok: false, violations: [{ code: "invalid-draft", path: "", message: "计划不是对象" }] };
  }
  const minPhases = opts.minPhases ?? MIN_PHASES;
  const maxPhases = opts.maxPhases ?? MAX_PHASES;

  // ---- 目标契约字段 ----
  const statement = isNonEmptyString(draft.statement) ? draft.statement.trim() : "";
  if (!statement && !opts.allowContractOmission) {
    violations.push({ code: "no-statement", path: "statement", message: "缺少目标重述（statement）" });
  }
  const principles = Array.isArray(draft.principles) ? draft.principles.filter(isNonEmptyString) : [];
  const nonGoals = Array.isArray(draft.nonGoals) ? draft.nonGoals.filter(isNonEmptyString) : [];
  const constraints = Array.isArray(draft.constraints) ? draft.constraints.filter(isNonEmptyString) : [];

  const goalAcceptance: Acceptance[] = [];
  const rawGoalAcceptance = Array.isArray(draft.goalAcceptance) ? draft.goalAcceptance : [];
  if (rawGoalAcceptance.length === 0 && !opts.allowContractOmission) {
    violations.push({ code: "no-goal-acceptance", path: "goalAcceptance", message: "目标级验收不能为空（否则无法判断整体完成）" });
  }
  rawGoalAcceptance.forEach((raw, i) => {
    const a = normalizeAcceptance(raw, `A${i + 1}`, `goalAcceptance[${i}]`, violations);
    if (a) goalAcceptance.push(a);
  });
  if (goalAcceptance.length > 0 && !goalAcceptance.some(isDeterministicAcceptance)) {
    violations.push({
      code: "invalid-acceptance",
      path: "goalAcceptance",
      message: "目标级验收必须是可确定性执行的检查（command/test/artifact）",
    });
  }

  // ---- 策略/不变式 ----
  const strategy = isNonEmptyString(draft.strategy) ? draft.strategy.trim() : "";
  if (strategy.length < 10) {
    violations.push({ code: "no-strategy", path: "strategy", message: "缺少总体策略（至少一句话，说明为什么选这条路径）" });
  }
  const invariants = Array.isArray(draft.invariants) ? draft.invariants.filter(isNonEmptyString) : [];
  if (invariants.length === 0) {
    violations.push({ code: "no-invariants", path: "invariants", message: "invariants 不能为空（至少包含用户原则/安全边界）" });
  }

  // ---- 阶段 ----
  const rawPhases = Array.isArray(draft.phases) ? draft.phases : [];
  if (rawPhases.length < minPhases || rawPhases.length > maxPhases) {
    violations.push({
      code: "phase-count",
      path: "phases",
      message: `阶段数必须在 ${minPhases}–${maxPhases} 之间（收到 ${rawPhases.length}）：少于 ${minPhases} 说明该走单轮自主，多于 ${maxPhases} 要求按结果合并`,
    });
  }

  /**
   * 目标验收 id 全集：
   * - 首次规划 = 草稿里的 `A1..An`；
   * - 重规划（`allowContractOmission`）= 现有契约的验收 id（契约不变，草稿不重述）。
   */
  const goalAcceptanceIds = new Set<string>(
    opts.allowContractOmission && opts.contractAcceptanceIds
      ? opts.contractAcceptanceIds
      : goalAcceptance.map((a) => a.id),
  );
  const phases: PlanPhase[] = [];
  const seenOutcomes = new Map<string, string>();
  rawPhases.forEach((raw, i) => {
    const key = isNonEmptyString(raw?.key) ? raw.key.trim() : `p${i + 1}`;
    const path = `phases[${i}]`;
    const title = isNonEmptyString(raw?.title) ? raw.title.trim() : "";
    const outcome = isNonEmptyString(raw?.outcome) ? raw.outcome.trim() : "";
    if (!title) violations.push({ code: "phase-missing-title", path: `${path}.title`, message: `${key} 缺少标题` });
    if (!outcome) {
      violations.push({ code: "phase-missing-outcome", path: `${path}.outcome`, message: `${key} 缺少 outcome（用户可见的交付物/行为/决策）` });
    } else if (isActionOutcome(outcome)) {
      violations.push({
        code: "action-phase",
        path: `${path}.outcome`,
        message:
          `阶段「${title || key}」的 outcome 是**动作**（「${outcome}」），不是可验收的结果。` +
          `把它改成「做完之后什么变了/什么可用了/什么决定了」（例如「X 的失败路径有回归测试且为绿」）。`,
      });
    }
    const dedupeKey = outcome ? outcomeKey(outcome) : "";
    if (dedupeKey) {
      const prior = seenOutcomes.get(dedupeKey);
      if (prior) {
        violations.push({
          code: "duplicate-outcome",
          path: `${path}.outcome`,
          message: `阶段 ${prior} 与 ${key} 的 outcome 重复（${outcome}）—— 两个阶段做同一件事等于计划没拆开`,
        });
      } else {
        seenOutcomes.set(dedupeKey, key);
      }
    }

    const acceptance: Acceptance[] = [];
    const rawAcceptance = Array.isArray(raw?.acceptance) ? raw.acceptance : [];
    if (rawAcceptance.length === 0) {
      violations.push({ code: "missing-acceptance", path: `${path}.acceptance`, message: `${key} 没有任何验收 —— 阶段完成将无客观依据` });
    }
    rawAcceptance.forEach((rawA, j) => {
      const a = normalizeAcceptance(rawA, `${key}.a${j + 1}`, `${path}.acceptance[${j}]`, violations);
      if (a) acceptance.push(a);
    });
    if (acceptance.length > 0 && !acceptance.some(isDeterministicAcceptance)) {
      violations.push({
        code: "missing-acceptance",
        path: `${path}.acceptance`,
        message: `${key} 的验收必须包含可确定性执行的检查（command/test/artifact）`,
      });
    }

    const covers = Array.isArray(raw?.covers)
      ? raw.covers.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim())
      : [];
    for (const id of covers) {
      if (!goalAcceptanceIds.has(id)) {
        violations.push({ code: "unknown-cover", path: `${path}.covers`, message: `${key} 覆盖了不存在的目标验收 ${id}` });
      }
    }

    const dependsOn = Array.isArray(raw?.dependsOn)
      ? raw.dependsOn.filter((d): d is string => typeof d === "string" && d.trim().length > 0).map((d) => d.trim())
      : [];
    if (dependsOn.includes(key)) {
      violations.push({ code: "self-dependency", path: `${path}.dependsOn`, message: `${key} 依赖自己` });
    }
    const risks = Array.isArray(raw?.risks) ? raw.risks.filter(isNonEmptyString) : [];

    phases.push({
      key,
      order: i,
      title: title || key,
      outcome,
      acceptance,
      covers,
      dependsOn,
      risks,
      status: "pending",
      attempts: 0,
      ...(isNonEmptyString(raw?.reworkOf) ? { reworkOf: raw.reworkOf.trim() } : {}),
    });
  });

  // 依赖必须存在 + 无环（依赖检查放在阶段收集之后：一次看到全图才知道谁不存在）
  const keys = new Set(phases.map((p) => p.key));
  for (const p of phases) {
    for (const dep of p.dependsOn) {
      if (!keys.has(dep)) {
        violations.push({ code: "unknown-dependency", path: `phases.${p.key}.dependsOn`, message: `${p.key} 依赖不存在的阶段 ${dep}` });
      }
    }
  }
  if (keys.size === phases.length) {
    const cycle = findCycle(phases);
    if (cycle) {
      violations.push({ code: "dag-cycle", path: "phases", message: `依赖成环：${cycle.join(" → ")}` });
    }
  }

  // 覆盖整体：目标验收的每一条必须被至少一个阶段（或已完成阶段）覆盖
  if (goalAcceptanceIds.size > 0) {
    const covered = new Set<string>(opts.coveredByDone ?? []);
    for (const p of phases) for (const id of p.covers) covered.add(id);
    const missing = [...goalAcceptanceIds].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      violations.push({
        code: "coverage",
        path: "phases",
        message: `目标验收没有被任何阶段覆盖：${missing.join(", ")} —— 计划不能保证整体完成`,
      });
    }
  }

  if (violations.length > 0) return { ok: false, violations };

  const now = opts.now ?? Date.now();
  const plan: GoalPlan = {
    goalId: "",
    version: 1,
    contractVersion: 1,
    strategy,
    invariants,
    phases,
    createdAt: now,
  };
  return {
    ok: true,
    plan,
    acceptance: goalAcceptance,
    statement,
    principles,
    nonGoals,
    constraints,
  };
}

/** 把校验错误转成给模型看的一段文本（planner 重写循环用） */
export function formatViolations(violations: PlanViolation[]): string {
  return violations.map((v, i) => `${i + 1}. [${v.code}] ${v.path ? v.path + "：" : ""}${v.message}`).join("\n");
}
