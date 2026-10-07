/**
 * **回归判定**（第 46 波 ✓，治本 ✓ 不靠提示词 ✗）。
 *
 * ## 它判定什么
 *
 * 「**本轮之内**被改红的判据」= 某个测试文件**首次被观察时是绿的** ✓、现在是红的 ✓。
 *
 * 抽成纯函数的三条理由 ✓（与 `turn-outcome.ts` 同一套路 ✓）：
 *   1. **可判定** ✓：这是事实比对 ✓，不是对模型措辞的解读 ✗；
 *   2. **可测** ✓：纯函数能用行为断言钉住 ✓（渲染层/循环都没有便宜的整机夹具 ✗）；
 *   3. **一处判定** ✓：循环与呈现层不会各算一遍而分歧 ✓（第 70 波的既有教训 ✓）。
 *
 * ## 为什么必须区分"回归"与"既有红"
 *
 * 真机取证（交接第十九节 ✓）：
 *   · `repo-02` / `repo-06` 的失败形态 = **把"本来绿、被自己改红"的判据点名为无关** ✗
 *   · 而 `repo-03` / `repo-04` 的红是**题目自带的既有红** ✓（改动前就红 ✓）
 * ⇒ 如果一律"有红就不许收尾" ✗ ⇒ 会把后两格**误伤** ✗（它们本来就红 ✓、且与题面无关 ✓）。
 * ⇒ 所以门只拦**回归** ✓：`基线绿 ∧ 现在红` ✓。
 *
 * ⚠️ 已知范围限制 ✓（写清，不含糊 ✗）：基线是**每轮**清的 ✓ ⇒ 它判"本轮之内"的回归 ✓；
 *   跨轮引入的回归不在本轮职责内 ✓。
 */

export type TestStatus = "red" | "green";

/**
 * 返回"基线绿、现在红"的文件名（保持传入顺序 ✓，去重 ✓）。
 *
 * @param current  当前每个判据文件的状态 ✓
 * @param baseline 每个文件**首次被观察**时的状态 ✓（缺失 = 本轮还没见过 ⇒ 不算回归 ✓）
 */
export function regressionRedFiles(
  current: ReadonlyMap<string, TestStatus>,
  baseline: ReadonlyMap<string, TestStatus>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [file, status] of current) {
    if (status !== "red") continue;
    // 没见过 ⇒ 不算回归 ✓（保守：宁可少拦，不可误伤 —— 既有红是常见情形 ✓）
    if (baseline.get(file) !== "green") continue;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}
