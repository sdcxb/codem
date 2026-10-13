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

/**
 * 第 223 波（用户实报两条 UI 问题）：
 * > 模型列表太长导致，下面的模型配置看不到了，优化它。
 * > 这个列表展开的时候，点设置或者点其他按钮弹出窗口，这个列表不自动收起来。
 */
describe("CHAT-OVERLAY：下拉限高 + 点外面收起（第 223 波）", () => {
  it("CHAT-OVERLAY-5：模型下拉要限高并自己滚动（否则盖住下面的模型配置）", () => {
    const css = readFileSync(path.resolve(__dirname, "../../src/styles.css"), "utf8");
    const start = css.indexOf(".model-picker {");
    expect(start, "找不到 .model-picker").toBeGreaterThan(0);
    const block = css.slice(start, start + 700);
    expect(block, "要限高").toMatch(/max-height:\s*min\([^)]+\)/);
    expect(block, "要自己滚动").toContain("overflow-y: auto");
    expect(block, "别让滚动穿透到背后").toContain("overscroll-behavior: contain");
  });

  it("CHAT-OVERLAY-6：点任何非本下拉的地方（含「设置」按钮）都要收起", () => {
    const chat = readFileSync(path.resolve(__dirname, "../components/ChatPanel.tsx"), "utf8");
    expect(chat, "要有基于 pointerdown 的点外面收起").toMatch(
      /addEventListener\("pointerdown",\s*onPointerDown,\s*true\)/,
    );
    expect(chat, "下拉自身与打开它的按钮不算外面").toMatch(/closest\("\.model-picker"\)[\s\S]{0,80}?closest\("\.model-selector"\)/);
    expect(chat, "命中外面就关掉").toMatch(/setShowModelPicker\(false\)/);
    expect(chat, "监听器要在关闭/卸载时摘掉（否则会泄漏）").toMatch(/removeEventListener\("pointerdown",\s*onPointerDown,\s*true\)/);
  });
});


/**
 * 第 224 波（用户实报）：
 * > 列表换行比较严重，适当放宽列表宽度。然后太长的模型名字用缩写，鼠标指上去显示全称。
 */
describe('CHAT-OVERLAY：下拉放宽 + 长名截断（第 224 波）', () => {
  it('CHAT-OVERLAY-7：下拉要够宽（不再把名字挤成两三行）', () => {
    const css = readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8');
    const start = css.indexOf('.model-picker {');
    const block = css.slice(start, start + 1400);
    expect(block, '下限要够放常见模型名').toMatch(/min-width:\s*3[0-9]{2}px/);
    expect(block, '按内容撑开').toContain('width: max-content');
    expect(block, '但不能溢出小窗口').toMatch(/max-width:\s*min\(/);
    expect(block, '旧的 160px 太窄，必须已经不在').not.toContain('min-width: 160px');
  });

  it('CHAT-OVERLAY-8：长名省略号截断，且悬停能看全称（title）', () => {
    const css = readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8');
    const nameBlock = css.slice(css.indexOf('.model-option-name {'), css.indexOf('.model-option-name {') + 260);
    expect(nameBlock, '名字过长要省略号').toContain('text-overflow: ellipsis');
    expect(nameBlock, '截断需要 min-width: 0（flex 子项默认不收缩）').toContain('min-width: 0');

    const chat = readFileSync(path.resolve(__dirname, '../components/ChatPanel.tsx'), 'utf8');
    expect(chat, '悬停显示全称').toMatch(/className="model-option-name"\s+title=\{m\.name\}/);
    const selector = readFileSync(path.resolve(__dirname, '../components/ModelSelector.tsx'), 'utf8');
    expect(selector, '另一个列表也要悬停全称').toContain('title={m.name}');

    const note = css.slice(css.indexOf('.model-option .model-option-note'), css.indexOf('.model-option .model-option-note') + 180);
    expect(note, '标签不许被压缩换行').toMatch(/flex:\s*0 0 auto/);
  });
});
