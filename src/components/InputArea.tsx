import { useState, useRef, useEffect } from "react";
import { MessageAttachment } from "../store";
import { FileUpload } from "./FileUpload";
import { useLang, S } from "../core/i18n/lang";
import type { CollaborationMode } from "../core/agent/agent";
import { SECURITY_MODES, getEffectiveSecurityMode, setProjectSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { getSkillRegistry } from "../core/skill/skill";
import { getSettingJSON } from "../core/storage/settings";

interface InputAreaProps {
  onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
  onCancel: () => void;
  disabled: boolean;
  isStreaming: boolean;
  collaborationMode: CollaborationMode;
  onModeChange: (mode: CollaborationMode) => void;
  /** Project path for per-project security mode */
  projectPath?: string;
  /** #5: Quoted text from selection tooltip */
  quoteContext?: string | null;
  onClearQuote?: () => void;
}

export function InputArea({ onSend, onCancel, disabled, isStreaming, collaborationMode, onModeChange, projectPath, quoteContext, onClearQuote }: InputAreaProps) {
  const lang = useLang();
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [showSecurityPicker, setShowSecurityPicker] = useState(false);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(projectPath));
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);

  // #5: Insert quote context into input when received
  useEffect(() => {
    if (quoteContext) {
      const quoted = quoteContext.split("\n").map((line) => `> ${line}`).join("\n");
      setInput((prev) => prev ? `${prev}\n\n${quoted}\n\n` : `${quoted}\n\n`);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [quoteContext]);

  // Update when project path changes
  useEffect(() => {
    setSecurityMode(getEffectiveSecurityMode(projectPath));
  }, [projectPath]);

  // Listen for global security mode changes
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
          name,
          type: "image",
          content: dataUrl,
          mimeType: file.type,
          size: file.size,
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

  // Cycle through security modes on double-click
  const cycleSecurityMode = () => {
    const modes: SecurityMode[] = ["ask", "auto", "full"];
    const currentIdx = modes.indexOf(securityMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    // MUST persist to storage — otherwise the event listener reads the old
    // value from storage and overwrites the local state immediately.
    if (projectPath) {
      setProjectSecurityMode(projectPath, nextMode);
    } else {
      setGlobalSecurityMode(nextMode);
    }
    // setGlobalSecurityMode / setProjectSecurityMode already dispatch the
    // event, so no need to dispatch again.
  };

  // Select a specific mode from the dropdown
  const selectSecurityMode = (mode: SecurityMode) => {
    if (projectPath) {
      setProjectSecurityMode(projectPath, mode);
    } else {
      setGlobalSecurityMode(mode);
    }
    setShowSecurityPicker(false);
  };

  const currentModeInfo = SECURITY_MODES.find(m => m.mode === securityMode)!;
  const zh = lang === "zh";

  return (
    <div className="input-area">
      {/* #5: Quote context preview banner */}
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
              <span className="attachment-icon">
                {att.type === "image" ? "🖼️" : "📄"}
              </span>
              <span className="attachment-name">{att.name}</span>
              {att.size && (
                <span className="attachment-size">{formatSize(att.size)}</span>
              )}
              <button className="attachment-remove" onClick={() => removeAttachment(att.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Security mode quick picker dropdown */}
      {showSecurityPicker && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            onClick={() => setShowSecurityPicker(false)}
            style={{ position: "fixed", inset: 0, zIndex: 99 }}
          />
          <div style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: 4,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 8,
            padding: 8,
            zIndex: 100,
            display: "flex",
            gap: 4,
            boxShadow: "0 -4px 12px rgba(0,0,0,0.3)",
          }}>
            {SECURITY_MODES.map(m => (
              <button
                key={m.mode}
                onClick={() => selectSecurityMode(m.mode)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: `1px solid ${securityMode === m.mode ? "var(--accent)" : "var(--border-primary)"}`,
                  background: securityMode === m.mode ? "var(--accent)" : "var(--bg-tertiary)",
                  color: securityMode === m.mode ? "#fff" : "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: 11,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 90,
                }}
                title={zh ? m.desc_zh : m.desc_en}
              >
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

      <div className="input-wrapper">
        <FileUpload onUpload={handleUpload} />
        {/* Skill picker — lets user explicitly select skills for this message */}
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
              <div
                style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }}
                onClick={() => setShowSkillPicker(false)}
              />
              <div className="skill-picker-popup" style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                marginBottom: 4,
                minWidth: 220,
                maxWidth: 320,
                zIndex: 100,
                maxHeight: 300,
                overflowY: "auto",
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
                    <label
                      key={s.name}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        padding: "6px 4px",
                        cursor: "pointer",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSkills.includes(s.name)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSkills([...selectedSkills, s.name]);
                          } else {
                            setSelectedSkills(selectedSkills.filter(n => n !== s.name));
                          }
                        }}
                        style={{ marginTop: 2 }}
                      />
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
        {/* C1: Collaboration mode toggle */}
        <button
          className={`mode-toggle-btn ${collaborationMode}`}
          onClick={() => onModeChange(collaborationMode === "default" ? "plan" : "default")}
          title={collaborationMode === "plan" ? (zh ? "计划模式（只读）— 点击切换到执行模式" : "Plan mode (read-only) — click to switch") : (zh ? "执行模式 — 点击切换到计划模式" : "Execute mode — click for plan mode")}
        >
          {collaborationMode === "plan" ? "📋" : "⚡"}
        </button>
        {/* Security mode toggle — single click cycles through ask → auto → full */}
        <button
          className={`mode-toggle-btn security-${securityMode}`}
          onClick={cycleSecurityMode}
          title={zh ? `安全策略: ${currentModeInfo.label_zh} — ${currentModeInfo.desc_zh}（点击切换）` : `Security: ${currentModeInfo.label_en} — ${currentModeInfo.desc_en} (click to cycle)`}
          style={{ position: "relative", display: "flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600 }}
        >
          <span style={{ fontSize: 15 }}>{currentModeInfo.icon}</span>
          <span>{zh ? currentModeInfo.label_zh : currentModeInfo.label_en}</span>
        </button>
        <textarea
          ref={textareaRef}
          className={`message-input ${expanded ? "expanded" : ""}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? S.sidebar.disabledHint[lang] : S.input.placeholder[lang]}
          disabled={disabled}
          rows={1}
        />
        {/* #10: Expand/collapse button */}
        <button
          className="mode-toggle-btn"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? S.sidebar.collapseInput[lang] : S.sidebar.expandInput[lang]}
        >
          {expanded ? "🗗" : "🗖"}
        </button>
        {isStreaming ? (
          <button className="send-btn cancel-btn" onClick={onCancel} title={S.input.cancel[lang]}>
            ■
          </button>
        ) : (
          <button
            className={`send-btn ${disabled ? "disabled" : ""}`}
            onClick={handleSubmit}
            disabled={disabled || (!input.trim() && pendingAttachments.length === 0)}
          >
            →
          </button>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
