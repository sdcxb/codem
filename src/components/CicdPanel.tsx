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

interface CicdPanelProps {
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  success: "#22c55e",
  failure: "#ef4444",
  cancelled: "#6b7280",
  neutral: "#6b7280",
  skipped: "#6b7280",
  timed_out: "#f59e0b",
  in_progress: "#3b82f6",
  queued: "#a855f7",
  waiting: "#a855f7",
  pending: "#a855f7",
};

function StatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  const display = conclusion || status;
  const color = STATUS_COLORS[display] || "#6b7280";
  const label = conclusion || status;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 8px", borderRadius: 4,
        fontSize: 11, fontWeight: 600, color: "#fff",
        background: color, textTransform: "capitalize",
      }}
    >
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

  const loadRuns = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    setError("");
    const { runs, error } = await listWorkflowRuns(owner, repo, { perPage: 20 });
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
      return;
    }
    setExpandedRun(runId);
    if (!runJobs[runId] && owner && repo) {
      const { jobs } = await getWorkflowJobs(owner, repo, runId);
      setRunJobs(prev => ({ ...prev, [runId]: jobs }));
    }
  }, [expandedRun, runJobs, owner, repo]);

  const handleRetry = useCallback(async (runId: number) => {
    if (!owner || !repo) return;
    setActionMsg("");
    const { success, error } = await retryWorkflowRun(owner, repo, runId);
    if (success) {
      setActionMsg(`✅ ${S.cicd.retry[lang]} OK`);
      setTimeout(() => loadRuns(), 1500);
    } else {
      setActionMsg(`❌ ${error}`);
    }
    setTimeout(() => setActionMsg(""), 3000);
  }, [owner, repo, lang, loadRuns]);

  const handleCancel = useCallback(async (runId: number) => {
    if (!owner || !repo) return;
    setActionMsg("");
    const { success, error } = await cancelWorkflowRun(owner, repo, runId);
    if (success) {
      setActionMsg(`✅ ${S.cicd.cancelRun[lang]} OK`);
      setTimeout(() => loadRuns(), 1500);
    } else {
      setActionMsg(`❌ ${error}`);
    }
    setTimeout(() => setActionMsg(""), 3000);
  }, [owner, repo, lang, loadRuns]);

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
    <div
      className="cicd-panel cicd-panel-inline"
      style={{
        width: "100%", height: "100%",
        background: "var(--bg-primary, #1e1e2e)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <GitBranch size={18} />
            <span style={{ fontSize: 16, fontWeight: 700 }}>{S.cicd.title[lang]}</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>
            <X size={20} />
          </button>
        </div>

        {/* Repo Input */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)", flexShrink: 0, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            value={repoInput}
            onChange={e => setRepoInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleLoadRepo(); }}
            placeholder={S.cicd.repoUrlPlaceholder[lang]}
            style={{
              flex: 1, minWidth: 240, padding: "6px 10px",
              background: "var(--bg-secondary, #181825)",
              border: "1px solid var(--border-color, #333)",
              borderRadius: 6, color: "inherit", fontSize: 13,
            }}
          />
          <button
            onClick={handleLoadRepo}
            style={{
              padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              border: "none", background: "var(--accent, #7c3aed)", color: "#fff", fontSize: 13,
            }}
          >
            {S.cicd.load[lang]}
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            {S.cicd.autoRefresh[lang]}
          </label>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: "8px 16px", color: "#ef4444", fontSize: 12 }}>
            ⚠ {error}
          </div>
        )}

        {/* Action feedback */}
        {actionMsg && (
          <div style={{ padding: "4px 16px", fontSize: 12, color: "#22c55e" }}>
            {actionMsg}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 12px" }}>
          {owner && repo && (
            <>
              {/* Summary */}
              <div style={{ display: "flex", gap: 12, margin: "12px 0", flexWrap: "wrap" }}>
                <div style={summaryCardStyle}>
                  <span style={{ fontSize: 22, fontWeight: 700 }}>{summary.total}</span>
                  <span style={{ fontSize: 11 }}>{S.cicd.total[lang]}</span>
                </div>
                <div style={{ ...summaryCardStyle, borderColor: "#22c55e" }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: "#22c55e" }}>{summary.success}</span>
                  <span style={{ fontSize: 11 }}>{S.cicd.success[lang]}</span>
                </div>
                <div style={{ ...summaryCardStyle, borderColor: "#ef4444" }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: "#ef4444" }}>{summary.failure}</span>
                  <span style={{ fontSize: 11 }}>{S.cicd.failure[lang]}</span>
                </div>
                <div style={{ ...summaryCardStyle, borderColor: "#3b82f6" }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: "#3b82f6" }}>{summary.running}</span>
                  <span style={{ fontSize: 11 }}>{S.cicd.running[lang]}</span>
                </div>
                <div style={{ ...summaryCardStyle, borderColor: "#6b7280" }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: "#6b7280" }}>{summary.cancelled}</span>
                  <span style={{ fontSize: 11 }}>{S.cicd.cancelled[lang]}</span>
                </div>
              </div>

              {/* Runs List */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{S.cicd.recentRuns[lang]}</span>
                <button onClick={loadRuns} disabled={loading} style={{ background: "none", border: "1px solid var(--border-color)", borderRadius: 4, padding: "2px 8px", cursor: "pointer", color: "inherit", fontSize: 12, opacity: loading ? 0.5 : 1 }}>
                  <RefreshCw size={12} style={{ display: "inline", marginRight: 4 }} className={loading ? "spin" : ""} />
                  {S.cicd.refresh[lang]}
                </button>
              </div>

              {loading && runs.length === 0 ? (
                <div style={{ textAlign: "center", padding: 24, color: "#6b7280" }}>{S.cicd.fetching[lang]}</div>
              ) : runs.length === 0 ? (
                <div style={{ textAlign: "center", padding: 24, color: "#6b7280" }}>{S.cicd.noRuns[lang]}</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {runs.map(run => (
                    <div key={run.id} style={runCardStyle}>
                      {/* Run header row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => toggleRunJobs(run.id)}>
                        <span style={{ flexShrink: 0 }}>
                          {expandedRun === run.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>
                        <StatusBadge status={run.status} conclusion={run.conclusion} />
                        <span style={{ fontWeight: 600, fontSize: 13 }}>#{run.runNumber} {run.name}</span>
                        <span style={{ fontSize: 11, color: "#6b7280" }}>{run.event}</span>
                        <span style={{ fontSize: 11, color: "#6b7280" }}>{run.headBranch}</span>
                        <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>{formatTime(run.createdAt)}</span>
                        <a href={run.htmlUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: "inherit", display: "flex" }}>
                          <ExternalLink size={14} />
                        </a>
                      </div>

                      {/* Action buttons */}
                      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                        {run.conclusion === "failure" && (
                          <button onClick={() => handleRetry(run.id)} style={actionBtnStyle}>
                            <RotateCcw size={12} /> {S.cicd.retry[lang]}
                          </button>
                        )}
                        {(run.status === "in_progress" || run.status === "queued") && (
                          <button onClick={() => handleCancel(run.id)} style={actionBtnStyle}>
                            <StopCircle size={12} /> {S.cicd.cancel[lang]}
                          </button>
                        )}
                      </div>

                      {/* Jobs detail */}
                      {expandedRun === run.id && runJobs[run.id] && (
                        <div style={{ marginTop: 8, borderTop: "1px solid var(--border-color, #333)", paddingTop: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{S.cicd.jobs[lang]}</div>
                          {runJobs[run.id]!.length === 0 ? (
                            <div style={{ fontSize: 12, color: "#6b7280" }}>—</div>
                          ) : (
                            runJobs[run.id]!.map(job => (
                              <div key={job.id} style={{ marginBottom: 8 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                                  <StatusBadge status={job.status} conclusion={job.conclusion} />
                                  <span style={{ fontWeight: 600 }}>{job.name}</span>
                                </div>
                                {/* Steps */}
                                {job.steps && job.steps.length > 0 && (
                                  <div style={{ marginLeft: 16, marginTop: 4 }}>
                                    {job.steps.map(step => (
                                      <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6b7280" }}>
                                        <span style={{ width: 16, textAlign: "center", color: step.conclusion === "success" ? "#22c55e" : step.conclusion === "failure" ? "#ef4444" : "#6b7280" }}>
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
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border-color, #333)", paddingTop: 12 }}>
            <button
              onClick={() => { setShowGenerator(!showGenerator); if (!showGenerator && !generatedWorkflow) handleGenerate(); }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
            >
              {showGenerator ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Zap size={16} />
              {S.cicd.generateWorkflow[lang]}
            </button>

            {showGenerator && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  {PIPELINE_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.type}
                      onClick={() => { setProjectType(tpl.type); const wf = generateWorkflow(tpl.type); setGeneratedWorkflow(wf); }}
                      style={{
                        padding: "4px 10px", borderRadius: 4, fontSize: 12, cursor: "pointer",
                        border: projectType === tpl.type ? "1px solid var(--accent, #7c3aed)" : "1px solid var(--border-color, #333)",
                        background: projectType === tpl.type ? "var(--accent-soft, rgba(124,58,237,0.15))" : "transparent",
                        color: "inherit",
                      }}
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>

                {generatedWorkflow && (
                  <div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      <button onClick={handleCopyYaml} style={actionBtnStyle}>
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? S.cicd.copied[lang] : S.cicd.copyYaml[lang]}
                      </button>
                      <button onClick={handleSaveYaml} style={actionBtnStyle}>
                        <FileDown size={12} />
                        {S.cicd.saveToFile[lang]}
                      </button>
                      <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "center" }}>{generatedWorkflow.path}</span>
                    </div>
                    <pre style={{
                      background: "var(--bg-secondary, #181825)",
                      border: "1px solid var(--border-color, #333)",
                      borderRadius: 6, padding: 12, fontSize: 12,
                      overflowX: "auto", maxHeight: 300,
                      fontFamily: "'Cascadia Code', 'Fira Code', monospace",
                      margin: 0,
                    }}>
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

// Styles
const summaryCardStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center",
  padding: "8px 16px", borderRadius: 8,
  border: "1px solid var(--border-color, #333)",
  minWidth: 80,
};

const runCardStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #333)",
  background: "var(--bg-secondary, #181825)",
};

const actionBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "3px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer",
  border: "1px solid var(--border-color, #333)", background: "transparent", color: "inherit",
};
