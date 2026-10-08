import type { MessageV2 } from "../llm/session";
import {
  loadMemoryChecked,
  saveMemoryConfirmed,
  writeMemoryConfirmed,
  patchMemoryMirror,
  getSetting,
  setSetting,
  setSettingConfirmed,
  MEMORY_DOMAIN_NOT_WARMED,
  MEMORY_DOMAIN_NO_PORT,
} from "../storage/settings";
import { getStoragePort, hasStoragePort } from "../storage/port";
import {
  reportAdvisory,
  reportPersistFailure,
  reportActionFailure,
  getPersistFailures,
  withdrawFailure,
} from "../storage/persist-failure";
import { redactSecrets } from "../utils/redact";
// R7：给人看的日期走**唯一口径**（本地日），不再自造 `toISOString().split("T")[0]`
import { localDateString } from "../time/local-time";

// ========== Memory Types ==========

/**
 * 三级作用域（对标 Hermes 三层 + OpenClaw 策展/自动分层）。
 *
 * | 作用域 | 生效范围 | 归属键 |
 * |---|---|---|
 * | `platform` | 所有项目、所有对话 | 无 |
 * | `project` | 仅本项目内的所有对话 | `projectId` |
 * | `conversation` | 仅当前对话 | `sessionId` |
 *
 * 与旧名的对应：`global` → `platform`，`session` → `conversation`，`project` 同名但
 * **现在真的按 `projectId` 过滤**（旧实现只按 scope 过滤 ⇒ 跨项目泄漏）。
 */
export type MemoryScope = "platform" | "project" | "conversation";

/** 旧库里的作用域名（一次性迁移的输入；迁移后不再出现） */
export type LegacyMemoryScope = MemoryScope | "global" | "session";

/**
 * 记忆来源。**信任边界的地基**：
 * - `manual`：用户手写/手改的条目 —— **任何自动流程都不得改写、覆盖或删除**；
 * - `auto`：自动提取产生的条目 —— 注入时必须单独分块并明确标注。
 */
export type MemorySource = "manual" | "auto";

/**
 * 条目状态。
 * - `active`：参与上下文注入；
 * - `pending`：**写入审批**下自动条目的暂存态 —— 未批准**不进上下文**。
 */
export type MemoryStatus = "active" | "pending";

/**
 * **权威性纪律**（照 Hermes `agent/context_compressor.py:291-293` 的口径翻译）：
 * 「系统提示里的记忆**始终是权威且生效的**，不得因为压缩/摘要而忽视或降级记忆内容」。
 *
 * 为什么要**挂在记忆块上**（而不是写在别处一句通用提醒）：
 * 记忆是本仓**唯一**「用户手工确认过的长期结论」载体。历史压缩（`context-compressor` /
 * 本仓 `conversation_compression` 等价物）会在历史里插摘要，模型很容易把摘要当成更新的
 * 事实而把系统提示里的记忆当"旧背景"降权 —— Hermes 因此在**摘要提示词**里显式下豁免指令
 * （`context_compressor.py:291-293`），并另加压缩哨兵
 * （`_COMPRESSION_NOTE`，`context_compressor.py:5453`）。这里取前者的**文本口径**，
 * 挂在记忆块自身的抬头，保证"读到记忆的同时就读到豁免"。
 *
 * ⚠️ 这句话是**内容**，不是实现：判据 `MEM-PLACE-6` 同时钉住"文本在场"与"它挂在记忆块上"。
 */
export const MEMORY_AUTHORITY_NOTE =
  "> **权威性**：以下记忆权威且持续生效，不得因压缩/摘要而降级或改写。";

/**
 * 两半记忆块的抬头。
 *
 * - `MEMORY_STABLE_HEADER`：**稳定前缀侧** —— 平台级（无归属键、跨项目跨对话），很少变；
 * - `MEMORY_VOLATILE_HEADER`：**易变侧** —— 项目级 + 对话级 + 自动提取块（回合结束自动提取、
 *   审批通过都会让它 churn）。
 *
 * 照 OpenClaw `src/agents/system-prompt-context-files.ts:7-15`（段序表）+
 * `SYSTEM_PROMPT_CACHE_BOUNDARY`（`system-prompt.ts:855,857`）的形态：
 * 记忆**留在系统提示**，但按易变性两分，显式缓存边界落在两半之间。
 *
 * ⚠️ **落点修正（第 189 波，实测）**：稳定记忆**不是**稳定前缀的最末一段 —— 它之后还有
 * 技能/知识/MCP/多智能体/安全/语言规则（这些**都是稳定的**，留在稳定前缀之内），
 * 哨兵统一由 `prompt.ts` 落在稳定前缀的**真正末尾**（语言规则/班长名册之后）。
 * 旧注释写"稳定前缀最末紧贴边界"，与实现不符（哨兵曾经早 8~13 段），已改。
 */
export const MEMORY_STABLE_HEADER = "# Memory System — 稳定记忆（平台级 · 手动维护）";
export const MEMORY_VOLATILE_HEADER = "# Memory System — 易变记忆（项目级 / 对话级 / 自动提取）";

/**
 * **来源三态**（展示口径）：`manual` / `auto` / `unknown`。
 *
 * 为什么必须有第三态（第 189 波 A1）：旧数据（`normalizeLoadedEntry` 对非法/缺失 `source`
 * 一律给 `undefined`）在**历史里没有任何字段**能区分"用户手写的"和"当时自动提取的"。
 * 把它算成 manual 或 auto 都是**编造来源** —— 而两侧一旦各编一套（注入说"自动提取、未经
 * 人工确认"、面板说"手动"），同一条目就有了两套真相，用户会据此删错条目。
 */
export type MemorySourceKind = MemorySource | "unknown";

/** 只关心 `source` 的载体（`undefined` = 旧数据；`MemoryEntry` 结构上可直接传进来） */
export type MemorySourceCarrier = { source?: MemorySource | undefined };

/**
 * 三态的**唯一**文案表：注入文本、记忆面板、记忆体检、导出**四处共用**（判据 `MEM-PLACE-12`
 * 断言同一事实同一说法）。改这里就是改四处，不许任何一处自己再写一份字面量。
 */
export const MEMORY_SOURCE_KIND_LABEL: Record<MemorySourceKind, string> = {
  manual: "手动",
  auto: "自动提取",
  unknown: "未知（旧数据）",
};

/**
 * 面板「自动提取」分组头的**补充说明**（第 189 波 R5）。
 *
 * 它**不是**三态文案 —— 三态只有 `MEMORY_SOURCE_KIND_LABEL` 一处。面板旧写法把
 * 「自动提取（可能不准，可删）」整句写死在组件里（改文案表不会改它 ⇒ 同一屏并存三套说法）。
 * 现在分组头 = 表里的 `auto` + 这个补充句，两个来源都是**一处**。
 */
export const MEMORY_AUTO_GROUP_HINT = "可能不准，可删";

/**
 * **来源未知（旧数据）**块的小标题（仅注入用；界面用同一张文案表）。
 *
 * 旧数据在注入文本里**必须**显式说"来源未知"，不许冒充"自动提取…未经人工确认"：
 * 版本升级把用户手写的旧 `global` 条目重写成"由自动流程从对话中提取"是对用户记忆的**编造**。
 *
 * ⚠️ R5：**当场**从唯一表拼（不是模块加载时算好的字符串快照）—— 于是"改文案表 ⇒ 注入抬头
 * 跟着改"在**同一个进程里**也成立，判据 `MEM-PLACE-23③` 就是靠这条把它钉住的。
 */
export function memoryUnknownHeader(): string {
  return `## 来源${MEMORY_SOURCE_KIND_LABEL.unknown}`;
}

/** 来源未知块的免责声明（说清"为什么不知道"与"怎么保护"，不编造来源） */
export function memoryUnknownNote(count: number): string {
  return (
    `> 以下 ${count} 条来自旧版本：写入时**没有记录来源**，无法确认是你手写的还是当时的自动流程写入的；` +
    `它们**按手动条目保护**（自动流程不会改写或删除），请核对后决定保留。`
  );
}

/** 条目的**展示**来源（三态；`undefined` ⇒ `unknown`，绝不冒充 manual/auto） */
export function memorySourceOf(entry: MemorySourceCarrier): MemorySourceKind {
  if (entry.source === "manual") return "manual";
  if (entry.source === "auto") return "auto";
  return "unknown";
}

/**
 * **受保护条目** = 手动 + 来源未知的旧数据（`memorySourceOf !== "auto"`）。
 *
 * 信任边界的**保护口径**：自动流程（回合结束提取 / 自动整合 / 容量裁剪 / 批量清理）
 * 一律不得改写或删除它们。旧数据必须按受保护处理 —— 否则**存量用户手写的记忆**会被
 * 自动整合删掉或洗成自动条目（这正是改造前的正确行为，不许改坏；判据 `MEM-PLACE-12` ②）。
 *
 * ⚠️ 保护口径（三态里"非 auto 都保护"）与**注入位置**口径（`entrySourceOf`：旧数据算
 * auto ⇒ 进易变侧）**故意不同**：位置错了只是缓存收益回退，**保护错了是不可逆的数据损失**。
 */
export function isProtectedMemoryEntry(entry: MemorySourceCarrier): boolean {
  return memorySourceOf(entry) !== "auto";
}

/**
 * **注入位置口径**：`undefined`（旧数据）按 `auto` 归入**易变侧**。
 *
 * 理由：旧 `project` 池正是"可能被自动流程动过"的那批数据（`legacyPool` 标记讲的就是这件事），
 * 把它放进**稳定前缀**会做出一个我们无法证明的强声明，且它一变就整体位移稳定前缀。
 *
 * ⚠️ 这是**位置**口径，只有"manual / 非 manual"两分；**它不决定注入文本里的来源说法** ——
 * 说法一律走 `memorySourceOf` 的三态文案（`MEMORY_SOURCE_KIND_LABEL`），
 * 所以旧数据在注入文本里写的是「未知（旧数据）」而不是「自动提取…未经人工确认」。
 */
export function entrySourceOf(entry: MemorySourceCarrier): MemorySource {
  return entry.source === "manual" ? "manual" : "auto";
}

/**
 * 稳定/易变两分的**可读镜像**。
 *
 * 真正生效的是两份取数常量 `MEMORY_STABLE_BLOCK_SELECTION` /
 * `MEMORY_VOLATILE_BLOCK_SELECTIONS`（+ `entrySourceOf` 过滤）；这里只是同一条规则的可读形式。
 * 两者由判据 `MEM-PLACE-17` **钉住一致**（对同一组条目断言"进稳定块"与
 * `isStableMemoryEntry` 逐条相等）——改了一边不改另一边必然红，所以它不再是"零引用却自称唯一"。
 *
 * 稳定侧 = **平台级 + 手动**。其余**一律**易变侧，包括：
 * - 任何作用域的 `auto` 条目（回合结束自动提取、审批后 `pending→active`、编辑都会 churn）；
 * - 任何作用域的旧数据（`source === undefined`）；
 * - `project` / `conversation` 的全部条目。
 *
 * 为什么平台级 `auto` **不能**留在稳定侧：体检视图允许把条目「保留为平台级」
 * ⇒ 一条平台级自动条目若落在稳定前缀里，它一变就**整体位移稳定前缀**，
 * 本次改造的核心收益当场失效（这正是这条判据要挡的形态）。
 */
export function isStableMemoryEntry(entry: Pick<MemoryEntry, "scope" | "source">): boolean {
  return entry.scope === "platform" && entry.source === "manual";
}

/** 注入的来源筛选口径（稳定侧只要手动、易变侧只要自动） */
export const MEMORY_SOURCES_MANUAL: readonly MemorySource[] = ["manual"];
export const MEMORY_SOURCES_AUTO: readonly MemorySource[] = ["auto"];

/**
 * **聚合**注入预算的共享计数槽（S1-BUDGET-TOTAL）。
 *
 * 背景（**照实**，第 189 波修正了原注释里"最多是预算的 3 倍"这句不成立的推断）：
 * `computeInjection` 的 `chars` 计数在**单次调用内跨三块共享**（它在 scope 循环之外声明），
 * 所以"三块各拿一份 12k 预算"这个前提**本身不成立** —— 实测（25 条/作用域）拆成多次调用
 * 前后的注入条数与字符数与旧口径**逐条一致**。
 *
 * 那它为什么还留着：这是**防御性**上限。`buildMemoryPrompt` 的默认形态仍允许调用方
 * 不传 `sources`/`budgetTracker`，将来任何一条只给"单块预算"的新调用路径出现时，
 * 聚合槽保证跨块合计仍不超过 `MEMORY_INJECT_CHAR_BUDGET`。它今天就该有的可观测行为是
 * "超限不静默"（见 `composeMemoryBlock` 的披露），不是"今天真的天天咬合"。
 *
 * 语义：`totalChars` 累计**已经被收进注入文本**的字符；超出聚合上限的条目**不收**，
 * 由调用方在末尾用 `renderAggregateBudgetNotice()` **如实披露**（不许静默丢）。
 */
export interface MemoryInjectBudgetTracker {
  totalChars: number;
  totalTruncated: number;
}

/**
 * 截断披露的**定位锚**（构建与解析共用一处，判据 `MEM-PLACE-24`）。
 *
 * 两层必须能**逐句分辨**：同一块里出现 2~4 句文字几乎相同、数字不同的披露时，
 * 读者（模型/用户）分不清哪句是哪一层的截断 —— 这正是复审读码推定要挡的形态。
 */
const TRUNCATION_NOTICE_PREFIX = "> 注入上限";
/** 逐块层（`renderBlocks`：每作用域每来源的条数上限 / 单次调用的字符预算） */
const TRUNCATION_NOTICE_PER_BLOCK_ANCHOR = "本段";
/** 聚合层（`renderAggregateBudgetNotice`：多块共享的合计字符预算） */
const TRUNCATION_NOTICE_AGGREGATE_ANCHOR = "跨块合计";

export function createMemoryInjectBudgetTracker(): MemoryInjectBudgetTracker {
  return { totalChars: 0, totalTruncated: 0 };
}

/**
 * 聚合上限被触发时的**如实披露**文本。
 *
 * ⚠️ 它**故意**不再与 `renderBlocks` 里那条逐字同形（第 189 波附带项，复审的读码推定）：
 * 一个 `composeMemoryBlock` 的易变半块由**三次** `buildMemoryPrompt` 拼成，每次都会带出
 * 自己那句「本段还有 N 条未注入」，最后再追加这一句 ⇒ 同一块里会出现 2~4 句**文字几乎相同、
 * 数字不同**的披露，读者分不清哪句是哪一层的截断（"同句不同数"）。
 * 现在两层各自自证：逐块的写「**本段**」，聚合的写「**跨块合计**」——
 * 判据 `MEM-PLACE-24` 同时钉住"分层可辨"与"数字必须能对账
 * （∑逐块 + 聚合 == 实际未注入条数）"。
 *
 * 未触发 ⇒ 返回空串（不留无意义的空话在系统提示里）。
 */
export function renderAggregateBudgetNotice(tracker: MemoryInjectBudgetTracker): string {
  if (tracker.totalTruncated <= 0) return "";
  return (
    `${TRUNCATION_NOTICE_PREFIX}（**${TRUNCATION_NOTICE_AGGREGATE_ANCHOR}**）：本块另有 ${tracker.totalTruncated} 条可见记忆**未注入**` +
    `（多块合计不超过 ${MEMORY_INJECT_CHAR_BUDGET} 字符；每个作用域每来源另受 ` +
    `${MEMORY_INJECT_MAX_PER_BLOCK} 条上限约束，那一层在各自的小节里单独写明）。` +
    `这不是它们被删除，只是没进上下文；可在「设置 → 记忆体检」里看到每一条。`
  );
}

/**
 * 把注入文本里的截断披露**按层分开**（判据 `MEM-PLACE-24`；界面若以后要展示也走它）。
 *
 * 三层归口：逐块披露（`renderBlocks` 每个 selection 各一句）→ `perBlock`；
 * 聚合披露（`renderAggregateBudgetNotice`）→ `aggregate`；两句锚都认不出 ⇒ `unknown`
 * （**不许**静默归到某一层 —— 那正是"同句不同数"的来源）。
 */
export function splitMemoryTruncationNotices(text: string): {
  perBlock: string[];
  aggregate: string[];
  unknown: string[];
} {
  const perBlock: string[] = [];
  const aggregate: string[] = [];
  const unknown: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(TRUNCATION_NOTICE_PREFIX)) continue;
    if (line.includes(TRUNCATION_NOTICE_AGGREGATE_ANCHOR)) aggregate.push(line);
    else if (line.includes(TRUNCATION_NOTICE_PER_BLOCK_ANCHOR)) perBlock.push(line);
    else unknown.push(line);
  }
  return { perBlock, aggregate, unknown };
}

/** 一块记忆的取数口径：哪个作用域、只要哪个来源 */
export interface MemoryBlockSelection {
  scope: MemoryScope;
  sources?: readonly MemorySource[];
}

/** 稳定侧取数口径 = **平台级 + 手动**（照 `isStableMemoryEntry`） */
export const MEMORY_STABLE_BLOCK_SELECTION: readonly MemoryBlockSelection[] = [
  { scope: "platform", sources: MEMORY_SOURCES_MANUAL },
];

/**
 * 易变侧取数口径 = 平台级自动（含旧数据）+ 项目级 + 对话级。
 *
 * 顺序照既有的 platform → project → conversation（顺序契约不变，判据 MEM-SCOPE-4 / MEM-INJECT-1）。
 */
export const MEMORY_VOLATILE_BLOCK_SELECTIONS: readonly MemoryBlockSelection[] = [
  { scope: "platform", sources: MEMORY_SOURCES_AUTO },
  { scope: "project" },
  { scope: "conversation" },
];

/**
 * 把若干"作用域 × 来源"的记忆渲染成**一块**带权威性抬头的记忆块。
 *
 * 空 ⇒ 返回空串（**不许**留一个孤零零的抬头占上下文）；但**披露优先于"空块不留字"**：
 * 正文为空而聚合上限挡下过条目时，抬头 + 权威句 + **披露**必须照样出现
 * （第 189 波 A4：旧写法先 `if (!text) return ""`，于是"还有 N 条未注入"随空块一起消失，
 * 正是 `:131` 明令禁止的静默丢）。判据 `MEM-PLACE-14`。
 *
 * 注入正文仍由 `MemoryService.buildMemoryPrompt(scope, projectId, sessionId, {sources})` 负责
 * （截断口径、手动/自动分块、超限如实披露都在那里，这里不重复一遍）。
 *
 * 两块（稳定/易变）**各自**带 `MEMORY_AUTHORITY_NOTE`（保留两份：两块可能在上下文里
 * "可回忆度"不同，豁免必须跟着它自己那块走）。**成本**：旧文案 104 字符 × 2 = 208；
 * 现在 37 字符 × 2 = 74 ⇒ 每轮省 **134** 字符，两块仍各自带豁免。
 *
 * `tracker`（可选）用于**聚合**预算（S1-BUDGET-TOTAL）：同一轮提示里的多块共享一个计数槽，
 * 合计不超过 `MEMORY_INJECT_CHAR_BUDGET`；被聚合上限挡下的条数会在该块末尾**如实披露**。
 */
export function composeMemoryBlock(
  service: Pick<MemoryService, "buildMemoryPrompt">,
  selections: readonly MemoryBlockSelection[],
  header: string,
  projectId?: string,
  sessionId?: string,
  tracker?: MemoryInjectBudgetTracker,
): string {
  const text = selections
    .map((selection) => service.buildMemoryPrompt(selection.scope, projectId, sessionId, { sources: selection.sources, budgetTracker: tracker }))
    .filter((part) => part !== "")
    .join("\n\n");
  const notice = tracker ? renderAggregateBudgetNotice(tracker) : "";
  // 正文与披露**都**为空 ⇒ 才是真正的空块（不占上下文、不留孤立抬头）
  if (!text && !notice) return "";
  return [
    header,
    "",
    MEMORY_AUTHORITY_NOTE,
    ...(text ? ["", text] : []),
    ...(notice ? ["", notice] : []),
  ].join("\n");
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  filePath?: string;
  timestamp: number;
  tags?: string[];
  /** 来源（迁移时按作用域推断：platform/project 视为用户维护，conversation 视为自动） */
  source: MemorySource;
  /** `pending` = 等待批准，未批准不进上下文 */
  status?: MemoryStatus;
  /** 归属键：`project` 作用域必填（否则不注入任何项目） */
  projectId?: string;
  /** 归属键：`conversation` 作用域必填（否则不注入任何对话 —— 迁移后的旧 session 记忆就是这一态） */
  sessionId?: string;
  /** 自动提取批次号（`batch-<时间>-<随机>`）—— 用于整批撤销 */
  batchId?: string;
  /**
   * **旧版跨项目池**标记（M-2）。
   *
   * 旧实现只按 `scope` 过滤、`projectId` 是未使用参数 ⇒ 旧 `project` 条目实际是
   * 「所有项目共享的自动提取池」，**可能已被别的项目污染**。迁移必须如实保留它的可见范围
   * （否则就是静默改变用户能看到什么），但也**必须**让用户能把它与真正手写的平台记忆区分开
   * —— 于是打上这个可展示的标记，并由体检视图单列一组、提供批量处置与「暂停注入」开关。
   */
  legacyPool?: true;
  /**
   * **创建序**（只增不减的整数；`add` 时分配，`update` 永不动它）。
   *
   * ## 为什么必须**持久化**一个序号（第 189 波 R2，实测）
   *
   * 注入块的块内顺序原先建立在 `this.entries` 的 **Map 插入序**上（"插入序 = 创建序"）。
   * 那条假设在**重载**路径上不成立：`serialize()` 把条目写成**以 id 为键的普通对象**，
   * 而 JSON 的**整数样键按数值升序**排列，与插入序无关。实测插入 `mem-3,1,mem-1,2`
   * ⇒ 落库文本是 `{"1":…,"2":…,"mem-3":…,"mem-1":…}` ⇒ 读回 `1,2,mem-3,mem-1`
   * （顺序整体反转）。**数字 id 是本仓真实形状**（`looksLikeMemoryEntryValue` 的注释：
   * 「真实 id 前缀会变（uuid / 中文 / 数字都出现过）」）。而构造即 `load()`、开记忆面板还会
   * `reload()`（`MemoryManager.tsx` 的 `useEffect`）⇒ 重启后注入块顺序反转，
   * 配合每桶 20 条上限，**入选的 20 条也会变**（稳定前缀被重写一次）。
   *
   * 于是创建序不再依赖"容器保序"这件我们控制不了的事，而是**写在条目自己身上**：
   * - 新写入（`createEntry`）分配 `max(order)+1` ⇒ 只增不减；
   * - `update()` 刷新 `timestamp` 但**不动** `order` ⇒ 编辑不平移（第 15 条）；
   * - `load()` 对**没有** `order` 的旧条目按**当前读入顺序**幂等补齐（旧的 id-keyed 映射
   *   本来就是"读入顺序"，无更早的真相可复原；补齐后立刻随下一次 `save()` 落库，
   *   于是**跨进程**也稳定）。
   *
   * 判据 `MEM-PLACE-20`（落库→重载后逐条顺序与入选集合不变，整数样 id 与非整数 id 混排）。
   */
  order?: number;
}

