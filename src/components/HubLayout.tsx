/**
 * Hub 皮肤布局
 * - 顶部导航栏 + 左侧栏 + 主面板 + 右侧栏（三栏布局）
 * - 深色科技感，橙色强调色
 */

import type { ReactNode } from "react";
import { TopNavbar } from "./TopNavbar";
import { RightSidebar } from "./RightSidebar";

interface HubLayoutProps {
  sidebar: ReactNode;
  mainPanel: ReactNode;
  onTasks?: () => void;
  onSkills?: () => void;
  onNotebooks?: () => void;
  onAutomations?: () => void;
  onSearch?: () => void;
  onSettings?: () => void;
  onNewChat?: () => void;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onGitHubClone?: () => void;
  onOpenSession?: (sessionId: string, projectId: string) => void;
}

export function HubLayout({
  sidebar,
  mainPanel,
  onTasks,
  onSkills,
  onNotebooks,
  onAutomations,
  onSearch,
  onSettings,
  onNewChat,
  onNewProject,
  onImportProject,
  onGitHubClone,
  onOpenSession,
}: HubLayoutProps) {
  return (
    <div className="hub-app">
      <TopNavbar
        onTasks={onTasks}
        onSkills={onSkills}
        onNotebooks={onNotebooks}
        onAutomations={onAutomations}
        onSearch={onSearch}
        onSettings={onSettings}
      />
      <div className="hub-body">
        <div className="hub-sidebar-wrapper">{sidebar}</div>
        <div className="hub-main-wrapper">{mainPanel}</div>
        <RightSidebar
          onNewChat={onNewChat}
          onNewProject={onNewProject}
          onImportProject={onImportProject}
          onGitHubClone={onGitHubClone}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}
