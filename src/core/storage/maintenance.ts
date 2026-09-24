/**
 * 启动维护（第 18 轮，从 `database.ts` 抽出来）。
 *
 * ## 为什么它必须独立存在
 *
 * 这个函数原来住在旧引擎模块 `database.ts` 里，于是它**继承了旧引擎的生死**：
 * 第一行 `if (!db || dbFatal) return` 让它在 rust 模式（`db` 恒为 `null`）下
 * **整段不执行**，而 `App.tsx` 每次启动都在 `await` 它 —— 追加日志（权威副本）的回填与压缩、
 * 索引裁剪、外置附件预热与孤儿清理、崩溃后"索引重建标记"驱动的自愈 **全部从未跑过**。
 *
 * 抽出来之后，它依赖的东西**一目了然**，且没有一件与旧引擎有关：
 *   · 会话追加日志（JSONL，权威副本）—— 文件 I/O；
 *   · 外置附件正文 —— 文件 I/O + 域端口；
 *   · 索引裁剪与重建 —— 域端口 + JSONL；
 *   · 遥测裁剪 —— 引擎命令 `telemetry.prune`；
 *   · 审计裁剪 / 审计规模 —— 引擎命令 `audit.prune` / `audit.stats`（第 45 轮接线）；
 *   · 空间回收 —— 引擎命令 `storage.compact`（**整库重写，按阈值**，第 45 轮接线）；
 *   · 完整性检查 —— 引擎命令 `integrity_check`（**异步 + 节流**，第 45 轮接线）。
 *
 * ## 顺带修掉的一件事：日志必须能区分"没跑"和"跑了没事做"
 *
 * 缺陷能长期存在的另一半原因是那两种情况在日志里长得一样（rust 模式下连"维护完成"都不打印）。
 * 现在**每次维护结束都打一行带数字的日志**，任何一步真的做了事都能看见。
 *
 * ## 第 45 轮：四条"引擎有能力、渲染侧零调用"的接线
 *
 * 这一轮加进来的四个引擎能力原来都**只有定义没有调用者**（正是本仓库反复抓到的
 * "有能力没人用"形态）：`audit.prune` / `audit.stats` / `storage.compact` / `integrity_check`。
 * 接线时统一遵守同一条规矩：**每一步都要能区分"没跑 / 跑了没做 / 跑了做了多少（失败就带原因）"**。
 * 这不是日志洁癖 —— 真机上"维护看起来在跑但其实什么都没做"在这个模块里发生过多次。
 */

import { reportActionFailure, reportAdvisory, reportPersistFailure } from "./persist-failure";
import { getStoragePort } from "./port";
import * as SessionStorage from "./session";
// 不变量审计的"上次水位"存在 settings（与其它偏好同一种介质，见 `readInvariantWatermark`）
import { getSettingJSON, setSettingJSON } from "./settings";

export interface MaintenanceResult {
  /** 旧引擎时代的库体积统计（现在由 `storage.compact` 的 before/after 承担，这里保持 0 兼容签名） */
  sizeBefore: number;
  sizeAfter: number;
  /** 旧引擎时代的 VACUUM 回收量；现在恒为 0（真正的回收量在 `compactedBytes`） */
  reclaimed: number;
  prunedEvents: number;
  prunedTelemetry: number;
  vacuumed: boolean;
  /** 本次被快照式压缩的会话数（第 77 波；端口模式下由引擎侧负责，这里恒为 0） */
  compactedSessions: number;
  /** 本次回填进追加日志的消息数（第 78 波） */
  backfilledMessages: number;
  /**
   * 第 62 轮：因**消息镜像没就绪**而本次**没有回填**的会话数。
   *
   * 与 `backfilledMessages` 是一对：`0 条` 与 `N 个会话根本没跑` 在日志上必须分得开。
   * 真机取证：`CODEM_DB_PATH` 隔离启动（索引 800+ 条、日志目录不存在）时，
   * 连续三次维护都打 `日志回填 0 条`，而**权威日志一个文件都没建出来** ——
   * 也就是说"崩溃后从日志重建"这条后路在那次启动里是空的，日志却显示一切正常。
   */
  backfillSkippedUnreadable: number;
  /** 本次**从权威日志重建进索引**的消息数（第 91 波：崩溃自愈） */
  rebuiltIndexMessages: number;
  /**
   * 本次因**索引落后于权威日志**而补回的行数（第 52 轮）。
   *
   * 与 `rebuiltIndexMessages` 分开报：那个是"检测到重建标记之后的整体重建"，
   * 这个是"**没人写标记、但对账自己发现了落后**"的局部修复。
   * 两者触发条件完全不同 —— 混在一起就看不出"系统自己发现过一次丢行"。
   */
  repairedBehindMessages: number;
  /**
   * 本次重建时因**会话墓碑**跳过的会话数（B-1）。
   *
   * 为什么这个数字必须出现在汇总里：它是"用户删掉的会话会不会复活"这件事的
   * **唯一可观测信号**。跳过而不计数 = 重建悄悄少几个会话，而少掉的那几个正是
   * 用户显式删除的；哪天墓碑机制失效（写失败、日志被清），只有这行数字对不上能发现。
   */
  skippedDeletedSessions: number;
  /**
   * 本次重建时**没能取到项目归属**的会话数（第 45 轮）。
   *
   * `messages.rebuild_index` 现在支持 `sessions[].project_id`；取不到时仍传 `""`，
   * 而 `""` 是"全局项目"—— 也就是说这种会话会掉进"全局对话"。
   * 这个计数就是那件事的可见性：**它是 0 才说明"复活的会话归属正确"**。
   */
  rebuildWithoutProject: number;
  /** 本次从查询索引裁剪掉的消息数（第 78 波） */
  trimmedIndexMessages: number;
  /** 本次预热的外置附件正文数 */
  warmedAttachments: number;
  /** 本次清理的孤儿附件文件数 */
  prunedAttachmentOrphans: number;
  /** 本次压缩的追加日志会话数（权威副本的膨胀控制） */
  compactedLogSessions: number;
  /** 本次从 `storage_audit` 裁掉的审计行数（第 45 轮；这张表曾无界增长到 61,416 行） */
  prunedAuditRows: number;
  /** 裁剪之后 `storage_audit` 的剩余行数（`-1` = 没读到，见 `auditStatsRead`） */
  auditRemainingRows: number;
  /** 审计规模是否读到了（`false` = `audit.stats` 没跑成，此时 `auditRemainingRows` 不可信） */
  auditStatsRead: boolean;
  /** 本次 `storage.compact` 是否**真的**做了整库重写（false = 未达阈值 / 失败，原因见汇总行） */
  compactPerformed: boolean;
  /** 本次真正回收的字节数（只有 `compactPerformed` 为真时才有意义） */
  compactedBytes: number;
  /** 本次完整性检查的结论：`ok` / `failed` / `skipped`（节流或命令不可用） */
  integrity: "ok" | "failed" | "skipped";
  /**
   * 本次修正了 `message_count` 的会话数（第 44 轮）。
   *
   * 这一列长期漂移（真机实测同一会话：日志 612 / 索引 544 / 该列 **27**），
   * 因为它的写入者太多而没人负责。引擎已改成唯一写入者（只管以后），
   * 这个数字是"以前写坏的那些修好了几个"的可见性：**长期应当是 0**。
   */
  recountedSessions: number;
  /** 本次**实际检查**了几个会话（与 `recountedSessions` 配对：区分"只跑了 3 个"与"3 个不一致"） */
  recountCheckedSessions: number;
  /** 读取失败而跳过的会话数（单会话失败不再中断整轮，但要可见） */
  recountFailedSessions: number;
  /**
   * 本次**实际检查**了不变量（"模型可见即已记录" + 工具调用配对）的会话数。
   *
   * ## 为什么这个数字必须存在（第 45 轮功能上下文审计 §"未做"）
   *
   * `runtime-invariants` 原来**只在 `NODE_ENV === "development"` 或
   * `DEBUG_INVARIANTS=1` 时运行**（调用点 `agentic-loop.ts:831`），
   * 而发布包是 production —— 也就是说**生产上没有任何人断言**这条不变量，
   * 而它正是 P0-D0（主聊天的 `user_message` / `assistant_text` 事件曾经整体不写）
   * 的唯一自动判据。改成"在启动维护里跑一次"之后，`0` 与"跑过且没有违规"
   * 必须能分开 —— 这就是这个字段（与 `recountCheckedSessions` 同一个理由）。
   */
  invariantCheckedSessions: number;
  /**
   * 本次发现的不变量违规条数（**长期应当是 0**）。
   *
   * 非 0 意味着"消息表里有一行在事件日志里没有任何对应事件"（或反之），
   * 也就是**事件双写又断了一条路**。这个数字进维护汇总行 —— 它是那条不变量
   * 在生产上唯一会被打印出来的地方。
   */
  invariantViolations: number;
  /**
   * 其中**本次新产生**的缺口条数（第 47 轮：水位判定真正落地）。
   *
   * `invariantViolations` 里绝大多数是迁移前的历史缺口（真机实测 777 条，长期不会消失），
   * 所以那个数字**不能**直接当信号用。真正要看见的是"上次审计之后**多出来**的缺口" ——
   * 那才意味着事件双写又断了一条路。与 `invariantViolations` 一样必须进汇总行，
   * 否则"新产生 N 条"只在 `console.warn` 里出现一次，用户关了 devtools 就再也看不到。
   */
  invariantNewViolations: number;
  /** 违规样本（最多 5 条，形如 `sessionId/type`）—— 只报数字的话排查还得再跑一次 */
  invariantSamples: string[];
  /**
   * 第 60 轮：**事件库结构异常**条数（重复 seq / 孤儿 `tool_result` / 未知事件类型 /
   * `compaction` 载荷形状）。
   *
   * 为什么单独一个字段：它与上面的"可见但没记事件"是**两个方向**的问题 ——
   * 那边是"消息有、事件缺"，这边是"事件自身不自洽"。而 `session_events` 是
   * **唯一没有等价物**的存储，所以它的结构异常值得单独在汇总行里出现。
   */
  invariantStructuralErrors: number;
  /**
   * 第 60 轮：**读侧镜像没就绪、因此本次没检查**的会话数（消息或事件任一侧读不到都算）。
   *
   * 与 `invariantCheckedSessions` 是一对：`checked + unreadableSessions` 才是本次
   * 参与审计的会话总数。分开报的理由见 `waitForSessionMirrors` ——
   * "读不到"会让不变量把整个会话的消息都报成缺口（真机实测 934 vs 749），
   * 也会让结构自检报 0 处异常却看起来"通过"。
   */
  invariantUnreadableSessions: number;
}

/**
 * 审计保留窗口（第 45 轮）。
 *
 * 真机实测 `storage_audit` 11.8 小时涨到 **61,416 行**（库内最大的表、占活数据 35.6%），
 * 而其中 99.98% 来自同一批全库重灌事件。7 天是"排查事故仍然够用"与"表不再无界增长"
 * 之间的折中：真机事故排查的取证窗口从来是小时级，7 天已经远超需要。
 */
const AUDIT_RETENTION_DAYS = 7;

/**
 * 完整性检查的节流窗口（第 45 轮定的 12 小时 → 第 51 轮按实测改成 **1 小时**）。
 *
 * ## 旧注释里的两个说法都必须更正（都核过）
 *
 * 1. **成本数字差了一个数量级。** 原文写 "quick_check 真机实测：901 ms @ 10k 行 /
 *    4,469 ms @ 100k 行"。第 51 轮用同一套 harness（同一个 CLI 调用方式，
 *    并且**同时量 `health` 作为"进程启动 + 开库"的基线**，只把差值算作检查成本）
 *    在**自己造的库**上扫了一遍规模：
 *
 *    | 规模 | 库大小 | `health`（基线） | `integrity_check` | 检查净成本 |
 *    | --- | --- | --- | --- | --- |
 *    | 10,000 行 | 14.1 MB | 29.5 ms | 61.7 ms | **32 ms** |
 *    | 100,000 行 | 137.2 MB | 30.5 ms | 355.4 ms | **325 ms** |
 *
 *    用户真实库（16.24 MB / 822 消息 / 2,647 事件 / 61k 审计行）另测：CLI 直跑
 *    **75–77 ms**（三次一致）；应用内一次维护含检查 **346–425 ms**、被跳过 **221 ms**。
 *    规模趋势与旧数字同形（行数 ×10 → 成本约 ×10），但**绝对值小一个数量级**。
 *
 * 2. **"不能放在首屏路径上"这句话是错的。** 启动维护在 `App.tsx` 里是
 *    `void (async () => { … await runDatabaseMaintenance() … })()` —— **后台任务**，
 *    首屏不等它。所以那次检查**根本不延迟启动**，只占一点后台 CPU/磁盘 IO。
 *
 * ## 现在的策略（按实测定）
 *
 * - 小/中库（< 256 MB）：**1 小时**窗口。实测成本 32–325 ms，且不阻塞首屏；
 *   把"数据页损坏但查询仍能正常返回"这种**没有别的信号**的损坏的发现延迟
 *   从 ≤12 小时压到 ≤1 小时。
 * - 大库（≥ 256 MB）：**保持 12 小时**。我没在 256 MB 以上量过，按未实测的规模
 *   放宽节流是拿用户机器赌博 —— 保守留着，等有真机数据再改。
 */
const INTEGRITY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 大库的节流窗口（见上：256 MB 以上没有实测数据，保守沿用 12 小时） */
const INTEGRITY_CHECK_INTERVAL_LARGE_DB_MS = 12 * 60 * 60 * 1000;

/** "大库"的判据（`engine.health().sizeBytes`） */
const INTEGRITY_CHECK_LARGE_DB_BYTES = 256 * 1024 * 1024;


/** 上次完整性检查的时间戳存在 settings 里（`settings` 是"几行数据、读起来最便宜"的配置面） */
const INTEGRITY_CHECK_MARKER_KEY = "codem-storage-integrity-checked-at";

/** 索引重建标记文件（写文件走 IPC，与数据库无关） */
export const INDEX_REBUILD_MARKER = "codem-index-rebuild-needed.json";

/**
 * 是否存在"需要重建索引"的标记（启动维护用）。
 *
 * 标记的产生者曾是旧引擎的致命闩锁（sql.js OOM/WASM 陷阱 → `noteFatalDbError`），
 * 那个产生者随引擎消失；消费侧保留 —— 它守的能力是"索引可以随时从权威日志重建"，
 * 而这条能力在新架构下仍然有意义（引擎侧完整性检查失败、未来的自愈入口都可以写这个标记）。
 */
export async function indexRebuildNeeded(): Promise<{ needed: boolean; reason?: string }> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return { needed: false };
    /**
     * 第 62 轮：标记文件与库**同属一份数据集** —— 目录跟着引擎实际使用的库走。
     * 用 `get_app_data_dir` 的话，`CODEM_DB_PATH`（便携 / 隔离钻取）下会出现
     * "库在 A、标记写在 B"，而标记的作用正是"库的索引要从日志重建"。
     */
    const dir = (await (await import("./data-root")).resolveDataRoot()).root;
    const path = `${dir}${INDEX_REBUILD_MARKER}`;
    const exists = await invoke("path_exists", { path });
    if (!exists) return { needed: false };
    let reason: string | undefined;
    try {
      const raw = await invoke("read_file", { path });
      reason = JSON.parse(raw)?.reason;
    } catch {
      /* 内容读不出来也照样重建 */
    }
    return { needed: true, reason };
  } catch {
    return { needed: false };
  }
}

