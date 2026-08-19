// @ts-nocheck
/**
 * @codem/typert-protocol — 类型协议插件 (P2-7.15)
 *
 * 定义工具调用和 LLM 交互的类型协议。
 *
 * 功能链路融入（文档 6.2 链路 A+B: LLM + 工具执行链 → 类型校验）：
 * - 启动时：注册类型协议，工具调用前校验参数类型
 * - 停止时：不校验类型，可能出现参数不匹配
 */
import type { Plugin } from '../cordis/src/index.ts'

interface TypeProtocol {
  toolName: string
  inputSchema: any
  outputSchema: any
}

class TypertProtocol {
  private protocols: Map<string, TypeProtocol> = new Map()

  registerProtocol(protocol: TypeProtocol) {
    this.protocols.set(protocol.toolName, protocol)
  }

  unregisterProtocol(toolName: string) {
    this.protocols.delete(toolName)
  }

  getProtocol(toolName: string): TypeProtocol | null {
    return this.protocols.get(toolName) || null
  }

  validateInput(toolName: string, input: any): { valid: boolean; errors?: string[] } {
    const protocol = this.protocols.get(toolName)
    if (!protocol) return { valid: true } // 无协议则不校验

    const errors: string[] = []
    const schema = protocol.inputSchema

    if (schema) {
      for (const [key, expectedType] of Object.entries(schema)) {
        if (input[key] !== undefined) {
          const actualType = Array.isArray(input[key]) ? 'array' : typeof input[key]
          if (actualType !== expectedType) {
            errors.push(`Field "${key}" expected ${expectedType}, got ${actualType}`)
          }
        } else if (!(key in input) && schema.__required?.includes(key)) {
          errors.push(`Missing required field: ${key}`)
        }
      }
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  }

  listProtocols(): string[] {
    return Array.from(this.protocols.keys())
  }
}

export const typertProtocolProvider: Plugin = (ctx: any) => {
  const protocol = new TypertProtocol()

  const dispose = ctx.provide('typertProtocol', {
    registerProtocol(p: any) { protocol.registerProtocol(p) },
    unregisterProtocol(toolName: string) { protocol.unregisterProtocol(toolName) },
    getProtocol(toolName: string) { return protocol.getProtocol(toolName) },
    validateInput(toolName: string, input: any) { return protocol.validateInput(toolName, input) },
    listProtocols() { return protocol.listProtocols() },
  })

  return dispose
}
