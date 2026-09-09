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
  CustomSceneImage,
  LibrarySnapshot,
  LibraryOpsSettings,
  MonitorTab,
  SeriesPoint,
} from "./types";
import {
  DEFAULT_SETTINGS,
  SCENE_IMAGE_IDS,
  SCENE_IMAGE_ID_FALLBACK,
  STORAGE_KEY,
} from "./types";
import { collectSnapshot } from "./core/telemetry-adapter";
import {
  clampSceneAdjust,
  createSceneImageUrl,
  describeSceneImage,
  readImageDimensions,
  sceneImageAspectWarning,
  validateSceneImageDimensions,
  validateSceneImageFile,
} from "./core/scene-image";
import { CUSTOM_SCENE_KEY, deleteSceneImage, getSceneImage, putSceneImage } from "./core/scene-image-db";

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
    if (merged.sceneStyle !== "pixel" && merged.sceneStyle !== "iso") merged.sceneStyle = DEFAULT_SETTINGS.sceneStyle;
    if (!SCENE_IMAGE_IDS.includes(merged.sceneImageId)) merged.sceneImageId = SCENE_IMAGE_ID_FALLBACK;
    merged.sceneImageAdjust = clampSceneAdjust(merged.sceneImageAdjust);
    merged.showAlignGuides = merged.showAlignGuides === true;
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
  /**
   * 场景运行态（面板切走再切回时恢复，角色不必重新入场）。
   * 两套引擎各占一个槽位，避免把像素场景态喂给等距引擎（坐标系统不同）。
   * 用 unknown 承载以免 store 依赖具体场景引擎。
   */
  isoScene: unknown;
  pixelScene: unknown;
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

  /** 用户上传的场景图片（IndexedDB 里存二进制，这里只留渲染用的 objectURL + 元信息） */
  customScene: CustomSceneImage | null;
  /** 上传/读取中 */
  sceneImageBusy: boolean;
  /** 场景图片操作失败原因（可见性：不静默） */
  sceneImageError: string | null;
  /** 场景图片操作成功提示 */
  sceneImageNotice: string | null;

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
  setIsoScene: (scene: unknown) => void;
  setPixelScene: (scene: unknown) => void;
  /** 从 IndexedDB 恢复用户上传的场景图片（面板/启动时调用一次） */
  loadCustomSceneImage: () => Promise<void>;
  /** 上传并立即启用一张场景图片；返回是否成功 */
  setCustomSceneImage: (file: File) => Promise<boolean>;
  /** 删除自定义场景图片并回到内置预设 */
  clearCustomSceneImage: () => Promise<void>;
  /** 重置（测试用） */
  _reset: () => void;
}

