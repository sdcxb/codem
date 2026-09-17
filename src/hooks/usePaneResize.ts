/**
 * usePaneResize — 面板拖拽调整 Hook
 *
 * 支持侧边栏、右侧栏可拖拽调整宽度。
 * 使用 requestAnimationFrame 调度，避免拖拽卡顿。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getSetting, setSetting } from "../core/storage/settings";
import { hasStoragePort } from "../core/storage/port";

interface PaneResizeConfig {
  /** 最小宽度 */
  min: number;
  /** 最大宽度 */
  max: number;
  /** 初始宽度 */
  initial: number;
  /** 持久化 key（可选） */
  storageKey?: string;
  /**
   * 持久化介质（第 45 轮 D-22）。
   *
   * - `"db"`（默认）：写 DB 的 `settings` 表 —— 与 `codem-sidebar-width` 同类偏好同介质；
   * - `"localStorage"`：只写 localStorage（历史行为，留给不想动库的调用方/测试）。
   *
   * 旧实现**只会**写 localStorage，于是"同类偏好两种介质"：清 localStorage（或换 profile）
   * 会不同步地丢掉一部分界面偏好，崩溃恢复卡的"重置界面设置"也只清到这一半。
   */
  storage?: "db" | "localStorage";
}

/** 旧 localStorage 键（`"db"` 介质下读它做一次性迁移，写完 DB 后清掉） */
const legacyKey = (key: string) => key;

/**
 * 同一 key 的宽度变化广播。
 * 宽度变化时广播，让同一进程里的其它同 key 面板（例如 Hub 布局）同步。
 */
const paneWidthEvent = (key: string) => `codem-pane-width:${key}`;

/**
 * D-22 的订阅式读取：端口未就绪时先按 `initial` 渲染，端口注册那一刻
 * （`App.tsx` 首个 effect）由 `port.ts` 的订阅者广播一次，这里再读 DB。
 *
 * 为什么需要"重复读"：`getSetting` 在端口未注册时同步返回 `null`，而 `useState`
 * 的初值只算一次 —— 只读一次就会把"读不到"当成"用默认宽度"永久固化。
 */
function subscribePaneWidth(key: string, onChange: () => void): () => void {
  const handler = () => onChange();
  const w = window as unknown as {
    addEventListener?: (t: string, h: EventListenerOrEventListenerObject) => void;
    removeEventListener?: (t: string, h: EventListenerOrEventListenerObject) => void;
  };
  w.addEventListener?.(paneWidthEvent(key), handler as EventListener);
  return () => w.removeEventListener?.(paneWidthEvent(key), handler as EventListener);
}

