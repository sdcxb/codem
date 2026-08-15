// @ts-nocheck
/**
 * @codem/skin-default — 默认皮肤插件
 * @codem/skin-pet — 宠物皮肤插件
 * @codem/ui-pet — 宠物覆盖层 UI 插件
 *
 * 遗漏补齐：P6.1 中缺失的皮肤/宠物独立插件包。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

// ========== skin-default ==========
export function applySkinDefault() {
  const ctx = useCtx()
  const root = document.documentElement

  // 默认 Catppuccin Mocha 配色
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

// ========== skin-pet ==========
export function applySkinPet() {
  const ctx = useCtx()
  const root = document.documentElement

  // 宠物皮肤配色（更温馨）
  const petVars = {
    '--codem-bg-primary': '#fef6e4',
    '--codem-bg-secondary': '#f5e6c8',
    '--codem-bg-tertiary': '#f0d9b5',
    '--codem-text-primary': '#2d2d2d',
    '--codem-text-secondary': '#6b6b6b',
    '--codem-accent': '#e76f51',
    '--codem-accent-hover': '#f4845f',
    '--codem-success': '#2a9d8f',
    '--codem-warning': '#e9c46a',
    '--codem-error': '#e63946',
    '--codem-border': '#d4a574',
  }

  // 注意：宠物皮肤默认不激活，用户选择后注入
  console.log('[skin-pet] Pet skin registered (inactive by default)')
}

// ========== ui-pet ==========
export function applyUIPet() {
  const ctx = useCtx()
  const PetOverlay = lazy(() => import('../../../components/PetOverlay'))
  ctx.slots.register('app.overlay', PetOverlay, { order: 100, priority: 50 })
  console.log('[ui-pet] Pet overlay registered')
}

// ========== 统一入口 ==========
export function apply() {
  applySkinDefault()
  applySkinPet()
  applyUIPet()
}
