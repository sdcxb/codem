import { useState, useEffect, useRef } from "react";
import { getContextManager, type TokenBudget, type CompactionConfig } from "../core/context/context";
import { getCostTracker } from "../core/llm/cost-tracker";
import { listMessages, deleteMessagesByIds, createMessage } from "../core/storage/message";
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

/** 手动压缩上下文：删除旧消息并插入摘要标记 */
function manualCompact(sessionId: string): { removed: number; kept: number } {
  const allMessages = listMessages(sessionId);
  // Only consider visible messages for compaction
  const messages = allMessages.filter((m: any) => !(m as any).hidden);
  if (messages.length <= 2) return { removed: 0, kept: messages.length };

  const keepCount = Math.min(20, messages.length);
  const messagesToKeep = messages.slice(-keepCount);
  const messagesToRemove = messages.slice(0, messages.length - keepCount);

  if (messagesToRemove.length === 0) return { removed: 0, kept: messages.length };

  // Build summary
  let summaryParts: string[] = [];
  for (const msg of messagesToRemove) {
    if (msg.role === "user") {
      const snippet = (msg.content || "").substring(0, 100);
      if (snippet.trim()) summaryParts.push(`- 用户请求: ${snippet}`);
    } else if (msg.role === "assistant") {
      const snippet = (msg.content || "").substring(0, 100);
      if (snippet.trim()) summaryParts.push(`- AI回复: ${snippet}`);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          summaryParts.push(`- 工具调用: ${tc.tool}`);
        }
      }
    }
  }
  let summary = summaryParts.join("\n");
  if (summary.length > 1000) {
    summary = summary.substring(0, 1000) + "\n...(更多历史已省略)";
  }

  // Delete old messages
  const removedIds = messagesToRemove.map(m => m.id);
  deleteMessagesByIds(removedIds);

  // Insert compaction marker
  const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
  createMessage({
    id: `compact-manual-${Date.now()}`,
    role: "user",
    content: `[上下文已手动压缩]\n\n以下是之前对话的摘要：\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条。请基于以上摘要和后续消息继续工作。`,
    timestamp: markerTs - 1,
    status: "done",
  }, sessionId);

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

        const messages = listMessages(sessionId);
        setMessageCount(messages.length);

        const contextManager = getContextManager();
        const b = contextManager.calculateBudgetFromMessages(messages);
        setBudget(b);
        setPressure(contextManager.getPressureLevelFromMessages(messages));
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
      // Trigger a refresh
      const messages = listMessages(sessionId);
      setMessageCount(messages.length);
      const contextManager = getContextManager();
      const b = contextManager.calculateBudgetFromMessages(messages);
      setBudget(b);
      setPressure(contextManager.getPressureLevelFromMessages(messages));
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
            <span className="context-stat-label">消息数</span>
            <span className="context-stat-value">{messageCount}</span>
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
