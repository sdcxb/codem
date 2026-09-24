/**
 * 第 97 轮：`src/core/slots/declare-slots.ts` 的**首个测试**（此前 0% 覆盖）。
 *
 * 这个文件看着只是"一长串声明"，但它是**真的承重**的：
 *  - `SlotCore.register()` 对**未声明**的槽位直接 `throw`（`slots/index.ts:168-170`）；
 *  - `SlotCore.entriesOfSlot()` 对**没有 spec** 的 key 返回空（`slots/index.ts:269-271`）。
 *
 * 于是有两个静默面：
 *  1. `<SlotBridge name="X">` 出口存在、但 `X` 没声明 ⇒ 插件一往 `X` 注册就**抛错**（插件加载失败）；
 *  2. `X` 声明了、但**没有任何出口** ⇒ 注册成功、永远不渲染（第 45 轮 D-15 的
 *     `app.model-selector` 就是这个"声明+注册+永不渲染"的三件套死代码，已删）。
 *
 * 本测试用**真实** `SlotCore` 跑 `declareAppSlots`，然后拿源码里的出口逐一对账，
 * 让第 1 类静默面变成红灯（SLOT-3）。第 2 类只锁住已清理过的那个锚点（SLOT-4），
 * 因为"声明了留给插件用"本身是合法的公开 API 面，不能一刀切要求必须有出口。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SlotCore } from '../core/slots/index'
import { declareAppSlots } from '../core/slots/declare-slots'
import { findTags } from '../../tools/ui-audit/jsx-scan.mjs'

const ROOT = path.resolve(__dirname, '..', '..')

type Declared = { key: string; spec: { kind: string; scope: string }; declaredBy?: string }

/** 用真实 SlotCore 跑一遍 declareAppSlots，返回声明清单 + core 本体。 */
function runDeclarations(): { core: SlotCore; declared: Declared[]; warned: string[] } {
  const core = new SlotCore()
  const declared: Declared[] = []
  const warned: string[] = []
  const slots = {
    declareSlot(key: string, spec: Declared['spec'], declaredBy?: string) {
      declared.push({ key, spec, declaredBy })
      core.declareSlot(key, spec as any, declaredBy)
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'slots') return slots
      return undefined
    },
  }
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warned.push(args.map(String).join(' '))
  })
  try {
    declareAppSlots(ctx as any)
  } finally {
    warn.mockRestore()
  }
  return { core, declared, warned }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('.')) continue
      walk(full, out)
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 把注释**换成等长空格**（保留换行与偏移），这样行号仍然准确。
 *
 * 必须做这一步：`declare-slots.ts:135` 和 `ui-model-selection-provider.ts:19` 的注释里
 * 都**原样写着** `<SlotBridge name="app.model-selector">`，不剥注释就会把它们当成真出口
 * （本测试第一版正是这样报了两个假阳性）。
 */
function stripComments(code: string): string {
  const out = code.split('')
  let quote: string | null = null
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < code.length) { out[i] = ' '; out[i + 1] = ' '; i++ }
      continue
    }
  }
  return out.join('')
}

/** 收集源码里的字符串常量（`const X = "y"` / `export const X = 'y'`），用于解析 `name={X}`。 */
function collectStringConstants(files: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(["'])([^"'\n]*)\2/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) map.set(m[1], m[3])
  }
  return map
}

type Outlet = { file: string; line: number; raw: string; name: string | null }

/** 扫出所有 `<SlotBridge>` / `<SlotListBridge>` 出口的槽位名（字面量或可解析常量）。 */
function collectOutlets(): { outlets: Outlet[]; unresolved: Outlet[] } {
  const files = walk(path.join(ROOT, 'src'))
  const constants = collectStringConstants(files)
  const outlets: Outlet[] = []
  const unresolved: Outlet[] = []
  const nameAttr = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$.]*))\s*\})/
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    for (const tagName of ['SlotBridge', 'SlotListBridge']) {
      for (const tag of findTags(code, tagName)) {
        if (code.slice(Math.max(0, tag.start - 1), tag.start) === '/') continue // 闭合标签
        const m = nameAttr.exec(tag.tag)
        const literal = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? null
        const identifier = m?.[5] ?? null
        const record: Outlet = {
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: tag.line,
          raw: tag.tag.replace(/\s+/g, ' ').slice(0, 120),
          name: literal ?? (identifier ? constants.get(identifier) ?? null : null),
        }
        outlets.push(record)
        if (record.name === null) unresolved.push(record)
      }
    }
  }
  return { outlets, unresolved }
}

