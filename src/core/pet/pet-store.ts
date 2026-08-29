/**
 * PetStore — 宠物运行时状态管理。
 *
 * 使用 Zustand 管理宠物的运行时状态，
 * 将 Codem Agent 的生命周期事件映射到宠物动画状态。
 *
 * 宠物显示在独立的 Tauri 透明窗口中（PetWindowApp），
 * 主窗口通过 Tauri 事件同步状态到宠物窗口。
 *
 * 状态映射策略：
 * - llm_status: "idle"            → pet state: "idle"（或 sleeping 如果超时）
 * - llm_status: "connecting"      → pet state: "thinking"
 * - llm_status: "streaming"       → pet state: "thinking"
 * - llm_status: "executing_tools" → pet state: "working"
 * - tool_start                    → pet state: "working" + 工具气泡
 * - tool_complete (文件修改)       → pet state: "review" → 1.5s 后回 "idle"
 * - tool_complete (其他)           → pet state: "thinking"
 * - end event (success)           → pet state: "happy" → 2s 后回 "idle"
 * - end event (有文件变更)         → pet state: "waving" → 2s 后回 "idle"（由 App.tsx 触发）
 * - error / tool_error            → pet state: "sad" + 错误详情气泡 → 2s 后回 "idle"
 * - compaction_start              → pet state: "waiting" + 压缩气泡（由 App.tsx 触发）
 * - idle 超时 (>60s)              → pet state: "sleeping"
 *
 * 基于 Petdex (MIT License) 开源项目集成并改造，适配 Codem 的 Agent 事件模型。
 * @see THIRD_PARTY_NOTICES.md — Petdex (MIT License) 集成声明
 */

import { create } from "zustand";
import type { PetState, InstalledPet, PetSettings, PetDefinition } from "./pet-types";
import { DEFAULT_PET_SETTINGS } from "./pet-types";
import { getPetSettings, savePetSettings, listInstalledPets, loadSpritesheetAsDataUrl, getInstalledPet } from "./pet-manager";
import { getSettingJSON } from "../storage/settings";
import type { UserConfig } from "../types";

// ========== Tauri 事件辅助 ==========

/** 向宠物窗口发送状态更新 */
function emitToPetWindow(data: {
  definition: PetDefinition | null;
  spritesheetUrl: string | null;
  petState: PetState;
  scale: number;
  opacity: number;
  /** 已安装宠物列表（slug + name），用于右键菜单切换样式 */
  installedPets?: { slug: string; name: string }[];
  /** 当前激活宠物的 slug */
  activeSlug?: string | null;
}) {
  const tauri = (window as any).__TAURI__;
  if (!tauri?.event?.emit) return;

  // 对 spritesheetUrl 做 lazy 发送：只有变化时才发
  // （data URL 可能很大，避免每次 petState 变化都重发）
  tauri.event.emit("pet-state-update", data).catch((e: any) => {
    console.warn("[PetStore] Failed to emit to pet window:", e);
  });
}

/** 仅发送轻量状态（不含 definition/spritesheetUrl） */
function emitPetStateLight(petState: PetState, scale: number, opacity: number) {
  const tauri = (window as any).__TAURI__;
  if (!tauri?.event?.emit) return;
  tauri.event.emit("pet-state-update", { petState, scale, opacity }).catch(() => {});
}

/** 请求宠物窗口关闭 */
function emitPetClose() {
  const tauri = (window as any).__TAURI__;
  if (!tauri?.event?.emit) return;
  tauri.event.emit("pet-close", {}).catch(() => {});
}

/** 向宠物窗口发送悬浮气泡通知（底层 IPC，不经过队列） */
function emitPetBubble(text: string, duration: number = 4000) {
  const tauri = (window as any).__TAURI__;
  if (!tauri?.event?.emit) return;
  tauri.event.emit("pet-bubble", { text, duration }).catch(() => {});
}

// ========== 气泡节流队列（P1-6）==========

type BubblePriority = "low" | "normal" | "high";

