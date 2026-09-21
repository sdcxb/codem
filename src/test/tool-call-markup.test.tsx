/**
 * TOOL-MARKUP —— **工具调用卡片真的会渲染出这些类名吗**（第 67 轮新增门禁）。
 *
 * ## 为什么需要这条门禁（本轮的真缺陷）
 *
 * 我把"回复过程条目之间的线"改到了 `.tool-item` 上 —— 而全项目**没有任何组件渲染这个类**
 * （TSX 里出现的 `tool-item` 全是 `sidebar-tool-item` / `agent-tool-item` 的**子串**，
 * 于是 `scan-ui.mjs` 的 `css-class-unused` 长期假绿）。结果是"改完了、界面上零变化"。
 *
 * `scan-ui.mjs` 的子串问题本轮已修（改成标识符整词匹配），但那条规则是**静态字符串**级的：
 * 它只回答"这个类名在 TS/TSX 里出现过吗"。这条用例走**真实渲染**这条路：
 * 用真实的 `ToolCallGroup` / `ToolCallCard` 渲染一批工具调用，然后断言
 * **过程条目线条所依赖的类名真的出现在产出的 DOM 里**。
 * 组件里一旦改名字（或换了分支条件），这里立刻红 —— 而不是等到用户说"怎么没效果"。
 *
 * 配套：`light-theme-contrast.test.ts` 的 `LIGHT-UI-2b` 守"这些类上的**线条写法**"（渐隐发丝线），
 * 两条合起来才是完整的：**类在被渲染** + **线画在该类上**。
 *
 * ⚠️ 本用例的样例数据是**构造的**（真实会话日志里没出现过 "grep 多文件命中 / diff 多块" 这两种形状），
 * 但**标记由真实组件渲染** —— 这正是它的价值：不依赖任何外部数据文件，永久可跑。
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolCallGroup } from "../components/ToolCallGroup";
import type { ToolCallCardProps } from "../components/ToolCallCard";

/** 让 `SearchBlockCard` 分支成立：grep 结果必须是 `文件:行号:内容` 形状 */
const grepItem: ToolCallCardProps = {
  toolName: "grep",
  toolArgs: JSON.stringify({ pattern: "tool-card-row", path: "C:\\proj\\src" }),
  toolResult: [
    "C:\\proj\\src\\a.ts:12:  const x = 1",
    "C:\\proj\\src\\b.ts:34:  const y = 2",
    "C:\\proj\\src\\c.ts:56:  const z = 3",
  ].join("\n"),
  status: "done",
  argsSummary: "tool-card-row",
};

/** 让 `DiffBlockCard` 分支成立：metadata.diff 是 {path, oldText, newText} 数组 */
const diffItem: ToolCallCardProps = {
  toolName: "edit",
  toolArgs: JSON.stringify({ path: "C:\\proj\\src\\a.ts" }),
  toolResult: "ok",
  status: "done",
  argsSummary: "src/a.ts",
  metadata: { diff: [{ path: "src/a.ts", oldText: null, newText: "  line" }] },
};

/** 让 `TerminalBlock` 分支成立：bash + 有输出 */
const bashItem: ToolCallCardProps = {
  toolName: "bash",
  toolArgs: JSON.stringify({ command: "npm run test", workdir: "C:\\proj" }),
  toolResult: "Test Files 1 passed\nTests 3 passed",
  status: "done",
  argsSummary: "npm run test",
  metadata: { cwd: "C:\\proj" },
};

/** 让通用 IN/OUT 分支成立：非单文件工具（有 args body 与 output） */
const ioItem: ToolCallCardProps = {
  toolName: "todowrite",
  toolArgs: JSON.stringify({ todos: [{ content: "精修线条", status: "in_progress" }] }),
  toolResult: "1 项已更新",
  status: "done",
  argsSummary: "更新待办",
};

