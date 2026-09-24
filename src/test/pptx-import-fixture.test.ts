// @vitest-environment jsdom
/**
 * 第 99 轮：**PPTX 导入**用一份真实（第三方写入器产出的）deck 量一遍 —— 顺带把 O-12 ① 的 `.pptx` 走查补上。
 *
 * ## 为什么这个文件必须用 jsdom（而不是项目默认的 happy-dom）
 *
 * 实测出来的两条 happy-dom 限制（`.preview-shot/_probe-happydom-*.mjs`）：
 *  1. **带前缀的属性会丢**：`<p:sldId r:id="rId2"/>` 解析后只剩 `id`，`getAttribute('r:id')` 返回 `null`
 *     ⇒ 真实 PPTX 全靠 `r:id` 关联幻灯片，导入器在 happy-dom 里必然报 `No slides found in PPTX`；
 *  2. **不认单引号的 XML 声明**：python-pptx 写的是 `<?xml version='1.0' ...?>`（XML 规范允许），
 *     happy-dom 直接给 `PARSERERROR`。
 *
 * 已经在**运行中的装机版（真实 Chromium）**里做过对照：两种声明、带前缀属性都解析正常
 * （`.preview-shot/_probe-xml-decl-quotes.mjs`，exit 0）⇒ **这两条是测试环境的毛病，不是产品缺陷**，
 * 所以这里换用符合规范的 jsdom（仓库里已装 jsdom 29），而不是去改产品代码迁就测试。
 * 全仓只有 `pptx-importer.ts` 用 `DOMParser` 解 XML，所以这个切换不影响其它用例。
 *
 * ## 夹具
 *
 * 本机实际找到的三份 `.pptx`（python-pptx 的 `default.pptx`、slidep 的 `blank.pptx`、
 * OneDrive 里那份）**都是空模板**（0~1 页、无文本）⇒ 量不出覆盖面。所以夹具用
 * `src/test/fixtures/pptx/third-party-deck.pptx`：由 **python-pptx 1.0.2** 生成（第三方写入器，
 * 标准 OOXML，PowerPoint 能打开；生成脚本 `tools/fixtures/make-pptx-fixture.py`，未做任何改写），
 * 5 页、每页放**不同形态**的元素：标题页 / 项目符号 / 表格 / 图片 / 演讲者备注。
 *
 * ## 判据
 *
 *  - 与**文件本身**交叉核对（不看解析器自己的说法）：页数 = zip 里 `ppt/slides/slideN.xml` 的个数；
 *    画布 = `<p:sldSz>` 的 EMU 换算；标题 = `docProps/core.xml` 的 `dc:title`；
 *  - 覆盖面如实记录：能读到的（正文文本、图片 data URL）**必须**读到；当前**读不到**的
 *    （表格 `p:graphicFrame`、演讲者备注）**也要断言"读不到"** —— 将来谁实现了它，这条用例会红。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { importPPTX } from '../core/knowledge/pptx-importer'

const FIXTURE = path.resolve(__dirname, 'fixtures', 'pptx', 'third-party-deck.pptx')

/**
 * 把夹具交给导入器。
 *
 * ⚠️ 传 `Uint8Array` 而不是 `ArrayBuffer`：这个文件跑在 **jsdom** 环境里，
 * jsdom 有自己的 `ArrayBuffer` 构造器，Node 那边 `Buffer#buffer` 切出来的 ArrayBuffer
 * 跨 realm 时会被 JSZip 判成"不认识的输入"（`Can't read the data of 'the loaded zip file'`）。
 * `Uint8Array` 是 JSZip 的一等输入，两个 realm 都认。
 */
function fixtureData(): ArrayBuffer {
  return new Uint8Array(fs.readFileSync(FIXTURE)) as unknown as ArrayBuffer
}

let zipSlideCount = 0
let coreTitle = ''
let hasNotesSlides = false
let hasMedia = false

beforeAll(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE))
  const names = Object.keys(zip.files)
  zipSlideCount = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length
  hasNotesSlides = names.some((n) => /notesSlide\d*\.xml$/.test(n))
  hasMedia = names.some((n) => n.startsWith('ppt/media/'))
  const core = await zip.file('docProps/core.xml')?.async('text')
  coreTitle = /<dc:title>([^<]*)<\/dc:title>/.exec(core ?? '')?.[1] ?? ''
})

