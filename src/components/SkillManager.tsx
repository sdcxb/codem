import { useState, useEffect, useCallback, useRef } from "react";
import { getSkillRegistry, type SkillDefinition } from "../core/skill/skill";
import { installSkillFromZip, uninstallSkill, readZipFile, type InstallResult } from "../core/skill/installer";
import {
  listMarketSkills,
  searchMarketSkillsOnline,
  installMarketSkill,
  isMarketSkillInstalled,
  getMarketSources,
  getSourceIcon,
  publishSkillToMarket,
  listPublishableMarkets,
  type MarketSkill,
  type MarketSource,
  type PublishTarget,
  type PublishableMarket,
} from "../core/skill/skill-market-client";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { PanelIcons, ActionIcons, SkillSourceIcons, StatusIcons, CommonIcons, MarketIcons } from "../core/icons/icon-map";
import { Switch } from "./ui/switch";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Progress } from "./ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

interface SkillManagerProps {
  onClose: () => void;
}

/** 技能禁用状态持久化 key */
const DISABLED_SKILLS_KEY = "codem-disabled-skills";

/** 获取禁用技能列表 */
function getDisabledSkills(): string[] {
  return getSettingJSON<string[]>(DISABLED_SKILLS_KEY, []);
}

/** 设置技能禁用状态 */
function setSkillDisabled(skillName: string, disabled: boolean) {
  const current = getDisabledSkills();
  if (disabled) {
    if (!current.includes(skillName)) {
      current.push(skillName);
      setSettingJSON(DISABLED_SKILLS_KEY, current);
    }
  } else {
    setSettingJSON(DISABLED_SKILLS_KEY, current.filter((s) => s !== skillName));
  }
}

/** 检查技能是否启用 */
function isSkillEnabled(skillName: string): boolean {
  return !getDisabledSkills().includes(skillName);
}

