/**
 * DocumentLedger —— 本轮「文档用法」的结构化记忆（ADR-0008 §11）。
 *
 * ## 为什么不能靠「把读过的正文留在上下文里」
 *
 * 文档正文是**最贵**的上下文：一份 300 页 PDF 的某一段就有几千 token。
 * 检索型工作真正要跨轮保留的只有三件事：**看过哪些文件、读过哪些 chunk、
 * 确认了哪些带 citation 的事实**。正文随时可以按 citation 再取一次。
 *
 * ## 注入位置
 *
 * 只能进 `trailingTurnContext`（易变尾部），**绝不进 system 前缀** ——
 * 否则每轮前缀都变，`dsh-d5-prefix-cache-stability` 会红（前缀缓存失效）。
 *
 * ## 预算
 *
 * 渲染文本 ≤2,000 token（超出按「文件 → 章节 → 已读 → 事实」优先级截断）。
 *
 * ## C06：章节覆盖 / claim 账本 / 跨段保留
 *
 * 只记「读过哪些 chunk」回答不了长文档任务真正的问题：
 * **哪些章节还没读、哪些结论还没验、改过的章节有没有再验**。所以账本多了三层：
 *
 * 1. **章节状态**（`unread → read → edited → verified`）：
 *    - `read`：检索命中或 `doc_read` 读过该标题下的内容；
 *    - `edited`：本轮改写了这一节（编译/修订任务）；
 *    - `verified`：该节的引用被核对过（claim 已验证 / 显式标记）。
 *    状态**只升不降**（`SECTION_RANK`）—— 降级会让「已验」被一次检索命中冲掉，
 *    覆盖状态就失去意义。
 * 2. **Claim 账本**：每条 claim 必须带 citation（没有 citation 直接拒绝），
 *    并把引用渲染回 `[file: … | page: … | §… | chunk: …]`，逐条可回溯。
 * 3. **跨段保留**：账本按**集合**（= 项目或 `session:<id>`，跟段号无关）存，
 *    `noteDocumentLedgerSegment` 只记录观察到的段号，**从不重置状态**；
 *    渲染时显式写出「覆盖保留自第 N 段」，压缩/换段后既有覆盖不会消失。
 */

import { getDocument, truncateToTokens, type DocumentSearchHit } from "./client";
import { hasStoragePort } from "../storage/port";
import { getSetting, setSettingJSON } from "../storage/settings";

interface LedgerFile {
  id: string;
  name: string;
  pages?: number;
  status?: string;
  /** 首次记录时文档的 `updated_at`（版本同步检查用） */
  updatedAt?: number;
  /** 首次记录时文档的 `sha256` */
  sha256?: string | null;
  /** 大纲里的标题路径（`recordDocumentOutline` 写入；用来算「未读」） */
  headings?: string[];
}

interface LedgerRead {
  documentId: string;
  chunkNo: number;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
  at: number;
}

interface LedgerFact {
  text: string;
  at: number;
}

/** 章节覆盖状态（只升不降）。 */
type SectionCoverage = "unread" | "read" | "edited" | "verified";

/** 章节状态机：数字越大越「强」；`recordDocumentSection` 只接受升级。 */
const SECTION_RANK: Record<SectionCoverage, number> = {
  unread: 0,
  read: 1,
  edited: 2,
  verified: 3,
};

interface DocumentSectionState {
  documentId: string;
  headingPath: string;
  status: SectionCoverage;
  pageFrom?: number;
  pageTo?: number;
  at: number;
}

interface ClaimCitation {
  documentId: string;
  chunkNo?: number;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
}

interface DocumentClaimState {
  id: string;
  text: string;
  citation: ClaimCitation;
  verified: boolean;
  at: number;
}

/** 超限裁剪的累计条数（按类别）——「裁剪生效」这件事**要看得到**，不能静默丢。 */
interface TrimCounters {
  files: number;
  reads: number;
  facts: number;
  sections: number;
  claims: number;
}

interface LedgerState {
  files: Map<string, LedgerFile>;
  reads: Map<string, LedgerRead>;
  facts: LedgerFact[];
  sections: Map<string, DocumentSectionState>;
  claims: Map<string, DocumentClaimState>;
  /** 下一个 claim 的序号（**单调递增**：裁剪之后也不能与既有 id 撞车） */
  claimSeq: number;
  /** 第一次记录覆盖时的段号（`noteDocumentLedgerSegment` 写入） */
  firstSegment?: number;
  /** 最近一次观察到的段号 */
  segment?: number;
  /** 已裁掉的条数（按类别累计） */
  trimmed: TrimCounters;
}

const MAX_FACTS = 40;
const MAX_READS = 80;
const MAX_FILES = 40;
/**
 * 每集合的**章节/claim 上限**（C06 边界①：账本要落盘，就必须有界）。
 *
 * 超限裁剪**最旧的**（按 `at`），并把裁掉的条数记进 `trimmed` ——
 * 「上限生效」必须是可观测的事实，而不是悄悄丢数据。
 * 内存与落盘用**同一个**上限，否则「重启前有、重启后没了」会变成静默失真。
 */
const MAX_SECTIONS = 100;
const MAX_CLAIMS = 200;
const MAX_UNREAD_LINES = 10;
const MAX_CLAIM_LINES = 8;
/**
 * 版本同步检查每集合最多比对几份文件。
 *
 * 与账本自身的 `MAX_FILES`（40）分开：版本检查要逐份读当前文档行（IPC / 索引），
 * 所以只比对最早记下的 8 份（正常任务的文档数远小于此）。
 * 导出它是为了让 **Goal 里程碑的完成前检查** 用同一个窗口判断「引用的文档到底有没有
 * 参与比对」—— 两处各写一个 8 必然漂移。
 */
export const DOCUMENT_SYNC_MAX_FILES = 8;

