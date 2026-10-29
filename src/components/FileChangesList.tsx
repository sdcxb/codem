/**
 * FileChangesList — Per-turn file change history panel
 *
 * Reads from turn_file_changes table (via FileChangeStorage).
 * Clicking a file opens DiffViewer with before/after content.
 * Includes Topic-style grouping by turn + revert button.
 *
 * P1-4: Thin wrapper that reuses existing DiffViewer component.
 */

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, RotateCcw, FileText, GitBranch } from "lucide-react";
import { FileChangeStorage, type TurnFileChangeRecord, type ChangedFile } from "../core/storage/file-change-storage";
import { FileChangeTracker } from "../core/environment/file-change-tracker";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";
import { DiffViewer } from "./DiffViewer";
import { confirmDialog } from "../core/ui/native-dialog";
import { listVerificationChecks, type VerificationCheck } from "../core/environment/verification-checks";

interface FileChangesListProps {
  sessionId: string;
  workspace: string;
}

/** 把 git 状态码映射成一个**完整**的类名字符串（避免在 JSX 里拼字符串，扫描器与人都更难读） */
function gitStatusClass(status: string): string {
  const s = (status || "").toLowerCase();
  const kind = s === "m" ? "modified" : s === "a" ? "added" : s === "d" ? "deleted" : "untracked";
  return `change-file-status git-status-${kind}`;
}

