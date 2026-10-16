/**
 * UI 插件禁用门控 —— 「插件管理器禁用 = 不装配 provider」的判定。
 *
 * 独立成模块（而不是写在 ui-plugins/index.ts 里）的原因：
 * `ui-plugins/index.ts` 会 import 全部 UI 插件包（含 shiki / mermaid 等重依赖），
 * 测试与其它模块不应为了一段纯逻辑把它整包拉进来。
 */

/** 插件短名 → 插件 id（仅登记需要「禁用 = 不装配」的 UI 插件） */
export const GATED_PROVIDERS: Record<string, string> = {
  "ui-pet": "@codem/ui-pet",
  "ui-library-ops": "@codem/ui-library-ops",
  /**
   * 2026-10-16 补：`@codem/ui-game` 是**默认关闭**的开关插件（游戏界面由 `App.tsx` 直接渲染，
   * 显隐读 `codem-disabled-plugins`）。登记在这里是为了让"禁用 = 不装配"这条语义对它也成立
   * —— 与 ui-pet / ui-library-ops 同一形态；它的 `apply` 是空操作，所以装配与否都不改变界面行为。
   */
  "ui-game": "@codem/ui-game",
};

/** 该 UI 插件是否被插件管理器禁用（禁用则不装配 provider） */
export function isUiProviderGated(name: string, disabledPlugins: readonly string[]): boolean {
  const gateId = GATED_PROVIDERS[name];
  return Boolean(gateId && disabledPlugins.includes(gateId));
}

/** 从 localStorage 读取禁用列表（损坏 / 不可用时返回空数组，不抛错） */
export function readDisabledPlugins(): string[] {
  try {
    const raw = localStorage.getItem("codem:disabled-plugins");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
