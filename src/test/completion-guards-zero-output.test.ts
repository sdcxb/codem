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
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["red"], lookedAtSource: false, alreadyNudged: false }),
      "活没干完（判据红着）却什么都没改就收尾 ⇒ 不许安静地过去",
    ).toBe(true);
  });

  it("ZA-2 反向对照: 没改过 + 判据全绿 ⇒ **不许**提醒（别骚扰只读型任务 ✗）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["green", "green"], lookedAtSource: true, alreadyNudged: false }),
      "只跑测试看结论、且全绿 ⇒ 那就是做完了，提醒只会是噪音",
    ).toBe(false);
  });

  it("ZA-3 反向对照: 改过了 ⇒ 不提醒（那是另外两条守卫的辖区 ✓）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: true, testStatuses: ["red"], lookedAtSource: true, alreadyNudged: false }),
      "改过文件就该由'改了没验证'/'判据没跑齐'去管，别抢",
    ).toBe(false);
  });

  it("ZA-4: 已经提醒过 ⇒ 不再提醒（每会话一次 ✓）", () => {
    expect(shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["red"], lookedAtSource: true, alreadyNudged: true })).toBe(false);
  });

  it("ZA-5（第 163 波补）: 没改过 + **一次测试都没跑** ⇒ 也要提醒（真机里「早早收工」多半是这个形状 ✗）", () => {
    /**
     * 实测迭代数：通过轮 **47 / 61 / 66** ✓，失败轮 **3 / 17 / 21 / 23 / 24 / 26 / 37** ✗。
     * 其中 v31 run-4（23 次、失败 ✗、`loopStops=[]` ✗）**既没改、也没跑测试** ✓
     * ⇒ 只要求「有红的判据」会让这种轮次**完全隐身** ✗。
     */
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: [], lookedAtSource: true, alreadyNudged: false }),
      "没改、没跑测试就收尾 ⇒ 至少要说一句为什么（提醒文案明确邀请它说明理由 ✓）",
    ).toBe(true);
  });

  it("ZA-7（第 163 波收紧）: 没改过、没跑测试、**也没读过源码** ⇒ 不打扰（12 条回路判据就是被这一条误伤的 ✗）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: [], lookedAtSource: false, alreadyNudged: false }),
      "连源码都没读 ⇒ 无从判断它在干实现类的活 ⇒ 别去打扰（既有回路夹具全是这个形状 ✓）",
    ).toBe(false);
  });

  it("ZA-6 反向对照: 没改过 + 测试**全绿** ⇒ 仍然不许提醒（只读型任务就是做完了 ✓）", () => {
    expect(
      shouldNudgeZeroOutput({ modifiedAnything: false, testStatuses: ["green", "green", "green"], lookedAtSource: true, alreadyNudged: false }),
      "全绿说明「跑测试看结论」这条路径本身是成立的 ⇒ 别打扰",
    ).toBe(false);
  });
});


