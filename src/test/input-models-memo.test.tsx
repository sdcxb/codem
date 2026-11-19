/**
 * INPUT-MODELS：模型列表不许**每次击键**重算（第 5 轮性能修复）。
 *
 * ## 现场
 *
 * `InputArea` 的渲染体里有 `const modelList = getModelsForMode(mode)`，而它内部是
 * `getConfiguredApiModels()`：对 `codem-settings`、动态模型、免费模型插件各做一次整份
 * `JSON.parse`。也就是说**每敲一个字 ≥3 次整份解析**，是输入延迟的直接来源之一。
 *
 * ## 判据（行为）
 *
 * - 连续输入多个字符（同一 mode、无设置变更）⇒ `getModelsForMode` **只被调用 1 次**；
 * - 收到 `codem-settings-changed` 事件 ⇒ 重新计算一次（设置变了选择器必须刷新）；
 * - 切换 mode（cli ↔ api）⇒ 重新计算（列表本身不同）。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { CollaborationMode } from "../core/agent/agent";

const getModelsForMode = vi.fn((mode: string) => [{ id: `${mode}-model`, name: `${mode} 模型`, providerId: "p" }]);

vi.mock("../core/model-config", async () => {
  const actual = await vi.importActual<typeof import("../core/model-config")>("../core/model-config");
  return { ...actual, getModelsForMode: (mode: string) => getModelsForMode(mode) };
});

import { InputArea } from "../components/InputArea";

function mount(mode: "cli" | "api" = "api") {
  return render(
    <InputArea
      onSend={vi.fn()}
      onCancel={vi.fn()}
      disabled={false}
      isStreaming={false}
      collaborationMode={"default" as CollaborationMode}
      onModeChange={vi.fn()}
      connected={true}
      mode={mode}
    />,
  );
}

beforeEach(() => {
  getModelsForMode.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("INPUT-MODELS：模型列表缓存", () => {
  it("连续输入 5 个字符只算一次（不是每次击键都整份解析设置）", () => {
    const { container } = mount();
    const box = container.querySelector("textarea")!;
    const before = getModelsForMode.mock.calls.length;
    for (let i = 1; i <= 5; i++) {
      fireEvent.change(box, { target: { value: "x".repeat(i) } });
    }
    const after = getModelsForMode.mock.calls.length;
    expect(after - before, "每次击键都重算模型列表 ⇒ 输入延迟随打字量线性上升").toBe(0);
  });

  it("设置变更事件到达后重新计算", () => {
    mount();
    const before = getModelsForMode.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("codem-settings-changed"));
    });
    expect(getModelsForMode.mock.calls.length).toBeGreaterThan(before);
  });

  it("切换 mode 会重新计算（cli / api 列表不同）", () => {
    const { rerender } = mount("api");
    const before = getModelsForMode.mock.calls.length;
    rerender(
      <InputArea
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected={true}
        mode="cli"
      />,
    );
    expect(getModelsForMode.mock.calls.length).toBeGreaterThan(before);
  });
});
