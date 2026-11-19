/**
 * FEEDBACK-A11Y：赞/踩是 **toggle 按钮**，选中态必须进无障碍树。
 *
 * ## 现场
 *
 * `FeedbackButtons` 的选中态只体现在**行内 style 的 color**（inline 模式）或 `active` 类上，
 * 没有任何 `aria-pressed`。后果有两层：
 * - 读屏用户无法知道「这条回答我评价过没有」；
 * - 自动化爬取（第 5 轮的无变化点击检测）也看不出状态变化，只能记成「死点击」。
 *
 * ## 判据
 *
 * - 未评价 ⇒ 两个按钮 `aria-pressed="false"`；
 * - 点「赞」⇒ 赞 `true`、踩 `false`；再点一次 ⇒ 取消（`false`）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FeedbackButtons } from "../components/FeedbackButtons";
import { TooltipProvider } from "../components/ui/tooltip";
import { useAppStore, type Message } from "../store";

const msg = { id: "m-feedback", role: "assistant", content: "答案", timestamp: 1, status: "done" } as Message;

/** 每个用例都必须包在 TooltipProvider 里（Tooltip 脱离 Provider 会直接抛错） */
function renderButtons() {
  return render(
    <TooltipProvider>
      <FeedbackButtons message={msg} sessionId="s1" inline />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  act(() => {
    useAppStore.setState({ feedback: {} });
  });
});

describe("FEEDBACK-A11Y：赞/踩的 aria-pressed", () => {
  it("未评价时两个按钮都是 false", () => {
    renderButtons();
    expect(screen.getByLabelText(/赞/).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText(/踩/).getAttribute("aria-pressed")).toBe("false");
  });

  it("点赞后赞是 true、踩是 false；再点一次取消", () => {
    renderButtons();
    fireEvent.click(screen.getByLabelText(/赞/));
    expect(screen.getByLabelText(/赞/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/踩/).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByLabelText(/赞/));
    expect(screen.getByLabelText(/赞/).getAttribute("aria-pressed")).toBe("false");
  });
});
