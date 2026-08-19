// @ts-nocheck
/**
 * @codem/session-telemetry-otel — OpenTelemetry 遥测，分布式追踪和指标收集
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionTelemetryOtelProvider: Plugin = (ctx: any) => {
  const s = {
    tracer: { startSpan(n, o={}) { return {name:n,startTime:Date.now(),attributes:o.attributes||{},status:'active'} }, endSpan(sp, st) { sp.endTime=Date.now(); sp.duration=sp.endTime-sp.startTime; sp.status=st||'ok'; return sp } },
    meter: { createCounter(n) { return {value:0,add(v){this.value+=v},getValue(){return this.value}} }, createHistogram(n) { return {values:[],record(v){this.values.push(v)},getValues(){return this.values}} } },
    export(sp) { const t=ctx.get('telemetry'); if(t&&t.record)t.record('otel.span',{name:sp.name,duration:sp.duration,status:sp.status}) },
  }
  return ctx.provide('sessionTelemetryOtel', s)
}
