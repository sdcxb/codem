/**
 * PetMarketDialog — 宠物市场浏览对话框。
 *
 * 功能：
 * - 从 Petdex 市场拉取宠物目录
 * - 展示宠物卡片（预览图、名称、描述、标签）
 * - 一键安装/卸载宠物
 * - 搜索过滤
 * - 安装进度展示
 *
 * 接入开源项目 Petdex (MIT License) 的市场 API。
 * @see THIRD_PARTY_NOTICES.md — Petdex (MIT License) 集成声明
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { MarketPet } from "../core/pet/pet-types";
import { listMarketPets, installMarketPet, isMarketPetInstalled, fetchPetImageAsDataUrl } from "../core/pet/pet-market-client";
import { uninstallPet, isPetInstalled } from "../core/pet/pet-manager";
import { usePetStore } from "../core/pet/pet-store";

/**
 * 宠物卡片预览图组件 — CSS steps() 动画。
 *
 * 基于 Petdex (MIT) 的精灵图动画方案：
 * preview.webp 是 idle 行的单行条带（6 帧 × 192px = 1152px 宽 × 208px 高），
 * 通过 CSS steps(6) 步进 background-position 实现帧动画。
 *
 * 加载策略（三层回退）：
 * 1. 直接加载 preview.webp（referrerPolicy="no-referrer" 绕过 R2 Referer 检查）
 * 2. 直接加载失败 → Rust 代理下载 preview.webp 转 data URL
 * 3. 代理也失败 → 尝试完整 spritesheet（取 idle 行做动画）
 * 4. 全部失败 → 显示 🐾 emoji
 */

/** 预览条带参数（idle 行：6 帧 × 192px） */
const PREVIEW_FRAMES = 6;
const PREVIEW_FRAME_WIDTH = 192;
const PREVIEW_STRIP_WIDTH = PREVIEW_FRAMES * PREVIEW_FRAME_WIDTH; // 1152px
const PREVIEW_DURATION_MS = 1100;

function PetCardPreview({ pet }: { pet: MarketPet }) {
  const [imgSrc, setImgSrc] = useState<string | null>(pet.previewUrl ?? null);
  const [useFullSheet, setUseFullSheet] = useState(false);
  const [failed, setFailed] = useState(false);
  const triedProxyRef = useRef(false);

  const tryProxyFallback = useCallback(async () => {
    if (triedProxyRef.current) {
      setFailed(true);
      return;
    }
    triedProxyRef.current = true;

    // 先试 preview.webp
    if (pet.previewUrl) {
      const dataUrl = await fetchPetImageAsDataUrl(pet.previewUrl, "image/webp");
      if (dataUrl) {
        setImgSrc(dataUrl);
        return;
      }
    }

    // 再试完整 spritesheet
    if (pet.spritesheetUrl) {
      const dataUrl = await fetchPetImageAsDataUrl(pet.spritesheetUrl, "image/webp");
      if (dataUrl) {
        setImgSrc(dataUrl);
        setUseFullSheet(true);
        return;
      }
    }

    setFailed(true);
  }, [pet.previewUrl, pet.spritesheetUrl]);

  if (failed || !imgSrc) {
    return <span style={{ fontSize: "40px" }}>🐾</span>;
  }

  // 完整 spritesheet 模式：背景宽度 1536px，取 idle 行（row 0）
  // 预览条带模式：背景宽度 1152px，单行
  const sheetWidth = useFullSheet ? 1536 : PREVIEW_STRIP_WIDTH;

  return (
    <div
      className="pet-sprite-card"
      style={{
        transform: "scale(0.45)",
        transformOrigin: "center",
      }}
    >
      <div
        className="pet-sprite-card-inner"
        style={{
          backgroundImage: `url("${imgSrc}")`,
          backgroundSize: `${sheetWidth}px auto`,
          ["--pet-frames" as string]: String(PREVIEW_FRAMES),
          ["--pet-duration" as string]: `${PREVIEW_DURATION_MS}ms`,
        }}
        onError={() => tryProxyFallback()}
      />
      {/* 隐藏 img 用于检测加载失败 */}
      <img
        src={imgSrc}
        alt=""
        aria-hidden
        style={{ display: "none" }}
        referrerPolicy="no-referrer"
        onError={() => tryProxyFallback()}
      />
    </div>
  );
}

