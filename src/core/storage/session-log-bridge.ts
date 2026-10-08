/**
 * 会话追加日志 ↔ SQLite 索引的桥接（第 78 波）
 *
 * 为什么要单独一层：`database.ts`（底层）需要"回填日志 + 裁剪索引"，而这两件事只能用
 * `message.ts` 的读接口；如果 `database.ts` 直接 import `message.ts` 就会形成
 * `database → message → database` 的模块循环。桥接层放在两者之上、由 `database.ts`
 * **动态 import**，循环就断开了（与 `event-log` 的处理方式一致）。
 */

import { listMessages, trimIndexedMessages, hydrateSessionLog, rebuildSessionFts, waitForMessageMirrors } from "./message";
import { backfillSessionLog, listSessionLogs, flushSessionLogWrites, compactSessionLog, hiddenFlagOf } from "./session-jsonl";
import { hydrateAttachmentsForSession } from "./attachment-files";
import { getStoragePort, hasStoragePort } from "./port";
import { domainReadMany } from "./domain-store";
import { reportPersistFailure } from "./persist-failure";
import { sessionTombstoneBinding } from "./session";

/**
 * 每次启动维护**最多**回填多少个会话（第 309 波 ✓）。
 *
 * 为什么要有这个上限（真机读数 ✓）：原来的循环对**全部 373 个会话**无条件走一遍
 * （载入消息镜像 + `fts.rebuild` + 回填 + hydrate ✓），而消息镜像 `keepSessions = 3`
 * ⇒ 载入一个逐出一个 ✗ ⇒ 真机 console 里那 1 868 条 `切到会话 …`（占 76% 流量 ✗）。
 * 而该机器上日志文件已有 **391 个** ✓ ⇒ 绝大多数会话**早就回填过** ✓，
 * `backfillSessionLog` 对它们是**一条都不写**的增量语义 ✓ ⇒ 那三件重活是纯开销 ✗。
 *
 * 取 **32** 的依据 ✓：本机会话数 373 ✓、把清扫压到"一次启动约 1/12 的会话" ✓
 * ⇒ 全部覆盖一遍需要十几次启动 ✓（对"回填"这件事足够快 —— 它救的是
 * "索引崩了/被裁"那种**少见**情形 ✓，不是每条消息的必经路径 ✓，
 * 而"索引空但日志有内容"这个**用户可见**的场景已经由
 * `store.ts::ensureSessionLogHydrated` 在**进会话时按需**兜住了 ✓）。
 *
 * ⚠️ 上限**只允许推迟、不允许跳过** ✗：多出来的会话必须计入 `deferredSessions` 并打日志 ✓
 * —— 否则就是"静默没做"✗（这个文件第 62 轮的教训 ✓）。
 */
const DEFAULT_BACKFILL_SWEEP_MAX = 32;

export { trimIndexedMessages };

/**
 * 预热会话里所有外置附件（第 80 波）。
 *
 * 附件读取路径是同步的，而外置内容在文件里 —— 启动维护/进入会话时把外置内容读进内存缓存，
 * 之后同步路径透明命中（`getAttachmentContent` 不会再拿到 `file:` 标记）。
 *
 * @returns 预热的附件数与清理掉的孤儿附件文件数
 */
/**
 * 走端口取「已外置的附件」清单（第 14 轮）。
 *
 * 为什么不让渲染侧自己从域镜像里筛：域镜像对 `attachments` **只投影元数据列**（不含 content），
 * 而"是否外置"这个信息就在 `content` 列（值形如 `file:<路径>`）。
 * 所以过滤放在**引擎侧**（`attachments.externalized`），只把 id + 路径传出来 ——
 * 既拿得到判据，又不会把正文拉进渲染进程。
 *
 * @returns undefined = 端口没接手（A 态走旧库）
 */
