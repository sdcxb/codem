import { useState, useEffect } from "react";
import {
  getSettingsManager,
  type SettingsSource,
  type SettingsSourceConfig,
} from "../core/settings/settings";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";

const SOURCE_LABELS_ZH: Record<SettingsSource, string> = {
  cli: "命令行参数",
  policy: "企业策略",
  flag: "功能标志",
  user: "用户全局",
  project: "项目设置",
  local: "本地项目",
  default: "内置默认",
};

const SOURCE_LABELS_EN: Record<SettingsSource, string> = {
  cli: "CLI Args",
  policy: "Enterprise Policy",
  flag: "Feature Flags",
  user: "User Global",
  project: "Project Settings",
  local: "Local Project",
  default: "Built-in Default",
};

const SOURCE_PRIORITY_DESC_ZH: Record<SettingsSource, string> = {
  cli: "最高优先级 — 命令行启动参数",
  policy: "企业管理策略，由组织统一下发",
  flag: "功能标志（GrowthBook 等），远程控制",
  user: "用户全局设置 (~/.codem/settings.json)",
  project: "项目设置 (.codem/settings.json)，团队共享",
  local: "本地项目设置 (.codem/settings.local.json)，不提交",
  default: "内置默认值，最低优先级",
};

const SOURCE_PRIORITY_DESC_EN: Record<SettingsSource, string> = {
  cli: "Highest priority — command line arguments",
  policy: "Enterprise policy, distributed by organization",
  flag: "Feature flags (GrowthBook etc.), remote controlled",
  user: "User global settings (~/.codem/settings.json)",
  project: "Project settings (.codem/settings.json), shared with team",
  local: "Local project settings (.codem/settings.local.json), not committed",
  default: "Built-in defaults, lowest priority",
};