describe('declare-slots: 框架槽位声明', () => {
  let warned: string[] = []
  beforeEach(() => { warned = [] })
  afterEach(() => { vi.restoreAllMocks() })

  it('SLOT-1: 没有 slots 服务时不抛异常，只 warn 一次（fail-open 语义明确）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    })
    const ctx = { get: () => undefined }
    expect(() => declareAppSlots(ctx as any)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warned.join('\n')).toContain('Slots service not yet available')
  })

  it('SLOT-2: 全部声明落到真实 SlotCore 上，名字唯一、kind/scope 合法、owner=framework', () => {
    const { core, declared, warned } = runDeclarations()
    expect(warned, '有 slots 服务时不应 warn').toEqual([])
    // 重复声明会让 core.declareSlot 抛错，所以能跑到这里就说明名字唯一。
    expect(declared.length).toBeGreaterThanOrEqual(80)
    expect(new Set(declared.map(d => d.key)).size).toBe(declared.length)
    for (const d of declared) {
      expect(['single', 'list', 'keyed', 'chain'], d.key).toContain(d.spec.kind)
      expect(d.spec.scope, d.key).toBe('root')
      expect(d.declaredBy, d.key).toBe('framework')
      expect(core.specDynamic(d.key), d.key).toEqual({ kind: d.spec.kind, scope: d.spec.scope })
    }
    // 四类 kind 里 keyed/chain 目前的使用是有意的：列覆盖保证不是"全都写成 single"。
    const kinds = new Set(declared.map(d => d.spec.kind))
    expect(kinds.has('single')).toBe(true)
    expect(kinds.has('list')).toBe(true)
    expect(kinds.has('chain')).toBe(true)
  })

  it('SLOT-3: 源码里每个 SlotBridge/SlotListBridge 出口都指向已声明的槽位（否则插件注册必抛）', () => {
    const { core } = runDeclarations()
    const { outlets, unresolved } = collectOutlets()
    expect(outlets.length, '出口数量应远大于 1（扫描器失效会让这条静默通过）').toBeGreaterThan(40)
    expect(
      unresolved.map(o => `${o.file}:${o.line} ${o.raw}`),
      '槽位名既不是字面量、也不是本测试可解析的 `const X = "..."` 常量',
    ).toEqual([])
    const undeclared = outlets
      .filter(o => core.specDynamic(o.name as string) === undefined)
      .map(o => `${o.file}:${o.line} name="${o.name}" 未在 declareAppSlots 中声明`)
    expect(undeclared).toEqual([])
  })

  it('SLOT-4: 已清理的死声明不回归（app.model-selector 声明+注册+永不渲染）', () => {
    const { core, declared } = runDeclarations()
    expect(declared.map(d => d.key)).not.toContain('app.model-selector')
    expect(core.specDynamic('app.model-selector')).toBeUndefined()
    // 反向对照：活着的那个模型选择入口所在的槽位族是在的（证明本测试不是在扫空集合）。
    expect(core.specDynamic('app.model-selection')).toBeDefined()
  })

  it('SLOT-5: 声明是承重的 —— 未声明槽位注册会抛、已声明槽位注册能被 entriesOfSlot 看到', () => {
    const { core } = runDeclarations()
    const noop = () => null
    expect(() => core.register({ name: 'app.not-declared-slot' } as any, noop))
      .toThrowError(/is not declared/)
    expect(core.entriesOfSlot('app.titlebar')).toHaveLength(0)
    const dispose = core.register({ name: 'app.titlebar' } as any, noop)
    expect(core.entriesOfSlot('app.titlebar')).toHaveLength(1)
    dispose()
    expect(core.entriesOfSlot('app.titlebar')).toHaveLength(0)
  })
})
