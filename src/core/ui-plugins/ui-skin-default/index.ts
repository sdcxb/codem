// @ts-nocheck
/**
 * @codem/skin-default — 默认皮肤插件
 *
 * 注入 CSS 变量定义默认配色方案。
 * 可独立加载/卸载/热替换 — 第三方可替换为自定义皮肤。
 */
export function applySkinDefault() {
  const root = document.documentElement

  const defaultVars = {
    '--codem-bg-primary': '#1e1e2e',
    '--codem-bg-secondary': '#181825',
    '--codem-bg-tertiary': '#11111b',
    '--codem-text-primary': '#cdd6f4',
    '--codem-text-secondary': '#a6adc8',
    '--codem-accent': '#89b4fa',
    '--codem-accent-hover': '#b4befe',
    '--codem-success': '#a6e3a1',
    '--codem-warning': '#f9e2af',
    '--codem-error': '#f38ba8',
    '--codem-border': '#313244',
  }

  for (const [k, v] of Object.entries(defaultVars)) {
    root.style.setProperty(k, v)
  }
  console.log('[skin-default] Default skin applied')
}

export function apply() {
  applySkinDefault()
}
