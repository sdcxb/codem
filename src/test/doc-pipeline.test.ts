/**
 * C07：长文档编译流水线 —— 阶段顺序 / 每阶段证据 / 失败不完成 / diff 产物。
 *
 * 验收口径（docs/marketing/context-os.claims.json C07）：
 * 「用 goal runner 或等价阶段机承载 section jobs；每阶段有验收证据；合并有计划；未完成不冒充完成。」
 *
 * 四条判据各自会因为实现坏掉而红：
 * 1. 去掉「上一阶段必须 done」的前置 ⇒ 判据 1 红；
 * 2. 阶段不落产物/摘要（或 digest 恒空）⇒ 判据 2 红；
 * 3. 失败仍标 complete / 不要求全部分节交付 ⇒ 判据 3 红；
 * 4. diff 不生成或基线状态不标注 ⇒ 判据 4 红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../core/llm/tools";
import { createDocCompileTool } from "../core/llm/tools/document-tools";
import {
  DOC_PIPELINE_STAGES,
  documentPipelineSnapshot,
  runDocumentPipelineStage,
  startDocumentPipeline,
  submitDocumentSection,
} from "../core/document/pipeline";
import {
  __resetDocumentPipelinesForTests,
  flushDocumentPipelinePersistence,
} from "../core/document/test-seams";
import { getSettingJSON, setSetting, setSettingJSON } from "../core/storage/settings";

const STAGES = [...DOC_PIPELINE_STAGES];

function plan(sessionId: string, documentId: string, extra: { baselineText?: string } = {}) {
  return startDocumentPipeline({
    sessionId,
    documentId,
    title: "迁移说明",
    outline: [{ heading: "1 总则", page: 1 }, { heading: "2 步骤", page: 2 }],
    ...extra,
  });
}

const CITATION_1 = "[file: 报告.docx | page: 1 | §1 总则 | chunk: doc_1#1]";
const CITATION_2 = "[file: 报告.docx | page: 2 | §2 步骤 | chunk: doc_1#2]";

function deliverBoth(sessionId: string, documentId: string, citation2 = CITATION_2) {
  submitDocumentSection({
    sessionId,
    documentId,
    sectionId: "s1",
    content: "总则正文。",
    citations: [CITATION_1],
  });
  return submitDocumentSection({
    sessionId,
    documentId,
    sectionId: "s2",
    content: "步骤正文。",
    citations: citation2 ? [citation2] : [],
  });
}

/** 按顺序跑完 sections → merge → consistency → citations → coverage → diff（可停在某阶段）。 */
function runStages(
  sessionId: string,
  documentId: string,
  until: (typeof STAGES)[number],
  extra: { baselineText?: string } = {},
) {
  const results: Array<{ stage: string; ok: boolean; error?: string }> = [];
  for (const stage of STAGES) {
    if (stage === "outline") continue;
    const res = runDocumentPipelineStage({
      sessionId,
      documentId,
      stage,
      ...extra,
    });
    results.push({ stage, ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
    if (!res.ok) break;
    if (stage === until) break;
  }
  return results;
}

describe("C07-1 阶段顺序：禁止跳级", () => {
  it("分节未交齐时 merge 被拒绝，且给出具体原因（不是笼统失败）", () => {
    const sessionId = "c07-order";
    plan(sessionId, "doc_order");

    const merge = runDocumentPipelineStage({ sessionId, documentId: "doc_order", stage: "merge" });
    expect(merge.ok).toBe(false);
    if (merge.ok) throw new Error("unreachable");
    expect(merge.error).toContain("禁止跳级：上一阶段 sections 还没完成");

    const sections = runDocumentPipelineStage({ sessionId, documentId: "doc_order", stage: "sections" });
    expect(sections.ok).toBe(false);
    if (sections.ok) throw new Error("unreachable");
    expect(sections.error).toContain("分节未交齐：2/2 个未完成");

    const snapshot = documentPipelineSnapshot(sessionId, "doc_order")!;
    expect(snapshot.complete).toBe(false);
    expect(snapshot.blockedBy[0]?.stage).toBe("sections");
  });

  it("阶段顺序表是唯一事实来源（7 个阶段，outline 在最先）", () => {
    const sessionId = "c07-order2";
    const snapshot = plan(sessionId, "doc_order2");
    expect(snapshot.stages.map((s) => s.stage)).toEqual(STAGES);
    expect(STAGES[0]).toBe("outline");
    expect(STAGES).toHaveLength(7);
    expect(snapshot.stages[0].status).toBe("done");
  });
});

describe("C07-2 每阶段有验收证据（产物 + digest）", () => {
  it("完整跑通后：每个阶段都有 ok 证据与产物 digest，merge 有计划，complete=true", () => {
    const sessionId = "c07-evidence";
    plan(sessionId, "doc_evidence");
    deliverBoth(sessionId, "doc_evidence");
    const runs = runStages(sessionId, "doc_evidence", "diff");
    expect(runs.every((r) => r.ok)).toBe(true);

    const snapshot = documentPipelineSnapshot(sessionId, "doc_evidence")!;
    expect(snapshot.complete).toBe(true);
    expect(snapshot.blockedBy).toEqual([]);
    expect(snapshot.evidence.map((e) => e.stage)).toEqual(STAGES);
    for (const evidence of snapshot.evidence) {
      expect(evidence.ok).toBe(true);
      expect(evidence.summary.length).toBeGreaterThan(4);
      expect(evidence.artifacts.length).toBeGreaterThan(0);
      expect(evidence.artifacts[0].digest).toMatch(/^[0-9a-f]{16}$/);
      expect(evidence.artifacts[0].bytes).toBeGreaterThan(0);
    }
    // 合并有计划：按顺序列节，并带合并文本里的区间
    expect(snapshot.mergePlan).toHaveLength(2);
    expect(snapshot.mergePlan.map((p) => p.heading)).toEqual(["1 总则", "2 步骤"]);
    expect(snapshot.mergePlan[0].from).toBe(0);
    expect(snapshot.mergePlan[1].from).toBeGreaterThanOrEqual(snapshot.mergePlan[0].to);
    expect(snapshot.sectionProgress).toEqual({ total: 2, done: 2, pending: 0, failed: 0 });
  });
});

describe("C07-3 未完成不冒充完成（失败停在原地 + 重试可恢复）", () => {
  it("分节没有引用 ⇒ citations 阶段失败、complete 保持 false；补引用重跑后恢复", () => {
    const sessionId = "c07-fail";
    plan(sessionId, "doc_fail");
    deliverBoth(sessionId, "doc_fail", "");
    const first = runStages(sessionId, "doc_fail", "citations");
    expect(first.find((r) => r.stage === "citations")?.ok).toBe(false);
    expect(first.find((r) => r.stage === "citations")?.error).toContain("没有任何 citation");

    let snapshot = documentPipelineSnapshot(sessionId, "doc_fail")!;
    expect(snapshot.complete).toBe(false);
    expect(snapshot.stages.find((s) => s.stage === "citations")?.status).toBe("failed");
    expect(snapshot.stages.find((s) => s.stage === "coverage")?.status).toBe("pending");

    // 重交分节（引用补齐）⇒ 下游阶段作废，必须按顺序重跑
    const resubmit = submitDocumentSection({
      sessionId,
      documentId: "doc_fail",
      sectionId: "s2",
      content: "步骤正文。",
      citations: [CITATION_2],
    });
    expect(resubmit.ok).toBe(true);
    snapshot = documentPipelineSnapshot(sessionId, "doc_fail")!;
    expect(snapshot.stages.find((s) => s.stage === "sections")?.status).toBe("pending");
    expect(snapshot.stages.find((s) => s.stage === "merge")?.status).toBe("pending");
    expect(snapshot.complete).toBe(false);

    const rerun = runStages(sessionId, "doc_fail", "diff");
    expect(rerun.every((r) => r.ok), JSON.stringify(rerun)).toBe(true);
    expect(documentPipelineSnapshot(sessionId, "doc_fail")!.complete).toBe(true);
  });

  it("空正文不算交付：分节标 failed，重试次数递增，流水线不会到 complete", () => {
    const sessionId = "c07-empty";
    plan(sessionId, "doc_empty");
    const bad = submitDocumentSection({
      sessionId,
      documentId: "doc_empty",
      sectionId: "s1",
      content: "   ",
      citations: [CITATION_1],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.error).toContain("分节正文为空");

    let snapshot = documentPipelineSnapshot(sessionId, "doc_empty")!;
    const s1 = snapshot.sections.find((s) => s.id === "s1")!;
    expect(s1.status).toBe("failed");
    expect(s1.attempts).toBe(1);
    expect(snapshot.complete).toBe(false);

    const retry = submitDocumentSection({
      sessionId,
      documentId: "doc_empty",
      sectionId: "s1",
      content: "总则正文。",
      citations: [CITATION_1],
    });
    expect(retry.ok).toBe(true);
    snapshot = documentPipelineSnapshot(sessionId, "doc_empty")!;
    expect(snapshot.sections.find((s) => s.id === "s1")!.attempts).toBe(2);
    expect(snapshot.sections.find((s) => s.id === "s1")!.status).toBe("done");
  });
});

describe("C07-4 diff 产物", () => {
  it("有基线：diff 里能同时看到删除行与新增行，并记住基线来源", () => {
    const sessionId = "c07-diff";
    const baseline = "## 1 总则\n\n旧的总则正文。\n\n## 2 步骤\n\n旧的步骤正文。\n";
    plan(sessionId, "doc_diff", { baselineText: baseline });
    deliverBoth(sessionId, "doc_diff");
    runStages(sessionId, "doc_diff", "diff", { baselineText: baseline });

    const snapshot = documentPipelineSnapshot(sessionId, "doc_diff")!;
    expect(snapshot.baseline).toBe("supplied");
    expect(snapshot.diff).toBeTruthy();
    expect(snapshot.diff!).toContain("--- v-previous.md");
    expect(snapshot.diff!).toContain("+++ v-next.md");
    expect(snapshot.diff!).toContain("-旧的总则正文。");
    expect(snapshot.diff!).toContain("+总则正文。");
    const diffEvidence = snapshot.evidence.find((e) => e.stage === "diff")!;
    expect(diffEvidence.artifacts[0].name).toBe("diff.patch");
  });

  it("没有基线：如实标 none，并把本次内容全部记为新增（不假装做过对比）", () => {
    const sessionId = "c07-diff2";
    plan(sessionId, "doc_diff2");
    deliverBoth(sessionId, "doc_diff2");
    runStages(sessionId, "doc_diff2", "diff");
    const snapshot = documentPipelineSnapshot(sessionId, "doc_diff2")!;
    expect(snapshot.baseline).toBe("none");
    expect(snapshot.diff!).toContain("+总则正文。");
    const summary = snapshot.evidence.find((e) => e.stage === "diff")!.summary;
    expect(summary).toContain("没有基线");
  });
});

/**
 * C07 边界①：**流水线状态不再只活在进程内**。
 *
 * 验收口径（本任务）：
 * - 提交 outline+sections 后「清内存/新实例」⇒ status 仍显示两阶段完成、可继续 merge；
 * - 坏 JSON / 乱序阶段 ⇒ 回到未开始 + warn（不许把可疑状态当成验收证据）；
 * - 持久化不改变现有阶段判据（跳级仍被拒、顺序仍固定）。
 *
 * 判据怎么变红：
 * - 去掉落盘 / 读回（只留内存 Map）⇒ C07-5 红；
 * - 读回时不做版本/顺序/交叉校验（把坏状态当正常）⇒ C07-6 红；
 * - 读回后绕过「上一阶段必须 done」⇒ C07-5 的跳级断言红。
 */
function pipelineSettingKey(sessionId: string): string {
  return `codem-document-pipeline:${sessionId}`;
}

/** 一份「形状合法」的持久化文档，供坏状态用例改字段用 */
function persistedDocumentStub(documentId: string) {
  return {
    documentId,
    title: "坏状态样例",
    stages: DOC_PIPELINE_STAGES.map((stage, i) => ({
      stage,
      status: i === 0 ? "done" : "pending",
    })),
    sections: [],
    artifacts: [],
    mergePlan: [],
    baseline: "none",
    completed: false,
    createdAt: 1,
    updatedAt: 2,
  };
}

function toolCtx(sessionId: string): ToolContext {
  return {
    sessionId,
    messageId: "m1",
    cwd: "C:\\project",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as unknown as ToolContext;
}

afterEach(() => {
  __resetDocumentPipelinesForTests();
  vi.restoreAllMocks();
});

describe("C07-5 持久化：提交 outline+sections 后新实例仍能读回并继续 merge", () => {
  it("清内存后 status 仍显示两阶段完成、分节正文还在、可继续 merge（且仍禁止跳级）", async () => {
    const sessionId = "c07-persist";
    const documentId = "doc_persist";
    plan(sessionId, documentId);
    deliverBoth(sessionId, documentId);
    const sectionsStage = runDocumentPipelineStage({ sessionId, documentId, stage: "sections" });
    expect(sectionsStage.ok).toBe(true);

    // 先证明「真的落盘了」：只有内存的话这步之后的重启断言不可能成立
    flushDocumentPipelinePersistence();
    const stored = getSettingJSON<Record<string, any> | null>(pipelineSettingKey(sessionId), null);
    expect(stored, "流水线状态必须落在 codem-document-pipeline:<sessionId> 键里").toBeTruthy();
    expect(stored!.version).toBe(1);
    expect(stored!.documents[0].documentId).toBe(documentId);
    expect(stored!.documents[0].completed).toBe(false);
    expect(stored!.documents[0].artifacts.map((a: any) => a.digest).every((d: string) => /^[0-9a-f]{16}$/.test(d))).toBe(true);

    // 新实例：清空进程内镜像（持久化留在设置里）
    __resetDocumentPipelinesForTests();
    const restored = documentPipelineSnapshot(sessionId, documentId);
    expect(restored, "重启后 status 不能回答「还没有流水线」").toBeTruthy();
    expect(restored!.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      "outline:done",
      "sections:done",
      "merge:pending",
      "consistency:pending",
      "citations:pending",
      "coverage:pending",
      "diff:pending",
    ]);
    expect(restored!.blockedBy[0]?.stage).toBe("merge");
    // 分节正文必须读回 —— 否则 merge 只是空壳（「可继续下一阶段」就成了假话）
    expect(restored!.sections.map((s) => s.content)).toEqual(["总则正文。", "步骤正文。"]);

    // 阶段顺序与禁跳级不变：恢复后直接跑 consistency 仍被拒
    const skip = runDocumentPipelineStage({ sessionId, documentId, stage: "consistency" });
    expect(skip.ok).toBe(false);
    if (skip.ok) throw new Error("unreachable");
    expect(skip.error).toContain("禁止跳级：上一阶段 merge 还没完成");

    // 继续下一阶段（merge）并一路跑完
    const merge = runDocumentPipelineStage({ sessionId, documentId, stage: "merge" });
    expect(merge.ok, JSON.stringify(merge)).toBe(true);
    for (const stage of ["consistency", "citations", "coverage", "diff"] as const) {
      const res = runDocumentPipelineStage({ sessionId, documentId, stage });
      expect(res.ok, `${stage}: ${res.ok ? "" : res.error}`).toBe(true);
    }
    const done = documentPipelineSnapshot(sessionId, documentId)!;
    expect(done.complete).toBe(true);
    expect(done.diffSummary).toBeTruthy();
    expect(done.diffSummary!.added).toBeGreaterThan(0);

    // 完成后重启：status 仍是已完成，diff 只剩摘要（补丁正文不落盘）也要如实显示
    flushDocumentPipelinePersistence();
    __resetDocumentPipelinesForTests();
    const afterRestart = documentPipelineSnapshot(sessionId, documentId)!;
    expect(afterRestart.complete).toBe(true);
    expect(afterRestart.diff).toBeUndefined();
    expect(afterRestart.diffSummary?.lines).toBe(done.diffSummary!.lines);
    expect(afterRestart.mergePlan).toHaveLength(2);

    // doc_compile status 是产品/模型用的入口：重启后必须真的读回（不是只让内部函数能读）
    const status = (await createDocCompileTool().execute(
      { action: "status", document_id: documentId },
      toolCtx(sessionId),
    )) as any;
    expect(String(status.output)).toContain("已完成");
    expect(String(status.output)).toContain("阶段: outline=done");
    expect(String(status.output)).toContain("diff: 摘要 +");
  });
});

describe("C07-6 持久化校验：坏 JSON / 乱序阶段 ⇒ 未开始 + warn", () => {
  it("坏 JSON ⇒ documentPipelineSnapshot 返回 null 且 warn（不把坏数据当状态）", () => {
    const sessionId = "c07-bad-json";
    const key = pipelineSettingKey(sessionId);
    setSetting(key, "{不是 JSON");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(documentPipelineSnapshot(sessionId, "doc_bad")).toBeNull();
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes("不是合法 JSON")),
      "坏 JSON 必须留可诊断的 warn",
    ).toBe(true);
  });

  it("版本不符 ⇒ 未开始 + warn（旧版本状态不许混进新判据）", () => {
    const sessionId = "c07-bad-version";
    setSettingJSON(pipelineSettingKey(sessionId), {
      version: 99,
      sessionId,
      documents: [persistedDocumentStub("doc_bad")],
      updatedAt: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(documentPipelineSnapshot(sessionId, "doc_bad")).toBeNull();
    expect(warn.mock.calls.some((args) => String(args[0]).includes("版本不符"))).toBe(true);
  });

  it("阶段乱序（merge 写在 sections 前面）⇒ 未开始 + warn", () => {
    const sessionId = "c07-bad-order";
    const doc = persistedDocumentStub("doc_bad");
    const stages = [...doc.stages];
    [stages[1], stages[2]] = [stages[2], stages[1]];
    setSettingJSON(pipelineSettingKey(sessionId), {
      version: 1,
      sessionId,
      documents: [{ ...doc, stages }],
      updatedAt: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(documentPipelineSnapshot(sessionId, "doc_bad")).toBeNull();
    expect(warn.mock.calls.some((args) => String(args[0]).includes("非法文档状态"))).toBe(true);
  });

  it("阶段顺序合法但跨字段矛盾（sections=done 却没有分节）⇒ 未开始 + warn", () => {
    const sessionId = "c07-bad-cross";
    const doc = persistedDocumentStub("doc_bad");
    const stages = DOC_PIPELINE_STAGES.map((stage) => ({
      stage,
      status: stage === "outline" || stage === "sections" ? "done" : "pending",
    }));
    setSettingJSON(pipelineSettingKey(sessionId), {
      version: 1,
      sessionId,
      documents: [{ ...doc, stages, completed: false }],
      updatedAt: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(documentPipelineSnapshot(sessionId, "doc_bad")).toBeNull();
    expect(warn.mock.calls.some((args) => String(args[0]).includes("非法文档状态"))).toBe(true);
  });
});

