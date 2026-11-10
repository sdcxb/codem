/**
 * Verifier（C10）：**独立角色 + 独立上下文**检查任务产物与判据。
 *
 * ## 独立上下文是什么意思
 *
 * 实现者写下的 `task.output`、`attempts[].output`、以及任何"自评/推理"文本，
 * 一律**不进入 Verifier 的检查上下文**。Verifier 只看：
 * - 任务本身声明的判据（subject/description/acceptance/dependencies）；
 * - 共享工件（引用 + 版本）；
 * - 四类证据（代码/文档/测试/引用）；
 * - 文档同步谓词的结果；
 * - 实现者是谁（只用于判断"Verifier 不能等于实现者"）。
 *
 * 它输出 `pass/fail` + **证据坐标**（不是一段解释），Conductor 据此决定是否放行。
 *
 * ## 与 completion.ts 的分工
 *
 * 本文件只"检查"，不改任务；把结果写回任务是服务层（`AgentTeamsService.verify`）的事。
 * 完成门禁（`evaluateTaskCompletion`）在 Verifier 之外**再核对一次**文档同步与独立性 ——
 * 检查器可能先跑、文档随后又落后，门禁必须按完成那一刻的事实判断。
 */

import { evidenceOfKind, resolveDocSync } from "./completion";
import {
  TASK_EVIDENCE_KINDS,
  type DocSyncCheck,
  type TaskArtifact,
  type TaskEvidence,
  type TaskEvidenceKind,
  type TaskVerification,
  type TaskVerificationCheck,
  type TaskVerificationContext,
  type TeamTask,
} from "./types";

export interface VerificationInput {
  /** 独立 Verifier 的名字（成员名或 "verifier"/"captain"）；等于实现者时判 fail */
  verifier: string;
  /** 可注入的 C06 文档版本同步谓词（未注入 ⇒ checked:false，不阻塞） */
  docSyncCheck?: DocSyncCheck;
}

/**
 * 构造 Verifier 上下文（**只从任务图/工件构建，不读任何自评文本**）。
 *
 * 该函数不导出：唯一使用方是 `runTaskVerification`，测试通过返回的
 * `verification.context` 断言"自评没有进入检查上下文"。
 */
function buildVerifierContext(task: TeamTask, docSyncCheck?: DocSyncCheck): TaskVerificationContext {
  return {
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    acceptance: task.acceptance,
    dependencies: [...(Array.isArray(task.dependencies) ? task.dependencies : [])],
    requiredEvidence: Array.isArray(task.completion?.requiredEvidence) && task.completion!.requiredEvidence.length > 0
      ? [...task.completion!.requiredEvidence]
      : [...TASK_EVIDENCE_KINDS],
    implementer: task.claim?.by,
    artifacts: (Array.isArray(task.artifacts) ? task.artifacts : []).map((artifact) => ({ ...artifact })),
    evidence: (Array.isArray(task.evidence) ? task.evidence : []).map((item) => ({ ...item })),
    docSync: resolveDocSync(task, docSyncCheck),
  };
}

/**
 * 在上下文里找证据对应的共享工件（不存在 / 没有版本 ⇒ undefined）。
 */
function artifactOf(context: TaskVerificationContext, kind: TaskEvidenceKind, ref: string): TaskArtifact | undefined {
  return context.artifacts.find((artifact) => artifact?.kind === kind && artifact.ref === ref);
}

/**
 * 运行独立检查并返回 `pass/fail + 证据`。
 *
 * 检查项固定（缺一项就 fail）：
 * - `TASK-ACTIVE`：任务真的被领取了（没有 claim 就没有实现者，无法验证）；
 * - `VERIFIER-INDEPENDENT`：Verifier ≠ 实现者；
 * - `EVIDENCE-<kind>` × 4：四类证据齐备（测试必须 pass）；
 * - `ARTIFACT-<kind>` × 4：每条证据都能落到一个有版本的共享工件；
 * - `DOC-SYNC`：文档同步谓词不能是 false。
 */
