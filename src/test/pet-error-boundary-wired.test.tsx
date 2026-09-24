/**
 * 第 108 轮门禁：**宠物窗的错误边界必须真的接在入口上**。
 *
 * ## 为什么要有这条
 *
 * `PetErrorBoundary` 是第 44 轮（P2-14）专门给宠物窗这个**独立 webview 入口**写的
 * （自包含、连样式都内联，文件头解释了为什么不能复用主窗的 `AppErrorBoundary`），
 * 但它**从来没有被接线** —— `pet-main.tsx` 一直直接渲染 `<PetWindowApp />`。
 * 这正是它要防的那个后果：渲染期一抛异常，宠物窗就是一块**透明的死窗口**
 * （没有文字、没有按钮，用户连"重新加载"都点不到）。
 *
 * 第 106/107 轮的可达性普查把它查了出来（`PetErrorBoundary.tsx` 只被测试 import、
 * 生产代码 0 引用）。本文件把两件事钉住：
 *  ① **接线**：入口必须把 `PetWindowApp` 包在 `PetErrorBoundary` 里（结构判据 + 反向对照）；
 *  ② **它真的兜得住**：子组件抛异常时渲染出诊断文本与「重新加载宠物界面」按钮（行为判据）；
 *  ③ **它必须保持自包含**：不许 import 主窗的存储/诊断模块（否则宠物 bundle 会被打穿，
 *     而且它自己的注释就是这么承诺的 —— 承诺要有判据）。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetErrorBoundary } from '../components/PetErrorBoundary'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

function Boom(): JSX.Element {
  throw new Error('宠物窗故意抛错（钻取）')
}

describe('宠物窗错误边界（第 108 轮接线）', () => {
  it('PET-EB-1: 入口把 PetWindowApp 包在 PetErrorBoundary 里', () => {
    const entry = read('src/pet-main.tsx')
    expect(entry).toContain('PetErrorBoundary')
    // 结构判据：边界必须在 App 外层（正则容忍换行与缩进）
    expect(entry).toMatch(/<PetErrorBoundary>\s*<PetWindowApp\s*\/>\s*<\/PetErrorBoundary>/)
    // 反向对照：不许出现"直接用根渲染 PetWindowApp"的老写法
    expect(entry).not.toMatch(/<React\.StrictMode>\s*<PetWindowApp\s*\/>\s*<\/React\.StrictMode>/)
  })

  it('PET-EB-2: 子组件抛异常时渲染诊断文本 + 可点的重新加载按钮（不是一块死窗口）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <PetErrorBoundary>
          <Boom />
        </PetErrorBoundary>,
      )
      const box = document.querySelector('[data-pet-error="1"]')
      expect(box, '必须留下可定位的错误块（data-pet-error）').toBeTruthy()
      expect(box!.textContent).toContain('宠物窗口渲染出错')
      expect(box!.textContent, '要带上原始错误信息，方便真机排查').toContain('宠物窗故意抛错')
      const retry = screen.getByRole('button', { name: /重新加载宠物界面/ })
      expect(retry).toBeTruthy()
      /*
       * 点得动（不是装饰）：子组件**每次都抛**，所以点完边界会再兜住一次并累加重试次数 ——
       * 连点 3 次后必须出现"可右键窗口退出"的升级提示（这是"反复崩溃时给用户一个下一步"的那条判据）。
       * ⚠️ 第一版断言"点完错误块消失"是错的：`<Boom />` 一重渲染就再抛，边界当然还在。
       */
      fireEvent.click(retry)
      fireEvent.click(screen.getByRole('button', { name: /重新加载宠物界面/ }))
      fireEvent.click(screen.getByRole('button', { name: /重新加载宠物界面/ }))
      const after = document.querySelector('[data-pet-error="1"]')!.textContent ?? ''
      expect(after, '反复失败要给下一步').toContain('已重试')
      expect(after).toContain('右键窗口退出')
    } finally {
      spy.mockRestore()
    }
  })

  it('PET-EB-3: 正常时原样渲染子组件（边界不改变成功路径）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <PetErrorBoundary>
          <div data-pet-ok="1">宠物正常</div>
        </PetErrorBoundary>,
      )
      expect(document.querySelector('[data-pet-ok="1"]')?.textContent).toBe('宠物正常')
      expect(document.querySelector('[data-pet-error="1"]')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('PET-EB-4: 它必须保持自包含 —— 不许 import 主窗的存储/诊断/样式模块', () => {
    const src = read('src/components/PetErrorBoundary.tsx')
    const imports = [...src.matchAll(/^import[^\n]*from\s+["']([^"']+)["']/gm)].map((m) => m[1])
    expect(imports.length, '实现里应当只有最少的 import').toBeGreaterThan(0)
    const forbidden = imports.filter((i) =>
      /persist-failure|core\/storage|core\/i18n|core\/icons|styles\.css|\.\.\/store/.test(i),
    )
    expect(forbidden, '宠物窗入口刻意不加载主窗的重依赖，边界也不能把入口打穿').toEqual([])
    // 行内样式而非类名（样式表失效时也要可见、可点）
    expect(src, '边界的可见性不能依赖样式表').toContain('data-pet-error')
    expect(src).toMatch(/style=\{\{/)
  })
})