/** 落盘键前缀：`codem-document-ledger:<collectionId>` */
const PERSIST_KEY_PREFIX = "codem-document-ledger:";
/**
 * 落盘信封的版本号。
 *
 * 读到**不认识**的版本 ⇒ 空账本 + `console.warn`（绝不抛、绝不把旧形状硬塞进来）。
 * 将来改形状时**必须**同时升这个号并写迁移，否则老数据会被静默当成坏数据。
 */
const PERSIST_VERSION = 1;
/**
 * 写入去抖窗口（毫秒）。
 *
 * 为什么不每次写都落盘：账本在一个回合里会被写几十次（每个检索命中都会升级章节），
 * 每次都整份 `setSettingJSON` 会把配置面写穿队列打满 —— 而配置面是启动期同步读的
 * **唯一**内存镜像（见 `storage/settings.ts` 文件头）。去抖把「同一批写」合成一次。
 *
 * 读路径**永不**写：只有写 API 会 `schedulePersist`（见各 `markDirty` 调用点）。
 */
const PERSIST_DEBOUNCE_MS = 200;

const ledgers = new Map<string, LedgerState>();
/** 已经尝试过从持久化里加载的集合（坏数据也只 warn 一次，不刷屏） */
const loadedCollections = new Set<string>();
/** 待落盘的集合（去抖窗口内累积） */
const dirtyCollections = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emptyTrimmed(): TrimCounters {
  return { files: 0, reads: 0, facts: 0, sections: 0, claims: 0 };
}

function emptyLedgerState(): LedgerState {
  return {
    files: new Map(),
    reads: new Map(),
    facts: [],
    sections: new Map(),
    claims: new Map(),
    claimSeq: 0,
    trimmed: emptyTrimmed(),
  };
}

/**
 * 取集合账本（**懒加载**：第一次访问时从存储里读，读到坏数据回到空账本并 warn）。
 *
 * 为什么读路径也走它：重启后模型第一次 `doc_ledger`/尾部注入之前，账本只存在于磁盘上；
 * 不懒加载的话「重启后覆盖丢失」就是必然的（这正是 C06 边界①）。
 */
function ledger(collectionId: string): LedgerState {
  const existing = ledgers.get(collectionId);
  if (existing) return existing;
  const alreadyLoaded = loadedCollections.has(collectionId);
  const persisted = alreadyLoaded ? null : loadPersisted(collectionId);
  if (!alreadyLoaded) loadedCollections.add(collectionId);
  const state = persisted ? hydratePersisted(persisted) : emptyLedgerState();
  ledgers.set(collectionId, state);
  return state;
}

/* ═══════════════════════ 持久化（C06 边界①：跨重启不丢） ═══════════════════════ */

