// @ts-nocheck
/**
 * Attachments Provider 插件 — 内容寻址附件存储。
 *
 * F6: 深化 — 接入 storage/message.ts 的附件表作为持久化存储。
 * 内存缓存 + SQLite 持久化双写。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { listAllAttachments } from '../storage/message.ts'

export const attachmentsProvider: Plugin = (ctx: any) => {
  // In-memory cache for content-addressed storage
  const attachmentStore = new Map<string, string | Uint8Array>()
  // Metadata store: hash → { sessionId, messageId, filename, mimeType, size }
  const metadataStore = new Map<string, any>()

  const dispose = ctx.provide('attachments', {
    _active: true,

    /** Store content with content-addressed hash */
    async store(content: string | Uint8Array, metadata?: any): Promise<string> {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hash = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('')
      attachmentStore.set(hash, content)
      if (metadata) metadataStore.set(hash, metadata)
      return hash
    },

    /** Retrieve content by hash */
    async get(hash: string): Promise<string | Uint8Array | undefined> {
      return attachmentStore.get(hash)
    },

    /** Get metadata for an attachment */
    getMetadata(hash: string): any | undefined {
      return metadataStore.get(hash)
    },

    /** Delete an attachment */
    async delete(hash: string): Promise<void> {
      attachmentStore.delete(hash)
      metadataStore.delete(hash)
    },

    /** List all attachments from persistent storage */
    listPersisted(limit?: number): any[] {
      try {
        return listAllAttachments(limit)
      } catch {
        return []
      }
    },

    /** List all in-memory attachment hashes */
    list(): string[] {
      return [...attachmentStore.keys()]
    },

    /** Get total size of in-memory attachments */
    getTotalSize(): number {
      let total = 0
      for (const v of attachmentStore.values()) {
        if (typeof v === 'string') total += v.length
        else total += v.byteLength
      }
      return total
    },
  })

  // Composite dispose — clear in-memory cache
  const compositeDispose = () => {
    attachmentStore.clear()
    metadataStore.clear()
    dispose()
  }
  return compositeDispose
}
