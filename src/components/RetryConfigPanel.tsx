import { useState, useEffect } from "react";
import {
  getRetryExecutor,
  classifyError,
  type RetryConfig,
  type RetryableErrorType,
} from "../core/retry/retry";
import { useLang } from "../core/i18n/lang";

const ERROR_TYPE_LABELS_ZH: Record<RetryableErrorType, string> = {
  rate_limit: "限流 (429)",
  server_error: "服务器错误 (5xx)",
  timeout: "请求超时",
  network: "网络错误",
  capacity: "过载 (529)",
  sse_timeout: "SSE 超时",
};

const ERROR_TYPE_LABELS_EN: Record<RetryableErrorType, string> = {
  rate_limit: "Rate Limit (429)",
  server_error: "Server Error (5xx)",
  timeout: "Timeout",
  network: "Network Error",
  capacity: "Overloaded (529)",
  sse_timeout: "SSE Timeout",
};

export function RetryConfigPanel() {
  const lang = useLang();
  const zh = lang === "zh";
  const [config, setConfig] = useState<RetryConfig>(() => getRetryExecutor().getConfig());
  const [state, setState] = useState(() => getRetryExecutor().getState());
  const [saved, setSaved] = useState(false);
  const [testError, setTestError] = useState("");
  const [testResult, setTestResult] = useState<{ type: RetryableErrorType | null; isRetryable: boolean; retryAfter?: number } | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setState(getRetryExecutor().getState());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSave = () => {
    getRetryExecutor().setConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    getRetryExecutor().reset();
    setState(getRetryExecutor().getState());
  };

  const handleTestClassify = () => {
    try {
      // Parse test error as JSON or use as message
      let error: unknown;
      try {
        error = JSON.parse(testError);
      } catch {
        error = { message: testError, status: undefined };
      }
      const result = classifyError(error);
      setTestResult(result);
    } catch (e) {
      setTestResult({ type: null, isRetryable: false });
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 3, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 12, width: "100%",
    outline: "none",
  };

  // Calculate preview delay for attempt 1
  const previewDelay = getRetryExecutor().getDelay(0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
          🔄 {zh ? "重试执行器" : "Retry Executor"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
          {zh ? "配置 API 请求失败时的自动重试策略（指数退避）。" : "Configure automatic retry strategy for failed API requests (exponential backoff)."}
        </div>
      </div>

      {/* Current state */}
      <div style={{
        padding: 10, borderRadius: 6, border: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)", display: "flex", gap: 16, fontSize: 11,
      }}>
        <div>
          <span style={{ color: "var(--text-muted)" }}>{zh ? "当前尝试" : "Current attempt"}: </span>
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{state.attempt} / {state.totalAttempts}</span>
        </div>
        <div>
          <span style={{ color: "var(--text-muted)" }}>{zh ? "累计等待" : "Total wait"}: </span>
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{(state.totalWaitTime / 1000).toFixed(1)}s</span>
        </div>
        <div>
          <span style={{ color: "var(--text-muted)" }}>{zh ? "最后重试" : "Last retry"}: </span>
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
            {state.lastRetryTime > 0 ? new Date(state.lastRetryTime).toLocaleTimeString() : "-"}
          </span>
        </div>
        {state.lastError != null && (
          <div>
            <span style={{ color: "var(--text-muted)" }}>{zh ? "最后错误" : "Last error"}: </span>
            <span style={{ fontWeight: 600, color: "var(--error)" }}>
              {state.lastError instanceof Error ? state.lastError.message : String(state.lastError ?? "")}
            </span>
          </div>
        )}
      </div>

      {/* Config form */}
      <div style={{
        padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "最大重试次数" : "Max Attempts"}</label>
            <input type="number" min={1} max={50} style={inputStyle} value={config.maxAttempts}
              onChange={e => setConfig({ ...config, maxAttempts: parseInt(e.target.value) || 10 })} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "基础延迟 (毫秒)" : "Base Delay (ms)"}</label>
            <input type="number" min={100} step={100} style={inputStyle} value={config.baseDelay}
              onChange={e => setConfig({ ...config, baseDelay: parseInt(e.target.value) || 500 })} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "退避倍数" : "Backoff Multiplier"}</label>
            <input type="number" min={1} max={5} step={0.5} style={inputStyle} value={config.backoffMultiplier}
              onChange={e => setConfig({ ...config, backoffMultiplier: parseFloat(e.target.value) || 2 })} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "最大延迟 (毫秒)" : "Max Delay (ms)"}</label>
            <input type="number" min={1000} step={1000} style={inputStyle} value={config.maxDelay}
              onChange={e => setConfig({ ...config, maxDelay: parseInt(e.target.value) || 300000 })} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "总超时 (毫秒)" : "Total Timeout (ms)"}</label>
            <input type="number" min={10000} step={10000} style={inputStyle} value={config.totalTimeout}
              onChange={e => setConfig({ ...config, totalTimeout: parseInt(e.target.value) || 1800000 })} />
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={config.respectRetryAfter}
            onChange={e => setConfig({ ...config, respectRetryAfter: e.target.checked })} />
          {zh ? "遵守 Retry-After 响应头" : "Respect Retry-After header"}
        </label>

        {/* Delay preview */}
        <div style={{
          padding: "6px 10px", borderRadius: 4, background: "var(--bg-tertiary)",
          fontSize: 11, color: "var(--text-secondary)", marginBottom: 8,
        }}>
          {zh ? "预览：第1次重试延迟" : "Preview: 1st retry delay"} = <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{(previewDelay / 1000).toFixed(2)}s</span>
          {config.backoffMultiplier > 1 && (
            <span> → {zh ? "第2次" : "2nd"}: {((config.baseDelay * Math.pow(config.backoffMultiplier, 1)) / 1000).toFixed(2)}s → {zh ? "第3次" : "3rd"}: {((config.baseDelay * Math.pow(config.backoffMultiplier, 2)) / 1000).toFixed(2)}s</span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSave} style={{
            padding: "6px 16px", borderRadius: 4, fontSize: 12,
            border: "1px solid var(--accent)", background: "var(--accent)",
            color: "#fff", cursor: "pointer",
          }}>
            {saved ? "✅ " + (zh ? "已保存" : "Saved") : (zh ? "保存配置" : "Save Config")}
          </button>
          <button onClick={handleReset} style={{
            padding: "6px 16px", borderRadius: 4, fontSize: 12,
            border: "1px solid var(--border-primary)", background: "none",
            color: "var(--text-primary)", cursor: "pointer",
          }}>
            {zh ? "重置状态" : "Reset State"}
          </button>
        </div>
      </div>

      {/* Error classification tester */}
      <div style={{
        padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
          🔍 {zh ? "错误分类测试器" : "Error Classification Tester"}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6 }}>
          {zh ? "输入错误信息（JSON 或文本），测试是否可重试。" : "Enter error info (JSON or text) to test if it's retryable."}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input style={inputStyle} value={testError} onChange={e => setTestError(e.target.value)}
            placeholder='{"status": 429, "headers": {"retry-after": "60"}}' />
          <button onClick={handleTestClassify} disabled={!testError.trim()} style={{
            padding: "5px 12px", borderRadius: 4, fontSize: 12,
            border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
            color: "var(--text-primary)", cursor: "pointer", whiteSpace: "nowrap",
            opacity: testError.trim() ? 1 : 0.5,
          }}>
            {zh ? "测试" : "Test"}
          </button>
        </div>
        {testResult && (
          <div style={{
            marginTop: 8, padding: "6px 10px", borderRadius: 4,
            background: "var(--bg-tertiary)", fontSize: 11,
          }}>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{zh ? "类型" : "Type"}: </span>
              <span style={{ fontWeight: 600, color: testResult.type ? "var(--text-primary)" : "var(--text-muted)" }}>
                {testResult.type ? (zh ? ERROR_TYPE_LABELS_ZH[testResult.type] : ERROR_TYPE_LABELS_EN[testResult.type]) : (zh ? "不可重试" : "Not retryable")}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{zh ? "可重试" : "Retryable"}: </span>
              <span style={{ fontWeight: 600, color: testResult.isRetryable ? "var(--success)" : "var(--error)" }}>
                {testResult.isRetryable ? "✅ " + (zh ? "是" : "Yes") : "❌ " + (zh ? "否" : "No")}
              </span>
            </div>
            {testResult.retryAfter && (
              <div>
                <span style={{ color: "var(--text-muted)" }}>Retry-After: </span>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{(testResult.retryAfter / 1000).toFixed(0)}s</span>
              </div>
            )}
          </div>
        )}

        {/* Retryable error types reference */}
        <div style={{ marginTop: 10, fontSize: 10, color: "var(--text-muted)" }}>
          {zh ? "可重试错误类型：" : "Retryable error types:"}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {Object.entries(zh ? ERROR_TYPE_LABELS_ZH : ERROR_TYPE_LABELS_EN).map(([type, label]) => (
              <span key={type} style={{
                padding: "2px 6px", borderRadius: 3, background: "var(--bg-tertiary)",
                border: "1px solid var(--border-primary)", fontSize: 10,
              }}>{label}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
