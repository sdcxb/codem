/**
 * 字节数的**唯一**人读形态（第 191 波：把「同一事实四份实现」收敛成一份）。
 *
 * ## 被守的形态（本轮全仓搜同类的产物）
 *
 * 「字节数 → 人读字符串」这件事在本仓曾经有 **4 份**实现，而且**有 3 种不同口径**：
 *
 * | 位置 | 512 字节 | 2048 字节 | 5 MiB |
 * | --- | --- | --- | --- |
 * | `components/InputArea.tsx`（本地 `formatSize`） | `512 B` | `2.0 KB` | `5.0 MB` |
 * | `components/MessageBubble.tsx`（本地 `formatSize`） | `512 B` | `2.0 KB` | `5.0 MB` |
 * | `core/storage/maintenance.ts`（本地 `formatBytes`） | `512 B` | `2.0 KiB` | `5.0 MiB` |
 * | `plugins/library-ops/core/scene-image.ts`（导出 `formatBytes`） | `512B` | `2.0KB` | `5.00MB` |
 *
 * 这**不是**"各处风格不同无所谓"：同一个数在维护汇总里写 `4.0 MiB`、在附件气泡里写 `4.0 MB`，
 * 用户/审计无法一眼判断两处说的是不是同一件事 —— 本仓对「同一事实两套口径」的判断是 P1
 * （第 189 波的亮度阈值 `0.04045 / 0.03928` 就是同一形态）。所以这里留**一处**实现，
 * 其余全部 import 它（判据 `BYTES-SINGLE-SOURCE` 用解析式对账钉住：`/ 1024` 这类换算
 * **只允许出现在本文件**，例外必须登记在判据的 allowlist 里）。
 *
 * ## 口径（选定：与两个界面组件一致的那种）
 *
 * - `< 1024` ⇒ 整数字节 + 空格 + `B`（`512 B`）；
 * - `< 1 MiB` ⇒ 一位小数 + `KB`；
 * - `< 1 GiB` ⇒ 一位小数 + `MB`；
 * - 其余 ⇒ 一位小数 + `GB`。
 *
 * 为什么选这一种：①它本来就是 4 份里的多数（2/4）；②`KB/MB` 是用户在任务管理器/资源管理器里
 * 看到的同一套单位（`KiB/MiB` 虽然对 1024 进制更严格，但与本应用其它所有体积读数不一致）；
 * ③一位小数在"看体积"这个用途上足够（多一位只增加噪声）。
 *
 * 非有限值 / 负数 ⇒ `0 B`（**不许**返回 `NaN B` 这种会污染界面与日志的形态）。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 字节数 → **兆字节数字**（保留一位小数；给"机器可读的证据字段"用）。
 *
 * 与 `formatBytes` 是**同一个事实的两种输出形状**（人读字符串 / 结构化数字），
 * 所以同样只许有这一处实现：`core/diagnostics/renderer-evidence.ts` 的
 * `heapUsedMB` / `webview_total=4093MB` 这类字段要的是数字，不是 `"4093.0 MB"`。
 *
 * 为什么单独留一个函数而不是让调用方自己 `/ (1024*1024)`：那就是本仓反复吃亏的
 * 「同一事实多份实现」—— 两份的**舍入方向**都可能不同（`Math.round(x*10)/10`
 * 与 `(x/1MiB).toFixed(1)` 在 .x5 处不一致）。判据 `BYTES-SINGLE-SOURCE` 钉住这一点。
 */
export function megabytesOf(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
