/**
 * C10「Artifact-centric Agents」判据（claim/attempt/rollback、任务切片、独立 Verifier、
 * 完成条件四类证据、文档未同步 ⇒ 不完成）。
 *
 * 这些用例都按"实现坏掉就红"的口径写：
 * - C10-1 变异：rollbackTask 不恢复领取时快照 / 不把任务放回 pending ⇒ 红；
 * - C10-2 变异：buildTaskSlice 把 parentMessages 的内容拼进 prompt ⇒ 红；
 * - C10-3 变异：Verifier 上下文加入 task.output / 允许 Verifier=实现者 ⇒ 红；
 * - C10-4 变异：完成门禁忽略 docSync（或忽略注入谓词）⇒ 红；
 * - C10-4c 变异：文档检查只覆盖实现者 + 队长（漏掉 Verifier / specialist）⇒ 红；
 * - C10-5 变异：requiredEvidence 只检查 code ⇒ 缺 test/reference 也能完成 ⇒ 红。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTeam, addMember, createTask, claimTask, updateTask, rollbackTask, snapshot,
} from "../core/agent-teams/engine";
import { runTaskVerification } from "../core/agent-teams/verifier";
import { buildTaskSlice } from "../core/agent-teams/task-context";
import { checkTaskDocumentSync } from "../core/agent-teams/doc-sync";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import { recordDocumentOutline, recordDocumentRead, recordDocumentSection } from "../core/document/ledger";
import { collectionIdForSession } from "../core/document/session-collection";
import {
  __resetDocumentBackendForTests,
  __resetDocumentLedgerForTests,
  setDocumentBackend,
} from "../core/document/test-seams";
import { createFakeDocumentBackend, makeDoc } from "./helpers/documents-fake";

const FULL_EVIDENCE = [
  { kind: "code" as const, ref: "src/feature.ts" },
  { kind: "doc" as const, ref: "docs/feature.md" },
  { kind: "test" as const, ref: "npx vitest run src/test/feature.test.ts", status: "pass" as const },
  { kind: "reference" as const, ref: "issue#42" },
];

function makeTeam() {
  const team = createTeam({ name: "C10 验收队", captainSessionId: "cap-c10" });
  addMember(team, { id: "child-impl", name: "实现者", role: "实现" });
  addMember(team, { id: "child-verifier", name: "验收员", role: "验证" });
  return team;
}

/** 领取 → in_progress（带证据） */
function startTask(team: ReturnType<typeof makeTeam>, taskId: string, by: string, evidence = FULL_EVIDENCE) {
  const claimed = claimTask(team, taskId, by);
  updateTask(team, taskId, { status: "in_progress", attemptId: claimed.attemptId, by, evidence });
  return claimed;
}

/** 跑独立 Verifier 并把结果写回任务（服务层的 verify 做的是同一件事） */
function verifyTask(team: ReturnType<typeof makeTeam>, taskId: string, verifier = "验收员") {
  const task = team.tasks.find((item) => item.id === taskId)!;
  const verification = runTaskVerification(task, { verifier });
  task.verification = verification;
  return verification;
}

