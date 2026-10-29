/**
 * FD-7（接线棘轮）：**水位 / 面板 / 引擎三处必须共用同一把尺子**。
 *
 * 为什么必须有这条判据：折叠是"读时视图"，如果只有引擎折了、水位没折，就会出现
 * 「面板显示 85% 但横幅不弹」；反过来只有水位折了、引擎没折，就是"界面变好看了、模型照样溢出"——
 * 两种都是自相矛盾，而且**只有真机才会遇到**，单元判据不看源码就守不住。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const read = (p: string) => norm(fs.readFileSync(p, "utf8"));

describe("FD-7 折叠阶梯接线：三处同一把尺子", () => {
  it("引擎（agentic-loop）在组装请求时折叠远处的工具输出", () => {
    const src = read("src/core/llm/agentic-loop.ts");
    expect(src, "必须调用折叠（否则模型照样收到全量）").toMatch(/shouldFoldToolOutputs\(/);
    expect(src, "必须真的按目标折").toMatch(/foldToolOutputsUnderTarget\(/);
    /*
     * 2026-10-29：这里原来断言「必须保护最近几轮」（`protectedFromIndexForTurns`）——
     * 那条承诺与折叠存在的前提冲突（长回合正是水位爆掉的场景，按轮次保护会让折叠在最需要它的
     * 地方失效），而且那个参数从来没有被实现读过。现在钉真正的不变量：**最近 N 条结果不动**
     * 由折叠模块自己的常量保证（`FOLD_KEEP_RECENT_RESULTS`），引擎侧只需要不再传死参数。
     */
    expect(src, "不该再传那个从未被实现的死参数").not.toMatch(/protectedFromIndex/);
    expect(read("src/core/llm/tool-output-fold.ts"), "最近 N 条结果的保护必须是折叠模块自己的常量").toMatch(
      /FOLD_KEEP_RECENT_RESULTS/,
    );
  });

  it("水位（water-level）按折叠后的视图算，并带出折叠痕迹", () => {
    const src = read("src/core/context/water-level.ts");
    expect(src, "水位必须走共享入口（否则与引擎口径不一致）").toMatch(/foldForLevelIfNeeded\(/);
    expect(src, "必须带出折叠条数供界面留一行痕迹").toMatch(/foldedToolOutputs/);
  });

  it("面板（ContextMonitor）也必须走同一个共享入口 —— 三处口径归一（真机实测过不一致：引擎已折叠、面板报 84%）", () => {
    const src = read("src/components/ContextMonitor.tsx");
    expect(src, "面板的占用必须与引擎同一把尺子").toMatch(/foldForLevelIfNeeded\(/);
  });

  it("共享入口本身只用一处折叠阈值来源（不许把 0.5/0.45 再写一遍）", () => {
    const fold = read("src/core/llm/tool-output-fold.ts");
    expect(fold).toMatch(/FOLD_TRIGGER_RATIO/);
    expect(fold).toMatch(/FOLD_TARGET_RATIO/);
    const others = ["src/core/context/water-level.ts", "src/core/llm/agentic-loop.ts"];
    for (const f of others) {
      const src = read(f);
      expect(src, `${f} 不该自己发明折叠阈值`).not.toMatch(/0\.45/);
    }
  });
});
