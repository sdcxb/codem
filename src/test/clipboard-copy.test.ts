/**
 * CLIP-1：复制到剪贴板必须**永不抛**，且失败要能被调用方看见（第 5 轮真机修复）。
 *
 * ## 现场（真机爬取打出来的 3 条未捕获拒绝）
 *
 *     NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Document is not focused.
 *
 * 触发条件很普通：窗口没聚焦时点「复制消息」、或用自动化驱动点击。原来十来处调用点
 * 直接 `navigator.clipboard.writeText(x)` 不管返回值 ⇒ 用户看到「点了没反应」，
 * 控制台里是未捕获拒绝（`main.tsx` 只 `console.error`，界面上毫无痕迹）。
 *
 * ## 判据
 *
 * - Clipboard API 拒绝 ⇒ `copyText` 返回 `false`（**不抛**），并尝试 `execCommand` 兜底；
 * - Clipboard API 不可用 ⇒ 直接走兜底；
 * - 兜底也失败 ⇒ `false`（调用方据此提示，而不是谎报「已复制」）；
 * - 成功 ⇒ `true`。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { copyText } from "../utils/clipboard";

let execResult = true;
let execCalls = 0;

beforeEach(() => {
  execResult = true;
  execCalls = 0;
  document.execCommand = ((cmd: string) => {
    if (cmd === "copy") {
      execCalls += 1;
      return execResult;
    }
    return false;
  }) as typeof document.execCommand;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe("CLIP-1：复制不抛、失败可见", () => {
  it("Clipboard API 成功 ⇒ true，且不走兜底", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    await expect(copyText("你好")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("你好");
    expect(execCalls).toBe(0);
  });

  it("Clipboard API 拒绝（未聚焦）⇒ 返回 false 而不是未捕获拒绝，并尝试兜底", async () => {
    setClipboard(async () => {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    });
    await expect(copyText("你好")).resolves.toBe(true); // 兜底成功
    expect(execCalls).toBe(1);
  });

  it("两条路都失败 ⇒ false（调用方据此提示，不谎报成功）", async () => {
    setClipboard(async () => {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    });
    execResult = false;
    await expect(copyText("你好")).resolves.toBe(false);
  });

  it("没有 Clipboard API ⇒ 直接兜底", async () => {
    setClipboard(undefined);
    await expect(copyText("你好")).resolves.toBe(true);
    expect(execCalls).toBe(1);
  });

  it("空文本不触发任何复制", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCalls).toBe(0);
  });
});
