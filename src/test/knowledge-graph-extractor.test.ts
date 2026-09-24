/**
 * 第 103 轮：知识图谱**抽取管道**的门禁（`knowledge/graph-extractor.ts` 此前 0 覆盖）。
 *
 * 这个文件是「知识图谱」这条轴的入口：从笔记本分块里抽实体/关系、去重落库、再做社区发现。
 * 它最要紧的判据不是"能不能抽出东西"，而是**读不到块的时候会不会把旧图谱清掉**：
 * `extractKnowledgeGraph` 中间有一句 `deleteGraphData()`，只要把"读不到"当成"没有内容"，
 * 就会先清空、再返回一张空图 —— 用户的图谱就这么没了（代码里的任务 C-3 注释记的正是这件事）。
 *
 * 判据分四层：
 *  ① 数据安全：索引未就绪 ⇒ **抛错**且**不许**调用 `deleteGraphData`；真的没有块 ⇒ 空图且同样不清库；
 *  ② 落库映射：实体类型 / 关系类型的中英文字符串→枚举映射（经 `findOrCreateNode` / `addGraphEdge` 的参数断言）；
 *  ③ 来源关联：LLM 给的 `chunkIndex` 要落到**正确的** chunk（跨批次换算），没有就按 label 搜，再兜底第一个；
 *  ④ 部分失败可见：某批失败不许中断别的批，且必须进 `warnings`（否则调用方以为图谱是完整的）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/* ===== 内存版 storage ===== */

interface FakeChunk { id: string; sourceId?: string; content: string; notebookId?: string }
interface FakeNode { id: string; label: string; entityType: string; description?: string; sourceIds: string[]; chunkIds: string[]; weight: number; community?: number }
interface FakeEdge { sourceNodeId: string; targetNodeId: string; relationType: string }

