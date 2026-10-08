// @ts-nocheck
/**
 * FS Provider 插件 — 文件系统服务，可独立加载/卸载/热替换。
 *
 * ★ 本轮（FSW）修的是**死接线 + 静默失败**：
 *
 * 1. `glob` 原来调 `invoke('glob_files')`、`grep` 原来调 `invoke('grep_files')`，
 *    而这两个命令在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里**都不存在**
 *    （`grep glob_files src-tauri/` = 0 命中）⇒ 真机上一调必抛「命令不存在」；
 * 2. 拿不到 `invoke` 时 `return []` ⇒ 把「我做不到」说成「没有匹配文件」。
 *
 * 修法：**接上真实存在的通道**（这个 provider 是活的 —— `builtin-registry.ts:288`
 * 注册为 `@codem/fs-local`，`provider/index.ts:229` 也装配它，`tools.ts:120` 真的在
 * `ctx.get('fs')`），不再自己拼 Rust 命令名：
 *   - `glob` → `file-api.globSearch`（底层 `glob_search`，第 186 波起是**结构化返回**）；
 *   - `grep` → `file-api.grepSearch`（底层是 PowerShell `Select-String`，**本来就没有**
 *     Rust 侧 grep 命令 —— 见 `file-api.ts:520`）；
 *   - 失败一律**抛错**，不再有任何 `return []` 的降级支。
 *
 * 判据：`src/test/fs-provider-invoke-surface.test.ts`（FSW-1..4，含变异自证）。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const fsProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('fs', {
    readFile: async (path: string, cwd?: string) => {
      const { readFile } = await import('../file-api')
      const resolvedPath = (cwd && !path.startsWith('/') && !path.match(/^[A-Za-z]:/))
        ? `${cwd.replace(/[/\\]+$/, '')}/${path}` : path
      return readFile(resolvedPath)
    },
    writeFile: async (path: string, content: string, cwd?: string) => {
      const { writeFile } = await import('../file-api')
      return writeFile(path, content, { workspace: cwd })
    },
    listDirectory: async (path: string) => {
      const { listDirectory } = await import('../file-api')
      const entries = await listDirectory(path)
      return entries.map(e => ({ name: e.name, isDir: e.isDirectory, size: 0 }))
    },
    deleteFile: async (path: string) => {
      /**
       * ★ 宿主不存在也要能诊断：改前直接写 `(window as any).__TAURI__?.core`，
       * 在**没有 window 的宿主**（node / worker）里抛的是 `ReferenceError: window is not defined`
       * —— 抛是抛了，但看不出"缺的是 IPC 通道"。
       */
      const host = typeof window === 'undefined' ? undefined : (window as any).__TAURI__
      const { invoke } = host?.core || {}
      /**
       * ★ 不许静默：原来没有 `invoke` 就什么都不做 —— 调用方以为删掉了，其实没删。
       * （`local-fs-provider.deleteFile` 那句 `catch {}` 是同一个形态，但它已是 deprecated 壳。）
       */
      if (!invoke) {
        throw new Error(`[fs-provider] deleteFile("${path}") 失败：没有 __TAURI__.core.invoke（非 Tauri 宿主），删除未执行`)
      }
      await invoke('delete_file', { path })
    },
    exists: async (path: string) => {
      const { listDirectory } = await import('../file-api')
      const parent = path.split(/[\\/]/).slice(0, -1).join('/') || '/'
      const name = path.split(/[\\/]/).pop() || ''
      /**
       * ★ 不许静默：原来 `catch { return false }` 把「父目录读不了」说成「文件不存在」
       * —— 那正是 `grepSearch` 在 `file-api.ts:533` 反复踩过的"假否定"。
       * 父目录读不成 ⇒ 抛错（调用方自己去决定要不要当成不存在）。
       */
      const entries = await listDirectory(parent)
      return entries.some(e => e.name === name)
    },
    /**
     * 按 glob 匹配文件。
     *
     * 走 `file-api.globSearch` —— 它自己负责工作区判定（`cwd` 当 workspace 传下去，
     * 与 `seam/local-fs-provider.glob` 同一个口径）、模式越界判定与 30s 超时。
     * **本层不再自己拼 `invoke('…')`**：命令名只有一处定义（`file-api.ts`），
     * 也就不会再出现"provider 调了个不存在的命令、`@ts-nocheck` 又看不见"这种事。
     *
     * 返回**结构化结果原样透传**（`{ files, truncated, depth_limited, returned, hint? }`）：
     * 形状与 `file-api.GlobSearchResult`、`seam/types.ts:129` 的 `FileSystemSeam.glob` **同一份**。
     * 拆成裸 `string[]` 就等于把 `truncated` / `depth_limited` / `hint` 丢在这一层，调用方
     * 会把有界的一段当全量 —— 那正是第 186 波要修掉的失真。
     */
    glob: async (pattern: string, cwd?: string) => {
      const { globSearch } = await import('../file-api')
      return globSearch(pattern, cwd, { workspace: cwd })
    },
    /**
     * 按内容检索。
     *
     * 走 `file-api.grepSearch`（PowerShell `Select-String`）。**没有** `grep_files` 这个
     * Rust 命令 —— 改前那行是死接线，真机必抛 `Command grep_files not found`。
     * 形状与 `local-fs-provider.grep` 一致：`[{ file, line, content }]`，其中 `line`/`content`
     * 是 `file-api` 从 `path:line:text` 里拆出来的。
     */
    grep: async (pattern: string, cwd?: string, glob?: string) => {
      const { grepSearch } = await import('../file-api')
      const results = await grepSearch(pattern, cwd, glob, { workspace: cwd })
      return results.map((r: string) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(r)
        return m ? { file: m[1], line: Number(m[2]), content: m[3] } : { file: r, line: 0, content: r }
      })
    },
  })

  return dispose
}