/** 清除重建标记（重建成功后调用） */
async function clearIndexRebuildMarker(): Promise<void> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return;
    /**
     * 第 62 轮：标记文件与库**同属一份数据集** —— 目录跟着引擎实际使用的库走。
     * 用 `get_app_data_dir` 的话，`CODEM_DB_PATH`（便携 / 隔离钻取）下会出现
     * "库在 A、标记写在 B"，而标记的作用正是"库的索引要从日志重建"。
     */
    const dir = (await (await import("./data-root")).resolveDataRoot()).root;
    await invoke("delete_file", { path: `${dir}${INDEX_REBUILD_MARKER}` });
  } catch {
    /* 删不掉也无害：重建是幂等的 */
  }
}

/**
 * **写下"索引需要重建"标记**（第 19 轮新增）。
 *
 * 消费侧一直是 `runDatabaseMaintenance`（它看到标记就**从权威日志重建索引**再清标记），
 * 但**生产者**在删 sql.js 时随旧引擎的致命闩锁一起消失了 —— 也就是说
 * "索引坏了能自愈"这条能力当时**只剩一半**（能消费、没人生产）。
 *
 * 现在生产者有两个：
 * 1. **损坏库自动恢复**（`Engine::open_with_recovery` → 渲染侧端口 health 里报 `recovered`，
 *    见 `rust-port.ts` 的 `health()`）：坏文件备份走人、空库重建，索引必须从日志重建回来；
 * 2. 将来任何"检测到索引与日志不一致"的自愈入口。
 *
 * 失败不抛：写标记本身失败不该阻塞启动（下次维护仍会做常规回填/裁剪）。
 */
export async function markIndexRebuildNeeded(reason: string): Promise<boolean> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return false;
    /**
     * 第 62 轮：标记文件与库**同属一份数据集** —— 目录跟着引擎实际使用的库走。
     * 用 `get_app_data_dir` 的话，`CODEM_DB_PATH`（便携 / 隔离钻取）下会出现
     * "库在 A、标记写在 B"，而标记的作用正是"库的索引要从日志重建"。
     */
    const dir = (await (await import("./data-root")).resolveDataRoot()).root;
    await invoke("write_file", {
      path: `${dir}${INDEX_REBUILD_MARKER}`,
      content: JSON.stringify({ reason, at: new Date().toISOString() }),
    });
    console.log("[Maintenance] 已留索引重建标记（下次启动将从权威日志重建索引）");
    return true;
  } catch (e) {
    console.warn("[Maintenance] 写索引重建标记失败（不影响主流程）:", e);
    return false;
  }
}

/**
 * 遥测裁剪的**端口版**。
 *
 * 引擎侧 `telemetry.prune` 刻意要求显式水位线 `before`（没有它直接报错），
 * 因为"以为传了条件其实全表清空"这类事故的代价太高。失败不抛：维护永远不能让应用不可用；
 * 但要**如实留痕**（否则又变成"看起来做了"）。
 */
/**
 * 遥测表名与列名（B-8：裁剪之后要**同步镜像**，不能只打一条引擎命令）。
 *
 * 与 `telemetry.ts` 的 `TABLE` / `wireToTelemetry` 保持一致 —— 那边不在本批所有权内，
 * 所以这里不 import 它的私有常量，而是把这两个**线上契约名**写在这里并注明出处。
 */
const TELEMETRY_TABLE = "telemetry_events";

/**
 * 遥测裁剪的结果（B-8：**必须能区分"裁了 / 失败 / 没得裁"**）。
 *
 * ## 为什么返回值从 `number` 改成三态
 *
 * 原来失败时 `catch { console.warn(...); return 0; }` —— 于是汇总行照打
 * "遥测裁剪 0 条"。而 `0` 同时代表三件完全不同的事：
 * 1. **裁了 0 条**（没有过期数据，一切正常）；
 * 2. **端口未注册 / 没接手**（这次维护根本没做这件事）；
 * 3. **命令失败**（可能有数据但没裁掉，越攒越多）。
 *
 * 这个模块的**头注释**恰恰把"必须能区分没跑与跑了没事做"当设计目标 ——
 * 而遥测这一步是唯一没做到的地方（真机排查时最需要它：库只涨不降时，
 * 判断"裁剪没跑"还是"跑了但没东西可删"决定了下一步查哪里）。
 */
type TelemetryPruneOutcome =
  | { status: "pruned"; rows: number; remaining?: number }
  | { status: "noop"; reason: string }
  | { status: "failed"; reason: string };

export async function pruneTelemetryViaPort(before: number): Promise<TelemetryPruneOutcome> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) {
    return { status: "noop", reason: "端口未注册（本次维护没有可用的存储）" };
  }
  const port = getStoragePort();
  let rows = 0;
  try {
    const res = await port.data.execute("telemetry.prune", { before });
    rows = Number((res as { written?: number } | undefined)?.written ?? 0);
  } catch (e) {
    /**
     * 失败不再静默（原来只有一行 `console.warn`，而汇总行照打"遥测裁剪 0 条"→
     * 与"没得裁"无法区分）。这里**两层都留**：
     * - `console.warn` 保留原样：它是既有告警契约（`snapshot-compaction.test.ts` 的 SNAP-6、
     *   `database-maintenance-bounds.test.ts` 的 MAINT-5 都按 warn 认领这一条）；
     * - `reportPersistFailure` 把失败送进**结构化**通道（可查询的失败清单 + 界面提示）。
     */
    console.warn("[Maintenance] 遥测裁剪（端口）失败（跳过）:", e);
    reportPersistFailure(
      "maintenance.telemetryPrune",
      e,
      `遥测裁剪失败（水位线 ${new Date(before).toISOString()}）：本次没有裁掉任何数据`,
      {
        // 第 88 轮：这不是写盘失败，是一次**维护动作**没跑成 —— 开头那句必须是真的
        title: "维护：遥测裁剪未跑成",
        consequence: "本次没有裁掉任何遥测行（它们会继续留在库里）；不影响你的会话与设置。",
      },
    );
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  /**
   * ## 裁剪之后**必须同步域镜像**（B-8 的另一半）
   *
   * 引擎那一条 `telemetry.prune` 只改库，而**性能面板读的是域镜像**
   * （`telemetry.ts` 的 `telemetryRows()` → `domainReadMany`）。只发命令不更新镜像，
   * 用户看到的是"裁剪之后事件还在"（面板刷新也不对），下一个人就会以为裁剪没生效。
   *
   * 这里的做法与 `telemetry.ts::clearAll` **完全一致**（那是这个仓库里已经验证过的
   * 正确形态）：按镜像里的 `id` 逐行 `crud.delete` —— 它同时改**本地镜像**与写穿，
   * 于是"引擎已删"与"镜像已删"是同一批 id，不会出现两张不同的真相。
   *
   * 为什么不重载整张镜像：`RustDomainMirror.ensureLoaded` 对**已加载**的表是
   * "回调一下就返回"（`if (this.loaded.has(table)) { onLoaded?.(); return; }`），
   * 所以"重新 ensureLoaded"根本刷不掉已经删掉的行。逐 id 删是这里唯一可靠的形态。
   *
   * ⚠️ 代价：镜像只镜像到上限（`telemetry.ts` 的 5000 行），所以**超出上限的那部分
   * 行不在镜像里**，也就不会被这一步删掉 —— 它们由引擎那条命令删掉了，但镜像里
   * 本来就没有，面板看不到它们，所以不影响"面板显示正确"。这一点记在这里，
   * 免得下一个人以为"删的行数必须等于引擎报的 written"。
   */
  try {
    const { domainReadMany, domainDeleteWhere } = await import("./domain-store");
    const mirrored = domainReadMany<Record<string, unknown>>(TELEMETRY_TABLE, (r) => r, {
      maxRows: 5000,
    });
    if (mirrored && mirrored.length > 0) {
      const expired = mirrored.filter((r) => Number(r.timestamp ?? 0) < before);
      if (expired.length > 0) {
        domainDeleteWhere(
          TELEMETRY_TABLE,
          (row) => Number(row.timestamp ?? 0) < before,
          "id",
          {
            scope: "maintenance.telemetryPrune.mirror",
            note: "遥测镜像未同步裁剪（面板仍会显示已删事件）",
            maxRows: 5000,
          },
        );
        console.log(
          `[Maintenance] 遥测镜像同步：按 id 删掉 ${expired.length} 条（镜像上限内的那部分）`,
        );
      }
    }
  } catch (e) {
    // 镜像同步失败不该让维护失败（引擎已经删了），但必须留痕
    reportPersistFailure(
      "maintenance.telemetryPrune.mirror",
      e,
      "引擎侧已裁剪，但遥测镜像未同步（性能面板仍会显示已删事件，重启后一致）",
      {
        // 第 88 轮：数据没丢，是**界面那份镜像**没跟上
        title: "维护：遥测镜像未同步",
        consequence:
          "库里的数据已经裁掉了，只是界面上的性能面板暂时还显示已删事件；重启后两边一致（不会改坏数据）。",
      },
    );
  }

  if (rows > 0) return { status: "pruned", rows };
  return { status: "noop", reason: "没有早于水位线的遥测事件" };
}

/**
 * 把裁剪结果渲染成**汇总行里的一小段**（B-8：三态各有各的说法、失败带原因）。
 *
 * 第 45 轮补上 `remaining`：任务书要求"裁剪 N 条 / **剩余 M 条**" ——
 * 只看裁掉多少看不出"这张表到底还多大"，而"它在涨"正是要盯的事。
 */
function formatTelemetryPrune(outcome: TelemetryPruneOutcome): string {
  switch (outcome.status) {
    case "pruned": {
      const left = typeof outcome.remaining === "number" ? `、剩余 ${outcome.remaining} 条` : "";
      return `遥测裁剪 ${outcome.rows} 条${left}`;
    }
    case "noop":
      return `遥测裁剪 未执行（${outcome.reason}）`;
    case "failed":
      return `遥测裁剪 失败（${outcome.reason}）`;
  }
}

/**
 * 取端口的"结构化命令"能力（没有就抛，让调用方的 catch 走如实上报）。
 *
 * 为什么要有这个小函数：`StorageDataPort.command` 是**可选**能力
 * （见 `port.ts` 的注释），所以每个调用点都得处理"没有它"这一态 ——
 * 到处写 `port.data.command?.()` 会让"缺能力"静默变成"什么都没做"。
 * 抛出去之后，各步的 `catch` 会把它变成"这一步失败（原因：端口没有命令能力）"，
 * 那才是如实表达。
 */
function structuredCommand<T>(
  port: { data: { command?: <R>(cmd: string, params?: Record<string, unknown>) => Promise<R> } },
  cmd: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const fn = port.data.command;
  if (!fn) throw new Error(`端口没有 command 能力，无法执行 ${cmd}（结构化结果读不到）`);
  return fn.call(port.data, cmd, params) as Promise<T>;
}

/**
 * `audit.prune { before }` 的结果（第 45 轮接线）。
 *
 * `storage_audit` 原来**无界增长**（真机 11.8 小时 61,416 行、库内最大的表、
 * 占活数据 35.6%），而引擎侧的 `audit.prune` 一直零生产调用者 —— 典型"有能力没人用"。
 */
interface AuditPruneOutcome {
  status: "pruned" | "noop" | "failed";
  /** 本次裁掉的行数 */
  rows: number;
  /** 裁剪之后的剩余行数（引擎在同一个事务里返回，比再问一次 `audit.stats` 更准） */
  remaining?: number;
  /** 剩余数据里最早/最晚的时间戳（诊断"这个窗口是不是在涨"） */
  oldest?: number | null;
  newest?: number | null;
  reason?: string;
}

/**
 * 按**保留窗口**裁剪审计表（`audit.prune`）。
 *
 * ## 为什么这一步不能省
 *
 * 审计表是"删除审计"（`storage_audit` 的 `AFTER DELETE` / `AFTER UPDATE` 触发器），
 * 它记的是**每一次行消失/被隐藏**。一次"隐藏 10,000 条消息"就写 10,000 行 ——
 * 真机上 11.8 小时 61,416 行，占活数据 35.6%，是库内最大的表。
 * 而它**天生只增不减**：没有任何东西会删它（`audit.clear` 是人工收尾用的）。
 *
 * ## 为什么宁可"裁掉旧记录"也不"根本不开审计"
 *
 * 审计的价值在**事后取证**（事故排查的窗口是小时级），7 天窗口远远够用；
 * 而"开审计"这件事本身就是当初那起"数据被谁删了查不出来"事故的教训 —— 关掉它
 * 等于把那个教训退回去。所以正确处置是**保留窗口**，不是保留全部。
 *
 * @param before 毫秒水位线（`at < before` 的行被删）。缺了水位线引擎直接报错 ——
 *   这与 `telemetry.prune` 同一条原则：**删除必须有明确条件**。
 */
