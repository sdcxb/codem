/**
 * 回归测试：JSX className 运算符优先级 bug（对标审计发现）
 *
 * 模式：`className={"prefix " + cond ? "a" : "b"}` 因 + 优先于 === 恒为
 * 字符串拼接后比较 → 永远 false（选中态/高亮失效）。已修 6 处：
 *   TerminalPanel / FileChangesList×2 / NeedsYouPanel / Workbench×3
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

function read(name: string): string {
  return readFileSync(`src/components/${name}`, "utf8");
}

describe("JSX className 运算符优先级（无裸拼接比较）", () => {
  it("UI-001: 各组件不再包含 `+ X === Y ?` 裸模式", () => {
    const files = [
      "TerminalPanel.tsx",
      "FileChangesList.tsx",
      "NeedsYouPanel.tsx",
      "Workbench.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      // 裸模式：字符串拼接后直接 === 比较（无括号包裹条件）
      const bad = /\{"[^"]*" \+ \w+ ===/;
      expect(bad.test(src), `${f} 含裸拼接比较`).toBe(false);
    }
  });

  it("UI-002: 修复后的模式为 `\"prefix\" + (cond ? \" active\" : \"\")`", () => {
    const wb = read("Workbench.tsx");
    expect(wb).toContain('"workbench-view-tab" + (activeView === "status" ? " active" : "")');
    expect(wb).toContain('"workbench-view-tab" + (activeView === "capacity" ? " active" : "")');
    expect(wb).toContain('"workbench-view-tab" + (activeView === "activity" ? " active" : "")');

    const ny = read("NeedsYouPanel.tsx");
    expect(ny).toContain('"needs-you-option" + (selectedOption === opt.id ? " selected" : "")');

    const tp = read("TerminalPanel.tsx");
    expect(tp).toContain('"terminal-tab" + (s.id === activeId ? " active" : "")');
  });

  it("UI-003: FileChangesList 状态类名用括号包裹三元", () => {
    const fcl = read("FileChangesList.tsx");
    // 不应再有 git-status- 前缀 + 裸比较（这正是本条判据要防的优先级 bug）
    expect(fcl).not.toContain('git-status-" + file.status');
    /*
     * 第 233 轮：那处三目被抽成了**一个函数**（`gitStatusClass`）—— JSX 里不再拼字符串，
     * 上面那条"不许裸比较拼接"的意图因此更强；这里钉住新形态的接线。
     */
    expect(fcl, "状态类必须由一个函数产出（不许在 JSX 里拼）").toContain("function gitStatusClass(");
    expect(fcl, "两处 status 类都必须走这个函数").toContain("className={gitStatusClass(file.status)}");
    expect(fcl).toContain('isReverted ? "turn-change-group reverted" : "turn-change-group"');
  });
});