const db = {
  chunks: [] as FakeChunk[],
  chunksStatus: null as null | { ok: false; reason: string },
  sources: [] as Array<{ id: string; name: string }>,
  nodes: [] as FakeNode[],
  edges: [] as FakeEdge[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  seq: 0,
}

vi.mock('../core/knowledge/storage', () => ({
  getChunksOrStatus: (notebookId: string) => {
    db.calls.push({ fn: 'getChunksOrStatus', args: [notebookId] })
    if (db.chunksStatus) return { ok: false, state: 'unavailable', reason: db.chunksStatus.reason }
    return { ok: true, chunks: db.chunks, state: 'ready' }
  },
  listSources: (notebookId: string) => {
    db.calls.push({ fn: 'listSources', args: [notebookId] })
    return db.sources
  },
  findOrCreateNode: (notebookId: string, label: string, entityType: string, description?: string, sourceId?: string, chunkId?: string) => {
    db.calls.push({ fn: 'findOrCreateNode', args: [notebookId, label, entityType, description, sourceId, chunkId] })
    const existing = db.nodes.find((n) => n.label === label)
    if (existing) {
      existing.weight += 1
      if (sourceId && !existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId)
      if (chunkId && !existing.chunkIds.includes(chunkId)) existing.chunkIds.push(chunkId)
      return existing
    }
    const node: FakeNode = {
      id: `node-${++db.seq}`,
      label,
      entityType,
      description,
      sourceIds: sourceId ? [sourceId] : [],
      chunkIds: chunkId ? [chunkId] : [],
      weight: 1,
    }
    db.nodes.push(node)
    return node
  },
  addGraphEdge: (notebookId: string, sourceNodeId: string, targetNodeId: string, relationType: string) => {
    db.calls.push({ fn: 'addGraphEdge', args: [notebookId, sourceNodeId, targetNodeId, relationType] })
    db.edges.push({ sourceNodeId, targetNodeId, relationType })
  },
  deleteGraphData: (notebookId: string) => {
    db.calls.push({ fn: 'deleteGraphData', args: [notebookId] })
    db.nodes = []
    db.edges = []
  },
  getGraphData: (notebookId: string) => {
    db.calls.push({ fn: 'getGraphData', args: [notebookId] })
    return { nodes: db.nodes.map((n) => ({ ...n })), edges: db.edges.map((e) => ({ ...e })) }
  },
  updateNodeCommunity: (nodeId: string, communityId: number) => {
    db.calls.push({ fn: 'updateNodeCommunity', args: [nodeId, communityId] })
    const node = db.nodes.find((n) => n.id === nodeId)
    if (node) node.community = communityId
  },
}))

/* ===== 假 LLM（`callLLMForExtraction` 里是 `await import('../llm/index')`） ===== */

const llm = {
  /** 每批一次 complete()：按调用序号返回脚本化的内容 */
  responses: [] as string[],
  calls: 0,
  throwOn: new Set<number>(),
  prompts: [] as string[],
}

vi.mock('../core/llm/index', () => ({
  getLLMEngine: () => ({
    getConfiguredProvider: () => ({
      model: 'test-model',
      provider: {
        complete: async (req: { messages: Array<{ content: string }> }) => {
          llm.calls += 1
          llm.prompts.push(req.messages.map((m) => m.content).join('\n---\n'))
          if (llm.throwOn.has(llm.calls)) throw new Error(`第 ${llm.calls} 批炸了`)
          const content = llm.responses[llm.calls - 1] ?? '{"entities":[],"relations":[]}'
          return { content }
        },
      },
    }),
  }),
}))

import { extractKnowledgeGraph } from '../core/knowledge/graph-extractor'

const extraction = (entities: unknown[], relations: unknown[] = []) => JSON.stringify({ entities, relations })

function seedChunks(count: number, notebookId = 'nb-1') {
  db.chunks = Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i + 1}`,
    sourceId: `src-${(i % 2) + 1}`,
    content: `第 ${i + 1} 块的正文，提到 ISA-95 与 MOM。`,
    notebookId,
  }))
}

const callsOf = (fn: string) => db.calls.filter((c) => c.fn === fn)

beforeEach(() => {
  db.chunks = []
  db.chunksStatus = null
  db.sources = [{ id: 'src-1', name: '来源 1' }, { id: 'src-2', name: '来源 2' }]
  db.nodes = []
  db.edges = []
  db.calls = []
  db.seq = 0
  llm.responses = []
  llm.calls = 0
  llm.throwOn = new Set()
  llm.prompts = []
})

describe('知识图谱抽取（第 103 轮）', () => {
  it('GR-1（数据安全）: 索引未就绪 ⇒ 抛错，且**绝不**调用 deleteGraphData', async () => {
    db.chunksStatus = { ok: false, reason: '文本块索引尚未就绪（镜像未接手）' }
    await expect(extractKnowledgeGraph('nb-1')).rejects.toThrow(/知识图谱未抽取：.*索引尚未就绪/)
    expect(callsOf('deleteGraphData'), '不能把"读不到"当成"没有内容"去清库').toHaveLength(0)
    expect(llm.calls, '读不到块就不该去调 LLM').toBe(0)
  })

  it('GR-2: 确实没有块 ⇒ 返回空图，同样不清库', async () => {
    const result = await extractKnowledgeGraph('nb-1')
    expect(result).toEqual({ nodes: [], edges: [] })
    expect(callsOf('deleteGraphData')).toHaveLength(0)
    expect(llm.calls).toBe(0)
  })

  it('GR-3: 正常一批 —— 实体落库、关系建边、按 label 提升权重', async () => {
    seedChunks(2)
    llm.responses = [
      extraction(
        [
          { label: 'ISA-95', type: '技术', description: 'MOM 的基础标准', chunkIndex: 1 },
          { label: 'MOM', type: 'concept', description: '制造运行管理', chunkIndex: 2 },
        ],
        [{ source: 'MOM', target: 'ISA-95', relation: '依赖' }],
      ),
    ]
    const result = await extractKnowledgeGraph('nb-1')

    expect(callsOf('deleteGraphData')).toHaveLength(1) // 就绪时才清旧图
    const nodeCalls = callsOf('findOrCreateNode')
    expect(nodeCalls).toHaveLength(2)
    // ①中英文类型映射：'技术' → technology；'concept' → concept
    expect(nodeCalls[0].args[2]).toBe('technology')
    expect(nodeCalls[1].args[2]).toBe('concept')
    // ②来源关联：chunkIndex 1/2 ⇒ 分别落在 chunk-1 / chunk-2（sourceId 也跟着对）
    expect(nodeCalls[0].args[4]).toBe('src-1')
    expect(nodeCalls[0].args[5]).toBe('chunk-1')
    expect(nodeCalls[1].args[4]).toBe('src-2')
    expect(nodeCalls[1].args[5]).toBe('chunk-2')

    const edgeCalls = callsOf('addGraphEdge')
    expect(edgeCalls).toHaveLength(1)
    expect(edgeCalls[0].args[3], '关系类型也要映射（依赖 → depends_on）').toBe('depends_on')
    expect(edgeCalls[0].args[1]).not.toBe(edgeCalls[0].args[2])

    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
    expect((result as { warnings?: string[] }).warnings).toBeUndefined()
  })

  it('GR-4: 查询用的 prompt 里带上了分块编号，且要求标注 chunkIndex', async () => {
    seedChunks(3)
    llm.responses = [extraction([{ label: 'X', type: 'concept', chunkIndex: 3 }])]
    await extractKnowledgeGraph('nb-1')
    expect(llm.calls).toBe(1)
    expect(llm.prompts[0]).toContain('[Chunk 1]')
    expect(llm.prompts[0]).toContain('[Chunk 3]')
    expect(llm.prompts[0]).toContain('chunkIndex')
  })

  it('GR-5: 没有 chunkIndex 时按 label 在块正文里搜；再找不到才兜底第一个块', async () => {
    db.chunks = [
      { id: 'chunk-a', sourceId: 'src-a', content: '这一段讲 A 主题' },
      { id: 'chunk-b', sourceId: 'src-b', content: '这一段讲 B 主题' },
    ]
    llm.responses = [
      extraction([
        { label: 'B 主题', type: 'concept' },
        { label: '完全没出现过的词', type: 'concept' },
      ]),
    ]
    await extractKnowledgeGraph('nb-1')
    const nodeCalls = callsOf('findOrCreateNode')
    expect(nodeCalls[0].args[5], '按 label 搜到 chunk-b').toBe('chunk-b')
    expect(nodeCalls[1].args[5], '都找不到就兜底第一个块').toBe('chunk-a')
  })

  it('GR-6: 跨批次时 chunkIndex 要按批内偏移换算（第 2 批的第 1 块 = 全局第 11 块）', async () => {
    seedChunks(12)
    llm.responses = [
      extraction([{ label: '第一批的实体', type: 'concept', chunkIndex: 1 }]),
      extraction([{ label: '第二批的实体', type: 'concept', chunkIndex: 11 }]),
    ]
    await extractKnowledgeGraph('nb-1')
    const nodeCalls = callsOf('findOrCreateNode')
    expect(nodeCalls).toHaveLength(2)
    expect(nodeCalls[0].args[5]).toBe('chunk-1')
    expect(nodeCalls[1].args[5], '11 - 1 - 10 = 0 ⇒ 第 2 批的第 1 块 ⇒ chunk-11').toBe('chunk-11')
  })

  it('GR-7: 单批失败不中断别的批，且进 warnings（部分失败必须可见）', async () => {
    seedChunks(20)
    llm.throwOn = new Set([1])
    llm.responses = [
      extraction([]),
      extraction([{ label: '第二批抽到的实体', type: 'concept', chunkIndex: 11 }]),
    ]
    const result = await extractKnowledgeGraph('nb-1') as { warnings?: string[]; nodes: unknown[] }
    expect(llm.calls, '两批都试过').toBe(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings![0]).toContain('第 1/2 批提取失败')
    expect(result.warnings![0]).toContain('第 1 批炸了')
    expect(result.nodes, '失败那批没抽到东西，但成功那批的实体在').toHaveLength(1)
  })

  it('GR-8: 超过上限（60 块）⇒ 只抽前 60 块并给出覆盖不完整的警告', async () => {
    seedChunks(75)
    const result = await extractKnowledgeGraph('nb-1') as { warnings?: string[] }
    expect(llm.calls, '最多 6 批 × 10 块').toBe(6)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings![0]).toContain('只提取了前 60 个分块（共 75 个）')
  })

  it('GR-9: LLM 返回非 JSON / 自环关系 / 找不到的节点 —— 都不许崩、不许建坏边', async () => {
    seedChunks(1)
    llm.responses = [
      '模型今天不想输出 JSON，直接说了句话',
    ]
    const first = await extractKnowledgeGraph('nb-1')
    expect(first.nodes).toHaveLength(0)
    expect(callsOf('addGraphEdge')).toHaveLength(0)

    // 自环 + 指向不存在节点的关系
    db.calls = []
    llm.responses = [
      extraction([{ label: 'A', type: 'concept', chunkIndex: 1 }], [
        { source: 'A', target: 'A', relation: '支持' },
        { source: 'A', target: '不存在的节点', relation: '支持' },
      ]),
    ]
    const second = await extractKnowledgeGraph('nb-1')
    expect(callsOf('addGraphEdge'), '自环与悬空关系都不建边').toHaveLength(0)
    expect(second.edges).toHaveLength(0)
  })

  it('GR-10: 社区发现按连通分量编号，孤立节点各自成一个社区', async () => {
    seedChunks(1)
    llm.responses = [
      extraction(
        [
          { label: '甲', type: 'concept', chunkIndex: 1 },
          { label: '乙', type: 'concept', chunkIndex: 1 },
          { label: '丙', type: 'concept', chunkIndex: 1 },
          { label: '孤岛', type: 'concept', chunkIndex: 1 },
        ],
        [
          { source: '甲', target: '乙', relation: '支持' },
          { source: '乙', target: '丙', relation: '支持' },
        ],
      ),
    ]
    const result = await extractKnowledgeGraph('nb-1') as { nodes: Array<{ label: string; community?: number }> }
    const communityOf = (label: string) => result.nodes.find((n) => n.label === label)?.community
    expect(communityOf('甲')).toBe(0)
    expect(communityOf('乙')).toBe(0)
    expect(communityOf('丙')).toBe(0)
    expect(communityOf('孤岛'), '孤立节点是另一个社区').toBe(1)
  })
})
