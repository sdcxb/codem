/**
 * PetWindowApp — 独立宠物窗口的根组件。
 *
 * ===== 窗口尺寸策略 =====
 * - 初始（无气泡）：窗口 = 精灵图宽 × (精灵图高 + MIN_BUBBLE_HEIGHT)
 * - 事件气泡出现：用 canvas 精确测量文本所需宽高，动态扩展窗口
 * - 事件气泡消失：缩回初始紧凑尺寸
 * - 悬停气泡：不触发 resize，在 MIN_BUBBLE_HEIGHT 预留空间内显示
 *
 * ===== 防漂移核心：Rust 端锚点计算 =====
 * 前端只传目标 width/height 给 Rust 的 resize_pet_window_anchored 命令。
 * Rust 端同步读取当前窗口位置 → 计算锚点（水平中心 + 底部）
 * → 原子化设置新位置和尺寸。全程无异步间隙，无 tauri://move 事件竞态。
 *
 * 基于 Petdex (MIT License) 开源项目集成并改造。
 */

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { PetSprite } from "./PetSprite";
import type { PetDefinition, PetState } from "../core/pet/pet-types";

// ========== 类型 ==========

interface PetInfo {
  slug: string;
  name: string;
}

interface PetWindowState {
  definition: PetDefinition | null;
  spritesheetUrl: string | null;
  petState: PetState;
  scale: number;
  opacity: number;
  /** 已安装宠物列表，用于右键菜单切换样式 */
  installedPets: PetInfo[];
  /** 当前激活宠物的 slug */
  activeSlug: string | null;
}

interface BubbleData {
  text: string;
  visible: boolean;
}

// ========== Tauri 事件辅助 ==========

function getTauriWindow(): any | null {
  const tauri = (window as any).__TAURI__;
  return tauri?.window?.getCurrentWindow?.() ?? null;
}

function tauriListen(event: string, handler: (payload: any) => void): (() => void) | null {
  const tauri = (window as any).__TAURI__;
  if (!tauri?.event?.listen) return null;
  let unlisten: (() => void) | null = null;
  tauri.event.listen(event, (e: any) => handler(e.payload)).then((un: (() => void)) => {
    unlisten = un;
  });
  return () => { if (unlisten) unlisten(); };
}

// ========== 常量 ==========

const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;

/** 气泡与精灵图之间的间距（含箭头高度 4px） */
const BUBBLE_GAP = 8;
/** 预留最小气泡高度（初始窗口高度 = spriteH + 此值） */
const MIN_BUBBLE_HEIGHT = 34;
/** 气泡最大宽度（px） */
const BUBBLE_MAX_WIDTH = 240;
/** 气泡 CSS 参数（须与 measureBubbleText 一致） */
const BUBBLE_FONT = "11px sans-serif";
const BUBBLE_PADDING_H = 10; // 每侧
const BUBBLE_PADDING_V = 5;  // 每侧
const BUBBLE_LINE_HEIGHT = 15; // ≈ 11px × 1.35

/** 宠物状态 → 悬停时显示的中文描述 */
const PET_STATE_TEXT: Record<PetState, string> = {
  idle: "空闲中",
  thinking: "思考中…",
  working: "工作中…",
  happy: "任务完成！",
  sad: "出错了",
  sleeping: "休眠中",
  waiting: "等待中",
  review: "请审查变更",
  waving: "任务完成！",
};

// ========== 气泡文本测量（canvas 精确测量） ==========

