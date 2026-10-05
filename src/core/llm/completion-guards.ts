/**
 * 收尾守卫的**纯判定**（第 162 波 ✓）—— 与回路解耦，便于单测与变异 ✓。
 *
 * 目前有两条 ✓：
 * - `shouldNudgeUnverified`：改了文件但**最后一次改动之后没验证** ✓（VU ✓，第 140 波）；
 * - `shouldNudgeZeroOutput`：**一个字节都没改**、而**判据还是红的就收尾** ✓（模式 A ✓，本波新增）。
 */

/**
 * **模式 A：零产出收工** ✓（第 162 波）。
 *
 * ## 为什么要它（同版本两批对照 ✓）
 *
 * 同一版本（1.16.264）的 repo-02 两批，一批 **3/4** ✓、一批 **0/4** ✗。
 * 分解之后，"把 3/4 打成 0/4"的是这一种 ✗：
 *
 * ```
 * v32 run-3：7 次调用、diff **0**、maxIteration=3、timedOut=false
 *          ⇒ 不是崩溃、不是超时，是模型自己**早早收尾、什么都没改** ✗
 * ```
 *
 * 而**现有两把守卫都正确地沉默了** ✗：
 * - "改了但没验证"：`turnModifiedFiles` 为假 ⇒ 不触发 ✓；
 * - "族判据没跑过"：没动过盘 ⇒ 不触发 ✓。
 *
 * ## 判据为什么是"**没改 + 判据还红着**"（低误报 ✓）
 *
 * - **没改** ✓：一旦改过，这是"未验证/不完整"那两条的辖区 ✓，不该抢 ✗；
 * - **判据红着** ✓：只看"没改"会误伤**只读型任务** ✗（只跑测试、看结论、不改代码 ✓，
 *   测试全绿时它就是做完了 ✓）⇒ 要求"**至少有一条判据是红的**"✓ ——
 *   这是"活没干完"的**硬证据** ✓，不是猜测 ✓。
 *
 * 作用要说清 ✓：它**不能**消除采样方差 ✗（同一提示词，一次 84 次调用、一次 7 次 ✗），
 * 它只能**不让这种失败安静地过去** ✓ —— 而真机数据（v31 的 3/4 ✓）说明"被迫再看一眼"有时就够了 ✓。
 */
export function shouldNudgeZeroOutput(args: {
  /** 本会话有没有动过盘（`sessionModifiedAnything` ✓） */
  modifiedAnything: boolean;
  /** 本会话跑过的判据 → 结果（`testFileStatus` ✓） */
  testStatuses: Iterable<"red" | "green">;
  /** 这条提醒每会话只发一次 ✓ */
  alreadyNudged: boolean;
}): boolean {
  if (args.alreadyNudged) return false;
  if (args.modifiedAnything) return false; // 改过了 ⇒ 交给另外两条守卫 ✓
  for (const s of args.testStatuses) if (s === "red") return true;
  return false;
}
