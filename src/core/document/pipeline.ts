/**
 * 长文档编译流水线（C07）—— **大纲 → 分节 → 合并 → 一致性 → 引用验证 → 覆盖检查 → diff**。
 *
 * ## 为什么不是「再写一个 agent 循环」
 *
 * 这里只做**阶段机**：每个阶段都有确定的输入/产物/校验结果，没有模型调用。
 * 分节内容由调用方（`doc_compile` 工具、未来的 UI）填进来，阶段机负责三件事：
 *
 * 1. **禁止跳级**：第 N 阶段只有在第 N-1 阶段 `done` 之后才能执行 ——
 *    「合并」不会发生在「所有分节都交齐」之前，「引用验证」不会跳过「一致性」。
 * 2. **每阶段留证据**：`{stage, ok, at, summary, artifacts:[{name,digest,bytes}]}`。
 *    产物摘要（稳定 digest）是「这一阶段的输出真的存在且是本轮的」的可复核凭据。
 * 3. **未完成不冒充完成**：`snapshot.complete` 只有在**全部**阶段 `done`
 *    且没有 `failed` 时才为 true；失败会停在原地并给出 `blockedBy`（具体到阶段/原因）。
 *
 * ## 与 `goal/runner` 的关系
 *
 * Goal Runner 承载的是「目标 → 里程碑 DAG」，它的阶段验收是命令/文件（`Acceptance`）。
 * 文档编译需要的是**分节 job 的交付物**（正文 + 引用），验收是结构校验（覆盖/引用/一致性），
 * 与命令退出码不是同一种东西。所以这里是**等价的阶段机**（同样的三条纪律：
 * 顺序、证据、未完成不完成），而不是把文档编译硬塞进 goal 契约。
 *
 * ## 状态存放（C07 边界①：进程内 → 落盘）
 *
 * 内存里仍是模块级 `Map`（键 `sessionId::documentId`，与 ledger 同思路：跟段号无关，
 * 压缩/换段不会把已交付的分节丢掉）；**同时**按会话落到设置键
 * `codem-document-pipeline:<sessionId>`（见下面的「持久化」一节）。
 *
 * 为什么必须落盘：阶段机原来只活在进程内 ⇒ 关一次应用，`doc_compile status` 就回答
 * 「还没有流水线」，已交付的分节白交、merge 之后的所有阶段全部丢失。用户看到的是
 * 「编译到一半，重启就没了」，而这正是 C07 的边界之一。
 *
 * 读回时**校验版本与阶段顺序**：坏 JSON / 乱序阶段一律按「从未开始」处理并 `console.warn`
 * （宁可让用户重跑 plan，也不许把一份来路不明的状态当成已完成的证据）。
 */

import { getSetting, getSettingJSON, setSettingJSON } from "../storage/settings";

/** 阶段顺序（唯一来源：顺序判据与「禁止跳级」都用它）。 */
export const DOC_PIPELINE_STAGES = [
  "outline",
  "sections",
  "merge",
  "consistency",
  "citations",
  "coverage",
  "diff",
] as const;

export type DocPipelineStage = (typeof DOC_PIPELINE_STAGES)[number];
type DocStageStatus = "pending" | "done" | "failed";
type DocSectionStatus = "pending" | "done" | "failed";

interface DocStageArtifact {
  name: string;
  /** 稳定摘要（FNV-1a 双 32 位；只用于「产物是否就是这一份」的比对） */
  digest: string;
  bytes: number;
}

interface DocStageEvidence {
  stage: DocPipelineStage;
  ok: boolean;
  at: number;
  summary: string;
  artifacts: DocStageArtifact[];
  /** 失败时的**具体**原因（阶段名 + 期望/实际），不写「失败了」 */
  error?: string;
}

interface DocSectionJob {
  id: string;
  order: number;
  heading: string;
  page?: number;
  status: DocSectionStatus;
  attempts: number;
  /** 交付的正文（未交付为 undefined） */
  content?: string;
  /** 本节引用的 citation 字符串（`file: … | page: … | §… | chunk: …`） */
  citations: string[];
  updatedAt?: number;
  /** 最近一次失败原因（重试时原样返回，不覆盖历史证据） */
  lastError?: string;
}

interface DocMergePlanEntry {
  sectionId: string;
  heading: string;
  /** 在合并文本里的字节区间（UTF-8 以字符计；用于回溯到分节） */
  from: number;
  to: number;
}

/**
 * diff 的**摘要**（持久化只存这个，不存整份 patch）。
 *
 * 为什么：补丁正文只服务「这一次查看」；重启后要回答的是「最近一次 diff 改了多少」。
 * 把整份 patch 写进设置键会让设置面跟着稿件长度一起膨胀（而且 patch 可以由合并稿重算）。
 */
export interface DocPipelineDiffSummary {
  /** 补丁总行数 */
  lines: number;
  added: number;
  removed: number;
  baseline: "supplied" | "none";
  at: number;
}

interface DocPipelineSnapshot {
  sessionId: string;
  documentId: string;
  title: string;
  stages: Array<{ stage: DocPipelineStage; status: DocStageStatus }>;
  sections: DocSectionJob[];
  sectionProgress: { total: number; done: number; pending: number; failed: number };
  mergePlan: DocMergePlanEntry[];
  evidence: DocStageEvidence[];
  complete: boolean;
  /** 未完成时：卡在哪一阶段、为什么（空数组 = 已完成） */
  blockedBy: Array<{ stage: DocPipelineStage; reason: string }>;
  /** diff 产物（`diff` 阶段完成后才有；重启后只有 `diffSummary`） */
  diff?: string;
  /** diff 摘要（重启后仍在；UI/status 用它回答「最近改了多少」） */
  diffSummary?: DocPipelineDiffSummary;
  baseline: "supplied" | "none";
  createdAt: number;
  updatedAt: number;
}

interface PipelineState {
  sessionId: string;
  documentId: string;
  title: string;
  baselineText?: string;
  stages: Map<DocPipelineStage, DocStageStatus>;
  sections: Map<string, DocSectionJob>;
  evidence: DocStageEvidence[];
  merged?: string;
  mergePlan: DocMergePlanEntry[];
  diff?: string;
  diffSummary?: DocPipelineDiffSummary;
  createdAt: number;
  updatedAt: number;
}

const pipelines = new Map<string, PipelineState>();

