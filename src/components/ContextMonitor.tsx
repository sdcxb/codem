import { useState, useEffect, useRef } from "react";
import { getContextManager, type TokenBudget, type CompactionConfig } from "../core/context/context";
import { getCostTracker } from "../core/llm/cost-tracker";
import { listVisibleMessages, deleteMessagesByIds, createMessage } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { setCompactionInProgress } from "../core/storage/compaction-state";
import {
  foldStaleCompactionMarkers,
  nextCompactionMarkerId,
  renderStructuredHistorySummary,
  summarizeModelContext,
} from "../core/llm/compaction-budget";
import { getTokenTracker } from "../core/llm/token-tracker";
import { pruneStaleToolResults } from "../core/llm/context-fold";
import { getSettingJSON } from "../core/storage/settings";
import { reportActionFailure, reportPersistFailure } from "../core/storage/persist-failure";

interface ContextMonitorProps {
  sessionId: string;
  visible: boolean;
}

// 默认 budget，让面板在无会话时也能显示
const DEFAULT_BUDGET: TokenBudget = {
  total: 128000,
  systemPrompt: 2000,
  outputReserve: 4096,
  available: 121904,
  used: 0,
  remaining: 121904,
};

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
export function manualCompact(sessionId: string): { removed: number; kept: number } {
  /**
   * P2-D12：可见消息的**唯一读法**是 `listVisibleMessages` ——
   * `listMessages` 会把软删（压缩隐藏）的历史也带回来，用它算"要压缩多少条／
   * 压缩后剩多少条"口径就与模型看到的集合不一致（模型侧读的是 `listMessages` 后
   * `filter(!hidden)`，见 `agentic-loop.ts::buildMessages`）。
   */
  const messages = listVisibleMessages(sessionId);
  if (messages.length <= 2) return { removed: 0, kept: messages.length };

  const keepCountPlanned = Math.min(20, messages.length);
  /**
   * 折叠保留集里的旧摘要标记（见函数头第 3 点）：保留集要从"最后一个旧标记"之后开始，
   * 否则手动压缩会把上一次的摘要块永久留在上下文里。
   */
  const folded = foldStaleCompactionMarkers(messages, keepCountPlanned);
  const keepCount = folded.keepCount;
  const messagesToKeep = messages.slice(-keepCount);
  const messagesToRemove = messages.slice(0, messages.length - keepCount);

  if (messagesToRemove.length === 0) return { removed: 0, kept: messages.length };

  // Build summary —— 见函数头第 47 轮说明：共享的结构化渲染器（不再 100 字符截断拼接）
  let summary = renderStructuredHistorySummary(messagesToRemove);
  /**
   * 上一次压缩的摘要必须**原样带进新摘要**（级联），否则手动压缩第二次开始就把
   * 前一次的结论丢掉。折叠逻辑已经把它取出来了（`folded.existingSummary`）。
   */
  if (folded.existingSummary) {
    summary = `以下是之前的摘要（继续保留）：\n${folded.existingSummary}\n\n本次新增历史：\n${summary}`;
  }

  const removedIds = messagesToRemove.map(m => m.id);
  const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
  /**
   * 主键用共享生成器（自动路径同一套，理由见 `nextCompactionMarkerId`）：
   * `messages.id` 是全局主键，`compact-manual-${Date.now()}` 在同一毫秒内会与
   * 另一个会话的手动压缩撞车 —— 撞车时后写者按主键覆盖整行，前一个会话的摘要标记
   * 连同归属一起被抢走。
   */
  const markerId = nextCompactionMarkerId("manual");
  const markerContent = `[上下文已手动压缩]\n\n以下是之前对话的摘要：\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条。请基于以上摘要和后续消息继续工作。`;
  const messagesBefore = messages.length;
  const messagesAfter = keepCount + 1;

  // 见函数头第 1 点：手动压缩也必须挂闸门（否则 UI 自动保存会把被软删的消息写回来）
  setCompactionInProgress(true);
  try {
    // Delete old messages
    deleteMessagesByIds(removedIds);

    // Insert compaction marker
    createMessage({
      id: markerId,
      role: "user",
      content: markerContent,
      timestamp: markerTs - 1,
      status: "done",
    }, sessionId);

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
    setCompactionInProgress(false);
  }

  return { removed: messagesToRemove.length, kept: keepCount };
}

