/**
 * 桌面「继续」判据（CONT-D1/2）：
 * - 组件只在被渲染时出现，点击触发回调（不做自动续跑）；
 * - ChatPanel 的接线必须**有条件**：正常结束的助手正文才显示，且点击发「继续」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContinueBar } from "../components/ContinueBar";

const root = join(__dirname, "..", "..");

describe("CONT-D1 组件", () => {
  it("点击触发 onContinue（只发一次）", () => {
    const onContinue = vi.fn();
    render(<ContinueBar onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /继续|Continue/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("CONT-D2 ChatPanel 接线", () => {
  const source = readFileSync(join(root, "src/components/ChatPanel.tsx"), "utf8");

  it("有出现条件（正常结束 + 助手正文 + 非流式）", () => {
    expect(source).toMatch(/const canContinue =[\s\S]*?!isSessionStreaming[\s\S]*?lastMessage\?\.role === "assistant"[\s\S]*?status \?\? "done"/);
  });

  it("点击发送「继续」，且不自动发", () => {
    expect(source).toContain("<ContinueBar");
    expect(source).toMatch(/onContinue=\{\(\) => \{[\s\S]*?onSend\("继续", \[\], \[\]\);/);
    expect(source, "不许在 useEffect 里自动发送").not.toMatch(/if \(canContinue\)[^]*?onSend\("继续"/);
  });
});
