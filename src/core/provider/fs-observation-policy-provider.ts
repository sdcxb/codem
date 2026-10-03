// @ts-nocheck
/**
 * @codem/fs-observation-policy —— **文件观察策略**：读后写 + 版本比对（第 95 波补齐）。
 *
 * ## 这个文件以前名不副实（交接单 §3.5）
 *
 * 全文 16 行，只提供"文件监听的防抖/忽略规则"，**没有任何写入前置条件** ——
 * 但它的模块名与 service 名（`fsObservationPolicy`）会让人以为已经有保护了。
 * 而 DSH 的同名插件（`.deepseek-harness-ref/packages/fs/fs-observation-policy`）做的是：
 * `editIntent` 抛 `FS_NOT_OBSERVED`、`writeIntent` 走 `createIfAbsent` / `replaceIfVersion`。
 *
 * 现在这个 provider 把**真判定**暴露出来（状态机在 `src/core/llm/fs-observation.ts`，
 * 与 `read` / `edit` / `write` 工具用的是同一份观察）：
 *
 * | service 方法 | 用途 |
 * | --- | --- |
 * | `observe(sessionId, path, kind, version)` | 记一次观察（`read` 成功/失败、写盘成功后都会调） |
 * | `getObservation(sessionId, path)` | 取观察（`undefined` = 没观察过） |
 * | `editIntent(path, currentVersion, sessionId)` | `edit` / `multi_edit` 的前置判定 |
 * | `writeIntent(path, currentVersion, sessionId)` | `write`（覆盖）的前置判定 |
 * | `forget(sessionId)` | 丢掉一个会话的观察 |
 *
 * 防抖/忽略那部分配置保留（文件监听仍在用）。`@ts-nocheck` 保留：这个 provider 走 Cordis 的
 * 宽松 service 形状（`ctx.provide` 的 `this` 语义），与仓库里其它 provider 同形。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  FsObservationPolicy,
  decideEditIntent,
  decideWriteIntent,
  getFsObservationPolicy,
} from '../llm/fs-observation.js'

export const fsObservationPolicyProvider: Plugin = (ctx: any) => {
  /** 进程级共享的观察状态机（与工具同一份，否则"读过"这条信息只在一半链路上） */
  const policy: FsObservationPolicy = getFsObservationPolicy()

  const s = {
    // ── 文件监听的老配置（保留） ──
    policies: new Map(),
    default: { ignoreDotFiles: true, ignorePatterns: ['node_modules', '.git', 'dist'], debounceMs: 100, maxWatchers: 50 },
    set(p, pol) { this.policies.set(p, { ...this.default, ...pol }) },
    get(p) { return this.policies.get(p || '') || this.default },
    shouldIgnore(fp, pp) { const pol = this.get(pp); if (pol.ignoreDotFiles && fp.startsWith('.')) return true; return pol.ignorePatterns?.some((x) => fp.includes(x)) || false },
    getDebounce(pp) { return this.get(pp).debounceMs || 100 },

    // ── 观察策略（第 95 波：以前完全没有） ──
    /** 记一次观察。`kind` 是 `"present"` / `"absent"`（**"没观察过"不要传**，那是 `undefined`） */
    observe(sessionId, path, kind, version = null) { policy.observe(sessionId, path, kind, version) },
    /** 取某个会话对某个路径的观察（`undefined` = 没观察过） */
    getObservation(sessionId, path) { return policy.get(sessionId, path) },
    /** `edit` / `multi_edit` 的前置判定（`{ ok: true }` 或 `{ ok: false, code, message }`） */
    editIntent(path, currentVersion, sessionId) {
      return decideEditIntent(path, policy.get(sessionId, path), currentVersion)
    },
    /** `write`（覆盖）的前置判定 */
    writeIntent(path, currentVersion, sessionId) {
      return decideWriteIntent(path, policy.get(sessionId, path), currentVersion)
    },
    /** 丢掉一个会话的全部观察 */
    forget(sessionId) { policy.forget(sessionId) },
    /** 当前记了多少个会话（诊断） */
    get trackedSessions() { return policy.trackedSessions },
  }
  return ctx.provide('fsObservationPolicy', s)
}
