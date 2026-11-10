/**
 * 任务完成门禁（C10：代码 + 文档 + 测试 + 引用，缺一不可）。
 *
 * ## 为什么门禁不放在工具层
 *
 * 工具层可以被绕过（服务直接调用、将来别的 UI 入口），而"完成"是**任务状态机**的
 * 语义。所以门禁放在引擎的 `updateTask` 里：任何把任务推进到 `completed` 的路径
 * 都必须过同一道闸。
 *
 * ## 文档同步 = 可注入谓词
 *
 * 引擎层只定义**同步**接口 `DocSyncCheck`，由调用方注入 —— 这里不碰异步 IO，
 * 完成判定才能保持纯函数、可复现。生产环境由服务层
 * （`provider/agent-teams-service.ts`）默认接 C06 的真实检查：
 * `agent-teams/doc-sync.ts` 先异步调 `documentSyncCheck` 取回版本事实，
 * 再把结果包成同步闭包注入。没有引用 / 没有账本 / 账本里没有版本事实时
 * `checked: false`，且**不阻塞** —— 这表示"当前没有可比对的版本事实"，
 * 不是"文档已同步"。一旦谓词返回 `synced: false`，任务就**不能**完成。
 *
 * 纯函数：不读时钟、不写任务（由调用方决定是否把 blockedReason 落到任务上）。
 */

import {
  TASK_EVIDENCE_KINDS,
  type DocSyncCheck,
  type DocSyncResult,
  type TaskCompletionBlock,
  type TaskEvidence,
  type TaskEvidenceKind,
  type TeamTask,
} from "./types";

export interface CompletionEvaluation {
  ok: boolean;
  /** 缺失的证据类别（空数组 = 四类齐备） */
  missing: TaskEvidenceKind[];
  /** 所有阻塞原因（人类可读；含文档未同步 / Verifier 未通过等） */
  reasons: string[];
  /** 结构化 blocked；ok=true 时为 undefined */
  block?: TaskCompletionBlock;
  docSync: DocSyncResult;
}

/** 任务声明的完成条件；旧数据没有该字段 ⇒ 按 C10 默认口径（四类 + Verifier）。 */
export function completionSpecOf(task: TeamTask): { requiredEvidence: TaskEvidenceKind[]; requireVerification: boolean } {
  const required = task.completion?.requiredEvidence;
  return {
    requiredEvidence: Array.isArray(required) && required.length > 0 ? [...required] : [...TASK_EVIDENCE_KINDS],
    requireVerification: task.completion?.requireVerification !== false,
  };
}

/** 取某类证据（只认非空 ref；测试证据额外要求不是 fail）。 */
export function evidenceOfKind(task: TeamTask, kind: TaskEvidenceKind): TaskEvidence[] {
  const list = Array.isArray(task.evidence) ? task.evidence : [];
  return list.filter((item) => item?.kind === kind && typeof item.ref === "string" && item.ref.trim().length > 0);
}

/**
 * 解析文档同步状态（优先级：任务上显式记录 > 注入的 C06 谓词 > 未检查）。
 *
 * 显式记录优先，是为了让"检查器一次判定后结果可复现"：同一任务不会因为调用时机
 * 不同而在"已同步/未同步"之间抖动。
 */
export function resolveDocSync(task: TeamTask, docSyncCheck?: DocSyncCheck): DocSyncResult {
  if (task.docSync) return task.docSync;
  if (typeof docSyncCheck === "function") {
    try {
      const result = docSyncCheck({ task, evidence: Array.isArray(task.evidence) ? task.evidence : [] });
      if (result && typeof result.synced === "boolean") {
        return { checked: true, ...result };
      }
      return { synced: false, checked: true, reason: "文档同步谓词返回了非法结果（不能当作已同步）" };
    } catch (e) {
      // 检查器抛错 = 无法证明同步 ⇒ 阻塞（fail-closed），不是放行
      return { synced: false, checked: true, reason: `文档同步谓词执行失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return {
    synced: true,
    checked: false,
    reason: "本次没有可用的文档版本事实（未引用文档 / 没有文档账本）——不阻塞，但也没有证明材料",
  };
}

/**
 * 评估任务是否可以完成。
 *
 * 门禁顺序对应验收口径：
 * 1. 代码 / 文档 / 测试 / 引用四类证据齐备（测试必须 pass）；
 * 2. 每条证据都必须能落到一个**有版本的共享工件**（引用不是空话）；
 * 3. 文档同步（可注入谓词）不能是 false；
 * 4. Verifier 必须独立（≠ 实现者）且 pass，并给出证据。
 */
export function evaluateTaskCompletion(task: TeamTask, docSyncCheck?: DocSyncCheck): CompletionEvaluation {
  const spec = completionSpecOf(task);
  const evidence = Array.isArray(task.evidence) ? task.evidence : [];
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const missing: TaskEvidenceKind[] = [];
  const reasons: string[] = [];

  for (const kind of spec.requiredEvidence) {
    const items = evidenceOfKind(task, kind);
    if (items.length === 0) {
      missing.push(kind);
      reasons.push(`缺少「${kind}」证据：任务完成条件要求代码/文档/测试/引用四类证据`);
      continue;
    }
    if (kind === "test" && !items.some((item) => item.status === "pass")) {
      missing.push(kind);
      reasons.push("测试证据没有 pass 结果：失败或未执行的测试不能作为完成依据");
    }
    const hasArtifact = items.some((item) =>
      artifacts.some((artifact) => artifact?.kind === kind && artifact.ref === item.ref && (artifact.revision ?? 0) >= 1),
    );
    if (!hasArtifact) {
      missing.push(kind);
      reasons.push(`「${kind}」证据没有对应的共享工件（ref 无法回溯）：${items.map((i) => i.ref).join(", ")}`);
    }
  }

  const docSync = resolveDocSync(task, docSyncCheck);
  if (spec.requiredEvidence.includes("doc") && !docSync.synced) {
    reasons.push(`文档未同步：${docSync.reason ?? "文档版本落后于代码"}`);
  }

  if (spec.requireVerification) {
    const verification = task.verification;
    if (!verification) {
      reasons.push("缺少 Verifier 独立检查：任务必须先通过 verify 才能 completed");
    } else {
      if (verification.verdict !== "pass") {
        reasons.push(`Verifier 未通过：${verification.reasons.join("；") || "无原因"}`);
      }
      if (Array.isArray(verification.evidence) && verification.evidence.length === 0) {
        reasons.push("Verifier 没有给出证据坐标（pass 不能是空口）");
      }
      const implementer = task.claim?.by;
      if (implementer && verification.verifier === implementer) {
        reasons.push(`Verifier「${verification.verifier}」就是实现者，独立检查不成立`);
      }
    }
  }

  // 去重但保持首次出现的顺序（同一原因可能由多类证据触发）
  const uniqueReasons = [...new Set(reasons)];
  const ok = missing.length === 0 && uniqueReasons.length === 0;
  return {
    ok,
    missing: [...new Set(missing)],
    reasons: uniqueReasons,
    ...(ok ? {} : { block: { missing: [...new Set(missing)], reasons: uniqueReasons } }),
    docSync,
  };
}
