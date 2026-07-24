/**
 * PetOverlay — 宠物浮窗组件。
 *
 * 在主窗口右下角显示宠物精灵图，支持拖拽移动。
 * 宠物状态由 usePetStore 管理，自动响应 Agent 事件。
 *
 * 特性：
 * - 固定定位（fixed），始终在视窗右下角
 * - 可拖拽移动位置
 * - 左键点击切换状态（彩蛋交互）
 * - 右键菜单：关闭宠物、切换已安装宠物
 * - 不影响底层 UI 交互（pointer-events 仅在宠物区域生效）
 *
 * ⚠️ 所有 hooks 必须在 early return 之前调用，否则违反 React Rules of Hooks。
 *
 * 基于 Petdex (MIT License) 开源项目集成并改造。
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { PetSprite } from "./PetSprite";
import { usePetStore } from "../core/pet/pet-store";
import type { PetState } from "../core/pet/pet-types";

/** 状态名称映射（用于 tooltip） */
const STATE_LABELS: Record<PetState, string> = {
  idle: "悠闲",
  thinking: "思考中...",
  working: "工作中...",
  happy: "开心！",
  sad: "出错了...",
  sleeping: "睡觉中...",
};

/** 点击彩蛋：idle/sleeping 时点击循环切换状态 */
const CLICK_STATES: PetState[] = ["happy", "idle", "thinking", "working", "sad", "sleeping"];

export function PetOverlay() {
  const {
    enabled,
    activePet,
    spritesheetUrl,
    petState,
    positionX,
    positionY,
    scale,
    opacity,
    installedPets,
    setPosition,
    setPetState,
    setEnabled,
    setActivePet,
  } = usePetStore();

  // ===== 所有 hooks 必须在 early return 之前 =====
  const [isDragging, setIsDragging] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; petX: number; petY: number } | null>(null);
  const dragMovedRef = useRef(false);
  const clickCountRef = useRef(0);

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  // 点击其他区域时关闭菜单
  useEffect(() => {
    if (!showContextMenu) return;
    const handleClickOutside = () => closeContextMenu();
    const timer = setTimeout(() => {
      document.addEventListener("click", handleClickOutside);
      document.addEventListener("contextmenu", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("contextmenu", handleClickOutside);
    };
  }, [showContextMenu, closeContextMenu]);

  // 拖拽处理
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return; // 右键不触发拖拽
    e.preventDefault();
    e.stopPropagation();

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      petX: positionX,
      petY: positionY,
    };
    dragMovedRef.current = false;
    setIsDragging(true);
  }, [positionX, positionY]);

  // 拖拽移动监听
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragMovedRef.current = true;
      }

      const newX = dragStartRef.current.petX - dx;
      const newY = dragStartRef.current.petY - dy;

      const maxX = window.innerWidth - 32;
      const maxY = window.innerHeight - 32;
      const clampedX = Math.max(0, Math.min(maxX, newX));
      const clampedY = Math.max(0, Math.min(maxY, newY));

      setPosition(clampedX, clampedY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, setPosition]);

  // 左键点击彩蛋
  const handleClick = useCallback(() => {
    if (dragMovedRef.current) return;
    if (petState === "idle" || petState === "sleeping") {
      clickCountRef.current = (clickCountRef.current + 1) % CLICK_STATES.length;
      setPetState(CLICK_STATES[clickCountRef.current]);
    }
  }, [petState, setPetState]);

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  // ===== early return 在所有 hooks 之后 =====
  if (!enabled || !activePet || !spritesheetUrl) {
    return null;
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          right: `${positionX}px`,
          bottom: `${positionY}px`,
          zIndex: 99999,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {/* 状态指示器（小气泡） */}
        {petState !== "idle" && petState !== "sleeping" && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              marginBottom: "4px",
              padding: "2px 8px",
              borderRadius: "10px",
              background: "rgba(0, 0, 0, 0.6)",
              color: "#fff",
              fontSize: "11px",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              backdropFilter: "blur(4px)",
            }}
          >
            {STATE_LABELS[petState]}
          </div>
        )}

        {/* 宠物精灵图 */}
        <div
          onMouseDown={handleMouseDown}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title={`${activePet.definition.name}（右键菜单）`}
          style={{
            pointerEvents: "auto",
            cursor: isDragging ? "grabbing" : "grab",
            filter: petState === "sleeping" ? "brightness(0.7)" : "none",
            transition: "filter 0.3s ease",
          }}
        >
          <PetSprite
            definition={activePet.definition}
            spritesheetUrl={spritesheetUrl}
            petState={petState}
            scale={scale}
            opacity={opacity}
          />
        </div>
      </div>

      {/* 右键菜单 */}
      {showContextMenu && (
        <div
          style={{
            position: "fixed",
            left: `${menuPos.x}px`,
            top: `${menuPos.y}px`,
            zIndex: 100001,
            pointerEvents: "auto",
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            style={{
              minWidth: "180px",
              padding: "4px",
              borderRadius: "8px",
              background: "var(--bg-secondary, #1e1e2e)",
              border: "1px solid var(--border-primary, rgba(255,255,255,0.1))",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              backdropFilter: "blur(12px)",
            }}
          >
            {/* 当前宠物名称 */}
            <div
              style={{
                padding: "8px 12px",
                fontSize: "11px",
                color: "var(--text-secondary, #888)",
                borderBottom: "1px solid var(--border-primary, rgba(255,255,255,0.08))",
                marginBottom: "4px",
              }}
            >
              🐾 {activePet.definition.name}
            </div>

            {/* 切换宠物列表 */}
            {installedPets.length > 1 && (
              <>
                <div style={{ padding: "4px 12px", fontSize: "10px", color: "var(--text-secondary, #666)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  切换宠物
                </div>
                {installedPets.map((pet) => (
                  <div
                    key={pet.slug}
                    onClick={() => {
                      setActivePet(pet.slug);
                      closeContextMenu();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px 12px",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "13px",
                      color: pet.slug === activePet.slug
                        ? "var(--accent, #6366f1)"
                        : "var(--text-primary, #e0e0e0)",
                      fontWeight: pet.slug === activePet.slug ? 600 : 400,
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "none"}
                  >
                    <span>{pet.slug === activePet.slug ? "●" : "○"}</span>
                    <span>{pet.definition.name}</span>
                  </div>
                ))}
                <div style={{ height: "1px", background: "var(--border-primary, rgba(255,255,255,0.08))", margin: "4px 0" }} />
              </>
            )}

            {/* 关闭宠物 */}
            <div
              onClick={() => {
                setEnabled(false);
                closeContextMenu();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "13px",
                color: "#f87171",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = "rgba(239,68,68,0.1)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "none"}
            >
              <span>✕</span>
              <span>关闭宠物</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
