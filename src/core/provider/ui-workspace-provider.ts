// @ts-nocheck
/**
 * @codem/uiWorkspace — UI Provider
 *
 * app.workspace slot 已移除 — FileExplorer 已由 ui-panels 注册到 app.file-explorer slot。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiWorkspaceProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const store=ctx.get('appStore'); const state=store&&store.getState?store.getState():{}; return {type:'workspace-panel',projects:state.projects||[]} },
    async openProject(path) { return {path,opened:true} },
    async closeProject() { return {closed:true} },
    async listFiles(dir) { const fs=ctx.get('fs'); return fs&&fs.readdir?fs.readdir(dir):[] },
  }

  const disp = ctx.provide('uiWorkspace', s)

  return () => {
    if (disp) disp()
  }
}