function keyOf(sessionId: string, documentId: string): string {
  return `${sessionId}::${documentId}`;
}

/** 稳定摘要（不引 crypto：渲染侧与判据用同一份实现）。 */
function digestOfText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 2654435761) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function stageIndex(stage: DocPipelineStage): number {
  return DOC_PIPELINE_STAGES.indexOf(stage);
}

/** 某阶段的「前一阶段」；`outline` 没有前一阶段。 */
function previousStage(stage: DocPipelineStage): DocPipelineStage | null {
  const i = stageIndex(stage);
  return i > 0 ? DOC_PIPELINE_STAGES[i - 1] : null;
}

function artifact(name: string, text: string): DocStageArtifact {
  return { name, digest: digestOfText(text), bytes: text.length };
}

function stamp(state: PipelineState): void {
  state.updatedAt = Date.now();
}

// ═══════════════════════════ 持久化（C07 边界①） ═══════════════════════════

/**
 * 设置键前缀：**一个会话一个键**（`codem-document-pipeline:<sessionId>`）。
 *
 * 为什么不按文档一个键：一次编译任务属于一个会话；按会话收口只需要一次读/写，
 * 也避免同一会话的多份文档各占一个设置项。
 */
const PIPELINE_SETTING_PREFIX = "codem-document-pipeline:";

/**
 * 持久化形状版本。**改字段语义必须 +1**：读回时版本不符按「从未开始」处理并 warn，
 * 这样旧版本留下的状态不会以「看起来能读」的形态混进新的阶段判据。
 */
const PIPELINE_STATE_VERSION = 1;

/**
 * 写入去抖：一次编译里 plan/submit/每个 stage 都会改状态，逐次落盘会把同一个键
 * 反复写（`submit` 一个分节一次）。去抖窗口内的多次改动合并成一次写。
 *
 * 代价（如实写）：进程在窗口内被强杀会丢最后一次改动 —— 关闭/隐藏页面时
 * `flushDocumentPipelinePersistence()` 会把待写内容立刻落盘，窗口只剩真正的崩溃。
 */
const PERSIST_DEBOUNCE_MS = 300;

/**
 * 持久化的单个文档状态（**摘要**：不含完整证据历史，只留可复核的产物 digest）。
 *
 * 代价（如实写）：为了「重启后还能继续 merge / 继续 diff」，分节正文与基线文本也会落盘 ——
 * 设置键的大小会随稿件长度增长。长文档编译是低频动作（一个会话一份文档一次），
 * 换来的是「关掉应用不用从头再交一遍分节」；补丁正文与完整证据历史不落盘。
 */
interface PersistedPipelineDocument {
  documentId: string;
  title: string;
  stages: Array<{ stage: DocPipelineStage; status: DocStageStatus }>;
  sections: Array<{
    id: string;
    order: number;
    heading: string;
    page?: number;
    status: DocSectionStatus;
    attempts: number;
    citations: string[];
    /** 分节正文（重启后继续 merge 需要；没有它就只能算「未交付」） */
    content?: string;
  }>;
  artifacts: Array<{ stage: DocPipelineStage; name: string; digest: string; bytes: number }>;
  mergePlan: DocMergePlanEntry[];
  /** 失败阶段的**具体原因**（重启后 status 仍能说清卡在哪、为什么） */
  failure?: { stage: DocPipelineStage; error: string };
  /** diff 摘要（补丁正文不落盘；合并稿可由分节重算） */
  diffSummary?: DocPipelineDiffSummary;
  baselineText?: string;
  baseline: "supplied" | "none";
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 一个会话的持久化文件。 */
interface PersistedPipelineFile {
  version: number;
  sessionId: string;
  documents: PersistedPipelineDocument[];
  updatedAt: number;
}

/** 已从持久化读过的会话（避免每次 status 都重新解析整份 JSON）。 */
const loadedSessions = new Set<string>();
/** 待写会话 → 去抖定时器。 */
const pendingPersist = new Map<string, ReturnType<typeof setTimeout>>();
/** 页面关闭钩子只装一次（装的时候还没有任何待写内容也无害）。 */
let unloadHookInstalled = false;

function settingKeyOf(sessionId: string): string {
  return `${PIPELINE_SETTING_PREFIX}${sessionId}`;
}

/** 某个 stage 的产物（取**最近一次成功**证据；重启后它就是那一份摘要）。 */
function artifactsOfStage(state: PipelineState, stage: DocPipelineStage): DocStageArtifact[] {
  const evidence = [...state.evidence].reverse().find((e) => e.stage === stage && e.ok);
  return evidence?.artifacts ?? [];
}

/** 快照 → 持久化文档（只保留可复核的摘要，不写完整证据历史）。 */
function toPersistedDocument(state: PipelineState): PersistedPipelineDocument {
  const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
  const artifacts: PersistedPipelineDocument["artifacts"] = [];
  for (const stage of DOC_PIPELINE_STAGES) {
    for (const item of artifactsOfStage(state, stage)) {
      artifacts.push({ stage, name: item.name, digest: item.digest, bytes: item.bytes });
    }
  }
  const failedStage = DOC_PIPELINE_STAGES.find((stage) => state.stages.get(stage) === "failed");
  const failure = failedStage
    ? [...state.evidence].reverse().find((e) => e.stage === failedStage && !e.ok)
    : undefined;
  return {
    documentId: state.documentId,
    title: state.title,
    stages: DOC_PIPELINE_STAGES.map((stage) => ({ stage, status: state.stages.get(stage) ?? "pending" })),
    sections: sections.map((section) => ({
      id: section.id,
      order: section.order,
      heading: section.heading,
      ...(typeof section.page === "number" ? { page: section.page } : {}),
      status: section.status,
      attempts: section.attempts,
      citations: [...section.citations],
      ...(section.content !== undefined ? { content: section.content } : {}),
    })),
    artifacts,
    mergePlan: state.mergePlan.map((entry) => ({ ...entry })),
    ...(failedStage && failure
      ? { failure: { stage: failedStage, error: failure.error ?? `${failedStage} 阶段失败` } }
      : {}),
    ...(state.diffSummary ? { diffSummary: { ...state.diffSummary } } : {}),
    ...(state.baselineText !== undefined ? { baselineText: state.baselineText } : {}),
    baseline: state.baselineText !== undefined ? "supplied" : "none",
    completed: snapshotOf(state).complete,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * 校验 + 还原一份持久化文档。
 *
 * **非法就返回 null**（调用方据此按「从未开始」处理并 warn）——
 * 判据要求：坏 JSON / 乱序阶段宁可回到未开始，也不许把可疑状态当成验收证据。
 */
function restorePersistedDocument(raw: unknown): PersistedPipelineDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.documentId !== "string" || !value.documentId.trim()) return null;
  if (typeof value.title !== "string") return null;
  if (!Array.isArray(value.stages) || value.stages.length !== DOC_PIPELINE_STAGES.length) return null;
  const stages: Array<{ stage: DocPipelineStage; status: DocStageStatus }> = [];
  let blockedSeen = false;
  let failedSeen = false;
  for (let i = 0; i < DOC_PIPELINE_STAGES.length; i += 1) {
    const item = value.stages[i] as { stage?: unknown; status?: unknown } | null;
    if (!item || item.stage !== DOC_PIPELINE_STAGES[i]) return null;
    const status = item.status;
    if (status !== "pending" && status !== "done" && status !== "failed") return null;
    // 阶段顺序不变式：一旦出现非 done，后面的阶段不许是 done（禁止跳级/作废后重跑才能 done）
    if (status !== "done") blockedSeen = true;
    else if (blockedSeen) return null;
    if (status === "failed") {
      if (failedSeen) return null;
      failedSeen = true;
    }
    stages.push({ stage: DOC_PIPELINE_STAGES[i], status });
  }
  // 任何已开始的流水线，outline 都是 done（startDocumentPipeline 的唯一入口行为）
  if (stages[0]?.status !== "done") return null;

  if (!Array.isArray(value.sections)) return null;
  const sections: PersistedPipelineDocument["sections"] = [];
  const ids = new Set<string>();
  for (const item of value.sections) {
    if (!item || typeof item !== "object") return null;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id) return null;
    if (ids.has(s.id)) return null;
    ids.add(s.id);
    if (typeof s.order !== "number" || !Number.isFinite(s.order)) return null;
    if (typeof s.heading !== "string" || !s.heading.trim()) return null;
    if (s.status !== "pending" && s.status !== "done" && s.status !== "failed") return null;
    if (typeof s.attempts !== "number" || !Number.isFinite(s.attempts)) return null;
    if (!Array.isArray(s.citations) || s.citations.some((c) => typeof c !== "string")) return null;
    if (s.content !== undefined && typeof s.content !== "string") return null;
    sections.push({
      id: s.id,
      order: s.order,
      heading: s.heading,
      ...(typeof s.page === "number" && Number.isFinite(s.page) ? { page: s.page } : {}),
      status: s.status,
      attempts: s.attempts,
      citations: s.citations as string[],
      ...(typeof s.content === "string" ? { content: s.content } : {}),
    });
  }
  sections.sort((a, b) => a.order - b.order);

