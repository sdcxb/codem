// @ts-nocheck
/**
 * Notebook Provider 插件 — 笔记本服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const notebookProvider: Plugin = (ctx: any) => {
  const notebooks = new Map<string, any>()

  const dispose = ctx.provide('notebook', {
    create(title: string) { const id = crypto.randomUUID(); notebooks.set(id, { id, title, entries: [] }); return id },
    addEntry(notebookId: string, content: string) { notebooks.get(notebookId)?.entries.push(content) },
    get(notebookId: string) { return notebooks.get(notebookId) },
    list() { return [...notebooks.values()].map(({ id, title }) => ({ id, title })) },
    remove(notebookId: string) { notebooks.delete(notebookId) },
  })

  return dispose
}
