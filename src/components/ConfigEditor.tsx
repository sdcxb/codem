import { useState, useEffect } from "react";
import {
  ClipboardList,
  Gem,
  IdCard,
  User as UserIcon,
  Wrench,
  HeartPulse,
  FolderTree,
  Home,
  FolderClosed,
  FolderOpen,
  Check,
  Square,
  Settings2,
} from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
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

/**
 * 解析"当前正在编辑哪一层"，并给出该层的**身份**（第 47 轮补）。
 *
 * ## 为什么必须是纯函数
 *
 * 这里出过一次"写错文件"的缺陷：所有子目录按钮都 `setActiveLevel("subfolder")`，
 * 而解析用 `find(l => l.level === activeLevel)`（第一个匹配）→ 点「B」读写的是 **A**。
 * 这种缺陷**用读代码很难发现**（两处代码各自都"看起来对"），
 * 但用用例一行就能钉住 —— 所以判定逻辑必须是可被直接驱动的纯函数。
 *
 * @param levels 全部层级（含每个 `.codem-sub` 子目录各一条）
 * @param activeLevel 当前选中的**类别**（app / project / subfolder）
 * @param activeSubfolder 当类别是 subfolder 时，选中的那条的 `basePath`（身份）
 */
export function resolveActiveLevel(
  levels: HierarchicalConfig[],
  activeLevel: ConfigLevel,
  activeSubfolder: string | null,
): HierarchicalConfig | undefined {
  if (activeLevel === "subfolder") {
    // ① 先按**身份**找（这才是修好的那一半）
    const byIdentity = levels.find((l) => l.level === "subfolder" && l.basePath === activeSubfolder);
    if (byIdentity) return byIdentity;
    // ② 身份还没选（或选的子目录已消失）→ 回退到第一条子目录（保持旧行为，不是静默乱选）
    const firstSub = levels.find((l) => l.level === "subfolder");
    if (firstSub) return firstSub;
  }
  // ③ app / project：按类别找；找不到就退回 levels[0]（与旧实现一致）
  return levels.find((l) => l.level === activeLevel) || levels[0];
}

/** 一条层级的**身份**：子目录用 `basePath`（类别名不够，会出现多个 subfolder），其余用类别名 */
export function levelIdentity(l: { level: string; basePath: string }): string {
  return l.level === "subfolder" ? `subfolder:${l.basePath}` : l.level;
}

interface ConfigEditorProps {
  appRoot: string;
  projectPath: string;
  onClose: () => void;
}

type TabKey = "agents" | "soul" | "identity" | "user" | "tools" | "heartbeat" | "structure";

const TAB_LABELS: Record<TabKey, string> = {
  agents: "AGENTS",
  soul: "SOUL",
  identity: "IDENTITY",
  user: "USER",
  tools: "TOOLS",
  heartbeat: "HEARTBEAT",
  structure: "层级结构",
};

/* 第 53 波：页签图标从 emoji 改为线性图标（icon-map 的既定政策：管理界面用 Lucide、聊天消息才用 emoji）。
   emoji 还有个副作用：单个 emoji 就要 ~20px 宽，7 个页签在 560px 的弹窗里必然放不下。 */
