/**
 * 第 98 轮：`knowledge/exporter.ts` + `knowledge/importer.ts` 的**往返**门禁（此前两者都是 0 覆盖）。
 *
 * 这两个文件是**一对**：`importer.ts` 的文件头自己写着"解析 exportNotebookAsMarkdown 导出的
 * Markdown 格式"，也就是说"导出再导入"应当能重建结构。但此前没有任何测试把这句话**量**出来：
 *  - 导出器有 3 个纯逻辑出口（`exportNotebookAsMarkdown` / `exportNoteAsMarkdown` / `downloadMarkdown`）；
 *  - 导入器有一整套手写 Markdown 解析（分节 / 按 ### 切块 / 逐行取 `- **类型**:` 等）。
 *
 * 手写解析 + 手写生成，最典型的坏法就是**两边各自演化**（生成侧多印一个字段、解析侧少认一个前缀），
 * 而"导出成功了"和"导入成功了"两个局部都看不出来 —— 只有往返能看出来。
 *
 * 判据分三层：
 *  ① 生成侧（EXP-*）：格式就是文档里写的那几段，PPT 笔记**不泄露正文**，空笔记本不印空小节；
 *  ② 解析侧（IMP-*）：缺 H1 的兜底名、未知类型兜底、单块解析失败**不许拖垮后面的块**；
 *  ③ **往返（RT-*）**：同一份数据 导出 → 导入，名称/描述/来源/笔记逐项对齐；并且
 *     **正文里带 Markdown 标题的笔记**也不许被解析器切碎（这是"手写解析"最容易漏的一格）。
 *
 * 依赖（`./storage` / `./indexer`）用内存假实现替换 —— 它们背后是 Rust 端口，
 * 真机上由引擎负责；这里要验的是**这两个文件自己的逻辑**。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/* ===== 内存假 storage / indexer（必须在 import 被测模块之前 mock） ===== */

interface FakeNotebook { id: string; name: string; description?: string; summary?: string; chunkCount: number }
interface FakeSource { id: string; notebookId: string; name: string; type: string; status: string; chunkCount: number; summary?: string; keyTopics?: string[]; content?: string }
interface FakeNote { id: string; notebookId: string; title: string; content: string; contentType: string; updatedAt: number }

const db = {
  notebooks: [] as FakeNotebook[],
  sources: [] as FakeSource[],
  notes: [] as FakeNote[],
  seq: 0,
}
const indexed: string[] = []
/** 让某次 indexSource（第 n 次调用）抛错，用来验错误隔离 */
let failIndexOnCall: number | null = null

vi.mock('../core/knowledge/storage', () => ({
  createNotebook: ({ name, description }: { name: string; description?: string }) => {
    const nb: FakeNotebook = { id: `nb-${++db.seq}`, name, description, chunkCount: 0 }
    db.notebooks.push(nb)
    return nb
  },
  getNotebook: (id: string) => db.notebooks.find(n => n.id === id) ?? null,
  listSources: (notebookId: string) => db.sources.filter(s => s.notebookId === notebookId),
  listNotes: (notebookId: string) => db.notes.filter(n => n.notebookId === notebookId),
  addSource: ({ notebookId, name, type, content }: { notebookId: string; name: string; type: string; content?: string }) => {
    const src: FakeSource = {
      id: `src-${++db.seq}`,
      notebookId,
      name,
      type,
      status: 'indexed',
      chunkCount: content ? 1 : 0,
      content,
    }
    db.sources.push(src)
    return src
  },
  createNote: ({ notebookId, title, content, contentType }: { notebookId: string; title: string; content: string; contentType: string }) => {
    const note: FakeNote = { id: `note-${++db.seq}`, notebookId, title, content, contentType, updatedAt: 1_760_000_000_000 }
    db.notes.push(note)
    return note
  },
}))

vi.mock('../core/knowledge/indexer', () => ({
  indexSource: async (src: FakeSource) => {
    indexed.push(src.name)
    if (failIndexOnCall !== null && indexed.length === failIndexOnCall) {
      throw new Error(`index blew up on ${src.name}`)
    }
  },
}))

import { exportNotebookAsMarkdown, exportNoteAsMarkdown, downloadMarkdown } from '../core/knowledge/exporter'
import { importNotebookFromMarkdown, importNotebookFromFile } from '../core/knowledge/importer'

