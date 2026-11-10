/**
 * 文档同步硬闸的**纯判定**（C06 边界②；25 §P2 抽出来供回放/评测复用）。
 *
 * ## 为什么从 `completion-guards.ts` 拆出来
 *
 * 原来的 `judgeDocumentSyncGate` 与环境耦合：它在内部调用 `documentSyncMaxBlocks()`，
 * 而那个函数要读 `ContextManager` 的配置（连带存储、React 上下文等一串依赖）。
 * 后果是「同一份判定」无法在**不启动应用**的回放脚本里跑：
 * `tools/eval/context-os-replay.mjs` 只能选择复制一份逻辑（会漂移）或者整包打包（跑不起来）。
 *
 * 拆成零依赖模块后：
 * - 判定本身只认参数（`codeEdited` / 文档事实 / 已拦键 / 已拦次数 / 额度）；
 * - 配置读取留在 `completion-guards.ts` 的包装函数里（**唯一读取点**不变）；
 * - 回放脚本 import 的是**产品同一份实现**，不是复述。
 *
 * ## 判定语义（与拆分前逐字一致）
 *
 * 1. 本轮没改文件 / 账本里没有带版本的文档 / 没有 stale 事实 ⇒ `none`；
 * 2. 同一（文档 + 版本）已经拦过 ⇒ `release-unverified`（`same-version`）；
 * 3. 会话额度用尽 ⇒ `release-unverified`（`cap`）；
 * 4. 否则 `block`，并把**本次新拦下**的键交给调用方记账。
 *
 * `maxBlocks` 的 `0` 表示**不限**（与 `codem-context-config.documentSyncMaxBlocks`
 * 的配置语义一致）；缺省/非法 ⇒ 3。
 */

/** 同一份文档的同一版本最多拦一次；缺省额度 = 3（上限与合法范围校验在配置层）。 */
export const DEFAULT_DOCUMENT_SYNC_MAX_BLOCKS = 3;

/**
 * 把「额度」归一成判定用的数字。
 *
 * - `undefined` ⇒ 3（旧配置没有这个键）；
 * - `0` ⇒ `Infinity`（不限；第一层「同一文档同一版本只拦一次」仍然生效 ⇒ 不会死循环）；
 * - 正整数 / `Infinity` ⇒ 原值；
 * - 其余（负数 / 小数 / NaN / 字符串…）⇒ 3。
 *
 * ⚠️ 合法范围（1..10）与非法值告警由配置层（`completion-guards.ts`）负责 ——
 * 那是**配置策略**，不是判定语义；放在这里会让纯模块开始关心设置面板。
 */
export function normalizeDocumentSyncMaxBlocks(raw: unknown): number {
  if (raw === undefined) return DEFAULT_DOCUMENT_SYNC_MAX_BLOCKS;
  if (raw === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    if (raw === 0) return Number.POSITIVE_INFINITY;
    if (raw > 0) return raw;
  }
  return DEFAULT_DOCUMENT_SYNC_MAX_BLOCKS;
}

/** 一条 stale 事实（`documentSyncCheck` 的 `changed` / `unreadableFacts` 投影）。 */
interface DocumentSyncStaleFact {
  documentId: string;
  name: string;
  updatedAt?: number;
  sha256?: string | null;
}

/**
 * 同一（文档 id + 版本）的稳定键。
 *
 * 为什么用「当前观测版本」而不是「账本记录版本」：同一份文档在读过之后又改了两次，
 * 第二次是一个**新版本**，应该再获得一次拦截机会；用账本版本会让两次改动共用一个键。
 */
function documentSyncFactKey(fact: DocumentSyncStaleFact): string {
  return `${fact.documentId}@${fact.updatedAt ?? "?"}:${fact.sha256 ?? "?"}`;
}

/** 硬闸判定：`none` = 不适用；`block` = 拒绝标记完成；`release-unverified` = 放行但标未验。 */
type DocumentSyncGate = "none" | "block" | "release-unverified";

/** 硬闸纯判定的完整结果（判定 + 记账用的键）。 */
export interface DocumentSyncGateDecision {
  verdict: DocumentSyncGate;
  /** 本次观测到的全部 stale 键（去重、稳定顺序；落日志与复现都用它） */
  keys: string[];
  /** 本次**新拦下**的键（`verdict=block` 时由调用方记入会话额度；其余为空） */
  newlyBlocked: string[];
  /** 放行原因：同一（文档 + 版本）已经拦过 / 会话总上限已到 */
  releaseReason?: "same-version" | "cap";
}

/** 纯判定的入参（额度直接给数字，不在这里读配置）。 */
export interface JudgeDocumentSyncGateArgs {
  /** 本轮改过文件/代码 */
  codeEdited: boolean;
  /** 账本里**记过版本**（updatedAt/sha256）的文档数 */
  versionedDocuments: number;
  /** 读过之后版本变了的文档（带当前观测版本） */
  changedDocuments: DocumentSyncStaleFact[];
  /** 带版本但当前读不到的文档（带账本记录版本） */
  unreadableDocuments: DocumentSyncStaleFact[];
  /** 本会话已经拦过的（文档 id + 版本）键 */
  blockedKeys: readonly string[];
  /** 本会话已经拦过几次 */
  blocksIssued: number;
  /** 每会话拦截额度（0 = 不限；缺省 3） */
  maxBlocks?: number;
}

/**
 * **C06 硬闸的纯判定**：不读存储、不读时钟、不读配置。
 *
 * @see completion-guards.ts 的 `judgeDocumentSyncGate`（包装：读配置后调本函数）
 */
export function judgeDocumentSyncGate(args: JudgeDocumentSyncGateArgs): DocumentSyncGateDecision {
  const none: DocumentSyncGateDecision = { verdict: "none", keys: [], newlyBlocked: [] };
  if (!args.codeEdited) return none;
  if (args.versionedDocuments <= 0) return none;
  const stale = [...args.changedDocuments, ...args.unreadableDocuments];
  if (stale.length === 0) return none;
  const keys = [...new Set(stale.map(documentSyncFactKey))];
  const blocked = new Set(args.blockedKeys);
  const pending = keys.filter((key) => !blocked.has(key));
  if (pending.length === 0) {
    return { verdict: "release-unverified", keys, newlyBlocked: [], releaseReason: "same-version" };
  }
  if (args.blocksIssued >= normalizeDocumentSyncMaxBlocks(args.maxBlocks)) {
    return { verdict: "release-unverified", keys, newlyBlocked: [], releaseReason: "cap" };
  }
  return { verdict: "block", keys, newlyBlocked: pending };
}