/** 落盘信封（版本化；字段与内存形状一一对应，便于判据直接比对）。 */
interface PersistedLedger {
  v: number;
  collectionId: string;
  savedAt: number;
  files: LedgerFile[];
  reads: LedgerRead[];
  facts: LedgerFact[];
  sections: DocumentSectionState[];
  claims: DocumentClaimState[];
  claimSeq: number;
  firstSegment?: number;
  segment?: number;
  trimmed: TrimCounters;
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  Boolean(x) && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";

function isLedgerFileRow(x: unknown): x is LedgerFile {
  if (!isObject(x)) return false;
  if (!isStr(x.id) || !x.id || !isStr(x.name)) return false;
  if (x.pages !== undefined && !isNum(x.pages)) return false;
  if (x.status !== undefined && !isStr(x.status)) return false;
  if (x.updatedAt !== undefined && !isNum(x.updatedAt)) return false;
  if (x.sha256 !== undefined && x.sha256 !== null && !isStr(x.sha256)) return false;
  if (x.headings !== undefined && (!Array.isArray(x.headings) || !x.headings.every(isStr))) return false;
  return true;
}

function isLedgerReadRow(x: unknown): x is LedgerRead {
  if (!isObject(x)) return false;
  if (!isStr(x.documentId) || !isNum(x.chunkNo) || !isNum(x.at)) return false;
  if (x.pageFrom !== undefined && !isNum(x.pageFrom)) return false;
  if (x.pageTo !== undefined && !isNum(x.pageTo)) return false;
  if (x.headingPath !== undefined && x.headingPath !== null && !isStr(x.headingPath)) return false;
  return true;
}

function isLedgerFactRow(x: unknown): x is LedgerFact {
  return isObject(x) && isStr(x.text) && isNum(x.at);
}

function isCitationRow(x: unknown): x is ClaimCitation {
  if (!isObject(x)) return false;
  if (!isStr(x.documentId)) return false;
  if (x.chunkNo !== undefined && !isNum(x.chunkNo)) return false;
  if (x.pageFrom !== undefined && !isNum(x.pageFrom)) return false;
  if (x.pageTo !== undefined && !isNum(x.pageTo)) return false;
  if (x.headingPath !== undefined && x.headingPath !== null && !isStr(x.headingPath)) return false;
  return true;
}

function isSectionRow(x: unknown): x is DocumentSectionState {
  if (!isObject(x)) return false;
  if (!isStr(x.documentId) || !isStr(x.headingPath) || !isNum(x.at)) return false;
  if (x.status !== "unread" && x.status !== "read" && x.status !== "edited" && x.status !== "verified") return false;
  if (x.pageFrom !== undefined && !isNum(x.pageFrom)) return false;
  if (x.pageTo !== undefined && !isNum(x.pageTo)) return false;
  return true;
}

function isClaimRow(x: unknown): x is DocumentClaimState {
  if (!isObject(x)) return false;
  return isStr(x.id) && isStr(x.text) && typeof x.verified === "boolean" && isNum(x.at) && isCitationRow(x.citation);
}

/**
 * 校验落盘信封。
 *
 * 口径：**结构不对就整份作废**（回到空账本），不做「尽力恢复一半」 ——
 * 半份账本会让「未读/未验」的结论看起来成立而实际缺条，比空账本更难发现。
 */
function validatePersisted(value: unknown, collectionId: string): { data?: PersistedLedger; problem?: string } {
  if (!isObject(value)) return { problem: "形状不是对象" };
  if (value.v !== PERSIST_VERSION) {
    return { problem: `版本不符（读到 v=${String(value.v)}，期望 ${PERSIST_VERSION}）` };
  }
  if (value.collectionId !== collectionId) return { problem: "collectionId 与键不一致" };
  const files = value.files;
  const reads = value.reads;
  const facts = value.facts;
  const sections = value.sections;
  const claims = value.claims;
  for (const [key, rows] of [
    ["files", files],
    ["reads", reads],
    ["facts", facts],
    ["sections", sections],
    ["claims", claims],
  ] as const) {
    if (!Array.isArray(rows)) return { problem: `字段 ${key} 不是数组` };
  }
  if (!(files as unknown[]).every(isLedgerFileRow)) return { problem: "files 里有坏条目" };
  if (!(reads as unknown[]).every(isLedgerReadRow)) return { problem: "reads 里有坏条目" };
  if (!(facts as unknown[]).every(isLedgerFactRow)) return { problem: "facts 里有坏条目" };
  if (!(sections as unknown[]).every(isSectionRow)) return { problem: "sections 里有坏条目" };
  if (!(claims as unknown[]).every(isClaimRow)) return { problem: "claims 里有坏条目" };
  if (value.claimSeq !== undefined && !isNum(value.claimSeq)) return { problem: "claimSeq 不是数字" };
  if (value.firstSegment !== undefined && !isNum(value.firstSegment)) return { problem: "firstSegment 不是数字" };
  if (value.segment !== undefined && !isNum(value.segment)) return { problem: "segment 不是数字" };
  return { data: value as unknown as PersistedLedger };
}

/** 观测设施：坏数据只 warn，**绝不抛**（账本坏了不该让整个回合失败）。 */
function warnLedger(message: string, detail?: unknown): void {
  try {
    console.warn(`[document-ledger] ${message}`, detail ?? "");
  } catch {
    /* ignore */
  }
}

/** 从持久化读一份信封（无端口 / 没写过 / 坏数据 ⇒ null，绝不抛）。 */
function loadPersisted(collectionId: string): PersistedLedger | null {
  if (!hasStoragePort()) return null;
  const key = PERSIST_KEY_PREFIX + collectionId;
  let raw: string | null;
  try {
    raw = getSetting(key);
  } catch (e) {
    warnLedger(`账本读取失败，本次按空账本处理：${collectionId}`, e);
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnLedger(`账本数据不是合法 JSON，已回到空账本：${collectionId}`, e);
    return null;
  }
  const verdict = validatePersisted(parsed, collectionId);
  if (!verdict.data) {
    warnLedger(`账本数据不可用（${verdict.problem}），已回到空账本：${collectionId}`);
    return null;
  }
  return verdict.data;
}

/** 信封 → 内存状态（拷贝，避免调用方拿到持久化对象后原地改）。 */
function hydratePersisted(persisted: PersistedLedger): LedgerState {
  const state = emptyLedgerState();
  for (const file of persisted.files) {
    state.files.set(file.id, { ...file, ...(file.headings ? { headings: [...file.headings] } : {}) });
  }
  for (const read of persisted.reads) {
    state.reads.set(`${read.documentId}#${read.chunkNo}`, { ...read });
  }
  state.facts = persisted.facts.map((f) => ({ ...f }));
  for (const section of persisted.sections) {
    state.sections.set(sectionKey(section.documentId, section.headingPath), { ...section });
  }
  for (const claim of persisted.claims) {
    state.claims.set(claim.id, { ...claim, citation: { ...claim.citation } });
  }
  const maxIdSeq = [...state.claims.keys()].reduce((max, id) => {
    const seq = Number(/^claim_(\d+)$/.exec(id)?.[1] ?? 0);
    return Number.isFinite(seq) ? Math.max(max, seq) : max;
  }, 0);
  state.claimSeq = Math.max(persisted.claimSeq ?? 0, maxIdSeq);
  if (persisted.firstSegment !== undefined) state.firstSegment = persisted.firstSegment;
  if (persisted.segment !== undefined) state.segment = persisted.segment;
  const trimmed = persisted.trimmed;
  if (isObject(trimmed)) {
    for (const key of ["files", "reads", "facts", "sections", "claims"] as const) {
      const value = trimmed[key];
      if (isNum(value)) state.trimmed[key] = value;
    }
  }
  // 落盘上限与内存上限是同一个；旧数据可能超限（例如上限被调小），这里补齐裁剪
  trim(state);
  return state;
}

/** 内存状态 → 信封（值拷贝；裁剪一次保证落盘也不超限）。 */
function toPersisted(collectionId: string, state: LedgerState): PersistedLedger {
  trim(state);
  return {
    v: PERSIST_VERSION,
    collectionId,
    savedAt: Date.now(),
    files: [...state.files.values()].map((file) => ({
      ...file,
      ...(file.headings ? { headings: [...file.headings] } : {}),
    })),
    reads: [...state.reads.values()].map((read) => ({ ...read })),
    facts: state.facts.map((fact) => ({ ...fact })),
    sections: [...state.sections.values()].map((section) => ({ ...section })),
    claims: [...state.claims.values()].map((claim) => ({ ...claim, citation: { ...claim.citation } })),
    claimSeq: state.claimSeq,
    ...(state.firstSegment !== undefined ? { firstSegment: state.firstSegment } : {}),
    ...(state.segment !== undefined ? { segment: state.segment } : {}),
    trimmed: { ...state.trimmed },
  };
}

/** 写 API 走这里：打脏标记 + 去抖（读路径**永不**调用它）。 */
function markDirty(collectionId: string): void {
  if (!hasStoragePort()) return;
  dirtyCollections.add(collectionId);
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushDocumentLedgerPersistence();
  }, PERSIST_DEBOUNCE_MS);
  // 不让这个计时器拖住测试/Node 进程（浏览器侧没有 unref，是可选调用）
  const timer = persistTimer as unknown as { unref?: () => void };
  if (typeof timer?.unref === "function") timer.unref();
}

