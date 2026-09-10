/**
 * AutomationTab — 自动化任务 Tab（任务管理）
 *
 * 这是自动化触发器的**唯一编辑入口**：原 SettingsPanel 里的
 * AutomationSettingsSection 已删除，设置面板只保留跳转提示，避免两套 UI 各写一份配置。
 *
 * 样式：第 15 波把内联样式收口成具名类（`tc-*` 通用 + `automation-*` 本组件），
 * 见 src/styles/task-center.css。
 */

import { useState, useEffect } from "react";
import { Folder, Clock, Play, Plus, History, Calendar, AlertTriangle } from "lucide-react";
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
import { ISSUE_STATUS_META } from "./issue-status-meta";

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

  return (
    <div className="tc-tab">
      {/* Description */}
      <div className="automation-desc">
        {zh
          ? "配置文件监听和定时器触发器，自动创建会话并发送预设消息。支持工作树模式并行隔离。"
          : "Configure file-watch and timer triggers to automatically create sessions and send preset messages. Supports worktree mode for parallel isolation."}
      </div>

      {/* Trigger list */}
      {triggers.map((t) => (
        <div key={t.id} className="automation-trigger">
          <input
            type="checkbox"
            checked={t.enabled}
            onChange={() => handleToggle(t.id)}
            className="automation-checkbox"
          />
          <div className="automation-trigger-main">
            <div className="automation-trigger-name">{t.name}</div>
            <div className="automation-trigger-meta">
              {t.type === "file_watch" && <><Folder size={12} /> {t.message}</>}
              {t.type === "timer" && <><Clock size={12} /> {t.message}</>}
              {t.type === "cron" && <><Calendar size={12} /> {t.cronExpression || "—"} · {t.message}</>}
              {t.type === "issue_status" && <><AlertTriangle size={12} /> {zh ? "状态" : "status"}={t.issueStatusFilter || "*"} · {t.message}</>}
            </div>
          </div>
          <button onClick={() => setEditing(t)} className="tc-btn tc-btn--sm">
            {zh ? "编辑" : "Edit"}
          </button>
          <button onClick={() => handleDelete(t.id)} className="tc-btn tc-btn--sm tc-btn--stop">
            {zh ? "删除" : "Del"}
          </button>
        </div>
      ))}

      {triggers.length === 0 && (
        <div className="automation-empty">
          {zh ? "无触发器。点击下方按钮添加。" : "No triggers. Click below to add one."}
        </div>
      )}

      <div className="automation-actions">
        <button onClick={handleAdd} className="tc-btn tc-btn--primary tc-btn--lg">
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
            className={`tc-btn tc-btn--lg ${enginesStopped ? "tc-btn--resume" : "tc-btn--stop"}`}
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
          <div className="automation-history-title">
            <History size={12} /> {zh ? "触发历史" : "Trigger History"} ({history.length})
          </div>
          <div className="automation-history-list">
            {history.slice(0, 20).map((h, i) => (
              <div key={i} className="automation-history-item">
                <span className="automation-history-time">
                  {new Date(h.timestamp).toLocaleString()}
                </span>
                <span className="automation-history-name">{h.triggerName}</span>
                <span className="automation-history-msg">
                  {h.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div className="tc-editor">
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "名称" : "Name"}</label>
            <input
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="tc-field"
            />
          </div>
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "类型" : "Type"}</label>
            <select
              value={editing.type}
              onChange={(e) => setEditing({ ...editing, type: e.target.value as TriggerType })}
              className="tc-field"
            >
              <option value="timer">{zh ? "定时器" : "Timer"}</option>
              <option value="file_watch">{zh ? "文件监听" : "File Watch"}</option>
              <option value="cron">{zh ? "Cron 定时" : "Cron Schedule"}</option>
              <option value="issue_status">{zh ? "Issue 状态变化" : "Issue Status Change"}</option>
            </select>
          </div>
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "触发消息" : "Trigger Message"}</label>
            <textarea
              value={editing.message || ""}
              onChange={(e) => setEditing({ ...editing, message: e.target.value })}
              className="tc-field tc-field--area"
            />
          </div>
          {editing.type === "file_watch" && (
            <div className="tc-field-row">
              <label className="tc-label">{zh ? "监听文件路径" : "Watch Path"}</label>
              <input
                value={editing.watchPath || ""}
                onChange={(e) => setEditing({ ...editing, watchPath: e.target.value })}
                className="tc-field"
                placeholder={zh ? "C:\\path\\to\\file" : "/path/to/file"}
              />
            </div>
          )}
          {editing.type === "timer" && (
            <div className="tc-field-row">
              <label className="tc-label">{zh ? "间隔（毫秒）" : "Interval (ms)"}</label>
              <input
                type="number"
                value={editing.intervalMs || 3600000}
                onChange={(e) => setEditing({ ...editing, intervalMs: parseInt(e.target.value) || 3600000 })}
                className="tc-field automation-field-narrow"
              />
            </div>
          )}
          {editing.type === "cron" && (
            <div className="tc-field-row">
              <label className="tc-label">{zh ? "Cron 表达式" : "Cron Expression"}</label>
              <input
                value={editing.cronExpression || ""}
                onChange={(e) => setEditing({ ...editing, cronExpression: e.target.value })}
                className="tc-field"
                placeholder="0 9 * * 1-5 (min hour dom mon dow)"
              />
              <div className="automation-hint">
                {zh ? "例: */30 * * * * = 每30分钟, 0 9 * * 1-5 = 工作日9点" : "e.g. */30 * * * * = every 30min, 0 9 * * 1-5 = weekdays 9am"}
              </div>
            </div>
          )}
          {editing.type === "issue_status" && (
            <>
              <div className="tc-field-row">
                <label className="tc-label">{zh ? "监听状态" : "Watch Status"}</label>
                <select
                  value={editing.issueStatusFilter || ""}
                  onChange={(e) => setEditing({ ...editing, issueStatusFilter: e.target.value })}
                  className="tc-field"
                >
                  <option value="">{zh ? "所有状态" : "Any status"}</option>
                  {/* 状态清单来自唯一的 issue-status-meta 表（原先只列了 5 个，漏了 backlog/todo） */}
                  {ISSUE_STATUS_META.map((m) => (
                    <option key={m.status} value={m.status}>
                      {zh ? m.labelZh : m.labelEn}
                    </option>
                  ))}
                </select>
              </div>
              <div className="automation-hint--block">
                {zh ? "消息中可用占位符: {issue_id} {status}" : "Placeholders in message: {issue_id} {status}"}
              </div>
            </>
          )}
          <div className="tc-editor-actions">
            <button
              onClick={handleSave}
              disabled={!editing.name || !editing.message}
              className="tc-btn tc-btn--primary"
            >
              {zh ? "保存" : "Save"}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="tc-btn"
            >
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
