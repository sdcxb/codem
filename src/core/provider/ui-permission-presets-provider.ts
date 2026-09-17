// @ts-nocheck
/**
 * @codem/ui-permission-presets — 权限预设 UI 插件
 *
 * 注册 `PermissionPresetSelector` 组件到 Slot，并把**真实**的安全模式系统暴露成
 * `ctx.uiPermissionPresets` 服务。关闭此 Provider 后，Slot 中的组件被移除，
 * SlotBridge 回退到 fallback。
 *
 * ## 第 45 轮（功能上下文审计 P1-2 / P3）：这里原来有**另一套不生效的权限预设**
 *
 * 旧实现自带一份"严格 / 标准 / 宽松"的预设表与一套规则
 * （`autoApproveRead` / `autoApproveWrite` / `autoApproveShell` / `autoApproveWeb` /
 * `requireConfirmationForDelete` / `blockedPaths`），并暴露 `shouldAutoApprove()` /
 * `isPathBlocked()` / `registerPreset()` / `selectPreset()`。问题有两层：
 *
 * 1. **没有消费者**：上面的规则与判定在全仓**零读取者** —— 真正管权限的是
 *    `security-mode.ts`（`ask | auto | full`）→ `agentic-loop` / ToolPipeline 那条链，
 *    以及本地 `PermissionEvaluator` 的规则。而同一模块注册出来的可见组件
 *    `PermissionPresetSelector` **也只读 `security-mode.ts`**，与这套服务毫无关系。
 * 2. **于是它是个谎言**：`selectPreset('permissive')` 只改了一个本地字段（应用的安全姿态
 *    一点没变），而 `isPathBlocked('**')` 在"严格"下会**声称**一切都拦住了 ——
 *    实际上一条都没拦。用户据它做安全判断会得到与事实相反的结论。
 *
 * 现在的做法：**这个服务只做一件事 —— 当真实安全模式系统的一层视图**。
 * - `listPresets` / `getPreset` / `getCurrentPreset` → `SECURITY_MODES`（`ask|auto|full`，
 *   与设置页、`App.tsx`、委派会话读的是同一份）；
 * - `selectPreset(id)` → `setGlobalSecurityMode`（非法 id **显式抛错**）；
 * - `subscribe(listener)` → 订阅真实变更事件 `codem-security-mode-changed`；
 * - **删掉** `shouldAutoApprove` / `isPathBlocked` / `registerPreset`：
 *   假执行、假拦截、假注册都比"没有这个方法"更糟（调用方会以为它在生效）。
 *   要真的问权限，用 `ctx.permissions.check(tool, args)`（第 45 轮已修成真实实现）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { PermissionPresetSelector } from '../../components/PermissionPresetSelector'
import {
  SECURITY_MODES,
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  type SecurityMode,
} from '../permission/security-mode.ts'

/** 合法的安全模式（真系统词表；旧词表 strict/normal/permissive 不再存在） */
const VALID_MODES: readonly SecurityMode[] = SECURITY_MODES.map((m) => m.mode)

/**
 * 安全模式 → 旧"预设"形状的视图。
 *
 * `level` 只是给旧调用方的一个粗粒度档位（真系统的词表里没有这个概念），
 * 语义映射：full → permissive、auto → normal、ask → strict。
 */
function modeToPreset(mode: SecurityMode) {
  const info = SECURITY_MODES.find((m) => m.mode === mode)
  return {
    id: mode,
    name: info?.label_zh || info?.label_en || mode,
    description: info?.desc_zh || info?.desc_en || '',
    icon: info?.icon,
    level: mode === 'full' ? 'permissive' : mode === 'auto' ? 'normal' : 'strict',
  }
}

export const uiPermissionPresetsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const listeners = new Set<(preset: string) => void>()

    /**
     * 真实变更的转发：`security-mode.ts` 在切换全局模式时会派发
     * `codem-security-mode-changed`（设置页、App、输入区都是这么同步的）。
     * 订阅它 = 订阅**真实发生的事**，而不是"有人调了 selectPreset"。
     */
    const onChanged = (e: Event) => {
      const mode = (e as CustomEvent)?.detail?.mode
      if (typeof mode !== 'string') return
      for (const l of listeners) {
        try {
          l(mode)
        } catch (err) {
          console.warn('[uiPermissionPresets] listener failed', err)
        }
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('codem-security-mode-changed', onChanged)
    }

    const dispose = ctx.provide('uiPermissionPresets', {
      /** 列出**真实**的安全模式（不再是那套不生效的"严格/标准/宽松"） */
      listPresets: () => SECURITY_MODES.map((m) => modeToPreset(m.mode)),
      getPreset: (id: string) => (VALID_MODES.includes(id as SecurityMode) ? modeToPreset(id as SecurityMode) : undefined),
      getCurrentPreset: () => modeToPreset(getGlobalSecurityMode()),

      /**
       * 切换全局安全模式。
       *
       * ⚠️ 这**真的会改变应用的权限姿态**（与设置页那个下拉是同一个开关）。
       * 非法 id 显式抛错 —— 静默忽略会让调用方以为切过去了。
       */
      selectPreset: (id: string) => {
        if (!VALID_MODES.includes(id as SecurityMode)) {
          throw new Error(`未知的权限预设 ${id}（合法值：${VALID_MODES.join(' | ')}）`)
        }
        setGlobalSecurityMode(id as SecurityMode)
      },

      subscribe: (listener: (preset: string) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    })

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.permission-preset-selector', id: 'r8-permissionpreset', priority: 5 }, PermissionPresetSelector)

    // 使用 slots.inject 声明消费依赖：conversation.composer.bar 存在时注册
    const injectUnreg = slots.inject('conversation.composer.bar', () =>
      slots.register({ name: 'conversation.composer.bar', id: 'r8-permissionpreset-sub', priority: 5 }, PermissionPresetSelector)
    )

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('codem-security-mode-changed', onChanged)
      }
      listeners.clear()
      if (dispose) dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
