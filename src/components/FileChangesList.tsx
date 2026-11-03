/**
 * FileChangesList（桌面适配器）—— 展示层是共享的 `packages/ui/src/changes-list.tsx`。
 *
 * ## 本文件只剩桌面的三件事
 *
 * 1. **取数**：`FileChangeStorage.loadBySession()`（按需查询 + 有界一屏，不含 patch）；
 * 2. **打开 diff**：用记录里的 before/after tree 跑 `git show <tree>:<path>`，
 *    交给桌面 `DiffViewer`（共享组件只发 `onOpenFile(change, file)`，不内置 diff 视图）；
 * 3. **桌面独有能力**：回滚（`FileChangeTracker.revert`，带确认）+ 「最近检查」区块。
 *
 * 行 DOM / 空态 / 统计口径 / "最近一轮"全在共享组件里 —— 手机与桌面是同一份实现，
 * 不存在第二套变更列表。
 */

import { useState, useEffect, useCallback } from "react";

import {
  FileChangeStorage,
  toTurnChangesView,
  parseChangedFilesResult,
  type TurnFileChangeRecord,
} from "../core/storage/file-change-storage";
import { FileChangeTracker, onFileChangesTracked } from "../core/environment/file-change-tracker";
import { runGitCommand } from "../core/command-api";
import { DiffViewer } from "./DiffViewer";
import { confirmDialog } from "../core/ui/native-dialog";
import { listVerificationChecks, type VerificationCheck } from "../core/environment/verification-checks";
import { ChangesList } from "../../packages/ui/src/changes-list";
import type { ChangedFileView, TurnChangesView } from "../../packages/protocol/src/index";

interface FileChangesListProps {
  sessionId: string;
  workspace: string;
}

export function FileChangesList({ sessionId, workspace }: FileChangesListProps) {
  const [records, setRecords] = useState<TurnFileChangeRecord[]>([]);
  /** 读失败 ≠ 没有记录（第 269 波）：两者必须显示不同文案 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffFile, setDiffFile] = useState<{ path: string; before: string; after: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  /** Phase C：本会话最近的验证命令结果（设置面读取，同步、有界） */
  const [checks, setChecks] = useState<VerificationCheck[]>([]);

  /**
   * 按需查询本会话的一屏记录（**不含 patch 正文**）。
   *
   * 失败不许吞成空：空列表与"读不到"是两件事，后者要如实显示。
   */
  const loadRecords = useCallback(() => {
    let alive = true;
    FileChangeStorage.loadBySession(sessionId)
      .then((list) => {
        if (!alive) return;
        setRecords(list);
        setLoadError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        console.warn("[FileChangesList] 读取本会话文件变更失败:", e);
        setRecords([]);
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    const cancel = loadRecords();
    const unsub = onFileChangesTracked(() => loadRecords());
    return () => {
      cancel();
      unsub();
    };
  }, [loadRecords]);

  /**
   * Phase C：读出本会话最近跑过的**验证命令**（测试/类型检查/构建/lint）。
   *
   * 口径如实：记录不绑定具体轮次 ⇒ 标题写「最近检查」而不是「本轮检查」。
   * 没有记录时明确说「没有检查记录」，不画一个看起来正常的空块。
   */
  useEffect(() => {
    try {
      setChecks(listVerificationChecks(sessionId));
    } catch {
      setChecks([]);
    }
  }, [sessionId, records.length]);

  const recordById = useCallback(
    (id: string): TurnFileChangeRecord | undefined => records.find((r) => r.id === id),
    [records],
  );

  /**
   * 桌面 diff：before/after tree + `git show <tree>:<path>`。
   *
   * 走 `command-api`（与追踪器同一条命令通道）：`core.quotepath=false` 让中文路径
   * 不再被转义成 `"\346…"`，否则 `git show` 必然找不到文件。
   */
  const handleOpenFile = useCallback(
    async (change: TurnChangesView, file: ChangedFileView): Promise<void> => {
      const record = recordById(change.changeId);
      if (!record) return;
      setDiffError(null);
      try {
        let before = "";
        let after = "";
        const status = file.status;
        if (record.before_tree && status !== "A") {
          const got = await runGitCommand(workspace, ["show", `${record.before_tree}:${file.path}`]);
          if ((got.exitCode ?? -1) === 0) before = got.stdout;
          else throw new Error(got.stderr.trim() || `git show 退出码 ${got.exitCode}`);
        }
        if (record.after_tree && status !== "D") {
          const got = await runGitCommand(workspace, ["show", `${record.after_tree}:${file.path}`]);
          if ((got.exitCode ?? -1) === 0) after = got.stdout;
          else throw new Error(got.stderr.trim() || `git show 退出码 ${got.exitCode}`);
        }
        setDiffFile({ path: file.path, before, after });
      } catch (e) {
        console.error("[FileChangesList] 读取文件快照失败:", e);
        setDiffError(e instanceof Error ? e.message : String(e));
      }
    },
    [recordById, workspace],
  );

  /**
   * 回滚（仅桌面）：确认框里把**文件清单**说清。
   *
   * `FileChangeTracker.revert` 做的是"反向打补丁 + 删除本轮新建且仍未被跟踪的文件"，
   * 同样是动用户工作区文件，所以必须确认。
   */
  const handleRevert = useCallback(
    async (change: TurnChangesView): Promise<void> => {
      const record = recordById(change.changeId);
      if (!record) return;
      const files = parseChangedFilesResult(record).files;
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
      // ⚠️ 必须 `await`：dialog 插件把 `window.confirm` 换成了异步调用，返回值是 Promise
      if (!(await confirmDialog(msg))) return;

      const ok = await FileChangeTracker.revert(record.id, workspace);
      if (ok) loadRecords();
    },
    [recordById, workspace, loadRecords],
  );

  return (
    <>
      {diffError ? (
        <div className="file-changes-error-banner" role="alert">
          无法读取该文件的快照：{diffError}
        </div>
      ) : null}
      <ChangesList
        records={records.map(toTurnChangesView)}
        loading={loading}
        error={loadError}
        supported
        hasMore={false}
        capabilities={{ revert: true, checks: true }}
        checks={checks.map((c: VerificationCheck) => ({ command: c.command, ok: c.ok }))}
        onOpenFile={(change, file) => void handleOpenFile(change, file)}
        onRevert={(change) => void handleRevert(change)}
      />
      {diffFile ? (
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
      ) : null}
    </>
  );
}

