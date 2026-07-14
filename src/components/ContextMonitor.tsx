import { useState, useEffect } from "react";
import { getContextManager, type TokenBudget } from "../core/context/context";
import { getCostTracker } from "../core/llm/cost-tracker";
import { listMessages, deleteMessagesByIds, createMessage } from "../core/storage/message";
import { getSettingJSON } from "../core/storage/settings";

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
  const messages = listMessages(sessionId);
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
  const [compactResult, setCompactResult] = useState<{ removed: number; kept: number } | null>(null);

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

  const handleManualCompact = () => {
    if (!sessionId || compacting) return;
    if (messageCount <= 2) {
      setCompactResult({ removed: 0, kept: messageCount });
      setTimeout(() => setCompactResult(null), 3000);
      return;
    }
    setCompacting(true);
    try {
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
      console.error("[ContextMonitor] manual compact failed:", e);
    } finally {
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
              title="压缩上下文：移除旧消息并生成摘要，类似 Codex 的 /compact 命令"
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
      </div>
    </div>
  );
}
