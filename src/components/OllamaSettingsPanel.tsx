/**
 * P3-31: Ollama Settings Panel
 *
 * 配置 Ollama 本地 LLM 连接：
 * - 服务地址 (Base URL)
 * - 连接状态检测
 * - 自动检测模型
 * - 模型列表展示
 */

import { useState, useEffect, useCallback } from "react";
import {
  Server, RefreshCw, CheckCircle, XCircle, Download,
  Cpu, Settings as SettingsIcon, Wifi, WifiOff,
} from "lucide-react";
import { useLang, S } from "../core/i18n/lang";
import { getOllamaProvider, OllamaConnectionStatus } from "../core/llm/ollama-provider";
import { getSetting, setSetting } from "../core/storage/settings";
import type { ModelConfig } from "../core/llm/types";

export function OllamaSettingsPanel() {
  const lang = useLang();
  const [baseUrl, setBaseUrl] = useState(getSetting("ollama-base-url") || "http://localhost:11434");
  const [autoDetect, setAutoDetect] = useState(getSetting("ollama-auto-detect") !== "false");
  const [status, setStatus] = useState<OllamaConnectionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saved, setSaved] = useState(false);

  const provider = getOllamaProvider();

  const checkConnection = useCallback(async () => {
    setChecking(true);
    const result = await provider.checkConnection();
    setStatus(result);
    setChecking(false);
  }, [provider]);

  const fetchModels = useCallback(async () => {
    setLoadingModels(true);
    const result = await provider.listModels();
    setModels(result);
    setLoadingModels(false);
  }, [provider]);

  // Auto-check on mount
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Fetch models if connected
  useEffect(() => {
    if (status?.connected && autoDetect) {
      fetchModels();
    }
  }, [status, autoDetect, fetchModels]);

  const handleSave = useCallback(() => {
    setSetting("ollama-base-url", baseUrl);
    setSetting("ollama-auto-detect", autoDetect ? "true" : "false");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Re-check connection with new URL
    checkConnection();
  }, [baseUrl, autoDetect, checkConnection]);

  return (
    <div className="settings-section">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Server size={18} />
        {S.ollama.settingsTitle[lang]}
      </h3>

      {/* Info banner */}
      <div style={{
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--accent-soft, rgba(124,58,237,0.1))",
        border: "1px solid var(--accent, #7c3aed)40",
        marginBottom: 16,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        fontSize: 'var(--fs-sm)',
      }}>
        <Cpu size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          <strong>{S.ollama.offlineMode[lang]}</strong> — {S.ollama.offlineModeHint[lang]}
          <br />
          <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent, #7c3aed)", textDecoration: "underline" }}>
            {S.ollama.downloadOllama[lang]} ↗
          </a>
        </div>
      </div>

      {/* Base URL */}
      <div className="settings-field" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 'var(--fs-base)', fontWeight: 600, marginBottom: 4, display: "block" }}>
          {S.ollama.baseUrl[lang]}
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434"
          style={inputStyle}
        />
        <div style={{ fontSize: 'var(--fs-sm)', color: "#6b7280", marginTop: 4 }}>{S.ollama.baseUrlHint[lang]}</div>
      </div>

      {/* Auto detect */}
      <div className="settings-field" style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={autoDetect} onChange={e => setAutoDetect(e.target.checked)} />
          <div>
            <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600 }}>{S.ollama.autoDetect[lang]}</div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "#6b7280" }}>{S.ollama.autoDetectHint[lang]}</div>
          </div>
        </label>
      </div>

      {/* Save button */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={handleSave} style={btnStyle}>
          <SettingsIcon size={14} />
          {S.ollama.save[lang]}
        </button>
        {saved && <span style={{ color: "#22c55e", fontSize: 'var(--fs-sm)', alignSelf: "center" }}>✓ {S.ollama.saved[lang]}</span>}
      </div>

      {/* Connection Status */}
      <div style={{
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--bg-secondary, #181825)",
        border: "1px solid var(--border-color, #333)",
        marginBottom: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 600 }}>{S.ollama.connectionStatus[lang]}</span>
          <button onClick={checkConnection} disabled={checking} style={btnStyle}>
            <RefreshCw size={12} className={checking ? "spin" : ""} />
            {S.ollama.checkConnection[lang]}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 'var(--fs-base)' }}>
          {checking ? (
            <>
              <RefreshCw size={14} className="spin" />
              <span>{S.ollama.checking[lang]}</span>
            </>
          ) : status?.connected ? (
            <>
              <CheckCircle size={14} color="#22c55e" />
              <span style={{ color: "#22c55e" }}>{S.ollama.connected[lang]}</span>
              <span style={{ color: "#6b7280", fontSize: 'var(--fs-sm)' }}>— {status.url}</span>
              <span style={{ marginLeft: "auto", fontWeight: 600 }}>
                {S.ollama.modelCount[lang]}: {status.modelCount}
              </span>
            </>
          ) : status ? (
            <>
              <XCircle size={14} color="#ef4444" />
              <span style={{ color: "#ef4444" }}>{S.ollama.disconnected[lang]}</span>
              <span style={{ color: "#6b7280", fontSize: 'var(--fs-sm)' }}>— {status.error}</span>
            </>
          ) : null}
        </div>
        {!status?.connected && status && (
          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: "#f59e0b" }}>
            ⚠ {S.ollama.connectError[lang]}
          </div>
        )}
      </div>

      {/* Model List */}
      {status?.connected && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--fs-base)', fontWeight: 600 }}>{S.ollama.models[lang]}</span>
            <button onClick={fetchModels} disabled={loadingModels} style={btnStyle}>
              <RefreshCw size={12} className={loadingModels ? "spin" : ""} />
              {S.ollama.refreshModels[lang]}
            </button>
          </div>

          {models.length === 0 ? (
            <div style={{ textAlign: "center", padding: 16, color: "#6b7280", fontSize: 'var(--fs-sm)' }}>
              {S.ollama.noModels[lang]}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {models.map(m => (
                <div key={m.id} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 10px", borderRadius: 6,
                  background: "var(--bg-secondary, #181825)",
                  border: "1px solid var(--border-color, #333)",
                  fontSize: 'var(--fs-sm)',
                }}>
                  <Cpu size={14} style={{ flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontFamily: "'Cascadia Code', monospace" }}>{m.id}</span>
                  <span style={{ color: "#6b7280", fontSize: 'var(--fs-sm)' }}>
                    ctx: {(m.contextWindow / 1000).toFixed(0)}K
                  </span>
                  {m.supportsTools && (
                    <span style={{ fontSize: 'var(--fs-xs)', padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
                      tools
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", color: "#22c55e", fontSize: 'var(--fs-sm)' }}>FREE</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: "#6b7280", fontStyle: "italic" }}>
            {S.ollama.installHint[lang]}
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-secondary, #181825)",
  border: "1px solid var(--border-color, #333)",
  borderRadius: 6,
  color: "inherit",
  fontSize: 'var(--fs-base)',
  fontFamily: "'Cascadia Code', monospace",
};

const btnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 'var(--fs-sm)',
  cursor: "pointer",
  border: "1px solid var(--border-color, #333)",
  background: "transparent",
  color: "inherit",
};
