// @ts-nocheck
/**
 * @codem/uiAttachment — UI Provider
 *
 * app.attachment slot 已移除 — FileUpload 无独立消费点，
 * 附件功能内嵌在 InputArea 中。此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiAttachmentProvider: Plugin = (ctx: any) => {
  const s = {
    render(attachment) { return {type:'attachment-view',data:attachment} },
    async preview(file) { return {name:file.name,size:file.size,type:file.type,preview:'data:'+file.type+';base64,'} },
    async upload(file) { const att=ctx.get('attachments'); if(att&&att.add)return att.add(file); return {id:'att-'+Date.now(),...file} },
  }

  const disp = ctx.provide('uiAttachment', s)

  return () => {
    if (disp) disp()
  }
}