/**
 * **立即**把待写账本落盘（去抖窗口的唯一出口）。
 *
 * 什么时候必须立刻落：① 模型显式记账（`doc_ledger` 的 claim/verify/section）——
 * 那一刻的承诺是「已记账」，不能等到 200ms 后；② 测试模拟重启前。
 * 返回后 `dirtyCollections` 为空（写失败也只 warn，不抛 —— 账本不是关键路径）。
 */
export function flushDocumentLedgerPersistence(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dirtyCollections.size === 0) return;
  const pending = [...dirtyCollections];
  dirtyCollections.clear();
  if (!hasStoragePort()) return;
  for (const collectionId of pending) {
    const state = ledgers.get(collectionId);
    if (!state) continue;
    try {
      setSettingJSON(PERSIST_KEY_PREFIX + collectionId, toPersisted(collectionId, state));
    } catch (e) {
      warnLedger(`账本落盘失败（本次仅保留在内存，重启会丢）：${collectionId}`, e);
    }
  }
}

function sectionKey(documentId: string, headingPath: string): string {
  return `${documentId}§${headingPath}`;
}

/**
 * 记录/升级一个章节的状态。
 *
 * @returns 是否真的升级了（同状态或降级都返回 false —— 用于「别把已验冲掉」的判据）。
 */
export function recordDocumentSection(params: {
  collectionId: string;
  documentId: string;
  headingPath: string;
  status: Exclude<SectionCoverage, "unread">;
  pageFrom?: number;
  pageTo?: number;
}): boolean {
  const heading = params.headingPath.trim();
  if (!heading) return false;
  markDirty(params.collectionId);
  const state = ledger(params.collectionId);
  const key = sectionKey(params.documentId, heading);
  const existing = state.sections.get(key);
  const nextRank = SECTION_RANK[params.status];
  if (existing && existing.status !== "unread" && SECTION_RANK[existing.status] >= nextRank) {
    // 已更强：只补页码（不降级）
    if (existing.pageFrom == null && params.pageFrom != null) existing.pageFrom = params.pageFrom;
    if (existing.pageTo == null && params.pageTo != null) existing.pageTo = params.pageTo;
    return false;
  }
  state.sections.set(key, {
    documentId: params.documentId,
    headingPath: heading,
    status: params.status,
    pageFrom: params.pageFrom ?? existing?.pageFrom,
    pageTo: params.pageTo ?? existing?.pageTo,
    at: Date.now(),
  });
  trim(state);
  return true;
}

/** 记录一次检索命中（文件 + chunk + 章节「已读」）。 */
export function recordDocumentSearch(collectionId: string, hits: DocumentSearchHit[]): void {
  const state = ledger(collectionId);
  for (const hit of hits) {
    if (state.files.size < MAX_FILES) {
      const existing = state.files.get(hit.document_id);
      if (!existing) {
        state.files.set(hit.document_id, {
          id: hit.document_id,
          name: hit.name ?? hit.document_id,
          pages: hit.page_to || undefined,
          status: hit.status,
        });
      } else if (!existing.pages && hit.page_to) {
        existing.pages = hit.page_to;
      }
    }
    const key = `${hit.document_id}#${hit.chunk_no}`;
    if (state.reads.size < MAX_READS && !state.reads.has(key)) {
      state.reads.set(key, {
        documentId: hit.document_id,
        chunkNo: hit.chunk_no,
        pageFrom: hit.page_from,
        pageTo: hit.page_to,
        headingPath: hit.heading_path ?? null,
        at: Date.now(),
      });
    }
    if (hit.heading_path) {
      recordDocumentSection({
        collectionId,
        documentId: hit.document_id,
        headingPath: hit.heading_path,
        status: "read",
        pageFrom: hit.page_from,
        pageTo: hit.page_to,
      });
    }
  }
  markDirty(collectionId);
  trim(state);
}

/**
 * 用**刚观察到的版本**更新账本记录。
 *
 * ## 为什么必须允许刷新（C06 硬闸「同步后可正常完成」的前提）
 *
 * 旧实现在「已经记过版本」时**永不更新** `updatedAt/sha256` ⇒ 文档一旦被改过，
 * 账本就**永远**报告「读过之后变了」：模型重新 `doc_read` 一次也回不到已同步状态，
 * 于是任何基于该事实的完成门都会把回合**永久卡住**（正是 agent-teams 那边
 * 「只搜到过、没读过版本」被单独排除掉的那类坑）。
 *
 * 语义因此定为「**最后一次读它时它是哪一版**」：新观察到的版本更晚、或哈希不同 ⇒ 刷新。
 * **不降级**（读到更旧的副本不该把账本的版本往回退）。
 */
function applyObservedVersion(file: LedgerFile, updatedAt?: number, sha256?: string | null): void {
  if (typeof updatedAt === "number" && (file.updatedAt == null || updatedAt > file.updatedAt)) {
    file.updatedAt = updatedAt;
  }
  if (typeof sha256 === "string" && sha256.length > 0 && file.sha256 !== sha256) {
    file.sha256 = sha256;
  }
}

