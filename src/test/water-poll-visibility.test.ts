/**
 * WATER-POLL：水位轮询在**页面不可见**时不该继续读（第 6 轮，带回归基线）。
 *
 * ## 为什么只做这一条（而不是把 3s 轮询改慢或加缓存键）
 *
 * 先试过「用会话行的 message_count/lastMessageAt 当闸门键」—— 那条路会被两个既有判据证否：
 * `context-water-level-banner.test.tsx` 的 WL-3（隐藏消息不算水位）与 WL-5（长会话能到 ≥70%）
 * 都是在**消息集合变了、会话行没变**的前提下改数据的（压缩/隐藏就属于这一类：条数不变）。
 * 闸门会让提示条在压缩后继续显示「上下文即将满」，那是**把缺陷修出来**，所以撤销。
 *
 * 真正零语义风险的那一半是：**页面隐藏时不轮询**。横幅本来就看不见，读出来的数没人用；
 * 重新可见时立即补一拍（不是等下一个 3s），所以用户切回来看到的永远是新值。
 *
 * ## 判据（看**读数推进**，不看 mock 调用次数）
 *
 * `readContextWaterLevel` 是模块内函数，外部 mock 换不掉它的内部调用 ——
 * 所以这里改注入它**依赖的那一层**（`listVisibleMessages`），让每次真读都会让 `messageCount` +1，
 * 然后观察 hook 返回的 `state.level.messageCount` 有没有推进。
 *
 * - 可见：每个 3s 周期推进一次；
 * - 隐藏：三个周期都不推进（后台不读）；
 * - 从隐藏变可见：`visibilitychange` 当场推进一次（不等下一个周期）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

let readCount = 0;

vi.mock("../core/storage/message", async () => {
  const actual = await vi.importActual<typeof import("../core/storage/message")>("../core/storage/message");
  return {
    ...actual,
    isHiddenStateAuthoritative: () => true,
    /* 每次"真读"都换一份内容 ⇒ 水位签名变化 ⇒ 结果里能看到这次读的序号 */
    listVisibleMessages: () => {
      readCount += 1;
      return [
        {
          id: `m-${readCount}`,
          role: "user",
          content: `第 ${readCount} 次读`,
          timestamp: readCount,
          status: "done",
        },
      ];
    },
  };
});

import { useStableContextWaterLevel } from "../core/context/water-level";

let hidden = false;

beforeEach(() => {
  hidden = false;
  readCount = 0;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe("WATER-POLL：隐藏时不读，可见时照旧", () => {
  it("可见：每个 3s 周期都推进一次", () => {
    renderHook(() => useStableContextWaterLevel("s1", 3000));
    expect(readCount, "挂载时必须读一次（否则横幅永远不出）").toBe(1);
    /* 一个周期一个周期地推（一次 advance 9000 在 fake timers 下只会跑最后一个到期的定时器，
       这一点实测过 —— 所以要分开推，测的也才是"每个周期各读一次"） */
    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(3000);
      });
    }
    expect(readCount, "可见时每周期都该读").toBe(4);
  });

  it("隐藏：三个周期一次都不读（横幅看不见，读了没人用）", () => {
    renderHook(() => useStableContextWaterLevel("s1", 3000));
    const baseline = readCount;
    hidden = true;
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(readCount, "隐藏时还在读 ⇒ 后台白烧 CPU/IO").toBe(baseline);
  });

  it("从隐藏变回可见：立即补一拍（不等下一个周期）", () => {
    renderHook(() => useStableContextWaterLevel("s1", 3000));
    hidden = true;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const baseline = readCount;
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(readCount, "切回来要立刻看到新值").toBe(baseline + 1);
  });
});
