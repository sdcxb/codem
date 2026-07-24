/**
 * Hub 皮肤 - 右侧栏
 * 1. 无项目无对话时：显示新手引导任务
 * 2. 有项目有对话时：显示最新对话和任务
 * 3. 支持隐私隐藏（不在右侧栏显示）
 * 4. 支持收缩/展开
 */

import { useState, useEffect } from "react";
import { useLang } from "../core/i18n/lang";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import * as SessionStorage from "../core/storage/session";
import type { Session } from "../core/types";
import { GitInfoPanel } from "./GitInfoPanel";

interface HubRightSidebarProps {
  onNewChat?: () => void;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onGitHubClone?: () => void;
  onOpenSession?: (sessionId: string, projectId: string) => void;
}

export function RightSidebar({ onNewChat, onNewProject, onImportProject, onGitHubClone, onOpenSession }: HubRightSidebarProps) {
  const lang = useLang();
  const [collapsed, setCollapsed] = useState(false);
  const { messages, isStreaming, activeSessions } = useAppStore();
  const { projects, currentProject } = useProjectStore();

  // 获取所有项目的最近会话
  const [recentSessions, setRecentSessions] = useState<Session[]>([]);
  // 隐藏的会话 ID 集合（隐私功能）
  const [hiddenSessions, setHiddenSessions] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("hub-hidden-sessions");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    // 收集所有项目的最近会话
    const allSessions: Session[] = [];
    for (const project of projects) {
      const sessions = SessionStorage.listSessions(project.id);
      allSessions.push(...sessions);
    }
    // 按最后消息时间排序，取最近 5 条
    allSessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    setRecentSessions(allSessions.slice(0, 5));
  }, [projects]);

  // 保存隐藏列表
  const toggleHideSession = (sessionId: string) => {
    const newSet = new Set(hiddenSessions);
    if (newSet.has(sessionId)) {
      newSet.delete(sessionId);
    } else {
      newSet.add(sessionId);
    }
    setHiddenSessions(newSet);
    localStorage.setItem("hub-hidden-sessions", JSON.stringify([...newSet]));
  };

  // 当前任务
  const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant");
  const currentTask = lastAssistantMsg
    ? (lastAssistantMsg as any).content?.slice(0, 80) || (lang === "zh" ? "处理中..." : "Processing...")
    : lang === "zh" ? "空闲" : "Idle";

  // 判断是否为新手（无项目且无对话）
  const hasProjects = projects.length > 0;
  const hasMessages = messages.length > 0;
  const isNewUser = !hasProjects && !hasMessages;

  // 过滤掉隐藏的会话
  const visibleSessions = recentSessions.filter((s) => !hiddenSessions.has(s.id));

  // Get active sessions for the active tasks panel
  const activeSessionsList = visibleSessions.filter(s => activeSessions.has(s.id));

  // 收缩状态
  if (collapsed) {
    return (
      <aside className="hub-right-sidebar hub-right-sidebar-collapsed">
        <button
          className="hub-sidebar-toggle hub-sidebar-toggle-collapsed"
          onClick={() => setCollapsed(false)}
          title={lang === "zh" ? "展开右侧栏" : "Expand sidebar"}
        >
          <i className="fas fa-chevron-left" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hub-right-sidebar">
      {/* 收缩按钮 */}
      <button
        className="hub-sidebar-toggle hub-sidebar-toggle-open"
        onClick={() => setCollapsed(true)}
        title={lang === "zh" ? "收起右侧栏" : "Collapse sidebar"}
      >
        <i className="fas fa-chevron-right" />
      </button>

      {/* Agent 状态卡片 */}
      <div className="hub-agent-card">
        <div style={{ textAlign: "left", marginBottom: "16px", fontWeight: 500, color: "var(--hub-text-main)" }}>
          {lang === "zh" ? "正在工作的 Agent" : "Active Agent"}
        </div>
        <div className="hub-agent-image">
          <i className="fas fa-robot" style={{ color: "#333", fontSize: "80px" }} />
          <div style={{ position: "absolute", top: "35%", display: "flex", flexDirection: "column", gap: "4px", alignItems: "center" }}>
            <span style={{ color: "var(--hub-color-primary)", fontSize: "18px", fontWeight: "bold", background: "#000", padding: "2px 8px", borderRadius: "4px" }}>
              {">"} _
            </span>
          </div>
        </div>
        <div className="hub-agent-info">
          <p>
            <span className="hub-status-dot" /> codem {lang === "zh" ? "在线" : "Online"}
          </p>
          <p style={{ color: "var(--hub-text-muted)", marginTop: "8px", fontSize: "12px" }}>
            {isStreaming
              ? (lang === "zh" ? "正在执行: " : "Executing: ") + currentTask
              : (lang === "zh" ? "就绪" : "Ready")}
          </p>
        </div>
      </div>

      {/* Git 环境信息面板 */}
      {currentProject && (
        <div className="hub-git-info-panel" style={{ padding: "8px 12px", borderBottom: "1px solid var(--hub-border)" }}>
          <GitInfoPanel />
        </div>
      )}

      {/* 活跃任务面板 */}
      {activeSessionsList.length > 0 && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--hub-border)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--hub-text-main)", marginBottom: 6 }}>
            ⚡ {lang === "zh" ? "活跃任务" : "Active Tasks"} ({activeSessionsList.length})
          </div>
          {activeSessionsList.map(s => (
            <div
              key={s.id}
              onClick={() => onOpenSession?.(s.id, s.projectId)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 6px", borderRadius: 4, cursor: "pointer",
                background: "var(--hub-bg-card)", marginBottom: 4, fontSize: 11,
              }}
            >
              <span className="session-running-dot" />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title}
              </span>
              {s.executionMode === "git_worktree" && <span style={{ fontSize: 10 }}>🌲</span>}
            </div>
          ))}
        </div>
      )}

      {/* 新手引导（无项目无对话时） */}
      {isNewUser && (
        <div className="hub-onboarding">
          <div className="hub-tasks-header">
            <h3>
              <i className="fas fa-rocket" style={{ color: "var(--hub-color-primary)", marginRight: "6px" }} />
              {lang === "zh" ? "快速开始" : "Quick Start"}
            </h3>
          </div>
          <div className="hub-task-list">
            <div className="hub-task-item hub-onboarding-item" onClick={onNewChat} style={{ cursor: "pointer" }}>
              <div className="hub-task-icon hub-task-icon-blue">
                <i className="fas fa-comments" />
              </div>
              <div className="hub-task-content">
                <h4>{lang === "zh" ? "开始聊天对话" : "Start a chat"}</h4>
                <div className="hub-task-tags">
                  <span>{lang === "zh" ? "推荐" : "Recommended"}</span>
                </div>
              </div>
            </div>
            <div className="hub-task-item hub-onboarding-item" onClick={onNewProject} style={{ cursor: "pointer" }}>
              <div className="hub-task-icon hub-task-icon-green">
                <i className="fas fa-folder-plus" />
              </div>
              <div className="hub-task-content">
                <h4>{lang === "zh" ? "新建项目" : "Create a project"}</h4>
                <div className="hub-task-tags">
                  <span>{lang === "zh" ? "项目管理" : "Projects"}</span>
                </div>
              </div>
            </div>
            <div className="hub-task-item hub-onboarding-item" onClick={onImportProject} style={{ cursor: "pointer" }}>
              <div className="hub-task-icon hub-task-icon-orange">
                <i className="fas fa-file-import" />
              </div>
              <div className="hub-task-content">
                <h4>{lang === "zh" ? "导入项目" : "Import a project"}</h4>
                <div className="hub-task-tags">
                  <span>{lang === "zh" ? "从本地" : "From local"}</span>
                </div>
              </div>
            </div>
            <div className="hub-task-item hub-onboarding-item" onClick={onGitHubClone} style={{ cursor: "pointer" }}>
              <div className="hub-task-icon hub-task-icon-purple">
                <i className="fab fa-github" />
              </div>
              <div className="hub-task-content">
                <h4>{lang === "zh" ? "从 GitHub 拉取" : "Clone from GitHub"}</h4>
                <div className="hub-task-tags">
                  <span>Git</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 最新对话和任务（有项目有对话时） */}
      {!isNewUser && (
        <div className="hub-recent">
          <div className="hub-tasks-header">
            <h3>
              <i className="fas fa-clock-rotate-left" style={{ color: "var(--hub-color-primary)", marginRight: "6px" }} />
              {lang === "zh" ? "最近对话" : "Recent Chats"}
            </h3>
          </div>

          {visibleSessions.length === 0 ? (
            <div style={{ color: "var(--hub-text-muted)", fontSize: "13px", padding: "12px 0" }}>
              {lang === "zh" ? "暂无对话记录" : "No conversations yet"}
            </div>
          ) : (
            <div className="hub-task-list">
              {visibleSessions.map((session) => {
                const project = projects.find((p) => p.id === session.projectId);
                return (
                  <div
                    key={session.id}
                    className="hub-task-item hub-recent-item"
                    onClick={() => onOpenSession?.(session.id, session.projectId)}
                    style={{ cursor: "pointer", position: "relative" }}
                  >
                    <div className="hub-task-icon hub-task-icon-blue">
                      <i className="fas fa-comment-dots" />
                    </div>
                    <div className="hub-task-content" style={{ minWidth: 0, flex: 1 }}>
                      <h4 style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {session.title || (lang === "zh" ? "新对话" : "New Chat")}
                      </h4>
                      <div className="hub-task-tags">
                        {project && <span>{project.name}</span>}
                        <span>{session.messageCount} {lang === "zh" ? "条" : "msgs"}</span>
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--hub-text-muted)", marginTop: "4px" }}>
                        {formatTime(session.lastMessageAt, lang)}
                      </div>
                    </div>
                    {/* 隐私隐藏按钮 */}
                    <button
                      className="hub-hide-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleHideSession(session.id);
                      }}
                      title={lang === "zh" ? "不在此处显示" : "Hide from here"}
                    >
                      <i className="fas fa-eye-slash" style={{ fontSize: "11px" }} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 如果有隐藏的会话，显示恢复按钮 */}
          {hiddenSessions.size > 0 && (
            <button
              className="hub-restore-btn"
              onClick={() => {
                setHiddenSessions(new Set());
                localStorage.removeItem("hub-hidden-sessions");
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--hub-text-muted)",
                fontSize: "12px",
                cursor: "pointer",
                padding: "8px 0",
                width: "100%",
                textAlign: "center",
              }}
            >
              {lang === "zh" ? `恢复 ${hiddenSessions.size} 条隐藏对话` : `Restore ${hiddenSessions.size} hidden`}
            </button>
          )}

          {/* LLM 推荐下一步 */}
          {!isStreaming && hasMessages && (
            <>
              <div className="hub-tasks-header" style={{ marginTop: "20px" }}>
                <h3>
                  <i className="fas fa-fire" style={{ color: "var(--hub-color-primary)", marginRight: "6px" }} />
                  {lang === "zh" ? "推荐下一步" : "Recommended Next"}
                </h3>
              </div>
              <div className="hub-task-list">
                <div className="hub-task-item">
                  <div className="hub-task-icon hub-task-icon-green"><i className="fas fa-code-branch" /></div>
                  <div className="hub-task-content">
                    <h4>{lang === "zh" ? "审查代码变更" : "Review code changes"}</h4>
                    <div className="hub-task-tags"><span>{lang === "zh" ? "代码审查" : "Code Review"}</span></div>
                  </div>
                </div>
                <div className="hub-task-item">
                  <div className="hub-task-icon hub-task-icon-orange"><i className="fas fa-vial" /></div>
                  <div className="hub-task-content">
                    <h4>{lang === "zh" ? "运行测试" : "Run tests"}</h4>
                    <div className="hub-task-tags"><span>{lang === "zh" ? "测试" : "Testing"}</span></div>
                  </div>
                </div>
                <div className="hub-task-item">
                  <div className="hub-task-icon hub-task-icon-purple"><i className="fas fa-book" /></div>
                  <div className="hub-task-content">
                    <h4>{lang === "zh" ? "更新文档" : "Update docs"}</h4>
                    <div className="hub-task-tags"><span>{lang === "zh" ? "文档" : "Docs"}</span></div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 正在执行任务时 */}
          {isStreaming && (
            <>
              <div className="hub-tasks-header" style={{ marginTop: "20px" }}>
                <h3>
                  <i className="fas fa-spinner fa-spin" style={{ color: "var(--hub-color-primary)", marginRight: "6px" }} />
                  {lang === "zh" ? "当前任务" : "Current Task"}
                </h3>
              </div>
              <div className="hub-task-list">
                <div className="hub-task-item">
                  <div className="hub-task-icon hub-task-icon-blue"><i className="fas fa-clock" /></div>
                  <div className="hub-task-content">
                    <h4 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {currentTask}
                    </h4>
                    <div className="hub-task-tags">
                      <span>{lang === "zh" ? "执行中" : "Running"}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** 格式化时间 */
function formatTime(timestamp: number, lang: string): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (lang === "zh") {
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
  } else {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 24) return `${hours} hr ago`;
    if (days < 7) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString("en-US");
  }
}
