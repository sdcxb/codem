import { useState, useEffect } from "react";
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
  "spawn_subagent",
  "wait_for_subagent",
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
  };

  const handleEdit = (agent: AgentDefinition) => {
    setEditing({ ...agent });
    setIsNew(false);
    setSelectedId(agent.id);
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

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 3, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 12, width: "100%",
    outline: "none",
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
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          {zh ? "查看、创建和编辑智能体定义。内置智能体不可编辑/删除。" : "View, create, and edit agent definitions. Built-in agents are read-only."}
        </div>
        <button
          onClick={handleNew}
          className="market-skill-link-btn"
          style={{ whiteSpace: "nowrap" }}
        >
          <AddIcon size={12} /> {zh ? "新建" : "New"}
        </button>
      </div>

      {/* Agent list + detail/edit form (scrollable) */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="skill-market-grid" style={{ overflow: "visible", flex: "none", padding: 0 }}>
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
                  {builtin && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{zh ? "内置" : "built-in"}</span>}
                </div>
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "var(--bg-secondary)", color: "var(--text-secondary)" }}>
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
                      className="market-skill-link-btn"
                      style={{ color: "var(--error)" }}
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
        <div style={{
          padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)", fontSize: 12,
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: "var(--text-primary)" }}>
            {selected.name} <span style={{ fontSize: 10, color: "var(--text-muted)" }}>({selected.id})</span>
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
          <div style={{ marginTop: 8, marginBottom: 4, fontWeight: 600, color: "var(--text-secondary)" }}>{zh ? "权限规则" : "Permissions"}</div>
          {selected.permissions.map((p, i) => (
            <div key={i} style={{ fontFamily: "monospace", fontSize: 11, padding: "3px 6px", background: "var(--bg-tertiary)", borderRadius: 3, marginBottom: 2 }}>
              {p.tool} {p.resource && `→ ${p.resource}`} <span style={{ color: p.action === "allow" ? "var(--success)" : p.action === "deny" ? "var(--error)" : "var(--text-secondary)" }}>[{p.action}]</span>
            </div>
          ))}

          {/* Prompt preview */}
          <div style={{ marginTop: 8, marginBottom: 4, fontWeight: 600, color: "var(--text-secondary)" }}>{zh ? "系统提示词" : "System Prompt"}</div>
          <pre style={{
            fontSize: 10, padding: 8, background: "var(--bg-tertiary)", borderRadius: 4,
            maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", margin: 0,
            color: "var(--text-secondary)",
          }}>
            {selected.prompt}
          </pre>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div style={{
          padding: 12, borderRadius: 8, border: "1px solid var(--accent)",
          background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)" }}>
            {isNew ? (zh ? "新建智能体" : "New Agent") : (zh ? "编辑智能体" : "Edit Agent")}
          </div>

          {/* Basic info */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>{zh ? "名称" : "Name"}</label>
              <input style={inputStyle} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="My Agent" />
            </div>
            <div>
              <label style={labelStyle}>{zh ? "ID (只读)" : "ID (read-only)"}</label>
              <input style={{ ...inputStyle, opacity: 0.6 }} value={editing.id} readOnly />
            </div>
          </div>

          <div>
            <label style={labelStyle}>{zh ? "描述" : "Description"}</label>
            <input style={inputStyle} value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder={zh ? "智能体用途描述" : "What this agent does"} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>{zh ? "模式" : "Mode"}</label>
              <select style={inputStyle} value={editing.mode} onChange={e => setEditing({ ...editing, mode: e.target.value as AgentMode })}>
                <option value="primary">{zh ? "主智能体" : "Primary"}</option>
                <option value="subagent">{zh ? "子智能体" : "Sub-agent"}</option>
                <option value="all">{zh ? "通用" : "All"}</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "协作模式" : "Collaboration"}</label>
              <select style={inputStyle} value={editing.collaborationMode || "default"} onChange={e => setEditing({ ...editing, collaborationMode: e.target.value as CollaborationMode })}>
                <option value="default">{zh ? "默认（自主执行）" : "Default (autonomous)"}</option>
                <option value="plan">{zh ? "规划（只读分析）" : "Plan (read-only)"}</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "模型槽位" : "Model Slot"}</label>
              <select style={inputStyle} value={editing.modelSlot || "subagent"} onChange={e => setEditing({ ...editing, modelSlot: e.target.value as TaskSlot })}>
                {Object.entries(SLOT_LABELS).map(([slot, label]) => (
                  <option key={slot} value={slot}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>{zh ? "最大步数" : "Max Steps"}</label>
              <input type="number" min={1} max={100} style={inputStyle} value={editing.maxSteps ?? 10} onChange={e => setEditing({ ...editing, maxSteps: parseInt(e.target.value) || 10 })} />
            </div>
            <div>
              <label style={labelStyle}>{zh ? "最大 Token" : "Max Tokens"}</label>
              <input type="number" min={0} style={inputStyle} value={editing.maxTokens ?? ""} onChange={e => setEditing({ ...editing, maxTokens: e.target.value ? parseInt(e.target.value) : undefined })} />
            </div>
            <div>
              <label style={labelStyle}>{zh ? "温度" : "Temperature"}</label>
              <input type="number" min={0} max={2} step={0.1} style={inputStyle} value={editing.temperature ?? ""} onChange={e => setEditing({ ...editing, temperature: e.target.value ? parseFloat(e.target.value) : undefined })} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>{zh ? "推理强度" : "Reasoning Effort"}</label>
              <select style={inputStyle} value={editing.reasoningEffort || ""} onChange={e => setEditing({ ...editing, reasoningEffort: (e.target.value || undefined) as "low" | "medium" | "high" | undefined })}>
                <option value="">{zh ? "默认" : "Default"}</option>
                <option value="low">{zh ? "低" : "Low"}</option>
                <option value="medium">{zh ? "中" : "Medium"}</option>
                <option value="high">{zh ? "高" : "High"}</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>{zh ? "上下文模式" : "Context Mode"}</label>
              <select style={inputStyle} value={editing.contextMode || "inline"} onChange={e => setEditing({ ...editing, contextMode: e.target.value as "inline" | "fork" })}>
                <option value="inline">{zh ? "内联（共享上下文）" : "Inline (shared)"}</option>
                <option value="fork">{zh ? "隔离（独立上下文）" : "Fork (isolated)"}</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
              <input type="checkbox" checked={editing.canSpawnSubagents ?? false} onChange={e => setEditing({ ...editing, canSpawnSubagents: e.target.checked })} />
              {zh ? "可生成子智能体" : "Can spawn sub-agents"}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
              <input type="checkbox" checked={editing.mode === "primary"} onChange={e => setEditing({ ...editing, mode: e.target.checked ? "primary" : "subagent" })} />
              {zh ? "Squad Leader 适配" : "Squad Leader compatible"}
            </label>
            {(editing.canSpawnSubagents || editing.mode === "primary") && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {zh ? "此 agent 可作为 Squad Leader 使用（任务管理 → Squads）" : "This agent can be used as a Squad Leader (Task Center → Squads)"}
              </span>
            )}
          </div>

          {/* Tool allowlist — checkbox grid with required tools locked */}
          <div>
            <label style={labelStyle}>{zh ? "工具权限" : "Tool Permissions"}</label>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
              gap: 4, marginTop: 4, padding: "8px 12px",
              background: "var(--bg-secondary)", borderRadius: 6,
              border: "1px solid var(--border-primary)",
            }}>
              {BUILTIN_TOOL_NAMES.map((toolName) => {
                const isRequired = REQUIRED_TOOLS.includes(toolName);
                const currentAllowlist = editing.toolAllowlist || [];
                const isChecked = isRequired || currentAllowlist.includes(toolName);
                return (
                  <label
                    key={toolName}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      cursor: isRequired ? "not-allowed" : "pointer",
                      fontSize: 12, opacity: isRequired ? 0.6 : 1,
                    }}
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
                    <span style={{
                      color: isRequired ? "var(--text-muted)" : "var(--text-primary)",
                      fontFamily: "monospace",
                    }}>
                      {toolName}
                      {isRequired && <span style={{ fontSize: 10, marginLeft: 2 }}>🔒</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              {zh ? "🔒 标记的工具为必选工具，不可取消。留空=全部工具权限。外部技能加载的工具也会自动可用。" : "🔒 Required tools cannot be unchecked. Empty = all tools. Skill tools are auto-available."}
            </div>
          </div>

          {/* System prompt */}
          <div>
            <label style={labelStyle}>{zh ? "系统提示词 (中文)" : "System Prompt (Chinese)"}</label>
            <textarea style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "monospace" }} value={editing.prompt} onChange={e => setEditing({ ...editing, prompt: e.target.value })} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "系统提示词 (英文, 可选)" : "System Prompt (English, optional)"}</label>
            <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: "monospace" }} value={editing.promptEn || ""} onChange={e => setEditing({ ...editing, promptEn: e.target.value || undefined })} />
          </div>

          {/* Permissions editor */}
          <div>
            <label style={labelStyle}>{zh ? "权限规则" : "Permission Rules"}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(editing.permissions || []).map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input style={{ ...inputStyle, flex: 2, fontFamily: "monospace" }} value={p.tool} onChange={e => {
                    const perms = [...(editing.permissions || [])];
                    perms[i] = { ...perms[i], tool: e.target.value };
                    setEditing({ ...editing, permissions: perms });
                  }} placeholder="bash / write / *" />
                  <input style={{ ...inputStyle, flex: 2, fontFamily: "monospace" }} value={p.resource || ""} onChange={e => {
                    const perms = [...(editing.permissions || [])];
                    perms[i] = { ...perms[i], resource: e.target.value || undefined };
                    setEditing({ ...editing, permissions: perms });
                  }} placeholder="rm -rf* / **/.env" />
                  <select style={{ ...inputStyle, flex: 1 }} value={p.action} onChange={e => {
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
                  }} style={{ display: "flex", alignItems: "center", padding: "4px 8px", border: "1px solid var(--border-primary)", background: "none", color: "var(--text-muted)", borderRadius: 4, cursor: "pointer" }}><CloseIcon size={14} /></button>
                </div>
              ))}
              <button onClick={() => setEditing({ ...editing, permissions: [...(editing.permissions || []), { tool: "*", action: "ask" }] })} style={{
                fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid var(--border-primary)",
                background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer", alignSelf: "flex-start",
              }}>+ {zh ? "添加规则" : "Add Rule"}</button>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={handleSave} disabled={!editing.name.trim()} style={{
              padding: "6px 16px", borderRadius: 4, fontSize: 12,
              border: "1px solid var(--accent)", background: "var(--accent)",
              color: "#fff", cursor: "pointer", opacity: editing.name.trim() ? 1 : 0.5,
            }}>{zh ? "保存" : "Save"}</button>
            <button onClick={handleCancel} style={{
              padding: "6px 16px", borderRadius: 4, fontSize: 12,
              border: "1px solid var(--border-primary)", background: "none",
              color: "var(--text-primary)", cursor: "pointer",
            }}>{zh ? "取消" : "Cancel"}</button>
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
    <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 90 }}>{label}:</span>
      <span style={{ fontSize: 11, color: "var(--text-primary)", flex: 1 }}>{value}</span>
    </div>
  );
}
