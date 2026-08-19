// @ts-nocheck
/**
 * @codem/tool-fs — 文件系统工具 Consumer
 *
 * 通过 ctx.fs 消费文件系统能力，注册 read/write/edit/glob/grep 工具。
 * 不直接依赖任何 Provider，切换 Provider 时无需修改此文件。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

export const inject = ['fs', 'tools'] as const

export function apply() {
  const ctx = useCtx()

  const fsTools = [
    defineTool({
      name: 'read',
      description: 'Read the contents of a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
      async execute({ path }: { path: string }) {
        const fs = ctx.get('fs')
        if (!fs) return 'FS not available'
        return fs.readFile(path)
      },
    }),
    defineTool({
      name: 'write',
      description: 'Write content to a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
      async execute({ path, content }: { path: string; content: string }) {
        const fs = ctx.get('fs')
        if (!fs) return 'FS not available'
        await fs.writeFile(path, content)
        return `Written to ${path}`
      },
    }),
    defineTool({
      name: 'list',
      description: 'List directory contents',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path' } },
        required: ['path'],
      },
      async execute({ path }: { path: string }) {
        const fs = ctx.get('fs')
        if (!fs) return 'FS not available'
        const entries = await fs.listDirectory(path)
        return entries.map(e => `${e.isDir ? '📁' : '📄'} ${e.name}`).join('\n')
      },
    }),
    defineTool({
      name: 'glob',
      description: 'Find files matching a glob pattern',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['pattern'],
      },
      async execute({ pattern, cwd }: { pattern: string; cwd?: string }) {
        const fs = ctx.get('fs')
        if (!fs) return 'FS not available'
        const files = await fs.glob(pattern, cwd)
        return files.join('\n')
      },
    }),
    defineTool({
      name: 'grep',
      description: 'Search file contents with regex',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          cwd: { type: 'string', description: 'Working directory' },
          glob: { type: 'string', description: 'File glob filter' },
        },
        required: ['pattern'],
      },
      async execute({ pattern, cwd, glob }: { pattern: string; cwd?: string; glob?: string }) {
        const fs = ctx.get('fs')
        if (!fs) return 'FS not available'
        const results = await fs.grep(pattern, cwd, glob)
        return results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n')
      },
    }),
  ]

  const toolsService = ctx.get('tools')
  if (toolsService) {
    fsTools.forEach(tool => toolsService.register(tool))
  }
}
