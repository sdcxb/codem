// @ts-nocheck
/**
 * Codem Slot Registry — UI 插槽系统核心。
 *
 * 从 dsh 的 ui-slots 包移植，支持四种槽位模式：
 * - single: 最后注册的生效（覆盖）
 * - list: 所有注册的组件按顺序渲染
 * - keyed: 按 key 分派，同一 key 后注册覆盖
 * - chain: 管道式，前一个组件可以决定是否传递给下一个
 *
 * 通过 TypeScript declaration merging 扩展 SlotMap 实现类型安全的槽位注册。
 */

import type { ReactNode } from 'react'
import { Service, Context } from '../cordis/src/index.ts'

/** Slot cardinality: single occupant, ordered list, key-dispatched, or chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global or session-bound. */
export type SlotScope = 'root' | 'session' | 'session-maybe'

/**
 * Slot contract table. Owners extend via declaration merging; entries are
 * {@link SlotEntryDef}. Consumers declare their slots by merging into this
 * interface.
 */
export interface SlotMap {}

/** One SlotMap entry: kind/scope axes plus optional owner-supplied props. */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  keyProps?: Record<string, object>
  hookContext?: unknown
  inject?: object
}

/** Runtime dispatch spec for one slot. */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
}

/** Child-slot declaration table for register(). */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** Registration key domain of one keyed slot. */
export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? keyof P & string
    : string

/** Owner-supplied props for a slot key. */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** renderSlot dispatch options. */
export interface RenderOpts<EntryKey extends string = string> {
  entryKey?: EntryKey
  only?: string
  fallback?: ReactNode
  hookContext?: unknown
}

/** Chain-entry selector. */
export type ChainSelect<O extends object, M> = (owner: O) => M | null

/** A list-entry display label. */
export type SlotLabel = string | (() => string)

/** One stored registration. */
export interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
  select?: ((owner: never) => unknown) | undefined
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined
  store?: unknown | undefined
  locale?: string | undefined
  registrant?: string | undefined
}

/** JSON-safe live occupant. */
export interface LiveSlotOccupant {
  registrant?: string
  key?: string
  id?: string
  order?: number
  priority: number
  active: boolean
}

/** JSON-safe live slot declaration tree. */
export interface LiveSlotNode {
  name: string
  kind: SlotKind
  scope: SlotScope
  declaredBy?: string
  occupants: LiveSlotOccupant[]
  children: LiveSlotNode[]
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/** Resolve a possibly-thunked list label. */
export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined
  declaredBy: string | undefined
  parent: string | undefined
  declarationEpoch: number
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

/**
 * Pure slot registry core (no React; event emission lives in the Service wrapper).
 *
 * The 'root' slot is the one a-priori declaration, seeded at construction
 * (single/root, declared by the framework) — the render tree's root hole.
 */
export class SlotCore {
  private records = new Map<string, SlotRecord>()
  private mutateListeners = new Set<(key: string) => void>()
  private handleScopes = new Map<object, { scope: SlotScope; count: number }>()
  private dirty = new Set<SlotRecord>()
  private flushScheduled = false
  private abdicated = new WeakSet<StoredEntry>()
  private entryErrorListeners
    = new Set<(key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void>()

  constructor() {
    const root = this.record('root')
    root.spec = { kind: 'single', scope: 'root' }
    root.declaredBy = '(built-in)'
    root.declarationEpoch = 1
  }

  /**
   * Contribute a component to a declared slot and (optionally) declare child
   * slots, a store seat, and the registrant's business face.
   */
  register<K extends keyof SlotMap & string>(
    options: {
      name: K
      key?: EntryKeyOf<K>
      id?: string
      order?: number
      label?: SlotLabel
      priority?: number
      select?: ChainSelect<any, any>
      children?: ChildrenDecl
      store?: unknown
      inject?: (...args: any[]) => Record<string, unknown>
      locale?: string
      registrant?: string
    },
    component: unknown,
  ): () => void {
    const rec = this.records.get(options.name)
    if (!rec?.spec) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const spec = rec.spec
    const priority = options.priority ?? 0

    switch (spec.kind) {
      case 'single': {
        const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`)
        break
      }
      case 'keyed': {
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`)
        const occupant = rec.entries.find(e => e.options.key === options.key && (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}"`)
        break
      }
      case 'list': {
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
        const occupant = rec.entries.find(e => e.options.id === options.id && (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
        break
      }
      case 'chain':
        if (options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`)
        break
    }

    if (options.children) {
      for (const childKey of Object.keys(options.children)) {
        const childRec = this.records.get(childKey)
        if (childRec?.spec) {
          throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy ?? 'an unknown entry'})`)
        }
      }
    }

    const entry: StoredEntry = {
      component,
      options: {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      },
      ...(options.select !== undefined ? { select: options.select } : {}),
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.registrant !== undefined ? { registrant: options.registrant } : {}),
    }
    const next = [...rec.entries, entry]
    next.sort(spec.kind === 'list'
      ? (a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)) || ((a.options.order ?? 0) - (b.options.order ?? 0))
      : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    rec.entries = next
    this.markDirty(options.name, rec)

    if (options.children) {
      const declarations: [key: string, record: SlotRecord][] = []
      for (const [childKey, childSpec] of Object.entries(options.children)) {
        const childRec = this.record(childKey)
        childRec.spec = childSpec
        childRec.declaredBy = `an entry in "${options.name}"`
        childRec.parent = options.name
        childRec.declarationEpoch += 1
        declarations.push([childKey, childRec])
      }
      for (const [childKey, childRec] of declarations) {
        this.markDirty(childKey, childRec)
      }
      for (const [, childRec] of declarations) {
        this.notifyDeclaration(childRec)
      }
    }

    return () => {
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(e => e !== entry)
      this.markDirty(options.name, rec)
      this.releaseEntry(entry)
    }
  }