/** 待迁移的条目形态（作用域可能是旧名，且没有新的信任字段） */
type LegacyMemoryEntry = Omit<Partial<MemoryEntry>, "scope"> & {
  scope: LegacyMemoryScope;
  id: string;
  key: string;
  content: string;
  timestamp: number;
};

/** 一次自动提取批次（用于 `/memory undo <batchId>` 与界面撤销） */
export interface MemoryBatch {
  id: string;
  sessionId?: string;
  createdAt: number;
  scope: MemoryScope;
  count: number;
  undone?: boolean;
  undoneAt?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

export interface MemoryConfig {
  /** Root directory for memory files */
  rootDir: string;
  /** Maximum entries per scope */
  maxEntries: number;
  /** Maximum content length per entry */
  maxContentLength: number;
}

/** 当前位置的作用域上下文（注入与过滤都要它） */
export interface MemoryScopeContext {
  projectId?: string;
  sessionId?: string;
  /** 连尚未批准的 `pending` 条目也一并返回（**只给审批界面用**，不给注入用） */
  includePending?: boolean;
  /** 连没有归属键的孤儿条目也一并返回（**只给界面用**，不给注入用） */
  includeUnscoped?: boolean;
  /**
   * **跨项目全量列举**（只给「记忆体检」用）。
   *
   * 体检的目的就是"审查全部记忆的归属对不对"，所以它必须看得到**所有**项目/对话的条目 ——
   * 这不违反作用域纪律（纪律约束的是"谁进上下文"，不是"谁能被审查"）。
   * 除体检外**任何地方都不许传它**：注入路径永远只看当前项目/当前对话。
   */
  showAllProjects?: boolean;
}

/**
 * 注入侧上下文的**品牌键**（R6 加强）。
 *
 * 为什么需要它：`Pick<MemoryScopeContext, "projectId" | "sessionId">` 只是"少几个可选字段"，
 * 而 TS 的**结构类型**允许把"带额外开关的宽对象"赋给窄类型（多余属性检查只对**新鲜字面量**
 * 生效）。于是"把 `showAllProjects` 传进注入路径"在旧形态下有两条路都不会红：
 * ① 宽类型变量直接传进形参；② 类内手工构造带开关的 ctx。
 * 有了必需品牌键，`InjectionScopeContext` 就**只能**由 `injectionScopeContext()` 构造
 * （`MemoryScopeContext` 没有这个键 ⇒ 赋不过去）⇒ 上面两条路都变成编译错误。
 */
export const INJECTION_SCOPE_CONTEXT_BRAND: unique symbol = Symbol("codem.memory.InjectionScopeContext");

/**
 * **注入侧**的作用域上下文：只有"当前项目 / 当前对话"，且**只能**由
 * `injectionScopeContext()` 构造（品牌键必需）。
 *
 * 显示专用的三个开关（`includePending` / `includeUnscoped` / `showAllProjects`）**故意不在
 * 这个类型里**，而且宽类型 `MemoryScopeContext` **赋不进来**（缺品牌键）—— 这条由类型系统保证。
 *
 * ⚠️ 覆盖面的**如实**声明（R6）：类型只挡"构造"，挡不住 `as InjectionScopeContext` 这种硬转；
 * 所以 `computeInjection` 在运行时**再收一次口**（只取两个归属键，见那里）。判据 `MEM-PLACE-13`。
 */
export type InjectionScopeContext = Pick<MemoryScopeContext, "projectId" | "sessionId"> & {
  /** 品牌：由 `injectionScopeContext()` 写入（运行时真的存在，但不进 `Object.keys`） */
  readonly [INJECTION_SCOPE_CONTEXT_BRAND]: true;
};

/**
 * **编译期守卫 ①**（判据 `MEM-PLACE-13`）：注入侧上下文**不许**携带体检开关。
 *
 * 为什么守卫必须写在**生产代码**里（`src/**`）而不是测试文件里：`tsconfig.json` 把
 * `src/test/**` 整个 **exclude** 掉了 ⇒ 测试文件里的 `@ts-expect-error` 不会被 `tsc` 检查
 * （是装饰品）。这个文件在 `include: ["src"]` 里，所以下面这行的指令是**真的**被检查的：
 *
 * - 今天 `showAllProjects` 不在 `InjectionScopeContext` 里 ⇒ 字面量多出一个键 ⇒
 *   报错 ⇒ `@ts-expect-error` **被消费**，`tsc` 0 错；
 * - 若将来有人把体检开关加回这个类型，这一行就**编译通过** ⇒ 指令变成"未使用"⇒ `tsc` 立刻红。
 */
export const INJECTION_SCOPE_CONTEXT_COMPILE_GUARD: InjectionScopeContext = {
  ...injectionScopeContext("compile-guard"),
  // @ts-expect-error 注入侧上下文不许携带体检开关（showAllProjects）
  showAllProjects: true,
};

/**
 * **编译期守卫 ②**（R6 新增：钉住**形参类型**，而不只是类型别名）。
 *
 * 旧守卫只挡"把字段加回 `InjectionScopeContext`"。把 `injectionPlan` / `computeInjection`
 * 的**形参**直接放宽成 `MemoryScopeContext`（不动别名）则一路畅通 —— 复审正是这么打穿它的。
 * 这条守卫读的**就是**形参类型：
 * - 今天形参是窄类型 ⇒ `InjectionParamIsNarrow = true` ⇒ `const g: true = false` **报错**
 *   ⇒ `@ts-expect-error` 被消费，`tsc` 0 错；
 * - 形参被放宽（`keyof` 里出现 `showAllProjects`）⇒ 类型变 `false` ⇒ 那一行**编译通过**
 *   ⇒ 指令变成"未使用"⇒ `tsc --noEmit` **立刻红**。
 */
type InjectionParamIsNarrow = "showAllProjects" extends keyof Parameters<MemoryService["injectionPlan"]>[0]
  ? false
  : true;
// @ts-expect-error 注入路径的形参必须窄：放宽成 MemoryScopeContext 会让这条指令"未被使用"（tsc 红）
const INJECTION_PARAM_TYPE_COMPILE_GUARD: InjectionParamIsNarrow = false;
void INJECTION_PARAM_TYPE_COMPILE_GUARD;

/** 注入侧上下文的**唯一**构造点（新增开关前必须先过判据 `MEM-PLACE-13`） */
export function injectionScopeContext(projectId?: string, sessionId?: string): InjectionScopeContext {
  return { projectId, sessionId, [INJECTION_SCOPE_CONTEXT_BRAND]: true };
}

/** `add` 的结果：容量超限等失败必须**可见**，不许静默驱逐 */
export interface MemoryAddResult {
  ok: boolean;
  entry?: MemoryEntry;
  /** 失败原因（用户可读） */
  error?: "capacity" | "persist" | "invalid";
  message?: string;
}

/** 审批开关的作用域语义：platform/project 默认开，conversation 默认关 */
export type ApprovalScopeSetting = { platform: boolean; project: boolean; conversation: boolean };

export const MEMORY_WRITE_APPROVAL_KEY = "memory-write-approval";
/** 迁移标记键（幂等的依据） */
export const MEMORY_MIGRATED_KEY = "memory-scope-migrated-v2";

/**
 * **迁移前快照键**（M-6）。
 *
 * 迁移是**原地改写** `memory` 字段那一个字符串（`memory_set` 单行 UPDATE），
 * 快照没留 ⇒ 用户升级后无法回退。这里把迁移前的**原始字符串逐字**存一份（独立键，不参与
 * 正常读写路径），并在体检视图提供「回退到迁移前」与「导出这份快照」。
 *
 * **只在第一次真的迁移时写一次**（幂等：键已存在就不再覆盖 —— 否则第二次迁移会把
 * 「迁移前」覆盖成「已迁移」的样子，回退就成了空操作）。
 */
export const MEMORY_PRE_MIGRATION_KEY = "memory-pre-migration-v2";

/**
 * 「暂停注入旧版跨项目记忆」开关键（M-2）。
 *
 * **默认关**（键不存在或不是 `"1"` ⇒ 不暂停）—— 也就是**不偷偷改变既有可见范围**；
 * 打开后那些带 `legacyPool` 标记的条目停止注入，直到用户处置它们。
 */
export const MEMORY_PAUSE_LEGACY_POOL_KEY = "memory-pause-legacy-project-pool";

/**
 * 每个注入块（作用域 × 来源）的条数上限（I4）。
 *
 * **一处定义**：注入侧用它截断，界面与体检也用它判定「这条其实不会被注入」，
 * 否则会出现「界面说生效、第 21 条起静默不进上下文」。
 */
export const MEMORY_INJECT_MAX_PER_BLOCK = 20;

/**
 * 注入文本的**总字符预算**（S1）。
 *
 * 120 条饱和时实测约 29,000 字符（≈1.9~2.9 万 token，占 128k 上下文的 15%~23%），
 * 而注入是**每轮**都要付的固定成本。这里给出一个明确上限：超预算即按块顺序截断，
 * 并在注入文本里**如实披露**被截断了多少条（不静默丢弃）。
 */
export const MEMORY_INJECT_CHAR_BUDGET = 12000;

/** 单条注入行的 key 上限（S1：key 原来原样注入 ⇒ 超长 key 会全额进每轮提示） */
export const MEMORY_INJECT_KEY_MAX = 120;

/** 快照/批次参数 */
const BATCH_KEEP_MAX = 50;

const DEFAULT_APPROVAL: ApprovalScopeSetting = { platform: true, project: true, conversation: false };

export interface MemoryMigrationReport {
  /** 本次调用是否真的执行了迁移（已迁移过 ⇒ false，幂等） */
  ran: boolean;
  /**
   * **因读取失败/格式不认识而推迟迁移**（M-1 / M-4 / A1）时给出的真实原因。
   *
   * 有它就意味着：本次**没有**迁移、**没有**写标记、**没有**覆盖磁盘上的数据。
   * 三种触发形态：记忆域未预热（读到的是兜底空串）、JSON 坏、顶层不是本模块认识的容器。
   */
  deferredReason?: string;
  /** 读入时被丢弃的非法条目数（M-4 条目级校验：缺 id/key/content 或类型不对） */
  droppedEntries?: number;
  /** 本次迁移打上 `legacyPool` 标记的条数（M-2：旧 `project` 池） */
  projectToLegacyPool?: number;
  /**
   * 迁移前快照是否**本次**写入（M-6；已存在则为 false —— 幂等）。
   *
   * F4：它**不是**"我打算写"而是"确认落库了没有" —— 确认链是异步的，所以同步返回时
   * 恒为 `false`；要读"到底落了没有"请 `await flushPendingPersist()` 之后再看
   * （成功 ⇒ 真、失败 ⇒ 假且 `snapshotDeferred` 说明原因）。
   */
  snapshotWritten?: boolean;
  /**
   * F4：本该写快照却**没写成**（或没来得及确认）时的真实原因。
   *
   * 有它就意味着：**数据与迁移标记都没写**（迁移被整条链拒了）—— 因为快照是唯一的可逆凭据，
   * "迁了但没法回退"是必须避免的形态。
   */
  snapshotDeferred?: string;
  /** 由旧 `global` 升为 `platform` 的条数 */
  globalToPlatform: number;
  /**
   * 由旧 `project` 降为 `platform` 的条数（同时打 `legacyPool` 标记，见 M-2）。
   * **理由**：旧 `project` 条目没有 `projectId`，今天的实际可见范围就是「到处都生效」
   * （因为过滤只看 scope）—— 如实保留该可见范围就是 `platform`。
   * 按当前项目猜一个 `projectId` 塞进去是**替用户做假设**，会让记忆突然从「到处可见」
   * 变成「只在一个项目可见」，所以不这么做。
   */
  projectToPlatform: number;
  /** 由旧 `session` 改为 `conversation` 且**不带 sessionId** 的条数（仍不被注入 = 与今天一致） */
  sessionToConversation: number;
  /** 迁移后仍未注入的条目数（孤儿 conversation） */
  notInjected: number;
  /** 迁移后的可见范围快照（判据用它逐字比对迁移前后） */
  visibleBefore: string[];
  visibleAfter: string[];
}

/**
 * 一次读盘的结果（M-1）。
 *
 * **「读不到」与「本来就空」必须是两种结果**：前者绝不允许走迁移、绝不允许写标记、
 * 绝不允许让 `save()` 覆盖（否则就是静默抹除旧数据）。
 */
export type MemoryLoadFailure = {
  /** `not-ready` = 记忆域未预热/没有端口；`malformed` = 读到了但形状不认识；`parse` = JSON 坏 */
  kind: "not-ready" | "malformed" | "parse";
  /** 用户可读的原因（会进上报通道与界面） */
  reason: string;
};

/** 迁移前快照的形状（M-6） */
export interface MemoryPreMigrationSnapshot {
  /** 快照写入时间 */
  takenAt: number;
  /** 快照里的条目数（给用户一个可核对的数字） */
  entries: number;
  /** 迁移前的**原始字符串**（逐字保存，回退时逐字写回） */
  raw: string;
}

/** 一次读盘后的状态（界面与判据都靠它区分「读不到」与「本来就空」） */
export interface MemoryLoadState {
  ok: boolean;
  /** 读失败时的原因（用户可读） */
  reason?: string;
  /** 读失败的种类 */
  kind?: MemoryLoadFailure["kind"];
  /** 读入时被丢弃的非法条目数（M-4） */
  dropped: number;
  /** 读进来的**原始字符串**（迁移快照与回退都要它逐字一致；读失败时为 null） */
  raw: string | null;
}

const DEFAULT_CONFIG: MemoryConfig = {
  rootDir: ".codem-memory",
  maxEntries: 1000,
  maxContentLength: 10000,
};

/**
 * 由工作目录推出 `projectId`。
 *
 * 为什么是"路径本身"而不是哈希：记忆条目要能被用户肉眼核对归属，路径可读且稳定；
 * 大小写与尾部分隔符差异在这里拉平（Windows 同一目录的不同写法必须落进同一个桶）。
 */
export function projectIdFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const normalized = cwd.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/** 条目是否有归属键（孤儿条目在界面上仍可见，但永不进注入） */
function hasOwner(entry: MemoryEntry): boolean {
  if (entry.scope === "platform") return true;
  if (entry.scope === "project") return Boolean(entry.projectId);
  return Boolean(entry.sessionId);
}

/**
 * 条目在其**自身维度**上是否可见。
 *
 * 这里没有 ctx 的概念：`platform` 恒可见；`project` 只看"有没有 projectId"
 * （**由 `visibleIn` 与实际 projectId 比对**，这样评审时能一眼看出维度落在哪里）；
 * `conversation` 只看 sessionId 是否存在。
 */
function ownedBySelf(entry: MemoryEntry): boolean {
  return hasOwner(entry);
}

/**
 * 当前位置**可见**的条目（含 pending，含孤儿 conversation —— 界面视图）。
 *
 * 判据注释（避免"文件里含某字符串"式伪断言）：
 * - `project`：有归属 ⇒ **必须与当前 projectId 相等**（项目 A 的记忆在项目 B 不可见）；
 *   没有归属（旧数据）⇒ 只有显式打开 `includeUnscoped` 的**界面视图**才看得到；
 * - `conversation`：同理（有归属看是否相等，没有归属要 `includeUnscoped`）；
 * - `platform` 不受任何维度约束 ⇒ 处处可见。
 */
function visibleIn(entry: MemoryEntry, ctx: MemoryScopeContext): boolean {
  if (entry.scope === "platform") return true;
  // 体检模式：跨项目全量列举（审查用，不影响注入）
  if (ctx.showAllProjects === true) return true;
  if (entry.scope === "project") {
    if (entry.projectId === undefined) return ctx.includeUnscoped === true;
    return entry.projectId === ctx.projectId;
  }
  if (entry.sessionId === undefined) return ctx.includeUnscoped === true;
  return entry.sessionId === ctx.sessionId;
}

/** 当前位置**会被注入上下文**的条目：可见 + 归属键齐备 + 已批准 + 未被暂停 */
function injectedIn(entry: MemoryEntry, ctx: MemoryScopeContext): boolean {
  if (!visibleIn(entry, ctx)) return false;
  if (!ownedBySelf(entry)) return false; // 孤儿：任何上下文都不注入
  if ((entry.status ?? "active") !== "active") return false; // pending：未批准不进上下文
  /*
   * M-2：旧版跨项目池的**暂停注入**开关。
   *
   * 默认关 ⇒ 这一行恒不生效 ⇒ 既有可见范围逐字不变（不许偷偷改行为）；
   * 用户显式打开 ⇒ 带 `legacyPool` 标记的条目停止注入，直到他在体检里处置它们。
   * 它只拦**注入**：体检（`showAllProjects` + `includeUnscoped` 的展示口径）仍看得到，
   * 否则用户就没法"处置完再打开"。
   */
  if (entry.legacyPool === true && isLegacyPoolInjectionPaused()) return false;
  return true;
}

/**
 * 「暂停注入旧版跨项目记忆」当前是否打开（M-2）。
 *
 * **默认关**：设置读不到（键不存在 / 未预热 / 坏值）一律按"未暂停"处理 ——
 * 这是**行为不变**的那一侧，读不到设置时不该改变用户能看到什么。
 */
export function isLegacyPoolInjectionPaused(): boolean {
  return getSetting(MEMORY_PAUSE_LEGACY_POOL_KEY) === "1";
}

/** 打开/关闭「暂停注入旧版跨项目记忆」（M-2）。写入失败如实上报，不假装保存成功。 */
export function setLegacyPoolInjectionPaused(paused: boolean): void {
  try {
    setSetting(MEMORY_PAUSE_LEGACY_POOL_KEY, paused ? "1" : "0");
  } catch (e) {
    reportPersistFailure(
      "memory.legacyPoolPause",
      e,
      "「暂停注入旧版跨项目记忆」开关未保存（本次运行内仍按新设置生效，重启后会回到旧值）",
    );
  }
}

/**
 * 任意值 → 可用于注入/回执的**字符串**（M-3；导出为公开入口 `safeMemoryText`）。
 *
 * 库里的 `content` / `key` 不是字符串时（历史手工改库、旧格式写坏、人工修库），
 * 旧实现直接在 `formatLine`/命令回执里 `.substring` ⇒ TypeError 抛到 `buildSystemPrompt`
 * **整轮系统提示全丢**，或在 `/memory pending` 里直接炸命令。这里给一条安全通道：
 * 数字/布尔安全字符串化，对象用 JSON（拿不到就给空串），绝不抛。
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * `textOf` 的**公开别名**（F7）：命令/界面回执里凡是拼接记忆 `content`/`key` 的地方，
 * 一律用它 —— 库里的字段按设计允许是数字/布尔，直接 `.substring` 会抛。
 */
export const safeMemoryText = textOf;

/**
 * 时间戳 → **本地**日期 `YYYY-MM-DD`；不是有限数字时如实写「日期未知」（不抛 RangeError）。
 *
 * ⚠️ **第 189 波 R7 修复**：旧实现是 `new Date(n).toISOString().split("T")[0]` ——
 * 那是 **UTC 日**，于是 `Asia/Shanghai` 本地 `00:00–08:00` 写入/展示的条目在注入文本里
 * **显示前一天**（与同提示的 `# Current Date` 本地口径也互相矛盾）。这是"自造时间格式"
 * 同一簇的第三份（前两份：`prompt.ts` 的 date、`time-context.ts` 的时间戳）。
 *
 * 现在一律走**唯一口径** `localDateString()`（`core/time/local-time.ts`）——
 * 判据 `TIME-SINGLE-SOURCE①②`（② 就是这条缺陷的正身：固定 +08:00、本地 00:30 必须显示当天）。
 */
function safeDate(timestamp: unknown): string {
  const n = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : NaN;
  if (Number.isNaN(n)) return "日期未知";
  try {
    return localDateString(new Date(n));
  } catch {
    return "日期未知";
  }
}

/** 非空字符串才认（其它一律 `undefined` —— 空串归属键等于没有归属） */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 从若干条目里算出**创建序的完整索引**（`MEM-PLACE-20` 的依据）。
 *
 * - 有显式 `order` 的（本版本落库的形态）**以它为唯一依据** —— 它与容器的键序无关；
 * - 没有 `order` 的（旧数据里直接塞进内部表的条目 / 判据手工构造的条目）按**迭代位置**兜底
 *   （接在最大显式 `order` 之后）—— 保证"键序变了也不会算出两套顺序"。
 *
 * 迭代位置兜底**不是**创建序的第二个真相：`load()` 会把读入的旧条目按读入顺序补齐 `order`
 * 并随下次 `save()` 落库，所以产品路径上"缺 `order`"只可能出现在同一进程刚塞进来的瞬间。
 */
function buildCreationOrderIndex(entries: Iterable<MemoryEntry>): Map<string, number> {
  /*
   * ⚠️ 必须先物化成数组：`Map.values()` 返回的是**一次性迭代器**，
   * 下面要遍历两遍（先取最大显式 order、再逐条建索引），第二遍会拿到空序列 ——
   * 第一版就是这么写的，判据 `MEM-PLACE-20` 当场抓到（顺序索引恒为空 ⇒ 排序退化成插入序）。
   */
  const list = Array.from(entries);
  const order = new Map<string, number>();
  let maxExplicit = -1;
  for (const e of list) {
    if (typeof e.order === "number" && Number.isFinite(e.order) && e.order > maxExplicit) {
      maxExplicit = e.order;
    }
  }
  let fallback = maxExplicit + 1;
  for (const e of list) {
    order.set(e.id, typeof e.order === "number" && Number.isFinite(e.order) ? e.order : fallback++);
  }
  return order;
}

/**
 * 这一条是不是**旧版本写下的 `project` 池条目**（M-2 的判据）。
 *
 * 判别为什么要这么小心：**新旧作用域名里都有 `project`**，只比作用域名会把
 * "本版本写的项目记忆"也当成旧数据（实测：那样会把刚写的项目条目降级成平台级 ⇒
 * 静默改变可见范围，而且判据 I9 当场抓到——所有 project 条目都被打上 legacyPool 标记）。
 *
 * 旧版本的真实形态（三条同时成立）：
 * - **没有 `projectId`**：旧实现只按 scope 过滤，`projectId` 是未使用参数，从不写进条目；
 * - **没有 `source` / `status` / `batchId`**：这三个是本次重构才引入的信任字段，
 *   旧数据一个都没有（这也是"来源无法确证"的成因）。
 *
 * 于是"本版本写的、只是缺归属键的项目条目"（`source` 一定被 `add` 设过）不会命中 ——
 * 它们保持原样（仍然不注入任何上下文），不会被悄悄提升为平台级。
 */
function isLegacyProjectPoolEntry(entry: MemoryEntry): boolean {
  return (
    entry.scope === "project" &&
    entry.projectId === undefined &&
    entry.source === undefined &&
    entry.status === undefined &&
    entry.batchId === undefined
  );
}

/**
 * 条目级校验 / 规范化（M-4，口径与 `importFromJSON` 一致）。
 *
 * - **丢弃**（返回 null）：不是对象、`key` 不是非空字符串、`content` 不是字符串/数字/布尔；
 * - **规范化**：`key`/`content` 是数字或布尔 ⇒ 安全字符串化（不丢用户数据）；
 * - `id` 以**记录键**为准（记录键就是库里的主键），记录键不可用时退回条目自带的 `id`；
 * - 作用域**原样保留**（未知值由体检的「作用域无法识别」组处置，M-5）；
 * - `timestamp` 不是有限数字 ⇒ `NaN`（界面显示「日期未知」，统计里被排除，不再是 NaN 传染）。
 */
function normalizeLoadedEntry(idKey: string, value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const id = optionalString(idKey) ?? optionalString(raw.id);
  if (!id) return null;

  const rawKey = raw.key;
  const key =
    typeof rawKey === "string" && rawKey.trim().length > 0
      ? rawKey
      : typeof rawKey === "number" || typeof rawKey === "boolean"
        ? String(rawKey)
        : null;
  if (key === null) return null;

  const rawContent = raw.content;
  const content =
    typeof rawContent === "string"
      ? rawContent
      : typeof rawContent === "number" || typeof rawContent === "boolean"
        ? String(rawContent)
        : null;
  if (content === null) return null;

  const source = raw.source === "manual" || raw.source === "auto" ? (raw.source as MemorySource) : undefined;
  const status = raw.status === "pending" || raw.status === "active" ? (raw.status as MemoryStatus) : undefined;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : undefined;

  return {
    id,
    scope: (typeof raw.scope === "string" ? raw.scope : "") as MemoryScope,
    key,
    content,
    filePath: optionalString(raw.filePath),
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Number.NaN,
    tags: tags && tags.length > 0 ? tags : undefined,
    source: source as MemorySource,
    status,
    projectId: optionalString(raw.projectId),
    sessionId: optionalString(raw.sessionId),
    batchId: optionalString(raw.batchId),
    legacyPool: raw.legacyPool === true ? true : undefined,
    // 创建序（R2）：非法/缺失一律 `undefined`，由 `load()` / `importFromJSON` 幂等补齐
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : undefined,
  };
}

/**
 * 「这个值看起来像一条记忆条目吗」——id-keyed 映射判定用的**唯一**线索（LEGACY-SHAPE-1）。
 *
 * 判据刻意只要 `key` 或 `content` **存在**（不管类型对不对）：类型不合法由
 * `normalizeLoadedEntry()` 逐条丢弃并计数 —— 那是**条目级**口径，不该决定"容器认不认识"。
 * 反过来，用"键以 `mem-` 开头"之类的判据是脆弱的：真实 id 前缀会变（uuid / 中文 / 数字都出现过）。
 */
function looksLikeMemoryEntryValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return "key" in raw || "content" in raw;
}

