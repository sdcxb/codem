// @ts-nocheck
/**
 * @codem/pwsh-sandbox — 沙箱内 PowerShell 执行，隔离环境命令运行
 */
import type { Plugin } from '../cordis/src/index.ts'

export const pwshSandboxProvider: Plugin = (ctx: any) => {
  const s = {
    async exec(cmd, o={}) { const sb=ctx.get('sandbox'); if(sb&&sb.exec)return sb.exec('pwsh',['-Command',cmd],o); const sh=ctx.get('shell'); if(sh&&sh.exec)return sh.exec('pwsh -Command '+cmd,o); throw new Error('No sandbox or shell') },
    async execScript(p, o={}) { return this.exec('& '+p, o) },
  }
  return ctx.provide('pwshSandbox', s)
}
