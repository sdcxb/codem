/**
 * 第 103 轮：PPT 内容生成器的门禁（`knowledge/ppt-generator.ts` 此前 0 覆盖）。
 *
 * 这条路径是「PPT」轴的入口（笔记本 → Studio → PPT 演示 → AI 生成）：
 * 读知识库分块 → 组装带风格技能的系统提示 → 流式调用 LLM → 解析大纲 → 生成元素化幻灯片。
 *
 * 判据分三层：
 *  ① **失败必须说人话且可区分**：索引未就绪（"稍后重试"）≠ 没有内容（"先去加来源"）；
 *    LLM 空响应 ≠ 返回非 JSON —— 三种情况的报错文案不同，调用方据此给不同建议；
 *  ② **喂给模型的东西是对的**：来源筛选真的生效、60 块/12000 字上限真的生效、
 *    风格技能提示真的注入了（否则模型拿不到视觉指令）；
 *  ③ **返回值自洽**：页数 = 大纲页数、画布尺寸/风格 id 回填、主题来自所选风格、进度回调有序。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hooks = {
  chunks: [] as Array<{ id: string; sourceId: string; content: string }>,
  chunksStatus: null as null | { ok: false; reason: string },
  llmScript: [] as Array<{ text?: string; error?: string }>,
  streamRequests: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
  skillPrompts: {} as Record<string, string>,
  imageGenAvailable: false,
  imageGenCalls: 0,
}

vi.mock('../core/knowledge/storage', () => ({
  getChunksOrStatus: () =>
    hooks.chunksStatus ? { ok: false, state: 'unavailable', reason: hooks.chunksStatus.reason } : { ok: true, chunks: hooks.chunks, state: 'ready' },
}))

vi.mock('../core/skill/skill', () => ({
  getSkillRegistry: () => ({
    get: (name: string) => (hooks.skillPrompts[name] ? { name, prompt: hooks.skillPrompts[name] } : undefined),
  }),
}))

vi.mock('../core/knowledge/ppt-skill-registry', () => ({
  registerOhMyPptSkills: () => {},
}))

vi.mock('../core/knowledge/ppt-image', () => ({
  isImageGenAvailable: () => hooks.imageGenAvailable,
  autoGenerateImages: async (slides: unknown[]) => {
    hooks.imageGenCalls += 1
    return slides
  },
}))

vi.mock('../core/llm/index', () => ({
  getLLMEngine: () => ({
    getConfiguredProvider: () => ({
      model: 'ppt-test-model',
      provider: {
        id: 'test-provider',
        // 生成器用的是 `provider.stream(...)` 的**流式**接口（不是 complete）
        stream: async function* (req: { model: string; messages: Array<{ role: string; content: string }> }) {
          hooks.streamRequests.push(req)
          for (const step of hooks.llmScript) {
            if (step.error) throw new Error(step.error)
            if (step.text) yield { type: 'text_delta', text: step.text }
          }
          yield { type: 'end', finishReason: 'stop' }
        },
      },
    }),
  }),
}))

import { generatePPTContent } from '../core/knowledge/ppt-generator'
import { getStyleById, getCanvasSizeById, PPT_STYLES, CANVAS_SIZES } from '../core/knowledge/ppt-styles'

const outlineOf = (titles: string[]) =>
  JSON.stringify({
    title: '钻取演示文稿',
    slides: titles.map((t, i) => ({ title: t, content: `第 ${i + 1} 页正文`, layout: i === 0 ? 'title' : 'title_content' })),
  })

function seedChunks(count: number) {
  hooks.chunks = Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i + 1}`,
    sourceId: i < count / 2 ? 'src-a' : 'src-b',
    content: `第 ${i + 1} 块正文：生产管控与 MOM。`,
  }))
}

beforeEach(() => {
  hooks.chunks = []
  hooks.chunksStatus = null
  hooks.llmScript = [{ text: outlineOf(['封面', '要点', '总结']) }]
  hooks.streamRequests = []
  hooks.skillPrompts = {}
  // 技能名是 `ppt-style-<规范化后的风格 id>`；`business-blue` 是**旧 id**，
  // 经 `OLD_STYLE_ID_MAP` 会被规范化成新 id（`getStyleById` 负责），技能名要按规范化后的来更。
  for (const candidate of ['business-blue', 'corporate-clean']) {
    const resolved = getStyleById(candidate)
    if (resolved) hooks.skillPrompts[`ppt-style-${resolved.id}`] = '风格指令：蓝色商务风，标题居中。'
  }
  hooks.imageGenAvailable = false
  hooks.imageGenCalls = 0
})

describe('PPT 内容生成（第 103 轮）', () => {
  it('PPTG-1: 索引未就绪 ⇒ 报"稍后重试"，且**不**去调 LLM', async () => {
    hooks.chunksStatus = { ok: false, reason: '文本块索引尚未就绪（镜像未接手）' }
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/知识库索引未就绪（请稍后重试）：.*镜像未接手/)
    expect(hooks.streamRequests, '读不到块就不该发请求').toHaveLength(0)
  })

  it('PPTG-2: 没有可用内容 ⇒ 报 No indexed content（而不是"索引未就绪"）', async () => {
    hooks.chunks = []
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/No indexed content available/)
  })

  it('PPTG-2b: 来源筛选后为空也走同一个错误（不是静默生成空演示）', async () => {
    seedChunks(4)
    await expect(generatePPTContent('nb-1', '主题', 8, 'business-blue', '16:9', false, ['src-不存在'])).rejects.toThrow(/No indexed content available/)
  })

  it('PPTG-3: LLM 空响应 ⇒ 明确让用户去查 API Key / 模型配置', async () => {
    seedChunks(2)
    hooks.llmScript = [{ text: '' }]
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/LLM returned empty response/)
  })

  it('PPTG-4: 返回的不是 JSON ⇒ 报"解析大纲失败"并带上响应片段与模型名', async () => {
    seedChunks(2)
    hooks.llmScript = [{ text: '抱歉，我不能生成这个。' }]
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/Failed to parse PPT outline from LLM response/)
  })

  it('PPTG-5: 网络类错误被包装成可读文案（带 provider / model / 原文）', async () => {
    seedChunks(2)
    hooks.llmScript = [{ error: 'Failed to fetch' }]
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/Network error when calling LLM API.*test-provider.*ppt-test-model.*Failed to fetch/s)
  })

  it('PPTG-6: 非网络错误原样抛出（不被吞、不被改写）', async () => {
    seedChunks(2)
    hooks.llmScript = [{ error: '401 无效的 API Key' }]
    await expect(generatePPTContent('nb-1')).rejects.toThrow(/401 无效的 API Key/)
  })

  it('PPTG-7: 正常生成 —— 页数/画布/风格 id 回填，每页都有元素，进度回调有序', async () => {
    seedChunks(3)
    const stages: string[] = []
    const deck = await generatePPTContent('nb-1', '生产管控', 8, 'business-blue', '16:9', false, undefined, (stage) => stages.push(stage))

    expect(deck.title).toBe('钻取演示文稿')
    expect(deck.slides).toHaveLength(3)
    /*
     * `styleId` 回填的是**规范化后的**风格 id（`business-blue` 是旧 id，
     * 经 `OLD_STYLE_ID_MAP` 映到新 id）—— 所以这里跟被测实现之外的 `getStyleById` 对账，
     * 而不是写死一个字符串。第一版写死了 'business-blue'，被这条交叉核对抓出来。
     */
    expect(deck.styleId).toBe(getStyleById('business-blue')!.id)
    expect(deck.canvasSizeId).toBe('16:9')
    expect(deck.canvasWidth).toBe(getCanvasSizeById('16:9')!.width)
    expect(deck.canvasHeight).toBe(getCanvasSizeById('16:9')!.height)
    for (const slide of deck.slides) {
      expect(slide.elements.length, '每页至少要有元素，不能是空页').toBeGreaterThan(0)
    }
    // 进度回调必须走完这几个阶段（顺序即用户看到的文案顺序）
    expect(stages.slice(0, 2)).toEqual(['loading', 'preparing'])
    expect(stages).toContain('generating')
    expect(stages).toContain('parsing')
    expect(stages).toContain('building')
  })

  it('PPTG-8: 风格技能提示真的注入了 systemPrompt（模型拿不到视觉指令就没人遵守）', async () => {
    seedChunks(2)
    await generatePPTContent('nb-1', undefined, 8, 'business-blue')
    const req = hooks.streamRequests[0]
    const system = req.messages.find((m) => m.role === 'system')!.content
    const user = req.messages.find((m) => m.role === 'user')!.content
    expect(system).toContain('风格指令：蓝色商务风，标题居中。')
    expect(user).toContain('第 1 块正文')
  })

  it('PPTG-9: 按来源筛选 —— 只把选中来源的分块喂给模型', async () => {
    seedChunks(4) // 前半 src-a，后半 src-b
    await generatePPTContent('nb-1', undefined, 8, 'business-blue', '16:9', false, ['src-b'])
    const user = hooks.streamRequests[0].messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('第 3 块正文')
    expect(user, 'src-a 的块不该出现').not.toContain('第 1 块正文')
  })

  it('PPTG-10: 60 块上限真的生效（第 61 块之后不许进 prompt）', async () => {
    seedChunks(70)
    await generatePPTContent('nb-1')
    const user = hooks.streamRequests[0].messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('第 60 块正文')
    expect(user).not.toContain('第 61 块正文')
  })

  it('PPTG-11: enableImages=true 但生图服务不可用 ⇒ 静默跳过、不炸', async () => {
    seedChunks(2)
    hooks.imageGenAvailable = false
    const deck = await generatePPTContent('nb-1', undefined, 8, 'business-blue', '16:9', true)
    expect(deck.slides).toHaveLength(3)
    expect(hooks.imageGenCalls).toBe(0)

    hooks.imageGenAvailable = true
    await generatePPTContent('nb-1', undefined, 8, 'business-blue', '16:9', true)
    expect(hooks.imageGenCalls, '可用时要真的去配图').toBe(1)
  })

  it('PPTG-12: 未知的风格/画布 id ⇒ 回退到第一项，而不是抛错或生成没主题的演示', async () => {
    seedChunks(2)
    const deck = await generatePPTContent('nb-1', undefined, 8, '压根不存在的风格', '不存在的画布')
    expect(deck.styleId).toBe(PPT_STYLES[0].id)
    expect(deck.canvasSizeId).toBe(CANVAS_SIZES[0].id)
    expect(deck.canvasWidth).toBe(CANVAS_SIZES[0].width)
    expect(deck.theme, '主题必须来自所选风格，不能是空对象').toBeTruthy()
  })
})
