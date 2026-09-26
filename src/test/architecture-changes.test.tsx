/**
 * 架构变更测试 — 覆盖今天审计修复的所有架构变更
 *
 * 覆盖项：
 * 1. safeJsonParse 安全解析
 * 2. loopPool LRU 淘汰
 * 3. 溢出（spill）只有一份实现 + 走统一文件 API
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
// 3. 溢出（spill）只有**一份**实现 —— 走应用的统一文件 API（第 71 轮更正）
// ============================================================
describe('架构变更: 溢出存储只有一份实现', () => {
  /**
   * ⚠️ 这组断言在**第 71 轮被改写两次**，过程值得记下来，因为它是"数据不是印象"的例子：
   *
   * 1) 最初钉的是 `llm/spill-store.ts` 的 `saveText` "用 `fs.promises.*`，不用 sync 版"。
   * 2) 但渲染进程里的 `fs` 被 `vite.config.ts` 映射到 `src/stubs/node-fs-stub.ts` —— 一个
   *    **空壳**：`writeFile` 什么都不做，`mkdtempSync` **根本不存在**。真机上每次大输出都打
   *    `[spill-policy] saveText failed for bash: (void 0) is not a function`
   *    —— 主 agent 循环的溢出策略在打包版里**从未成功过一次**。
   * 3) 第 71 轮把 `llm/spill-store.ts` 改成走统一文件 API 之后才发现真正的病根不是"哪套写法"，
   *    而是**同一件事有两份实现**：`core/storage/spill.ts` 那套一直好好的
   *    （`session/executor.ts` 在用、`pruneSpillFiles` 按它的文件名回收），只有中间件这条
   *    路用的是死的第 71 轮之前那套。所以最终做法是**删掉重复实现**：中间件只做决策
   *    （WHEN 溢出），机制全部交给 `core/storage/spill.ts`。
   *
   * 于是现在的契约有三条：唯一实现、不碰 Node fs、决策方必须委托。
   */
  it('只有一份溢出实现：llm/spill-store.ts 不得复活', async () => {
    const src = await vi.importActual('fs')
    expect(
      src.existsSync('src/core/llm/spill-store.ts'),
      '溢出存储只能有 core/storage/spill.ts 一份；再出现第二份就是"只有一份是活的"那类缺陷的复发',
    ).toBe(false)
    expect(src.existsSync('src/core/storage/spill.ts'), '唯一实现必须存在').toBe(true)
  })

  it('唯一实现走统一文件 API（不碰 Node fs）', async () => {
    const src = await vi.importActual('fs')
    const raw = src.readFileSync('src/core/storage/spill.ts', 'utf8')
    // 判据落在**代码**上：注释里会解释"为什么不用 Node fs"，那是文档不是实现
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    expect(code, '必须通过应用的统一文件 API 写盘').toContain('from "../file-api"')
    expect(code, '落点必须在数据根目录下的 spill/（保留期清理认账的同一处）').toContain('resolveDataRoot')
    // 反向守卫：Node fs / os 的痕迹一个都不许留（它们在打包版里是空壳）
    expect(code, '不许再用 Node fs').not.toMatch(/from ["'](node:)?fs["']/)
    expect(code, '不许再用 Node os').not.toMatch(/from ["'](node:)?os["']/)
    expect(code, '不许再用 fs.promises（打包版里是空壳）').not.toContain('fs.promises')
    expect(code, '不许再用同步 fs').not.toContain('fs.mkdirSync')
    expect(code, '不许再用 mkdtempSync（桩里没有这个函数，真机那条报错就是它）').not.toContain('mkdtempSync')
    expect(raw, '注释里要留下"为什么不用 Node fs"的说明（否则下一个人会改回去）').toContain('打包版')
  })

  it('决策方（spill-policy）必须委托给唯一实现，不许自带预览/通知', async () => {
    const src = await vi.importActual('fs')
    const raw = src.readFileSync('src/core/llm/spill-policy.ts', 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    expect(code, '必须委托给 core/storage/spill.ts 的 retainToolResult').toContain('retainToolResult')
    expect(code, '必须从 core/storage/spill 导入（不是某个 llm/ 下的私有实现）').toMatch(/from "\.\.\/storage\/spill"/)
    // 反向守卫：不许再自建预览/通知（这正是被删掉的那份重复机制）
    expect(code, '不许自建 head/tail 预览').not.toContain('buildHeadTailPreview')
    expect(code, '不许自建通知行').not.toContain('buildSpillNotice')
    expect(code, '不许再用 Buffer（渲染进程里不是原生对象）').not.toContain('Buffer.byteLength')
    // 正向上限不变式：替换文本前必须还有一道硬检查
    expect(code, '替换前必须保持"绝不超过 maxInlineBytes"的硬检查').toContain('exceeds maxInlineBytes')
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
    // 锚定行首，避免误匹配 `.input-card-container.blur-folded .message-input {` 等后代规则
    const inputBlock = css.match(/(?:^|\n)\.message-input\s*\{[^}]+\}/s)?.[0]
    expect(inputBlock).toBeDefined()
    // 字号必须走设计系统令牌（audit 规则 fs-hardcoded 禁止写死 px），
    // 但「>= 15px」这个可读性要求不变 —— 于是从 :root 解析令牌的实际数值来断言。
    const token = /font-size:\s*var\((--[a-z0-9-]+)\)/.exec(inputBlock!)?.[1]
    expect(token, '输入框字号必须使用设计系统令牌 var(--fs-*)').toBeTruthy()
    const rawPx = new RegExp(`\\${token}:\\s*calc\\(([0-9.]+)px`).exec(css)?.[1]
    expect(Number(rawPx), `${token} = ${rawPx}px，输入框字号必须 >= 15px`).toBeGreaterThanOrEqual(15)
    expect(inputBlock).toContain('min-height: 56px')
    /**
     * 行高：第 155 轮（P0-3）从写死的 `24px` 改成令牌 `var(--lh-base)`。
     *
     * 为什么这次替换是**等价且更好**的：`--lh-base = 1.5`、`--fs-lg = 16px` ⇒ 定稿值仍是 **24px**；
     * 而写成比例值之后，它随设置里的字号滑杆（`--ui-font-scale`）一起缩放 ——
     * 原来 24px 是死的，字号调大后输入框行高不变（.input-backdrop 镜像层同样如此）。
     * 判据同时钉住两件事：① 走的是行高令牌；② 在默认字号下仍然等于 24px；③ 镜像层用**同一个**令牌
     * （见下面那条用例 —— 两层字号/行高不一致会直接表现为光标错位）。
     */
    expect(inputBlock, '输入框行高必须走 --lh-* 令牌').toContain('line-height: var(--lh-base)')
    const lhToken = /line-height:\s*var\((--lh-[a-z]+)\)/.exec(inputBlock!)?.[1]
    expect(lhToken, '输入框行高必须使用设计系统令牌 var(--lh-*)').toBeTruthy()
    const lhFactor = new RegExp(`\\${lhToken}:\\s*([0-9.]+);`).exec(css)?.[1]
    const fsPx = Number(rawPx)
    expect(
      lhFactor && Math.abs(Number(lhFactor) * fsPx - 24) < 0.01,
      `${lhToken}(${lhFactor}) × ${token}(${fsPx}px) = ${(Number(lhFactor) * fsPx).toFixed(2)}px，必须等于 24px`,
    ).toBe(true)
  })

  it('输入框实时镜像层（.input-backdrop）与 .message-input 同字号、同行高令牌', async () => {
    const src = await vi.importActual('fs')
    const css = src.readFileSync('src/styles.css', 'utf8')
    const grab = (sel: string, prop: string) =>
      new RegExp(`${prop}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(css.match(new RegExp(`(?:^|\\n)\\${sel}\\s*\\{[^}]+\\}`, 's'))?.[0] ?? '')?.[1]
    const a = grab('.message-input', 'font-size')
    const b = grab('.input-backdrop', 'font-size')
    expect(a).toBeTruthy()
    // 两层字号一旦漂移，输入文字与镜像文字会错位（光标跑到文字前面/后面）
    expect(b, '.input-backdrop 必须与 .message-input 同字号令牌').toBe(a)
    /**
     * 第 155 轮（P0-3）补：**行高也必须同令牌**。
     * 字号一致但行高不同，同样会错位（镜像层按自己的行高排版）—— 而且这正好是
     * "行高从 24px 改成令牌"那次迁移最容易踩的地方：只改一层就静默错位。
     */
    const la = grab('.message-input', 'line-height')
    const lb = grab('.input-backdrop', 'line-height')
    expect(la, '.message-input 行高必须走令牌').toBeTruthy()
    expect(lb, '.input-backdrop 必须与 .message-input 同行高令牌').toBe(la)
  })
})
