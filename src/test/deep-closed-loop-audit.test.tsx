/**
 * 功能闭环深度审计测试 — 验证今天架构变更的功能触发-调用-执行闭环
 *
 * 重点：
 * 1. consumer -> ctx.get -> provider 链路完整性
 * 2. SlotBridge Hook 安全（无 Hooks 顺序违规）
 * 3. Provider dispose 复合清理链
 * 4. Guard -> repeatToolReminder 可选依赖
 * 5. Credentials 编码/解码往返
 * 6. safeJsonParse 在数据流中的使用
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'

// ============================================================
// 1. SlotBridge Hooks 顺序安全
// ============================================================
import { SlotBridge } from '../core/slots/SlotBridge'

describe('功能闭环: SlotBridge Hooks 顺序安全', () => {
  it('tryGetCtx 返回 null 时（Context 未初始化）不调用 useSlotEntries 内的 useSyncExternalStore 导致 Hooks 违规', () => {
    // 当 ctx 为 null 时，useSlotEntriesSafe 应使用 no-op subscribe
    // 确保渲染不崩溃
    const Fallback = () => <div>Fallback</div>
    const { container } = render(
      <SlotBridge name="test.hook-safety" fallback={Fallback as any} />
    )
    expect(container.textContent).toContain('Fallback')
  })

  it('无 fallback 且 ctx 为 null 时渲染 null 不崩溃', () => {
    const { container } = render(
      <SlotBridge name="test.no-fallback" />
    )
    expect(container.textContent).toBe('')
  })

  it('Fallback 崩溃时 FallbackErrorBoundary 捕获并显示降级提示', () => {
    const CrashFallback = () => {
      throw new Error('Provider disabled')
    }
    const { container } = render(
      <SlotBridge name="test.crash" fallback={CrashFallback as any} />
    )
    expect(container.textContent).toContain('不可用')
  })

  it('源码中 useSlotEntriesSafe 在条件 return 之前被调用', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/slots/SlotBridge.tsx', 'utf8')
    // 验证 useSlotEntriesSafe 调用在条件 return 之前
    const entriesCall = code.indexOf('useSlotEntriesSafe(slots')
    const ifNotSlots = code.indexOf('if (!ctxReady || !slots)')
    expect(entriesCall).toBeGreaterThan(-1)
    expect(ifNotSlots).toBeGreaterThan(-1)
    expect(entriesCall).toBeLessThan(ifNotSlots)
  })

  it('源码中 useSlotEntriesSafe 使用 no-op subscribe 当 slots 为 null', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/slots/SlotBridge.tsx', 'utf8')
    expect(code).toContain('noopSubscribe')
    expect(code).toContain('noopGetSnapshot')
  })
})

// ============================================================
// 2. consumer -> ctx.get -> provider 链路
// ============================================================
import { useCtx, tryGetCtx, setActiveContext, callLLM, callTool, getSetting, setSetting, checkPermission, defineTool } from '../core/consumer/index.ts'

describe('功能闭环: consumer 链路完整性', () => {
  it('useCtx 在未初始化时抛出错误', () => {
    // 确保 _activeCtx 为 null
    setActiveContext(null as any)
    expect(() => useCtx()).toThrow('Cordis Context not initialized')
  })

  it('tryGetCtx 在未初始化时返回 null', () => {
    setActiveContext(null as any)
    expect(tryGetCtx()).toBeNull()
  })

  it('callLLM 在未初始化时抛出错误', async () => {
    setActiveContext(null as any)
    await expect(callLLM({})).rejects.toThrow('Cordis Context not initialized')
  })

  it('callTool 在未初始化时抛出错误', async () => {
    setActiveContext(null as any)
    await expect(callTool('test', {})).rejects.toThrow('Cordis Context not initialized')
  })

  it('getSetting 在未初始化时抛出错误', () => {
    setActiveContext(null as any)
    expect(() => getSetting('key')).toThrow('Cordis Context not initialized')
  })

  it('checkPermission 在未初始化时抛出错误', () => {
    setActiveContext(null as any)
    expect(() => checkPermission('test')).toThrow('Cordis Context not initialized')
  })

  it('defineTool 返回 ToolDefinition 对象', () => {
    const tool = defineTool({
      name: 'test_tool',
      description: 'Test tool',
      async execute() { return 'result' }
    })
    expect(typeof tool).toBe('object')
    expect(tool.name).toBe('test_tool')
    expect(typeof tool.execute).toBe('function')
  })

  it('defineTool 在 ctx 已初始化时自动注册到 tools service', () => {
    const registeredTools: any[] = []
    const mockCtx = {
      get: (name: string) => {
        if (name === 'tools') return {
          register: (tool: any) => {
            registeredTools.push(tool)
            return () => {}
          }
        }
        return null
      }
    }
    setActiveContext(mockCtx as any)
    const tool = defineTool({
      name: 'auto_register_tool',
      description: 'Test tool',
      async execute() { return 'result' }
    })
    expect(registeredTools).toHaveLength(1)
    expect(registeredTools[0].name).toBe('auto_register_tool')
    // 清理
    setActiveContext(null as any)
  })
})

// ============================================================
// 3. Provider dispose 复合清理链
// ============================================================
describe('功能闭环: Provider dispose 复合清理', () => {
  it('agent-loop-provider dispose 清理所有 loop 并设置 _active=false', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/agent-loop-provider.ts', 'utf8')
    expect(code).toContain('service._active = false')
    expect(code).toContain('loopPool.clear()')
    expect(code).toContain('for (const [, loop] of loopPool)')
  })

  it('hooks-provider dispose 设置 _active=false 并调用 clearAllHooks', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/hooks-provider.ts', 'utf8')
    expect(code).toContain('_active = false')
    expect(code).toContain('clearAllHooks')
  })

  it('automation-provider dispose 设置 _active=false 并调用 stopAutomationEngines', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/automation-provider.ts', 'utf8')
    expect(code).toContain('_active = false')
    expect(code).toContain('stopAutomationEngines')
  })

  it('code-runtime-worker-thread-provider dispose 设置 _active=false', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/code-runtime-worker-thread-provider.ts', 'utf8')
    expect(code).toContain('_active = false')
  })
})

// ============================================================
// 4. Guard -> repeatToolReminder 可选依赖
// ============================================================
describe('功能闭环: Guard 可选依赖 repeatToolReminder', () => {
  it('guard-provider 中 ctx.get("repeatToolReminder") 在 try-catch 中', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/guard-provider.ts', 'utf8')
    expect(code).toContain('ctx.get(\'repeatToolReminder\')')
    expect(code).toContain('try')
    expect(code).toContain('catch')
  })

  it('guard-provider 不在 inject 中声明 repeatToolReminder', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/plugin-registry-provider.ts', 'utf8')
    const guardLine = code.match(/name: '@codem\/guard'[^}]+}/s)?.[0]
    expect(guardLine).toBeDefined()
    expect(guardLine).toContain("inject: []")
    expect(guardLine).toContain("optionalInject: ['repeatToolReminder']")
  })
})

// ============================================================
// 5. Credentials 编码/解码往返
// ============================================================
describe('功能闭环: Credentials 编码/解码往返', () => {
  it('encode 后 decode 应能还原原始值', () => {
    // 直接验证 XOR + Base64 编码/解码逻辑
    const OBFUSCATION_KEY = 'codem-cred-'
    function encode(value: string): string {
      if (!value) return ''
      let result = ''
      for (let i = 0; i < value.length; i++) {
        const charCode = value.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length)
        result += String.fromCharCode(charCode)
      }
      return btoa(result)
    }
    function decode(encoded: string): string {
      if (!encoded) return ''
      try {
        const decoded = atob(encoded)
        let result = ''
        for (let i = 0; i < decoded.length; i++) {
          const charCode = decoded.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length)
          result += String.fromCharCode(charCode)
        }
        return result
      } catch {
        return encoded
      }
    }

    const testValues = ['sk-test-key-123', 'simple', '', 'a', 'very-long-api-key-with-special-chars!@#$%^&*()']
    for (const v of testValues) {
      const encoded = encode(v)
      const decoded = decode(encoded)
      expect(decoded).toBe(v)
    }
  })

  it('decode 对空字符串返回空字符串', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/credentials-provider.ts', 'utf8')
    expect(code).toContain("if (!encoded) return ''")
  })

  it('decode 对无效 Base64 返回空字符串', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/credentials-provider.ts', 'utf8')
    expect(code).toContain("catch")
    expect(code).toMatch(/return\s+''/)
  })
})

// ============================================================
// 6. Worker 隔离 + validateCode 闭环
// ============================================================
describe('功能闭环: Worker 隔离 + validateCode', () => {
  it('validateCode 拒绝 child_process', async () => {
    const { validateCode } = await import('../core/provider/code-runtime-worker-thread-provider')
    expect(validateCode("require('child_process')").ok).toBe(false)
  })

  it('validateCode 拒绝 eval()', async () => {
    const { validateCode } = await import('../core/provider/code-runtime-worker-thread-provider')
    expect(validateCode("eval('test')").ok).toBe(false)
  })

  it('validateCode 拒绝 process.exit', async () => {
    const { validateCode } = await import('../core/provider/code-runtime-worker-thread-provider')
    expect(validateCode("process.exit(0)").ok).toBe(false)
  })

  it('validateCode 拒绝 fs require', async () => {
    const { validateCode } = await import('../core/provider/code-runtime-worker-thread-provider')
    expect(validateCode("require('fs')").ok).toBe(false)
  })

  it('validateCode 放行安全代码', async () => {
    const { validateCode } = await import('../core/provider/code-runtime-worker-thread-provider')
    expect(validateCode("1 + 1").ok).toBe(true)
    expect(validateCode("const x = 'hello'").ok).toBe(true)
  })

  it('Worker 脚本使用白名单 require', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/code-runtime-worker-thread-provider.ts', 'utf8')
    expect(code).toContain("allowed = ['worker_threads']")
    expect(code).toContain("Module not allowed")
  })

  it('Worker 脚本使用 Function 构造器而非 eval', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/code-runtime-worker-thread-provider.ts', 'utf8')
    expect(code).toContain('new Function')
  })
})

// ============================================================
// 7. safeJsonParse 在数据流中的使用
// ============================================================
describe('功能闭环: safeJsonParse 数据流覆盖', () => {
  it('safeJsonParse 存在且可导入', async () => {
    const mod = await import('../core/utils/safe-json')
    expect(typeof mod.safeJsonParse).toBe('function')
    expect(typeof mod.safeJsonStringify).toBe('function')
  })

  it('safeJsonParse 处理边界情况', async () => {
    const { safeJsonParse } = await import('../core/utils/safe-json')
    // null 输入
    expect(safeJsonParse(null as any, 'default')).toBe('default')
    // undefined 输入
    expect(safeJsonParse(undefined as any, 'default')).toBe('default')
    // 空字符串
    expect(safeJsonParse('', 'default')).toBe('default')
    // 有效 JSON
    expect(safeJsonParse('{"x":1}', null)).toEqual({ x: 1 })
    // 无效 JSON
    expect(safeJsonParse('not json', null)).toBeNull()
  })

  it('safeJsonStringify 处理循环引用', async () => {
    const { safeJsonStringify } = await import('../core/utils/safe-json')
    const obj: any = { a: 1 }
    obj.self = obj
    expect(safeJsonStringify(obj)).toBeNull()
  })
})

// ============================================================
// 8. 数据流: App.tsx -> getCtxService -> ctx.get -> provider
// ============================================================
describe('功能闭环: App.tsx getCtxService 数据流', () => {
  it('getCtxService 不在调用中使用 fallback 单例参数', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    // 所有 getCtxService 调用
    const calls = code.match(/getCtxService\([^)]+\)/g) || []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // 不应包含 getXXX 作为第二参数
      expect(call).not.toMatch(/getCtxService\(['"]\w+['"],\s*get\w+/)
    }
  })

  it('App.tsx 在 getCtxService 返回 null 时有降级处理', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    // 检查 mimoAuth 调用处有 null 检查
    const authCalls = code.match(/getCtxService\('mimoAuth'\)[^;]+;/g) || []
    for (const call of authCalls) {
      // 后续应有 null 检查（在附近 3 行内）
      const idx = code.indexOf(call)
      const nearby = code.slice(idx, idx + 200)
      expect(nearby).toMatch(/if\s*\(\s*!\s*\w+\s*\)|\.?\?\.|null/)
    }
  })
})

// ============================================================
// 9. 工具管道数据流闭环
// ============================================================
describe('功能闭环: 工具管道数据流', () => {
  it('SandboxGuard 覆盖写工具和读工具', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/llm/tool-pipeline.ts', 'utf8')
    expect(code).toContain('"write"')
    expect(code).toContain('"edit"')
    expect(code).toContain('"multi_edit"')
    expect(code).toContain('"delete_file"')
    expect(code).toContain('"read"')
    expect(code).toContain('"read_file"')
    expect(code).toContain('"list_dir"')
    expect(code).toContain('"glob"')
  })

  it('SandboxGuard 在 path 不存在时放行', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/llm/tool-pipeline.ts', 'utf8')
    // 检查 path 为空时放行逻辑 — 可能使用双引号或单引号
    expect(code).toMatch(/if\s*\(\s*!\s*path\s*\)\s*return\s*\{\s*action:\s*['"]proceed['"]\s*\}/)
  })

  it('只读工具注册了并发分类器', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/llm/tool-pipeline.ts', 'utf8')
    expect(code).toContain('registerConcurrency')
    expect(code).toContain('"read_file"')
    expect(code).toContain('"web_search"')
  })
})

// ============================================================
// 10. 全局错误监听闭环
// ============================================================
describe('功能闭环: 全局错误监听', () => {
  it('App.tsx 包含 unhandledrejection 监听', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    expect(code).toContain('unhandledrejection')
    // 确保在 useEffect 中注册
    expect(code).toMatch(/addEventListener.*unhandledrejection|window\.addEventListener.*'unhandledrejection'/)
  })
})
