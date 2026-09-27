/**
 * HIST-DRAFT —— **历史浏览不许吃掉草稿**（第 184 轮修的缺陷）。
 *
 * 用户原话：「主对话区域输入大段文字后，不小心按了向上的按钮，加载了历史输入信息，
 * 按理来讲再按向下的按钮这段文字应该覆盖回来，结果现在这段文字直接就不见了。修正这个机制。」
 *
 * ## 这条缺陷的机制（复现出来的，不是推断）
 *
 * 缺陷根因是"**显示态**"与"**草稿态**"两套状态在历史浏览里被混用了：
 *
 * 1. `browseHistory` 填充历史项时调了 `setDraft(recalled)` —— 而 `draft` 是
 *    **会被持久化**的那份（`useDraftPersistence` 防抖 500ms 落盘）。
 *    于是"按一下 ↑"就等于**拿历史项覆盖掉用户正在写的大段文字**：
 *    localStorage 里的 `composer-draft-*` 当场被替换成历史项，原来的文字**再也回不来**
 *    （无论之后按 ↓、切会话还是刷新）。
 * 2. 恢复路径用的是"进入浏览那一刻的快照"，而用户完全可能在历史行上继续敲字 ——
 *    那种情况下按 ↓ 会把**用户刚敲的内容**revert 掉。
 *
 * ## 修完之后的语义（本文件就是它的规格）
 *
 * · ↑/↓ 只改**显示**（`input`），**一个字都不碰草稿**（`setDraft`）；
 * · 进入浏览时记下"进浏览前输入框里的真实文本"，↓ 越过最新那条就原样还回去，
 *   并把两套状态重新对齐（`input` + `draft` 都写回那份文本）；
 * · 在历史行上接着敲的字，退出浏览时恢复成原草稿 —— 它是临时内容，不该变成草稿。
 *
 * ⚠️ 与 `repro-input-history-wrap-guard.test.ts` 的分工：那个文件测的是**多行 guard**
 * （↑ 只在视觉第一行翻历史），它把 guard 逻辑**复刻**了一份来测、碰不到真实状态机；
 * 本文件测的是**真实组件**里的状态机。两者互补，别互相替代。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { InputArea } from "../components/InputArea";
import type { CollaborationMode } from "../core/agent/agent";
import { getSetting } from "../core/storage/settings";

const LARGE = "第一段：这是一大段要写很久的文字。\n第二段：还没写完，先看看历史。\n第三段：继续。";
const ONE_LONG_LINE = "这是一段很长的文字".repeat(30);
const HISTORY = ["上一条历史", "上上条历史"];
const DRAFT_KEY = "composer-draft-__global__";

function mount() {
  return render(
    <InputArea
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
const value = () => box().value;
const key = (k: string) => fireEvent.keyDown(box(), { key: k });
/** 模拟用户输入：受控组件必须走 change 事件并带上 target.value */
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const storedDraft = () => getSetting(DRAFT_KEY) ?? null;

describe("HIST-DRAFT：历史浏览不许吃掉草稿（第 184 轮）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("codem-input-history", JSON.stringify(HISTORY));
  });

  it("HIST-DRAFT-1：打字 → ↑ → ↓，草稿必须原样回来", () => {
    mount();
    type(LARGE);
    key("ArrowUp");
    expect(value(), "↑ 应当加载最新那条历史").toBe(HISTORY[HISTORY.length - 1]);
    key("ArrowDown");
    expect(value(), "↓ 回到草稿 —— 用户报的就是这一步文字不见了").toBe(LARGE);
  });

  it("HIST-DRAFT-2：↑ **不许**把历史项写进草稿（这是根因）", async () => {
    mount();
    type(LARGE);
    /* 先让防抖（500ms）把这份草稿落盘 —— 用假定时器推过窗口，再读存储。
       ⚠️ 断言要读**settings 存储**（`getSetting`），不是 `localStorage`：
       草稿走的是 core/storage/settings，不是直接写 localStorage（第一版读错了地方）。 */
    await act(async () => {
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      } finally {
        vi.useRealTimers();
      }
    });
    expect(storedDraft(), "大段文字应当已经落盘").toBe(LARGE);

    key("ArrowUp");
    expect(value()).toBe(HISTORY[HISTORY.length - 1]);
    /* 关键断言：翻历史**不得**改动草稿存储 */
    expect(
      storedDraft(),
      "按 ↑ 之后草稿被历史项覆盖了 —— 这会让用户没写完的文字永久消失（切会话/刷新都回不来）",
    ).toBe(LARGE);
  });

  it("HIST-DRAFT-3：↑ 之后在历史行上敲字，↓ 回来的是**原草稿**（临时编辑不该变成草稿）", () => {
    mount();
    type(LARGE);
    key("ArrowUp");
    const recalled = value();
    type(recalled + "x");
    key("ArrowDown");
    expect(value(), "↓ 应当还回进浏览前那份草稿，而不是把历史行上的临时编辑留下").toBe(LARGE);
  });

  it("HIST-DRAFT-4：连按 ↑ 翻多条后再 ↓ 到底，仍回到草稿", () => {
    mount();
    type(LARGE);
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp"); // 越过最旧那条 → doskey 式回绕
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    expect(value()).toBe(LARGE);
  });

  it("HIST-DRAFT-5：单个长段（纯软换行）也能 ↑ 后 ↓ 回来", () => {
    mount();
    type(ONE_LONG_LINE);
    key("ArrowUp");
    key("ArrowDown");
    expect(value()).toBe(ONE_LONG_LINE);
  });

  it("HIST-DRAFT-6：草稿态按 ↓ 保持原生（不翻历史）—— 与终端一致", () => {
    mount();
    type(LARGE);
    key("ArrowDown");
    expect(value(), "还没进入浏览态时 ↓ 不该动文本（应当只是原生光标下移）").toBe(LARGE);
  });

  it("HIST-DRAFT-7：浏览历史期间**清空**输入框，草稿也该跟着清空（不许把历史项当草稿留下）", () => {
    mount();
    type(LARGE);
    key("ArrowUp");
    type(""); // 用户把历史项删光
    key("ArrowDown");
    expect(value(), "↓ 应当还回进浏览前的草稿").toBe(LARGE);
    expect(storedDraft(), "草稿存储里不许留着历史项").not.toBe(HISTORY[HISTORY.length - 1]);
  });

  it("HIST-DRAFT-8：没有历史时 ↑/↓ 不改动任何东西", () => {
    localStorage.setItem("codem-input-history", JSON.stringify([]));
    mount();
    type(LARGE);
    key("ArrowUp");
    key("ArrowDown");
    expect(value()).toBe(LARGE);
  });
});
