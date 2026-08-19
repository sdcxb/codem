// @ts-nocheck
/**
 * @codem/ui-directory-picker — 目录选择器 UI 插件
 *
 * 提供目录选择器组件的注册和管理服务。
 * 支持原生（Tauri dialog）和浏览器（File System Access API）两种模式。
 *
 * 功能链路融入：
 * - 启动时：注册目录选择器服务，其他插件可通过 ctx.get('uiDirectoryPicker') 调用
 * - 停止时：选择器不可用 → 回退到手动输入路径
 */
import type { Plugin } from '../cordis/src/index.ts'

class DirectoryPickerService {
  private mode: 'native' | 'browser' | 'fallback' = 'fallback'

  constructor() {
    // 检测可用模式
    if (typeof (window as any)?.__TAURI__?.dialog?.open === 'function') {
      this.mode = 'native'
    } else if (typeof (window as any)?.showOpenFilePicker === 'function') {
      this.mode = 'browser'
    }
  }

  getMode() { return this.mode }

  async pick(options?: { multiple?: boolean; defaultPath?: string; title?: string }): Promise<string | string[] | null> {
    if (this.mode === 'native') {
      try {
        const { open } = (window as any).__TAURI__.dialog
        const result = await open({
          directory: true,
          multiple: options?.multiple || false,
          defaultPath: options?.defaultPath,
          title: options?.title || '选择目录',
        })
        return result
      } catch {
        return null
      }
    }

    if (this.mode === 'browser') {
      try {
        const handle = await (window as any).showOpenFilePicker({ mode: 'directory' })
        return handle.name
      } catch {
        return null
      }
    }

    // Fallback: 返回 null，调用方应提供手动输入 UI
    return null
  }

  /**
   * 验证路径是否存在（通过 Tauri fs 或 fetch）
   */
  async validate(path: string): Promise<boolean> {
    try {
      const fs = (window as any)?.__TAURI__?.fs
      if (fs) {
        await fs.readDir(path)
        return true
      }
    } catch (e) { console.warn('[ui-directory-picker-provider.ts]', e) }
    return false
  }
}

export const uiDirectoryPickerProvider: Plugin = (ctx: any) => {
  const picker = new DirectoryPickerService()

  const dispose = ctx.provide('uiDirectoryPicker', {
    getMode: () => picker.getMode(),
    pick: (options?: any) => picker.pick(options),
    validate: (path: string) => picker.validate(path),
  })

  return dispose
}