/** 记录一次定点阅读（`doc_read`）。 */
export function recordDocumentRead(params: {
  collectionId: string;
  documentId: string;
  documentName?: string;
  chunkNo?: number;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
  /** 文档版本（`updated_at` / `sha256`）：跨轮做「文档是否变过」的检查 */
  updatedAt?: number;
  sha256?: string | null;
}): void {
  const state = ledger(params.collectionId);
  if (params.documentName && state.files.size < MAX_FILES) {
    const existing = state.files.get(params.documentId);
    if (!existing) {
      state.files.set(params.documentId, {
        id: params.documentId,
        name: params.documentName,
        pages: params.pageTo || undefined,
        ...(typeof params.updatedAt === "number" ? { updatedAt: params.updatedAt } : {}),
        ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
      });
    } else {
      if (!existing.pages && params.pageTo) existing.pages = params.pageTo;
      applyObservedVersion(existing, params.updatedAt, params.sha256);
    }
  }
  if (typeof params.chunkNo === "number" && state.reads.size < MAX_READS) {
    state.reads.set(`${params.documentId}#${params.chunkNo}`, {
      documentId: params.documentId,
      chunkNo: params.chunkNo,
      pageFrom: params.pageFrom,
      pageTo: params.pageTo,
      headingPath: params.headingPath ?? null,
      at: Date.now(),
    });
  }
  if (params.headingPath) {
    recordDocumentSection({
      collectionId: params.collectionId,
      documentId: params.documentId,
      headingPath: params.headingPath,
      status: "read",
      pageFrom: params.pageFrom,
      pageTo: params.pageTo,
    });
  }
  markDirty(params.collectionId);
  trim(state);
}

/** 记录一条带 citation 的事实（由检索/阅读结果推导，不是模型自述）。 */
export function recordDocumentFact(collectionId: string, fact: string): void {
  const text = fact.trim();
  if (!text) return;
  const state = ledger(collectionId);
  if (state.facts.some((f) => f.text === text)) return;
  state.facts.push({ text, at: Date.now() });
  markDirty(collectionId);
  trim(state);
}

/**
 * 记录文档大纲（`doc_outline` 一份文档时调用）。
 *
 * 为什么要存全量标题：只有知道「这份文档有哪些章节」，才能把**从未碰过**的章节
 * 列成「未读」；否则账本只能显示读过的，读者会误以为「没列出来的就是不存在」。
 */
export function recordDocumentOutline(params: {
  collectionId: string;
  documentId: string;
  documentName: string;
  headings: string[];
  pages?: number;
  status?: string;
  updatedAt?: number;
  sha256?: string | null;
}): void {
  const state = ledger(params.collectionId);
  const unique = [...new Set(params.headings.map((h) => h.trim()).filter(Boolean))];
  const existing = state.files.get(params.documentId);
  if (existing) {
    existing.headings = unique;
    if (!existing.pages && params.pages) existing.pages = params.pages;
    applyObservedVersion(existing, params.updatedAt, params.sha256);
  } else if (state.files.size < MAX_FILES) {
    state.files.set(params.documentId, {
      id: params.documentId,
      name: params.documentName,
      pages: params.pages,
      status: params.status,
      headings: unique,
      ...(typeof params.updatedAt === "number" ? { updatedAt: params.updatedAt } : {}),
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
    });
  }
  markDirty(params.collectionId);
  trim(state);
}

/** 记录一条 claim —— **必须**带 citation，否则直接拒绝（C06「每个 claim 可回溯」）。 */
export function recordDocumentClaim(params: {
  collectionId: string;
  claim: string;
  citation: ClaimCitation;
}): DocumentClaimState {
  const text = params.claim.trim();
  if (!text) throw new Error("claim 不能为空");
  const citation = params.citation;
  if (!citation || typeof citation.documentId !== "string" || !citation.documentId.trim()) {
    throw new Error("claim 缺少 citation（必须给出 documentId + chunk/页/章节）");
  }
  const hasLocator =
    typeof citation.chunkNo === "number" ||
    typeof citation.pageFrom === "number" ||
    Boolean(citation.headingPath && citation.headingPath.trim());
  if (!hasLocator) {
    throw new Error("claim 的 citation 只有 documentId，没有 chunk/页/章节 —— 无法回到原文");
  }
  const state = ledger(params.collectionId);
  state.claimSeq += 1;
  const id = `claim_${state.claimSeq}`;
  const record: DocumentClaimState = {
    id,
    text,
    citation: { ...citation, documentId: citation.documentId.trim() },
    verified: false,
    at: Date.now(),
  };
  state.claims.set(id, record);
  if (citation.headingPath) {
    recordDocumentSection({
      collectionId: params.collectionId,
      documentId: record.citation.documentId,
      headingPath: citation.headingPath,
      status: "read",
      pageFrom: citation.pageFrom,
      pageTo: citation.pageTo,
    });
  }
  markDirty(params.collectionId);
  trim(state);
  return record;
}

/** 标记 claim 已验证（章节状态一并升到 `verified`）。返回是否真的改动。 */
export function verifyDocumentClaim(collectionId: string, claimId: string): boolean {
  const state = ledger(collectionId);
  const claim = state.claims.get(claimId);
  if (!claim) return false;
  const changed = !claim.verified;
  claim.verified = true;
  if (claim.citation.headingPath) {
    recordDocumentSection({
      collectionId,
      documentId: claim.citation.documentId,
      headingPath: claim.citation.headingPath,
      status: "verified",
      pageFrom: claim.citation.pageFrom,
      pageTo: claim.citation.pageTo,
    });
  }
  if (changed) markDirty(collectionId);
  return changed;
}

/**
 * 记录「本轮处于第几段」。
 *
 * 只观察、不重置：账本按集合存，段号翻篇**不会**掉覆盖 —— 这是 C06
 * 「压缩/换段后保留覆盖状态」的结构保证（渲染时会写出「覆盖保留自第 N 段」）。
 */
