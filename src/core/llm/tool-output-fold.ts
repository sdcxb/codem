/**
 * ## 工具输出折叠阶梯（用户提的机制，本轮落地）
 *
 * 用户的原话：「每次水位到了临近值，先不提示，先压缩距离对话时间远的工具输出
 *（因为工具输出对上下文和对话记忆没有帮助）……如果压缩了水位还高，再提示用户手动压缩或移交对话」。
 *
 * ### 为什么这条机制成立（有真机数据）
 * 另一台机器那条会话的日志视图里，工具结果占 **75,989 / 102,317 token（74%）**，
 * 正文只占 26% ⇒ **长对话的大头确实是工具输出**，而它们的信息**大多可以再取**
 *（重跑一次工具即可），代价远低于丢掉对话结论。所以"先折工具输出、还高才打扰用户"是对的。
 *
 * ### 三条必须守住的边界（否则就是把"静默丢信息"再实现一遍）
 * 1. **不销毁文本**：这是**读时视图**（`foldToolOutputs` 只产生新数组，不动入参、不写库）——
 *    权威日志里原文一直在，"取回"就是重跑工具或直接看历史；水位与发送都按**折叠后的视图**算，
 *    于是"面板数字"与"模型真正收到的"始终是同一口径。
 * 2. **最近的东西绝不折**：最近 `FOLD_MIN_KEEP_TURNS` 轮、以及最近 `FOLD_KEEP_RECENT_RESULTS`
 *    条工具结果一律原样（当前正在干的事依赖它们）。这条与压缩侧的"最近 3 轮不切断"同一条纪律。
 * 3. **分两类**：可重放（读文件/列目录/grep/构建/测试）折得狠一些；
 *    不可重放（网页抓取、外部 API、一次性命令、写文件后的结果）折得保守并**在片段里说明原因**。
 *
 * ### 阶梯
 * `0.5`（提示不出现的档）以下不折；到 `0.5` 起**静默折**（不打扰）；
 * 折完仍 ≥ `0.7` 才走既有横幅（手动压缩 / 移交）；`0.9` 是硬停 —— 横幅与阈值逻辑不变，
 * 只是它读到的水位已经是**折叠后**的水位 ⇒ 绝大多数会话永远看不到提示。
 */
import { pruneLargeToolResult } from "./context-fold";

/** 起来折叠的水位（= 常驻提示条出现的那一档之下的第一档） */
export const FOLD_TRIGGER_RATIO = 0.5;
/** 折叠目标：跌破 0.45（留一点余量，别在阈值上抖动） */
export const FOLD_TARGET_RATIO = 0.45;
/** 最近多少"轮"绝不折（轮 = 一条 user 到下一轮之前） */
export const FOLD_MIN_KEEP_TURNS = 3;
/** 最近多少条工具结果绝不折（与请求侧 `pruneStaleToolResults` 的默认值同源） */
export const FOLD_KEEP_RECENT_RESULTS = 2;

/** 不可重放类保留更大片段（head / tail） */
const IRREPRODUCIBLE_HEAD = 8192;
const IRREPRODUCIBLE_TAIL = 2048;
const IRREPRODUCIBLE_NOTE =
  "\n\n[... 这条工具结果来自**不可重放**的工具（重新执行不保证拿到同样内容），已保留更大片段；中段已折叠 ...]\n\n";
/** 可重放类沿用请求侧同一套裁剪形状（head 4096 + marker + tail 1024） */
const REPRODUCIBLE_NOTE_RE = /工具结果中段已裁剪/;

/**
 * 不可重放的工具名（**保守**清单：只列"重新执行不保证一致"的）。
 *
 * 判据取向：**不确定就当成不可重放**（宁可多留一点文本，也不许把取不回来的东西折狠）。
 * 所以这里列的是"可重放"的白名单更稳妥 —— 见 `isReproducibleTool`。
 */
const REPRODUCIBLE_TOOLS = new Set([
  "read",
  "read_file",
  "list",
  "list_dir",
  "glob",
  "grep",
  "search",
  "search_files",
  "find",
  "git_status",
  "git_diff",
  "git_log",
  "run_command",
  "exec",
  "shell",
  "bash",
  "test",
  "build",
  "typecheck",
  "tsc",
]);

/** 这个工具的结果能不能可靠地重新拿到？不在白名单里就按"不可重放"处理（保守） */
export function isReproducibleTool(tool: string): boolean {
  return REPRODUCIBLE_TOOLS.has(String(tool ?? "").toLowerCase());
}

/**
 * 该不该折？——**与横幅同一把尺子**（都用水位那个"选择后"的比例）。
 *
 * 为什么必须同一把尺子：折叠的目的是"让用户不被提示打扰"，而提示只看水位。
 * 若折叠按另一套口径（例如原始字符总量）触发，就会出现"水位没超、却动了上下文"的无谓改动。
 */