  if (!Array.isArray(value.artifacts)) return null;
  const artifacts: PersistedPipelineDocument["artifacts"] = [];
  for (const item of value.artifacts) {
    if (!item || typeof item !== "object") return null;
    const a = item as Record<string, unknown>;
    if (!(DOC_PIPELINE_STAGES as readonly string[]).includes(String(a.stage))) return null;
    if (typeof a.name !== "string" || !a.name) return null;
    if (typeof a.digest !== "string" || !/^[0-9a-f]{16}$/.test(a.digest)) return null;
    if (typeof a.bytes !== "number" || !Number.isFinite(a.bytes)) return null;
    artifacts.push({ stage: a.stage as DocPipelineStage, name: a.name, digest: a.digest, bytes: a.bytes });
  }

  if (!Array.isArray(value.mergePlan)) return null;
  const mergePlan: DocMergePlanEntry[] = [];
  for (const item of value.mergePlan) {
    if (!item || typeof item !== "object") return null;
    const p = item as Record<string, unknown>;
    if (typeof p.sectionId !== "string" || typeof p.heading !== "string") return null;
    if (typeof p.from !== "number" || typeof p.to !== "number") return null;
    mergePlan.push({ sectionId: p.sectionId, heading: p.heading, from: p.from, to: p.to });
  }

  if (value.baseline !== "supplied" && value.baseline !== "none") return null;
  if (value.baselineText !== undefined && typeof value.baselineText !== "string") return null;
  if (typeof value.completed !== "boolean") return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;

  let failure: PersistedPipelineDocument["failure"];
  if (value.failure !== undefined) {
    if (!value.failure || typeof value.failure !== "object") return null;
    const f = value.failure as Record<string, unknown>;
    if (!(DOC_PIPELINE_STAGES as readonly string[]).includes(String(f.stage))) return null;
    if (typeof f.error !== "string" || !f.error) return null;
    failure = { stage: f.stage as DocPipelineStage, error: f.error };
  }

  let diffSummary: DocPipelineDiffSummary | undefined;
  if (value.diffSummary !== undefined) {
    if (!value.diffSummary || typeof value.diffSummary !== "object") return null;
    const d = value.diffSummary as Record<string, unknown>;
    if (typeof d.lines !== "number" || typeof d.added !== "number" || typeof d.removed !== "number") return null;
    if (d.baseline !== "supplied" && d.baseline !== "none") return null;
    if (typeof d.at !== "number") return null;
    diffSummary = { lines: d.lines, added: d.added, removed: d.removed, baseline: d.baseline, at: d.at };
  }

