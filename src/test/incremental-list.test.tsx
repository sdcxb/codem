/**
 * 分片渲染（IncrementalList）的用例 —— 第 181 轮**全面审计**抓到的真问题的整改。
 *
 * ## 抓到了什么（装机版 1.16.180 实测）
 *
 * 逐面板量 DOM 节点（每个入口先重载到干净状态）：
 *
 * | 面板 | 自身节点 | 关闭后残留 |
 * | --- | --- | --- |
 * | **插件管理** | **6153** | **6153（保活不卸载）** |
 * | 文件快照 / 执行轨迹 / 技能 / 记忆 / 智能体 | 620 / 321 / 228 / 197 / 151 | — |
 *
 * 干净状态的整个应用只有 **620** 个节点 —— 点开一次插件管理，页面 DOM 变成 11 倍并永久留着。
 * 归因：`.skill-market-grid` 一棵子树 **6095** 个节点 = **208 张 `.market-skill-card`**
 * （207 内置插件 + 1 扩展）× 约 29 个节点/张（其中约 9 个是内联 `<svg>` 图标）。
 * 根因就是 `plugins.map(...)` **一次性全渲染**。
 *
 * ## 这一组用例守什么
 *
 * ① **首屏只渲染一片**（这是修复本身）；
 * ② 追加按钮**必须存在且可聚焦** —— 网格万一没形成滚动容器时，它是唯一能拿到剩余项的路；
 * ③ 换数据集（`resetKey` 变）**回到首屏片数** —— 否则"筛出 5 项"仍留着上次的 200 片数，
 *    切回来会一次性全渲染（**修复被自己的状态抵消**，这是最阴的一种"改完没效果"）；
 * ④ 没有 `IntersectionObserver` 的环境不许崩（退化到"只能靠按钮"）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { IncrementalList, useIncrementalList } from "../components/ui/IncrementalList";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));

function Probe({ count, initial, step, resetKey }: { count: number; initial?: number; step?: number; resetKey?: string }) {
  const { visible, hasMore, remaining, loadMore } = useIncrementalList(items(count), { initial, step, resetKey });
  return (
    <div>
      <span data-testid="n">{visible.length}</span>
      <span data-testid="more">{String(hasMore)}</span>
      <span data-testid="rest">{remaining}</span>
      <button type="button" onClick={loadMore}>more</button>
    </div>
  );
}

afterEach(() => cleanup());

describe("IncrementalList：长列表分片渲染", () => {
  beforeEach(() => {
    /* jsdom 没有 IntersectionObserver —— 正好也是"环境缺能力"那条判据的前提 */
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
  });

  it("IL-1：首屏只渲染 initial 项（这是修复本身）", () => {
    const { getByTestId } = render(<Probe count={208} initial={40} step={40} />);
    expect(getByTestId("n").textContent).toBe("40");
    expect(getByTestId("more").textContent).toBe("true");
    expect(getByTestId("rest").textContent).toBe("168");
  });

  it("IL-2：显式按钮按 step 追加（滚动之外的唯一入口）", () => {
    /**
     * ⚠️ 这里**必须点组件自己的按钮**（`.incremental-more-btn`），不能点测试夹具的按钮。
     * 第一版写的是 `fireEvent.click(getByText("more"))` —— 那点的是 `Probe` 里我自己放的按钮，
     * 于是"把组件的哨兵按钮删掉"这条变异**照样绿**（`INCR-删掉显式按钮` 就是这么暴露的）。
     * 夹具是用来量"渲染了多少"的，判据必须落在**被测组件**上。
     */
    const { container } = render(
      <IncrementalList className="grid" items={items(208)} initial={40} step={40} moreLabel={(rest, next) => `更多 ${next}（剩 ${rest}）`} renderItem={(x) => <i key={x.id} />} />,
    );
    expect(container.querySelectorAll("i").length).toBe(40);
    const btn = container.querySelector(".incremental-more-btn");
    expect(btn, "组件没有渲染「再显示 N 项」按钮 —— 网格没形成滚动容器时用户就拿不到剩余项了").toBeTruthy();
    expect(btn!.tagName).toBe("BUTTON"); // 必须是可聚焦元素，不能是个 div
    expect(btn!.textContent).toContain("更多 40");
    fireEvent.click(btn!);
    expect(container.querySelectorAll("i").length).toBe(80);
    fireEvent.click(container.querySelector(".incremental-more-btn")!);
    expect(container.querySelectorAll("i").length).toBe(120);
  });

  it("IL-2b：按钮挂在哨兵里，且哨兵跨整行（网格里不该占掉一个卡片格）", () => {
    const { container } = render(
      <IncrementalList className="grid" items={items(208)} initial={40} step={40} moreLabel={() => "更多"} renderItem={(x) => <i key={x.id} />} />,
    );
    const sentinel = container.querySelector(".incremental-sentinel");
    expect(sentinel, "找不到哨兵容器（滚动追加与显式按钮都挂在它上面）").toBeTruthy();
    expect(sentinel!.querySelector(".incremental-more-btn")).toBeTruthy();
  });

  it("IL-3：追加到末尾后封顶（不许超过总数、也不许一直显示按钮）", () => {
    const { getByTestId, getByText } = render(<Probe count={50} initial={40} step={40} />);
    fireEvent.click(getByText("more"));
    expect(getByTestId("n").textContent).toBe("50");
    expect(getByTestId("more").textContent).toBe("false");
    expect(getByTestId("rest").textContent).toBe("0");
  });

  it("IL-4：项数不超过首屏时不出现哨兵/按钮", () => {
    const { getByTestId, queryByText } = render(<Probe count={12} initial={40} />);
    expect(getByTestId("n").textContent).toBe("12");
    expect(getByTestId("more").textContent).toBe("false");
    expect(queryByText("more")).toBeTruthy(); // Probe 自己的按钮，不是组件的哨兵
    const { container } = render(
      <IncrementalList className="grid" items={items(12)} moreLabel={() => "更多"} renderItem={(x) => <i key={x.id} />} />,
    );
    expect(container.querySelector(".incremental-sentinel")).toBeNull();
  });

  it("IL-5：**换数据集必须回到首屏片数**（否则「改完没效果」）", () => {
    const { getByTestId, getByText, rerender } = render(<Probe count={208} initial={40} step={40} resetKey="all" />);
    fireEvent.click(getByText("more"));
    fireEvent.click(getByText("more"));
    expect(getByTestId("n").textContent).toBe("120");
    /* 换搜索词：应回到 40 */
    rerender(<Probe count={208} initial={40} step={40} resetKey="query-x" />);
    expect(getByTestId("n").textContent).toBe("40");
  });

  it("IL-6：没有 IntersectionObserver 时不许崩（退化到只能靠按钮）", () => {
    expect(() => render(<Probe count={208} initial={40} step={40} />)).not.toThrow();
  });

  it("IL-7：有 IntersectionObserver 时，哨兵进入视口会自动追加", async () => {
    let cb: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    class FakeIO {
      constructor(fn: (entries: { isIntersecting: boolean }[]) => void) { cb = fn; }
      observe() {}
      disconnect() {}
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    const { getByTestId, container } = render(
      <IncrementalList className="grid" items={items(208)} initial={40} step={40} moreLabel={() => "更多"} renderItem={(x) => <i key={x.id} />} />,
    );
    expect(container.querySelectorAll("i").length).toBe(40);
    expect(cb).toBeTruthy();
    await act(async () => { cb!([{ isIntersecting: true }]); });
    expect(container.querySelectorAll("i").length).toBe(80);
    expect(getByTestId).toBeTruthy();
  });

  it("IL-8：真实站点的网格里**不许**出现「网格 div 里直接 map 出全部卡片」", () => {
    /**
     * ⚠️ 口径踩过一次（`INCR-某网格改回全量map` 就是这么漏过去的）：
     * 第一版只断言"文件里出现了 `IncrementalList` 这个词" —— 而变异**只是在同一个文件里
     * 又加了一处 `plugins.map(...)`**，`IncrementalList` 字样还在 ⇒ 判据照样绿。
     * 现在的口径直接盯**反模式本身**：`<div className="…skill-market-grid…">` 之后紧接着
     * 不许出现 `.map(`（空态分支里不会有 map；分片渲染的网格用的是 `<IncrementalList`，不是 div）。
     */
    const ROOT = path.resolve(__dirname, "..", "..");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const n of readdirSync(dir)) {
        if (n === "node_modules" || n === "test") continue;
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(n) && !/\.test\./.test(n)) files.push(p);
      }
    })(path.join(ROOT, "src"));
    const offenders: string[] = [];
    let grids = 0;
    for (const full of files) {
      const src = readFileSync(full, "utf8");
      const re = /<div\s+className="[^"]*skill-market-grid[^"]*"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        grids++;
        const window = src.slice(m.index, m.index + 320);
        if (/\.map\(/.test(window)) {
          const line = src.slice(0, m.index).split(/\r?\n/).length;
          offenders.push(`${path.relative(ROOT, full).replace(/\\/g, "/")}:${line}（网格 div 里直接 map）`);
        }
      }
      /*
       * 反向对照：文件里只要出现"`.map(` 紧跟着渲染 `market-skill-card`"这种写法，
       * 就必须用 `IncrementalList`。⚠️ 不能写成"渲染了卡片就要用" ——
       * `ZvecGrepMarketCard.tsx` 是**单张卡**（不是列表），第一版这么写就误报了它。
       */
      if (!/IncrementalList/.test(src)) {
        const mapRe = /\.map\(/g;
        let mm: RegExpExecArray | null;
        while ((mm = mapRe.exec(src))) {
          if (/market-skill-card/.test(src.slice(mm.index, mm.index + 320))) {
            const line = src.slice(0, mm.index).split(/\r?\n/).length;
            offenders.push(`${path.relative(ROOT, full).replace(/\\/g, "/")}:${line}（map 出卡片却没走分片渲染）`);
            break;
          }
        }
      }
    }
    expect(grids, "一个 `.skill-market-grid` 的 div 都没扫到 —— 判据的口径坏了？").toBeGreaterThanOrEqual(3);
    expect(offenders,
      "这些地方又在网格里一次性 map 出全部卡片了（一次 208 张 = 6095 个节点）：\n  - " + offenders.join("\n  - "),
    ).toEqual([]);
  });
});
