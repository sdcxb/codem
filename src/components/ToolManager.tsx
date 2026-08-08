/**
 * ToolManager — 工具注册表查看与管理面板
 *
 * 展示所有已注册的工具：
 * - 工具名称、描述、参数 schema
 * - 工具启用/禁用开关（持久化到设置）
 * - 工具分类（内置 / MCP / 技能）
 */

import { useState, useEffect, useMemo } from "react";
import { getLLMEngine } from "../core/llm";
import type { ToolDef } from "../core/llm/tools";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { Wrench, Plug, Target, Link2, X, Lightbulb, ChevronDown, ChevronRight } from "lucide-react";

interface ToolManagerProps {
  onClose: () => void;
}

interface ToolInfo {
  tool: ToolDef;
  category: "builtin" | "mcp" | "skill" | "delegation";
  enabled: boolean;
}

const CATEGORY_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  builtin: { label: "内置工具", icon: <Wrench size={14} />, color: "#3b82f6" },
  mcp: { label: "MCP 工具", icon: <Plug size={14} />, color: "#8b5cf6" },
  skill: { label: "技能工具", icon: <Target size={14} />, color: "#10b981" },
  delegation: { label: "委派工具", icon: <Link2 size={14} />, color: "#f59e0b" },
};

// 内置工具 ID 列表
const BUILTIN_TOOL_IDS = new Set([
  "bash", "read", "write", "edit", "multiedit", "glob", "grep", "tts", "image_gen",
  "spawn_subagent", "wait_for_subagent",
]);

// 委派工具 ID 列表
const DELEGATION_TOOL_IDS = new Set([
  "delegate_to_session", "wait_for_delegation", "query_session_result", "list_sessions",
]);

