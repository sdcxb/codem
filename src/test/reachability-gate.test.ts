/**
 * 第 109 轮门禁：**"写了但没接线"必须被拦住**（把审计工具变成常驻门禁）。
 *
 * ## 为什么需要这条常驻门禁
 *
 * 第 108 轮修的宠物窗缺陷（错误边界写好了却没接，崩溃就是透明死窗口）**没有任何既有门禁能抓**：
 *  - 用例能过（它自己 import 自己测的东西）；
 *  - knip 的 "Unused files" 在这个仓库里是**空的**（实测，与配置有关）；
 *  - 覆盖率也看不出来（那个文件被测试覆盖着）。
 *
 * 所以这里把 `tools/audit/reachability-scan.mjs`（模块解析 + 可达性，带**两条已知答案对照**）
 * 作为门禁钉住，判据三条：
 *  ① **自检必须通过**：`MessageBubble` 可达、`sync-engine` 不可达 —— 不过就说明分析不可信，
 *    这时**不许**拿结论下判断（本条会红）；
 *  ② **不可达集合必须 ⊆ 白名单**（`tools/audit/reachability-allowlist.json`）——
 *    新冒出来的不可达文件要么接线、要么登记并写清类别；
 *  ③ **白名单不许有过期条目**（文件变可达了就要删掉，否则白名单会慢慢变成"历史垃圾场"）。
 *
 * ## 第 109 轮实测的一个坑（写在这里，免得下次又踩）
 *
 * 第一版把"未跟踪文件"也算进分析范围（`git ls-files --others`），于是**全量测试里偶发假红**：
 * 同一个套件里有若干用例会往 `src/` 下写临时产物（写完就删），扫描恰好在那一瞬间看到它，
 * 就报"新出现的不可达文件"。同一份代码：单跑通过、`npm run verify` 有时红。
 * 现在**只算 git 跟踪的文件**，并额外把这条判据做成 `npm run audit:reachability`
 * （`audit` 是串行跑的 CLI，不受测试并发影响）——所以这条门禁有两道：
 * 用例（快、进 verify 的全量跑）+ CLI（串行、进 `npm run audit`）。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { scanReachability, readAllowlist, checkAgainstAllowlist } from '../../tools/audit/reachability-scan.mjs'

const ROOT = path.resolve(__dirname, '..', '..')

describe('可达性门禁：写了但没接线的代码必须被拦住（第 109 轮）', () => {
  it('REACH-1: 工具自检通过（MessageBubble 必须可达 / sync-engine 必须不可达）', () => {
    const result = scanReachability(ROOT)
    expect(result.checks.entryMissing, '入口文件必须存在').toEqual([])
    expect(result.checks.messageBubbleReachable, '活着的组件必须被判为可达（否则分析不可信）').toBe(true)
    expect(result.checks.syncEngineUnreachable, '已知未接线的 sync-engine 必须被判为不可达（否则分析不可信）').toBe(true)
    expect(result.trustworthy).toBe(true)
    // 反向对照：算出来的规模必须像回事（避免"扫到 0 个文件"式恒真）
    expect(result.counts.prod).toBeGreaterThan(700)
    expect(result.counts.reached).toBeGreaterThan(700)
  })

  it('REACH-2: 不可达集合 ⊆ 白名单（新出现的不可达文件要么接线、要么登记）', () => {
    const result = scanReachability(ROOT)
    const verdict = checkAgainstAllowlist(result, readAllowlist(ROOT))
    expect(
      verdict.unexpected,
      '这些文件从入口静态不可达、且没登记 —— 要么接线，要么写进 tools/audit/reachability-allowlist.json 并写清类别',
    ).toEqual([])
  })

  it('REACH-3: 白名单不许有过期条目（变可达了就得删）', () => {
    const result = scanReachability(ROOT)
    const verdict = checkAgainstAllowlist(result, readAllowlist(ROOT))
    expect(verdict.stale, '这些文件已经可达了，白名单条目应删除').toEqual([])
  })

  it('REACH-4: 白名单每一条都必须带非空类别理由（不许"因为它不可达所以白名单"）', () => {
    const allowlist = readAllowlist(ROOT)
    const entries = Object.entries(allowlist.entries ?? {})
    expect(entries.length, '白名单不该是空的').toBeGreaterThan(10)
    const empty = entries.filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 8)
    expect(empty.map(([f]) => f)).toEqual([])
    // 两个"未接线"条目必须**明说**未接线（它们是 O-22 里待判的那两处）
    const unwired = entries.filter(([, reason]) => reason.includes('未接线')).map(([f]) => f)
    expect(unwired.sort()).toEqual(['src/components/RegenerateModelPopover.tsx', 'src/core/storage/sync-engine.ts'])
  })
})
