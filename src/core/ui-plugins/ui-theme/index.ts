// @ts-nocheck
/**
 * @codem/ui-theme — 主题 UI 插件包
 *
 * 主题管理 + CSS 变量注入。
 */
import { ThemeManager } from '../../theme/index.ts'

export function apply(ctx: any) {
  const themeMgr = new ThemeManager()

  // 注入默认主题 CSS 变量
  const root = document.documentElement
  root.style.setProperty('--codem-bg-primary', '#1e1e2e')
  root.style.setProperty('--codem-bg-secondary', '#181825')
  root.style.setProperty('--codem-bg-tertiary', '#11111b')
  root.style.setProperty('--codem-text-primary', '#cdd6f4')
  root.style.setProperty('--codem-text-secondary', '#a6adc8')
  root.style.setProperty('--codem-accent', '#89b4fa')
  root.style.setProperty('--codem-accent-hover', '#b4befe')

  console.log('[ui-theme] Default theme applied')
}
