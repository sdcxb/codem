// @ts-nocheck
/**
 * YAML 配置加载器 — 对标 DSH cordis.patch.yml 的声明式插件配置。
 *
 * 核心流程：
 * 1. 读取 config/codem.base.yml（通过 Vite ?raw import）
 * 2. 解析 YAML 声明：id, name, inject, disabled, when, config, core
 * 3. 根据 when 条件过滤平台
 * 4. 通过 id 从 builtinPlugins 注册表查找对应 Plugin 对象
 * 5. 按依赖拓扑排序加载到 Cordis Context
 *
 * 对标 DSH 的分层 bundle 架构：
 * - codem.base.yml: 所有模式共享的核心插件
 * - codem.desktop.yml: 桌面应用（Tauri）覆盖层
 * - codem.web.yml: Web 模式覆盖层（未来）
 */

import type { Context, Plugin } from '../cordis/src/index.ts'
import { builtinPlugins } from './index.ts'

/** YAML 中的单个插件条目 */
export interface YamlPluginEntry {
  id: string
  name: string
  inject?: string[]
  disabled?: boolean
  /** 平台条件，如 "platform == 'win32'" */
  when?: string
  config?: Record<string, any>
  core?: boolean
}

/** 加载结果 */
export interface YamlLoadResult {
  loaded: string[]
  skipped: string[]
  failed: Array<{ name: string; error: string }>
}

/**
 * 简易 YAML 解析器。
 *
 * 支持 codem.base.yml 的子集格式：
 * - 顶层是 `- id: xxx` 开头的数组
 * - 每个条目有 `name`, `inject`, `disabled`, `when`, `config`, `core` 字段
 * - `inject` 是 `[a, b, c]` 格式的数组
 * - `config` 是嵌套的 key: value 映射
 *
 * 不依赖 js-yaml，在浏览器环境中可直接运行。
 */
