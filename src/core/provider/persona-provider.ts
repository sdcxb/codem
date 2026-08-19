// @ts-nocheck
/**
 * @codem/persona — 人格管理，Agent 人格配置和行为风格切换
 */
import type { Plugin } from '../cordis/src/index.ts'

export const personaProvider: Plugin = (ctx: any) => {
  const s = {
    personas: new Map([['default',{name:'Default',systemPrompt:'You are a helpful assistant.',tone:'neutral'}],['developer',{name:'Developer',systemPrompt:'You are an expert developer.',tone:'technical'}],['creative',{name:'Creative',systemPrompt:'You are a creative writer.',tone:'casual'}]]),
    active: 'default',
    get(name) { return this.personas.get(name||this.active) },
    set(name, persona) { this.personas.set(name, persona) },
    setActive(name) { if(this.personas.has(name))this.active=name },
    list() { return [...this.personas.values()] },
    buildPrompt() { return this.get()?.systemPrompt||'You are a helpful assistant.' },
  }
  return ctx.provide('persona', s)
}
