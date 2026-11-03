/**
 * 共享 Markdown 判据（MD-1..3）：
 * - GFM 表格 / 代码块 / 粗体真的渲染（不是原样输出 `**`）；
 * - 流式正文同样走 Markdown；
 * - 原始 HTML 与 javascript: 链接不会变成可执行元素。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageList } from "../../packages/ui/src/components";

function assistant(body: string) {
  return [{ kind: "text" as const, id: "a1", role: "assistant" as const, roleLabel: "assistant", body }];
}

describe("MD-1 GFM 渲染", () => {
  it("粗体、代码块、表格都渲染", () => {
    render(
      <MessageList
        views={
          assistant("**粗体**\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |") as never
        }
      />,
    );
    expect(screen.getByText("粗体").tagName.toLowerCase()).toBe("strong");
    expect(document.body.textContent).toContain("const a = 1;");
    expect(document.querySelector("table")).toBeTruthy();
    expect(document.body.textContent).not.toContain("**粗体**");
  });
});

describe("MD-2 流式也走 Markdown", () => {
  it("streaming 文本里的粗体生效", () => {
    render(<MessageList views={[]} streaming="**流式粗体**" />);
    expect(screen.getByText("流式粗体").tagName.toLowerCase()).toBe("strong");
  });
});

describe("MD-3 安全", () => {
  it("原始 HTML 不生成元素，javascript: 链接被清空", () => {
    render(
      <MessageList
        views={assistant('<img src=x onerror="window.__xss=1">\n\n[x](javascript:alert(1))') as never}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    const a = document.querySelector("a");
    expect(a?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});
