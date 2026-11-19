/**
 * 复制到剪贴板（**唯一入口**）。
 *
 * ## 为什么需要一层
 *
 * 真机爬取（第 5 轮）里点「复制消息」打出 3 条未捕获拒绝：
 *
 *     NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Document is not focused.
 *
 * 原因：`navigator.clipboard.writeText()` 在**窗口未聚焦**（用户点了别处、或自动化驱动点击）
 * 时必然拒绝，而调用点大多直接 `navigator.clipboard.writeText(x)` 不管返回值 —— 于是
 * 用户看到的是「点了复制、没反应」，控制台里是未捕获拒绝。
 *
 * ## 策略
 *
 * 1. 先试异步 Clipboard API；
 * 2. 失败/不可用时退回 `document.execCommand("copy")`（老 WebView / 未聚焦场景仍常可用）；
 * 3. 两条都不行就**返回 false**，由调用方决定提示什么（绝不静默成功）。
 *
 * 所有调用点都应 `const ok = await copyText(x)`，只在 `ok === true` 时显示「已复制」。
 */

/** 同步兜底：临时 textarea + execCommand */
function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  /* 必须在视口内且不被读出：用 fixed + 透明，而不是 display:none（后者选不中） */
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    /* 还原用户原来的选区：复制不该把光标位置弄丢 */
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
}

/**
 * 复制文本。**永远不抛**：成功返回 true，失败返回 false。
 *
 * @param text 要复制的文本
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? "");
  if (value === "") return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 未聚焦 / 权限被拒 / 非安全上下文 —— 走兜底 */
  }
  return copyWithExecCommand(value);
}
