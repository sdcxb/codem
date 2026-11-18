/**
 * Hub 皮肤布局
 * - 顶部导航栏 + 左侧栏 + 主面板 + 右侧栏（三栏布局）
 * - 深色科技感（Batch 6A 起 accent 统一为琥珀）
 *
 * Batch 1A：右栏改为可由外部传入（`rightRail`）。
 * 迁移前三套皮肤里，hub 的右栏由本组件**自己**渲染，而 dream/default 的右栏由 `App` 渲染，
 * 两处入参不同（hub 少传 `sessionId` / `workspace` / `agents`）—— 同一块面板在 hub 下少了三样数据。
 * 现在由 `App` 统一构造后传入；不传时仍回落到旧行为（本组件自渲染），
 * 以免影响直接使用 `HubLayout` 的调用方。
 */

import type { ReactNode } from "react";
import { TopNavbar } from "./TopNavbar";
import { RightSidebar } from "./RightSidebar";

interface HubLayoutProps {
  sidebar: ReactNode;
  mainPanel: ReactNode;
  /** 右栏节点（由 App 统一构造，入参与 dream/default 完全一致） */
  rightRail?: ReactNode;
  rightRailOpen?: boolean;
  onToggleRightRail?: () => void;
  onTasks?: () => void;
  onSkills?: () => void;
  onNotebooks?: () => void;
  onTaskCenter?: () => void;
  onNewChat?: () => void;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onGitHubClone?: () => void;
  onOpenSession?: (sessionId: string, projectId: string) => void;
  editingFile?: string | null;
  onEditingFileChange?: (path: string | null) => void;
  refreshKey?: number;
}

export function HubLayout({
  sidebar,
  mainPanel,
  rightRail,
  rightRailOpen = true,
  onToggleRightRail,
  onTasks,
  onSkills,
  onNotebooks,
  onTaskCenter,
  onNewChat,
  onNewProject,
  onImportProject,
  onGitHubClone,
  onOpenSession,
  editingFile,
  onEditingFileChange,
  refreshKey,
}: HubLayoutProps) {
  return (
    <div className="hub-app">
      <TopNavbar
        onTasks={onTasks}
        onSkills={onSkills}
        onNotebooks={onNotebooks}
        onTaskCenter={onTaskCenter}
      />
      <div className="hub-body">
        <div className="hub-sidebar-wrapper">{sidebar}</div>
        <div className="hub-main-wrapper">{mainPanel}</div>
        {rightRail ?? (
          <RightSidebar
            collapsed={!rightRailOpen}
            onToggleCollapse={onToggleRightRail}
            onNewChat={onNewChat}
            onNewProject={onNewProject}
            onImportProject={onImportProject}
            onGitHubClone={onGitHubClone}
            onOpenSession={onOpenSession}
            editingFile={editingFile}
            onEditingFileChange={onEditingFileChange}
            refreshKey={refreshKey}
          />
        )}
      </div>
    </div>
  );
}
