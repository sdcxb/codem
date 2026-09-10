import { useState, useEffect, useRef } from "react";
import {
  getAgentRegistry,
  type AgentDefinition,
  type AgentMode,
  type AgentPermission,
  type CollaborationMode,
} from "../core/agent/agent";
import type { TaskSlot } from "../core/llm/model-profile";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";

/**
 * AgentManager — 智能体定义管理（列表 + 详情 + 编辑表单）。
 *
 * 样式：第 19 波把内联样式收口成 `.agent-*` 具名类（见 src/styles.css），
 * 外壳沿用 `.skill-manager-*` / `.market-skill-*`（与技能管理同一套）。
 */

const MODE_LABELS: Record<AgentMode, string> = {
  primary: "主智能体",
  subagent: "子智能体",
  all: "通用",
};

const SLOT_LABELS: Record<TaskSlot, string> = {
  chat: "主对话 (chat)",
  subagent: "子任务 (subagent)",
  memory: "记忆提取 (memory)",
  compaction: "上下文压缩 (compaction)",
  vision: "视觉理解 (vision)",
  tts: "语音合成 (tts)",
  imageGen: "图像生成 (imageGen)",
  embedding: "语义搜索 (embedding)",
};

// 必选工具 — 新建 agent 时默认勾选且不可取消
const REQUIRED_TOOLS = ["read", "glob", "grep"];

// 预置工具列表（用于 UI 复选框展示）
const BUILTIN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "multi_edit",
  "glob",
  "grep",
  "tts",
  "image_gen",
  "load_skill",
  "web_search",
  "read_attachment",
  "search_notebook",
  "create_note",
  "edit_note",
  "link_notes",
  "ask_clarification",
  "fact_check",
  "show_todo",
  "browser_automate",
  "figma_fetch",
  "github_tool",
  "lsp_tool",
  "tool_search",
  "subagent",
  "send_message",
  "interrupt_agent",
  "list_agents",
];

function emptyAgent(): AgentDefinition {
  return {
    id: `agent-${Date.now()}`,
    name: "",
    description: "",
    mode: "subagent",
    prompt: "",
    promptEn: "",
    toolAllowlist: [...REQUIRED_TOOLS],
    permissions: [{ tool: "*", action: "allow" }],
    canSpawnSubagents: false,
    maxSteps: 10,
    contextMode: "inline",
    collaborationMode: "default",
    modelSlot: "subagent",
  };
}

