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
    // 不应再有 git-status- 前缀 + 裸比较
    expect(fcl).not.toContain('git-status-" + file.status');
    // 修复后：git-status- 后跟括号内三元
    expect(fcl).toContain('"change-file-status git-status-" + (');
    expect(fcl).toContain('"turn-change-group" + (isReverted ? " reverted" : "")');
  });
});
