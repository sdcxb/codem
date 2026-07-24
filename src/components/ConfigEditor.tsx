import { useState, useEffect } from "react";
import {
  HierarchicalConfig,
  IdentityConfig,
  UserConfig,
  ConfigLevel,
} from "../core/types";
import {
  initConfigDir,
  loadHierarchicalConfig,
  saveConfigFile,
  saveIdentity,
  saveUser,
} from "../core/config/loader";

interface ConfigEditorProps {
  appRoot: string;
  projectPath: string;
  onClose: () => void;
}

type TabKey = "agents" | "soul" | "identity" | "user" | "tools" | "heartbeat" | "structure";

const TAB_LABELS: Record<TabKey, string> = {
  agents: "📋 AGENTS",
  soul: "💎 SOUL",
  identity: "🪪 IDENTITY",
  user: "👤 USER",
  tools: "🔧 TOOLS",
  heartbeat: "💓 HEARTBEAT",
  structure: "🌳 层级结构",
};

export function ConfigEditor({ appRoot, projectPath, onClose }: ConfigEditorProps) {
  const [loading, setLoading] = useState(true);
  const [levels, setLevels] = useState<HierarchicalConfig[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("agents");
  const [activeLevel, setActiveLevel] = useState<ConfigLevel>("project");
  const [editing, setEditing] = useState("");
  const [identity, setIdentity] = useState<IdentityConfig>({ name: "", creature: "", vibe: "", emoji: "", avatar: "", raw: "" });
  const [user, setUser] = useState<UserConfig>({ name: "", callBy: "", pronouns: "", timezone: "", notes: "", context: "", raw: "" });
  const [saved, setSaved] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const { levels: lvs } = await loadHierarchicalConfig(appRoot, projectPath);
      setLevels(lvs);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadConfig(); }, [appRoot, projectPath]);

  const currentLevel = levels.find((l) => l.level === activeLevel) || levels[0];

  useEffect(() => {
    if (!currentLevel) return;
    switch (activeTab) {
      case "agents": setEditing(currentLevel.agents); break;
      case "soul": setEditing(currentLevel.soul); break;
      case "identity": setIdentity(currentLevel.identity); break;
      case "user": setUser(currentLevel.user); break;
      case "tools": setEditing(currentLevel.tools); break;
      case "heartbeat": setEditing(currentLevel.heartbeat); break;
      case "structure": setEditing(""); break;
    }
  }, [activeTab, activeLevel, currentLevel]);

  const handleSave = async () => {
    if (!currentLevel) return;
    const base = currentLevel.basePath;
    const lvl = currentLevel.level;

    switch (activeTab) {
      case "agents": await saveConfigFile(base, lvl, "AGENTS.md", editing); break;
      case "soul": await saveConfigFile(base, lvl, "SOUL.md", editing); break;
      case "identity": await saveIdentity(base, lvl, identity); break;
      case "user": await saveUser(base, lvl, user); break;
      case "tools": await saveConfigFile(base, lvl, "TOOLS.md", editing); break;
      case "heartbeat": await saveConfigFile(base, lvl, "HEARTBEAT.md", editing); break;
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await loadConfig();
  };

  const handleInitLevel = async (level: ConfigLevel) => {
    const path = level === "app" ? appRoot : projectPath;
    await initConfigDir(path, level);
    await loadConfig();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="config-editor" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>⚙️ 分层配置管理</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="config-body">
          {/* Level Selector */}
          <div className="config-levels">
            <span className="config-level-label">配置层级：</span>
            {(["app", "project"] as ConfigLevel[]).map((lvl) => {
              const exists = levels.some((l) => l.level === lvl);
              return (
                <button
                  key={lvl}
                  className={`config-level-btn ${activeLevel === lvl ? "active" : ""} ${!exists ? "missing" : ""}`}
                  onClick={() => setActiveLevel(lvl)}
                >
                  {lvl === "app" ? "🏠 全局" : "📁 项目"}
                  {!exists && " (未初始化)"}
                </button>
              );
            })}
            {levels.filter((l) => l.level === "subfolder").map((l) => (
              <button
                key={l.basePath}
                className={`config-level-btn ${activeLevel === "subfolder" ? "active" : ""}`}
                onClick={() => { setActiveLevel("subfolder"); }}
              >
                📂 {l.basePath.split("\\").pop()}
              </button>
            ))}
          </div>

          {/* Tab Bar */}
          <div className="config-tabs">
            {(Object.keys(TAB_LABELS) as TabKey[]).map((tab) => (
              <button
                key={tab}
                className={`config-tab ${activeTab === tab ? "active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="config-content">
            {loading ? (
              <div className="config-loading">加载中...</div>
            ) : activeTab === "structure" ? (
              <div className="config-structure">
                {levels.map((lvl) => (
                  <div key={lvl.level} className="structure-level">
                    <div className="structure-header">
                      <span className="structure-icon">
                        {lvl.level === "app" ? "🏠" : lvl.level === "project" ? "📁" : "📂"}
                      </span>
                      <span className="structure-name">
                        {lvl.level === "app" ? "全局配置" : lvl.level === "project" ? "项目配置" : lvl.basePath.split("\\").pop()}
                      </span>
                      <span className="structure-path">{lvl.basePath}</span>
                    </div>
                    <div className="structure-files">
                      {Object.entries(lvl.exists).map(([file, exists]) => (
                        <span key={file} className={`structure-file ${exists ? "exists" : "missing"}`}>
                          {exists ? "✅" : "⬜"} {file}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="config-init-section">
                  <h4>初始化配置目录</h4>
                  <button className="config-init-btn" onClick={() => handleInitLevel("app")}>
                    🏠 初始化全局配置 (.codem-app/)
                  </button>
                  <button className="config-init-btn" onClick={() => handleInitLevel("project")}>
                    📁 初始化项目配置 (.codem/)
                  </button>
                </div>
              </div>
            ) : activeTab === "identity" ? (
              <div className="config-form">
                <div className="config-form-group">
                  <label>名字</label>
                  <input value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} placeholder="给你的 Agent 起个名字" />
                </div>
                <div className="config-form-group">
                  <label>类型</label>
                  <input value={identity.creature} onChange={(e) => setIdentity({ ...identity, creature: e.target.value })} placeholder="AI? 机器人? 幽灵?" />
                </div>
                <div className="config-form-group">
                  <label>风格</label>
                  <input value={identity.vibe} onChange={(e) => setIdentity({ ...identity, vibe: e.target.value })} placeholder="温暖? 犀利? 搞怪?" />
                </div>
                <div className="config-form-group">
                  <label>Emoji</label>
                  <input value={identity.emoji} onChange={(e) => setIdentity({ ...identity, emoji: e.target.value })} placeholder="⚡" style={{ width: 80 }} />
                </div>
                <div className="config-form-group">
                  <label>头像路径</label>
                  <input value={identity.avatar} onChange={(e) => setIdentity({ ...identity, avatar: e.target.value })} placeholder="avatars/me.png 或 URL" />
                </div>
              </div>
            ) : activeTab === "user" ? (
              <div className="config-form">
                <div className="config-form-group">
                  <label>名字</label>
                  <input value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} placeholder="用户的名字" />
                </div>
                <div className="config-form-group">
                  <label>称呼</label>
                  <input value={user.callBy} onChange={(e) => setUser({ ...user, callBy: e.target.value })} placeholder="怎么称呼用户" />
                </div>
                <div className="config-form-group">
                  <label>代词</label>
                  <input value={user.pronouns} onChange={(e) => setUser({ ...user, pronouns: e.target.value })} placeholder="可选" />
                </div>
                <div className="config-form-group">
                  <label>时区</label>
                  <input value={user.timezone} onChange={(e) => setUser({ ...user, timezone: e.target.value })} placeholder="Asia/Shanghai" />
                </div>
                <div className="config-form-group">
                  <label>备注</label>
                  <textarea value={user.notes} onChange={(e) => setUser({ ...user, notes: e.target.value })} rows={2} placeholder="其他信息" />
                </div>
                <div className="config-form-group">
                  <label>上下文</label>
                  <textarea value={user.context} onChange={(e) => setUser({ ...user, context: e.target.value })} rows={4} placeholder="用户在做什么项目、关心什么、喜欢什么..." />
                </div>
              </div>
            ) : (
              <textarea
                className="config-textarea"
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                spellCheck={false}
              />
            )}
          </div>

          {/* Footer */}
          <div className="config-footer">
            {saved && <span className="config-saved">✅ 已保存</span>}
            {activeTab !== "structure" && (
              <button className="config-save-btn" onClick={handleSave}>💾 保存</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
