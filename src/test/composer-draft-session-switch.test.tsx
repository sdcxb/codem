/**
 * DRAFT-SWITCH —— 切会话时输入草稿不丢（2026-11-09 真机复现的根因回归）。
 *
 * 根因不是 useDraftPersistence 的 cleanup，而是 InputArea 的切会话 reset effect
 * 调了 clearDraft()：切回 A 时先 load 出 A 的草稿，紧接着 reset 又把它 removeSetting，
 * 于是框里空、settings 里也没有行（删除指纹）。
 *
 * 判据：
 * - S1：在 A 输入后立刻切到 B，A 的草稿已经写回；切回 A，框里与存储里都还是原文。
 * - S2：draftKey 与 sessionKey 同源（sessionKey 优先；props-only 的会话也必须落对键）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InputArea } from "../components/InputArea";
import type { CollaborationMode } from "../core/agent/agent";
import { getSetting } from "../core/storage/settings";

const A = "composer-draft-sess-A";
const B = "composer-draft-sess-B";

function mount(sessionKey: string) {
  return render(
    <InputArea
      sessionKey={sessionKey}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      disabled={false}
      isStreaming={false}
      collaborationMode={"default" as CollaborationMode}
      onModeChange={vi.fn()}
      connected={true}
    />,
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("DRAFT-SWITCH：切会话草稿不丢", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("S1: A 输入 → 切 B → 切回 A，草稿仍在（不被 clearDraft 删掉）", async () => {
    const view = mount("sess-A");
    fireEvent.change(box(), { target: { value: "A 的未发送草稿" } });

    view.rerender(
      <InputArea
        sessionKey="sess-B"
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected={true}
      />,
    );

    expect(getSetting(A), "切走 A 时必须把 A 的草稿写回自己的键").toBe("A 的未发送草稿");
    expect(getSetting(B), "不得把 A 的草稿写进 B").toBeNull();

    view.rerender(
      <InputArea
        sessionKey="sess-A"
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected={true}
      />,
    );

    await waitFor(() => expect(box().value, "切回 A 必须恢复 A 的草稿").toBe("A 的未发送草稿"));
    expect(getSetting(A), "A 的草稿行不许被切回动作删除").toBe("A 的未发送草稿");
  });

  it("S2: B 已有草稿，A→B 不得删/覆盖 B 的行", async () => {
    localStorage.setItem("codem-settings", JSON.stringify({ [B]: "B 原有草稿" }));
    // settings 走 storage 端口；上面 localStorage 只是兜底，显式写一遍更贴近真实
    const { setSetting } = await import("../core/storage/settings");
    setSetting(B, "B 原有草稿");

    const view = mount("sess-A");
    fireEvent.change(box(), { target: { value: "A 文本" } });
    view.rerender(
      <InputArea
        sessionKey="sess-B"
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected={true}
      />,
    );

    await waitFor(() => expect(box().value).toBe("B 原有草稿"));
    expect(getSetting(B), "B 的草稿不许被 A 或清空动作删掉").toBe("B 原有草稿");
  });
});
