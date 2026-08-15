// @ts-nocheck
/**
 * @codem/fs-local — 本地文件系统 Provider
 *
 * 使用 Tauri 的文件 API 实现文件系统接口。
 * 包装现有 seam/local-fs-provider.ts 的实现。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { FileSystem } from './index.ts'

export class LocalFileSystem implements FileSystem {
  constructor(private ctx: Context) {}

  async readFile(path: string, cwd?: string): Promise<string> {
    const { readFile } = await import('../../file-api')
    const resolvedPath = (cwd && !path.startsWith('/') && !path.match(/^[A-Za-z]:/))
      ? `${cwd.replace(/[/\\]+$/, '')}/${path}`
      : path
    return readFile(resolvedPath)
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    const { writeFile } = await import('../../file-api')
    return writeFile(path, content, { workspace: cwd })
  }

  async listDirectory(path: string): Promise<Array<{ name: string; isDir: boolean; size: number }>> {
    const { listDirectory } = await import('../../file-api')
    const entries = await listDirectory(path)
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory, size: 0 }))
  }

  async deleteFile(path: string): Promise<void> {
    const { invoke } = (window as any).__TAURI__?.core || {}
    if (invoke) {
      await invoke('delete_file', { path })
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { listDirectory } = await import('../../file-api')
      const parent = path.split(/[\\/]/).slice(0, -1).join('/') || '/'
      const name = path.split(/[\\/]/).pop() || ''
      const entries = await listDirectory(parent)
      return entries.some(e => e.name === name)
    } catch {
      return false
    }
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    const { invoke } = (window as any).__TAURI__?.core || {}
    if (invoke) {
      return await invoke('glob_files', { pattern, cwd: cwd || '.' })
    }
    return []
  }

  async grep(pattern: string, cwd?: string, glob?: string): Promise<Array<{ file: string; line: number; content: string }>> {
    const { invoke } = (window as any).__TAURI__?.core || {}
    if (invoke) {
      return await invoke('grep_files', { pattern, cwd: cwd || '.', glob: glob || '*' })
    }
    return []
  }
}

export const inject = [] as const
export const provide = ['fs'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('fs', new LocalFileSystem(ctx))
}
