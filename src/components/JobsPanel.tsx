/**
 * JobsPanel —— 底部「任务」页签的**宿主兜底面板**（`app.jobs` 槽位没有贡献者时渲染它）。
 *
 * ## 为什么之前没有这个面板
 *
 * `jobs` 这个 `BottomTab` 成员从来没有渲染分支、也没有 setter（`git log -S` 可查），
 * 而全仓**没有任何 jobs 面板组件** —— 只有会话头部的 `JobsBadge`（一个下拉指示器）。
 * 于是「任务」页签即使恢复入口，也只能是空白。这里补上宿主兜底实现。
 *
 * ## 数据来源（都是真的，不是占位）
 *
 * 1. **后台任务**：`@codem/tool-jobs` 那条**真的能用**的通道 —— `terminal_send run_in_background`
 *    创建的 PTY 后台发送（id 前缀 `pty-job-`，`TerminalManager.listBackgroundJobs()`）。
 *    终止走同一个 manager 的 `killBackgroundJob()`，三态返回（killed / already-finished / not-found）
 *    **如实显示**，不把「早就自己跑完」报成「已终止」（第 185 波 T3 的教训）。
 * 2. **子智能体任务**：由 `App.tsx` 从 `getSubagentRuntime()` 订阅的 `subagentTasks` 传进来，只读展示。
 *
 * 刻意**不**接 `uiJobs.cancelJob/retryJob`：那个服务要求 `automation` 服务具备 `cancel`/`retry` 能力，
 * 而 `automation-provider` 只提供 registerTrigger/listTriggers/start/stop/refresh —— 接上去只会
 * 得到一个「点了报错」的按钮（假入口），不如不接。
 */
import { useCallback, useEffect, useState } from "react";
import { ListChecks, RefreshCw, Square } from "lucide-react";
import { useLang } from "../core/i18n/lang";
import {
  killTerminalBackgroundJob,
  listTerminalBackgroundJobs,
} from "../core/llm/tools/terminal-tools";

/** 后台任务行（TerminalManager 的真实字段子集） */
interface PtyJobRow {
  id: string;
  sessionId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
}

/** 子智能体任务行（由 App 侧映射，见 App.tsx 的 subagentTasks） */
export interface JobsPanelTask {
  id: string;
  label: string;
  kind: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
}

export interface JobsPanelProps {
  /** 关闭面板（切回对话） */
  onClose?: () => void;
  /** 子智能体任务（只读） */
  tasks?: JobsPanelTask[];
}

/** 轮询间隔：后台任务的产出在别的进程里，界面只做低频率对账 */
const POLL_MS = 2000;

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

export function JobsPanel({ onClose, tasks }: JobsPanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [jobs, setJobs] = useState<PtyJobRow[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setJobs(listTerminalBackgroundJobs() as PtyJobRow[]);
    setTick(Date.now());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleKill = useCallback(
    async (jobId: string) => {
      setBusy(jobId);
      try {
        const outcome = await killTerminalBackgroundJob(jobId);
        setNotice(
          outcome === "killed"
            ? (zh ? "已终止：" : "Killed: ") + jobId
            : outcome === "already-finished"
              ? (zh ? "该任务已经自己结束（本次没有停任何东西）：" : "Already finished before kill (nothing was stopped): ") + jobId
              : (zh ? "找不到这个任务：" : "Job not found: ") + jobId,
        );
      } catch (err) {
        setNotice((zh ? "终止失败：" : "Kill failed: ") + (err instanceof Error ? err.message : String(err)));
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh, zh],
  );

  const liveCount = jobs.filter((j) => j.status === "running").length;
  const hasAny = jobs.length > 0 || (tasks?.length ?? 0) > 0;

  return (
    <div className="jobs-panel">
      <div className="jobs-panel-header">
        <span className="jobs-panel-title">
          <ListChecks className="icon-sm" /> {zh ? "后台任务" : "Background jobs"}
          {liveCount > 0 ? <span className="jobs-panel-live">{liveCount} {zh ? "个运行中" : "running"}</span> : null}
        </span>
        <div className="jobs-panel-actions">
          <button type="button" className="jobs-panel-btn" onClick={refresh}>
            <RefreshCw className="icon-xs" /> {zh ? "刷新" : "Refresh"}
          </button>
          {onClose ? (
            <button type="button" className="jobs-panel-btn" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>
              {zh ? "关闭" : "Close"}
            </button>
          ) : null}
        </div>
      </div>

      {notice ? <div className="jobs-panel-notice">{notice}</div> : null}

      {!hasAny ? (
        <div className="empty-hint">
          {zh
            ? "当前没有后台任务。Agent 用 terminal_send(run_in_background) 起的命令会出现在这里。"
            : "No background jobs. Commands started with terminal_send(run_in_background) show up here."}
        </div>
      ) : null}

      {jobs.length > 0 ? (
        <ul className="jobs-panel-list">
          {jobs.map((job) => (
            <li key={job.id} className="jobs-panel-row">
              <span className={`jobs-panel-status is-${job.status}`}>{job.status}</span>
              <span className="jobs-panel-id">{job.id}</span>
              <span className="jobs-panel-meta">{job.sessionId}</span>
              <span className="jobs-panel-meta">
                {formatDuration((job.completedAt ?? tick) - job.startedAt)}
              </span>
              <button
                type="button"
                className="jobs-panel-btn is-danger"
                disabled={job.status !== "running" || busy === job.id}
                onClick={() => void handleKill(job.id)}
                title={zh ? "终止（发 SIGINT）" : "Kill (SIGINT)"}
              >
                <Square className="icon-xs" /> {zh ? "终止" : "Kill"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {tasks && tasks.length > 0 ? (
        <>
          <div className="jobs-panel-subtitle">{zh ? "子智能体任务（只读）" : "Subagent tasks (read-only)"}</div>
          <ul className="jobs-panel-list">
            {tasks.map((task) => (
              <li key={task.id} className="jobs-panel-row">
                <span className={`jobs-panel-status is-${task.status}`}>{task.status}</span>
                <span className="jobs-panel-id">{task.label}</span>
                <span className="jobs-panel-meta">{task.kind}</span>
                <span className="jobs-panel-meta">
                  {formatDuration((task.finishedAt ?? tick) - task.startedAt)}
                </span>
                {task.detail ? <span className="jobs-panel-meta is-error">{task.detail}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
