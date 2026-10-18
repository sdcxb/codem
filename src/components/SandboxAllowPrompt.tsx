/**
 * 沙箱允许目录提示条（交接正文里的绝对路径在工作区外时出现）。
 *
 * 数据来源只有一处：`handoff-sandbox.requestSandboxAllowlist()` 派发的
 * `codem-sandbox-allow-request` 事件（交接工具/横幅都会调）。
 *
 * ⚠️ 这个提示**绝不自动放行**：用户必须点「加入允许目录」，加入的是**目录**（不是文件），
 * 而且可以随时在设置里移除（`removeSandboxAllowedDir`）。判据 `ALLOW-4/5`。
 */
import { useEffect, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import {
  SANDBOX_ALLOW_REQUEST_EVENT,
  outsideWorkspacePaths,
} from "../core/session/handoff-sandbox";
import { addSandboxAllowedDirs } from "../core/sandbox/sandbox-acl";
import { useLang } from "../core/i18n/lang";

/** 把文件路径收缩成"所在目录"（提示条加的是目录，不是单个文件） */
function dirsOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const raw of paths) {
    const p = String(raw ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const idx = p.lastIndexOf("/");
    if (idx > 0) dirs.add(p.slice(0, idx));
  }
  return [...dirs];
}

export function SandboxAllowPrompt() {
  const lang = useLang();
  const zh = lang === "zh";
  const [paths, setPaths] = useState<string[]>([]);
  const [added, setAdded] = useState<string[] | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ paths?: string[] }>).detail;
      const next = Array.isArray(detail?.paths) ? detail!.paths!.filter(Boolean) : [];
      if (next.length === 0) return;
      setAdded(null);
      setPaths(next);
    };
    window.addEventListener(SANDBOX_ALLOW_REQUEST_EVENT, onRequest as EventListener);
    return () => window.removeEventListener(SANDBOX_ALLOW_REQUEST_EVENT, onRequest as EventListener);
  }, []);

  if (paths.length === 0 && !added) return null;

  if (added) {
    return (
      <div className="sandbox-allow-prompt is-done" role="status" data-testid="sandbox-allow-done">
        <span className="sandbox-allow-title">
          {zh
            ? `已加入允许目录：${added.join("、")}`
            : `Added to sandbox allowlist: ${added.join(", ")}`}
        </span>
        <div className="sandbox-allow-actions">
          <button type="button" className="sandbox-allow-btn" onClick={() => setAdded(null)}>
            {zh ? "好" : "OK"}
          </button>
        </div>
      </div>
    );
  }

  const dirs = dirsOf(paths);

  return (
    <div className="sandbox-allow-prompt" role="status" aria-live="polite" data-testid="sandbox-allow-prompt">
      <span className="sandbox-allow-title">
        {zh
          ? `交接正文里的这些路径在工作区外，读不到：${paths.length} 个`
          : `${paths.length} path(s) in the handover are outside the workspace and unreadable`}
      </span>
      <details className="sandbox-allow-details">
        <summary className="sandbox-allow-summary">{zh ? "查看路径" : "Show paths"}</summary>
        <ul className="sandbox-allow-list">
          {paths.slice(0, 12).map((p) => (
            <li key={p} className="sandbox-allow-item" title={p}>
              {p}
            </li>
          ))}
          {paths.length > 12 && (
            <li className="sandbox-allow-item">… (+{paths.length - 12})</li>
          )}
        </ul>
      </details>
      <div className="sandbox-allow-actions">
        <button
          type="button"
          className="sandbox-allow-btn is-primary"
          onClick={() => {
            const dirsToAdd = dirsOf(outsideWorkspacePaths(paths, null, []));
            const didAdd = addSandboxAllowedDirs(dirsToAdd);
            setPaths([]);
            setAdded(didAdd.length > 0 ? didAdd : dirsToAdd);
            window.dispatchEvent(new Event("codem-settings-changed"));
          }}
          title={zh ? `把 ${dirs.join("、")} 加入沙箱允许目录` : `Allow ${dirs.join(", ")}`}
        >
          <FolderPlus className="icon-sm" aria-hidden="true" />
          {zh ? "加入允许目录" : "Allow these folders"}
        </button>
        <button
          type="button"
          className="sandbox-allow-btn"
          onClick={() => setPaths([])}
          aria-label={zh ? "忽略这次提示" : "Dismiss"}
        >
          <X className="icon-sm" aria-hidden="true" />
          {zh ? "忽略" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
