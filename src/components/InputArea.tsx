import { useState, useRef, useEffect, useCallback } from "react";
import { MessageAttachment } from "../store";
import { FileUpload } from "./FileUpload";
import { useLang, S } from "../core/i18n/lang";
import type { CollaborationMode } from "../core/agent/agent";
import { SECURITY_MODES, getEffectiveSecurityMode, setProjectSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { getSkillRegistry } from "../core/skill/skill";
import { getSettingJSON } from "../core/storage/settings";
import { getCustomOperations, runCustomOperation, getProjectExecutionMode, setProjectExecutionMode, getCurrentBranch, listBranches, isGitRepo, type ExecutionMode } from "../core/environment";
import type { CustomOperation } from "../core/settings/settings";
import { SlashCommandMenu, type SlashCommandItem } from "./SlashCommandMenu";
import { useProjectStore } from "../core/store";

interface InputAreaProps {
onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
onCancel: () => void;
disabled: boolean;
isStreaming: boolean;
/** No session selected — show "select or create session" hint */
noSession?: boolean;
  collaborationMode: CollaborationMode;
  onModeChange: (mode: CollaborationMode) => void;
  /** Project path for per-project security mode */
  projectPath?: string;
  /** #5: Quoted text from selection tooltip */
  quoteContext?: string | null;
  onClearQuote?: () => void;
}

export function InputArea({ onSend, onCancel, disabled, isStreaming, noSession, collaborationMode, onModeChange, projectPath, quoteContext, onClearQuote }: InputAreaProps) {
  const lang = useLang();
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [showSecurityPicker, setShowSecurityPicker] = useState(false);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(projectPath));
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [customOps, setCustomOps] = useState<CustomOperation[]>([]);
  const [runningOp, setRunningOp] = useState<string | null>(null);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const { currentProject, projects, openProject, createSession, switchSession, getProjectSessions } = useProjectStore();

  // === Bottom bar state (对标 wecode ProjectWorkBar) ===
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("current_workspace");
  const [currentBranchName, setCurrentBranchName] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [isGitProject, setIsGitProject] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);

  const zh = lang === "zh";

  // Load custom operations
  useEffect(() => {
    setCustomOps(getCustomOperations());
    const handler = () => setCustomOps(getCustomOperations());
    window.addEventListener("codem-settings-changed", handler);
    return () => window.removeEventListener("codem-settings-changed", handler);
  }, []);

  // Load execution mode + git info when project changes
  useEffect(() => {
    if (!projectPath) {
      setExecutionMode("current_workspace");
      setIsGitProject(false);
      setCurrentBranchName("");
      setBranches([]);
      return;
    }
    setExecutionMode(getProjectExecutionMode(projectPath));
    isGitRepo(projectPath).then(async (isRepo) => {
      setIsGitProject(isRepo);
      if (isRepo) {
        setBranchLoading(true);
        try {
          const [br, allBr] = await Promise.all([
            getCurrentBranch(projectPath),
            listBranches(projectPath),
          ]);
          setCurrentBranchName(br);
          setBranches(allBr);
        } catch {
          setCurrentBranchName("");
          setBranches([]);
        } finally {
          setBranchLoading(false);
        }
      } else {
        setCurrentBranchName("");
        setBranches([]);
      }
    });
  }, [projectPath]);

  // Listen for execution mode changes
  useEffect(() => {
    const handler = () => {
      if (projectPath) setExecutionMode(getProjectExecutionMode(projectPath));
    };
    window.addEventListener("codem-execution-mode-changed", handler);
    return () => window.removeEventListener("codem-execution-mode-changed", handler);
  }, [projectPath]);

  const refreshBranch = useCallback(async () => {
    if (!projectPath) return;
    setBranchLoading(true);
    try {
      const [br, allBr] = await Promise.all([
        getCurrentBranch(projectPath),
        listBranches(projectPath),
      ]);
      setCurrentBranchName(br);
      setBranches(allBr);
    } catch { /* ignore */ } finally {
      setBranchLoading(false);
    }
  }, [projectPath]);

  const handleRunOp = async (op: CustomOperation) => {
    if (!op.command.trim() || runningOp) return;
    setRunningOp(op.id);
    try {
      const { useProjectStore } = await import("../core/store");
      const cwd = useProjectStore.getState().currentProject?.path;
      if (!cwd) return;
      await runCustomOperation(op.id, cwd);
    } catch (e) {
      console.error("[InputArea] Custom operation failed:", e);
    } finally {
      setRunningOp(null);
    }
  };

  useEffect(() => {
    if (quoteContext) {
      const quoted = quoteContext.split("\n").map((line) => `> ${line}`).join("\n");
      setInput((prev) => prev ? `${prev}\n\n${quoted}\n\n` : `${quoted}\n\n`);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [quoteContext]);

  useEffect(() => {
    setSecurityMode(getEffectiveSecurityMode(projectPath));
  }, [projectPath]);

  useEffect(() => {
    const handler = () => setSecurityMode(getEffectiveSecurityMode(projectPath));
    window.addEventListener("codem-security-mode-changed", handler);
    return () => window.removeEventListener("codem-security-mode-changed", handler);
  }, [projectPath]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || disabled) return;
    onSend(input.trim(), pendingAttachments.length > 0 ? pendingAttachments : undefined, selectedSkills.length > 0 ? selectedSkills : undefined);
    setInput("");
    setPendingAttachments([]);
    setSelectedSkills([]);
    setSlashFilter(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const ext = file.type.split("/")[1] || "png";
      const name = `clipboard-${Date.now()}.${ext}`;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const attachment: MessageAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name, type: "image", content: dataUrl, mimeType: file.type, size: file.size,
        };
        setPendingAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = (attachments: MessageAttachment[]) => {
    setPendingAttachments((prev) => [...prev, ...attachments]);
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const cycleSecurityMode = () => {
    const modes: SecurityMode[] = ["ask", "auto", "full"];
    const currentIdx = modes.indexOf(securityMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    if (projectPath) setProjectSecurityMode(projectPath, nextMode);
    else setGlobalSecurityMode(nextMode);
    setShowSecurityPicker(false);
  };

  const selectSecurityMode = (mode: SecurityMode) => {
    if (projectPath) setProjectSecurityMode(projectPath, mode);
    else setGlobalSecurityMode(mode);
    setShowSecurityPicker(false);
  };

  const handleExecutionModeChange = async (mode: ExecutionMode) => {
    if (!projectPath) {
      setShowModeMenu(false);
      return;
    }
    // Check for uncommitted changes before switching modes
    if (isGitProject) {
      try {
        const { hasUncommittedChanges } = await import("../core/environment");
        const dirty = await hasUncommittedChanges(projectPath);
        if (dirty) {
          if (!confirm(zh
            ? "⚠️ 当前工作区有未提交的修改。切换模式可能导致修改丢失。确认切换？"
            : "⚠️ The current workspace has uncommitted changes. Switching modes may cause loss. Continue?")) {
            setShowModeMenu(false);
            return;
          }
        }
      } catch {
        // If check fails, proceed anyway
      }
    }
    setProjectExecutionMode(projectPath, mode);
    setExecutionMode(mode);
    if (mode === "git_worktree") refreshBranch();
    setShowModeMenu(false);
  };

const handleSelectProject = (projectId: string) => {
  openProject(projectId);
  // Try to open the most recently interacted session instead of always creating a new one
  const sessions = getProjectSessions(projectId);
  if (sessions.length > 0) {
    // Sort by lastMessageAt descending, pick the most recent
    const sorted = [...sessions].sort((a: any, b: any) => {
      const aTime = a.lastMessageAt || a.createdAt || 0;
      const bTime = b.lastMessageAt || b.createdAt || 0;
      return bTime - aTime;
    });
    switchSession(sorted[0].id);
  } else {
    // No existing sessions — create a new one
    createSession();
  }
  setShowProjectMenu(false);
};

  // Close all bottom-bar dropdowns
  const closeBottomMenus = useCallback(() => {
    setShowProjectMenu(false);
    setShowModeMenu(false);
    setShowBranchMenu(false);
  }, []);

  const currentModeInfo = SECURITY_MODES.find(m => m.mode === securityMode)!;

  // Whether execution mode can be changed (locked when streaming)
  const modeLocked = isStreaming;

  return (
    <div className="input-area">
      {/* Quote context banner */}
      {quoteContext && (
        <div className="quote-context-banner">
          <span className="quote-context-icon">💬</span>
          <span className="quote-context-text">{quoteContext.length > 80 ? quoteContext.substring(0, 80) + "..." : quoteContext}</span>
          <button className="quote-context-clear" onClick={() => onClearQuote?.()}>✕</button>
        </div>
      )}

      {/* Pending Attachments */}
      {pendingAttachments.length > 0 && (
        <div className="pending-attachments">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="pending-attachment">
              <span className="attachment-icon">{att.type === "image" ? "🖼️" : "📄"}</span>
              <span className="attachment-name">{att.name}</span>
              {att.size && <span className="attachment-size">{formatSize(att.size)}</span>}
              <button className="attachment-remove" onClick={() => removeAttachment(att.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* === input-wrapper: textarea + left-side controls (协作模式 + 安全模式) === */}
      <div className="input-wrapper">
        <FileUpload onUpload={handleUpload} />

        {/* Skill picker */}
        <div style={{ position: "relative" }}>
          <button
            className={`mode-toggle-btn ${selectedSkills.length > 0 ? "active" : ""}`}
            onClick={() => setShowSkillPicker(!showSkillPicker)}
            title={zh ? "选择技能" : "Select skills"}
            style={selectedSkills.length > 0 ? { background: "var(--accent)", color: "#fff" } : {}}
          >
            {selectedSkills.length > 0 ? `🎯 ${selectedSkills.length}` : "🎯"}
          </button>
          {showSkillPicker && (
            <>
              <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} onClick={() => setShowSkillPicker(false)} />
              <div className="skill-picker-popup" style={{
                position: "absolute", bottom: "100%", left: 0, marginBottom: 4,
                minWidth: 220, maxWidth: 320, zIndex: 100, maxHeight: 300, overflowY: "auto",
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>
                  {zh ? "选择技能（本次消息）" : "Select skills (this message)"}
                </div>
                {(() => {
                  let disabled: string[] = [];
                  try { disabled = getSettingJSON<string[]>("codem-disabled-skills", []); } catch {}
                  const skills = getSkillRegistry().getAll().filter(s => !disabled.includes(s.name));
                  if (skills.length === 0) {
                    return <div style={{ fontSize: 11, opacity: 0.5, padding: "8px 0" }}>{zh ? "无可用技能" : "No skills available"}</div>;
                  }
                  return skills.map(s => (
                    <label key={s.name} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 4px", cursor: "pointer", borderRadius: 4, fontSize: 11 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <input type="checkbox" checked={selectedSkills.includes(s.name)} onChange={(e) => {
                        if (e.target.checked) setSelectedSkills([...selectedSkills, s.name]);
                        else setSelectedSkills(selectedSkills.filter(n => n !== s.name));
                      }} style={{ marginTop: 2 }} />
                      <div>
                        <div style={{ fontWeight: 600 }}>{s.displayName || s.name}</div>
                        <div style={{ opacity: 0.6, fontSize: 10, lineHeight: 1.3 }}>{s.description}</div>
                      </div>
                    </label>
                  ));
                })()}
              </div>
            </>
          )}
        </div>

        {/* 📋/⚡ Collaboration mode — back in input-wrapper left side */}
        <button
          className={`mode-toggle-btn ${collaborationMode}`}
          onClick={() => onModeChange(collaborationMode === "default" ? "plan" : "default")}
          title={collaborationMode === "plan" ? (zh ? "计划模式（只读）— 点击切换到执行模式" : "Plan mode (read-only) — click to switch") : (zh ? "执行模式 — 点击切换到计划模式" : "Execute mode — click for plan mode")}
        >
          {collaborationMode === "plan" ? "📋" : "⚡"}
        </button>

        {/* 🔒 Security mode — back in input-wrapper left side */}
        <button
          className={`mode-toggle-btn security-${securityMode}`}
          onClick={() => setShowSecurityPicker(!showSecurityPicker)}
          title={zh ? `安全策略: ${currentModeInfo.label_zh} — ${currentModeInfo.desc_zh}` : `Security: ${currentModeInfo.label_en} — ${currentModeInfo.desc_en}`}
          style={{ position: "relative", display: "flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600 }}
        >
          <span style={{ fontSize: 15 }}>{currentModeInfo.icon}</span>
          <span>{zh ? currentModeInfo.label_zh : currentModeInfo.label_en}</span>
        </button>

        {/* Security mode dropdown */}
        {showSecurityPicker && (
          <>
            <div onClick={() => setShowSecurityPicker(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
            <div style={{
              position: "absolute", bottom: "100%", left: 0, marginBottom: 4,
              background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
              borderRadius: 8, padding: 8, zIndex: 100, display: "flex", gap: 4,
              boxShadow: "0 -4px 12px rgba(0,0,0,0.3)",
            }}>
              {SECURITY_MODES.map(m => (
                <button key={m.mode} onClick={() => selectSecurityMode(m.mode)} style={{
                  padding: "8px 12px", borderRadius: 6,
                  border: `1px solid ${securityMode === m.mode ? "var(--accent)" : "var(--border-primary)"}`,
                  background: securityMode === m.mode ? "var(--accent)" : "var(--bg-tertiary)",
                  color: securityMode === m.mode ? "#fff" : "var(--text-primary)",
                  cursor: "pointer", fontSize: 11, display: "flex", flexDirection: "column",
                  alignItems: "center", gap: 4, minWidth: 90,
                }} title={zh ? m.desc_zh : m.desc_en} >
                  <span style={{ fontSize: 18 }}>{m.icon}</span>
                  <span style={{ fontWeight: 600 }}>{zh ? m.label_zh : m.label_en}</span>
                  <span style={{ fontSize: 9, opacity: 0.7, textAlign: "center", lineHeight: 1.3 }}>
                    {zh ? m.desc_zh.substring(0, 20) + "…" : m.desc_en.substring(0, 25) + "…"}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Slash command menu */}
        {slashFilter !== null && (
          <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 100 }}>
            <SlashCommandMenu
              filter={slashFilter}
              onSelect={(item: SlashCommandItem) => {
                setSelectedSkills([...selectedSkills, item.id]);
                const slashIdx = input.lastIndexOf("/");
                if (slashIdx >= 0) setInput(input.substring(0, slashIdx).replace(/\s+$/, " "));
                setSlashFilter(null);
                textareaRef.current?.focus();
              }}
              onClose={() => setSlashFilter(null)}
            />
          </div>
        )}

        <textarea
          ref={textareaRef}
          className={`message-input ${expanded ? "expanded" : ""}`}
          value={input}
          onChange={(e) => {
            const val = e.target.value;
            setInput(val);
            const slashMatch = val.match(/(?:^|\s)\/([^\s]*)$/);
            setSlashFilter(slashMatch ? slashMatch[1] : null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={noSession ? (lang === "zh" ? "请新建或选择历史对话后发起任务" : "Create or select a session to start") : disabled ? S.sidebar.disabledHint[lang] : S.input.placeholder[lang]}
          disabled={disabled}
          rows={1}
        />

        <button
          className="mode-toggle-btn"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? S.sidebar.collapseInput[lang] : S.sidebar.expandInput[lang]}
        >
          {expanded ? "🗗" : "🗖"}
        </button>

        {isStreaming ? (
          <button className="send-btn cancel-btn" onClick={onCancel} title={S.input.cancel[lang]}>■</button>
        ) : (
          <button
            className={`send-btn ${disabled ? "disabled" : ""}`}
            onClick={handleSubmit}
            disabled={disabled || (!input.trim() && pendingAttachments.length === 0)}
          >→</button>
        )}
      </div>

      {/* === Bottom control bar (对标 wecode ProjectWorkBar) === */}
      {/* Project dropdown backdrop */}
      {(showProjectMenu || showModeMenu || showBranchMenu) && (
        <div onClick={closeBottomMenus} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      )}

      <div className="input-control-bar">
        {/* Project indicator */}
        <div style={{ position: "relative" }}>
          <button
            className="input-control-item project-indicator"
            onClick={() => { setShowProjectMenu(!showProjectMenu); setShowModeMenu(false); setShowBranchMenu(false); }}
            title={currentProject ? currentProject.path : (zh ? "选择项目" : "Select project")}
          >
            <span style={{ fontSize: 13 }}>{currentProject ? "📁" : "🌐"}</span>
            <span className="project-indicator-name">
              {currentProject ? currentProject.name : (zh ? "全局对话" : "Global")}
            </span>
            <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
          </button>
          {showProjectMenu && (
            <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 260, maxHeight: 240, overflowY: "auto" }}>
              <div className="bottom-bar-dropdown-header">{zh ? "切换项目" : "Switch Project"}</div>
              {projects.length === 0 && (
                <div className="bottom-bar-dropdown-empty">{zh ? "无项目" : "No projects"}</div>
              )}
              {projects.map(p => (
                <button
                  key={p.id}
                  className={`bottom-bar-dropdown-item ${currentProject?.id === p.id ? "active" : ""}`}
                  onClick={() => handleSelectProject(p.id)}
                >
                  <span style={{ fontSize: 14 }}>📁</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{p.name}</div>
                    <div style={{ fontSize: 10, opacity: 0.5 }}>{p.path}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="input-control-divider" />

        {/* Execution mode (本地处理 / 新工作树) */}
        <div style={{ position: "relative" }}>
          <button
            className={`input-control-item ${executionMode === "git_worktree" ? "active" : ""}`}
            onClick={() => { if (!modeLocked) { setShowModeMenu(!showModeMenu); setShowProjectMenu(false); setShowBranchMenu(false); } }}
            disabled={modeLocked}
            title={zh ? "执行模式" : "Execution mode"}
            style={{ opacity: modeLocked ? 0.5 : 1 }}
          >
            <span style={{ fontSize: 13 }}>{executionMode === "git_worktree" ? "🌲" : "🏠"}</span>
            <span>{executionMode === "git_worktree" ? (zh ? "新工作树" : "Worktree") : (zh ? "本地处理" : "Local")}</span>
            <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
          </button>
          {showModeMenu && (
            <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 200 }}>
              <div className="bottom-bar-dropdown-header">{zh ? "执行模式" : "Execution Mode"}</div>
              <button
                className={`bottom-bar-dropdown-item ${executionMode === "current_workspace" ? "active" : ""}`}
                onClick={() => handleExecutionModeChange("current_workspace")}
              >
                <span style={{ fontSize: 16 }}>🏠</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{zh ? "本地处理" : "Local workspace"}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{zh ? "共享项目目录" : "Shared project directory"}</div>
                </div>
              </button>
              <button
                className={`bottom-bar-dropdown-item ${executionMode === "git_worktree" ? "active" : ""}`}
                onClick={() => handleExecutionModeChange("git_worktree")}
                disabled={!isGitProject}
                style={{ opacity: isGitProject ? 1 : 0.4 }}
                title={isGitProject ? "" : (zh ? "需要 Git 仓库项目才能使用工作树模式" : "Git repository required for worktree mode")}
              >
                <span style={{ fontSize: 16 }}>🌲</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{zh ? "新工作树" : "New worktree"}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{zh ? "每次任务独立隔离" : "Isolated per-task"}</div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Branch selector (only for git projects) */}
        {isGitProject && (
          <>
            <div className="input-control-divider" />
            <div style={{ position: "relative" }}>
              <button
                className="input-control-item"
                onClick={() => { setShowBranchMenu(!showBranchMenu); setShowProjectMenu(false); setShowModeMenu(false); }}
                title={zh ? "选择分支" : "Select branch"}
              >
                <span style={{ fontSize: 13 }}>🌿</span>
                <span>{branchLoading ? "..." : (currentBranchName || (zh ? "分支" : "Branch"))}</span>
                <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
              </button>
              {showBranchMenu && (
                <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 200, maxHeight: 240, overflowY: "auto" }}>
                  <div className="bottom-bar-dropdown-header" style={{ display: "flex", alignItems: "center" }}>
                    <span>{zh ? "选择分支" : "Select Branch"}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); refreshBranch(); }}
                      style={{ marginLeft: "auto", fontSize: 10, opacity: 0.6, cursor: "pointer", background: "none", border: "none", color: "inherit" }}
                    >
                      {branchLoading ? "⏳" : "🔄"}
                    </button>
                  </div>
                  {branchLoading && <div className="bottom-bar-dropdown-empty">{zh ? "加载中..." : "Loading..."}</div>}
                  {!branchLoading && branches.length === 0 && (
                    <div className="bottom-bar-dropdown-empty">{zh ? "无分支" : "No branches"}</div>
                  )}
                  {!branchLoading && branches.map(br => (
                    <button
                      key={br}
                      className={`bottom-bar-dropdown-item ${br === currentBranchName ? "active" : ""}`}
                      onClick={async () => {
                if (projectPath && br !== currentBranchName) {
                  // Execute git checkout — PowerShell-safe single-quoted paths
                  try {
                    const { executeCommand } = await import("../core/file-api");
                    const safePath = projectPath.replace(/'/g, "''");
                    const safeBranch = br.replace(/'/g, "''");
                    const result = await executeCommand(
                      `git -C '${safePath}' checkout '${safeBranch}'`,
                      projectPath
                    );
                    if (result.exitCode && result.exitCode !== 0) {
                      console.error("[InputArea] git checkout failed:", result.stderr);
                      alert(`${zh ? "切换分支失败: " : "Checkout failed: "}${result.stderr}`);
                    } else {
                      setCurrentBranchName(br);
                    }
                  } catch (e) {
                    console.error("[InputArea] git checkout error:", e);
                    alert(`${zh ? "切换分支失败: " : "Checkout failed: "}${e}`);
                  }
                }
                setShowBranchMenu(false);
              }}
                    >
                      <span style={{ fontSize: 14 }}>{br === currentBranchName ? "✓" : "🌿"}</span>
                      <span style={{ fontSize: 12 }}>{br}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Custom operations */}
        {customOps.filter(op => op.command.trim()).length > 0 && (
          <>
            <div className="input-control-divider" />
            {customOps.filter(op => op.command.trim()).slice(0, 3).map(op => (
              <button
                key={op.id}
                className="input-control-item"
                onClick={() => handleRunOp(op)}
                disabled={runningOp !== null}
                title={`${op.name}: ${op.command}`}
                style={{ opacity: runningOp === op.id ? 0.5 : 1 }}
              >
                {runningOp === op.id ? "⏳" : (op.icon || "🔧")} {op.name}
              </button>
            ))}
          </>
        )}

        {/* Right side: skills + hint */}
        {selectedSkills.length > 0 && (
          <>
            <div className="input-control-divider" />
            <span className="input-control-item active">
              🎯 {selectedSkills.length} {zh ? "技能" : "skills"}
            </span>
          </>
        )}
        <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>
          {zh ? "输入 / 选择技能" : "Type / for skills"}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
