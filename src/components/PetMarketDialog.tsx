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
import { ActionIcons } from "../core/icons/icon-map";
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
    return <span className="petm-state-icon">🐾</span>;
  }

  // 完整 spritesheet 模式：背景宽度 1536px，取 idle 行（row 0）
  // 预览条带模式：背景宽度 1152px，单行
  const sheetWidth = useFullSheet ? 1536 : PREVIEW_STRIP_WIDTH;

  return (
    <div className="pet-sprite-card petm-sprite">
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
        className="petm-sprite-probe"
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
  const CloseIcon = ActionIcons.close;
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
      className="modal-overlay petm-overlay"
      style={{ zIndex: "var(--z-top)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel petm-panel"
      >
        {/* 标题栏 */}
        <div className="petm-header">
          <div className="petm-header-left">
            <span className="petm-logo">🐾</span>
            <h2 className="petm-title">
              宠物市场
            </h2>
            {pets.length > 0 && (
              <span className="petm-count">
                ({filteredPets.length}/{pets.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="petm-close"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* 搜索栏 */}
        <div className="petm-search-row">
          <input
            type="text"
            placeholder="搜索宠物..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="petm-search"
          />
        </div>

        {/* 内容区 */}
        <div ref={scrollRef} className="petm-body">
          {loading && (
            <div className="petm-state">
              <div className="petm-state-icon">🔄</div>
              <div>正在加载宠物市场...</div>
            </div>
          )}

          {error && !loading && (
            <div className="petm-state petm-state--error">
              <div className="petm-state-icon">😞</div>
              <div className="petm-state-gap">{error}</div>
              <button
                onClick={() => { setError(null); loadMarket(); }}
                className="petm-retry"
              >
                重试
              </button>
            </div>
          )}

          {!loading && !error && filteredPets.length === 0 && (
            <div className="petm-state">
              <div className="petm-state-icon">🔍</div>
              <div>未找到宠物</div>
            </div>
          )}

          {/* 宠物卡片网格 */}
          {!loading && !error && filteredPets.length > 0 && (
            <div className="petm-grid">
              {filteredPets.map((pet) => {
                const isInstalling = installProgress?.slug === pet.slug;
                return (
                  <div key={pet.id} className="petm-card">
                    {/* 预览图 */}
                    <div className="petm-preview">
                      <PetCardPreview pet={pet} />
                      {pet.installed && (
                        <span className="petm-installed">
                          已安装
                        </span>
                      )}
                    </div>

                    {/* 信息区 */}
                    <div className="petm-info">
                      <div className="petm-name">
                        {pet.name}
                      </div>
                      <div className="petm-desc">
                        {pet.description || "暂无描述"}
                      </div>

                      {/* 标签 */}
                      {pet.tags && pet.tags.length > 0 && (
                        <div className="petm-tags">
                          {pet.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="petm-tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 操作按钮 */}
                      <div className="petm-actions">
                        {isInstalling ? (
                          <div className="petm-install-block">
                            <div className="petm-progress-track">
                              <div
                                className="petm-progress-fill"
                                style={{ width: `${installProgress!.progress}%` }}
                              />
                            </div>
                            <div className="petm-progress-msg">
                              {installProgress!.message}
                            </div>
                          </div>
                        ) : pet.installed ? (
                          <button
                            onClick={() => handleUninstall(pet)}
                            className="petm-btn petm-btn--uninstall"
                          >
                            卸载
                          </button>
                        ) : (
                          <button
                            onClick={() => handleInstall(pet)}
                            className="petm-btn petm-btn--install"
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
        <div className="petm-footer">
          <span>数据来源: Petdex (MIT License)</span>
          <span>已安装: {installedPets.length} 个宠物</span>
        </div>
      </div>
    </div>
  );
}
