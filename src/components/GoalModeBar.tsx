/**
 * 长程目标模式状态条 + 计划/证据/决策面板（桌面）。
 *
 * ## 为什么不是「继续」按钮的变体
 *
 * 目标模式下**没有默认的每轮「继续」**（ADR-0006 §2.8）：阶段完成自动进入下一阶段，
 * 阶段内验收不过也会自动继续（A1）。用户能做的只有三件事：
 *
 * 1. 看进度（阶段 X/Y、当前阶段交付物、自动继续次数、重规划次数、用量）；
 * 2. 停止（立即暂停，可再继续；已完成阶段不会重跑）；
 * 3. 改目标（改意图 —— 只有用户能改契约；继续时会重新规划）；
 * 4. 取消目标（结束、不可继续 —— 暂停后没有这个出口就会一直挂在目标条上，真机 bug）。
 *
 * ## 数据来源
 *
 * 视图来自 `useGoalView(sessionId)`（存储投影，订阅刷新）；
 * 面板的明细来自 `getGoalDetails(sessionId)`（每次展开时现读，够用且不会把整份计划塞进全局状态）。
 */
import { useState } from "react";

import { useLang } from "../core/i18n/lang";
import {
  cancelSessionGoal,
  changeGoalContract,
  getGoalDetails,
  resumeSessionGoal,
  stopSessionGoal,
} from "../core/goal/runtime";
import {
  getGoalBudgetSetting,
  getGoalModeSetting,
  getGoalResumeOnOpen,
  setGoalBudgetSetting,
  setGoalModeSetting,
  setGoalResumeOnOpen,
} from "../core/goal/settings";
import { refreshGoalView } from "../core/goal/state";
import type { GoalView } from "../core/goal/types";
import { useGoalPlanning, useGoalView } from "./useGoalView";

const STATUS_LABEL: Record<GoalView["status"], { zh: string; en: string }> = {
  active: { zh: "目标执行中", en: "Goal running" },
  paused: { zh: "目标已暂停", en: "Goal paused" },
  blocked: { zh: "目标阻塞", en: "Goal blocked" },
  completed: { zh: "目标已完成", en: "Goal completed" },
  cancelled: { zh: "目标已取消", en: "Goal cancelled" },
};

function phaseIcon(status: string): string {
  if (status === "done") return "✅";
  if (status === "active") return "🔄";
  if (status === "blocked") return "⛔";
  return "⏳";
}

/** 设置区（与目标面板放一起：用户改目标模式设置时正看着目标，不需要去设置面板翻） */
function GoalModeSettings({ zh, onChange }: { zh: boolean; onChange: () => void }) {
  const [mode, setMode] = useState(getGoalModeSetting());
  const [resume, setResume] = useState(getGoalResumeOnOpen());
  const [budgetMode, setBudgetMode] = useState(getGoalBudgetSetting().mode);
  const [maxMinutes, setMaxMinutes] = useState(String(getGoalBudgetSetting().maxMinutes ?? ""));
  const [maxTurns, setMaxTurns] = useState(String(getGoalBudgetSetting().maxTurns ?? ""));

  const save = () => {
    setGoalModeSetting(mode);
    setGoalResumeOnOpen(resume);
    if (budgetMode === "capped") {
      const minutes = Number(maxMinutes);
      const turns = Number(maxTurns);
      setGoalBudgetSetting({
        mode: "capped",
        ...(Number.isFinite(minutes) && minutes > 0 ? { maxMinutes: minutes } : {}),
        ...(Number.isFinite(turns) && turns > 0 ? { maxTurns: turns } : {}),
      });
    } else {
      setGoalBudgetSetting({ mode: "unlimited" });
    }
    onChange();
  };

  return (
    <div data-testid="goal-settings" className="goal-mode-bar__settings">
      <div className="setting-group">
        <label htmlFor="goal-mode-select">{zh ? "长程目标模式" : "Long-horizon goal mode"}</label>
        <select
          id="goal-mode-select"
          value={mode}
          aria-label={zh ? "长程目标模式" : "Long-horizon goal mode"}
          onChange={(e) => setMode(e.target.value === "off" ? "off" : "auto")}
        >
          <option value="auto">{zh ? "自动（多阶段任务自动进入）" : "Auto (multi-phase tasks)"}</option>
          <option value="off">{zh ? "关闭" : "Off"}</option>
        </select>
      </div>
      <label className="goal-mode-bar__check">
        <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
        <span>{zh ? "启动时恢复未完成目标" : "Resume unfinished goal on open"}</span>
      </label>
      <div className="setting-group">
        <label htmlFor="goal-budget-select">{zh ? "预算" : "Budget"}</label>
        <select
          id="goal-budget-select"
          value={budgetMode}
          aria-label={zh ? "预算" : "Budget"}
          onChange={(e) => setBudgetMode(e.target.value === "capped" ? "capped" : "unlimited")}
        >
          <option value="unlimited">{zh ? "不限（推荐）" : "Unlimited (default)"}</option>
          <option value="capped">{zh ? "设上限" : "Capped"}</option>
        </select>
      </div>
      {budgetMode === "capped" ? (
        <div className="goal-mode-bar__budget-inputs">
          <input
            value={maxMinutes}
            onChange={(e) => setMaxMinutes(e.target.value)}
            placeholder={zh ? "最长分钟" : "max minutes"}
            aria-label={zh ? "最长分钟" : "max minutes"}
          />
          <input
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            placeholder={zh ? "最多回合" : "max turns"}
            aria-label={zh ? "最多回合" : "max turns"}
          />
        </div>
      ) : null}
      <button type="button" className="panel-btn panel-btn--primary goal-mode-bar__save" onClick={save}>
        {zh ? "保存目标模式设置" : "Save goal settings"}
      </button>
    </div>
  );
}

