/**
 * 按「标题文案」找运行模式的按钮（第 186 轮）。
 *
 * ## 为什么需要它
 *
 * `settings-dead-keys.test.ts` 原来按**位置**取第二个模式按钮（`modeButtons[1]` = CLI）。
 * 第 186 轮把 CLI 收进「更多」之后位置变了，按下标取会点到「更多」按钮 ——
 * 用例红在"点了没反应"，**看着像功能坏了，其实是选择器过期**。
 * 按文案找就不会因为加了个按钮而失效。
 *
 * ## 一条踩过的坑（记下来免得再犯）
 *
 * 第一版用 XPath（`document.evaluate(..., XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, ...)`）——
 * **jsdom 没有实现 `XPathResult`**，直接 `ReferenceError: XPathResult is not defined`。
 * 现在改回纯 `querySelectorAll` + 文案匹配：零环境依赖，出错时信息也更好读。
 *
 * @param container 查询范围（通常是 `render()` 返回的 container）
 * @param title     模式标题文案（如 `"CLI"` / `"API"`）—— **子串匹配**，中英文都适用
 * @returns         命中的按钮，找不到返回 `null`
 */
export function findModeButton(container: ParentNode, title: string): HTMLElement | null {
  const buttons = [...container.querySelectorAll<HTMLElement>(".mode-btn")];
  for (const btn of buttons) {
    const label = btn.querySelector(".mode-title")?.textContent ?? "";
    if (label.includes(title)) return btn;
  }
  return null;
}