describe("C10-1 claim / attempt / rollback 状态机", () => {
  it("领取写 claim+attempt；回滚恢复上一版工件/证据并回到 pending；再次领取 attempt++", () => {
    const team = makeTeam();
    const { task } = createTask(team, { subject: "实现 C10", acceptance: "代码/文档/测试/引用齐备" });
    // 上一版工件（模拟这个任务之前已经产出过一版）
    task.artifacts = [{
      id: "code:src/feature.ts", kind: "code", ref: "src/feature.ts", revision: 1,
      updatedAt: Date.now() - 1000,
    }];

    const first = claimTask(team, "t1", "实现者");
    expect(first.attempt).toBe(1);
    expect(task.claim).toMatchObject({ by: "实现者", attempt: 1, attemptId: first.attemptId });
    expect(task.attempts, "第一次领取要留一条 attempt 记录").toHaveLength(1);
    expect(task.attempts![0].artifactSnapshot, "领取时快照上一版工件").toHaveLength(1);

    updateTask(team, "t1", {
      status: "in_progress", attemptId: first.attemptId, by: "实现者",
      evidence: [{ kind: "code", ref: "src/feature.ts" }],
    });
    expect(task.artifacts!.find((a) => a.ref === "src/feature.ts")!.revision, "同引用再次登记 ⇒ 版本 +1").toBe(2);
    expect(task.evidence, "证据已登记").toHaveLength(1);

    const rolled = rollbackTask(team, "t1", { by: "实现者", reason: "实现方向错了，退回上一版" });
    expect(task.status, "回滚后回到共享池").toBe("pending");
    expect(task.claim, "领取权作废").toBeUndefined();
    expect(task.attemptId).toBeUndefined();
    expect(task.artifacts!.find((a) => a.ref === "src/feature.ts")!.revision, "工件恢复到领取时那一版").toBe(1);
    expect(task.evidence, "本次尝试新增的证据一并回退").toHaveLength(0);
    expect(task.rollbacks).toHaveLength(1);
    expect(task.rollbacks![0].restoredArtifacts).toContainEqual({
      id: "code:src/feature.ts", fromRevision: 2, toRevision: 1,
    });
    expect(task.attempts![0].status, "被回滚的 attempt 标记 rolled_back").toBe("rolled_back");
    expect(rolled.rollback.reason).toContain("方向");

    const second = claimTask(team, "t1", "实现者");
    expect(second.attempt, "重新领取开新代").toBe(2);
    expect(task.claim!.attempt).toBe(2);
    expect(task.attempts).toHaveLength(2);
    expect(task.status).toBe("claimed");
  });

  it("回滚必须写原因（不能静默回滚），且没有 attempt 的任务不能回滚", () => {
    const team = makeTeam();
    createTask(team, { subject: "x" });
    expect(() => rollbackTask(team, "t1", { by: "实现者", reason: "  " })).toThrow(/原因/);
    expect(() => rollbackTask(team, "t1", { by: "实现者", reason: "没领取过" })).toThrow(/no attempt/);
  });
});

describe("C10-2 Agent 任务切片不含父会话全文", () => {
  it("切片只含任务/依赖/工件/判据，父会话与无关任务的内容一个字都不进 prompt", () => {
    const team = makeTeam();
    createTask(team, { subject: "前置：调研方案" });                     // t1
    const { task } = createTask(team, {
      subject: "实现登录页", description: "只做登录页", dependencies: ["t1"],
      acceptance: "代码 + 文档 + 测试 + 引用",
    });                                                                  // t2
    createTask(team, { subject: "UNRELATED-TASK-SENTINEL-不要进切片" }); // t3
    task.artifacts = [{
      id: "code:src/login.tsx", kind: "code", ref: "src/login.tsx", revision: 3,
      updatedAt: Date.now(),
    }];

    const parentMessages = [
      { id: "p1", role: "user", content: "PARENT-CHAT-SENTINEL-队长的整段聊天" },
      { id: "p2", role: "assistant", content: "PARENT-REASONING-SENTINEL-实现者的推理" },
    ];
    const slice = buildTaskSlice({
      team, task, memberName: "实现者", role: "实现",
      parentMessages,
      notes: "只改登录页的样式，别动路由",
    });

    // 任务相关内容在
    expect(slice.prompt).toContain("实现登录页");
    expect(slice.prompt).toContain("只做登录页");
    expect(slice.prompt).toContain("前置：调研方案");
    expect(slice.prompt).toContain("src/login.tsx");
    expect(slice.prompt).toContain("只改登录页的样式");
    // 父会话整段聊天 / 无关任务不在
    expect(slice.prompt).not.toContain("PARENT-CHAT-SENTINEL");
    expect(slice.prompt).not.toContain("PARENT-REASONING-SENTINEL");
    expect(slice.prompt).not.toContain("UNRELATED-TASK-SENTINEL");
    // 结构性声明（不是靠提示词自觉）
    expect(slice.includesParentConversation).toBe(false);
    expect(slice.includedParentMessages).toBe(0);
    expect(slice.parentMessageCount).toBe(2);
    expect(slice.artifactRefs).toEqual(["code:src/login.tsx@r3"]);
  });
});