export function AgentManager({ onClose }: { onClose: () => void }) {
  const lang = useLang();
  const zh = lang === "zh";
  const AgentIcon = PanelIcons.agent;
  const CloseIcon = ActionIcons.close;
  const AddIcon = ActionIcons.add;
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [isNew, setIsNew] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    setAgents(getAgentRegistry().getAll());
  };

  useEffect(() => {
    refresh();
  }, []);

  const selected = editing || (selectedId ? agents.find(a => a.id === selectedId) : null);
  const isBuiltin = selected ? getAgentRegistry().isBuiltin(selected.id) : false;

  const handleNew = () => {
    setEditing(emptyAgent());
    setIsNew(true);
    setSelectedId(null);
    // 滚动到编辑区域，确保用户看到新建表单
    setTimeout(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const handleEdit = (agent: AgentDefinition) => {
    setEditing({ ...agent });
    setIsNew(false);
    setSelectedId(agent.id);
    // 滚动到编辑区域
    setTimeout(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const handleSave = () => {
    if (!editing) return;
    if (!editing.name.trim()) return;
    const registry = getAgentRegistry();
    if (isNew) {
      registry.register(editing);
    } else {
      registry.update(editing.id, editing);
    }
    setEditing(null);
    setIsNew(false);
    refresh();
  };

  const handleDelete = (id: string) => {
    if (!confirm(zh ? "确认删除此智能体？" : "Delete this agent?")) return;
    getAgentRegistry().unregister(id);
    if (selectedId === id) setSelectedId(null);
    refresh();
  };

  const handleCancel = () => {
    setEditing(null);
    setIsNew(false);
  };

  return (
    <div className="skill-manager">
      {/* Header */}
      <div className="skill-manager-header">
        <div className="skill-manager-title">
          <AgentIcon size={20} className="skill-manager-icon-svg" />
          <span>{zh ? "智能体定义管理" : "Agent Management"}</span>
        </div>
        <button className="skill-manager-close" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      {/* Toolbar */}
      <div className="skill-manager-toolbar">
        <div className="agent-toolbar-note">
          {zh ? "查看、创建和编辑智能体定义。内置智能体不可编辑/删除。" : "View, create, and edit agent definitions. Built-in agents are read-only."}
        </div>
        <button
          onClick={handleNew}
          className="market-skill-link-btn agent-new-btn"
        >
          <AddIcon size={12} /> {zh ? "新建" : "New"}
        </button>
      </div>

      {/* Agent list + detail/edit form (scrollable) */}
      <div className="agent-list">
        <div className="skill-market-grid agent-grid">
        {agents.map(agent => {
          const builtin = getAgentRegistry().isBuiltin(agent.id);
          const active = selectedId === agent.id && !editing;
          return (
            <div
              key={agent.id}
              onClick={() => { if (!editing) setSelectedId(agent.id); }}
              className={`market-skill-card ${active ? "selected" : ""}`}
            >
              <div className="market-skill-card-header">
                <span className="market-skill-icon">
                  <AgentIcon size={14} style={{ color: agent.mode === "primary" ? "var(--accent)" : "var(--text-secondary)" }} />
                </span>
                <div className="market-skill-card-title">
                  <span className="market-skill-name">{agent.name || agent.id}</span>
                  {builtin && <span className="agent-builtin-tag">{zh ? "内置" : "built-in"}</span>}
                </div>
                <span className="agent-mode-badge">
                  {MODE_LABELS[agent.mode]}
                </span>
              </div>
              <div className="market-skill-desc">
                {agent.description || agent.prompt.substring(0, 60) + "..."}
              </div>
              <div className="market-skill-card-footer">
                <div className="market-skill-meta">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(agent); }}
                    className="market-skill-link-btn"
                  >
                    {zh ? "编辑" : "Edit"}
                  </button>
                  {!builtin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(agent.id); }}
                      className="market-skill-link-btn agent-delete-btn"
                    >
                      {zh ? "删除" : "Del"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail view (read-only, when not editing) */}
      {!editing && selected && (
        <div className="agent-card">
          <div className="agent-card-title">
            {selected.name} <span className="agent-detail-id">({selected.id})</span>
          </div>
          <DetailRow label={zh ? "描述" : "Description"} value={selected.description} />
          <DetailRow label={zh ? "模式" : "Mode"} value={MODE_LABELS[selected.mode]} />
          <DetailRow label={zh ? "协作模式" : "Collaboration"} value={selected.collaborationMode === "plan" ? (zh ? "规划模式 (只读)" : "Plan (read-only)") : (zh ? "默认模式" : "Default")} />
          <DetailRow label={zh ? "模型槽位" : "Model Slot"} value={selected.modelSlot ? SLOT_LABELS[selected.modelSlot] : "-"} />
          <DetailRow label={zh ? "最大步数" : "Max Steps"} value={String(selected.maxSteps ?? "-")} />
          <DetailRow label={zh ? "可生成子智能体" : "Can Spawn"} value={selected.canSpawnSubagents ? (zh ? "是" : "Yes") : (zh ? "否" : "No")} />
          <DetailRow label={zh ? "工具白名单" : "Tool Allowlist"} value={selected.toolAllowlist && selected.toolAllowlist.length > 0 ? selected.toolAllowlist.map(t => REQUIRED_TOOLS.includes(t) ? `${t}🔒` : t).join(", ") : (zh ? "全部工具" : "All tools")} />
          <DetailRow label={zh ? "上下文模式" : "Context Mode"} value={selected.contextMode === "fork" ? (zh ? "隔离 (fork)" : "Fork (isolated)") : (zh ? "内联 (inline)" : "Inline")} />
          {selected.model && <DetailRow label={zh ? "模型覆盖" : "Model Override"} value={selected.model} />}
          {selected.temperature !== undefined && <DetailRow label={zh ? "温度" : "Temperature"} value={String(selected.temperature)} />}
          {selected.maxTokens !== undefined && <DetailRow label={zh ? "最大 Token" : "Max Tokens"} value={String(selected.maxTokens)} />}
          {selected.reasoningEffort && <DetailRow label={zh ? "推理强度" : "Reasoning Effort"} value={selected.reasoningEffort} />}

          {/* Permissions */}
          <div className="agent-section-title">{zh ? "权限规则" : "Permissions"}</div>
          {selected.permissions.map((p, i) => (
            <div key={i} className="agent-perm-row">
              {p.tool} {p.resource && `→ ${p.resource}`} <span className={`agent-perm-action is-${p.action}`}>[{p.action}]</span>
            </div>
          ))}

          {/* Prompt preview */}
          <div className="agent-section-title">{zh ? "系统提示词" : "System Prompt"}</div>
          <pre className="agent-prompt">
            {selected.prompt}
          </pre>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div ref={editorRef} className="agent-card agent-card--editing">
          <div className="agent-card-title agent-card-title--tight">
            {isNew ? (zh ? "新建智能体" : "New Agent") : (zh ? "编辑智能体" : "Edit Agent")}
          </div>

          {/* Basic info */}
          <div className="agent-form-grid2">
            <div>
              <label className="agent-label">{zh ? "名称" : "Name"}</label>
              <input className="agent-input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="My Agent" />
            </div>
            <div>
              <label className="agent-label">{zh ? "ID (只读)" : "ID (read-only)"}</label>
              <input className="agent-input agent-input--dim" value={editing.id} readOnly />
            </div>
          </div>

          <div>
            <label className="agent-label">{zh ? "描述" : "Description"}</label>
            <input className="agent-input" value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder={zh ? "智能体用途描述" : "What this agent does"} />
          </div>

          <div className="agent-form-grid3">
            <div>
              <label className="agent-label">{zh ? "模式" : "Mode"}</label>
              <select className="agent-input" value={editing.mode} onChange={e => setEditing({ ...editing, mode: e.target.value as AgentMode })}>
                <option value="primary">{zh ? "主智能体" : "Primary"}</option>
                <option value="subagent">{zh ? "子智能体" : "Sub-agent"}</option>
                <option value="all">{zh ? "通用" : "All"}</option>
              </select>
            </div>
            <div>
              <label className="agent-label">{zh ? "协作模式" : "Collaboration"}</label>
              <select className="agent-input" value={editing.collaborationMode || "default"} onChange={e => setEditing({ ...editing, collaborationMode: e.target.value as CollaborationMode })}>
                <option value="default">{zh ? "默认（自主执行）" : "Default (autonomous)"}</option>
                <option value="plan">{zh ? "规划（只读分析）" : "Plan (read-only)"}</option>
              </select>
            </div>
            <div>
              <label className="agent-label">{zh ? "模型槽位" : "Model Slot"}</label>
              <select className="agent-input" value={editing.modelSlot || "subagent"} onChange={e => setEditing({ ...editing, modelSlot: e.target.value as TaskSlot })}>
                {Object.entries(SLOT_LABELS).map(([slot, label]) => (
                  <option key={slot} value={slot}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="agent-form-grid3">
            <div>
              <label className="agent-label">{zh ? "最大步数" : "Max Steps"}</label>
              <input type="number" min={1} max={100} className="agent-input" value={editing.maxSteps ?? 10} onChange={e => setEditing({ ...editing, maxSteps: parseInt(e.target.value) || 10 })} />
            </div>
            <div>
              <label className="agent-label">{zh ? "最大 Token" : "Max Tokens"}</label>
              <input type="number" min={0} className="agent-input" value={editing.maxTokens ?? ""} onChange={e => setEditing({ ...editing, maxTokens: e.target.value ? parseInt(e.target.value) : undefined })} />
            </div>
            <div>
              <label className="agent-label">{zh ? "温度" : "Temperature"}</label>
              <input type="number" min={0} max={2} step={0.1} className="agent-input" value={editing.temperature ?? ""} onChange={e => setEditing({ ...editing, temperature: e.target.value ? parseFloat(e.target.value) : undefined })} />
            </div>
          </div>

          <div className="agent-form-grid2">
            <div>
              <label className="agent-label">{zh ? "推理强度" : "Reasoning Effort"}</label>
              <select className="agent-input" value={editing.reasoningEffort || ""} onChange={e => setEditing({ ...editing, reasoningEffort: (e.target.value || undefined) as "low" | "medium" | "high" | undefined })}>
                <option value="">{zh ? "默认" : "Default"}</option>
                <option value="low">{zh ? "低" : "Low"}</option>
                <option value="medium">{zh ? "中" : "Medium"}</option>
                <option value="high">{zh ? "高" : "High"}</option>
              </select>
            </div>
            <div>
              <label className="agent-label">{zh ? "上下文模式" : "Context Mode"}</label>
              <select className="agent-input" value={editing.contextMode || "inline"} onChange={e => setEditing({ ...editing, contextMode: e.target.value as "inline" | "fork" })}>
                <option value="inline">{zh ? "内联（共享上下文）" : "Inline (shared)"}</option>
                <option value="fork">{zh ? "隔离（独立上下文）" : "Fork (isolated)"}</option>
              </select>
            </div>
          </div>

          <div className="agent-checks">
            <label className="agent-check-label">
              <input type="checkbox" checked={editing.canSpawnSubagents ?? false} onChange={e => setEditing({ ...editing, canSpawnSubagents: e.target.checked })} />
              {zh ? "可生成子智能体" : "Can spawn sub-agents"}
            </label>
            <label className="agent-check-label">
              <input type="checkbox" checked={editing.mode === "primary"} onChange={e => setEditing({ ...editing, mode: e.target.checked ? "primary" : "subagent" })} />
              {zh ? "Squad Leader 适配" : "Squad Leader compatible"}
            </label>
            {(editing.canSpawnSubagents || editing.mode === "primary") && (
              <span className="agent-check-hint">
                {zh ? "此 agent 可作为 Squad Leader 使用（任务管理 → Squads）" : "This agent can be used as a Squad Leader (Task Center → Squads)"}
              </span>
            )}
          </div>

          {/* Tool allowlist — checkbox grid with required tools locked */}
          <div>
            <label className="agent-label">{zh ? "工具权限" : "Tool Permissions"}</label>
            <div className="agent-tool-grid">
              {BUILTIN_TOOL_NAMES.map((toolName) => {
                const isRequired = REQUIRED_TOOLS.includes(toolName);
                const currentAllowlist = editing.toolAllowlist || [];
                const isChecked = isRequired || currentAllowlist.includes(toolName);
                return (
                  <label
                    key={toolName}
                    className={`agent-tool-item${isRequired ? " is-locked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={isRequired}
                      onChange={(e) => {
                        const current = new Set(currentAllowlist);
                        if (e.target.checked) {
                          current.add(toolName);
                        } else {
                          current.delete(toolName);
                        }
                        const newAllowlist = Array.from(current);
                        setEditing({
                          ...editing,
                          toolAllowlist: newAllowlist.length > 0 ? newAllowlist : undefined,
                        });
                      }}
                    />
                    <span className={`agent-tool-name${isRequired ? " is-required" : ""}`}>
                      {toolName}
                      {isRequired && <span className="agent-tool-lock">🔒</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="agent-tool-hint">
              {zh ? "🔒 标记的工具为必选工具，不可取消。留空=全部工具权限。外部技能加载的工具也会自动可用。" : "🔒 Required tools cannot be unchecked. Empty = all tools. Skill tools are auto-available."}
            </div>
          </div>

          {/* System prompt */}
          <div>
            <label className="agent-label">{zh ? "系统提示词 (中文)" : "System Prompt (Chinese)"}</label>
            <textarea className="agent-input agent-input--prompt" value={editing.prompt} onChange={e => setEditing({ ...editing, prompt: e.target.value })} />
          </div>
          <div>
            <label className="agent-label">{zh ? "系统提示词 (英文, 可选)" : "System Prompt (English, optional)"}</label>
            <textarea className="agent-input agent-input--prompt-sm" value={editing.promptEn || ""} onChange={e => setEditing({ ...editing, promptEn: e.target.value || undefined })} />
          </div>

          {/* Permissions editor */}
          <div>
            <label className="agent-label">{zh ? "权限规则" : "Permission Rules"}</label>
            <div className="agent-perm-list">
              {(editing.permissions || []).map((p, i) => (
                <div key={i} className="agent-perm-edit-row">
                  <input className="agent-input agent-input--w2 agent-input--mono" value={p.tool} onChange={e => {
                    const perms = [...(editing.permissions || [])];
                    perms[i] = { ...perms[i], tool: e.target.value };
                    setEditing({ ...editing, permissions: perms });
                  }} placeholder="bash / write / *" />
                  <input className="agent-input agent-input--w2 agent-input--mono" value={p.resource || ""} onChange={e => {
                    const perms = [...(editing.permissions || [])];
                    perms[i] = { ...perms[i], resource: e.target.value || undefined };
                    setEditing({ ...editing, permissions: perms });
                  }} placeholder="rm -rf* / **/.env" />
                  <select className="agent-input agent-input--w1" value={p.action} onChange={e => {
                    const perms = [...(editing.permissions || [])];
                    perms[i] = { ...perms[i], action: e.target.value as "allow" | "deny" | "ask" };
                    setEditing({ ...editing, permissions: perms });
                  }}>
                    <option value="allow">{zh ? "允许" : "Allow"}</option>
                    <option value="deny">{zh ? "禁止" : "Deny"}</option>
                    <option value="ask">{zh ? "询问" : "Ask"}</option>
                  </select>
                  <button onClick={() => {
                    const perms = (editing.permissions || []).filter((_, idx) => idx !== i);
                    setEditing({ ...editing, permissions: perms });
                  }} className="agent-perm-remove"><CloseIcon size={14} /></button>
                </div>
              ))}
              <button onClick={() => setEditing({ ...editing, permissions: [...(editing.permissions || []), { tool: "*", action: "ask" }] })} className="agent-add-rule-btn">+ {zh ? "添加规则" : "Add Rule"}</button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="agent-editor-actions">
            <button onClick={handleSave} disabled={!editing.name.trim()} className="panel-btn panel-btn--primary">{zh ? "保存" : "Save"}</button>
            <button onClick={handleCancel} className="panel-btn">{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}

      {/* End of scrollable container */}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="agent-detail-row">
      <span className="agent-detail-label">{label}:</span>
      <span className="agent-detail-value">{value}</span>
    </div>
  );
}
