/**
 * 第 213 波判据（用户实报）：
 *
 * > 对话里模型列表打开的时候，切换对话没自动关闭列表，导致新切换打开的对话顶上去了。
 *
 * 根因：这些浮层是组件内的布尔状态，只在"点自己那个按钮"时切换 —— **切换会话不是它们关心的事件**
 * ⇒ 旧会话的浮层原样贴到新会话上面。
 *
 * 判据要点：
 * ① 切换会话/笔记本时，**所有瞬时浮层**必须一起收起（只修一个 ⇒ 下次换个面板再报一次）；
 * ② **不许**把"持久偏好"（右侧栏、快捷入口、思考过程显示）也一起收起 —— 那是用户显式设置的常驻状态，
 *    切会话收起来反而是 bug ⇒ 这条是反向对照，防止"为了修 bug 把正常行为改坏"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const panel = readFileSync(path.resolve(__dirname, "../components/ChatPanel.tsx"), "utf8");

/** 取"切会话时收浮层"那个 effect 的正文 */
const closeOnSwitch = (() => {
  const marker = "第 213 波";
  const start = panel.indexOf(marker);
  if (start < 0) return "";
  const body = panel.slice(start, start + 2200);
  const end = body.indexOf("}, [currentSessionId, notebookId]);");
  return end < 0 ? body : body.slice(0, end);
})();

describe("CHAT-OVERLAY：切换会话要收起浮层（第 213 波）", () => {
  it("CHAT-OVERLAY-1：切会话的 effect 必须存在，并以 currentSessionId / notebookId 为依赖", () => {
    expect(closeOnSwitch, "找不到「切会话收浮层」的 effect").not.toBe("");
    expect(panel, "依赖里要同时有会话与笔记本").toContain("}, [currentSessionId, notebookId]);");
  });

  it("CHAT-OVERLAY-2：模型列表必须被收起（用户实报的就是它）", () => {
    expect(closeOnSwitch, "要收起模型列表").toContain("setShowModelPicker(false)");
  });

  it("CHAT-OVERLAY-3：同类瞬时浮层要**一起**收起（推理强度、各类面板、搜索、快速短语…）", () => {
    for (const setter of [
      "setShowEffortPicker(false)",
      "setShowAgentPanel(false)",
      "setShowSnapshotPanel(false)",
      "setShowContextMonitor(false)",
      "setShowTrajectoryPanel(false)",
      "setShowGitPanel(false)",
      "setShowSearch(false)",
      "setShowQuickPhrase(false)",
      "setShowDraftPicker(false)",
      "setShowTitleDropdown(false)",
    ]) {
      expect(closeOnSwitch, `同类浮层漏了：${setter}`).toContain(setter);
    }
  });

  it("CHAT-OVERLAY-4（反向对照）：持久偏好不许被一起收起（右侧栏 / 快捷入口 / 思考过程）", () => {
    for (const setter of ["setShowRightSidebar", "setShowQuickAccess", "setShowReasoning"]) {
      expect(closeOnSwitch, `持久偏好被误收：${setter}`).not.toContain(setter);
    }
  });
});
