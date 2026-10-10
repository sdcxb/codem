/**
 * 侧栏会话的**显示排序**（GAP-LIST `O-57` 的第三件事）。
 *
 * ## 它是什么 / 它不是什么
 *
 * - **是**：一个**纯函数**（`sortSessionsForDisplay`）+ 一个设置键的读写。
 *   它只重排"这一次渲染要吃的那份数组"。
 * - **不是**：存储层的排序。`src/core/storage/session.ts::listSessions` 的
 *   `pinned DESC, sort_order ASC, last_message_at DESC` **一个字都不动** ——
 *   其中 `sort_order` 是用户拖拽的结果（B-6 的长注释写了它为什么必须参与），
 *   拖拽语义与"按名称排"是两回事，谁都不许覆盖谁。
 *   ⇒ 本模块的输出**只喂给侧栏的渲染**（`Sidebar.tsx::loadAllSessions`），
 *   不回写 `sort_order`、不改任何会话行。
 *
 * ## 为什么置顶始终排在最前（不受排序键影响）
 *
 * 置顶是**用户显式表达的分组意图**，不是一个排序键。存储层的排序（`pinned DESC`）
 * 与侧栏的分组（今天 / 更早）都把它当第一维；这里跟着同一条口径，
 * 否则「选了按名称排」会把置顶会话淹掉 —— 那是把用户的显式意图吃掉。
 *
 * ## 为什么选择要落进设置
 *
 * 它是**用户偏好**（不是"一次性结论"），用与 `codem-sidebar-width` 同一条通道
 * （`getSetting` / `setSetting`）读写；设置面未预热时 `getSetting` 返回 `null`
 * ⇒ 走默认值（不抛、不假装有值）。
 */

import { getSetting, setSetting } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";

/** 排序键：最近对话 / 名称 */
export type SessionSortKey = "recent" | "name";
/** 方向：正序（旧→新 / A→Z） / 倒序（新→旧 / Z→A） */
export type SessionSortDir = "asc" | "desc";

export interface SessionSortPref {
  key: SessionSortKey;
  dir: SessionSortDir;
}

/** 设置键（与 `codem-sidebar-width` 同一个面：`settings` 表的一行） */
export const SESSION_SORT_SETTING_KEY = "codem-session-sort";

/**
 * 默认值 = 时间倒序（与"没选过"时的既有行为**逐字一致**：
 * `listSessions` 最后一段就是 `last_message_at DESC`）。
 * 默认值必须等于旧行为，否则升级会在用户没做任何选择时改变侧栏顺序。
 */
export const DEFAULT_SESSION_SORT: SessionSortPref = { key: "recent", dir: "desc" };

/**
 * 解析存下来的选择（**宽容**：坏值/缺键一律回默认）。
 *
 * 为什么宽容而不是抛：这个键的值可能来自老版本、手改的库、或将来新增的档位。
 * 一个读不懂的偏好不该让侧栏崩掉或把所有会话排成乱序 ——
 * 但也不能"猜"（`?? default` 是唯一的兜底，不做同义转换）。
 */
export function parseSessionSort(raw: string | null | undefined): SessionSortPref {
  if (!raw) return DEFAULT_SESSION_SORT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SESSION_SORT;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_SESSION_SORT;
  const key = (parsed as { key?: unknown }).key;
  const dir = (parsed as { dir?: unknown }).dir;
  const validKey = key === "recent" || key === "name";
  const validDir = dir === "asc" || dir === "desc";
  if (!validKey || !validDir) return DEFAULT_SESSION_SORT;
  return { key, dir } as SessionSortPref;
}

/** 读当前偏好（未预热/未设置 ⇒ 默认值） */
export function readSessionSortPreference(): SessionSortPref {
  try {
    return parseSessionSort(getSetting(SESSION_SORT_SETTING_KEY));
  } catch {
    // 设置面在读的时候抛（端口异常）不该让侧栏渲染不出来：按默认值走，下次渲染再读
    return DEFAULT_SESSION_SORT;
  }
}

