import { useState, useEffect, useRef } from "react";
import { StatusBanner } from "./ui/StatusBanner";
import { getContextManager, summarizeDisplayPressure, type TokenBudget, type CompactionConfig } from "../core/context/context";
import { getCostTracker } from "../core/llm/cost-tracker";
import { listVisibleMessages, deleteMessagesByIds, createMessage, getLastDeleteReport } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { setCompactionInProgress } from "../core/storage/compaction-state";
import {
  foldStaleCompactionMarkers,
  nextCompactionMarkerId,
  renderStructuredHistorySummary,
  summarizeModelContext,
  /* 第 228 波：保留集的"最近 3 轮不切断"与自动压缩共用同一条口径 */
  compactionMinKeep,
  COMPACTION_MIN_KEEP_TURNS,
  /* 第 228 波审计：识别"上一次的摘要标记"，避免它被渲染第二遍（会让上下文变大） */
  isCompactionMarker,
} from "../core/llm/compaction-budget";
/* 第 228 波审计：手动与自动压缩必须互斥（共用同一把按会话的锁） */
import { acquireCompactionLock, releaseCompactionLock } from "../core/llm/compaction-control";
import { getTokenTracker } from "../core/llm/token-tracker";
import { pruneStaleToolResults } from "../core/llm/context-fold";
import { getSettingJSON } from "../core/storage/settings";
import { reportActionFailure, reportPersistFailure } from "../core/storage/persist-failure";
import { FALLBACK_CONTEXT_WINDOW } from "../core/context/water-level";

interface ContextMonitorProps {
  sessionId: string;
  visible: boolean;
}

// 默认 budget，让面板在无会话时也能显示。
//
// 第 122 轮：窗口兜底值改从 `core/context/water-level.ts` 取 —— 常驻水位提示条
// 也要在拿不到真实窗口时兜底，两处必须是同一个数，否则面板与提示条会分叉。
const DEFAULT_BUDGET: TokenBudget = {
  total: FALLBACK_CONTEXT_WINDOW,
  systemPrompt: 2000,
  outputReserve: 4096,
  available: 121904,
  used: 0,
  remaining: 121904,
};

/**
 * 压缩完成后的**冷却期**（第 227 波，用户实报「没出现进度也没出现压缩提示 ⇒ 很容易重复点」）。
 *
 * 为什么需要它：`manualCompact()` 很快（同步、不调模型），原来的守卫在动作结束的同一刻就放开了
 * ⇒ 用户连点两下真的会压两次（第二次删的是刚保留下来的那批旧消息，多丢一批上下文）。
 * 冷却期内按钮**禁用 + 写明刚刚压缩过**，让"已经发生过了"这件事有可点的证据。
 */
const COMPACT_COOLDOWN_MS = 8000;

/**
 * 手动压缩**逐字保留的条数上限**（第 228 波）。
 *
 * 它不再是唯一条件：还会叠加"最近 `COMPACTION_MIN_KEEP_TURNS` 轮绝不切断"这条保底
 * （见 `manualCompact`）—— 于是"最近几轮"在大消息刷屏时也不会被切进中间。
 */
const MANUAL_KEEP_MESSAGES = 20;

interface ProviderBalance {
  provider: string;
  balance: string | null;
  currency: string;
  loading: boolean;
  error: string | null;
}

/** 从 SQLite settings 读取已配置 API Key 的 provider 列表 */
function getConfiguredProviders(): Array<{ id: string; name: string; apiKey: string; baseUrl: string }> {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    if (!settings.providers) return [];
    return settings.providers.filter((p: any) => p.apiKey && p.id !== "mimo");
  } catch {
    return [];
  }
}