export function noteDocumentLedgerSegment(collectionId: string, segmentSeq: number): void {
  const seq = Math.max(1, Math.floor(Number(segmentSeq) || 1));
  const state = ledger(collectionId);
  if (state.firstSegment === undefined) state.firstSegment = seq;
  state.segment = seq;
  markDirty(collectionId);
}

/**
 * 上限裁剪：**最旧的先裁**，裁掉的条数计进 `state.trimmed`（可观测）。
 *
 * 上限与落盘共用同一组常量 —— 否则「重启前有、重启后没了」会成为静默失真。
 */
function trim(state: LedgerState): void {
  if (state.facts.length > MAX_FACTS) {
    state.trimmed.facts += state.facts.length - MAX_FACTS;
    state.facts = state.facts.slice(-MAX_FACTS);
  }
  if (state.reads.size > MAX_READS) {
    const entries = [...state.reads.entries()].sort((a, b) => a[1].at - b[1].at);
    const drop = entries.slice(0, entries.length - MAX_READS);
    for (const [key] of drop) state.reads.delete(key);
    state.trimmed.reads += drop.length;
  }
  if (state.files.size > MAX_FILES) {
    const extra = [...state.files.keys()].slice(0, state.files.size - MAX_FILES);
    for (const key of extra) state.files.delete(key);
    state.trimmed.files += extra.length;
  }
  if (state.sections.size > MAX_SECTIONS) {
    const entries = [...state.sections.entries()].sort((a, b) => a[1].at - b[1].at);
    const drop = entries.slice(0, entries.length - MAX_SECTIONS);
    for (const [key] of drop) state.sections.delete(key);
    state.trimmed.sections += drop.length;
  }
  if (state.claims.size > MAX_CLAIMS) {
    const entries = [...state.claims.values()].sort((a, b) => a.at - b.at);
    const drop = entries.slice(0, entries.length - MAX_CLAIMS);
    for (const claim of drop) state.claims.delete(claim.id);
    state.trimmed.claims += drop.length;
  }
}

function citationOf(state: LedgerState, read: LedgerRead): string {
  const file = state.files.get(read.documentId);
  const name = file?.name ?? read.documentId;
  const page =
    typeof read.pageFrom === "number"
      ? read.pageFrom === read.pageTo || read.pageTo == null
        ? `p.${read.pageFrom}`
        : `p.${read.pageFrom}-${read.pageTo}`
      : "";
  const heading = read.headingPath ? ` §${read.headingPath}` : "";
  return `${name} ${page}${heading} (chunk ${read.chunkNo})`.replace(/\s+/g, " ").trim();
}

/** claim 的引用渲染（与 `doc_search` 的 citation 同构，便于逐条回溯）。 */
function renderClaimCitation(state: LedgerState, citation: ClaimCitation): string {
  const name = state.files.get(citation.documentId)?.name ?? citation.documentId;
  const parts = [`file: ${name}`];
  if (typeof citation.pageFrom === "number" && citation.pageFrom > 0) {
    parts.push(
      typeof citation.pageTo === "number" && citation.pageTo > citation.pageFrom
        ? `page: ${citation.pageFrom}-${citation.pageTo}`
        : `page: ${citation.pageFrom}`,
    );
  }
  if (citation.headingPath) parts.push(`§${citation.headingPath}`);
  if (typeof citation.chunkNo === "number") parts.push(`chunk: ${citation.documentId}#${citation.chunkNo}`);
  else parts.push(`doc: ${citation.documentId}`);
  return `[${parts.join(" | ")}]`;
}

/** 未读章节：大纲里有、账本里从未碰过的标题。 */
function unreadSections(state: LedgerState): Array<{ documentId: string; name: string; headingPath: string }> {
  const out: Array<{ documentId: string; name: string; headingPath: string }> = [];
  for (const file of state.files.values()) {
    for (const heading of file.headings ?? []) {
      const section = state.sections.get(sectionKey(file.id, heading));
      if (!section) out.push({ documentId: file.id, name: file.name, headingPath: heading });
    }
  }
  return out;
}

/** 已读但未验的章节（`read`/`edited` 且不是 `verified`）。 */
function unverifiedSections(state: LedgerState): DocumentSectionState[] {
  return [...state.sections.values()].filter((s) => s.status !== "verified");
}

/** 只读快照（工具/UI/判据共用；不含任何写操作）。 */
interface DocumentLedgerSnapshot {
  collectionId: string;
  hasContent: boolean;
  segment: { first?: number; current?: number };
  files: Array<{
    id: string;
    name: string;
    pages?: number;
    status?: string;
    updatedAt?: number;
    sha256?: string | null;
    headings: number;
  }>;
  reads: Array<{ documentId: string; chunkNo: number; citation: string }>;
  sections: DocumentSectionState[];
  unread: Array<{ documentId: string; name: string; headingPath: string }>;
  unverified: DocumentSectionState[];
  claims: Array<{ id: string; text: string; verified: boolean; citation: string }>;
  counts: { files: number; reads: number; sections: number; unread: number; unverified: number; claims: number; verifiedClaims: number };
  /** 超限裁剪掉的条数（按类别累计；「上限生效」不能是静默的） */
  trimmed: TrimCounters;
}