export function shouldFoldToolOutputs(levelRatio: number): boolean {
  if (!Number.isFinite(levelRatio)) return false;
  return levelRatio >= FOLD_TRIGGER_RATIO;
}
export interface FoldCandidate {
  /** 归属消息 id */
  messageId: string;
  /** 该消息里第几个工具调用 */
  toolIndex: number;
  tool: string;
  /** 折叠前字符数 */
  beforeChars: number;
  /** 折叠后字符数 */
  afterChars: number;
  reproducible: boolean;
  /** 同一（工具, 参数）的重复结果：只保留最新一次，更早的换存根 */
  duplicate?: boolean;
  /** 这条最多能压到多少字符（第二档存根只作用于可重放结果） */
  stubChars?: number;
}

export interface FoldResult {
  /** 折叠后的消息数组（新对象；入参一字不动） */
  messages: any[];
  /** 实际折叠的条目 */
  candidates: FoldCandidate[];
  /** 省下的字符数 */
  savedChars: number;
}

function toolResultChars(m: any): number {
  if (!Array.isArray(m?.toolCalls)) return 0;
  let n = 0;
  for (const tc of m.toolCalls) n += typeof tc?.result === "string" ? tc.result.length : 0;
  return n;
}

/** 第二档存根的正文上限（含标记；越小省得越多，但必须够模型判断"要不要重读"） */
const AGGRESSIVE_STUB_CHARS = 240;

/** 生成"短存根"：原长度 + 首行 + 工具名 + 可重读提示 */
function aggressiveStub(text: string, tool: string, originalChars: number, duplicate = false): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const head = firstLine.trim().slice(0, 120);
  if (duplicate) {
    return (
      `[重复读取同一参数的工具结果已折叠：原始 ${originalChars} 字符，工具 ${tool || "unknown"}]` +
      `\n（同一工具的同一参数在更近的位置还有一次结果；需要原文请重新调用该工具。）`
    ).slice(0, AGGRESSIVE_STUB_CHARS);
  }
  return (
    `[工具结果中段已折叠：原始 ${originalChars} 字符，工具 ${tool || "unknown"}]` +
    (head ? `\n首行：${head}` : "") +
    `\n（需要原文请重新调用该工具；这是读时视图，日志里的原文没有被删除。）`
  ).slice(0, AGGRESSIVE_STUB_CHARS);
}
/** 一条工具结果按类别折叠（可重放走请求侧同一形状；不可重放留更大片段并说明） */
function foldOne(text: string, reproducible: boolean): string {
  if (!text) return text;
  if (reproducible) return pruneLargeToolResult(text);
  if (REPRODUCIBLE_NOTE_RE.test(text)) return text;
  if (text.length <= IRREPRODUCIBLE_HEAD + IRREPRODUCIBLE_TAIL) return text;
  return `${text.slice(0, IRREPRODUCIBLE_HEAD)}${IRREPRODUCIBLE_NOTE}${text.slice(-IRREPRODUCIBLE_TAIL)}`;
}

/**
 * 选出该折哪些工具结果（**按 距离 × 体积** 排序，绝不碰最近几轮/最近几条）。
 *
 * @param messages 可见消息（时间升序）
 * @param opts.protectedFromIndex 从这个下标起（含）属于"最近 FOLD_MIN_KEEP_TURNS 轮"，一律保护；
 *                                调用方可用 `protectedFromIndexForTurns()` 算出来。
 */
