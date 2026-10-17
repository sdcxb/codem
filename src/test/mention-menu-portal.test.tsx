/**
 * `@` 提及候选的 Portal 修复（第 232 波）。
 *
 * ## 缺陷（真机取证，修复前）
 *
 * `MentionAutocomplete` 就地渲染在 `.input-textarea-row` 里，而祖辈
 * `.input-area.input-card-container` 有 `overflow: hidden; height: 135px`（高度有意固定）。
 * 候选面板 240px 高、锚在输入行上方 ⇒ **被裁到只剩 9px**（`clippedByPx: 231`），
 * `elementFromPoint` 在候选位置命中的是 `.messages-container` / `.qa-turn-footer` ——
 * 用户既看不见也点不到；`/` 菜单因 `SlotBridge` Portal 到 body 不受影响。
 *
 * ## 判据
 *
 * | # | 守什么 | 形态 |
 * |---|---|---|
 * | MP-1 | `@` 候选必须经 `MentionMenuPortal`（= Portal 到 body）渲染，不许回到就地渲染 | 源码结构 + 反向对照（合成「就地渲染」样本必须判红） |
 * | MP-2 | Portal 宿主确实挂在 `document.body` 下、不在输入卡的裁剪链里；定位由 fixed 包裹层给 | DOM 挂载点断言 |
 * | MP-3 | CSS：Portal 包裹层 `position: fixed`、内层面板 `position: static`；且**没有**靠放宽输入卡 `overflow` 来"挤出来" | 样式断言（防止用错修法） |
 * | MP-4 | `@` → 候选 → `ArrowDown` + `Enter` 仍能选中并插入（真实链路不回退） | 渲染 + 键盘交互（InputArea 真组件） |
 * | MP-5 | 权限预设一次点击只派发一次 `codem-security-mode-changed`（旧写法两次） | 渲染 + 事件计数（InputArea 真组件） |
 *
 * 变异自证：把 InputArea 的 `<MentionMenuPortal>` 改回就地 `<MentionAutocomplete>` ⇒ MP-1/MP-2/MP-4 红；
 * 把 `PermissionPresetSelector.handleSelect` 改回"自己写 + 再调 onModeChange" ⇒ MP-5 红（2 次）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MentionAutocomplete, type MentionItem } from "../components/MentionAutocomplete";
import { MentionMenuPortal } from "../components/MentionMenuPortal";
import { InputArea } from "../components/InputArea";
import { useProjectStore } from "../core/store";
import type { CollaborationMode } from "../core/agent/agent";

/* InputArea 里的 @ 候选来自真实文件系统列举；测试里换成固定清单（形状与 FileMentionItem 一致） */
vi.mock("../core/file-mention", () => ({
  listFilesForMention: vi.fn(async () => [
    { id: "f1", type: "file", label: "alpha.ts", path: "/proj/alpha.ts" },
    { id: "f2", type: "file", label: "beta.ts", path: "/proj/beta.ts" },
  ]),
  getRelativePath: (p: string) => p,
}));

const ROOT = path.join(__dirname, "..", "..");
const readSrc = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");

/** MP-1 的检查器：识别「就地渲染 / Portal / 找不到」三种形态（纯函数，便于反向对照） */
function mentionRenderShape(src: string): "portal" | "inline" | "missing" {
  const portalForm = /<MentionMenuPortal\s+pos=\{mentionMenuPos\}>[\s\S]{0,400}<MentionAutocomplete/;
  const inlineForm = /\{mentionQuery !== null && \(\s*<MentionAutocomplete/;
  if (portalForm.test(src)) return "portal";
  if (inlineForm.test(src)) return "inline";
  return "missing";
}

function renderInputArea(overrides: Record<string, any> = {}) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const onModeChange = vi.fn();
  const utils = render(
    <InputArea
      onSend={onSend}
      onCancel={onCancel}
      disabled={false}
      isStreaming={false}
      collaborationMode={"default" as CollaborationMode}
      onModeChange={onModeChange}
      connected={true}
      {...overrides}
    />,
  );
  return { ...utils, onSend, onCancel, onModeChange };
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: "p1", name: "proj", path: "/proj" } as any });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  document.body.innerHTML = "";
});