/** 查询 DeepSeek 账户余额 */
async function fetchDeepSeekBalance(apiKey: string, baseUrl: string): Promise<{ balance: string; currency: string }> {
  // DeepSeek 余额 API: GET /user/balance
  // baseUrl 可能是 https://api.deepseek.com 或 https://api.deepseek.com/v1
  const root = baseUrl.replace(/\/v1\/?$/, "");
  const resp = await fetch(`${root}/user/balance`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const info = data.balance_infos?.[0];
  if (info) {
    return { balance: info.total_balance, currency: info.currency || "CNY" };
  }
  throw new Error("No balance info");
}

/**
 * 手动压缩上下文：删除旧消息并插入摘要标记。
 *
 * ## 第 45 轮（功能上下文审计 P1-D5）：补三件原来完全没有的事
 *
 * 1. **并发闸门**：加 `setCompactionInProgress(true/false)`。这个标志是"压缩正在改库"的
 *    唯一告示牌 —— `store.saveMessages`（`src/store.ts:510`）与
 *    `telemetry`（`core/telemetry/telemetry.ts:506`）都按它退让。自动压缩有它
 *    （`agentic-loop.ts:3445`），手动压缩原来**没有**：压缩期间任何一次 UI 自动保存
 *    都会继续把"面板截取的那份旧列表"重新写回库 —— 压缩被部分撤销（被软删的消息复活）。
 * 2. **compaction 事件**：事件日志是投影/世代追踪的唯一输入，手动压缩原来一条都不写，
 *    于是"这次压缩发生过"在事件侧不存在（`getActiveGenerations` 之类看不到它）。
 * 3. **旧摘要标记折叠**：与自动路径共用 `foldStaleCompactionMarkers`
 *    （手动压缩的标记前缀 `[上下文已手动压缩]` 原来连自动路径的扫描都匹配不到，
 *    因此永远折叠不了、永远清不掉）。
 *
 * @returns 实际移除/保留的条数（面板展示用）
 *
 * 导出是为了让"手动压缩"这条数据路径可以被用例直接驱动
 * （`src/test/feature-context-fixes.test.ts` 的 FC-D5* 就是对着它跑的）。
 *
 * ## 第 47 轮修正（功能上下文审计 P2-D8）：摘要不再是"100 字符截断拼接"
 *
 * 原来这里自己拼摘要：
 * ```ts
 * const snippet = (msg.content || "").substring(0, 100);   // ← 从中间切断代码/路径/命令
 * summaryParts.push(`- 工具调用: ${tc.tool}`);              // ← 只有名字，参数与结果全丢
 * if (summary.length > 1000) summary = summary.substring(0, 1000) + "\n...(更多历史已省略)";
 * ```
 * 一个几十万 token 的会话被压成 ≤1000 字符的无结构列表 —— 与自动路径的 LLM 结构化检查点
 * **不可比**，恢复工作时既不知道动过哪些文件、也不知道报过什么错。
 *
 * 现在改用共享渲染器 `renderStructuredHistorySummary`（`compaction-budget.ts`）：
 * 每条消息的正文上限从 100 提到 2000/1500（实际内容基本完整），工具调用保留
 * **名字 / 参数 / 结果**三段，并抽出 `涉及文件` / `错误` / `待办` 三段可检索结论；
 * 超限时按段显式标记省略了多少字符（不再静默砍尾）。
 *
 * ⚠️ 诚实交代：这里仍然**不调 LLM**（手动压缩是同步动作，面板按钮不该等一次模型调用），
 * 所以它与自动路径**不是同一种摘要**：自动路径是 LLM 检查点，这里是确定性结构化摘要。
 * 但两者的**渲染契约**（段名、显式上限、不丢路径/错误/待办）已经统一，
 * 且这里的摘要会作为级联输入带进下一次自动压缩（`folded.existingSummary`）。
 */
export function manualCompact(sessionId: string): {
  removed: number;
  kept: number;
  skipped?: string;
  /** ★ 全量审计：真实删除结果带来的补充说明（索引没回应 / 有条目查不到归属） */
  receiptNote?: string;
  softDeleteIncomplete?: boolean;
} {
  /**
   * P2-D12：可见消息的**唯一读法**是 `listVisibleMessages` ——
   * `listMessages` 会把软删（压缩隐藏）的历史也带回来，用它算"要压缩多少条／
   * 压缩后剩多少条"口径就与模型看到的集合不一致（模型侧读的是 `listMessages` 后
   * `filter(!hidden)`，见 `agentic-loop.ts::buildMessages`）。
   */
  const messages = listVisibleMessages(sessionId);
  /*
   * ★ 全量审计（低）：这个「没压成」必须带真实原因 ——
   * 不带 skipped 时面板会按模板写成「没有可移除的消息…保留最近 20 条」，与真因不符。
   */
  if (messages.length <= 2)
    return {
      removed: 0,
      kept: messages.length,
      skipped: "可见消息太少（不多于 2 条），压缩无法减小上下文",
    };

  /**
   * ★ 第 228 波审计修复（中）：**手动压缩也要取同一把压缩锁**。
   *
   * 被守的缺陷：锁此前只覆盖"自动 → 自动"，手动路径既不取锁也不看标志
   * ⇒ 自动压缩正在**等摘要**（锁内有一段 LLM await）时用户点一下，两条路径各写一条标记
   * （两条标记的时间戳算法逐字相同），而折叠只带走"最靠后"的那一条 ⇒ 另一份摘要只能以
   * 被裁剪后的形态存活。现在拿不到锁就直接返回 `skipped`（有回执，不静默）。
   */
  if (!acquireCompactionLock(sessionId)) {
    return { removed: 0, kept: messages.length, skipped: "另一次压缩正在进行，请稍后再试" };
  }
  try {

  /**
   * ★ 第 228 波（用户要求，对标「最近 5–6 轮 100% 保留」）：
   * 保留集要**同时**满足两个条件 —— 条数上限 20，以及**最近 3 轮绝不切断**。
   *
   * 原实现只有「最近 20 条」这一个条件：一条大文件读取 / 一段大粘贴就能让最近几轮
   * **装不满 20 条**，于是手动压缩会切进最近几轮（用户那边的形态：压完连"刚才在干什么"
   * 都答不上来）。轮次保底的实现是**共享的**（`compactionMinKeep`，自动压缩走同一条规则）。
   */
  const keepCountPlanned = Math.min(
    messages.length,
    Math.max(
      Math.min(MANUAL_KEEP_MESSAGES, messages.length),
      /* ★ 第 228 波审计（第三轮）：保底要在**真实消息**上数 —— 压缩标记也是 role=user，
         把它算作一轮会让"最近 3 轮"少算一整轮真实对话（自动路径已同样处理） */
      compactionMinKeep(messages.filter((m) => !isCompactionMarker(m)), 4).minKeep,
    ),
  );
  /**
   * 折叠保留集里的旧摘要标记（见函数头第 3 点）：保留集要从"最后一个旧标记"之后开始，
   * 否则手动压缩会把上一次的摘要块永久留在上下文里。
   */
  const folded = foldStaleCompactionMarkers(messages, keepCountPlanned);
  let keepCount = folded.keepCount;
  let messagesToKeep = messages.slice(-keepCount);
  let messagesToRemove = messages.slice(0, messages.length - keepCount);

  /**
   * ★ 第 228 波审计修复：**"旧标记正好是最后一条"**那种形态下，旧标记会被下限钉在保留集里，
   * 而它的正文已经作为 `folded.existingSummary` 级联进新摘要 ⇒ 不额外删掉的话，同一份摘要
   * 会在上下文里出现两遍（新标记内含 + 旧标记原文）。这里按 id 并进待删集
   * （不能用 `slice(-0)` 表达，那会把整段历史都算进来 —— `foldStaleCompactionMarkers` 里的警告守的就是它）。
   */
  if (folded.staleMarkerIds.length > 0) {
    const staleSet = new Set(folded.staleMarkerIds);
    const extra = messagesToKeep.filter((m) => staleSet.has(m.id));
    if (extra.length > 0) {
      messagesToKeep = messagesToKeep.filter((m) => !staleSet.has(m.id));
      messagesToRemove = [...messagesToRemove, ...extra].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      keepCount = messagesToKeep.length;
    }
  }

  /**
   * ★ 第 228 波审计（第四轮·**高**）：手动路径同样必须**折叠后重夹轮次保底**。
   *
   * 被守的缺陷（自动路径 CA-9 守的是同一形态，手动路径漏了）：当**最后一条就是压缩标记**时
   * （`listMessagesMerged` 在镜像缺失/为空时返回**插入序**，而标记是追加写入的 ⇒ 它就在末尾），
   * `foldStaleCompactionMarkers` 会把 keep 钉成 1，再把那条标记记进 `staleMarkerIds`；
   * 上面那段合并把标记移进待删集并 `keepCount = messagesToKeep.length` ⇒ **keepCount 变成 0**
   * ⇒ `messagesToKeep` 空、`messagesToRemove` 是**全部 81 条**（含最近 3 轮）
   * ⇒ 一次手动压缩把整段可见历史软删（用户看到"压缩完成：移除 81 条"，而刚聊的东西没了）。
   * 这里按与自动路径**同一条规则**重夹：保底在真实消息（排除所有压缩标记）上算。
   */
  const realForFloor = messages.filter((m) => !isCompactionMarker(m));
  const floorAfterFold = compactionMinKeep(realForFloor, 4).minKeep;
  if (messagesToKeep.length < floorAfterFold) {
    const restored = realForFloor.slice(-floorAfterFold);
    const restoredIds = new Set(restored.map((m) => m.id));
    /* （全量审计）这里原来算了 keepIds，全程没人读 ⇒ 已删除 */
    /* 被重夹回来的那些要从待删集里摘掉；原本被挤出保留集的补进待删集（双向 filter = 严格划分） */
    const newlyRemoved = messagesToKeep.filter((m) => !restoredIds.has(m.id));
    messagesToKeep = restored;
    messagesToRemove = [...messagesToRemove.filter((m) => !restoredIds.has(m.id)), ...newlyRemoved].sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
    keepCount = messagesToKeep.length;
    console.log(
      `[manualCompact] 折叠后保留集少于轮次保底 ⇒ 重新夹回最近 ${keepCount} 条（真实消息，排除旧标记）`,
    );
  }
  /* 兜底：一条都保不住就**什么都不做**（`slice(-0)` 会取全部，绝不能让它走到删除那一步） */
  if (messagesToKeep.length === 0) {
    /*
     * ★ 第六批（审计·低-中）：**必须带 skipped 的真实原因**。
     * 该闸唯一可达态是"可见消息全是压缩标记"（realForFloor 为空 ⇒ floor=1 ⇒ slice(-1)=[]），
     * 而面板在没有 skipped 时会编造"可压缩的部分不足 / 保留最近 20 条"——
     * 真因是"没有真实历史可压"，两句话指的不是一回事。
     */
    console.warn("[manualCompact] 保留集为空 ⇒ 本次不压缩（否则会把整段可见历史删光）");
    return {
      removed: 0,
      kept: messages.length,
      skipped: "可见消息只剩压缩摘要标记，没有可压缩的真实历史",
    };
  }

  /*
   * ⚠️ 这一档**不加** skipped：既有判据 CB-5 明确要求这里说成
   * 「没有可移除的消息…保留最近 20 条…占用没降是因为系统提示与工具定义」——
   * 那几句对本形态（12 条 ≤ 保留 20 条）是**准确**的，比换一句新话更好。
   */
  if (messagesToRemove.length === 0) return { removed: 0, kept: messages.length };

  /**
   * ★ 第 228 波审计修复：手动压缩同样**不许让上下文变大** ——
   * 摘要的字符上限按"这次要移除多少字符"给（下界 800、上界沿用 8000）。
   * 原来的固定 8000 在"移除几百字符"的会话上会让上下文变大（用户看到"点了压缩，占用没降"）。
   */
  /**
   * ★ 第 228 波审计（第三轮·高）：**旧标记的字符不能算进"被压缩的内容"**。
   *
   * 被守的缺陷：`removedChars` 原来把待删集里那条旧标记的正文也算进去，而它的正文同时又要
   * 作为**级联摘要**原样保留（且它这一轮会被软删 ⇒ 那是唯一的副本）⇒ 预算被"自己"吃掉一次，
   * 待删集只剩一条旧标记时 `historyBudget` 恒为 0 ⇒ `summary.slice(0, 0)` 把级联整段删掉
   * ⇒ **累积摘要静默、不可恢复地消失**（而代码注释还承诺"旧摘要一律保留"）。
   * 现在：预算只由**真实内容**（非标记）决定，级联段永不参与裁剪。
   */
  const compressibleMessages = messagesToRemove.filter((m) => !isCompactionMarker(m));
  const messageChars = (m: (typeof messagesToRemove)[number]): number => {
    let chars = typeof m.content === "string" ? m.content.length : 0;
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        chars += typeof tc?.result === "string" ? tc.result.length : 0;
        if (tc?.args !== undefined) {
          try {
            chars += JSON.stringify(tc.args).length;
          } catch {
            /* 参数不可序列化时忽略（只影响预算，不影响正确性） */
          }
        }
      }
    }
    return chars;
  };
  const removedChars = compressibleMessages.reduce((sum, m) => sum + messageChars(m), 0);
  /**
   * ★ 第 228 波审计修复（中）：**旧标记不再被渲染第二遍**。
   *
   * 被守的缺陷：`messagesToRemove` 里可能含上一次的摘要标记（最常见形态就是"刚自动压缩完
   * 只剩标记 + 20 条"），而 `renderStructuredHistorySummary` 把它当普通 user 请求再渲染一遍
   * ⇒ 旧摘要同时以"原文"（`existingSummary`）和"本次新增历史"两种形态进了新标记
   * ⇒ 用户连按两次手动压缩，标记长度近似翻倍（**上下文变大**，与本节承诺相反）。
   * 标记的正文已经原样保留在下面那段"以下是之前的摘要"里，无需重复收录。
   */
  const historyForSummary = compressibleMessages;
  let summary = renderStructuredHistorySummary(historyForSummary, {
    userChars: 2000,
    assistantChars: 1500,
    toolChars: 400,
    totalChars: Math.max(800, Math.min(8000, removedChars)),
  });
  /**
   * ★ 第 228 波审计修复：**手动压缩同样不许让上下文变大** —— 整条标记的字符上限按
   * "这次移除的**真实内容**有多少字符"给（下界 800）。超限时只裁"本次新增历史"那段，
   * **级联的旧摘要一律保留**（它这一轮要被删掉，是唯一副本），并如实写出裁剪量。
   */
  const cascadePrefix = folded.existingSummary
    ? `以下是之前的摘要（继续保留）：\n${folded.existingSummary}\n\n本次新增历史：\n`
    : "";
  /**
   * ★ 第 228 波审计（第四轮·中）：预算要**含级联段**。
   * ⚠️ 第六批（审计员复算）：这条界**不保证"净增 ≤ 0"** —— 级联段是新标记必须整段保留的内容
   * （旧标记这一轮被删、它是唯一副本），所以净增**有界但恒为正**：
   * 裁剪生效时净增 ≈ 26 字符（级联标题 + "本次新增历史"这两个固定串），受 800 下界支配时最多 ≈ +120。
   * 被守的缺陷：级联的旧摘要（这一轮会被软删 ⇒ 是唯一副本）本来就整段保留，
   * 而 `fixedLen` 里又把它算掉了 ⇒ 旧摘要 > 733 字符时 `historyBudget` 恒为 0，
   * 「整条标记 ≤ max(800, removedChars)」这条不变量整段失效；removedChars < 106 时还**严格变大**。
   * 现在的界是：整条标记 ≤ max(800, removedChars + 级联段长度)，且裁剪注记也计入预算。
   */
  const markerBudget = Math.max(800, removedChars + cascadePrefix.length);
  const fixedLen = `[上下文已手动压缩]\n\n以下对话的摘要：\n${cascadePrefix}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条。请基于以上摘要和后续消息继续工作。`.length;
  const historyBudget = Math.max(0, markerBudget - fixedLen);
  if (summary.length > historyBudget) {
    const dropped = summary.length - historyBudget;
    const note = `\n（本次新增历史已按压缩预算裁剪 ${dropped} 字符）`;
    /**
     * ★ 第六批（审计·中）：注记本身也要放得进预算 —— 放不下就**不追加注记**。
     * 老写法在 `historyBudget < note.length` 时仍然整条追加 ⇒ 标记突破自己的预算（实测 +26 字符），
     * 而这条预算正是"压缩不许让上下文变大"的唯一依据。
     */
    if (historyBudget > note.length) {
      summary = `${summary.slice(0, historyBudget - note.length)}${note}`;
    } else {
      summary = summary.slice(0, historyBudget);
    }
  }
  summary = `${cascadePrefix}${summary}`;

  const removedIds = messagesToRemove.map(m => m.id);
  const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
  /**
   * 主键用共享生成器（自动路径同一套，理由见 `nextCompactionMarkerId`）：
   * `messages.id` 是全局主键，`compact-manual-${Date.now()}` 在同一毫秒内会与
   * 另一个会话的手动压缩撞车 —— 撞车时后写者按主键覆盖整行，前一个会话的摘要标记
   * 连同归属一起被抢走。
   */
  const markerId = nextCompactionMarkerId("manual");
  const markerContent = `[上下文已手动压缩]\n\n以下对话的摘要：\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条。请基于以上摘要和后续消息继续工作。`;
  const messagesBefore = messages.length;
  const messagesAfter = keepCount + 1;

  // 见函数头第 1 点：手动压缩也必须挂闸门（否则 UI 自动保存会把被软删的消息写回来）
  setCompactionInProgress(sessionId, true);
  try {
    /**
     * ★ 第 228 波审计修复（中/高）：**先写标记，再删旧消息**（原来反着写）。
     *
     * 两步都不会抛（日志追加是 best-effort、索引失败被吞成上报）⇒ 旧顺序下"旧消息已永久隐藏、
     * 摘要却没落盘"是可达的，而且没有补偿路径。反过来写，最坏只是"多一条摘要 + 旧消息还在"
     * （下次压缩会折叠掉）。
     */
    createMessage({
      id: markerId,
      role: "user",
      content: markerContent,
      timestamp: markerTs - 1,
      status: "done",
    }, sessionId);

    // Delete old messages —— 传 sessionId：镜像被逐出时也能判归属（否则墓碑不写、消息会复活）
    deleteMessagesByIds(removedIds, sessionId);

    // 见函数头第 2 点：事件日志里必须留下"这次压缩发生过"
    try {
      getEventLog().append(sessionId, "compaction", {
        removedMessageIds: removedIds,
        summary: markerContent,
        messagesBefore,
        messagesAfter,
        trigger: "manual",
      });
    } catch (eventErr) {
      // 与自动路径同一条约定：事件写失败不致命（消息侧已经落地），但必须留下痕迹
      console.warn("[ContextMonitor] 手动压缩的事件写入失败（非致命）:", eventErr);
    }
  } finally {
    setCompactionInProgress(sessionId, false);
  }

    /**
     * ★ 全量审计（中）：回执要用**真实删除结果**，不是计划值 ——
     * `deleteMessagesByIds` 恒返回「计划删多少」，而索引侧可能没回应（端口缺能力）或
     * 有若干 id 查不到归属（`unresolved`）⇒ 原来那句「移除 N 条」会高于真实值。
     */
    const report = getLastDeleteReport();
    const reallyUnresolved = report.unresolved > 0 || !report.softDeleteResponded;
    return {
      removed: messagesToRemove.length,
      kept: keepCount,
      receiptNote: !report.softDeleteResponded
        ? "（注意：索引侧这次没有回应，旧消息可能仍然留在索引里，重启后请确认）"
        : report.unresolved > 0
          ? `（其中 ${report.unresolved} 条查不到归属，实际没有隐藏）`
          : undefined,
      ...(reallyUnresolved ? { softDeleteIncomplete: true } : {}),
    };
  } finally {
    /* ★ 第 228 波审计修复：锁必须在所有出口释放（含中途抛错） */
    releaseCompactionLock(sessionId);
  }
}