export function LayeredSettingsPanel() {
  const lang = useLang();
  const zh = lang === "zh";
  const { currentProject } = useProjectStore();
  const [sources, setSources] = useState<SettingsSourceConfig[]>([]);
  const [selectedSource, setSelectedSource] = useState<SettingsSource | null>(null);
  const [exportData, setExportData] = useState<string>("");
  const [showExport, setShowExport] = useState(false);

  const refresh = () => {
    const mgr = getSettingsManager(currentProject?.path || ".");
    if (mgr) {
      setSources(mgr.getAllSources());
    }
  };

  useEffect(() => {
    refresh();
  }, [currentProject?.path]);

  const mgr = getSettingsManager(currentProject?.path || ".");

  const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);

  const selectedConfig = sources.find(s => s.source === selectedSource);

  const handleExport = () => {
    if (!mgr) return;
    const data = mgr.exportSettings();
    setExportData(JSON.stringify(data, null, 2));
    setShowExport(true);
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 3, display: "block",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
          🏗️ {zh ? "分层设置管理" : "Layered Settings Management"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
          {zh
            ? "查看设置来源优先级链。高优先级来源覆盖低优先级。当前项目: "
            : "View settings source priority chain. Higher priority overrides lower. Current project: "}
          <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
            {currentProject?.path || zh ? "(未选择)" : "(none)"}
          </span>
        </div>
      </div>

      {/* Priority chain visualization */}
      <div style={{
        padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
          {zh ? "优先级链（从高到低）" : "Priority Chain (high to low)"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {sortedSources.map((s, i) => {
            const isActive = selectedSource === s.source;
            return (
              <div
                key={s.source}
                onClick={() => setSelectedSource(isActive ? null : s.source)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  borderRadius: 4, cursor: "pointer", fontSize: 12,
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--border-primary)"}`,
                  background: isActive ? "rgba(99, 102, 241, 0.1)" : "var(--bg-tertiary)",
                }}
              >
                <span style={{
                  width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700,
                  background: s.enabled ? "var(--accent)" : "var(--bg-secondary)",
                  color: s.enabled ? "#fff" : "var(--text-muted)",
                }}>
                  {s.priority}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                    {zh ? SOURCE_LABELS_ZH[s.source] : SOURCE_LABELS_EN[s.source]}
                    {!s.enabled && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-muted)" }}>({zh ? "已禁用" : "disabled"})</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {zh ? SOURCE_PRIORITY_DESC_ZH[s.source] : SOURCE_PRIORITY_DESC_EN[s.source]}
                  </div>
                </div>
                {s.path && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.path}
                  </span>
                )}
                {s.lastLoaded && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {zh ? "已加载" : "loaded"}
                  </span>
                )}
                {s.data && Object.keys(s.data).length > 0 && (
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--bg-secondary)", color: "var(--text-secondary)" }}>
                    {Object.keys(s.data).length} {zh ? "项" : "keys"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected source detail */}
      {selectedConfig && (
        <div style={{
          padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
            {zh ? SOURCE_LABELS_ZH[selectedConfig.source] : SOURCE_LABELS_EN[selectedConfig.source]} — {zh ? "详情" : "Details"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div>
              <label style={labelStyle}>{zh ? "来源" : "Source"}</label>
              <div style={{ fontSize: 12, color: "var(--text-primary)", fontFamily: "monospace" }}>{selectedConfig.source}</div>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "优先级" : "Priority"}</label>
              <div style={{ fontSize: 12, color: "var(--text-primary)" }}>{selectedConfig.priority}</div>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "路径" : "Path"}</label>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>{selectedConfig.path || "-"}</div>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "已加载" : "Last Loaded"}</label>
              <div style={{ fontSize: 12, color: "var(--text-primary)" }}>
                {selectedConfig.lastLoaded ? new Date(selectedConfig.lastLoaded).toLocaleString() : "-"}
              </div>
            </div>
          </div>

          {selectedConfig.data && Object.keys(selectedConfig.data).length > 0 && (
            <div>
              <label style={labelStyle}>{zh ? "数据" : "Data"}</label>
              <pre style={{
                fontSize: 10, padding: 8, background: "var(--bg-tertiary)", borderRadius: 4,
                maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", margin: 0,
                color: "var(--text-secondary)", fontFamily: "monospace",
              }}>
                {JSON.stringify(selectedConfig.data, null, 2)}
              </pre>
            </div>
          )}

          {(!selectedConfig.data || Object.keys(selectedConfig.data).length === 0) && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
              {zh ? "无数据" : "No data"}
            </div>
          )}
        </div>
      )}

      {/* Policy info */}
      {mgr && (
        <div style={{
          padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
            🛡️ {zh ? "策略限制" : "Policy Restrictions"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{zh ? "绕过权限禁用" : "Bypass disabled"}: </span>
              <span style={{ fontWeight: 600, color: mgr.isBypassDisabled() ? "var(--error)" : "var(--success)" }}>
                {mgr.isBypassDisabled() ? "✅ " + (zh ? "是" : "Yes") : "❌ " + (zh ? "否" : "No")}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{zh ? "屏蔽模型" : "Blocked models"}: </span>
              <span style={{ fontWeight: 600, color: mgr.getBlockedModels().length > 0 ? "var(--warning)" : "var(--success)" }}>
                {mgr.getBlockedModels().length > 0 ? mgr.getBlockedModels().join(", ") : (zh ? "无" : "None")}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{zh ? "屏蔽供应商" : "Blocked providers"}: </span>
              <span style={{ fontWeight: 600, color: mgr.getBlockedProviders().length > 0 ? "var(--warning)" : "var(--success)" }}>
                {mgr.getBlockedProviders().length > 0 ? mgr.getBlockedProviders().join(", ") : (zh ? "无" : "None")}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Export */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={handleExport} style={{
          padding: "6px 14px", borderRadius: 4, fontSize: 12,
          border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
          color: "var(--text-primary)", cursor: "pointer",
        }}>
          📤 {zh ? "导出所有设置" : "Export All Settings"}
        </button>
        {showExport && (
          <button onClick={() => { navigator.clipboard?.writeText(exportData); }} style={{
            padding: "6px 14px", borderRadius: 4, fontSize: 12,
            border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
            color: "var(--text-primary)", cursor: "pointer",
          }}>
            📋 {zh ? "复制到剪贴板" : "Copy to Clipboard"}
          </button>
        )}
      </div>

      {showExport && (
        <pre style={{
          fontSize: 10, padding: 8, background: "var(--bg-tertiary)", borderRadius: 4,
          maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", margin: 0,
          color: "var(--text-secondary)", fontFamily: "monospace",
          border: "1px solid var(--border-primary)",
        }}>
          {exportData}
        </pre>
      )}
    </div>
  );
}