function measureBubbleText(text: string): { width: number; height: number } {
  const paddingH = BUBBLE_PADDING_H * 2;
  const paddingV = BUBBLE_PADDING_V * 2;
  const innerMaxWidth = BUBBLE_MAX_WIDTH - paddingH;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // fallback：无 canvas 时粗略估算
  if (!ctx) {
    const charW = 7;
    const lines = Math.max(1, Math.ceil((text.length * charW) / innerMaxWidth));
    return {
      width: Math.min(text.length * charW + paddingH, BUBBLE_MAX_WIDTH),
      height: lines * BUBBLE_LINE_HEIGHT + paddingV,
    };
  }

  ctx.font = BUBBLE_FONT;

  // 处理显式换行 + 自动换行
  const explicitLines = text.split("\n");
  const wrappedLines: string[] = [];

  for (const line of explicitLines) {
    if (line === "") {
      wrappedLines.push("");
      continue;
    }
    if (ctx.measureText(line).width <= innerMaxWidth) {
      wrappedLines.push(line);
      continue;
    }
    // 逐字符换行（兼容中英文混合）
    let current = "";
    for (let i = 0; i < line.length; i++) {
      const test = current + line[i];
      if (ctx.measureText(test).width > innerMaxWidth && current) {
        wrappedLines.push(current);
        current = line[i];
      } else {
        current = test;
      }
    }
    if (current) wrappedLines.push(current);
  }

  const maxLineWidth = Math.max(...wrappedLines.map((l) => ctx.measureText(l).width));
  return {
    width: Math.ceil(Math.min(maxLineWidth + paddingH, BUBBLE_MAX_WIDTH)),
    height: Math.ceil(wrappedLines.length * BUBBLE_LINE_HEIGHT + paddingV),
  };
}

// ========== 组件 ==========