export function usePaneResize(config: PaneResizeConfig) {
  const min = config.min;
  const max = config.max;
  const initial = config.initial;
  const storageKey = config.storageKey;
  const storage = config.storage ?? "db";

  const clamp = useCallback((n: number) => Math.max(min, Math.min(max, n)), [min, max]);

  /** 从配置的介质读宽度；读不到返回 null（**不返回默认值**，由调用方决定怎么兜） */
  const readStored = useCallback((): number | null => {
    if (!storageKey) return null;
    const parse = (raw: string | null | undefined): number | null => {
      if (!raw) return null;
      const num = parseInt(raw, 10);
      return Number.isNaN(num) ? null : num;
    };
    if (storage === "localStorage") {
      try {
        return parse(localStorage.getItem(legacyKey(storageKey)));
      } catch {
        return null;
      }
    }
    // DB 优先（与 codem-sidebar-width 同介质）
    try {
      const fromDb = parse(getSetting(storageKey));
      if (fromDb !== null) return fromDb;
    } catch {
      /* 端口未就绪 → 走下面的 localStorage 兜底 */
    }
    /**
     * 旧 localStorage 值兜底 + **在读取处就搬进 DB**（第 45 轮 D-22）。
     *
     * 为什么不在 `endResize` 里搬：那要等用户拖一次才迁移，用户不拖就永远两种介质并存
     * （旧键一直在、DB 一直是空）。在读取处搬的好处是"读一次就收敛"——
     * 而端口未就绪时 `setSetting` 会走 `reportWriteNotAccepted`，此时**不删旧键**，
     * 等端口注册后（`port.ts` 的订阅者会触发 resync → 再读一次）自然完成迁移。
     */
    let legacy: number | null = null;
    try {
      legacy = parse(localStorage.getItem(legacyKey(storageKey)));
    } catch {
      legacy = null;
    }
    if (legacy === null) return null;
    try {
      // 端口未注册时不写 DB（`setSetting` 不抛，但会在权限上报通道里留一条"未保存"）：
      // 先按旧值渲染，等端口注册后由订阅者触发 resync → 再读一次自然完成迁移
      if (hasStoragePort()) {
        setSetting(storageKey, String(legacy));
        localStorage.removeItem(legacyKey(storageKey));
      }
    } catch {
      /* 迁移失败：旧值仍然生效，下一次读取再试 */
    }
    return legacy;
  }, [storageKey, storage]);

  const [width, setWidth] = useState(() => {
    const saved = readStored();
    // 第 45 轮 D-22：范围校验保留（脏值不能把面板顶出屏幕）
    if (saved !== null && saved >= min && saved <= max) return saved;
    return initial;
  });

  const persist = useCallback((value: number) => {
    if (!storageKey) return;
    if (storage === "localStorage") {
      try {
        localStorage.setItem(legacyKey(storageKey), String(value));
      } catch {}
      return;
    }
    /**
     * DB 优先；**端口不可用时退回 localStorage 写**（不是静默丢）。
     *
     * 两个理由：
     * - 端口注册是 App 首个 effect 里的事，在此之前用户也可能拖宽度（启动早期）；
     * - 退回写保证"任何时刻都能持久化"，只是介质在端口就绪前后不同，
     *   而端口就绪时 `readStored()` 会把 localStorage 那份**搬进 DB 并清掉**（收敛到单一介质）。
     */
    let wroteToDb = false;
    try {
      // `setSetting` 在端口未注册时**不抛**（只走 `reportWriteNotAccepted`），
      // 所以必须先自己判端口是否可用，否则会把"只改了内存镜像"当成落库成功
      if (hasStoragePort()) {
        setSetting(storageKey, String(value));
        wroteToDb = true;
      }
    } catch {
      wroteToDb = false;
    }
    try {
      if (wroteToDb) localStorage.removeItem(legacyKey(storageKey));
      else localStorage.setItem(legacyKey(storageKey), String(value));
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent(paneWidthEvent(storageKey)));
    } catch {}
  }, [storageKey, storage]);

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef({ x: 0, width: 0 });
  const frameRef = useRef<number | null>(null);
  /** 手势是否仍在进行（endResize 幂等的依据） */
  const activeRef = useRef(false);
  /** 最近一次**已经写进 state** 的宽度 */
  const widthRef = useRef(width);
  /** 最近一次**期望**的宽度（含还在 rAF 队列里、尚未落进 state 的那一次） */
  const pendingWidthRef = useRef(width);
  /** 结束手势要摘掉的监听器（全部注册在 document / window 上） */
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  /**
   * 端口就绪 / 其它面板改了同一 key 时重新读一次（D-22）。
   *
   * 只在**手势没在进行中**时覆盖，否则会把用户正在拖的宽度拽回去。
   * 两个来源：① 本进程里别的同 key 面板广播的自定义事件；
   * ② 存储端口注册（`App.tsx` 首个 effect 里的 `await registerRustStoragePort()`）——
   * 那一刻 DB 才能同步读到，必须重读一次，否则首帧的 `initial` 会被永久固化。
   */
  useEffect(() => {
    if (!storageKey) return;
    const resync = () => {
      if (activeRef.current) return;
      const saved = readStored();
      if (saved === null || saved < min || saved > max) return;
      if (saved === widthRef.current) return;
      widthRef.current = saved;
      pendingWidthRef.current = saved;
      setWidth(saved);
    };
    const unsub = subscribePaneWidth(storageKey, resync);

    let disposed = false;
    let unsubPort: (() => void) | null = null;
    // 延迟导入 + 忽略失败：纯 UI 测试环境里没有存储端口模块也没关系
    void import("../core/storage/port")
      .then((mod) => {
        if (disposed) return;
        unsubPort = mod.setStoragePortListener(() => {
          resync();
        });
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unsub();
      unsubPort?.();
    };
  }, [storageKey, readStored, min, max]);

  /**
   * 结束拖拽 —— **幂等**，并且是唯一的释放路径。
   *
   * P1-10：原来只有 `pointerup` 会摘掉 `body.resizing-columns`，而
   * `src/styles/codem-ui.css` 里那条规则是 `body.resizing-columns * { pointer-events: none !important }`
   * —— 手势一旦以 `pointercancel`（系统抢走指针 / 触摸被取消）、窗口失焦、
   * 或者 `pointerup` 落在别的元素上结束，class 就永远摘不掉，**整个界面再也点不动**。
   * 所以 pointerup / pointercancel / window.blur / 组件卸载都收敛到这里。
   */
  const endResize = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setIsResizing(false);

    /**
     * 结算最后一次位移再退场。
     *
     * 两条结束路径的"最后位置"来源不同，必须都照顾到：
     * - pointerup 有事件坐标 → `handleUp` 已经把它写进 pendingWidthRef；
     * - pointercancel / 失焦 / 卸载没有坐标可用 → 只能靠 pointermove 期间记下的
     *   pendingWidthRef（可能还在 rAF 队列里，尚未落进 state）。
     * 所以这里只要 pending != 已提交值就补一次；pending 相等时是无操作。
     * 注意 activeRef 已经置 false，这不会反过来再触发一次 endResize。
     */
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (pendingWidthRef.current !== widthRef.current) {
      widthRef.current = pendingWidthRef.current;
      setWidth(pendingWidthRef.current);
    }

    // 摘监听器 + 摘 body class：**任何**结束路径都必须走到
    detachRef.current?.();
    detachRef.current = null;
    document.body.classList.remove("resizing-columns");

    // 落盘（D-22：走 persist，按 `storage` 决定写 DB 还是 localStorage）
    persist(widthRef.current);
  }, [persist]);

  /** 由指针坐标算出夹紧后的宽度 */
  const widthForX = useCallback((clientX: number) => {
    const delta = startRef.current.x - clientX;
    return clamp(startRef.current.width + delta);
  }, [clamp]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 上一次手势若没被正确释放，先收干净（否则监听器会重复注册）
    endResize();

    activeRef.current = true;
    setIsResizing(true);
    startRef.current = { x: e.clientX, width };
    pendingWidthRef.current = width;

    const handleMove = (ev: PointerEvent) => {
      const next = widthForX(ev.clientX);
      pendingWidthRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        // Resize handle is on the LEFT edge of the right sidebar:
        // drag LEFT (negative delta) → wider, drag RIGHT (positive delta) → narrower
        const w = pendingWidthRef.current;
        widthRef.current = w;
        setWidth(w);
      });
    };

    /**
     * pointerup：先按事件坐标结算最终宽度（用户拖完直接松手时，
     * 最后一次 pointermove 可能还在 rAF 队列里），再走统一的 endResize。
     */
    const handleUp = (ev: PointerEvent) => {
      if (!activeRef.current) return;
      pendingWidthRef.current = widthForX(ev.clientX);
      endResize();
    };

    document.body.classList.add("resizing-columns");
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", endResize);
    window.addEventListener("blur", endResize);

    detachRef.current = () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", endResize);
      window.removeEventListener("blur", endResize);
    };
  }, [width, widthForX, endResize]);

  /**
   * 卸载路径通过 ref 取**最新**的 endResize。
   *
   * 为什么不把 endResize 直接放进 deps：它的依赖里有 `config.storageKey`，
   * 调用方传内联 config 时每次渲染都会换身份 → 这个"卸载清理" effect 会在**每次渲染**都跑一遍
   * （实测：无关 re-render 会触发一次 endResize，把进行中的手势提前结束）。
   * 这里要的语义就是"只在卸载时收尾一次"，所以固定成 [] 依赖 + ref 取最新实现。
   */
  const endResizeRef = useRef(endResize);
  useEffect(() => {
    endResizeRef.current = endResize;
  }, [endResize]);

  // 清理：卸载时必须结束手势 —— 否则组件没了、监听器和 body class 还在
  useEffect(() => {
    return () => {
      endResizeRef.current();
    };
  }, []);

  return { width, isResizing, onResizeStart, setWidth, endResize };
}
