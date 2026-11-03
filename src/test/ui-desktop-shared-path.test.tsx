/**
 * 桌面侧的共享 UI 判据（DTR-*）。
 *
 * B 项删除了 `?ui=shared` 只读预览页：预览页只是把共享组件挂在一个调试入口上，
 * 它不是产品路径，删掉之后再由它来证明"桌面能共用"就会假绿。
 *
 * 这里改钉**真实桌面路径**：
 * 1. 桌面默认聊天树 `ChatPanel` 渲染出的消息行就是共享气泡（原 DTR-3 的预览页证据改为真实路径）；
 * 2. 共享组件在桌面数据形态下可直接渲染（与移动端同一份）；
 * 3. 默认入口无条件渲染 `App`，`?ui=shared` 分支与预览实现都不存在。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ChatPanel } from "../components/ChatPanel";
import { TooltipProvider } from "../components/ui/tooltip";
import { useAppStore } from "../store";
import { MessageList, SessionList } from "../../packages/ui/src/components";
import { messageViews } from "../../packages/ui/src/session-view";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const sessions = [
  { id: "s1", title: "真机会话", messageCount: 3, lastMessageAt: 1_700_000_000_000 },
];

afterEach(() => {
  cleanup();
  useAppStore.setState({
    messages: [],
    loadedSessionId: null,
    messagesLoading: false,
    messagesReadUnavailable: false,
  });
});

describe("DTR-1 真实桌面 ChatPanel 的消息行 = 共享气泡", () => {
  it("消息由共享气泡 DOM 渲染（不是预览页、也不是第二份骨架）", () => {
    useAppStore.setState({
      messages: [
        { id: "m-user", role: "user", content: "你好", timestamp: 1, status: "done" },
        { id: "m-assistant", role: "assistant", content: "世界", timestamp: 2, status: "done" },
      ],
      loadedSessionId: "sess-dtr",
    });

    const { container } = render(
      <TooltipProvider>
        <ChatPanel
          onSend={() => undefined}
          onCancel={() => undefined}
          onToggleSidebar={() => undefined}
          connected
          model="m"
          onModelChange={() => undefined}
          sessionId="sess-dtr"
        />
      </TooltipProvider>,
    );

    const bubbles = container.querySelectorAll(".message.message-bubble");
    expect(bubbles).toHaveLength(2);
    expect(container.querySelector('[data-message-id="m-user"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-assistant"]')).not.toBeNull();
    expect(screen.getByText("你好")).toBeTruthy();
    expect(screen.getByText("世界")).toBeTruthy();
  });
});

describe("DTR-2 共享组件在桌面数据形态下渲染", () => {
  it("会话列表显示标题与消息数", () => {
    render(<SessionList sessions={sessions} onOpen={() => undefined} />);
    expect(screen.getByText("真机会话")).toBeTruthy();
    expect(screen.getByText(/3 条消息/)).toBeTruthy();
  });

  it("工具卡显示 `read` 且带输出（与移动端同一份渲染）", () => {
    const views = messageViews(
      [
        { id: "u", role: "user", content: "读文件" },
        { id: "t", role: "tool", content: "hello", toolCallId: "c1" },
      ],
      { c1: { name: "read", status: "done" } },
    );
    render(<MessageList views={views} />);
    // 第 2 步之后共享工具卡是胶囊行（桌面同一条 DOM）：标题是变体名，结果点开才显示
    expect(screen.getByText("Read")).toBeTruthy();
    const pill = document.querySelector(".tool-call-pill") as HTMLElement;
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    expect(screen.getByText("hello")).toBeTruthy();
  });
});

describe("DTR-3 默认入口只有真实 App（预览页已删除）", () => {
  it("main.tsx 无条件渲染 App，没有 ?ui=shared / SharedUiPreview 残留", () => {
    const main = read("src/main.tsx");
    expect(main, "入口必须渲染正式应用").toContain("<App />");
    expect(main, "预览分支必须删除").not.toMatch(/SharedUiPreview|URLSearchParams|location\.search/);
    expect(main).not.toContain("ui=shared");
    expect(existsSync(join(ROOT, "src/components/SharedUiPreview.tsx")), "预览页文件必须删除").toBe(false);
    expect(
      existsSync(join(ROOT, "src/core/remote/desktop-transport.ts")),
      "只读预览专用的桌面适配器必须删除",
    ).toBe(false);
  });
});
