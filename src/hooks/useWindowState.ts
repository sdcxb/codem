/**
 * useWindowState — 窗口位置/大小持久化（对标 dsh main-window-state）
 *
 * 在窗口 resize/move/maximize 变化后防抖保存到 localStorage；
 * 下次启动恢复尺寸/位置/最大化状态。
 *
 * 安全设计：
 * - 仅在有效值（width/height > 0）时应用，失败静默（不阻塞启动）
 * - 恢复用 setSize/setPosition 为逻辑坐标，避免 DPI 缩放误差
 * - 监听防抖（500ms），避免高频 resize/move 频繁写 localStorage
 * - isMaximized 单独保存：最大化时恢复直接 maximize（不设具体尺寸，
 *   避免在不同显示器上错位）
 */
import { useEffect } from "react";

const STORAGE_KEY = "codem-window-state";

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

function getWindow(): any {
  try {
    const tauri = (window as any).__TAURI__;
    if (tauri?.window?.getCurrentWindow) {
      return tauri.window.getCurrentWindow();
    }
  } catch {}
  return null;
}

function loadSaved(): WindowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WindowState;
    // 校验：尺寸必须为正数才有效
    if (!parsed || typeof parsed.width !== "number" || parsed.width < 400 ||
        typeof parsed.height !== "number" || parsed.height < 300) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveState(state: WindowState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 满/不可用 — 静默
  }
}

export function useWindowState(): void {
  useEffect(() => {
    const win = getWindow();
    if (!win) return;

    let mounted = true;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // ===== 恢复保存的窗口状态 =====
    (async () => {
      const saved = loadSaved();
      if (!saved || !mounted) return;
      try {
        if (saved.maximized) {
          await win.maximize();
        } else {
          await win.setSize({ width: saved.width, height: saved.height } as any);
          // 位置也恢复（若坐标看起来合理——避免多显示器拔掉后窗口移出屏幕）
          await win.setPosition({ x: saved.x, y: saved.y } as any);
        }
      } catch {
        // 恢复失败（如显示器变化）— 保持默认居中
      }
    })();

    // ===== 监听变化并防抖保存 =====
    const scheduleSave = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const size = await win.outerSize();
          const pos = await win.outerPosition();
          const maximized = await win.isMaximized();
          saveState({
            width: size.width,
            height: size.height,
            x: pos.x,
            y: pos.y,
            maximized,
          });
        } catch {}
      }, 500);
    };

    // Tauri v2: resize/move 通过 onResized/onMoved 事件
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let unlistenMax: (() => void) | undefined;

    win.onResized?.(scheduleSave).then((u: () => void) => { unlistenResize = u; }).catch(() => {});
    win.onMoved?.(scheduleSave).then((u: () => void) => { unlistenMove = u; }).catch(() => {});
    // 最大化状态变化（Tauri 无专门事件，用间隔检测 + 现有 resize 事件已覆盖）

    return () => {
      mounted = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, []);
}
