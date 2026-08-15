// @ts-nocheck
/**
 * FS Provider 插件 — 文件系统服务，可独立加载/卸载/热替换。
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
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) await invoke('delete_file', { path })
    },
    exists: async (path: string) => {
      try {
        const { listDirectory } = await import('../file-api')
        const parent = path.split(/[\\/]/).slice(0, -1).join('/') || '/'
        const name = path.split(/[\\/]/).pop() || ''
        const entries = await listDirectory(parent)
        return entries.some(e => e.name === name)
      } catch { return false }
    },
    glob: async (pattern: string, cwd?: string) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) return await invoke('glob_files', { pattern, cwd: cwd || '.' })
      return []
    },
    grep: async (pattern: string, cwd?: string, glob?: string) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) return await invoke('grep_files', { pattern, cwd: cwd || '.', glob: glob || '*' })
      return []
    },
  })

  return dispose
}