export function planToolOutputFold(
  messages: any[],
  opts: {
    protectedFromIndex: number;
    keepRecentResults?: number;
    minFoldChars?: number;
  },
): FoldCandidate[] {
  const keepRecent = opts.keepRecentResults ?? FOLD_KEEP_RECENT_RESULTS;
  /** 小于存根尺寸的结果本来就压不动，不必进入候选 */
  const minFoldChars = opts.minFoldChars ?? AGGRESSIVE_STUB_CHARS;

  /* 先定位"最近 N 条工具结果"所属的消息下标（它们一律保护） */
  const withResults: number[] = [];
  messages.forEach((m, i) => {
    if (toolResultChars(m) > 0) withResults.push(i);
  });
  const protectedByRecency = new Set(withResults.slice(Math.max(0, withResults.length - keepRecent)));

  /**
   * 只有**带参数**的调用才参与重复检测：无参工具（git_status / build 之类）每次结果都可能不同，
   * 把"同一工具名"当重复会把它们的旧结果全换成存根（实验里这就是 FOLD-LONGTURN-5 的误判）。
   */
  const hasArgs = (tc: any): boolean => {
    const a = tc?.args;
    if (a === undefined || a === null) return false;
    if (typeof a === "object" && Object.keys(a).length === 0) return false;
    return true;
  };
  const keyOf = (tc: any): string => {
    const tool = String(tc?.tool ?? "").toLowerCase();
    let args = "";
    try {
      args = JSON.stringify(tc?.args ?? null);
    } catch {
      args = "?";
    }
    return `${tool}|${args}`;
  };
  /**
   * 每个 (工具, 参数) 的**最后一次**出现（全局，含受保护的那些）——
   * 用于"重复读取"去重：只保留最新一次的结果，更早的同一路径结果换成存根。
   */
  const lastByKey = new Map<string, string>();
  messages.forEach((m) => {
    if (!Array.isArray(m?.toolCalls)) return;
    m.toolCalls.forEach((tc: any, ti: number) => {
      if (!isReproducibleTool(String(tc?.tool ?? "")) || !hasArgs(tc)) return;
      const text = typeof tc?.result === "string" ? tc.result : "";
      if (text.length > AGGRESSIVE_STUB_CHARS) lastByKey.set(keyOf(tc), `${m.id}#${ti}`);
    });
  });

  const out: FoldCandidate[] = [];
  messages.forEach((m, i) => {
    if (protectedByRecency.has(i)) return; // 最近几条工具结果：保护
    if (!Array.isArray(m?.toolCalls)) return;
    m.toolCalls.forEach((tc: any, ti: number) => {
      const text = typeof tc?.result === "string" ? tc.result : "";
      if (text.length <= minFoldChars) return;
      const reproducible = isReproducibleTool(String(tc?.tool ?? ""));
      const folded = foldOne(text, reproducible);
      const key = `${m.id}#${ti}`;
      const duplicate = reproducible && hasArgs(tc) && lastByKey.get(keyOf(tc)) !== key;
      /*
       * 第一档折不动、也不是重复读取 ⇒ 这条没有收益（例如 2K 的可重放结果，
       * 第一档的 head 4096 比它还大）。但**重复读取**即使第一档折不动也有收益
       * （第二档换成 240 字存根），所以单独放行。
       */
      /*
       * 第一档折不动（例如 2K 的可重放结果，head 4096 比它还大）也**要进候选**：
       * 第二档能把它换成 240 字存根。真机上大量工具结果正是 1–2K。
       */
      const stubbable = reproducible && text.length > AGGRESSIVE_STUB_CHARS;
      if (!duplicate && folded.length >= text.length && !stubbable) return;
      const afterChars = Math.min(folded.length, text.length);
      out.push({
        messageId: String(m.id),
        toolIndex: ti,
        tool: String(tc?.tool ?? ""),
        beforeChars: text.length,
        afterChars,
        reproducible,
        duplicate,
        /** 最多能压到多少（第二档存根只能作用于可重放结果） */
        stubChars: reproducible ? Math.min(afterChars, AGGRESSIVE_STUB_CHARS) : afterChars,
      });
    });
  });

  /*
   * 排序：**距离 × 可省体积** —— 只看距离可能一条都不降，只看体积又会先折"刚刚发生的大动作"。
   * 重复读取按"换成 240 字存根"估算收益，否则它会被排到最后（第一档对它是 0 收益）。
   */
  const n = Math.max(1, messages.length);
  return out.sort((a, b) => {
    const idxA = messages.findIndex((m) => String(m?.id) === a.messageId);
    const idxB = messages.findIndex((m) => String(m?.id) === b.messageId);
    const saveA = Math.max(a.beforeChars - a.afterChars, a.beforeChars - (a.stubChars ?? a.afterChars));
    const saveB = Math.max(b.beforeChars - b.afterChars, b.beforeChars - (b.stubChars ?? b.afterChars));
    const scoreA = (n - idxA) * saveA;
    const scoreB = (n - idxB) * saveB;
    return scoreB - scoreA;
  });
}

