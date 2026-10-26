/**
 * P1-2 模型菜单分组：按**可证明的来源**分组，不按模型名猜 role。
 * 结果必须保序、免费优先、未知不丢；UI 的 check/折叠由源码契约守。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupModelsByFamily, isUnknownModelName, modelFamily } from '../components/model-menu-groups'

const models = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'free-alpha', name: 'Free Alpha' },
  { id: 'custom-thing', name: 'Custom' },
]

describe('P1-2 模型来源分组', () => {
  it('来源识别只依赖 id 前缀，不猜 role', () => {
    expect(modelFamily('deepseek-v4-pro')).toBe('deepseek')
    expect(modelFamily('claude-opus-4')).toBe('anthropic')
    expect(modelFamily('gpt-4o')).toBe('openai')
    expect(modelFamily('o3')).toBe('openai')
    expect(modelFamily('gemini-2.5-pro')).toBe('gemini')
    expect(modelFamily('moonshot-v1-8k')).toBe('moonshot')
    expect(modelFamily('mimo-v2.5')).toBe('mimo')
    expect(modelFamily('custom-thing')).toBe('other')
  })

  it('免费优先、组序固定、组内保序、模型不丢', () => {
    const groups = groupModelsByFamily(models, (id) => id.startsWith('free-'))
    expect(groups.map((g) => g.family)).toEqual(['free', 'deepseek', 'anthropic', 'openai', 'gemini', 'other'])
    expect(groups.flatMap((g) => g.models.map((m) => m.id))).toHaveLength(models.length)
    expect(groups[0].models.map((m) => m.id)).toEqual(['free-alpha'])
    expect(groups.find((g) => g.family === 'deepseek')!.models.map((m) => m.id)).toEqual(['deepseek-v4-pro'])
  })

  it('未知名字可识别，不会混进首屏正常组', () => {
    expect(isUnknownModelName('【未知】model')).toBe(true)
    expect(isUnknownModelName('unknown')).toBe(true)
    expect(isUnknownModelName('')).toBe(true)
    expect(isUnknownModelName('DeepSeek V4 Pro')).toBe(false)
  })

  it('ChatPanel 真的用了分组、check 和未知折叠', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ChatPanel.tsx'), 'utf8')
    expect(src).toContain('groupModelsByFamily(menuKnown, isFreeModelId)')
    expect(src).toContain('model-option-check')
    expect(src).toContain('model-unknown-group')
    expect(src).toContain('menuUnknown.map')
  })
})