/** 存当前偏好（失败走**统一上报通道**，不是只写一行日志 —— 见下） */
export function writeSessionSortPreference(pref: SessionSortPref): void {
  try {
    setSetting(SESSION_SORT_SETTING_KEY, JSON.stringify(pref));
  } catch (e) {
    /*
     * 这里**不能**只 `console.warn`：那正是本仓库明令禁止的「B 类假成功」形态
     * （写类函数的 catch 里只有日志 ⇒ 用户以为选择存下了，重启后却回默认，界面上没有任何痕迹）。
     * `setSetting` 自己的契约是"失败走 `reportWriteNotAccepted`"（端口没接手时它已经报过），
     * 这个 catch 兜的是"它意外抛了" —— 同一个通道，文案要说清后果。
     */
    reportPersistFailure(
      "session.sortPreference",
      e,
      "会话排序偏好未保存（本次仍按所选顺序渲染，**重启后会回到上一次保存的选择**）",
    );
  }
}

/** 排序需要的字段（结构化，避免依赖 `Session` 的具体类型） */
export interface SortableSession {
  id?: string;
  title?: string;
  pinned?: boolean | number;
  lastMessageAt?: number;
}

/** 置顶标志（库里是 0/1，实体里是 boolean —— 两种形态都要认） */
function isPinned(s: SortableSession): boolean {
  return s.pinned === true || s.pinned === 1;
}

/**
 * 会话的显示排序（**纯函数**，不改入参、不读库、不写库）。
 *
 * 比较顺序：
 * 1. 置顶（`true` 在前）—— 与存储层 `pinned DESC` 同一口径；
 * 2. 排序键：
 *    - `recent`：`lastMessageAt`（缺省按 0，即最旧）—— `desc` = 新的在前（默认）、`asc` = 旧的在前；
 *    - `name`：`title` 用 **`localeCompare(…, { numeric: true })`**（中文按拼音、数字按数值：
 *      "对话 2" 排在 "对话 10" 前面，而不是按码点把 10 排在 2 前面）；
 * 3. **末位用 `id` 兜底**：同一个时间戳/同名会话之间的顺序必须是**确定**的，
 *    否则排序不稳定、每次渲染都可能换位置（React 复用节点时会看着像"闪"）。
 */
export function sortSessionsForDisplay<T extends SortableSession>(
  sessions: readonly T[],
  pref: SessionSortPref = DEFAULT_SESSION_SORT,
): T[] {
  const dir = pref.dir === "asc" ? 1 : -1;
  const byTie = (a: T, b: T) => String(a.id ?? "").localeCompare(String(b.id ?? ""));
  return [...sessions].sort((a, b) => {
    const pa = isPinned(a) ? 1 : 0;
    const pb = isPinned(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (pref.key === "name") {
      const cmp = String(a.title ?? "").localeCompare(String(b.title ?? ""), undefined, { numeric: true });
      if (cmp !== 0) return dir * cmp;
    } else {
      const ta = Number(a.lastMessageAt ?? 0);
      const tb = Number(b.lastMessageAt ?? 0);
      // 基准是"旧的在前"（`ta - tb`）；`dir = -1`（倒序）把它翻成"新的在前"
      if (ta !== tb) return dir * (ta - tb);
    }
    return byTie(a, b);
  });
}

/** 给界面用的一句话描述（tooltip / 可访问名；中英各一份，键顺序与菜单一致） */
export function describeSessionSort(pref: SessionSortPref): { zh: string; en: string } {
  const key = pref.key === "recent" ? { zh: "最近对话", en: "Recent" } : { zh: "名称", en: "Name" };
  const dir = pref.dir === "desc" ? { zh: "倒序", en: "Descending" } : { zh: "正序", en: "Ascending" };
  return { zh: `${key.zh} · ${dir.zh}`, en: `${key.en} · ${dir.en}` };
}