async function pruneAuditViaPort(before: number): Promise<AuditPruneOutcome> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) {
    return { status: "noop", rows: 0, reason: "端口未注册（本次维护没有可用的存储）" };
  }
  try {
    const port = getStoragePort();
    const res = await structuredCommand<{
      removed?: number;
      remaining?: number;
      oldest?: number | null;
      newest?: number | null;
    }>(port, "audit.prune", { before });
    const rows = Number(res?.removed ?? 0);
    const remaining = typeof res?.remaining === "number" ? res.remaining : undefined;
    const out: AuditPruneOutcome = {
      status: rows > 0 ? "pruned" : "noop",
      rows,
      remaining,
      oldest: res?.oldest ?? null,
      newest: res?.newest ?? null,
    };
    if (rows === 0) out.reason = `没有早于 ${new Date(before).toISOString()} 的审计记录`;
    return out;
  } catch (e) {
    /**
     * 走 `reportPersistFailure` + 保留原有的 warn 形态：这一步失败**不影响使用**
     * （审计只是取证工具），但必须留痕 —— 否则"审计表在涨"这件事又看不见了。
     */
    console.warn("[Maintenance] 审计裁剪（端口）失败（跳过）:", e);
    reportPersistFailure(
      "maintenance.auditPrune",
      e,
      `审计裁剪失败（水位线 ${new Date(before).toISOString()}）：storage_audit 本次没有被裁剪`,
      {
        // 第 88 轮：维护动作没跑成，不是写盘失败
        title: "维护：审计裁剪未跑成",
        consequence: "storage_audit 本次没有被裁剪（旧审计行会继续留着，不影响任何功能）。",
      },
    );
    return { status: "failed", rows: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** `audit.stats` 的读数（第 45 轮：这是"审计表在涨"能被看见的**唯一**途径） */
interface AuditStatsOutcome {
  read: boolean;
  count?: number;
  oldest?: number | null;
  newest?: number | null;
  reason?: string;
}

/**
 * 读审计表规模（`audit.stats`）。
 *
 * 为什么单独读一次而不是复用 `audit.prune` 的 `remaining`：`prune` 只在**维护跑到那一步**
 * 时才返回数字，而且**失败时什么都没有**；而"审计表现在多大"是排查时要看的独立事实
 * （哪怕裁剪失败了也要知道它多大）。两者都报，原因不同。
 */
async function auditStatsViaPort(): Promise<AuditStatsOutcome> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) return { read: false, reason: "端口未注册" };
  try {
    const port = getStoragePort();
    const res = await structuredCommand<{ count?: number; oldest?: number | null; newest?: number | null }>(
      port,
      "audit.stats",
      {},
    );
    if (typeof res?.count !== "number") {
      return { read: false, reason: "audit.stats 返回的形状不符合契约" };
    }
    return { read: true, count: res.count, oldest: res.oldest ?? null, newest: res.newest ?? null };
  } catch (e) {
    console.warn("[Maintenance] 读审计规模（端口）失败（跳过）:", e);
    return { read: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** `storage.compact` 的结果（第 45 轮接线） */
interface StorageCompactOutcome {
  status: "compacted" | "noop" | "failed";
  /** 真正回收的字节数（只有 `status === "compacted"` 时有意义） */
  reclaimedBytes: number;
  /** 空闲页规模（未达阈值时的诊断依据） */
  freeBytes?: number;
  freeRatio?: number;
  elapsedMs?: number;
  reason?: string;
}

/**
 * 回收库文件里的空闲页（`storage.compact`，引擎侧是整库 `VACUUM`）。
 *
 * ## 为什么需要这一步（真机实测）
 *
 * 库文件 **115,191,808 B**，而活数据只有 16,392,192 B；`freelist_count` = 98,799,616 B
 * —— **85.8% 是永不回收的空闲页**。而全 crate 搜 `VACUUM` 零命中：
 * 没有任何东西会回收它们，库只会越长越大（每次全库重灌、每次大删除都制造空闲页）。
 *
 * ## 为什么**用默认阈值**、且绝不传 `force`
 *
 * 它是**整库重写**：需要与库等量的临时空间，期间占住单写者锁；115 MB 的库是秒级到十秒级。
 * 默认阈值是"空闲 ≥ 8 MiB **且** 空闲占比 ≥ 25%"——两个都满足才做。
 * 调低阈值 = 把"每次启动都重写一遍库"变成常态，那比不回收更糟（启动变慢 + 磁盘磨损）。
 * 传 `force` 只在人工排查时用，**不属于启动维护**。
 *
 * ## 为什么必须如实报"做了没有"
 *
 * `performed:false`（未达阈值）与"这一步根本没跑"在真机上必须能区分 ——
 * 这正是本模块头注释里那条设计目标，也是这次接线最容易做成"看起来跑了"的地方。
 */
export async function compactStorageViaPort(): Promise<StorageCompactOutcome> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) return { status: "noop", reclaimedBytes: 0, reason: "端口未注册" };
  try {
    const port = getStoragePort();
    /**
     * **刻意不传任何参数**：让引擎用它自己的默认阈值（8 MiB 且 25%）。
     * 渲染侧一旦开始传 `min_free_*`，阈值就有了第二个真相 —— 而它的取值需要
     * 跟着"库有多大 / 启动预算多长"变，那种判断属于引擎侧（那里才看得到页数）。
     */
    const res = await structuredCommand<{
      performed?: boolean;
      reason?: string;
      reclaimed_bytes?: number;
      free_bytes?: number;
      free_ratio?: number;
      elapsed_ms?: number;
    }>(port, "storage.compact", {});
    if (res?.performed) {
      return {
        status: "compacted",
        reclaimedBytes: Number(res.reclaimed_bytes ?? 0),
        elapsedMs: Number(res.elapsed_ms ?? 0),
      };
    }
    return {
      status: "noop",
      reclaimedBytes: 0,
      freeBytes: Number(res?.free_bytes ?? 0),
      freeRatio: Number(res?.free_ratio ?? 0),
      reason: res?.reason ?? "引擎判定未达阈值",
    };
  } catch (e) {
    console.warn("[Maintenance] 空间回收（端口）失败（跳过）:", e);
    reportPersistFailure(
      "maintenance.storageCompact",
      e,
      "空间回收失败：本次没有回收任何空闲页（库会继续持有它们，下次维护会再试）",
      {
        // 第 88 轮：维护动作没跑成，不是写盘失败
        title: "维护：空间回收未跑成",
        consequence: "本次没有回收任何空闲页，库文件会继续持有它们（不影响数据与使用）。",
      },
    );
    return { status: "failed", reclaimedBytes: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 完整性检查的结果（第 45 轮接线） */
export interface IntegrityCheckOutcome {
  status: "ok" | "failed" | "skipped";
  detail?: string;
  reason?: string;
}

/**
 * 找出"**索引落后于权威日志**"的会话（第 52 轮）。
 *
 * 与"库损坏"是两件事：这里库是好的、`quick_check` 也 ok，只是索引**少了行**。
 * 修复触发器此前只有两个（完整性检查失败、引擎恢复时写的标记），于是
 * "索引真的少了行、但没坏也没标记"就成了静默缺口 —— 真机实证：某会话日志有 657 个
 * 唯一 id、索引只有 545 行，差 112 行，没有任何信号。
 *
 * 判据与"为什么这个方向只能是丢行"：见 `runDatabaseMaintenance` 里的长注释。
 * 要点：只比**日志已 hydrate** 的会话；口径对 `messages.count.total`（含 hidden，
 * 因为裁剪是软删除、行留在库里）；跳过有会话墓碑的（用户删掉的会话）。
 */
async function detectSessionsBehindLog(): Promise<
  Array<{ sessionId: string; indexRows: number; logIds: number }>
> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) return [];

  const [{ listSessionLogs, isSessionDeleted }, msgMod] = await Promise.all([
    import("./session-jsonl"),
    import("./message"),
  ]);

  let sessionIds: string[] = [];
  try {
    sessionIds = await listSessionLogs();
  } catch (e) {
    console.warn("[Maintenance] 列会话日志失败（本次不做索引/日志对账）:", e);
    return [];
  }

  const behind: Array<{ sessionId: string; indexRows: number; logIds: number }> = [];
  for (const sessionId of sessionIds) {
    try {
      /**
       * ① 用户删掉的会话：日志留墓碑是设计使然（`isSessionDeleted`），不参与比较 ——
       * 而且**没有任何合法读者**（会话行已删、这个 id 不会再被用户面读路径读），
       * 所以顺手把它已经驻留的日志正文镜像释放掉（第 63 轮，见
       * `message.ts::releaseSessionLogCache` 的"为什么这个时机是安全的"）。
       *
       * 这一步治的是"**上一个进程里**删掉的会话"：`session.ts::deleteSession` 的释放
       * 只覆盖本进程内的删除，而这些会话的日志文件还在磁盘上、墓碑也在，
       * `listSessionLogs()` 照样把它们列出来 —— 于是下面那句"主动读一遍日志"
       * 会把它们的正文**读进内存**（读的是日志文件，不看会话表），
       * 而它们永远不会被任何东西用到，是纯驻留。
       *
       * 判据放在 hydrate **之前**（原来在之后）：顺序换过来只是省掉"为一次不会用到
       * 的对账去读全文"，不影响任何报告口径 —— 两条路都是 `continue`、都不计数。
       */
      if (await isSessionDeleted(sessionId)) {
        msgMod.releaseSessionLogCache(sessionId, "会话已删除（日志留墓碑）");
        continue;
      }
      /**
       * ② 这里**必须自己去把日志读一遍**，不能等别人先 hydrate。
       *
       * 第一版是"只比已 hydrate 的会话"，看着保守，实际会在**最该发现问题的形态**上瞎掉：
       * **索引为空**的会话（正是"索引丢光了"那种）在回填里会走
       * `if (messages.length === 0) continue` —— 回填直接跳过它、也就不会 hydrate 它，
       * 于是对账永远看不到它、永远不告警。
       * （这是我在真机夹具上撞出来的：日志 3 条 / 索引 0 行，第一版检测不到。）
       *
       * `ensureSessionLogHydrated` 幂等去重（同一会话每进程只读一次），
       * 所以这里的"主动读"不会放大成本。
       */
      if (msgMod.sessionLogReadState(sessionId) === "pending") {
        await new Promise<void>((resolve) => msgMod.ensureSessionLogHydrated(sessionId, () => resolve()));
      }
      // ③ 读过之后仍不是 hydrated（= 读失败）：没有可信集合，跳过（不许瞎猜）
      if (msgMod.sessionLogReadState(sessionId) !== "hydrated") continue;
      // ④ 日志里的活消息数（`null` = 不知道，**不许**当成 0）
      const logIds = msgMod.logLiveMessageCount(sessionId);
      if (logIds === null || logIds === 0) continue;
      // ⑤ 引擎报的该会话总行数（含 hidden）
      const counted = await structuredCommand<{ total?: number; count?: number }>(
        getStoragePort(),
        "messages.count",
        { session_id: sessionId },
      );
      const indexRows = typeof counted?.total === "number" ? counted.total : counted?.count;
      if (typeof indexRows !== "number") continue;
      if (indexRows < logIds) behind.push({ sessionId, indexRows, logIds });
    } catch (e) {
      console.warn(`[Maintenance] 会话 ${sessionId} 的索引/日志对账失败（跳过该会话）:`, e);
    }
  }
  return behind;
}

/**
 * **异步、节流**地跑一次 `PRAGMA quick_check`（`integrity_check`）。
 *
 * ## 为什么必须有这一步（D12）
 *
 * 引擎在**数据页**损坏时**不会**走自动恢复（`open_with_recovery` 只在**头部**损坏时
 * 备份并重建），而渲染侧的 `integrityCheck` 生产零调用 —— 也就是说：
 * 数据页坏了，**没有任何人会知道**，用户只会看到某个查询开始报错或结果不对。
 *
 * ## 为什么必须节流（真机成本，第 51 轮按实测量过）
 *
 * 实测（同 harness，`health` 作为基线只算差值）：**32 ms @10k 行 / 325 ms @100k 行**，
 * 用户真实库 76 ms。原文写的 "901 ms @10k / 4,469 ms @100k" 与
 * "维护是 App.tsx 启动时 await 的一步、这一条直接加 1–4.5 秒" **都与实测不符**
 * （维护是 `void (async …)` 后台任务，首屏不等它）—— 更正见上面窗口常量的注释。
 * 所以节流现在按库大小分档（小/中库 1 小时、大库 12 小时），
 * 而不是为了省那几毫秒把发现延迟拉到 12 小时：
 *
 * - **节流状态存 settings**（`INTEGRITY_CHECK_MARKER_KEY`），不是内存变量：
 *   内存变量在"用户一天开十次应用"时形同没有节流（每次都是新进程）。
 *
 * ## 失败时的动作
 *
 * `ok: false` → **复用既有的 `markIndexRebuildNeeded`** 写"索引需要重建"标记
 * （下次维护会据此从权威日志重建索引 + 清标记），并如实上报。
 * 这是"索引可从权威日志重建"这条分层在完整性维度的落地：
 * 页损坏时索引不可信，而**权威副本在 JSONL 里，重建是有意义的**。
 *
 * @param now 注入当前时间（测试用；生产省略）
 */
export async function verifyIntegrityThrottled(
  now: number = Date.now(),
): Promise<IntegrityCheckOutcome> {
  const { hasStoragePort, getStoragePort } = await import("./port");
  if (!hasStoragePort()) return { status: "skipped", reason: "端口未注册" };
  const port = getStoragePort();

  /**
   * 节流：读上次检查时间。
   *
   * ⚠️ 读不到（settings 面读失败 / 这一行不存在）**不当作"刚检查过"**：
   * 前者会让完整性检查被永久跳过（比不检查更坏，因为它看起来"在跑"），
   * 后者的正确语义是"从来没检查过" → **应当检查**。
   * 两种形态在这里的处置相同（都继续检查），但原因不同，所以分开写清楚。
   */
  let lastAt: number | null = null;
  try {
    const page = await port.data.query<{ key: string; value: string }>("crud.list", {
      table: "settings",
      limit: 2000,
    });
    const raw = (page.items ?? []).find((s) => s.key === INTEGRITY_CHECK_MARKER_KEY)?.value;
    if (raw) {
      const parsed = Number(raw);
      lastAt = Number.isFinite(parsed) ? parsed : null;
    }
  } catch (e) {
    console.warn("[Maintenance] 读完整性检查时间戳失败（本次照常检查）:", e);
  }
  /**
   * 窗口按**库大小**选（第 51 轮）：小/中库 1 小时、大库 12 小时。
   *
   * 读大小走 `engine.health()`（一次很便宜的调用，返回值里有 `sizeBytes`）。
   * **读不到大小不当作"大库"**：那会退化成"永远走 12 小时窗口"，
   * 而默认更保守的那一侧在成本上毫无必要（实测最大的量级也只有几百毫秒，
   * 且不阻塞首屏）—— 所以读不到就按小库处理，并在理由里如实说明。
   */
  let dbSizeBytes: number | null = null;
  try {
    const h = await port.engine.health();
    if (typeof h?.sizeBytes === "number" && Number.isFinite(h.sizeBytes)) dbSizeBytes = h.sizeBytes;
  } catch (e) {
    console.warn("[Maintenance] 读库大小失败（本次按小库窗口判定）:", e);
  }
  const isLargeDb = dbSizeBytes !== null && dbSizeBytes >= INTEGRITY_CHECK_LARGE_DB_BYTES;
  const windowMs = isLargeDb ? INTEGRITY_CHECK_INTERVAL_LARGE_DB_MS : INTEGRITY_CHECK_INTERVAL_MS;

  if (lastAt !== null && now - lastAt < windowMs) {
    const waitH = ((windowMs - (now - lastAt)) / 3_600_000).toFixed(1);
    return {
      status: "skipped",
      reason:
        `距上次检查 ${((now - lastAt) / 3_600_000).toFixed(1)} 小时（${
          windowMs / 3_600_000
        } 小时内不重复跑，还需 ${waitH} 小时；` +
        `库大小 ${
          dbSizeBytes === null ? "读不到，按小库窗口" : `${(dbSizeBytes / 1048576).toFixed(1)} MB`
        }）`,
    };
  }

  /** 先写时间戳再检查：宁可"这次失败了下一次窗口到了才重试"，也不要在失败时反复重跑 */
  try {
    await port.data.execute("settings.set", {
      key: INTEGRITY_CHECK_MARKER_KEY,
      value: String(now),
    });
  } catch (e) {
    console.warn("[Maintenance] 写完整性检查时间戳失败（不影响本次检查）:", e);
  }

  try {
    const res = await structuredCommand<{ ok?: boolean; detail?: string }>(port, "integrity_check", {});
    if (res?.ok) return { status: "ok", detail: res.detail ?? "ok" };
    const detail = res?.detail ?? "（引擎没有给出细节）";
    /**
     * 页损坏 → 写"索引需要重建"标记（复用既有能力），并如实上报。
     *
     * ⚠️ 标记这一步**只在真的判失败时**做：`ok:true` 时写标记会让每次启动都白重建一次索引
     * （那是分钟级 + 全库 upsert），把"损坏自愈"变成"常态开销"。
     */
    await markIndexRebuildNeeded(`完整性检查失败：${detail}`);
    reportPersistFailure(
      "maintenance.integrityCheck",
      new Error(detail),
      "完整性检查失败：已留「索引需要重建」标记（下次维护会从权威日志重建索引）；" +
        "数据页损坏时引擎不会自动恢复，需要人工确认库文件",
      {
        // 第 88 轮：真机取证里这行印的是「写盘失败（第 1 次）」，
        // 而同一句消息正文写着「完整性检查失败」—— 开头那句是假的
        title: "维护：完整性检查未跑成",
        consequence:
          "已留「索引需要重建」标记（下次维护会从权威日志重建索引）；" +
          "若确是数据页损坏，引擎不会自动恢复，需要人工确认库文件。",
      },
    );
    return { status: "failed", detail };
  } catch (e) {
    console.warn("[Maintenance] 完整性检查（端口）失败（跳过）:", e);
    return { status: "skipped", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 审计裁剪那一段（第 45 轮："裁剪 N 条 / 剩余 M 条"是任务书明确要求的形态）。
 *
 * 为什么"剩余"与"裁剪"要一起报：只看裁掉多少**看不出这张表是不是还在涨** ——
 * 而"`storage_audit` 无界增长"正是这一轮要解决的那个问题。真机上 61,416 行 / 35.6%
 * 这个数字当初就是因为没人报"它多大"才藏了 11.8 小时。
 */
function formatAuditPrune(outcome: AuditPruneOutcome, result: MaintenanceResult): string {
  const size = result.auditStatsRead
    ? `、审计表 ${result.auditRemainingRows} 行`
    : (() => {
        const why = outcome.status === "failed" ? "（规模未读到：audit.stats 也失败）" : "";
        return `、审计表 规模未读到${why}`;
      })();
  switch (outcome.status) {
    case "pruned":
      return `审计裁剪 ${outcome.rows} 条、剩余 ${
        typeof outcome.remaining === "number" ? outcome.remaining : "（未报）"
      } 条${size}`;
    case "noop":
      return `审计裁剪 未执行（${outcome.reason}）${size}`;
    case "failed":
      return `审计裁剪 失败（${outcome.reason}）${size}`;
  }
}

/**
 * 空间回收那一段（第 45 轮）。
 *
 * **"跑了但没做（未达阈值）"与"跑了并回收了 N 字节"必须能区分** —— 这是任务书的
 * 明确要求，也是本模块头注释里那条设计目标最容易在这里被做砸的地方：
 * 直接把 `performed:false` 渲染成"回收 0 字节"就退回了"三种情况一个样子"。
 */
function formatCompact(outcome: StorageCompactOutcome): string {
  switch (outcome.status) {
    case "compacted":
      return `空间回收 已回收 ${formatBytes(outcome.reclaimedBytes)}（耗时 ${outcome.elapsedMs ?? 0} ms）`;
    case "noop": {
      const detail =
        typeof outcome.freeBytes === "number"
          ? `空闲 ${formatBytes(outcome.freeBytes)}（占比 ${((outcome.freeRatio ?? 0) * 100).toFixed(1)}%）`
          : undefined;
      return `空间回收 未执行（${outcome.reason ?? "未达阈值"}${detail ? `；${detail}` : ""}）`;
    }
    case "failed":
      return `空间回收 失败（${outcome.reason}）`;
  }
}

/** 完整性检查那一段（第 45 轮） */
function formatIntegrity(outcome: IntegrityCheckOutcome): string {
  switch (outcome.status) {
    case "ok":
      return "完整性检查 通过";
    case "skipped":
      return `完整性检查 跳过（${outcome.reason ?? "未执行"}）`;
    case "failed":
      return `完整性检查 **失败**（${outcome.detail ?? "无细节"}）—— 已留索引重建标记`;
  }
}

/** 字节数 → 人读的形态（维护汇总行里报 `reclaimed_bytes` 用） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 不变量审计的**上次水位**（settings 里的一个键）—— 用来把"历史缺口"与"本次新产生"分开。
 *
 * ## 为什么必须有水位（第 47 轮：这条本来是"写了名字没人填"的谎）
 *
 * 第 46 轮把 777 条历史缺口从"违规"改称"历史缺口"（信息级）是对的，但那一段同时写着
 * "只有本次新产生的那部分（`newViolations`，下一轮用水位判定）才升级为告警" ——
 * 而 `auditInvariantsForSessions` **从来没有返回过** `newViolations`，调用点也
 * `?? 0` 兜底。后果：告警分支（`console.warn`）与失败上报**永远不会执行**，
 * 这条不变量存在的意义（发现"事件双写又断了一条路"）等于零 —— 真出现新缺口时，
 * 它只会被 777 这个常数淹没，用户和开发者都看不见。
 *
 * ## 水位怎么算（判据落在"缺口集合"上，不落在"函数被调用了"）
 *
 * 每个缺口有一个**稳定指纹**：`会话id / 违规类型 / 消息id（没有就用 seq）`。
 * 本次审计的指纹集合与上次水位比较：
 * - 水位里**没有**的指纹 = 本次新产生的缺口 → `console.warn` + `reportPersistFailure`；
 * - 水位里有的 = 历史缺口 → 只进信息级汇总行。
 *
 * 三条边界（都用例守着）：
 * 1. **第一次审计**（水位不存在）→ 全部算历史缺口（`newViolations = 0`），
 *    同时把本次集合写成水位。否则升级版本后第一次启动会把几百条老缺口全报成"新缺陷"，
 *    与第 46 轮修掉的那个假警报一模一样；
 * 2. **水位是并集，只增不减**（⚠️ 第 47 轮真机复核把原来的"只写本次存在的键"证伪了，
 *    取证与取舍见下面 `readInvariantWatermark()` 之后的对比段落）；
 * 3. **指纹里不放内容**：用户编辑一条历史消息的正文不该被算成"新缺口"（键是消息 id）。
 */
const INVARIANT_WATERMARK_KEY = "codem-invariant-watermark";

/**
 * 水位的键数上限（见写入处的「有界水位」段落）。
 *
 * 20000 键 ≈ 1.2 MB 的 settings 值 —— 相对这个库能逐字保真 5 MB 工具结果的能力很小，
 * 而 20000 条历史缺口已远超"靠告警发现新缺陷"真正需要的量。超限丢**最旧**的键。
 */
const MAX_INVARIANT_WATERMARK_KEYS = 20_000;

/** 仅测试用：把上限暴露出去，让用例能验证"上限存在"而不必真造 2 万个缺口 */
export const __MAX_INVARIANT_WATERMARK_KEYS_FOR_TEST = MAX_INVARIANT_WATERMARK_KEYS;

/**
 * 水位里存的东西（版本号留着以后换指纹口径时能识别旧数据）
 *
 * ⚠️ `keys` 的**顺序有含义**：它是"首次被记住的先后"（插入顺序）。
 * 有界水位超限时靠这个顺序丢**最旧**的键，所以**不要**再按字典序 sort 后再写回
 * （第 47 轮补之前是 `[...set].sort()`；排序会把"最旧"这个信息抹掉）。
 */
interface InvariantWatermark {
  v: 1;
  at: number;
  keys: string[];
}

/** 一个缺口的稳定指纹：会话 + 类型 + 消息/序号，不含内容 */
function violationFingerprint(sessionId: string, v: { type: string; messageId?: string; seq?: number }): string {
  const target = v.messageId ?? (v.seq !== undefined ? `seq:${v.seq}` : "-");
  return `${sessionId}|${v.type}|${target}`;
}

/** 读水位。键不存在 / 解析失败 / 形状不对 → `null`（= 没有水位，**不是**空水位） */
function readInvariantWatermark(): InvariantWatermark | null {
  try {
    const raw = getSettingJSON<InvariantWatermark | null>(INVARIANT_WATERMARK_KEY, null);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { keys?: unknown }).keys)) return null;
    return {
      v: 1,
      at: Number((raw as { at?: unknown }).at ?? 0) || 0,
      keys: (raw as { keys: unknown[] }).keys.map((k) => String(k)),
    };
  } catch {
    return null;
  }
}

/**
 * 读侧镜像的最小接口（`RustMessageMirror` / `RustEventMirror` 都满足）。
 *
 * 第 63 轮：从 `waitForSessionMirrors` 的**函数内局部接口**提到模块级 ——
 * 因为"重新确认就绪"（见 `recheckMirrorsReady`）也需要同一份形状，
 * 两处各写一份迟早会漂移（这正是本仓库反复记录的那类"同一规则两份实现"）。
 */
interface MirrorLike {
  isLoaded?: (sid: string) => boolean;
  isTruncated?: () => boolean;
  ensureLoaded?: (sid: string, cb?: () => void) => void;
}

/** 取可用的读侧镜像（消息 + 事件）；没有任何镜像能力时返回空数组 */
function sessionMirrors(): MirrorLike[] {
  const port = getStoragePort() as unknown as { messages?: MirrorLike; events?: MirrorLike } | null;
  return [port?.messages, port?.events].filter(
    (m): m is MirrorLike => !!m && typeof m.ensureLoaded === "function" && typeof m.isLoaded === "function",
  );
}

/** 该会话两侧镜像**此刻**是否都已加载（**不触发加载、不等待**） */
function mirrorsReadyNow(mirrors: MirrorLike[], sid: string): boolean {
  return mirrors.every(
    (m) => m.isLoaded!(sid) === true && !(typeof m.isTruncated === "function" && m.isTruncated()),
  );
}

/**
 * 单个会话的"**重新**确认就绪"（第 63 轮）。
 *
 * ## 为什么需要它：批量就绪快照会**过期**
 *
 * `waitForSessionMirrors(sessionIds)` 是批量等的，返回的是**那一刻**的快照。
 * 而两侧镜像都有内存预算（消息镜像 20000 行、第 63 轮给事件镜像补上了同一条），
 * 批量加载会把先加载完的会话按 LRU 逐出 —— 于是"头上判为就绪"的会话
 * 轮到它读的时候可能已经不在镜像里，`readAll(sid)` 返回空数组，
 * 判据随即把"读不到"算成"这些消息都没有事件记录"（真机形态：934 = 657 + 277 的假缺口）。
 *
 * ⚠️ 更糟的是：这条竞态**不是罕见的边角**。第 63 轮修掉"强制点没生效"之后，
 * 批量加载在所有会话都被发出去的同一条微任务链上**必然**发生逐出，
 * 于是"头上就绪、轮到时已被逐出"是**常规形态**，不是例外。
 *
 * ## 处置（与头上那次等就绪**同一条规则**，不发明新的）
 *
 * - 此刻就绪 → 直接用（零额外等待 —— 没超预算的机器走的一直是这条）；
 * - 此刻不就绪 → 重新等一次：`ensureLoaded` 会重新分页拉全量，
 *   读到的仍是**完整集合**（`isLoaded` 为真才放行）；
 * - 等不到（读失败 / 超预算）→ **如实计入 `unreadableSessions` 并跳过**。
 *
 * ## 等待是有界的（两层都要有，缺一层就会被拖死）
 *
 * - **单会话**：头上就绪过的（= 被逐出 → 重新加载本来就快）给 `MIRROR_RECHECK_PER_SESSION_MS`；
 *   头上就没就绪的（= 可能加载慢或本来就失败）只给 `MIRROR_RECHECK_COLD_SESSION_MS`，
 *   免得每个会话都白等一整个窗口；
 * - **整轮共享** `MIRROR_RECHECK_TOTAL_MS`：用尽之后不再等，剩下的会话一律计入
 *   "未检查"。这条与 `waitForSessionMirrors` 的 `budgetMs`（"维护不会被拖死"）
 *   是同一条原则：**宁可不检查，也不许报假缺口，更不许把维护挂住**。
 *
 * 代价如实写明：语料量超过镜像预算的机器，维护会为被逐出的会话多付一次加载成本
 * （与头上那次批量加载同量级）。还有一笔**必须一起说清**的代价：批量等就绪那一趟
 * （`waitForSessionMirrors` 的 4000ms 共享上限）在"途中发生逐出"的机器上会**等到它的上限**——
 * 因为镜像的就绪回调带着 `loaded.has(sid)` 判据（`rust-port.ts`），
 * 被逐出的会话不会再触发那个回调。也就是说：这一改动让"语料超预算"的机器
 * 在维护里最多多等一次 4000ms。**换到的是"逐出不会被算成数据缺口"**，
 * 而假缺口会写进只增不减的水位（见 `invariant-watermark` 的用例），代价更高。
 */
const MIRROR_RECHECK_PER_SESSION_MS = 2500;
const MIRROR_RECHECK_COLD_SESSION_MS = 800;
const MIRROR_RECHECK_TOTAL_MS = 8000;

async function recheckMirrorsReady(
  sid: string,
  readyAtGate: boolean,
  deadline: number,
): Promise<boolean> {
  const mirrors = sessionMirrors();
  if (mirrors.length === 0) return true;
  if (mirrorsReadyNow(mirrors, sid)) return true;
  const budgetMs = Math.min(
    readyAtGate ? MIRROR_RECHECK_PER_SESSION_MS : MIRROR_RECHECK_COLD_SESSION_MS,
    deadline - Date.now(),
  );
  if (budgetMs <= 0) return false;
  const again = await waitForSessionMirrors([sid], budgetMs);
  return again.get(sid) === true;
}

/**
 * 等这些会话的**读侧镜像**（消息 + 事件）真正就绪；返回 `会话 → 是否读得到`。
 *
 * ## 为什么必须有这一步（第 60 轮的真机取证）
 *
 * 两条判据读的分别是 `EventLog.readAll(sid)` 与 `MessageStorage.listMessages(sid)`，
 * 两者都有同一条硬路由规则：**该会话的镜像没加载完 → 返回空数组/空列表**
 * （见 `event-log.ts` 与 `message.ts::listMessagesFromIndex` 的"合理空结果"）。
 * 而维护触发的这一次审计**往往就是第一次访问这些会话** —— `ensureLoaded` 是
 * "触发加载、同步返回"，真实现走异步 IPC，于是紧接着的读**读到的是空**。
 *
 * 后果不是"少报"，是**多报**：把"事件读成空"理解成"这些消息都没有事件记录"，
 * 于是把该会话的**每一条消息**都报成缺口。真机实测（同一份数据、两次维护相隔 36 秒）：
 *
 * | 那次维护 | 报出的历史缺口 | 与会话消息行数的关系 |
 * | --- | --- | --- |
 * | 事件镜像没加载完 | **934** | = 657 + 277（两个会话的**全部消息行**） |
 * | 镜像已加载 | **749** | = 505 + 244（与 DB 真值逐条相等） |
 *
 * 顺带把第 47 轮那桩悬案解释了：当时追到的"水位漂移 777 / 757 / 671"并归因于
 * "索引裁剪 / 隐藏状态让参与审计的集合摆动"，真正的变量是**审计那一刻镜像加载到哪一步**
 * （并集水位只是把噪声压住了，没有修掉噪声源）。
 *
 * 两边**都要等**：第 60 轮的契约用例直接观察到，只等事件那一边时，消息那一侧仍在
 * "未加载"的窗口里读成空，于是判据换个方向继续造假（`RECORDED_BUT_NOT_VISIBLE` × 2：
 * 事件有、消息"没有"）。
 *
 * ## 就绪判据
 *
 * - 消息镜像：`isLoaded(sid)` 且**未被截断**（截断 = 集合不完整，与
 *   `message.ts::isMessagesReadUnavailable` 同一条判据）；
 * - 事件镜像：`isLoaded(sid)`（事件镜像没有截断这一态）；
 * - 端口连镜像能力都没有 → 一律视为"就绪"：那种状态下两条判据本来就没有可判的东西，
 *   在这里报错只会变成噪声。
 *
 * ## 代价与边界（如实写明）
 *
 * - **不增加 IPC 次数**：这些会话的 `ensureLoaded` 本来就会被本次审计触发，
 *   这里只是**等**它完成；等待有上限（`budgetMs`，按会话均摊），维护不会被拖死。
 * - 等不到（加载失败 / 超预算）→ 该会话**跳过**并计入 `unreadableSessions`：
 *   "没检查"必须能看见，且**绝不能**折算成"没有缺口"。
 */
async function waitForSessionMirrors(
  sessionIds: readonly string[],
  budgetMs = 4000,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(sessionIds.filter((s) => typeof s === "string" && s.length > 0))];
  const mirrors = sessionMirrors();
  if (mirrors.length === 0) {
    for (const sid of ids) out.set(sid, true);
    return out;
  }
  /** 该会话两侧镜像**都**读得到（截断的镜像不完整：读到的"少"不是真值） */
  const readyOf = (sid: string): boolean => mirrorsReadyNow(mirrors, sid);
  const deadline = Date.now() + budgetMs;
  await Promise.all(
    ids.map(
      (sid) =>
        new Promise<void>((resolve) => {
          if (readyOf(sid)) {
            out.set(sid, true);
            return resolve();
          }
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            // 以**最终状态**为准（回调触发不等于就绪一定为真）
            out.set(sid, readyOf(sid));
            resolve();
          };
          /**
           * ⚠️ **先数、后触发**：`ensureLoaded` 可能是**同步回调**的（假端口、
           * 以及"该会话刚被别的路径加载完"的真实现分支）。若一边触发一边计数，
           * 第一个镜像的同步回调就会在**第二个镜像还没被触发**时把 `finish` 叫起来，
           * 于是以"只就绪了一侧"的状态判定 → 每个会话都被判成未就绪（本用例抓到过）。
           */
          const notLoaded = mirrors.filter((m) => !m.isLoaded!(sid));
          if (notLoaded.length === 0) {
            finish();
            return;
          }
          let waiting = notLoaded.length;
          const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
          for (const m of notLoaded) {
            try {
              m.ensureLoaded!(sid, () => {
                waiting -= 1;
                if (waiting <= 0) {
                  clearTimeout(timer);
                  finish();
                }
              });
            } catch {
              // 触发失败：不再等这一个，但**仍然要等其它镜像**（少等一个就会读成空）
              waiting -= 1;
            }
          }
          if (waiting <= 0) {
            clearTimeout(timer);
            finish();
          }
        }),
    ),
  );
  return out;
}

