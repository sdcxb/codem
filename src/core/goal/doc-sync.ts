/**
 * Goal × C06 接线：**完成前的独立文档同步检查**。
 *
 * ## 为什么需要它
 *
 * C06 的文档同步硬闸在 `agentic-loop` 的收尾出口 —— 它只覆盖普通回合。
 * Goal Runner 有两条完成路径**不经过**那条收尾守卫：
 * 1. 里程碑完成：「阶段验收通过 ⇒ 标 done」；
 * 2. 目标完成：「所有阶段 done + 整体验收通过 ⇒ 标 completed」。
 * 于是目标可以在文档版本落后的情况下被标成 completed。这里的检查把两条路径都补上：
 * 引用了文档、而文档在读过之后变了（或读不到）⇒ **不标完成**，
 * 目标 blocked 并带上具体原因（阶段级 / 目标级原因可区分）。
 *
 * ## 判定逻辑不复制
 *
 * 版本比较全部由 C06 的 `documentSyncCheck`（`document/ledger.ts`）完成；本文件只做两件
 * C06 没有、而 Goal 需要的事：
 * 1. 从验收项里认出「这次完成引用了哪些文档」（复用 C10 的 `isDocumentRef` 口径）；
 * 2. 把 `documentSyncCheck` 返回的版本事实**筛选到这些引用上** —— 账本里别的文档 stale
 *    不代表这次完成引用的文档 stale。
 *
 * **阶段级与目标级共用同一实现**（{@link checkDocumentSyncForAcceptances}）：区别只有
 * 验收项来源（阶段 / 目标契约）与原因文案里的主体（「里程碑」/「目标」）。
 *
 * ## 边界（如实标注）
 *
 * - **没有文档引用** ⇒ `checked:false` 且**不阻塞**：代码/测试类完成项的文档同步
 *   检查尚未接入（没有可比的文档，不能假装检查过）。
 * - 引用了文档、但账本里这些文档**没有版本记录**（只有检索命中）⇒ 同样 `checked:false`
 *   且不阻塞：没有版本事实就永远无法证明「已同步」，阻塞会制造永久死锁
 *   （agent-teams 的 C10 完成门踩过同一个坑）。
 * - 账本版本检查只看前 `DOCUMENT_SYNC_MAX_FILES` 份（与 `documentSyncCheck` 同一窗口）。
 */

import { DOCUMENT_SYNC_MAX_FILES, documentLedgerSnapshot, documentSyncCheck } from "../document/ledger";
import { collectionIdForSession } from "../document/session-collection";
import { isDocumentRef } from "../agent-teams/doc-sync";
import type { Acceptance, PlanPhase } from "./types";

/** 完成前检查的结果（`ok:false` ⇒ 这次完成不标、目标 blocked）。 */
interface GoalDocSyncVerdict {
  /** 是否真的做了版本比对（false = 无引用/无版本事实，不阻塞） */
  checked: boolean;
  /** 是否允许标记完成 */
  ok: boolean;
  /** 人可读原因（`ok:false` 时进 blockedReason；`checked:false` 时说明「为什么没接入」） */
  reason: string;
  /** 这次完成引用的文档坐标（首次出现优先） */
  refs: string[];
  /** 读过之后版本变了的文档名 */
  changed: string[];
  /** 带版本但当前读不到的文档名 */
  unreadable: string[];
}

/** 检查主体：阶段级（里程碑）或目标级。只影响原因文案。 */
type DocSyncSubject = "phase" | "goal";

function subjectLabel(subject: DocSyncSubject): string {
  return subject === "phase" ? "里程碑" : "目标";
}

/** 取路径的文件名部分（Windows / POSIX 分隔符都认）。 */
function basename(value: string): string {
  const parts = value.replace(/\\/gu, "/").split("/");
  return parts[parts.length - 1] ?? value;
}

/**
 * 判断账本里的一条文档事实是否属于这次完成引用的那份文档。
 *
 * 账本记的 `name` 通常是文件名（`报告.docx`），而验收里的 `path` 可能是
 * `docs/报告.docx` 或 `D:\work\报告.docx` ⇒ 按文件名比较（大小写不敏感，Windows 语义）。
 * 文档 id 与引用完全相等时也算命中（引用可以直接写 id）。
 */
function refMatchesDocument(ref: string, name: string, documentId?: string): boolean {
  if (documentId && ref === documentId) return true;
  const refName = basename(ref).toLowerCase();
  const ledgerName = basename(name).toLowerCase();
  return refName.length > 0 && refName === ledgerName;
}

/**
 * 从验收项里收集**引用的文档**。
 *
 * 认**任何带 `path` 的验收项**（artifact / file / 其它 kind）：只要路径扩展名是文档，
 * 它就是可回溯的坐标。旧实现只认 `kind=artifact`，会漏掉 `kind=file` 的 README/设计稿。
 * `outcome`/`title`/`description` 里的「更新 README」只是自然语言描述，拿来当门禁会误伤
 * （而且无法回溯到具体文件），所以**不参与**。
 *
 * 阶段级与目标级共用：阶段传 `phase.acceptance`，目标传 `goal.acceptance`。
 */
