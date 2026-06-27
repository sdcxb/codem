import { useState, useEffect } from "react";
import { getMemoryService, type MemoryEntry, type MemoryScope, type MemorySearchResult } from "../core/memory/memory";

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

export function MemoryManager({ onClose }: MemoryManagerProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [filterScope, setFilterScope] = useState<MemoryScope | "all">("all");
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntry | null>(null);
  const [stats, setStats] = useState({ totalEntries: 0, byScope: { project: 0, session: 0, global: 0 } });

  useEffect(() => {
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
        <button className="memory-manager-close" onClick={onClose}>✕</button>
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
                className="memory-delete-btn"
                onClick={() => handleDelete(selectedEntry.id)}
              >
                🗑️ 删除
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
