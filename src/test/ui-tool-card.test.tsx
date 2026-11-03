/**
 * 工具行判据（TOOLCARD-1..4）—— 第 2 步之后共享工具卡是**胶囊行**。
 *
 * 桌面与移动端现在共用 `packages/ui/src/tool-card.tsx` 的同一条 DOM：
 * - 长结果默认收起（明细不渲染）；
 * - 点击胶囊行展开全文，再点收起；
 * - 错误状态用错误前导图标 + 错误首行摘要（不再是纯文本 ✗）；
 * - 参数在展开后的 IN 区；
 * - 结果看起来是 unified diff 时仍按增删行着色。
 */
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageList } from "../../packages/ui/src/components";

const long = "A".repeat(600) + "TAIL_MARKER";
const args = JSON.stringify({ pattern: "*", limit: 10 }, null, 2);

function views(output: string, toolName = "read", toolStatus = "ok", extra: Record<string, unknown> = {}) {
  return [{ kind: "tool" as const, id: "t1", toolName, toolStatus, output, ...extra }];
}

function row(): HTMLElement {
  const el = document.querySelector(".tool-call-pill") as HTMLElement | null;
  expect(el, "必须渲染共享胶囊行").toBeTruthy();
  return el!;
}

describe("TOOLCARD-1 长结果默认收起", () => {
  it("默认不渲染明细（尾部不出现），胶囊行标记为收起", () => {
    render(<MessageList views={views(long) as never} />);
    expect(document.body.textContent).not.toContain("TAIL_MARKER");
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".tool-pill-detail")).toBeNull();
  });
});

describe("TOOLCARD-2 展开/收起", () => {
  it("点开显示全文，再点收起", () => {
    render(<MessageList views={views(long) as never} />);
    fireEvent.click(row());
    expect(document.body.textContent).toContain("TAIL_MARKER");
    fireEvent.click(row());
    expect(document.body.textContent).not.toContain("TAIL_MARKER");
  });
});

describe("TOOLCARD-3 参数与错误态", () => {
  it("错误状态有错误前导标记；展开后显示参数", () => {
    render(
      <MessageList
        views={[{ kind: "tool", id: "t2", toolName: "grep", toolStatus: "error", output: "boom", toolArgs: args }] as never}
      />,
    );
    expect(document.querySelector(".tool-pill-icon-error"), "错误行必须有错误状态标记").toBeTruthy();
    expect(document.querySelector(".tool-call-pill")?.className).toContain("error");
    fireEvent.click(row());
    expect(document.body.textContent).toContain("pattern");
  });
});

describe("TOOLCARD-4 diff 着色", () => {
  it("diff 文本按增删行着色", () => {
    const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new";
    render(<MessageList views={views(diff, "edit") as never} />);
    fireEvent.click(row());
    expect(document.querySelector(".tool-diff .add")?.textContent).toContain("+new");
    expect(document.querySelector(".tool-diff .del")?.textContent).toContain("-old");
  });
});
