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
  /**
   * ⚠️ **语义 = 「已装配」（`ctx.plugin()` 没抛）**，**不是**「已激活」（第 184 波 F6）。
   *
   * Cordis 的激活是**异步**的：`fiber._reload` 先 `await Promise.resolve()` 再 `_execute`，
   * 失败时把错误写进 `_error` 并把 epoch 置 INACTIVE（`cordis/src/fiber.ts:647-665`）。
   * 所以 `ctx.plugin()` 返回之后立刻 push 进来的这条，只证明"装配调用没抛"。
   *
   * 想要"真的在跑"的口径，用 `settleActivation(result)`（本文件）或
   * `assertActivated(ctx)` —— 它们读的是 fiber 的真实状态。
   */
  loaded: string[]
  skipped: string[]
  failed: Array<{ name: string; error: string }>
  /**
   * **激活结算**后的真实口径（由 `settleActivation()` 填；未调用前为 `undefined`）。
   * `activated` + `notActivated` 覆盖 `loaded` 里的每一条。
   */
  activated?: string[]
  /** 已装配但没进入 ACTIVE 的条目（激活抛错 / 一直在等依赖） */
  notActivated?: Array<{ id: string; name: string; reason: string }>
  /**
   * 装配时留下的 fiber 句柄（**内部字段**，不参与日志/序列化）。
   * `settleActivation` 靠它把"装配"结算成"真的激活了没有"。
   */
  handles?: Array<{ id: string; name: string; fiber: any }>
}

// ===== 装配 fiber 登记（对标 dsh 卸载语义） =====
/**
 * name（@codem/*）→ 装配时 ctx.plugin 创建的 fiber。
 *
 * PluginManagerService 的"禁用"需要真正卸载 Cordis 里由 YAML 装配的插件
 * （否则只是改状态——插件/服务/工具仍在 ctx 运行 = 假禁用）。装配入口
 * （loadFromYaml / loadFromEntries）每 ctx.plugin 一个插件即在此登记，
 * manager.disable 通过 getActiveFiber 找到 fiber 并 dispose。
 */
const activeFibers = new Map<string, any>()

/** 登记装配 fiber（装配入口调用） */
function registerActiveFiber(name: string, fiber: any): void {
  activeFibers.set(name, fiber)
}

/** 注销装配 fiber（manager 真卸载后调用） */
export function unregisterActiveFiber(name: string): void {
  activeFibers.delete(name)
}

/** 取某插件由 YAML 装配创建的 fiber（未装配/已卸载返回 undefined） */
export function getActiveFiber(name: string): any {
  return activeFibers.get(name)
}

/**
 * 仅供测试：直接登记一个装配 fiber（不经过 `ctx.plugin`）。
 *
 * 用途：`PluginManagerService.doDisable` 对"装配过但没有可卸载句柄"这一形态的报账
 * （第 184 波 F5：`everLoaded && !unloaded` 那条 warn）需要造出这个状态，
 * 而生产路径（`loadFromEntries`）要拉起真实的 builtin 插件才能造 —— 那会把用例
 * 变成启动装配测试。这里只暴露**登记**这一件事，行为本身仍由 `doDisable` 决定。
 */
