// @ts-nocheck
/**
 * @codem/sdk-client — SDK 客户端，外部程序连接和调用接口
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sdkClientProvider: Plugin = (ctx: any) => {
  const s = {
    async connect(url, opts={}) { return {url,connected:true,opts} },
    async call(method, params) { const sdk=ctx.get('sdkProtocol'); if(sdk&&sdk.call)return sdk.call(method, params); throw new Error('SDK protocol not available') },
    async disconnect() { return true },
    on(event, cb) { /* event listener */ },
  }
  return ctx.provide('sdkClient', s)
}
