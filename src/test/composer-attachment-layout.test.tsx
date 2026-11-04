/**
 * 输入区附件布局回归（用户真机截图）：
 *
 * 1. 选着 `deepseek-flash`（原生多模态）时，**不许**再提示「当前模型不支持视觉」；
 * 2. 粘贴/上传图片后，左侧「上下文」徽章与视觉提示**不许**和编辑区抢同一行 ——
 *    旧 DOM 把 `ContextBadgeList` 放进 `.input-textarea-row`，徽章一长就把
 *    textarea 挤到右边；视觉提示又是 `.pending-attachments` 的 flex 子项，长句会横穿编辑区。
 *
 * 结构判据比截图稳：徽章行必须在编辑行**之前**、提示必须在附件行**之外**。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { InputArea } from "../components/InputArea";
import type { CollaborationMode } from "../core/agent/agent";

function renderComposer(model: string) {
  const props = {
    onSend: vi.fn(),
    onCancel: vi.fn(),
    disabled: false,
    isStreaming: false,
    collaborationMode: "default" as CollaborationMode,
    onModeChange: vi.fn(),
    connected: true,
    model,
  };
  return render(<InputArea {...props} />);
}

async function uploadImage(container: HTMLElement, name = "pic.png") {
  const input = container.querySelector<HTMLInputElement>("#file-upload-input");
  expect(input).toBeTruthy();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = new File([bytes], name, { type: "image/png" });
  fireEvent.change(input!, { target: { files: [file] } });
  await waitFor(() => expect(container.querySelector(".pending-attachment")).toBeTruthy());
}

describe("COMPOSER-1 视觉提示按当前模型判定", () => {
  it("deepseek-flash（原生多模态）不再提示「不支持视觉」", async () => {
    const { container } = renderComposer("deepseek-flash");
    await uploadImage(container);
    expect(container.textContent).not.toContain("当前模型不支持视觉");
    expect(container.querySelector(".attachment-hint")).toBeNull();
  });

  it("纯文本模型仍如实提示「图片将以文字标注发送」", async () => {
    const { container } = renderComposer("deepseek-v4-pro");
    await uploadImage(container);
    const hint = container.querySelector(".attachment-hint");
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain("当前模型不支持视觉");
  });
});

describe("COMPOSER-2 附件/徽章不得挤占编辑区", () => {
  it("上下文徽章在编辑行之外（独占一行，位于 input-wrapper 之前）", async () => {
    const { container } = renderComposer("deepseek-flash");
    await uploadImage(container);

    const badgeList = container.querySelector(".context-badge-list");
    expect(badgeList).toBeTruthy();
    expect(
      container.querySelector(".input-textarea-row .context-badge-list"),
      "徽章行不许出现在 textarea 所在行（会把编辑区挤到右边）",
    ).toBeNull();
    expect(container.querySelector(".input-wrapper .context-badge-list")).toBeNull();
  });

  it("视觉提示独占一块，不是附件行的 flex 子项（长提示不会横穿编辑区）", async () => {
    const { container } = renderComposer("deepseek-v4-pro");
    await uploadImage(container);

    expect(container.querySelector(".attachment-hint")).toBeTruthy();
    expect(
      container.querySelector(".pending-attachments .attachment-hint"),
      "提示不能作为附件卡片的兄弟 flex 子项",
    ).toBeNull();
  });

  it("编辑区仍是整行的唯一主体（textarea 在 backdrop wrapper 内）", async () => {
    const { container } = renderComposer("deepseek-flash");
    await uploadImage(container);
    const wrapper = container.querySelector(".input-textarea-row > .input-backdrop-wrapper");
    expect(wrapper).toBeTruthy();
    expect(wrapper!.querySelector("textarea.message-input")).toBeTruthy();
  });
});
