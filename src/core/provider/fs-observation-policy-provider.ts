// @ts-nocheck
/**
 * @codem/fs-observation-policy — 文件观察策略，监控变更的频率和范围控制
 */
import type { Plugin } from '../cordis/src/index.ts'

export const fsObservationPolicyProvider: Plugin = (ctx: any) => {
  const s = {
    policies: new Map(), default: {ignoreDotFiles:true,ignorePatterns:['node_modules','.git','dist'],debounceMs:100,maxWatchers:50},
    set(p, pol) { this.policies.set(p, {...this.default,...pol}) },
    get(p) { return this.policies.get(p||'')||this.default },
    shouldIgnore(fp, pp) { const pol=this.get(pp); if(pol.ignoreDotFiles&&fp.startsWith('.'))return true; return pol.ignorePatterns?.some(x=>fp.includes(x))||false },
    getDebounce(pp) { return this.get(pp).debounceMs||100 },
  }
  return ctx.provide('fsObservationPolicy', s)
}
