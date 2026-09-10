/**
 * SquadsTab — Squad 配置和管理 Tab
 *
 * 展示所有 Squad，支持创建/编辑/归档。
 * 使用 lucide-react 图标，不用 emoji。
 *
 * 样式：第 15 波把内联样式收口成 `.squads-*` 具名类（见 src/styles/task-center.css）。
 */

import { useState, useEffect, useCallback } from "react";
import { Users, Plus, Trash2, Archive, Crown, User, ChevronRight, Bot } from "lucide-react";
import { getSquadManager, type SquadWithMembers } from "../../core/squad";
import { getAgentRegistry, type AgentDefinition } from "../../core/agent/agent";
import { useLang } from "../../core/i18n/lang";
import { useCurrentProjectId } from "./use-current-project";

export function SquadsTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [squads, setSquads] = useState<SquadWithMembers[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState<Partial<{ name: string; leaderAgentId: string; instructions: string }> | null>(null);
  const [selectedSquad, setSelectedSquad] = useState<string | null>(null);
  // 当前项目进依赖：切换项目必须重查（对齐 Issues/看板/收件箱的 P2-12 项目边界约定）
  const projectId = useCurrentProjectId();

  const loadSquads = useCallback(() => {
    const mgr = getSquadManager();
    setSquads(mgr.listSquads(projectId ?? undefined));
    setAgents(getAgentRegistry().getAll());
  }, [projectId]);

  useEffect(() => {
    loadSquads();
    const mgr = getSquadManager();
    const unsub = mgr.onSquadChange(() => loadSquads());
    return () => { unsub(); };
  }, [loadSquads]);

  const handleCreate = () => {
    if (!editing || !editing.name || !editing.leaderAgentId) return;
    const mgr = getSquadManager();
    mgr.createSquad({
      name: editing.name,
      leaderAgentId: editing.leaderAgentId,
      instructions: editing.instructions,
      projectId: projectId ?? undefined,
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
    <div className="tc-tab">
      {/* Header */}
      <div className="squads-header">
        <div className="squads-header-title">
          <Users size={16} />
          <span className="squads-title">
            {zh ? "Squads" : "Squads"} ({squads.length})
          </span>
        </div>
        <button
          onClick={() => setEditing({ name: "", leaderAgentId: "", instructions: "" })}
          className="squads-new-btn"
        >
          <Plus size={14} /> {zh ? "新建 Squad" : "New Squad"}
        </button>
      </div>

      {/* Squad list */}
      {squads.length === 0 && !editing && (
        <div className="tc-empty">
          {zh ? "暂无 Squad。点击上方按钮创建第一个 Squad。" : "No squads yet. Click above to create one."}
        </div>
      )}

      <div className="squads-list">
        {squads.map((squad) => (
          <div key={squad.id} className="squads-card">
            <div
              className="squads-card-head"
              onClick={() => setSelectedSquad(selectedSquad === squad.id ? null : squad.id)}
            >
              <Users size={14} />
              <span className="squads-name">{squad.name}</span>
              <span className="squads-count-badge">
                {squad.members.length} {zh ? "成员" : "members"}
              </span>
              <span className="squads-card-actions">
                <button
                  onClick={(e) => { e.stopPropagation(); handleArchive(squad.id); }}
                  className="squads-icon-btn"
                  title={zh ? "归档" : "Archive"}
                >
                  <Archive size={14} />
                </button>
                <ChevronRight
                  size={14}
                  className={`squads-chevron${selectedSquad === squad.id ? " is-open" : ""}`}
                />
              </span>
            </div>

            {/* Leader info */}
            <div className="squads-leader">
              <Crown size={12} />
              <span>{zh ? "Leader:" : "Leader:"}</span>
              <span className="squads-leader-name">{squad.leader?.name || squad.leaderAgentId}</span>
            </div>

            {/* Expanded detail */}
            {selectedSquad === squad.id && (
              <div className="squads-detail">
                {/* Instructions */}
                {squad.instructions && (
                  <div className="squads-instructions">
                    {squad.instructions}
                  </div>
                )}

                {/* Members */}
                <div className="squads-members-title">
                  {zh ? "成员列表" : "Members"}
                </div>
                {squad.members.map((m) => (
                  <div key={m.id} className="squads-member">
                    {m.memberType === "agent" ? <Bot size={12} /> : <User size={12} />}
                    <span className="squads-member-name">{m.memberName}</span>
                    {m.id !== squad.members[0]?.id && (
                      <span className="squads-member-role">{m.roleDescription}</span>
                    )}
                    {m.id === squad.members[0]?.id && (
                      <span className="squads-member-leader-badge">
                        {zh ? "Leader" : "Leader"}
                      </span>
                    )}
                    {m.id !== squad.members[0]?.id && (
                      <button
                        onClick={() => handleRemoveMember(m.id, squad.id)}
                        className="squads-member-remove"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Add member dropdown */}
                <select
                  onChange={(e) => { if (e.target.value) { handleAddMember(squad.id, e.target.value); e.target.value = ""; } }}
                  className="tc-field tc-field--add"
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
        <div className="tc-editor">
          <div className="tc-editor-title">
            {zh ? "新建 Squad" : "Create Squad"}
          </div>
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "名称" : "Name"}</label>
            <input
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="tc-field"
              placeholder={zh ? "如: 产品交付 Squad" : "e.g. Product Delivery"}
            />
          </div>
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "Leader Agent" : "Leader Agent"}</label>
            <select
              value={editing.leaderAgentId || ""}
              onChange={(e) => setEditing({ ...editing, leaderAgentId: e.target.value })}
              className="tc-field"
            >
              <option value="" disabled>{zh ? "选择 Leader..." : "Select leader..."}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.description})</option>
              ))}
            </select>
          </div>
          <div className="tc-field-row">
            <label className="tc-label">{zh ? "Squad 指令" : "Instructions"}</label>
            <textarea
              value={editing.instructions || ""}
              onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
              className="tc-field tc-field--area"
              placeholder={zh ? "路由规则、协作规范等..." : "Routing rules, collaboration norms..."}
            />
          </div>
          <div className="tc-editor-actions">
            <button
              onClick={handleCreate}
              disabled={!editing.name || !editing.leaderAgentId}
              className="tc-btn tc-btn--primary"
            >
              {zh ? "创建" : "Create"}
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