function collectAcceptanceDocumentRefs(acceptances: readonly Acceptance[] | undefined): string[] {
  const refs = new Set<string>();
  for (const acceptance of acceptances ?? []) {
    if (!acceptance) continue;
    const path = typeof acceptance.path === "string" ? acceptance.path.trim() : "";
    if (!path) continue;
    // `kind` 传 undefined：这里只按扩展名认文档（C10 的 `doc` 语义是任务证据类型，不适用于工件路径）
    if (!isDocumentRef(undefined, path)) continue;
    refs.add(path);
  }
  return [...refs];
}

/**
 * 对一组验收项引用的文档做一次**真实**的 C06 版本同步检查。
 *
 * 返回值即 Runner 的完成前检查结果：`ok:false` 时 Runner 不标完成。
 * 这是阶段级与目标级的**唯一实现** —— 主体只影响原因文案。
 */
async function checkDocumentSyncForAcceptances(input: {
  sessionId: string;
  acceptances: readonly Acceptance[] | undefined;
  subject: DocSyncSubject;
}): Promise<GoalDocSyncVerdict> {
  const label = subjectLabel(input.subject);
  const refs = collectAcceptanceDocumentRefs(input.acceptances);
  if (refs.length === 0) {
    return {
      checked: false,
      ok: true,
      refs,
      changed: [],
      unreadable: [],
      reason:
        input.subject === "phase"
          ? "里程碑没有文档引用 —— 独立文档检查未接入（代码/测试类里程碑不阻塞）"
          : "目标没有文档引用 —— 独立文档检查未接入（目标验收不阻塞）",
    };
  }

  const collectionId = collectionIdForSession(input.sessionId);
  let sync: Awaited<ReturnType<typeof documentSyncCheck>>;
  try {
    sync = await documentSyncCheck(collectionId);
  } catch (e) {
    /*
     * 检查本身失败 = 没有取得版本事实。按「未接入」处理（不阻塞），
     * 但原因里必须写清失败，而不是让调用方以为「已检查且同步」。
     */
    return {
      checked: false,
      ok: true,
      refs,
      changed: [],
      unreadable: [],
      reason: `${label}的文档同步检查执行失败（未取得版本事实，不阻塞）：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (sync.versioned <= 0) {
    return {
      checked: false,
      ok: true,
      refs,
      changed: [],
      unreadable: [],
      reason: `${label}引用了文档（${refs.join("、")}），但账本里没有带版本的文档 —— 未做版本比对（不阻塞）`,
    };
  }

  /*
   * 引用的文档必须**真的在比对窗口里且有版本**，否则这次 `documentSyncCheck` 没检查到它：
   * 只有 `versioned>0`（别的文档有版本）不足以说「引用已核对」。
   */
  const referencedVersioned = documentLedgerSnapshot(collectionId)
    .files.slice(0, DOCUMENT_SYNC_MAX_FILES)
    .some(
      (file) =>
        (file.updatedAt !== undefined || file.sha256 !== undefined) &&
        refs.some((ref) => refMatchesDocument(ref, file.name, file.id)),
    );
  if (!referencedVersioned) {
    return {
      checked: false,
      ok: true,
      refs,
      changed: [],
      unreadable: [],
      reason: `${label}引用的文档在账本里没有版本记录（${refs.join("、")}）—— 未做版本比对（不阻塞）`,
    };
  }

  const changed = sync.changed
    .filter((item) => refs.some((ref) => refMatchesDocument(ref, item.name, item.documentId)))
    .map((item) => item.name);
  const unreadable = sync.unreadable.filter((name) => refs.some((ref) => refMatchesDocument(ref, name)));
  if (changed.length > 0 || unreadable.length > 0) {
    const facts: string[] = [];
    if (changed.length > 0) facts.push(`读过之后变了：${changed.join("、")}`);
    if (unreadable.length > 0) facts.push(`现在读不到：${unreadable.join("、")}`);
    return {
      checked: true,
      ok: false,
      refs,
      changed,
      unreadable,
      reason: `C06 文档版本未同步（${label}）：${facts.join("；")}`,
    };
  }
  return {
    checked: true,
    ok: true,
    refs,
    changed: [],
    unreadable: [],
    reason: `C06 已检查 ${sync.versioned} 份带版本文档，${label}引用的文档版本未变化`,
  };
}

/**
 * 阶段级（里程碑）完成前的文档同步检查。
 *
 * `ok:false` 时 Runner **不把阶段标 done**、目标 blocked 且 reason 可见。
 */
export async function checkGoalPhaseDocumentSync(input: {
  sessionId: string;
  phase: PlanPhase;
}): Promise<GoalDocSyncVerdict> {
  return checkDocumentSyncForAcceptances({
    sessionId: input.sessionId,
    acceptances: input.phase.acceptance,
    subject: "phase",
  });
}

/**
 * 目标级（`goal.acceptance`）完成前的文档同步检查 —— 与阶段级**同一实现**。
 *
 * 调用点：Runner 在所有阶段 done、整体验收通过之后、`goal` 标 completed 之前。
 * `ok:false` ⇒ 目标不标 completed（blocked + reason 含「目标」与文档名）。
 */
export async function checkGoalAcceptanceDocumentSync(input: {
  sessionId: string;
  acceptance: readonly Acceptance[] | undefined;
}): Promise<GoalDocSyncVerdict> {
  return checkDocumentSyncForAcceptances({
    sessionId: input.sessionId,
    acceptances: input.acceptance,
    subject: "goal",
  });
}
