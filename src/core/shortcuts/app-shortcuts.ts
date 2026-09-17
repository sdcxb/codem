/**
 * 应用级快捷键的**单一真相源**（第 45 轮 D-14）。
 *
 * ## 为什么需要
 *
 * 审计事实：应用菜单里 5 个菜单项都印着快捷键（`Ctrl+N` / `Ctrl+,` / `Ctrl+B` / `` Ctrl+` `` /
 * macOS 的 `⌘Q`），而全仓 `metaKey|ctrlKey` 组合键 handler 只有 12 处，其中**应用级只有两处**
 * （`TitleBar` 的 Ctrl/Cmd+K、`ui-library-ops-provider` 的 Ctrl/Cmd+Shift+L）。
 * 也就是说菜单在**对用户和辅助技术撒谎**（这些字符串还会经 `aria-keyshortcuts` 播报出去，
 * `SettingsPanel` 的帮助页也重复了 `Ctrl+B`）—— 正好违反 `TitleBar` 自己写的
 * "只放真实可用的命令，不放灰掉的假项"。
 *
 * 修法不是在菜单里删掉这行字（用户确实需要这些快捷方式），而是把
 * **"标签"和"实际按键处理"绑在同一个表里**：`APP_SHORTCUTS` 既是菜单显示来源，
 * 也是 `installAppShortcuts()` 的匹配依据 —— 两边不可能再漂移。
 *
 * ## 平台差异
 *
 * - macOS 用 ⌘（`metaKey`），其它平台用 Ctrl；
 * - macOS 的 ⌘Q（退出）由**系统菜单**处理，应用层不该也不能接管 ——
 *   所以 `close` 这条在 mac 上**不显示快捷键**、也不注册处理（Windows 侧 Alt+F4 同理，
 *   由操作系统处理，也不注册）。
 */

export interface ShortcutModifiers {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutSpec {
  id: string;
  /** `KeyboardEvent.key`（小写比较） */
  key: string;
  /** 除"平台主修饰键"之外还需要按住的修饰键 */
  modifiers?: ShortcutModifiers;
  /** 菜单里显示的标签；`null` = 该平台上不显示快捷键 */
  label: string | null;
  /** `aria-keyshortcuts` 的规范写法（WAI-ARIA：`Control+B` / `Meta+B`） */
  aria: string | null;
  /**
   * 是否在可编辑控件（输入框 / textarea / contenteditable）里也生效。
   *
   * 默认 `false`：`Ctrl+B` 在输入框里是"光标左移"（macOS 上尤其如此），
   * `Ctrl+`` ` 会打断输入 —— 抢掉这些按键会毁掉正常输入。搜索（`Ctrl+K`）是例外，
   * 它本来就是"任何地方都能唤起"的动作。
   */
  allowInEditable?: boolean;
  /** 该平台上是否注册处理（mac 上 `close` 交给系统） */
  enabled?: boolean;
}

/** 当前平台是否按 macOS 处理（⌘ 而不是 Ctrl） */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const raw = platform || navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(raw);
}

/** 平台的"主修饰键"（macOS = ⌘/Meta，其它 = Ctrl/Control） */
export function primaryModifier(mac = isMacPlatform()): { ctrl: boolean; meta: boolean; symbol: string; aria: string } {
  return mac
    ? { ctrl: false, meta: true, symbol: "⌘", aria: "Meta" }
    : { ctrl: true, meta: false, symbol: "Ctrl+", aria: "Control" };
}

/**
 * 应用级快捷键表。新增一条 = 菜单里自动出现这个标签 + 按键自动生效。
 *
 * `new-chat` / `settings` / `sidebar` / `terminal` 都是"可编辑控件里不抢"的动作；
 * `search` 例外（任何地方都能唤起搜索）。
 */
export function buildAppShortcuts(mac = isMacPlatform()): ShortcutSpec[] {
  const mod = primaryModifier(mac);
  const mk = (
    id: string,
    key: string,
    displayKey: string,
    opts: Partial<ShortcutSpec> = {},
  ): ShortcutSpec => ({
    id,
    key,
    label: `${mod.symbol}${displayKey}`,
    aria: `${mod.aria}+${displayKey}`,
    ...opts,
  });

  return [
    mk("new-chat", "n", "N"),
    mk("search", "k", "K", { allowInEditable: true }),
    mk("settings", ",", ","),
    // 关闭窗口：mac 上是 ⌘Q（系统菜单处理，应用层不接管）、Windows 上是 Alt+F4（操作系统处理）
    { id: "close", key: "q", label: null, aria: null, enabled: false },
    mk("sidebar", "b", "B"),
    mk("terminal", "`", "`"),
  ];
}

/** 按 id 取一条（找不到返回 undefined） */
export function getShortcut(id: string, mac = isMacPlatform()): ShortcutSpec | undefined {
  return buildAppShortcuts(mac).find((s) => s.id === id);
}

/** 菜单/帮助页显示的标签（该平台不显示时返回 undefined） */
export function shortcutLabel(id: string, mac = isMacPlatform()): string | undefined {
  return getShortcut(id, mac)?.label ?? undefined;
}

/** `aria-keyshortcuts` 的规范写法（该平台没有时返回 undefined） */
export function shortcutAria(id: string, mac = isMacPlatform()): string | undefined {
  return getShortcut(id, mac)?.aria ?? undefined;
}

/** 事件目标是不是"可编辑控件"（在里面抢字母键会毁掉正常输入） */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName?.toUpperCase?.() ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  // 兼容 happy-dom / jsdom（isContentEditable 可能没实现）
  const attr = el.getAttribute?.("contenteditable");
  return attr === "" || attr === "true";
}

/** 一次按键是否命中某条快捷键（平台主修饰键按 mac 判定） */
export function matchesShortcut(e: KeyboardEvent, spec: ShortcutSpec, mac = isMacPlatform()): boolean {
  if (spec.enabled === false) return false;
  if (!spec.allowInEditable && isEditableTarget(e.target)) return false;

  const wantShift = !!spec.modifiers?.shift;
  const wantAlt = !!spec.modifiers?.alt;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;
  // 平台主修饰键：mac = ⌘（Meta），其它 = Ctrl。**另一个不许同时按下**，
  // 否则 Ctrl+⌘+B 之类也会误命中。
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return false;
  } else {
    if (!e.ctrlKey || e.metaKey) return false;
  }
  return (e.key || "").toLowerCase() === spec.key.toLowerCase();
}
