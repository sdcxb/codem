import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Clock3, Eye, Loader2, RefreshCw, X } from "lucide-react";
import { buildProjectOverview, type ProjectOverview, type OverviewBucket } from "../core/project/coordinator";

const BUCKETS: Array<{ id: OverviewBucket; zh: string; en: string; color: string; icon: typeof Clock3 }> = [
  { id: "waiting", zh: "等你", en: "Waiting on you", color: "var(--warning, #d97706)", icon: AlertTriangle },
  { id: "working", zh: "运行中", en: "Working", color: "var(--accent, #7c3aed)", icon: Loader2 },
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
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgb(0 0 0 / 45%)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(760px, 92vw)", maxHeight: "82vh", overflow: "auto", background: "var(--bg-primary, #1a1a1a)", color: "var(--text-primary, #eee)", border: "1px solid var(--border-primary, #333)", borderRadius: 12, padding: 18, boxShadow: "0 24px 70px rgb(0 0 0 / 45%)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "var(--fs-lg, 16px)", fontWeight: 600 }}>项目总览 · {projectName}</div>
            <div style={{ fontSize: "var(--fs-xs, 11px)", color: "var(--text-muted, #999)" }}>只读 .codem/project 的项目状态；不读 thread 聊天记录</div>
          </div>
          <button aria-label="刷新" title="刷新" onClick={() => void load()} style={{ background: "none", border: "none", color: "var(--text-secondary, #aaa)", cursor: "pointer", padding: 6 }}>
            <RefreshCw size={15} />
          </button>
          <button aria-label="关闭" title="关闭" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-secondary, #aaa)", cursor: "pointer", padding: 6 }}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted, #999)" }}><Loader2 size={18} /> 读取项目状态…</div>
        ) : error ? (
          <div style={{ padding: 16, color: "var(--error, #ef4444)" }}>读取失败：{error}</div>
        ) : overview ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 14 }}>
              {BUCKETS.map((b) => {
                const Icon = b.icon;
                return (
                  <div key={b.id} style={{ border: "1px solid var(--border-primary, #333)", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: b.color, fontSize: "var(--fs-xs, 11px)" }}><Icon size={13} /> {b.zh}</div>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{overview.counts[b.id]}</div>
                  </div>
                );
              })}
            </div>

            {overview.invalidReports.length > 0 && (
              <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--warning, #d97706)", color: "var(--warning, #d97706)", fontSize: "var(--fs-xs, 11px)" }}>
                <AlertTriangle size={12} /> {overview.invalidReports.length} 份报告不符合 v3.1 契约（未计入结论）：{overview.invalidReports.map((r) => r.file).join("、")}
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
                        <div key={t.sessionId} style={{ border: "1px solid var(--border-primary, #333)", borderRadius: 8, padding: "7px 10px" }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <span style={{ fontWeight: 600, fontSize: "var(--fs-sm, 12px)" }}>{t.title}</span>
                            <span style={{ fontSize: "var(--fs-xs, 10px)", color: "var(--text-muted, #888)" }}>{t.sessionId}</span>
                          </div>
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
    document.body
  );
}