export function PetWindowApp() {
  const [state, setState] = useState<PetWindowState>({
    definition: null,
    spritesheetUrl: null,
    petState: "idle",
    scale: 0.4,
    opacity: 1.0,
    installedPets: [],
    activeSlug: null,
  });
  const [bubble, setBubble] = useState<BubbleData>({ text: "", visible: false });
  const [isHovering, setIsHovering] = useState(false);
  const [ready, setReady] = useState(false);

  const winRef = useRef<any>(null);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== 获取 Tauri 窗口实例 =====
  useEffect(() => {
    const win = getTauriWindow();
    winRef.current = win;
    if (win) setReady(true);
  }, []);

  // ===== 事件监听 =====
  useEffect(() => {
    const unlistenState = tauriListen("pet-state-update", (data: any) => {
      setState((prev) => ({ ...prev, ...data }));
    });
    const unlistenClose = tauriListen("pet-close", () => {
      const win = winRef.current;
      if (win) win.close();
    });
    const unlistenBubble = tauriListen("pet-bubble", (data: any) => {
      const { text, duration = 4000 } = data;
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
      setBubble({ text, visible: true });
      bubbleTimerRef.current = setTimeout(() => {
        setBubble((prev) => ({ ...prev, visible: false }));
      }, duration);
    });
    const tauri = (window as any).__TAURI__;
    if (tauri?.event?.emit) tauri.event.emit("pet-window-ready", {});
    return () => {
      if (unlistenState) unlistenState();
      if (unlistenClose) unlistenClose();
      if (unlistenBubble) unlistenBubble();
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    };
  }, []);

  // ===== 精确测量事件气泡尺寸 =====
  const bubbleSize = useMemo(() => {
    if (!bubble.visible || !bubble.text) return null;
    return measureBubbleText(bubble.text);
  }, [bubble.visible, bubble.text]);

  const eventBubbleActive = bubble.visible && bubbleSize !== null;

  // ===== 显示气泡（事件优先 > 悬停）=====
  const displayBubbleText = bubble.visible
    ? bubble.text
    : isHovering
      ? (PET_STATE_TEXT[state.petState] ?? "")
      : "";
  const displayBubbleVisible = bubble.visible || isHovering;

  // ===== geometry effect：调用 Rust 端锚点 resize =====
  useEffect(() => {
    if (!state.definition || !ready) return;

    const spriteW = FRAME_WIDTH * state.scale;
    const spriteH = FRAME_HEIGHT * state.scale;

    let windowW: number;
    let windowH: number;

    if (eventBubbleActive && bubbleSize) {
      // 事件气泡：窗口宽度取精灵图与气泡的较大值，高度 = 精灵图 + 气泡 + 间距
      windowW = Math.max(spriteW, bubbleSize.width + 4); // +4 for border
      windowH = spriteH + bubbleSize.height + BUBBLE_GAP;
    } else {
      // 无事件气泡：紧凑尺寸 + 预留最小气泡高度
      windowW = spriteW;
      windowH = spriteH + MIN_BUBBLE_HEIGHT;
    }

    // ★ 调用 Rust 端命令：同步读取当前位置 → 计算锚点 → 设置新位置和尺寸
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (invoke) {
      invoke("resize_pet_window_anchored", {
        width: windowW,
        height: windowH,
      }).catch(() => {});
    }
  }, [state.definition, state.scale, ready, eventBubbleActive, bubbleSize]);

  // ===== 交互处理 =====
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return;
    const win = winRef.current;
    if (win) win.startDragging();
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { invoke } = (window as any).__TAURI__?.core || {};
      if (invoke) {
        const dpr = window.devicePixelRatio || 1;
        invoke("show_pet_menu", {
          x: e.clientX * dpr,
          y: e.clientY * dpr,
          petName: state.definition?.name ?? null,
          pets: state.installedPets,
          activeSlug: state.activeSlug,
        }).catch(() => {});
      }
    },
    [state.definition, state.installedPets, state.activeSlug]
  );

  const handleMouseEnter = useCallback(() => setIsHovering(true), []);
  const handleMouseLeave = useCallback(() => setIsHovering(false), []);

  // ===== 渲染 =====
  if (!state.definition || !state.spritesheetUrl) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          color: "rgba(136,136,136,0.5)",
          fontSize: "10px",
        }}
      >
        ...
      </div>
    );
  }

  const spriteW = FRAME_WIDTH * state.scale;
  const spriteH = FRAME_HEIGHT * state.scale;
  const bubbleMaxW = eventBubbleActive ? BUBBLE_MAX_WIDTH : Math.max(spriteW - BUBBLE_PADDING_H * 2, 60);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        background: "transparent",
        userSelect: "none",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* 气泡区域：占据精灵图上方空间 */}
      {displayBubbleVisible && displayBubbleText && (
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: BUBBLE_GAP,
            zIndex: 10,
            pointerEvents: "none",
            maxWidth: "100%",
            animation: "petBubbleIn 0.2s ease",
          }}
        >
          <div
            style={{
              maxWidth: `${bubbleMaxW}px`,
              width: "fit-content",
              padding: `${BUBBLE_PADDING_V}px ${BUBBLE_PADDING_H}px`,
              borderRadius: "10px",
              background: "rgba(30, 30, 46, 0.92)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              backdropFilter: "blur(8px)",
              color: "#e8e8f0",
              fontFamily: "sans-serif",
              fontSize: "11px",
              lineHeight: `${BUBBLE_LINE_HEIGHT}px`,
              textAlign: "center",
              whiteSpace: "normal",
              wordBreak: "break-word",
              position: "relative",
            }}
          >
            {displayBubbleText}
            {/* 气泡箭头 */}
            <div
              style={{
                position: "absolute",
                bottom: "-4px",
                left: "50%",
                transform: "translateX(-50%)",
                width: "0",
                height: "0",
                borderLeft: "4px solid transparent",
                borderRight: "4px solid transparent",
                borderTop: "4px solid rgba(30, 30, 46, 0.92)",
              }}
            />
          </div>
        </div>
      )}

      {/* 宠物精灵图 */}
      <div
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          flexShrink: 0,
          cursor: "grab",
          filter: state.petState === "sleeping" ? "brightness(0.7)" : "none",
          transition: "filter 0.3s ease",
        }}
      >
        <PetSprite
          definition={state.definition}
          spritesheetUrl={state.spritesheetUrl}
          petState={state.petState}
          scale={state.scale}
          opacity={state.opacity}
        />
      </div>

      <style>{`
        @keyframes petBubbleIn {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
