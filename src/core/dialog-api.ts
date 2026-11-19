/**
 * 原生文件对话框（Tauri v2 dialog 插件）。
 *
 * ## 为什么要有这一层
 *
 * CI/CD 面板原来直接调 `invoke("dialog_save", …)` / `invoke("write_text_file", …)` ——
 * **这两个命令在 Rust 侧根本不存在**（全仓 133 个命令里没有），所以「保存工作流」按钮
 * 100% 失败，只是 catch 里会把错误写进 actionMsg，看起来像"偶发"。
 *
 * Tauri v2 的对话框在插件里，命令名带前缀、参数包在 `options` 里：
 *   `invoke("plugin:dialog|save", { options: { title, defaultPath, filters } })`
 * capabilities 已经授予 `dialog:default` / `dialog:allow-save`（见 `src-tauri/capabilities/default.json`）。
 *
 * 返回值：用户取消时是 `null`（不是空串），调用方要判 `null`。
 */

/** Tauri v2 的过滤器形状（与插件 JS API 一致）；只在本模块使用，不导出 */
interface SaveDialogFilter {
  name: string;
  extensions: string[];
}

export interface SaveDialogOptions {
  title?: string;
  /** 默认文件名/路径（插件只在支持时使用） */
  defaultPath?: string;
  filters?: SaveDialogFilter[];
}

function hasTauri(): boolean {
  return typeof (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke === "function";
}

/**
 * 打开「另存为」对话框，返回用户选定的绝对路径；取消返回 `null`。
 *
 * 非 Tauri 环境（浏览器/测试）返回 `null` —— 调用方应据此走浏览器下载兜底。
 */
export async function saveFileDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  if (!hasTauri()) return null;
  const invoke = (globalThis as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__.core.invoke;
  const result = await invoke("plugin:dialog|save", {
    options: {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    },
  });
  return typeof result === "string" && result ? result : null;
}
