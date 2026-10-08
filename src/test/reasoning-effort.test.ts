/**
 * 第 184 波（G10）：**思考档位的表达能力与按族钳制**（对标 Pi v1.1.0）。
 *
 * ## 两处缺陷形态
 *
 * 1. **档位被锁在上限之下**：我们的类型原来只有 `low | medium | high`，
 *    而上游支持到 `xhigh` / `max`（自适应思考）⇒ 用户/智能体选了更高档位也**表达不出来**。
 * 2. **把非法档位原样发给供应商**：各家接受的集合不同 ——
 *    `gpt-oss` 系走**扁平** `reasoning_effort` 且**只接受 low/medium/high**，
 *    把 `xhigh`/`max` 发出去会被拒（400）或静默降级，而用户以为自己在用最高档。
 *    上游的对应实现在 `packages/ai/src/api/bedrock-converse-stream.ts:1339-1355`
 *    （两张映射表 + 注释说明 gpt-oss 的接受集合）。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | EFF-1 | 类型层面能表达 `xhigh` / `max`（**由 tsc 兜住**：不合法则本文件编译失败） |
 * | EFF-2 | gpt-oss 族：`xhigh`/`max` 被钳到 `high`，低档原样 |
 * | EFF-3 | 非 gpt-oss 族：档位原样透传（不许误伤） |
 * | EFF-4 | 族判定同时看 **id 与显示名**（有的网关只把族信息放显示名里） |
 * | EFF-5 | 没选档位 ⇒ **不发该字段**（`undefined`），不是发个默认值 |
 */
import { describe, it, expect } from "vitest";
import {
  clampEffortForGptOss,
  isGptOssFamily,
  reasoningEffortForRequest,
} from "../core/llm/reasoning-effort";
import type { ReasoningEffort } from "../core/llm/types";

describe("第 184 波 · 思考档位（G10）", () => {
  it("EFF-1: 类型层面能表达 xhigh / max（不合法则本文件编译不过，tsc 是判据的一部分）", () => {
    const allowed: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
    expect(allowed).toHaveLength(5);
    // 显式赋值一次，确保这两个值真的在联合里（而不是靠 any 混过去）
    const a: ReasoningEffort = "xhigh";
    const b: ReasoningEffort = "max";
    expect([a, b]).toEqual(["xhigh", "max"]);
  });

  it("EFF-2: gpt-oss 族的 xhigh/max 必须钳到 high（它只接受 low/medium/high）", () => {
    expect(clampEffortForGptOss("low")).toBe("low");
    expect(clampEffortForGptOss("medium")).toBe("medium");
    expect(clampEffortForGptOss("high")).toBe("high");
    expect(clampEffortForGptOss("xhigh"), "不接受 xhigh ⇒ 保住最高可用档").toBe("high");
    expect(clampEffortForGptOss("max"), "不接受 max ⇒ 保住最高可用档").toBe("high");

    expect(reasoningEffortForRequest("gpt-oss-120b", undefined, "max")).toBe("high");
    expect(reasoningEffortForRequest("openai/gpt-oss-20b", undefined, "xhigh")).toBe("high");
  });

  it("EFF-3 反向对照：非 gpt-oss 族必须原样透传（不许误伤）", () => {
    for (const m of ["deepseek-v4-pro", "claude-opus-4", "gpt-5.4", "gemini-3-pro", "deepseek-reasoner"]) {
      expect(reasoningEffortForRequest(m, undefined, "max"), `「${m}」不属于 gpt-oss 族`).toBe("max");
      expect(reasoningEffortForRequest(m, undefined, "xhigh")).toBe("xhigh");
    }
  });

  it("EFF-4: 族判定同时看 id 与**显示名**（有的网关只把族信息放在显示名里）", () => {
    expect(isGptOssFamily("some-unknown-id", "GPT-OSS 120B")).toBe(true);
    expect(isGptOssFamily("gpt_oss_120b")).toBe(true);
    expect(isGptOssFamily("gpt-oss")).toBe(true);
    expect(isGptOssFamily("claude-opus-4", "Claude Opus 4")).toBe(false);
    // 反向：名字里只是**恰好**含 oss 的别的模型？—— 判据要求 "gpt" 与 "oss" 相邻，避免误伤
    expect(isGptOssFamily("cross-encoder-model"), "不许把含 oss 的无关模型卷进来").toBe(false);
  });

  it("EFF-5: 没选档位 ⇒ 不发该字段（undefined，而不是塞个默认值）", () => {
    expect(reasoningEffortForRequest("gpt-oss-120b", undefined, undefined)).toBeUndefined();
    expect(reasoningEffortForRequest("deepseek-v4-pro", undefined, undefined)).toBeUndefined();
  });
});