/**
 * 在生产路径上跑一次运行时不变量审计（第 45 轮功能上下文审计 §"未做" 的收口）。
 *
 * ## 为什么是这里，而不是"把 `agentic-loop.ts:831` 的门控拆掉"
 *
 * `agentic-loop.ts:831` 的门控（`NODE_ENV === "development" || DEBUG_INVARIANTS === "1"`）
 * 是**有意**的：那个调用点在**每一轮 `run()`** 上，而 `checkVisibleRecordedInvariant`
 * 每个会话要读**全部事件** + 全部消息（`listMessages` 还会合并权威日志）。
 * 拆掉门控 = 每次用户发一条消息就付一次全量读，代价与收益不对称。
 *
 * 而这条不变量要抓的缺陷（事件双写断了）是**持久状态**，不是瞬时状态：
 * 消息写进去了、事件没写，那个差异不会自己消失。所以"启动时（以及每次维护时）
 * 检查一遍"就足够，且成本被摊到每天几次 —— 这与 `verifyIntegrityThrottled`
 * （12 小时一次的 `PRAGMA quick_check`）是同一个取舍。
 *
 * ## 为什么会话列表从这里传进去
 *
 * `checkVisibleRecordedInvariant()` **无参调用什么都不检查**（它自己列不出会话，
 * 原注释写着这一点）却返回 `passed: true` —— 那是"没跑"冒充"通过"。
 * 这里已经有 `sessions` 镜像（对账那一段刚读过），显式传进去，
 * 于是"检查了几个"在返回结构里是诚实的。
 *
 * ## 三态与容错
 *
 * - 端口没有 `command` 能力 / 会话列表为空 → `checked = 0`，**不假装通过**；
 * - 单个会话抛错不中断整轮（记 `checked` 为已尝试的那个数，跳过该会话并上报）；
 * - 违规**不抛**：它是一条"需要被看见"的数据事实，不是维护失败。
 *
 * ## 返回值里的 `newViolations`（第 47 轮：水位落地）
 *
 * 见 `INVARIANT_WATERMARK_KEY` 的长注释。这里只强调一个取舍：
 * **水位在函数内部读写**（而不是让调用方传进来）—— 因为"上次水位"必须与"这次检查了哪些会话"
 * 是同一份事实。调用方传水位的话，两处口径一旦分叉（比如换了会话集合），
 * `newViolations` 就会变成噪声源，而这个字段的全部价值就是"信得过"。
 */