const TAB_ICONS: Record<TabKey, typeof ClipboardList> = {
  agents: ClipboardList,
  soul: Gem,
  identity: IdCard,
  user: UserIcon,
  tools: Wrench,
  heartbeat: HeartPulse,
  structure: FolderTree,
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

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：子目录层级必须按**身份**选中，不能只看 `level` 名
   *
   * 原来所有子目录按钮都 `setActiveLevel("subfolder")`，而层级解析是
   * `levels.find(l => l.level === activeLevel)` —— "第一个匹配"。于是项目下同时有
   * `A\.codem-sub` 与 `B\.codem-sub` 时（`config/loader` 会为**每个**含 `.codem-sub`
   * 的子目录各生成一条 subfolder 层级）：
   *
   * - 点「B」→ 编辑器载入的是 **A** 的内容；
   * - 点保存 → 写进 **A** 的文件；
   * - 而且四个按钮的高亮判定都是硬编码 `activeLevel === "subfolder"`，
   *   所以**所有**子目录按钮同时高亮 —— 连"选错了"的视觉线索都没有。
   *
   * 修法：子目录额外记住**它的 `basePath`**（行身份）。解析逻辑抽成纯函数
   * （`resolveActiveLevel`）以便被用例直接驱动 —— 这正是"写错文件"那类缺陷该被钉住的地方。
   */
  const [activeSubfolder, setActiveSubfolder] = useState<string | null>(null);

  useEffect(() => { loadConfig(); }, [appRoot, projectPath]);

  const currentLevel = resolveActiveLevel(levels, activeLevel, activeSubfolder);
  /** 当前层级的身份（用于按钮高亮判定：子目录必须按身份，不能按类别名） */
  const activeIdentity = currentLevel ? levelIdentity(currentLevel) : null;

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
          <h3><Settings2 size={16} className="icon-inline" />分层配置管理</h3>
          <button className="settings-close" onClick={onClose} aria-label="关闭"><ActionIcons.close size={16} /></button>
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
                  /* 第 47 轮补：切到 app/project 时清掉子目录选择，避免 currentLevel 回退到某条子目录 */
                  onClick={() => { setActiveLevel(lvl); setActiveSubfolder(null); }}
                >
                  {lvl === "app" ? <Home size={14} /> : <FolderClosed size={14} />}
                  {lvl === "app" ? "全局" : "项目"}
                  {!exists && " (未初始化)"}
                </button>
              );
            })}
            {levels.filter((l) => l.level === "subfolder").map((l) => (
              <button
                key={l.basePath}
                /* 第 47 轮补：高亮判定必须看**这一条的身份**，否则所有子目录按钮同时高亮 */
                className={`config-level-btn ${activeIdentity === levelIdentity(l) ? "active" : ""}`}
                onClick={() => { setActiveLevel("subfolder"); setActiveSubfolder(l.basePath); }}
              >
                <FolderOpen size={14} />
                {l.basePath.split("\\").pop()}
              </button>
            ))}
          </div>

          {/* Tab Bar */}
          <div className="config-tabs">
            {(Object.keys(TAB_LABELS) as TabKey[]).map((tab) => {
              const TabIcon = TAB_ICONS[tab];
              return (
                <button
                  key={tab}
                  className={`config-tab ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setActiveTab(tab)}
                >
                  <TabIcon size={14} />
                  <span className="config-tab-label">{TAB_LABELS[tab]}</span>
                </button>
              );
            })}
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
                        {lvl.level === "app" ? <Home size={14} /> : lvl.level === "project" ? <FolderClosed size={14} /> : <FolderOpen size={14} />}
                      </span>
                      <span className="structure-name">
                        {lvl.level === "app" ? "全局配置" : lvl.level === "project" ? "项目配置" : lvl.basePath.split("\\").pop()}
                      </span>
                      <span className="structure-path">{lvl.basePath}</span>
                    </div>
                    <div className="structure-files">
                      {Object.entries(lvl.exists).map(([file, exists]) => (
                        <span key={file} className={`structure-file ${exists ? "exists" : "missing"}`}>
                          {exists ? <Check size={12} className="icon-inline" /> : <Square size={12} className="icon-inline" />} {file}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="config-init-section">
                  <h4>初始化配置目录</h4>
                  <button className="config-init-btn" onClick={() => handleInitLevel("app")}>
                    <Home size={14} /> 初始化全局配置 (.codem-app/)
                  </button>
                  <button className="config-init-btn" onClick={() => handleInitLevel("project")}>
                    <FolderClosed size={14} /> 初始化项目配置 (.codem/)
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
            {saved && <span className="config-saved"><Check size={12} className="icon-inline" /> 已保存</span>}
            {activeTab !== "structure" && (
              <button className="config-save-btn" onClick={handleSave}><ActionIcons.save size={14} /> 保存</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
