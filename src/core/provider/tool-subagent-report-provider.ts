// @ts-nocheck
/**
 * @codem/tool-subagent-report — 子 Agent 报告工具，收集和汇总子 Agent 执行结果
 */
import type { Plugin } from '../cordis/src/index.ts'

export const toolSubagentReportProvider: Plugin = (ctx: any) => {
  const s = {
    reports: new Map(),
    generate(agentId) { const sub=ctx.get('subagent'); let info={}; if(sub){const a=sub.get?sub.get(agentId):null; if(a)info=a} const report={agentId,generatedAt:Date.now(),status:info.status||'unknown',summary:'Subagent report (simulated)',metrics:{duration:0,toolCalls:0,messages:0}}; this.reports.set(agentId,report); return report },
    get(agentId) { return this.reports.get(agentId) },
    list() { return [...this.reports.values()] },
    compare(ids) { return ids.map(id=>this.reports.get(id)).filter(Boolean) },
  }
  return ctx.provide('toolSubagentReport', s)
}
