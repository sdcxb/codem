/**
 * AutomationTab — 自动化任务 Tab（任务管理）
 *
 * 这是自动化触发器的**唯一编辑入口**：原 SettingsPanel 里的
 * AutomationSettingsSection 已删除，设置面板只保留跳转提示，避免两套 UI 各写一份配置。
 */

import { useState, useEffect } from "react";
import { Bot, Folder, Clock, Play, Plus, History, Calendar, AlertTriangle } from "lucide-react";
import {
  getAutomationConfig,
  setAutomationConfig,
  refreshAutomationEngines,
  stopAutomationEngines,
  resumeAutomationEngines,
  isAutomationStopped,
  type AutomationTrigger,
  type TriggerType,
} from "../../core/automation/automation-manager";
import { useLang } from "../../core/i18n/lang";

export function AutomationTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [triggers, setTriggers] = useState<AutomationTrigger[]>([]);
  const [editing, setEditing] = useState<Partial<AutomationTrigger> | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  // 暂停状态从模块读取（引擎是单例）：卸载重挂 / 切页签都不会与真实状态脱节
  const [enginesStopped, setEnginesStopped] = useState(() => isAutomationStopped());

  useEffect(() => {
    const config = getAutomationConfig();
    setTriggers(config.triggers);
    setHistory(config.history || []);
    setEnginesStopped(isAutomationStopped());
    const handler = () => {
      const c = getAutomationConfig();
      setTriggers(c.triggers);
      setHistory(c.history || []);
    };
    window.addEventListener("codem-automation-config-changed", handler);
    return () => window.removeEventListener("codem-automation-config-changed", handler);
  }, []);

  const handleToggleEngines = () => {
    if (isAutomationStopped()) {
      // 恢复：handler 仍在，重新起表；引擎从未装配过则保持暂停态（按钮不变）
      const resumed = resumeAutomationEngines();
      setEnginesStopped(!resumed);
      return;
    }
    stopAutomationEngines();
    setEnginesStopped(true);
  };

  const handleAdd = () => {
    setEditing({
      id: `trigger-${Date.now()}`,
      name: "",
      type: "timer",
      enabled: true,
      message: "",
      intervalMs: 3600000,
      cooldownMs: 30000,
    });
  };

  const handleSave = () => {
    if (!editing || !editing.name || !editing.message) return;
    const config = getAutomationConfig();
    const existing = config.triggers.findIndex((t) => t.id === editing.id);
    if (existing >= 0) {
      config.triggers[existing] = editing as AutomationTrigger;
    } else {
      config.triggers.push(editing as AutomationTrigger);
    }
    setAutomationConfig(config);
    setTriggers(config.triggers);
    setEditing(null);
    refreshAutomationEngines();
  };

  const handleToggle = (id: string) => {
    const t = triggers.find((t) => t.id === id);
    if (!t) return;
    const config = getAutomationConfig();
    config.triggers = config.triggers.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
    setAutomationConfig(config);
    setTriggers(config.triggers);
    refreshAutomationEngines();
  };

  const handleDelete = (id: string) => {
    const config = getAutomationConfig();
    config.triggers = config.triggers.filter((t) => t.id !== id);
    setAutomationConfig(config);
    setTriggers(config.triggers);
    refreshAutomationEngines();
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)',
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 4,
    display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: 'var(--fs-base)',
    width: "100%",
  };

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Description */}
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 16 }}>
        {zh
          ? "配置文件监听和定时器触发器，自动创建会话并发送预设消息。支持工作树模式并行隔离。"
          : "Configure file-watch and timer triggers to automatically create sessions and send preset messages. Supports worktree mode for parallel isolation."}
      </div>

      {/* Trigger list */}
      {triggers.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-tertiary)",
            marginBottom: 8,
            fontSize: 'var(--fs-sm)',
          }}
        >
          <input
            type="checkbox"
            checked={t.enabled}
            onChange={() => handleToggle(t.id)}
            style={{ width: 16, height: 16 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{t.name}</div>
            <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
              {t.type === "file_watch" && <><Folder size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {t.message}</>}
              {t.type === "timer" && <><Clock size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {t.message}</>}
              {t.type === "cron" && <><Calendar size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {t.cronExpression || "—"} · {t.message}</>}
              {t.type === "issue_status" && <><AlertTriangle size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {zh ? "状态" : "status"}={t.issueStatusFilter || "*"} · {t.message}</>}
            </div>
          </div>
          <button
            onClick={() => setEditing(t)}
            style={{
              fontSize: 'var(--fs-sm)',
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid var(--border-primary)",
              background: "none",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            {zh ? "编辑" : "Edit"}
          </button>
          <button
            onClick={() => handleDelete(t.id)}
            style={{
              fontSize: 'var(--fs-sm)',
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid var(--error)",
              background: "none",
              color: "var(--error)",
              cursor: "pointer",
            }}
          >
            {zh ? "删除" : "Del"}
          </button>
        </div>
      ))}

      {triggers.length === 0 && (
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginBottom: 8 }}>
          {zh ? "无触发器。点击下方按钮添加。" : "No triggers. Click below to add one."}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={handleAdd}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            fontSize: 'var(--fs-base)',
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Plus size={14} /> {zh ? "添加触发器" : "Add Trigger"}
        </button>

        {triggers.length > 0 && (
          <button
            onClick={handleToggleEngines}
            title={
              enginesStopped
                ? zh ? "重新启动所有自动化引擎" : "Restart all automation engines"
                : zh ? "暂停所有自动化引擎（可随时恢复）" : "Pause all automation engines (resumable)"
            }
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 'var(--fs-base)',
              border: enginesStopped ? "1px solid var(--success)" : "1px solid var(--error)",
              background: "none",
              color: enginesStopped ? "var(--success)" : "var(--error)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {enginesStopped ? (
              <>
                <Play size={12} /> {zh ? "恢复运行" : "Resume"}
              </>
            ) : zh ? "停止所有" : "Stop All"}
          </button>
        )}
      </div>

      {/* Trigger history */}
      {history.length > 0 && (
        <div>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
            <History size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {zh ? "触发历史" : "Trigger History"} ({history.length})
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {history.slice(0, 20).map((h, i) => (
              <div
                key={i}
                style={{
                  fontSize: 'var(--fs-sm)',
                  padding: "6px 8px",
                  borderRadius: 4,
                  background: "var(--bg-tertiary)",
                }}
              >
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                  {new Date(h.timestamp).toLocaleString()}
                </span>
                <span style={{ marginLeft: 6 }}>{h.triggerName}</span>
                <span
                  style={{
                    marginLeft: 6,
                    opacity: 0.6,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "inline-block",
                    maxWidth: 200,
                  }}
                >
                  {h.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 8,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)",
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "名称" : "Name"}</label>
            <input
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "类型" : "Type"}</label>
            <select
              value={editing.type}
              onChange={(e) => setEditing({ ...editing, type: e.target.value as TriggerType })}
              style={inputStyle}
            >
              <option value="timer">{zh ? "定时器" : "Timer"}</option>
              <option value="file_watch">{zh ? "文件监听" : "File Watch"}</option>
              <option value="cron">{zh ? "Cron 定时" : "Cron Schedule"}</option>
              <option value="issue_status">{zh ? "Issue 状态变化" : "Issue Status Change"}</option>
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "触发消息" : "Trigger Message"}</label>
            <textarea
              value={editing.message || ""}
              onChange={(e) => setEditing({ ...editing, message: e.target.value })}
              style={{ ...inputStyle, minHeight: 60 }}
            />
          </div>
          {editing.type === "file_watch" && (
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>{zh ? "监听文件路径" : "Watch Path"}</label>
              <input
                value={editing.watchPath || ""}
                onChange={(e) => setEditing({ ...editing, watchPath: e.target.value })}
                style={inputStyle}
                placeholder={zh ? "C:\\path\\to\\file" : "/path/to/file"}
              />
            </div>
          )}
          {editing.type === "timer" && (
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>{zh ? "间隔（毫秒）" : "Interval (ms)"}</label>
              <input
                type="number"
                value={editing.intervalMs || 3600000}
                onChange={(e) => setEditing({ ...editing, intervalMs: parseInt(e.target.value) || 3600000 })}
                style={{ ...inputStyle, width: 120 }}
              />
            </div>
          )}
          {editing.type === "cron" && (
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>{zh ? "Cron 表达式" : "Cron Expression"}</label>
              <input
                value={editing.cronExpression || ""}
                onChange={(e) => setEditing({ ...editing, cronExpression: e.target.value })}
                style={inputStyle}
                placeholder="0 9 * * 1-5 (min hour dom mon dow)"
              />
              <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", marginTop: 4 }}>
                {zh ? "例: */30 * * * * = 每30分钟, 0 9 * * 1-5 = 工作日9点" : "e.g. */30 * * * * = every 30min, 0 9 * * 1-5 = weekdays 9am"}
              </div>
            </div>
          )}
          {editing.type === "issue_status" && (
            <>
              <div style={{ marginBottom: 8 }}>
                <label style={labelStyle}>{zh ? "监听状态" : "Watch Status"}</label>
                <select
                  value={editing.issueStatusFilter || ""}
                  onChange={(e) => setEditing({ ...editing, issueStatusFilter: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">{zh ? "所有状态" : "Any status"}</option>
                  <option value="in_progress">{zh ? "进行中" : "In Progress"}</option>
                  <option value="in_review">{zh ? "待审查" : "In Review"}</option>
                  <option value="done">{zh ? "已完成" : "Done"}</option>
                  <option value="blocked">{zh ? "阻塞" : "Blocked"}</option>
                  <option value="cancelled">{zh ? "已取消" : "Cancelled"}</option>
                </select>
              </div>
              <div style={{ marginBottom: 8, fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                {zh ? "消息中可用占位符: {issue_id} {status}" : "Placeholders in message: {issue_id} {status}"}
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleSave}
              disabled={!editing.name || !editing.message}
              style={{
                padding: "6px 16px",
                borderRadius: 4,
                fontSize: 'var(--fs-sm)',
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
                opacity: !editing.name || !editing.message ? 0.5 : 1,
              }}
            >
              {zh ? "保存" : "Save"}
            </button>
            <button
              onClick={() => setEditing(null)}
              style={{
                padding: "6px 16px",
                borderRadius: 4,
                fontSize: 'var(--fs-sm)',
                border: "1px solid var(--border-primary)",
                background: "none",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
