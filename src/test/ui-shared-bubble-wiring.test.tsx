/**
 * 第 2 步「桌面默认路径切到共享 UI」的接线判据（WIRE-1..5）。
 *
 * 这一步的主张只有两句：
 * 1. 消息气泡的骨架只有**一份**（`packages/ui/src/message-bubble.tsx`），桌面入口只做平台注入；
 * 2. 工具行的胶囊只有**一份**（`packages/ui/src/tool-card.tsx`），桌面只注入专用明细。
 *
 * 下面每条都能被"把旧实现放回去 / 再加一层壳"这种改动弄红。
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MessageBubble } from "../components/MessageBubble";
import { MessageBubble as SharedMessageBubble } from "../../packages/ui/src/message-bubble";
import { ToolCardView } from "../../packages/ui/src/tool-card";
import { ToolCallCard } from "../components/ToolCallCard";
import { TooltipProvider } from "../components/ui/tooltip";
import type { Message } from "../store";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const msg: Message = {
  id: "m1",
  role: "assistant",
  content: "hello",
  timestamp: 0,
  status: "done",
};

describe("WIRE：桌面默认路径 = 共享实现（第 2 步）", () => {
  it("WIRE-1: 桌面入口只剩平台注入，不含气泡骨架", () => {
    const entry = read("src/components/MessageBubble.tsx");
    expect(entry, "必须渲染共享气泡").toContain("SharedMessageBubble");
    expect(entry, "必须注入桌面平台").toContain("ChatPlatformProvider");
    expect(entry, "入口里不许再有气泡骨架").not.toContain("message-bubble ${");
    expect(entry).not.toContain('className="message-body"');
    expect(entry).not.toContain("<UserAvatar");
  });

  it("WIRE-2: 共享气泡不反向依赖桌面运行时（store / core / src / Tauri）", () => {
    for (const file of ["packages/ui/src/message-bubble.tsx", "packages/ui/src/chat-platform.tsx"]) {
      const src = read(file);
      expect(src, `${file} 不得 import 桌面 store`).not.toContain('from "../store"');
      expect(src, `${file} 不得 import 桌面 core`).not.toContain('from "../core');
      expect(src, `${file} 不得 import 桌面 src`).not.toContain('from "../../src');
      expect(src, `${file} 不得直接使用 Tauri`).not.toContain("@tauri-apps");
    }
  });

  it("WIRE-3: 缺 Provider 直接抛错 —— 没有默认平台、也没有第二条渲染路径", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<SharedMessageBubble message={msg} />)).toThrow(/ChatPlatformProvider/);
    spy.mockRestore();
  });

  it("WIRE-4: 桌面入口渲染出来的就是共享气泡（同一份类名/数据属性）", () => {
    const { container } = render(
      <TooltipProvider>
        <MessageBubble message={msg} />
      </TooltipProvider>,
    );
    const bubble = container.querySelector(".message.message-bubble.assistant");
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute("data-message-id")).toBe("m1");
    expect(bubble?.getAttribute("data-message-kind")).toBe("assistant");
    expect(container.querySelector(".message-body")).not.toBeNull();
  });

  it("WIRE-5: 通用工具在桌面与共享卡上渲染出**同一棵 DOM**（没有第二层壳）", () => {
    const props = {
      toolName: "todowrite",
      toolArgs: JSON.stringify({ todos: [{ title: "a" }] }),
      toolResult: "ok",
      status: "done" as const,
    };
    render(<ToolCardView {...props} />);
    const sharedHtml = document.querySelector(".tool-call-card-wrap")!.outerHTML;
    cleanup();

    render(<ToolCallCard {...props} />);
    const desktopHtml = document.querySelector(".tool-call-card-wrap")!.outerHTML;
    expect(desktopHtml, "桌面工具卡必须与共享卡逐字一致（只允许注入明细）").toBe(sharedHtml);

    // 展开后也一致（通用 IN/OUT 由共享卡渲染，桌面不再插手）
    fireEvent.click(document.querySelector(".tool-call-pill") as HTMLElement);
    const desktopOpen = document.querySelector(".tool-pill-detail")!.innerHTML;
    cleanup();
    render(<ToolCardView {...props} />);
    fireEvent.click(document.querySelector(".tool-call-pill") as HTMLElement);
    const sharedOpen = document.querySelector(".tool-pill-detail")!.innerHTML;
    expect(desktopOpen).toBe(sharedOpen);
  });

  it("WIRE-6: 胶囊行与通用 IN/OUT 只出现在共享包；桌面只有专用明细与附加区", () => {
    const shared = read("packages/ui/src/tool-card.tsx");
    const desktop = read("src/components/ToolCallCard.tsx");
    expect(shared, "共享卡必须拥有胶囊行").toContain('className="tool-call-card-wrap"');
    expect(shared, "共享卡必须拥有通用 IN/OUT").toContain("tool-io-section--bordered");
    expect(desktop, "桌面必须复用共享卡").toContain("ToolCardView");
    expect(desktop, "桌面不许再自带胶囊行").not.toContain("tool-call-pill");
    // 桌面只保留"附加区"（metadata.file_paths / spill），通用 IN/OUT 必须在共享卡里
    expect(desktop, "桌面不许再自带通用 IN 区").not.toContain(">IN<");
    expect(desktop, "桌面不许再自带通用 OUT 区").not.toContain(">OUT<");
    // 专用卡仍然在桌面（Terminal/Diff/Read/Search/Web）
    for (const marker of ["TerminalBlock", "DiffBlockCard", "ReadBlockCard", "SearchBlockCard", "WebSearchResultCard"]) {
      expect(desktop, `专用卡 ${marker} 必须保留在桌面`).toContain(marker);
    }
  });
});