export function ToolManager({ onClose }: ToolManagerProps) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  useEffect(() => {
    loadTools();
  }, []);

  const loadTools = () => {
    const engine = getLLMEngine();
    const allTools = engine.tools.getAll();
    const disabled = getSettingJSON<string[]>("codem-disabled-tools", []);

    const toolInfos: ToolInfo[] = allTools.map((tool) => {
      let category: ToolInfo["category"] = "skill";
      if (BUILTIN_TOOL_IDS.has(tool.id)) category = "builtin";
      else if (DELEGATION_TOOL_IDS.has(tool.id)) category = "delegation";
      else if (tool.id.startsWith("mcp_") || tool.id.includes("__")) category = "mcp";

      return {
        tool,
        category,
        enabled: !disabled.includes(tool.id),
      };
    });

    setTools(toolInfos);
  };

  const toggleTool = (toolId: string, enabled: boolean) => {
    const disabled = getSettingJSON<string[]>("codem-disabled-tools", []);
    let newDisabled: string[];
    if (enabled) {
      newDisabled = disabled.filter((id) => id !== toolId);
    } else {
      newDisabled = [...disabled, toolId];
    }
    setSettingJSON("codem-disabled-tools", newDisabled);

    setTools((prev) =>
      prev.map((t) => (t.tool.id === toolId ? { ...t, enabled } : t)),
    );
  };

  const filteredTools = useMemo(() => {
    return tools.filter((t) => {
      if (filterCategory !== "all" && t.category !== filterCategory) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          t.tool.id.toLowerCase().includes(q) ||
          t.tool.description.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tools, searchQuery, filterCategory]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tools) {
      counts[t.category] = (counts[t.category] || 0) + 1;
    }
    return counts;
  }, [tools]);

  return (
    <div className="usage-stats" style={{ maxWidth: 700 }}>
      <div className="usage-stats-header">
        <div className="usage-stats-title">
          <span className="usage-stats-icon"><Wrench size={16} /></span>
          <span>工具管理</span>
        </div>
        <button className="usage-stats-close" onClick={onClose}><X size={14} /></button>
      </div>

      {/* 搜索框 */}
      <div style={{ padding: "8px 16px" }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索工具..."
          style={{
            width: "100%", padding: "6px 12px", fontSize: 13, borderRadius: 6,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-tertiary)", color: "var(--text-primary)",
          }}
        />
      </div>

      {/* 分类过滤 */}
      <div style={{ display: "flex", gap: 6, padding: "0 16px 8px", flexWrap: "wrap" }}>
        <button
          className={`usage-tab ${filterCategory === "all" ? "active" : ""}`}
          onClick={() => setFilterCategory("all")}
          style={{ fontSize: 11 }}
        >
          全部 ({tools.length})
        </button>
        {Object.entries(CATEGORY_LABELS).map(([key, info]) => (
          <button
            key={key}
            className={`usage-tab ${filterCategory === key ? "active" : ""}`}
            onClick={() => setFilterCategory(key)}
            style={{ fontSize: 11 }}
          >
            {info.icon} {info.label} ({categoryCounts[key] || 0})
          </button>
        ))}
      </div>

      {/* 工具列表 */}
      <div className="usage-content" style={{ maxHeight: "60vh", overflowY: "auto" }}>
        {filteredTools.length === 0 && (
          <div className="usage-empty">暂无匹配工具</div>
        )}
        {filteredTools.map(({ tool, category, enabled }) => {
          const catInfo = CATEGORY_LABELS[category];
          const isExpanded = expandedTool === tool.id;
          const params = tool.parameters as any;
          const paramEntries = params?.properties
            ? Object.entries(params.properties) as [string, any][]
            : [];

          return (
            <div
              key={tool.id}
              style={{
                padding: "10px 12px",
                borderRadius: 6,
                background: "var(--bg-tertiary)",
                marginBottom: 6,
                border: "1px solid var(--border-primary)",
                opacity: enabled ? 1 : 0.6,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>{catInfo.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
                      {tool.id}
                    </span>
                    <span style={{
                      fontSize: 9, padding: "1px 6px", borderRadius: 8,
                      background: catInfo.color + "20", color: catInfo.color,
                    }}>
                      {catInfo.label}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 11, color: "var(--text-muted)", marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {tool.description.substring(0, 100)}
                    {tool.description.length > 100 ? "..." : ""}
                  </div>
                </div>
                {/* Enable/Disable toggle */}
                <button
                  onClick={() => toggleTool(tool.id, !enabled)}
                  title={enabled ? "点击禁用" : "点击启用"}
                  style={{
                    width: "36px", height: "20px", borderRadius: "10px",
                    border: enabled ? "none" : "1px solid var(--border-primary)",
                    background: enabled ? "var(--accent)" : "var(--bg-hover)",
                    cursor: "pointer", position: "relative", flexShrink: 0,
                    transition: "background 0.2s",
                  }}
                >
                  <span style={{
                    position: "absolute", top: enabled ? "1px" : "1px",
                    left: enabled ? "18px" : "2px",
                    width: "16px", height: "16px", borderRadius: "50%",
                    background: enabled ? "#fff" : "var(--text-secondary)",
                    transition: "left 0.2s, background 0.2s",
                  }} />
                </button>
                {/* Expand button */}
                <button
                  onClick={() => setExpandedTool(isExpanded ? null : tool.id)}
                  style={{
                    background: "none", border: "none", color: "var(--text-muted)",
                    cursor: "pointer", fontSize: 12, padding: "2px 4px",
                  }}
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-primary)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
                    <strong>完整描述：</strong>
                  </div>
                  <div style={{
                    fontSize: 11, color: "var(--text-muted)", marginBottom: 8,
                    padding: 6, borderRadius: 4, background: "var(--bg-secondary)",
                    whiteSpace: "pre-wrap", lineHeight: 1.5,
                  }}>
                    {tool.description}
                  </div>

                  {paramEntries.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
                        <strong>参数 ({paramEntries.length}):</strong>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {paramEntries.map(([name, schema]) => {
                          const isRequired = params.required?.includes(name);
                          return (
                            <div key={name} style={{
                              display: "flex", gap: 8, fontSize: 11,
                              padding: "3px 6px", borderRadius: 4,
                              background: "var(--bg-secondary)",
                            }}>
                              <span style={{
                                fontFamily: "monospace", color: "var(--accent)",
                                fontWeight: 600, flexShrink: 0,
                              }}>
                                {name}
                                {isRequired && <span style={{ color: "#e74c3c" }}>*</span>}
                              </span>
                              <span style={{ color: "var(--text-muted)" }}>
                                {schema.type || "any"}
                              </span>
                              <span style={{ color: "var(--text-muted)", flex: 1 }}>
                                {schema.description || ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ padding: "8px 16px", fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border-primary)" }}>
        <Lightbulb size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />禁用的工具不会出现在 LLM 的可用工具列表中。内置工具禁用后可能影响核心功能。
      </div>
    </div>
  );
}
