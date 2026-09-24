/**
 * 数据目录**台账**（第 62 轮；对标 `dsh-desktop` 的 `desktop-data-directory.ts`）。
 *
 * ## 为什么需要它（真机上会出现的一种沉默）
 *
 * 数据根目录的唯一来源是引擎解析出来的库路径（见 `data-root.ts`）。而库路径可以被
 * **环境变量 `CODEM_DB_PATH`** 指到别处 —— 于是下面两件事在今天的界面上**无法区分**：
 *
 * | 实际发生了什么 | 界面表现 |
 * | --- | --- |
 * | 用户换了/丢了数据目录（新目录是空的） | "没有会话、没有项目" |
 * | 用户的数据真的没了 | "没有会话、没有项目" |
 *
 * 两者一模一样，而第一种是**可解释、可恢复**的（旧目录还在机器上）。台账就是把
 * "这一次的 active 数据目录是哪儿、上一处是哪儿、是第几代"变成**可查事实**。
 *
 * ## 四条纪律
 *
 * 1. **只记账，绝不复制**：切换目录**不会**把旧目录的数据搬过来（那是最容易做错的事：
 *    半拷贝、覆盖、把两代数据混在一起）。旧数据原地不动，用户自己决定。
 * 2. **台账放在"标准数据目录"里，而不是 active 目录里**：放在 active 目录的话，
 *    切到新目录后台账也跟着"重置"，第 1 代与第 9 代看起来一样。
 * 3. **写是原子的**（先写 `<file>.tmp`，再 `rename_file` 覆盖）；
 *    且**只在真的变了的时候才写** —— 每次启动都重写会让 mtime 失去意义
 *    （"什么时候换的目录"就答不出来了）。
 * 4. **读失败 ≠ 没有台账**：解析不了时**不覆盖**（否则把用户的历史抹掉），
 *    而是把现场另存成 `<file>.corrupt-<时间戳>` 并**如实上报**（`ledgerUnreadable`）。
 *
 * ## 与 `dsh-desktop` 的一处**有意不同**
 *
 * 那边还把目录权限收紧到 `0700`/`0600`。本仓库主战场是 Windows，POSIX 权限位没有意义，
 * 所以这里**不做**、也**不声称**做了；这里只记 `targetState`
 * （新目录**切换前**是空的还是已有数据）—— 那才是"用户有没有旧数据可回退"的关键信息。
 */

const LEDGER_FILE = "data-home.json";

export const LEDGER_VERSION = 1;

/** 这一次的 active 目录是**怎么来的** */
type DataHomeSource = "standard" | "app-data-dir-fallback";

export interface DataHomeLedger {
  version: number;
  /** 当前数据目录（绝对值，带尾部分隔符） */
  activeHome: string;
  /** 上一次的数据目录（首次为 null） */
  previousHome: string | null;
  /** 第几代（每次 activeHome 变化 +1；首次为 1；**0 = 不知道**） */
  generation: number;
  source: DataHomeSource;
  /** 引擎给的原因（非标准位置时） */
  reason?: string;
  /** 本次切换时，新目录里**切换前**有没有库文件 */
  targetState: "empty" | "existing";
  updatedAt: string;
  /** 历史（最近 10 代） */
  history: Array<{ home: string; at: string; generation: number }>;
}

export interface RecordOutcome {
  ledger: DataHomeLedger;
  /** true = 这次真的换了 active 目录（generation +1） */
  changed: boolean;
  /** true = 这台机器第一次记台账 */
  firstSeen: boolean;
  /** 台账**读不出来**（文件在但解析失败）—— 与"没有台账"是两件事 */
  ledgerUnreadable: boolean;
  /** 原子写是否成功（失败不许静默） */
  written: boolean;
  /** 读失败/写失败的原因 */
  why?: string;
}

export interface DataRootLike {
  root: string;
  origin: "engine" | "app-data-dir";
  dbPath?: string;
  standard?: boolean;
  reason?: string;
}

function invokeFn(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  return typeof invoke === "function" ? (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) : null;
}

function join(base: string, name: string): string {
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  const trimmed = base.endsWith("/") || base.endsWith("\\") ? base.slice(0, -1) : base;
  return `${trimmed}${sep}${name}`;
}

/** 台账文件路径。**必须**由调用方给出标准数据目录（不在本模块里再算一遍，避免第二个真相） */
export function ledgerPathIn(standardDir: string): string {
  return join(standardDir, LEDGER_FILE);
}

/**
 * 读台账。
 *
 * - 返回 `null` = **文件不存在**（第一次跑）；
 * - **抛错** = 读到了但不可用（IO 失败 / 解析失败）—— 调用方必须区别对待。
 */
export async function readDataHomeLedger(standardDir: string): Promise<DataHomeLedger | null> {
  const invoke = invokeFn();
  if (!invoke) throw new Error("没有 Tauri 运行时，读不了数据目录台账");
  const path = ledgerPathIn(standardDir);
  const exists = (await invoke("path_exists", { path })) === true;
  if (!exists) return null;
  const text = String((await invoke("read_file", { path })) ?? "");
  const parsed = JSON.parse(text) as DataHomeLedger;
  if (!parsed || typeof parsed.activeHome !== "string" || typeof parsed.generation !== "number") {
    throw new Error("台账内容不是本模块认识的形状");
  }
  return parsed;
}

