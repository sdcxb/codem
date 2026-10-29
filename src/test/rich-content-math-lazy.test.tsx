/**
 * 数学公式：**只有出现公式才加载 KaTeX**（第 233 轮审计 · 冷启动）。
 *
 * ## 缺陷形态
 *
 * `RichContent`（首屏每条消息的 Markdown 渲染器）原来静态 import：
 * `remark-math` + `rehype-katex` + `katex/dist/katex.min.css` ——
 * 合计约 **270KB**（主包 7%），而绝大多数消息里没有公式。
 *
 * ## 修法
 *
 * 检测到数学标记才动态 `import("./markdown-math")`；Vite 把它切成独立 chunk。
 * 代价：带公式的消息**第一帧是原文**（`$…$` 原样显示），chunk 到了再变成公式 ——
 * 只影响带公式的消息，且只发生一次。
 *
 * ## 判据（用组件暴露的"发起加载次数"计数，不用 vi.mock 工厂计数 —— 后者会被模块缓存吃掉）
 *
 * | # | 行为 |
 * |---|---|
 * | MATH-LAZY-1 | 普通消息**不许**发起数学 chunk 加载（否则等于没拆） |
 * | MATH-LAZY-2 | 带 `$$…$$` 的消息最终必须渲染出 `.katex`（功能不许丢） |
 * | MATH-LAZY-3 | 行内 `$…$` 也算数学（否则行内公式会一直显示原文） |
 * | MATH-LAZY-4（反向对照） | 纯文本里的 `$5` 价格**不许**误触发（会把 270KB 白拉一遍） |
 * | MATH-LAZY-5 | 插件的 hooks 必须在 `if (streaming) return` **之前**（否则 hooks 数量随分支变化，React 会抛） |
 *
 * 变异自证：`hasMath` 恒 true ⇒ MATH-LAZY-1/4 红；去掉动态 import ⇒ MATH-LAZY-2/3 红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RichContent,
  __mathLoadCountForTests,
  __resetMathLoadCountForTests,
} from "../components/rich-content/RichContent";

beforeEach(() => {
  __resetMathLoadCountForTests();
});

describe("KaTeX 按需加载", () => {
  it("MATH-LAZY-1（反向对照）: 普通消息不许发起数学 chunk 加载", async () => {
    const { container } = render(<RichContent content={"这是一段普通说明，包含 **粗体** 与 `code`。"} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(__mathLoadCountForTests(), "普通消息不该拉 KaTeX（270KB）").toBe(0);
    expect(container.querySelector(".katex"), "没有公式就不该有 katex 节点").toBeNull();
  });

  it("MATH-LAZY-2: 带 $$…$$ 的消息最终必须渲染出 .katex", async () => {
    const { container } = render(<RichContent content={"质能方程：\n\n$$E = mc^2$$\n\n就是这样。"} />);
    await waitFor(
      () => {
        expect(__mathLoadCountForTests(), "带公式 ⇒ 必须去加载数学 chunk").toBeGreaterThan(0);
        expect(container.querySelector(".katex"), "公式必须真的渲染出来").toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("MATH-LAZY-3: 行内 $…$ 也算数学", async () => {
    const { container } = render(<RichContent content={"当 $a^2 + b^2 = c^2$ 时成立。"} />);
    await waitFor(
      () => {
        expect(__mathLoadCountForTests()).toBeGreaterThan(0);
        expect(container.querySelector(".katex")).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("MATH-LAZY-4（反向对照）: 纯文本里的 $5 不许误触发", async () => {
    render(<RichContent content={"这杯咖啡 $5，那杯 $8。"} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(__mathLoadCountForTests(), "$5 不是公式，不该拉 270KB").toBe(0);
  });

  it("MATH-LAZY-5: 数学插件的 hooks 必须在 streaming 早退之前", () => {
    const src = readFileSync(join(__dirname, "../components/rich-content/RichContent.tsx"), "utf8");
    const hookIdx = src.indexOf("const hasMath = useMemo(");
    const streamingIdx = src.indexOf("if (streaming) {");
    expect(hookIdx, "找不到 hasMath（判据锚点过期）").toBeGreaterThan(-1);
    expect(streamingIdx).toBeGreaterThan(-1);
    expect(hookIdx, "hooks 排在 early return 之后 ⇒ 流式切换时 hook 数量会变，React 会抛").toBeLessThan(
      streamingIdx,
    );
  });
});
