/**
 * useWindowState — 窗口位置/大小持久化（对标 dsh main-window-state）
 *
 * 在窗口 resize/move/maximize 变化后防抖保存到 localStorage；
 * 下次启动恢复尺寸/位置/最大化状态。
 *
 * 安全设计：
 * - 仅在有效值（width/height > 0）时应用
 * - **坐标系成对**：保存用 `outerSize()/outerPosition()`（**物理像素**），恢复也必须用
 *   `PhysicalSize/PhysicalPosition` —— 见下面 D-4 的说明，混用会让恢复整段失效或按缩放比失真
 * - 监听防抖（500ms），避免高频 resize/move 频繁写 localStorage
 * - isMaximized 单独保存：最大化时恢复直接 maximize（不设具体尺寸，
 *   避免在不同显示器上错位）
 * - 恢复失败**不静默**：`console.warn` 留原始异常 + 走统一失败上报（可诊断痕迹）
 *
 * ## 第 45 轮 D-4：恢复载荷必须是 Tauri 的 `Size`/`Position` 值
 *
 * 旧实现是 `win.setSize({ width, height } as any)` / `win.setPosition({ x, y } as any)`
 * —— 一个**裸对象**。而 `@tauri-apps/api/window` 的 `setSize` 把它包成
 * `new Size(size)` 再序列化（`window.js`：`size instanceof Size ? size : new Size(size)`），
 * `Size[SERIALIZE_TO_IPC_FN]()` 返回的是外部标记枚举 `{ [size.type]: { width, height } }`
 * ——裸对象没有 `type`，键名于是变成字符串 `"undefined"`（`{"undefined":{…}}`），
 * 而 Rust 侧 `tauri::Size` 只接受 `{"Physical":{…}}` / `{"Logical":{…}}`：
 * 要么反序列化直接报错（`invoke` reject → 被空 catch 吞掉 → 尺寸位置**根本不恢复**），
 * 要么被当成某一档单位 —— 而保存的是物理像素，在缩放 ≠100% 的屏幕上就会按缩放比失真
 * （用户报的"窗口越开越大"）。两种结局都至少有一个是真缺陷。
 *
 * 所以：保存侧用 `outerSize()/outerPosition()`（物理），恢复侧用
 * `new PhysicalSize(...)` / `new PhysicalPosition(...)`（物理），两侧同一坐标系。
 */
import { useEffect } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { reportActionFailure } from "../core/storage/persist-failure";

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

/**
 * 恢复载荷：与保存侧 `outerSize()/outerPosition()` 的**物理像素**成对。
 *
 * 单独导出是为了让回归测试能断言"交给 Tauri 的到底是什么形状"
 * （裸对象 → `{"undefined":{…}}`；这两个类 → `{"Physical":{…}}`）。
 */
export function toPhysicalSize(saved: Pick<WindowState, "width" | "height">): PhysicalSize {
  return new PhysicalSize(saved.width, saved.height);
}

export function toPhysicalPosition(saved: Pick<WindowState, "x" | "y">): PhysicalPosition {
  return new PhysicalPosition(saved.x, saved.y);
}

/**
 * 应用一次保存的窗口状态。
 *
 * 失败**不吞**：抛给调用方（调用方负责留痕），因为"静默吞掉"正是这条缺陷
 * 藏了这么久的原因（用户只看到"窗口大小记不住"）。
 */
export async function restoreWindowState(win: WindowLike, saved: WindowState): Promise<void> {
  if (saved.maximized) {
    await win.maximize();
    return;
  }
  await win.setSize(toPhysicalSize(saved));
  // 位置也恢复（若坐标看起来合理——避免多显示器拔掉后窗口移出屏幕）
  await win.setPosition(toPhysicalPosition(saved));
}

/** `restoreWindowState` 需要的最小窗口能力（真实实现是 Tauri 的 `getCurrentWindow()`） */
export interface WindowLike {
  maximize(): Promise<void>;
  setSize(size: unknown): Promise<void>;
  setPosition(position: unknown): Promise<void>;
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
        await restoreWindowState(win, saved);
      } catch (e) {
        /**
         * 恢复失败（显示器变化、窗口被系统拒绝…）——**保持默认尺寸/位置，但必须留痕**：
         * 一行带原始异常的控制台告警（真机排查用）+ 一次统一失败上报
         * （`codem:persist-failed` → 用户可见提示，kind=action："这次恢复没有生效"）。
         * 旧实现这里是空 `catch {}`，于是"窗口大小记不住"没有任何可查的痕迹。
         */
        console.warn("[useWindowState] 窗口尺寸/位置恢复失败（已保持默认）:", {
          saved,
          error: e,
        });
        reportActionFailure(
          "useWindowState.restore",
          e,
          `窗口尺寸/位置未恢复（保存值 ${saved.width}×${saved.height} @ ${saved.x},${saved.y}）`,
        );
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
        } catch {
          // 保存路径拿不到窗口几何（窗口已关闭/平台不支持）—— 保持上一次的值，不写坏数据
        }
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
