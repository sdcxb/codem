/**
 * 计划停滞检测契约（第 65 波）—— 补上「每次输出都不一样」的空转。
 *
 * 为什么需要第三道检测（前两道的盲区，见各文件头注释）：
 *   · 零信息增益要求"内容与之前完全相同" → 内容一直在变就判不出来；
 *   · 空闲看门狗要求"完全没有事件" → 一直在动就判不出来。
 * 第三类打转是**输出一直在变、但任务一步没走**（计划没修订、一个交付物都没产生）。
 * 它的判据不能是内容，只能是**状态**：计划修订号 + 交付物。
 */

import { describe, it, expect } from "vitest";
import { StallGuard, DEFAULT_STALL_LIMITS } from "../core/llm/stall-guard";
import { ArtifactTracker } from "../core/llm/artifact-tracker";

const PLAN_A = { planRevision: 0, producedArtifact: false };
const REVISED = { planRevision: 1, producedArtifact: false };
const ARTIFACT = { planRevision: 0, producedArtifact: true };

describe("计划停滞检测（第 65 波）", () => {
  it("STALL-1: 计划没修订 + 没有交付物 → 连续到阈值先「问」，不直接停", () => {
    const g = new StallGuard();
    const actions: string[] = [];
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter; i++) {
      actions.push(g.noteIteration(PLAN_A).action);
    }
    expect(actions.slice(0, -1).every((a) => a === "none")).toBe(true);
    expect(actions.at(-1)).toBe("ask");
    expect(g.stats.asks).toBe(1);
  });

  it("STALL-2: 「问」之后仍无推进 → 到第二个窗口才停（且只停一次）", () => {
    const g = new StallGuard();
    let stopAt = -1;
    for (let i = 1; i <= DEFAULT_STALL_LIMITS.stopAfter; i++) {
      const d = g.noteIteration(PLAN_A);
      if (d.action === "stop") { stopAt = i; break; }
    }
    expect(stopAt).toBe(DEFAULT_STALL_LIMITS.stopAfter);
    expect(g.stats.asks).toBe(1);
    expect(g.stats.stops).toBe(1);
  });

  it("STALL-3: 产出交付物就清零 —— 「读一堆文件然后动手写」是合法节奏，绝不能被误判", () => {
    const g = new StallGuard();
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter - 1; i++) {
      expect(g.noteIteration(PLAN_A).action).toBe("none");
    }
    expect(g.noteIteration(ARTIFACT).action).toBe("none"); // 写出一个文件（真实推进）
    expect(g.stalledIterations).toBe(0);
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter - 1; i++) {
      expect(g.noteIteration(PLAN_A).action).toBe("none");
    }
  });

  it("STALL-4: 模型修订计划（update_plan）同样清零", () => {
    const g = new StallGuard();
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter - 1; i++) g.noteIteration(PLAN_A);
    expect(g.noteIteration(REVISED).action).toBe("none");
    expect(g.stalledIterations).toBe(0);

    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter - 1; i++) g.noteIteration(REVISED);
    expect(g.noteIteration({ planRevision: 2, producedArtifact: false }).action).toBe("none");
    expect(g.stalledIterations).toBe(0);
    expect(g.stats.progressResets).toBeGreaterThanOrEqual(2);
  });

  it("STALL-4b: **UI 步进（macroStep）不能当推进信号**（审计修正的回归锁）", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/stall-guard.ts"), "utf-8");
    expect(src).toMatch(/planRevision/);
    expect(src, "不应再用计划标题/macroStep 当推进指纹").not.toMatch(/planKey:\s*string/);
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    expect(loop, "update_plan 成功时才 +1").toMatch(/this\.planRevision\+\+/);
  });

  it("STALL-5: 提醒过之后又出现推进，则下一次停滞会重新「问」一次（不是一次就永久闭嘴）", () => {
    const g = new StallGuard();
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter; i++) g.noteIteration(PLAN_A);
    g.noteIteration(ARTIFACT); // 恢复推进
    let asked = false;
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter; i++) {
      if (g.noteIteration(PLAN_A).action === "ask") { asked = true; break; }
    }
    expect(asked, "再次停滞应当能再次提问").toBe(true);
    expect(g.stats.asks).toBe(2);
  });

  it("STALL-6: 纯问答（计划修订号恒为 0）不会误报", () => {
    const g = new StallGuard();
    const actions: string[] = [];
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter - 1; i++) {
      actions.push(g.noteIteration({ planRevision: 0, producedArtifact: false }).action);
    }
    expect(actions.every((a) => a === "none")).toBe(true);
  });

  it("STALL-7: 阈值可配置（不写死；不同场景可以用不同窗口）", () => {
    const g = new StallGuard({ askAfter: 2, stopAfter: 4 });
    expect(g.noteIteration(PLAN_A).action).toBe("none");
    expect(g.noteIteration(PLAN_A).action).toBe("ask");
    expect(g.noteIteration(PLAN_A).action).toBe("none");
    expect(g.noteIteration(PLAN_A).action).toBe("stop");
  });

  it("STALL-8: 提示语要求「说清卡点 + 更新计划或报告」，并带上当前步骤", () => {
    const g = new StallGuard();
    let msg = "";
    for (let i = 0; i < DEFAULT_STALL_LIMITS.askAfter; i++) {
      const d = g.noteIteration({ ...PLAN_A, stepLabel: "写 3000 字版" });
      if (d.action === "ask") msg = d.message ?? "";
    }
    expect(msg).toMatch(/卡在哪/);
    expect(msg).toMatch(/update_plan/);
    expect(msg).toMatch(/读是为了写/);
    expect(msg, "提醒里要带上当前步骤，便于模型定位").toMatch(/写 3000 字版/);
  });

  it("STALL-9: 「产出交付物」的判定不能把只读查询算进去（审计修正：反复 `git status` 不算干活）", () => {
    const tracker = new ArtifactTracker();
    // 写入类工具：算交付物
    expect(tracker.note("write", { path: "D:\\a.md", content: "x" }, "Successfully wrote", null).artifact).toBe(true);
    // 只读 VCS 查询：不算（否则反复 `git status` 的会话永远判不出停滞）
    const readOnly = tracker.note("bash", { command: "git status" }, "On branch master", { kind: "mutate", provable: false });
    expect(readOnly.artifact, "只读查询不该算交付物").toBe(false);
    // 可证明会改盘的命令（Set-Content 等）：算
    const provable = tracker.note("bash", { command: "Set-Content -Path D:\\a.txt -Value x" }, "written", { kind: "mutate", provable: true });
    expect(provable).toEqual({ artifact: true, verdict: "provable" });
    // 结果失败：不算
    expect(tracker.note("write", { path: "D:\\a.md" }, "Error: permission denied", null).artifact).toBe(false);
  });

  it("STALL-10（第 83 波用户现场）: 同一条「可能写」的命令反复跑 → 不再算推进（停滞守卫不能被打转骗过）", () => {
    const tracker = new ArtifactTracker(3); // 允许前 3 次
    const cmd = 'python "D:\\课题3\\_tmp_extract.py"'; // 只读脚本，每轮输出都不同（带时间戳）
    const verdicts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = tracker.note("bash", { command: cmd }, `提取完成 ts=${Date.now()}`, { kind: "mutate", provable: false });
      verdicts.push(`${i + 1}:${r.verdict}`);
    }
    // 前几次算推进（保护"构建→测试→再构建"这类正常节奏），重复到阈值后不再算
    expect(verdicts.slice(0, 3).every((v) => v.endsWith("speculative-ok"))).toBe(true);
    expect(verdicts.slice(3).every((v) => v.endsWith("speculative-repeat"))).toBe(true);
    expect(tracker.stats.speculativeVetoed).toBe(5);
  });

  it("STALL-11: 命令各不相同（正常的构建/测试长任务）照常算推进；真实写入后重复计数清零", () => {
    const tracker = new ArtifactTracker(2);
    const cmds = ["npm run build", "npm test", "cargo build", "pytest -q", "npm run build -- --prod"];
    for (const c of cmds) {
      // npm/cargo/pytest 属于"可能写"：命令各不相同 → 每次都算推进
      expect(tracker.note("bash", { command: c }, `输出 ${c}`, { kind: "mutate", provable: false }).artifact, c).toBe(true);
    }
    // 同一条命令重复到超过允许次数（allowance=2：第 3 次起）→ 不算了
    expect(tracker.note("bash", { command: "npm test" }, "又跑一次", { kind: "mutate", provable: false }).artifact).toBe(true);
    expect(tracker.note("bash", { command: "npm test" }, "第三次", { kind: "mutate", provable: false }).artifact).toBe(false);
    // 出现一次**可证明**的写操作（真正改了盘）→ 记忆清零，重新给它机会
    tracker.note("bash", { command: "Set-Content -Path D:\\out.txt -Value done" }, "written", { kind: "mutate", provable: true });
    expect(tracker.note("bash", { command: "npm test" }, "改了盘之后再跑，合理", { kind: "mutate", provable: false }).artifact).toBe(true);
  });

  it("STALL-12: 判定逻辑真的接在循环里（否则守卫照样失效）", () => {
    const fs = require("fs");
    const path = require("path");
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    expect(loop, "循环必须用分级判定").toContain("this.artifactTracker.note(");
    expect(loop, "旧的单一判定（mutate 即交付物）必须已经移除").not.toContain("function isArtifactTool");
    expect(loop).toContain("this.iterationProducedArtifact = true");
  });
});
