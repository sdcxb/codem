/**
 * P1-1 命令中心：分组顺序、选中索引、Enter 执行必须一一对应。
 *
 * 旧实现把「对话」渲染在「项目」前面，但键盘索引按「项目先、对话后」算 ——
 * 一旦有会话结果，Enter 就会执行上一项。这里用真实渲染 + 键盘事件钉住。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchDialog } from '../components/SearchDialog'

const listSessions = vi.hoisted(() => vi.fn(() => []))
vi.mock('../core/storage/session', async (orig) => ({
  ...(await orig<any>()),
  listSessions: (...args: any[]) => listSessions(...args),
}))

const projectState = {
  projects: [
    { id: 'p1', name: 'Alpha', path: 'C:/alpha', pinned: false },
    { id: 'p2', name: 'Beta', path: 'C:/beta', pinned: false },
  ],
  currentProject: null,
  openProject: vi.fn(),
  getProjectSessions: vi.fn(() => []),
  switchSession: vi.fn(),
}

async function mockStore() {
  const storeMod: any = await import('../core/store')
  vi.spyOn(storeMod, 'useProjectStore').mockImplementation(((sel: any) =>
    sel ? sel(projectState) : projectState) as any)
}

describe('P1-1 命令中心', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSessions.mockReturnValue([])
    projectState.getProjectSessions.mockReturnValue([])
  })

  it('按渲染顺序选中：项目组第一项 Enter 就是第一个项目', async () => {
    await mockStore()
    const onSwitchProject = vi.fn()
    const onClose = vi.fn()
    render(
      <SearchDialog
        onClose={onClose}
        onSwitchProject={onSwitchProject}
        onNewSession={() => {}}
        onOpenSkills={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onSwitchProject).toHaveBeenCalledWith('p1')
    expect(onClose).toHaveBeenCalled()
  })

  it('方向键选择第二项后 Enter 执行第二项，不会错位', async () => {
    await mockStore()
    const onSwitchProject = vi.fn()
    render(
      <SearchDialog
        onClose={() => {}}
        onSwitchProject={onSwitchProject}
        onNewSession={() => {}}
        onOpenSkills={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onSwitchProject).toHaveBeenCalledWith('p2')
  })

  it('有会话结果时索引仍与渲染一致（旧实现的错位回归）', async () => {
    await mockStore()
    listSessions.mockReturnValue([{ id: 's1', title: 'Alpha chat' }])
    const onSwitchProject = vi.fn()
    const onClose = vi.fn()
    render(
      <SearchDialog
        onClose={onClose}
        onSwitchProject={onSwitchProject}
        onNewSession={() => {}}
        onOpenSkills={() => {}}
      />,
    )

    const input = document.body.querySelector('.search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alpha' } })
    await waitFor(() => expect(screen.getByText('Alpha chat')).toBeTruthy())

    // 项目 Alpha、会话 Alpha chat、命令；Enter 从第一项开始。
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSwitchProject).toHaveBeenCalledWith('p1')
  })

  it('Ctrl+数字按显示顺序选中，而不是按内部数组顺序', async () => {
    await mockStore()
    const onSwitchProject = vi.fn()
    render(
      <SearchDialog
        onClose={() => {}}
        onSwitchProject={onSwitchProject}
        onNewSession={() => {}}
        onOpenSkills={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSwitchProject).toHaveBeenCalledWith('p2')
  })
})
