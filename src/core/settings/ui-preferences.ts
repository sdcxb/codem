/**
 * 界面偏好的「恢复默认」——第 45 轮 D-11 的实现侧。
 *
 * ## 为什么单独一个模块
 *
 * 审计坐实的现状：全项目**不存在**任何"恢复默认设置"的实现，而崩溃恢复卡上那颗
 * "重置界面设置"按钮（`src/components/AppErrorBoundary.tsx:155-168`）只清 localStorage 里
 * `codem-*` 开头的键，文案却承诺"将清除本地界面设置（**关闭行为**、窗口状态等偏好）"
 * —— 关闭行为（`codem-close-behavior`）、字号、字体、语言、主题的**权威副本全在 DB 的
 * settings 表里**（localStorage 里只有 `codem-window-state` / `codem-theme-cache` /
 * pane 宽度等镜像），所以那颗按钮什么偏好都没重置。
 *
 * 这里给出**真正做这件事**的实现：删 DB 里的界面偏好键（回到各自的默认档）+ 清 localStorage
 * 镜像 + 把 `codem-settings` 里的界面字段复位。放在独立模块是因为两侧都要用它
 * （设置页的"恢复默认界面设置"按钮、以及崩溃恢复卡），而 `settings.ts` 是存储层最底层
 * —— 让它反向 import `ui-font.ts`（字号默认值的唯一来源）会形成循环。
 *
 * ## 边界（刻意不做的）
 *
 * - **不碰安全策略**（`codem-security-mode`、自定义权限规则）：那是策略不是界面偏好，
 *   悄悄放宽或收紧都会改变 AI 的执行权限；
 * - **不碰身份/用户配置**（`codem-identity` / `codem-user` / `codem-app-identity`）：
 *   那是用户填的内容，不是"偏好"；
 * - **不碰 API Key / provider 配置 / 模型选择**：只复位 `codem-settings` 里的界面字段；
 * - **不碰会话、项目、消息、MCP、插件等数据**；
 * - **不碰另一些"界面偏好"**：它们存在 localStorage 且键名不是 `codem-*`
 *   （`usePaneResize` 的面板宽度、`codem:disabled-plugins` 插件开关、输入历史…）。
 *   那是 D-22（同类偏好两种介质）要处理的事，不属于本次复位的承诺
 *   —— 所以设置页上的按钮文案**逐项列出**会复位的字段，不写"清空所有设置"这种大话。
 */

import { getSetting, getSettingJSON, removeSetting, setSettingJSON } from "../storage/settings";
import { FONT_BASE_PX } from "../ui-font";
import { DEFAULT_LANG } from "../i18n/lang";

/** `codem-settings` 里的界面字段（复位时只改这两个，其余原样保留） */
const SETTINGS_KEY = "codem-settings";

/**
 * 界面偏好的 DB 键（删掉即回到默认档 —— 每个键的读取方都自带默认值）。
 *
 * 逐条说明为什么删掉 = 恢复默认：
 * - `codem-theme` → `resolveEffectiveTheme` 回落默认档（`theme-default.ts`）；
 * - `skin-id` / `dream-config` → `ThemeManager.init()` 回落 `default` 皮肤与默认梦幻配置；
 * - `codem-language` → `getLang()` 回落 `DEFAULT_LANG`；
 * - `codem-font-size`（旧扁平键）/`codem-font-family`/`codem-font-weight` → 回落到基准 13px、
 *   默认字体栈（`--font-ui` 令牌）、400 字重；
 * - `codem-close-behavior` → 读取处 `|| "ask"`（每次询问）；
 * - `codem-display-mode` → store 的 `displayMode: "unified"`；
 * - `codem-sidebar-width` → Sidebar 的 260 兜底。
 */
export const UI_PREFERENCE_KEYS: readonly string[] = [
  "codem-theme",
  "skin-id",
  "dream-config",
  "codem-language",
  "codem-font-size",
  "codem-font-family",
  "codem-font-weight",
  "codem-close-behavior",
  "codem-display-mode",
  "codem-sidebar-width",
];

/**
 * 界面偏好的 localStorage 镜像键。
 *
 * - `codem-window-state`：窗口尺寸/位置（`useWindowState`，下一次 resize 会重新写入）；
 * - `codem-theme-cache`：首屏主题预测镜像（下一次 `applyThemeAttribute` 会重新写入）。
 */
export const UI_PREFERENCE_LOCAL_KEYS: readonly string[] = ["codem-window-state", "codem-theme-cache"];

export interface UiPreferencesResetResult {
  /** 确实存在过、并被删掉的 DB 键 */
  removedKeys: string[];
  /** 被复位的 `codem-settings` 字段（形如 `codem-settings.fontSize`） */
  patchedFields: string[];
  /** 被清掉的 localStorage 镜像键 */
  clearedLocalKeys: string[];
  /** 删除/复位失败的项（如实返回，绝不静默当成成功） */
  failed: string[];
}

/** 读出并删除一个键；返回"它原本是否存在"（`removeSetting` 幂等，不能拿它判断有没有值） */
function removeIfPresent(key: string): boolean {
  const had = getSetting(key) !== null;
  removeSetting(key);
  return had;
}

/**
 * 把界面偏好恢复为默认值。**同步**执行（读内存镜像 + 入写队列），
 * 落库确认交给调用方走 `flushSettingsWrites()`。
 */
export function resetUiPreferencesToDefaults(): UiPreferencesResetResult {
  const removedKeys: string[] = [];
  const patchedFields: string[] = [];
  const clearedLocalKeys: string[] = [];
  const failed: string[] = [];

  for (const key of UI_PREFERENCE_KEYS) {
    try {
      if (removeIfPresent(key)) removedKeys.push(key);
    } catch {
      failed.push(key);
    }
  }

  // `codem-settings`：只复位界面字段，其余（mode/model/providers/dynamic…）原样保留
  try {
    const current = getSettingJSON<Record<string, unknown> | null>(SETTINGS_KEY, null);
    if (current && typeof current === "object") {
      setSettingJSON(SETTINGS_KEY, {
        ...current,
        fontSize: FONT_BASE_PX,
        language: DEFAULT_LANG,
      });
      patchedFields.push(`${SETTINGS_KEY}.fontSize`, `${SETTINGS_KEY}.language`);
    }
  } catch {
    failed.push(`${SETTINGS_KEY}.fontSize`);
  }

  try {
    if (typeof localStorage !== "undefined") {
      for (const key of UI_PREFERENCE_LOCAL_KEYS) {
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          clearedLocalKeys.push(key);
        }
      }
    }
  } catch {
    failed.push("localStorage");
  }

  return { removedKeys, patchedFields, clearedLocalKeys, failed };
}