describe("C10-3 Verifier 独立上下文 + 独立角色", () => {
  it("实现者的 output/推理不进入 Verifier；Verifier=实现者 ⇒ fail；独立 Verifier ⇒ pass", () => {
    const team = makeTeam();
    createTask(team, { subject: "实现搜索", acceptance: "四类证据" });
    const claimed = startTask(team, "t1", "实现者");
    const task = team.tasks[0];
    task.output = "IMPLEMENTER-SELF-REVIEW-SENTINEL-我自己觉得全做完了";
    task.attempts![0].output = "IMPLEMENTER-REASONING-SENTINEL-我的推理过程";

    const same = runTaskVerification(task, { verifier: "实现者" });
    expect(same.verdict, "Verifier 不能同时是实现者").toBe("fail");
    expect(same.checks.find((c) => c.id === "VERIFIER-INDEPENDENT")!.ok).toBe(false);
    expect(JSON.stringify(same), "自评/推理不能进入检查上下文").not.toContain("IMPLEMENTER-SELF-REVIEW-SENTINEL");
    expect(JSON.stringify(same)).not.toContain("IMPLEMENTER-REASONING-SENTINEL");

    const independent = runTaskVerification(task, { verifier: "验收员" });
    expect(independent.verdict).toBe("pass");
    expect(independent.context.implementer).toBe("实现者");
    expect(independent.context.evidence.map((e) => e.ref)).toEqual(FULL_EVIDENCE.map((e) => e.ref));
    expect(independent.evidence.join(","), "pass 必须给出证据坐标").toContain("src/feature.ts");
    expect(independent.evidence.join(",")).toContain("doc-sync:");
    expect(JSON.stringify(independent), "独立 Verifier 结果同样不含实现者自评").not.toContain("IMPLEMENTER-SELF-REVIEW-SENTINEL");
    expect(independent.verifier).not.toBe(claimed.attemptId);
  });
});

describe("C10-4 文档未同步 ⇒ 任务不得完成", () => {
  it("四类证据 + Verifier 都齐了，但 docSync=false ⇒ blocked、状态保持 in_progress；同步后才 completed", () => {
    const team = makeTeam();
    createTask(team, { subject: "改接口文档与代码", acceptance: "文档必须同步" });
    const claimed = startTask(team, "t1", "实现者");
    expect(verifyTask(team, "t1").verdict).toBe("pass");

    const task = team.tasks[0];
    task.docSync = { synced: false, reason: "文档版本落后于代码（C06 判定）" };
    const blocked = updateTask(team, "t1", { status: "completed", attemptId: claimed.attemptId, by: "实现者" });
    expect(blocked.blocked, "必须明确 blocked").toBeTruthy();
    expect(blocked.blocked!.missing, "证据类别没缺").toEqual([]);
    expect(blocked.blocked!.reasons.join("；")).toMatch(/文档未同步/);
    expect(task.status, "文档未同步时状态不能变成 completed").toBe("in_progress");
    expect(task.blockedReason).toMatch(/文档未同步/);

    // 反向对照：文档同步后同一份证据/Verifier 可以完成
    task.docSync = { synced: true, reason: "文档已随代码更新" };
    updateTask(team, "t1", { status: "completed", attemptId: claimed.attemptId, by: "实现者" });
    expect(task.status).toBe("completed");
    expect(task.blockedReason).toBeUndefined();
  });

  it("可注入的 C06 谓词：返回 false 就阻塞（不是只有任务字段能拦）", () => {
    const team = makeTeam();
    createTask(team, { subject: "接 C06 谓词" });
    const claimed = startTask(team, "t1", "实现者");
    verifyTask(team, "t1");

    const docSyncCheck = () => ({ synced: false, reason: "C06: docs/ADR-0008.md 未同步" });
    const blocked = updateTask(
      team, "t1",
      { status: "completed", attemptId: claimed.attemptId, by: "实现者" },
      { docSyncCheck },
    );
    expect(blocked.blocked!.reasons.join("；")).toMatch(/C06/);
    expect(team.tasks[0].status).toBe("in_progress");

    const ok = updateTask(
      team, "t1",
      { status: "completed", attemptId: claimed.attemptId, by: "实现者" },
      { docSyncCheck: () => ({ synced: true, reason: "已同步" }) },
    );
    expect(ok.blocked).toBeUndefined();
    expect(team.tasks[0].status).toBe("completed");
  });
  it("服务层可注入 C06 谓词：Verifier 之后文档才变旧，完成门禁仍会拦住", async () => {
    AgentTeamsService._reset();
    localStorage.clear();
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "C06 接线队", captainSessionId: "cap-c06" });
    await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: "cap-c06" });
    const { task } = svc.createTask(team.id, { subject: "代码完成但文档落后", acceptance: "文档必须同步" });
    const claimed = svc.claim(team.id, task.id, "实现者");
    await svc.update(team.id, task.id, {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者", evidence: FULL_EVIDENCE,
    });
    // 先按"文档已同步"通过 Verifier
    svc.setDocSyncCheck(() => ({ synced: true, reason: "检查时已同步" }));
    expect((await svc.verify(team.id, task.id, "独立验收员")).verification.verdict).toBe("pass");
    // 之后文档落后（C06 谓词翻转）⇒ 完成门禁必须按完成那一刻的事实再拦一次
    svc.setDocSyncCheck(() => ({ synced: false, reason: "C06: docs/feature.md 落后于代码" }));
    const blocked = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者", evidence: FULL_EVIDENCE,
    });
    expect(blocked.blocked, "文档未同步必须 blocked").toBeTruthy();
    expect(blocked.blocked!.reasons.join("；")).toMatch(/文档未同步|C06/);
    expect(svc.get(team.id)!.tasks[0].status).toBe("in_progress");
    svc.setDocSyncCheck(undefined);
  });
});

