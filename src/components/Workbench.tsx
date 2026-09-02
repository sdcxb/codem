/**
 * Workbench — Code workbench + lightweight Overview
 *
 * Upgraded from simple tool/file display to include:
 *   - Status: currently executing tools, waiting items
 *   - Capacity: task queue time, backlog
 *   - Activity: execution timeline
 *
 * Key principle (from CodexLoom article): Signal is not Diagnosis.
 * Metrics are investigation entry points, not performance ratings.
 */

import { memo, useState, useEffect } from "react";
import { useLang, S } from "../core/i18n/lang";
import { onFileChangesTracked, type FileChangeResult } from "../core/environment/file-change-tracker";
import { ActionIcons } from "../core/icons/icon-map";

interface WorkbenchProps {
  collapsed: boolean;
  onToggle: () => void;
  activeTools: Array<{ name: string; status: string }>;
  modifiedFiles: Array<{ path: string; additions: number; deletions: number }>;
}

interface ActivityEntry {
  turnIndex: number;
  fileCount: number;
  timestamp: number;
  artifactId: string;
}

export const Workbench = memo(function Workbench({
  collapsed,
  onToggle,
  activeTools,
  modifiedFiles,
}: WorkbenchProps) {
  const lang = useLang();
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [activeView, setActiveView] = useState<"status" | "capacity" | "activity">("status");
  const CloseIcon = ActionIcons.close;

  // Listen for file change events → add to activity timeline
  useEffect(() => {
    const unsubscribe = onFileChangesTracked((result: FileChangeResult) => {
      setActivities((prev) => [
        ...prev.slice(-19), // Keep last 20
        {
          turnIndex: prev.length + 1,
          fileCount: result.changedFiles.length,
          timestamp: Date.now(),
          artifactId: result.artifactId,
        },
      ]);
    });
    return unsubscribe;
  }, []);

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
        <button className="workbench-toggle" onClick={onToggle}><CloseIcon size={18} /></button>
      </div>

      {/* View tabs */}
      <div className="workbench-view-tabs">
        <button
          className={"workbench-view-tab" + (activeView === "status" ? " active" : "")}
          onClick={() => setActiveView("status")}
        >
          状态
        </button>
        <button
          className={"workbench-view-tab" + (activeView === "capacity" ? " active" : "")}
          onClick={() => setActiveView("capacity")}
        >
          容量
        </button>
        <button
          className={"workbench-view-tab" + (activeView === "activity" ? " active" : "")}
          onClick={() => setActiveView("activity")}
        >
          活动
        </button>
      </div>

      {/* Status view */}
      {activeView === "status" && (
        <div className="workbench-section">
          {activeTools.length > 0 && (
            <>
              <h4>{S.workbench.activeTools[lang]}</h4>
              {activeTools.map((tool, index) => (
                <div key={index} className={"workbench-item tool-" + tool.status}>
                  {tool.name}
                </div>
              ))}
            </>
          )}
          {activeTools.length === 0 && (
            <div className="workbench-empty">当前无执行中的工具</div>
          )}
        </div>
      )}

      {/* Capacity view — modified files + summary */}
      {activeView === "capacity" && (
        <div className="workbench-section">
          {modifiedFiles.length > 0 ? (
            <>
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
            </>
          ) : (
            <div className="workbench-empty">暂无修改文件</div>
          )}
        </div>
      )}

      {/* Activity view — execution timeline */}
      {activeView === "activity" && (
        <div className="workbench-section">
          <h4>变更时间线</h4>
          {activities.length > 0 ? (
            activities.map((entry, i) => (
              <div key={i} className="workbench-activity-entry">
                <span className="activity-turn">Turn {entry.turnIndex}</span>
                <span className="activity-files">{entry.fileCount} 文件变更</span>
                <span className="activity-time">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          ) : (
            <div className="workbench-empty">暂无活动记录</div>
          )}
        </div>
      )}

      {/* Signal is not Diagnosis notice */}
      <div className="workbench-disclaimer">
        指标仅作为调查入口，不等于诊断
      </div>
    </div>
  );
});

