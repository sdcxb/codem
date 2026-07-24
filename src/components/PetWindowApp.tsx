/**
 * PetWindowApp — 独立宠物窗口的根组件。
 *
 * 运行在 Tauri 创建的透明、无边框、置顶窗口中，
 * 独立于主窗口，最小化主窗口时宠物仍然可见。
 *
 * 数据流：
 * 1. 主窗口 pet-store 通过 Tauri 事件发送状态到宠物窗口
 * 2. 本组件监听事件，维护本地状态
 * 3. 渲染 PetSprite 精灵图动画
 * 4. 拖拽通过 Tauri startDragging 实现（原生窗口拖动）
 * 5. 右键菜单通过 Rust 原生弹出菜单（不受窗口边界裁剪）
 * 6. 悬浮气泡：监听 pet-bubble 事件，动态扩展窗口高度
 *
 * 基于 Petdex (MIT License) 开源项目集成并改造。
 */

import { useRef, useEffect, useState, useCallback, useLayoutEffect } from "react";
import { PetSprite } from "./PetSprite";
import type { PetDefinition, PetState } from "../core/pet/pet-types";

// ========== 类型 ==========

interface PetWindowState {
  definition: PetDefinition | null;
  spritesheetUrl: string | null;
  petState: PetState;
  scale: number;
  opacity: number;
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

/** 气泡与精灵图之间的间距 */
const BUBBLE_GAP = 6;
/** 气泡内容区固定宽度（逻辑像素），确保换行一致 */
const BUBBLE_MAX_WIDTH = 280;
/** 气泡可见时窗口至少需要的宽度（含 padding） */
const BUBBLE_WINDOW_WIDTH = BUBBLE_MAX_WIDTH + 20;

// ========== 组件 ==========

export function PetWindowApp() {
  const [state, setState] = useState<PetWindowState>({
    definition: null,
    spritesheetUrl: null,
    petState: "idle",
    scale: 0.4,
    opacity: 1.0,
  });
  const [bubble, setBubble] = useState<BubbleData>({ text: "", visible: false });
  // 气泡实际测量高度（动态，随内容变化）
  const [bubbleHeight, setBubbleHeight] = useState(48);
  const winRef = useRef<any>(null);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // 记录当前窗口额外宽高增量（用于位置增量计算，保持宠物视觉静止）
  const currentExtraWRef = useRef(0);
  const currentExtraHRef = useRef(0);

  // 获取当前 Tauri 窗口实例
  useEffect(() => {
    winRef.current = getTauriWindow();
  }, []);

  // 监听来自主窗口的事件
  useEffect(() => {
    const unlistenState = tauriListen("pet-state-update", (data: any) => {
      setState((prev) => ({
        ...prev,
        ...data,
      }));
    });

    const unlistenClose = tauriListen("pet-close", () => {
      const win = winRef.current;
      if (win) {
        win.close();
      }
    });

    // 监听气泡通知事件
    const unlistenBubble = tauriListen("pet-bubble", (data: any) => {
      const { text, duration = 4000 } = data;

      if (bubbleTimerRef.current) {
        clearTimeout(bubbleTimerRef.current);
      }

      setBubble({ text, visible: true });

      bubbleTimerRef.current = setTimeout(() => {
        setBubble((prev) => ({ ...prev, visible: false }));
      }, duration);
    });

    // 通知主窗口：宠物窗口已就绪
    const tauri = (window as any).__TAURI__;
    if (tauri?.event?.emit) {
      tauri.event.emit("pet-window-ready", {});
    }

    return () => {
      if (unlistenState) unlistenState();
      if (unlistenClose) unlistenClose();
      if (unlistenBubble) unlistenBubble();
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    };
  }, []);

  // ========== 测量气泡实际高度（同步，在 paint 前完成） ==========
  useLayoutEffect(() => {
    if (!bubble.visible || !bubbleRef.current) return;
    const h = bubbleRef.current.offsetHeight;
    if (h > 0 && h !== bubbleHeight) {
      setBubbleHeight(h);
    }
  }, [bubble.visible, bubble.text]);

  // ========== 窗口尺寸 + 位置：合并为一个 effect，用增量保证宠物不动 ==========
  useEffect(() => {
    if (!state.definition) return;
    const win = winRef.current;
    if (!win) return;

    const TauriAPI = (window as any).__TAURI__?.window;
    if (!TauriAPI?.LogicalSize || !TauriAPI?.LogicalPosition) return;

    const spriteW = FRAME_WIDTH * state.scale;
    const spriteH = FRAME_HEIGHT * state.scale;

    // 气泡可见时，窗口需扩展宽度（给文字留空间）和高度（自适应）
    const newExtraW = bubble.visible ? Math.max(0, BUBBLE_WINDOW_WIDTH - spriteW) : 0;
    const newExtraH = bubble.visible ? bubbleHeight + BUBBLE_GAP : 0;

    const windowW = spriteW + newExtraW;
    const windowH = spriteH + newExtraH;

    // 1) 调整窗口大小
    win.setSize(new TauriAPI.LogicalSize(windowW, windowH)).catch(() => {});

    // 2) 用增量调整窗口位置：上移 deltaH，左移 deltaW/2（居中扩展）
    const deltaW = newExtraW - currentExtraWRef.current;
    const deltaH = newExtraH - currentExtraHRef.current;

    if (deltaW !== 0 || deltaH !== 0) {
      win.outerPosition().then((physicalPos: any) => {
        const dpr = window.devicePixelRatio || 1;
        const logicalX = physicalPos.x / dpr;
        const logicalY = physicalPos.y / dpr;
        const newX = logicalX - deltaW / 2;
        const newY = logicalY - deltaH;
        win.setPosition(new TauriAPI.LogicalPosition(newX, newY)).catch(() => {});
      }).catch(() => {});
    }

    currentExtraWRef.current = newExtraW;
    currentExtraHRef.current = newExtraH;
  }, [state.definition, state.scale, bubble.visible, bubbleHeight]);

  // 拖拽：使用 Tauri 原生窗口拖动
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) return;
    const win = winRef.current;
    if (win) {
      win.startDragging();
    }
  }, []);

  // 右键菜单：调用 Rust 原生弹出菜单
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (invoke) {
      const dpr = window.devicePixelRatio || 1;
      invoke("show_pet_menu", {
        x: e.clientX * dpr,
        y: e.clientY * dpr,
        petName: state.definition?.name ?? null,
      }).catch((err: any) => {
        console.warn("[PetWindowApp] Failed to show pet menu:", err);
      });
    }
  }, [state.definition]);

  // 如果没有收到定义，显示加载中
  if (!state.definition || !state.spritesheetUrl) {
    return (
      <div style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: "rgba(136,136,136,0.5)",
        fontSize: "10px",
      }}>
        ...
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        background: "transparent",
        userSelect: "none",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* 悬浮气泡 — 绝对定位在精灵图上方，高度自适应内容 */}
      {bubble.visible && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: `${BUBBLE_GAP}px`,
            zIndex: 10,
            pointerEvents: "none",
            animation: "petBubbleIn 0.3s ease",
          }}
        >
          <div
            ref={bubbleRef}
            style={{
              width: `${BUBBLE_MAX_WIDTH}px`,
              flexShrink: 0,
              padding: "6px 12px",
              borderRadius: "12px",
              background: "rgba(30, 30, 46, 0.92)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              backdropFilter: "blur(8px)",
              color: "#e8e8f0",
              fontSize: "12px",
              lineHeight: "1.4",
              textAlign: "center",
              whiteSpace: "normal",
              wordBreak: "break-word",
              position: "relative",
            }}
          >
            {bubble.text}
            {/* 气泡小尾巴 */}
            <div
              style={{
                position: "absolute",
                bottom: "-5px",
                left: "50%",
                transform: "translateX(-50%)",
                width: "0",
                height: "0",
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid rgba(30, 30, 46, 0.92)",
              }}
            />
          </div>
        </div>
      )}

      {/* 宠物精灵图 */}
      <div
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        title={state.definition.name}
        style={{
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

      {/* 气泡动画 keyframes */}
      <style>{`
        @keyframes petBubbleIn {
          0% {
            opacity: 0;
            transform: translateY(8px) scale(0.9);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}
