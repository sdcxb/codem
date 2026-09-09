/**
 * Library Ops 插件状态 —— zustand store（插件私有，不进入宿主 store）。
 *
 * 职责：
 * 1. 面板开关 / 当前页签 / 选中角色与区域（UI 状态）
 * 2. 采样调度：面板打开时按 `settings.refreshMs` 拉取快照
 * 3. 时间序列环形缓冲：为监控面板的迷你折线图提供历史（token / 成本 / 工具 / 角色）
 * 4. 设置持久化：localStorage `codem-library-ops`（与宿主其它键同前缀，互不干扰）
 *
 * 关闭面板即停止采样 —— 插件关闭时宿主零额外开销。
 */

import { create } from "zustand";
import type {
  LibrarySnapshot,
  LibraryOpsSettings,
  MonitorTab,
  SceneState,
  SeriesPoint,
} from "./types";
import { DEFAULT_SETTINGS, STORAGE_KEY } from "./types";
import { createSceneState } from "./core/scene-engine";
import { collectSnapshot } from "./core/telemetry-adapter";

/** 时间序列最大长度（约 3 分钟 @1.5s） */
export const SERIES_CAP = 120;

/** 单次采样超时（防止一次挂住的采样把 sampling 永久锁死） */
export const SAMPLE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface SeriesBundle {
  tokens: SeriesPoint[];
  cost: SeriesPoint[];
  tools: SeriesPoint[];
  actors: SeriesPoint[];
  tasks: SeriesPoint[];
  health: SeriesPoint[];
}

function emptySeries(): SeriesBundle {
  return { tokens: [], cost: [], tools: [], actors: [], tasks: [], health: [] };
}

function pushSeries(list: SeriesPoint[], point: SeriesPoint): SeriesPoint[] {
  const last = list[list.length - 1];
  if (last && last.at === point.at && last.value === point.value) return list;
  const next = [...list, point];
  return next.length > SERIES_CAP ? next.slice(next.length - SERIES_CAP) : next;
}

/** 读取持久化设置（损坏时回退默认值，不抛错） */
export function loadSettings(): LibraryOpsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LibraryOpsSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // 边界收敛（防御非法持久化值）
    merged.refreshMs = clamp(Number(merged.refreshMs) || DEFAULT_SETTINGS.refreshMs, 500, 30_000);
    merged.speed = clamp(Number(merged.speed) || 1, 0.25, 4);
    merged.maxActors = Math.round(clamp(Number(merged.maxActors) || DEFAULT_SETTINGS.maxActors, 4, 64));
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function persistSettings(settings: LibraryOpsSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("[library-ops] settings persist failed:", e);
  }
}

interface LibraryOpsState {
  /** 面板是否打开 */
  open: boolean;
  /** 当前页签 */
  tab: MonitorTab;
  /** 设置 */
  settings: LibraryOpsSettings;
  /** 最新快照 */
  snapshot: LibrarySnapshot | null;
  /** 场景运行态 */
  scene: SceneState;
  /** 时间序列 */
  series: SeriesBundle;
  /** 选中角色（点击角色/列表项） */
  selectedActorId: string | null;
  /** 选中区域 */
  selectedZoneId: string | null;
  /** 是否正在采样 */
  sampling: boolean;
  /** 最近一次采样错误（可见性：不静默） */
  error: string | null;
  /** 已采样次数 */
  samples: number;

  openPanel: (tab?: MonitorTab) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setTab: (tab: MonitorTab) => void;
  updateSettings: (patch: Partial<LibraryOpsSettings>) => void;
  selectActor: (id: string | null) => void;
  selectZone: (id: string | null) => void;
  /** 立即采样一次 */
  refresh: () => Promise<void>;
  /** 推进场景（由场景组件的 rAF 调用） */
  setScene: (scene: SceneState) => void;
  /** 重置（测试用） */
  _reset: () => void;
}

export const useLibraryOps = create<LibraryOpsState>((set, get) => ({
  open: false,
  tab: DEFAULT_SETTINGS.defaultTab,
  settings: loadSettings(),
  snapshot: null,
  scene: createSceneState(),
  series: emptySeries(),
  selectedActorId: null,
  selectedZoneId: null,
  sampling: false,
  error: null,
  samples: 0,

  openPanel: (tab) => {
    const s = get();
    set({ open: true, tab: tab ?? s.tab });
    void s.refresh();
  },

  closePanel: () => set({ open: false, selectedActorId: null, selectedZoneId: null }),

  togglePanel: () => {
    if (get().open) get().closePanel();
    else get().openPanel();
  },

  setTab: (tab) => set({ tab }),

  updateSettings: (patch) => {
    const next = { ...get().settings, ...patch };
    persistSettings(next);
    set({ settings: next });
  },

  selectActor: (id) => set({ selectedActorId: id }),
  selectZone: (id) => set({ selectedZoneId: id }),

  refresh: async () => {
    if (get().sampling) return;
    set({ sampling: true });
    try {
      const snapshot = await withTimeout(collectSnapshot(), SAMPLE_TIMEOUT_MS, "采集宿主数据");
      const prevSeries = get().series;
      const m = snapshot.metrics;
      set({
        snapshot,
        sampling: false,
        error: null,
        samples: get().samples + 1,
        series: {
          tokens: pushSeries(prevSeries.tokens, { at: snapshot.at, value: m.tokensIn + m.tokensOut }),
          cost: pushSeries(prevSeries.cost, { at: snapshot.at, value: m.costTotal }),
          tools: pushSeries(prevSeries.tools, { at: snapshot.at, value: m.toolCalls }),
          actors: pushSeries(prevSeries.actors, { at: snapshot.at, value: m.actorsWorking }),
          tasks: pushSeries(prevSeries.tasks, { at: snapshot.at, value: m.tasksDone }),
          health: pushSeries(prevSeries.health, { at: snapshot.at, value: m.health }),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[library-ops] sample failed:", e);
      set({ sampling: false, error: msg });
    }
  },

  setScene: (scene) => set({ scene }),

  _reset: () =>
    set({
      open: false,
      tab: DEFAULT_SETTINGS.defaultTab,
      settings: { ...DEFAULT_SETTINGS },
      snapshot: null,
      scene: createSceneState(),
      series: emptySeries(),
      selectedActorId: null,
      selectedZoneId: null,
      sampling: false,
      error: null,
      samples: 0,
    }),
}));

/** 从快照里取演员（按严重度与活跃度排序，供列表/场景共用） */
export function sortedActors(snapshot: LibrarySnapshot | null) {
  if (!snapshot) return [];
  const weight: Record<string, number> = { bad: 0, wait: 1, active: 2, ok: 3, off: 4 };
  return [...snapshot.actors].sort((a, b) => {
    const wa = weight[a.activity === "error" ? "bad" : a.activity === "blocked" ? "wait" : a.activity === "idle" || a.activity === "sleeping" ? "off" : "active"] ?? 5;
    const wb = weight[b.activity === "error" ? "bad" : b.activity === "blocked" ? "wait" : b.activity === "idle" || b.activity === "sleeping" ? "off" : "active"] ?? 5;
    if (wa !== wb) return wa - wb;
    return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
  });
}