export function FileChangesList({ sessionId, workspace }: FileChangesListProps) {
  const [records, setRecords] = useState<TurnFileChangeRecord[]>([]);
  /**
   * 读取失败的原因（第 269 波）✓ —— **空列表**与**读不到**必须能区分 ✓。
   *
   * 为什么必须显式：这张表以前只能给"空"✗（镜像被拒载 ⇒ 同步读恒返回 `[]` ✗），
   * 而界面把"空"显示成"暂无文件变更记录"✗ —— 用户看到的是一个**看起来正常**的空面板 ✗。
   * 现在失败会在面板里如实说出来 ✓，不再是无声的空 ✗。
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ path: string; before: string; after: string } | null>(null);
  const [patchPreview, setPatchPreview] = useState<{ id: string; add: number; del: number; lines: string[] } | null>(null);
  /** Phase C：本会话最近的验证命令结果（设置面读取，同步、有界） */
  const [checks, setChecks] = useState<VerificationCheck[]>([]);

  useEffect(() => {
    if (!expandedTurn) { setPatchPreview(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const patch = await FileChangeStorage.getPatchByIdAsync(expandedTurn);
        if (cancelled || !patch) return;
        const lines = patch.split("\n");
        const add = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const del = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        const preview = lines
          .filter((l) => /^[+-]/.test(l) && !l.startsWith("+++") && !l.startsWith("---"))
          .slice(0, 12);
        setPatchPreview({ id: expandedTurn, add, del, lines: preview });
      } catch { /* 预览失败不伪造统计 */ }
    })();
    return () => { cancelled = true; };
  }, [expandedTurn]);

  /**
   * ## 第 269 波：这张表**不再有域镜像** ✗→✓（按需查询 + 有界一屏 ✓）
   *
   * 原来 `FileChangeStorage.listBySession()` 是**同步读镜像** ✗ —— 而真机上它超过
   * 默认上限 5000 行就被**拒载**✗，于是这个面板显示的是"暂无文件变更记录"✗
   * （用户看到的是「该功能本次不可用」✗，`docs/HANDOFF-NEXT-SESSION.md` §3 ✓）。
   *
   * 现在读的是**按需查询** ✓：`loadBySession()` 按会话拉最近
   * `TURN_FILE_CHANGE_WINDOW_ROWS` 行 ✓（**不含 patch 正文** ✗，回滚时按 id 单独取 ✓）。
   *
   * ⚠️ **失败不许吞成空** ✗：拉取失败时把 `loadError` 记下来并**如实显示** ✗→✓
   * —— 空列表与"读不到"是两件事 ✓（这正是这个面板以前让人误判的地方 ✗）。
   */
  const loadRecords = useCallback(() => {
    let alive = true;
    FileChangeStorage.loadBySession(sessionId)
      .then((list) => {
        if (!alive) return;
        setRecords(list);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        console.warn("[FileChangesList] 读取本会话文件变更失败:", e);
        setRecords([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const cancel = loadRecords();
    const unsub = onFileChangesTracked(() => loadRecords());
    return () => {
      cancel();
      unsub();
    };
  }, [loadRecords]);

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P0）：单轮变更回滚也要先确认
   *
   * `FileChangeTracker.revert` 做的是"反向打补丁 + `Remove-Item -Force` 删掉本轮新建的文件"
   * —— 同样是**动用户工作区文件**，而这里原来是单击即执行、没有确认也没有撤销。
   * 与 `SnapshotPanel` 那条入口一起补齐（仓库里更轻的操作都有确认，只有这两处没有）。
   *
   * 确认框里把**文件清单**说清：用户是在知道"要动哪几个文件"的前提下点的。
   */
  const handleRevert = async (record: TurnFileChangeRecord) => {
    // `changed_files` 是 JSON 文本列（`[{path, status, …}]`）—— 解析失败就退回只报条数的文案
    let files: Array<{ path: string; status: string }> = [];
    try {
      const parsed = record.changed_files ? JSON.parse(record.changed_files) : [];
      if (Array.isArray(parsed)) files = parsed;
    } catch (e) {
      console.warn("[FileChangesList] changed_files 解析失败（回滚确认框只报条数）:", e);
    }
    const fileList =
      files
        .slice(0, 8)
        .map((f) => `  · ${f.status} ${f.path.split(/[\\/]/).pop()}`)
        .join("\n") + (files.length > 8 ? `\n  · …还有 ${files.length - 8} 个` : "");
    const msg =
      `回滚这一轮的改动会改写你的工作区文件：\n\n` +
      (files.length > 0
        ? `将反向应用 ${files.length} 个文件的改动` +
          (files.some((f) => f.status === "A") ? `（其中新增的文件会被删除）` : "") +
          `：\n${fileList}\n\n`
        : `将反向应用这一轮记录的全部改动。\n\n`) +
      `这一步没有自动快照，确定继续吗？`;
    // ⚠️ 必须 `await`：dialog 插件把 `window.confirm` 换成了异步调用，返回值是 Promise（恒为真）
    if (!(await confirmDialog(msg))) return;

    const ok = await FileChangeTracker.revert(record.id, workspace);
    if (ok) {
      loadRecords();
    }
  };

  const handleViewDiff = async (record: TurnFileChangeRecord, file: ChangedFile) => {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      let before = "";
      let after = "";

      // Get before content via git show beforeTree:path
      if (record.before_tree && file.status !== "A") {
        const beforeResult = await invoke("execute_command", {
          command: "git -C \"" + workspace + "\" show " + record.before_tree + ":\"" + file.path + "\"",
          cwd: workspace,
        });
        before = beforeResult.stdout || "";
      }
      // Get after content via git show afterTree:path
      if (record.after_tree && file.status !== "D") {
        const afterResult = await invoke("execute_command", {
          command: "git -C \"" + workspace + "\" show " + record.after_tree + ":\"" + file.path + "\"",
          cwd: workspace,
        });
        after = afterResult.stdout || "";
      }

      setDiffFile({ path: file.path, before, after });
    } catch (e: any) {
      console.error("[FileChangesList] Failed to load diff:", e);
    }
  };

  /**
   * Phase C：读出本会话最近跑过的**验证命令**（测试/类型检查/构建/lint）。
   *
   * 口径如实：记录不绑定具体轮次（工具执行在 agent 循环里、turn 边界在跟踪器里，
   * 两处没有共享计数器）⇒ 标题写「最近检查」而不是「本轮检查」。
   * 没有记录时明确说「没有检查记录」，不画一个看起来正常的空块。
   *
   * ⚠️ 这两个 hook 必须在下面 `if (records.length === 0) return …` **之前**：
   * hooks 顺序不能随渲染分支变化（否则 React 会抛 "change in the order of Hooks"）。
   */
  const refreshChecks = useCallback(() => {
    try {
      setChecks(listVerificationChecks(sessionId));
    } catch {
      setChecks([]);
    }
  }, [sessionId]);

  useEffect(() => {
    refreshChecks();
  }, [refreshChecks, records.length]);

  if (records.length === 0) {
    return (
      <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: 'var(--fs-sm)', textAlign: "center" }}>
        <GitBranch className="icon-lg" style={{ opacity: 0.3, marginBottom: 8 }} />
        {/*
         * 读不到 ≠ 没有 ✓（第 269 波）：以前两种情况都显示"暂无文件变更记录"✗，
         * 而真机上恰恰是"读不到"那一半（镜像被拒载 ✗）—— 用户看到的是一个正常的空面板 ✗。
         */}
        <div>{loadError ? "文件变更记录读取失败" : "暂无文件变更记录"}</div>
        <div style={{ marginTop: 4, opacity: 0.6 }}>
          {loadError ? loadError : "Agent 执行修改后会自动记录"}
        </div>
      </div>
    );
  }

  const visibleRecords = records.filter((r) => FileChangeStorage.parseChangedFiles(r).length > 0);


  /**
   * Phase C：**最近一轮**单独置于顶部（历史轮次仍在下面）。
   *
   * "最近"取 `turn_index` 最大的那条（不是数组第一项 —— 读回来的顺序是存储实现细节，
   * 拿它当"最新"就是把实现细节当契约）。
   */
  const latest = [...visibleRecords].sort((a, b) => b.turn_index - a.turn_index)[0] ?? null;
  const latestFiles = latest ? FileChangeStorage.parseChangedFiles(latest) : [];
  /** 汇总只对**有 numstat 的文件**求和；一个都没有时显示「—」（不把"不知道"画成 +0 −0） */
  const withStats = latestFiles.filter((f) => typeof f.additions === "number" || typeof f.deletions === "number");
  const totalAdd = withStats.reduce((n, f) => n + (f.additions ?? 0), 0);
  const totalDel = withStats.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const hasTotals = withStats.length > 0;

  return (
    <div className="file-changes-list">
      {latest && (
        <section className="inspector-latest" aria-label="最近一轮改动">
          <div className="inspector-latest-head">
            <span className="inspector-latest-title">最近一轮</span>
            <span className="inspector-latest-turn">第 {latest.turn_index} 轮</span>
            <span className="inspector-latest-stats">
              {hasTotals ? (
                <>
                  <span className="diff-stat-add">+{totalAdd}</span>{" "}
                  <span className="diff-stat-del">−{totalDel}</span>
                </>
              ) : (
                <span className="inspector-stats-unknown" title="这次改动没有逐行统计（二进制或旧记录）">
                  +— −—
                </span>
              )}
            </span>
            <span className="inspector-latest-count">{latestFiles.length} 个文件</span>
          </div>

          <div className="inspector-file-rows" role="list">
            {latestFiles.map((file, i) => (
              <button
                key={i}
                type="button"
                role="listitem"
                className="inspector-file-row"
                onClick={() => handleViewDiff(latest, file)}
                title={file.path}
              >
                <FileText className="icon-xs change-file-icon" />
                <span className="inspector-file-path">{file.path}</span>
                <span
                  className={gitStatusClass(file.status)}
                >
                  {file.status}
                </span>
                <span className="inspector-file-stat diff-stat-add">
                  {typeof file.additions === "number" ? `+${file.additions}` : "+—"}
                </span>
                <span className="inspector-file-stat diff-stat-del">
                  {typeof file.deletions === "number" ? `−${file.deletions}` : "−—"}
                </span>
              </button>
            ))}
          </div>

          <div className="inspector-checks">
            <div className="inspector-checks-title">最近检查</div>
            {checks.length === 0 ? (
              <div className="inspector-checks-empty empty-hint">
                本轮没有检查记录（未运行测试 / 类型检查 / 构建）
              </div>
            ) : (
              <ul className="inspector-check-list">
                {checks.slice(0, 5).map((c, i) => (
                  <li key={i} className={c.ok ? "inspector-check ok" : "inspector-check failed"}>
                    <span className="inspector-check-dot" aria-hidden="true" />
                    <code className="inspector-check-cmd" title={c.command}>
                      {c.command.length > 60 ? `${c.command.slice(0, 60)}…` : c.command}
                    </code>
                    <span className="inspector-check-verdict">{c.ok ? "通过" : "失败"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            className="revert-btn"
            onClick={(e) => { e.stopPropagation(); handleRevert(latest); }}
            disabled={latest.status === "reverted"}
            title="回滚最近一轮的变更"
          >
            <RotateCcw className="icon-xs" /> 回滚本轮
          </button>
        </section>
      )}

      {visibleRecords.length > 0 && <div className="inspector-history-title">历史轮次</div>}

      {visibleRecords.map((record) => {
        const files = FileChangeStorage.parseChangedFiles(record);
        const isExpanded = expandedTurn === record.id;
        const isReverted = record.status === "reverted";

        return (
          <div key={record.id} className={isReverted ? "turn-change-group reverted" : "turn-change-group"}>
            <div
              className="turn-change-header"
              onClick={() => setExpandedTurn(isExpanded ? null : record.id)}
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="turn-label">
                第 {record.turn_index} 轮
                {isReverted && <span className="reverted-tag">已回滚</span>}
              </span>
              <span className="turn-file-count">{files.length} 个文件</span>
            </div>
            {isExpanded && (
              <div className="turn-change-files">
                <div className="turn-brief">
                  本轮改动 {files.length} 个文件
                  {patchPreview?.id === record.id && (
                    <>
                      {" · "}
                      <span className="diff-stat-add">+{patchPreview.add}</span>
                      {" "}
                      <span className="diff-stat-del">−{patchPreview.del}</span>
                    </>
                  )}
                </div>
                {patchPreview?.id === record.id && patchPreview.lines.length > 0 && (
                  <pre className="turn-diff-preview">
                    {patchPreview.lines.map((line, i) => (
                      <span key={i} className={line.startsWith("+") ? "diff-line-add" : "diff-line-del"}>
                        {line}{"\n"}
                      </span>
                    ))}
                  </pre>
                )}
                {files.map((file, i) => (
                  <div key={i} className="change-file-row" onClick={() => handleViewDiff(record, file)}>
                    <FileText size={12} className="change-file-icon" />
                    <span className="change-file-path" title={file.path}>
                      {file.path.split(/[/\\]/).pop()}
                    </span>
                    <span
                      className={gitStatusClass(file.status)}
                    >
                      {file.status}
                    </span>
                  </div>
                ))}
                <button
                  className="revert-btn"
                  onClick={(e) => { e.stopPropagation(); handleRevert(record); }}
                  disabled={isReverted}
                  title="回滚此轮变更"
                >
                  <RotateCcw size={12} /> 回滚
                </button>
              </div>
            )}
          </div>
        );
      })}

      {diffFile && (
        <div className="diff-viewer-overlay" onClick={() => setDiffFile(null)}>
          <div className="diff-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <DiffViewer
              filePath={diffFile.path}
              before={diffFile.before}
              after={diffFile.after}
              onClose={() => setDiffFile(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