interface BubbleQueueItem {
  text: string;
  duration: number;
  priority: BubblePriority;
  timestamp: number;
}

/** 相同文本去重窗口（ms） */
const BUBBLE_DEDUP_WINDOW = 3000;
/** 两个气泡之间的最小间隔（ms） */
const BUBBLE_MIN_INTERVAL = 1200;

let bubbleQueue: BubbleQueueItem[] = [];
let lastBubbleText = "";
let lastBubbleTime = 0;
let bubbleDispatchTimer: ReturnType<typeof setTimeout> | null = null;

const PRIORITY_ORDER: Record<BubblePriority, number> = { high: 0, normal: 1, low: 2 };

/** 实际发送气泡到宠物窗口 */
function dispatchBubble(text: string, duration: number) {
  lastBubbleText = text;
  lastBubbleTime = Date.now();
  emitPetBubble(text, duration);
}

/** 调度队列中下一个气泡 */
function scheduleNextBubble() {
  if (bubbleQueue.length === 0) {
    bubbleDispatchTimer = null;
    return;
  }

  const now = Date.now();
  const elapsed = now - lastBubbleTime;
  const wait = Math.max(0, BUBBLE_MIN_INTERVAL - elapsed);

  bubbleDispatchTimer = setTimeout(() => {
    // 按优先级排序，同优先级按时间排序
    bubbleQueue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      }
      return a.timestamp - b.timestamp;
    });

    const item = bubbleQueue.shift()!;
    dispatchBubble(item.text, item.duration);

    if (bubbleQueue.length > 0) {
      scheduleNextBubble();
    } else {
      bubbleDispatchTimer = null;
    }
  }, wait);
}

/** 入队气泡（高优先级直接发送，低/正常优先级排队+去重） */
function enqueueBubble(text: string, duration: number = 4000, priority: BubblePriority = "normal") {
  const now = Date.now();

  // 高优先级：清空队列并立即发送
  if (priority === "high") {
    bubbleQueue = [];
    if (bubbleDispatchTimer) {
      clearTimeout(bubbleDispatchTimer);
      bubbleDispatchTimer = null;
    }
    dispatchBubble(text, duration);
    return;
  }

  // 去重：相同文本在去重窗口内跳过
  if (text === lastBubbleText && now - lastBubbleTime < BUBBLE_DEDUP_WINDOW) {
    return;
  }

  // 入队
  bubbleQueue.push({ text, duration, priority, timestamp: now });

  if (!bubbleDispatchTimer) {
    scheduleNextBubble();
  }
}

// ========== 格式化辅助 ==========

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function truncatePath(path: string, maxLen: number = 50): string {
  if (path.length <= maxLen) return path;
  const parts = path.split(/[/\\]/);
  if (parts.length <= 2) return "…" + path.slice(-(maxLen - 1));
  const fileName = parts[parts.length - 1];
  const firstDir = parts[0];
  const result = `${firstDir}/…/${fileName}`;
  return result.length <= maxLen ? result : "…" + fileName;
}

const TOOL_NAME_MAP: Record<string, string> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  str_replace: "替换内容",
  bash: "执行命令",
  glob: "搜索文件",
  grep: "搜索内容",
  list: "列出目录",
  web_fetch: "获取网页",
  web_search: "搜索网络",
};

function formatToolName(name: string): string {
  return TOOL_NAME_MAP[name] || name;
}

/** 读取用户称呼（设置中「想让我怎么叫你」） */
function getUserCallBy(): string {
  try {
    const user = getSettingJSON<UserConfig | null>("codem-user", null);
    return user?.callBy || user?.name || "";
  } catch {
    return "";
  }
}

// ========== Types ==========