export function SkillManager({ onClose }: SkillManagerProps) {
  // ===== Tab State =====
  const [activeTab, setActiveTab] = useState<"my-skills" | "market">("my-skills");

  // ===== My Skills State =====
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillDefinition | null>(null);
  const [filter, setFilter] = useState<"all" | "builtin" | "user" | "external">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [installProgress, setInstallProgress] = useState<{ value: number; message: string } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillDefinition | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<{ zipData: Uint8Array; skillName: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ===== Market State =====
  const [marketSkills, setMarketSkills] = useState<MarketSkill[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketSearchQuery, setMarketSearchQuery] = useState("");
  const [marketSourceFilter, setMarketSourceFilter] = useState<string>("all");
  const [marketSources, setMarketSources] = useState<MarketSource[]>([]);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [marketInstallProgress, setMarketInstallProgress] = useState<{ value: number; message: string } | null>(null);
  const [selectedMarketSkill, setSelectedMarketSkill] = useState<MarketSkill | null>(null);

  // ===== Publish State =====
  const [publishTarget, setPublishTarget] = useState<SkillDefinition | null>(null);
  const [publishMarkets, setPublishMarkets] = useState<PublishableMarket[]>([]);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);
  const [publishForm, setPublishForm] = useState({
    target: "clawhub" as PublishTarget,
    slug: "",
    displayName: "",
    version: "1.0.0",
    changelog: "",
    githubPrivate: false,
  });

  // ===== My Skills Logic =====
  const loadSkills = useCallback(() => {
    const registry = getSkillRegistry();
    const all = registry.getAll().map((s) => ({
      ...s,
      enabled: isSkillEnabled(s.name),
    }));
    setSkills(all);
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills, refreshKey]);

  const filteredSkills = skills.filter((s) => {
    if (filter !== "all" && s.source !== filter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const name = String(s.name || "");
      const description = String(s.description || "");
      const aliases = Array.isArray(s.aliases) ? s.aliases : [];
      const tags = Array.isArray(s.tags) ? s.tags : [];
      return (
        name.toLowerCase().includes(q) ||
        description.toLowerCase().includes(q) ||
        aliases.some((a) => String(a).toLowerCase().includes(q)) ||
        tags.some((t) => String(t).toLowerCase().includes(q))
      );
    }
    return true;
  });

  const handleZipInstall = async (zipData: Uint8Array, overwrite: boolean = false) => {
    setInstallProgress({ value: 0, message: "准备安装..." });
    setInstallError(null);

    const result: InstallResult = await installSkillFromZip(
      zipData,
      (progress, message) => setInstallProgress({ value: progress, message }),
      overwrite,
    );

    if (result.success) {
      setInstallProgress(null);
      setRefreshKey((k) => k + 1);
    } else {
      if (result.skillName && !overwrite && result.error?.includes("已存在")) {
        setOverwriteTarget({ zipData, skillName: result.skillName });
        setInstallProgress(null);
      } else {
        setInstallError(result.error || "安装失败");
        setInstallProgress(null);
      }
    }
  };

  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith(".zip")) {
      setInstallError("请选择 ZIP 文件");
      return;
    }
    try {
      const zipData = await readZipFile(file);
      await handleZipInstall(zipData);
    } catch (err: any) {
      setInstallError(`读取文件失败: ${err.message}`);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleToggleEnabled = (skillName: string, enabled: boolean) => {
    setSkillDisabled(skillName, !enabled);
    setSkills((prev) => prev.map((s) => s.name === skillName ? { ...s, enabled } : s));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const result = await uninstallSkill(deleteTarget.name);
    if (result.success) {
      setDeleteTarget(null);
      setSelectedSkill(null);
      setRefreshKey((k) => k + 1);
    } else {
      setInstallError(result.error || "删除失败");
      setDeleteTarget(null);
    }
  };

  function getSourceLabel(source: string): string {
    const labels: Record<string, string> = {
      builtin: "内置",
      project: "项目",
      user: "用户",
      external: "外部",
    };
    return labels[source] || source;
  }

  function getSourceBadgeVariant(source: string): "default" | "success" | "warning" | "info" | "muted" {
    const variants: Record<string, "default" | "success" | "warning" | "info" | "muted"> = {
      builtin: "info",
      project: "success",
      user: "warning",
      external: "muted",
    };
    return variants[source] || "default";
  }

  // ===== Market Cache =====
  const MARKET_CACHE_KEY = "codem-market-skills-cache";
  const MARKET_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  /** 从缓存加载市场技能列表（快速显示） */
  const loadCachedMarketSkills = useCallback(() => {
    try {
      const cached = getSettingJSON<{ skills: MarketSkill[]; sources: MarketSource[]; ts: number } | null>(MARKET_CACHE_KEY, null);
      if (cached && cached.skills && Array.isArray(cached.skills) && cached.skills.length > 0) {
        setMarketSkills(cached.skills);
        setMarketSources(cached.sources || []);
        return true;
      }
    } catch {}
    return false;
  }, []);

  // ===== Market Logic =====
  const loadMarketSkills = useCallback(async (silent: boolean = false) => {
    if (!silent) {
      setMarketLoading(true);
      setMarketError(null);
    }
    // 不清空列表 — 保留已有数据避免闪烁

    try {
      const sources = getMarketSources();
      setMarketSources(sources);

      const result = await listMarketSkills(sources, (sourceId, sourceSkills) => {
        // 渐进式更新：每加载完一个源就更新列表
        // 防御性检查：确保 sourceSkills 是数组
        if (!Array.isArray(sourceSkills)) return;
        setMarketSkills((prev) => {
          if (!Array.isArray(prev)) return sourceSkills;
          // 移除该源的旧数据
          const filtered = prev.filter((s) => s.sourceId !== sourceId);
          // 添加新数据
          return [...filtered, ...sourceSkills];
        });
      });

      // 最终更新
      setMarketSkills(result.skills);

      // 缓存到 settings
      try {
        setSettingJSON(MARKET_CACHE_KEY, { skills: result.skills, sources, ts: Date.now() });
      } catch {}

      if (result.errors.length > 0) {
        const errorMessages = result.errors
          .map((e) => `${e.sourceName}: ${e.error}`)
          .join("; ");
        setMarketError(`部分源加载失败: ${errorMessages}`);
      }
    } catch (err: any) {
      setMarketError(`市场加载失败: ${err.message || String(err)}`);
    } finally {
      setMarketLoading(false);
    }
  }, []);

  // 切换到市场 Tab 时先从缓存快速加载，再后台增量更新
  useEffect(() => {
    if (activeTab === "market" && marketSkills.length === 0 && !marketLoading) {
      // 先从缓存快速加载
      const hasCache = loadCachedMarketSkills();
      // 后台静默增量更新（仅在缓存超过 TTL 或无缓存时才联网）
      if (!hasCache) {
        loadMarketSkills(false);
      } else {
        // 缓存在 TTL 内不再自动联网，用户可手动点"检查更新"
        // 如果缓存过期则后台静默更新
        try {
          const cached = getSettingJSON<{ ts: number } | null>(MARKET_CACHE_KEY, null);
          if (cached && Date.now() - cached.ts > MARKET_CACHE_TTL_MS) {
            loadMarketSkills(true);
          }
        } catch {}
      }
    }
  }, [activeTab, marketSkills.length, marketLoading, loadCachedMarketSkills, loadMarketSkills]);

const filteredMarketSkills = marketSkills.filter((s) => {
if (marketSourceFilter !== "all" && s.sourceId !== marketSourceFilter) return false;
if (marketSearchQuery) {
const q = marketSearchQuery.toLowerCase();
const tags = Array.isArray(s.tags) ? s.tags : [];
const name = String(s.name || "");
const displayName = String(s.displayName || "");
const description = String(s.description || "");
const author = s.author ? String(s.author) : "";
return (
name.toLowerCase().includes(q) ||
displayName.toLowerCase().includes(q) ||
description.toLowerCase().includes(q) ||
author.toLowerCase().includes(q) ||
tags.some((t) => String(t).toLowerCase().includes(q))
);
}
return true;
});

  // ===== Incremental Online Search =====
  // 当本地搜索无结果时，自动触发联网搜索
  const [onlineSearching, setOnlineSearching] = useState(false);
  const [onlineSearchTriggered, setOnlineSearchTriggered] = useState(false);
  const lastOnlineSearchRef = useRef("");

  useEffect(() => {
    const q = marketSearchQuery.trim();
    if (!q || q.length < 2) {
      setOnlineSearchTriggered(false);
      lastOnlineSearchRef.current = "";
      return;
    }

    // 本地有结果时不触发联网
    if (filteredMarketSkills.length > 0) {
      setOnlineSearchTriggered(false);
      lastOnlineSearchRef.current = q;
      return;
    }

    // 已经搜索过相同关键词，不重复触发
    if (lastOnlineSearchRef.current === q && onlineSearchTriggered) return;
    lastOnlineSearchRef.current = q;

    // 本地无结果，触发增量联网搜索
    let cancelled = false;
    setOnlineSearching(true);
    setOnlineSearchTriggered(true);

    // 防抖延迟
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const sources = getMarketSources();
        const result = await searchMarketSkillsOnline(q, sources, (sourceId, sourceSkills) => {
          // 渐进式更新：每搜完一个源就立即合并结果到列表
          if (sourceSkills.length > 0) {
            setMarketSkills((prev) => {
              const existingIds = new Set(prev.map((s) => s.id));
              const newSkills = sourceSkills.filter((s) => !existingIds.has(s.id));
              if (newSkills.length > 0) {
                const updated = [...prev, ...newSkills];
                try {
                  setSettingJSON(MARKET_CACHE_KEY, { skills: updated, sources, ts: Date.now() });
                } catch {}
                return updated;
              }
              return prev;
            });
          }
        });
        if (cancelled) return;

        if (result.skills.length > 0) {
          // 合并新结果到 marketSkills（去重）
          setMarketSkills((prev) => {
            const existingIds = new Set(prev.map((s) => s.id));
            const newSkills = result.skills.filter((s) => !existingIds.has(s.id));
            if (newSkills.length > 0) {
              // 更新缓存
              const updated = [...prev, ...newSkills];
              try {
                setSettingJSON(MARKET_CACHE_KEY, { skills: updated, sources, ts: Date.now() });
              } catch {}
              return updated;
            }
            return prev;
          });
        }
      } catch (err) {
        console.warn("[SkillManager] Incremental online search failed:", err);
      } finally {
        if (!cancelled) setOnlineSearching(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [marketSearchQuery, filteredMarketSkills.length, onlineSearchTriggered]);

  const handleMarketInstall = async (skill: MarketSkill) => {
    if (skill.installed) return;

    setInstallingSkillId(skill.id);
    setMarketInstallProgress({ value: 0, message: "准备安装..." });
    setMarketError(null);

    const result = await installMarketSkill(
      skill,
      (progress, message) => setMarketInstallProgress({ value: progress, message }),
    );

    if (result.success) {
      setMarketInstallProgress(null);
      // 更新已安装状态
      setMarketSkills((prev) =>
        prev.map((s) => s.id === skill.id ? { ...s, installed: true } : s),
      );
      // 刷新本地技能列表
      setRefreshKey((k) => k + 1);
    } else {
      setMarketInstallProgress(null);
      setMarketError(result.error || "安装失败");
    }

    setInstallingSkillId(null);
  };

  // ===== Icons =====
  const SkillsIcon = PanelIcons.skills;
  const StoreIcon = MarketIcons.store;
  const UploadIcon = ActionIcons.upload;
  const SearchIcon = CommonIcons.filter;
  const CloseIcon = ActionIcons.close;
  const DeleteIcon = ActionIcons.delete;
  const RefreshIcon = ActionIcons.refresh;
  const DownloadIcon = ActionIcons.download;
  const ExternalLinkIcon = ActionIcons.externalLink;
  const StarIcon = MarketIcons.star;
  const LoadingIcon = StatusIcons.loading;

  return (
    <div className="skill-manager">
      {/* Header */}
      <div className="skill-manager-header">
        <div className="skill-manager-title">
          <SkillsIcon size={20} className="skill-manager-icon-svg" />
          <span>技能管理</span>
        </div>
        <button className="skill-manager-close" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="skill-manager-tabs">
        <button
          className={`skill-tab-btn ${activeTab === "my-skills" ? "active" : ""}`}
          onClick={() => setActiveTab("my-skills")}
        >
          <SkillsIcon size={16} />
          <span>我的技能</span>
          <Badge variant="muted">{skills.length}</Badge>
        </button>
        <button
          className={`skill-tab-btn ${activeTab === "market" ? "active" : ""}`}
          onClick={() => setActiveTab("market")}
        >
          <StoreIcon size={16} />
          <span>技能市场</span>
          {marketSkills.length > 0 && <Badge variant="info">{marketSkills.length}</Badge>}
        </button>
      </div>

      {/* ===== My Skills Tab ===== */}
      {activeTab === "my-skills" && (
        <>
          {/* Search + Upload */}
          <div className="skill-manager-toolbar">
            <div className="skill-search-box">
              <SearchIcon size={14} className="skill-search-icon" />
              <input
                type="text"
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="skill-search-input"
              />
            </div>
            <button
              className="skill-upload-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon size={16} />
              <span>安装 ZIP</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleFileInputChange}
              style={{ display: "none" }}
            />
          </div>

          {/* Drag & Drop Zone */}
          <div
            ref={dragRef}
            className={`skill-drop-zone ${isDragging ? "dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            {isDragging ? "松开以安装 ZIP 技能包" : "拖拽 .zip 文件到此处安装技能"}
          </div>

          {/* Install Progress */}
          {installProgress && (
            <div className="skill-install-progress">
              <Progress value={installProgress.value} label={`${installProgress.value}%`} />
              <span className="skill-progress-message">{installProgress.message}</span>
            </div>
          )}

          {/* Install Error */}
          {installError && (
            <div className="skill-install-error">
              <span>{installError}</span>
              <button onClick={() => setInstallError(null)}>✕</button>
            </div>
          )}

          {/* Filters */}
          <div className="skill-manager-filters">
            {(["all", "builtin", "user", "external"] as const).map((f) => (
              <button
                key={f}
                className={`skill-filter-btn ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "全部" : getSourceLabel(f)}
                <span className="skill-filter-count">
                  {f === "all" ? skills.length : skills.filter((s) => s.source === f).length}
                </span>
              </button>
            ))}
          </div>

          {/* Content: List + Detail */}
          <div className="skill-content">
            <div className="skill-list">
              {filteredSkills.length === 0 && (
                <div className="skill-empty">
                  {searchQuery ? "未找到匹配的技能" : "暂无技能"}
                </div>
              )}
              {filteredSkills.map((skill) => {
                const SourceIcon = SkillSourceIcons[skill.source] || SkillSourceIcons.external;
                return (
                  <div
                    key={skill.name}
                    className={`skill-item ${selectedSkill?.name === skill.name ? "selected" : ""} ${skill.enabled === false ? "disabled" : ""}`}
                    onClick={() => setSelectedSkill(selectedSkill?.name === skill.name ? null : skill)}
                  >
                    <div className="skill-item-header">
                      <div className="skill-item-name-row">
                        <SourceIcon size={14} className="skill-item-source-icon" />
                        <span className="skill-item-name">{skill.displayName || skill.name}</span>
                        {skill.version && (
                          <Badge variant="muted">v{skill.version}</Badge>
                        )}
                      </div>
                      <Switch
                        checked={skill.enabled !== false}
                        onCheckedChange={(checked) => handleToggleEnabled(skill.name, checked)}
                        disabled={skill.source === "builtin"}
                      />
                    </div>
                    <div className="skill-item-desc">{skill.description}</div>
                    <div className="skill-item-meta">
                      <Badge variant={getSourceBadgeVariant(skill.source)}>
                        {getSourceLabel(skill.source)}
                      </Badge>
                      {skill.aliases && skill.aliases.length > 0 && (
                        <span className="skill-item-aliases">
                          {skill.aliases.slice(0, 3).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Detail Panel */}
            {selectedSkill && (
              <div className="skill-detail">
                <div className="skill-detail-header">
                  <h3>{selectedSkill.displayName || selectedSkill.name}</h3>
                  <Badge variant={getSourceBadgeVariant(selectedSkill.source)}>
                    {getSourceLabel(selectedSkill.source)}
                  </Badge>
                </div>

                {selectedSkill.version && (
                  <div className="skill-detail-section">
                    <label>版本</label>
                    <span className="skill-detail-value">{selectedSkill.version}</span>
                  </div>
                )}

                {selectedSkill.author && (
                  <div className="skill-detail-section">
                    <label>作者</label>
                    <span className="skill-detail-value">{selectedSkill.author}</span>
                  </div>
                )}

                <div className="skill-detail-section">
                  <label>描述</label>
                  <p>{selectedSkill.description}</p>
                </div>

                {selectedSkill.aliases && selectedSkill.aliases.length > 0 && (
                  <div className="skill-detail-section">
                    <label>别名</label>
                    <div className="skill-detail-tags">
                      {selectedSkill.aliases.map((alias) => (
                        <Badge key={alias} variant="default">{alias}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedSkill.tags && selectedSkill.tags.length > 0 && (
                  <div className="skill-detail-section">
                    <label>标签</label>
                    <div className="skill-detail-tags">
                      {selectedSkill.tags.map((tag) => (
                        <Badge key={tag} variant="info">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedSkill.allowedTools && selectedSkill.allowedTools.length > 0 && (
                  <div className="skill-detail-section">
                    <label>允许的工具</label>
                    <div className="skill-detail-tags">
                      {selectedSkill.allowedTools.map((tool) => (
                        <Badge key={tool} variant="muted">{tool}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedSkill.tools && selectedSkill.tools.length > 0 && (
                  <div className="skill-detail-section">
                    <label>携带工具</label>
                    <div className="skill-detail-tags">
                      {selectedSkill.tools.map((tool) => (
                        <Badge key={tool.name} variant="success">{tool.name}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedSkill.whenToUse && (
                  <div className="skill-detail-section">
                    <label>触发条件</label>
                    <p className="skill-detail-mono">{selectedSkill.whenToUse}</p>
                  </div>
                )}

                <div className="skill-detail-section">
                  <label>提示词</label>
                  <pre className="skill-detail-prompt">{selectedSkill.prompt}</pre>
                </div>

                {/* Delete + Publish buttons (only for non-builtin) */}
                {selectedSkill.source !== "builtin" && (
                  <div className="skill-detail-actions">
                    <button
                      className="skill-detail-btn publish"
                      onClick={() => {
                        setPublishTarget(selectedSkill);
                        setPublishForm({
                          target: "clawhub",
                          slug: selectedSkill.name,
                          displayName: selectedSkill.displayName || selectedSkill.name,
                          version: selectedSkill.version || "1.0.0",
                          changelog: "",
                          githubPrivate: false,
                        });
                        setPublishResult(null);
                        // Load publishable markets
                        listPublishableMarkets().then(setPublishMarkets);
                      }}
                    >
                      <span>📤</span>
                      发布到市场
                    </button>
                    <button
                      className="skill-detail-btn delete"
                      onClick={() => setDeleteTarget(selectedSkill)}
                    >
                      <DeleteIcon size={14} />
                      删除技能
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ===== Market Tab ===== */}
      {activeTab === "market" && (
        <>
          {/* Market Toolbar */}
          <div className="skill-manager-toolbar">
            <div className="skill-search-box">
              <SearchIcon size={14} className="skill-search-icon" />
              <input
                type="text"
                placeholder="搜索市场技能..."
                value={marketSearchQuery}
                onChange={(e) => setMarketSearchQuery(e.target.value)}
                className="skill-search-input"
              />
            </div>
            <button
              className="skill-upload-btn"
              onClick={() => loadMarketSkills(false)}
              disabled={marketLoading}
            >
              <RefreshIcon size={16} className={marketLoading ? "spin" : ""} />
              <span>{marketLoading ? "检查中..." : "检查更新"}</span>
            </button>
          </div>

          {/* Market Loading */}
          {marketLoading && marketSkills.length === 0 && (
            <div className="skill-market-loading">
              <LoadingIcon size={32} className="spin" />
              <span>正在从市场源加载技能...</span>
            </div>
          )}

          {/* Market Error */}
          {marketError && (
            <div className="skill-install-error">
              <span>{marketError}</span>
              <button onClick={() => setMarketError(null)}>✕</button>
            </div>
          )}

          {/* Market Install Progress */}
          {marketInstallProgress && (
            <div className="skill-install-progress">
              <Progress value={marketInstallProgress.value} label={`${marketInstallProgress.value}%`} />
              <span className="skill-progress-message">{marketInstallProgress.message}</span>
            </div>
          )}

          {/* Source Filters */}
          <div className="skill-manager-filters">
            <button
              className={`skill-filter-btn ${marketSourceFilter === "all" ? "active" : ""}`}
              onClick={() => setMarketSourceFilter("all")}
            >
              全部
              <span className="skill-filter-count">{marketSkills.length}</span>
            </button>
            {marketSources.filter((s) => s.enabled).map((source) => (
              <button
                key={source.id}
                className={`skill-filter-btn ${marketSourceFilter === source.id ? "active" : ""}`}
                onClick={() => setMarketSourceFilter(source.id)}
              >
                {getSourceIcon(source)} {source.name}
                <span className="skill-filter-count">
                  {marketSkills.filter((s) => s.sourceId === source.id).length}
                </span>
              </button>
            ))}
          </div>

          {/* Market Skills Grid */}
          <div className="skill-market-grid">
            {filteredMarketSkills.length === 0 && !marketLoading && !onlineSearching && (
              <div className="skill-empty">
                {marketSearchQuery ? "未找到匹配的技能" : "暂无市场技能，点击检查更新重试"}
              </div>
            )}
            {filteredMarketSkills.length === 0 && onlineSearching && (
              <div className="skill-empty">
                正在联网搜索 "{marketSearchQuery}"...
              </div>
            )}
            {filteredMarketSkills.map((skill) => (
              <div
                key={skill.id}
                className={`market-skill-card ${skill.installed ? "installed" : ""} ${selectedMarketSkill?.id === skill.id ? "selected" : ""}`}
                onClick={() => setSelectedMarketSkill(selectedMarketSkill?.id === skill.id ? null : skill)}
              >
                <div className="market-skill-card-header">
                  <span className="market-skill-icon">
                    {skill.installType === "builtin" ? "⚡" : "📦"}
                  </span>
                  <div className="market-skill-card-title">
                    <span className="market-skill-name">{skill.displayName}</span>
                    {skill.version && <Badge variant="muted">v{skill.version}</Badge>}
                  </div>
                  {skill.stars !== undefined && skill.stars > 0 && (
                    <span className="market-skill-stars">
                      <StarIcon size={12} />
                      {skill.stars > 1000 ? `${(skill.stars / 1000).toFixed(1)}k` : skill.stars}
                    </span>
                  )}
                </div>

                <div className="market-skill-desc">{skill.description}</div>

                <div className="market-skill-card-footer">
                  <div className="market-skill-meta">
                    <Badge variant="info">{skill.sourceName}</Badge>
                    {skill.author && <span className="market-skill-author">@{skill.author}</span>}
                  </div>
                  <div className="market-skill-actions">
                    {skill.repoUrl && (
                      <button
                        className="market-skill-link-btn"
                        title="查看仓库"
                        onClick={(e) => {
                          e.stopPropagation();
                          if ((window as any).__TAURI__?.shell?.open) {
                            (window as any).__TAURI__.shell.open(skill.repoUrl);
                          }
                        }}
                      >
                        <ExternalLinkIcon size={14} />
                      </button>
                    )}
                    {skill.installType === "builtin" ? (
                      <Badge variant="success">已内置</Badge>
                    ) : skill.installed ? (
                      <Badge variant="success">已安装</Badge>
                    ) : (
                      <button
                        className="market-skill-install-btn"
                        disabled={installingSkillId === skill.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMarketInstall(skill);
                        }}
                      >
                        {installingSkillId === skill.id ? (
                          <LoadingIcon size={14} className="spin" />
                        ) : (
                          <DownloadIcon size={14} />
                        )}
                        安装
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Market Skill Detail Dialog */}
          <Dialog open={!!selectedMarketSkill} onOpenChange={(open) => !open && setSelectedMarketSkill(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{selectedMarketSkill?.displayName}</DialogTitle>
                <DialogDescription>{selectedMarketSkill?.description}</DialogDescription>
              </DialogHeader>
              {selectedMarketSkill && (
                <div className="market-skill-detail">
                  {selectedMarketSkill.author && (
                    <div className="skill-detail-section">
                      <label>作者</label>
                      <span className="skill-detail-value">{selectedMarketSkill.author}</span>
                    </div>
                  )}
                  {selectedMarketSkill.version && (
                    <div className="skill-detail-section">
                      <label>版本</label>
                      <span className="skill-detail-value">{selectedMarketSkill.version}</span>
                    </div>
                  )}
                  <div className="skill-detail-section">
                    <label>来源</label>
                    <span className="skill-detail-value">{selectedMarketSkill.sourceName}</span>
                  </div>
                  {selectedMarketSkill.tags && selectedMarketSkill.tags.length > 0 && (
                    <div className="skill-detail-section">
                      <label>标签</label>
                      <div className="skill-detail-tags">
                        {selectedMarketSkill.tags.map((tag) => (
                          <Badge key={tag} variant="info">{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedMarketSkill.repoUrl && (
                    <div className="skill-detail-section">
                      <label>仓库</label>
                      <a
                        href={selectedMarketSkill.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="skill-detail-link"
                      >
                        <ExternalLinkIcon size={14} />
                        {selectedMarketSkill.repoUrl}
                      </a>
                    </div>
                  )}
                  {selectedMarketSkill.stars !== undefined && selectedMarketSkill.stars > 0 && (
                    <div className="skill-detail-section">
                      <label>Stars</label>
                      <span className="skill-detail-value">
                        <StarIcon size={12} /> {selectedMarketSkill.stars}
                      </span>
                    </div>
                  )}
                  {selectedMarketSkill.lastUpdated && (
                    <div className="skill-detail-section">
                      <label>更新时间</label>
                      <span className="skill-detail-value">
                        {new Date(selectedMarketSkill.lastUpdated).toLocaleDateString("zh-CN")}
                      </span>
                    </div>
                  )}
                </div>
              )}
              <DialogFooter>
                {selectedMarketSkill && selectedMarketSkill.installType !== "builtin" && !selectedMarketSkill.installed && (
                  <button
                    className="market-skill-install-btn"
                    disabled={installingSkillId === selectedMarketSkill.id}
                    onClick={() => handleMarketInstall(selectedMarketSkill)}
                  >
                    {installingSkillId === selectedMarketSkill.id ? (
                      <LoadingIcon size={14} className="spin" />
                    ) : (
                      <DownloadIcon size={14} />
                    )}
                    安装技能
                  </button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除技能</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除技能 "{deleteTarget?.name}" 吗？此操作将删除技能文件，无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Overwrite Confirmation */}
      <AlertDialog open={!!overwriteTarget} onOpenChange={(open) => !open && setOverwriteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>技能已存在</AlertDialogTitle>
            <AlertDialogDescription>
              技能 "{overwriteTarget?.skillName}" 已存在。是否覆盖安装？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overwriteTarget) {
                  handleZipInstall(overwriteTarget.zipData, true);
                  setOverwriteTarget(null);
                }
              }}
            >
              覆盖安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ===== Publish Dialog ===== */}
      {publishTarget && (
        <Dialog open={true} onOpenChange={(open) => { if (!open) setPublishTarget(null); }}>
          <DialogContent className="publish-dialog">
            <DialogHeader>
              <DialogTitle>📤 发布技能到市场</DialogTitle>
              <DialogDescription>
                将「{publishTarget.displayName || publishTarget.name}」发布到技能市场，供其他用户安装使用。
              </DialogDescription>
            </DialogHeader>

            <div className="publish-form">
              {/* Target market selector */}
              <div className="publish-field">
                <label>目标市场</label>
                <div className="publish-market-list">
                  {publishMarkets.map((m) => (
                    <button
                      key={m.id}
                      className={`publish-market-item ${publishForm.target === m.target ? "active" : ""}`}
                      onClick={() => setPublishForm({ ...publishForm, target: m.target })}
                      disabled={!m.ready}
                      title={m.notReadyReason || ""}
                    >
                      <span className="publish-market-icon">{m.icon}</span>
                      <span className="publish-market-name">{m.name}</span>
                      {!m.ready && <span className="publish-market-unavailable">未就绪</span>}
                      {m.ready && publishForm.target === m.target && <span className="publish-market-check">✓</span>}
                    </button>
                  ))}
                  {publishMarkets.length === 0 && (
                    <p className="publish-no-markets">正在检查可用市场...</p>
                  )}
                </div>
              </div>

              {/* Slug */}
              <div className="publish-field">
                <label>技能标识 (slug)</label>
                <input
                  type="text"
                  value={publishForm.slug}
                  onChange={(e) => setPublishForm({ ...publishForm, slug: e.target.value })}
                  placeholder="my-skill"
                  className="publish-input"
                />
              </div>

              {/* Display name */}
              <div className="publish-field">
                <label>显示名称</label>
                <input
                  type="text"
                  value={publishForm.displayName}
                  onChange={(e) => setPublishForm({ ...publishForm, displayName: e.target.value })}
                  placeholder="My Skill"
                  className="publish-input"
                />
              </div>

              {/* Version */}
              <div className="publish-field">
                <label>版本号</label>
                <input
                  type="text"
                  value={publishForm.version}
                  onChange={(e) => setPublishForm({ ...publishForm, version: e.target.value })}
                  placeholder="1.0.0"
                  className="publish-input"
                />
              </div>

              {/* Changelog */}
              <div className="publish-field">
                <label>变更日志（可选）</label>
                <textarea
                  value={publishForm.changelog}
                  onChange={(e) => setPublishForm({ ...publishForm, changelog: e.target.value })}
                  placeholder="本次发布包含的改动..."
                  className="publish-textarea"
                  rows={3}
                />
              </div>

              {/* GitHub private toggle */}
              {publishForm.target === "github" && (
                <div className="publish-field publish-field-inline">
                  <label>
                    <input
                      type="checkbox"
                      checked={publishForm.githubPrivate}
                      onChange={(e) => setPublishForm({ ...publishForm, githubPrivate: e.target.checked })}
                    />
                    创建为私有仓库
                  </label>
                </div>
              )}

              {/* Not-ready warnings */}
              {publishMarkets.find((m) => m.target === publishForm.target)?.notReadyReason && (
                <div className="publish-warning">
                  ⚠️ {publishMarkets.find((m) => m.target === publishForm.target)?.notReadyReason}
                </div>
              )}

              {/* Publish result */}
              {publishResult && (
                <div className={`publish-result ${publishResult.success ? "success" : "error"}`}>
                  {publishResult.success ? (
                    <>
                      <p>✅ 发布成功！</p>
                      {publishResult.url && (
                        <a href={publishResult.url} target="_blank" rel="noopener noreferrer">
                          {publishResult.url}
                        </a>
                      )}
                    </>
                  ) : (
                    <p>❌ {publishResult.error}</p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <button
                className="skill-upload-btn"
                onClick={() => setPublishTarget(null)}
                disabled={publishLoading}
              >
                关闭
              </button>
              <button
                className="skill-detail-btn publish"
                onClick={async () => {
                  setPublishLoading(true);
                  setPublishResult(null);
                  try {
                    const result = await publishSkillToMarket({
                      target: publishForm.target,
                      skillPath: publishTarget.filePath || "",
                      slug: publishForm.slug,
                      displayName: publishForm.displayName,
                      version: publishForm.version,
                      changelog: publishForm.changelog || undefined,
                      githubPrivate: publishForm.githubPrivate,
                    });
                    setPublishResult({
                      success: result.success,
                      url: result.url,
                      error: result.error,
                    });
                  } catch (err: any) {
                    setPublishResult({
                      success: false,
                      error: err.message || String(err),
                    });
                  } finally {
                    setPublishLoading(false);
                  }
                }}
                disabled={publishLoading || !publishForm.slug || !publishForm.version}
              >
                {publishLoading ? "发布中..." : "确认发布"}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