export function runTaskVerification(task: TeamTask, input: VerificationInput): TaskVerification {
  const verifier = typeof input?.verifier === "string" && input.verifier.trim() ? input.verifier.trim() : "verifier";
  const context = buildVerifierContext(task, input?.docSyncCheck);
  const checks: TaskVerificationCheck[] = [];
  const reasons: string[] = [];
  const evidence: string[] = [`task:${context.taskId}`, `verifier:${verifier}`];

  const implementer = context.implementer;
  const active = Boolean(implementer) && (task.status === "claimed" || task.status === "in_progress");
  checks.push({
    id: "TASK-ACTIVE",
    ok: active,
    detail: active ? `implementer=${implementer}` : `status=${task.status}, implementer=${implementer ?? "(none)"}`,
  });
  if (!active) reasons.push("任务没有被领取（没有实现者），不能做完成验证");

  const independent = !implementer || verifier !== implementer;
  checks.push({
    id: "VERIFIER-INDEPENDENT",
    ok: independent,
    detail: independent ? `verifier=${verifier}` : `verifier 与实现者同为 ${implementer}`,
  });
  if (!independent) reasons.push(`Verifier「${verifier}」不能同时是实现者`);

  for (const kind of context.requiredEvidence) {
    const items = evidenceOfKind(task, kind);
    const present = items.length > 0;
    checks.push({
      id: `EVIDENCE-${kind}`,
      ok: present,
      detail: present ? items.map((item) => item.ref).join(", ") : "缺少该类证据",
    });
    if (!present) reasons.push(`缺少「${kind}」证据`);
    if (!present) continue;

    if (kind === "test") {
      const passed = items.some((item) => item.status === "pass");
      checks.push({
        id: "TEST-PASS",
        ok: passed,
        detail: passed ? "至少一条测试证据 pass" : "没有 pass 的测试结果",
      });
      if (!passed) reasons.push("测试证据没有 pass 结果");
    }

    const missingArtifact = items.filter((item) => {
      const artifact = artifactOf(context, kind, item.ref);
      return !artifact || (artifact.revision ?? 0) < 1;
    });
    checks.push({
      id: `ARTIFACT-${kind}`,
      ok: missingArtifact.length === 0,
      detail: missingArtifact.length === 0 ? "所有证据都有带版本的共享工件" : `无工件：${missingArtifact.map((i) => i.ref).join(", ")}`,
    });
    if (missingArtifact.length > 0) reasons.push(`「${kind}」证据没有带版本的共享工件`);
    for (const item of items) {
      const artifact = artifactOf(context, kind, item.ref);
      evidence.push(`evidence:${kind}:${item.ref}${artifact ? `@r${artifact.revision}` : ""}`);
    }
  }

  checks.push({
    id: "DOC-SYNC",
    ok: context.docSync.synced,
    detail: context.docSync.synced
      ? context.docSync.checked === false
        ? "本次没有可用的文档版本事实（无引用/无账本）——没有同步证明材料，但不阻塞"
        : "文档同步谓词通过"
      : `文档未同步：${context.docSync.reason ?? "未知原因"}`,
  });
  if (!context.docSync.synced) reasons.push(`文档未同步：${context.docSync.reason ?? "未知原因"}`);
  evidence.push(`doc-sync:${context.docSync.synced ? (context.docSync.checked === false ? "unchecked" : "synced") : "stale"}`);
  for (const artifact of context.artifacts) evidence.push(`artifact:${artifact.kind}:${artifact.ref}@r${artifact.revision}`);

  const verdict: TaskVerification["verdict"] = reasons.length === 0 ? "pass" : "fail";
  evidence.push(`checks:${checks.filter((c) => c.ok).length}/${checks.length}`);
  return {
    verifier,
    verdict,
    checkedAt: Date.now(),
    evidence: [...new Set(evidence)],
    reasons: [...new Set(reasons)],
    checks,
    context,
  };
}
