/**
 * 终端键位处理（纯函数，可测试）
 *
 * 语义约定（P0 回归保护）：
 * - Ctrl+C 仅用于复制：有选区时复制并阻止默认；无选区时什么都不做（不发送 \x03）
 * - Ctrl+Shift+C 才向 PTY 发送 \x03 中断信号
 * - Ctrl+V 粘贴剪贴板内容到 PTY
 *
 * 返回 true 表示继续走 xterm 默认处理，返回 false 表示已消费该事件。
 */

export interface TerminalKeyHandlerDeps {
  getSelection: () => string;
  clearSelection: () => void;
  writeClipboard: (text: string) => Promise<void> | void;
  readClipboard: () => Promise<string>;
  writeToPty: (data: string) => void;
}

export function handleTerminalKeyEvent(
  event: KeyboardEvent,
  deps: TerminalKeyHandlerDeps,
): boolean {
  if (event.type !== "keydown") return true;

  // Ctrl+V — paste
  if (event.ctrlKey && !event.shiftKey && event.key === "v") {
    deps.readClipboard().then((text) => {
      if (text) deps.writeToPty(text);
    }).catch(() => {});
    return false;
  }

  // Ctrl+C — copy if selection exists, otherwise DO NOTHING (no interrupt)
  if (event.ctrlKey && !event.shiftKey && event.key === "c") {
    const selection = deps.getSelection();
    if (selection) {
      deps.writeClipboard(selection);
      deps.clearSelection();
    }
    return false; // No selection → don't send Ctrl+C either (prevents accidental interrupt)
  }

  // Ctrl+Shift+C — interrupt (send \x03 to PTY)
  if (event.ctrlKey && event.shiftKey && (event.key === "C" || event.key === "c")) {
    deps.writeToPty("\x03");
    return false;
  }

  return true;
}
