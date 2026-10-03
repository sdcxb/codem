// @ts-nocheck
/**
 * `@codem/code-runtime-worker-thread` — 受限代码运行时（**第 103 波：改走 Rust 侧 JS 沙箱**）
 *
 * ## 原来是什么样，为什么必须改
 *
 * 它原来 `import('worker_threads')` 起一个 Node Worker，并让 Worker 里执行
 * `new Function('require', code)`。两个问题：
 *  1. **在装好的应用里跑不起来**：Tauri WebView 里没有 `worker_threads`，而 `new Function` 又被
 *     CSP 挡住（不含 `unsafe-eval`）—— 这个 provider 在真机上是**死**的；
 *  2. 它把 `new Function` 藏在 **worker 脚本字符串**里，源码扫描看不见（门禁 `audit:no-eval`
 *     只扫真代码），属于"看起来没事、其实在 eval"。
 *
 * ## 现在
 *
 * 同一段代码交给 **Rust 侧 boa 沙箱**（`js_run_sandboxed`，与 `run_code` 同一条路）：
 *  · **不暴露任何工具方法**（`methods: []`）—— 这个 provider 的语义本来就是"只跑纯计算"，
 *    比原来"给一个白名单 require"更严：guest 里连 `require` / `process` 都不存在；
 *  · 失控由 Rust 的循环迭代上限兜住；
 *  · 危险模式预检（`validateCode`）**保留**，早失败 + 给一句人话。
 *
 * 兼容性：导出名与 `provides`（`codeRuntimeWorkerThread`）保持不变，
 * `run(code, opts)` 的签名与返回值（完成值）也不变。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { validateCode } from './validate-dynamic-code.ts'

/** 这个 provider 的默认预算（纯计算脚本，给得比 run_code 紧一些） */
const DEFAULT_LOOP_LIMIT = 2_000_000

interface RustSandboxOutcome {
  ok: boolean
  value?: string | null
  error?: string | null
  stdout?: string
  stderr?: string
  budgetExceeded?: boolean
}

function tauriInvoke(): ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const api = (globalThis as any).__TAURI__
  return api?.core?.invoke ?? null
}

export const codeRuntimeWorkerThreadProvider: Plugin = (ctx: any) => {
  const s = {
    _active: true,

    /**
     * 跑一段受限代码。**没有任何工具方法**：guest 只能用语言本身的运算能力。
     * 返回完成值；出错抛异常（与旧的 Worker 实现一致，调用方靠 catch 处理）。
     */
    async run(code: string, opts: { timeout?: number } = {}) {
      // D1-1: 执行前验证代码安全性（正则预检；真正的边界是沙箱本身）
      const validation = validateCode(code)
      if (!validation.ok) {
        throw new Error(validation.error)
      }

      const invoke = tauriInvoke()
      if (!invoke) {
        throw new Error('代码运行时不可用：这个环境没有 Tauri 运行时')
      }

      const outcome = (await invoke('js_run_sandboxed', {
        code,
        methods: [],
        loopLimit: DEFAULT_LOOP_LIMIT,
        hostCallLimit: 0,
      })) as RustSandboxOutcome

      if (!outcome?.ok) {
        let message = String(outcome?.error ?? '未知错误')
        try {
          const parsed = JSON.parse(message) as { message?: string }
          if (parsed?.message) message = parsed.message
        } catch {
          /* 原样抛出 */
        }
        throw new Error(message)
      }

      // 完成值是 JSON 文本：能解开就解开（与旧实现"返回真实值"的观感一致）
      const raw = outcome.value ?? null
      if (raw === null) return undefined
      try {
        return JSON.parse(String(raw))
      } catch {
        return raw
      }
    },
  }

  const disp = ctx.provide('codeRuntimeWorkerThread', s)

  // Composite dispose
  const compositeDispose = () => {
    s._active = false
    disp()
  }
  return compositeDispose
}

// Re-export validateCode for other providers
export { validateCode as validateDynamicCode }