export async function auditInvariantsForSessions(
  sessionIds: readonly string[],
): Promise<{
  checked: number;
  violations: number;
  newViolations: number;
  samples: string[];
  /** 第 60 轮：事件库**结构**异常数（重复 seq / 孤儿 tool_result / 未知类型 / compaction 载荷） */
  structuralErrors: number;
  /**
   * 第 60 轮：**事件镜像没就绪、因此本次没检查**的会话数。
   *
   * 这个数字必须单独存在，理由见 `waitForEventMirrors` 的长注释：事件读不到时
   * `readAll` 返回空数组，若把"读不到"当成"没有缺口/没有异常"，报出来的数字
   * 就是"该会话的消息行总数"（真机实测 934 vs 749）。
   */
  unreadableSessions: number;
}> {
  const out = {
    checked: 0,
    violations: 0,
    newViolations: 0,
    samples: [] as string[],
    structuralErrors: 0,
    unreadableSessions: 0,
  };
  if (sessionIds.length === 0) return out;
  /** 本次仍然存在的缺口指纹（审计结束后写成新水位） */
  const presentKeys = new Set<string>();
  try {
    // 动态 import：`runtime-invariants` 会拉进 `event-log` + `message`（体量不小），
    // 而维护是低频路径，不值得让它进启动包的静态图。
    const { runAllInvariants } = await import("../llm/runtime-invariants");
    /**
     * ## 第 60 轮：**先等读侧镜像就绪，再判定**（本轮最重要的修复）
     *
     * 这两条判据读的分别是 `getEventLog().readAll(sid)`（事件）与
     * `MessageStorage.listMessages(sid)`（消息，最终落到 `listMessagesFromIndex`）。
     * 两者都有同一条硬路由规则：**该会话的镜像没加载完 → 返回空数组/空列表**。
     * 于是"读不到"与"没有数据"在返回值上**完全同形**。
     *
     * 真机取证（同一份数据、同一次会话、两次维护相隔 36 秒）：
     *
     * ```text
     * 第 1 次（事件镜像没加载完）：历史缺口 934 条 = 657 + 277
     * 第 2 次（镜像已加载）：      历史缺口 749 条 = 与 DB 真值逐条相等（505 + 244）
     * ```
     *
     * 934 正好等于那两个会话的**消息行总数** —— 也就是"每个会话的事件都读成空，
     * 于是每条消息都被判成『可见但没记录』"。这不是数据缺陷，是**测量缺陷**：
     * 判据把自己读不到的东西报成了缺口。
     *
     * 它还有两个连带后果（都实测过）：
     * 1. 第 47 轮追查的"水位漂移（777/757/671）"有了真正的解释 ——
     *    那不是索引裁剪或隐藏状态导致的集合摆动，而是**审计那一刻镜像加载到哪一步**；
     *    并集水位只是把这个噪声压住了，没有修掉噪声源。
     * 2. 第 60 轮新接的结构自检同样瞎：镜像没加载时它读到空事件 →
     *    报 0 处结构异常，而汇总行写的是"含事件库结构自检" —— 印出来的不是真的。
     *
     * 所以现在**先等**（这几个会话的加载本来就会被这次审计触发，等待不增加 IPC 次数），
     * 等不到就**如实计入 `unreadableSessions` 并跳过该会话**：既不冒充"检查过"，
     * 也不把"读不到"折算成缺口。
     *
     * ## 顺带说明：为什么"事件库结构自检"接在这个循环里（同一轮的接线）
     *
     * `session_events` 是**唯一没有等价物**的存储（消息有权威 JSONL、设置与归属有抢救）。
     * 它此前的自检只有"消息可见但事件没记"（`runAllInvariants`），**不查事件自身的结构**：
     * 重复 seq、`tool_result` 找不到对应的 `tool_call`、`compaction` 载荷形状不对、
     * 未知事件类型 —— 而 `validateReplay` 正好查这些，却**全仓零调用**（死代码）。
     * 接在这里的理由：同一个循环已经按会话读了事件（`runAllInvariants` 内部就读），
     * 维护又是低频路径（每天几次）；接在别处（比如每条消息）会变成"每发一条消息
     * 全量读一遍事件"，代价与收益不对称。
     *
     * 容错与上面同一条规则：单会话抛错 → 不计入 `checked` 并如实上报；
     * 结构错误**不抛**（它是"需要被看见的数据事实"，不是维护失败），聚合成一次上报。
     */
    const { getEventProjection } = await import("./event-projection");
    const ready = await waitForSessionMirrors(sessionIds);
    /**
     * 整轮共享的"重新就绪"预算（见 `recheckMirrorsReady` 的注释）：
     * 用尽之后剩下的会话一律计入 `unreadableSessions`，不再等待 ——
     * 与 `waitForSessionMirrors` 的 `budgetMs` 是同一条原则：维护不许被拖死，
     * 但也绝不把"读不到"折算成缺口。
     */
    const recheckDeadline = Date.now() + MIRROR_RECHECK_TOTAL_MS;
    const structuralErrors: string[] = [];
    for (const sid of sessionIds) {
      if (!sid) continue;
      /**
       * ## ⚠️ 本次会话读之前**必须重新确认一次**就绪，不能只用开头那张快照（第 63 轮）
       *
       * 开头那次 `waitForSessionMirrors(sessionIds)` 是**批量**等全部会话就绪的。
       * 而两侧镜像现在**都有内存预算**（`RustMessageMirror.totalBudgetRows = 20000`，
       * 第 63 轮给 `RustEventMirror` 补上了同样的一条）：批量加载途中，
       * 先加载完的会话会按 LRU 被逐出 —— 于是"开头判为就绪"的那个会话，
       * 轮到它读的时候**可能已经不在镜像里了**。那一刻 `readAll(sid)` 返回空数组，
       * 判据就会把"读不到"算成"这些消息都没有事件记录"：**正是上面用真机数据记下的那场误报**
       * （934 = 657 + 277，两次维护相隔 36 秒报出两个不同的假缺口）。
       *
       * 逐出本身**不是缺陷**（它是内存预算的正常代价，而且逐出后 `isLoaded` 明确回到 false，
       * 读语义仍是"要么完整、要么重新加载"）；**把逐出当成"没有数据"才是**。
       * 所以这里的处置与开头完全一致：重新等一次就绪（会重新分页拉全量），
       * 等不到就**如实计入 `unreadableSessions` 并跳过** —— 既不冒充"检查过"，
       * 也不把"读不到"折算成缺口。
       *
       * ⚠️ 不拿"头上就绪过"当**放行**条件（只在 `recheckMirrorsReady` 里用它决定
       * 给多长的等待窗口）：批量加载的逐出发生在同一条微任务链上，
       * "头上就绪、轮到时已被逐出"是常规形态而不是意外，
       * 拿过期快照当放行条件正是要修的那个缺陷。
       */
      if (!(await recheckMirrorsReady(sid, ready.get(sid) === true, recheckDeadline))) {
        out.unreadableSessions += 1;
        continue;
      }
      try {
        const res = runAllInvariants(sid);
        out.checked += 1;
        if (res.violations.length > 0) {
          out.violations += res.violations.length;
          for (const v of res.violations) {
            presentKeys.add(violationFingerprint(sid, v));
            if (out.samples.length < 5) out.samples.push(`${sid}/${v.type}`);
          }
        }
        try {
          const errs = getEventProjection().validateReplay(sid);
          if (errs.length > 0) {
            for (const e of errs) {
              if (structuralErrors.length < 5) structuralErrors.push(`${sid}: ${e}`);
            }
            out.structuralErrors += errs.length;
          }
        } catch (e) {
          // 结构自检本身失败不算"事件坏了"：如实记一条，继续
          reportPersistFailure(
            "maintenance.eventStructure",
            e,
            `会话 ${sid} 的事件结构自检未跑成（本次不判定该会话）`,
            {
              // 第 88 轮：没跑成就是失败，但**不是写盘失败**（原来印的是「写盘失败」）
              title: "自检：这个会话的事件结构没检查",
              consequence: "这个会话本次**没有被检查**（不计入已检查数，也不计入缺口数）——别把「没检查」当成「没问题」。",
            },
          );
        }
      } catch (e) {
        /*
         * 单会话失败**不算检查过**（`checked` 不加）：与对账段同一条规则 ——
         * 不加的话"跑了 3 个"里会混进"3 个里 1 个抛了"，而汇总行看不出区别。
         */
        reportPersistFailure("maintenance.invariantAudit", e, `会话 ${sid} 的不变量检查未跑成（未计入已检查数）`, {
          title: "自检：这个会话的不变量没检查",
          consequence: "这个会话本次**没有被检查**（未计入已检查数）——「没检查」不等于「没问题」。",
        });
      }
    }
    if (out.unreadableSessions > 0) {
      reportPersistFailure(
        "maintenance.invariantAudit",
        new Error(`会话读侧镜像未就绪 ${out.unreadableSessions} 个会话`),
        `${out.unreadableSessions} 个会话本次**没有被检查**（不计入已检查数，也不计入缺口数）。` +
          `理由：镜像没加载完时 readAll / listMessages 一律返回空 —— 把它当成"没有缺口"` +
          `会报出「该会话的消息行总数」这种假数字（真机实测：同一份数据两次维护报 934 与 749，` +
          `934 恰好等于那两个会话的消息行总数）`,
        {
          title: "自检：有会话没被检查（读侧镜像未就绪）",
          consequence: "这些会话本次没有被检查（不计入缺口数）——「读不到」不许被当成「没有缺口」。",
        },
      );
    }
    if (out.structuralErrors > 0) {
      /**
       * 第 88 轮：结构异常是**自检的发现**（自检本身跑成了），不是失败 ⇒ 走 advisory。
       *
       * 第 68 轮已经在这里踩过一次同类坑：原来借 `reportActionFailure` 时，
       * 控制台默认补的那句是「该功能本次没有生效」，恰好与事实相反
       * （真机取证：`[PersistFailure] maintenance.eventStructure 操作失败（第 1 次）：事件库结构异常 7360 处（…）—— 该功能本次没有生效。`），
       * 当时靠手工传 `title` + `consequence` 绕开。现在这一类有了正经的 kind，
       * 前缀与后缀都不会再假装失败。
       */
      reportAdvisory("maintenance.eventStructure", `事件库结构异常 ${out.structuralErrors} 处`, {
        title: "存储自检：会话事件日志存在结构异常",
        nextStep:
          "自检**本身跑成了**（这是它报出的结果，不是没运行）；这些是**存量**异常，" +
          "不会自己消失，需要人工看一眼（见样例与 docs 里的排查方法）。",
        sample:
          "事件是**唯一没有等价物**的存储（消息有权威日志、设置/归属有抢救）：" +
          `这些异常需要人工看一眼（样例：${structuralErrors.join("；")}）`,
      });
    }
  } catch (e) {
    reportPersistFailure("maintenance.invariantAudit", e, "运行时不变量审计未跑成（本次 checked=0）", {
      title: "自检：不变量审计未跑成",
      consequence: "本次 checked=0，不做任何结论（「没检查」不等于「没问题」）。",
    });
  }

  /**
   * 与水位比对。⚠️ 顺序：**先比对、后写水位**（写水位是"这次已经报过了"的确认，
   * 反过来的话本次新缺口会被自己刚写下的水印吃掉）。
   *
   * ## ⚠️ 第 47 轮真机复核发现：水位**只能并集增长，绝不能只写"本次存在的键"**
   *
   * 上面那张说明（"水位只保留本次仍然存在的指纹"）在真机上被证伪了，取证如下。
   *
   * 现场矛盾：真机上同一天的三次维护分别报 `fresh = 0`、`0`、`118`/`138` ——
   * 而"新产生"是说**事件双写又断了一条路**，不该在没有人改过数据的情况下反复报警。
   * 于是加了临时诊断（`[不变量水位诊断]`）在真机跑，一次拿到决定性数字：
   *
   * ```text
   * presentKeys=777 watermarkKeys=757 newViolations=138 notInWatermark=138 staleInWatermarkOnly=118
   * ```
   *
   * 即：**水位里缺了 138 个"本次存在"的指纹**。而水位上一轮结束时正是用它自己的
   * `presentKeys` 写的 —— 说明 **`presentKeys` 这个集合本身在两次维护之间会漂移**。
   * 当时实测到过 671 / 744 / 777 三种规模。
   *
   * ### ⚠️ 第 60 轮：**上面那个归因（索引裁剪 / 隐藏状态）已被更强的证据取代**
   *
   * 第 60 轮在同一份数据上连续抓到两次维护：**934 条**与 **749 条**（相隔 36 秒），
   * 而 934 恰好等于那两个会话的**消息行总数**（657 + 277），749 与 DB 真值逐条相等。
   * 也就是说：那次"漂移"的真正变量是**审计那一刻读侧镜像加载到哪一步** ——
   * 事件镜像没就绪时 `readAll` 返回空数组，于是该会话的每条消息都被算成缺口。
   * 索引裁剪 / 隐藏状态那条解释**没有被证据支持过**（当时只是"最像"的假设）。
   *
   * 修法在 `waitForSessionMirrors`：**先等镜像就绪再判定**；等不到就如实计
   * `unreadableSessions` 并跳过该会话（"没检查"不再冒充"没有缺口"）。
   *
   * 并集水位**照旧保留**：它是判据层的第二道防线（面对真实的集合变化仍能压住噪声），
   * 只是现在不再是唯一一道 —— 而且已知它当年压住的主要是**测量缺陷**而非数据缺陷。
   * 代价照旧：已被修复的缺口会永久留在水位里（并集不删）。
   *
   * 后果：只要有一批消息翻转，下一次维护就会把**整批历史缺口**报成"本次新产生"
   * （现场报出 138 条，样例逐条比对**全部落在修复前的历史消息区间**里）。
   * 一个会自己报警的判据比没有判据更糟 —— 它要么把人吓到不再看告警，要么让真正
   * 的新缺口淹在噪声里。
   *
   * **所以现在的判据是"并集水位"**：
   * - 写入的值 = `上次水位 ∪ 本次存在的指纹` —— **只增不减**；
   * - `newViolations` 仍然只算 `本次存在 − 上次水位`（这一点没变，也是判据的核心）；
   * - 于是翻转不会产生"新缺口"，而**真正新出现**的指纹（新会话、新消息、事件双写
   *   真的断了）依然会命中 —— 判据的能力一点没丢，丢掉的只是自己制造的噪声。
   *
   * 代价如实写明：**已被修复的缺口**会永久留在水位里（并集不删）。这是有意的取舍 ——
   * 那条路径重新断掉时会表现为"同一指纹再次进入 presentKeys 但已在水位里"，即
   * **静默**（不再报警）。两害相权取其轻：①水位只写本次存在的键 → 噪声大到判据失效；
   * ②并集水位 → 极端情况下漏报"同一条消息的事件再次丢失"（而那种情况另有
   * `appendMessageTextEvent` 的写入侧测试与 `[PersistFailure]` 通道兜着）。
   * 真正要给"重新断掉"报警，需要一个**带时间维度的判据**（比对该消息 id 的事件写入
   * 时间与其创建时间），那是另一件事，不在本轮范围。
   */
  const watermark = readInvariantWatermark();
  /**
   * 并集水位的初值 = 上次水位。
   *
   * ⚠️ 用 `Set` 而不是 `Array.includes`：比对与并集都是**逐个键**做集合运算，
   * 用数组就是 O(n²)（真机水位已 895 键，会话多起来会到万级；`includes` 在循环里
   * 会让每次维护白烧几千万次字符串比较）。集合语义也正是这里要的东西。
   */
  const nextWatermarkKeys = new Set<string>(watermark?.keys ?? []);
  const previousKeys = new Set<string>(watermark?.keys ?? []);
  if (watermark) {
    for (const key of presentKeys) {
      if (!previousKeys.has(key)) out.newViolations += 1;
    }
  }
  // 并集：无论如何都把本次存在的指纹并进去（新会话/新消息的指纹因此被记住）
  for (const key of presentKeys) nextWatermarkKeys.add(key);

  /**
   * ## 有界水位（第 47 轮补）：并集**只增不减**，所以必须有个上限
   *
   * 并集口径买来了"漂移不产生假警报"，代价是水位只增不减 —— 而它存在
   * `settings` 的一个键里（值会被整体序列化进库）。不设上限的话：
   * - 一个长期使用、消息量大的库会把它推到几十万键（**每轮维护都要写回整份**）；
   * - 真机现状 895 键 ≈ 一个会话 757 个历史缺口，可见增长是**线性于历史消息数**的。
   *
   * 上限取 20000：按"每条消息一个键、键长约 60 字符"算约 1.2 MB 的 settings 值，
   * 相对这个库能逐字保真 5 MB 工具结果的能力是很小的一笔；而 20000 条历史缺口
   * 已经远超"靠告警发现新缺陷"真正需要的量。
   *
   * 超限时**丢最旧的**（`keys` 数组的顺序是"首次被记住的先后"，见写入处的注释）：
   * 那些是库里最老的历史缺口，早就不会再变；丢掉它们最坏的效果是**下一轮把少量
   * 老缺口报一次"新产生"**（一次性噪声），而不是永久失效。
   * 丢了多少要**打出来** —— 静默丢弃会让"水位为什么不报警"变成新的谜。
   */
  const droppedForCap = Math.max(0, nextWatermarkKeys.size - MAX_INVARIANT_WATERMARK_KEYS);
  let finalWatermarkKeys = [...nextWatermarkKeys];
  if (droppedForCap > 0) {
    // Set 保持插入顺序 → 前面的就是最早被记住的
    finalWatermarkKeys = finalWatermarkKeys.slice(droppedForCap);
  }

  /**
   * 这一行是"水位为什么不报警"的**唯一现场依据**（信息级、每次维护一行）。
   * 真机复核就是靠它拿到 `presentKeys=777 watermarkKeys=757 newViolations=138`
   * 那组决定性数字的，所以刻意保留在发布版里。
   */
  console.log(
    `[不变量水位] 上次水位 ${watermark ? watermark.keys.length : 0} 键、本次存在 ${presentKeys.size} 个、` +
      `本次新产生 ${out.newViolations} 个 → 新水位 ${finalWatermarkKeys.length} 键` +
      (droppedForCap > 0 ? `（超上限 ${MAX_INVARIANT_WATERMARK_KEYS}，丢弃最旧 ${droppedForCap} 键）` : ""),
  );
  /*
   * 新水位 = **上次水位 ∪ 本次存在的指纹**（并集，只增不减 —— 见上面的长注释）。
   *
   * 水位读不到（settings 里没有 → null）时不写：**"读不到"不许被当成"空水位"**
   * （那会把下一轮的全部历史缺口判成新产生）。
   */
  if (out.checked > 0) {
    setSettingJSON(INVARIANT_WATERMARK_KEY, {
      v: 1,
      at: Date.now(),
      keys: finalWatermarkKeys,
    } satisfies InvariantWatermark);

    /*
     * 新产生的缺口才升级为**失败上报**（`console.warn` 由 `runDatabaseMaintenance`
     * 打，避免同一件事在日志里出现两遍）。上报里带指纹样例 —— 否则"新产生 3 条"
     * 对排查毫无用处（该去哪个会话看哪一条）。
     */
    if (out.newViolations > 0) {
      const fresh = [...presentKeys].filter((k) => !(watermark?.keys.includes(k) ?? false));
      /**
       * 第 88 轮：这是**自检的发现**，不是写盘失败 —— 走 advisory。
       *
       * 改前的真机取证（隔离钻取跑在装机版 1.16.134 上）：
       * ```text
       * [PersistFailure] maintenance.invariantAudit.new 写盘失败（第 1 次）：不变量审计：本次新产生 39 条缺口（…）
       *   —— 本次改动只存在于内存，重启后可能丢失。
       * ```
       * 三句话里有两句是假的：没有任何写盘动作失败了，也没有"改动只存在于内存"。
       * 这会把一个**要人看一眼的对账结论**说成"磁盘坏了"，反而让用户不当回事。
       */
      reportAdvisory(
        "maintenance.invariantAudit.new",
        `不变量审计：本次新产生 ${out.newViolations} 条缺口（历史缺口另有 ${out.violations - out.newViolations} 条）`,
        {
          title: "存储自检：本次新发现记录与界面不一致",
          nextStep:
            "自检跑成了（这是它报出的结果）；这些缺口**不影响本次使用**，但意味着事件双写可能又断了一条路，" +
            "需要看一眼样例对应的会话。",
          sample: `样例：${fresh.slice(0, 5).join("、")}${fresh.length > 5 ? ` 等 ${fresh.length} 条` : ""}`,
        },
      );
    }
  }
  return out;
}

