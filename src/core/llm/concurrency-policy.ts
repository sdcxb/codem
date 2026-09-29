/**
 * 工具并发安全名单 —— **唯一权威来源**。
 *
 * ## 为什么单独成文件
 *
 * 在 `streaming-executor.ts` `DEFAULT_CONFIG.concurrencySafeTools` 出现之前，同一个名单在**三处**各自硬编码：

 * | 位置 | 内容 |
 * | --- | --- |
 * | `streaming-executor.ts` `DEFAULT_CONFIG.concurrencySafeTools` | 9 个名字（**实际调度读的是这份**） |
 * | `tool-pipeline.ts` `initializeToolPipeline()` 的 `readOnlyTools` | 9 个名字（算出的 `concurrencySafe` **无人消费**） |
 * | `agentic-loop.ts` `RECON_TOOL_NAMES` | 23 个名字（语义不同：只表示「不推进宏步骤」，与并发无关） |
 *
 * 前两份还被注释写成「Extended concurrency-safe tools — **all read-only tools** can run
 * in parallel」，但**两份名单里大部分名字不对应任何内置工具**：
 *
 * - `read_file` / `list_directory` / `list_dir` / `codebase_search` /
 *   `file_search` / `web_fetch`
 *   —— 内置工具工厂里没有任何一个产出这些 id。它们只在 UI 的 `switch` 分支和
 *   `micro-compact` 的 `case` 里被**防御性**处理过，看起来像"支持"，实际是历史残留。
 *
 * 后果：名单声称覆盖 9 个只读工具，**真实生效的没几个**；而 `web_search`
 * （真实存在、确实只读）因为**不在任何名单里，一直被强制串行**。
 *
 * ## 维护规则
 *
 * 新增条目时**必须**是真工具 id。`src/test/tool-concurrency-list.test.ts` 会把本名单
 * 与「全仓所有 `id: "..."` 常量」交叉核对，收不在其中的名字就红。
 * 这条门禁存在的原因就是上面那批幽灵名能活这么久。
 *
 * ## 为什么不按参数判定（zcode 的 `classifyConcurrency(args)`）
 *
 * zcode 的判据带参数，可以让「读不同文件的两个 read 并发、读同一文件的两个 read 串行」。
 * 我方 `tool-pipeline.classifyConcurrency(args)` 的签名也支持，但**已注册的分类器
 * 全都是 `() => true`**（`tool-pipeline.ts` 内），即实际语义仍是「按工具名」。
 * 所以这里如实按名字表达，不假装支持参数级判定；等真有参数级需求时，
 * 改的是判据函数而不是这份名单。
 */

/**
 * 可与其他工具调用安全并发的工具 id（只读、无副作用、结果与执行顺序无关）。
 *
 * 判据：**只读**且**不依赖同一批次内其他调用的执行结果**。
 * 因此 `write` / `edit` / `multi_edit` / `bash` 一律不在列（它们有副作用，且
 * 后续调用常常依赖前一个的结果）。
 */
export const CONCURRENCY_SAFE_TOOL_IDS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "lsp",
  "web_search",
  // 由 zvec-grep MCP 服务器在运行时注册（`tools/zvec-tool.ts` 的
  // `createZvecTool()` 用 `id: name`，name 来自 MCP 工具清单），
  // 因此**任何静态扫描都看不到这两个 id**。
  // 它们是真实存在且只读的搜索工具，必须留在名单里，
  // 见 `DYNAMIC_TOOL_ID_ALLOWLIST`。
  "zvec_grep_search",
  "zvec_grep_rg",
];

/**
 * 静态扫描看不到、但**确实存在**的工具 id。
 *
 * ## 为什么需要这个例外名单
 *
 * `src/test/tool-concurrency-list.test.ts` 用「全仓 `id: "..."` 字面量」当真实 id 全集。
 * 这个口径覆盖内置工具，但**覆盖不到运行时才注册的工具**：
 *
 * - `zvec_grep_search` / `zvec_grep_rg`：来自外部 MCP 服务器（`zvec_grep`），
 *   由 `tools/zvec-tool.ts` 的 `createZvecTool()` 用 `id: name` 注册，
 *   name 是**运行时从 MCP 拿到的**，源码里没有字面量。
 *
 * ## 这个例外是怎么被发现的（值得记下来）
 *
 * 我第一次做这份名单时，正是用「静态扫描找不到」当依据，把
 * `zvec_grep_search` 判成了幽灵名并删掉 —— 于是
 * `zvec-tool-sync.test.ts` 与 `deep-closed-loop-audit.test.tsx` 立刻红了。
 * 那两条用例是对的：它们守的正是「zvec 搜索工具必须可并发，不许被误串行」。
 *
 * 结论：**「扫不到」≠「不存在」**。扫描口径只能覆盖内置工具，
 * 动态注册的必须显式登记在这里，而不是靠删名单来让门禁变绿。
 */
export const DYNAMIC_TOOL_ID_ALLOWLIST: readonly string[] = [
  "zvec_grep_search",
  "zvec_grep_rg",
];

/**
 * 兼容用的可变副本 —— `ToolExecutorConfig.concurrencySafeTools` 的默认值。
 *
 * 保留 `string[]`（而非 `readonly string[]`）是为了不改动既有公开配置类型的形状，
 * 调用方仍可整体覆盖它（测试大量这么做）。
 */
export const DEFAULT_CONCURRENCY_SAFE_TOOLS: string[] = [...CONCURRENCY_SAFE_TOOL_IDS];
