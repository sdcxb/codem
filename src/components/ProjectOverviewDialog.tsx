import { useEffect, useState } from "react";
import { createPortal } from "./ui/portal";
import { AlertTriangle, CheckCircle2, Clock3, Eye, RefreshCw, X } from "lucide-react";
import { Spinner } from "./ui/Spinner";
import { buildProjectOverview, verifyProjectGates, type ProjectOverview, type OverviewBucket } from "../core/project/coordinator";
import { confirmDialog } from "../core/ui/native-dialog";

const BUCKETS: Array<{ id: OverviewBucket; zh: string; en: string; color: string; icon: typeof Clock3 }> = [
  { id: "waiting", zh: "等你", en: "Waiting on you", color: "var(--warning, #d97706)", icon: AlertTriangle },
  { id: "working", zh: "运行中", en: "Working", color: "var(--accent, #7c3aed)", icon: RefreshCw },
  { id: "review", zh: "待评审", en: "Ready for review", color: "var(--info, #2563eb)", icon: Eye },
  { id: "done", zh: "已完成", en: "Done", color: "var(--success, #16a34a)", icon: CheckCircle2 },
];

export function ProjectOverviewDialog({
  projectPath,
  projectName,
  onClose,
}: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await buildProjectOverview(projectPath));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const reverify = async () => {
    const ok = await confirmDialog("重验 gate 会重新执行报告里登记的命令（在工作区里跑），确认继续？");
    if (!ok) return;
    setVerifying(true);
    setError(null);
    try {
      await verifyProjectGates(projectPath);
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    void load();
    // 项目切换时重新读；不监听文件变化（P0 用刷新按钮）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="项目总览"
      className="modal-overlay"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="project-overview-panel"
        style={{ width: "min(760px, 92vw)", maxHeight: "82vh", overflow: "auto", background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)", boxShadow: "0 24px 70px var(--shadow-color)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "var(--fs-lg, 16px)", fontWeight: 600 }}>项目总览 · {projectName}</div>
            <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--text-muted, #999)" }}>只读 .codem/project 的项目状态；不读 thread 聊天记录</div>
          </div>
          <button aria-label="重验 gate" title="重验 gate" disabled={verifying} onClick={() => void reverify()} style={{ background: "none", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)", color: "var(--text-secondary)", cursor: "pointer", padding: "3px 8px", fontSize: "var(--fs-xs)" }}>
            {verifying ? "重验中…" : "重验 gate"}
          </button>
          <button aria-label="刷新" title="刷新" onClick={() => void load()} style={{ background: "none", border: "none", color: "var(--text-secondary, #aaa)", cursor: "pointer", padding: 6 }}>
            <RefreshCw className="icon-sm" />
          </button>
          <button aria-label="关闭" title="关闭" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-secondary, #aaa)", cursor: "pointer", padding: 6 }}>
            <X className="icon-sm" />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted, #999)" }}><Spinner size="sm" label="" /> 读取项目状态…</div>
        ) : error ? (
          <div style={{ padding: 16, color: "var(--error, #ef4444)" }}>读取失败：{error}</div>
        ) : overview ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 14 }}>
              {BUCKETS.map((b) => {
                const Icon = b.icon;
                return (
                  <div key={b.id} style={{ border: "1px solid var(--border-primary, #333)", borderRadius: "var(--radius-md)", padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: b.color, fontSize: "var(--fs-xs, 11px)" }}><Icon className="icon-xs" /> {b.zh}</div>
                    <div style={{ fontSize: "var(--fs-xl)", fontWeight: 700 }}>{overview.counts[b.id]}</div>
                  </div>
                );
              })}
            </div>

            {overview.unverifiedGates > 0 && (
              <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--warning, #d97706)", color: "var(--warning, #d97706)", fontSize: "var(--fs-xs, 11px)" }}>
                <AlertTriangle className="icon-xs" /> {overview.unverifiedGates} 个 gate 未重验（报告说通过不算，点「重验 gate」）
              </div>
            )}

            {overview.missingEvidence > 0 && (
              <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--warning, #d97706)", color: "var(--warning, #d97706)", fontSize: "var(--fs-xs, 11px)" }}>
                <AlertTriangle className="icon-xs" /> {overview.missingEvidence} 个证据文件在主工作区缺失（报告可能不完整）
              </div>
            )}

            {overview.invalidReports.length > 0 && (
              <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--warning, #d97706)", color: "var(--warning, #d97706)", fontSize: "var(--fs-xs, 11px)" }}>
                <AlertTriangle className="icon-xs" /> {overview.invalidReports.length} 份报告不符合 v3.1 契约（未计入结论）：{overview.invalidReports.map((r) => r.file).join("、")}
              </div>
            )}

            {BUCKETS.map((b) => {
              const items = overview.threads.filter((t) => t.bucket === b.id);
              return (
                <div key={b.id} style={{ marginTop: 10 }}>
                  <div style={{ fontSize: "var(--fs-sm, 12px)", fontWeight: 600, color: b.color, marginBottom: 6 }}>{b.zh} · {items.length}</div>
                  {items.length === 0 ? (
                    <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--text-muted, #888)" }}>（空）</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {items.map((t) => (
                        <div key={t.sessionId} style={{ border: "1px solid var(--border-primary, #333)", borderRadius: "var(--radius-md)", padding: "7px 10px" }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <span style={{ fontWeight: 600, fontSize: "var(--fs-sm, 12px)" }}>{t.title}</span>
                            <span style={{ fontSize: "var(--fs-xs, 10px)", color: "var(--text-muted, #888)" }}>{t.status} · {t.sessionId}</span>
                          </div>
                          {t.latestReport?.pull_request && (
                            <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--text-secondary, #bbb)", marginTop: 2 }}>
                              PR {t.latestReport.pull_request.number ? `#${t.latestReport.pull_request.number} ` : ""}
                              {t.latestReport.pull_request.state}
                              {t.latestReport.pull_request.checks ? ` · CI ${t.latestReport.pull_request.checks}` : ""}
                              {t.latestReport.pull_request.url ? ` · ${t.latestReport.pull_request.url}` : ""}
                            </div>
                          )}
                          {t.latestReport?.blocking && (
                            <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--warning, #d97706)", marginTop: 2 }}>
                              等你：{t.latestReport.blocking.question}（选项：{t.latestReport.blocking.options.join(" / ")}；默认：{t.latestReport.blocking.default}）
                            </div>
                          )}
                          {t.latestReport && (
                            <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--text-secondary, #bbb)", marginTop: 2 }}>
                              {t.latestReport.summary}
                              {t.latestReport.gates?.length ? ` · gates: ${t.latestReport.gates.map((g) => `${g.id}=${g.passed ? "pass" : "fail"}`).join(",")}` : ""}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {overview.threads.length === 0 && (
              <div style={{ padding: 18, textAlign: "center", color: "var(--text-muted, #999)", fontSize: "var(--fs-sm, 12px)" }}>
                还没有注册 thread。thread 写一份 project_report 后会出现在这里。
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>,
  );
}
