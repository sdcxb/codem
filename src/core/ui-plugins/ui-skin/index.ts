// @ts-nocheck
/**
 * @codem/skin-default — 默认皮肤插件
 * @codem/skin-pet — 宠物皮肤插件
 * @codem/ui-pet — 宠物覆盖层 UI 插件
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

// ========== skin-default ==========
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

// ========== skin-pet ==========
export function applySkinPet() {
  console.log('[skin-pet] Pet skin registered (inactive by default)')
}

// ========== ui-pet ==========
export function applyUIPet() {
  const ctx = useCtx()
  const PetOverlay = lazy(() => import('../../../components/PetOverlay'))
  ctx.slots.register({ name: 'app.overlay', id: 'pet-overlay-skin', order: 100, priority: 50 }, PetOverlay)
  console.log('[ui-pet] Pet overlay registered')
}

// ========== 统一入口 ==========
export function apply() {
  applySkinDefault()
  applySkinPet()
  applyUIPet()
}
