/**
 * 皮肤/首屏镜像的**开始读取门**与**事后校正**（第 45 轮 D-17）。
 *
 * ## 问题
 *
 * `skin-id`（皮肤）与 `dream-config` 都存在 DB 的 `settings` 表里，而存储端口要等
 * `App.tsx` 首个 effect 里 `await registerRustStoragePort()` 之后才注册（`port.ts:setStoragePort`），
 * `ThemeManager.init()`（`App.tsx:1317`）则在**那之前**就跑完了。于是：
 *
 * - 首帧的 `data-skin` 只能是"默认皮肤"（`applySkin()` 唯一写入点，`init()` 里调用）；
 * - Hub / Dream 用户启动时先按默认皮肤渲染（含启动闪屏），等下一次皮肤变化才切过去；
 * - 镜像（`codem-skin-cache`）如果只在 `setSkin()` 里写，就会**永远停在**"上次点过的皮肤"，
 *   而 `init()` 又拿它当兜底 —— 一旦镜像过期，首帧会渲染**错误的皮肤**且没人纠正
 *   （这比"没有镜像"更糟：DB 里明明有真值，读得到的时候却不采信）。
 *
 * ## 做法
 *
 * 把"皮肤首屏镜像"做成和主题镜像（`codem-theme-cache`）同构的两段式：
 *
 * 1. **预测**：`ThemeManager.init()` 在 DB 读不到时用镜像兜底（`theme-manager.ts`）——
 *    保证首帧就是"上次实际生效的皮肤"；
 * 2. **校正**：端口注册是**同步回调**里的第一件事（`setStoragePort` → 订阅者），
 *    此时内存镜像已经预热（`RustStoragePort.start()` 先 `await warmup()` 再 `setStoragePort`），
 *    所以这里能同步读到真值并立刻 `resyncFromStorage()`。
 *
 * 订阅发生在主题模块被 import 时（早于端口注册），因此两种启动路径都能覆盖；
 * 重复调用 `setupThemeSkinResync()` 是幂等的。
 */

import { getStoragePort, hasStoragePort, setStoragePortListener } from '../storage/port';
import { ThemeManager } from './theme-manager';

let registered = false;

/** 端口已就绪时立刻校正一次（端口没就绪时是空操作） */
export function resyncThemeSkinNow(): boolean {
  if (!hasStoragePort()) return false;
  try {
    // 触发一次同步配置读，确保端口处于可用状态（读不到东西也不会抛）
    void getStoragePort().config.stats();
    return ThemeManager.resyncFromStorage();
  } catch (e) {
    console.warn('[theme-resync] 皮肤校正失败（保持当前皮肤）', e);
    return false;
  }
}

/**
 * 注册"端口就绪 → 用 DB 校正皮肤"的门。幂等，返回取消订阅函数。
 */
export function setupThemeSkinResync(): () => void {
  if (registered) {
    return () => {};
  }
  registered = true;

  const unsubscribe = setStoragePortListener((port) => {
    if (!port) return;
    resyncThemeSkinNow();
  });

  // 兼容"本模块在端口注册之后才被 import"的顺序（两个 provider 入口都会调它）
  resyncThemeSkinNow();

  return () => {
    unsubscribe();
    registered = false;
  };
}

/** 测试用：重置幂等标记 */
export function __resetThemeSkinResyncForTests(): void {
  registered = false;
}
