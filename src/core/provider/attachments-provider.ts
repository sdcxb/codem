// @ts-nocheck
/**
 * Attachments Provider 插件 — 内容寻址附件存储。
 *
 * 功能链：
 * - 上游：read_attachment 工具（src/core/llm/tools/read-attachment.ts）
 *         用户上传文件（App.tsx → useAppStore.addAttachment）
 * - 下游：LLM 获取附件内容进行推理
 * - 接入点：read-attachment.ts L26 → extractAttachmentsFromStore() 改为从 ctx.attachments 读取
 *           store.ts L210-L211 → addAttachment/removeAttachment 改为调用 ctx.attachments
 *
 * 当前为空壳实现，真实实现需：
 * 1. 包装 storage/message.ts 的 loadAttachmentsForMessage() + listAllAttachments() 作为底层存储
 * 2. ctx.attachments.store(content) → 存入 SQLite attachments 表，返回 hash
 * 3. read_attachment 工具改为 ctx.attachments.get(hash) 读取（不再直接访问 useAppStore）
 * 4. 未来扩展：支持远程附件存储（S3/OSS）
 */
import type { Plugin } from '../cordis/src/index.ts'

export const attachmentsProvider: Plugin = (ctx: any) => {
  const attachmentStore = new Map<string, string | Uint8Array>()

  const dispose = ctx.provide('attachments', {
    async store(content: string | Uint8Array): Promise<string> {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hash = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('')
      attachmentStore.set(hash, content)
      return hash
    },
    async get(hash: string): Promise<string | Uint8Array | undefined> {
      return attachmentStore.get(hash)
    },
    async delete(hash: string): Promise<void> {
      attachmentStore.delete(hash)
    },
  })

  return dispose
}