  const doc: PersistedPipelineDocument = {
    documentId: value.documentId,
    title: value.title,
    stages,
    sections,
    artifacts,
    mergePlan,
    ...(failure ? { failure } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    ...(typeof value.baselineText === "string" ? { baselineText: value.baselineText } : {}),
    baseline: value.baseline,
    completed: value.completed,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };

  if (!persistedDocumentConsistent(doc)) return null;
  return doc;
}

/** 交叉校验：阶段状态与分节/合并计划/产物必须互相对得上（坏状态在这里被挡下）。 */
function persistedDocumentConsistent(doc: PersistedPipelineDocument): boolean {
  const statusOf = (stage: DocPipelineStage): DocStageStatus =>
    doc.stages.find((s) => s.stage === stage)?.status ?? "pending";
  const allDone = doc.stages.every((s) => s.status === "done");
  const anyFailed = doc.stages.some((s) => s.status === "failed");
  if (doc.completed !== (allDone && !anyFailed)) return false;
  if (statusOf("outline") !== "done") return false;
  // baseline 标注必须与基线正文一致（「有基线」却没有文本 = 状态被改过）
  if (doc.baseline === "supplied" && doc.baselineText === undefined) return false;
  if (doc.baseline === "none" && doc.baselineText !== undefined) return false;

  if (statusOf("sections") === "done") {
    if (doc.sections.length === 0) return false;
    for (const section of doc.sections) {
      if (section.status !== "done") return false;
      if (!section.content || !section.content.trim()) return false;
    }
  }
  if (statusOf("merge") === "done") {
    if (doc.sections.length === 0) return false;
    if (doc.mergePlan.length !== doc.sections.length) return false;
    const merged = rebuildMergedText(doc);
    if (!merged) return false;
    const mergeArtifact = doc.artifacts.find((a) => a.stage === "merge" && a.name === "merged.md");
    if (!mergeArtifact || mergeArtifact.digest !== digestOfText(merged)) return false;
  } else if (doc.mergePlan.length > 0) {
    // 合并计划只在 merge 成功后存在；merge 不是 done 却带着计划 = 状态被改过
    return false;
  }
  if (statusOf("citations") === "done") {
    if (doc.sections.some((section) => section.citations.length === 0)) return false;
  }
  if (statusOf("diff") === "done") {
    if (!doc.diffSummary) return false;
  } else if (doc.diffSummary) {
    return false;
  }
  if (doc.failure) {
    if (statusOf(doc.failure.stage) !== "failed") return false;
  }
  return true;
}

/** 由分节正文重算合并稿（merge 阶段是确定性的；digest 用来校验「这就是当时那份」）。 */
function rebuildMergedText(doc: PersistedPipelineDocument): string | null {
  if (doc.sections.length === 0) return null;
  const parts: string[] = [];
  let cursor = 0;
  for (const section of doc.sections) {
    if (section.content === undefined) return null;
    const chunk = `## ${section.heading}\n\n${section.content}\n`;
    const plan = doc.mergePlan.find((entry) => entry.sectionId === section.id);
    if (!plan) return null;
    if (plan.heading !== section.heading || plan.from !== cursor || plan.to !== cursor + chunk.length) return null;
    parts.push(chunk);
    cursor += chunk.length;
  }
  return parts.join("\n");
}

/**
 * 读回一个会话的持久化文件（含版本/形状校验）。
 *
 * `warn` 只在「用户/判据真的在读状态」时为 true —— 写回时的合并读不该因为
 * 一份坏数据反复刷日志（写回会直接覆盖它）。
 */
function readPersistedFile(sessionId: string, options: { warn: boolean }): PersistedPipelineFile | null {
  const key = settingKeyOf(sessionId);
  const parsed = getSettingJSON<unknown>(key, undefined);
  if (parsed === undefined) {
    // `getSettingJSON` 的 fallback 与「坏 JSON」长得一样 ⇒ 用原始串区分，坏 JSON 要 warn
    const raw = getSetting(key);
    if (options.warn && raw !== null && raw.trim() !== "") {
      console.warn(`[document-pipeline] ${key} 不是合法 JSON（按「从未开始」处理，不会把它当验收证据）`);
    }
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    if (options.warn) console.warn(`[document-pipeline] ${key} 不是对象（按「从未开始」处理）`);
    return null;
  }
  const file = parsed as Record<string, unknown>;
  if (file.version !== PIPELINE_STATE_VERSION) {
    if (options.warn) {
      console.warn(
        `[document-pipeline] ${key} 版本不符（期望 ${PIPELINE_STATE_VERSION}，实际 ${String(file.version)}）—— 按「从未开始」处理`,
      );
    }
    return null;
  }
  if (file.sessionId !== sessionId) {
    if (options.warn) console.warn(`[document-pipeline] ${key} 的 sessionId 不匹配（按「从未开始」处理）`);
    return null;
  }
  if (!Array.isArray(file.documents)) {
    if (options.warn) console.warn(`[document-pipeline] ${key} 的 documents 不是数组（按「从未开始」处理）`);
    return null;
  }
  const documents: PersistedPipelineDocument[] = [];
  for (const item of file.documents) {
    const doc = restorePersistedDocument(item);
    if (!doc) {
      if (options.warn) {
        console.warn(`[document-pipeline] ${key} 里有一条非法文档状态（已忽略；它不会被当成已完成）`);
      }
      continue;
    }
    documents.push(doc);
  }
  if (documents.length === 0) return null;
  return {
    version: PIPELINE_STATE_VERSION,
    sessionId,
    documents,
    updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : Date.now(),
  };
}

/** 持久化文档 → 内存状态（合并稿按分节重算，并用 merge 产物 digest 校验）。 */
function restoreState(doc: PersistedPipelineDocument): PipelineState {
  const stages = new Map<DocPipelineStage, DocStageStatus>();
  for (const item of doc.stages) stages.set(item.stage, item.status);
  const sections = new Map<string, DocSectionJob>();
  for (const section of doc.sections) {
    sections.set(section.id, {
      id: section.id,
      order: section.order,
      heading: section.heading,
      ...(typeof section.page === "number" ? { page: section.page } : {}),
      status: section.status,
      attempts: section.attempts,
      citations: [...section.citations],
      ...(section.content !== undefined ? { content: section.content } : {}),
    });
  }
  const evidence: DocStageEvidence[] = [];
  for (const stage of DOC_PIPELINE_STAGES) {
    const status = stages.get(stage);
    if (status === "done") {
      evidence.push({
        stage,
        ok: true,
        at: doc.updatedAt,
        summary: `（重启后从持久化状态恢复：${stage} 已完成；摘要未落盘，产物 digest 保留）`,
        artifacts: doc.artifacts
          .filter((item) => item.stage === stage)
          .map((item) => ({ name: item.name, digest: item.digest, bytes: item.bytes })),
      });
    } else if (status === "failed") {
      const error = doc.failure?.stage === stage ? doc.failure.error : `${stage} 阶段失败`;
      evidence.push({ stage, ok: false, at: doc.updatedAt, summary: error, artifacts: [], error });
    }
  }
  const merged = stages.get("merge") === "done" ? rebuildMergedText(doc) ?? undefined : undefined;
  return {
    sessionId: "", // 由 ensureSessionLoaded 填
    documentId: doc.documentId,
    title: doc.title,
    ...(doc.baselineText !== undefined ? { baselineText: doc.baselineText } : {}),
    stages,
    sections,
    evidence,
    ...(merged !== undefined ? { merged } : {}),
    mergePlan: doc.mergePlan.map((entry) => ({ ...entry })),
    ...(doc.diffSummary ? { diffSummary: { ...doc.diffSummary } } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** 懒加载：会话第一次被读/写时把持久化状态并入内存（内存里已有的优先）。 */
function ensureSessionLoaded(sessionId: string): void {
  if (!sessionId || loadedSessions.has(sessionId)) return;
  loadedSessions.add(sessionId);
  const file = readPersistedFile(sessionId, { warn: true });
  if (!file) return;
  for (const doc of file.documents) {
    const key = keyOf(sessionId, doc.documentId);
    if (pipelines.has(key)) continue;
    const state = restoreState(doc);
    state.sessionId = sessionId;
    pipelines.set(key, state);
  }
}

/** 写回一个会话（与设置里已有的其它文档合并，不覆盖别的文档状态）。 */
function persistSessionNow(sessionId: string): void {
  const docs = [...pipelines.values()].filter((state) => state.sessionId === sessionId);
  if (docs.length === 0) return;
  const key = settingKeyOf(sessionId);
  const existing = readPersistedFile(sessionId, { warn: false });
  const byId = new Map<string, PersistedPipelineDocument>();
  for (const doc of existing?.documents ?? []) byId.set(doc.documentId, doc);
  for (const state of docs) byId.set(state.documentId, toPersistedDocument(state));
  const file: PersistedPipelineFile = {
    version: PIPELINE_STATE_VERSION,
    sessionId,
    documents: [...byId.values()],
    updatedAt: Date.now(),
  };
  loadedSessions.add(sessionId);
  setSettingJSON(key, file);
}

/** 页面关闭/隐藏时把待写内容立刻落盘（去抖窗口内被关掉的最后一次改动不丢）。 */
function installUnloadHook(): void {
  if (unloadHookInstalled) return;
  unloadHookInstalled = true;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("pagehide", () => flushDocumentPipelinePersistence());
}

/**
 * 落盘发生在去抖定时器里：即便设置面真的抛出，**内存状态也已经生效**
 * （下一次改动会再写一次），流水线的阶段判据不受影响。
 *
 * 这里刻意**不写「catch 后只 console.warn」**：那会把「状态没落盘、重启读不回」
 * 变成用户看不见的假成功 —— `tools/audit/scan-false-success.mjs` 的 P2 规则
 * 守的正是这种形态。真实失败由设置面的统一上报通道（`persist-failure`）负责。
 */
/** 标记某会话需要落盘（去抖；同一会话的连续改动合并成一次写）。 */
function schedulePersist(sessionId: string): void {
  if (!sessionId) return;
  installUnloadHook();
  const pending = pendingPersist.get(sessionId);
  if (pending !== undefined) clearTimeout(pending);
  const timer = setTimeout(() => {
    pendingPersist.delete(sessionId);
    persistSessionNow(sessionId);
  }, PERSIST_DEBOUNCE_MS);
  pendingPersist.set(sessionId, timer);
}

/**
 * 立刻把所有待写的会话落盘（页面关闭钩子与判据共用；重复调用安全）。
 *
 * 导出是为了判据能稳定复现「提交后重启」：只等去抖窗口会让用例依赖真实计时。
 */
export function flushDocumentPipelinePersistence(): void {
  for (const [sessionId, timer] of [...pendingPersist.entries()]) {
    clearTimeout(timer);
    pendingPersist.delete(sessionId);
    persistSessionNow(sessionId);
  }
}

/**
 * 只读查询：当前会话里所有文档的编译进度（产品入口用，见 `ContextMonitor`）。
 *
 * 不读设置键的私有形状、不写任何东西 —— 上层只拿这份稳定视图；内存里没有的
 * 文档会先从持久化懒加载（于是重启后列表还在）。
 */
export function listDocumentPipelines(sessionId: string): DocPipelineView[] {
  if (!sessionId) return [];
  ensureSessionLoaded(sessionId);
  return [...pipelines.values()]
    .filter((state) => state.sessionId === sessionId)
    .map((state) => documentPipelineSnapshot(sessionId, state.documentId))
    .filter((snapshot): snapshot is DocPipelineSnapshot => snapshot !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((snapshot) => ({
      sessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      title: snapshot.title,
      stages: snapshot.stages,
      sectionProgress: snapshot.sectionProgress,
      completed: snapshot.complete,
      artifactCount: snapshot.evidence
        .filter((evidence) => evidence.ok)
        .reduce((count, evidence) => count + evidence.artifacts.length, 0),
      updatedAt: snapshot.updatedAt,
      ...(snapshot.diffSummary ? { diffSummary: snapshot.diffSummary } : {}),
    }));
}

/**
 * 只读视图（UI 消费）。刻意只给「阶段 / 产物数 / diff 摘要」：
 * 面板不该知道持久化键的形状，也不该自己去解析 settings。
 */
export interface DocPipelineView {
  sessionId: string;
  documentId: string;
  title: string;
  stages: Array<{ stage: DocPipelineStage; status: DocStageStatus }>;
  sectionProgress: { total: number; done: number; pending: number; failed: number };
  completed: boolean;
  artifactCount: number;
  updatedAt: number;
  diffSummary?: DocPipelineDiffSummary;
}

/**
 * 判据用：清空内存镜像与待写定时器（模拟「重启/新实例」）。
 *
 * 只清**进程内**状态；持久化仍在设置里 ⇒ 下一次读会懒加载回来。
 * 生产不可达；经 `test-seams.ts` 汇总登记（knip 一条忽略 + 可达性白名单）。
 */
export function __resetDocumentPipelinesForTests(): void {
  for (const timer of pendingPersist.values()) clearTimeout(timer);
  pendingPersist.clear();
  loadedSessions.clear();
  pipelines.clear();
}

/**
 * 分节重交之后，**依赖它的下游阶段必须作废**（回到 pending）。
 *
 * 为什么：merge 的产物是按当时的分节正文生成的；如果分节可以被悄悄改掉而
 * merge/consistency/citations/coverage/diff 仍是 done，那份证据就变成了
 * 「对旧正文的验收」—— 阶段证据看着齐全，实际验的不是现在这份稿子。
 * 作废时保留一条 ok:false 的历史记录（说明为什么作废），不删旧证据。
 */
function invalidateFrom(state: PipelineState, fromStage: DocPipelineStage): void {
  const start = stageIndex(fromStage);
  for (let i = start; i < DOC_PIPELINE_STAGES.length; i += 1) {
    const stage = DOC_PIPELINE_STAGES[i];
    if (state.stages.get(stage) !== "done") continue;
    state.stages.set(stage, "pending");
    state.evidence.push({
      stage,
      ok: false,
      at: Date.now(),
      summary: `作废：分节内容已重交，${stage} 的产物针对的是旧正文`,
      artifacts: [],
    });
  }
  state.merged = undefined;
  state.mergePlan = [];
  state.diff = undefined;
  state.diffSummary = undefined;
}

/**
 * 开始（或重建）一条编译流水线。
 *
 * - `outline` 阶段在这一步就是 `done`（它只依赖调用方给的章节清单）；
 * - 同一 `(sessionId, documentId)` 再次调用时，**标题一致的分节交付会保留**
 *   （重入：换段/重试不该让已交的分节白干），标题变了的旧分节丢弃并如实记录。
 */
export function startDocumentPipeline(args: {
  sessionId: string;
  documentId: string;
  title?: string;
  outline: Array<{ heading: string; page?: number }>;
  /** 上一版的合并文本（diff 的基线）；没有就如实标「无基线」 */
  baselineText?: string;
}): DocPipelineSnapshot {
  const headingList = args.outline.map((h) => h.heading.trim()).filter(Boolean);
  if (headingList.length === 0) throw new Error("编译流水线需要至少一个章节（大纲为空）");
  // 重启后重新 plan 时，先把持久化里的分节并进来（标题一致的交付不该白干）
  ensureSessionLoaded(args.sessionId);
  const key = keyOf(args.sessionId, args.documentId);
  const previous = pipelines.get(key);
  const now = Date.now();
  const sections = new Map<string, DocSectionJob>();
  headingList.forEach((heading, i) => {
    const id = `s${i + 1}`;
    const old = previous ? [...previous.sections.values()].find((s) => s.heading === heading) : undefined;
    const page = args.outline[i]?.page;
    sections.set(id, {
      id,
      order: i,
      heading,
      ...(typeof page === "number" ? { page } : {}),
      status: old?.status === "done" ? "done" : "pending",
      attempts: old?.attempts ?? 0,
      ...(old?.content !== undefined ? { content: old.content } : {}),
      citations: old?.citations ?? [],
      ...(old?.updatedAt !== undefined ? { updatedAt: old.updatedAt } : {}),
      ...(old?.lastError !== undefined ? { lastError: old.lastError } : {}),
    });
  });
  const stages = new Map<DocPipelineStage, DocStageStatus>();
  for (const stage of DOC_PIPELINE_STAGES) stages.set(stage, stage === "outline" ? "done" : "pending");
  const state: PipelineState = {
    sessionId: args.sessionId,
    documentId: args.documentId,
    title: args.title ?? args.documentId,
    ...(args.baselineText !== undefined ? { baselineText: args.baselineText } : {}),
    stages,
    sections,
    evidence: [
      {
        stage: "outline",
        ok: true,
        at: now,
        summary: `大纲已确定：${headingList.length} 个章节（§1 ${headingList[0]} …）`,
        artifacts: [artifact("outline.json", JSON.stringify(headingList))],
      },
    ],
    mergePlan: [],
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  pipelines.set(key, state);
  schedulePersist(args.sessionId);
  return snapshotOf(state);
}

function snapshotOf(state: PipelineState): DocPipelineSnapshot {
  const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
  const counts = { total: sections.length, done: 0, pending: 0, failed: 0 };
  for (const section of sections) {
    if (section.status === "done") counts.done += 1;
    else if (section.status === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  const stages = DOC_PIPELINE_STAGES.map((stage) => ({
    stage,
    status: state.stages.get(stage) ?? "pending",
  }));
  const blockedBy: Array<{ stage: DocPipelineStage; reason: string }> = [];
  for (const item of stages) {
    if (item.status === "done") continue;
    const prev = previousStage(item.stage);
    if (item.status === "failed") {
      const failedEvidence = [...state.evidence].reverse().find((e) => e.stage === item.stage && !e.ok);
      blockedBy.push({ stage: item.stage, reason: failedEvidence?.error ?? `${item.stage} 阶段失败` });
      continue;
    }
    if (item.stage === "sections" && counts.done < counts.total) {
      blockedBy.push({
        stage: "sections",
        reason: `还有 ${counts.total - counts.done} 个分节未交付（${counts.done}/${counts.total}）`,
      });
    } else {
      blockedBy.push({
        stage: item.stage,
        reason: prev ? `上一阶段 ${prev} 未完成` : `${item.stage} 未执行`,
      });
    }
  }
  const complete = blockedBy.length === 0;
  return {
    sessionId: state.sessionId,
    documentId: state.documentId,
    title: state.title,
    stages,
    sections,
    sectionProgress: counts,
    mergePlan: state.mergePlan,
    evidence: state.evidence,
    complete,
    blockedBy,
    ...(state.diff !== undefined ? { diff: state.diff } : {}),
    ...(state.diffSummary !== undefined ? { diffSummary: state.diffSummary } : {}),
    baseline: state.baselineText !== undefined ? "supplied" : "none",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/** 只读快照（工具/判据共用；不存在时返回 null，不伪造一条空流水线）。 */
export function documentPipelineSnapshot(
  sessionId: string,
  documentId: string,
): DocPipelineSnapshot | null {
  ensureSessionLoaded(sessionId);
  const state = pipelines.get(keyOf(sessionId, documentId));
  return state ? snapshotOf(state) : null;
}

/** 交付一个分节（可重入：失败/重试都走这里；重交会递增 attempts）。 */
export function submitDocumentSection(args: {
  sessionId: string;
  documentId: string;
  sectionId?: string;
  heading?: string;
  content: string;
  citations?: string[];
}):
  | { ok: true; section: DocSectionJob; snapshot: DocPipelineSnapshot }
  | { ok: false; error: string; snapshot: DocPipelineSnapshot | null } {
  ensureSessionLoaded(args.sessionId);
  const state = pipelines.get(keyOf(args.sessionId, args.documentId));
  if (!state) return { ok: false, error: "流水线还没开始（先执行 plan）", snapshot: null };
  const section = args.sectionId
    ? state.sections.get(args.sectionId)
    : args.heading
      ? [...state.sections.values()].find((s) => s.heading === args.heading!.trim())
      : undefined;
  if (!section) {
    return {
      ok: false,
      error: args.sectionId ? `没有这个分节：${args.sectionId}` : `大纲里没有标题「${args.heading ?? ""}」`,
      snapshot: snapshotOf(state),
    };
  }
  const content = args.content.trim();
  if (!content) {
    section.status = "failed";
    section.attempts += 1;
    section.lastError = "分节正文为空（空节不算交付）";
    section.updatedAt = Date.now();
    stamp(state);
    schedulePersist(args.sessionId);
    return { ok: false, error: section.lastError, snapshot: snapshotOf(state) };
  }
  /** 分节重交：若 sections 阶段已经 done，下游产物全部作废（见 invalidateFrom） */
  if (state.stages.get("sections") === "done") invalidateFrom(state, "sections");
  section.content = content;
  section.citations = [...new Set((args.citations ?? []).map((c) => c.trim()).filter(Boolean))];
  section.status = "done";
  section.attempts += 1;
  section.lastError = undefined;
  section.updatedAt = Date.now();
  stamp(state);
  schedulePersist(args.sessionId);
  return { ok: true, section, snapshot: snapshotOf(state) };
}

/** 引用解析器：默认只做结构检查（调用方可注入真实解析）。 */
type CitationResolver = (citation: string) => boolean;

function structuralCitationOk(citation: string): boolean {
  const text = citation.trim();
  if (!text) return false;
  // 形如 `[file: X | page: 12 | §3.2 | chunk: doc#3]` / `file: X | …` 都接受；
  // 只要求「有文件 + 至少一个定位器（page/§/chunk）」，不假装能验证内容。
  // 允许 `[` 前缀：工具产出的 citation 是带方括号的整段（`formatCitation` 的形状）。
  if (!/(^|\[|\|)\s*file:\s*\S/.test(text)) return false;
  return /(^|\[|\|)\s*(page|§|chunk):/.test(text);
}

/**
 * 执行一个阶段（**禁止跳级**）。
 *
 * 失败返回 `ok:false` 并把该阶段标 `failed`；已 `done` 的阶段不会回退，
 * 但也不会被再次执行（幂等：重复调用返回同一份证据，不追加重复证据）。
 */
export function runDocumentPipelineStage(args: {
  sessionId: string;
  documentId: string;
  stage: Exclude<DocPipelineStage, "outline">;
  /** 引用解析器（默认结构检查；注入真实解析器时判据更严） */
  resolveCitation?: CitationResolver;
  /** 生成 diff 的基线文本（覆盖 start 时给的基线） */
  baselineText?: string;
  now?: () => number;
}):
  | { ok: true; stage: DocPipelineStage; evidence: DocStageEvidence; snapshot: DocPipelineSnapshot }
  | { ok: false; stage: DocPipelineStage; error: string; snapshot: DocPipelineSnapshot | null } {
  const now = args.now ?? (() => Date.now());
  ensureSessionLoaded(args.sessionId);
  const state = pipelines.get(keyOf(args.sessionId, args.documentId));
  if (!state) {
    return { ok: false, stage: args.stage, error: "流水线还没开始（先执行 plan）", snapshot: null };
  }
  const status = state.stages.get(args.stage) ?? "pending";
  if (status === "done") {
    const existing = [...state.evidence].reverse().find((e) => e.stage === args.stage && e.ok);
    if (existing) return { ok: true, stage: args.stage, evidence: existing, snapshot: snapshotOf(state) };
  }
  const previous = previousStage(args.stage);
  if (previous && state.stages.get(previous) !== "done") {
    return {
      ok: false,
      stage: args.stage,
      error: `禁止跳级：上一阶段 ${previous} 还没完成（当前 ${state.stages.get(previous) ?? "pending"}）`,
      snapshot: snapshotOf(state),
    };
  }

  const fail = (error: string, artifacts: DocStageArtifact[] = []): {
    ok: false;
    stage: DocPipelineStage;
    error: string;
    snapshot: DocPipelineSnapshot;
  } => {
    state.stages.set(args.stage, "failed");
    state.evidence.push({ stage: args.stage, ok: false, at: now(), summary: error, artifacts, error });
    stamp(state);
    schedulePersist(args.sessionId);
    return { ok: false, stage: args.stage, error, snapshot: snapshotOf(state) };
  };

  switch (args.stage) {
    case "sections": {
      const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
      const missing = sections.filter((s) => s.status !== "done");
      if (missing.length > 0) {
        return fail(
          `分节未交齐：${missing.length}/${sections.length} 个未完成（${missing
            .slice(0, 6)
            .map((s) => s.id)
            .join("、")}）—— 合并/验证必须等全部分节交付`,
        );
      }
      const manifest = JSON.stringify(
        sections.map((s) => ({ id: s.id, heading: s.heading, digest: digestOfText(s.content ?? "") })),
      );
      const evidence: DocStageEvidence = {
        stage: "sections",
        ok: true,
        at: now(),
        summary: `${sections.length} 个分节全部交付（全部非空）`,
        artifacts: [artifact("sections.json", manifest)],
      };
      state.stages.set("sections", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "sections", evidence, snapshot: snapshotOf(state) };
    }
    case "merge": {
      const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
      if (sections.length === 0) return fail("没有分节可合并");
      const parts: string[] = [];
      const plan: DocMergePlanEntry[] = [];
      let cursor = 0;
      for (const section of sections) {
        const chunk = `## ${section.heading}\n\n${section.content ?? ""}\n`;
        plan.push({ sectionId: section.id, heading: section.heading, from: cursor, to: cursor + chunk.length });
        parts.push(chunk);
        cursor += chunk.length;
      }
      state.merged = parts.join("\n");
      state.mergePlan = plan;
      const evidence: DocStageEvidence = {
        stage: "merge",
        ok: true,
        at: now(),
        summary: `按计划合并 ${sections.length} 节（顺序 ${sections.map((s) => s.id).join(" → ")}）`,
        artifacts: [artifact("merged.md", state.merged)],
      };
      state.stages.set("merge", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "merge", evidence, snapshot: snapshotOf(state) };
    }
    case "consistency": {
      const merged = state.merged ?? "";
      const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
      const problems: string[] = [];
      for (const section of sections) {
        const header = `## ${section.heading}`;
        const occurrences = merged.split(header).length - 1;
        if (occurrences !== 1) problems.push(`章节「${section.heading}」在合并文本里出现 ${occurrences} 次（应为 1）`);
        if (!(section.content ?? "").trim()) problems.push(`章节「${section.heading}」正文为空`);
      }
      for (const entry of state.mergePlan) {
        const text = merged.slice(entry.from, entry.to);
        if (!text.includes(`## ${entry.heading}`)) {
          problems.push(`合并计划与正文不一致：${entry.sectionId} 的区间里没有标题「${entry.heading}」`);
        }
      }
      if (problems.length > 0) return fail(`一致性检查失败：${problems.slice(0, 6).join("；")}`);
      const evidence: DocStageEvidence = {
        stage: "consistency",
        ok: true,
        at: now(),
        summary: `一致性检查通过：${sections.length} 节标题各出现 1 次、正文非空、合并计划与正文对得上`,
        artifacts: [artifact("consistency.json", JSON.stringify({ sections: sections.length, ok: true }))],
      };
      state.stages.set("consistency", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "consistency", evidence, snapshot: snapshotOf(state) };
    }
    case "citations": {
      const resolve = args.resolveCitation ?? structuralCitationOk;
      const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
      const noCitation = sections.filter((s) => s.citations.length === 0);
      if (noCitation.length > 0) {
        return fail(
          `引用验证失败：${noCitation.length} 个章节没有任何 citation（${noCitation
            .slice(0, 6)
            .map((s) => s.id)
            .join("、")}）`,
        );
      }
      const bad: string[] = [];
      for (const section of sections) {
        for (const citation of section.citations) {
          if (!resolve(citation)) bad.push(`${section.id}: ${citation}`);
        }
      }
      if (bad.length > 0) {
        return fail(`引用验证失败：${bad.length} 条引用无法解析（${bad.slice(0, 4).join("；")}）`);
      }
      const total = sections.reduce((n, s) => n + s.citations.length, 0);
      const evidence: DocStageEvidence = {
        stage: "citations",
        ok: true,
        at: now(),
        summary: `${total} 条引用全部可解析（每节至少 1 条）`,
        artifacts: [artifact("citations.json", JSON.stringify(sections.map((s) => s.citations)))],
      };
      state.stages.set("citations", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "citations", evidence, snapshot: snapshotOf(state) };
    }
    case "coverage": {
      const merged = state.merged ?? "";
      const sections = [...state.sections.values()].sort((a, b) => a.order - b.order);
      const missing = sections.filter((s) => !merged.includes(`## ${s.heading}`));
      if (missing.length > 0) {
        return fail(`覆盖检查失败：${missing.length} 个章节没有进入合并文本（${missing.map((s) => s.id).join("、")}）`);
      }
      const uncovered = sections.filter((s) => s.citations.length === 0);
      if (uncovered.length > 0) {
        return fail(`覆盖检查失败：${uncovered.length} 个章节没有引用支撑（${uncovered.map((s) => s.id).join("、")}）`);
      }
      const evidence: DocStageEvidence = {
        stage: "coverage",
        ok: true,
        at: now(),
        summary: `覆盖检查通过：${sections.length}/${sections.length} 章节有正文且有引用`,
        artifacts: [artifact("coverage.json", JSON.stringify({ covered: sections.length }))],
      };
      state.stages.set("coverage", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "coverage", evidence, snapshot: snapshotOf(state) };
    }
    case "diff": {
      const merged = state.merged ?? "";
      const baseline = args.baselineText ?? state.baselineText;
      const diff = buildUnifiedDiff(baseline ?? "", merged, baseline ? "v-previous.md" : "/dev/null", "v-next.md");
      state.diff = diff;
      state.diffSummary = summarizeDiffText(diff, baseline ? "supplied" : "none", now());
      const evidence: DocStageEvidence = {
        stage: "diff",
        ok: true,
        at: now(),
        summary: baseline
          ? `diff 已生成：基线 ${baseline.length} 字符 → 合并稿 ${merged.length} 字符`
          : "diff 已生成：没有基线（全部记为新增，基线状态如实标注）",
        artifacts: [artifact("diff.patch", diff)],
      };
      state.stages.set("diff", "done");
      state.evidence.push(evidence);
      stamp(state);
      schedulePersist(args.sessionId);
      return { ok: true, stage: "diff", evidence, snapshot: snapshotOf(state) };
    }
    default: {
      const exhaustive: never = args.stage;
      return { ok: false, stage: exhaustive, error: `未知阶段：${String(args.stage)}`, snapshot: snapshotOf(state) };
    }
  }
}

/**
 * 把统一 diff 折成摘要（行数 / 新增 / 删除 / 基线状态）——持久化与 UI 用的是这一份。
 *
 * 为什么不在读取时现算：重启后补丁正文不落盘（设置键不该跟着稿件长度膨胀），
 * 摘要必须和「当时生成的那份」一起存下来，否则「最近改了多少」会变成重新猜。
 */
function summarizeDiffText(
  diff: string,
  baseline: "supplied" | "none",
  at: number,
): DocPipelineDiffSummary {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { lines: lines.length, added, removed, baseline, at };
}

/** 逐行 LCS diff（有界：超过 1200 行只比对前 1200 行，并显式说明截断）。 */
function buildUnifiedDiff(before: string, after: string, beforeName: string, afterName: string): string {
  const LIMIT = 1200;
  const a = before.split("\n");
  const b = after.split("\n");
  const aTrunc = a.length > LIMIT;
  const bTrunc = b.length > LIMIT;
  const left = aTrunc ? a.slice(0, LIMIT) : a;
  const right = bTrunc ? b.slice(0, LIMIT) : b;
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [`--- ${beforeName}`, `+++ ${afterName}`];
  if (aTrunc || bTrunc) lines.push(`@@ 注意：文本超过 ${LIMIT} 行，diff 只比对前 ${LIMIT} 行 @@`);
  lines.push(`@@ -1,${n} +1,${m} @@`);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      lines.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${left[i]}`);
      i += 1;
    } else {
      lines.push(`+${right[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${left[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+${right[j]}`);
    j += 1;
  }
  return lines.join("\n");
}
