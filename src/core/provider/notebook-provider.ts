/**
 * Notebook Provider 插件 — 包装知识管理模块并接入 ctx。
 *
 * 真实实现源：
 * - src/core/knowledge/storage.ts（SQLite 持久化）
 * - src/core/knowledge/note-manager.ts（笔记 CRUD 管理）
 *
 * 接入点：
 * - LLM 工具 note_* 系列通过 ctx.notebook 操作笔记
 * - UI 知识管理面板通过 ctx.notebook.list() 展示笔记列表
 */
import type { Plugin } from '../cordis/src/index.ts'
import * as NoteStorage from '../knowledge/storage.ts'
import { getOutgoingLinks, getIncomingLinks, parseWikiLinks, syncNoteLinks } from '../knowledge/note-manager.ts'

export const notebookProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('notebook', {
    async create(title: string, content: string, tags?: string[], notebookId?: string): Promise<string> {
      const note = NoteStorage.createNote({ notebookId: notebookId || "default", title, content, tags })
      return note.id
    },
    async edit(noteId: string, updates: any): Promise<void> {
      NoteStorage.updateNote(noteId, updates)
    },
    async delete(noteId: string): Promise<void> {
      NoteStorage.deleteNote(noteId)
    },
    async get(noteId: string): Promise<any> {
      return NoteStorage.getNote(noteId)
    },
    async list(notebookId?: string): Promise<any[]> {
      return NoteStorage.listNotes(notebookId || "default")
    },
    async search(query: string, notebookId?: string): Promise<any[]> {
      const notes = NoteStorage.listNotes(notebookId || "default")
      return notes.filter(n => n.title.includes(query) || (n.content || "").includes(query))
    },
    getOutgoingLinks(noteId: string) {
      return getOutgoingLinks(noteId)
    },
    getIncomingLinks(noteId: string) {
      return getIncomingLinks(noteId)
    },
    parseWikiLinks(content: string) {
      return parseWikiLinks(content)
    },
    syncNoteLinks(noteId: string, notebookId: string, content: string) {
      return syncNoteLinks(noteId, notebookId, content)
    },
  })

  return dispose
}
