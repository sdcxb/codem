// @ts-nocheck
/**
 * @codem/tmux-context — Tmux 上下文管理，终端会话复用和窗口管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const tmuxContextProvider: Plugin = (ctx: any) => {
  const s = {
    sessions: new Map(),
    async createSession(n) { const sh=ctx.get('shell'); if(sh&&sh.exec)await sh.exec('tmux new-session -d -s '+n); const ss={name:n,windows:[],activeWindow:0}; this.sessions.set(n,ss); return ss },
    async newWindow(sn, t) { const sh=ctx.get('shell'); if(sh&&sh.exec)await sh.exec('tmux new-window -t '+sn+' -n '+t); const ss=this.sessions.get(sn); if(ss)ss.windows.push({title:t,panes:[]}) },
    async sendKeys(sn, wi, k) { const sh=ctx.get('shell'); if(sh&&sh.exec)await sh.exec('tmux send-keys -t '+sn+':'+wi+' "'+k+'" Enter') },
    async captureOutput(sn, wi) { const sh=ctx.get('shell'); if(sh&&sh.exec){const r=await sh.exec('tmux capture-pane -t '+sn+':'+wi+' -p'); return r?.stdout||''} return '' },
    async killSession(n) { const sh=ctx.get('shell'); if(sh&&sh.exec)await sh.exec('tmux kill-session -t '+n); this.sessions.delete(n) },
  }
  return ctx.provide('tmuxContext', s)
}