export function ContextMonitor({ sessionId, visible }: ContextMonitorProps) {
  const [budget, setBudget] = useState<TokenBudget>(DEFAULT_BUDGET);
  /** ★ 全量审计：自动压缩阈值按**同一个窗口**算（默认 128k），显示用 */
  const [contextWindowTokens, setContextWindowTokens] = useState(DEFAULT_BUDGET.total);
  /*
   * ⚠️ 第 72 轮：这里原来还有一个 `pressure` state（由 `setPressure(...)` 写两次）。
   * 它和进度条用的 `budget` 是**两套口径**，于是真机上出现"21% 却显示临界"的自相矛盾。
   * 现在压力等级在渲染时由 `summarizeDisplayPressure(budget.used, budget.available)`
   * 现场导出 —— 与进度条同一对数字，state 也就没必要存在了。
   */
  const [todayCost, setTodayCost] = useState(0);
  const [messageCount, setMessageCount] = useState(0);
  const [balances, setBalances] = useState<ProviderBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  /**
   * ★ 第 185 波（复审 R1-6）：**上一次余额刷新失败了**（`null` = 没失败过）。
   * 旧数字会继续显示（不清空），但界面必须说明它不是刚拿到的。
   */
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  /**
   * P1-8：真正生效的重入守卫。
   *
   * 原来 `handleManualCompact` 里是同步执行 + `finally { setCompacting(false) }`：
   * `setCompacting(true)` 与随后的 `setCompacting(false)` 落在**同一批**里，React 渲染时
   * 状态已经是 false —— `compacting` 从来没有真正变成过 true，`disabled={compacting}`
   * 与函数入口的 `if (compacting) return` 都拦不住第二次点击。实测：连点两次
   * `deleteMessagesByIds` 被调用 **2 次**，第二次是在**已经被删掉一批**的列表上再删一批
   * （多删一批旧消息）。ref 是同步置位/复位的，用它做守卫才拦得住同一 tick 内的第二次点击。
   */
  const compactingRef = useRef(false);
  /** 压缩失败的可见提示（原来只 console.error，界面完全看不出失败）。 */
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<{
    removed: number;
    kept: number;
    skipped?: string;
    receiptNote?: string;
    softDeleteIncomplete?: boolean;
  } | null>(null);
  /**
   * ★ 第 227 波（用户实报）：
   *
   * > 弹出上下文窗口，我点了压缩上下文按钮，没出现进度也没出现压缩提示。
   * > 这样很容易让人误操作，以为没压缩重复点。
   *
   * 两个真正的缺陷：
   * ① **进度永远画不出来**：`manualCompact()` 是**同步**动作，而 `setCompacting(true/false)`
   *    会被 React 批到同一帧里 ⇒ 「⏳ 压缩中…」这一帧从来没有被 paint 过；
   * ② **回执 3 秒就消失**：`setTimeout(() => setCompactResult(null), 3000)` —— 用户在面板上
   *    找"压缩完了吗"的时候它已经没了，于是他会**再点一次**（而且真会再压一次）。
   *
   * 现在的口径：**回执留着**（会话变了 / 下一次压缩才换），**完成后进冷却期**（按钮禁用并写明
   * 刚刚压缩过），并且在真正动手之前**让出一帧**把"压缩中"画出来。
   */
  const [compactCooldown, setCompactCooldown] = useState(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 第 228 波审计：当前会话（供异步续体判断"用户是否已切走"） */
  const sessionIdRef = useRef<string>(sessionId);
  const [showConfig, setShowConfig] = useState(false);
  const [ctxConfig, setCtxConfig] = useState<CompactionConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState(false);

  // 更新 token 使用量和费用（每 3 秒）
  useEffect(() => {
    if (!visible) return;

    const update = () => {
      try {
        const costTracker = getCostTracker();
        setTodayCost(costTracker.getTodayCost());

        if (!sessionId) {
          setBudget(DEFAULT_BUDGET);
          setMessageCount(0);
          /* ★ 全量审计（低）：没有会话时窗口也要复位（否则显示的是上一个会话的窗口） */
          setContextWindowTokens(DEFAULT_BUDGET.total);
          return;
        }

        /**
         * ## 第 47 轮（功能上下文审计 P2-D12）：“消息数 / 占用”必须与送往模型的口径一致
         *
         * 改前：
         * ```ts
         * const messages = listMessages(sessionId);      // ← 含软删的压缩隐藏行 + 被裁历史
         * setMessageCount(messages.length);
         * const b = contextManager.calculateBudgetFromMessages(messages);   // ← 面板自己一套口径
         * ```
         * 模型侧的真实口径是三层（`agentic-loop.ts::buildMessages`）：
         * `listMessages` → `filter(!hidden)` → `pruneStaleToolResults` →
         * `selectMessagesByPriority(预算 = 真实窗口 × 0.9)`。
         * 于是面板的数字与"模型到底收到多少"是两回事（压缩过 200 条的会话会显示成
         * 200 条更多、占用率虚高），而这个面板存在的意义就是回答"上下文还剩多少"。
         *
         * 改后：
         * - **消息数** = `listVisibleMessages(sessionId).length`（与模型侧同一个入口，
         *   不含软删行；`listMessages` 只用于拿"库里总共多少行"的对照，不再当模型口径）；
         * - **占用** = 完全按模型侧那条链算：可见 → 裁剪陈旧大工具结果 → 按优先级选进
         *   "真实窗口 × 0.9"的预算（`summarizeModelContext`，与循环共用同一份选择算法）。
         *   于是"占用"= **模型这一次真的会收到的消息的估算 token**，
         *   而不是"库里所有行的估算 token"。
         */
        const visible = listVisibleMessages(sessionId);
        setMessageCount(visible.length);

        const contextWindow = getTokenTracker().getContextWindow() || DEFAULT_BUDGET.total;
        setContextWindowTokens(contextWindow);
        const { usedTokens, budgetTokens } = summarizeModelContext(
          pruneStaleToolResults(visible as any[]),
          contextWindow,
        );
        /**
         * `calculateBudgetFromMessages` 仍然用**同一份可见列表**计算（它读的是"消息集合"，
         * 不是"库里有多少行"）—— 只是它的 `used/available` 会被下面的模型侧口径覆盖。
         *
         * 第 72 轮：这里原来还有一次 `setPressure(getPressureLevelFromMessages(visible))`，
         * 它算的是**另一套**分子分母（不裁剪陈旧工具结果、不按优先级选择、分母也不一样），
         * 于是"进度条 21% + 压力等级 临界"同时出现在屏幕上。现在压力等级在渲染时由
         * `summarizeDisplayPressure(budget.used, budget.available)` 导出，这里不再需要它。
         */
        const contextManager = getContextManager();
        const b = contextManager.calculateBudgetFromMessages(visible as any[]);
        setBudget({
          ...b,
          used: usedTokens,
          available: budgetTokens,
          remaining: Math.max(0, budgetTokens - usedTokens),
        });
      } catch (e) {
        console.error("[ContextMonitor] update failed:", e);
      }
    };

    update();
    const interval = setInterval(update, 3000);
    return () => clearInterval(interval);
  }, [sessionId, visible]);

  /**
   * 第 227 波：换会话时把**压缩回执与冷却期**清掉。
   *
   * 为什么必须清：回执现在会一直留着（不再 3 秒消失）—— 留着的前提是它说的必须是**这个会话**的事。
   * 换了会话还挂着"移除 120 条"就是假信息（用户会以为新会话也被压过）。
   * 卸载时同时把冷却期的定时器收掉，避免对已卸载组件 setState。
   */
  useEffect(() => {
    /**
     * ★ 第 228 波审计：把"当前会话"记进 ref —— 手动压缩的续体在**让出一帧之后**
     * 必须能判断"用户是不是已经切走了"（否则会把旧会话的读数与冷却写到新会话上）。
     */
    sessionIdRef.current = sessionId;
    setCompactResult(null);
    setCompactError(null);
    setCompactCooldown(false);
    if (cooldownTimerRef.current !== null) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, [sessionId]);

  useEffect(
    () => () => {
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    },
    [],
  );

  // 查询余额（面板打开时和每 60 秒刷新一次）
  useEffect(() => {
    if (!visible) return;
    const fetchBalances = async () => {
      setBalanceLoading(true);
      /**
       * ★ 第 185 波（复审 R1-6）：**`balanceLoading` 必须在 `finally` 里复位**。
       *
       * 改前 `setBalanceLoading(false)` 在函数**最后一行**、且整段不在 try 里
       * （只有 deepseek 那一小支有自己的 try/catch）。任何**非** `fetchDeepSeekBalance`
       * 的抛错（`getConfiguredProviders()` 读设置、渲染订阅链、以后新增的 provider 分支）
       * 都会跳过它，而这个 promise 无人 await ⇒ 面板**永久显示 ⏳**（`:505` 的条件在
       * `balances.length > 0` 时照样渲染它）。
       *
       * 失败也要**如实**：旧数字继续显示，但必须说明"刚才这次没更新成功"，
       * 否则用户看着旧余额以为是最新的（"看起来在工作、实际是死数据"）。
       */
      let failure: string | null = null;
      try {
        const providers = getConfiguredProviders();
        const results: ProviderBalance[] = [];

        for (const p of providers) {
          const result: ProviderBalance = {
            provider: p.name || p.id,
            balance: null,
            currency: "CNY",
            loading: false,
            error: null,
          };

          if (p.id === "deepseek") {
            try {
              const { balance, currency } = await fetchDeepSeekBalance(p.apiKey, p.baseUrl);
              result.balance = balance;
              result.currency = currency;
            } catch (e: any) {
              result.error = e?.message || "查询失败";
            }
          } else {
            // 其他 provider 不支持余额查询
            result.error = "不支持";
          }

          results.push(result);
        }

        setBalances(results);
      } catch (e: any) {
        // 整段失败（不是单家 provider 的失败）：留痕 + 让界面说出来
        failure = e?.message || String(e ?? "查询失败");
        console.error("[ContextMonitor] balance fetch failed:", e);
      } finally {
        setBalanceError(failure);
        setBalanceLoading(false);
      }
    };

    fetchBalances();
    const interval = setInterval(fetchBalances, 60000);
    return () => clearInterval(interval);
  }, [visible]);

  // 加载上下文配置
  useEffect(() => {
    if (!visible) return;
    const cm = getContextManager();
    setCtxConfig(cm.getConfig());
  }, [visible]);

  if (!visible) return null;

  /*
   * ⚠️ 第 72 轮：**进度条与压力等级必须来自同一对分子/分母**。
   *
   * 改前：进度条用 `budget.used / budget.available`（模型侧口径：可见 → 裁剪陈旧工具结果 →
   * 按优先级选进"真实窗口 × 0.9"），而压力等级是另一个 `pressure` state，
   * 走 `getPressureLevelFromMessages(visible)`（另一套分母、且不裁剪不选择）。
   * 真机实测的后果：面板上同时写着 `23,678 / 115,200 tokens 21%` 与
   * 「压力等级：临界」+「🔴 上下文即将满」—— 用户看到的是自相矛盾的两个结论。
   * 现在两者都由 `summarizeDisplayPressure` 从**同一对数字**导出，
   * 这种矛盾在构造上不可能再出现（门禁 `context-monitor-pressure.test.ts`）。
   */
  const display = summarizeDisplayPressure(budget.used, budget.available);
  const usagePercent = display.percent;
  const pressure = display.level;
  const pressureColor = pressure === 0 ? "var(--success)"
    : pressure === 1 ? "var(--info)"
    : pressure === 2 ? "var(--warning)"
    : "var(--error)";

  const pressureLabel = pressure === 0 ? "正常"
    : pressure === 1 ? "中等"
    : pressure === 2 ? "较高"
    : "临界";

  // 有余额数据的 provider
  const balanceProviders = balances.filter((b) => b.balance !== null);
  const unsupportedProviders = balances.filter((b) => b.balance === null && b.error === "不支持");

  const handleManualCompact = async (): Promise<void> => {
    // P1-8：守卫必须"同步生效"——用 ref 而不是 state（state 在同一批里会被 finally 复位）
    if (!sessionId || compactingRef.current || compactCooldown) return;
    if (messageCount <= 2) {
      // 回执**不再 3 秒后自动消失**（第 227 波）：它是"这次点了有没有发生"的唯一证据
      setCompactError(null);
      setCompactResult({ removed: 0, kept: messageCount });
      return;
    }
    compactingRef.current = true;
    setCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      /*
       * 让出**一帧**（不是微任务，第 227 波）：`manualCompact()` 是同步动作，
       * React 会把 `setCompacting(true)` 与随后的 `false` 批进同一帧 ⇒
       * 「⏳ 压缩中…」这一帧**永远不会被画出来** —— 用户看到的就是"点了没反应"。
       * 16ms 足够浏览器画一帧；对几百条消息的结构化摘要来说这点开销可忽略。
       * （守卫 `compactingRef` 在这一帧里也是 held 的 ⇒ 同一 tick 的第二次点击照样被挡。）
       */
      await new Promise((resolve) => setTimeout(resolve, 16));
      /**
       * ★ 第 228 波审计修复（中）：这一帧里**用户可能已经切了会话**。
       *
       * 被守的缺陷：下面的续体用的是**捕获的** `sessionId`，而"切会话就清回执/清冷却"的
       * effect 是先跑的 ⇒ 续体把**旧会话**的读数与 8 秒冷却写到**新会话**的面板上
       * （用户看到的形态：刚切过去，按钮就处于"刚刚已压缩（移除 12 条）"的禁用态）。
       * 会话已经变了就什么都别写 —— 那次压缩的归属会话自己看得到结果。
       */
      if (sessionIdRef.current !== sessionId) return;
      const result = manualCompact(sessionId);
      setCompactResult(result);
      /*
       * 真的压缩过 ⇒ 进**冷却期**：按钮禁用并写明"刚刚已压缩（移除 N 条）"。
       * 这是"以为没压缩、重复点"的直接解药 —— 原来的守卫是同步的，压缩一结束就放开了，
       * 用户连点两下真的会压两次（第二次删的是刚保留下来的那批旧消息）。
       */
      if (result.removed > 0) {
        setCompactCooldown(true);
        if (cooldownTimerRef.current !== null) clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = setTimeout(() => {
          cooldownTimerRef.current = null;
          setCompactCooldown(false);
        }, COMPACT_COOLDOWN_MS);
      }
      // Trigger a refresh —— 与上面 update() 同一口径（可见消息 + 模型侧选择，P2-D12）
      const visible = listVisibleMessages(sessionId);
      setMessageCount(visible.length);
      const contextManager = getContextManager();
      const contextWindow = getTokenTracker().getContextWindow() || DEFAULT_BUDGET.total;
      const { usedTokens, budgetTokens } = summarizeModelContext(
        pruneStaleToolResults(visible as any[]),
        contextWindow,
      );
      const b = contextManager.calculateBudgetFromMessages(visible as any[]);
      setBudget({ ...b, used: usedTokens, available: budgetTokens, remaining: Math.max(0, budgetTokens - usedTokens) });
      // 第 72 轮：不再单独 setPressure —— 压力等级由渲染时的 summarizeDisplayPressure 导出
    } catch (e) {
      // 失败必须可见：既有上报通道（kind=action：这次压缩没生效）+ 组件内提示
      const detail = e instanceof Error ? e.message : String(e);
      reportActionFailure("contextMonitor.manualCompact", e, "手动压缩未生效（旧消息与摘要标记的写入没有全部完成）");
      try {
        reportPersistFailure("contextMonitor.manualCompact.write", e, `压缩写盘失败：${detail}`);
      } catch {
        // 二次上报失败不影响主流程
      }
      /**
       * ★ 第 228 波审计修复：文案必须与**新的写入顺序**一致。
       * 现在先写标记、再删旧消息 ⇒ 失败时真实状态是"摘要已写入（或未写入）、旧消息没被删"，
       * 而老文案说的是"旧消息未被完整删除"（在旧顺序下恰恰相反：旧消息已经删了、摘要没有）。
       */
      setCompactError(`压缩失败：${detail}（摘要标记已先写入，旧消息未被删除；可直接重试）`);
    } finally {
      // finally 里复位：无论成功失败，下一次仍然可以尝试
      compactingRef.current = false;
      setCompacting(false);
      /*
       * 第 227 波：这里原来还有一句 `setTimeout(() => setCompactResult(null), 3000)`。
       * 它正是用户"以为没压缩"的另一半原因 —— 回执只活 3 秒，而用户是**先看数字、再找提示**，
       * 找的时候它已经没了。现在回执**留着**：换会话、或者下一次压缩时才被替换。
       */
    }
  };

  return (
    <div className="context-monitor">
      <div className="context-monitor-header">
        <span className="context-monitor-icon">📊</span>
        <span>上下文状态{!sessionId && "（未选择会话）"}</span>
      </div>

      <div className="context-monitor-body">
        <div className="context-usage">
          <div className="context-usage-bar">
            <div
              className="context-usage-fill"
              style={{ width: `${Math.min(usagePercent, 100)}%`, background: pressureColor }}
            />
          </div>
          <div className="context-usage-info">
            <span>{budget.used.toLocaleString()} / {budget.available.toLocaleString()} tokens</span>
            <span style={{ color: pressureColor }}>{usagePercent}%</span>
          </div>
        </div>

        <div className="context-stats">
          <div className="context-stat">
            <span className="context-stat-label">压力等级</span>
            <span className="context-stat-value" style={{ color: pressureColor }}>
              {pressureLabel}
            </span>
          </div>
          <div className="context-stat">
            <span className="context-stat-label" title="窗口 × 0.9 的安全预算（进度条分母）">
              剩余
            </span>
            <span className="context-stat-value">{budget.remaining.toLocaleString()} tokens</span>
          </div>
          {/* ★ 全量审计（中）：把自动压缩的**触发阈值**也显示出来 ——
              它与上面那条进度条的分母不是一对数字（阈值按窗口 80%、含系统提示与工具定义），
              不写出来用户会看到「占用不高却已经压缩了/一直不压缩」。 */}
          <div className="context-stat">
            <span
              className="context-stat-label"
              title="模型侧压力（含系统提示与工具定义）超过它就会自动压缩，与上面的安全预算不是一对数字"
            >
              自动压缩阈值
            </span>
            <span className="context-stat-value">
              {Math.round(contextWindowTokens * (ctxConfig?.compactionThreshold ?? 0.8)).toLocaleString()} tokens
              {`（窗口 ${Math.round((ctxConfig?.compactionThreshold ?? 0.8) * 100)}%）`}
            </span>
          </div>
          <div className="context-stat">
            <span className="context-stat-label" title="与模型侧同一口径：listVisibleMessages（不含压缩隐藏的历史）">消息数</span>
            <span className="context-stat-value" title="送往模型的消息条数（与模型的可见集合一致）">{messageCount}</span>
          </div>
          <div className="context-stat">
            <span className="context-stat-label">今日费用</span>
            <span className="context-stat-value">${todayCost.toFixed(4)}</span>
          </div>
        </div>

        {/* 手动压缩按钮 */}
        {sessionId && messageCount > 2 && (
          <div className="context-compact-section">
            <button
              className="context-compact-btn"
              onClick={handleManualCompact}
              disabled={compacting || compactCooldown}
              title={
                compactCooldown
                  ? `刚刚压缩过（${Math.round(COMPACT_COOLDOWN_MS / 1000)} 秒冷却，避免重复点击 —— 压缩很快，连点两下真的会压两次）`
                  : "压缩上下文：移除旧消息并生成摘要"
              }
            >
              {compacting
                ? "⏳ 压缩中..."
                : compactCooldown && compactResult && compactResult.removed > 0
                  ? `✅ 已压缩（移除 ${compactResult.removed} 条）`
                  : "▼ 压缩上下文"}
            </button>
            {/*
              第 227 波（用户实报「点了压缩但没出现任何提示」）：
              回执从"3 秒就消失的一行小字"改成**常驻的状态条**，并且把"发生了什么"写清楚 ——
              成功要说清移除了多少、保留了多少、对话里多了什么；没得压也要说清**为什么**
              （否则用户看到数字没变，只会以为按钮坏了）。
            */}
            {compactResult && (
              <StatusBanner
                tone={compactResult.removed > 0 ? "success" : "info"}
                data-testid="compact-result"
              >
                {compactResult.skipped
                  ? `没有压缩：${compactResult.skipped}`
                  : compactResult.removed > 0
                  ? `压缩完成：移除 ${compactResult.removed} 条旧消息，保留最近 ${compactResult.kept} 条；` +
                    `本对话里已插入一条「[上下文已手动压缩]」摘要（老对话细节变成摘要，仍在本对话继续）。` +
                    /* ★ 全量审计（中）：真实删除结果的补充说明（索引没回应 / 有条目查不到归属） */
                    (compactResult.receiptNote ?? "")
                  : `本次没有可移除的消息：当前可见消息只有 ${compactResult.kept} 条（保留最近 ${MANUAL_KEEP_MESSAGES} 条，` +
                    `并且最近 ${COMPACTION_MIN_KEEP_TURNS} 轮绝不切断 ⇒ 可压缩的部分不足）。` +
                    `上下文占用主要来自系统提示与工具定义，压缩对话不会让它降下来。`}
              </StatusBanner>
            )}
            {compactError && (
              <StatusBanner tone="error" data-testid="compact-error">
                {compactError}
              </StatusBanner>
            )}
          </div>
        )}

        {/* 压力等级提示 */}
        {pressure >= 2 && sessionId && (
          <div className="context-pressure-warning">
            {pressure === 2
              ? "⚠️ 上下文压力较高，建议压缩或开启新对话"
              : "🔴 上下文即将满！请立即压缩或开启新对话"}
          </div>
        )}

        {/* 账户余额 */}
        {/*
          ★ 第 185 波（复审 R1-6）：`balanceError` 也要能撑开这一段 ——
          首次刷新就整体失败时（连 `balances` 都没有），否则用户什么提示都看不到。
        */}
        {(balanceProviders.length > 0 || (balances.length > 0 && balanceLoading) || !!balanceError) && (
          <div className="context-balance-section">
            <div className="context-balance-title">
              💰 账户余额
              {balanceLoading && <span className="context-balance-loading">⏳</span>}
            </div>
            {balanceProviders.map((b, i) => (
              <div key={i} className="context-balance-item">
                <span className="context-balance-provider">{b.provider}</span>
                <span className="context-balance-amount">
                  ¥{parseFloat(b.balance!).toFixed(2)}
                </span>
              </div>
            ))}
            {/*
              ★ 第 185 波（复审 R1-6）：刷新失败要**如实说**。
              下面这些数字是**上一次成功拿到的**（旧值继续显示，不清空）——
              不说清楚，用户会把它当成"刚刚的余额"。
            */}
            {balanceError && (
              <div
                data-testid="context-balance-stale"
                style={{ fontSize: 'var(--fs-xs)', color: "var(--warning, var(--text-secondary))", marginTop: 4 }}
              >
                ⚠️ 刚才更新余额失败：{balanceError}（上面显示的是上次成功获取的数字）
              </div>
            )}
          </div>
        )}

        {/* 不支持余额查询的 provider */}
        {unsupportedProviders.length > 0 && (
          <div className="context-balance-unsupported">
            <span>余额查询不支持: {unsupportedProviders.map((b) => b.provider).join("、")}</span>
          </div>
        )}

        {/* 压缩参数配置 */}
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setShowConfig(!showConfig)}
            style={{
              background: "none", border: "1px solid var(--border-primary)", color: "var(--text-secondary)",
              fontSize: 'var(--fs-sm)', padding: "4px 10px", borderRadius: "var(--radius-xs)", cursor: "pointer", width: "100%",
              textAlign: "left",
            }}
          >
            {showConfig ? "▼" : "▶"} 压缩参数配置
          </button>
          {showConfig && ctxConfig && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, padding: 8, borderRadius: "var(--radius-sm)", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
              {/* 上下文窗口大小 */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>上下文窗口 (tokens)</span>
                <input type="number" min="8000" step="1000" value={ctxConfig.maxContextWindow}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, maxContextWindow: parseInt(e.target.value) || 128000 })}
                  style={{ padding: "4px 8px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)" }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>模型的最大上下文长度，如 128000</span>
              </label>

              {/* 压缩阈值 */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>压缩阈值: {Math.round(ctxConfig.compactionThreshold * 100)}%</span>
                <input type="range" min="0.5" max="0.95" step="0.05" value={ctxConfig.compactionThreshold}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, compactionThreshold: parseFloat(e.target.value) })}
                  style={{ width: "100%" }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>达到此比例时自动触发压缩，默认 80%</span>
              </label>

              {/* 压缩后保留消息数 */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>压缩后保留消息数</span>
                <input type="number" min="5" max="100" value={ctxConfig.maxMessagesAfterCompaction}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, maxMessagesAfterCompaction: parseInt(e.target.value) || 20 })}
                  style={{ padding: "4px 8px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)" }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>压缩后保留最近多少条消息，默认 20</span>
              </label>

              {/* 输出预留 */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>输出预留 (tokens)</span>
                <input type="number" min="1024" step="512" value={ctxConfig.outputReserve}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, outputReserve: parseInt(e.target.value) || 4096 })}
                  style={{ padding: "4px 8px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)" }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>为模型输出预留的 token 数，默认 4096</span>
              </label>

              {/* 系统提示词预留 */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>系统提示词预留 (tokens)</span>
                <input type="number" min="500" step="500" value={ctxConfig.systemPromptTokens}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, systemPromptTokens: parseInt(e.target.value) || 2000 })}
                  style={{ padding: "4px 8px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)" }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>系统提示词的预估 token 数，默认 2000</span>
              </label>

              {/* 保留近期工具输出 */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={ctxConfig.preserveRecentToolOutputs}
                  onChange={(e) => setCtxConfig({ ...ctxConfig, preserveRecentToolOutputs: e.target.checked })}
                  style={{ cursor: "pointer" }} />
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)" }}>压缩时保留近期工具输出</span>
              </label>

              {/* 保存按钮 */}
              <button
                onClick={() => {
                  const cm = getContextManager();
                  cm.updateConfig(ctxConfig);
                  setSavedConfig(true);
                  setTimeout(() => setSavedConfig(false), 2000);
                }}
                style={{
                  padding: "6px 14px", borderRadius: "var(--radius-xs)", fontSize: 'var(--fs-sm)', fontWeight: 500,
                  border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--text-on-accent)",
                  cursor: "pointer", alignSelf: "flex-start",
                }}
              >
                {savedConfig ? "✅ 已保存" : "保存配置"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