async function externalizedViaPort(): Promise<Array<{ id: string; content: string }> | undefined> {
  const port = hasStoragePort() ? getStoragePort() : null;
  // 第 19 轮：`port.kind !== "rust"` 判据已删（`kind` 是常量 "rust"，恒不成立）。
  if (!port) return undefined;
  const probe = port.data as unknown as {
    command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
  };
  if (!probe.command) return undefined;
  try {
    const r = await probe.command<{ items?: Array<{ id?: string; path?: string }> }>("attachments.externalized", {});
    const items = r?.items ?? [];
    return items
      .filter((x) => typeof x?.id === "string" && typeof x?.path === "string" && x.path.length > 0)
      .map((x) => ({ id: String(x.id), content: `file:${x.path}` }));
  } catch (e) {
    console.warn("[Attachment] 取外置附件清单失败（本次跳过预热与清理）:", e);
    return undefined;
  }
}

export async function hydrateAllAttachments(): Promise<{ warmed: number; orphansRemoved: number }> {
  const out = { warmed: 0, orphansRemoved: 0 };
  try {
    // P5 第 2 段：走端口读"外置标记"，不再依赖 WASM 库。
    // 这里只读 `content`（值形如 `file:<路径>`），正文本身在文件里、按需预热。
    const markers = await externalizedViaPort();
    let entries: Array<{ id: string; content: string }>;
    /**
     * **只有"标记清单可信"时才允许做孤儿清理**（第 14 轮，破坏性缺陷修正）。
     *
     * 真机/测试实测的形态：B 态下 `attachments` 域镜像**就绪但为空**（附件行压根没有写入
     * 路径，见 `docs/L3-DELETION-PLAN.md` §10）→ `markers = []` → `referenced = ∅`
     * → `pruneOrphanAttachmentFiles` 会把 `<appData>/attachments/` 下**所有**文件当孤儿删掉，
     * 包括迁移前留下的、仍被引用的外置正文。**那是不可逆的数据丢失**。
     *
     * 所以判据从"读到了清单"改成"这份清单是不是权威的"：
     * - 旧库路径（A 态）：附件行只在旧库里，清单权威 → 允许清理；
     * - 端口路径（B 态）：**附件写入路径尚未端口化** → 清单必然为空、不代表"没有附件"
     *   → **只预热、不清理**（预热本身也无害）。
     */
    let listIsAuthoritative = false;
    if (markers) {
      entries = markers;
      // 端口命令 `attachments.externalized` 在**引擎侧**按 `content LIKE 'file:%'` 过滤，
      // 它返回的就是全部外置附件 → 这份清单权威（空 = 确实没有外置附件）。
      listIsAuthoritative = true;
    } else {
      /**
       * B 态（端口在 rust、attachments 域未就绪）：**不去读旧库**（第 17 轮 L4：旧库回退已删）。
       *
       * 旧库在 rust 模式下刻意不存在，读它只会拿到一个异常；而"这次没预热"是可接受的
       * —— 外置正文仍在文件里，读取路径遇到未预热会明确提示并触发一次预取（既有约定）。
       */
      console.warn("[Attachment] attachments 域镜像未就绪，本次跳过外置附件预热与孤儿清理");
      return out;
    }
    out.warmed = await hydrateAttachmentsForSession(entries);

    // 孤儿清理：文件在、数据库里已无对应标记（附件被删/会话被清）→ 磁盘不能只涨不降
    if (!listIsAuthoritative) {
      console.warn(
        "[Attachment] 外置附件标记清单不完整（端口侧附件写入路径未接通）—— 本次跳过孤儿清理，避免误删仍被引用的外置正文",
      );
      return out;
    }
    const referenced = new Set(entries.map((e) => e.content.slice("file:".length)));
    const { pruneOrphanAttachmentFiles } = await import("./attachment-files");
    out.orphansRemoved = (await pruneOrphanAttachmentFiles(referenced)).deletedFiles;
  } catch (e) {
    console.warn("[Attachment] 外置附件预热/清理失败（跳过）:", e);
  }
  return out;
}

