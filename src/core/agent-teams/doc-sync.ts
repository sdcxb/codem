/**
 * C10 × C06 接线：把「任务引用的文档」接到**真实文档账本检查**。
 *
 * ## 为什么适配层在服务端，而不在 completion.ts
 *
 * `completion.ts` 是纯函数（不读时钟、不写任务），它的 `DocSyncCheck` 是**同步**谓词 ——
 * 这样引擎的完成门禁可复现、可单测。而 C06 的 `documentSyncCheck` 是**异步**的
 * （要读文档索引里各文档的当前版本）。两者之间的适配放在这里：
 * 服务在调用引擎前先把异步事实取回来，再以同步闭包（返回已取回的结果）交给引擎，
 * 引擎仍走原来的同步路径 —— 不把异步 IO 塞进状态机。
 *
 * ## 什么算「任务引用了文档」
 *
 * 工件/证据里 `kind === "doc"` 的条目，或 ref 以文档扩展名结尾
 * （`.md/.pdf/.docx/...`，覆盖「代码任务顺手改了 README」这种形态）。
 * 没有引用 ⇒ `checked:false` **不阻塞**：没有可比的文档，不能假装检查过。
 *
 * ## 什么算「文档未同步」
 *
 * C06 的版本事实是「账本记录时的 `updated_at/sha256` vs 当前版本」，外加
 * 「读不到」的情况。代码改动本身不写文档账本；账本回答的是任务引用的文档
 * 在读过之后有没有变、还能不能读到 —— 这就是 C10 完成门禁可用的同步事实。
 * 版本变化或读不到 ⇒ `synced:false`；账本里没有带版本的文档 ⇒ `checked:false`。
 *
 * ## 覆盖范围：团队**全体成员**（不只实现者 + 队长）
 *
 * 文档账本按集合（项目或 `session:<id>`）存，每个成员读过的文档只记在**他自己**的账本里。
 * 旧实现只查实现者 + 队长：Verifier 或别的 specialist 读过的文档在验收之后变旧，
 * 完成门禁看不见 ⇒ 「团队里有人拿着旧文档验收」也能通过。现在逐个成员检查：
 * 只要**任一成员**（或队长）的账本里出现「读后变化 / 读不到」，就按未同步阻塞，
 * 并在原因里点名**成员 + 文档**。
 *
 * 防死锁仍然保留：没有文档引用 / 没有任何账本 / 账本里全是无版本事实（`doc_search` 命中）
 * 时 `checked:false` 且**不阻塞** —— 那不是「已同步」，只是没有可比对的版本事实。
 * 池里被移出的成员（`status === "removed"`）不再参与：他们已无法重新读文档，
 * 拿他们的旧账本永久卡住完成任务只会制造死锁。
 */

import { documentLedgerSnapshot, documentSyncCheck, hasDocumentLedger } from "../document/ledger";
import { collectionIdForSession } from "../document/session-collection";
import {
  type AgentTeam,
  type DocSyncResult,
  type TaskEvidence,
  type TeamTask,
} from "./types";

/** 文档类路径的扩展名（用于识别「代码证据里其实指着文档」的情况）。 */
const DOCUMENT_REF_RE = /\.(?:md|markdown|mdx|rst|adoc|txt|pdf|docx?|pptx?|xlsx?|csv|html?)$/iu;

/**
 * 文档类引用的判定（C10 任务证据 / Goal 里程碑工件共用同一口径）。
 *
 * 导出它而不是让 Goal 再写一遍：两边对「什么算文档引用」必须是同一个答案，
 * 否则同一份工件在 C10 里算文档、在 Goal 里不算，完成门禁就会漏。
 */
export function isDocumentRef(kind: string | undefined, ref: string | undefined): boolean {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (!value) return false;
  return kind === "doc" || DOCUMENT_REF_RE.test(value);
}

/**
 * 收集任务工件/证据里引用的文档坐标（路径或 docId）。
 *
 * 返回顺序稳定（首次出现优先），便于把原因写进 blockedReason 时复现。
 */
function collectTaskDocumentRefs(task: TeamTask, evidence?: TaskEvidence[]): string[] {
  const refs = new Set<string>();
  const items = [
    ...(Array.isArray(task?.artifacts) ? task.artifacts : []),
    ...(Array.isArray(task?.evidence) ? task.evidence : []),
    ...(Array.isArray(evidence) ? evidence : []),
  ];
  for (const item of items) {
    if (item && isDocumentRef(item.kind, item.ref)) refs.add(item.ref.trim());
  }
  return [...refs];
}

/** 一个可能持有文档账本的文档集合，以及共享这个集合的成员展示名。 */
interface DocumentLedgerOwner {
  collectionId: string;
  /** 队长 / 成员名；同一集合被多人共享时全部保留（原因里要能点名） */
  names: string[];
}

/**
 * 收集团队**所有成员**（含队长）的文档集合坐标。
 *
 * 去重按 `collectionIdForSession` 的结果做：成员各自是独立子会话时会得到
 * `session:<id>`；若某个会话就是当前会话，则归到项目集合 —— 同一集合只查一次。
 */
