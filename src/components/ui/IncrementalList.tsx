/**
 * 分片渲染（IncrementalList）—— 长列表**不许一次性全渲染**（第 181 轮全面审计的内存/性能整改）。
 *
 * ## 为什么要有它（实测，不是"预防性优化"）
 *
 * 审计在装机版 1.16.180 上逐个面板量 DOM 节点（`.preview-shot/_audit-dom-budget2.mjs`，
 * 每个入口先重载到干净状态再量）：
 *
 * | 面板 | 自身节点 | 关闭后残留 |
 * | --- | --- | --- |
 * | **插件管理** | **6153** | **6153（不卸载）** |
 * | 文件快照 | 620 | 0 |
 * | 执行轨迹 | 321 | 0 |
 * | 技能 / 记忆 / 智能体 | 228 / 197 / 151 | 各自残留 |
 *
 * 干净状态的整个应用只有 **620** 个节点 —— 也就是说**点开一次插件管理，页面 DOM 变成原来的 11 倍**
 * 并永久留着。归因（`.preview-shot/_audit-heaviest-subtree.mjs`）：
 * `.skill-market-grid` 一棵子树就 **6095** 个节点，里面是 **208 张 `.market-skill-card`**
 * （207 个内置插件 + 1 个扩展），每张卡约 **29** 个节点、其中约 9 个是内联 `<svg>` 图标
 * （全页 SVG 元素 **1952** 个，正是这 208 张卡贡献的）。
 *
 * 也就是说：**"打开插件管理"这件事的成本 = 一次性造 208 张卡 × 29 个节点**，
 * 而用户一屏最多看到 6~8 张。
 *
 * ## 口径
 *
 * - **首屏只渲染前 `initial` 项**（默认 40，够铺满 1080p 下的 4~6 行网格）；
 * - 底部放一个**哨兵**，它进入视口时按 `step` 追加（`IntersectionObserver`，`rootMargin` 200px 预取）；
 * - **必须同时给一个显式的「再显示 N 项」按钮**：不能只靠滚动 ——
 *   ① 键盘用户与读屏用户需要一个可聚焦的显式入口；
 *   ② 网格万一没形成滚动容器（父级高度不受限），哨兵可能永远不进视口，
 *      那时按钮是**唯一**能拿到剩余项的路。少了它就是把"没渲染"变成"拿不到"。
 * - `resetKey` 变化（切换分类 / 搜索词）时**回到首屏片数** ——
 *   否则"筛出 5 项"却还留着上一次的 200 片数，下次切回来会一次性全渲染。
 *
 * ## 与"面板关掉不卸载"的关系
 *
 * 审计同时看到"关掉后面板不卸载"（残留 6153）。那是**保活**（keep-alive）的形态，
 * 反复开合不再增长（后半段 8 轮 Δ0），所以**不是泄漏**、本轮不改它 ——
 * 改了会动"面板打开速度"与"面板内状态保留"这两件用户能感觉到的事。
 * 分片渲染直接把常驻成本从 6153 降到首屏那一片，这才是这个问题的正解。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface IncrementalListOptions {
  /** 首屏渲染多少项（默认 40） */
  initial?: number;
  /** 每次追加多少项（默认 40） */
  step?: number;
  /**
   * 变化时把片数重置回首屏值（传分类 / 搜索词这类"换了数据集"的标识）。
   * 不传就只在挂载时定一次。
   */
  resetKey?: string | number;
}

export interface IncrementalListState<T> {
  /** 当前该渲染的那一片 */
  visible: T[];
  /**
   * 挂到底部的哨兵（进入视口就追加）。
   *
   * ⚠️ 类型写成 `MutableRefObject<HTMLDivElement | null>` 而不是 `RefObject<… | null>`：
   * 本仓库的 React 类型里 `RefObject<T>` 已经是"`current` 可能为 null"的形态，
   * 再写成 `RefObject<T | null>` 就与 JSX 的 `ref` 期望的 `LegacyRef<T>` 对不上，
   * 报 `Type 'HTMLDivElement | null' is not assignable to type 'HTMLDivElement'`。
   * 这是类型层面的坑，运行期两种写法一样。
   */
  sentinelRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 还有没渲染的 */
  hasMore: boolean;
  /** 还没渲染的条数 */
  remaining: number;
  /** 显式追加（按钮用） */
  loadMore: () => void;
}

export function useIncrementalList<T>(items: T[], options: IncrementalListOptions = {}): IncrementalListState<T> {
  const initial = options.initial ?? 40;
  const step = options.step ?? 40;
  const [count, setCount] = useState(initial);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /* 换数据集就回到首屏片数（见文件头口径最后一条） */
  useEffect(() => {
    setCount(initial);
  }, [options.resetKey, initial]);

  const loadMore = useCallback(() => {
    setCount((c) => Math.min(items.length, c + step));
  }, [items.length, step]);

  const hasMore = count < items.length;

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    /* 没有 IntersectionObserver 的环境（老 WebView / jsdom）退化成"只能靠按钮"，
       不抛错 —— 这条能力缺失不该让整个面板打不开。 */
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, count]);

  return { visible: items.slice(0, count), sentinelRef, hasMore, remaining: Math.max(0, items.length - count), loadMore };
}

export interface IncrementalListProps<T> extends IncrementalListOptions {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** 网格/列表容器的类名（几何由调用方决定，这个原语只管"渲染多少"） */
  className?: string;
  /** 容器内联样式（`PluginMarketTab` 的 `maxHeight` 这类需要） */
  style?: React.CSSProperties;
  /** 追加按钮的文案（中英由调用方给；参数是"还剩几项"与"这一次会追加几项"） */
  moreLabel: (remaining: number, next: number) => string;
  /** 挂测试钩子 / 布局类 */
  sentinelClassName?: string;
}

/**
 * 用法：
 * ```tsx
 * <IncrementalList
 *   className="skill-market-grid"
 *   items={filteredMarketSkills}
 *   resetKey={marketSearchQuery}
 *   moreLabel={(rest, next) => zh ? `再显示 ${next} 项（还有 ${rest} 项）` : `Show ${next} more (${rest} left)`}
 *   renderItem={(skill) => <SkillCard key={skill.id} skill={skill} />}
 * />
 * ```
 * 注意 `renderItem` 里**要保留 `key`**（在返回的元素上给），别在外层再包一层没有 key 的 div。
 */
export function IncrementalList<T>({
  items,
  renderItem,
  className,
  style,
  moreLabel,
  sentinelClassName,
  ...options
}: IncrementalListProps<T>) {
  const { visible, sentinelRef, hasMore, remaining, loadMore } = useIncrementalList(items, options);
  const next = Math.min(options.step ?? 40, remaining);
  return (
    <div className={className} style={style}>
      {visible.map((item, i) => renderItem(item, i))}
      {hasMore && (
        <div ref={sentinelRef} className={["incremental-sentinel", sentinelClassName].filter(Boolean).join(" ")}>
          <button type="button" className="incremental-more-btn" onClick={loadMore}>
            {moreLabel(remaining, next)}
          </button>
        </div>
      )}
    </div>
  );
}
