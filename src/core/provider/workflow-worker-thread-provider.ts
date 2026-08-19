// @ts-nocheck
/**
 * @codem/workflow-worker-thread — Worker 线程工作流，多线程并行任务执行
 */
import type { Plugin } from '../cordis/src/index.ts'

export const workflowWorkerThreadProvider: Plugin = (ctx: any) => {
  const s = {
    workers: new Map(),
    async create(id, scriptPath) { const {Worker}=await import('worker_threads'); try{const w=new Worker(scriptPath); this.workers.set(id,w); return{id,worker:w,status:'running'}}catch(e){return{id,worker:null,status:'error',error:e.message}} },
    async send(id, message) { const w=this.workers.get(id); if(!w)return; w.postMessage(message) },
    async terminate(id) { const w=this.workers.get(id); if(w)await w.terminate(); this.workers.delete(id) },
    list() { return [...this.workers.keys()] },
  }
  return ctx.provide('workflowWorkerThread', s)
}