interface PetStoreState {
  /** 是否启用宠物 */
  enabled: boolean;
  /** 当前激活的宠物 */
  activePet: InstalledPet | null;
  /** 精灵图 Data URL */
  spritesheetUrl: string | null;
  /** 当前宠物状态 */
  petState: PetState;
  /** 所有已安装的宠物 */
  installedPets: InstalledPet[];
  /** 是否正在加载 */
  loading: boolean;
  /** 上次活动时间戳（用于 sleeping 检测） */
  lastActivityAt: number;
  /** 位置 */
  positionX: number;
  positionY: number;
  /** 缩放 */
  scale: number;
  /** 透明度 */
  opacity: number;

  // Actions
  init: () => Promise<void>;
  setActivePet: (slug: string | null) => Promise<void>;
  refreshInstalledPets: () => Promise<void>;
  setPetState: (state: PetState) => void;
  onLLMStatus: (status: "idle" | "connecting" | "streaming" | "executing_tools") => void;
  onStreamEvent: (event: { type: string; [key: string]: any }) => void;
  setPosition: (x: number, y: number) => void;
  setScale: (scale: number) => void;
  setOpacity: (opacity: number) => void;
  setEnabled: (enabled: boolean) => void;
  /** 显示悬浮气泡通知（自动拼接用户称呼） */
  showBubble: (message: string, duration?: number) => void;
  /** 显示原始气泡通知（不拼接称呼） */
  showRawBubble: (text: string, duration?: number) => void;
}

// ========== 辅助函数 ==========

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let happyTimer: ReturnType<typeof setTimeout> | null = null;

/** 清除 idle 超时定时器 */
function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** 设置 idle 超时 → sleeping */
function scheduleIdleToSleeping(timeout: number) {
  clearIdleTimer();
  if (timeout <= 0) return;
  idleTimer = setTimeout(() => {
    const current = usePetStore.getState();
    if (current.petState === "idle") {
      current.setPetState("sleeping");
    }
  }, timeout);
}

/** 向宠物窗口发送完整状态 */
function sendFullStateToPet() {
  const s = usePetStore.getState();
  if (!s.enabled || !s.activePet) return;
  emitToPetWindow({
    definition: s.activePet.definition,
    spritesheetUrl: s.spritesheetUrl,
    petState: s.petState,
    scale: s.scale,
    opacity: s.opacity,
    installedPets: s.installedPets.map(p => ({ slug: p.slug, name: p.definition.name })),
    activeSlug: s.activePet.slug,
  });
}

// ========== Store ==========