export function documentLedgerSnapshot(collectionId: string): DocumentLedgerSnapshot {
  const state = ledger(collectionId);
  const empty: DocumentLedgerSnapshot = {
    collectionId,
    hasContent: false,
    segment: {},
    files: [],
    reads: [],
    sections: [],
    unread: [],
    unverified: [],
    claims: [],
    counts: { files: 0, reads: 0, sections: 0, unread: 0, unverified: 0, claims: 0, verifiedClaims: 0 },
    trimmed: emptyTrimmed(),
  };
  const reads = [...state.reads.values()].map((r) => ({
    documentId: r.documentId,
    chunkNo: r.chunkNo,
    citation: citationOf(state, r),
  }));
  const sections = [...state.sections.values()];
  const unread = unreadSections(state);
  const unverified = sections.filter((s) => s.status !== "verified");
  const claims = [...state.claims.values()].map((c) => ({
    id: c.id,
    text: c.text,
    verified: c.verified,
    citation: renderClaimCitation(state, c.citation),
  }));
  const hasContent =
    state.files.size > 0 || state.reads.size > 0 || state.facts.length > 0 || sections.length > 0 || claims.length > 0;
  if (!hasContent) return { ...empty, trimmed: { ...state.trimmed } };
  return {
    collectionId,
    hasContent,
    segment: {
      ...(state.firstSegment !== undefined ? { first: state.firstSegment } : {}),
      ...(state.segment !== undefined ? { current: state.segment } : {}),
    },
    files: [...state.files.values()].map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.pages ? { pages: f.pages } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.updatedAt !== undefined ? { updatedAt: f.updatedAt } : {}),
      ...(f.sha256 !== undefined ? { sha256: f.sha256 } : {}),
      headings: f.headings?.length ?? 0,
    })),
    reads,
    sections,
    unread,
    unverified,
    claims,
    counts: {
      files: state.files.size,
      reads: state.reads.size,
      sections: sections.length,
      unread: unread.length,
      unverified: unverified.length,
      claims: claims.length,
      verifiedClaims: claims.filter((c) => c.verified).length,
    },
    trimmed: { ...state.trimmed },
  };
}

/**
 * 文档版本同步检查（C06「代码任务完成后检查相关文档版本是否同步」）。
 *
 * 语义**刻意保守**：账本记下读它那一刻的 `updated_at`/`sha256`；这里重新读当前文档行，
 * 只回答「这份文档在读过之后有没有变」以及「还有多少章节/claim 没验」。
 *
 * 返回 `ok=false` 的理由可能同时有多个（变更 / 未验 / 读不到），三者分开列，
 * 不合并成一个笼统的「不同步」。
 *
 * ## `versioned` / `unreadable` / `versionless`（C06 硬闸用）
 *
 * `unknown` 沿旧语义把「**没记过版本**」与「带版本但读不到」混在一起；而完成门
 * 只该被**前者以外**的情况拦（agent-teams 那边踩过：只搜到过的文档会把任务永久卡住）。
 * 所以额外给出三个可判定的分量：
 * - `versioned`：有版本记录、参与了比对的文档数（**0 ⇒ 硬闸不成立**）；
 * - `unreadable`：带版本但当前读不到（`unknown` 的子集，足以拦完成）；
 * - `versionless`：没记过版本（不参与比对，也不阻塞）。
 *
 * ## `currentSha256` / `unreadableFacts`（C06 硬闸按「文档 + 版本」记账用）
 *
 * 硬闸要回答「**这一版**是不是已经拦过」：只记 `updated_at` 会漏掉「文件被替换、
 * 时间戳没变但 sha 变了」的新版本。所以 `changed` 额外带当前的 `sha256`；
 * 读不到的文档则给出结构化事实（id + 账本记录的版本），否则硬闸只能拿名字当身份。
 */
export async function documentSyncCheck(collectionId: string): Promise<{
  ok: boolean;
  checked: number;
  changed: Array<{
    documentId: string;
    name: string;
    recordedUpdatedAt?: number;
    currentUpdatedAt?: number;
    /** 当前文档的 sha256（有就带上：硬闸拿它区分「同一时间戳的新版本」） */
    currentSha256?: string;
  }>;
  unknown: string[];
  versioned: number;
  unreadable: string[];
  /** `unreadable` 的结构化版本（文档 id + 账本记录的版本；硬闸按它记账） */
  unreadableFacts: Array<{
    documentId: string;
    name: string;
    recordedUpdatedAt?: number;
    recordedSha256?: string | null;
  }>;
  versionless: string[];
  unreadSections: number;
  unverifiedSections: number;
  unverifiedClaims: number;
}> {
  const state = ledger(collectionId);
  const changed: Array<{
    documentId: string;
    name: string;
    recordedUpdatedAt?: number;
    currentUpdatedAt?: number;
    currentSha256?: string;
  }> = [];
  const unknown: string[] = [];
  const unreadable: string[] = [];
  const unreadableFacts: Array<{
    documentId: string;
    name: string;
    recordedUpdatedAt?: number;
    recordedSha256?: string | null;
  }> = [];
  const versionless: string[] = [];
  let versioned = 0;
  const files = [...state.files.values()].slice(0, DOCUMENT_SYNC_MAX_FILES);
  for (const file of files) {
    if (file.updatedAt == null && file.sha256 == null) {
      versionless.push(file.name);
      unknown.push(file.name);
      continue;
    }
    versioned += 1;
    try {
      const doc = await getDocument(file.id);
      const versionChanged =
        (file.updatedAt != null && typeof doc.updated_at === "number" && doc.updated_at > file.updatedAt) ||
        (file.sha256 != null && typeof doc.sha256 === "string" && doc.sha256 !== file.sha256);
      if (versionChanged) {
        changed.push({
          documentId: file.id,
          name: file.name,
          ...(file.updatedAt !== undefined ? { recordedUpdatedAt: file.updatedAt } : {}),
          ...(typeof doc.updated_at === "number" ? { currentUpdatedAt: doc.updated_at } : {}),
          ...(typeof doc.sha256 === "string" ? { currentSha256: doc.sha256 } : {}),
        });
      }
    } catch {
      // 读不到（已删除/索引不可用）不算「同步」—— 如实报 unknown，不假装通过。
      unknown.push(file.name);
      unreadable.push(file.name);
      unreadableFacts.push({
        documentId: file.id,
        name: file.name,
        ...(file.updatedAt !== undefined ? { recordedUpdatedAt: file.updatedAt } : {}),
        ...(file.sha256 !== undefined ? { recordedSha256: file.sha256 } : {}),
      });
    }
  }
  const unread = unreadSections(state).length;
  const unverified = unverifiedSections(state).length;
  const unverifiedClaims = [...state.claims.values()].filter((c) => !c.verified).length;
  return {
    ok: changed.length === 0 && unknown.length === 0,
    checked: files.length,
    changed,
    unknown,
    versioned,
    unreadable,
    unreadableFacts,
    versionless,
    unreadSections: unread,
    unverifiedSections: unverified,
    unverifiedClaims,
  };
}

