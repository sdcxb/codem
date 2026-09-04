/**
 * 插件皮肤兼容契约（Skin Token Contract）——插件影响 UI/UX 时的皮肤兼容机制。
 *
 * ## 皮肤矩阵（Codem 现有 4 视觉态）
 *   - default 皮肤：跟随 `data-theme`（light / dark 两态）
 *   - dream 皮肤：`[data-skin="dream"]`（梦幻皮肤，主题变量覆盖层 + 动态背景配置）
 *   - hub 皮肤：`[data-skin="hub"]`（恒暗色，不受 data-theme 影响）
 *
 * 所有皮肤由 `data-skin` + `data-theme` 属性驱动 styles.css 的**设计令牌**（Design
 * Tokens / Theme Variables）切换；样式只需消费 `var(--token)` 即可自动适配全部皮肤，
 * 无需感知具体皮肤。
 *
 * ## 契约（插件 UI 的样式来源唯一化）
 * 1. 颜色/背景/边框/文字只允许消费主题令牌：`--bg-*` `--text-*` `--border-*`
 *    `--accent*` `--text-on-accent` `--sidebar-bg` `--input-bg` `--code-bg`
 *    `--tooltip-*` `--dropdown-*` `--scrollbar-*` `--user-bg` `--assistant-bg` 等；
 * 2. 语义状态只允许语义令牌：`--success` `--warning` `--error` `--info`
 *    `--security-ask/auto/full`（及各自 hover 变体）；
 * 3. 字号/圆角/阴影/动效只允许结构令牌：`--fs-*` `--radius*` `--shadow-*`
 *    `--duration-*` `--ease-*` `--transition-*` `--z-*`；
 * 4. **禁止硬编码色值**（`#hex` / `rgb()/rgba()/hsl()/hsla()`）——唯一的例外是
 *    `var(--token, <fallback>)` 中的 fallback（容错值，皮肤切换时仍被令牌覆盖）；
 *    半透明覆盖层可用 `color-mix(in srgb, var(--token) N%, transparent)` 派生；
 * 5. 图标/动效同理：图标颜色来自 `currentColor`（继承文字令牌）或直接令牌；
 *    强调动画只使用 `--accent*`，不写死主题色。
 *
 * 消费面：内置 UI 插件（ui-* provider 包、PluginManager、插件市场 Tab 等一切影响
 * UI 的插件/面板）与将来经市场"可适配"评估的 dsh UI 插件移植时均受此约束；
 * harness 核心 packages 无 UI 插件（UI 属 dsh-desktop 宿主层），因此市场"界面"类
 * 能力在 Codem 侧由本令牌体系承接（目录动态分类，无 ui 条目时不显示空分类）。
 *
 * 本模块提供审计函数（源码级静态检查，测试 `skin-compat-plugin.test.ts` 使用），
 * 把契约变成可执行校验。
 */

/** 主题令牌前缀（颜色/背景/边框/文字等随皮肤切换的令牌） */
export const THEME_TOKEN_PREFIX = '--'

/** 语义状态令牌（插件 UI 状态表达必须使用，禁止自造色值） */
export const SEMANTIC_TOKENS = [
  '--success', '--success-hover', '--warning', '--error', '--error-hover', '--info',
  '--security-ask', '--security-auto', '--security-full',
] as const

/** 核心主题令牌（契约文档用；新增主题令牌时在此登记，SC-3 校验其存在于 styles.css） */
export const CORE_SKIN_TOKENS = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover',
  '--text-primary', '--text-secondary', '--text-muted',
  '--border-primary', '--border-secondary',
  '--accent', '--accent-hover', '--accent-muted', '--text-on-accent',
  '--success', '--warning', '--error', '--info',
  '--user-bg', '--assistant-bg', '--system-bg', '--code-bg',
  '--sidebar-bg', '--input-bg',
  '--scrollbar-track', '--scrollbar-thumb',
  '--tooltip-bg', '--tooltip-text', '--tooltip-border',
  '--dropdown-bg', '--dropdown-hover',
] as const

/** 结构令牌（字号/圆角/阴影/动效，不随皮肤切换但受同一设计体系约束） */
export const STRUCTURAL_TOKENS = [
  '--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl', '--fs-3xl',
  '--radius-sm', '--radius', '--radius-md', '--radius-lg', '--radius-full',
  '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-popover',
] as const

/** 颜色字面量正则（hex / rgb(a) / hsl(a)） */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(\s*[^)]*\)/g

/**
 * 剥离 `var(--token[, fallback])` 表达式后再扫描颜色字面量：
 * fallback（如 `var(--accent, #7c6cf0)`）是契约允许的唯一硬编码例外，
 * 其余裸露色值一律判违规。
 * @param source - CSS 文本或 JSX/TSX inline style 源码
 * @returns 违规色值列表（空 = 合规）；附带行号（按 \n 切分）
 */
export function findHardcodedColors(source: string): Array<{ color: string; line: number }> {
  const violations: Array<{ color: string; line: number }> = []
  const lines = source.split('\n')
  lines.forEach((raw, idx) => {
    // 逐行剥掉 var(...) 再匹配（var 内 fallback 放行）
    const stripped = raw.replace(/var\(\s*--[\w-]+\s*(?:,\s*[^)]*)?\)/g, '')
    for (const m of stripped.matchAll(COLOR_LITERAL)) {
      violations.push({ color: m[0], line: idx + 1 })
    }
  })
  return violations
}

/**
 * 校验插件 UI 源码是否合规（无硬编码色值）。
 * @returns 违规列表；空数组表示通过
 */
export function auditPluginStyle(source: string): Array<{ color: string; line: number }> {
  return findHardcodedColors(source)
}