  /** Whether a previously obtained entry is still registered. */
  isLive(entry: StoredEntry): boolean {
    for (const rec of this.records.values()) {
      if (rec.entries.includes(entry)) return true
    }
    return false
  }

  /** Snapshot the registered entries for a key. */
  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? NO_ENTRIES
  }

  /** Project a key's entries to its shadowing winners. */
  entriesOfSlot(key: string): readonly StoredEntry[] {
    const rec = this.records.get(key)
    if (!rec?.spec) return NO_ENTRIES
    const kind = rec.spec.kind
    if (kind === 'chain') return rec.entries
    const heads: StoredEntry[] = []
    const seenCells = new Set<string | undefined>()
    for (const entry of rec.entries) {
      if (this.abdicated.has(entry)) continue
      const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
      if (seenCells.has(cell)) continue
      seenCells.add(cell)
      heads.push(entry)
    }
    return heads
  }

  /** Look up a slot's declared spec. */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this.records.get(key)?.spec as SlotSpec<SlotMap[K]> | undefined
  }

  /**
   * Declare a top-level slot directly (without needing a parent entry).
   * This is used by the framework to declare well-known slots before
   * any plugin registers into them.
   */
  declareSlot(key: string, spec: SlotSpec<SlotEntryDef>, declaredBy?: string): void {
    const rec = this.record(key)
    if (rec.spec) {
      throw new Error(`slot "${key}" is already declared (by ${rec.declaredBy ?? 'an unknown entry'})`)
    }
    rec.spec = spec
    rec.declaredBy = declaredBy ?? '(framework)'
    rec.declarationEpoch += 1
    this.markDirty(key, rec)
    this.notifyDeclaration(rec)
  }

  /** Dynamic-key escape hatch for spec lookup. */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this.records.get(key)?.spec
  }

  /** Export the current declaration topology. */
  snapshot(root?: string): LiveSlotNode[] {
    const build = (name: string, seen: Set<string>): LiveSlotNode | undefined => {
      const record = this.records.get(name)
      if (record?.spec === undefined || seen.has(name)) return undefined
      const branch = new Set(seen)
      branch.add(name)
      const active = new Set(this.entriesOfSlot(name))
      const children = [...this.records.entries()]
        .filter(([, candidate]) => candidate.spec !== undefined && candidate.parent === name)
        .flatMap(([child]) => {
          const node = build(child, branch)
          return node === undefined ? [] : [node]
        })
      return {
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy },
        occupants: record.entries.map(entry => ({
          ...entry.registrant === undefined ? {} : { registrant: entry.registrant },
          ...entry.options.key === undefined ? {} : { key: entry.options.key },
          ...entry.options.id === undefined ? {} : { id: entry.options.id },
          ...entry.options.order === undefined ? {} : { order: entry.options.order },
          priority: entry.options.priority ?? 0,
          active: active.has(entry),
        })),
        children,
      }
    }
    if (root !== undefined) {
      const node = build(root, new Set())
      return node === undefined ? [] : [node]
    }
    return [...this.records.entries()]
      .filter(([, record]) => record.spec !== undefined
        && (record.parent === undefined || this.records.get(record.parent)?.spec === undefined))
      .flatMap(([name]) => {
        const node = build(name, new Set())
        return node === undefined ? [] : [node]
      })
  }

  /** Read the declaration lifetime of a key. */
  declarationEpoch(key: string): number {
    return this.records.get(key)?.declarationEpoch ?? 0
  }

  /** Subscribe to registration changes for a key (microtask-batched). */
  subscribe(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.listeners.add(fn)
    return () => { rec.listeners.delete(fn) }
  }

  /** Subscribe to declaration lifetime boundaries for a key. */
  subscribeDeclaration(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.declarationListeners.add(fn)
    return () => { rec.declarationListeners.delete(fn) }
  }

  /** Monotonic version for a key. */
  getVersion(key: string): number {
    return this.records.get(key)?.version ?? 0
  }

  /** Hook every mutation. */
  onMutate(fn: (key: string) => void): () => void {
    this.mutateListeners.add(fn)
    return () => { this.mutateListeners.delete(fn) }
  }

  /** Renderer crash report from an entry boundary. */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void {
    if (info.abdicate) {
      if (this.abdicated.has(entry)) return
      this.abdicated.add(entry)
      const rec = this.records.get(key)
      if (rec !== undefined) this.markDirty(key, rec)
    }
    for (const fn of [...this.entryErrorListeners]) fn(key, entry, error, { abdicated: info.abdicate })
  }

  /** Observe entry boundary crashes. */
  onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void {
    this.entryErrorListeners.add(fn)
    return () => { this.entryErrorListeners.delete(fn) }
  }

  private releaseEntry(entry: StoredEntry): void {
    if (!entry.children) return
    for (const childKey of Object.keys(entry.children)) {
      const childRec = this.records.get(childKey)
      if (!childRec) continue
      const doomed = childRec.entries
      childRec.spec = undefined
      childRec.declaredBy = undefined
      childRec.parent = undefined
      childRec.declarationEpoch += 1
      childRec.entries = NO_ENTRIES
      this.markDirty(childKey, childRec)
      this.notifyDeclaration(childRec)
      for (const dead of doomed) this.releaseEntry(dead)
    }
  }

  private record(key: string): SlotRecord {
    let rec = this.records.get(key)
    if (!rec) {
      rec = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        declarationEpoch: 0,
        entries: NO_ENTRIES,
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(key, rec)
    }
    return rec
  }

  private markDirty(key: string, rec: SlotRecord): void {
    rec.version += 1
    for (const fn of [...this.mutateListeners]) fn(key)
    this.dirty.add(rec)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => { this.flush() })
    }
  }

  private notifyDeclaration(rec: SlotRecord): void {
    for (const fn of [...rec.declarationListeners]) fn()
  }

  private flush(): void {
    this.flushScheduled = false
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const rec of dirty) {
      for (const fn of [...rec.listeners]) fn()
    }
  }
}