/** 渲染 ledger 文本（没有内容时返回空串 —— 不把普通对话变成永远带一段固定文本）。 */
export function renderDocumentLedger(collectionId: string, maxTokens = 2000): string {
  const state = ledger(collectionId);
  if (
    state.files.size === 0 &&
    state.reads.size === 0 &&
    state.facts.length === 0 &&
    state.sections.size === 0 &&
    state.claims.size === 0
  ) {
    return "";
  }

  const lines: string[] = ["[文档索引]"];
  if (state.files.size > 0) {
    lines.push("文件:");
    for (const file of state.files.values()) {
      const pages = file.pages ? ` · ${file.pages} 页` : "";
      const status = file.status && file.status !== "ready" ? ` · ${file.status}` : "";
      lines.push(`- ${file.name}${pages}${status}（id: ${file.id}）`);
    }
  }
  /**
   * 跨段保留要**看得见**：不写这一行，模型会以为账本只覆盖当前段；
   * 写了才知道有些结论来自上一段（必要时重读）。
   */
  if (state.segment !== undefined && state.firstSegment !== undefined && state.segment > state.firstSegment) {
    lines.push(`覆盖: 第 ${state.firstSegment} 段 → 第 ${state.segment} 段（覆盖保留，未丢失）`);
  }
  const sections = [...state.sections.values()];
  const unread = unreadSections(state);
  const unverified = sections.filter((s) => s.status !== "verified");
  if (sections.length > 0 || unread.length > 0) {
    const byStatus = {
      read: sections.filter((s) => s.status === "read").length,
      edited: sections.filter((s) => s.status === "edited").length,
      verified: sections.filter((s) => s.status === "verified").length,
    };
    lines.push(
      `章节: 已读 ${byStatus.read} / 已改 ${byStatus.edited} / 已验 ${byStatus.verified} / 未读 ${unread.length}`,
    );
  }
  if (unread.length > 0) {
    lines.push("未读章节:");
    for (const item of unread.slice(0, MAX_UNREAD_LINES)) lines.push(`- ${item.name} §${item.headingPath}`);
  }
  if (unverified.length > 0) {
    lines.push("未验章节:");
    for (const item of unverified.slice(0, MAX_UNREAD_LINES)) {
      const name = state.files.get(item.documentId)?.name ?? item.documentId;
      const page = typeof item.pageFrom === "number" ? ` · p.${item.pageFrom}` : "";
      lines.push(`- ${name} §${item.headingPath}${page}（${item.status}）`);
    }
  }
  if (state.reads.size > 0) {
    lines.push("已读:");
    const reads = [...state.reads.values()].sort((a, b) => a.at - b.at).slice(-12);
    for (const read of reads) lines.push(`- ${citationOf(state, read)}`);
  }
  if (state.claims.size > 0) {
    const claims = [...state.claims.values()];
    const pending = claims.filter((c) => !c.verified);
    if (pending.length > 0) {
      lines.push("待验证的结论:");
      for (const claim of pending.slice(-MAX_CLAIM_LINES)) {
        lines.push(`- ${claim.text} ← ${renderClaimCitation(state, claim.citation)}`);
      }
    }
    const verified = claims.filter((c) => c.verified);
    if (verified.length > 0) {
      lines.push("已验证的结论:");
      for (const claim of verified.slice(-MAX_CLAIM_LINES)) {
        lines.push(`- ${claim.text} ← ${renderClaimCitation(state, claim.citation)}`);
      }
    }
  }
  if (state.facts.length > 0) {
    lines.push("已确认:");
    for (const fact of state.facts.slice(-12)) lines.push(`- ${fact.text}`);
  }
  lines.push("[用法] 需要更多内容用 doc_read；不要整篇读入。");

  const rendered = lines.join("\n");
  /*
   * 截断要把**后缀本身**也算进预算：先按 `maxTokens - 24` 截正文，再拼后缀。
   * （否则「≤2,000 token」这条判据会被后缀顶出去 —— 实测 2,007。）
   */
  const suffix = "\n…（ledger 已截断）";
  const { text, truncated } = truncateToTokens(rendered, Math.max(0, maxTokens - 24));
  return truncated ? `${text}${suffix}` : text;
}

/** 某集合是否已有 ledger 内容（用于「是否注入」判断）。 */
export function hasDocumentLedger(collectionId: string): boolean {
  const state = ledger(collectionId);
  return (
    state.files.size > 0 ||
    state.reads.size > 0 ||
    state.facts.length > 0 ||
    state.sections.size > 0 ||
    state.claims.size > 0
  );
}

/**
 * 判据用：清空全部内存状态（含"已加载"标记与去抖计时器）。
 *
 * ⚠️ 它**不删磁盘上的账本** —— 清空后再读会**重新懒加载**，这正是「模拟重启」的做法
 * （见 `doc-ledger-coverage.test.ts` 的 C06-6）。
 */
export function __resetDocumentLedgerForTests(): void {
  ledgers.clear();
  loadedCollections.clear();
  dirtyCollections.clear();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