describe('PPTX 导入：第三方 deck 夹具（第 99 轮）', () => {
  it('PPTX-1: 夹具是"真的"—— 5 页 / 有备注页 / 有媒体 / 有核心属性（先钉住夹具自身）', () => {
    expect(zipSlideCount).toBe(5)
    expect(hasNotesSlides).toBe(true)
    expect(hasMedia).toBe(true)
    expect(coreTitle).toBe('第三方 PPTX 夹具')
  })

  it('PPTX-2: 页数与文件里真实存在的 slide XML 数一致（交叉核对，不看解析器自述）', async () => {
    const deck = await importPPTX(fixtureData())
    expect(deck.slides).toHaveLength(zipSlideCount)
    expect(deck.slides.map((s) => s.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('PPTX-3: 画布按 <p:sldSz> 的 EMU 换算成 1280×720（16:9）', async () => {
    const deck = await importPPTX(fixtureData())
    // 12192000 / (914400/96) = 1280；6858000 / (914400/96) = 720
    expect(deck.canvasWidth).toBe(1280)
    expect(deck.canvasHeight).toBe(720)
  })

  it('PPTX-4: 标题沿用文档核心属性里的 dc:title', async () => {
    const deck = await importPPTX(fixtureData())
    expect(deck.title).toBe(coreTitle)
  })

  it('PPTX-5: 每页的占位符文本都读到了（标题 + 三条要点逐字对）', async () => {
    const deck = await importPPTX(fixtureData())
    /** 文本可能落在 `text`（content）或 `list`（items）两种元素里，两种都算"读到了" */
    const textOf = (i: number) =>
      deck.slides[i].elements
        .flatMap((e) => {
          const anyE = e as { content?: string; items?: string[] }
          return [anyE.content ?? '', ...(anyE.items ?? [])]
        })
        .filter(Boolean)
        .join('\n')

    expect(textOf(0)).toContain('Codem PPTX 导入钻取')
    expect(textOf(0)).toContain('由 python-pptx 生成（第三方写入器）')
    const bullets = textOf(1)
    expect(bullets).toContain('三条要点')
    expect(bullets).toContain('第一条要点')
    expect(bullets).toContain('第二条要点')
    expect(bullets).toContain('第三条要点')
  })

  it('PPTX-6: 图片被提取成 data URL（媒体映射走 slide rels → ppt/media）', async () => {
    const deck = await importPPTX(fixtureData())
    const images = deck.slides[3].elements.filter((e) => e.type === 'image')
    expect(images.length).toBeGreaterThan(0)
    const src = (images[0] as { src?: string }).src ?? ''
    expect(src.startsWith('data:image/')).toBe(true)
    expect(src).toContain('base64,')
    // 真是一张 PNG：解出来的头两字节必须是 PNG 魔数（别只信前缀字符串）
    const base64 = src.slice(src.indexOf('base64,') + 'base64,'.length)
    const bytes = Buffer.from(base64, 'base64')
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('\x89PNG')
  })

  it('PPTX-7: 位置尺寸转成了百分比（不是原样把 EMU 当像素用）', async () => {
    const deck = await importPPTX(fixtureData())
    const texts = deck.slides[0].elements.filter((e) => e.type === 'text')
    expect(texts.length).toBeGreaterThan(0)
    for (const el of texts) {
      expect(el.x).toBeGreaterThanOrEqual(0)
      expect(el.x).toBeLessThanOrEqual(100)
      expect(el.width).toBeGreaterThan(0)
      expect(el.width).toBeLessThanOrEqual(100)
    }
  })

  it('PPTX-8: 已知限制（表格 / 演讲者备注读不到）—— 断言"当前读不到"，避免限制悄悄漂移', async () => {
    const deck = await importPPTX(fixtureData())
    // 表格在 OOXML 里是 `p:graphicFrame`，导入器只走 `p:sp` / `p:pic` ⇒ 表格文字读不到。
    const tableSlideText = deck.slides[2].elements
      .filter((e) => e.type === 'text')
      .map((e) => (e as { content?: string; text?: string }).content ?? '')
      .join('\n')
    expect(tableSlideText).toContain('表格页')          // 标题读到了
    expect(tableSlideText).not.toContain('通过率')        // 表格单元格没读到（限制）
    expect(deck.slides[2].elements.some((e) => e.type === 'table')).toBe(false)
    // 演讲者备注：`notes` 目前恒为空串（实现里写死）
    expect(deck.slides[4].notes).toBe('')
  })

  it('PPTX-9: 坏输入必须抛可读错误（不许静默返回空 deck）', async () => {
    const notAZip = new TextEncoder().encode('这不是一个 pptx').buffer
    await expect(importPPTX(notAZip)).rejects.toBeTruthy()
    // 合法 zip 但缺 presentation.xml ⇒ 明确的 "Invalid PPTX"
    const zip = new JSZip()
    zip.file('readme.txt', 'nothing here')
    const emptyZip = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(importPPTX(emptyZip)).rejects.toThrow(/Invalid PPTX/)
  })
})
