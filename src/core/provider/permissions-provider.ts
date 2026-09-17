// @ts-nocheck
/**
 * Permissions Provider 插件 — 把**真实**的安全策略系统接入 `ctx.permissions`。
 *
 * ## 第 45 轮（功能上下文审计 P4）：这个服务原来是个**说谎的 API**
 *
 * 原实现的三处硬伤（文件里带 `// @ts-nocheck`，所以 TypeScript 一处都没报）：
 *
 * | 暴露的方法 | 原实现 | 真实 `PermissionManager` 上 |
 * | --- | --- | --- |
 * | `check(tool, args, mode)` | `manager.checkPermission(...)` | **不存在这个方法** → 调用即 `TypeError` |
 * | `setMode(name)` | `manager.setSecurityMode(name)` | **不存在** → 调用即 `TypeError` |
 * | `getActiveMode()` | `manager.getActiveSecurityMode()` | **不存在** → 调用即 `TypeError` |
 * | `listModes()` | `getSecurityModes()`（`permission.ts:289`） | 第三套词表 `ask/auto-approve/strict`，与真系统（`ask/auto/full`，见 `security-mode.ts`）**不是一套** |
 * | `registerMode(name, cfg)` | 往本地数组 push | 真系统**没有**可注册模式这回事 → 收下了、什么也不生效 |
 *
 * 也就是说：任何插件按这里的文档调 `ctx.permissions.check(...)` 都会**当场抛异常**；
 * 而 `setMode("full")` 之类的调用既不会抛"不支持"，也不会真的切换模式 —— 它抛的是
 * `TypeError`（一个连"这条命令不支持"都表达不出来的错误）。
 *
 * ## 现在的做法：**只暴露真实能力**，一个假方法都不留
 *
 * 全部委托给 `security-mode.ts`（那才是全应用真正在用的那套：`App.tsx` 读它、
 * 委派会话按 cwd 重解析、UI 预设走 `setGlobalSecurityMode`）：
 * - `check` → 本地权限评估器 `PermissionEvaluator.evaluate` + `evaluateWithSecurityMode`
 *   （与 ToolPipeline 的真实判定同源，返回 `allow|ask|deny`，**不抛**）；
 * - `listModes` / `getMode` → 真实词表 `SECURITY_MODES`（`ask|auto|full`）；
 * - `setMode` / `getActiveMode` → `setGlobalSecurityMode` / `getGlobalSecurityMode`
 *   （非法模式**显式抛错**，而不是默默忽略 —— 静默忽略会让"我设过了"变成假记忆）；
 * - `registerMode` **删掉**：真系统不支持注册自定义模式，留一个收了参数却什么都不做的方法
 *   比没有这个方法更糟（调用方会以为注册成功了）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  evaluateWithSecurityMode,
  SECURITY_MODES,
  type SecurityMode,
} from '../permission/security-mode.ts'
import { getPermissionManager } from '../permission/permission.ts'

/** 合法的安全模式（真系统的词表，不是 `permission.ts::getSecurityModes` 那套历史词表） */
const VALID_MODES: readonly SecurityMode[] = SECURITY_MODES.map((m) => m.mode)

export const permissionsProvider: Plugin = (ctx: any) => {
  const manager = getPermissionManager()

  const dispose = ctx.provide('permissions', {
    _active: true,

    /**
     * 检查一次工具调用在当前（或指定）安全模式下会被如何处置。
     *
     * 返回 `{ action, allowed, reason? }`：
     * - `action` 是真实判定（`allow|ask|deny`），`allowed` 是给"只想问能不能过"的调用方的简写
     *   （**只有 `allow` 才算通过** —— `ask` 不是通过，它是在等用户）。
     *
     * 判据与 ToolPipeline 同源：先问本地评估器（用户手工规则 / 平台规则），
     * 再让安全模式层裁决（`full` 直接放行、`auto` 只放行安全操作、`ask` 保持评估器结论）。
     */
    check(toolName: string, args: any, mode?: string): { action: 'allow' | 'ask' | 'deny'; allowed: boolean; reason?: string } {
      const resource =
        typeof args?.path === 'string'
          ? args.path
          : typeof args?.command === 'string'
            ? args.command
            : undefined
      const effective = (mode && VALID_MODES.includes(mode as SecurityMode)
        ? (mode as SecurityMode)
        : getGlobalSecurityMode()) as SecurityMode

      let normal: 'allow' | 'deny' | 'ask' = 'ask'
      try {
        normal = manager.getEvaluator().evaluate(toolName, resource)
      } catch (e) {
        // 评估器自身出错 → 按"要问"处理（fail-closed，而不是静默放行）
        return { action: 'ask', allowed: false, reason: `权限评估失败：${e instanceof Error ? e.message : String(e)}` }
      }

      const action = evaluateWithSecurityMode(effective, toolName, resource, normal)
      return {
        action,
        allowed: action === 'allow',
        reason: action === 'allow' ? undefined : `安全模式 ${effective} 下需要确认或拒绝`,
      }
    },

    /** 列出**真实**的安全模式（词表与全应用一致：# 第 45 轮起不再是第三套词表） */
    listModes(): Array<{ name: string; description: string; riskLevel: string; icon?: string }> {
      return SECURITY_MODES.map((m) => ({
        name: m.mode,
        description: m.desc_zh || m.desc_en,
        // 真系统的词表没有 riskLevel；按语义映射（完全访问=高、替我审批=中、请求批准=低）
        riskLevel: m.mode === 'full' ? 'high' : m.mode === 'auto' ? 'medium' : 'low',
        icon: m.icon,
      }))
    },

    getMode(name: string): any {
      const found = SECURITY_MODES.find((m) => m.mode === name)
      if (!found) return undefined
      return { name: found.mode, description: found.desc_zh || found.desc_en, icon: found.icon }
    },

    /**
     * 切换**全局**安全模式（与设置页的预设、`App.tsx` 的读取同源）。
     *
     * 非法模式**抛错**：静默忽略会让调用方以为切换成功了（"我设过了"变成假记忆）。
     */
    setMode(name: string): boolean {
      if (!VALID_MODES.includes(name as SecurityMode)) {
        throw new Error(
          `未知的安全模式 ${name}（合法值：${VALID_MODES.join(' | ')}）`,
        )
      }
      setGlobalSecurityMode(name as SecurityMode)
      return true
    },

    getActiveMode(): string {
      return getGlobalSecurityMode()
    },
  })

  // Composite dispose — stop underlying manager to eliminate double-track
  const compositeDispose = () => {
    if (manager.dispose) manager.dispose()
    dispose()
  }
  return compositeDispose
}
