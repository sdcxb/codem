/**
 * Workbench — 代码工作台（Git diff + 文件树）
 *
 * 浮动侧边栏，实时显示工具执行状态、Git diff、文件树、提交统计
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface WorkbenchProps {
  /** Whether workbench is collapsed */
  collapsed: boolean;
  /** Toggle collapse state */
  onToggle: () => void;
  /** Currently executing tools */
  activeTools: Array<{ name: string; status: string }>;
  /** Modified files (for Git diff) */
  modifiedFiles: Array<{ path: string; additions: number; deletions: number }>;
}

export const Workbench = memo(function Workbench({
  collapsed,
  onToggle,
  activeTools,
  modifiedFiles,
}: WorkbenchProps) {
  const lang = useLang();

  if (collapsed) {
    return (
      <button className="workbench-toggle collapsed" onClick={onToggle}>
        {S.workbench.expand[lang]}
      </button>
    );
  }

  const totalAdditions = modifiedFiles.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = modifiedFiles.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div className="workbench">
      <div className="workbench-header">
        <span>{S.workbench.title[lang]}</span>
        <button className="workbench-toggle" onClick={onToggle}>
          ✕
        </button>
      </div>

      {/* Active Tools */}
      {activeTools.length > 0 && (
        <div className="workbench-section">
          <h4>{S.workbench.activeTools[lang]}</h4>
          {activeTools.map((tool, index) => (
            <div key={index} className={`workbench-item tool-${tool.status}`}>
              {tool.name}
            </div>
          ))}
        </div>
      )}

      {/* Modified Files */}
      {modifiedFiles.length > 0 && (
        <div className="workbench-section">
          <h4>{S.workbench.modifiedFiles[lang]}</h4>
          <div className="workbench-summary">
            <span className="additions">+{totalAdditions}</span>
            <span className="deletions">-{totalDeletions}</span>
          </div>
          {modifiedFiles.map((file, index) => (
            <div key={index} className="workbench-file">
              <span className="file-path">{file.path}</span>
              <span className="file-stats">
                <span className="additions">+{file.additions}</span>
                <span className="deletions">-{file.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});