/* ===== 夹具 ===== */

function seedNotebook(overrides: Partial<FakeNotebook> = {}) {
  const nb: FakeNotebook = {
    id: `nb-fixed-${++db.seq}`,
    name: '制造运行管理',
    description: 'MOM 相关材料的整理',
    summary: 'ISA-95 是 MOM 的基础标准。',
    chunkCount: 7,
    ...overrides,
  }
  db.notebooks.push(nb)
  return nb
}

function seedSource(notebookId: string, overrides: Partial<FakeSource> = {}) {
  const src: FakeSource = {
    id: `src-fixed-${++db.seq}`,
    notebookId,
    name: '标准原文',
    type: 'file',
    status: 'indexed',
    chunkCount: 3,
    summary: '以 ISA-95 为基础',
    keyTopics: ['ISA-95', 'MOM'],
    ...overrides,
  }
  db.sources.push(src)
  return src
}

function seedNote(notebookId: string, overrides: Partial<FakeNote> = {}) {
  const note: FakeNote = {
    id: `note-fixed-${++db.seq}`,
    notebookId,
    title: '要点',
    content: '第一条要点',
    contentType: 'markdown',
    updatedAt: 1_760_000_000_000,
    ...overrides,
  }
  db.notes.push(note)
  return note
}

/** 把导出的 Markdown 里属于「我们刚种进去的那份数据」的来源/笔记取出来 */
function sourcesOf(notebookId: string) { return db.sources.filter(s => s.notebookId === notebookId) }
function notesOf(notebookId: string) { return db.notes.filter(n => n.notebookId === notebookId) }

beforeEach(() => {
  db.notebooks = []
  db.sources = []
  db.notes = []
  db.seq = 0
  indexed.length = 0
  failIndexOnCall = null
  delete (window as any).__TAURI__
})