export function __registerActiveFiberForTest(name: string, fiber: any): void {
  registerActiveFiber(name, fiber)
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
function parseCodemYaml(content: string): YamlPluginEntry[] {
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
function evaluateWhen(when: string | undefined): boolean {
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

      const fiber = ctx.plugin(plugin as any)
      registerActiveFiber(entry.name, fiber)
      /**
       * ⚠️ 这里进的是「已装配」名单（第 184 波 F6）：`ctx.plugin()` 返回只说明
       * 装配调用没抛，激活是异步的（见 `YamlLoadResult.loaded` 的说明）。
       * 真实激活口径由 `settleActivation(result)` 结算。
       */
      result.loaded.push(entry.id)
      result.handles = result.handles ?? []
      result.handles.push({ id: entry.id, name: entry.name, fiber })
    } catch (err: any) {
      result.failed.push({
        name: entry.id,
        error: err.message || String(err),
      })
    }
  }

  console.log(
    `[YamlLoader] Assembled ${result.loaded.length}, skipped ${result.skipped.length}, failed ${result.failed.length}` +
      `（"assembled" ≠ "activated"：激活是异步的，真实口径见 settleActivation）`
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

/** 激活结算的默认等待上限（与应用启动时等 fiber 的那个上限同量级） */
const ACTIVATION_SETTLE_TIMEOUT_MS = 10_000

/**
 * 把一个 `YamlLoadResult` 的「已装配」名单**结算成真实激活口径**（第 184 波 F6）。
 *
 * ## 为什么必须有这一步
 *
 * `ctx.plugin()` 不抛 ≠ 插件在跑：Cordis 的 `_reload` 先 `await Promise.resolve()` 再
 * `_execute`，插件抛错时错误只写进 `fiber._error`（`cordis/src/fiber.ts:647-665`），
 * 而 `loadFromEntries` 早在那一刻之前就把条目记进了 `loaded`。
 * 于是启动日志里的「Loaded 60, failed 0」只是**愿望清单** —— 与"真的在跑多少"是两个口径。
 *
 * ## 语义
 *
 * - 等每个已装配 fiber 结算（`fiber.await()`，**有界**：超时按未激活记）；
 * - 真的 ACTIVE ⇒ 进 `activated`；
 * - 抛错 / 一直没进入 ACTIVE ⇒ 进 `notActivated`（带原因）**并追加进 `failed`**
 *   —— 这样既有的 fail-loud 分支（`failed.length > 0` 打 error）会照实报出来，
 *   启动汇总也不再可能说"成功"。
 *
 * 等的是**并行**的（`Promise.all`），所以不会把启动串行化。
 */
export async function settleActivation(
  result: YamlLoadResult,
  timeoutMs: number = ACTIVATION_SETTLE_TIMEOUT_MS,
): Promise<YamlLoadResult> {
  const handles = result.handles ?? []
  const activated: string[] = []
  const notActivated: Array<{ id: string; name: string; reason: string }> = []

  await Promise.all(
    handles.map(async ({ id, name, fiber }) => {
      let reason = ''
      let timer: any
      try {
        await Promise.race([
          typeof fiber?.await === 'function' ? fiber.await() : Promise.resolve(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`等待激活超过 ${timeoutMs}ms`)),
              timeoutMs,
            )
          }),
        ])
      } catch (err: any) {
        reason = err?.message || String(err)
      } finally {
        if (timer) clearTimeout(timer)
      }
      // FiberState: 2 = ACTIVE（与 assertActivated 同一张表）
      if (!reason && fiber?.state !== 2) {
        reason = `激活未完成（state=${fiber?.state}）`
      }
      if (reason) {
        notActivated.push({ id, name, reason })
        result.failed.push({ name: id, error: reason })
      } else {
        activated.push(id)
      }
    }),
  )

  result.activated = activated
  result.notActivated = notActivated

  console.log(
    `[YamlLoader] 激活结算：assembled ${handles.length} ⇒ activated ${activated.length}` +
      `，not activated ${notActivated.length}` +
      (notActivated.length > 0
        ? `（${notActivated.map((n) => `${n.id}: ${n.reason}`).join('；')}）`
        : ''),
  )

  if (notActivated.length > 0) {
    const detail = notActivated.map((n) => `  ${n.id}（${n.name}）: ${n.reason}`).join('\n')
    console.error(`[YamlLoader] ${notActivated.length} plugin(s) 装配了但没有激活：\n${detail}`)
  }

  return result
}

/**
 * 启动汇总的**唯一**口径（第 184 波 F6，纯函数）。
 *
 * ## 为什么需要它
 *
 * 改前 `App.tsx` 把唯一的权威校验 `assertActivated` 的失败降级成一行
 * `console.error`（"不终止启动"），随后**同一个函数**照样打印
 * `getCordisContext completed successfully` —— 必要插件（llm/tools/session/store…）
 * 没激活时日志仍称成功，排障时被这句成功日志误导（正是"会撒谎的汇总比没有汇总更糟"）。
 *
 * 现在汇总只有这一处：只要有未激活的条目，就**不许**出现 "completed successfully"。
 *
 * @param activationErrors 未激活条目的说明（来自 `settleActivation().notActivated` 或
 *        `assertActivated` 抛出的错误信息）
 */
export function formatBootCompletion(activationErrors: string[]): { ok: boolean; message: string } {
  const errors = (activationErrors ?? []).filter(Boolean)
  if (errors.length === 0) {
    return { ok: true, message: '[Cordis] getCordisContext completed successfully' }
  }
  return {
    ok: false,
    message:
      `[Cordis] getCordisContext finished WITH FAILURES: ${errors.length} 个插件未激活 —— ` +
      `本次启动不完整（功能可能静默缺失），**不是**成功启动：\n${errors.join('\n')}`,
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

      const fiber = ctx.plugin(plugin as any)
      registerActiveFiber(entry.name, fiber)
      /**
       * ⚠️ 这里进的是「已装配」名单（第 184 波 F6）：`ctx.plugin()` 返回只说明
       * 装配调用没抛，激活是异步的（见 `YamlLoadResult.loaded` 的说明）。
       * 真实激活口径由 `settleActivation(result)` 结算。
       */
      result.loaded.push(entry.id)
      result.handles = result.handles ?? []
      result.handles.push({ id: entry.id, name: entry.name, fiber })
    } catch (err: any) {
      result.failed.push({
        name: entry.id,
        error: err.message || String(err),
      })
    }
  }

  console.log(
    `[YamlLoader] Assembled ${result.loaded.length}, skipped ${result.skipped.length}, failed ${result.failed.length}` +
      `（"assembled" ≠ "activated"：激活是异步的，真实口径见 settleActivation）`
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
