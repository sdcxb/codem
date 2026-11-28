/** unslop 收口：边框/卡片密度。插件行、任务卡、记忆项不再逐条描边。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync("src/styles/unslop-v2.css", "utf8");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 边框/卡片密度", () => {
  it("插件行不再逐行画线，列表只保留一条组线", () => {
    expect(clean).toMatch(/\.plugin-row\s*\{[^}]*border-bottom:\s*0/);
    expect(clean).toMatch(/\.plugin-list\s*\{[^}]*border-top:\s*1px solid var\(--ui-line\)/);
  });

  it("任务卡改用底面分组，不再保留一圈卡片边框", () => {
    expect(clean).toMatch(/\.lo-card\s*\{[^}]*border-color:\s*transparent/);
    expect(clean).toMatch(/\.lo-card\s*\{[^}]*background:\s*var\(--ui-surface-raised\)/);
  });

  it("设置表单行不再逐行画分隔线，保留输入控件自身边框", () => {
    expect(clean).toMatch(/\.settings-content[^{}]*\.setting-group[^{}]*\{[^}]*border-bottom-color:\s*transparent/);
  });

  it("聊天用户气泡用白色内容面 + 一条发丝边框，任务活动行/证据 rail 不逐条描边", () => {
    expect(clean).toMatch(/\.user \.message-content\s*\{[^}]*background:\s*var\(--ui-surface-raised\)/);
    expect(clean).toMatch(/\[data-theme="light"\] \.user \.message-content\s*\{[^}]*background:\s*var\(--ui-surface\)[^}]*border:\s*1px solid var\(--ui-line\)/);
    expect(clean).not.toMatch(/\.workbench-activity-entry\s*\{[^}]*border-bottom/);
    expect(clean).not.toMatch(/\.jobs-panel-row\s*\{[^}]*border-bottom/);
    expect(clean).toMatch(/\.turn-evidence-rail\s*\{[^}]*border-top:\s*1px/);
    expect(clean).not.toMatch(/\.turn-evidence-rail\s*\{[^}]*border-bottom/);
  });

  it("任务中心/插件市场/AgentPanel 不再用内联 1px 边框画列表", () => {
    const files = [
      "src/components/TaskCenter.tsx",
      "src/components/task-center/InboxTab.tsx",
      "src/components/task-center/IssueCard.tsx",
      "src/components/task-center/DelegationTab.tsx",
      "src/components/task-center/SubagentsTab.tsx",
      "src/components/plugin-market/PluginMarketTab.tsx",
      "src/components/AgentPanel.tsx",
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/border(?:Top|Right|Bottom|Left)?\s*:\s*["']1px/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(file + ":" + line);
      }
    }
    expect(hits, "列表/卡片边框应走 class，不再写内联 1px").toEqual([]);
  });

  it("记忆项只在 hover/selected 时描边，静止态透明", () => {
    expect(clean).toMatch(/\.memory-item\s*\{[^}]*border:\s*1px solid transparent/);
  });
});