describe("@ 提及候选 Portal 化（第 232 波）", () => {
  it("MP-1: InputArea 必须经 MentionMenuPortal 渲染候选（不许回到就地渲染）", () => {
    const src = readSrc("src/components/InputArea.tsx");
    expect(mentionRenderShape(src), "InputArea 里 @ 候选的渲染形态不是 Portal").toBe("portal");
    expect(src).toContain('from "./MentionMenuPortal"');
    // 位置必须真的被算出来并传给 Portal（不是挂了个空壳）
    expect(src).toMatch(/setMentionMenuPos\(/);
    expect(src).toMatch(/window\.addEventListener\("scroll", update, true\)/);

    // 反向对照：合成一段「就地渲染」的样本，检查器必须判红（否则那条断言可能是哑巴）
    const inlineSample = `{mentionQuery !== null && (\n  <MentionAutocomplete items={mentionItems} query={mentionQuery} />\n)}`;
    expect(mentionRenderShape(inlineSample), "反向对照：就地渲染的样本必须被判为 inline").toBe("inline");
    // 反向对照 2：把真源码的 Portal 包裹去掉，也必须判红
    const withoutPortal = src.replace(/<MentionMenuPortal\s+pos=\{mentionMenuPos\}>/, "").replace(/<\/MentionMenuPortal>/, "");
    expect(mentionRenderShape(withoutPortal)).not.toBe("portal");
  });

  it("MP-2: Portal 宿主挂在 body 下、不在输入卡的裁剪链里", () => {
    const { container } = render(
      <div className="input-card-container" style={{ overflow: "hidden", height: 135 }}>
        <MentionMenuPortal pos={{ left: 10, bottom: 20, width: 300 }}>
          <div className="mention-autocomplete">
            <ul className="mention-list">
              <li className="mention-item">alpha.ts</li>
            </ul>
          </div>
        </MentionMenuPortal>
      </div>,
    );

    const wrapper = document.querySelector(".mention-menu-portal");
    expect(wrapper, "Portal 包裹层没渲染出来").toBeTruthy();
    expect(wrapper!.parentElement, "候选必须挂在 document.body 下").toBe(document.body);
    expect(wrapper!.closest(".input-card-container"), "候选仍在输入卡裁剪链里").toBeNull();
    expect(container.querySelector(".mention-menu-portal"), "render 容器里不该再有候选").toBeNull();

    const style = wrapper!.getAttribute("style") || "";
    expect(style).toContain("left: 10px");
    expect(style).toContain("bottom: 20px");
    expect(style).toContain("width: 300px");
    expect(style).toContain("z-index"); // 必须自带层级（body 下没有父层叠上下文可依靠）
    expect(wrapper!.querySelector(".mention-autocomplete"), "候选内容必须原样进 Portal").toBeTruthy();
  });

  it("MP-3: 样式用 fixed 包裹层 + static 内层；不许靠放宽输入卡 overflow 来挤出来", () => {
    const css = readSrc("src/styles.css");
    const wrapperBlock = css.match(/\.mention-menu-portal\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(wrapperBlock, "缺少 .mention-menu-portal 规则").toMatch(/position:\s*fixed/);
    expect(wrapperBlock).toMatch(/z-index:\s*var\(--z-top\)/);

    const innerBlock = css.match(/\.mention-menu-portal\s+\.mention-autocomplete\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(innerBlock, "缺少 Portal 内的 .mention-autocomplete 覆盖规则").toMatch(/position:\s*static/);
    expect(innerBlock).toMatch(/width:\s*100%/);

    // 修法必须是「把候选搬出裁剪链」，不是「把裁剪打开」：输入卡仍要 overflow:hidden
    expect(css, "输入卡的 overflow 被改开了 —— 那是另一种修法，会牵动 Composer 布局").toMatch(
      /\.input-card-container\s*\{[^}]*overflow:\s*hidden/,
    );
  });

  it("MP-4: @ → 候选 → ArrowDown + Enter 仍能选中并插入（真实链路不回退）", async () => {
    const user = userEvent.setup();
    renderInputArea();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(ta, "@");
    await waitFor(() => {
      expect(document.querySelector(".mention-menu-portal"), "候选没有出现").toBeTruthy();
    });

    const wrapper = document.querySelector(".mention-menu-portal")!;
    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.closest(".input-card-container")).toBeNull();

    const items = wrapper.querySelectorAll(".mention-item");
    expect(items.length, "候选条数应与 mock 的文件数一致").toBe(2);
    expect(wrapper.querySelector(".mention-header")!.textContent).toContain("提及文件 (2)");

    // 键盘路径：按下箭头到第 2 条，回车插入
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(ta.value, "键盘选中后应插入 @<label> ").toBe("@beta.ts ");
    });
    expect(document.querySelector(".mention-menu-portal"), "选中后候选应关闭").toBeNull();
  });

  it("MP-5: 权限预设一次点击只派发一次 codem-security-mode-changed", async () => {
    const user = userEvent.setup();
    renderInputArea({ projectPath: "/proj" });

    const events: any[] = [];
    const onMode = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("codem-security-mode-changed", onMode);

    const btn = document.querySelector(".security-mode-btn");
    expect(btn, "预设按钮没渲染（SlotBridge fallback 应生效）").toBeTruthy();
    await user.click(btn as HTMLElement);

    const items = [...document.querySelectorAll(".bottom-bar-dropdown-item")];
    expect(items.length, "预设下拉应有三档").toBeGreaterThanOrEqual(3);
    const auto = items.find((el) => (el.textContent || "").includes("替我审批")) ?? items[1];
    await user.click(auto as HTMLElement);

    window.removeEventListener("codem-security-mode-changed", onMode);
    expect(events.length, `一次点击派发了 ${events.length} 次同值事件（应恰好 1 次）`).toBe(1);
    expect(events[0]?.mode).toBe("auto");
  });
});

describe("MentionAutocomplete 自身键盘语义（Portal 不改变它）", () => {
  const items: MentionItem[] = [
    { id: "a", type: "file", label: "a.ts", path: "/a.ts" },
    { id: "b", type: "file", label: "b.ts", path: "/b.ts" },
    { id: "c", type: "file", label: "c.ts", path: "/c.ts" },
  ];

  it("MP-6: ArrowDown ×2 + Enter 选中第 3 条；Escape 关闭", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<MentionAutocomplete items={items} query="" onSelect={onSelect} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].label).toBe("c.ts");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
