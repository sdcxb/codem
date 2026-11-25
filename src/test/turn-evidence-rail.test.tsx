/**
 * 工作证据 rail 判据（design/unslop-v2）
 *
 * ## 守的是什么
 *
 * | # | 行为 |
 * |---|---|
 * | EV-1 | 有文件变更 + 验证记录 ⇒ rail 出现，文件 chip 可点开 diff，验证结果有**文字**（通过/失败） |
 * | EV-2 | 完全没有数据 ⇒ **不渲染**（不画空壳） |
 * | EV-3 | 只有验证记录 ⇒ 只显示验证区（不硬造一个空文件区） |
 * | EV-4 | 只有文件记录 ⇒ 只显示文件区，**不显示**任何验证结论（不能假绿） |
 * | EV-5 | 文案口径：文件是「本会话最近一次记录」，不许写成「本轮」 |
 * | EV-6 | 只输出 `turn-evidence-*` 类名，不新增内联样式 |
 *
 * 走真实取数路径（`FileChangeStorage.loadBySession` + `listVerificationChecks`），
 * 落在内存端口上；这与 `file-changes-list-diff.test.tsx` 同一种夹具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DeliverableFiles } from '../components/DeliverableFiles'
import { setStoragePort } from '../core/storage/port'
import { __resetFileChangeWindow } from '../core/storage/file-change-storage'
import {
  __resetVerificationChecksForTests,
  recordVerificationCheck,
} from '../core/environment/verification-checks'
import { createFakeStoragePort } from './fake-storage-port'

const SESSION = 'sess-evidence'
const WORKSPACE = 'C:/ws'

const ROW = {
  id: 'tfc-evidence-1',
  session_id: SESSION,
  message_id: 'm-evidence',
  turn_index: 2,
  before_tree: 'a'.repeat(40),
  after_tree: 'b'.repeat(40),
  changed_files: JSON.stringify([
    { path: 'C:\\ws\\src\\a.ts', status: 'M', additions: 3, deletions: 1 },
    { path: 'C:\\ws\\docs\\readme.md', status: 'A' },
  ]),
  patch_sha256: null,
  current_brief: 'Turn 2',
  status: 'completed',
  created_at: 2_000,
}

function mountPort(seed: { turn_file_changes?: unknown[] } = {}) {
  setStoragePort(
    createFakeStoragePort({
      seed: {
        settings: [],
        turn_file_changes: (seed.turn_file_changes ?? []) as never[],
      },
    }) as never,
  )
}

beforeEach(() => {
  __resetFileChangeWindow()
  mountPort()
  __resetVerificationChecksForTests()
})

afterEach(() => {
  cleanup()
  setStoragePort(null)
  __resetFileChangeWindow()
})

describe('工作证据 rail', () => {
  it('EV-1/EV-5/EV-6：文件 + 验证都有数据时出现，chip 可点开 diff，结论有文字', async () => {
    mountPort({ turn_file_changes: [ROW] })
    recordVerificationCheck(SESSION, { command: 'npx tsc --noEmit', ok: true })
    recordVerificationCheck(SESSION, { command: 'npx vitest run', ok: false })

    const onViewDiff = vi.fn()
    const { container } = render(
      <DeliverableFiles sessionId={SESSION} workspace={WORKSPACE} onViewDiff={onViewDiff} />,
    )

    await waitFor(() => {
      expect(container.querySelector('.turn-evidence-rail'), '有证据时 rail 必须出现').toBeTruthy()
    })

    const text = container.textContent ?? ''
    expect(text, 'rail 标题').toContain('工作证据')
    expect(text, '文件区').toContain('最近改动')
    expect(text, '文件 chip（工作区相对路径）').toContain('src/a.ts')
    expect(text).toContain('docs/readme.md')
    expect(text, '验证区').toContain('最近验证')
    expect(text, '验证命令').toContain('npx tsc --noEmit')
    expect(text, '验证命令').toContain('npx vitest run')
    expect(text, '通过必须是文字，不只颜色').toContain('通过')
    expect(text, '失败必须是文字，不只颜色').toContain('失败')
    expect(text, '文件口径要写实').toContain('本会话最近一次记录')
    expect(text, '不许把最近一次记录说成「本轮」').not.toContain('本轮')

    expect(container.querySelectorAll('[style]'), 'rail 不许新增内联样式').toHaveLength(0)

    fireEvent.click(screen.getByText('src/a.ts'))
    expect(onViewDiff, '文件 chip 必须能打开 diff').toHaveBeenCalledTimes(1)
    const [record, file] = onViewDiff.mock.calls[0] as [{ id: string }, { path: string }]
    expect(record.id).toBe(ROW.id)
    expect(file.path).toBe('C:\\ws\\src\\a.ts')
  })

  it('EV-2：完全没有数据 ⇒ 不渲染任何空壳', async () => {
    const { container } = render(<DeliverableFiles sessionId="sess-empty" workspace={WORKSPACE} />)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(container.querySelector('.turn-evidence-rail'), '没有证据就不许占位').toBeNull()
    expect(container.textContent, '不许输出空文案').toBe('')
  })

  it('EV-3：只有验证记录 ⇒ 只显示验证区', async () => {
    recordVerificationCheck(SESSION, { command: 'npm run build', ok: true })
    const { container } = render(<DeliverableFiles sessionId={SESSION} workspace={WORKSPACE} />)

    await waitFor(() => {
      expect(container.querySelector('.turn-evidence-checks')).toBeTruthy()
    })
    expect(container.querySelector('.turn-evidence-files'), '没有文件就不许画文件区').toBeNull()
    expect(container.textContent).toContain('npm run build')
    expect(container.textContent).toContain('通过')
  })

  it('EV-4：只有文件记录 ⇒ 不显示任何验证结论（不能假绿）', async () => {
    mountPort({ turn_file_changes: [ROW] })
    const { container } = render(<DeliverableFiles sessionId={SESSION} workspace={WORKSPACE} />)

    await waitFor(() => {
      expect(container.querySelector('.turn-evidence-files')).toBeTruthy()
    })
    expect(container.querySelector('.turn-evidence-checks'), '没有验证记录就不许画验证区').toBeNull()
    expect(container.textContent, '不许出现假「通过」').not.toContain('通过')
    expect(container.textContent, '不许出现假「失败」').not.toContain('失败')
  })
})