/** 原子写：先写 `.tmp`，再 `rename_file` 覆盖（避免"写一半"留下半个台账） */
async function writeLedgerAtomic(standardDir: string, ledger: DataHomeLedger): Promise<void> {
  const invoke = invokeFn();
  if (!invoke) throw new Error("没有 Tauri 运行时，写不了数据目录台账");
  const path = ledgerPathIn(standardDir);
  const tmp = `${path}.tmp`;
  await invoke("write_file", { path: tmp, content: JSON.stringify(ledger, null, 2) });
  await invoke("rename_file", { oldPath: tmp, newPath: path });
}

/** 解析失败时把现场另存（**不覆盖**原文件；读得到原文才存） */
async function preserveCorruptLedger(standardDir: string, at: string): Promise<void> {
  const invoke = invokeFn();
  if (!invoke) return;
  const path = ledgerPathIn(standardDir);
  try {
    const text = String((await invoke("read_file", { path })) ?? "");
    const stamp = at.replace(/[:.]/g, "-");
    await invoke("write_file", { path: `${path}.corrupt-${stamp}`, content: text });
  } catch {
    /* 连原文都读不出来：那就没有可保存的现场（不影响主流程） */
  }
}

/**
 * 目标目录在**切换之前**有没有数据。
 *
 * 判据取"引擎实际用的库文件在不在"（`dbPath`），而不是"目录里有没有文件"：
 * 目录里可能只有日志或附件，那不算"有可回退的库"。
 */
async function detectTargetState(root: DataRootLike): Promise<"empty" | "existing"> {
  const invoke = invokeFn();
  if (!invoke || !root.dbPath) return "empty";
  try {
    return (await invoke("path_exists", { path: root.dbPath })) === true ? "existing" : "empty";
  } catch {
    return "empty";
  }
}

/**
 * 记录本次的 active 数据目录（启动时调用一次）。
 *
 * 幂等：目录没变时**不递增** generation、**不重写**文件。
 * 读不出来时**不假装是第一次**（`generation: 0` = 不知道），且**不覆盖**台账。
 */
export async function recordActiveDataHome(standardDir: string, info: DataRootLike): Promise<RecordOutcome> {
  const now = new Date().toISOString();
  const source: DataHomeSource =
    info.origin === "engine" && info.standard === true ? "standard" : "app-data-dir-fallback";
  const targetState = await detectTargetState(info);

  let existing: DataHomeLedger | null = null;
  let unreadable = false;
  let why: string | undefined;
  try {
    existing = await readDataHomeLedger(standardDir);
  } catch (e) {
    unreadable = true;
    why = `台账读不出来：${e instanceof Error ? e.message : String(e)}`;
    await preserveCorruptLedger(standardDir, now);
  }

  if (unreadable) {
    return {
      ledger: {
        version: LEDGER_VERSION,
        activeHome: info.root,
        previousHome: null,
        generation: 0, // 0 = 不知道第几代（不许假装是第 1 代）
        source,
        reason: info.reason,
        targetState,
        updatedAt: now,
        history: [],
      },
      changed: false,
      firstSeen: false,
      ledgerUnreadable: true,
      written: false,
      why,
    };
  }

  if (existing && existing.activeHome === info.root) {
    return { ledger: existing, changed: false, firstSeen: false, ledgerUnreadable: false, written: false };
  }

  const generation = existing ? existing.generation + 1 : 1;
  const history = existing
    ? [...existing.history, { home: existing.activeHome, at: existing.updatedAt, generation: existing.generation }].slice(-10)
    : [];
  const ledger: DataHomeLedger = {
    version: LEDGER_VERSION,
    activeHome: info.root,
    previousHome: existing ? existing.activeHome : null,
    generation,
    source,
    reason: info.reason,
    targetState,
    updatedAt: now,
    history,
  };
  try {
    await writeLedgerAtomic(standardDir, ledger);
    return { ledger, changed: true, firstSeen: existing === null, ledgerUnreadable: false, written: true };
  } catch (e) {
    return {
      ledger,
      changed: true,
      firstSeen: existing === null,
      ledgerUnreadable: false,
      written: false,
      why: `台账写入失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 把台账说成一句人话（日志/界面共用；只陈述事实） */
export function describeDataHome(outcome: RecordOutcome): string {
  const { ledger, changed, firstSeen, ledgerUnreadable, written } = outcome;
  if (ledgerUnreadable) {
    return (
      `数据目录台账读不出来（${outcome.why ?? "原因未知"}）：当前数据目录 ${ledger.activeHome}；` +
      "**本次未改动台账**（现场已另存为 .corrupt-*）"
    );
  }
  if (firstSeen) {
    return `数据目录：${ledger.activeHome}（第 1 代，来源 ${ledger.source}${written ? "" : "，⚠️ 台账写入失败"}）`;
  }
  if (!changed) {
    return `数据目录未变化：${ledger.activeHome}（第 ${ledger.generation} 代）`;
  }
  const prev = ledger.previousHome ? `上一处是 ${ledger.previousHome}，` : "";
  const oldData = ledger.targetState === "existing" ? "新目录里**已有**库文件" : "新目录当时是空的";
  return (
    `⚠️ 数据目录已切换到 ${ledger.activeHome}（第 ${ledger.generation} 代）：${prev}${oldData}；` +
    "**旧目录的数据没有被复制过来**（本模块只记账、从不搬运）——要回到旧数据，请把库路径指回旧目录"
  );
}
