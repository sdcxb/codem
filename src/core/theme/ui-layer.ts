/**
 * unslop v2 覆盖层的启用档（`data-ui`）。
 *
 * ## 为什么需要一个开关
 *
 * 这次重构要在**不改业务代码**的前提下逐批换视觉。覆盖层的每条规则都写在
 * `[data-ui="v2"]` 作用域里，所以「关掉」必须是**结构上等同于没引入**，而不是"靠人记得别开"。
 * 开关本身只有一件事：决定 `<html>` 上有没有 `data-ui="v2"`。
 *
 * ## 三个来源与优先级
 *
 * 1. `?ui=v2`（**仅 QA/验收**）：一次性生效，**不写回**任何存储 —— 否则一次验收会让整机永久停在新层；
 * 2. `localStorage["codem-ui-layer"] = "v2"`：持久档（用户在验收期手动打开，或将来做设置项）；
 * 3. 都没有 → `v1`（默认），**不写 `data-ui` 属性**，页面与引入覆盖层之前逐像素一致。
 *
 * ## 为什么不进 SQLite
 *
 * 它不是产品设置，只是一次视觉迁移的脚手架；Batch 7 会连同覆盖层一起删掉。
 * 放在 localStorage 里与 `codem-theme-cache`（首屏预测镜像）同一层，且**不参与**设置读写，
 * 因此不会触发「设置键读写对称」那类门禁。
 *
 * ## 首帧
 *
 * `main.tsx` 在 `render()` **之前**调用 `applyUiLayer()`，避免"先按 v1 画一帧再切"。
 * 本模块不 import 任何存储/DOM 之外的依赖，因此不会拖慢首屏。
 */

export type UiLayer = "v1" | "v2";

/** localStorage 键（与主题镜像键同一命名族） */
export const UI_LAYER_STORAGE_KEY = "codem-ui-layer";

/** `<html>` 上的属性名 */
export const UI_LAYER_ATTRIBUTE = "data-ui";

/** 只认字面量 "v2"；其它一切值（含 "v1"、空串、损坏数据）都回到默认档 */
function normalize(value: string | null | undefined): UiLayer {
  return value === "v2" ? "v2" : "v1";
}

export interface UiLayerSources {
  /** 存储读取器（默认 `globalThis.localStorage`）；抛错按"读不到"处理 */
  storage?: Pick<Storage, "getItem"> | null;
  /** URL query（默认 `globalThis.location.search`） */
  search?: string | null;
}

/**
 * 读当前档位。
 *
 * 注意：**只读**。`?ui=v2` 不会被写进 storage（见文件头第 1 条）。
 */
export function readUiLayer(sources: UiLayerSources = {}): UiLayer {
  const search = sources.search ?? (typeof globalThis.location !== "undefined" ? globalThis.location.search : "");
  try {
    const params = new URLSearchParams(search || "");
    if (params.get("ui") === "v2") return "v2";
  } catch {
    /* search 不合法就当没有（不影响存储档） */
  }
  const storage = sources.storage ?? safeStorage();
  if (!storage) return "v1";
  try {
    return normalize(storage.getItem(UI_LAYER_STORAGE_KEY));
  } catch {
    return "v1";
  }
}

function safeStorage(): Pick<Storage, "getItem"> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 可注入的最小根元素（`document.documentElement` 的子集），便于单测不依赖 DOM */
export interface UiLayerRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}

/**
 * 把档位写到 `<html>`。幂等：值没变时不碰 DOM。
 *
 * 默认档**移除属性**而不是写 `data-ui="v1"` —— 这样"引入覆盖层"与"未引入"的 DOM 完全一致，
 * 也让「关闭时逐像素不变」不需要额外条件。
 */
export function applyUiLayer(root?: UiLayerRoot | null, layer?: UiLayer): UiLayer {
  const target = root === undefined ? (typeof document !== "undefined" ? document.documentElement : null) : root;
  const next = layer ?? readUiLayer();
  if (!target) return next;
  if (target.getAttribute(UI_LAYER_ATTRIBUTE) === (next === "v2" ? "v2" : null)) return next;
  if (next === "v2") target.setAttribute(UI_LAYER_ATTRIBUTE, "v2");
  else target.removeAttribute(UI_LAYER_ATTRIBUTE);
  return next;
}

/** 供单测/验收脚本使用：切换持久档（写 localStorage） */
export function setStoredUiLayer(layer: UiLayer, storage?: Pick<Storage, "setItem" | "removeItem"> | null): void {
  const target = storage ?? (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null);
  if (!target) return;
  try {
    if (layer === "v2") target.setItem(UI_LAYER_STORAGE_KEY, "v2");
    else target.removeItem(UI_LAYER_STORAGE_KEY);
  } catch {
    /* 存储不可用：档位退回默认，不影响渲染 */
  }
}
