import { useState, useEffect } from "react";
import { getMemoryService, type MemoryEntry, type MemoryScope, type MemorySearchResult } from "../core/memory/memory";
import { getLLMEngine } from "../core/llm";

interface MemoryManagerProps {
  onClose: () => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN");
}

function getScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case "project": return "项目";
    case "session": return "会话";
    case "global": return "全局";
    default: return scope;
  }
}

function getScopeColor(scope: MemoryScope): string {
  switch (scope) {
    case "project": return "var(--accent)";
    case "session": return "var(--success)";
    case "global": return "var(--warning)";
    default: return "var(--text-muted)";
  }
}

interface EditForm {
  key: string;
  content: string;
  scope: MemoryScope;
  tags: string;
  filePath: string;
}

const EMPTY_FORM: EditForm = {
  key: "",
  content: "",
  scope: "project",
  tags: "",
  filePath: "",
};

export function MemoryManager({ onClose }: MemoryManagerProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [filterScope, setFilterScope] = useState<MemoryScope | "all">("all");
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntry | null>(null);
  const [stats, setStats] = useState({ totalEntries: 0, byScope: { project: 0, session: 0, global: 0 } });

  // F1.1: Edit/Create state
  const [editMode, setEditMode] = useState<"none" | "create" | "edit">("none");
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_FORM);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    // Reload from DB in case singleton was created before DB was ready
    getMemoryService().reload();
    loadEntries();
  }, []);

  const loadEntries = () => {
    const service = getMemoryService();
    const allEntries: MemoryEntry[] = [];
    for (const scope of ["project", "session", "global"] as MemoryScope[]) {
      allEntries.push(...service.listByScope(scope));
    }
    setEntries(allEntries.sort((a, b) => b.timestamp - a.timestamp));
    setStats(service.getStats());
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const service = getMemoryService();
    const scope = filterScope === "all" ? undefined : filterScope;
    const results = service.search(searchQuery, scope);
    setSearchResults(results);
  };

  const handleDelete = (id: string) => {
    const service = getMemoryService();
    service.delete(id);
    loadEntries();
    if (selectedEntry?.id === id) {
      setSelectedEntry(null);
    }
  };

  // F1.1: Create new entry
  const handleStartCreate = () => {
    setEditMode("create");
    setEditForm(EMPTY_FORM);
    setEditError("");
    setSelectedEntry(null);
  };

  // F1.1: Edit existing entry
  const handleStartEdit = (entry: MemoryEntry) => {
    setEditMode("edit");
    setEditForm({
      key: entry.key,
      content: entry.content,
      scope: entry.scope,
      tags: entry.tags?.join(", ") || "",
      filePath: entry.filePath || "",
    });
    setEditError("");
  };

  // F1.1: Save (create or update)
  const handleSave = () => {
    if (!editForm.key.trim()) {
      setEditError("请填写键名");
      return;
    }
    if (!editForm.content.trim()) {
      setEditError("请填写内容");
      return;
    }

    const service = getMemoryService();
    const tags = editForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (editMode === "create") {
      service.add({
        key: editForm.key.trim(),
        content: editForm.content,
        scope: editForm.scope,
        tags: tags.length > 0 ? tags : undefined,
        filePath: editForm.filePath.trim() || undefined,
      });
    } else if (editMode === "edit" && selectedEntry) {
      service.update(selectedEntry.id, {
        key: editForm.key.trim(),
        content: editForm.content,
        scope: editForm.scope,
        tags: tags.length > 0 ? tags : undefined,
        filePath: editForm.filePath.trim() || undefined,
      });
    }

    setEditMode("none");
    setEditForm(EMPTY_FORM);
    setEditError("");
    loadEntries();
  };

  const handleCancelEdit = () => {
    setEditMode("none");
    setEditForm(EMPTY_FORM);
    setEditError("");
  };

  // F2.4: Export / Import handlers
  const handleExportJSON = () => {
    const json = getMemoryService().exportAsJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportMarkdown = () => {
    const md = getMemoryService().exportAsMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-${new Date().toISOString().split("T")[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const jsonStr = reader.result as string;
      const count = getMemoryService().importFromJSON(jsonStr, false);
      alert(count > 0 ? `成功导入 ${count} 条记忆` : "未导入任何记忆（可能所有记忆已存在）");
      loadEntries();
    };
    reader.readAsText(file);
    // Reset input so the same file can be selected again
    e.target.value = "";
  };

  const filteredEntries = filterScope === "all"
    ? entries
    : entries.filter((e) => e.scope === filterScope);

  const displayEntries = searchResults.length > 0
    ? searchResults.map((r) => r.entry)
    : filteredEntries;

  return (
    <div className="memory-manager">
      <div className="memory-manager-header">
        <div className="memory-manager-title">
          <span className="memory-manager-icon">🧠</span>
          <span>记忆系统</span>
        </div>
        <div className="memory-manager-actions">
          {editMode === "none" && (
            <>
              <button className="memory-action-btn" onClick={handleStartCreate}>
                + 新增
              </button>
              {/* F2.4: Export / Import */}
              <button className="memory-action-btn" onClick={handleExportJSON} title="导出为 JSON">
                JSON
              </button>
              <button className="memory-action-btn" onClick={handleExportMarkdown} title="导出为 Markdown">
                MD
              </button>
              <label className="memory-action-btn memory-action-label" title="导入 JSON">
                导入
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={handleImportJSON}
                />
              </label>
              {/* F3.1: Memory consolidation button */}
              <button
                className="memory-action-btn"
                title="整合记忆：去重、清理过期、裁剪超额"
                onClick={() => {
                  const result = getLLMEngine().consolidateMemories();
                  const msg = `整合完成：合并 ${result.duplicatesMerged} 条重复，清理 ${result.staleRemoved} 条过期，裁剪 ${result.capacityTrimmed} 条超额`;
                  alert(msg);
                  window.location.reload();
                }}
              >
                整合
              </button>
            </>
          )}
          <button className="memory-manager-close" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="memory-stats">
        <div className="memory-stat">
          <span className="memory-stat-value">{stats.totalEntries}</span>
          <span className="memory-stat-label">总计</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value project">{stats.byScope.project}</span>
          <span className="memory-stat-label">项目</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value session">{stats.byScope.session}</span>
          <span className="memory-stat-label">会话</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value global">{stats.byScope.global}</span>
          <span className="memory-stat-label">全局</span>
        </div>
      </div>

      {/* F1.1: Edit/Create Form */}
      {editMode !== "none" && (
        <div className="memory-edit-form">
          <div className="memory-edit-form-title">
            {editMode === "create" ? "新增记忆" : "编辑记忆"}
          </div>
          {editError && <div className="memory-edit-error">{editError}</div>}
          <div className="memory-edit-field">
            <label>键名</label>
            <input
              type="text"
              value={editForm.key}
              onChange={(e) => setEditForm({ ...editForm, key: e.target.value })}
              placeholder="记忆的唯一标识"
            />
          </div>
          <div className="memory-edit-field">
            <label>范围</label>
            <select
              value={editForm.scope}
              onChange={(e) => setEditForm({ ...editForm, scope: e.target.value as MemoryScope })}
            >
              <option value="project">项目</option>
              <option value="session">会话</option>
              <option value="global">全局</option>
            </select>
          </div>
          <div className="memory-edit-field">
            <label>内容</label>
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
              placeholder="记忆内容"
              rows={6}
            />
          </div>
          <div className="memory-edit-field">
            <label>标签 (逗号分隔)</label>
            <input
              type="text"
              value={editForm.tags}
              onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
              placeholder="标签1, 标签2"
            />
          </div>
          <div className="memory-edit-field">
            <label>文件路径 (可选)</label>
            <input
              type="text"
              value={editForm.filePath}
              onChange={(e) => setEditForm({ ...editForm, filePath: e.target.value })}
              placeholder="/path/to/file"
            />
          </div>
          <div className="memory-edit-actions">
            <button className="memory-save-btn" onClick={handleSave}>💾 保存</button>
            <button className="memory-cancel-btn" onClick={handleCancelEdit}>取消</button>
          </div>
        </div>
      )}

      {editMode === "none" && (
        <>
          <div className="memory-search">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="搜索记忆..."
            />
            <button onClick={handleSearch}>🔍</button>
          </div>

          <div className="memory-filters">
            {(["all", "project", "session", "global"] as const).map((scope) => (
              <button
                key={scope}
                className={`memory-filter-btn ${filterScope === scope ? "active" : ""}`}
                onClick={() => { setFilterScope(scope); setSearchResults([]); }}
              >
                {scope === "all" ? "全部" : getScopeLabel(scope)}
              </button>
            ))}
          </div>
        </>
      )}

      {editMode === "none" && (
        <div className="memory-content">
          <div className="memory-list">
            {displayEntries.length === 0 && (
              <div className="memory-empty">暂无记忆条目</div>
            )}
            {displayEntries.map((entry) => (
              <div
                key={entry.id}
                className={`memory-item ${selectedEntry?.id === entry.id ? "selected" : ""}`}
                onClick={() => setSelectedEntry(selectedEntry?.id === entry.id ? null : entry)}
              >
                <div className="memory-item-header">
                  <span className="memory-item-key">{entry.key}</span>
                  <span
                    className="memory-item-scope"
                    style={{ color: getScopeColor(entry.scope) }}
                  >
                    {getScopeLabel(entry.scope)}
                  </span>
                </div>
                <div className="memory-item-preview">
                  {entry.content.substring(0, 100)}...
                </div>
                <div className="memory-item-meta">
                  <span>{formatTime(entry.timestamp)}</span>
                  {entry.tags && entry.tags.length > 0 && (
                    <span className="memory-item-tags">
                      {entry.tags.slice(0, 3).join(", ")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {selectedEntry && (
            <div className="memory-detail">
              <div className="memory-detail-header">
                <h3>{selectedEntry.key}</h3>
                <span
                  className="memory-detail-scope"
                  style={{ color: getScopeColor(selectedEntry.scope) }}
                >
                  {getScopeLabel(selectedEntry.scope)}
                </span>
              </div>

              <div className="memory-detail-section">
                <label>ID</label>
                <span className="memory-detail-mono">{selectedEntry.id}</span>
              </div>

              <div className="memory-detail-section">
                <label>创建时间</label>
                <span>{formatTime(selectedEntry.timestamp)}</span>
              </div>

              {selectedEntry.filePath && (
                <div className="memory-detail-section">
                  <label>文件路径</label>
                  <span className="memory-detail-mono">{selectedEntry.filePath}</span>
                </div>
              )}

              {selectedEntry.tags && selectedEntry.tags.length > 0 && (
                <div className="memory-detail-section">
                  <label>标签</label>
                  <div className="memory-detail-tags">
                    {selectedEntry.tags.map((tag) => (
                      <span key={tag} className="memory-detail-tag">{tag}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="memory-detail-section">
                <label>内容</label>
                <pre className="memory-detail-content">{selectedEntry.content}</pre>
              </div>

              <div className="memory-detail-actions">
                <button
                  className="memory-edit-btn"
                  onClick={() => handleStartEdit(selectedEntry)}
                >
                  ✏️ 编辑
                </button>
                <button
                  className="memory-delete-btn"
                  onClick={() => handleDelete(selectedEntry.id)}
                >
                  🗑️ 删除
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