function documentLedgerOwners(team: AgentTeam): DocumentLedgerOwner[] {
  const owners = new Map<string, Set<string>>();
  const add = (sessionId: string | undefined, name: string): void => {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) return;
    const collectionId = collectionIdForSession(id);
    const names = owners.get(collectionId);
    if (names) names.add(name);
    else owners.set(collectionId, new Set([name]));
  };
  add(team?.captainSessionId, "队长");
  for (const member of team?.members ?? []) {
    if (!member || member.status === "removed") continue;
    add(member.id, member.name);
  }
  return [...owners].map(([collectionId, names]) => ({ collectionId, names: [...names] }));
}

/** 把「成员 → 文档」按成员分组，输出 `成员：文档1、文档2` 形式的原因片段。 */
function ownerFacts(items: Array<{ owners: string; name: string }>): string {
  const byOwner = new Map<string, string[]>();
  for (const item of items) {
    const names = byOwner.get(item.owners);
    if (names) {
      if (!names.includes(item.name)) names.push(item.name);
    } else {
      byOwner.set(item.owners, [item.name]);
    }
  }
  return [...byOwner].map(([owner, names]) => `${owner}：${names.join("、")}`).join("；");
}

/**
 * 对任务引用的文档做一次真实 C06 版本同步检查。
 *
 * 返回值即 `DocSyncCheck` 的结果形状：调用方（服务层）把它包成同步闭包注入引擎。
 */
export async function checkTaskDocumentSync(input: {
  team: AgentTeam;
  task: TeamTask;
  /** 本次更新随附的证据（引擎会在完成判定前登记，这里提前算进来） */
  evidence?: TaskEvidence[];
  /** 实现者标识（成员名 / captain）；仅为兼容旧调用保留，检查范围已覆盖全体成员 */
  by?: string;
}): Promise<DocSyncResult> {
  const { team, task } = input;
  const refs = collectTaskDocumentRefs(task, input.evidence);
  if (refs.length === 0) {
    return {
      synced: true,
      checked: false,
      reason: "任务工件/证据没有引用文档 —— 未做文档版本比对",
    };
  }

  const owners = documentLedgerOwners(team);
  const withLedger = owners.filter((owner) => hasDocumentLedger(owner.collectionId));
  if (withLedger.length === 0) {
    return {
      synced: true,
      checked: false,
      reason: `任务引用了文档（${refs.join(", ")}），但团队所有成员（含队长）的会话都还没有文档账本 —— 未做版本比对`,
    };
  }

  let checked = 0;
  const changed: Array<{ owners: string; name: string }> = [];
  const unknown: Array<{ owners: string; name: string }> = [];
  for (const owner of withLedger) {
    /*
     * 只让**记过版本**的文档参与比对。
     *
     * 账本里的「文件」有两种来源：`doc_read/doc_outline` 会记下 updatedAt/sha256，
     * 而 `doc_search` 命中是没有版本字段的。C06 的 `documentSyncCheck` 对
     * 「没有版本字段」和「读不到」都返回 unknown + ok=false —— 直接拿 ok 当门禁，
     * 会让「只搜到过、没读过版本」的文档把任务**永久**卡住（它永远无法变成已同步）。
     * 所以这里先用 `documentLedgerSnapshot` 区分：无版本的文件不参与、也不阻塞；
     * 真正读不到（版本已记但当前取不到）才按未同步处理。
     */
    const snapshot = documentLedgerSnapshot(owner.collectionId);
    // 与 documentSyncCheck 一致：它只检查账本里前 8 份文件
    const first = snapshot.files.slice(0, 8);
    const versionless = new Set(
      first.filter((file) => file.updatedAt === undefined && file.sha256 === undefined).map((file) => file.name),
    );
    const versioned = first.length - versionless.size;
    if (versioned === 0) continue;
    const sync = await documentSyncCheck(owner.collectionId);
    checked += versioned;
    const ownersLabel = owner.names.join("、");
    for (const item of sync.changed) changed.push({ owners: ownersLabel, name: item.name });
    for (const name of sync.unknown) {
      if (!versionless.has(name)) unknown.push({ owners: ownersLabel, name });
    }
  }
  if (checked === 0) {
    return {
      synced: true,
      checked: false,
      reason: "文档账本里还没有带版本的文档（只有检索命中）—— 未做版本比对（不假装检查过）",
    };
  }
  if (changed.length > 0 || unknown.length > 0) {
    const facts: string[] = [];
    if (changed.length > 0) {
      facts.push(`${changed.length} 份文档在读过之后发生变化（${ownerFacts(changed)}）`);
    }
    if (unknown.length > 0) {
      facts.push(`${unknown.length} 份读不到（${ownerFacts(unknown)}）`);
    }
    return {
      synced: false,
      checked: true,
      reason: `C06 文档版本未同步：${facts.join("；")}`,
    };
  }
  return {
    synced: true,
    checked: true,
    reason: `C06 已检查 ${checked} 份文档，版本未变化`,
  };
}
