/**
 * P3-29: CI/CD Management Panel
 *
 * 功能：
 * 1. 输入 GitHub 仓库地址，加载最近 workflow runs
 * 2. 显示 CI/CD 状态概览（成功/失败/运行中）
 * 3. 支持重试、取消、手动触发 workflow
 * 4. 生成 GitHub Actions workflow YAML 模板
 * 5. 自动刷新
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X, RefreshCw, Play, RotateCcw, StopCircle, ExternalLink,
  ChevronDown, ChevronRight, Copy, Check, FileDown, GitBranch, Zap,
} from "lucide-react";
import { useLang, S } from "../core/i18n/lang";
import {
  generateWorkflow, listWorkflowRuns, getWorkflowJobs,
  retryWorkflowRun, cancelWorkflowRun, triggerWorkflowDispatch,
  parseRepoUrl, getCiStatusSummary,
  PIPELINE_TEMPLATES, WorkflowRun, ProjectType, WorkflowFile,
} from "../core/cicd";
import { reportActionFailure } from "../core/storage/persist-failure";

interface CicdPanelProps {
  onClose?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  success: "var(--success)",
  failure: "var(--error)",
  cancelled: "var(--text-muted)",
  neutral: "var(--text-muted)",
  skipped: "var(--text-muted)",
  timed_out: "var(--warning)",
  in_progress: "var(--info)",
  queued: "var(--accent)",
  waiting: "var(--accent)",
  pending: "var(--accent)",
};

function StatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  const display = conclusion || status;
  const color = STATUS_COLORS[display] || "var(--text-muted)";
  const label = conclusion || status;
  return (
    <span className="cicd-badge" style={{ background: color }}>
      {status === "in_progress" || status === "queued" ? (
        <RefreshCw size={10} className="spin" />
      ) : null}
      {label}
    </span>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export function CicdPanel({ onClose }: CicdPanelProps) {
  const lang = useLang();
  const [repoInput, setRepoInput] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [runJobs, setRunJobs] = useState<Record<number, WorkflowRun["jobs"]>>({});
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [copied, setCopied] = useState(false);

  // Workflow generation
  const [showGenerator, setShowGenerator] = useState(false);
  const [projectType, setProjectType] = useState<ProjectType>("node");
  const [generatedWorkflow, setGeneratedWorkflow] = useState<WorkflowFile | null>(null);

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * P2-8: 请求标识。`owner/repo` 在 `await` 期间可能已被用户改掉（切仓库 / 自动刷新
   * 与手动刷新重叠），没有标识时**旧仓库的响应会覆盖新仓库的列表与错误横幅**。
   * 每次 `loadRuns` 自增一次，回来时不是最新一次就直接丢弃（含 loading/error 写入）。
   */
  const runsSeqRef = useRef(0);
  /** P2-8: 「重试 / 取消」是真实 POST，双击会重复触发工作流；用 ref 做同 tick 守卫 */
  const actionBusyRef = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  /** P2-8: 展开详情里的 jobs 请求也要按 runId 丢弃陈旧响应 */
  const jobsSeqRef = useRef(0);

  const loadRuns = useCallback(async () => {
    if (!owner || !repo) return;
    const my = ++runsSeqRef.current;
    const reqOwner = owner;
    const reqRepo = repo;
    setLoading(true);
    setError("");
    const { runs, error } = await listWorkflowRuns(owner, repo, { perPage: 20 });
    // 期间又发起了新的加载（切仓库 / 手动刷新 / 30s 自动刷新）→ 本次结果作废
    if (my !== runsSeqRef.current) return;
    // 请求期间 owner/repo 变了（新一次 loadRuns 必然已发生或即将发生）→ 不作数
    if (reqOwner !== owner || reqRepo !== repo) return;
    setLoading(false);
    if (error) {
      setError(error);
    } else {
      setRuns(runs);
    }
  }, [owner, repo]);

  const handleLoadRepo = useCallback(() => {
    const trimmed = repoInput.trim();
    if (!trimmed) return;
    // Try parsing as URL first, then as owner/repo
    let parsed = parseRepoUrl(trimmed);
    if (!parsed) {
      const parts = trimmed.split("/");
      if (parts.length === 2) {
        parsed = { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
      }
    }
    if (!parsed) {
      setError(S.cicd.loadError[lang]);
      return;
    }
    setOwner(parsed.owner);
    setRepo(parsed.repo);
    setRuns([]);
    setExpandedRun(null);
    setRunJobs({});
    // P2-8: 切仓库时让在途的 runs/jobs 响应与「重试/取消」结果全部作废
    runsSeqRef.current += 1;
    jobsSeqRef.current += 1;
    setLoading(false);
  }, [repoInput, lang]);

  // Load runs when owner/repo changes
  useEffect(() => {
    if (owner && repo) {
      loadRuns();
    }
  }, [owner, repo, loadRuns]);

  // Auto refresh
  useEffect(() => {
    if (autoRefresh && owner && repo) {
      refreshTimer.current = setInterval(() => loadRuns(), 30000);
      return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
    }
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, [autoRefresh, owner, repo, loadRuns]);

  const toggleRunJobs = useCallback(async (runId: number) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      // P2-8: 收起时让在途的 jobs 请求作废（避免陈旧响应写进已收起的行）
      jobsSeqRef.current += 1;
      return;
    }
    setExpandedRun(runId);
    if (!runJobs[runId] && owner && repo) {
      const my = ++jobsSeqRef.current;
      const { jobs } = await getWorkflowJobs(owner, repo, runId);
      // 期间换了仓库 / 收起了这一行 / 展开了另一行 → 丢弃
      if (my !== jobsSeqRef.current) return;
      setRunJobs(prev => ({ ...prev, [runId]: jobs }));
    }
  }, [expandedRun, runJobs, owner, repo]);

  /**
   * P2-8: 重试 / 取消共用的 in-flight 守卫。
   * 双击（或两个按钮连点）会发出两次真实 POST —— 重复 rerun、误取消、白烧速率限制。
   */
  const runAction = useCallback(async (
    kind: "retry" | "cancel",
    runId: number,
  ): Promise<void> => {
    if (!owner || !repo) return;
    if (actionBusyRef.current) {
      // 可见反馈：不静默吞掉第二次点击
      setActionMsg(
        lang === "zh"
          ? "⚠ 上一个操作还在进行中，请稍候…"
          : "⚠ Previous action still in flight, please wait…",
      );
      setTimeout(() => setActionMsg(""), 3000);
      return;
    }
    actionBusyRef.current = true;
    setActionBusy(true);
    setActionMsg("");
    try {
      const { success, error } = kind === "retry"
        ? await retryWorkflowRun(owner, repo, runId)
        : await cancelWorkflowRun(owner, repo, runId);
      if (success) {
        setActionMsg(`✅ ${(kind === "retry" ? S.cicd.retry : S.cicd.cancelRun)[lang]} OK`);
        setTimeout(() => loadRuns(), 1500);
      } else {
        setActionMsg(`❌ ${error}`);
        reportActionFailure(
          `cicd.${kind}WorkflowRun`,
          new Error(String(error || "unknown error")),
          kind === "retry" ? "重试工作流未生效" : "取消工作流未生效",
        );
      }
      setTimeout(() => setActionMsg(""), 3000);
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }, [owner, repo, lang, loadRuns]);

  const handleRetry = useCallback((runId: number) => { void runAction("retry", runId); }, [runAction]);

  const handleCancel = useCallback((runId: number) => { void runAction("cancel", runId); }, [runAction]);

  const handleGenerate = useCallback(() => {
    const wf = generateWorkflow(projectType);
    setGeneratedWorkflow(wf);
  }, [projectType]);

  const handleCopyYaml = useCallback(() => {
    if (!generatedWorkflow) return;
    navigator.clipboard.writeText(generatedWorkflow.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedWorkflow]);

  const handleSaveYaml = useCallback(async () => {
    if (!generatedWorkflow) return;
    try {
      const isTauri = !!(window as any).__TAURI__;
      if (isTauri) {
        const { invoke } = (window as any).__TAURI__.core;
        // Use the dialog to get save path
        const filePath = await invoke("dialog_save", {
          title: "Save Workflow",
          defaultPath: generatedWorkflow.path,
          filters: [{ name: "YAML", extensions: ["yml", "yaml"] }],
        });
        if (filePath) {
          await invoke("write_text_file", { path: filePath, content: generatedWorkflow.content });
          setActionMsg(`✅ ${S.cicd.saved[lang]}`);
        }
      } else {
        // Browser fallback — download as blob
        const blob = new Blob([generatedWorkflow.content], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = generatedWorkflow.path.split("/").pop() || "ci.yml";
        a.click();
        URL.revokeObjectURL(url);
        setActionMsg(`✅ ${S.cicd.saved[lang]}`);
      }
    } catch (err: any) {
      setActionMsg(`❌ ${S.cicd.saveError[lang]}: ${err.message || err}`);
    }
    setTimeout(() => setActionMsg(""), 3000);
  }, [generatedWorkflow, lang]);

  const summary = getCiStatusSummary(runs);

  const panel = (
    <div className="cicd-panel cicd-panel-inline">
        {/* Repo Input */}
        <div className="cicd-repo-bar">
          <input
            type="text"
            value={repoInput}
            onChange={e => setRepoInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleLoadRepo(); }}
            placeholder={S.cicd.repoUrlPlaceholder[lang]}
            className="cicd-repo-input"
          />
          <button
            onClick={handleLoadRepo}
            className="cicd-load-btn"
          >
            {S.cicd.load[lang]}
          </button>
          <label className="cicd-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            {S.cicd.autoRefresh[lang]}
          </label>
        </div>

        {/* Error */}
        {error && (
          <div className="cicd-error">
            ⚠ {error}
          </div>
        )}

        {/* Action feedback */}
        {actionMsg && (
          <div className="cicd-action-msg">
            {actionMsg}
          </div>
        )}

        {/* Content */}
        <div className="cicd-content">
          {owner && repo && (
            <>
              {/* Summary */}
              <div className="cicd-summary">
                <div className="cicd-summary-card">
                  <span className="cicd-summary-value">{summary.total}</span>
                  <span className="cicd-summary-label">{S.cicd.total[lang]}</span>
                </div>
                <div className="cicd-summary-card" style={{ borderColor: "var(--success)" }}>
                  <span className="cicd-summary-value is-success">{summary.success}</span>
                  <span className="cicd-summary-label">{S.cicd.success[lang]}</span>
                </div>
                <div className="cicd-summary-card" style={{ borderColor: "var(--error)" }}>
                  <span className="cicd-summary-value is-failure">{summary.failure}</span>
                  <span className="cicd-summary-label">{S.cicd.failure[lang]}</span>
                </div>
                <div className="cicd-summary-card" style={{ borderColor: "var(--info)" }}>
                  <span className="cicd-summary-value is-running">{summary.running}</span>
                  <span className="cicd-summary-label">{S.cicd.running[lang]}</span>
                </div>
                <div className="cicd-summary-card" style={{ borderColor: "var(--text-muted)" }}>
                  <span className="cicd-summary-value is-cancelled">{summary.cancelled}</span>
                  <span className="cicd-summary-label">{S.cicd.cancelled[lang]}</span>
                </div>
              </div>

              {/* Runs List */}
              <div className="cicd-runs-head">
                <span className="cicd-runs-title">{S.cicd.recentRuns[lang]}</span>
                <button onClick={loadRuns} disabled={loading} className="cicd-refresh-btn">
                  <RefreshCw size={12} className={loading ? "spin" : ""} />
                  {S.cicd.refresh[lang]}
                </button>
              </div>

              {loading && runs.length === 0 ? (
                <div className="empty-hint">{S.cicd.fetching[lang]}</div>
              ) : runs.length === 0 ? (
                <div className="empty-hint">{S.cicd.noRuns[lang]}</div>
              ) : (
                <div className="cicd-runs">
                  {runs.map(run => (
                    <div key={run.id} className="cicd-run-card">
                      {/* Run header row */}
                      <div className="cicd-run-head" onClick={() => toggleRunJobs(run.id)}>
                        <span className="cicd-run-chevron">
                          {expandedRun === run.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>
                        <StatusBadge status={run.status} conclusion={run.conclusion} />
                        <span className="cicd-run-title">#{run.runNumber} {run.name}</span>
                        <span className="hint-sm">{run.event}</span>
                        <span className="hint-sm">{run.headBranch}</span>
                        <span className="cicd-run-time">{formatTime(run.createdAt)}</span>
                        <a href={run.htmlUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="cicd-run-link">
                          <ExternalLink size={14} />
                        </a>
                      </div>

                      {/* Action buttons */}
                      <div className="cicd-run-actions">
                        {run.conclusion === "failure" && (
                          <button onClick={() => handleRetry(run.id)} disabled={actionBusy} className="cicd-btn">
                            <RotateCcw size={12} /> {S.cicd.retry[lang]}
                          </button>
                        )}
                        {(run.status === "in_progress" || run.status === "queued") && (
                          <button onClick={() => handleCancel(run.id)} disabled={actionBusy} className="cicd-btn">
                            <StopCircle size={12} /> {S.cicd.cancel[lang]}
                          </button>
                        )}
                      </div>

                      {/* Jobs detail */}
                      {expandedRun === run.id && runJobs[run.id] && (
                        <div className="cicd-jobs">
                          <div className="cicd-jobs-title">{S.cicd.jobs[lang]}</div>
                          {runJobs[run.id]!.length === 0 ? (
                            <div className="hint-sm">—</div>
                          ) : (
                            runJobs[run.id]!.map(job => (
                              <div key={job.id} className="cicd-job">
                                <div className="cicd-job-head">
                                  <StatusBadge status={job.status} conclusion={job.conclusion} />
                                  <span className="cicd-job-name">{job.name}</span>
                                </div>
                                {/* Steps */}
                                {job.steps && job.steps.length > 0 && (
                                  <div className="cicd-steps">
                                    {job.steps.map(step => (
                                      <div key={step.number} className="cicd-step">
                                        <span className={`cicd-step-mark is-${step.conclusion === "success" ? "success" : step.conclusion === "failure" ? "failure" : "unknown"}`}>
                                          {step.conclusion === "success" ? "✓" : step.conclusion === "failure" ? "✗" : "○"}
                                        </span>
                                        <span>{step.name}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Workflow Generator */}
          <div className="cicd-generator">
            <button
              onClick={() => { setShowGenerator(!showGenerator); if (!showGenerator && !generatedWorkflow) handleGenerate(); }}
              className="cicd-generator-toggle"
            >
              {showGenerator ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Zap size={16} />
              {S.cicd.generateWorkflow[lang]}
            </button>

            {showGenerator && (
              <div style={{ marginTop: "var(--space-4)" }}>
                <div className="cicd-templates">
                  {PIPELINE_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.type}
                      onClick={() => { setProjectType(tpl.type); const wf = generateWorkflow(tpl.type); setGeneratedWorkflow(wf); }}
                      className={`cicd-template-btn${projectType === tpl.type ? " is-active" : ""}`}
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>

                {generatedWorkflow && (
                  <div>
                    <div className="cicd-workflow-actions">
                      <button onClick={handleCopyYaml} className="cicd-btn">
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? S.cicd.copied[lang] : S.cicd.copyYaml[lang]}
                      </button>
                      <button onClick={handleSaveYaml} className="cicd-btn">
                        <FileDown size={12} />
                        {S.cicd.saveToFile[lang]}
                      </button>
                      <span className="cicd-workflow-path">{generatedWorkflow.path}</span>
                    </div>
                    <pre className="cicd-yaml">
                      {generatedWorkflow.content}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
  );

  return panel;
}

