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
    expect(src, "必须保护最近几轮").toMatch(/protectedFromIndexForTurns\(/);
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