describe("C10-5 缺测试/引用 ⇒ 不完成（四类证据缺一不可）", () => {
  it("只有 code+doc ⇒ blocked 且缺 test/reference；补 test（fail 不算）与 reference 后才完成", () => {
    const team = makeTeam();
    createTask(team, { subject: "补四类证据" });
    const claimed = startTask(team, "t1", "实现者", [
      { kind: "code", ref: "src/feature.ts" },
      { kind: "doc", ref: "docs/feature.md" },
    ]);
    const task = team.tasks[0];

    const blocked1 = updateTask(team, "t1", { status: "completed", attemptId: claimed.attemptId, by: "实现者" });
    expect(blocked1.blocked!.missing.sort()).toEqual(["reference", "test"]);
    expect(task.status).toBe("in_progress");

    // 失败的测试不能当证据
    updateTask(team, "t1", {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
      evidence: [
        { kind: "test", ref: "npx vitest run src/test/feature.test.ts", status: "fail" },
        { kind: "reference", ref: "issue#42" },
      ],
    });
    expect(task.status, "test 证据 fail 时仍不能完成").toBe("in_progress");
    expect(task.blockedReason).toMatch(/测试/);

    // 测试转 pass + 独立 Verifier ⇒ 完成
    updateTask(team, "t1", {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者",
      evidence: [{ kind: "test", ref: "npx vitest run src/test/feature.test.ts", status: "pass" }],
    });
    expect(verifyTask(team, "t1").verdict).toBe("pass");
    updateTask(team, "t1", { status: "completed", attemptId: claimed.attemptId, by: "实现者" });
    expect(task.status).toBe("completed");
    expect(snapshot(team).tasks[0].evidenceKinds.sort()).toEqual(["code", "doc", "reference", "test"]);
    expect(snapshot(team).tasks[0].verified).toBe(true);
  });

  it("缺 Verifier 也不能完成（四类证据齐了但没人独立检查）", () => {
    const team = makeTeam();
    createTask(team, { subject: "没有 Verifier" });
    const claimed = startTask(team, "t1", "实现者");
    const blocked = updateTask(team, "t1", { status: "completed", attemptId: claimed.attemptId, by: "实现者" });
    expect(blocked.blocked!.reasons.join("；")).toMatch(/Verifier/);
    expect(team.tasks[0].status).toBe("in_progress");
  });
});

