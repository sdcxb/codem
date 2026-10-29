/**
 * 首帧与「系统材质探测」的时序（第 233 轮审计 · P2 冷启动）。
 *
 * ## 缺陷形态
 *
 * `main.tsx` 原来是 **先探测、再渲染**：
 *
 * ```ts
 * await Promise.race([applyNativeMaterialHint(), sleep(400)]);
 * renderApp();           // ← 首帧被这段 await 卡住，最多 400ms
 * ```
 *
 * 材质探测要跨一次 IPC（`native_material`）。正常情况下它 5–20ms 就回来了，所以"先探测"
 * 的收益（避免先画一帧实色再变玻璃）值得；但**一旦 IPC 慢或卡住**，用户看到的是
 * **最长 400ms 的空白窗口**，而这段等待对"能不能开始用"毫无帮助。
 *
 * ## 现在的口径
 *
 * - **快速路径不变**：探测在 `limitMs`（默认 60ms）内回来 ⇒ 属性先落地、再渲染
 *   （不会闪一帧实色）；
 * - **慢路径不再阻塞**：超过 `limitMs` 就**先渲染**，探测在后台继续
 *   （它只是给 `<html>` 打属性，晚到也能生效，CSS 会跟着变）。
 *
 * 判据见 `src/test/startup-material-hint.test.ts`（START-1/2/3）。
 */
export interface MaterialHintStartupOptions {
  /** 探测系统材质：只负责给 `<html>` 打属性；失败自行吞掉 */
  probe: () => Promise<void>;
  /** 首帧渲染（只会被调用一次） */
  render: () => void;
  /** 允许阻塞首帧的上限（ms）；超过就先渲染 */
  limitMs?: number;
  /** 便于判据注入（生产用默认的 setTimeout/clearTimeout） */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export const DEFAULT_MATERIAL_HINT_LIMIT_MS = 60;

/**
 * 启动：**最多**阻塞 `limitMs` 再渲染。返回一个 promise（探测+渲染都完成时 resolve），
 * 生产调用方可以 `void` 掉它。
 */
export function startWithMaterialHint({
  probe,
  render,
  limitMs = DEFAULT_MATERIAL_HINT_LIMIT_MS,
  timers,
}: MaterialHintStartupOptions): Promise<void> {
  const setT = timers?.setTimeout ?? setTimeout;
  const clearT = timers?.clearTimeout ?? clearTimeout;

  let rendered = false;
  const renderOnce = () => {
    if (rendered) return;
    rendered = true;
    render();
  };

  /**
   * 探测**立刻**开始（不是等渲染之后）—— 这样正常路径上它仍然先于首帧完成。
   * `catch` 在这里再兜一次：探测自己已经吞过异常，但 `probe` 可能被替换（判据会这么干）。
   */
  const probed = Promise.resolve()
    .then(probe)
    .catch(() => undefined);

  return new Promise<void>((resolve) => {
    const cutoff = setT(() => {
      // 超时：先渲染，探测继续在后台跑
      renderOnce();
      resolve();
    }, limitMs);

    void probed.then(() => {
      clearT(cutoff);
      renderOnce();
      resolve();
    });
  });
}