describe('知识笔记本导出（EXP-*）', () => {
  it('EXP-1: 笔记本不存在 ⇒ 返回空串（不抛、不生成半截文件）', () => {
    expect(exportNotebookAsMarkdown('nb-nope')).toBe('')
  })

  it('EXP-2: 只有标题和元数据时，不印空的「来源 / 笔记」小节', () => {
    const nb = seedNotebook({ id: 'nb-empty', description: undefined, summary: undefined, chunkCount: 0 })
    const md = exportNotebookAsMarkdown(nb.id)
    expect(md).toContain('# 制造运行管理')
    expect(md).toContain('**来源**: 0 | **笔记**: 0 | **分块**: 0')
    expect(md).not.toContain('## 📎 来源')
    expect(md).not.toContain('## 📝 笔记')
    expect(md).not.toContain('## 📋 摘要')
  })

  it('EXP-3: PPT 笔记只印占位提示，不把演示文稿正文导成 Markdown', () => {
    const nb = seedNotebook({ id: 'nb-ppt' })
    seedNote(nb.id, { title: '季度汇报', contentType: 'ppt', content: '{"slides":[{"title":"机密"}]}' })
    const md = exportNotebookAsMarkdown(nb.id)
    expect(md).toContain('### 📊 季度汇报')
    expect(md).toContain('> PPT 演示文稿内容 (请在应用内查看)')
    expect(md).not.toContain('机密')
  })

  it('EXP-4: 来源的摘要/话题/分块数都印出来，话题用反引号包裹', () => {
    const nb = seedNotebook({ id: 'nb-src' })
    seedSource(nb.id)
    const md = exportNotebookAsMarkdown(nb.id)
    expect(md).toContain('### 标准原文')
    expect(md).toContain('- **类型**: file')
    expect(md).toContain('- **状态**: indexed')
    expect(md).toContain('- **分块数**: 3')
    expect(md).toContain('- **摘要**: 以 ISA-95 为基础')
    expect(md).toContain('- **话题**: `ISA-95`, `MOM`')
  })

  it('EXP-5: 单条笔记导出 —— 空内容印「(空)」而不是留白', () => {
    const md = exportNoteAsMarkdown({ title: '空白笔记', content: '', updatedAt: 1_760_000_000_000 } as any)
    expect(md).toContain('# 空白笔记')
    expect(md).toContain('(空)')
  })

  it('EXP-6: downloadMarkdown —— .md 后缀不重复加、文件名与内容真的进了下载链接', () => {
    const created: unknown[] = []
    const revoked: string[] = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      created.push({ download: this.download, href: this.href })
    })
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (() => 'blob:fake-url') as any
    URL.revokeObjectURL = ((u: string) => { revoked.push(u) }) as any
    try {
      downloadMarkdown('笔记导出', '# 内容')
      downloadMarkdown('已经带后缀.md', '# 内容')
      const downloads = created.map(c => c.download)
      expect(downloads).toEqual(['笔记导出.md', '已经带后缀.md'])
      expect(revoked).toEqual(['blob:fake-url', 'blob:fake-url'])
      expect(created.every(c => c.href === 'blob:fake-url')).toBe(true)
    } finally {
      clickSpy.mockRestore()
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
})

describe('知识笔记本导入（IMP-*）', () => {
  it('IMP-1: 没有 H1 时用兜底名，而不是把整份文件当标题', async () => {
    const result = await importNotebookFromMarkdown('## 📎 来源\n\n### 无名来源\n- **类型**: url\n')
    const nb = db.notebooks.find(n => n.id === result.notebookId)!
    expect(nb.name).toBe('Imported Notebook')
    expect(result.sourcesCreated).toBe(1)
    expect(sourcesOf(result.notebookId)[0].type).toBe('url')
  })

  it('IMP-2: 未知/缺失的类型字段兜底成 text（不产生非法类型）', async () => {
    const result = await importNotebookFromMarkdown('## 📎 来源\n\n### 无类型来源\n- **摘要**: 只有摘要\n')
    expect(result.errors).toEqual([])
    expect(sourcesOf(result.notebookId)[0].type).toBe('text')
    // 摘要同时被当成内容（文档里写明的那条兜底）
    expect(sourcesOf(result.notebookId)[0].content).toBe('只有摘要')
  })

  it('IMP-3: 单个来源索引失败只记进 errors，后面的块照常导入（错误隔离）', async () => {
    failIndexOnCall = 1
    const md = [
      '## 📎 来源',
      '',
      '### 会失败的来源',
      '- **类型**: file',
      '',
      '### 应当成功',
      '- **类型**: text',
      '- **摘要**: ok',
      '',
    ].join('\n')
    const result = await importNotebookFromMarkdown(md)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('index blew up')
    expect(indexed).toEqual(['会失败的来源', '应当成功'])
  })

  it('IMP-4: 笔记的「时间戳行」被跳过；(空) 还原成真正的空内容', async () => {
    const md = [
      '## 📝 笔记',
      '',
      '### 📝 有内容',
      '*2026/9/24 10:00:00*',
      '',
      '正文第一行',
      '正文第二行',
      '',
      '### 📝 空笔记',
      '*2026/9/24 10:00:00*',
      '',
      '(空)',
      '',
    ].join('\n')
    const result = await importNotebookFromMarkdown(md)
    const notes = notesOf(result.notebookId)
    expect(result.notesCreated).toBe(2)
    expect(notes[0].title).toBe('有内容')
    expect(notes[0].content).toBe('正文第一行\n正文第二行')
    expect(notes[1].content).toBe('')
  })

  it('IMP-5: 非 Tauri 环境读文件必须明确拒绝（不许静默返回空笔记本）', async () => {
    await expect(importNotebookFromFile('C:/tmp/x.md')).rejects.toThrow(/requires Tauri runtime/)
  })

  it('IMP-6: Tauri 环境下走 read_file，参数就是引擎要的那两个', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    ;(window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args: unknown) => {
          calls.push({ cmd, args })
          return '# 从文件导入\n\n## 📝 笔记\n\n### 📝 一条\n*2026/9/24 10:00:00*\n\n内容\n'
        },
      },
    }
    const result = await importNotebookFromFile('C:/tmp/notebook.md')
    expect(calls).toEqual([{ cmd: 'read_file', args: { path: 'C:/tmp/notebook.md', encoding: 'utf-8' } }])
    expect(db.notebooks.find(n => n.id === result.notebookId)!.name).toBe('从文件导入')
    expect(result.notesCreated).toBe(1)
  })

  it('IMP-7: 手写文件没有 📝/📊 记号时，退回「每个 ### 都是一条笔记」的老行为（兼容）', async () => {
    const md = ['## 笔记', '', '### 手写甲', '甲的内容', '', '### 手写乙', '乙的内容', ''].join('\n')
    const result = await importNotebookFromMarkdown(md)
    expect(result.notesCreated).toBe(2)
    expect(notesOf(result.notebookId).map(n => n.title)).toEqual(['手写甲', '手写乙'])
    expect(notesOf(result.notebookId).map(n => n.content)).toEqual(['甲的内容', '乙的内容'])
  })

  it('IMP-8: 白名单之外的小节标题（`## 其它`）不再吞掉后面的内容', async () => {
    const md = [
      '# 手写笔记本',
      '',
      '开头一句。',
      '',
      '## 其它小节',
      '',
      '这段属于笔记正文。',
      '',
      '## 笔记',
      '',
      '### 手写甲',
      '甲的内容',
      '',
    ].join('\n')
    const result = await importNotebookFromMarkdown(md)
    // `## 其它小节` 不是认得出的小节 ⇒ 不进"来源/笔记"任何一分支，也不会让后面的笔记丢失
    expect(result.notesCreated).toBe(1)
    expect(notesOf(result.notebookId)[0].title).toBe('手写甲')
    expect(result.errors).toEqual([])
  })
})