export function GoalModeBar({ sessionId }: { sessionId: string | null | undefined }): React.ReactElement | null {
  const zh = useLang() === "zh";
  const view = useGoalView(sessionId);
  const planning = useGoalPlanning(sessionId);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState("");
  const [nonGoals, setNonGoals] = useState("");
  const [note, setNote] = useState("");

  if (!sessionId) return null;
  if (!view) {
    if (!planning) return null;
    return (
      <div data-testid="goal-planning-bar" style={{ padding: "4px 0", color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
        🧭 {zh ? "深规划中…（只读分析，不写工作区）" : "Deep planning… (read-only)"}
      </div>
    );
  }

  const status = STATUS_LABEL[view.status][zh ? "zh" : "en"];
  const details = open ? getGoalDetails(sessionId) : null;
  const phaseIndex = view.activePhase ? view.activePhase.index + 1 : view.phaseDone;

  const startEdit = () => {
    setStatement(view.statement);
    setNonGoals("");
    setNote("");
    setEditing(true);
  };
  const applyEdit = () => {
    const applied = changeGoalContract({
      sessionId,
      patch: {
        ...(statement.trim() && statement.trim() !== view.statement ? { statement: statement.trim() } : {}),
        ...(nonGoals.trim()
          ? {
              nonGoals: nonGoals
                .split(/\n|；|;/)
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      },
    });
    setNote(
      applied.ok
        ? zh
          ? "目标已修改；点「继续」会先重新规划剩余阶段（已完成阶段保留）"
          : "Goal updated; resuming will re-plan remaining phases (completed phases kept)"
        : `${zh ? "修改失败：" : "Failed: "}${applied.reason ?? ""}`,
    );
    setEditing(false);
    refreshGoalView(sessionId);
  };

  return (
    <div data-testid="goal-mode-bar" className="goal-mode-bar">
      <div className="goal-mode-bar__row">
        <span className="goal-mode-bar__icon" aria-hidden="true">🧭</span>
        <div className="goal-mode-bar__body">
          <div className="goal-mode-bar__line">
            <span className="goal-mode-bar__status">
              {status}
              {view.phaseTotal > 0 ? ` · ${zh ? "阶段" : "phase"} ${phaseIndex}/${view.phaseTotal}` : ""}
              {view.status === "active" ? (zh ? " · 自动推进" : " · auto") : ""}
            </span>
            {view.autoContinues > 0 ? (
              <span className="goal-mode-bar__meta">
                {zh ? `自动继续 ${view.autoContinues} 次` : `auto-continued ${view.autoContinues}×`}
              </span>
            ) : null}
            {view.replanCount > 0 ? (
              <span className="goal-mode-bar__meta">
                {zh ? `重规划 ${view.replanCount}/${view.maxReplans}` : `re-planned ${view.replanCount}/${view.maxReplans}`}
              </span>
            ) : null}
            <span className="goal-mode-bar__meta">
              {zh
                ? `用量 ≈${view.usage.tokens} tokens · ${view.usage.turns} 回合`
                : `usage ≈${view.usage.tokens} tokens · ${view.usage.turns} turns`}
            </span>
          </div>
          <div className="goal-mode-bar__desc">
            {view.statement}
            {view.activePhase ? ` · ${zh ? "当前" : "now"}：${view.activePhase.outcome}` : ""}
          </div>
          {view.blockedReason ? (
            <div className="goal-mode-bar__reason" data-testid="goal-reason">
              {view.blockedReason}
            </div>
          ) : null}
          {planning ? <div className="goal-mode-bar__meta">{zh ? "深规划中…" : "Deep planning…"}</div> : null}
          {note ? <div className="goal-mode-bar__note">{note}</div> : null}
        </div>
        <div className="goal-mode-bar__actions">
          <button
            type="button"
            className="guidance-action-btn"
            data-testid="goal-details-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (zh ? "收起" : "Hide") : zh ? "计划 / 证据" : "Plan / evidence"}
          </button>
          {view.status === "active" ? (
            <button
              type="button"
              className="guidance-action-btn"
              data-testid="goal-stop"
              onClick={() => {
                stopSessionGoal(sessionId);
                refreshGoalView(sessionId);
              }}
            >
              {zh ? "停止" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              className="guidance-action-btn guidance-action-primary"
              data-testid="goal-continue"
              onClick={() => {
                const resumed = resumeSessionGoal(sessionId);
                setNote(resumed.ok ? "" : `${zh ? "无法继续：" : "Cannot resume: "}${resumed.reason ?? ""}`);
                refreshGoalView(sessionId);
              }}
            >
              {zh ? "继续目标" : "Resume goal"}
            </button>
          )}
          <button type="button" className="guidance-action-btn" data-testid="goal-edit" onClick={startEdit}>
            {zh ? "改目标" : "Edit goal"}
          </button>
          {/*
           * 取消目标：paused/blocked 时**必须有**出口。
           * 只有「继续目标」时，用户暂停后若不想继续（例如发现目标跑偏）就没有任何结束入口，
           * 界面会一直停在目标条 + 引导输入（真机 bug：暂停后挂住）。
           */}
          {view.status !== "completed" && view.status !== "cancelled" ? (
            <button
              type="button"
              className="guidance-action-btn"
              data-testid="goal-cancel"
              title={zh ? "结束该目标（不可继续）" : "End this goal (cannot resume)"}
              onClick={() => {
                const res = cancelSessionGoal(sessionId);
                setNote(res.ok ? "" : `${zh ? "无法取消：" : "Cannot cancel: "}${res.reason ?? ""}`);
                refreshGoalView(sessionId);
              }}
            >
              {zh ? "取消目标" : "Cancel goal"}
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div data-testid="goal-edit-form" className="goal-mode-bar__form">
          <label>
            <div>{zh ? "目标（意图）" : "Goal statement"}</div>
            <textarea
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              rows={3}
              style={{ width: "100%" }}
              aria-label={zh ? "目标（意图）" : "Goal statement"}
            />
          </label>
          <label>
            <div>{zh ? "新增非目标（一行一条，可空）" : "Additional non-goals (one per line, optional)"}</div>
            <textarea
              value={nonGoals}
              onChange={(e) => setNonGoals(e.target.value)}
              rows={2}
              style={{ width: "100%" }}
              aria-label={zh ? "非目标" : "Non-goals"}
            />
          </label>
          <div className="goal-mode-bar__form-actions">
            <button type="button" className="panel-btn panel-btn--primary" onClick={applyEdit}>
              {zh ? "确认修改" : "Apply"}
            </button>
            <button type="button" className="panel-btn" onClick={() => setEditing(false)}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}

      {open && details ? (
        <div data-testid="goal-mode-panel" className="goal-mode-bar__panel">
          <section>
            <strong>{zh ? "里程碑计划" : "Milestones"}{details.plan ? ` v${details.plan.version}` : ""}</strong>
            {details.plan ? (
              <>
                <div style={{ color: "var(--text-muted)" }}>{details.plan.strategy}</div>
                <ul>
                  {details.phases.map((p) => (
                    <li key={p.key}>
                      {phaseIcon(p.status)} <b>{p.title}</b> —— {p.outcome}
                      <div style={{ color: "var(--text-muted)" }}>
                        {zh ? "验收：" : "acceptance: "}
                        {p.acceptance.map((a) => a.description).join("；")}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div>{zh ? "尚未生成计划" : "No plan yet"}</div>
            )}
          </section>
          <section>
            <strong>{zh ? "最近证据" : "Recent evidence"}</strong>
            <ul>
              {details.evidence.slice(-8).map((e) => (
                <li key={e.id}>
                  {e.passed ? "✅" : "❌"} {e.phaseKey}/{e.acceptanceId}：{e.summary}
                </li>
              ))}
              {details.evidence.length === 0 ? <li>{zh ? "（暂无）" : "(none)"}</li> : null}
            </ul>
          </section>
          <section>
            <strong>{zh ? "决策日志" : "Decisions"}</strong>
            <ul>
              {details.decisions.slice(-10).map((d) => (
                <li key={d.id}>
                  [{d.kind}] {d.reason}
                </li>
              ))}
            </ul>
          </section>
          <GoalModeSettings zh={zh} onChange={() => refreshGoalView(sessionId)} />
        </div>
      ) : null}
    </div>
  );
}
