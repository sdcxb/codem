/**
 * TeamTab — 「团队」Tab（B 深合并：模板 + 运行时活动同视图）
 *
 * 上部：团队模板（原 Squad）管理——模板是 agent-teams 运行时团队的角色蓝图，
 *       可经 squad_dispatch 工具（LLM 对话）实例化为运行时团队。
 * 下部：当前会话的运行时团队活动（agent-teams，复用 AgentTeamsPanel 视图；
 *       展示成员状态/任务/邮箱进度，随 AgentTeamsService 变化自动刷新）。
 */
import { useState } from "react";
import { Users, Boxes, ChevronDown, ChevronRight } from "lucide-react";
import { useLang } from "../../core/i18n/lang";
import { SquadsTab } from "./SquadsTab";
import { AgentTeamsPanel } from "../AgentTeamsPanel";

export function TeamTab() {
  const zh = useLang() === "zh";
  const [showRuntime, setShowRuntime] = useState(true);

  return (
    <div style={{ display: "grid", gap: 14, padding: 14, maxWidth: 900 }}>
      {/* 说明条 */}
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.7, background: "var(--bg-secondary, #1c212b)", border: "1px solid var(--border-primary, rgba(0,0,0,.1))", borderRadius: 8, padding: "8px 12px" }}>
        {zh
          ? "「团队」= 团队模板 + 运行时团队（agent-teams）：在下方用模板建好角色集（队长/成员+职责），然后在对话中对助手说“用 <模板名> 建个团队做 X”，或让模型调用 squad_dispatch / agent_teams_* 工具，即可把模板实例化为运行时团队（确定性调度、成员按角色领取任务）。运行时活动见下方面板。"
          : "\"Teams\" = templates + running agent-teams teams: define role sets below, then ask the assistant to \"use <template> to create a team for X\" (or the model calls squad_dispatch / agent_teams_*) to instantiate a running team. Live activity is below."}
      </div>

      {/* 运行时团队活动（agent-teams） */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }} onClick={() => setShowRuntime((s) => !s)}>
          {showRuntime ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <Boxes size={15} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "var(--fs-md)" }}>{zh ? "运行时团队（agent-teams）" : "Running teams (agent-teams)"}</strong>
        </div>
        {showRuntime && (
          <div style={{ border: "1px solid var(--border-primary, rgba(0,0,0,.12))", borderRadius: 10, overflow: "hidden", minHeight: 160 }}>
            <AgentTeamsPanel onClose={() => setShowRuntime(false)} />
          </div>
        )}
      </section>

      {/* 团队模板（原 Squad）管理 */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={15} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "var(--fs-md)" }}>{zh ? "团队模板（Squad → 实例化为运行时团队）" : "Team templates (Squad → instantiate)"}</strong>
        </div>
        <SquadsTab />
      </section>
    </div>
  );
}