export const useLibraryOps = create<LibraryOpsState>((set, get) => ({
  open: false,
  tab: DEFAULT_SETTINGS.defaultTab,
  settings: loadSettings(),
  snapshot: null,
  isoScene: null,
  pixelScene: null,
  series: emptySeries(),
  selectedActorId: null,
  selectedZoneId: null,
  sampling: false,
  error: null,
  samples: 0,
  customScene: null,
  sceneImageBusy: false,
  sceneImageError: null,
  sceneImageNotice: null,

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

  setIsoScene: (scene) => set({ isoScene: scene }),
  setPixelScene: (scene) => set({ pixelScene: scene }),

  loadCustomSceneImage: async () => {
    if (get().customScene || get().sceneImageBusy) return;
    set({ sceneImageBusy: true });
    try {
      const record = await getSceneImage(CUSTOM_SCENE_KEY);
      if (!record) {
        set({ sceneImageBusy: false });
        return;
      }
      const { url } = await createSceneImageUrl(record.blob);
      set({
        sceneImageBusy: false,
        customScene: {
          url,
          name: record.name,
          width: record.width,
          height: record.height,
          size: record.size,
          addedAt: record.addedAt,
        },
      });
    } catch (e) {
      // 启动时读失败不是用户操作，不弹错误（设置面板另有「不支持持久化」提示），只留日志
      console.warn("[library-ops] 读取自定义场景图片失败:", e);
      set({ sceneImageBusy: false });
    }
  },

  setCustomSceneImage: async (file) => {
    const invalid = validateSceneImageFile(file);
    if (invalid) {
      set({ sceneImageError: invalid, sceneImageNotice: null });
      return false;
    }
    set({ sceneImageBusy: true, sceneImageError: null, sceneImageNotice: null });
    try {
      const { width, height } = await readImageDimensions(file);
      const sizeError = validateSceneImageDimensions(width, height);
      if (sizeError) throw new Error(sizeError);

      const name = file.name || "场景图片";
      let persisted = true;
      let persistError = "";
      try {
        await putSceneImage({
          id: CUSTOM_SCENE_KEY,
          blob: file,
          name,
          type: file.type || "image/png",
          width,
          height,
          size: file.size,
          addedAt: Date.now(),
        });
      } catch (e) {
        // 存不下也让用户先用起来（本次会话有效），但必须明确告知重启会丢
        persisted = false;
        persistError = e instanceof Error ? e.message : String(e);
        console.warn("[library-ops] 场景图片持久化失败:", e);
      }

      const { url } = await createSceneImageUrl(file);
      const prev = get().customScene;
      if (prev) revokeUrl(prev.url);
      const image: CustomSceneImage = { url, name, width, height, size: file.size, addedAt: Date.now() };
      set({
        customScene: image,
        sceneImageBusy: false,
        sceneImageNotice: persisted ? `已启用：${describeSceneImage(image)}` : `已启用（本次会话有效）：${describeSceneImage(image)}`,
      });
      const warn = sceneImageAspectWarning(width, height);
      if (warn) set({ sceneImageError: warn });
      if (!persisted) {
        set({ sceneImageError: `图片未能保存到本地（${persistError}），重启后会恢复内置场景。` });
      }
      get().updateSettings({ sceneImageId: "custom" });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[library-ops] 上传场景图片失败:", e);
      set({ sceneImageBusy: false, sceneImageError: msg, sceneImageNotice: null });
      return false;
    }
  },

  clearCustomSceneImage: async () => {
    const prev = get().customScene;
    set({ sceneImageBusy: true, sceneImageError: null, sceneImageNotice: null });
    try {
      await deleteSceneImage(CUSTOM_SCENE_KEY);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[library-ops] 删除自定义场景图片失败:", e);
      set({ sceneImageBusy: false, sceneImageError: msg });
      return;
    }
    if (prev) revokeUrl(prev.url);
    set({ customScene: null, sceneImageBusy: false, sceneImageNotice: "已恢复内置场景" });
    if (get().settings.sceneImageId === "custom") {
      get().updateSettings({ sceneImageId: SCENE_IMAGE_ID_FALLBACK, sceneImageAdjust: { scale: 1, x: 0, y: 0 } });
    }
  },

  _reset: () =>
    set({
      open: false,
      tab: DEFAULT_SETTINGS.defaultTab,
      settings: { ...DEFAULT_SETTINGS, sceneImageAdjust: { ...DEFAULT_SETTINGS.sceneImageAdjust } },
      snapshot: null,
      isoScene: null,
      pixelScene: null,
      series: emptySeries(),
      selectedActorId: null,
      selectedZoneId: null,
      sampling: false,
      error: null,
      samples: 0,
      customScene: null,
      sceneImageBusy: false,
      sceneImageError: null,
      sceneImageNotice: null,
    }),
}));

/** 释放我们自己创建的 objectURL（dataURL / 外部 URL 不做处理） */
function revokeUrl(url: string): void {
  if (!url.startsWith("blob:")) return;
  try {
    globalThis.URL?.revokeObjectURL?.(url);
  } catch {
    /* 忽略：某些 WebView 在页面卸载后调用会抛错 */
  }
}

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
