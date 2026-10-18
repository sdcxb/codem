/**
 * MEM-QUICK：待批准区提供**一键关掉「项目级」写入审批**（2026-10-18 用户实报）
 *
 * 用户现场：「记忆系统里，审批还是很频繁…我拒绝了大量的审批，还是每轮对话，有很多审批。」
 *
 * 数据侧的定性（本机库 + 设置）：项目级自动记忆默认**逐条审批**（`DEFAULT_APPROVAL.project = true`），
 * 所以每轮提取出的项目级条目都会进待批准区 —— 用户拒绝的是"这一条"，默认值并没有变，
 * 下一轮还来。这不是"批得慢"，是**默认策略**问题。
 *
 * 修法：待批准区给一个一次性开关（就是「写入审批」的 project 档），点一下以后不再逐条问；
 * 平台级仍保留审批。判据 `MEM-QUICK-1..3`；变异 `memory-quick-toggle`。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "components", "MemoryManager.tsx"), "utf8");

describe("MEM-QUICK 一键关闭项目级审批", () => {
  it("MEM-QUICK-1: 待批准区有「以后不再逐条批准」按钮，且只在 project 审批开启时出现", () => {
    expect(SRC).toContain("以后不再逐条批准");
    expect(SRC, "按钮必须受 approval.project 控制（已经关了就不该再出现）").toContain("approval.project && (");
    expect(SRC).toContain('handleToggleApproval("project")');
  });

  it("MEM-QUICK-2: 文案写明代价（不再询问、平台级仍询问、可重新开启）", () => {
    const at = SRC.indexOf("以后不再逐条批准");
    const around = SRC.slice(Math.max(0, at - 1800), at + 400);
    expect(around, "必须说明代价：不经确认就进上下文").toContain("不经你确认");
    expect(around, "必须说明平台级仍会询问").toContain("平台级仍");
    expect(around, "必须说明可重新打开").toContain("重新打开");
  });

  it("MEM-QUICK-3: 关的是「写入审批」的 project 档，不是把整条记忆删掉", () => {
    // 只看这个按钮自己的 onClick 块（前后兄弟按钮里有「全部拒绝」，不能用大窗口误伤）
    const start = SRC.indexOf("{approval.project && (");
    const end = SRC.indexOf("以后不再逐条批准", start);
    expect(start, "找不到受控按钮").toBeGreaterThan(0);
    const block = SRC.slice(start, end);
    expect(block).toContain("handleToggleApproval(\"project\")");
    expect(block, "不许在这一键里删除/拒绝记忆").not.toMatch(/handleRejectAll|approveMany|deleteEntry/);
  });
});