/** 运行中、**没有输出**的 bash —— 头部会是卡片里最后一个子元素（`:not(:last-child)` 那条边界） */
const runningItem: ToolCallCardProps = {
  toolName: "bash",
  toolArgs: JSON.stringify({ command: "npm run build", workdir: "C:\\proj" }),
  status: "running",
  argsSummary: "npm run build",
  metadata: { cwd: "C:\\proj" },
};

/**
 * 渲染一组工具调用并**把可展开的胶囊行点开**。
 *
 * ⚠️ 必须点开：卡片（`.tool-card` 及其头部/行）只在 `open` 时才渲染 ——
 * 第一版用例忘了这一步，于是"什么都没渲染出来"、断言全部指向假失败。
 * 这也顺带证明了"卡片是**展开态**才有线条"：折叠成一行胶囊时根本没有这些线。
 */
const renderGroup = (items: ToolCallCardProps[]) => {
  const { container } = render(<ToolCallGroup items={items} />);
  for (const pill of container.querySelectorAll(".tool-call-pill.expandable")) fireEvent.click(pill);
  return container;
};

describe("TOOL-MARKUP 工具调用卡片的真实标记", () => {
  it("TOOL-MARKUP-1：过程条目线条依赖的类名，必须真的被渲染出来", () => {
    const c = renderGroup([bashItem, grepItem, diffItem, ioItem, runningItem]);
    const classes = new Set<string>();
    for (const el of c.querySelectorAll("*")) {
      for (const x of String(el.className || "").split(/\s+/)) if (x) classes.add(x);
    }
    // 这些是 `codem-ui.css` 里画"过程条目线条"所依赖的类（LIGHT-UI-2b 守它们的写法）
    const required = ["tool-card", "tool-card-head", "tool-card-row", "tool-io-section--bordered", "tool-call-group-inline", "tool-group-body-inline"];
    const missing = required.filter((x) => !classes.has(x));
    expect(
      missing,
      `这些类名没有被任何组件渲染出来（给它们写样式等于没写，本轮就是这么栽的）：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("TOOL-MARKUP-2：`.tool-card-row` 是多行卡片里**一行一个**，且最后一个不留线（`:not(:last-child)` 的判据）", () => {
    const c = renderGroup([grepItem, diffItem]);
    const rows = [...c.querySelectorAll(".tool-card-row")];
    expect(rows.length, "grep/diff 卡片必须渲染出多行，否则行间线无从谈起").toBeGreaterThanOrEqual(3);
    // 每个 .tool-card 内的最后一行必须是该卡片的最后一个子元素（CSS 靠这一条不画线）
    const perCard = new Map<Element, Element[]>();
    for (const r of rows) {
      const card = r.parentElement!;
      perCard.set(card, [...(perCard.get(card) ?? []), r]);
    }
    for (const [card, list] of perCard) {
      expect(card.lastElementChild, "卡片最后一个子元素应当是最后一行（否则 :last-child 判不到）").toBe(list[list.length - 1]);
    }
  });

  it("TOOL-MARKUP-3：没有输出的运行中卡片，头部是卡片里最后一个子元素（`:not(:last-child)` 必须挡住它）", () => {
    const c = renderGroup([runningItem]);
    const head = c.querySelector(".tool-card-head");
    expect(head, "运行中的 bash 应当渲染出卡片头").toBeTruthy();
    expect(
      head!.parentElement!.lastElementChild,
      "无输出时头部是最后一个子元素 —— 若这里变了，`.tool-card-head:not(:last-child)::after` 的判据也要跟着改",
    ).toBe(head);
  });

  it("TOOL-MARKUP-4（反向守卫）：`.tool-item` 这个类**不许**被渲染出来（它是第 67 轮的假结构）", () => {
    const c = renderGroup([bashItem, grepItem]);
    // `sidebar-tool-item` 之类必须**不算**命中：用整词判断
    const names = new Set<string>();
    for (const el of c.querySelectorAll("*")) {
      for (const x of String(el.className || "").split(/\s+/)) if (x) names.add(x);
    }
    expect(names.has("tool-item"), "`tool-item` 又出现在真实标记里了？先确认它到底是谁渲染的").toBe(false);
  });
});