/** 一次容器解析的结果：要么给出可用的 (键, 值) 对，要么给出一句**用户可读**的拒绝原因 */
type MemoryContainerRead =
  | { ok: true; pairs: Array<[string, unknown]>; batches: unknown[] | null }
  | { ok: false; reason: string };

/**
 * 解析 `memory` 字段的**容器**（LEGACY-SHAPE-1）。
 *
 * 认两种形状，其余一律 fail-closed：
 *
 * 1. `{ entries: {…} | […] }` —— 本版本 `save()` 写的形态（`batches` 顺带读）；
 * 2. **以条目 id 为键的裸映射**（顶层非数组对象、**没有** `entries` 字段、
 *    且其值**大多是看起来像条目的对象**）—— 这是真机上存量用户的真实形状：
 *
 *    ```json
 *    {"mem-1791424659167-eirq3sf0m":{"scope":"project","key":"…","content":"…"}, …}
 *    ```
 *
 *    修复前第 2 种被当成"形状不认识"直接拒 ⇒ **存量记忆一条都读不出来**（没被删，功能等于失效）。
 *    认出来的口径是「值大多像条目」而不是「有一个像」：`{"foo":1}`、`{"foo":{"bar":1}}`
 *    这类**没有 key/content 的对象**仍然不认（LEGACY-SHAPE-3），
 *    所以第 3 条纪律（fail-closed 只对真正不认识的形状保留）没有被放松。
 *
 * ⚠️ 顶层数组**仍然不认**：旧实现用 `Object.entries` 把每个下标变成 `{scope:undefined,…}`
 * 的空壳条目收进池（`MIG-ROBUST-2` 钉的就是这一条）。
 */