export function parseCodemYaml(content: string): YamlPluginEntry[] {
  const entries: YamlPluginEntry[] = []
  // 规范化换行符：Windows \r\n -> \n，单独的 \r -> \n
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  let current: YamlPluginEntry | null = null
  let inConfig = false
  let configIndent = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedEnd = line.trimEnd()
    if (!trimmedEnd || trimmedEnd.startsWith('#')) continue

    // 顶层条目：- id: xxx
    const entryMatch = line.match(/^- id:\s*(.+)$/)
    if (entryMatch) {
      if (current) entries.push(current)
      current = {
        id: entryMatch[1].trim().replace(/['"]/g, ''),
        name: '',
      }
      inConfig = false
      continue
    }

    if (!current) continue

    // 简单属性
    const propMatch = line.match(/^  (\w+):\s*(.*)$/)
    if (propMatch && !inConfig) {
      const [, key, value] = propMatch
      const cleanValue = value.trim().replace(/['"]/g, '')

      switch (key) {
        case 'name':
          current.name = cleanValue
          break
        case 'inject':
          if (cleanValue && cleanValue !== '[]') {
            current.inject = cleanValue
              .replace(/[\[\]]/g, '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          } else {
            current.inject = []
          }
          break
        case 'disabled':
          current.disabled = cleanValue === 'true'
          break
        case 'when':
          current.when = cleanValue
          break
        case 'core':
          current.core = cleanValue === 'true'
          break
        case 'config':
          inConfig = true
          configIndent = 4
          current.config = {}
          break
      }
      continue
    }

    // config 嵌套属性
    if (inConfig && current.config) {
      const configMatch = line.match(/^(\s+)(\w+):\s*(.*)$/)
      if (configMatch) {
        const indent = configMatch[1].length
        if (indent <= 2) {
          inConfig = false
          // 重新作为简单属性处理
          const [, , key, value] = configMatch
          const cleanValue = value.trim().replace(/['"]/g, '')
          if (key === 'name') current.name = cleanValue
          else if (key === 'disabled') current.disabled = cleanValue === 'true'
          continue
        }
        const key = configMatch[2]
        const value = configMatch[3].trim().replace(/['"]/g, '')
        if (value) {
          // 简单标量值
          current.config[key] = isNaN(Number(value)) ? value : Number(value)
        }
        // 不处理更深嵌套
      }
    }
  }
  if (current) entries.push(current)

  return entries
}

/**
 * 评估 when 条件表达式。
 *
 * 支持的表达式：
 * - platform == 'win32'
 * - platform != 'win32'
 */
export function evaluateWhen(when: string | undefined): boolean {
  if (!when) return true

  const platform = typeof process !== 'undefined'
    ? process.platform
    : (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Win') ? 'win32' : 'linux')

  // platform == 'win32'
  const eqMatch = when.match(/platform\s*==\s*['"](\w+)['"]/)
  if (eqMatch) return platform === eqMatch[1]

  // platform != 'win32'
  const neqMatch = when.match(/platform\s*!=\s*['"](\w+)['"]/)
  if (neqMatch) return platform !== neqMatch[1]

  return true
}

/**
 * 从 builtinPlugins 注册表中查找对应的 Plugin。
 *
 * 查找策略：按 name 精确匹配，回退到 id 模糊匹配。
 */
function findPluginInRegistry(name: string, id: string): { meta: any; apply: () => any } | null {
  // 精确匹配 name
  if (builtinPlugins.has(name)) {
    return builtinPlugins.get(name)
  }

  // 回退：用 id 构造可能的 name（@codem/<id>）
  const constructedName = `@codem/${id}`
  if (builtinPlugins.has(constructedName)) {
    return builtinPlugins.get(constructedName)
  }

  // 回退：用 name 去掉 @codem/ 前缀后匹配 id
  const nameWithoutPrefix = name.replace(/^@codem\//, '')
  if (nameWithoutPrefix === id && builtinPlugins.has(name)) {
    return builtinPlugins.get(name)
  }

  return null
}

/**
 * 声明式加载插件 — 从 YAML 配置驱动。
 *
 * 对标 DSH 的 boot() 函数：
 * 1. 解析 YAML 声明
 * 2. 过滤条件（disabled, when）
 * 3. 拓扑排序
 * 4. 逐个加载到 Context
 *
 * @param ctx Cordis Context
 * @param ymlContent YAML 文件内容（codem.base.yml）
 * @returns 加载结果
 */
export function loadFromYaml(ctx: Context, ymlContent: string): YamlLoadResult {
  const result: YamlLoadResult = {
    loaded: [],
    skipped: [],
    failed: [],
  }

  // 1. 解析 YAML
  const entries = parseCodemYaml(ymlContent)
  console.log(`[YamlLoader] Parsed ${entries.length} entries from YAML`)

  // 2. 过滤条件
  const activeEntries = entries.filter(entry => {
    // disabled: true → 跳过
    if (entry.disabled) {
      result.skipped.push(`${entry.id} (disabled)`)
      return false
    }
    // when 条件不满足 → 跳过
    if (!evaluateWhen(entry.when)) {
      result.skipped.push(`${entry.id} (platform: ${entry.when})`)
      return false
    }
    return true
  })

  console.log(`[YamlLoader] ${activeEntries.length} active entries (${result.skipped.length} skipped)`)

  // 3. 拓扑排序：provides 在 inject 它的插件之前
  const sorted = topologicalSort(activeEntries, builtinPlugins)

  // 4. 逐个加载
  for (const entry of sorted) {
    const registryEntry = findPluginInRegistry(entry.name, entry.id)
    if (!registryEntry) {
      result.failed.push({
        name: entry.id,
        error: `not found in builtin registry (name: ${entry.name})`,
      })
      continue
    }

    try {
      const pluginObj = registryEntry.apply()
      // 如果 Plugin 是函数形式，展开它
      const plugin = typeof pluginObj === 'function' ? pluginObj : pluginObj

      // 对标 DSH：将 YAML 中声明的 inject 注入到 plugin 对象上。
      // YAML 中的 inject 声明是声明式的（描述依赖关系），
      // 而 provider 代码中的函数形式插件可能没有设置 inject 属性。
      // Cordis 的 ctx.plugin() 会读取 plugin.inject 来决定依赖等待。
      if (entry.inject && entry.inject.length > 0) {
        if (typeof plugin === 'function') {
          // 函数形式插件：将 inject 附加为属性
          ;(plugin as any).inject = entry.inject
        } else if (typeof plugin === 'object' && plugin !== null) {
          // 对象形式插件：合并 inject（不覆盖已有的）
          if (!plugin.inject) {
            plugin.inject = entry.inject
          }
        }
      }

      // 注入 config（如果有）
      if (entry.config && typeof plugin === 'object') {
        if (!plugin.config) plugin.config = {}
        Object.assign(plugin.config, entry.config)
      }

      ctx.plugin(plugin as any)
      result.loaded.push(entry.id)
    } catch (err: any) {
      result.failed.push({
        name: entry.id,
        error: err.message || String(err),
      })
    }
  }

  console.log(
    `[YamlLoader] Loaded ${result.loaded.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`
  )

  // 对标 DSH fail-loud：报告失败但不终止启动（桌面应用不能 exit(1)）
  if (result.failed.length > 0) {
    const failures = result.failed.map(f => `  ${f.name}: ${f.error}`).join('\n')
    console.error(`[YamlLoader] ${result.failed.length} plugin(s) failed to load:\n${failures}`)
  }

  return result
}

/**
 * 验证所有已加载 fiber 是否已 ACTIVE。
 *
 * 对标 DSH 的 assertEntriesActivated：
 * - 检查每个 fiber 的状态
 * - PENDING: 报告正在等待哪些服务
 * - FAILED: 报告失败原因
 * - 非 ACTIVE 状态的 fiber 会被收集并抛出错误
 *
 * @param ctx Cordis Context
 * @param binName 诊断前缀
 * @throws 当有 fiber 未激活时
 */
export async function assertActivated(ctx: Context, binName: string = 'codem'): Promise<void> {
  const failures: string[] = []

  // 遍历所有 registry 中的 fiber
  ctx.registry.forEach((runtime: any) => {
    for (const fiber of runtime.fibers) {
      const name = fiber.name || 'unknown'
      // Fiber 状态常量: 0=PENDING, 1=LOADING, 2=ACTIVE, 3=FAILED, 4=DISPOSED, 5=UNLOADING
      const state = fiber.state

      if (state === 2 /* ACTIVE */) continue
      if (state === 4 /* DISPOSED */ || state === 5 /* UNLOADING */) continue

      if (state === 3 /* FAILED */) {
        const err = fiber._error || fiber.error || 'unknown error'
        failures.push(`${name}: FAILED — ${err}`)
      } else if (state === 0 /* PENDING */) {
        // 找出正在等待哪些服务
        const missing: string[] = []
        if (fiber.inject) {
          for (const service of Object.keys(fiber.inject)) {
            if (fiber.ctx?.get(service) === undefined) {
              missing.push(service)
            }
          }
        }
        const subject = missing.length === 1 ? 'service' : 'services'
        failures.push(`${name}: PENDING (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: state ${state}`)
      }
    }
  })

  if (failures.length > 0) {
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(
      `${binName}: ${failures.length} ${noun} did not activate\n${failures.join('\n')}`
    )
  }
}

/**
 * 合并 base 和 overlay 的 YAML 条目。
 *
 * 对标 DSH 的 bundle patch 机制：
 * - overlay 中同 id 的条目覆盖 base 中的条目
 * - overlay 中新增的条目追加到列表末尾
 * - overlay 中 `disabled: true` 的条目会将 base 中同 id 条目标记为禁用
 *
 * @param baseYml base 层 YAML 文本
 * @param overlayYml overlay 层 YAML 文本（如 codem.desktop.yml）
 * @returns 合并后的 YamlPluginEntry 数组
 */
export function mergeYamlEntries(baseYml: string, overlayYml: string): YamlPluginEntry[] {
  const baseEntries = parseCodemYaml(baseYml)
  const overlayEntries = parseCodemYaml(overlayYml)

  // 用 id 做 key，overlay 覆盖 base
  const merged = new Map<string, YamlPluginEntry>()
  for (const entry of baseEntries) {
    merged.set(entry.id, entry)
  }
  for (const entry of overlayEntries) {
    const existing = merged.get(entry.id)
    if (existing) {
      // 合并：overlay 的字段覆盖 base 的
      merged.set(entry.id, {
        ...existing,
        ...entry,
        // 如果 overlay 只是设置 disabled: true，保留 base 的其他字段
        inject: entry.inject ?? existing.inject,
        config: entry.config ?? existing.config,
      })
    } else {
      merged.set(entry.id, entry)
    }
  }

  return [...merged.values()]
}

/**
 * 从已合并的 YamlPluginEntry 数组加载插件。
 *
 * 与 loadFromYaml 相同，但跳过 YAML 解析步骤，直接使用已合并的条目数组。
 *
 * @param ctx Cordis Context
 * @param entries 已合并的插件条目数组
 * @returns 加载结果
 */
export function loadFromEntries(ctx: Context, entries: YamlPluginEntry[]): YamlLoadResult {
  const result: YamlLoadResult = {
    loaded: [],
    skipped: [],
    failed: [],
  }

  console.log(`[YamlLoader] Received ${entries.length} entries`)

  // 1. 过滤条件
  const activeEntries = entries.filter(entry => {
    if (entry.disabled) {
      result.skipped.push(`${entry.id} (disabled)`)
      return false
    }
    if (!evaluateWhen(entry.when)) {
      result.skipped.push(`${entry.id} (platform: ${entry.when})`)
      return false
    }
    return true
  })

  console.log(`[YamlLoader] ${activeEntries.length} active entries (${result.skipped.length} skipped)`)

  // 2. 拓扑排序
  const sorted = topologicalSort(activeEntries, builtinPlugins)

  // 3. 逐个加载
  for (const entry of sorted) {
    const registryEntry = findPluginInRegistry(entry.name, entry.id)
    if (!registryEntry) {
      result.failed.push({
        name: entry.id,
        error: `not found in builtin registry (name: ${entry.name})`,
      })
      continue
    }

    try {
      const pluginObj = registryEntry.apply()
      const plugin = typeof pluginObj === 'function' ? pluginObj : pluginObj

      // 对标 DSH：将 YAML 中声明的 inject 注入到 plugin 对象上
      if (entry.inject && entry.inject.length > 0) {
        if (typeof plugin === 'function') {
          ;(plugin as any).inject = entry.inject
        } else if (typeof plugin === 'object' && plugin !== null) {
          if (!plugin.inject) {
            plugin.inject = entry.inject
          }
        }
      }

      // 注入 config
      if (entry.config && typeof plugin === 'object') {
        if (!plugin.config) plugin.config = {}
        Object.assign(plugin.config, entry.config)
      }

      ctx.plugin(plugin as any)
      result.loaded.push(entry.id)
    } catch (err: any) {
      result.failed.push({
        name: entry.id,
        error: err.message || String(err),
      })
    }
  }

  console.log(
    `[YamlLoader] Loaded ${result.loaded.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`
  )

  // 对标 DSH fail-loud：报告失败但不终止启动（桌面应用不能 exit(1)）
  if (result.failed.length > 0) {
    const failures = result.failed.map(f => `  ${f.name}: ${f.error}`).join('\n')
    console.error(`[YamlLoader] ${result.failed.length} plugin(s) failed to load:\n${failures}`)
  }

  return result
}
function topologicalSort(
  entries: YamlPluginEntry[],
  registry: Map<string, { meta: any; apply: () => any }>
): YamlPluginEntry[] {
  const sorted: YamlPluginEntry[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (entry: YamlPluginEntry) => {
    if (visited.has(entry.id)) return
    if (visiting.has(entry.id)) {
      console.warn(`[YamlLoader] Circular dependency detected: ${entry.id}`)
      return
    }
    visiting.add(entry.id)

    // 查找此插件依赖的服务
    const injects = entry.inject || []
    if (injects.length > 0) {
      for (const dep of injects) {
        // 找到 provides 此服务的插件
        for (const other of entries) {
          if (other.id === entry.id || visited.has(other.id)) continue
          const regEntry = findPluginInRegistry(other.name, other.id)
          const provides = regEntry?.meta?.provides || []
          if (provides.includes(dep)) {
            visit(other)
          }
        }
      }
    }

    visiting.delete(entry.id)
    visited.add(entry.id)
    sorted.push(entry)
  }

  for (const entry of entries) {
    visit(entry)
  }

  return sorted
}
