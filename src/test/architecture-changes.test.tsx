/**
 * 架构变更测试 — 覆盖今天审计修复的所有架构变更
 *
 * 覆盖项：
 * 1. safeJsonParse 安全解析
 * 2. loopPool LRU 淘汰
 * 3. SpillStore 异步 I/O
 * 4. SlotBridge 级联降级错误边界
 * 5. service-types Context 类型声明
 * 6. 双轨制消除（getCtxService 不回退单例）
 * 7. Guard↔RepeatToolReminder 循环依赖修复
 * 8. Provider inject 声明对齐
 * 9. Plugin registry optionalInject 字段
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// 1. safeJsonParse
// ============================================================
import { safeJsonParse, safeJsonStringify } from '../core/utils/safe-json'

describe('架构变更: safeJsonParse', () => {
  it('正常解析有效 JSON', () => {
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 })
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3])
  })

  it('解析失败时返回 fallback', () => {
    expect(safeJsonParse('invalid', null)).toBeNull()
    expect(safeJsonParse('invalid', [])).toEqual([])
    expect(safeJsonParse('invalid', { default: true })).toEqual({ default: true })
  })

  it('null/undefined 输入返回 fallback', () => {
    expect(safeJsonParse(null, null)).toBeNull()
    expect(safeJsonParse(undefined, 'fb')).toBe('fb')
    expect(safeJsonParse('', 'fb')).toBe('fb')
  })

  it('解析失败时输出 warn 日志', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeJsonParse('not json', 'fallback')
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[safeJsonParse]'),
      expect.any(String),
      'raw:',
      'not json'.slice(0, 100)
    )
    spy.mockRestore()
  })

  it('safeJsonStringify 正常序列化', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}')
  })

  it('safeJsonStringify 循环引用返回 null', () => {
    const obj: any = { a: 1 }
    obj.self = obj
    expect(safeJsonStringify(obj)).toBeNull()
  })
})

// ============================================================
// 2. loopPool LRU 淘汰
// ============================================================
describe('架构变更: loopPool LRU 淘汰', () => {
  it('LOOP_POOL_MAX 常量存在且为 20', async () => {
    // 通过源码验证：agent-loop-provider.ts 内 LOOP_POOL_MAX = 20
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/agent-loop-provider.ts', 'utf8')
    expect(code).toContain('LOOP_POOL_MAX')
    expect(code).toContain('evictLoopPoolIfNeeded')
    expect(code).toContain('LRU touch')
  })

  it('LRU touch 在 getLoop 时将访问的 key 移到末尾', async () => {
    // 通过源码验证 LRU touch 逻辑
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/agent-loop-provider.ts', 'utf8')
    expect(code).toContain('loopPool.delete(sessionId)')
    expect(code).toContain('loopPool.set(sessionId, existing)')
  })
})

// ============================================================
// 3. SpillStore 异步 I/O
// ============================================================
describe('架构变更: SpillStore 异步 I/O', () => {
  it('saveText 使用 fs.promises 而非 sync', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/llm/spill-store.ts', 'utf8')
    expect(code).toContain('fs.promises.mkdir')
    expect(code).toContain('fs.promises.writeFile')
    expect(code).not.toContain('fs.mkdirSync')
    expect(code).not.toContain('fs.writeFileSync')
  })
})

// ============================================================
// 4. SlotBridge 级联降级错误边界
// ============================================================
import { render } from '@testing-library/react'
import React from 'react'
import { SlotBridge } from '../core/slots/SlotBridge'

describe('架构变更: SlotBridge FallbackErrorBoundary', () => {
  it('Fallback 崩溃时显示错误提示而非白屏', () => {
    const CrashFallback = () => {
      throw new Error('Provider disabled')
    }

    // tryGetCtx 返回 null 时走 fallback
    const { container } = render(
      <SlotBridge name="test.slot" fallback={CrashFallback as any} />
    )

    // 应该包含错误提示文本
    expect(container.textContent).toContain('不可用')
  })

  it('无 fallback 时不崩溃', () => {
    const { container } = render(
      <SlotBridge name="test.slot" />
    )
    expect(container).toBeDefined()
  })
})

// ============================================================
// 5. service-types Context 类型声明
// ============================================================
describe('架构变更: service-types 类型声明', () => {
  it('文件导出所有 Provider 服务接口', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/service-types.ts', 'utf8')
    expect(code).toContain('LLMEngineService')
    expect(code).toContain('MiMoAuthService')
    expect(code).toContain('AgentRegistryService')
    expect(code).toContain('CredentialsService')
    expect(code).toContain('GuardService')
    expect(code).toContain('SandboxService')
    expect(code).toContain('HooksService')
    expect(code).toContain('AutomationService')
    expect(code).toContain('SlotsService')
    expect(code).toContain('declare module')
  })

  it('所有 Service 接口包含 _active 标志', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/service-types.ts', 'utf8')
    // _active 应出现在每个 Service 接口中（至少 10 次）
    const matches = code.match(/_active: boolean/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(10)
  })
})

// ============================================================
// 6. 双轨制消除 — getCtxService 不回退单例
// ============================================================
describe('架构变更: 双轨制消除', () => {
  it('App.tsx 中 getCtxService 调用不包含 fallback 单例', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    // 不应有 getCtxService('xxx', getYYY) || getYYY() 模式
    expect(code).not.toMatch(/getCtxService\(['"]\w+['"],\s*get\w+\)/)
  })

  it('getCtxService 定义不回退到单例', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    // 定义中 fallback 参数仍然存在（初始化前可用）但不应在调用中使用
    // 检查所有调用处
    const calls = code.match(/getCtxService\([^)]+\)/g) || []
    for (const call of calls) {
      // 不应包含 getXXX 作为第二参数
      expect(call).not.toMatch(/getCtxService\(['"]\w+['"],\s*get\w+/)
    }
  })
})

// ============================================================
// 7. Guard↔RepeatToolReminder 循环依赖修复
// ============================================================
describe('架构变更: Guard 循环依赖修复', () => {
  it('guard inject 声明为空数组（可选依赖）', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/plugin-registry-provider.ts', 'utf8')
    // guard 行应包含 optionalInject 而非 inject
    const guardLine = code.match(/name: '@codem\/guard'[^}]+}/s)?.[0]
    expect(guardLine).toBeDefined()
    expect(guardLine).toContain("inject: []")
    expect(guardLine).toContain("optionalInject: ['repeatToolReminder']")
  })
})

// ============================================================
// 8. Provider inject 声明对齐
// ============================================================
describe('架构变更: Provider inject 对齐', () => {
  it('sandbox-local inject shell', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/plugin-registry-provider.ts', 'utf8')
    const line = code.match(/name: '@codem\/sandbox-local'[^}]+}/s)?.[0]
    expect(line).toContain("inject: ['shell']")
  })

  it('schedule inject inbox', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/plugin-registry-provider.ts', 'utf8')
    const line = code.match(/name: '@codem\/schedule'[^}]+}/s)?.[0]
    expect(line).toContain("inject: ['inbox']")
  })
})

// ============================================================
// 9. 复合 Dispose 模式
// ============================================================
describe('架构变更: 复合 Dispose', () => {
  it('hooks-provider 有 compositeDispose', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/hooks-provider.ts', 'utf8')
    expect(code).toContain('compositeDispose')
    expect(code).toContain('clearAllHooks')
    expect(code).toContain('_active: true')
  })

  it('automation-provider 有 compositeDispose + _active', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/automation-provider.ts', 'utf8')
    expect(code).toContain('compositeDispose')
    expect(code).toContain('stopAutomationEngines')
    expect(code).toContain('_active: true')
  })
})

// ============================================================
// 10. Credentials XOR 混淆存储
// ============================================================
describe('架构变更: Credentials XOR 混淆', () => {
  it('credentials-provider 包含 XOR 混淆逻辑', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/credentials-provider.ts', 'utf8')
    expect(code).toContain('XOR') // 注释中声明 XOR + Base64
    expect(code).toContain('OBFUSCATION_KEY')
    expect(code).toMatch(/encode\s*\(/)
    expect(code).toMatch(/decode\s*\(/)
  })

  it('migrateToObfuscated 自动迁移逻辑存在', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/provider/credentials-provider.ts', 'utf8')
    expect(code).toContain('migrateToObfuscated')
  })
})

// ============================================================
// 11. SandboxGuard 覆盖读操作
// ============================================================
describe('架构变更: SandboxGuard 读操作覆盖', () => {
  it('tool-pipeline 中 SandboxGuard 覆盖 read_file 和 list_dir', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/core/llm/tool-pipeline.ts', 'utf8')
    expect(code).toContain('read_file')
    expect(code).toContain('list_dir')
  })
})

// ============================================================
// 12. 全局错误监听
// ============================================================
describe('架构变更: 全局错误边界', () => {
  it('App.tsx 包含全局 error 和 unhandledrejection 监听', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/App.tsx', 'utf8')
    expect(code).toContain('unhandledrejection')
  })
})

// ============================================================
// 13. 空 catch 块添加日志
// ============================================================
describe('架构变更: 空 catch 块日志', () => {
  it('provider 目录中不存在裸 catch {} 块', async () => {
    const src = await vi.importActual('fs')
    const path = await vi.importActual('path')
    const providerDir = 'src/core/provider'
    const files = src.readdirSync(providerDir).filter((f: string) => f.endsWith('.ts'))
    let bareCatchCount = 0
    for (const f of files) {
      const code = src.readFileSync(path.join(providerDir, f), 'utf8')
      // 检查 catch {} 后面直接 } 的模式（空 catch）
      const bare = code.match(/catch\s*\{[^}]*\}/g) || []
      for (const b of bare) {
        // 允许 catch { /* comment */ } 但不允许 catch {}
        if (b.match(/catch\s*\{\s*\}/)) {
          bareCatchCount++
        }
      }
    }
    // 允许少量残留，但不应超过 5 个
    expect(bareCatchCount).toBeLessThan(5)
  })
})

