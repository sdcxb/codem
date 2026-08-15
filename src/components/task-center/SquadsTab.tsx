/**
 * SquadsTab — Squad 配置和管理 Tab
 *
 * 展示所有 Squad，支持创建/编辑/归档。
 * 使用 lucide-react 图标，不用 emoji。
 */

import { useState, useEffect, useCallback } from "react";
import { Users, Plus, Trash2, Archive, Crown, User, ChevronRight, Bot } from "lucide-react";
import { getSquadManager, type SquadWithMembers } from "../../core/squad";
import { getAgentRegistry, type AgentDefinition } from "../../core/agent/agent";
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";

export function SquadsTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [squads, setSquads] = useState<SquadWithMembers[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState<Partial<{ name: string; leaderAgentId: string; instructions: string }> | null>(null);
  const [selectedSquad, setSelectedSquad] = useState<string | null>(null);

  const loadSquads = useCallback(() => {
    const mgr = getSquadManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    setSquads(mgr.listSquads(projectId));
    setAgents(getAgentRegistry().getAll());
  }, []);

  useEffect(() => {
    loadSquads();
    const mgr = getSquadManager();
    const unsub = mgr.onSquadChange(() => loadSquads());
    return () => { unsub(); };
  }, [loadSquads]);

  const handleCreate = () => {
    if (!editing || !editing.name || !editing.leaderAgentId) return;
    const mgr = getSquadManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    mgr.createSquad({
      name: editing.name,
      leaderAgentId: editing.leaderAgentId,
      instructions: editing.instructions,
      projectId,
    });
    setEditing(null);
    loadSquads();
  };

  const handleArchive = (id: string) => {
    getSquadManager().archiveSquad(id);
    if (selectedSquad === id) setSelectedSquad(null);
    loadSquads();
  };

  const handleAddMember = (squadId: string, agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    getSquadManager().addMember(squadId, {
      memberType: "agent",
      memberId: agentId,
      memberName: agent.name,
      roleDescription: agent.description,
    });
    loadSquads();
  };

  const handleRemoveMember = (memberId: string, squadId: string) => {
    getSquadManager().removeMember(memberId, squadId);
    loadSquads();
  };

  const detailSquad = squads.find((s) => s.id === selectedSquad);

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Users size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            {zh ? "Squads" : "Squads"} ({squads.length})
          </span>
        </div>
        <button
          onClick={() => setEditing({ name: "", leaderAgentId: "", instructions: "" })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          <Plus size={14} /> {zh ? "新建 Squad" : "New Squad"}
        </button>
      </div>

      {/* Squad list */}
      {squads.length === 0 && !editing && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "14px" }}>
          {zh ? "暂无 Squad。点击上方按钮创建第一个 Squad。" : "No squads yet. Click above to create one."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {squads.map((squad) => (
          <div
            key={squad.id}
            style={{
              padding: "14px 16px",
              borderRadius: 8,
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
              onClick={() => setSelectedSquad(selectedSquad === squad.id ? null : squad.id)}
            >
              <Users size={14} style={{ color: "var(--text-secondary)" }} />
              <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{squad.name}</span>
              <span style={{
                fontSize: "10px",
                padding: "2px 8px",
                borderRadius: 3,
                background: "var(--accent)22",
                color: "var(--accent)",
              }}>
                {squad.members.length} {zh ? "成员" : "members"}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
                <button
                  onClick={(e) => { e.stopPropagation(); handleArchive(squad.id); }}
                  style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: "2px" }}
                  title={zh ? "归档" : "Archive"}
                >
                  <Archive size={14} />
                </button>
                <ChevronRight
                  size={14}
                  style={{ color: "var(--text-secondary)", transform: selectedSquad === squad.id ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}
                />
              </span>
            </div>

            {/* Leader info */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", fontSize: "12px", color: "var(--text-secondary)" }}>
              <Crown size={12} style={{ color: "var(--warning)" }} />
              <span>{zh ? "Leader:" : "Leader:"}</span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{squad.leader?.name || squad.leaderAgentId}</span>
            </div>

            {/* Expanded detail */}
            {selectedSquad === squad.id && (
              <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--border-primary)" }}>
                {/* Instructions */}
                {squad.instructions && (
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px", padding: "8px", background: "var(--bg-secondary)", borderRadius: 4 }}>
                    {squad.instructions}
                  </div>
                )}

                {/* Members */}
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
                  {zh ? "成员列表" : "Members"}
                </div>
                {squad.members.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", marginBottom: "4px", borderRadius: 4, background: "var(--bg-secondary)", fontSize: "12px" }}>
                    {m.memberType === "agent" ? <Bot size={12} style={{ color: "var(--text-secondary)" }} /> : <User size={12} style={{ color: "var(--text-secondary)" }} />}
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{m.memberName}</span>
                    {m.id !== squad.members[0]?.id && (
                      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{m.roleDescription}</span>
                    )}
                    {m.id === squad.members[0]?.id && (
                      <span style={{ fontSize: "9px", padding: "1px 6px", borderRadius: 3, background: "var(--warning)22", color: "var(--warning)" }}>
                        {zh ? "Leader" : "Leader"}
                      </span>
                    )}
                    {m.id !== squad.members[0]?.id && (
                      <button
                        onClick={() => handleRemoveMember(m.id, squad.id)}
                        style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--error)", cursor: "pointer", padding: "2px" }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Add member dropdown */}
                <select
                  onChange={(e) => { if (e.target.value) { handleAddMember(squad.id, e.target.value); e.target.value = ""; } }}
                  style={{ marginTop: "8px", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 12, width: "100%" }}
                  defaultValue=""
                >
                  <option value="" disabled>{zh ? "+ 添加成员..." : "+ Add member..."}</option>
                  {agents
                    .filter((a) => !squad.members.some((m) => m.memberId === a.id))
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.description})</option>
                    ))}
                </select>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create editor */}
      {editing && (
        <div style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 8,
          border: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--text-primary)" }}>
            {zh ? "新建 Squad" : "Create Squad"}
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, display: "block" }}>{zh ? "名称" : "Name"}</label>
            <input
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13, width: "100%" }}
              placeholder={zh ? "如: 产品交付 Squad" : "e.g. Product Delivery"}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, display: "block" }}>{zh ? "Leader Agent" : "Leader Agent"}</label>
            <select
              value={editing.leaderAgentId || ""}
              onChange={(e) => setEditing({ ...editing, leaderAgentId: e.target.value })}
              style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13, width: "100%" }}
            >
              <option value="" disabled>{zh ? "选择 Leader..." : "Select leader..."}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.description})</option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, display: "block" }}>{zh ? "Squad 指令" : "Instructions"}</label>
            <textarea
              value={editing.instructions || ""}
              onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
              style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13, width: "100%", minHeight: 60 }}
              placeholder={zh ? "路由规则、协作规范等..." : "Routing rules, collaboration norms..."}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleCreate}
              disabled={!editing.name || !editing.leaderAgentId}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 12,
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "#fff", cursor: "pointer", opacity: !editing.name || !editing.leaderAgentId ? 0.5 : 1,
              }}
            >
              {zh ? "创建" : "Create"}
            </button>
            <button
              onClick={() => setEditing(null)}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 12,
                border: "1px solid var(--border-primary)", background: "none",
                color: "var(--text-primary)", cursor: "pointer",
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
