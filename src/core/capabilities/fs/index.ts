// @ts-nocheck
/**
 * @codem/fs — 文件系统能力族 Service Definition
 *
 * 定义文件系统接口契约。Provider 包（fs-local, fs-sandbox, fs-remote）
 * 实现此接口并注册到 ctx.fs。Consumer 包通过 ctx.fs 访问文件系统。
 *
 * 替代原有 seam/types.ts 中的 FileSystemSeam。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface FileSystem {
  readFile(path: string, cwd?: string): Promise<string>
  writeFile(path: string, content: string, cwd?: string): Promise<void>
  listDirectory(path: string): Promise<Array<{ name: string; isDir: boolean; size: number }>>
  deleteFile(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  glob(pattern: string, cwd?: string): Promise<string[]>
  grep(pattern: string, cwd?: string, glob?: string): Promise<Array<{ file: string; line: number; content: string }>>
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** 文件系统服务（可替换 Provider） */
    fs: FileSystem
  }
}

/**
 * FS 能力族 Provider 插件。
 * 注册文件系统服务定义到 Cordis Context。
 */
export const fsServiceDef = (ctx: Context) => {
  // Provider 在此注册实例到 ctx.fs
  // 默认无实现，等 fs-local Provider 加载后自动就绪
}