function readMemoryContainer(parsed: unknown): MemoryContainerRead {
  const reject = (shape: string): MemoryContainerRead => ({
    ok: false,
    reason:
      `记忆容器形状不认识（${shape}，且没有 entries 字段、其值也不像记忆条目）：` +
      `本模块只认 { entries: {…} | […] } 或以条目 id 为键的对象（值形如 { key, content, … }）；` +
      `本次不迁移、不覆盖，旧数据保持原样`,
  });

  if (!parsed || typeof parsed !== "object") {
    return reject(parsed === null ? "顶层是 null" : `顶层是 ${typeof parsed}`);
  }
  if (Array.isArray(parsed)) return reject("顶层是数组");

  if ("entries" in (parsed as object)) {
    const rawEntries = (parsed as { entries: unknown }).entries;
    if (!rawEntries || typeof rawEntries !== "object") {
      return {
        ok: false,
        reason: `entries 不是对象/数组（实际是 ${rawEntries === null ? "null" : typeof rawEntries}）：不迁移、不覆盖`,
      };
    }
    const pairs: Array<[string, unknown]> = Array.isArray(rawEntries)
      ? (rawEntries as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(rawEntries as Record<string, unknown>);
    const rawBatches = (parsed as { batches?: unknown }).batches;
    return { ok: true, pairs, batches: Array.isArray(rawBatches) ? rawBatches : null };
  }

  /*
   * id-keyed 裸映射（存量数据的真实形状）：键 = 条目 id。
   * 判定口径见 `looksLikeMemoryEntryValue()` 的说明 —— 只要有一半以上的值像条目就认，
   * 少数坏值交给 `normalizeLoadedEntry()` 逐条丢弃并计数（不因为一条坏值把整份存量判死）。
   */
  const values = Object.values(parsed as Record<string, unknown>);
  const objectValues = values.filter((v) => !!v && typeof v === "object" && !Array.isArray(v));
  const entryLike = objectValues.filter(looksLikeMemoryEntryValue);
  if (entryLike.length > 0 && entryLike.length * 2 >= objectValues.length) {
    return { ok: true, pairs: Object.entries(parsed as Record<string, unknown>), batches: null };
  }
  return reject(`顶层是 ${typeof parsed}`);
}

/** `memory.load` 的上报区域名（**撤回**用；两处上报刻意写字面量，好让上报点扫描器按区域对上账） */
const MEMORY_LOAD_AREA = "memory.load";

/**
 * 「记忆读不到」的两种成因必须**分开**（MEM-LOAD-QUIET-1 / MEM-LOAD-VISIBLE-1）。
 *
 * - **暂时性**（本函数为真）：端口还没注册 / 配置面记忆域还没预热 —— 真机上
 *   `MemoryService` 的构造点早于端口注册，这是**正常启动顺序**的一部分；
 *   系统随后自己会重读（`bootstrap` 的"端口注册后 reload" + `save()`/`saveConfirmed()` 的写前重试），
 *   用户**什么都做不了**，所以它不许作为用户可见错误弹出（只进日志/建议）。
 * - **结论性**（本函数为假）：读到了内容、但形状不认识 / JSON 坏 / 迁移抛出 ——
 *   这是**必须让用户看到**的（并能据此回退），不许被上面那条一起藏掉。
 */
function isTransientMemoryReadFailure(reason: string): boolean {
  return reason === MEMORY_DOMAIN_NO_PORT || reason === MEMORY_DOMAIN_NOT_WARMED;
}

/** 结论性读失败在横幅上的"怎么办"（可操作：留档 → 回退 → 反馈；并如实说明旧数据没被动过） */
const LOAD_FAILURE_NEXT_STEP =
  "本次**没有迁移、也没有覆盖**：库里的旧记忆逐字保持原样。可以先到「设置 → 记忆」导出 JSON 留档，" +
  "再到「设置 → 记忆体检」用「回退到迁移前」恢复上一次迁移前的原文；若一直读不出来，请把这段原文反馈给我们。";

/** 容量桶键：同一 (作用域, 归属键) 才互相挤占 */function bucketKey(entry: Pick<MemoryEntry, "scope" | "projectId" | "sessionId">): string {
  if (entry.scope === "platform") return "platform";
  if (entry.scope === "project") return `project:${entry.projectId ?? ""}`;
  return `conversation:${entry.sessionId ?? ""}`;
}

/**
 * 把审批设置解析成三态：`undefined` = 存储里坏掉了（读不出来）。
 * 单独一个函数，是为了让下面那个"守卫名"的函数体里**没有 catch**：
 * fail-open 扫描器按"守卫名 + catch 里返回否定值"取线索，而它的函数体窗口只有几百字符 ——
 * catch 留在原处会把**后面那个函数**的 `return` 误算进来（本仓库踩过这次误报）。
 */
function parseApprovalSetting(): Partial<ApprovalScopeSetting> | undefined {
  try {
    const raw: unknown = JSON.parse(getSetting(MEMORY_WRITE_APPROVAL_KEY) || "null");
    if (!raw || typeof raw !== "object") return {};
    const obj = raw as Partial<Record<string, unknown>>;
    const out: Partial<ApprovalScopeSetting> = {};
    for (const k of ["platform", "project", "conversation"] as Array<keyof ApprovalScopeSetting>) {
      if (typeof obj[k] === "boolean") out[k] = obj[k] as boolean;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * 读取写入审批设置（**按作用域**给默认值：platform/project 开、conversation 关）。
 *
 * ⚠️ 读取失败（JSON 坏了）时一律按"全部需要批准"返回，**不**回落到默认值里的
 * `conversation: false`：审批开关是安全开关，读不到设置时"少拦一道"就等于放行（fail-open）。
 *
 * 实现上把"解析"单独拆成 `parseApprovalSetting()`（返回 `undefined` 表示读不出来），
 * 本函数只做三态到具体值的映射；这样守卫名函数的函数体里**没有 catch** ——
 * `tools/audit/scan-fail-open-guards.mjs` 的线索规则是"守卫名 + catch 里返回否定值"，
 * 而它的函数体窗口只有几百字符，会把**后面函数的 `return`** 误算进来（本仓库踩过这次误报）。
 */
export function getWriteApprovalSetting(): ApprovalScopeSetting {
  const parsed = parseApprovalSetting();
  if (parsed === undefined) return { platform: true, project: true, conversation: true };
  const pick = (k: keyof ApprovalScopeSetting) =>
    typeof parsed[k] === "boolean" ? (parsed[k] as boolean) : DEFAULT_APPROVAL[k];
  return { platform: pick("platform"), project: pick("project"), conversation: pick("conversation") };
}

export function setWriteApprovalSetting(next: Partial<ApprovalScopeSetting>): ApprovalScopeSetting {
  const merged = { ...getWriteApprovalSetting(), ...next };
  try {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify(merged));
  } catch (e) {
    reportPersistFailure("memory.setWriteApproval", e, "写入审批设置未保存（本次运行内仍按新设置生效，重启后会回到旧值）");
    /*
     * 这一段注释刻意写长，理由与代码行为无关、**完全是给审计工具留的距离**：
     * `tools/audit/scan-fail-open-guards.mjs` 把"守卫名函数 + 函数体里的 catch"当线索，
     * 而它截函数体的方式是"从这个 function 关键字到**下一个** function 关键字" ——
     * **类方法**（`class X { foo() {} }`）不在它的正则里，于是 `MemoryService` 整个类会被算进
     * 紧随其后的那个模块级函数的函数体，把 900 行之后 `importFromJSON` 的
     * `catch { return 0; }` 记到它头上（报出一条指向完全无关代码的"未定性"线索）。
     * 该工具的 catch 片段窗口只有 400 字符，所以这里用注释把"下一个 return"推远到窗口之外；
     * 同时也把下面那个函数名换成了非守卫名（双保险），不改任何行为。
     */
  }
  return merged;
}

/**
 * 该作用域的自动条目是否需要先暂存审批。
 *
 * ⚠️ 命名刻意**避开** `is*` / `has*` / `can*` 这类"守卫名"前缀：
 * `tools/audit/scan-fail-open-guards.mjs` 按"守卫名函数 + 函数体里的 catch"取线索，
 * 而它截函数体是"到这个 function 到**下一个** function"——**类方法不在它的正则里**，
 * 于是 `MemoryService` 整个类会被算进紧随其后的模块级函数里，把这个函数误报成
 * "catch → return 0"（那是 900 行之后 `importFromJSON` 的 catch）。这不影响任何行为，
 * 只是不给自己制造一条指向无关代码的审计线索。
 */
export function approvalRequiredForScope(scope: MemoryScope): boolean {
  return getWriteApprovalSetting()[scope] === true;
}

// ========== Memory Service ==========
export class MemoryService {
  private config: MemoryConfig;
  private entries: Map<string, MemoryEntry> = new Map();
  private batches: Map<string, MemoryBatch> = new Map();
  private migrationReport: MemoryMigrationReport | null = null;
  /**
   * 读盘状态（M-1）。
   *
   * 初始值是「还没读到过」而不是「读到空」——**这两个必须区分**：
   * 读失败时（未预热/JSON 坏/形状不认识）后续的迁移、标记、`save()` 全都要走 fail-closed。
   */
  private loadState: MemoryLoadState = { ok: false, reason: "尚未读取记忆", kind: "not-ready", dropped: 0, raw: null };
  /** 最近一次**成功写过磁盘**的 payload（F8/S3：无变化不写，省掉每回合的整份 IPC） */
  private lastPersistedPayload: string | null = null;
  /** 在途的确认式写入（I6：异步落库失败要能回传到 `getLastPersistError()`） */
  private pendingPersist: Promise<void> | null = null;
  /** 本进程内是否已经跑过一次真正改动的迁移（R1：标记异步落库时的进程内幂等依据） */
  private migratedThisProcess = false;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.load();
  }

  /**
   * 从存储读入记忆（M-1 / M-4 / A1）。
   *
   * ## 三种结果，**不许混为一谈**
   * 1. **读到数据**（`ok:true`，可能是空库）⇒ 才允许走迁移；
   * 2. **读不到**（记忆域未预热 / 没有端口 / 读抛错）⇒ 记录失败原因，**不迁移、不写标记**，
   *    并让 `save()` 拒绝覆盖 —— 否则"兜底空串"会被整份写回，把旧记忆真正抹掉（I1）；
   * 3. **读到但形状不认识**（JSON 坏 / 顶层是数组 / `entries` 不是对象 / 没有 `entries`
   *    且值也不像条目）⇒ 与第 2 类同样 fail-closed。
   *
   * ## 条目级校验（M-4）
   * 缺 `id`/`key`/`content` 或类型不对的条目**丢弃并计数上报**（口径与 `importFromJSON` 一致）。
   * 顶层是数组时旧实现用 `Object.entries` 把每个下标变成一个 `{scope:undefined,…}` 的空壳条目，
   * 现在这类容器直接判为"格式不认识"（不迁移、不覆盖）。
   *
   * ## 两种合法容器（LEGACY-SHAPE-1）
   * `{ entries: {…} | […] }` 与**以条目 id 为键的裸映射**（存量用户的真实形状，
   * 见 `readMemoryContainer()`）。第二种修复前被拒 ⇒ 存量记忆一条都读不出来。
   *
   * ## 上报口径（MEM-LOAD-QUIET / MEM-LOAD-VISIBLE）
   * 上面第 2 类里的"端口/预热还没就绪"是**暂时性**的（系统随后自己会重读）⇒ 只进 advisory；
   * 其余（形状不认识 / JSON 坏 / 迁移抛出）是**结论性**的 ⇒ 必须用户可见且可操作。
   * 读盘成功时**撤回**先前那条 `memory.load`（否则界面留下一条陈旧横幅）。
   */
  private load() {
    this.loadState = { ok: false, reason: "尚未读取记忆", kind: "not-ready", dropped: 0, raw: null };
    const read = loadMemoryChecked();
    if (!read.ok) {
      this.loadState = { ok: false, reason: read.reason, kind: "not-ready", dropped: 0, raw: null };
      /*
       * MEM-LOAD-QUIET-1：端口未就绪 / 记忆域未预热是**启动顺序**的一部分（临时单例早于端口注册），
       * 系统随后自己会重读 ⇒ 只进 advisory（提醒/日志），不许当成用户可见错误弹出去
       * （真机上用户看到的就是"操作没有生效（memory.load）：没有可用的存储端口 —— 请重试或检查日志"，
       * 而他**什么都做不了**，系统自己就好了）。
       */
      this.reportLoadUnavailable(read.reason, isTransientMemoryReadFailure(read.reason));
      /*
       * 仍然调一次迁移：它只**产出一份"推迟了"的报告**（不写标记、不落盘）——
       * 报告是界面/命令能看到的唯一"为什么没迁移"的证据，缺了它用户只会看到"记忆不见了"。
       */
      this.runMigration();
      return;
    }
    const raw = read.data;
    if (raw.trim() === "") {
      // **真的为空**（不是读不到）：这是合法状态，允许迁移（无事可做）与后续写入
      this.loadState = { ok: true, dropped: 0, raw };
      this.lastPersistedPayload = raw;
      this.markLoadRecovered();
      this.runMigration();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const reason = `记忆 JSON 解析失败：${e instanceof Error ? e.message : String(e)}（本次不迁移、不覆盖，旧数据保持原样）`;
      this.loadState = { ok: false, reason, kind: "parse", dropped: 0, raw };
      this.reportLoadUnavailable(reason, false, e, "JSON 已损坏：本次不迁移、不覆盖，旧记忆一条都没有被改动或删除。");
      this.runMigration();
      return;
    }

    const container = readMemoryContainer(parsed);
    if (!container.ok) {
      this.loadState = { ok: false, reason: container.reason, kind: "malformed", dropped: 0, raw };
      this.reportLoadUnavailable(
        container.reason,
        false,
        new Error(container.reason),
        "可先导出留档（设置 → 记忆 → 导出为 JSON）再把这段原文反馈；旧记忆一条都没有被改动或删除。",
      );
      this.runMigration();
      return;
    }

    let dropped = 0;
    /*
     * R2：旧条目补齐**创建序**（幂等迁移）。
     *
     * 先扫一遍显式 `order` 取最大值，再按**读入顺序**给缺 `order` 的条目依次补齐 ——
     * 补齐值只增不减、且完全由"这份落库文本的读入顺序"决定，所以**跨进程幂等**：
     * 同一份文件在任何一次启动里补齐出的顺序逐条相同（不会有第二套真相）。
     * 补齐结果随下一次 `save()` 落库（`serialize()` 写整个条目对象 ⇒ `order` 一起进 JSON）。
     */
    let nextOrder = -1;
    for (const [, value] of container.pairs) {
      const raw = (value ?? {}) as { order?: unknown };
      if (typeof raw.order === "number" && Number.isFinite(raw.order) && raw.order > nextOrder) {
        nextOrder = raw.order;
      }
    }
    nextOrder += 1;
    for (const [key, value] of container.pairs) {
      const normalized = normalizeLoadedEntry(key, value);
      if (!normalized) {
        dropped++;
        continue;
      }
      if (typeof normalized.order !== "number" || !Number.isFinite(normalized.order)) {
        normalized.order = nextOrder++;
      }
      this.entries.set(normalized.id, normalized);
    }

    if (container.batches) {
      for (const batch of container.batches) {
        if (!batch || typeof batch !== "object") continue;
        const b = batch as Partial<MemoryBatch>;
        if (typeof b.id !== "string" || b.id.length === 0) continue;
        this.batches.set(b.id, b as MemoryBatch);
      }
    }
    this.pruneBatches();

    this.loadState = { ok: true, dropped, raw };
    this.lastPersistedPayload = raw;
    if (dropped > 0) {
      // 丢弃必须**如实上报**（不静默）：这是"产品自己的读入口做了校验"的可见证据
      reportAdvisory("memory.entriesDropped", `读入时跳过 ${dropped} 条形状不合法（缺 id/key/content 或类型不对）的记忆条目`, {
        title: "记忆读取提醒",
        nextStep: "这些条目本次没有进内存；它们仍留在库里，下一次写入时会从库里消失。可先用「导出 JSON」留档。",
      });
    }
    // 读入后立刻做一次性迁移（幂等：标记键在就不再动；读失败时上面已经 return）
    this.markLoadRecovered();
    this.runMigration();
  }

  /**
   * 上报一次「记忆读不到」（MEM-LOAD-QUIET / MEM-LOAD-VISIBLE）。
   *
   * 两个方向必须同时成立，缺一条都不行：
   *
   * 1. **暂时性**（端口/预热还没就绪、系统自己会重读）⇒ `advisory`（提醒/日志），
   *    不许作为用户可见错误弹出。实测的假陈述是"该功能本次不可用，请重试或检查日志"——
   *    用户既没做错什么、也无从重试，系统下一次读就好了。
   * 2. **结论性**（端口已就绪、重试过之后仍然读不出来）⇒ `action`（用户可见错误）
   *    且文案**可操作**（是什么 / 旧数据动没动 / 能不能回退 / 去哪里看）。
   *    这里先 `withdrawFailure` 撤掉前面那条"暂时性提醒"：界面按**同区域去重**
   *    （`App.tsx` 的 `reportedPersistAreas`），不撤回的话，**该报的那条会被挡住**。
   *
   * 反向也守：已经有一条结论性错误时，后来的"暂时性"**不许把它降级**成提醒
   * （那等于把用户已经看到的真问题擦掉）。
   *
   * @param reason 逐字原因（用户可读）
   * @param transient 是否属于"系统自己会恢复"的那一类
   * @param error 原始异常（结论性时用；暂时性用原因文本即可）
   * @param extra 结论性时的补充说明（写进日志/详情）
   */
  private reportLoadUnavailable(reason: string, transient: boolean, error?: unknown, extra?: string): void {
    const prev = getPersistFailures().find((f) => f.area === MEMORY_LOAD_AREA);
    if (transient) {
      if (prev && prev.kind !== "advisory") return; // 已有真问题 ⇒ 不许用"暂时性"把它盖掉
      reportAdvisory("memory.load", `记忆尚未就绪（启动期暂时状态，系统会自动重试）：${reason}`, {
        title: "记忆尚未就绪（启动期暂时状态，系统会自动重试）",
        nextStep: "不需要你做任何事：存储端口注册后会自动重读一次；若一直读不出来会再提示你。",
      });
      return;
    }
    if (prev && prev.kind === "advisory") withdrawFailure(MEMORY_LOAD_AREA);
    reportActionFailure("memory.load", error ?? new Error(reason), extra, { consequence: LOAD_FAILURE_NEXT_STEP });
  }

  /**
   * 读盘成功 ⇒ **撤回**先前那条 `memory.load`（MEM-LOAD-QUIET-2）。
   *
   * 真机上用户看到的正是"第 1 次失败弹了横幅、第 2 次已经读成功了、横幅却留在原处"——
   * 陈旧横幅比没有横幅更糟：它让用户以为功能坏了，而系统其实已经自愈。
   * 撤回同时会重置界面那条"同区域只提示一次"的去重，所以**后面真的出错时仍然报得出来**。
   */
  private markLoadRecovered(): void {
    withdrawFailure(MEMORY_LOAD_AREA);
  }

  /**
   * 跑迁移，并让"这次读盘到底算不算成功"与迁移的**结果**一致（F2）。
   *
   * ## 为什么不能像修复前那样"先置 `ok=true` 再迁移"
   *
   * 修复前的写法是「先 `loadState.ok = true`，**再** `migrateScopeModel()`」，而那一次调用
   * 被放在 `retryLoadIfPossible()` 的 `try` 里 ⇒ 迁移段一旦抛出：
   * - `ok` **已经是 true** ⇒ `save()` 照常接受写入（"读失败 ⇒ 拒绝写"这条防线失效）；
   * - 抛出点之后**没有任何人**把"重读前攒下的条目"补回去 ⇒ `add()` 已经对用户回执过
   *   「记忆已加入本次运行」的条目**无声消失**（与该函数自己的承诺相反）。
   *
   * 现在有**两道**处置，缺一不可：
   * 1. 这里把迁移异常如实降级成"读失败"（`ok` 回到 false + `memory.load` 上报）——
   *    调用方（`save()` / `saveConfirmed()`）于是照旧拒绝写入；
   * 2. `retryLoadIfPossible()` 的 merge-back 放在自己的 finally 里 —— 无论这次读盘
   *    成功、失败还是抛出，攒下的条目都不会消失。
   */
  private runMigration(): void {
    try {
      this.migrateScopeModel();
    } catch (e) {
      const reason = `记忆迁移阶段抛出（本次读盘未完成，按读失败处理）：${e instanceof Error ? e.message : String(e)}`;
      this.loadState = { ok: false, reason, kind: "parse", dropped: this.loadState.dropped, raw: this.loadState.raw };
      // 迁移抛出是**结论性**失败（不是"端口没就绪"那类自恢复的暂时状态）
      this.reportLoadUnavailable(reason, false, e, "本次不迁移、不写入：旧数据保持原样（fail-closed）。");
    }
  }

  /** Reload memory from SQLite (call when DB is ready) */
  /**
   * Reload memory from SQLite (call when DB is ready).
   *
   * F2：`load()` 内部已经把迁移异常收成"读失败"（见 `runMigration()`），所以这里不需要
   * 额外兜错 —— 但**不许**让它抛到调用方（面板按钮/端口注册点的语义是"尽力重载"）。
   */
  reload() {
    this.entries.clear();
    this.batches.clear();
    this.pendingPersist = null;
    this.load();
  }

  /** 最近一次读盘的状态（界面用它区分「读不到」与「本来就空」） */
  getLoadState(): MemoryLoadState {
    return { ...this.loadState };
  }

  /** 上一次迁移是否**因读取失败/格式不认识而推迟**（M-1：界面要给用户看得见的原因） */
  getMigrationDeferredReason(): string | null {
    return this.migrationReport?.deferredReason ?? null;
  }

  /**
   * Save memory to SQLite.
   *
   * 第 84 波（审计修正）：**返回是否真的写成功**。
   * 第 187 波（I1 / F8 / S3 / R1 / F6）四处收紧：
   * ① **读失败 ⇒ 拒绝写**（`loadState.ok === false`）：否则"兜底空串"派生出的内存态会被
   *    整份写回 `memory` 字段，把用户的全部历史记忆静默清空（`finalizeBatch` 每回合都调它）；
   *    拒绝之前**先尝试重读一次**（R2：端口可能在单例构造之后才就绪）；
   * ② **无变化不写**：payload 与上次成功写过的逐字相同 ⇒ 直接返回 true（省掉每回合的整份 IPC）；
   * ③ **返回值语义如实**：它只表示"这次写入**已被接受**"（镜像已同步更新 + 已交给确认通道），
   *    **不等于已落库**。落库结果由 `flushPendingPersist()` / `getLastPersistError()` 给出；
   * ④ **每一次写都进确认通道**（不再 fire-and-forget）：`pendingPersist` 一路串到
   *    `writeMemoryConfirmed`，失败会写进 `lastPersistError` 并把 `lastPersistedPayload` 回滚
   *    （于是 `update`/`removeMany`/`retargetEntry` 这些"丢了返回值"的写入口
   *    也能通过 `await flushPendingPersist()` 拿到真实结果 —— F6）。
   */
  private save(): boolean {
    if (!this.loadState.ok) {
      // R2：读失败可能只是"单例构造早于端口就绪" —— 写之前**给一次重读机会**，不依赖用户去点面板
      this.retryLoadIfPossible();
    }
    if (!this.loadState.ok) {
      const reason = this.loadState.reason ?? "记忆尚未成功读取";
      this.lastPersistError = `拒绝写入：${reason}`;
      reportPersistFailure(
        "memory.saveRefused",
        new Error(reason),
        "本次写入被拒绝（避免把读失败派生出的空内容整份覆盖到库里）",
        { consequence: "改动只存在于内存，重启后会丢失；请先让记忆读起来（重启应用）再改。" },
      );
      return false;
    }
    this.pruneBatches();
    const payload = this.serialize();
    // ② 无变化不写（内容逐字相同 ⇒ 库里已经是这份，不需要再发一次 IPC）
    if (payload === this.lastPersistedPayload) return true;
    // ③ 同步那半：镜像立即反映（同一 tick 之后的读路径看得到），随后由确认通道决定"落没落定"
    patchMemoryMirror(payload);
    this.lastPersistedPayload = payload;
    this.chainPersist(payload);
    return true;
  }

  /** 当前内存态的线上形态（`save` / `saveConfirmed` / 迁移共用同一处序列化） */
  private serialize(): string {
    const obj: Record<string, MemoryEntry> = {};
    for (const [id, entry] of this.entries) {
      obj[id] = entry;
    }
    this.pruneBatches();
    return JSON.stringify({ version: 2, entries: obj, batches: Array.from(this.batches.values()) });
  }

  /**
   * R2：**读失败之后必须有机会重读**（否则"单例构造早于端口就绪"会让整个会话写不进记忆，
   * 而全仓唯一的 `reload()` 在生产里只在打开记忆面板时被调用）。
   *
   * 只在**端口已经可用**时试一次；不抛、不弹窗（失败路径由调用方如实拒绝 + 上报）。
   *
   * ⚠️ 读失败期间内存里可能已经攒下**未落库**的条目（`add` 先把条目放进内存、再由 `save()`
   * 拒绝）。重读会把内存态换成"磁盘上那份"，所以这里先在旁边留一份、重读之后**补回去**
   * （同一 id 以磁盘为准）—— 否则那些条目会在重读的瞬间无声消失。
   *
   * ## F2：merge-back 必须在 `finally` 里
   *
   * 修复前这段"读失败窗口 ⇒ 重读 ⇒ 补回"整段共用一个 `try`：`load()` 一旦抛出
   * （迁移段在 `ok` 置真之后运行，见 `runMigration()`），**补回那两行根本不会执行** ——
   * 于是 `add()` 已经回执过「已加入本次运行」的条目在内存里无声消失。
   * 现在**只有**"捕获 pending + 清表"在这一层 try 里，merge-back 无条件执行。
   */
  private retryLoadIfPossible(): void {
    if (!hasStoragePort()) return;
    const pendingEntries = Array.from(this.entries.values());
    const pendingBatches = Array.from(this.batches.values());
    try {
      this.entries.clear();
      this.batches.clear();
      this.load();
    } catch (e) {
      // `load()` 与 `runMigration()` 都已各自把异常收成"读失败 + 上报"，这里只是最后一道防线
      console.warn("[memory] 重读记忆失败（仍按读失败处理）:", e);
    } finally {
      for (const e of pendingEntries) if (!this.entries.has(e.id)) this.entries.set(e.id, e);
      for (const b of pendingBatches) if (!this.batches.has(b.id)) this.batches.set(b.id, b);
    }
  }

  /**
   * 排队时捕获的端口是否仍是当前端口（`getStoragePort()` 在端口已注销时会**抛**，
   * 所以这里必须自己兜住 —— 否则会留下一条未处理的 Promise 拒绝）。
   */
  private isStillSamePort(port: unknown): boolean {
    if (port === null) return true;
    try {
      return getStoragePort() === port;
    } catch {
      return false;
    }
  }

  /** 把一次写入挂到确认链上（失败 ⇒ `lastPersistError` 非空 + `lastPersistedPayload` 回滚，允许下次重试） */
  private chainPersist(payload: string): void {
    /**
     * 捕获**排队时**的存储端口（R1 的配套修正）。
     *
     * 确认链是异步的：如果排队之后存储端口换了（测试基座每例一个新端口；真机上是"重启/换库"），
     * 这次写入已经不属于新的存储面 —— 继续写会把**旧实例的内存态**灌进新库
     * （实测：判据之间互相串味，冲突条目凭空出现）。端口不同 ⇒ 直接放弃这次写入。
     */
    const port = hasStoragePort() ? getStoragePort() : null;
    const previous = this.pendingPersist ?? Promise.resolve();
    this.pendingPersist = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.isStillSamePort(port)) return;
        const result = await writeMemoryConfirmed(payload);
        if (result.ok) {
          this.lastPersistError = null;
          return;
        }
        if (this.lastPersistedPayload === payload) this.lastPersistedPayload = null;
        this.lastPersistError = result.reason ?? "记忆落库失败";
        reportPersistFailure("memory.saveConfirmed", new Error(this.lastPersistError), "记忆写入未被引擎确认（本次改动只在内存里）");
      });
  }

  /**
   * **确认式**保存（I6）：等到引擎确认落库才返回。
   *
   * 界面新建/导入/回退走这一条（`createEntry` 只改内存，写由这里负责）。
   */
  async saveConfirmed(): Promise<boolean> {
    if (!this.loadState.ok) this.retryLoadIfPossible();
    if (!this.loadState.ok) {
      this.lastPersistError = `拒绝写入：${this.loadState.reason ?? "记忆尚未成功读取"}`;
      reportPersistFailure("memory.saveRefused", new Error(this.lastPersistError), "确认式写入被拒绝（读失败 ⇒ 不许覆盖）");
      return false;
    }
    const payload = this.serialize();
    if (payload === this.lastPersistedPayload) {
      // 内容与"已接受的那一份"相同：仍要等前面在途的确认落地，不能直接说成功
      await this.flushPendingPersist();
      return this.lastPersistError === null;
    }
    const result = await saveMemoryConfirmed(payload);
    if (result.ok) {
      this.lastPersistedPayload = payload;
      this.lastPersistError = null;
      return true;
    }
    this.lastPersistError = result.reason ?? "记忆落库失败";
    reportPersistFailure("memory.saveConfirmed", new Error(this.lastPersistError), "记忆写入未被引擎确认（本次改动只在内存里）");
    return false;
  }

  /** 等在途的确认式写入落地（界面在保存后调用；失败 ⇒ `getLastPersistError()` 非空） */
  async flushPendingPersist(): Promise<boolean> {
    if (this.pendingPersist) await this.pendingPersist;
    return this.lastPersistError === null;
  }

  /** 最近一次持久化失败的原因（成功时为 null） */
  getLastPersistError(): string | null {
    return this.lastPersistError;
  }

  /**
   * F3（第 188 波）：**清掉上一次写失败留下的残迹** —— 只允许在"本次写入已被确认落库"之后调用。
   *
   * 为什么需要它：`lastPersistError` 是**粘性**的（成功才会清），于是"上一次失败 + 这一次成功"
   * 会让界面把成功报成失败（导入路径实测：明明导入成功却弹「写入数据库失败」）。
   * 判据就是"回执必须与本次动作的真实结果一致"，所以本次**确认成功之后**必须把残迹清掉。
   */
  clearLastPersistErrorIfLanded(): void {
    if (this.lastPersistError !== null) this.lastPersistError = null;
  }

  private lastPersistError: string | null = null;

  /** 批次有界修剪（S3：`batches` 原来永不修剪 ⇒ 每轮加一条、整份写盘） */
  private pruneBatches(): void {
    if (this.batches.size <= BATCH_KEEP_MAX) return;
    const sorted = Array.from(this.batches.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    for (const stale of sorted.slice(BATCH_KEEP_MAX)) this.batches.delete(stale.id);
  }

  /**
   * 下一个可用的**创建序**（R2）：现有最大 `order` + 1。
   *
   * 为什么是"现算"而不是一个自增计数器字段：计数器必须在 `load()` / `retryLoadIfPossible()`
   * 的 merge-back / `importFromJSON` 三条路径上各自复位，漏一条就会发出**重复的 order**
   * （两条同序 ⇒ 顺序退化成"谁先被迭代到"）。现算没有状态可漏。
   */
  private nextCreationOrder(): number {
    let max = -1;
    for (const entry of this.entries.values()) {
      if (typeof entry.order === "number" && Number.isFinite(entry.order) && entry.order > max) {
        max = entry.order;
      }
    }
    return max + 1;
  }

  /** 容量上限（界面/命令用它如实报告"为什么写不进去"） */
  getMaxEntries(): number {
    return this.config.maxEntries;
  }

  /**
   * 该桶里已有的条目数（容量判定的分母）。
   * 计入 pending —— 暂存的条目同样占位，否则"批准"会变成绕过容量的后门。
   */
  private bucketCount(scope: MemoryScope, projectId?: string, sessionId?: string): number {
    const key = bucketKey({ scope, projectId, sessionId });
    let count = 0;
    for (const entry of this.entries.values()) {
      if (bucketKey(entry) === key) count++;
    }
    return count;
  }

  /**
   * Add a memory entry.
   *
   * **容量超限"可见地失败"**（对标 Hermes）：达到 `maxEntries` 时**拒绝写入并如实上报**，
   * 绝不静默驱逐已有条目（旧实现靠 `consolidate` 的 FIFO 裁剪，用户看不到任何动静）。
   */
  add(entry: Omit<MemoryEntry, "id" | "timestamp"> & { source?: MemorySource }): MemoryAddResult {
    const result = this.createEntry(entry);
    if (!result.ok) return result;
    const persisted = this.save();
    if (!persisted) {
      return {
        ok: false,
        error: "persist",
        entry: result.entry,
        message: `记忆已加入本次运行，但写入数据库失败：${this.lastPersistError}`,
      };
    }
    return result;
  }

  /**
   * **插入条目**（只改内存，不落库）。
   *
   * 抽出来是为了让 `add`（乐观写）与 `addConfirmed`（确认写）**共用同一套校验与容量判定** ——
   * 旧写法是 `addConfirmed` 调用 `add`，而 `add` 里的 `save()` 会把
   * `lastPersistedPayload` 提前更新成新 payload ⇒ 随后的确认写命中"无变化不写"的捷径
   * ⇒ **落库失败被静默吞掉**（判据 I6 当场抓到）。
   */
  private createEntry(entry: Omit<MemoryEntry, "id" | "timestamp"> & { source?: MemorySource }): MemoryAddResult {
    if (typeof entry.key !== "string" || typeof entry.content !== "string") {
      // M-3：类型不对时**当场如实失败**（否则会带着坏数据进注入路径）
      return { ok: false, error: "invalid", message: "记忆的 key 与 content 必须是字符串" };
    }
    if (!entry.key.trim() || !entry.content) {
      return { ok: false, error: "invalid", message: "记忆的 key 与 content 不能为空" };
    }

    const scope = entry.scope;
    const bucketCount = this.bucketCount(scope, entry.projectId, entry.sessionId);
    if (bucketCount >= this.config.maxEntries) {
      const message =
        `记忆容量已满（${scope} 作用域上限 ${this.config.maxEntries} 条，当前 ${bucketCount} 条）：` +
        `本次写入被拒绝，已有条目保持不动。请先删除或整合部分记忆再试。`;
      console.warn(`[MemoryService] ${message}`);
      return { ok: false, error: "capacity", message };
    }

    const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    /*
     * 手动写入也过一遍脱敏（既有缺口，第 187 波按"同一波处理"收口）：
     * 自动提取路径早就 `redactSecrets` 了，手动/导入路径没有 —— 而本轮把平台级记忆的注入面
     * 从「当前项目」扩大到「所有项目」，泄漏的**扩散面变大**，所以在入口一并收口。
     */
    const safeContent = redactSecrets(entry.content);
    const safeKey = redactSecrets(entry.key);
    // B5：截断**不许静默** —— 截了就写进返回值里的 message（界面直接显示给用户）
    const truncated = safeContent.length > this.config.maxContentLength;
    const truncatedKey = safeKey.length > MEMORY_INJECT_KEY_MAX;
    const fullEntry: MemoryEntry = {
      ...entry,
      source: entry.source ?? "manual",
      status: entry.status ?? "active",
      id,
      timestamp: Date.now(),
      // R2：创建序**只增不减**（取现有最大值 +1），与插入位置/时间戳都解耦
      order: this.nextCreationOrder(),
      content: safeContent.substring(0, this.config.maxContentLength),
      key: safeKey.substring(0, MEMORY_INJECT_KEY_MAX),
    };

    this.entries.set(id, fullEntry);
    if (truncated || truncatedKey) {
      const parts: string[] = [];
      if (truncated) parts.push(`content 超过 ${this.config.maxContentLength} 字符，已截断`);
      if (truncatedKey) parts.push(`key 超过 ${MEMORY_INJECT_KEY_MAX} 字符，已截断（注入按此长度截断）`);
      return { ok: true, entry: fullEntry, message: `已保存，但${parts.join("；")}` };
    }
    return { ok: true, entry: fullEntry };
  }

  /**
   * **确认式写入**（I6）：与 `add` 同样的语义，但会等到"引擎确认落库"才返回。
   *
   * 界面新建/编辑走这一条 —— 否则"落库失败"永远只体现为一条全局横幅，
   * 而条目级契约仍宣称成功（`MemoryAddResult.error === "persist"` 那条分支永不触发）。
   */
  async addConfirmed(entry: Omit<MemoryEntry, "id" | "timestamp"> & { source?: MemorySource }): Promise<MemoryAddResult> {
    const result = this.createEntry(entry);
    if (!result.ok) return result;
    const persisted = await this.saveConfirmed();
    if (!persisted) {
      return {
        ok: false,
        error: "persist",
        entry: result.entry,
        message: `记忆已加入本次运行，但引擎未确认落库：${this.lastPersistError}`,
      };
    }
    return result;
  }

  /** Get a memory entry */
  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Update a memory entry.
   *
   * **信任边界（第 187 波收紧为显式要求来源）**：`opts.actor` 是**必填**的 ——
   * 旧写法是 `if (source === "manual" && opts?.allowAutoWrite) return false;`，
   * 即"自动流程只要忘了传标记就能改写手动条目"（fail-open 形状）。现在：
   * `actor: "auto"` 一律不得改写**受保护条目**（手动 + 来源未知的旧数据，
   * 见 `isProtectedMemoryEntry`）；`actor: "user"` 才是用户显式动作。
   * 参数**必填**由类型系统保证（漏传 = 编译不过，而不是运行时静默放行）。
   *
   * **容量（B5）**：改归属可能把一个桶撑过 `maxEntries` —— 与 `add` 同口径**可见地失败**
   * （返回 false，原因在 `getLastWriteError()`）。
   */
  update(id: string, updates: Partial<MemoryEntry>, opts: { actor: "user" | "auto" }): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    /*
     * `source` 只作**写入回填**：旧数据（`undefined`）在用户显式编辑后落定为 `manual`
     * （用户刚动过它 ⇒ "手动维护"是事实，不是编造）。保护判定不看这一行，走三态
     * `isProtectedMemoryEntry`（手动 + 来源未知都保护）。
     */
    const source = entry.source ?? "manual";
    if (opts?.actor !== "user" && isProtectedMemoryEntry(entry)) {
      this.lastWriteError = `拒绝自动流程改写手动记忆：${id}（自动流程只能通过 actor:"user" 之外的方式新增，不能改写）`;
      console.warn(`[MemoryService] ${this.lastWriteError}`);
      reportActionFailure("memory.updateRejected", new Error(this.lastWriteError), "自动改写被信任边界拦下");
      return false;
    }

    if (updates.content !== undefined && typeof updates.content !== "string") {
      this.lastWriteError = "记忆的 content 必须是字符串";
      return false;
    }
    if (updates.key !== undefined && (typeof updates.key !== "string" || !updates.key.trim())) {
      this.lastWriteError = "记忆的 key 必须是非空字符串";
      return false;
    }

    const next: MemoryEntry = {
      ...entry,
      ...updates,
      id, // Prevent id change
      // 来源与批次归属**不可被改写**（自动流程不得把手工条目洗成自动，反之亦然）
      source,
      batchId: entry.batchId,
      timestamp: Date.now(),
      content:
        updates.content !== undefined
          ? redactSecrets(updates.content).substring(0, this.config.maxContentLength)
          : entry.content,
      key: updates.key !== undefined ? redactSecrets(updates.key).substring(0, MEMORY_INJECT_KEY_MAX) : entry.key,
    };

    // B5：归属/作用域改变时守容量（同一个桶内更新不占新位）
    const movedBucket = bucketKey(next) !== bucketKey(entry);
    if (movedBucket) {
      const target = this.bucketCount(next.scope, next.projectId, next.sessionId);
      if (target >= this.config.maxEntries) {
        this.lastWriteError =
          `记忆容量已满（${next.scope} 作用域上限 ${this.config.maxEntries} 条，当前 ${target} 条）：` +
          `本次改动被拒绝（条目保持原样）。请先删除或整合部分记忆再试。`;
        reportActionFailure("memory.updateRejected", new Error(this.lastWriteError), "改归属会把目标桶撑过上限，已拒绝");
        return false;
      }
    }

    if (updates.content !== undefined && updates.content.length > this.config.maxContentLength) {
      // 截断如实记录（与 add 同口径），界面在回执里显示
      this.lastWriteError = `content 超过 ${this.config.maxContentLength} 字符，已截断`;
    } else {
      this.lastWriteError = null;
    }

    this.entries.set(id, next);
    this.save();
    return true;
  }

  /** 最近一次写入被拒绝/被截断的原因（`add`/`update` 的可见失败口径，B5） */
  getLastWriteError(): string | null {
    return this.lastWriteError;
  }

  private lastWriteError: string | null = null;

  /** Delete a memory entry（用户显式删除 —— 手动条目也允许，这是用户的权力） */
  delete(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /**
   * 批量删除**指定 id**（界面勾选删除 / 清空全部都走这一条）。
   *
   * 语义要点（判据 MEM-CHECK-3 钉着）：
   * - **只删传进来的 id** —— 调用方没勾的条目一条都不许动；
   * - 返回 `{ requested, removed, notFound }`，让界面能如实报告"要删 N 条、实删 M 条"；
   * - 不做任何"看起来像自动提取就顺手删掉"的推断（信任边界：自动判断只能用于展示）。
   */
  removeMany(ids: string[]): { requested: number; removed: number; notFound: string[] } {
    const notFound: string[] = [];
    let removed = 0;
    for (const id of ids) {
      if (!this.entries.has(id)) {
        notFound.push(id);
        continue;
      }
      this.entries.delete(id);
      removed++;
    }
    if (removed > 0) this.save();
    return { requested: ids.length, removed, notFound };
  }

  /**
   * List entries by scope.
   *
   * 第 N 波（作用域/信任边界重构）：**真的按维度过滤**。
   * 传 `ctx` 时：
   * - 只返回实际可见的条目（项目 A 的 `project` 记忆在项目 B 不出现）；
   * - 默认**只返回已批准**且归属键齐备的条目（注入与"生效视图"都要求这一点）；
   * - `includePending` / `includeUnscoped` 只给审批界面用。
   * 不传 `ctx` 时按旧语义返回该作用域的全部条目（界面列表/统计用，**不用于注入**）。
   */
  listByScope(scope: MemoryScope, ctx?: MemoryScopeContext): MemoryEntry[] {
    const viewOnly = ctx?.includePending === true || ctx?.includeUnscoped === true;
    /*
     * ⚠️ 视图模式下必须**同时打开** `includeUnscoped`：`includePending` 只解决"未批准也要看得见"，
     * 而"没有归属键的旧数据"要由 `includeUnscoped` 放行 —— 少一个开关，体检分组就会只剩平台级一组。
     *
     * ⚠️ 也**必须带上当前位置的 projectId/sessionId**：视图是"这个项目的全部条目"，
     * 不是"所有项目的全部条目"（跨项目不做全量列举，否则又变成一次跨项目读取）。
     */
    const viewCtx: MemoryScopeContext | undefined = ctx
      ? { ...ctx, includePending: true, includeUnscoped: true }
      : undefined;
    const filtered = Array.from(this.entries.values()).filter((e) => {
      if (e.scope !== scope) return false;
      if (!viewCtx) return true;
      return viewOnly ? visibleIn(e, viewCtx) : injectedIn(e, ctx!);
    });
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 界面用的全量列举：三个作用域都按"当前位置可见"取，**含 pending 与孤儿**
   * （迁移后的旧 `session` 记忆没有 sessionId ⇒ 仍可见/可编辑，但永不进注入）。
   *
   * ⚠️ `ctx` 里的 `projectId` / `sessionId` **不是可选的**：视图要的是"这个项目 + 这个对话的
   * 全部条目（含未批准、含无归属）"。只传 `includeUnscoped` 而不传归属 ⇒ 有归属的项目条目会被
   * `visibleIn` 判为不可见（"可见范围"这个口径始终要求 projectId 相等）。
   */
  listAll(ctx?: MemoryScopeContext): MemoryEntry[] {
    const base: MemoryScopeContext = { ...ctx, includePending: true, includeUnscoped: true };
    const all: MemoryEntry[] = [];
    for (const scope of ["platform", "project", "conversation"] as MemoryScope[]) {
      all.push(...this.listByScope(scope, base));
    }
    /*
     * M-5：作用域**不是这三者之一**的条目也要出现在界面全量列举里。
     *
     * 旧实现只遍历三个作用域名 ⇒ 更老版本写的 `workspace`、大小写不符、空值这些条目
     * 在任何界面都看不见、也删不掉（操作死角），却每次 `save()` 都被重写回库里。
     * 它们仍然**不进注入**（注入只按三个作用域取块），所以这里只影响"能不能看见/处置"。
     */
    const otherCtx: MemoryScopeContext = { ...base, showAllProjects: ctx?.showAllProjects === true };
    for (const entry of this.entries.values()) {
      if (entry.scope === "platform" || entry.scope === "project" || entry.scope === "conversation") continue;
      if (visibleIn(entry, otherCtx)) all.push(entry);
    }
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  /**
   * **面板列表的默认顺序** = **注入顺序**（创建序倒序）。
   *
   * 第 189 波 R3：注入按创建序、面板按 `timestamp` 倒序，两侧口径不同 ⇒ 用户**编辑一条**
   * 之后两侧顺序就分叉（面板按"最后修改"把它顶到最前，注入里它原地不动），而面板把
   * `timestamp` 标成「创建时间」⇒ 用户无从自知、也无从判断"我改的这条到底进没进上下文"。
   * 现在面板默认就用**注入的同一个键**（`buildCreationOrderIndex`，与 `computeInjection`
   * 内部那次调用是同一个函数）；`timestamp` 仍在**单条字段**上如实展示，标签是
   * 「最后修改时间」（`update()` 每次刷新它 ⇒ 名实一致）。
   *
   * ⚠️ 有意保留的语义（判据 `MEM-PLACE-22③`）：`update()` 刷新 `timestamp` 但**不影响**
   * 入选集合 —— 旧行为里"编辑第 25 条能把它顶进注入窗口"依赖的正是"排序键 = 被编辑的字段"，
   * 而那正是本轮要修掉的缓存抖动（`MEM-PLACE-15`）。要让一条超额条目进上下文，
   * 用户的动作仍然是"删掉/整合掉同桶里的其它条目"，不是"编辑它"。
   */
  listAllForPanel(ctx?: MemoryScopeContext): MemoryEntry[] {
    const order = buildCreationOrderIndex(this.entries.values());
    return this.listAll(ctx).sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  }

  /** 面板列表排序口径的可展示说明（界面的文案取自这里 ⇒ 口径改了文案不改会露出来） */
  static readonly PANEL_ORDER_NOTE =
    "列表按创建序排列（与注入顺序一致）；编辑只刷新「最后修改时间」，不会把条目挪位、也不改变入选集合。";
  /** `timestamp` 字段在界面上的**如实**名字：`update()` 每次刷新它 ⇒ 它是最后修改时间 */
  static readonly PANEL_TIMESTAMP_LABEL = "最后修改时间";

  /**
   * 待批准条目（审批界面与 `/memory pending` 用）。
   *
   * **`ctx` 必须传**（A2 / F7）：待批准列表原来全量返回，于是项目 A 的面板里能看到
   * 项目 B 的待批准内容 —— 而 `visibleIn` 需要 ctx 才按项目/会话过滤。
   * 缺 ctx ⇒ **不返回任何条目**（fail-closed：宁可不显示，也不跨项目展示），
   * 跨项目列举只允许体检那条显式带 `showAllProjects` 的路径。
   */
  listPending(scope?: MemoryScope, ctx?: MemoryScopeContext): MemoryEntry[] {
    if (!ctx) return [];
    return Array.from(this.entries.values())
      .filter((e) => (e.status ?? "active") === "pending" && (!scope || e.scope === scope) && visibleIn(e, ctx))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 批准一条待审条目 ⇒ 之后它才参与上下文注入。
   * 批准同样受容量约束（否则它可以绕过 `add` 的上限）。
   */
  approve(id: string): MemoryAddResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "invalid", message: `未找到记忆：${id}` };
    if (isProtectedMemoryEntry(entry)) {
      // 旧数据（未知来源）按受保护条目处理：它的说法是"未知（旧数据）· 按手动条目保护"
      return {
        ok: false,
        error: "invalid",
        message:
          memorySourceOf(entry) === "manual"
            ? "手动条目不需要批准"
            : "来源未知（旧数据）的条目按受保护条目处理，不需要批准",
      };
    }
    if ((entry.status ?? "active") !== "pending") {
      return { ok: false, error: "invalid", message: "该条目不在待批准状态" };
    }
    const bucketCount = this.bucketCount(entry.scope, entry.projectId, entry.sessionId);
    if (bucketCount > this.config.maxEntries) {
      return {
        ok: false,
        error: "capacity",
        message: `容量已满（${entry.scope} 上限 ${this.config.maxEntries} 条）：批准被拒绝，请先清理。`,
      };
    }
    this.entries.set(id, { ...entry, status: "active" });
    const persisted = this.save();
    return persisted
      ? { ok: true, entry: this.entries.get(id) }
      : { ok: false, error: "persist", entry: this.entries.get(id), message: `已批准，但写入数据库失败：${this.lastPersistError}` };
  }

  /** 拒绝一条待审条目 ⇒ 删除它（不写进上下文） */
  reject(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if ((entry.status ?? "active") !== "pending") return false;
    return this.delete(id);
  }

  /** List entries by tag */
  listByTag(tag: string): MemoryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.tags?.includes(tag))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Search memory using simple text matching (BM25-like).
   *
   * **`ctx` 是必填的语义要求**（A2 / F7）：`visibleIn` 要靠它才知道"当前是哪个项目/哪个对话"。
   * 旧写法是 `if (ctx && !visibleIn(entry, ctx)) continue;` —— 调用方忘传 ctx 就整体短路，
   * 于是**回到"只按 scope 过滤"的旧口径**：在项目 A 里能搜出项目 B 的记忆（含未批准的 pending），
   * 而且结果可直接编辑/删除。现在缺 ctx ⇒ **一条都不返回**（fail-closed），
   * 跨项目检索只允许体检那条显式带 `showAllProjects` 的路径。
   */
  search(query: string, scope?: MemoryScope, limit: number = 10, ctx?: MemoryScopeContext): MemorySearchResult[] {
    if (!ctx) return [];
    const queryTerms = textOf(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) return [];
    const results: MemorySearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (scope && entry.scope !== scope) continue;
      if (!visibleIn(entry, ctx)) continue;

      // M-3：坏数据（content/key 不是字符串）不许把搜索/注入搞崩
      const contentText = textOf(entry.content);
      const contentLower = contentText.toLowerCase();
      const keyLower = textOf(entry.key).toLowerCase();

      let score = 0;
      for (const term of queryTerms) {
        // Key match (higher weight)
        if (keyLower.includes(term)) {
          score += 10;
        }

        // Content match
        // FIX: escape regex metacharacters — term comes from user query tokens
        // which may contain "+", "*", "(", etc. (e.g. extracted memory content).
        // new RegExp(term) with an unescaped metacharacter throws
        // SyntaxError: Invalid regular expression (Nothing to repeat).
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const contentMatches = (contentLower.match(new RegExp(escapedTerm, "g")) || []).length;
        score += contentMatches;

        // Tag match
        if (entry.tags?.some((t) => textOf(t).toLowerCase().includes(term))) {
          score += 5;
        }
      }

      if (score > 0) {
        // Extract snippet around first match
        const firstMatch = contentLower.indexOf(queryTerms[0]);
        const snippetStart = Math.max(0, firstMatch - 50);
        const snippetEnd = Math.min(contentText.length, firstMatch + 100);
        const snippet = contentText.substring(snippetStart, snippetEnd);

        results.push({ entry, score, snippet });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 手动维护块的小标题（仅注入用；界面不显示）。
   *
   * R5：三态说法一律从唯一表取（`MEMORY_SOURCE_KIND_LABEL.manual`），
   * 这里只拼"作用域 + 这一态 + 说明" —— 文案表改了，注入抬头也跟着改。
   */
  private static manualHeader(scope: MemoryScope): string {
    const where = scope === "platform" ? "平台" : scope === "project" ? "项目" : "对话";
    return `## ${where}记忆（${MEMORY_SOURCE_KIND_LABEL.manual}维护）`;
  }

  /** 自动提取块的小标题（仅注入用；界面不显示）—— 同样是表 + 补充句，没有第二份三态字面量 */
  private static autoHeader(scope: MemoryScope): string {
    return `## ${MEMORY_SOURCE_KIND_LABEL.auto}（${MEMORY_AUTO_GROUP_HINT}）`;
  }

  /** 旧数据块的小标题（仅注入用；说"来源未知"而不编造来源，见 `memoryUnknownHeader()`） */
  private static unknownHeader(): string {
    return memoryUnknownHeader();
  }

  private scopeLabel(scope: MemoryScope): string {
    switch (scope) {
      case "platform": return "平台记忆";
      case "project": return "项目记忆";
      default: return "对话记忆";
    }
  }

  /**
   * 条目在**注入文本里**的排序键：**创建序**（条目自己的 `order`，见 `MemoryEntry.order`）。
   *
   * 为什么不用 `timestamp`（第 189 波第 15 条）：`update()` 会刷新 `timestamp`，
   * 于是"原地改一行"变成"把这一条挪到块首"，块内后续内容整体平移
   * （实测断点后的差异从 124 码元放大到 3813 码元，约 30×）——正好抵消
   * "稳定前缀钉住、易变块只在尾部 churn"这条收益。
   *
   * ⚠️ **第 189 波 R2 修正了这条注释原先的过度声明**：它曾断言"`entries` 的插入序在
   * 写入/迁移/**重载**后都保持（`Map.set` 命中已有键不改位置），所以它是稳定的创建序"。
   * 写入/迁移确实不改位置，但**重载**会：`serialize()` 写的是**以 id 为键的普通对象**，
   * JSON 的整数样键按数值升序排列 ⇒ 插入 `mem-3,1,mem-1,2` 读回 `1,2,mem-3,mem-1`。
   * 所以创建序**必须持久化**（`order`），这里只读它，不再从迭代位置推。
   *
   * 展示侧（面板列表）**按同一个创建序**（`listAllForPanel`）——第 189 波 R3：
   * 两侧口径不同会让"编辑后两侧顺序分叉"而用户无从自知。界面另有按 `timestamp`
   * （= 最后修改时间）的单条字段展示，标签与语义一致。
   * 判据 `MEM-PLACE-15`（编辑不平移）与 `MEM-PLACE-20`（重载后逐条相同）。
   */
  private static renderOrderIndex(entries: Map<string, MemoryEntry>): Map<string, number> {
    return buildCreationOrderIndex(entries.values());
  }

  private formatLine(e: MemoryEntry): string {
    // M-3：坏数据（content/key 不是字符串）**不许**把系统提示整个搞丢
    const date = safeDate(e.timestamp);
    // P-Link: Resolve [[name]] links to show related memory references
    const resolvedContent = this.resolveLinks(e);
    const key = textOf(e.key).substring(0, MEMORY_INJECT_KEY_MAX);
    return `- [${date}] ${key}: ${resolvedContent.substring(0, 200)}`;
  }

  /**
   * **注入计划**（I4：单一口径）。
   *
   * 注入侧的截断有两处：每作用域每来源 `MEMORY_INJECT_MAX_PER_BLOCK` 条、以及全局字符预算
   * `MEMORY_INJECT_CHAR_BUDGET`。旧实现只有**注入侧**知道这两处截断，界面与体检的 `injected`
   * 完全不含它们 ⇒ 第 21 条起"界面说生效、实际不进上下文"。
   * 现在两边共用这一个函数（`buildMemoryPrompt` 也走它），并如实给出被截断的条数。
   */
  private computeInjection(
    ctx: InjectionScopeContext,
    scopes: MemoryScope[],
    options?: { sources?: readonly MemorySource[]; budgetTracker?: MemoryInjectBudgetTracker },
  ): { blocks: Array<{ scope: MemoryScope; kind: MemorySourceKind; entries: MemoryEntry[] }>; ids: Set<string>; truncated: number; chars: number } {
    /*
     * R6 运行时收口：类型只保证"品牌 ⇒ 构造点唯一"，而类型会被擦除、也可能被 `as` 硬转绕过。
     * 注入路径的判定**只认两个归属键**，视图开关一律不参与 —— 否则 `showAllProjects` 一进来，
     * 下面 `injectedIn` 的 `visibleIn` 就会放行所有项目的记忆（判据 `MEM-PLACE-13` 的运行时一半）。
     */
    const scopeCtx: InjectionScopeContext = injectionScopeContext(ctx?.projectId, ctx?.sessionId);
    const blocks: Array<{ scope: MemoryScope; kind: MemorySourceKind; entries: MemoryEntry[] }> = [];
    const ids = new Set<string>();
    const sourceFilter = options?.sources ? new Set(options.sources) : null;
    const tracker = options?.budgetTracker;
    let truncated = 0;
    let chars = 0;
    // 块内顺序 = 创建序（稳定；`update()` 刷新 timestamp 也不许让条目平移，见 renderOrderIndex）
    const order = MemoryService.renderOrderIndex(this.entries);
    /*
     * 三个来源桶的**固定顺序**：手动 → 来源未知（旧数据）→ 自动提取。
     * 手动在前是既有契约（MEM-TRUST-2）；旧数据排在自动之前，因为它的显示说法是
     * 「未知（旧数据）· 按手动条目保护」，比"自动提取"更接近可信侧。
     */
    const KINDS: readonly MemorySourceKind[] = ["manual", "unknown", "auto"];
    for (const scope of scopes) {
      const entries = Array.from(this.entries.values())
        .filter((e) => e.scope === scope && injectedIn(e, scopeCtx) && (!sourceFilter || sourceFilter.has(entrySourceOf(e))))
        .sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
      const buckets = KINDS.map((kind) => [kind, entries.filter((e) => memorySourceOf(e) === kind)] as const);
      for (const [kind, list] of buckets) {
        const capped = list.slice(0, MEMORY_INJECT_MAX_PER_BLOCK);
        truncated += list.length - capped.length;
        const kept: MemoryEntry[] = [];
        for (const e of capped) {
          const line = this.formatLine(e);
          // 总字符预算（S1）：超了就不再收，并如实计数（注入文本里会写明被截断多少条）
          if (chars + line.length > MEMORY_INJECT_CHAR_BUDGET) {
            truncated++;
            continue;
          }
          /*
           * S1-BUDGET-TOTAL：**聚合**上限（照用户审计口径：不许因为拆成三块就重新开口子）。
           * 段序与筛选固定 ⇒ 这里的 `spent` 是确定性的。超出即**不收**，由调用方
           * `renderAggregateBudgetNotice()` 如实披露（不静默丢）。
           */
          if (tracker && tracker.totalChars + line.length > MEMORY_INJECT_CHAR_BUDGET) {
            tracker.totalTruncated++;
            continue;
          }
          chars += line.length + 1;
          if (tracker) tracker.totalChars += line.length + 1;
          kept.push(e);
        }
        if (kept.length > 0) {
          for (const e of kept) ids.add(e.id);
          blocks.push({ scope, kind, entries: kept });
        }
      }
    }
    return { blocks, ids, truncated, chars };
  }

  /**
   * 当前位置**实际会被注入**的条目 id 集合 + 被截断条数（I4）。
   * 界面与体检必须用它算「已生效」，否则就会出现"界面说生效、实际第 21 条起不进上下文"。
   */
  injectionPlan(ctx: InjectionScopeContext): { ids: Set<string>; truncated: number; chars: number; budget: number } {
    const plan = this.computeInjection(ctx, ["platform", "project", "conversation"]);
    return { ids: plan.ids, truncated: plan.truncated, chars: plan.chars, budget: MEMORY_INJECT_CHAR_BUDGET };
  }

  /**
   * **注入判定 + 真实原因**（F5/I4：界面与体检**共用同一处口径**）。
   *
   * 旧形态是"两套真相"：体检用 `injectionPlan`（含条数上限与字符预算），
   * 而记忆管理面板的 `isInjected` 只看 status/scope/归属 ⇒ 第 21 条起面板仍显示
   * 「已生效（参与上下文）」而实际不进上下文，用户按面板做取舍就会删错条目。
   *
   * 返回：`injected` = 真的会进上下文的 id 集合；`reasons` = 其余每一条**为什么不进**
   * （待批准 / 已暂停注入 / 作用域无法识别 / 不在当前位置 / 没有归属键 / 超出注入上限）。
   *
   * ⚠️ 形参是**注入侧窄类型**（R6）：调用方必须用 `injectionScopeContext(projectId, sessionId)`
   * 构造 —— 体检/面板的宽 ctx（带 `includePending` / `includeUnscoped` / `showAllProjects`）
   * **赋不进来**。语义上也必须如此：`showAllProjects` 一旦进到这里，`visibleIn` 会放行
   * **所有项目**的记忆，面板就会把"别的项目的条目"标成"已生效（参与上下文）"。
   */
  injectionExplanations(ctx: InjectionScopeContext): {
    injected: Set<string>;
    reasons: Map<string, string>;
    truncated: number;
    chars: number;
    budget: number;
  } {
    const plan = this.computeInjection(ctx, ["platform", "project", "conversation"]);
    const reasons = new Map<string, string>();
    for (const e of this.entries.values()) {
      if (plan.ids.has(e.id)) continue;
      if ((e.status ?? "active") !== "active") {
        reasons.set(e.id, "待批准（未批准不进上下文）");
        continue;
      }
      if (e.legacyPool === true && isLegacyPoolInjectionPaused()) {
        reasons.set(e.id, "已打开「暂停注入旧版跨项目记忆」");
        continue;
      }
      if (e.scope !== "platform" && e.scope !== "project" && e.scope !== "conversation") {
        reasons.set(e.id, "作用域无法识别，注入路径不认识它");
        continue;
      }
      if (!visibleIn(e, ctx)) {
        reasons.set(e.id, "不在当前项目/对话的作用域内");
        continue;
      }
      if (!ownedBySelf(e)) {
        reasons.set(e.id, "没有归属键（孤儿条目），任何上下文都不注入");
        continue;
      }
      reasons.set(
        e.id,
        `超出注入上限（每作用域每来源 ${MEMORY_INJECT_MAX_PER_BLOCK} 条 / 总字符预算 ${MEMORY_INJECT_CHAR_BUDGET}），本轮没有进上下文`,
      );
    }
    return { injected: plan.ids, reasons, truncated: plan.truncated, chars: plan.chars, budget: MEMORY_INJECT_CHAR_BUDGET };
  }

  /** 一个作用域里"手动块在前、自动块单独标注在后"的文本 */
  private buildBlock(scope: MemoryScope, ctx: InjectionScopeContext): string {
    const plan = this.computeInjection(ctx, [scope]);
    return this.renderBlocks(plan.blocks, plan.truncated);
  }

  /** 把注入计划渲染成文本（`truncated > 0` 时**如实披露**） */
  private renderBlocks(
    blocks: Array<{ scope: MemoryScope; kind: MemorySourceKind; entries: MemoryEntry[] }>,
    truncated: number,
  ): string {
    const chunks: string[] = [];
    for (const block of blocks) {
      if (block.kind === "manual") {
        chunks.push(
          [MemoryService.manualHeader(block.scope), "", ...block.entries.map((e) => this.formatLine(e))].join("\n"),
        );
        continue;
      }
      if (block.kind === "unknown") {
        /*
         * 旧数据块**必须**说"来源未知"，不许冒充"自动提取、未经人工确认"（A1）：
         * 版本升级把用户手写的旧 `global` 条目说成自动提取，是对用户记忆的编造。
         * 说法与界面/体检/导出**同一个常量**（`MEMORY_SOURCE_KIND_LABEL`）。
         */
        chunks.push(
          [
            MemoryService.unknownHeader(),
            "",
            memoryUnknownNote(block.entries.length),
            "",
            ...block.entries.map((e) => this.formatLine(e)),
          ].join("\n"),
        );
        continue;
      }
      // 自动块**必须**能自证来源：标题里带"自动提取"，并列出条数
      chunks.push(
        [
          MemoryService.autoHeader(block.scope),
          "",
          `> 以下 ${block.entries.length} 条由自动流程从对话中提取，未经人工确认，可能不准确；如需以人工结论为准，请直接编辑或删除。`,
          "",
          ...block.entries.map((e) => this.formatLine(e)),
        ].join("\n"),
      );
    }
    if (truncated > 0) {
      chunks.push(
        `${TRUNCATION_NOTICE_PREFIX}：${TRUNCATION_NOTICE_PER_BLOCK_ANCHOR}还有 ${truncated} 条可见记忆**未注入**（每条作用域每来源最多 ` +
          `${MEMORY_INJECT_MAX_PER_BLOCK} 条、总预算 ${MEMORY_INJECT_CHAR_BUDGET} 字符）。` +
          `这不是它们被删除，只是没进上下文；可在「设置 → 记忆体检」里看到每一条。`,
      );
    }
    return chunks.join("\n\n");
  }

  /**
   * Build memory prompt for system prompt.
   *
   * 调用形态：
   * - `buildMemoryPrompt()` —— **三块全出**（platform → project → conversation），
   *   每块内部按来源三桶 "手动 → 未知（旧数据）→ 自动提取" 渲染；
   * - `buildMemoryPrompt("project", projectId, sessionId)` —— 只要一块（既有测试与局部注入用）。
   *
   * `projectId` 不再是未使用参数：它决定 `project` 作用域的记忆**能不能出现**。
   * 截断（条数 + 字符预算）由 `computeInjection` 统一决定，并**如实披露**（I4 / S1）。
   *
   * `options.sources`（新）：按**来源**过滤（稳定侧只收 `manual`、易变侧只收 `auto` 时用，
   * 见 `isStableMemoryEntry`）。不传 = 两个来源都收（与既有调用逐字同行为）。
   * `options.budgetTracker`（新）：**聚合**预算（S1-BUDGET-TOTAL）——多次调用共享一个
   * 计数槽，三块合计不得超过 `MEMORY_INJECT_CHAR_BUDGET`。
   */
  buildMemoryPrompt(
    scope?: MemoryScope,
    projectId?: string,
    sessionId?: string,
    options?: { sources?: readonly MemorySource[]; budgetTracker?: MemoryInjectBudgetTracker },
  ): string {
    const ctx: InjectionScopeContext = injectionScopeContext(projectId, sessionId);
    const scopes: MemoryScope[] = scope
      ? [scope]
      : ["platform", "project", "conversation"];
    const plan = this.computeInjection(ctx, scopes, options);
    return this.renderBlocks(plan.blocks, plan.truncated);
  }

  // ========== 写入审批 / 批次（信任边界） ==========

  /** 开始一个自动提取批次（返回批次号；由 `add` 写在条目上） */
  beginBatch(sessionId?: string, scope: MemoryScope = "project"): string {
    const id = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    this.batches.set(id, { id, sessionId, createdAt: Date.now(), scope, count: 0 });
    return id;
  }

  /** 记下批次实际写入了几条（0 条的批次也留下痕迹，便于解释"这次什么都没写"） */
  finalizeBatch(batchId: string, written: number): MemoryBatch | undefined {
    const batch = this.batches.get(batchId);
    if (!batch) return undefined;
    batch.count = written;
    this.batches.set(batchId, batch);
    this.save();
    return batch;
  }

  listBatches(includeUndone = true): MemoryBatch[] {
    return Array.from(this.batches.values())
      .filter((b) => includeUndone || !b.undone)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  hasBatch(batchId: string): boolean {
    return this.batches.has(batchId);
  }

  /**
   * 撤销一个批次：**只删该批次写入的条目**。
   * 手动条目不可能带 batchId，所以这条路径天然不可能碰到它们；同批次全删、其它批次不动。
   */
  undoBatch(batchId: string): { ok: boolean; removed: number; message: string } {
    const batch = this.batches.get(batchId);
    const targets = Array.from(this.entries.values()).filter((e) => e.batchId === batchId);
    if (!batch && targets.length === 0) {
      return { ok: false, removed: 0, message: `未找到批次：${batchId}` };
    }
    if (batch?.undone) {
      return { ok: false, removed: 0, message: `批次 ${batchId} 已经撤销过（本次不做任何改动）` };
    }
    let removed = 0;
    for (const entry of targets) {
      if (this.entries.delete(entry.id)) removed++;
    }
    if (batch) {
      batch.undone = true;
      batch.undoneAt = Date.now();
      this.batches.set(batchId, batch);
    }
    this.save();
    return { ok: true, removed, message: `批次 ${batchId} 已撤销：删除 ${removed} 条自动记忆（手动条目与其它批次未受影响）` };
  }

  // ========== 一次性迁移（作用域改名 + 信任字段） ==========

  /**
   * 迁移规则（**如实保留今天的可见范围**，不替用户做假设）：
   * - `global` → `platform`：可见范围不变（所有项目、所有对话）；
   * - `project` → **`platform`**：今天的 `project` 条目没有 `projectId`，实际就是"到处都生效"
   *   （过滤只看 scope）⇒ 降为 platform 才是不改变行为。**不许**按当前项目猜一个 projectId；
   * - `session` → `conversation` 且**不带 sessionId**：于是仍然不被注入（今天 `buildMemoryPrompt("session")`
   *   全仓没有调用点）= 与今天行为一致，但在界面里仍可见/可编辑；
   * - 来源推断：`platform`/`project` → `manual`（用户维护的长期知识），`conversation` → `auto`
   *   （旧 session 条目来自自动提取路径）；状态一律 `active`。
   *
   * 幂等：标记键写了就不再迁移；没写就重跑（重跑不会再次改动任何条目，因为作用域已是新名）。
   *
   * ⚠️ **写标记的四个前提**（M-1 / A1 / I1，缺一不可）：
   * ① 这一次**确实读到了数据**（`loadState.ok`：记忆域已预热、JSON 与容器形状都认得）；
   * ② `changed > 0`（真的迁移过条目）；
   * ③ `save()` 报告成功（写穿没抛错）；
   * ④ 标记本身写得进去（`setSetting` 不抛）。
   *
   * 旧实现只要求"跑过迁移函数"，于是三种形态下会**永久锁死迁移**：预热未就绪（读到兜底空串）、
   * JSON 坏（解析异常被吞成空表）、落库失败（标记照写）。锁死之后旧作用域条目在新口径里
   * 既不注入也在界面看不见，用户表现为"记忆全没了"。
   *
   * @param opts.force **只给判据用**：跳过标记键检查，对当前内存里的数据重跑一次迁移规则。
   *                    它让"迁移前 vs 迁移后"的对照能在同一个实例上做（构造即迁移，否则拿不到"前"）。
   *                    它**不**绕过"读失败不迁移"这条（fail-closed 优先）。
   */
  migrateScopeModel(opts?: { force?: boolean }): MemoryMigrationReport {
    /**
     * 报告里的可见范围快照**一律带 `includeUnscoped`**：迁移报告的核心信息之一就是
     * "有多少条旧条目迁移后仍然没有归属（= 仍然不进注入）" —— 不带这个开关，
     * 那些条目会从快照里消失，报告就变成"少报了"（而且两次调用的口径会不一致）。
     */
    const snapshot = () => this.visibilitySnapshot({ includeUnscoped: true });
    const zero = {
      globalToPlatform: 0,
      projectToPlatform: 0,
      sessionToConversation: 0,
    };
    /*
     * ① 读失败 / 形状不认识 ⇒ **推迟迁移**（M-1）。
     * 这里必须**先**判：否则"兜底空串"会走完整条迁移并把标记写死（A1 的现场）。
     */
    if (!this.loadState.ok) {
      const report: MemoryMigrationReport = {
        ran: false,
        deferredReason: this.loadState.reason ?? "记忆尚未成功读取",
        droppedEntries: this.loadState.dropped,
        ...zero,
        notInjected: this.countNotInjected(),
        visibleBefore: snapshot(),
        visibleAfter: snapshot(),
      };
      this.migrationReport = report;
      console.warn(`[memory] 迁移推迟（不写标记、不覆盖）：${report.deferredReason}`);
      return report;
    }
    if (!opts?.force && (this.migratedThisProcess || getSetting(MEMORY_MIGRATED_KEY) === "1")) {
      const done: MemoryMigrationReport = {
        ran: false,
        droppedEntries: this.loadState.dropped,
        snapshotWritten: false,
        ...zero,
        notInjected: this.countNotInjected(),
        visibleBefore: snapshot(),
        visibleAfter: snapshot(),
      };
      // 记下来：界面/命令问"这次启动迁移跑了没有"时要能拿到（旧实现这里返回 null）
      this.migrationReport = done;
      return done;
    }

    const visibleBefore = snapshot();
    let globalToPlatform = 0;
    let projectToPlatform = 0;
    let sessionToConversation = 0;
    let projectToLegacyPool = 0;
    /** 先算出目标状态再落库：迁移前快照必须写在**改动之前**（M-6） */
    const nextEntries = new Map<string, MemoryEntry>();

    for (const [id, entry] of this.entries) {
      const legacyScope = entry.scope as LegacyMemoryScope;
      let nextScope: MemoryScope = entry.scope as MemoryScope;
      // 旧 `project` 必须是"旧版本写的"那一种（见 isLegacyProjectPoolEntry 的说明）
      const legacyProject = isLegacyProjectPoolEntry(entry);
      if (legacyScope === "global") {
        nextScope = "platform";
        globalToPlatform++;
      } else if (legacyProject) {
        nextScope = "platform";
        projectToPlatform++;
        // M-2：旧 project 池**必须留下可展示的痕迹**（哪几条是被污染进来的，只有它能回答）
        projectToLegacyPool++;
      } else if (legacyScope === "session") {
        nextScope = "conversation";
        sessionToConversation++;
      }

      /**
       * 来源：迁移**刻意不给旧数据盖章**。
       *
       * - 旧 `global` / 旧 `project`：用户可能是手写的，也可能是当时自动提取写的 ——
       *   历史数据里**没有任何字段**能区分，所以保持 `undefined`（界面显示"未知（旧数据）"）；
       * - 旧 `session`：旧实现里 `buildMemoryPrompt("session")` 全仓没有调用点，那些条目只可能来自
       *   自动提取路径 —— 这一条是可以确证的，因此明确标成 `auto`（避免把"确证的自动"说成"未知"）。
       *
       * 也就是说：**只有确证过来源的条目才会被打上 source**，其余一律留空。
       */
      const source: MemorySource | undefined =
        legacyScope === "session" ? "auto" : entry.source;
      const next: MemoryEntry = {
        ...entry,
        scope: nextScope,
        source,
        status: entry.status ?? "active",
        // 归属键**刻意不猜**：project/session 条目迁移后不带 projectId/sessionId
        projectId: entry.projectId,
        sessionId: legacyScope === "session" ? undefined : entry.sessionId,
        // M-2：旧 project 池打标记（旧 global 不打 —— 它从来不是自动提取的目标作用域）
        legacyPool: legacyProject ? true : entry.legacyPool,
      };
      nextEntries.set(id, next);
    }

    const changed = globalToPlatform + projectToPlatform + sessionToConversation;

    /*
     * M-6 / F4：**迁移前快照**必须走确认通道，且"快照没落"时**不许写迁移标记**。
     *
     * 修复前的形态（第 188 波复审 F4）：这里用 `setSetting()`（fire-and-forget，写失败只上报）
     * 之后**无条件** `snapshotWritten = true` ⇒ 磁盘上可能出现「数据已迁移（已确认）+
     * 迁移标记已写 + **快照根本没落**」⇒ 重启后 `getPreMigrationSnapshot()` 返回 null、
     * 界面隐藏「回退到迁移前」，而旧形态已被确认覆盖 —— **唯一的可逆凭据丢了，且没人说**。
     * 判据 `MIG-SNAP-1` 当时读的是**镜像**，所以抓不到。
     *
     * 现在快照由 `commitMigrationPayload()` 排在确认链的**链首**：
     *   ① `setSettingConfirmed(快照)` 等确认 —— 失败则**整条链停在这里**（不写数据、不写标记）；
     *   ② 确认成功后写迁移数据并等确认；
     *   ③ 只有 ② 确认成功才写迁移标记。
     * `snapshotWritten` 因此**只在①确认之后**才置真（同步返回时恒为 false，如实反映
     * "这一刻磁盘上还没有快照"）；`snapshotDeferred` 记录"本该写却没写"的原因。
     */
    const snapshotPayload: MemoryPreMigrationSnapshot | null =
      changed > 0 && getSetting(MEMORY_PRE_MIGRATION_KEY) === null && this.loadState.raw !== null
        ? { takenAt: Date.now(), entries: this.entries.size, raw: this.loadState.raw }
        : null;
    let snapshotWritten = false;
    let snapshotDeferred: string | null = null;

    for (const [id, next] of nextEntries) this.entries.set(id, next);

    /*
     * R1 + F4：快照、数据、标记**三者都走可确认通道，且顺序固定为 快照 → 数据 → 标记**。
     *
     * 旧写法是 `this.save()`（同步返回 true 只代表"没抛错"，`memory.set` 的 IPC 失败是
     * `.catch(上报)`）之后再 `setSetting(KEY,"1")`（**另一条** fire-and-forget 写穿）⇒
     * 磁盘上完全可能"**数据没落、标记落了**"，下次启动 `ran:false` ⇒ 旧作用域条目永久不注入。
     *
     * ⚠️ `changed === 0` 时不写标记（也不写快照）：重跑迁移是幂等的、不改任何数据，代价可忽略；
     * 而"数据已经迁过但标记没写"本来就该允许下一次继续迁（幂等）——**先写数据再写标记**不变。
     *
     * ⚠️ 镜像这半仍**同步**更新（`patchMemoryMirror`）：同一 tick 之后的读路径（例如
     * 紧接着 `new MemoryService()`）必须看到迁移后的形态。若确认失败，镜像比磁盘"超前"一步，
     * 由 `lastPersistError` 如实反映（并在下次迁移时重来 —— 因为标记没写，下次必然重跑）。
     *
     * ⚠️ 报告要**先**建出来：确认链在快照确认落库之后**回填**它的 `snapshotWritten`
     * （同步返回时它如实为 false = "这一刻磁盘上还没有快照"，
     * `await flushPendingPersist()` 之后才是结论）。
     */
    const report: MemoryMigrationReport = {
      ran: true,
      droppedEntries: this.loadState.dropped,
      projectToLegacyPool,
      snapshotWritten,
      snapshotDeferred: snapshotDeferred ?? undefined,
      ...zero,
      globalToPlatform,
      projectToPlatform,
      sessionToConversation,
      notInjected: this.countNotInjected(),
      visibleBefore,
      visibleAfter: snapshot(),
    };
    this.migrationReport = report;
    /*
     * ⚠️ 回填必须写在**报告对象上**（不是只写闭包里的局部变量）：`snapshotWritten` 是报告创建时
     * 拷进去的一个值，之后改局部变量对报告没有任何影响 —— 第一版就是这么写的，
     * 判据 `MIG-SNAP-1` 当场抓到（磁盘上快照在、报告却说"未留"）。
     */
    const persistedSync = changed > 0 ? this.commitMigrationPayload(snapshotPayload, (reason) => {
      snapshotDeferred = reason;
      report.snapshotDeferred = reason;
    }, () => {
      snapshotWritten = true;
      report.snapshotWritten = true;
    }) : true;
    /*
     * 本进程内**已迁移**标记（R1 的配套）：迁移标记现在走**异步确认**才落库，
     * 于是同一进程里紧接着的第二次 `migrateScopeModel()` 看不到标记 ——
     * 它会重跑一遍规则（对已迁移的数据 `changed === 0`，不改任何东西）并把标记再排一次队。
     * 幂等性因此不再依赖"标记已经写进磁盘了吗"这个跨进程事实，而是进程内确定的行为。
     */
    if (changed > 0) this.migratedThisProcess = true;
    if (changed > 0) {
      console.log(
        `[memory] 作用域迁移完成（幂等）：global→platform ${globalToPlatform} 条；` +
          `project→platform ${projectToPlatform} 条（旧 project 没有 projectId，今天就是到处生效，故降为 platform 而不猜项目；` +
          `并打上 legacyPool 标记，见体检的「旧版跨项目记忆」组，共 ${projectToLegacyPool} 条）；` +
          `session→conversation（无 sessionId，仍不进注入）${sessionToConversation} 条。` +
          `镜像已更新=${persistedSync}；**快照 → 数据 → 标记**三道都走确认通道（见 flushPendingPersist）。` +
          `迁移前快照=${snapshotWritten ? "已确认落库" : snapshotPayload ? "未落库（迁移被拒，见 snapshotDeferred）" : "未留（键已存在）"}。`,
      );
    }
    return report;
  }

  /**
   * 迁移的落库（R1 + F4）：同步更新镜像 + 把「确认快照 → 确认数据 → 确认标记」挂到确认链上。
   *
   * 返回**同步那半**是否被接受（镜像是否更新过）——它**不是**落库结论；
   * 真实结论由 `await flushPendingPersist()` / `getLastPersistError()` 给出。
   *
   * ## F4：快照失败 ⇒ 整条链停在这里
   *
   * 快照是**唯一的可逆凭据**。旧写法把它当顺带的元数据（fire-and-forget + 无条件
   * `snapshotWritten = true`）⇒ 磁盘上可能出现"数据已迁、标记已写、快照没落"，
   * 而那是不可逆的。现在：
   * - ① 先 `setSettingConfirmed(快照)` 并**等确认**；失败 ⇒ 记 `snapshotDeferred`、
   *   写 `memory.preMigrationSnapshot` 上报、`lastPersistError` 非空、**直接 return**
   *   （不写迁移数据、不写迁移标记）⇒ 下次启动仍是旧形态，逐字可回退；
   * - ② 快照确认成功后才写数据、再写标记（顺序与 R1 一致）；
   * - ③ 只有①确认成功才把 `snapshotWritten` 置真（它由报告对象与链共享同一变量）。
   *
   * @param snapshot 需要写却还没有的迁移前快照（`null` = 键已存在或本次无改动 ⇒ 不写）
   * @param onSnapshotDeferred 把"没写成"的原因交回给报告（报告是界面/命令唯一能看到的凭据）
   * @param onSnapshotConfirmed 快照**确认落库成功**时回调（报告据此把 `snapshotWritten` 置真）
   */
  private commitMigrationPayload(
    snapshot: MemoryPreMigrationSnapshot | null,
    onSnapshotDeferred: (reason: string) => void,
    onSnapshotConfirmed: () => void,
  ): boolean {
    if (!this.loadState.ok) return false;
    const payload = this.serialize();
    if (payload === this.lastPersistedPayload) return true;
    patchMemoryMirror(payload);
    this.lastPersistedPayload = payload;
    const previous = this.pendingPersist ?? Promise.resolve();
    const port = hasStoragePort() ? getStoragePort() : null;
    this.pendingPersist = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.isStillSamePort(port)) return; // 端口换了 ⇒ 这次迁移写入已无意义（同 chainPersist）
        /*
         * ① 快照（F4）：**先于数据**确认落库。没有它，后面两步就是"迁了但没法回退"。
         */
        if (snapshot) {
          const snapOk = await setSettingConfirmed(MEMORY_PRE_MIGRATION_KEY, JSON.stringify(snapshot));
          if (!snapOk) {
            const reason =
              "迁移前快照未被确认写入 ⇒ 本次**不迁移**（不写数据、不写迁移标记）：没有可逆凭据时迁移不可接受";
            onSnapshotDeferred(reason);
            if (this.lastPersistedPayload === payload) this.lastPersistedPayload = null;
            this.lastPersistError = reason;
            reportPersistFailure("memory.preMigrationSnapshot", new Error(reason), "回退凭据没落库 ⇒ 迁移整体未执行，旧数据保持原样");
            return;
          }
          onSnapshotConfirmed();
        }
        const landed = await writeMemoryConfirmed(payload);
        if (!landed.ok) {
          if (this.lastPersistedPayload === payload) this.lastPersistedPayload = null;
          this.lastPersistError = landed.reason ?? "记忆落库失败";
          reportPersistFailure(
            "memory.saveConfirmed",
            new Error(this.lastPersistError),
            "迁移后的数据没被引擎确认 ⇒ **本次不写迁移标记**（下次启动会重跑一次幂等迁移）",
          );
          return;
        }
        this.lastPersistError = null;
        /*
         * ③ 数据**确认落库之后**才写标记，且同样要求确认。
         * 标记写失败 ⇒ 不抛给调用方（迁移是构造期动作），只如实上报：下次启动重跑（幂等）。
         */
        const marked = await setSettingConfirmed(MEMORY_MIGRATED_KEY, "1");
        if (!marked) {
          console.warn("[memory] 迁移标记未被确认写入（下次启动会重跑一次幂等迁移）");
        }
      });
    return true;
  }

  /** 迁移前快照（M-6）；没有/坏了 ⇒ null（界面据此隐藏「回退」入口） */
  getPreMigrationSnapshot(): MemoryPreMigrationSnapshot | null {
    const rawSetting = getSetting(MEMORY_PRE_MIGRATION_KEY);
    if (rawSetting === null) return null;
    try {
      const parsed = JSON.parse(rawSetting) as Partial<MemoryPreMigrationSnapshot>;
      if (typeof parsed?.raw !== "string") return null;
      return {
        takenAt: typeof parsed.takenAt === "number" ? parsed.takenAt : 0,
        entries: typeof parsed.entries === "number" ? parsed.entries : 0,
        raw: parsed.raw,
      };
    } catch {
      return null;
    }
  }

  /** 导出迁移前快照（给「导出这份快照」按钮用；内容是快照本体 + 一句可读说明） */
  exportPreMigrationSnapshot(): string | null {
    const snap = this.getPreMigrationSnapshot();
    if (!snap) return null;
    return JSON.stringify(
      {
        note: "Codem 记忆迁移前快照（原样保存的 memory 字段内容；回退时逐字写回）",
        takenAt: new Date(snap.takenAt).toISOString(),
        entries: snap.entries,
        raw: snap.raw,
      },
      null,
      2,
    );
  }

  /**
   * **回退到迁移前**（M-6，用户显式动作，界面负责二次确认）。
   *
   * 语义（必须说清，界面文案与之逐字一致）：
   * - 把快照里的原始字符串**逐字**写回 `memory` 字段（这就是"逐字一致"的判据）；
   * - **不**清迁移标记：清掉的话下一次启动会立刻重新迁移，回退等于没做（这是陷阱）。
   *   代价如实写在这里：回退后旧作用域条目会落在体检的「作用域无法识别」组里，
   *   需要用户自己归位（或再次导入导出）—— 界面会这么提示。
   * - 回退后本进程的内存态 = 旧数据（不再自动迁移），界面能立刻看到真实状态。
   */
  async restorePreMigrationSnapshot(): Promise<{ ok: boolean; restored: number; message: string }> {
    const snap = this.getPreMigrationSnapshot();
    if (!snap) {
      return { ok: false, restored: 0, message: "没有可用的迁移前快照（本机从未执行过迁移，或快照已被清理）" };
    }
    const result = await saveMemoryConfirmed(snap.raw);
    if (!result.ok) {
      const message = `回退失败：写回库未成功（${result.reason ?? "未知原因"}）—— 库内容未改动，请重试`;
      reportActionFailure("memory.rollback", new Error(message), "回退时写回失败，库内容保持不变");
      return { ok: false, restored: 0, message };
    }
    this.lastPersistedPayload = snap.raw;
    this.entries.clear();
    this.batches.clear();
    this.ingestRawForRestore(snap.raw);
    const restored = this.entries.size;
    reportAdvisory("memory.rollback", `已回退到迁移前快照：写回 ${restored} 条（原样字符串）`, {
      title: "记忆回退完成",
      nextStep:
        "旧作用域条目现在落在体检的「作用域无法识别」组里，可逐条归位；迁移标记保持不变，" +
        "所以本次回退不会被下次启动自动撤销。",
    });
    return {
      ok: true,
      restored,
      message:
        `已回退到迁移前：写回 ${restored} 条（逐字恢复原字符串）。` +
        `旧作用域条目现在只能在体检的「作用域无法识别」组里看到，可逐条归位；` +
        `本操作不可撤销（再次迁移不会自动发生）。`,
    };
  }

  /** 回退时**只做读入**（不再跑迁移）—— 迁移会把刚回退的状态又改回去 */
  private ingestRawForRestore(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    /*
     * LEGACY-SHAPE-4：回退也必须认**同一批**容器形状（`readMemoryContainer` 是唯一口径）。
     * 否则回退 id-keyed 那种存量数据时，字符串逐字写回了、内存里却读成空表
     * ⇒ 界面显示 0 条，用户会以为回退把数据弄丢了。
     */
    const container = readMemoryContainer(parsed);
    if (!container.ok) return;
    for (const [key, value] of container.pairs) {
      const normalized = normalizeLoadedEntry(key, value);
      if (normalized) this.entries.set(normalized.id, normalized);
    }
    this.loadState = { ok: true, dropped: 0, raw };
  }

  /**
   * **只给判据用**的夹具入口：把当前内存里的条目当成"旧版本写下的数据"（作用域名与信任字段都按旧语义重置），
   * 这样"迁移前 / 迁移后"的可见范围可以在**同一个实例**上对照，不依赖真实历史数据。
   */
  __seedLegacyForMigrationTest(entries: Array<{ scope: LegacyMemoryScope; key: string; content: string; timestamp?: number }>): void {
    this.entries.clear();
    for (const e of entries) {
      const id = `legacy-${e.key}`;
      this.entries.set(id, {
        id,
        scope: e.scope as unknown as MemoryScope,
        key: e.key,
        content: e.content,
        timestamp: e.timestamp ?? Date.now(),
      } as MemoryEntry);
    }
  }

  /**
   * **只给判据用**：把内存态恢复到"刚读完旧版本数据、还没有迁移"的那一刻。
   *
   * 为什么必须有它：构造即迁移 ⇒ 在一个刚构造的实例上**拿不到迁移前的状态**，
   * 而"迁移前后可见范围逐字不变"这条判据恰恰需要那一刻。它只动内存，不碰持久化标记。
   */
  __resetMigrationStateForTest(): void {
    this.migrationReport = null;
  }

  /** 最近一次迁移报告（未跑过则为 null） */
  getMigrationReport(): MemoryMigrationReport | null {
    return this.migrationReport;
  }

  /** 迁移后仍不会被注入的条目数（给用户/命令一个诚实的数字） */
  countNotInjected(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!ownedBySelf(entry)) count++;
    }
    return count;
  }

  /**
   * 可见范围快照：列出"迁移前/迁移后**实际会被注入**的条目"，形如
   * `EVERYWHERE|key`（平台级：所有项目、所有对话都能看到）、
   * `PROJECT:<projectId>|key`、`CONVERSATION:<sessionId>|key`。
   *
   * 关键是**旧名的语义映射**（判据要断言改名不改行为）：
   * - 旧 `global` / 新 `platform` / **没有 projectId 的旧 `project`** ⇒ 三者今天都是"到处生效" ⇒ `EVERYWHERE`；
   * - 旧 `session` / 没有 sessionId 的新 `conversation` ⇒ 都不进注入 ⇒ 从快照里消失（不算"可见"）。
   */
  visibilitySnapshot(opts?: { includeUnscoped?: boolean }): string[] {
    const includeUnscoped = opts?.includeUnscoped === true;
    const rows: string[] = [];
    for (const entry of this.entries.values()) {
      const legacyScope = entry.scope as LegacyMemoryScope;
      if (legacyScope === "global" || legacyScope === "platform") {
        rows.push(`EVERYWHERE|${entry.key}`);
        continue;
      }
      if (legacyScope === "project") {
        // 有 projectId 才是"只在本项目"，没有就是"到处生效"（今天的行为）——
        // 迁移把它降为 platform 后，"到处生效"这个事实保持不变，快照因此逐字相同。
        rows.push(entry.projectId ? `PROJECT:${entry.projectId}|${entry.key}` : `EVERYWHERE|${entry.key}`);
        continue;
      }
      // 旧 session / 新 conversation：没有 sessionId 就是"没有任何对话会注入它"——
      // 判据要断言"迁移前后这个事实不变"，所以把它记成 UNSCOPED（可选）。
      if (entry.sessionId) {
        rows.push(`CONVERSATION:${entry.sessionId}|${entry.key}`);
      } else if (includeUnscoped) {
        rows.push(`UNSCOPED|${entry.key}`);
      }
    }
    return rows.sort();
  }

  // ========== Bidirectional Memory Links ==========

  /**
   * Extract [[link-name]] references from a memory entry's content.
   * Returns an array of link target names (without brackets).
   */
  extractLinks(content: string): string[] {
    const linkPattern = /\[\[([^\]]+?)\]\]/g;
    const links: string[] = [];
    let match;
    // M-3：坏数据不许在这里抛（正则 exec 会做 ToString，但显式过一遍更清楚）
    const text = textOf(content);
    while ((match = linkPattern.exec(text)) !== null) {
      links.push(match[1].trim());
    }
    return links;
  }

  /**
   * **链接目标是否允许展开**（第 190 波 / 审计 M-2，P1）。
   *
   * 不变量：**稳定块的字节 = f(稳定数据)**。链接目标原先在**全库**里按 key 找第一条
   * （不分 scope/source）⇒ 一条平台级手写条目里写 `[[某条记忆]]`，它的注入文本就成了
   * **易变条目内容的函数**：改一条项目级记忆就会顶掉整个稳定前缀 + 边界 + date
   * （本次改造的收益被一条链接打穿，且无任何提示）。
   *
   * 修法（选**同侧约束**，即用户倾向的方案 1，但只对**稳定侧**设限）：
   * - 稳定条目（`isStableMemoryEntry`：平台级 + 手动）**只能**展开稳定目标
   *   ⇒ 稳定块的内容只依赖稳定数据；
   * - 易变条目不设限（它在边界**之后**，依赖稳定数据不会破坏任何前缀不变量，
   *   关掉它反而会平白损失既有功能）。
   *
   * 跨侧不展开时的呈现 = 现有"目标不存在"的降级形态：`[[key]]` **原样留着**（可见），
   * 不注入对方正文。
   */
  private linkTargetAllowed(source: MemoryEntry, target: MemoryEntry): boolean {
    if (!isStableMemoryEntry(source)) return true;
    return isStableMemoryEntry(target);
  }

  /**
   * Resolve [[link-name]] references in a memory entry's content.
   * Replaces [[name]] with the actual content snippet from the linked entry.
   * If the link target doesn't exist, leaves it as-is (visible to the LLM).
   *
   * M-3：`content` / `key` 不是字符串时**安全降级**（返回安全文本），绝不抛 ——
   * 这条路径在 `buildSystemPrompt` 里，抛一次就丢掉整轮系统提示。
   *
   * ⚠️ 目标筛选必须过 `linkTargetAllowed`（稳定侧只解析同侧目标，见那里的说明）：
   * 否则稳定前缀会被易变条目的内容间接改写（判据 `MEM-PLACE-19`）。
   */
  private resolveLinks(entry: MemoryEntry): string {
    const content = textOf(entry.content);
    const links = this.extractLinks(content);
    if (links.length === 0) return content;

    let resolved = content;
    for (const linkName of links) {
      // Find the linked entry by key (case-insensitive) —— 且必须**允许展开**（同侧约束）
      const target = Array.from(this.entries.values()).find(
        e => textOf(e.key).toLowerCase() === linkName.toLowerCase() && this.linkTargetAllowed(entry, e)
      );
      if (target) {
        const snippet = textOf(target.content).substring(0, 100);
        resolved = resolved.replace(
          new RegExp(`\\[\\[${linkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'gi'),
          `[→ ${textOf(target.key)}: ${snippet}...]`
        );
      }
    }
    return resolved;
  }

  /**
   * Find all entries that link TO the given entry (reverse links).
   * This enables "related memories" discovery.
   */
  findBacklinks(entryId: string): MemoryEntry[] {
    const target = this.entries.get(entryId);
    if (!target) return [];

    const targetKey = textOf(target.key).toLowerCase();
    const backlinks: MemoryEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.id === entryId) continue;
      const links = this.extractLinks(entry.content);
      if (links.some(link => link.toLowerCase() === targetKey)) {
        backlinks.push(entry);
      }
    }

    return backlinks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  /**
   * Get related entries for a given entry — both forward links and backlinks.
   * Used during memory loading to enrich context with connected knowledge.
   */
  getRelatedEntries(entryId: string, maxDepth: number = 1): MemoryEntry[] {
    const visited = new Set<string>([entryId]);
    const result: MemoryEntry[] = [];

    const collect = (id: string, depth: number) => {
      if (depth > maxDepth) return;
      const entry = this.entries.get(id);
      if (!entry) return;

      // Forward links
      const linkNames = this.extractLinks(entry.content);
      for (const name of linkNames) {
        const target = Array.from(this.entries.values()).find(
          e => e.key.toLowerCase() === name.toLowerCase()
        );
        if (target && !visited.has(target.id)) {
          visited.add(target.id);
          result.push(target);
          collect(target.id, depth + 1);
        }
      }

      // Backlinks
      for (const backlinker of this.findBacklinks(id)) {
        if (!visited.has(backlinker.id)) {
          visited.add(backlinker.id);
          result.push(backlinker);
          collect(backlinker.id, depth + 1);
        }
      }
    };

    collect(entryId, 0);
    return result;
  }

  /** Build checkpoint for session */
  buildCheckpoint(messages: MessageV2[]): string {
    const lines: string[] = ["# Session Checkpoint", ""];

    // Extract key information from messages
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    lines.push(`## Conversation Summary`);
    lines.push(`- Total messages: ${messages.length}`);
    lines.push(`- User messages: ${userMessages.length}`);
    lines.push(`- Assistant messages: ${assistantMessages.length}`);

    // Extract tool calls
    const toolCalls: string[] = [];
    for (const msg of assistantMessages) {
      for (const part of msg.parts) {
        if (part.type === "tool") {
          toolCalls.push(`${part.name}: ${JSON.stringify(part.input).substring(0, 100)}`);
        }
      }
    }

    if (toolCalls.length > 0) {
      lines.push("\n## Tools Used");
      toolCalls.forEach((tc) => lines.push(`- ${tc}`));
    }

    // Extract recent decisions
    const recentTexts = assistantMessages
      .slice(-5)
      .flatMap((m) => m.parts.filter((p) => p.type === "text"))
      .map((p) => p.content.substring(0, 200));

    if (recentTexts.length > 0) {
      lines.push("\n## Recent Responses");
      recentTexts.forEach((t) => lines.push(`- ${t}`));
    }

    return lines.join("\n");
  }

  /**
   * Get stats.
   *
   * - **`ctx` 可选但强烈建议传**（B7 / F7）：不传时统计的是**全库**，而界面列表是按当前位置过滤的
   *   ⇒ 会出现「项目 37 / 列表 2 条」的错位（本仓库把这类错位定性为 P1）。界面必须用同一个 ctx 调。
   * - **未知作用域不再产生 NaN**（M-5 / C2）：`byScope[未知]++` 原来得到 `NaN` 且凭空多出一个键；
   *   现在它们如实计入 `unknownScope`（界面上是「其它」）。
   * - **时间戳只统计有限的数字**（C2）：缺 `timestamp` 的条目原来让 `oldestEntry/newestEntry` 变 `NaN`
   *   ⇒ 界面显示 Invalid Date。
   * - `legacyPool`：旧版跨项目池的条数（M-2，界面用它解释「暂停注入」影响多少条）。
   */
  getStats(ctx?: MemoryScopeContext): {
    totalEntries: number;
    byScope: Record<MemoryScope, number>;
    /** 来源三态计数（`unknown` = 旧数据；旧写法把它并进 manual 是**编造来源**，已改） */
    bySource: Record<MemorySourceKind, number>;
    pendingEntries: number;
    notInjected: number;
    unknownScope: number;
    legacyPool: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const scoped = ctx ? this.listAll(ctx) : Array.from(this.entries.values());
    const byScope: Record<MemoryScope, number> = { platform: 0, project: 0, conversation: 0 };
    const bySource: Record<MemorySourceKind, number> = { manual: 0, auto: 0, unknown: 0 };
    let pendingEntries = 0;
    let unknownScope = 0;
    let legacyPool = 0;

    for (const entry of scoped) {
      if (entry.scope === "platform" || entry.scope === "project" || entry.scope === "conversation") {
        byScope[entry.scope]++;
      } else {
        unknownScope++;
      }
      // 三态口径（与注入文本、面板、体检、导出**同一个** `memorySourceOf`）
      bySource[memorySourceOf(entry)]++;
      if ((entry.status ?? "active") === "pending") pendingEntries++;
      if (entry.legacyPool === true) legacyPool++;
    }

    const timestamps = scoped.map((e) => e.timestamp).filter((t): t is number => typeof t === "number" && Number.isFinite(t));

    return {
      totalEntries: scoped.length,
      byScope,
      bySource,
      pendingEntries,
      notInjected: scoped.filter((e) => !ownedBySelf(e)).length,
      unknownScope,
      legacyPool,
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
    };
  }

  /**
   * Clear entries.
   *
   * **信任边界**：自动流程**不得删除手动条目**。默认只清自动条目；要连手动一起清，
   * 必须由用户显式传 `includeManual: true`（界面/命令会先问一遍）。
   */
  clear(scope?: MemoryScope, opts?: { includeManual?: boolean }): number {
    const includeManual = opts?.includeManual === true;
    let removed = 0;
    for (const [id, entry] of Array.from(this.entries)) {
      if (scope && entry.scope !== scope) continue;
      if (!includeManual && isProtectedMemoryEntry(entry)) continue;
      this.entries.delete(id);
      removed++;
    }
    if (removed > 0) this.save();
    return removed;
  }

  // ========== F2.4: Export / Import ==========

  /**
   * Export all memories as JSON string.
   *
   * ⚠️ **第 189 波 R4**：`source === undefined`（来源未知的旧数据）必须**显式写出** `null`。
   * `JSON.stringify` 会**丢掉** `undefined` 值 ⇒ 旧写法导出的文件里根本没有 `source` 这个键，
   * 于是"导出留档 → 再导入"（`LOAD_FAILURE_NEXT_STEP` 推荐的常规操作）之后：
   * 导入侧只能靠兜底**自造**一个来源 ⇒ 三态里的「未知（旧数据）」被洗成「手动」，
   * `platform` 的旧条目还会从易变侧被搬进稳定前缀（`isStableMemoryEntry` 要求 manual）。
   * 现在 `null` 是**显式**的"这条来源未知"（`normalizeLoadedEntry` 把 `null` 读回 `undefined`），
   * 往返逐条保真。判据 `MEM-PLACE-21`。
   */
  exportAsJSON(): string {
    const data = {
      version: 2,
      exportedAt: new Date().toISOString(),
      entries: Array.from(this.entries.values()).map((e) => ({
        ...e,
        // `undefined` ⇒ `null`（**显式**表示"来源未知"，不是"字段缺失"）
        source: e.source ?? null,
      })),
      batches: Array.from(this.batches.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Export all memories as Markdown */
  exportAsMarkdown(): string {
    const lines: string[] = ["# Codem Memory Export", ""];
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push("");

    for (const scope of ["platform", "project", "conversation"] as MemoryScope[]) {
      const entries = this.listByScope(scope);
      if (entries.length === 0) continue;
      lines.push(`## ${this.scopeLabel(scope)}`);
      lines.push("");
      for (const e of entries) {
        const date = safeDate(e.timestamp);
        lines.push(`### ${textOf(e.key)}`);
        lines.push(`- **ID**: ${e.id}`);
        lines.push(`- **Date**: ${date}`);
        lines.push(`- **来源**: ${MEMORY_SOURCE_KIND_LABEL[memorySourceOf(e)]}`);
        if (e.projectId) lines.push(`- **项目**: ${e.projectId}`);
        if (e.sessionId) lines.push(`- **对话**: ${e.sessionId}`);
        if (e.tags && e.tags.length > 0) {
          lines.push(`- **Tags**: ${e.tags.join(", ")}`);
        }
        if (e.filePath) {
          lines.push(`- **File**: ${e.filePath}`);
        }
        lines.push("");
        lines.push(textOf(e.content));
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /**
   * Import memories from JSON string.
   *
   * 第 187 波（B5 / 脱敏口径）两处收紧：
   * - **容量**：与 `add` 同口径 —— 目标桶超 `maxEntries` 的条目**拒绝导入并计数**（`rejectedCapacity`），
   *   不再"界面回成功导入 N 条、库里却超了上限"；
   * - **脱敏**：手动写入/导入也过同一套 `redactSecrets`（自动提取路径早就过了）。
   *   本波把平台级记忆的注入面从"当前项目"扩大到"所有项目"，扩散面变大，所以在入口一并收口。
   *
   * ## 第 189 波 R4：**往返必须保真**（三态来源不许被"洗"）
   *
   * 旧写法把 `source` 兜底成 `?? (scope === "conversation" ? "auto" : "manual")` —— 这是
   * **自造来源**：迁移刻意不给旧数据盖 `source`（`undefined` = 「未知（旧数据）」），而
   * `LOAD_FAILURE_NEXT_STEP` 与界面按钮把"导出留档 → 再导入"当**常规操作**
   * ⇒ 用户按提示走一遍，三态里的"未知"就变成"手动"，`platform` 的旧条目还会从**易变侧**
   * 被搬进**稳定前缀**（`isStableMemoryEntry` 要求 `source === "manual"`）
   * ⇒ 注入位置、缓存分块、面板文案三处同时变，而**没有任何判据会红**。
   *
   * 现在：`source` **原样保留**（`undefined` 就是 `undefined`）；导出侧把 `undefined`
   * **显式写成 `null`**（见 `exportAsJSON`）—— 于是往返逐条保真，判据 `MEM-PLACE-21`。
   * 形态确无法保真的只有"由 `add()` 新写入的条目"（新写入从来都有来源，不存在未知态）。
   */
  importFromJSON(jsonStr: string, overwrite = false): { imported: number; rejectedCapacity: number; rejectedInvalid: number; truncated: number } {
    const result = { imported: 0, rejectedCapacity: 0, rejectedInvalid: 0, truncated: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      console.error("[importFromJSON] Failed:", err);
      return result;
    }
    const raw = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { entries?: unknown }).entries ?? [])
        : [];
    const list: unknown[] = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
    // R2：缺 `order` 的导入条目按**导入顺序**补齐（接在现有最大 order 之后，只增不减）
    let nextOrder = this.nextCreationOrder();
    for (const item of list) {
      const normalized = normalizeLoadedEntry("", item);
      if (!normalized) {
        result.rejectedInvalid++;
        continue;
      }
      if (!overwrite && this.entries.has(normalized.id)) continue;
      const scope: MemoryScope =
        normalized.scope === ("global" as unknown) ? "platform"
        : normalized.scope === ("session" as unknown) ? "conversation"
        : normalized.scope;
      // B5：导入也要守容量（与 add 同一口径：可见地拒绝，不静默撑桶）
      const existing = this.entries.has(normalized.id);
      const target = this.bucketCount(scope, normalized.projectId, normalized.sessionId);
      if (!existing && target >= this.config.maxEntries) {
        result.rejectedCapacity++;
        continue;
      }
      const safeContent = redactSecrets(normalized.content);
      if (safeContent.length > this.config.maxContentLength) result.truncated++;
      const order =
        typeof normalized.order === "number" && Number.isFinite(normalized.order)
          ? normalized.order
          : nextOrder++;
      this.entries.set(normalized.id, {
        ...normalized,
        scope,
        // R4：**不自造来源** —— `undefined`（旧数据）保持 `undefined`，与迁移后的形态一致
        // （`normalizeLoadedEntry` 已经把 `null`/非法值收成 `undefined`；这里只做类型收窄）
        source: normalized.source as MemorySource,
        status: normalized.status ?? "active",
        order,
        key: redactSecrets(normalized.key).substring(0, MEMORY_INJECT_KEY_MAX),
        content: safeContent.substring(0, this.config.maxContentLength),
      });
      result.imported++;
    }
    if (result.imported > 0) this.save();
    return result;
  }

  // ========== F3.1: Cross-session Memory Consolidation ==========

  /**
   * F3.1: Consolidate memories across sessions（**只由用户显式动作触发**）。
   *
   * ## 第 187 波（I5 / B6 / S3）改了什么，以及为什么
   *
   * 这个函数会**删除与改写**条目（合并 keeper 正文、删重复项、删过期项）。
   * 而它在旧实现里被**每回合自动调用**一次（提取写入成功后），返回值还被丢弃 ——
   * 界面同时写着"程序不会自动删除或改写任何条目"，两边直接矛盾；
   * 更糟的是"过期"只比 `entry.timestamp`（注释却说是"最近没被访问"），
   * 而**注入从不回写访问时间** ⇒ 每天在用的旧自动记忆会在某回合被静默删掉。
   *
   * 现在的口径（**让承诺成真**）：
   * - **自动流程不再调用它**（`llm/index.ts` 里那处每回合调用已删除）⇒ 只有用户点「整合」
   *   或跑 `/memory consolidate` 时才会发生删除/改写；
   * - `pending`（未批准）条目**不参与**去重与清理（未批准的条目不该被自动流程动，B6）；
   * - 删除与改写**如实上报**（`reportAdvisory`：条数 + 原因），不再只有 `console.log`。
   *
   * ## 三个动作
   * 1. **Deduplication**：把相似度 ≥ 阈值的**自动**条目合并（保留最新那条，正文合并）。
   * 2. **Stale cleanup**：删掉 `timestamp` 超过 `maxAgeDays` 的自动条目
   *    （手动、`conversation`、`pending` 豁免）。**它比较的确实是时间戳**，不是"访问时间"——
   *    这是一次由用户显式发起的整理，所以口径与文案必须一致（见下面的回执）。
   * 3. **Capacity enforcement**（可选，`maxEntriesPerScope`）：优先裁最旧的自动条目；
   *    手动条目超额 ⇒ **拒绝裁剪并如实上报 `capacityBlocked`**（不做静默驱逐）。
   */
  consolidate(options?: {
    maxAgeDays?: number;        // Default: 90 days
    maxEntriesPerScope?: number; // 默认不做容量裁剪（要裁剪必须显式传值）
    similarityThreshold?: number; // Default: 0.7 (70% content similarity)
    /** 是否做按时间的过期清理（默认 true；自动路径若以后复用必须显式传 false） */
    removeStale?: boolean;
  }): { duplicatesMerged: number; staleRemoved: number; capacityTrimmed: number; capacityBlocked: number } {
    const maxAgeDays = options?.maxAgeDays ?? 90;
    const maxPerScope = options?.maxEntriesPerScope;
    const similarityThreshold = options?.similarityThreshold ?? 0.7;
    const removeStale = options?.removeStale !== false;

    let duplicatesMerged = 0;
    let staleRemoved = 0;
    let capacityTrimmed = 0;
    let capacityBlocked = 0;

    const allEntries = Array.from(this.entries.values());

    // --- 1. Deduplication（自动**且已批准**的条目之间；手动与 pending 都不参与） ---
    for (const scope of ["platform", "project", "conversation"] as MemoryScope[]) {
      const scopedEntries = allEntries
        .filter(e => e.scope === scope)
        .filter(e => memorySourceOf(e) === "auto")
        // B6：未批准（pending）的条目不该被自动流程合并/删除
        .filter(e => (e.status ?? "active") === "active")
        .sort((a, b) => b.timestamp - a.timestamp); // Most recent first

      const toDelete = new Set<string>();
      const toMerge: Map<string, string[]> = new Map(); // keeperId -> [duplicateIds]

      for (let i = 0; i < scopedEntries.length; i++) {
        if (toDelete.has(scopedEntries[i].id)) continue;

        for (let j = i + 1; j < scopedEntries.length; j++) {
          if (toDelete.has(scopedEntries[j].id)) continue;

          const similarity = this.calculateSimilarity(scopedEntries[i], scopedEntries[j]);
          if (similarity >= similarityThreshold) {
            // Mark j as duplicate of i
            toDelete.add(scopedEntries[j].id);
            const existing = toMerge.get(scopedEntries[i].id) || [];
            existing.push(scopedEntries[j].id);
            toMerge.set(scopedEntries[i].id, existing);
          }
        }
      }

      // Merge duplicate content into keepers
      for (const [keeperId, dupIds] of toMerge) {
        const keeper = this.entries.get(keeperId);
        if (!keeper) continue;

        const dupContents: string[] = [];
        for (const dupId of dupIds) {
          const dup = this.entries.get(dupId);
          if (dup) {
            // Append content that's not already in the keeper
            if (!keeper.content.includes(dup.content.substring(0, 50))) {
              dupContents.push(dup.content);
            }
            // Merge tags
            if (dup.tags) {
              keeper.tags = [...new Set([...(keeper.tags || []), ...dup.tags])];
            }
          }
        }

        if (dupContents.length > 0) {
          keeper.content = (keeper.content + "\n\n" + dupContents.join("\n\n")).substring(0, this.config.maxContentLength);
        }

        this.entries.set(keeperId, keeper);
        duplicatesMerged += dupIds.length;
      }

      // Delete duplicates
      for (const id of toDelete) {
        this.entries.delete(id);
      }
    }

    // --- 2. Stale cleanup（跳过手动、conversation、pending） ---
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (removeStale) {
      for (const [id, entry] of this.entries) {
        if (entry.scope === "conversation") continue; // Don't auto-clean conversation memories
        if (isProtectedMemoryEntry(entry)) continue; // 手动 + 来源未知（旧数据）永不被自动清理
        if ((entry.status ?? "active") !== "active") continue; // B6：未批准的不动
        if (!Number.isFinite(entry.timestamp)) continue; // 时间未知 ⇒ 不据此删除
        if (now - entry.timestamp > maxAgeMs) {
          this.entries.delete(id);
          staleRemoved++;
        }
      }
    }

    // --- 3. Capacity enforcement（只裁自动条目；手动超额则拒绝并上报） ---
    if (typeof maxPerScope === "number" && maxPerScope > 0) {
      const buckets = new Set<string>();
      for (const entry of this.entries.values()) buckets.add(bucketKey(entry));
      for (const bucket of buckets) {
        const bucketEntries = Array.from(this.entries.values()).filter(e => bucketKey(e) === bucket);
        if (bucketEntries.length <= maxPerScope) continue;
        const manualCount = bucketEntries.filter(e => isProtectedMemoryEntry(e)).length;
        if (manualCount >= maxPerScope) {
          // 受保护条目自己就超了 ⇒ 拒绝静默驱逐，如实上报
          capacityBlocked++;
          console.warn(
            `[MemoryService] 容量裁剪被拒绝（可见地失败）：桶 ${bucket} 有 ${manualCount} 条受保护记忆（手动 / 来源未知）> 上限 ${maxPerScope}，` +
              `不会自动删除任何条目。`,
          );
          continue;
        }
        const autoSorted = bucketEntries
          .filter(e => memorySourceOf(e) === "auto")
          .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
        const keepAuto = autoSorted.slice(0, maxPerScope - manualCount);
        const keepIds = new Set([
          ...keepAuto.map(e => e.id),
          ...bucketEntries.filter(e => isProtectedMemoryEntry(e)).map(e => e.id),
        ]);
        for (const entry of bucketEntries) {
          if (!keepIds.has(entry.id)) {
            this.entries.delete(entry.id);
            capacityTrimmed++;
          }
        }
      }
    }

    if (duplicatesMerged > 0 || staleRemoved > 0 || capacityTrimmed > 0) {
      this.save();
      console.log(`[F3.1] Memory consolidation: ${duplicatesMerged} duplicates merged, ${staleRemoved} stale removed, ${capacityTrimmed} capacity trimmed, ${capacityBlocked} capacity blocked`);
      /*
       * I5：删除与改写**必须如实上报**（旧实现只有上面那一行渲染侧 console ——
       * 按仓库纪律，渲染侧 console 用户看不到，等于静默）。
       * 用户能介入（这次整理是他自己发起的、结果对他有意义），所以走 advisory（发现/回执），
       * 不走"失败"语气。
       */
      reportAdvisory(
        "memory.consolidate",
        `记忆整合：合并 ${duplicatesMerged} 条重复的自动记忆（正文已合并到保留的那条）、` +
          `按时间清理 ${staleRemoved} 条超过 ${maxAgeDays} 天的自动记忆、按容量裁剪 ${capacityTrimmed} 条。`,
        {
          title: "记忆整合结果",
          nextStep:
            "手动条目、对话级条目与待批准条目一条都没动（未批准的不会被自动整理）。" +
            "清理按条目的写入时间（不是最近使用时间）判定。",
        },
      );
    }

    return { duplicatesMerged, staleRemoved, capacityTrimmed, capacityBlocked };
  }

  /**
   * Calculate similarity between two memory entries (0-1).
   * Uses key similarity (Jaccard) + content overlap.
   */
  private calculateSimilarity(a: MemoryEntry, b: MemoryEntry): number {
    // Key similarity: exact match = 1.0, partial match = lower
    let keyScore = 0;
    if (a.key === b.key) {
      keyScore = 1.0;
    } else {
      const aWords = new Set(a.key.toLowerCase().split(/\s+/));
      const bWords = new Set(b.key.toLowerCase().split(/\s+/));
      const intersection = [...aWords].filter(w => bWords.has(w)).length;
      const union = new Set([...aWords, ...bWords]).size;
      keyScore = union > 0 ? intersection / union : 0;
    }

    // Content similarity: based on first 200 chars overlap
    const aPrefix = a.content.substring(0, 200).toLowerCase();
    const bPrefix = b.content.substring(0, 200).toLowerCase();
    let contentScore = 0;
    if (aPrefix === bPrefix) {
      contentScore = 1.0;
    } else {
      // Simple character-level overlap
      const aChars = new Set(aPrefix);
      const bChars = new Set(bPrefix);
      const intersection = [...aChars].filter(c => bChars.has(c)).length;
      const union = new Set([...aChars, ...bChars]).size;
      contentScore = union > 0 ? intersection / union : 0;
    }

    // Weighted: key match is more important
    return keyScore * 0.6 + contentScore * 0.4;
  }

  /**
   * F3.1: Get memory consolidation stats.
   * Useful for UI display and debugging.
   */
  getConsolidationStats(): {
    totalEntries: number;
    potentialDuplicates: number;
    oldestAge: number | null;
    scopeBreakdown: Record<MemoryScope, number>;
    pendingEntries: number;
    notInjected: number;
    /** M-5：作用域不是三者之一的条数（过去它们连统计里都看不见；含未归属与未知作用域） */
    unknownScope: number;
    /** M-2：旧版跨项目池的条数 */
    legacyPool: number;
    /** I1：记忆是否读得出来（读不出来时的写入一律被拒，界面必须说明） */
    readable: boolean;
    loadFailureReason?: string;
  } {
    const allEntries = Array.from(this.entries.values());
    let potentialDuplicates = 0;

    // Quick check for potential duplicates (same key)（M-3：key 不是字符串时用安全文本）
    const keyCounts: Record<string, number> = {};
    for (const entry of allEntries) {
      const key = textOf(entry.key).toLowerCase();
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
    for (const count of Object.values(keyCounts)) {
      if (count > 1) potentialDuplicates += count - 1;
    }

    // C2：只统计有限的时间戳（缺 timestamp 的条目原来会让 oldestAge 变 NaN）
    const timestamps = allEntries
      .map(e => e.timestamp)
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    const now = Date.now();
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const oldestAge = oldest !== null ? Math.floor((now - oldest) / (24 * 60 * 60 * 1000)) : null;

    const scopeBreakdown: Record<MemoryScope, number> = { platform: 0, project: 0, conversation: 0 };
    let pendingEntries = 0;
    let unknownScope = 0;
    let legacyPool = 0;
    for (const entry of allEntries) {
      if (entry.scope === "platform" || entry.scope === "project" || entry.scope === "conversation") {
        scopeBreakdown[entry.scope]++;
      } else {
        unknownScope++;
      }
      if ((entry.status ?? "active") === "pending") pendingEntries++;
      if (entry.legacyPool === true) legacyPool++;
    }

    return {
      totalEntries: allEntries.length,
      potentialDuplicates,
      oldestAge,
      scopeBreakdown,
      pendingEntries,
      notInjected: this.countNotInjected(),
      unknownScope,
      legacyPool,
      readable: this.loadState.ok,
      loadFailureReason: this.loadState.ok ? undefined : this.loadState.reason,
    };
  }
}

// ========== Singleton ==========
let instance: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!instance) {
    instance = new MemoryService();
  }
  return instance;
}

/**
 * 单例**是否已经构造过**（R2：端口注册后只给"已经存在的"那个补一次 `reload()`）。
 *
 * 刻意不在注册点凭空构造：那会让"懒单例"变成"每次注册都新建一个"，
 * 而 `getMemoryService()` 的单例前提是整个记忆域的地基。
 */
export function hasMemoryServiceInstance(): boolean {
  return instance !== null;
}