/**
 * 不变量审计那一段（第 45 轮）：`0` 与"没跑"必须分得开。
 *
 * ## 为什么把"非 0"改称**历史缺口**，而不是"违规"（第 46 轮真机实测）
 *
 * 第一次在真机上跑出来的是 `不变量违规 777 条（检查 3 个会话）` —— 而这**不是**新缺陷：
 * `assistant_text` 事件是从第 45 轮（`appendMessageTextEvent`）才开始写的，在那之前的
 * 助手消息**从来没有过**对应事件（旧路径只在 `createMessage` 里写 `user_message`，
 * 而助手正文是流式更新，那条路没有事件写入点）。所以迁移过来的历史会话必然"消息多于文本事件"。
 *
 * 把它打成"违规"会有两个坏处：① 每次启动都报一个吓人的大数字，用户会以为数据坏了；
 * ② 真信号（**本版之后**新写的消息缺事件）会被淹没在这个常数里 —— 而这条不变量存在的意义
 * 恰恰是发现"事件双写又断了一条路"（那就应当**新增**）。
 *
 * 所以现在如实分成两句话：历史缺口（迁移前数据，**不是缺陷**）与本次新产生的缺口
 * （`auditInvariantsForSessions` 用"上次审计水位"判定），后者才进失败上报。
 *
 * ⚠️ 第 47 轮：上面那句"用水位判定"在第 46 轮只是**愿望** ——
 * `auditInvariantsForSessions` 从来没返回过 `newViolations`，于是这里 `?? 0`
 * 恒为 0、告警分支永不执行。现在水位真的落地了（见 `INVARIANT_WATERMARK_KEY`），
 * 这里也**不再**用 `?? 0` 兜底：字段是必填的，缺了就是编译错误，不许再退化成"永远报历史缺口"。
 */
function formatInvariantAudit(outcome: {
  checked: number;
  violations: number;
  newViolations: number;
  samples: string[];
  /** 第 60 轮：事件库结构异常数（必填，理由同上：缺字段就该是编译错误） */
  structuralErrors: number;
  /** 第 60 轮：读侧镜像没就绪、本次没检查的会话数（必填，同上） */
  unreadableSessions: number;
}): string {
  /**
   * 第 60 轮：结构自检的数字**必须出现在汇总行里**，否则它只活在返回值里 ——
   * 而"没被打印出来的检查"和"没跑"在真机日志上无法区分（这正是本项目反复吃过的亏：
   * 第 46 轮那次 `newViolations` 恒为 0、告警分支永不执行）。
   */
  const structural = outcome.structuralErrors > 0 ? `；事件库结构异常 **${outcome.structuralErrors} 处**（见上一条上报）` : "";
  /**
   * 第 60 轮：**"没检查"必须与"检查了、没问题"长得不一样**。
   *
   * 读侧镜像没就绪的会话会被跳过（见 `waitForSessionMirrors`）：若这里不打印，
   * 汇总行就会在"3 个会话全检查了、0 缺口"与"3 个里 2 个根本没读成"这两种情况之间
   * 长得完全一样 —— 而那正是这个模块历史上反复吃过的亏。
   */
  const unread = outcome.unreadableSessions > 0 ? `；**${outcome.unreadableSessions} 个会话的读侧镜像未就绪 → 本次未检查**` : "";
  if (outcome.checked === 0) return "不变量审计 跳过（没有可检查的会话）" + structural + unread;
  const fresh = outcome.newViolations;
  if (outcome.violations === 0) return `不变量审计 ${outcome.checked} 个会话 全部通过（含事件库结构自检）${structural}${unread}`;
  if (fresh === 0) {
    return (
      `不变量审计 ${outcome.checked} 个会话：**历史缺口 ${outcome.violations} 条**` +
      `（迁移前的助手消息本来就没有 \`assistant_text\` 事件，不是本次新产生的缺陷）` +
      (outcome.samples.length > 0 ? `；样例：${outcome.samples.join("、")}` : "") +
      structural + unread
    );
  }
  return (
    `不变量审计 **本次新产生 ${fresh} 条缺口**（历史缺口另有 ${outcome.violations - fresh} 条）` +
    `（检查 ${outcome.checked} 个会话）` +
    (outcome.samples.length > 0 ? `：${outcome.samples.join("、")}` : "") +
    structural + unread
  );
}

