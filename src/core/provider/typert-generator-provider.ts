// @ts-nocheck
/**
 * @codem/typert-generator — 类型生成器插件 (P2-7.15)
 *
 * 根据工具定义、API Schema 自动生成 TypeScript 类型。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链 → 工具注册后生成类型）：
 * - 启动时：注册类型生成器，工具注册后自动生成类型定义
 * - 停止时：类型不自动生成，开发者需手动定义
 */
import type { Plugin } from '../cordis/src/index.ts'

class TypertGenerator {
  private generatedTypes: Map<string, string> = new Map()

  generateFromSchema(name: string, schema: any): string {
    const tsType = this.schemaToTypeScript(schema)
    const typeDef = `export interface ${name} {\n${tsType}\n}`
    this.generatedTypes.set(name, typeDef)
    return typeDef
  }

  private schemaToTypeScript(schema: any, indent: string = '  '): string {
    if (!schema || typeof schema !== 'object') return ''
    const lines: string[] = []
    for (const [key, value] of Object.entries(schema)) {
      const typeStr = this.inferType(value)
      lines.push(`${indent}${key}: ${typeStr}`)
    }
    return lines.join('\n')
  }

  private inferType(value: any): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) {
      if (value.length > 0) return `${this.inferType(value[0])}[]`
      return 'any[]'
    }
    switch (typeof value) {
      case 'string': return 'string'
      case 'number': return 'number'
      case 'boolean': return 'boolean'
      case 'object': {
        const fields = Object.entries(value)
          .map(([k, v]) => `${k}: ${this.inferType(v)}`)
          .join(', ')
        return `{ ${fields} }`
      }
      default: return 'any'
    }
  }

  getGenerated(name: string): string | null {
    return this.generatedTypes.get(name) || null
  }

  getAllGenerated(): { name: string; typeDef: string }[] {
    return Array.from(this.generatedTypes.entries()).map(([name, typeDef]) => ({ name, typeDef }))
  }

  clear() {
    this.generatedTypes.clear()
  }
}

export const typertGeneratorProvider: Plugin = (ctx: any) => {
  const generator = new TypertGenerator()

  const dispose = ctx.provide('typertGenerator', {
    generateFromSchema(name: string, schema: any) { return generator.generateFromSchema(name, schema) },
    getGenerated(name: string) { return generator.getGenerated(name) },
    getAllGenerated() { return generator.getAllGenerated() },
    clear() { generator.clear() },
  })

  return dispose
}
