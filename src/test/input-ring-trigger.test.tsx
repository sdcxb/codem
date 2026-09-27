/**
 * RING-1 —— **输入框焦点环：只在"真的在编辑"时出现**（第 187 轮）。
 *
 * 用户第四次反馈同一处：「刚才那个外边框多的紫色条，**现在常显了**」。
 *
 * ## 实测到的两个成因（都不在"环有多粗"上，所以前面三轮调宽度全都没解决）
 *
 * `_diag-187-four-edges.mjs` 把输入卡**四条边**在失焦/聚焦两种状态下各扫一遍：
 * ```
 *   失焦：四条边 0 个紫像素
 *   聚焦 textarea：上边 y=590/591 一条**整宽**紫线（x 从 116 铺到 1048+）
 * ```
 * 这条线正好压在**面板顶部那条通宽边界**上，所以观感是"外边栏多了一条常亮紫条"。两个成因：
 *
 * 1. **触发面太宽**：环挂在 `.input-card-container:focus-within` 上 ——
 *    卡里**任何**控件（工具条按钮、模式按钮…）拿到焦点都会点亮这整圈，
 *    即使根本没在编辑文字；而且一旦点进输入框，打字全程它都亮着。
 *    ⇒ 改为 `:has(.message-input:focus-visible)`：只有**文字编辑框自身的键盘可见焦点**才点亮。
 * 2. **开机就抢焦点**：`InputArea` 里那条"语音停止后恢复光标"的 effect 写成
 *    `if (!isListeningVoice) { ta.focus() }` —— 而初次挂载时 `isListeningVoice` 就是 `false`
 *    ⇒ **应用一打开就把焦点塞进输入框**，于是环开机即亮。
 *    ⇒ 改成只在「正在听 → 停止」这**一个跃迁**上恢复焦点。
 *
 * ## 本文件的判据
 *
 * - RING-1a：挂载后输入框**不许**自动获得焦点（这就是"开机常显"的直接成因）。
 * - RING-1b：源码里那条恢复光标的 effect 必须**带跃迁判断**（`prevListeningRef`），
 *   不许退回"当前没在听就 focus"的形态。
 * - RING-1c：环的触发条件必须是 `:has(.message-input:focus-visible)`，
 *   且不许留下 `.input-card-container:focus-within` 的环规则。
 *
 * ⚠️ RING-1b 是**源码判据**：`isListeningVoice` 来自语音引擎 hook，行为级要牵进整套语音夹具
 * （MediaRecorder / Web Speech），代价远大于这条判据守住的东西。按本仓库的做法：
 * 拿不准的地方用**窄判据 + 说明**，而不是为了"看起来更像测试"去挂一堆无关夹具。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InputArea } from "../components/InputArea";
import type { CollaborationMode } from "../core/agent/agent";

const ROOT = join(__dirname, "..", "..");
const inputAreaSrc = readFileSync(join(ROOT, "src/components/InputArea.tsx"), "utf8");
const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");

describe("RING-1：输入框焦点环只在编辑时出现", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("RING-1a：挂载后输入框**不许**自动获得焦点（开机常亮紫条的直接成因）", () => {
    render(
      <InputArea
        onSend={() => {}}
        onCancel={() => {}}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={() => {}}
        connected={true}
      />,
    );
    try {
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(
        document.activeElement,
        "挂载后焦点被自动塞进了输入框 —— 于是 `:focus-visible` 立刻为真、焦点环开机常亮。" +
          "恢复光标的逻辑只该在「语音从开到关」这一个跃迁上动作。",
      ).not.toBe(ta);
    } finally {
      cleanup();
    }
  });

  it("RING-1b：恢复光标的 effect 必须带跃迁判断（不许退回「当前没在听就 focus」）", () => {
    /* 正面：必须存在 prevListeningRef 且用它做前后比较 */
    expect(inputAreaSrc, "找不到 prevListeningRef —— 恢复光标必须区分「跃迁」与「状态」").toMatch(
      /const prevListeningRef = useRef\(isListeningVoice\)/,
    );
    expect(inputAreaSrc, "必须在 effect 里读取上一次的值并回写本次值").toMatch(
      /const wasListening = prevListeningRef\.current;[\s\S]{0,80}prevListeningRef\.current = isListeningVoice;/,
    );
    expect(inputAreaSrc, "必须在「不是在听 且 上一次在听」时才恢复焦点").toMatch(
      /if \(!wasListening \|\| isListeningVoice\) return;/,
    );

    /* 反面：旧的错误形态（挂载即抢焦点）必须已经不在 */
    expect(
      /if \(!isListeningVoice\) \{[\s\S]{0,160}ta\.focus\(\);/.test(inputAreaSrc),
      "又出现了「当前没在听就 focus」的写法 —— 那会在**初次挂载时**（isListeningVoice 初值 false）" +
        "无条件抢焦点，焦点环开机常亮",
    ).toBe(false);
  });

  it("RING-1c：焦点环圈住**文字编辑区那一行**，且只在编辑框有键盘焦点时出现", () => {
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

    /* ⚠️ 第 188 轮：环的位置从 `.input-card-container` 移到 `.input-textarea-row`。
       前者正好是**面板顶部那条通宽边界** —— 用户反馈「编辑的时候，刚才那个外边框多的紫色条出现了，
       反而编辑框内的紫色框不见了」：环亮在面板外框上、而输入框自己一圈都没有。 */
    expect(
      /(^|\n)\s*\.input-textarea-row:has\(\.message-input:focus-visible\)\s*\{/.test(cssNoComments),
      "环必须画在 `.input-textarea-row:has(.message-input:focus-visible)` 上 —— " +
        "圈住的是**文字编辑区**，不是面板外框",
    ).toBe(true);

    for (const [sel, why] of [
      [".input-card-container:focus-within", "卡内任何控件拿到焦点都点亮整圈，打字全程也一直亮（187 轮「常显」）"],
      [".input-card-container:has(.message-input:focus-visible)", "环亮在面板外框上、编辑框内反而没有框（188 轮用户原话）"],
      [".input-textarea-row:focus-within", "行内任何控件拿到焦点都点亮（触发面太宽）"],
    ] as const) {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        new RegExp(`(^|\\n)\\s*${esc}\\s*\\{`).test(cssNoComments),
        `\`${sel}\` 又回来了 —— ${why}`,
      ).toBe(false);
    }

    /* 环规则体里必须有 box-shadow（不能只剩 border-color，那样四边不闭合） */
    const body = /(^|\n)\s*\.input-textarea-row:has\(\.message-input:focus-visible\)\s*\{([^}]*)\}/.exec(cssNoComments)?.[2] ?? "";
    expect(body, "环规则体里必须有 box-shadow").toMatch(/box-shadow:/);
  });
});
