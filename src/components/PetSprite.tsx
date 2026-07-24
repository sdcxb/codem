/**
 * PetSprite — 宠物精灵图渲染组件。
 *
 * 使用 CSS background-position 帧动画渲染精灵图。
 * 根据 petState 自动切换到对应动画帧序列。
 *
 * 渲染原理（基于 Petdex 固定网格布局）：
 * - 精灵图是一张包含所有动画帧的大图
 * - 每帧 192×208px，8 列 1536px 宽
 * - 每帧通过 background-position 偏移显示
 * - 使用 requestAnimationFrame 按帧间隔切换 background-position
 *
 * ⚠️ 关键：backgroundPosition 必须与 backgroundSize 使用相同的坐标系。
 * 当 backgroundSize 按 scale 缩放时，position 也必须按 scale 缩放，
 * 否则定位会错位（表现为画面截断拼接）。
 *
 * 基于 Petdex (MIT License) 开源项目集成并改造。
 */

import { useRef, useEffect, useState, useCallback, memo } from "react";
import type { PetDefinition, PetState } from "../core/pet/pet-types";
import { getAnimationForState } from "../core/pet/pet-manager";

interface PetSpriteProps {
  /** 宠物定义 */
  definition: PetDefinition;
  /** 精灵图 Data URL */
  spritesheetUrl: string;
  /** 当前宠物状态 */
  petState: PetState;
  /** 缩放比例（覆盖 definition.scale） */
  scale?: number;
  /** 透明度 (0-1) */
  opacity?: number;
  /** 点击回调 */
  onClick?: () => void;
}

export const PetSprite = memo(function PetSprite({
  definition,
  spritesheetUrl,
  petState,
  scale,
  opacity = 1,
  onClick,
}: PetSpriteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const rafRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const frameRef = useRef<number>(0);

  // 获取当前状态的动画配置
  const anim = getAnimationForState(definition, petState);
  const effectiveScale = scale ?? definition.scale ?? 1.0;

  // 帧动画循环
  const animate = useCallback((timestamp: number) => {
    if (!anim) return;

    const elapsed = timestamp - lastFrameTimeRef.current;
    if (elapsed >= anim.frameInterval) {
      lastFrameTimeRef.current = timestamp;

      if (anim.loop) {
        frameRef.current = (frameRef.current + 1) % anim.frames;
      } else {
        if (frameRef.current < anim.frames - 1) {
          frameRef.current += 1;
        }
      }
      setCurrentFrame(frameRef.current);
    }

    rafRef.current = requestAnimationFrame(animate);
  }, [anim]);

  // 状态切换时重置帧
  useEffect(() => {
    frameRef.current = 0;
    setCurrentFrame(0);
    lastFrameTimeRef.current = performance.now();

    if (anim) {
      rafRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [petState, anim, animate]);

  if (!anim) {
    return null;
  }

  // ⚠️ background-position 必须与 background-size 使用相同坐标系。
  // background-size 已按 effectiveScale 缩放，所以 position 也必须缩放。
  // 不缩放的话，scale≠1 时定位会指向错误的行，导致画面截断拼接。
  const bgX = -(anim.x + currentFrame * anim.frameWidth) * effectiveScale;
  const bgY = -anim.y * effectiveScale;

  // 渲染尺寸
  const renderWidth = anim.frameWidth * effectiveScale;
  const renderHeight = anim.frameHeight * effectiveScale;

  // background-size: 只设宽度，高度用 auto 让浏览器按图片原始宽高比自动计算。
  // 这样无论精灵图实际有多少行，每行始终是 208px（缩放后 208*scale），
 // 不会因为 sheetHeight 估计错误而导致图片被拉伸、行高偏移。
  const bgWidth = definition.sheetWidth * effectiveScale;

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      style={{
        width: `${renderWidth}px`,
        height: `${renderHeight}px`,
        backgroundImage: `url(${spritesheetUrl})`,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundSize: `${bgWidth}px auto`,
        backgroundRepeat: "no-repeat",
        opacity,
        cursor: onClick ? "pointer" : "default",
        imageRendering: "pixelated",
        userSelect: "none",
        pointerEvents: "auto",
        position: "relative",
        zIndex: 2147483647,
      }}
    />
  );
});