export const usePetStore = create<PetStoreState>((set, get) => ({
  enabled: false,
  activePet: null,
  spritesheetUrl: null,
  petState: "idle",
  installedPets: [],
  loading: false,
  lastActivityAt: Date.now(),
  positionX: DEFAULT_PET_SETTINGS.positionX,
  positionY: DEFAULT_PET_SETTINGS.positionY,
  scale: DEFAULT_PET_SETTINGS.scale,
  opacity: DEFAULT_PET_SETTINGS.opacity,

  init: async () => {
    const settings = getPetSettings();
    set({
      enabled: settings.enabled,
      positionX: settings.positionX,
      positionY: settings.positionY,
      scale: settings.scale,
      opacity: settings.opacity,
      loading: true,
    });

    // 加载已安装宠物列表
    const pets = await listInstalledPets();
    set({ installedPets: pets, loading: false });

    // 如果有激活的宠物，加载它
    if (settings.activePetSlug) {
      await get().setActivePet(settings.activePetSlug);
    }

    // 如果设置中已启用，创建宠物窗口
    if (settings.enabled && settings.activePetSlug) {
      const { invoke } = (window as any).__TAURI__?.core || {};
      if (invoke) {
        try {
          await invoke("create_pet_window");
          // 等待宠物窗口就绪后发送状态
          const tauri = (window as any).__TAURI__;
          if (tauri?.event?.listen) {
            const unlisten = await tauri.event.listen("pet-window-ready", () => {
              sendFullStateToPet();
              unlisten();
            });
            // 也设一个超时保底，万一 ready 事件错过了
            setTimeout(() => sendFullStateToPet(), 1500);
          }
        } catch (e) {
          console.warn("[PetStore] Failed to create pet window:", e);
        }
      }
    }

    // 监听宠物窗口发来的"关闭宠物"请求
    const tauri = (window as any).__TAURI__;
    if (tauri?.event?.listen) {
      tauri.event.listen("pet-disable-request", () => {
        get().setEnabled(false);
      });
      // 监听切换宠物样式请求（来自独立窗口右键菜单）
      tauri.event.listen("pet-switch-request", (e: any) => {
        const slug = typeof e.payload === "string" ? e.payload : e.payload?.slug;
        if (slug) {
          get().setActivePet(slug);
        }
      });
    }

    // 启动 idle 超时检测
    scheduleIdleToSleeping(settings.idleTimeout);
  },

  setActivePet: async (slug) => {
    if (!slug) {
      set({ activePet: null, spritesheetUrl: null });
      savePetSettings({ activePetSlug: null });
      // 通知宠物窗口清空
      emitToPetWindow({
        definition: null,
        spritesheetUrl: null,
        petState: "idle",
        scale: get().scale,
        opacity: get().opacity,
        installedPets: get().installedPets.map(p => ({ slug: p.slug, name: p.definition.name })),
        activeSlug: null,
      });
      return;
    }

    const pet = await getInstalledPet(slug);
    if (!pet) {
      console.warn(`[PetStore] Pet not found: ${slug}`);
      return;
    }

    const dataUrl = await loadSpritesheetAsDataUrl(pet);
    set({ activePet: pet, spritesheetUrl: dataUrl, petState: "idle" });
    savePetSettings({ activePetSlug: slug });

    // 发送完整状态到宠物窗口
    sendFullStateToPet();
  },

  refreshInstalledPets: async () => {
    const pets = await listInstalledPets();
    set({ installedPets: pets });
  },

  setPetState: (state) => {
    set({ petState: state, lastActivityAt: Date.now() });

    // 发送轻量状态到宠物窗口
    emitPetStateLight(state, get().scale, get().opacity);

    // 非 idle 状态清除 sleeping 定时器
    if (state !== "idle" && state !== "sleeping") {
      clearIdleTimer();
    }

    // happy/sad/waving/review 状态自动回到 idle
    if (happyTimer) {
      clearTimeout(happyTimer);
      happyTimer = null;
    }
    if (state === "happy" || state === "sad" || state === "waving" || state === "review") {
      const timeout = state === "review" ? 1500 : 2000;
      happyTimer = setTimeout(() => {
        const current = get().petState;
        if (current === "happy" || current === "sad" || current === "waving" || current === "review") {
          set({ petState: "idle" });
          emitPetStateLight("idle", get().scale, get().opacity);
          const settings = getPetSettings();
          scheduleIdleToSleeping(settings.idleTimeout);
        }
      }, timeout);
    }

    // 回到 idle 时重新启动 sleeping 定时器
    if (state === "idle") {
      const settings = getPetSettings();
      scheduleIdleToSleeping(settings.idleTimeout);
    }
  },

  onLLMStatus: (status) => {
    const state = get();
    if (!state.enabled || !state.activePet) return;

    // happy/sad/waving 状态期间不响应状态变化
    if (state.petState === "happy" || state.petState === "sad" || state.petState === "waving") return;

    switch (status) {
      case "idle":
        break;
      case "connecting":
      case "streaming":
        state.setPetState("thinking");
        break;
      case "executing_tools":
        state.setPetState("working");
        break;
    }
  },

  onStreamEvent: (event) => {
    const state = get();
    if (!state.enabled || !state.activePet) return;

    switch (event.type) {
      case "end": {
        const result = (event as any).result;
        const isError = result && (result.type === "error" || result.type === "overflow");
        if (isError) {
          state.setPetState("sad");
          // P1-7: 错误详情气泡
          const errMsg = result?.message || result?.error || "任务出错了";
          enqueueBubble(`出错了：${truncateText(errMsg, 80)}`, 5000, "high");
        } else if (state.petState !== "sad") {
          state.setPetState("happy");
        }
        break;
      }
      case "error": {
        state.setPetState("sad");
        // P1-7: 错误详情气泡
        const errMsg = (event as any).error || "未知错误";
        enqueueBubble(`出错了：${truncateText(errMsg, 80)}`, 5000, "high");
        break;
      }
      case "tool_error": {
        state.setPetState("sad");
        // P1-7: 工具错误详情气泡
        const tc = (event as any).toolCall;
        const errMsg = (event as any).error || "工具执行失败";
        const toolName = tc?.name ? formatToolName(tc.name) : "工具";
        enqueueBubble(`${toolName}失败：${truncateText(errMsg, 60)}`, 4000, "high");
        break;
      }
      case "start":
      case "text_delta":
      case "reasoning_delta": {
        // 可被覆盖的状态：idle, sleeping, waiting, review
        const overridable = ["idle", "sleeping", "waiting", "review"];
        if (overridable.includes(state.petState)) {
          state.setPetState("thinking");
        }
        break;
      }
      case "tool_start": {
        state.setPetState("working");
        // P0-1: 工具执行气泡
        const tc = (event as any).toolCall;
        if (tc) {
          const toolName = formatToolName(tc.name);
          const filePath = tc.input?.path || tc.input?.name;
          if (filePath) {
            enqueueBubble(`${toolName}：${truncatePath(filePath)}`, 3000, "low");
          } else {
            enqueueBubble(`${toolName}…`, 3000, "low");
          }
        }
        break;
      }
      case "tool_complete": {
        const tc = (event as any).toolCall;
        // P0-5: 文件修改类工具完成后，短暂切到 review 状态
        if (tc && (tc.name === "write" || tc.name === "edit" || tc.name === "str_replace")) {
          state.setPetState("review");
        } else if (state.petState === "working") {
          state.setPetState("thinking");
        }
        break;
      }
    }
  },

  setPosition: (x, y) => {
    set({ positionX: x, positionY: y });
    savePetSettings({ positionX: x, positionY: y });
  },

  setScale: (scale) => {
    set({ scale });
    savePetSettings({ scale });
    // 通知宠物窗口
    emitPetStateLight(get().petState, scale, get().opacity);
  },

  setOpacity: (opacity) => {
    set({ opacity });
    savePetSettings({ opacity });
    emitPetStateLight(get().petState, get().scale, opacity);
  },

  setEnabled: (enabled) => {
    set({ enabled });
    savePetSettings({ enabled });

    const { invoke } = (window as any).__TAURI__?.core || {};

    if (enabled) {
      const settings = getPetSettings();
      scheduleIdleToSleeping(settings.idleTimeout);

      // 创建宠物窗口
      if (invoke) {
        invoke("create_pet_window").then(async () => {
          // 等待宠物窗口就绪后发送完整状态
          const tauri = (window as any).__TAURI__;
          if (tauri?.event?.listen) {
            const unlisten = await tauri.event.listen("pet-window-ready", () => {
              sendFullStateToPet();
              unlisten();
            });
          }
          // 超时保底
          setTimeout(() => sendFullStateToPet(), 1500);
        }).catch((e: any) => {
          console.warn("[PetStore] Failed to create pet window:", e);
        });
      }
    } else {
      clearIdleTimer();
      // 关闭宠物窗口 — 只通过 Rust 端命令关闭，避免双路径竞态
      // (close_pet_window 调用 window.close()，Rust 端对 pet 窗口不再 prevent_close)
      if (invoke) {
        invoke("close_pet_window").catch(() => {});
      } else {
        // Fallback: 通过事件通知宠物窗口前端自行关闭
        emitPetClose();
      }
    }
  },

  showBubble: (message, duration = 4000) => {
    if (!get().enabled) return;
    const callBy = getUserCallBy();
    const text = callBy ? `${callBy}，${message}` : message;
    enqueueBubble(text, duration, "normal");
  },

  showRawBubble: (text, duration = 4000) => {
    if (!get().enabled) return;
    enqueueBubble(text, duration, "normal");
  },
}));
