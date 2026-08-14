import { useState, useEffect, useMemo, useCallback } from "react";
import {
  type MCPRegistryEntry,
  type MCPCategory,
  getCatalog,
  getCategories,
  searchCatalog,
  installCatalogEntry,
  uninstallCatalogEntry,
  isEntryInstalled,
  getInstalledEntryNames,
  CATEGORY_LABELS,
} from "../core/mcp/mcp-registry-catalog";
import type { MCPServerConfig } from "../core/mcp/mcp";
import { getMCPRegistry } from "../core/mcp/mcp";
import { ActionIcons } from "../core/icons/icon-map";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

interface McpMarketplaceProps {
  onClose: () => void;
}

/** 安装进度状态 */
interface InstallState {
  entryId: string;
  installing: boolean;
  result?: { success: boolean; error?: string };
}

export function McpMarketplace({ onClose }: McpMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<MCPCategory | "all">("all");
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [installStates, setInstallStates] = useState<Map<string, InstallState>>(new Map());
  const [configTarget, setConfigTarget] = useState<MCPRegistryEntry | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [detailEntry, setDetailEntry] = useState<MCPRegistryEntry | null>(null);

  // 加载已安装列表
  const refreshInstalled = useCallback(() => {
    setInstalledNames(getInstalledEntryNames());
  }, []);

  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

  // 过滤后的条目
  const entries = useMemo(() => {
    let result = query ? searchCatalog(query) : getCatalog();
    if (activeCategory !== "all") {
      result = result.filter((e) => e.category === activeCategory);
    }
    return result;
  }, [query, activeCategory]);

  const categories = useMemo(() => getCategories(), []);

  // 安装
  const handleInstall = (entry: MCPRegistryEntry, env?: Record<string, string>) => {
    setInstallStates((prev) => {
      const next = new Map(prev);
      next.set(entry.id, { entryId: entry.id, installing: true });
      return next;
    });

    // 执行安装
    const result = installCatalogEntry(entry, env);

    setInstallStates((prev) => {
      const next = new Map(prev);
      next.set(entry.id, { entryId: entry.id, installing: false, result });
      return next;
    });

    if (result.success) {
      refreshInstalled();
    }

    // 3秒后清除结果
    setTimeout(() => {
      setInstallStates((prev) => {
        const next = new Map(prev);
        next.delete(entry.id);
        return next;
      });
    }, 3000);
  };

  // 卸载
  const handleUninstall = (entry: MCPRegistryEntry) => {
    const result = uninstallCatalogEntry(entry);
    if (result.success) {
      refreshInstalled();
    }
  };

  // 打开配置对话框
  const handleOpenConfig = (entry: MCPRegistryEntry) => {
    setConfigTarget(entry);
    setEnvValues({});
  };

  // 配置确认安装
  const handleConfigInstall = () => {
    if (!configTarget) return;
    handleInstall(configTarget, envValues);
    setConfigTarget(null);
    setEnvValues({});
  };

  const CloseIcon = ActionIcons.close;
  const SearchIcon = ActionIcons.search;
  const InstallIcon = ActionIcons.add;
  const UninstallIcon = ActionIcons.delete;

  return (
    <div className="mcp-marketplace">
      {/* Header */}
      <div className="mcp-marketplace-header">
        <div className="mcp-marketplace-title">
          <span className="mcp-marketplace-title-icon">🏪</span>
          <span>MCP 服务器目录</span>
        </div>
        <button className="mcp-marketplace-close" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      {/* Search Bar */}
      <div className="mcp-marketplace-search">
        <SearchIcon size={16} className="mcp-search-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 MCP 服务器..."
          className="mcp-search-input"
        />
        {query && (
          <button className="mcp-search-clear" onClick={() => setQuery("")}>
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {/* Category Filter */}
      <div className="mcp-marketplace-categories">
        <button
          className={`mcp-category-btn ${activeCategory === "all" ? "active" : ""}`}
          onClick={() => setActiveCategory("all")}
        >
          <span>全部</span>
          <Badge>{getCatalog().length}</Badge>
        </button>
        {categories.map((cat) => {
          const label = CATEGORY_LABELS[cat];
          const count = getCatalog().filter((e) => e.category === cat).length;
          return (
            <button
              key={cat}
              className={`mcp-category-btn ${activeCategory === cat ? "active" : ""}`}
              onClick={() => setActiveCategory(cat)}
            >
              <span>{label.icon} {label.zh}</span>
              <Badge>{count}</Badge>
            </button>
          );
        })}
      </div>

      {/* Entry Grid */}
      <div className="mcp-marketplace-grid">
        {entries.length === 0 && (
          <div className="mcp-marketplace-empty">
            {query ? `未找到匹配 "${query}" 的 MCP 服务器` : "暂无服务器"}
          </div>
        )}
        {entries.map((entry) => {
          const isInstalled = installedNames.has(entry.id) || installedNames.has(entry.name);
          const state = installStates.get(entry.id);
          const label = CATEGORY_LABELS[entry.category];

          return (
            <div key={entry.id} className={`mcp-catalog-card ${isInstalled ? "installed" : ""}`}>
              <div className="mcp-catalog-card-header">
                <span className="mcp-catalog-icon">{entry.icon || "📦"}</span>
                <div className="mcp-catalog-title-area">
                  <span className="mcp-catalog-name" onClick={() => setDetailEntry(entry)}>
                    {entry.name}
                  </span>
                  <span className="mcp-catalog-author">by {entry.author}</span>
                </div>
                {isInstalled && (
                  <span className="mcp-catalog-installed-badge">✓ 已安装</span>
                )}
              </div>

              <p className="mcp-catalog-description">{entry.description}</p>

              <div className="mcp-catalog-tags">
                <Badge variant="muted">{label.icon} {label.zh}</Badge>
                <Badge variant="info">{entry.transport}</Badge>
                {entry.requiresApiKey && (
                  <Badge variant="warning">需要 API Key</Badge>
                )}
              </div>

              <div className="mcp-catalog-actions">
                {state?.result && !state.result.success && (
                  <span className="mcp-catalog-error">{state.result.error}</span>
                )}
                {state?.result?.success && (
                  <span className="mcp-catalog-success">安装成功!</span>
                )}
                {isInstalled ? (
                  <button
                    className="mcp-catalog-btn uninstall"
                    onClick={() => handleUninstall(entry)}
                    disabled={state?.installing}
                  >
                    <UninstallIcon size={14} />
                    卸载
                  </button>
                ) : entry.requiresApiKey ? (
                  <button
                    className="mcp-catalog-btn install"
                    onClick={() => handleOpenConfig(entry)}
                    disabled={state?.installing}
                  >
                    {state?.installing ? "安装中..." : "配置并安装"}
                  </button>
                ) : (
                  <button
                    className="mcp-catalog-btn install"
                    onClick={() => handleInstall(entry)}
                    disabled={state?.installing}
                  >
                    <InstallIcon size={14} />
                    {state?.installing ? "安装中..." : "一键安装"}
                  </button>
                )}
                {entry.homepage && (
                  <a
                    href={entry.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mcp-catalog-link"
                  >
                    文档 ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Config Dialog (for entries requiring API Key) */}
      <Dialog open={!!configTarget} onOpenChange={(open) => !open && setConfigTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>配置 {configTarget?.name}</DialogTitle>
            <DialogDescription>
              该 MCP 服务器需要以下环境变量。请填入您的 API Key 后安装。
            </DialogDescription>
          </DialogHeader>
          {configTarget?.requiresApiKey && (
            <div className="mcp-config-form">
              <div className="mcp-config-row">
                <label>{configTarget.requiresApiKey}</label>
                <input
                  type="password"
                  value={envValues[configTarget.requiresApiKey] || ""}
                  onChange={(e) =>
                    setEnvValues({
                      ...envValues,
                      [configTarget.requiresApiKey!]: e.target.value,
                    })
                  }
                  placeholder={`输入 ${configTarget.requiresApiKey}`}
                />
              </div>
              {configTarget.homepage && (
                <p className="mcp-config-hint">
                  如何获取 API Key？请查看{" "}
                  <a href={configTarget.homepage} target="_blank" rel="noopener noreferrer">
                    官方文档 ↗
                  </a>
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <button className="mcp-form-btn cancel" onClick={() => setConfigTarget(null)}>
              取消
            </button>
            <button
              className="mcp-form-btn confirm"
              onClick={handleConfigInstall}
              disabled={!!configTarget?.requiresApiKey && !envValues[configTarget.requiresApiKey]}
            >
              安装
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={!!detailEntry} onOpenChange={(open) => !open && setDetailEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {detailEntry?.icon} {detailEntry?.name}
            </DialogTitle>
            <DialogDescription>{detailEntry?.description}</DialogDescription>
          </DialogHeader>
          {detailEntry && (
            <div className="mcp-detail-info">
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">作者:</span>
                <span>{detailEntry.author}</span>
              </div>
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">分类:</span>
                <span>{CATEGORY_LABELS[detailEntry.category].icon} {CATEGORY_LABELS[detailEntry.category].zh}</span>
              </div>
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">传输:</span>
                <span>{detailEntry.transport}</span>
              </div>
              {detailEntry.command && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">命令:</span>
                  <code className="mcp-detail-code">
                    {detailEntry.command} {(detailEntry.args || []).join(" ")}
                  </code>
                </div>
              )}
              {detailEntry.url && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">URL:</span>
                  <code className="mcp-detail-code">{detailEntry.url}</code>
                </div>
              )}
              {detailEntry.tags && detailEntry.tags.length > 0 && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">标签:</span>
                  <div className="mcp-detail-tags">
                    {detailEntry.tags.map((t) => (
                      <Badge key={t} variant="muted">{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {detailEntry.requiresApiKey && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">需要:</span>
                  <Badge variant="warning">{detailEntry.requiresApiKey}</Badge>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <button className="mcp-form-btn cancel" onClick={() => setDetailEntry(null)}>
              关闭
            </button>
            {detailEntry && !installedNames.has(detailEntry.id) && !installedNames.has(detailEntry.name) && (
              <button
                className="mcp-form-btn confirm"
                onClick={() => {
                  if (detailEntry.requiresApiKey) {
                    handleOpenConfig(detailEntry);
                  } else {
                    handleInstall(detailEntry);
                  }
                  setDetailEntry(null);
                }}
              >
                安装
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ========== Badge helper (local, to avoid import cycle) ==========
function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: string }) {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}