describe("C10-6 服务层共享任务图/工件（状态快照）", () => {
  beforeEach(() => {
    AgentTeamsService._reset();
    localStorage.clear();
  });

  it("snapshot 暴露 claim/attempts/artifacts/evidence/verified；服务层完成链路与回滚可用", async () => {
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "C10 服务队", captainSessionId: "cap-svc" });
    await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: "cap-svc" });
    const { task } = svc.createTask(team.id, { subject: "服务层实现", acceptance: "四类证据" });
    const claimed = svc.claim(team.id, task.id, "实现者");
    await svc.update(team.id, task.id, {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者", evidence: FULL_EVIDENCE,
    });
    const { verification } = await svc.verify(team.id, task.id, "队长验收员");
    expect(verification.verdict).toBe("pass");
    const done = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者", output: "done", evidence: FULL_EVIDENCE,
    });
    expect(done.blocked).toBeUndefined();
    expect(done.task.status).toBe("completed");

    const snap = svc.status(team.id).tasks.find((t) => t.id === task.id)!;
    expect(snap.claimBy).toBe("实现者");
    expect(snap.attempts).toBe(1);
    expect(snap.artifacts.map((a) => `${a.kind}:${a.ref}`).sort()).toEqual(FULL_EVIDENCE.map((e) => `${e.kind}:${e.ref}`).sort());
    expect(snap.evidenceKinds.sort()).toEqual(["code", "doc", "reference", "test"]);
    expect(snap.verified).toBe(true);

    // 完成后仍可回滚（回到上一版工件/状态），任务重新进入共享池
    const rolled = svc.rollback(team.id, task.id, { by: "队长", reason: "上线后发现文档与实现不一致" });
    expect(rolled.task.status).toBe("pending");
    expect(rolled.task.artifacts).toHaveLength(0); // 领取前没有任何工件
    expect(rolled.rollback.attempt).toBe(1);
    expect(svc.status(team.id).tasks.find((t) => t.id === task.id)!.rollbacks).toBe(1);
  });
});

/**
 * C10-4b：**默认服务**接真实 C06 账本（不是可注入谓词的自娱自乐）。
 *
 * 变异点（每条都能让判据变红）：
 * - 把默认注入去掉（`docSyncPredicateFor` 恒返回 undefined）⇒ 文档变了仍能完成 ⇒ 红；
 * - 把结果强制 `synced:true` ⇒ 同上 ⇒ 红；
 * - 无文档引用/无账本时强制 `checked:true`（假装检查）⇒ 反向用例红。
 */
