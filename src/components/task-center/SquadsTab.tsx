/**
 * SquadsTab — Squad 配置和管理 Tab
 *
 * 展示所有 Squad，支持创建/编辑/归档。
 * 使用 lucide-react 图标，不用 emoji。
 *
 * 样式：第 15 波把内联样式收口成 `.squads-*` 具名类（见 src/styles/task-center.css）。
 */

import { useState, useEffect, useCallback } from "react";
import { Users, Plus, Trash2, Archive, ArchiveRestore, Crown, User, ChevronRight, Bot } from "lucide-react";
import { getSquadManager, type SquadWithMembers } from "../../core/squad";
import { getAgentRegistry, type AgentDefinition } from "../../core/agent/agent";
import { useLang } from "../../core/i18n/lang";
import { useCurrentProjectId } from "./use-current-project";
import { useDomainReady } from "../../hooks/use-domain-ready";

export function SquadsTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [squads, setSquads] = useState<SquadWithMembers[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState<Partial<{ name: string; leaderAgentId: string; instructions: string }> | null>(null);
  const [selectedSquad, setSelectedSquad] = useState<string | null>(null);
  /**
   * 显示已归档（第 44 轮）。
   *
   * 归档是 UI 上唯一的"移除"入口，而它原来是**不可逆且看不见**的：写 `archived = 1`、
   * 读路径全过滤掉归档行 → 误点一次就等于永久删除（数据还在库里，界面上再也看不到）。
   * 存储层已经有 `unarchive` 与 `includeArchived`，这里把它接到界面上：
   * 打开开关就能看到归档过的 Squad，并逐个"恢复"。
   */
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 当前项目进依赖：切换项目必须重查（对齐 Issues/看板/收件箱的 P2-12 项目边界约定）
  const projectId = useCurrentProjectId();

  const loadSquads = useCallback(() => {
    const mgr = getSquadManager();
    setSquads(mgr.listSquads(projectId ?? undefined, { includeArchived: showArchived }));
    setAgents(getAgentRegistry().getAll());
  }, [projectId, showArchived]);

  useEffect(() => {
    loadSquads();
    const mgr = getSquadManager();
    const unsub = mgr.onSquadChange(() => loadSquads());
    return () => { unsub(); };
  }, [loadSquads]);

  // 第 72 轮审计：镜像晚就绪时自己补一次（团队/成员两张表都不在首屏预取清单里）
  useDomainReady(["squads", "squad_members"], loadSquads);

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
    // 如实告诉用户"它去哪了、怎么找回来" —— 原来这里什么都没有，于是"归档"看起来像删除
    setNotice(zh ? "已归档。可用右上角「显示已归档」找回。" : "Archived. Use “Show archived” to restore it.");
  };

  /** 取消归档（恢复）。失败必须如实提示，不能假装成功。 */
  const handleUnarchive = (id: string) => {
    const ok = getSquadManager().unarchiveSquad(id);
    setNotice(
      ok
        ? zh ? "已恢复。" : "Restored."
        : zh ? "恢复失败：写入未被接受，请稍后重试。" : "Restore failed: the write was not accepted. Try again.",
    );
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
        <div className="squads-header-actions">
          <label className="squads-archived-toggle" title={zh ? "归档过的 Squad 默认不显示，但一直还在库里" : "Archived squads are hidden but still in the database"}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {zh ? "显示已归档" : "Show archived"}
          </label>
          <button
            onClick={() => setEditing({ name: "", leaderAgentId: "", instructions: "" })}
            className="squads-new-btn"
          >
            <Plus size={14} /> {zh ? "新建 Squad" : "New Squad"}
          </button>
        </div>
      </div>

      {/* 归档/恢复的结果提示：这两件事必须对用户可见（归档原来像删除，恢复原来不存在） */}
      {notice && (
        <div className="tc-empty squads-notice" onClick={() => setNotice(null)} role="status">
          {notice}
        </div>
      )}

      {/* Squad list */}
      {squads.length === 0 && !editing && (
        <div className="tc-empty">
          {zh
            ? showArchived
              ? "没有 Squad（含已归档）。"
              : "暂无 Squad。点击上方按钮创建第一个 Squad。"
            : showArchived
              ? "No squads (including archived)."
              : "No squads yet. Click above to create one."}
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
              {squad.archived === true && (
                <span className="squads-count-badge">{zh ? "已归档" : "archived"}</span>
              )}
              <span className="squads-card-actions">
                {squad.archived === true ? (
                  // 已归档的行只给"恢复"—— 归档才是 UI 上唯一的移除入口，误点必须能撤销
                  <button
                    onClick={(e) => { e.stopPropagation(); handleUnarchive(squad.id); }}
                    className="squads-icon-btn"
                    title={zh ? "恢复（取消归档）" : "Restore (unarchive)"}
                  >
                    <ArchiveRestore size={14} />
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleArchive(squad.id); }}
                    className="squads-icon-btn"
                    title={zh ? "归档（可在「显示已归档」里恢复）" : "Archive (restore via “Show archived”)"}
                  >
                    <Archive size={14} />
                  </button>
                )}
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
          aria-label="移除该成员"
                        title="移除该成员"
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
