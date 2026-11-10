/**
 * CMP-P-3（24 §P0-5 / §6）：**同一会话、同一时刻的面板与水位提示条必须使用同一分母与口径**。
 *
 * ## 被守的缺陷
 *
 * 水位模块（`core/context/water-level.ts`）早就是「唯一计算入口」，但 `ContextMonitor`
 * 仍自己算一遍进度条：不加系统提示/工具定义（overhead），还把 `used` 夹到分母以内
 * ⇒ 同一会话同一时刻，面板与提示条/引擎是**两个百分比**（真机第 72、122 轮各栽过一次）。
 * 旧判据 `CMP-1..7` 只钉「面板内部自洽」，钉不住「面板 vs 水位」。
 *
 * ## 判据与变异
 *
 * `CMP-P-3`：渲染真实面板，把它显示的 `used / available`、`data-water-source`、压力等级
 * 与 `readContextWaterLevel(sessionId)` 的返回值逐项对齐。
 *
 * 变异：把面板改回自己的 `usedTokens`（不加 overhead / 夹到分母）⇒ used 与水位不等 ⇒ 红；
 * 把 `data-water-source` 写死 `estimate` ⇒ 红（它必须如实反映 exact/estimate/unknown）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ContextMonitor } from "../components/ContextMonitor";
import { createMessage } from "../core/storage/message";
import { readContextWaterLevel } from "../core/context/water-level";
import { getContextManager } from "../core/context/context";

const SESSION = "cm-water-parity";

function seedMessages(count = 6) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `cm-water-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `第 ${i} 条消息：` + "上下文水位同源判据的填充正文。".repeat(8),
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION,
    );
  }
}

const PRESSURE_LABEL: Record<number, string> = { 0: "正常", 1: "中等", 2: "较高", 3: "临界" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getContextManager().updateConfig({ segmentEpochs: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CMP-P-3：面板与水位提示条同源", () => {
  it("CMP-P-3：面板显示的 used/available、来源、压力等级与 readContextWaterLevel 逐项一致", async () => {
    seedMessages();

    const water = readContextWaterLevel(SESSION);
    expect(water.authoritative, "前提：内存路径的隐藏状态是权威的（否则本条测的是 unknown 分支）").toBe(true);
    expect(water.available, "前提：水位必须有真实分母").toBeGreaterThan(0);

    render(<ContextMonitor sessionId={SESSION} visible={true} />);

    const info = await waitFor(() => {
      const el = document.querySelector(".context-usage-info");
      expect(el, "面板必须已经渲染出占用行").toBeTruthy();
      /* 等面板的 3 秒轮询先跑一次（消息数读进来之后才可能对上 water） */
      expect(el!.textContent ?? "").toContain(water.used.toLocaleString());
      return el as HTMLElement;
    });

    const text = info.textContent ?? "";
    expect(
      text,
      `面板占用必须就是水位那一对数字（water = ${water.used}/${water.available}，面板 = ${text}）`,
    ).toContain(`${water.used.toLocaleString()} / ${water.available.toLocaleString()} tokens`);
    expect(
      info.getAttribute("data-water-source"),
      "来源必须如实标出（exact / estimate / unknown），不许写死",
    ).toBe(water.source);

    const percent = Math.min(100, Math.round((water.used / water.available) * 100));
    expect(text, "百分比必须由同一对数字导出").toContain(`${percent}%`);

    const pressureRow = screen.getByText("压力等级").parentElement?.textContent ?? "";
    expect(
      pressureRow,
      `压力等级必须与水位同一口径（water.level=${water.level}）`,
    ).toContain(PRESSURE_LABEL[water.level]);
  });
});
