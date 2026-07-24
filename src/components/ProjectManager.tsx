import { useState } from "react";
import { createPortal } from "react-dom";
import { useProjectStore } from "../core/store";
import { createProjectFiles, loadProjectInstructions, loadProjectSkills, loadProjectMemory } from "../core/project/files";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import type { EnvironmentConfig, GitConfig } from "../core/settings/settings";

const isTauri = () => !!(window as any).__TAURI__;

async function openFolderPicker(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = (window as any).__TAURI__.core;
    console.log("[FolderPicker] Invoking open_folder_dialog...");
    const result = await invoke("open_folder_dialog");
    console.log("[FolderPicker] Result:", result);
    return result || null;
  } catch (e) {
    console.error("[FolderPicker] Error:", e);
    return null;
  }
}

/** Escape a path for PowerShell single-quoted strings */
function psQuote(p: string): string {
  return p.replace(/'/g, "''");
}

interface ProjectManagerProps {
  onClose: () => void;
}

export function ProjectManager({ onClose }: ProjectManagerProps) {
  const { projects, createProject, openProject, deleteProject, setInstructions, setSkills, setMemories } = useProjectStore();
  const [mode, setMode] = useState<"list" | "create" | "import" | "env" | "git-create" | "git-clone">("list");
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [envConfig, setEnvConfig] = useState<EnvironmentConfig>({});
  const [envSaved, setEnvSaved] = useState(false);

  // Git project creation state
  const [gitRepoName, setGitRepoName] = useState("");
  const [gitProjectPath, setGitProjectPath] = useState("");
  const [gitIsPrivate, setGitIsPrivate] = useState(true);
  const [gitToken, setGitToken] = useState("");
  const [gitStatus, setGitStatus] = useState<"idle" | "creating" | "done" | "error">("idle");
  const [gitStatusMsg, setGitStatusMsg] = useState("");

  // GitHub Clone state
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneStatus, setCloneStatus] = useState<"idle" | "cloning" | "done" | "error">("idle");
  const [cloneMsg, setCloneMsg] = useState("");
  const [cloneName, setCloneName] = useState("");

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    await createProjectFiles(newPath);
    const project = createProject(newName, newPath, newDesc);
    await loadProjectData(newPath);
    onClose();
  };

  const handleGitCreate = async () => {
    if (!gitRepoName.trim() || !gitProjectPath.trim()) return;
    if (!isTauri()) {
      setGitStatus("error");
      setGitStatusMsg("需要在桌面应用中使用此功能");
      return;
    }
    if (!gitToken.trim()) {
      setGitStatus("error");
      setGitStatusMsg("请输入 GitHub Personal Access Token");
      return;
    }

    setGitStatus("creating");
    setGitStatusMsg("正在初始化本地 Git 仓库...");
    const { invoke } = (window as any).__TAURI__.core;
    const safePath = psQuote(gitProjectPath);

    try {
      // Step 1: git init
      let result = await invoke("execute_command", {
        command: `git init '${safePath}'`,
      });
      if (result.exitCode && result.exitCode !== 0) {
        throw new Error(`git init failed: ${result.stderr || result.stdout}`);
      }

      // Step 2: Create .codem structure + AGENTS.md
      await createProjectFiles(gitProjectPath);

      // Step 3: Create .gitignore (basic)
      const gitignoreContent = `node_modules/\n.env\n.codem/\n*.log\n.DS_Store\n`;
      await invoke("write_file", { path: `${gitProjectPath}\\.gitignore`, content: gitignoreContent });

      // Step 4: git add + initial commit
      setGitStatusMsg("正在提交初始代码...");
      await invoke("execute_command", {
        command: `git -C '${safePath}' add -A`,
      });
      result = await invoke("execute_command", {
        command: `git -C '${safePath}' commit -m "Initial commit"`,
      });
      // git commit may return non-zero if nothing to commit, that's ok

      // Step 5: Create GitHub repository via API
      setGitStatusMsg("正在 GitHub 创建远程仓库...");
      const repoData = JSON.stringify({
        name: gitRepoName,
        private: gitIsPrivate,
        description: newDesc || undefined,
        auto_init: false,
      });
      const headers: Record<string, string> = {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${gitToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
      const apiResult = await invoke("http_post", {
        url: "https://api.github.com/user/repos",
        body: repoData,
        headers,
      });
      const apiResp = JSON.parse(apiResult.body || "{}");
      if (apiResult.status >= 300 || apiResp.message) {
        throw new Error(`GitHub API error: ${apiResp.message || apiResult.body}`);
      }

      // Step 6: Get clone URL and add remote
      const cloneUrl = apiResp.clone_url || apiResp.ssh_url || `https://github.com/${apiResp.full_name || gitRepoName}.git`;
      setGitStatusMsg("正在关联远程仓库...");
      await invoke("execute_command", {
        command: `git -C '${safePath}' remote add origin '${psQuote(cloneUrl)}'`,
      });

      // Step 7: git push
      setGitStatusMsg("正在推送到 GitHub...");
      // Determine default branch
      const branchResult = await invoke("execute_command", {
        command: `git -C '${safePath}' branch --show-current`,
      });
      const branchName = (branchResult.stdout || "main").trim() || "main";
      result = await invoke("execute_command", {
        command: `git -C '${safePath}' push -u origin '${psQuote(branchName)}'`,
      });
      if (result.exitCode && result.exitCode !== 0 && !result.stderr?.includes("up-to-date")) {
        throw new Error(`git push failed: ${result.stderr || result.stdout}`);
      }

      // Step 8: Save token to git config for future use
      const gitConfig = getSettingJSON<GitConfig>("codem-git-config", {});
      gitConfig.githubToken = gitToken;
      setSettingJSON("codem-git-config", gitConfig);

      // Step 9: Create project in app
      const project = createProject(gitRepoName, gitProjectPath, `GitHub: ${apiResp.full_name || gitRepoName}`);
      await loadProjectData(gitProjectPath);

      setGitStatus("done");
      setGitStatusMsg(`✅ 仓库已创建: ${apiResp.html_url || cloneUrl}`);
      setTimeout(() => {
        onClose();
        // Reset state
        setGitStatus("idle");
        setGitRepoName("");
        setGitProjectPath("");
        setGitToken("");
        setNewDesc("");
      }, 2000);
    } catch (e: any) {
      setGitStatus("error");
      setGitStatusMsg(e?.message || String(e));
    }
  };

  const handleImport = async () => {
    if (!newPath.trim()) return;
    const name = newPath.split("\\").pop() || "导入项目";
    const project = createProject(name, newPath, "导入的项目");
    await loadProjectData(newPath);
    onClose();
  };

  const handleClone = async () => {
    if (!cloneUrl.trim()) return;
    if (!isTauri()) {
      setCloneStatus("error");
      setCloneMsg("需要在桌面应用中使用此功能");
      return;
    }

    function extractRepoName(gitUrl: string): string {
      const cleanUrl = gitUrl.trim().replace(/\.git$/, "");
      const parts = cleanUrl.split("/");
      return parts[parts.length - 1] || "github-project";
    }

    const name = extractRepoName(cloneUrl);
    setCloneName(name);
    setCloneStatus("cloning");
    setCloneMsg(`正在克隆 ${name}...`);

    try {
      const { invoke } = (window as any).__TAURI__.core;
      const home = await invoke("get_default_cwd");
      const projectDir = `${home}\\${name}`;

      // Check git available
      try {
        await invoke("execute_command", { command: "git --version" });
      } catch {
        throw new Error("未找到 git，请先安装 Git");
      }

      // git clone
      const result = await invoke("execute_command", {
        command: `git clone "${cloneUrl.trim()}" "${projectDir}"`,
      });
      const stderr = (result as any)?.stderr || "";
      if (stderr.includes("fatal") || stderr.includes("error")) {
        throw new Error(stderr);
      }

      // Create project in app
      const project = createProject(name, projectDir, `Cloned from ${cloneUrl.trim()}`);
      await loadProjectData(projectDir);

      setCloneStatus("done");
      setCloneMsg(`✅ 项目 ${name} 创建成功！`);
      setTimeout(() => {
        onClose();
        setCloneStatus("idle");
        setCloneUrl("");
        setCloneMsg("");
      }, 1500);
    } catch (e: any) {
      setCloneStatus("error");
      setCloneMsg(e?.message || String(e));
    }
  };

  const handleOpen = async (project: typeof projects[0]) => {
    openProject(project.id);
    await loadProjectData(project.path);
    onClose();
  };

  const handleDelete = (projectId: string) => {
    if (!confirm("确定删除此项目？")) return;
    deleteProject(projectId);
  };

  const handlePickFolder = async () => {
    console.log("[ProjectManager] Opening folder picker...");
    const folder = await openFolderPicker();
    console.log("[ProjectManager] Folder picker returned:", folder);
    if (folder) {
      setNewPath(folder);
      // Auto-fill name from folder
      if (!newName.trim()) {
        const folderName = folder.split(/[/\\]/).pop() || "";
        setNewName(folderName);
      }
    }
  };

  const loadProjectData = async (path: string) => {
    const instructions = await loadProjectInstructions(path);
    setInstructions({ content: instructions, rules: [] });

    const skills = await loadProjectSkills(path);
    setSkills(skills.map((s) => ({
      name: s.name,
      description: "",
      content: s.content,
    })));

    const memories = await loadProjectMemory(path);
    setMemories(memories.map((m, i) => ({
      id: `mem-${i}`,
      name: m.name.replace(".md", ""),
      description: "",
      type: "project" as const,
      content: m.content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })));
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="project-manager" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>📁 项目管理</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        {mode === "list" && (
          <div className="project-list-body">
            <div className="project-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <button className="project-action-btn" onClick={() => setMode("create")}>
                ➕ 新建项目
              </button>
              <button className="project-action-btn" onClick={() => setMode("import")}>
                📂 导入文件夹
              </button>
              <button className="project-action-btn" onClick={() => { setGitStatus("idle"); setGitStatusMsg(""); setMode("git-create"); }}>
                🔗 新建 Git 项目
              </button>
              <button className="project-action-btn" onClick={() => { setCloneStatus("idle"); setCloneMsg(""); setMode("git-clone"); }}>
                📥 从 GitHub 拉取
              </button>
            </div>

            <div className="project-items">
              {projects.length === 0 && (
                <div className="project-empty">暂无项目，新建或导入一个</div>
              )}
              {projects.map((p) => (
                <div key={p.id} className="project-item" onClick={() => handleOpen(p)}>
                  <div className="project-item-info">
                    <div className="project-item-name">{p.name}</div>
                    <div className="project-item-path">{p.path}</div>
                    {p.description && <div className="project-item-desc">{p.description}</div>}
                  </div>
                  <button
                    className="project-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Load existing env config and switch to env mode
                      const stored = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null);
                      setEnvConfig(stored || {});
                      setMode("env");
                    }}
                    title="环境配置"
                    style={{ marginRight: 4 }}
                  >
                    🏗️
                  </button>
                  <button
                    className="project-item-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "create" && (
          <div className="project-form">
            <div className="setting-group">
              <label>项目名称</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Project" />
            </div>
            <div className="setting-group">
              <label>项目路径</label>
              <div className="path-input-group">
                <input
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="点击右边按钮选择文件夹"
                />
                <button className="path-picker-btn" onClick={handlePickFolder} title="选择文件夹">
                  📁
                </button>
              </div>
              {isTauri() && (
                <p className="project-form-hint">点击 📁 按钮打开系统文件选择器</p>
              )}
            </div>
            <div className="setting-group">
              <label>描述 (可选)</label>
              <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="项目描述" />
            </div>
            <div className="project-form-actions">
              <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
              <button className="project-action-btn primary" onClick={handleCreate}>创建项目</button>
            </div>
          </div>
        )}

        {mode === "import" && (
          <div className="project-form">
            <div className="setting-group">
              <label>文件夹路径</label>
              <div className="path-input-group">
                <input
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="点击右边按钮选择文件夹"
                />
                <button className="path-picker-btn" onClick={handlePickFolder} title="选择文件夹">
                  📁
                </button>
              </div>
              {isTauri() && (
                <p className="project-form-hint">点击 📁 按钮打开系统文件选择器</p>
              )}
            </div>
            <p className="project-form-hint">导入已有文件夹作为项目，会自动创建 .codem 目录和 AGENTS.md</p>
            <div className="project-form-actions">
              <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
              <button className="project-action-btn primary" onClick={handleImport}>导入</button>
            </div>
          </div>
        )}

        {mode === "git-create" && (
          <div className="project-form">
            {gitStatus === "idle" && (
              <>
                <div className="setting-group">
                  <label>GitHub 仓库名</label>
                  <input
                    type="text"
                    value={gitRepoName}
                    onChange={(e) => setGitRepoName(e.target.value)}
                    placeholder="my-awesome-project"
                    style={{ fontFamily: "monospace" }}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    将在 GitHub 上创建同名仓库，并在本地 git init
                  </div>
                </div>
                <div className="setting-group">
                  <label>本地项目路径</label>
                  <div className="path-input-group">
                    <input
                      type="text"
                      value={gitProjectPath}
                      onChange={(e) => setGitProjectPath(e.target.value)}
                      placeholder="点击右边按钮选择文件夹"
                    />
                    <button className="path-picker-btn" onClick={async () => {
                      const folder = await openFolderPicker();
                      if (folder) {
                        setGitProjectPath(folder);
                        if (!gitRepoName.trim()) {
                          const folderName = folder.split(/[/\\]/).pop() || "";
                          setGitRepoName(folderName);
                        }
                      }
                    }} title="选择文件夹">
                      📁
                    </button>
                  </div>
                  {isTauri() && (
                    <p className="project-form-hint">点击 📁 按钮打开系统文件选择器</p>
                  )}
                </div>
                <div className="setting-group">
                  <label>描述 (可选)</label>
                  <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="项目描述" />
                </div>
                <div className="setting-group">
                  <label>仓库可见性</label>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="radio"
                        checked={gitIsPrivate}
                        onChange={() => setGitIsPrivate(true)}
                      />
                      🔒 私有
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="radio"
                        checked={!gitIsPrivate}
                        onChange={() => setGitIsPrivate(false)}
                      />
                      🌍 公开
                    </label>
                  </div>
                </div>
                <div className="setting-group">
                  <label>GitHub Token</label>
                  <input
                    type="password"
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    style={{ fontFamily: "monospace" }}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    需要 repo 权限。
                    <a href="https://github.com/settings/tokens/new?scopes=repo" target="_blank" rel="noopener" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                      点击创建 Token
                    </a>
                    {getSettingJSON<GitConfig>("codem-git-config", {}).githubToken && "（已保存，可从设置中清除）"}
                  </div>
                </div>
                <div className="project-form-actions">
                  <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
                  <button
                    className="project-action-btn primary"
                    onClick={handleGitCreate}
                    disabled={!gitRepoName.trim() || !gitProjectPath.trim() || !gitToken.trim()}
                  >
                    🔗 创建并推送
                  </button>
                </div>
              </>
            )}

            {gitStatus === "creating" && (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
                <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>{gitStatusMsg}</p>
              </div>
            )}

            {gitStatus === "done" && (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>✅</div>
                <p style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 500 }}>{gitStatusMsg}</p>
              </div>
            )}

            {gitStatus === "error" && (
              <div style={{ padding: "20px 0" }}>
                <div style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>❌ 创建失败</div>
                <pre style={{
                  background: "var(--bg-hover, #2a2a3a)",
                  padding: 12, borderRadius: 8, fontSize: 12, color: "#ef4444",
                  maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {gitStatusMsg}
                </pre>
                <button
                  onClick={() => { setGitStatus("idle"); setGitStatusMsg(""); }}
                  style={{ marginTop: 12, padding: "8px 20px", borderRadius: 8, border: "none",
                    background: "var(--accent, #ff6b35)", color: "#fff", cursor: "pointer", fontSize: 14, width: "100%" }}
                >
                  重试
                </button>
              </div>
            )}
          </div>
        )}

        {mode === "git-clone" && (
          <div className="project-form">
            {cloneStatus === "idle" && (
              <>
                <div className="setting-group">
                  <label>GitHub 仓库地址</label>
                  <input
                    type="text"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    onKeyDown={(e) => { if (e.key === "Enter" && cloneUrl.trim()) handleClone(); }}
                    autoFocus
                    style={{ fontFamily: "monospace" }}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    输入 GitHub 仓库 URL，将自动 clone 到本地并创建项目
                  </div>
                </div>
                <div className="project-form-actions">
                  <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
                  <button
                    className="project-action-btn primary"
                    onClick={handleClone}
                    disabled={!cloneUrl.trim()}
                  >
                    📥 拉取
                  </button>
                </div>
              </>
            )}

            {cloneStatus === "cloning" && (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
                <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>{cloneMsg}</p>
              </div>
            )}

            {cloneStatus === "done" && (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>✅</div>
                <p style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 500 }}>{cloneMsg}</p>
              </div>
            )}

            {cloneStatus === "error" && (
              <div style={{ padding: "20px 0" }}>
                <div style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>❌ 克隆失败</div>
                <pre style={{
                  background: "var(--bg-hover, #2a2a3a)",
                  padding: 12, borderRadius: 8, fontSize: 12, color: "#ef4444",
                  maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {cloneMsg}
                </pre>
                <button
                  onClick={() => { setCloneStatus("idle"); setCloneMsg(""); }}
                  style={{ marginTop: 12, padding: "8px 20px", borderRadius: 8, border: "none",
                    background: "var(--accent, #ff6b35)", color: "#fff", cursor: "pointer", fontSize: 14, width: "100%" }}
                >
                  重试
                </button>
              </div>
            )}
          </div>
        )}

        {mode === "env" && (
          <div className="project-form">
            <div className="setting-group">
              <label>🏗️ 环境脚本配置</label>
              <p className="project-form-hint">配置打开/关闭项目时自动执行的脚本</p>
            </div>
            <div className="setting-group">
              <label>设置脚本（打开项目时自动执行）</label>
              <input
                type="text"
                value={envConfig.setupScript || ""}
                onChange={(e) => setEnvConfig({ ...envConfig, setupScript: e.target.value })}
                placeholder="如 npm install"
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div className="setting-group">
              <label>清理脚本（切换/关闭项目时执行）</label>
              <input
                type="text"
                value={envConfig.cleanupScript || ""}
                onChange={(e) => setEnvConfig({ ...envConfig, cleanupScript: e.target.value })}
                placeholder="如 docker compose down"
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div className="project-form-actions">
              <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
              <button
                className="project-action-btn primary"
                onClick={() => {
                  setSettingJSON("codem-env-config", envConfig);
                  setEnvSaved(true);
                  setTimeout(() => { setEnvSaved(false); setMode("list"); }, 1000);
                }}
              >
                {envSaved ? "✅ 已保存" : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