/**
 * Slot Registry Cordis Service — wraps SlotCore and exposes it as `ctx.slots`.
 *
 * Provides `register()`, `entriesOfSlot()`, `subscribe()`, and `renderSlot()`
 * methods for plugins to contribute UI components to dynamic slot positions.
 */
export class SlotsService extends Service {
  static readonly inject = ['events'] as const

  private core: SlotCore

  constructor(ctx: Context) {
    super(ctx, 'slots')
    this.core = new SlotCore()

    // Bridge SlotCore mutations to Cordis events
    this.core.onMutate((key) => {
      ctx.emit('slots/mutate', key)
    })
  }

  /** The underlying SlotCore instance (for advanced use). */
  get core$() { return this.core }

  /** Declare a top-level slot directly. */
  declareSlot(key: string, spec: SlotSpec<SlotEntryDef>, declaredBy?: string): void {
    this.core.declareSlot(key, spec, declaredBy)
  }

  /** Register a component into a slot. */
  register<K extends keyof SlotMap & string>(
    options: Parameters<SlotCore['register']>[0] & { name: K },
    component: Parameters<SlotCore['register']>[1],
  ): () => void {
    return this.ctx.effect(() => {
      return this.core.register(options as any, component)
    }, `ctx.slots.register(${JSON.stringify(options.name)})`)
  }

  /** Get entries for a key (stable reference between mutations). */
  entries(key: string): readonly StoredEntry[] {
    return this.core.entries(key)
  }

  /** Get shadowing winners for a key. */
  entriesOfSlot(key: string): readonly StoredEntry[] {
    return this.core.entriesOfSlot(key)
  }

  /** Subscribe to registration changes for a key. */
  subscribe(key: string, fn: () => void): () => void {
    return this.core.subscribe(key, fn)
  }

  /** Monotonic version for a key. */
  getVersion(key: string): number {
    return this.core.getVersion(key)
  }

  /** Get declared spec for a key. */
  spec(key: string) {
    return this.core.specDynamic(key)
  }

  /** Export the current declaration topology. */
  snapshot(root?: string) {
    return this.core.snapshot(root)
  }

  /** Check if an entry is still live. */
  isLive(entry: StoredEntry): boolean {
    return this.core.isLive(entry)
  }

  /** Report an entry error. */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }) {
    return this.core.reportEntryError(key, entry, error, info)
  }
}

declare module '../cordis/src/context.ts' {
  interface Context {
    /** Slot Registry service for dynamic UI component injection. */
    slots: SlotsService
  }
}
