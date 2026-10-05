/**
 * 第 162 波：**模式 A（零产出收工）守卫的判据** ✓。
 *
 * ## 它针对的真机形态（同版本两批对照 ✓）
 *
 * ```
 * v31（1.16.264）：3/4 ✓   调用 70 / 84 / 39 / 87   ⇒ 每轮都干了活 ✓
 * v32（1.16.264）：0/4 ✗   调用 34 / 7 / 27 / 59    ⇒ 其中 run-3 只跑了 7 次、diff=0 ✗
 * ```
 * v32 run-3 的关键字段：`maxIteration=3` ✓、`timedOut=false` ✓、`diffChars=0` ✗
 * ⇒ **不是崩溃、不是超时** ✓，是模型自己早早收尾、**一个字节都没改** ✗。
 *
 * ## 判据（重点是**别误伤只读型任务** ✗）
 *
 * - **ZA-1**：没改过 + **有判据红着** ⇒ 该提醒 ✓（v32 run-3 的形状 ✓）；
 * - **ZA-2 反向对照**：没改过 + 判据**全绿** ⇒ **不提醒** ✓
 *   （"只跑测试看结论"的任务本来就该这么结束 ✓ —— 这条是防误伤的关键 ✓）；
 * - **ZA-3 反向对照**：**改过了** ⇒ 不提醒 ✓（那是"未验证 / 判据不完整"两条守卫的辖区 ✓）；
 * - **ZA-4**：已经提醒过 ⇒ 不再提醒 ✓（每会话一次 ✓）。
 *
 * 变异：去掉"必须有红的"这一条 ⇒ **ZA-2 立刻红** ✓（会去骚扰只读型任务 ✗）。
 */
import { describe, expect, it } from "vitest";
import { shouldNudgeZeroOutput } from "../core/llm/completion-guards";

describe("第 162 波：零产出收工守卫", () => {
  it("ZA-1: 没改过 + 判据红着 ⇒ 必须提醒（v32 run-3：7 次调用、diff 0 ✗）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["red"], alreadyNudged: false }),
      "活没干完（判据红着）却什么都没改就收尾 ⇒ 不许安静地过去",
    ).toBe(true);
  });

  it("ZA-2 反向对照: 没改过 + 判据全绿 ⇒ **不许**提醒（别骚扰只读型任务 ✗）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["green", "green"], alreadyNudged: false }),
      "只跑测试看结论、且全绿 ⇒ 那就是做完了，提醒只会是噪音",
    ).toBe(false);
  });

  it("ZA-3 反向对照: 改过了 ⇒ 不提醒（那是另外两条守卫的辖区 ✓）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: true, testStatuses: ["red"], alreadyNudged: false }),
      "改过文件就该由'改了没验证'/'判据没跑齐'去管，别抢",
    ).toBe(false);
  });

  it("ZA-4: 已经提醒过 ⇒ 不再提醒（每会话一次 ✓）", () => {
    expect(shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["red"], alreadyNudged: true })).toBe(false);
  });
});