describe("C10-4b 默认接真实 C06 文档账本", () => {
  beforeEach(() => {
    AgentTeamsService._reset();
    localStorage.clear();
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  afterEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  it("真实 ledger：文档读过之后变了 ⇒ completed 被 blocked（reason 可见）；重新同步后 ⇒ 可完成", async () => {
    const doc = makeDoc({ id: "doc_1", name: "设计说明.md", updated_at: 100 });
    setDocumentBackend(createFakeDocumentBackend({ documents: [doc] }).backend);

    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "C06 接线队", captainSessionId: "cap-doc" });
    const { member } = await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: "cap-doc" });
    // 实现者的会话账本：读到「设计说明.md」时它是 version 100
    const collection = collectionIdForSession(member.id);
    recordDocumentOutline({
      collectionId: collection, documentId: "doc_1", documentName: "设计说明.md",
      headings: ["接口契约"], updatedAt: 100,
    });
    recordDocumentSection({
      collectionId: collection, documentId: "doc_1", headingPath: "接口契约", status: "verified",
    });

    const { task } = svc.createTask(team.id, { subject: "改接口并同步文档", acceptance: "文档必须同步" });
    const claimed = svc.claim(team.id, task.id, "实现者");
    await svc.update(team.id, task.id, {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者", evidence: FULL_EVIDENCE,
    });
    expect((await svc.verify(team.id, task.id, "独立验收员")).verification.verdict).toBe("pass");

    // 文档在读过之后变了（100 → 200）：默认服务必须用真实 C06 账本拦住完成
    doc.updated_at = 200;
    const blocked = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    expect(blocked.blocked, "真实账本判定未同步时必须 blocked").toBeTruthy();
    expect(blocked.blocked!.reasons.join("；"), "reason 要指出文档未同步").toMatch(/文档未同步/);
    expect(blocked.blocked!.reasons.join("；"), "reason 要指出是哪份文档").toMatch(/设计说明\.md/);
    expect(svc.get(team.id)!.tasks[0].status, "未同步时状态保持 in_progress").toBe("in_progress");
    expect(svc.get(team.id)!.tasks[0].blockedReason).toMatch(/文档未同步/);

    // 文档同步后（重新读到 version 200 并核对）⇒ 同一份证据可以完成
    __resetDocumentLedgerForTests();
    recordDocumentOutline({
      collectionId: collection, documentId: "doc_1", documentName: "设计说明.md",
      headings: ["接口契约"], updatedAt: 200,
    });
    recordDocumentSection({
      collectionId: collection, documentId: "doc_1", headingPath: "接口契约", status: "verified",
    });
    const done = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    expect(done.blocked, "同步后不该再阻塞").toBeUndefined();
    expect(done.task.status).toBe("completed");
    expect(done.task.blockedReason).toBeUndefined();
  });

  it("无文档引用 / 无账本时 checked:false（不假装检查），也不因 docSync 阻塞", async () => {
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "无文档队", captainSessionId: "cap-nodoc" });
    await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: "cap-nodoc" });
    const { task } = svc.createTask(team.id, {
      subject: "纯代码任务",
      requiredEvidence: ["code", "test", "reference"],
    });
    const claimed = svc.claim(team.id, task.id, "实现者");
    const noDocEvidence = [
      { kind: "code" as const, ref: "src/feature.ts" },
      { kind: "test" as const, ref: "npx vitest run src/test/feature.test.ts", status: "pass" as const },
      { kind: "reference" as const, ref: "issue#42" },
    ];
    await svc.update(team.id, task.id, {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者", evidence: noDocEvidence,
    });
    expect((await svc.verify(team.id, task.id, "独立验收员")).verification.verdict).toBe("pass");
    const done = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者", evidence: noDocEvidence,
    });
    expect(done.blocked, "没有文档引用时 docSync 不该阻塞").toBeUndefined();
    expect(done.task.status).toBe("completed");

    // 直接量谓词本身：没有文档引用 ⇒ 未检查（不是"已同步"）
    const helperTeam = makeTeam();
    const { task: helperTask } = createTask(helperTeam, { subject: "纯代码" });
    const noRefs = await checkTaskDocumentSync({
      team: helperTeam, task: helperTask, evidence: [FULL_EVIDENCE[0]], by: "实现者",
    });
    expect(noRefs.checked, "没有文档引用 ⇒ checked:false").toBe(false);
    expect(noRefs.synced, "没有文档引用 ⇒ 不阻塞").toBe(true);

    // 有文档引用但没有账本 ⇒ 也未检查（同样不阻塞），reason 要说明原因
    const { task: docTask } = createTask(helperTeam, { subject: "有文档引用" });
    const noLedger = await checkTaskDocumentSync({
      team: helperTeam, task: docTask, evidence: [FULL_EVIDENCE[1]], by: "实现者",
    });
    expect(noLedger.checked, "没有账本 ⇒ checked:false").toBe(false);
    expect(noLedger.synced).toBe(true);
    expect(noLedger.reason, "reason 要说清是「没有账本」而不是假装同步").toMatch(/账本/);

    /*
     * 账本里只有检索命中（`doc_search` 不记版本）⇒ 仍然算「未检查」。
     * 这条是防永久卡死的反向判据：C06 的 documentSyncCheck 对「没记版本」也返回
     * ok=false，若直接拿 ok 当门禁，只搜到过、没读过版本的文档会让任务永远完不成。
     */
    recordDocumentRead({
      collectionId: collectionIdForSession("cap-c10"),
      documentId: "doc_9",
      documentName: "只有检索命中的文档.md",
      chunkNo: 0,
    });
    const versionless = await checkTaskDocumentSync({
      team: helperTeam, task: docTask, evidence: [FULL_EVIDENCE[1]], by: "实现者",
    });
    expect(versionless.checked, "没有版本事实 ⇒ checked:false").toBe(false);
    expect(versionless.synced, "没有版本事实 ⇒ 不阻塞").toBe(true);
    expect(versionless.reason).toMatch(/版本/);
  });
});

/**
 * C10-4c：**文档同步覆盖全体成员**（不只实现者 + 队长）。
 *
 * 被守的缺陷：文档账本按会话集合存，Verifier / specialist 读过的文档只记在**他们自己**
 * 的账本里。只查实现者 + 队长时，「团队里有人拿着旧文档验收」也能完成 —— 而完成门禁
 * 恰恰是拿这些账本当证据的。
 *
 * 变异点（每条都能让判据变红）：
 * - 收集范围退回实现者 + 队长 ⇒ 第一条（验收员账本落后）不再 blocked ⇒ 红；
 * - 只要有**任一**账本同步就放行（不是逐个成员都要求）⇒ 第一条红；
 * - 把「只有检索命中、没有版本」也当未同步 ⇒ 第三条红（任务会被永久卡住）。
 */
