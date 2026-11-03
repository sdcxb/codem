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

function readRepo(rel: string): string {
  return readFileSync(rel, "utf8");
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

  it("UI-003: 变更列表的状态类名由一个函数产出（桌面与手机同一份）", () => {
    /*
     * 第 270 波：展示层从 `src/components/FileChangesList.tsx` 抽到共享
     * `packages/ui/src/changes-list.tsx`（桌面只剩数据适配器）。判据目标随之移动，
     * 但钉的仍是同一件事：**不许在 JSX 里拼"前缀 + 裸比较"**。
     */
    const model = readRepo("packages/ui/src/changes-model.ts");
    const list = readRepo("packages/ui/src/changes-list.tsx");
    const desktop = read("FileChangesList.tsx");

    expect(model, "状态类必须由一个函数产出（不许在 JSX 里拼）").toContain("export function fileStatusClass(");
    expect(list, "文件行的 status 类必须走这个函数").toContain("className={fileStatusClass(file.status)}");
    expect(list).toContain('isReverted ? "turn-change-group reverted" : "turn-change-group"');
    // 桌面适配器不许再自带第二套状态类实现 / 裸拼接
    expect(desktop).not.toContain('git-status-" + file.status');
    expect(desktop).not.toContain("function gitStatusClass(");
  });
});
