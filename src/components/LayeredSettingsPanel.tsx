import { useState, useEffect } from "react";
import {
  getSettingsManager,
  type SettingsSource,
  type SettingsSourceConfig,
} from "../core/settings/settings";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";

/**
 * 分层设置管理面板。
 *
 * 样式：第 16 波把内联样式收口成 `.layered-*` 具名类（见 src/styles.css），
 * 按钮复用共享 `.panel-btn`，等宽文本复用 `.mono`。
 */

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

  // 一次算好，避免同一个 getter 在渲染里被反复调用（原代码每处都调了两遍）
  const blockedModels = mgr ? mgr.getBlockedModels() : [];
  const blockedProviders = mgr ? mgr.getBlockedProviders() : [];

  return (
    <div className="layered-panel">
      <div>
        <div className="layered-title">
          🏗️ {zh ? "分层设置管理" : "Layered Settings Management"}
        </div>
        <div className="layered-subtitle">
          {zh
            ? "查看设置来源优先级链。高优先级来源覆盖低优先级。当前项目: "
            : "View settings source priority chain. Higher priority overrides lower. Current project: "}
          <span className="layered-path">
            {currentProject?.path || zh ? "(未选择)" : "(none)"}
          </span>
        </div>
      </div>

      {/* Priority chain visualization */}
      <div className="layered-card">
        <div className="layered-card-title">
          {zh ? "优先级链（从高到低）" : "Priority Chain (high to low)"}
        </div>
        <div className="layered-chain">
          {sortedSources.map((s) => {
            const isActive = selectedSource === s.source;
            return (
              <div
                key={s.source}
                onClick={() => setSelectedSource(isActive ? null : s.source)}
                className={`layered-item${isActive ? " is-active" : ""}`}
              >
                <span className={`layered-priority${s.enabled ? "" : " is-off"}`}>
                  {s.priority}
                </span>
                <div className="layered-item-main">
                  <div className="layered-item-name">
                    {zh ? SOURCE_LABELS_ZH[s.source] : SOURCE_LABELS_EN[s.source]}
                    {!s.enabled && <span className="layered-item-disabled">({zh ? "已禁用" : "disabled"})</span>}
                  </div>
                  <div className="layered-item-desc">
                    {zh ? SOURCE_PRIORITY_DESC_ZH[s.source] : SOURCE_PRIORITY_DESC_EN[s.source]}
                  </div>
                </div>
                {s.path && (
                  <span className="layered-item-path">
                    {s.path}
                  </span>
                )}
                {s.lastLoaded && (
                  <span className="layered-item-note">
                    {zh ? "已加载" : "loaded"}
                  </span>
                )}
                {s.data && Object.keys(s.data).length > 0 && (
                  <span className="layered-item-count">
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
        <div className="layered-card">
          <div className="layered-card-title is-strong">
            {zh ? SOURCE_LABELS_ZH[selectedConfig.source] : SOURCE_LABELS_EN[selectedConfig.source]} — {zh ? "详情" : "Details"}
          </div>

          <div className="layered-detail-grid">
            <div>
              <label className="layered-label">{zh ? "来源" : "Source"}</label>
              <div className="layered-value layered-value--mono">{selectedConfig.source}</div>
            </div>
            <div>
              <label className="layered-label">{zh ? "优先级" : "Priority"}</label>
              <div className="layered-value">{selectedConfig.priority}</div>
            </div>
            <div>
              <label className="layered-label">{zh ? "路径" : "Path"}</label>
              <div className="layered-value layered-value--mono layered-value--muted">{selectedConfig.path || "-"}</div>
            </div>
            <div>
              <label className="layered-label">{zh ? "已加载" : "Last Loaded"}</label>
              <div className="layered-value">
                {selectedConfig.lastLoaded ? new Date(selectedConfig.lastLoaded).toLocaleString() : "-"}
              </div>
            </div>
          </div>

          {selectedConfig.data && Object.keys(selectedConfig.data).length > 0 && (
            <div>
              <label className="layered-label">{zh ? "数据" : "Data"}</label>
              <pre className="layered-pre">
                {JSON.stringify(selectedConfig.data, null, 2)}
              </pre>
            </div>
          )}

          {(!selectedConfig.data || Object.keys(selectedConfig.data).length === 0) && (
            <div className="layered-empty-data">
              {zh ? "无数据" : "No data"}
            </div>
          )}
        </div>
      )}

      {/* Policy info */}
      {mgr && (
        <div className="layered-card">
          <div className="layered-card-title">
            🛡️ {zh ? "策略限制" : "Policy Restrictions"}
          </div>
          <div className="layered-policy">
            <div>
              <span className="layered-policy-key">{zh ? "绕过权限禁用" : "Bypass disabled"}: </span>
              <span className={`layered-policy-value ${mgr.isBypassDisabled() ? "is-bad" : "is-ok"}`}>
                {mgr.isBypassDisabled() ? "✅ " + (zh ? "是" : "Yes") : "❌ " + (zh ? "否" : "No")}
              </span>
            </div>
            <div>
              <span className="layered-policy-key">{zh ? "屏蔽模型" : "Blocked models"}: </span>
              <span className={`layered-policy-value ${blockedModels.length > 0 ? "is-warn" : "is-ok"}`}>
                {blockedModels.length > 0 ? blockedModels.join(", ") : (zh ? "无" : "None")}
              </span>
            </div>
            <div>
              <span className="layered-policy-key">{zh ? "屏蔽供应商" : "Blocked providers"}: </span>
              <span className={`layered-policy-value ${blockedProviders.length > 0 ? "is-warn" : "is-ok"}`}>
                {blockedProviders.length > 0 ? blockedProviders.join(", ") : (zh ? "无" : "None")}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Export */}
      <div className="layered-actions">
        <button onClick={handleExport} className="panel-btn">
          📤 {zh ? "导出所有设置" : "Export All Settings"}
        </button>
        {showExport && (
          <button onClick={() => { navigator.clipboard?.writeText(exportData); }} className="panel-btn">
            📋 {zh ? "复制到剪贴板" : "Copy to Clipboard"}
          </button>
        )}
      </div>

      {showExport && (
        <pre className="layered-pre layered-pre--export">
          {exportData}
        </pre>
      )}
    </div>
  );
}
