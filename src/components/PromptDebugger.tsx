import { useState, useMemo } from "react";
import { buildSystemPrompt, type SystemPromptConfig } from "../core/prompt/prompt";
import { getAgentRegistry, type AgentDefinition, type CollaborationMode } from "../core/agent/agent";
import { getSettingJSON } from "../core/storage/settings";
import { getLang, useLang } from "../core/i18n/lang";
import type { AppIdentity, UserConfig } from "../core/types";
import type { GitConfig, EnvironmentConfig } from "../core/settings/settings";

export function PromptDebugger() {
  const lang = useLang();
  const zh = lang === "zh";
  const agents = getAgentRegistry().getAll();

  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id || "build");
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>("default");
  const [workingDirectory, setWorkingDirectory] = useState("D:\\project\\my-app");
  const [gitBranch, setGitBranch] = useState("main");
  const [modelInfo, setModelInfo] = useState("gpt-4o");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [showSection, setShowSection] = useState<Record<string, boolean>>({});

  const selectedAgent = agents.find(a => a.id === selectedAgentId) || agents[0];

  const prompt = useMemo(() => {
    if (!selectedAgent) return "";

    // Load identity and user config from settings
    const identity = getSettingJSON<AppIdentity>("codem-identity", {
      name: "Codem",
      creature: "AI 助手",
      vibe: "靠谱、直接、有观点",
      emoji: "⚡",
      avatar: "",
      onboarded: true,
    });

    const user = getSettingJSON<UserConfig>("codem-user", {
      name: "",
      callBy: "",
      pronouns: "",
      timezone: "Asia/Shanghai",
      notes: "",
      context: "",
      raw: "",
    });

    const gitConfig = getSettingJSON<GitConfig | null>("codem-git-config", null) || undefined;
    const envConfig = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null) || undefined;

    // Clone agent and override collaboration mode
    const agent: AgentDefinition = {
      ...selectedAgent,
      collaborationMode,
    };

    const config: SystemPromptConfig = {
      agent,
      identity,
      user: user.name ? user : undefined,
      projectInstructions: projectInstructions.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      gitBranch: gitBranch.trim() || undefined,
      modelInfo: modelInfo.trim() || undefined,
      date: new Date().toLocaleDateString("zh-CN"),
      gitConfig,
      environmentConfig: envConfig,
    };

    return buildSystemPrompt(config);
  }, [selectedAgent, collaborationMode, workingDirectory, gitBranch, modelInfo, projectInstructions]);

  // Split prompt into sections for collapsible display
  const sections = useMemo(() => {
    const parts = prompt.split("\n\n---\n\n");
    return parts.map((part, i) => {
      const firstLine = part.split("\n")[0];
      const title = firstLine.replace(/^#+\s*/, "").substring(0, 60);
      return { index: i, title, content: part };
    });
  }, [prompt]);

  const tokenEstimate = Math.ceil(prompt.length / 4);

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 3, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 'var(--fs-sm)', width: "100%",
    outline: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: "var(--text-primary)" }}>
          📝 {zh ? "系统提示词调试" : "System Prompt Debugger"}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginTop: 2 }}>
          {zh ? "预览和调试生成的系统提示词。修改参数后实时更新。" : "Preview and debug the generated system prompt. Updates in real-time."}
        </div>
      </div>

      {/* Config controls */}
      <div style={{
        padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 8,
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "智能体" : "Agent"}</label>
            <select style={inputStyle} value={selectedAgentId} onChange={e => setSelectedAgentId(e.target.value)}>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>{zh ? "协作模式" : "Collaboration Mode"}</label>
            <select style={inputStyle} value={collaborationMode} onChange={e => setCollaborationMode(e.target.value as CollaborationMode)}>
              <option value="default">{zh ? "默认（自主执行）" : "Default (autonomous)"}</option>
              <option value="plan">{zh ? "规划（只读分析）" : "Plan (read-only)"}</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "工作目录" : "Working Directory"}</label>
            <input style={inputStyle} value={workingDirectory} onChange={e => setWorkingDirectory(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "Git 分支" : "Git Branch"}</label>
            <input style={inputStyle} value={gitBranch} onChange={e => setGitBranch(e.target.value)} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>{zh ? "模型信息" : "Model Info"}</label>
          <input style={inputStyle} value={modelInfo} onChange={e => setModelInfo(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>{zh ? "项目指令 (可选)" : "Project Instructions (optional)"}</label>
          <textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={projectInstructions}
            onChange={e => setProjectInstructions(e.target.value)}
            placeholder={zh ? "自定义项目指令，如编码规范、架构约束等" : "Custom project instructions, e.g. coding standards, architecture constraints"} />
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 12, fontSize: 'var(--fs-sm)' }}>
        <span style={{ color: "var(--text-muted)" }}>
          {zh ? "总长度" : "Total length"}: <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{prompt.length.toLocaleString()}</span> {zh ? "字符" : "chars"}
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          {zh ? "预估" : "Est."}: <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{tokenEstimate.toLocaleString()}</span> tokens
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          {zh ? "段落数" : "Sections"}: <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{sections.length}</span>
        </span>
        <button onClick={() => {
          navigator.clipboard?.writeText(prompt);
        }} style={{
          marginLeft: "auto", padding: "2px 10px", borderRadius: 4, fontSize: 'var(--fs-sm)',
          border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
          color: "var(--text-primary)", cursor: "pointer",
        }}>
          📋 {zh ? "复制全部" : "Copy All"}
        </button>
      </div>

      {/* Collapsible sections */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sections.map(s => {
          const expanded = showSection[s.index] !== false; // Default expanded
          return (
            <div key={s.index} style={{
              border: "1px solid var(--border-primary)", borderRadius: 6,
              background: "var(--bg-tertiary)", overflow: "hidden",
            }}>
              <div
                onClick={() => setShowSection({ ...showSection, [s.index]: !expanded })}
                style={{
                  padding: "6px 10px", cursor: "pointer", fontSize: 'var(--fs-sm)', fontWeight: 600,
                  color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6,
                  borderBottom: expanded ? "1px solid var(--border-primary)" : "none",
                }}
              >
                <span style={{ fontSize: 'var(--fs-xs)' }}>{expanded ? "▼" : "▶"}</span>
                <span>{s.title || `Section ${s.index + 1}`}</span>
                <span style={{ marginLeft: "auto", fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                  ~{Math.ceil(s.content.length / 4)} tokens
                </span>
              </div>
              {expanded && (
                <pre style={{
                  margin: 0, padding: 8, fontSize: 'var(--fs-xs)', whiteSpace: "pre-wrap",
                  wordBreak: "break-word", maxHeight: 300, overflow: "auto",
                  color: "var(--text-secondary)", fontFamily: "monospace",
                }}>
                  {s.content}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
