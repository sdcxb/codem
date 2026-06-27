import { useState, useEffect } from "react";
import { useProjectStore } from "../core/store";
import { createProjectFiles, loadProjectInstructions, loadProjectSkills, loadProjectMemory } from "../core/project/files";

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

interface ProjectManagerProps {
  onClose: () => void;
}

export function ProjectManager({ onClose }: ProjectManagerProps) {
  const { projects, createProject, openProject, deleteProject, setProjects, setInstructions, setSkills, setMemories } = useProjectStore();
  const [mode, setMode] = useState<"list" | "create" | "import">("list");
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newDesc, setNewDesc] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("mimo-projects");
    if (stored) setProjects(JSON.parse(stored));
  }, []);

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    await createProjectFiles(newPath);
    const project = createProject(newName, newPath, newDesc);
    localStorage.setItem("mimo-projects", JSON.stringify([...projects, project]));
    await loadProjectData(newPath);
    onClose();
  };

  const handleImport = async () => {
    if (!newPath.trim()) return;
    const name = newPath.split("\\").pop() || "导入项目";
    const project = createProject(name, newPath, "导入的项目");
    localStorage.setItem("mimo-projects", JSON.stringify([...projects, project]));
    await loadProjectData(newPath);
    onClose();
  };

  const handleOpen = async (project: typeof projects[0]) => {
    openProject(project.id);
    await loadProjectData(project.path);
    onClose();
  };

  const handleDelete = (projectId: string) => {
    if (!confirm("确定删除此项目？")) return;
    deleteProject(projectId);
    const updated = projects.filter((p) => p.id !== projectId);
    localStorage.setItem("mimo-projects", JSON.stringify(updated));
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
            <div className="project-actions">
              <button className="project-action-btn" onClick={() => setMode("create")}>
                ➕ 新建项目
              </button>
              <button className="project-action-btn" onClick={() => setMode("import")}>
                📂 导入文件夹
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
            <p className="project-form-hint">导入已有文件夹作为项目，会自动创建 .mimo 目录和 AGENTS.md</p>
            <div className="project-form-actions">
              <button className="project-action-btn secondary" onClick={() => setMode("list")}>返回</button>
              <button className="project-action-btn primary" onClick={handleImport}>导入</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
