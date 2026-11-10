/**
 * TeamTab — 「团队」Tab（B 深合并：模板 + 运行时活动同视图）
 *
 * 上部：团队模板（原 Squad）管理——模板是 agent-teams 运行时团队的角色蓝图，
 *       可经 squad_dispatch 工具（LLM 对话）实例化为运行时团队。
 * 下部：当前会话的运行时团队活动（agent-teams，复用 AgentTeamsPanel 视图；
 *       展示成员状态/任务/邮箱进度，随 AgentTeamsService 变化自动刷新）。
 */
import { useEffect, useMemo, useState } from "react";
import { Users, Boxes, ChevronDown, ChevronRight } from "lucide-react";
import { useLang } from "../../core/i18n/lang";
import { SquadsTab } from "./SquadsTab";
import { AgentTeamsPanel } from "../AgentTeamsPanel";
import { AgentTeamsService } from "../../core/provider/agent-teams-service";
import { readTeamMemoryPreview, rememberTeamMemory } from "../../core/memory/team-memory";

export function TeamTab() {
  const zh = useLang() === "zh";
  const [showRuntime, setShowRuntime] = useState(true);

  return (
    <div style={{ display: "grid", gap: 14, padding: 14, maxWidth: 900 }}>
      {/* 说明条 */}
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.7, background: "var(--bg-secondary, #1c212b)", border: "1px solid var(--border-primary, rgba(0,0,0,.1))", borderRadius: "var(--radius)", padding: "8px 12px" }}>
        {zh
          ? "「团队」= 团队模板 + 运行时团队（agent-teams）：在下方用模板建好角色集（队长/成员+职责），然后在对话中对助手说“用 <模板名> 建个团队做 X”，或让模型调用 squad_dispatch / agent_teams_* 工具，即可把模板实例化为运行时团队（确定性调度、成员按角色领取任务）。运行时活动见下方面板。"
          : "\"Teams\" = templates + running agent-teams teams: define role sets below, then ask the assistant to \"use <template> to create a team for X\" (or the model calls squad_dispatch / agent_teams_*) to instantiate a running team. Live activity is below."}
      </div>

      {/* 运行时团队活动（agent-teams） */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }} onClick={() => setShowRuntime((s) => !s)}>
          {showRuntime ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Boxes size={14} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "var(--fs-md)" }}>{zh ? "运行时团队（agent-teams）" : "Running teams (agent-teams)"}</strong>
        </div>
        {showRuntime && (
          <div style={{ border: "1px solid var(--border-primary, rgba(0,0,0,.12))", borderRadius: "var(--radius-md)", overflow: "hidden", minHeight: 160 }}>
            <AgentTeamsPanel onClose={() => setShowRuntime(false)} />
          </div>
        )}
      </section>


      {/* 团队模板（原 Squad）管理 */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={14} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "var(--fs-md)" }}>{zh ? "团队模板（Squad → 实例化为运行时团队）" : "Team templates (Squad → instantiate)"}</strong>
        </div>
        <SquadsTab />
      </section>
      <TeamMemoryPanel zh={zh} />
    </div>
  );
}

/**
 * 团队记忆（25:668）：直接长在现有 agent-teams 团队上，没有 Bot 身份/群绑定。
 *
 * 读：团队内任何成员会话由 `resolveTeamIdForSession` 自动拿到 team scope；
 * 写：只在这里由用户显式提交，模型没有管理工具。
 */
function TeamMemoryPanel({ zh }: { zh: boolean }) {
  const [teams, setTeams] = useState(() => AgentTeamsService.getInstance().listAll());
  const [teamId, setTeamId] = useState(() => teams[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = useMemo(() => teams.find((team) => team.id === teamId), [teams, teamId]);

  useEffect(() => {
    const next = AgentTeamsService.getInstance().listAll();
    setTeams(next);
    setTeamId((current) => (next.some((team) => team.id === current) ? current : (next[0]?.id ?? "")));
  }, []);

  useEffect(() => {
    setPreview(teamId ? readTeamMemoryPreview(teamId) : "");
  }, [teamId]);

  const save = async () => {
    if (!teamId) {
      setFeedback(zh ? "先选一个运行时团队" : "Pick a running team first");
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const result = rememberTeamMemory({ teamId, key, content });
      if (!result.ok) {
        setFeedback(result.message);
        return;
      }
      setFeedback(zh ? "已写入团队记忆（团队内所有成员会话可见）" : "Saved. Visible to all member sessions in this team.");
      setKey("");
      setContent("");
      setPreview(readTeamMemoryPreview(teamId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="team-memory-panel" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: "var(--fs-md)" }}>{zh ? "团队记忆（跨会话共享）" : "Team memory (shared)"}</strong>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          {zh ? "存在现有 AgentTeam 上；成员会话自动注入，不需要升级 Bot" : "Stored on the existing AgentTeam; member sessions inject it automatically."}
        </span>
      </div>
      {teams.length === 0 ? (
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }} data-testid="team-memory-empty">
          {zh ? "还没有运行时团队。先在对话里用 agent_teams_create / squad_dispatch 建队并加成员。" : "No running team yet."}
        </div>
      ) : (
        <>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--fs-sm)" }}>
            {zh ? "团队：" : "Team:"}
            <select data-testid="team-memory-team-select" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {teams.map((team) => (
                <option value={team.id} key={team.id}>{team.name}</option>
              ))}
            </select>
            {selected && <span style={{ color: "var(--text-muted)" }}>{selected.members.length} {zh ? "名成员" : "members"}</span>}
          </label>
          <textarea
            data-testid="team-memory-preview"
            readOnly
            value={preview || (zh ? "（这个团队还没有团队记忆）" : "(no team memory yet)")}
            rows={4}
            style={{ width: "100%", resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}
          />
          <label style={{ display: "grid", gap: 4, fontSize: "var(--fs-sm)" }}>
            {zh ? "键（短标识）" : "Key"}
            <input data-testid="team-memory-key" value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: "var(--fs-sm)" }}>
            {zh ? "内容" : "Content"}
            <textarea data-testid="team-memory-content" value={content} onChange={(event) => setContent(event.target.value)} rows={3} />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" data-testid="team-memory-save" disabled={busy || !key.trim() || !content.trim()} onClick={() => void save()}>
              {zh ? "写入团队记忆" : "Save team memory"}
            </button>
            {feedback && <span data-testid="team-memory-feedback" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{feedback}</span>}
          </div>
        </>
      )}
    </section>
  );
}
