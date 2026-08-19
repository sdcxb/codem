// @ts-nocheck
/**
 * @codem/session-log-export — 会话日志导出，支持 JSON/Markdown/HTML 格式
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionLogExportProvider: Plugin = (ctx: any) => {
  const s = {
    async export(id, fmt='json') { const sess=ctx.get('session'); const msgs=sess&&sess.getMessages?sess.getMessages(id):[]; switch(fmt){case'json':return JSON.stringify({sessionId:id,messages:msgs,exportedAt:Date.now()},null,2);case'markdown':return msgs.map(m=>'### '+(m.role||'unknown')+'\n\n'+(m.content||'')).join('\n\n---\n\n');case'html':return'<html><body>'+msgs.map(m=>'<div class="msg '+(m.role||'')+'">'+(m.content||'')+'</div>').join('')+'</body></html>';default:return JSON.stringify(msgs)} },
    async exportToFile(id, fp, fmt) { const {writeFileSync}=await import('fs'); writeFileSync(fp, await this.export(id, fmt||'json'), 'utf8'); return fp },
  }
  return ctx.provide('sessionLogExport', s)
}
