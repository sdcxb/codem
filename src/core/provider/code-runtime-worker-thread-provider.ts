// @ts-nocheck
/**
 * @codem/code-runtime-worker-thread — Worker 线程代码运行时，隔离线程内执行代码
 *
 * D1-1 修复: 提取 dynamic-runner-provider 的 validateCode() 为公共工具，
 * 在 Worker 执行前进行 AST 验证，阻止危险 API 调用。
 *
 * 参考 DSH packages/core/code-runtime/src/worker.ts:
 *   Worker 内使用受限 require 白名单 + 超时自动终止
 */
import type { Plugin } from '../cordis/src/index.ts'

/** D1-1: 公共代码验证函数 — 从 dynamic-runner-provider 提取 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; msg: string }> = [
  { pattern: /require\s*\(\s*['"]child_process['"]\)/, msg: 'child_process not allowed' },
  { pattern: /require\s*\(\s*['"]fs['"]\)/, msg: 'fs not allowed — use ctx.fs' },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/, msg: 'fs not allowed — use ctx.fs' },
  { pattern: /process\.exit/, msg: 'process.exit not allowed' },
  { pattern: /eval\s*\(/, msg: 'eval() not allowed' },
  { pattern: /require\s*\(\s*['"]net['"]\)/, msg: 'net not allowed' },
  { pattern: /require\s*\(\s*['"]http['"]\)/, msg: 'http not allowed — use ctx.webFetch' },
  { pattern: /require\s*\(\s*['"]https['"]\)/, msg: 'https not allowed — use ctx.webFetch' },
  { pattern: /require\s*\(\s*['"]dns['"]\)/, msg: 'dns not allowed' },
  { pattern: /require\s*\(\s*['"]os['"]\)/, msg: 'os not allowed' },
  { pattern: /require\s*\(\s*['"]cluster['"]\)/, msg: 'cluster not allowed' },
]

export function validateCode(code: string): { ok: boolean; error?: string } {
  for (const { pattern, msg } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return { ok: false, error: `Security violation: ${msg}` }
    }
  }
  return { ok: true }
}

/** DSH 参考: Worker 超时保护 */
const DEFAULT_TIMEOUT_MS = 30000

export const codeRuntimeWorkerThreadProvider: Plugin = (ctx: any) => {
  const s = {
    _active: true,

    async run(code: string, opts: { timeout?: number } = {}) {
      // D1-1: 执行前验证代码安全性
      const validation = validateCode(code)
      if (!validation.ok) {
        throw new Error(validation.error)
      }

      const { Worker } = await import('worker_threads')
      const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS

      return new Promise((resolve, reject) => {
        // DSH 参考: 受限 Worker 脚本 — 白名单 require
        const script = `
          const { parentPort, workerData } = require('worker_threads');
          // 受限 require 白名单
          const _require = (mod) => {
            const allowed = ['worker_threads'];
            if (!allowed.includes(mod)) throw new Error('Module not allowed: ' + mod);
            return require(mod);
          };
          parentPort.on('message', async (m) => {
            try {
              // 使用 Function 构造器而非 eval，限制作用域
              const fn = new Function('require', m.code);
              const r = await fn(_require);
              parentPort.postMessage({ result: r });
            } catch(e) {
              parentPort.postMessage({ error: e.message });
            }
          });
        `

        let w: any
        let timer: any

        try {
          w = new Worker(script, { eval: true })

          // DSH 参考: 超时自动终止
          timer = setTimeout(() => {
            if (w) {
              w.terminate()
              reject(new Error(`Code execution timed out after ${timeoutMs}ms`))
            }
          }, timeoutMs)

          w.postMessage({ code })
          w.on('message', (r: any) => {
            clearTimeout(timer)
            if (r.error) reject(new Error(r.error))
            else resolve(r.result)
            w.terminate()
          })
          w.on('error', (e: any) => {
            clearTimeout(timer)
            reject(e)
            if (w) w.terminate()
          })
        } catch (e) {
          clearTimeout(timer)
          if (w) w.terminate()
          reject(e)
        }
      })
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