/**
 * 把**每个会话**的 SQLite 历史回填进追加日志（幂等：已存在的消息不会被重复追加）。
 *
 * 迁移语义：从这一版起，追加日志是权威存储；SQLite 退化为可重建的查询索引。
 * 老会话第一次跑维护时会被回填一次，之后只有新消息会追加。
 *
 * ## 第 62 轮：**先等消息镜像就绪**（真机取证：这条步骤曾在启动窗口里静默 no-op）
 *
 * 现场：用 `CODEM_DB_PATH` 隔离启动一个"从旧库迁移过来"的库（索引里 800+ 条消息、
 * 日志目录还不存在），连续三次维护都打 `日志回填 0 条`，而**权威日志一个文件都没建出来**。
 * 机制与第 44 轮那次"索引裁剪整条从不生效"完全相同：`listMessages` 在该会话的
 * 消息镜像未加载完时返回**空数组**，于是 `messages.length === 0 → continue`，
 * 回填"跑了但什么都没做"，而返回值 0 在日志上与"确实没有可回填的"长得一模一样。
 *
 * 代价不只是少回填一次：**追加日志是这套架构的权威副本** ——
 * 它没被建出来，"库坏了从日志重建"这条后路在那次启动里就是空的。
 *
 * 所以现在：先等就绪（`waitForMessageMirrors`，与裁剪共用同一条等待与预算），
 * 等不到的会话**单独计数**并如实上报（`skippedUnreadable`），不再混进"0 条"。
 *
 * @returns `backfilled` = 本次回填的消息数；`skippedUnreadable` = 因镜像没就绪而**没回填**的会话数
 */
