// @ts-nocheck
/**
 * Notebook Provider 插件 — 包装真实知识管理模块并接入 ctx。
 *
 * 真实实现源：
 * - src/core/knowledge/storage.ts（SQLite 持久化）
 * - src/core/knowledge/note-manager.ts（笔记 CRUD 管理）
 * - src/core/llm/tools/note-operations.ts（create_note/edit_note/link_notes/delete_note 工具）
 *
 * 接入点：
 * - LLM 工具 note_* 系列通过 ctx.notebook 操作笔记
 * - UI 知识管理面板通过 ctx.notebook.list() 展示笔记列表
 */
import type { Plugin } from '../cordis/src/index.ts'
import { NoteManager } from '../knowledge/note-manager.ts'

export const notebookProvider: Plugin = (ctx: any) => {
  const manager = new NoteManager(ctx)

  const dispose = ctx.provide('notebook', {
    async create(title: string, content: string, tags?: string[]): Promise<string> {
      return manager.createNote(title, content, tags)
    },
    async edit(noteId: string, updates: any): Promise<void> {
      return manager.editNote(noteId, updates)
    },
    async delete(noteId: string): Promise<void> {
      return manager.deleteNote(noteId)
    },
    async get(noteId: string): Promise<any> {
      return manager.getNote(noteId)
    },
    async list(query?: { tags?: string[]; search?: string }): Promise<any[]> {
      return manager.listNotes(query)
    },
    async link(noteId1: string, noteId2: string, type?: string): Promise<void> {
      return manager.linkNotes(noteId1, noteId2, type)
    },
    async unlink(noteId1: string, noteId2: string): Promise<void> {
      return manager.unlinkNotes(noteId1, noteId2)
    },
    async getLinks(noteId: string): Promise<any[]> {
      return manager.getNoteLinks(noteId)
    },
  })

  return dispose
}