interface PetMarketDialogProps {
  open: boolean;
  onClose: () => void;
}

interface InstallProgress {
  slug: string;
  progress: number;
  message: string;
}

export function PetMarketDialog({ open, onClose }: PetMarketDialogProps) {
  const [pets, setPets] = useState<MarketPet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { refreshInstalledPets, setActivePet, installedPets, setEnabled, enabled } = usePetStore();

  // 加载市场数据
  const loadMarket = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { pets: marketPets, error: err } = await listMarketPets((msg) => {
      // 可选：显示加载阶段消息
    });
    if (err) {
      setError(err);
    }
    // 标记已安装状态
    const installedSlugs = new Set(installedPets.map((p) => p.slug));
    const marked = marketPets.map((p) => ({
      ...p,
      installed: installedSlugs.has(p.slug),
    }));
    setPets(marked);
    setLoading(false);
  }, [installedPets]);

  useEffect(() => {
    if (open) {
      loadMarket();
    }
  }, [open, loadMarket]);

  // 过滤
  const filteredPets = searchQuery.trim()
    ? pets.filter((p) =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : pets;

  // 安装宠物
  const handleInstall = useCallback(async (pet: MarketPet) => {
    setInstallProgress({ slug: pet.slug, progress: 0, message: "准备安装..." });
    const result = await installMarketPet(
      pet,
      (progress, message) => {
        setInstallProgress({ slug: pet.slug, progress, message });
      },
      true, // overwrite
    );

    if (result.success) {
      // 刷新已安装列表
      await refreshInstalledPets();
      // 更新市场列表中的安装状态
      setPets((prev) => prev.map((p) =>
        p.slug === pet.slug ? { ...p, installed: true } : p
      ));
      // 自动激活刚安装的宠物
      await setActivePet(pet.slug);
      // 自动启用宠物系统（如果尚未启用）
      if (!enabled) {
        setEnabled(true);
      }
    } else {
      setError(result.error || "安装失败");
    }
    setInstallProgress(null);
  }, [refreshInstalledPets, setActivePet, setEnabled, enabled]);

  // 卸载宠物
  const handleUninstall = useCallback(async (pet: MarketPet) => {
    const result = await uninstallPet(pet.slug);
    if (result.success) {
      await refreshInstalledPets();
      setPets((prev) => prev.map((p) =>
        p.slug === pet.slug ? { ...p, installed: false } : p
      ));
    } else {
      setError(result.error || "卸载失败");
    }
    setRefreshKey((k) => k + 1);
  }, [refreshInstalledPets]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100000,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "80%",
          maxWidth: "720px",
          height: "70%",
          maxHeight: "600px",
          background: "var(--bg-secondary, #1e1e2e)",
          borderRadius: "12px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
          border: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
        }}
      >
        {/* 标题栏 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-color, rgba(255, 255, 255, 0.08))",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "20px" }}>🐾</span>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
              宠物市场
            </h2>
            {pets.length > 0 && (
              <span style={{ fontSize: "12px", color: "var(--text-secondary, #888)" }}>
                ({filteredPets.length}/{pets.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary, #888)",
              cursor: "pointer",
              fontSize: "18px",
              padding: "4px 8px",
              borderRadius: "4px",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
            onMouseLeave={(e) => e.currentTarget.style.background = "none"}
          >
            ✕
          </button>
        </div>

        {/* 搜索栏 */}
        <div style={{ padding: "12px 20px" }}>
          <input
            type="text"
            placeholder="搜索宠物..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "8px",
              border: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
              background: "var(--bg-tertiary, #181825)",
              color: "var(--text-primary, #e0e0e0)",
              fontSize: "13px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* 内容区 */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 20px 16px",
          }}
        >
          {loading && (
            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #888)" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>🔄</div>
              <div>正在加载宠物市场...</div>
            </div>
          )}

          {error && !loading && (
            <div style={{ textAlign: "center", padding: "40px", color: "#f87171" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>😞</div>
              <div style={{ marginBottom: "12px" }}>{error}</div>
              <button
                onClick={() => { setError(null); loadMarket(); }}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color, rgba(255, 255, 255, 0.2))",
                  background: "var(--bg-tertiary, #181825)",
                  color: "var(--text-primary, #e0e0e0)",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                重试
              </button>
            </div>
          )}

          {!loading && !error && filteredPets.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-secondary, #888)" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>🔍</div>
              <div>未找到宠物</div>
            </div>
          )}

          {/* 宠物卡片网格 */}
          {!loading && !error && filteredPets.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "12px",
              }}
            >
              {filteredPets.map((pet) => {
                const isInstalling = installProgress?.slug === pet.slug;
                return (
                  <div
                    key={pet.id}
                    style={{
                      borderRadius: "10px",
                      border: "1px solid var(--border-color, rgba(255, 255, 255, 0.08))",
                      background: "var(--bg-tertiary, #181825)",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column",
                      transition: "transform 0.15s ease, border-color 0.15s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "none";
                      e.currentTarget.style.borderColor = "var(--border-color, rgba(255, 255, 255, 0.08))";
                    }}
                  >
                    {/* 预览图 */}
                    <div
                      style={{
                        width: "100%",
                        height: "120px",
                        background: "var(--bg-secondary, #1e1e2e)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                      }}
                    >
                      <PetCardPreview pet={pet} />
                      {pet.installed && (
                        <span
                          style={{
                            position: "absolute",
                            top: "6px",
                            right: "6px",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            background: "rgba(34, 197, 94, 0.8)",
                            color: "#fff",
                            fontSize: "10px",
                            fontWeight: 600,
                          }}
                        >
                          已安装
                        </span>
                      )}
                    </div>

                    {/* 信息区 */}
                    <div style={{ padding: "10px 12px", flex: 1, display: "flex", flexDirection: "column" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary, #e0e0e0)", marginBottom: "4px" }}>
                        {pet.name}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-secondary, #888)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {pet.description || "暂无描述"}
                      </div>

                      {/* 标签 */}
                      {pet.tags && pet.tags.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                          {pet.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              style={{
                                padding: "1px 6px",
                                borderRadius: "3px",
                                background: "rgba(255, 255, 255, 0.06)",
                                color: "var(--text-secondary, #aaa)",
                                fontSize: "10px",
                              }}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 操作按钮 */}
                      <div style={{ marginTop: "8px" }}>
                        {isInstalling ? (
                          <div style={{ width: "100%" }}>
                            <div
                              style={{
                                width: "100%",
                                height: "4px",
                                borderRadius: "2px",
                                background: "rgba(255, 255, 255, 0.1)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${installProgress!.progress}%`,
                                  height: "100%",
                                  background: "var(--accent-color, #6366f1)",
                                  transition: "width 0.3s ease",
                                }}
                              />
                            </div>
                            <div style={{ fontSize: "10px", color: "var(--text-secondary, #888)", marginTop: "4px" }}>
                              {installProgress!.message}
                            </div>
                          </div>
                        ) : pet.installed ? (
                          <button
                            onClick={() => handleUninstall(pet)}
                            style={{
                              width: "100%",
                              padding: "5px 0",
                              borderRadius: "6px",
                              border: "1px solid rgba(239, 68, 68, 0.3)",
                              background: "rgba(239, 68, 68, 0.1)",
                              color: "#f87171",
                              cursor: "pointer",
                              fontSize: "12px",
                              fontWeight: 500,
                            }}
                          >
                            卸载
                          </button>
                        ) : (
                          <button
                            onClick={() => handleInstall(pet)}
                            style={{
                              width: "100%",
                              padding: "5px 0",
                              borderRadius: "6px",
                              border: "none",
                              background: "var(--accent-color, #6366f1)",
                              color: "#fff",
                              cursor: "pointer",
                              fontSize: "12px",
                              fontWeight: 500,
                            }}
                          >
                            安装
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部信息 */}
        <div
          style={{
            padding: "8px 20px",
            borderTop: "1px solid var(--border-color, rgba(255, 255, 255, 0.08))",
            fontSize: "11px",
            color: "var(--text-secondary, #666)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>数据来源: Petdex (MIT License)</span>
          <span>已安装: {installedPets.length} 个宠物</span>
        </div>
      </div>
    </div>
  );
}