export function foldToolOutputsUnderTarget(
  messages: any[],
  opts: {
    protectedFromIndex: number;
    targetTokens: number;
    estimate: (msgs: any[]) => number;
    keepRecentResults?: number;
    maxFold?: number;
  },
): FoldResult {
  const all = planToolOutputFold(messages, {
    protectedFromIndex: opts.protectedFromIndex,
    keepRecentResults: opts.keepRecentResults,
  });
  const limit = opts.maxFold ?? all.length;
  let current = messages;
  const applied: FoldCandidate[] = [];
  /** 进入过评估的候选（含"第一档折不动但第二档能换存根"的），第二档要用 */
  const reviewed: FoldCandidate[] = [];
  let savedChars = 0;

  for (const cand of all) {
    if (applied.length >= limit) break;
    if (opts.estimate(current) <= opts.targetTokens) break;
    reviewed.push(cand);
    const next = current.map((m: any) => {
      if (String(m?.id) !== cand.messageId || !Array.isArray(m.toolCalls)) return m;
      const calls = m.toolCalls.map((tc: any, ti: number) => {
        if (ti !== cand.toolIndex) return tc;
        const text = typeof tc?.result === "string" ? tc.result : "";
        const folded = foldOne(text, cand.reproducible);
        return folded === text ? tc : { ...tc, result: folded };
      });
      return { ...m, toolCalls: calls };
    });
    const changed = next.some((m: any, i: number) => m !== current[i]);
    if (!changed) continue; // 第一档没收益；留给第二档
    current = next;
    applied.push(cand);
    savedChars += cand.beforeChars - cand.afterChars;
  }

  /*
   * 第二档：第一档折完仍高于目标 ⇒ 把**可重放**的结果换成短存根。
   *
   * 为什么可以这么狠：这些是"较远 + 可重放"的工具结果（读文件/列目录/grep/构建…），
   * 需要原文时重跑一次工具即可；保留 5K 对模型几乎没有增量信息，却持续占着预算。
   * 不可重放的（网页抓取、一次性命令）**不参与**这一档。
   *
   * ⚠️ 2026-10-19 补：第二档也覆盖**第一档折不动的小结果**（2K~5K）与**重复读取**——
   * 真机上大量工具结果在 1–2K，只走第一档时它们根本不进候选（而它们加起来才是大头）。
   */
  if (opts.estimate(current) > opts.targetTokens) {
    const stubbable = reviewed
      .filter((c) => c.reproducible && c.beforeChars > AGGRESSIVE_STUB_CHARS)
      .sort((a, b) => b.beforeChars - a.beforeChars);
    for (const cand of stubbable) {
      if (opts.estimate(current) <= opts.targetTokens) break;
      const next = current.map((m: any) => {
        if (String(m?.id) !== cand.messageId || !Array.isArray(m.toolCalls)) return m;
        const calls = m.toolCalls.map((tc: any, ti: number) => {
          if (ti !== cand.toolIndex) return tc;
          const text = typeof tc?.result === "string" ? tc.result : "";
          if (!text) return tc;
          const stub = aggressiveStub(text, String(tc?.tool ?? ""), cand.beforeChars, Boolean(cand.duplicate));
          return stub.length < text.length ? { ...tc, result: stub } : tc;
        });
        return { ...m, toolCalls: calls };
      });
      const changed = next.some((m: any, i: number) => m !== current[i]);
      if (!changed) continue;
      current = next;
      savedChars += Math.max(0, cand.beforeChars - (cand.stubChars ?? AGGRESSIVE_STUB_CHARS));
    }
  }

  return { messages: current, candidates: applied, savedChars };
}

/**
 * 从消息数组算出"最近 FOLD_MIN_KEEP_TURNS 轮"的起点下标（轮 = 一条 user 到下一轮之前）。
 *
 * 与压缩侧 `compactionMinKeep` 同一条纪律：**最近几轮绝不切断** ——
 * 这里用它决定"哪些工具结果不许折"。
 */
export function protectedFromIndexForTurns(
  messages: any[],
  turns = FOLD_MIN_KEEP_TURNS,
): number {
  if (turns <= 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      seen += 1;
      if (seen >= turns) return i;
    }
  }
  return 0;
}

/**
 * 共享入口：**需要折就折**，返回折叠后的消息与两侧的比例。
 *
 * 水位、面板、引擎请求三处必须走这**同一个函数** —— 否则会出现
 * 「面板显示 85% 但横幅不弹」（引擎折了、面板没算）这种自相矛盾。
 *
 * @param available 该口径下的可用 token（水位是 `窗口×0.9`）
 */
export function foldForLevelIfNeeded(
  messages: any[],
  opts: { available: number; estimate: (msgs: any[]) => number; keepRecentResults?: number },
): { messages: any[]; folded: number; savedChars: number; ratioBefore: number; ratioAfter: number } {
  const before = opts.estimate(messages);
  const ratioBefore = opts.available > 0 ? before / opts.available : 0;
  if (!shouldFoldToolOutputs(ratioBefore)) {
    return { messages, folded: 0, savedChars: 0, ratioBefore, ratioAfter: ratioBefore };
  }
  const fold = foldToolOutputsUnderTarget(messages, {
    protectedFromIndex: protectedFromIndexForTurns(messages),
    targetTokens: Math.floor(opts.available * FOLD_TARGET_RATIO),
    estimate: opts.estimate,
    keepRecentResults: opts.keepRecentResults,
  });
  const after = opts.estimate(fold.messages);
  return {
    messages: fold.messages,
    folded: fold.candidates.length,
    savedChars: fold.savedChars,
    ratioBefore,
    ratioAfter: opts.available > 0 ? after / opts.available : 0,
  };
}