export async function backfillAllSessions(
  opts: { mirrorWaitMs?: number; maxSessions?: number } = {},
): Promise<{ backfilled: number; skippedUnreadable: number; deferredSessions: number }> {
  // 第 17 轮（L4）：原来的 `await initDatabase()` 已删 —— 它的唯一作用是"确保旧库存在"，
  // 而新架构下旧库刻意不加载（那次调用只会把 sql.js 拖进渲染进程）。
  let sessionIds: string[] = [];
  /**
   * 会话清单：**端口优先**（第 12 轮）。
   *
   * 原来只有 `tryGetDatabase()` 一条路径 —— rust 模式下旧库刻意不存在 → 清单为空 →
   * 循环一次都不进 → 函数返回 0，日志打出"回填 0 条"这种**看着正常、实则整件事没做**的结果
   * （回填是"日志成为权威副本"的前提，长期不执行意味着崩溃后无从重建）。
   * 现在从端口枚举；端口没接手（A 态）才回退旧库。
   */
  const fromPort = domainReadMany<Record<string, unknown>>("sessions", (r) => r);
  if (fromPort) {
    sessionIds = fromPort.map((r) => String(r.id ?? "")).filter((id) => id.length > 0);
  } else {
    // 第 17 轮（L4）：旧库回退（`SELECT DISTINCT session_id FROM messages`）已删 ——
    // 镜像未就绪时如实跳过，下次维护重试（静默"回填 0 条"才是要避免的那种假正常）。
    console.warn("[SessionLog] sessions 域镜像未就绪，本次跳过回填（下次维护会重试）");
    return { backfilled: 0, skippedUnreadable: 0, deferredSessions: 0 };
  }

  /**
   * ## 第 309 波：**把"无界全量清扫"改成"有界 + 优先补真缺的"** ✓（真机读数换来的 ✓）
   *
   * ## 现场（`repo-01 r3`，`1.16.283` ✓）
   *
   * 一次启动维护把**全部 373 个会话**逐个走了一遍 ✓ —— 每个都
   * `ensureLoaded`（消息镜像 `keepSessions = 3` ⇒ **载入一个逐出一个** ✗）
   * + `rebuildSessionFts`（**一次 `fts.rebuild` IPC** ✓）
   * + `backfillSessionLog` + `hydrateSessionLog` ✓。
   * 真机 console 实测的后果 ✓：`[RustStoragePort] 切到会话 …` **1 868 条 = 76% 流量** ✗，
   * 而当前回合真正相关的 `[agent-loop]` 只占 **1%** ✓（证据被噪声淹掉 ✓）。
   *
   * ## 为什么"全都走一遍"是浪费（**有真机依据** ✓）
   *
   * 该机器上日志目录里已经有 **391 个 `.jsonl`** ✓（会话 373 个 ✓）——
   * 也就是**几乎每个会话都早就回填过了** ✓。而 `backfillSessionLog` 本身**是增量的** ✓
   * （`if (existing.has(message.id)) continue` ✓）⇒ 对已齐的会话它**一条都不写** ✓。
   * ⇒ 那三件重活（载入镜像 / FTS 重建 / hydrate）**对绝大多数会话是纯开销** ✗。
   *
   * ## 改法：只**限定工作量**，不改任何语义 ✓
   *
   * 1. **优先**处理"日志文件都还没有"的会话 ✓（那是真正需要回填的一类 ✓，
   *    与既有注释里"老会话第一次跑维护会被回填一次"的语义一致 ✓）；
   * 2. 设一个**每次启动的上限** ✓（`maxSessions` ✓），超出的**如实计数** ✓
   *    （`deferredSessions` ✓）⇒ 下次维护继续 ✓（**有界 + 最终覆盖** ✓，
   *    而不是"这次做了多少全靠运气"✗）；
   * 3. ⚠️ **上限只允许"推迟"，不允许"跳过"** ✗：被推迟的会话**必须**在
   *    `deferredSessions` 里被数出来 ✓ —— 否则就成了"静默没做"✗，
   *    正是这个文件自己反复警告过的那一类（第 62 轮"回填 0 条"看着正常实则整件事没做 ✗）。
   *
   * ⚠️ **这一波不删 `rebuildSessionFts` / `hydrateSessionLog`** ✓ ——
   * 它们对"索引被裁/崩溃丢写入"那种**真缺**的会话仍然是必须的 ✓
   * （判据 `SWEEP-5` 钉这条反向 ✓）。本波只是不再对**全部**会话无条件做 ✓。
   */
  const maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_BACKFILL_SWEEP_MAX);
  const withLog = new Set(await listSessionLogs());
  /** 真缺的（连日志文件都没有）优先 ✓ */
  const needFirst = sessionIds.filter((id) => !withLog.has(id));
  const rest = sessionIds.filter((id) => withLog.has(id));
  const sweep = [...needFirst, ...rest].slice(0, maxSessions);
  const deferredSessions = Math.max(0, sessionIds.length - sweep.length);
  if (deferredSessions > 0) {
    console.log(
      `[SessionLog] 本次只回填 ${sweep.length}/${sessionIds.length} 个会话（优先 ${needFirst.length} 个**还没有日志文件**的）` +
        `；其余 ${deferredSessions} 个**推迟到下次维护**（有界清扫，避免每次启动载入全部会话）`,
    );
  }

  const unreadable = await waitForMessageMirrors(sweep, opts.mirrorWaitMs ?? 5000);
  let total = 0;
  let skippedUnreadable = 0;
  for (const sessionId of sweep) {
    if (unreadable.has(sessionId)) {
      skippedUnreadable += 1;
      continue;
    }
    try {
      const messages = listMessages(sessionId);
      if (messages.length === 0) continue;
      await rebuildSessionFts(sessionId); // 索引与日志对齐（含孤儿清理与补齐）
      await flushSessionLogWrites(); // 先把在途追加写完，避免重复回填
      total += await backfillSessionLog(sessionId, messages);
      // 回填后把日志读进内存镜像，读路径立刻就能合并出完整历史
      await hydrateSessionLog(sessionId);
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sessionId} 回填失败（跳过）:`, e);
    }
  }
  if (skippedUnreadable > 0) {
    reportPersistFailure(
      "sessionLog.backfill",
      new Error(`消息镜像未就绪 ${skippedUnreadable} 个会话`),
      `${skippedUnreadable} 个会话本次**没有回填**（不计入"回填 0 条"）。` +
        `镜像没加载完时 listMessages 返回空数组 —— 当成"没有可回填的"会让` +
        `**权威日志一个文件都建不出来**（真机实测：隔离启动的三次维护全是"回填 0 条"，日志目录始终是空的）`,
    );
  }
  return { backfilled: total, skippedUnreadable, deferredSessions };
}

/** 已存在日志文件的会话数（诊断用） */
export async function countSessionLogs(): Promise<number> {
  return (await listSessionLogs()).length;
}

// ========== 索引重建（第 91 波：自愈） ==========

/**
 * 从**权威日志**重建查询索引。
 *
 * 为什么这是"数据库崩了也不丢数据"的最后一块拼图：
 * 分层本来就写着"日志是权威、索引可重建"，但**重建方向从来没有实现过** ——
 * 只有"索引 → 日志"的回填（`backfillAllSessions`）。于是索引一崩（WASM 陷阱、
 * 索引文件损坏、被裁剪过），用户只能重启撞运气；索引里的附件/工具调用也不会自己回来。
 *
 * 现在：日志里有什么，索引就能重建出什么（幂等：同 id 覆盖写）。
 * 触发点有两个：①启动维护时若发现"上次崩溃"标记；②手工/维护显式调用。
 *
 * ## P5 第 2 段：改走端口（不再依赖 WASM 库）
 *
 * 原实现是一整套裸 SQL（`BEGIN; INSERT sessions; INSERT messages; DELETE tool_calls;
 * INSERT tool_calls; COMMIT`）。搬到端口后有两条硬要求：
 * 1. **必须是一个事务** —— 拆成多条 IPC 时中途失败会留下"会话行在、消息只写了一半"
 *    的半截索引，比不重建更糟。因此 Rust 侧做成一条复合命令 `messages.rebuild_index`；
 * 2. **`hidden` 与 `parent_message_id` / `metadata` 必须还原** ——
 *    日志里记着压缩状态与消息链，重建后不一致会让被压缩的消息复活
 *    （`messages.upsert_index` 的 hidden 语义见 repo.rs 的注释）。
 *
 * 端口不可用时（第 19 轮：只剩"端口未注册"这一种形态，wasm 回滚已随旧引擎删除）
 * 继续走原来的旧路径。
 *
 * @returns 重建的会话数与消息数（`skippedDeleted` = 因**会话墓碑**被跳过的会话数）
 */
export async function rebuildIndexFromSessionLogs(sessionId?: string): Promise<{
  sessions: number;
  messages: number;
  /** 因"日志里有会话墓碑"被跳过的会话数（B-1：跳过必须**如实计数并上报**，不能静默） */
  skippedDeleted: number;
  /**
   * 墓碑被**作废**的会话数（第 184 波存储审计 S1）。
   *
   * 日志里有墓碑、但 `sessions` 镜像里**还有这一行** ⇒ 那次删除没成（或被队满/老化丢弃），
   * 此时按"仍存在的会话"照常重建。这个计数长期应当是 0；不是 0 就说明删除链路上
   * 出过"墓碑已落盘、行没删掉"的事（必须能在日志里看见，否则只剩"会话怎么又回来了"）。
   */
  voidedTombstones: number;
  /** 因会话没有任何消息而跳过的会话数（诊断用：与"已删除"区分开，两者含义完全不同） */
  skippedEmpty: number;
  /**
   * 本次重建时**没能取到项目归属**的会话数（第 45 轮）。
   *
   * 取不到时仍然传 `""`（引擎的缺省语义），而 `""` = **全局项目** ——
   * 也就是说这些会话会掉进"全局对话"。这个计数就是那件事的可见性：
   * **它是 0 才说明"复活的会话归属正确"**。
   */
  withoutProject: number;
}> {
  // 第 17 轮（L4）：原来的 `await initDatabase()` 已删（同上：只为"确保旧库存在"）。
  const targets = sessionId ? [sessionId] : await listSessionLogs();
  const out = { sessions: 0, messages: 0, skippedDeleted: 0, skippedEmpty: 0, withoutProject: 0, voidedTombstones: 0 };

  /**
   * ## 项目归属从哪来（第 45 轮）
   *
   * 引擎侧 `messages_rebuild_index` 原来把 `project_id` **硬编码为 `''`** ——
   * 于是"索引重建复活的会话"全部掉进"全局对话"（真机形态：删掉的会话自愈后
   * 出现在全局项目下、标题看着像一句用户话）。现在它支持 `sessions[].project_id`，
   * 而权威日志（JSONL）里**没有**这一列 —— 它记的是消息，不是会话归属。
   *
   * 所以归属只能从**会话元数据**取，也就是 `sessions` 域镜像（`sessions` 是小表，
   * 域镜像的适用边界正好覆盖它）。**必须在下面那次重建写库之前读** ——
   * 重建会 upsert `sessions` 行，读完再读就不是"重建前的归属"了。
   *
   * 取不到的两种情况，都是**如实退让**而不是猜：
   * 1. 镜像未就绪 / 没接手（`domainReadMany` 返回 undefined）→ 全部按 `""`，
   *    并在返回值里报 `withoutProject`；
   * 2. 这个会话在 `sessions` 里没有行（库被清过、或这个会话只存在于 JSONL）→ 同样报数。
   *
   * ⚠️ 刻意**不**去猜（比如"按消息 id 前缀推断"或"取上次已知的归属"）：
   * 猜错的后果是把用户的会话挂到**别的项目**下，那比落到全局项目更难发现。
   */
  const projectOf = new Map<string, string>();
  const sessionRows = domainReadMany<Record<string, unknown>>("sessions", (r) => r);
  if (sessionRows) {
    for (const row of sessionRows) {
      const id = String(row.id ?? "");
      if (id) projectOf.set(id, String(row.project_id ?? ""));
    }
  } else {
    console.warn(
      "[SessionLog] sessions 域镜像未就绪：本次重建的项目归属取不到，复活的会话会落到全局项目（已计入 withoutProject）",
    );
  }

  // 先把日志全部读出来（异步），再决定走端口还是旧路径
  const batches: Array<{
    id: string;
    projectId: string;
    messages: Awaited<ReturnType<typeof readSessionMessages>>["messages"];
  }> = [];
  const { readSessionMessages, isSessionDeleted } = await import("./session-jsonl");
  for (const sid of targets) {
    try {
      /**
       * **B-1：先读会话墓碑，被删过的会话绝不写回索引。**
       *
       * 为什么必须放在"读消息"之前、且单独一次读：墓碑行会被
       * `readSessionMessages` 丢掉（后写者胜的删除语义），从它的返回值里
       * **看不出**这个会话被删过 —— 只看"有没有消息"会把"已删除"与"日志还空着"
       * 混成一件事，而前者应该永久跳过、后者只是这次没得写。
       *
       * 计数为什么不省：跳过而不计数，真机上就变成了"重建了 N 个会话"里悄悄少了几个，
       * 而少了的那几个恰恰是**用户显式删掉的**——一旦哪天墓碑机制失效，唯一能发现的
       * 窗口就是这行数字对不上。所以它进返回值、进维护汇总、进日志。
       */
      if (await isSessionDeleted(sid)) {
        /**
         * ## 第 184 波存储审计 S1：墓碑**必须能被作废**
         *
         * 墓碑是 append-only、没有撤销入口，而删除失败（`domainDelete` 返回 false）
         * 或那次写被队满 / 15s 老化丢弃时，墓碑已经落盘、`sessions` 行却还在。
         * 只按"日志里有墓碑"跳过，就等于把这个**仍然存在的会话永久排除在重建之外**：
         * 空库恢复之后它不会回到 `sessions` 表，会话从侧栏彻底消失。
         *
         * 所以先问一句"库里还有没有这一行"（`sessionTombstoneBinding`）：
         * `false` = 墓碑作废（行还在）→ 照常重建并如实计数；否则按已删除跳过。
         * `undefined`（`sessions` 域镜像未就绪）时按最保守处理：仍然跳过 ——
         * 宁可晚一次重建，也不要在"判不了"的时候把用户明确删掉的会话复活。
         */
        const binding = sessionTombstoneBinding(sid);
        if (binding === false) {
          out.voidedTombstones++;
        } else {
          out.skippedDeleted++;
          continue;
        }
      }
      const { messages } = await readSessionMessages(sid);
      if (messages.length === 0) {
        out.skippedEmpty++;
        continue;
      }
      const projectId = projectOf.get(sid);
      if (projectId === undefined) out.withoutProject++;
      batches.push({ id: sid, projectId: projectId ?? "", messages });
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sid} 日志读取失败（跳过）:`, e);
    }
  }
  if (out.skippedDeleted > 0) {
    console.log(
      `[Database] 索引重建：跳过 ${out.skippedDeleted} 个**已删除**会话（日志里有会话墓碑，绝不复活）`,
    );
  }
  if (out.voidedTombstones > 0) {
    /**
     * 如实上报：这些会话的日志里有墓碑，但库里**还有会话行** ——
     * 说明某次删除没成或被丢弃。此时按"仍存在的会话"重建（S1），但这件事必须可见。
     */
    console.warn(
      `[Database] 索引重建：${out.voidedTombstones} 个会话的日志里有墓碑但 sessions 里仍有行` +
        "（上次删除没成 / 那次写被队满或老化丢弃）→ **墓碑作废**，照常重建（否则这些会话会被永久跳过）",
    );
  }
  if (out.withoutProject > 0) {
    console.warn(
      `[Database] 索引重建：${out.withoutProject} 个会话取不到项目归属（会话元数据里没有它们）` +
        "—— 这些会话会落到全局项目；这个数字应当长期为 0",
    );
  }
  if (batches.length === 0) return out;

  const port = hasStoragePort() ? getStoragePort() : null;
  // 第 19 轮：`port && port.kind === "rust"` 的 kind 判据已删（恒为真）。
  if (port) {
    const payload = {
      sessions: batches.map((b) => ({
        id: b.id,
        /**
         * 项目归属（第 45 轮）。引擎侧 `INSERT ... ON CONFLICT(id) DO UPDATE` **不碰这一列**，
         * 所以它只影响"新建的行" —— 正是需要它影响的那部分（已存在的会话归属不变）。
         */
        project_id: b.projectId,
        messages: b.messages.map((rec) => ({
          id: rec.id,
          session_id: b.id,
          role: rec.role,
          content: rec.content ?? "",
          reasoning: (rec as { reasoning?: string | null }).reasoning ?? null,
          timestamp: rec.timestamp ?? Date.now(),
          model: (rec as { model?: string | null }).model ?? null,
          status: (rec as { status?: string }).status ?? "done",
          /*
           * 压缩状态必须还原（否则被压缩的消息会复活）。
           *
           * ⚠️ 第 47 轮补（数据面审计 P1-1）：这里原来读的是 `(rec as {hidden?}).hidden ?? 0`
           * —— 而**日志从来没有写过 `hidden`**（`JsonlMessageRecord` 的白名单里没有它）。
           * 于是这一行恒等于 0，注释里那句"必须还原"是一句**做不到的承诺**：
           * 索引重建之后（`hidden=1` 的行被当新行插入）所有被压缩的消息原地复活，
           * 用户列表凭空多出几百条旧消息、模型上下文跟着涨回去。
           * 现在写侧把非 0 的 `hidden` 记进日志、这里读回来，重建路径按它落库。
           *
           * ⚠️ 第 184 波存储审计 S2：`hidden` 是**数字**（日志写的是 `Number(...)`），
           * 所以这里改成共用 `session-jsonl.ts::hiddenFlagOf` —— 写侧 / 读侧
           * （`logMirrorMessage`）/ 这里 / 合并防线（`listMessagesMerged`）**同一份判定**，
           * 不再各写一遍（其中一份曾把数字与布尔比，那道防线因此从未生效）。
           *
           * ⚠️ 刻意**不**在这里传 `trimmed`：引擎的 `MessageFields` 里没有这个字段，
           * 送了也不会被读 —— 传一个"没人读的参数"会让下一个人以为它生效了。
           * 新插入行的 `trimmed` 由 SQL 默认 0（"新行不可能曾经被裁过"），
           * 已存在行则由引擎保持原值（见 `repo.rs` 里那段长注释）。
           */
          hidden: hiddenFlagOf(rec),
          parent_message_id: (rec as { parentMessageId?: string | null }).parentMessageId ?? null,
          metadata: (rec as { metadata?: unknown }).metadata ?? null,
          tool_calls: (rec as { toolCalls?: unknown[] }).toolCalls ?? null,
          /**
           * B-3：`generated_files` / `retrieved_sources` 也要还原。
           *
           * 这两个 JSON 列在**索引重建**这条路上原来整个缺席（连 `generated_files` 都没传）——
           * 于是"索引可从日志重建"对它们不成立：重建之后消息上的生成文件标记与引用来源
           * 永久消失。日志里既然已经记了（见 `session-jsonl.ts` 的白名单），就必须送回去。
           */
          generated_files: (rec as { generatedFiles?: unknown }).generatedFiles ?? null,
          retrieved_sources: (rec as { retrievedSources?: unknown }).retrievedSources ?? null,
        })),
      })),
    };
    try {
      /**
       * ⚠️ **必须用 `command`（结构化结果），不能用 `execute`**（第 14 轮修正）。
       *
       * `data.execute` 按契约只返回 `{ written }`（`rust-port.ts`），而这里要读的是
       * `{ sessions, messages }`（Rust 侧 `messages_rebuild_index` 确实这么返回）。
       * 用 `execute` 读不到字段 → `?? 0` 兜底 → **真机上"索引重建写成功、计数恒为 0"**：
       * `runDatabaseMaintenance` 的 `rebuiltIndexMessages` 永远是 0，
       * 那行"索引已从权威日志重建…"的日志**永远打不出来**。
       * 这与 `migration.auto` 上踩过的坑（`{written}` 压平）是同一个。
       */
      const probe = port.data as unknown as {
        command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
      };
      const r: { sessions?: number; messages?: number } = probe.command
        ? await probe.command<{ sessions?: number; messages?: number }>("messages.rebuild_index", payload)
        : ((await port.data.execute("messages.rebuild_index", payload)) as unknown as {
            sessions?: number;
            messages?: number;
          });
      out.sessions = r?.sessions ?? batches.length;
      /**
       * 计数读不到时**不再静默取 0**：旧行为会让"写成功但计数 0"看起来像"没重建"。
       * 这里以"确实送进去的消息条数"作为下界（写入是单事务，失败会抛而不是返回 0）。
       */
      out.messages =
        typeof r?.messages === "number" && r.messages > 0
          ? r.messages
          : batches.reduce((n, b) => n + b.messages.length, 0);
      // 重建后把镜像换成新数据（否则镜像里还是崩溃前的旧集合）
      for (const b of batches) await hydrateSessionLog(b.id);
      if (out.messages > 0) {
        console.log(
          `[Database] 索引已从权威日志重建（Rust 单事务）：${out.sessions} 个会话 / ${out.messages} 条消息` +
            // B-1：跳过数必须出现在这一行里，否则"整件事做了多少"看不出来
            (out.skippedDeleted > 0 ? `，跳过 ${out.skippedDeleted} 个已删除会话` : ""),
        );
      }
      return out;
    } catch (e) {
      /*
       * 第 104 轮：这句 `extra` 原来写着「**已回退旧路径重试**」—— 但那段回退**第 17 轮就删了**
       * （见下面 425 行起的注释：旧库在 B 态刻意不存在，回退只会把真实失败原因换成一个无关异常）。
       * 也就是说提示条一直在告诉用户"我们重试过了"，而实际上没有。改成事实：
       * 本次重建没有完成，交给下一次维护重试。
       */
      reportPersistFailure(
        "sessionLog.rebuildIndex",
        e,
        "Rust 侧索引重建失败：本次重建**没有完成**（旧路径回退已在第 17 轮删除），下一次维护会再试",
      );
    }
  }

  /**
   * 第 17 轮（L4）：旧库回退（"回退旧路径再试一次"的整段重建）已删。
   *
   * 那段代码在 A 态成立，在 B 态却只会撞上"旧库刻意不存在"，把**真实的失败原因**
   * （Rust 侧重建报的错）换成另一个无关的异常。现在只剩如实上报 + 返回本次实际结果，
   * 交给下一次维护重试。
   */
  return out;
}


/**
 * 压缩膨胀的追加日志（第 79 波收尾项）：对行数明显多于"唯一消息数"的会话重写日志。
 * 幂等、失败保留原文件；压缩后再 hydrate 一次，保证内存镜像同步。
 */
export async function compactOversizedSessionLogs(): Promise<{ compactedSessions: number; linesSaved: number }> {
  const out = { compactedSessions: 0, linesSaved: 0 };
  for (const sessionId of await listSessionLogs()) {
    try {
      const result = await compactSessionLog(sessionId);
      if (result.compacted) {
        out.compactedSessions++;
        out.linesSaved += result.linesBefore - result.linesAfter;
        await hydrateSessionLog(sessionId); // 镜像跟着换成压缩后的版本
      }
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sessionId} 日志压缩失败（跳过）:`, e);
    }
  }
  return out;
}