export async function runDatabaseMaintenance(
  opts: {
    /**
     * 事件裁剪开关（**惰性参数：签名兼容用，不是一个有效的维护开关**）。
     *
     * B-2 核实过：事件日志里含**权威日志（JSONL）里没有**的信息（`session_meta` 的
     * preset/feedback、`compaction`、`tool_call`/`tool_result` 配对、`turn_*` 的时间线），
     * 所以"按会话保留 N 条事件"这种截断会把它们删掉 —— 详见 `MaintenanceResult.prunedEvents`
     * 上的长注释。这个参数保留是为了**不让既有调用点与测试签名破**，它不产生任何行为。
     */
    keepEventsPerSession?: number;
    keepTelemetryDays?: number;
    /** 兼容旧签名（旧引擎的 VACUUM 阈值）；端口模式下无对应动作 */
    vacuumMaxBytes?: number;
    /**
     * 事件快照压缩阈值（**同为惰性参数**：见 `keepEventsPerSession` 与
     * `MaintenanceResult.prunedEvents` 的注释）。
     *
     * 不接回启动维护的理由不是"没时间接"，而是"接回会删权威数据"：
     * 快照载荷是**投影结果**（`messages`），而不是事件本身，回放等价只对投影成立。
     */
    compactEventsOver?: number;
    /** 每个会话在查询索引里至少保留多少条消息（0 = 不裁剪索引） */
    keepIndexedMessages?: number;
  } = {},
): Promise<MaintenanceResult> {
  const keepTelemetryDays = opts.keepTelemetryDays ?? 7;
  const keepIndexedMessages = opts.keepIndexedMessages ?? 500;
  /** 遥测裁剪结果（B-8：三态，不再用一个 `0` 混着"没得裁 / 失败 / 没跑"） */
  let telemetryPrune: TelemetryPruneOutcome = { status: "noop", reason: "本次维护未走到遥测裁剪" };
  /** 审计裁剪结果（第 45 轮） */
  let auditPrune: AuditPruneOutcome = { status: "noop", rows: 0, reason: "本次维护未走到审计裁剪" };
  /** 空间回收结果（第 45 轮） */
  let compact: StorageCompactOutcome = { status: "noop", reclaimedBytes: 0, reason: "本次维护未走到空间回收" };
  /** 完整性检查结果（第 45 轮） */
  let integrity: IntegrityCheckOutcome = { status: "skipped", reason: "本次维护未走到完整性检查" };

  const result: MaintenanceResult = {
    sizeBefore: 0,
    sizeAfter: 0,
    reclaimed: 0,
    /**
     * ## `prunedEvents` / `compactedSessions` **刻意恒为 0**（B-2 的结论，不是"忘了接"）
     *
     * 审阅时的原始判断：`runDatabaseMaintenance` 收下 `keepEventsPerSession` /
     * `compactEventsOver` 却从不读取，`prunedEvents` / `compactedSessions` 恒为 0
     * → "事件表只增不减，维护参数是空开关，应当把压缩接回启动维护"。
     *
     * **接回之前必须先回答"压缩会不会删权威数据"，答案是：会。**（读代码 + 真引擎取证）
     *
     * `session_events` 里有**JSONL 里没有**的信息，所以它不是"可从权威日志重建的派生数据"：
     * - `session_meta`：**第 60 轮复核后的准确说法是"今天没有任何生产读取者"** ——
     *   写它的是 `selectPresetForSession`（零调用者）与 `recordSessionFeedback`
     *   （`App.tsx:2635` 真的调）；读它的三个候选全部落空：
     *   `getSessionPreset`（`preset-discovery.ts:333`）与 `listSessionFeedback`
     *   （`feedback.ts:87`）**零生产调用者**，而 `project/files.ts` 那段
     *   "会话级指令"读的是 `readAll("")`（**空会话 id 永远读不到事件**，且
     *   `instructions_override` 从来没有写入方）→ **已在本轮删除**，见该文件里的说明。
     *   （第 45 轮已撤回一次"用不存在的消费者论证不能压缩"；第 60 轮发现换上去的
     *   那个消费者本身也是死读 —— 同一类错误犯了两遍，所以这里改成**如实说没消费者**。）
     * - `compaction` 事件（`CompactionPayload`：`removedMessageIds` / `summary`）：
     *   `event-projection` 的 `applyCompaction` 真的读它（把消息标记为被取代）；
     *   `validateReplay` 也检查它。快照载荷里只固化了
     *   `{ messages, compactionSummary, removedMessageIds }`，**没有逐条的 compaction 事件**。
     *   （第 84 波改正：原注释在这里写着 "`runtime-invariants` 也读它（`abort` / `compaction`
     *   会改变它判定的口径）" —— **实现里没有这条读**。`runtime-invariants.ts` 全文**没有**
     *   `compaction` / `abort` 字样，它只按 `user_message` / `assistant_text` /
     *   `assistant_reasoning` / `tool_call` / `tool_result` 过滤事件，机制上不会读
     *   compaction 的载荷。**但这条论据的结论仍然成立**，只是理由是**间接误报**：
     *   旧事件被快照删掉之后，仍可见的那些老消息在事件侧再没有对应事件，
     *   于是 `checkVisibleRecordedInvariant` 会把它们报成
     *   `VISIBLE_BUT_NOT_RECORDED`（`runtime-invariants.ts:129-141`）——
     *   是"事件没了导致误报"，不是"它会读 compaction"。)
     *   （原注释此处还列了 `getActiveGenerations`：它是 `event-projection.ts` 里
     *   `EventProjection.getActiveGenerations` 的定义，同样**零生产调用者** ——
     *   一并按"只列真实消费者"处理；其零调用者状态已登记在该方法注释与
     *   `docs/AUDIT-ZERO-GAP.md` 第 3 节。）
     * - `tool_call` / `tool_result` 的配对：`runtime-invariants` 的
     *   `checkToolCallPairingInvariant` 靠事件配对判断"有没有未完成的工具调用"，
     *   而快照只固化投影出的 `messages`（配对关系不是它的形状）。
     * - **时间上下文**：`time-context.ts::findLastVisibleMessageTime` 从
     *   `user_message` / `assistant_text` / `tool_result` 事件取时间戳（真的接在
     *   `agentic-loop.ts:1267` 的每轮提示词拼装上）；快照里这些事件消失后它只能
     *   回退到别的来源（信息量下降）。
     *
     * 而且压缩**本身是有损的**：快照的载荷是
     * `projectUpTo(events) → { messages }`（`event-log.ts::compactWithSnapshot`
     * 的调用方就是 `projection.projectFromEvents`），也就是"投影结果"而不是"事件"——
     * 回放等价只对**投影**成立，对 `readAll` 的消费方（上面那一串）不成立。
     *
     * 所以本批的处置与 `event-log.ts` 里的决定一致：
     * 1. **不把压缩接回启动维护**（接回 = 用"省空间"换"悄悄改数据"，代价不对称）；
     * 2. 修掉 `compactWithSnapshot` 里那个**真**会毁数据的 `cutoff_seq` 缺陷
     *    （见 `event-log.ts` 的注释与 `snapshot-compaction.test.ts` 的 SNAP-7/8）；
     * 3. 这两个计数字段**保持 0 并如实声明**"事件不压缩"——
     *    `snapshot-compaction.test.ts` 的 SNAP-5 把这条断言钉着；
     * 4. 两个参数保留（签名兼容），但它们**不是维护开关**：文档写在参数类型上。
     * 5. 事件表"只增不减"这件事若要认真解决，方向是**独立的保留策略**（按会话 TTL
     * 清 `session_events`，而不是把事件换成投影快照）—— 那需要产品决策，超出本批范围。
     */
    prunedEvents: 0,
    prunedTelemetry: 0,
    vacuumed: false,
    /** 见上面 `prunedEvents` 的长注释：事件压缩不在启动维护里做，所以恒为 0 */
    compactedSessions: 0,
    backfilledMessages: 0,
    backfillSkippedUnreadable: 0,
    rebuiltIndexMessages: 0,
    repairedBehindMessages: 0,
    skippedDeletedSessions: 0,
    rebuildWithoutProject: 0,
    trimmedIndexMessages: 0,
    warmedAttachments: 0,
    prunedAttachmentOrphans: 0,
    compactedLogSessions: 0,
    prunedAuditRows: 0,
    auditRemainingRows: -1,
    auditStatsRead: false,
    compactPerformed: false,
    compactedBytes: 0,
    integrity: "skipped",
    recountedSessions: 0,
    recountCheckedSessions: 0,
    recountFailedSessions: 0,
    invariantCheckedSessions: 0,
    invariantViolations: 0,
    invariantNewViolations: 0,
    invariantStructuralErrors: 0,
    invariantUnreadableSessions: 0,
    invariantSamples: [],
  };

  try {
    /**
     * 顺序是有语义的（第 78 波）：先把历史回填进**追加日志**（权威存储），再裁剪查询索引。
     * 反过来的话，裁剪的耐久性检查会读不到刚写的日志 —— 它宁可跳过也不会冒险删。
     *
     * 另外注意（第 80 波审计修正）：回填、附件预热、日志压缩**不能被"是否裁剪索引"这个开关挡住** ——
     * 曾经把它们一起塞进 `if (keepIndexedMessages > 0)`，于是关掉裁剪时附件不预热
     * （同步读取拿不到外置内容）、日志也不压缩。只有"裁剪索引"这一步该受开关控制。
     */
    try {
      const bridge = await import("./session-log-bridge");

      // 自愈：上次留下的标记 → 先**从权威日志重建索引**，再回填/裁剪。
      try {
        const marker = await indexRebuildNeeded();
        if (marker.needed) {
          console.log(`[Maintenance] 检测到索引重建标记（原因：${marker.reason || "未知"}）—— 从权威日志重建索引`);
          const rebuilt = await bridge.rebuildIndexFromSessionLogs();
          result.rebuiltIndexMessages = rebuilt.messages;
          result.skippedDeletedSessions = rebuilt.skippedDeleted;
          result.rebuildWithoutProject = rebuilt.withoutProject;
          await clearIndexRebuildMarker();
        }
      } catch (e) {
        console.warn("[Maintenance] 索引重建失败（保留标记，下次再试）:", e);
      }

      /**
       * ## 第 52 轮：**"索引落后于权威日志"必须有主动判据**（不再只等标记）
       *
       * 这套架构的约定是"JSONL 是权威副本、SQLite 索引可重建"，而**修复的触发器**
       * 此前只有两个：完整性检查失败、引擎恢复时写的标记。于是出现了一个静默缺口：
       * **索引真的少了行、但库没坏、也没人写标记** → 什么都不会发生。
       *
       * 真机实证（第 52 轮钻取）：一个会话的权威日志有 **657** 个唯一 id，
       * 而索引里只有 **545** 行 —— 差 **112 行**，且没有任何信号。跑一次"从日志重建"
       * 之后索引变成 657（与日志逐条一致），说明这 112 行确实是索引丢了、不是日志多了。
       *
       * ### 为什么"索引行数 < 日志唯一 id 数"只能是丢行，不是设计使然
       *
       * - **裁剪**（`trimIndexedMessages`）走的是**软删除 + 裁剪标记**，行**留在库里**
       *   （否则 `message_feedback` 的外键目标会消失），所以 `messages.count.total` **不会**因此变小；
       * - 正常方向的落后是"索引**多**、日志少"（老会话的日志还没回填），那个方向**不告警**；
       * - 反向（日志多、索引少）只可能来自"索引写入丢了/被外力删了"。
       *
       * ### 做法
       *
       * 只对**日志已 hydrate** 的会话比较（没 hydrate 就没有可信的日志集合，比了是瞎猜）；
       * 发现落后就**当场按会话重建**（`rebuildIndexFromSessionLogs(sessionId)`，
       * 第 52 轮的钻取已经端到端验证过它幂等、且**只 upsert 不删行**），
       * 并如实上报 —— 这是一次"发现并修复了静默丢行"，用户与排查者都该看到。
       */
      try {
        const behind = await detectSessionsBehindLog();
        if (behind.length > 0) {
          const detail = behind
            .map((b) => `${b.sessionId}(索引 ${b.indexRows} < 日志 ${b.logIds})`)
            .join("、");
          console.warn(`[Maintenance] 检测到索引落后于权威日志：${detail} —— 逐会话重建`);
          let repaired = 0;
          for (const b of behind) {
            try {
              const r = await bridge.rebuildIndexFromSessionLogs(b.sessionId);
              repaired += r.messages;
            } catch (e) {
              console.warn(`[Maintenance] 会话 ${b.sessionId} 的重建失败（下次维护再试）:`, e);
            }
          }
          result.repairedBehindMessages = repaired;
          /**
           * 第 88 轮：改用 `reportAdvisory`（**发现并已修好**，不是失败）。
           *
           * 原来借 `reportActionFailure` + 手工 `title`/`consequence` 把两句都盖掉 ——
           * 界面上勉强说对了，但**控制台那一行仍然是** `[PersistFailure] … 操作失败（第 1 次）`
           * （横幅能靠 title 救，日志的前缀救不了）。现在这一类有了正经的 kind。
           */
          reportAdvisory("maintenance.indexBehindLog", detail, {
            title: "存储自检：索引落后于权威日志，已自动补回",
            nextStep: `已逐会话从权威日志重建索引（补回 ${repaired} 行）；消息正文从未受影响。`,
            sample: "已按权威日志补回索引行（不影响消息本身）",
          });
        }
      } catch (e) {
        console.warn("[Maintenance] 索引与日志的对账未完成（不影响使用）:", e);
      }

      /**
       * 第 62 轮：回填的返回值从"一个数"变成"**两件事**"（回填了多少 / 因镜像没就绪而没跑几个会话）。
       * 理由与索引裁剪的 `skippedNotLoaded` 完全同一条：把"没跑"混进"0 条"，
       * 日志上就分不出"确实没有可回填的"与"整条步骤静默没做"。
       */
      const backfill = await bridge.backfillAllSessions();
      result.backfilledMessages = backfill.backfilled;
      result.backfillSkippedUnreadable = backfill.skippedUnreadable;

      if (keepIndexedMessages > 0) {
        const trimmed = await bridge.trimIndexedMessages({ keepPerSession: keepIndexedMessages });
        result.trimmedIndexMessages = trimmed.deletedMessages;
        /**
         * 跳过原因必须**分开报**（第 44 轮修掉的误导性日志）。
         *
         * 原来这里把三种完全不同的原因一律印成"日志尚未覆盖"：
         * ① 镜像没就绪（真端口是异步的，曾因此让**整条裁剪步骤在真机上从未执行**）；
         * ② 日志确实还没覆盖这些消息（耐久性不变量：正常跳过）；
         * ③ 有候选但一条都裁不了（带附件 / 日志缺该 id）。
         *
         * 三者的处置完全不同：①是缺陷、②是正常、③要看是不是附件太多。
         * 真机上真实原因是①，而日志说成②——排查方向就是这样被带偏的。
         */
        if (trimmed.deletedMessages > 0 || trimmed.skippedSessions > 0) {
          const reasons: string[] = [];
          if (trimmed.skippedNotLoaded > 0) reasons.push(`镜像未就绪 ${trimmed.skippedNotLoaded} 个`);
          if (trimmed.skippedTruncated > 0) reasons.push(`镜像被截断 ${trimmed.skippedTruncated} 个`);
          if (trimmed.skippedNoLog > 0) reasons.push(`日志尚未覆盖 ${trimmed.skippedNoLog} 个`);
          if (trimmed.skippedNoCandidates > 0) reasons.push(`无可裁候选 ${trimmed.skippedNoCandidates} 个`);
          console.log(
            `[Maintenance] 追加日志：索引裁剪 ${trimmed.deletedMessages} 条` +
              (reasons.length > 0 ? `（跳过 ${trimmed.skippedSessions} 个会话：${reasons.join("、")}）` : ""),
          );
        }
      }
      if (result.backfilledMessages > 0 || result.backfillSkippedUnreadable > 0) {
        console.log(
          `[Maintenance] 追加日志：回填 ${result.backfilledMessages} 条历史` +
            (result.backfillSkippedUnreadable > 0
              ? `（**${result.backfillSkippedUnreadable} 个会话的消息镜像未就绪 → 本次未回填**）`
              : ""),
        );
      }

      /**
       * 第 62 轮：**凭据普查**（见 docs/CREDENTIALS-PLAN.md 阶段 0-c）。
       *
       * 密钥本来就该在 settings 里（明文落盘是既有设计），问题是用户不知道有它。
       * 只报**键名 + 命中数量，从不打印值**；命中就经既有上报通道让用户看见。
       *
       * ⚠️ 两个坑都踩过并在此写死（1.16.100 真机抓到）：
       * ① 不能用 `domainReadMany("settings")` —— 维护跑到这里时**该域镜像还没就绪**，
       *    会拿到空数组（真机日志：`凭据普查：0 个设置项，未命中`，而 key 明明在库里）；
       *    改用引擎命令 `settings.get_all`（bootstrap 预热用的就是它，不经镜像、不必等就绪）。
       * ② `scanned === 0` 必须说成「**没跑成**」而不是「未命中」—— 否则'读不到'又变成'一切正常'。
       */
      try {
        const { censusCredentialSettings } = await import("./credential-census");
        const { getStoragePort } = await import("./port");
        const probe = getStoragePort() as unknown as {
          data?: {
            command?: <T>(c: string, p?: Record<string, unknown>) => Promise<T>;
            execute?: (c: string, p?: Record<string, unknown>) => Promise<unknown>;
          };
        } | null;
        const all = probe?.data?.command
          ? await probe.data.command<Record<string, string | null>>("settings.get_all", {})
          : ((await probe?.data?.execute?.("settings.get_all", {})) as Record<string, string | null> | undefined);
        const rows = Object.entries(all ?? {}).map(([key, value]) => ({
          key,
          value: typeof value === "string" ? value : "",
        }));
        const census = censusCredentialSettings(rows);
        /** 已加密的那些单独说一句（**不许**混进"明文凭据"的告警里 —— 那是假话） */
        const sealedNote =
          census.sealedTotal > 0
            ? `；另有 ${census.sealedTotal} 处**已加密保存**（${census.sealedKeys.join("、")}，不是明文）`
            : "";
        if (census.scanned === 0) {
          console.warn("[Maintenance] 凭据普查**未跑成**（一条设置都没读到）—— 不判定为'未命中'");
        } else if (census.total > 0) {
          const keys = census.hits.map((h) => `${h.key}(${h.kind}×${h.count})`).join("、");
          console.log(
            `[Maintenance] 凭据普查：${census.scanned} 个设置项里**明文**命中 ${census.total} 处（${keys}）${sealedNote}` +
              "—— 只报位置与数量，不打印值",
          );
          reportAdvisory("maintenance.credentialCensus", `设置里存在疑似凭据 ${census.total} 处`, {
            /**
             * 第 88 轮改（**印出来的必须是真的**）：
             * ① 标题原来是「设置里存在**明文**凭据」，但判据只能证明"键名像凭据 + 值不是本产品的封存格式"
             *    —— 那可能是明文，也可能是**别的形式/别的机器写的密文**（隔离钻取里就出现了后者）。
             *    所以标题如实改成「疑似」；正文再说清它为什么值得看一眼。
             * ② 走 advisory（原来借 `reportActionFailure`）：它的后缀是「该功能本次不可用，请重试或检查日志」
             *    —— 而普查**刚刚跑成功了**，"请重试"更是假建议（再跑一次还是同样的发现）。
             */
            title: "安全提示：发现疑似明文凭据",
            nextStep:
              "这些是**明文存放的密钥/令牌**（本机存储的既有设计）。" +
              "若该机器或其备份可能外流，建议轮换；值从不打印。",
            sample: `位置：${keys}（值从不打印）${sealedNote}`,
          });
        } else {
          console.log(
            `[Maintenance] 凭据普查：${census.scanned} 个设置项，未命中**明文**凭据形状${sealedNote}`,
          );
        }
      } catch (e) {
        console.warn("[Maintenance] 凭据普查跳过:", e);
      }
      const attachments = await bridge.hydrateAllAttachments();
      result.warmedAttachments = attachments.warmed;
      result.prunedAttachmentOrphans = attachments.orphansRemoved;
      if (attachments.warmed > 0 || attachments.orphansRemoved > 0) {
        console.log(
          `[Maintenance] 外置附件：预热 ${attachments.warmed} 个，清理孤儿文件 ${attachments.orphansRemoved} 个`,
        );
      }

      const compactedLog = await bridge.compactOversizedSessionLogs();
      result.compactedLogSessions = compactedLog.compactedSessions;
      if (compactedLog.compactedSessions > 0) {
        console.log(
          `[Maintenance] 追加日志压缩：${compactedLog.compactedSessions} 个会话，省下 ${compactedLog.linesSaved} 行`,
        );
      }
    } catch (e) {
      console.warn("[Maintenance] 追加日志/附件维护失败（跳过）:", e);
    }

    // 遥测按天裁剪（引擎命令，显式水位线）
    const cutoff = Date.now() - keepTelemetryDays * 24 * 60 * 60 * 1000;
    telemetryPrune = await pruneTelemetryViaPort(cutoff);
    result.prunedTelemetry = telemetryPrune.status === "pruned" ? telemetryPrune.rows : 0;

    /**
     * ## 审计裁剪（`audit.prune`，第 45 轮接线）
     *
     * `storage_audit` 原来**无界增长**（真机 11.8 小时 61,416 行、库内最大的表、
     * 占活数据 35.6%），而引擎侧的 `audit.prune` 一直是零调用的死能力。
     * 放在**数据裁剪之后**：这条顺序让"本次维护删掉的东西"在审计里留到**下一次**维护才被裁，
     * 也就是说刚发生的大删除仍然查得到（排查窗口不会被自己的裁剪吃掉）。
     */
    auditPrune = await pruneAuditViaPort(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    result.prunedAuditRows = auditPrune.rows;
    if (typeof auditPrune.remaining === "number") result.auditRemainingRows = auditPrune.remaining;
    // 规模单独读一次（`prune` 失败时什么都没有，而"审计表现在多大"是独立事实）
    const auditStats = await auditStatsViaPort();
    result.auditStatsRead = auditStats.read;
    if (auditStats.read && typeof auditStats.count === "number") {
      // prune 的 remaining 更"同事务"，但 stats 是权威现状：以它为最终数字
      result.auditRemainingRows = auditStats.count;
    }

    /**
     * ## 空间回收（`storage.compact`，第 45 轮接线）
     *
     * 放在**所有删除动作之后**：空闲页是那些删除制造出来的，先删再收才收得动。
     * 用引擎默认阈值（8 MiB 且 25%），**不传 `force`** —— 见 `compactStorageViaPort` 的注释。
     */
    const compactResult = await compactStorageViaPort();
    compact = compactResult;
    result.compactPerformed = compactResult.status === "compacted";
    result.compactedBytes = compactResult.reclaimedBytes;

    /**
     * ## 完整性检查（`integrity_check`，第 45 轮接线，**异步 + 节流**）
     *
     * 放在**最后**：它是只读的（`PRAGMA quick_check`），失败时的动作是写重建标记，
     * 而那件事应当发生在"本次维护的数据动作都做完之后"。
     * 节流按库大小分档（小/中库 1 小时、大库 12 小时），实测成本 32–325 ms
     * —— 具体数字与"维护是后台任务"这两个更正见上面窗口常量的注释。
     */
    const integrityResult = await verifyIntegrityThrottled();
    integrity = integrityResult;
    result.integrity = integrityResult.status;
    if (integrityResult.status === "failed") {
      console.warn(
        `[Maintenance] 完整性检查失败：${integrityResult.detail ?? "（无细节）"} —— 已留索引重建标记`,
      );
    }

    /*
     * ## 会话计数对账（第 44 轮）
     *
     * `sessions.message_count` 长期漂移：真机实测同一个会话有**三个互相矛盾的数** ——
     * 权威 JSONL 612 条 / 索引 544 行 / 这一列写着 **27**。
     * 原因是"多个写入者有空才更新"：渲染侧只在极少数地方显式写它。
     *
     * 引擎侧已经改成**唯一写入者**（新增 +1、硬删除按实际行数减），但那只能管住**以后**；
     * 已经写坏的值得有人修一次。这里就是对账那一次：拿引擎的 `messages.count`
     * （**索引真值**，与引擎维护的是同一个真相）与这一列比，不一致才写回。
     *
     * 为什么用索引真值而不是日志条数：两个真相会立刻再次漂移。
     * 日志里可能有索引没有的历史（旧版硬删除裁剪留下的），那种差异会随着
     * "裁剪改为软删除 + `trimmed` 标记"而不再产生；把它当成计数只会制造第二个真相。
     */
    result.recountedSessions = 0;
    try {
      const { domainReadMany } = await import("./domain-store");
      const sessions = domainReadMany<Record<string, unknown>>("sessions", (r) => r) ?? [];
      const { hasStoragePort, getStoragePort } = await import("./port");
      if (!hasStoragePort() || sessions.length === 0) {
        // 端口没有 / 镜像未就绪：**什么都不做**（不做成"当成 0 写回去"）
      } else {
        const port = getStoragePort() as unknown as {
          data: { command?: <R>(cmd: string, params?: Record<string, unknown>) => Promise<R> };
        };
        /*
         * ⚠️ 两条"部分完成"必须可见（第 44 轮，对抗性审计指出的漏洞）：
         *
         * ① 端口**没有 `command` 能力**时（`structuredCommand` 会抛），原来这个 throw
         *    发生在循环体内部、被外层整体 catch 接住 → 一行 `console.warn` 收尾，
         *    而汇总行里的 `recountedSessions` 看着像"跑过了、没发现不一致"。
         *    现在先探测一次能力：没有就**明确标记本次没跑**（`checked = 0`）。
         * ② 单个会话失败（IPC 抖动）原来会**中断整轮**，其余会话不再对账 ——
         *    而 `recountedSessions = 3` 无法区分"只跑了 3 个"与"3 个不一致、其余都对"。
         *    现在逐会话容错，并把"实际检查了几个 / 几个失败"报出来。
         */
        if (typeof port.data.command !== "function") {
          console.warn(
            "[Maintenance] 会话计数对账：端口没有 command 能力，**本次一个会话都没对账**（不是“都对上了”）",
          );
        } else {
          for (const row of sessions) {
            const id = String(row.id ?? "");
            if (!id) continue;
            const stored = Number(row.message_count ?? 0);
            /*
             * ⚠️ 必须走 `command`（结构化结果），**不能**走 `data.query`。
             *
             * 这是我在真机上踩到的：`RustDataPort.query` 的实现是"把 `items`/`item` 整形，
             * 其余原样塞进 `items: [raw]`" —— 也就是说它**不返回 `total`**。
             * 于是 `query("messages.count").total` 恒为 `undefined` → `?? 0` → **把 0 写了回去**：
             * 真机上把两个会话的 8 / 27 改成了 **0 / 0**（原本只是陈旧，被我改成了更错的）。
             * `command` 拿的是引擎的原始返回（`{count,total,visible,hidden}`），才是这条命令的契约。
             */
            let total = NaN;
            try {
              const counted = await structuredCommand<{ total?: number; count?: number }>(port, "messages.count", {
                session_id: id,
              });
              total = Number(counted?.total ?? counted?.count ?? NaN);
            } catch (e) {
              // 单个会话失败不该中断整轮：记下来，继续对账其余会话
              result.recountFailedSessions += 1;
              console.warn(`[Maintenance] 会话计数对账：会话 ${id} 读取失败（跳过，其余继续）:`, e);
              continue;
            }
            result.recountCheckedSessions += 1;
            // 读不到就**跳过**（不要猜、更不要写 0）
            if (!Number.isFinite(total) || total === stored) continue;
            SessionStorage.updateSession(id, { messageCount: total });
            result.recountedSessions += 1;
          }
        }
      }
      if (result.recountedSessions > 0 || result.recountFailedSessions > 0) {
        console.log(
          `[Maintenance] 会话计数对账：检查 ${result.recountCheckedSessions} 个、修正 ${result.recountedSessions} 个` +
            (result.recountFailedSessions > 0 ? `、读取失败 ${result.recountFailedSessions} 个` : ""),
        );
      }
    } catch (e) {
      console.warn("[Maintenance] 会话计数对账失败（跳过）:", e);
    }

    /**
     * ## 运行时不变量审计（第 45 轮功能上下文审计 §"未做" 的收口）
     *
     * 见 `auditInvariantsForSessions` 的长注释：`runtime-invariants` 原来只在
     * `NODE_ENV === "development"` 下跑（`agentic-loop.ts:831`），**生产无人断言** ——
     * 而那条不变量（模型可见即已记录）正是 P0-D0（主聊天事件整体不写）的唯一自动判据。
     * 这里把它接到**每次维护**（启动时必跑）上：缺陷是持久状态，不是瞬时状态，
     * 所以"每天检查几次"足够；关键是**它真的会跑，而且跑没跑、违规几条都进汇总行**。
     *
     * ⚠️ 放在对账之后：对账段读的就是同一份 `sessions` 镜像，
     * 两会话集合不一致（一个读镜像、一个读列表）会让"检查了几个会话"这个数自相矛盾。
     */
    result.invariantCheckedSessions = 0;
    result.invariantViolations = 0;
    result.invariantNewViolations = 0;
    result.invariantSamples = [];
    result.invariantStructuralErrors = 0;
    result.invariantUnreadableSessions = 0;
    try {
      const { domainReadMany } = await import("./domain-store");
      const rows = domainReadMany<Record<string, unknown>>("sessions", (r) => r) ?? [];
      const ids = rows.map((r) => String(r.id ?? "")).filter((id) => id.length > 0);
      const audit = await auditInvariantsForSessions(ids);
      result.invariantCheckedSessions = audit.checked;
      result.invariantViolations = audit.violations;
      result.invariantNewViolations = audit.newViolations;
      result.invariantSamples = audit.samples;
      result.invariantStructuralErrors = audit.structuralErrors;
      result.invariantUnreadableSessions = audit.unreadableSessions;
      if (audit.violations > 0) {
        /*
         * ⚠️ **不要**把这里写成"违规"（第 46 轮真机实测的假警报）。
         *
         * `assistant_text` 事件从第 45 轮才开始写，在那之前的助手消息**从来没有过**对应事件，
         * 所以迁移过来的历史会话必然"消息多于文本事件" —— 真机上这个数字是 **777**，
         * 每次启动都打印一次，用户会以为数据坏了；更糟的是真正的信号（**本版之后**新写出的
         * 消息缺事件）会被这个常数淹没。所以：默认按**历史缺口**打印（信息级），
         * 只有"本次新产生"的那部分（`newViolations`，由上次审计水位判定 —— 第 47 轮真的落地了）
         * 才升级为告警。
         */
        const fresh = audit.newViolations;
        const detail =
          `（检查 ${audit.checked} 个会话，样例：${audit.samples.join("、") || "无"}）` +
          `。若某个会话是**本版之后**新建的却出现在这里，那才是新缺陷`;
        if (fresh > 0) {
          console.warn(
            `[Maintenance] 不变量**本次新产生** ${fresh} 条缺口（历史缺口另有 ${audit.violations - fresh} 条）${detail}`,
          );
        } else {
          console.log(
            `[Maintenance] 不变量审计：历史缺口 ${audit.violations} 条（均在上次审计水位之内 —— ` +
              `迁移前的助手消息本来就没有 \`assistant_text\` 事件，不是本次新产生的缺陷）${detail}`,
          );
        }
      }
    } catch (e) {
      console.warn("[Maintenance] 不变量审计失败（跳过）:", e);
    }
  } catch (e) {
    console.warn("[Maintenance] 维护失败（不影响使用）:", e);
  }

  /**
   * 每次维护结束都留一行带数字的日志。
   *
   * ⚠️ 这不是"日志洁癖"：这个功能曾经在真机上**整段没跑**却没人发现，
   * 因为"没跑"与"跑了但没事做"在日志里完全一样（当时 rust 模式连这行都不打印）。
   * 可观测性的最低要求就是——**做了什么都得看得见**。
   *
   * 第 45 轮把三段"引擎有能力、渲染侧没人用"的能力接上来时，这条要求就是接线本身的一部分：
   * 审计裁剪要报"裁了多少 / **还剩多少**"（只看裁掉多少看不出这张表是不是还在涨）；
   * 空间回收要报 `performed` 与回收字节（**"跑了但没做（未达阈值）"与"跑了并回收了 N 字节"
   * 必须分得开**）；完整性检查要报"检查了 / 节流跳过 / 失败"。
   */
  console.log(
    `[Maintenance] 维护完成：索引重建 ${result.rebuiltIndexMessages} 条` +
      // B-1：跳过数紧跟在重建数后面 —— 它是"用户删掉的会话有没有被复活"的唯一信号
      (result.skippedDeletedSessions > 0 ? `（跳过 ${result.skippedDeletedSessions} 个已删除会话）` : "") +
      // 第 45 轮：取不到项目归属的会话数是"复活的会话会不会掉进全局项目"的信号
      (result.rebuildWithoutProject > 0
        ? `（其中 ${result.rebuildWithoutProject} 个没取到项目归属 → 落到全局项目）`
        : "") +
      `、日志回填 ${result.backfilledMessages} 条` +
      (result.backfillSkippedUnreadable > 0
        ? `（${result.backfillSkippedUnreadable} 个会话镜像未就绪未回填）`
        : "") +
      `、` +
      `索引裁剪 ${result.trimmedIndexMessages} 条、附件预热 ${result.warmedAttachments} 个、孤儿清理 ${result.prunedAttachmentOrphans} 个、` +
      `日志压缩 ${result.compactedLogSessions} 个会话、${formatTelemetryPrune(telemetryPrune)}、` +
      formatAuditPrune(auditPrune, result) +
      `、${formatCompact(compact)}、${formatIntegrity(integrity)}、` +
      // 第 45 轮：这条不变量原来在生产上**无人断言**，现在它每次维护都会在这里报一次
      formatInvariantAudit({
        checked: result.invariantCheckedSessions,
        violations: result.invariantViolations,
        newViolations: result.invariantNewViolations,
        samples: result.invariantSamples,
        // 第 60 轮：结构自检的数字也进汇总行（否则它只活在返回值里，日志上"没跑"与"跑了没问题"分不开）
        structuralErrors: result.invariantStructuralErrors,
        // 第 60 轮：同理 —— "镜像没就绪所以没检查"必须与"检查了没问题"分得开
        unreadableSessions: result.invariantUnreadableSessions,
      }),
  );
  return result;
}

/** 兼容旧调用点：维护失败时也走统一上报通道（保留导出，供未来需要时使用） */
export { reportPersistFailure as __reportMaintenanceFailure };