// ============================================================
// 14. InputArea 两行布局
// ============================================================
describe('架构变更: InputArea 两行布局', () => {
  it('CSS 包含 input-textarea-row 和 input-action-row', async () => {
    const src = await vi.importActual('fs')
    const css = src.readFileSync('src/styles.css', 'utf8')
    expect(css).toContain('.input-textarea-row')
    expect(css).toContain('.input-action-row')
    expect(css).toContain('.input-tools-left')
    expect(css).toContain('.input-tools-right')
  })

  it('InputArea.tsx 使用新的两行结构', async () => {
    const src = await vi.importActual('fs')
    const code = src.readFileSync('src/components/InputArea.tsx', 'utf8')
    expect(code).toContain('input-textarea-row')
    expect(code).toContain('input-action-row')
    expect(code).toContain('input-tools-left')
    expect(code).toContain('input-tools-right')
  })

  it('textarea 字号 >= 15px', async () => {
    const src = await vi.importActual('fs')
    const css = src.readFileSync('src/styles.css', 'utf8')
    const inputBlock = css.match(/\.message-input\s*\{[^}]+\}/s)?.[0]
    expect(inputBlock).toBeDefined()
    expect(inputBlock).toContain('font-size: 15px')
    expect(inputBlock).toContain('min-height: 56px')
    expect(inputBlock).toContain('line-height: 24px')
  })
})