describe('导出 → 导入 往返（RT-*）', () => {
  it('RT-1: 名称/描述/来源/笔记逐项对齐；来源名与笔记正文原样回来', async () => {
    const nb = seedNotebook({ id: 'nb-rt' })
    seedSource(nb.id)
    seedSource(nb.id, { name: '第二份材料', type: 'url', chunkCount: 0, summary: undefined, keyTopics: undefined })
    seedNote(nb.id, { title: '要点', content: '第一条要点' })

    const md = exportNotebookAsMarkdown(nb.id)
    const result = await importNotebookFromMarkdown(md)

    const imported = db.notebooks.find(n => n.id === result.notebookId)!
    expect(imported.name).toBe(nb.name)
    expect(imported.description).toBe(nb.description)
    expect(result.sourcesCreated).toBe(2)
    expect(result.notesCreated).toBe(1)
    expect(result.errors).toEqual([])

    const names = sourcesOf(result.notebookId).map(s => s.name)
    expect(names).toEqual(['标准原文', '第二份材料'])
    // 没有摘要的来源不会凭空多出摘要，且不会被当成 file/url 之外的类型
    expect(sourcesOf(result.notebookId)[1].type).toBe('url')
    expect(notesOf(result.notebookId)[0].title).toBe('要点')
    expect(notesOf(result.notebookId)[0].content).toBe('第一条要点')
  })

  it('RT-2: PPT 笔记往返后仍是 PPT（内容按设计降级成占位提示，但类型不许丢）', async () => {
    const nb = seedNotebook({ id: 'nb-rt-ppt' })
    seedNote(nb.id, { title: '汇报', contentType: 'ppt', content: '{"slides":[]}' })
    const result = await importNotebookFromMarkdown(exportNotebookAsMarkdown(nb.id))
    const imported = notesOf(result.notebookId)[0]
    expect(imported.contentType).toBe('ppt')
    expect(imported.content).toContain('请在应用内查看')
  })

  it('RT-3: 正文里带 Markdown 标题的笔记，往返后内容不许被切碎（手写解析最容易漏的一格）', async () => {
    const nb = seedNotebook({ id: 'nb-rt-headings' })
    const richContent = [
      '## 二级标题在正文里',
      '',
      '正文一段。',
      '',
      '### 三级标题也在正文里',
      '',
      '正文又一段。',
    ].join('\n')
    seedNote(nb.id, { title: '带标题的笔记', content: richContent })
    seedSource(nb.id, { name: '防串味来源' })

    const result = await importNotebookFromMarkdown(exportNotebookAsMarkdown(nb.id))
    const notes = notesOf(result.notebookId)
    expect(notes, '正文里的 ## / ### 不能被当成新的小节或新笔记').toHaveLength(1)
    expect(notes[0].content).toBe(richContent)
    expect(result.sourcesCreated, '笔记正文里的标题也可能被当成来源块').toBe(1)
    expect(sourcesOf(result.notebookId).map(s => s.name)).toEqual(['防串味来源'])
  })
})