export function ContextMonitor({ sessionId, visible }: ContextMonitorProps) {
  const [budget, setBudget] = useState<TokenBudget>(DEFAULT_BUDGET);
  const [pressure, setPressure] = useState(0);
  const [todayCost, setTodayCost] = useState(0);
  const [messageCount, setMessageCount] = useState(0);
  const [balances, setBalances] = useState<ProviderBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
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
  const [compactResult, setCompactResult] = useState<{ removed: number; kept: number } | null>(null);
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
          setPressure(0);
          setMessageCount(0);
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
        const { usedTokens, budgetTokens } = summarizeModelContext(
          pruneStaleToolResults(visible as any[]),
          contextWindow,
        );
        /**
         * `calculateBudgetFromMessages` / `getPressureLevelFromMessages` 仍然用**同一份可见列表**
         * 计算（它们读的是"消息集合"，不是"库里有多少行"）—— 口径与上面一致。
         */
        const contextManager = getContextManager();
        const b = contextManager.calculateBudgetFromMessages(visible as any[]);
        setBudget({
          ...b,
          used: usedTokens,
          available: budgetTokens,
          remaining: Math.max(0, budgetTokens - usedTokens),
        });
        setPressure(contextManager.getPressureLevelFromMessages(visible as any[]));
      } catch (e) {
        console.error("[ContextMonitor] update failed:", e);
      }
    };

    update();
    const interval = setInterval(update, 3000);
    return () => clearInterval(interval);
  }, [sessionId, visible]);

  // 查询余额（面板打开时和每 60 秒刷新一次）
  useEffect(() => {
    if (!visible) return;

    const fetchBalances = async () => {
      setBalanceLoading(true);
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
      setBalanceLoading(false);
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

  const usagePercent = budget.available > 0 ? Math.round((budget.used / budget.available) * 100) : 0;
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
    if (!sessionId || compactingRef.current) return;
    if (messageCount <= 2) {
      setCompactResult({ removed: 0, kept: messageCount });
      setTimeout(() => setCompactResult(null), 3000);
      return;
    }
    compactingRef.current = true;
    setCompacting(true);
    setCompactError(null);
    try {
      // 让出一次微任务：守卫在整个动作期间是真的"held"（否则同步动作一返回守卫就放开了，
      // 同一 tick 内到达的第二次点击照样能进来）
      await Promise.resolve();
      const result = manualCompact(sessionId);
      setCompactResult(result);
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
      setPressure(contextManager.getPressureLevelFromMessages(visible as any[]));
    } catch (e) {
      // 失败必须可见：既有上报通道（kind=action：这次压缩没生效）+ 组件内提示
      const detail = e instanceof Error ? e.message : String(e);
      reportActionFailure("contextMonitor.manualCompact", e, "手动压缩未生效（旧消息与摘要标记的写入没有全部完成）");
      try {
        reportPersistFailure("contextMonitor.manualCompact.write", e, `压缩写盘失败：${detail}`);
      } catch {
        // 二次上报失败不影响主流程
      }
      setCompactError(`压缩失败：${detail}（旧消息未被完整删除，请重试）`);
    } finally {
      // finally 里复位：无论成功失败，下一次仍然可以尝试
      compactingRef.current = false;
      setCompacting(false);
      setTimeout(() => setCompactResult(null), 3000);
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
            <span className="context-stat-label">剩余</span>
            <span className="context-stat-value">{budget.remaining.toLocaleString()} tokens</span>
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
              disabled={compacting}
              title="压缩上下文：移除旧消息并生成摘要"
            >
              {compacting ? "⏳ 压缩中..." : "▼ 压缩上下文"}
            </button>
            {compactResult && (
              <span className={`context-compact-result ${compactResult.removed > 0 ? "success" : "info"}`}>
                {compactResult.removed > 0
                  ? `✅ 移除 ${compactResult.removed} 条，保留 ${compactResult.kept} 条`
                  : "消息太少，无需压缩"}
              </span>
            )}
            {compactError && (
              <span className="context-compact-result error" role="alert" data-testid="compact-error">
                ⚠️ {compactError}
              </span>
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
        {(balanceProviders.length > 0 || (balances.length > 0 && balanceLoading)) && (
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