describe("C10-4c 文档同步覆盖团队全体成员", () => {
  beforeEach(() => {
    AgentTeamsService._reset();
    localStorage.clear();
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  afterEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  /** 给某个会话的账本记一份文档版本（`recordDocumentOutline` 会写 updatedAt/sha256） */
  function recordVersioned(
    collectionId: string,
    updatedAt: number,
    name = "设计说明.md",
  ): void {
    recordDocumentOutline({
      collectionId,
      documentId: "doc_1",
      documentName: name,
      headings: ["接口契约"],
      updatedAt,
    });
  }

  /** 建一支「实现者 + 验收员 + 调研员」的队，返回服务、团队与会话几何 */
  async function makeMemberTeam(captainSessionId: string) {
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "全体成员文档队", captainSessionId });
    const impl = await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: captainSessionId });
    const verifier = await svc.addMember(team.id, { name: "验收员", role: "验证", parentSessionId: captainSessionId });
    const specialist = await svc.addMember(team.id, { name: "调研员", role: "调研", parentSessionId: captainSessionId });
    return {
      svc,
      team,
      implCollection: collectionIdForSession(impl.member.id),
      verifierCollection: collectionIdForSession(verifier.member.id),
      specialistCollection: collectionIdForSession(specialist.member.id),
    };
  }

  /** 领取 → in_progress（四类证据）→ 独立 Verifier 通过 */
  async function startAndVerify(
    svc: AgentTeamsService,
    teamId: string,
    taskId: string,
    verifier: string,
  ) {
    const claimed = svc.claim(teamId, taskId, "实现者");
    await svc.update(teamId, taskId, {
      status: "in_progress", attemptId: claimed.attemptId, by: "实现者", evidence: FULL_EVIDENCE,
    });
    const verification = (await svc.verify(teamId, taskId, verifier)).verification;
    expect(verification.verdict, "前提：独立 Verifier 通过").toBe("pass");
    return claimed;
  }

  it("非实现者成员（验收员）的账本里文档落后 ⇒ completed 被 blocked，reason 点名成员与文档", async () => {
    const doc = makeDoc({ id: "doc_1", name: "设计说明.md", updated_at: 100 });
    setDocumentBackend(createFakeDocumentBackend({ documents: [doc] }).backend);

    const { svc, team, implCollection, verifierCollection } = await makeMemberTeam("cap-all");
    // 两个成员都读过 version 100
    recordVersioned(implCollection, 100);
    recordVersioned(verifierCollection, 100);

    const { task } = svc.createTask(team.id, {
      subject: "改接口并同步文档",
      acceptance: "文档必须同步",
    });
    const claimed = await startAndVerify(svc, team.id, task.id, "验收员");

    // 文档变旧；实现者重新读过（同步），验收员仍停在 100 —— 只有非实现者落后
    doc.updated_at = 200;
    __resetDocumentLedgerForTests();
    recordVersioned(implCollection, 200);
    recordVersioned(verifierCollection, 100);

    const blocked = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    const reasons = blocked.blocked?.reasons.join("；") ?? "";
    expect(blocked.blocked, "验收员账本落后必须 blocked（只查实现者 + 队长会漏掉它）").toBeTruthy();
    expect(reasons, "reason 要指出文档未同步").toMatch(/文档未同步/);
    expect(reasons, "reason 要点名落后的成员").toContain("验收员");
    expect(reasons, "reason 要点名是哪份文档").toContain("设计说明.md");
    expect(svc.get(team.id)!.tasks[0].status, "未同步时状态保持 in_progress").toBe("in_progress");
  });

  it("所有成员（实现者 / 验收员 / 调研员）的账本都同步 ⇒ 可以完成", async () => {
    const doc = makeDoc({ id: "doc_1", name: "设计说明.md", updated_at: 200 });
    setDocumentBackend(createFakeDocumentBackend({ documents: [doc] }).backend);

    const { svc, team, implCollection, verifierCollection, specialistCollection } =
      await makeMemberTeam("cap-all-synced");
    for (const collection of [implCollection, verifierCollection, specialistCollection]) {
      recordVersioned(collection, 200);
    }

    const { task } = svc.createTask(team.id, { subject: "全员同步", acceptance: "文档必须同步" });
    const claimed = await startAndVerify(svc, team.id, task.id, "验收员");
    const done = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    expect(done.blocked, "所有成员账本都同步时不该阻塞").toBeUndefined();
    expect(done.task.status).toBe("completed");
  });

  it("只有检索命中、没有版本事实的成员账本不阻塞（防永久卡死）", async () => {
    const doc = makeDoc({ id: "doc_1", name: "设计说明.md", updated_at: 200 });
    setDocumentBackend(createFakeDocumentBackend({ documents: [doc] }).backend);

    const { svc, team, implCollection, verifierCollection } = await makeMemberTeam("cap-versionless");
    // 实现者：版本化且同步；验收员：只有 doc_search 命中（没有 updatedAt/sha256）
    recordVersioned(implCollection, 200);
    recordDocumentRead({
      collectionId: verifierCollection,
      documentId: "doc_1",
      documentName: "设计说明.md",
      chunkNo: 0,
    });

    const { task } = svc.createTask(team.id, { subject: "检索过但没记版本", acceptance: "文档必须同步" });
    const claimed = await startAndVerify(svc, team.id, task.id, "验收员");

    // 直接量谓词：验收员账本没有版本事实 ⇒ 不参与比对、不阻塞
    const probe = await checkTaskDocumentSync({
      team, task, evidence: [FULL_EVIDENCE[1]], by: "实现者",
    });
    expect(probe.checked, "实现者有版本事实 ⇒ checked:true").toBe(true);
    expect(probe.synced, "只有检索命中的成员账本不该阻塞").toBe(true);

    // 全员账本都只有检索命中 ⇒ checked:false（不假装检查过），但仍不阻塞
    __resetDocumentLedgerForTests();
    recordDocumentRead({
      collectionId: implCollection,
      documentId: "doc_1",
      documentName: "设计说明.md",
      chunkNo: 0,
    });
    recordDocumentRead({
      collectionId: verifierCollection,
      documentId: "doc_1",
      documentName: "设计说明.md",
      chunkNo: 0,
    });
    const allVersionless = await checkTaskDocumentSync({
      team, task, evidence: [FULL_EVIDENCE[1]], by: "实现者",
    });
    expect(allVersionless.checked, "全员都只有检索命中 ⇒ checked:false").toBe(false);
    expect(allVersionless.synced, "没有版本事实 ⇒ 不阻塞").toBe(true);
    expect(allVersionless.reason).toMatch(/版本/);

    // 恢复成「实现者版本化」再走完成链路：验收员仍只有检索命中，不能因此阻塞
    __resetDocumentLedgerForTests();
    recordVersioned(implCollection, 200);
    recordDocumentRead({
      collectionId: verifierCollection,
      documentId: "doc_1",
      documentName: "设计说明.md",
      chunkNo: 0,
    });
    const done = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    expect(done.blocked, "检索命中不构成版本事实，不能阻塞完成").toBeUndefined();
    expect(done.task.status).toBe("completed");
  });

  it("检查器抛错 ⇒ fail-closed（completed 被 blocked），不静默放行", async () => {
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "检查器崩溃队", captainSessionId: "cap-throw" });
    await svc.addMember(team.id, { name: "实现者", role: "实现", parentSessionId: "cap-throw" });
    const { task } = svc.createTask(team.id, { subject: "检查器崩溃", acceptance: "文档必须同步" });
    const claimed = await startAndVerify(svc, team.id, task.id, "独立验收员");

    svc.setDocSyncCheck(() => {
      throw new Error("C06 检查器崩了");
    });
    const blocked = await svc.update(team.id, task.id, {
      status: "completed", attemptId: claimed.attemptId, by: "实现者",
    });
    const reasons = blocked.blocked?.reasons.join("；") ?? "";
    expect(blocked.blocked, "检查器抛错不能当作已同步").toBeTruthy();
    expect(reasons, "reason 要如实说是检查执行失败").toMatch(/执行失败/);
    expect(reasons).toContain("C06 检查器崩了");
    expect(svc.get(team.id)!.tasks[0].status).toBe("in_progress");
    svc.setDocSyncCheck(undefined);
  });
});
