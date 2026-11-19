/**
 * A11Y-1：视觉上成对的 label 与控件，语义上必须也成对（Batch 6C）。
 *
 * 现场：设置页 35 个可交互元素没有可访问名 —— 绝大多数是「`<label>` 文字 + 紧挨着的 `<input>`」，
 * 但 label 没有 `for`、控件没有 `id`，屏幕阅读器只会念「编辑框」。
 *
 * 判据（行为）：
 * - 同组内 label 与控件被 `aria-labelledby` 关联；
 * - 已经可访问的控件不动（`aria-label` / 被 label 包住 / `label[for]` 指向）；
 * - 找不到同组控件时不猜、不报错；
 * - 幂等：连续跑两次，第二次补 0 个、属性值不变。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { labelFormControls, labelFormControlsByFallback, installAutoAriaLabels } from "../core/ui/aria-label-form";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("A11Y-1：表单控件的可访问名", () => {
  it("同组内的 label 关联到控件", () => {
    document.body.innerHTML = `
      <div class="setting-group">
        <label>字体大小</label>
        <input type="range" />
      </div>`;
    expect(labelFormControls(document)).toBe(1);
    const input = document.querySelector("input")!;
    const labelId = input.getAttribute("aria-labelledby")!;
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId)!.textContent).toContain("字体大小");
  });

  it("已有 aria-label 的控件不动", () => {
    document.body.innerHTML = `
      <div class="setting-group">
        <label>主题</label>
        <select aria-label="主题选择"><option>暗色</option></select>
      </div>`;
    expect(labelFormControls(document)).toBe(0);
    expect(document.querySelector("select")!.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("label 用 for 指向控件时不动（已经是标准写法）", () => {
    document.body.innerHTML = `
      <div class="setting-group">
        <label for="abc">语言</label>
        <select id="abc"><option>中文</option></select>
      </div>`;
    expect(labelFormControls(document)).toBe(0);
  });

  it("没有同组控件时不猜（0 个补齐，不抛错）", () => {
    document.body.innerHTML = `<div class="setting-group"><label>只有文字</label></div>`;
    expect(labelFormControls(document)).toBe(0);
  });

  it("幂等：第二次补 0 个，属性不变", () => {
    document.body.innerHTML = `
      <div class="setting-group"><label>音量</label><input type="range" /></div>`;
    expect(labelFormControls(document)).toBe(1);
    const first = document.querySelector("input")!.getAttribute("aria-labelledby");
    expect(labelFormControls(document)).toBe(0);
    expect(document.querySelector("input")!.getAttribute("aria-labelledby")).toBe(first);
  });

  it("多个组各配各的（不会把第一个 label 发给所有控件）", () => {
    document.body.innerHTML = `
      <div class="setting-group"><label>甲</label><input id="a" /></div>
      <div class="setting-group"><label>乙</label><input id="b" /></div>`;
    expect(labelFormControls(document)).toBe(2);
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const aText = document.getElementById(a.getAttribute("aria-labelledby")!)!.textContent;
    const bText = document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent;
    expect(aText).toContain("甲");
    expect(bText).toContain("乙");
  });
  it("兜底：没有 label 时用 placeholder 当名字", () => {
    document.body.innerHTML = `<div class="sp-row"><input placeholder="搜索设置..." /></div>`;
    expect(labelFormControlsByFallback(document)).toBe(1);
    expect(document.querySelector("input")!.getAttribute("aria-label")).toBe("搜索设置...");
  });

  it("兜底：没有 placeholder 时用同一行的可见文字，且不改已有名字", () => {
    document.body.innerHTML = `
      <div class="sp-row"><span>服务器地址</span><input value="http://127.0.0.1:18937/v1" /></div>
      <div class="sp-row"><span>甲</span><input aria-label="已有名字" /></div>`;
    expect(labelFormControlsByFallback(document)).toBe(1);
    expect(document.querySelectorAll("input")[0].getAttribute("aria-label")).toBe("服务器地址");
    expect(document.querySelectorAll("input")[1].getAttribute("aria-label")).toBe("已有名字");
  });
  it("持续补齐：后挂载的输入框也会被补上名字（异步渲染的真实形态）", async () => {
    const uninstall = installAutoAriaLabels();
    const later = document.createElement("div");
    later.innerHTML = '<div class="sp-row"><input placeholder="后挂载的搜索框" /></div>';
    document.body.appendChild(later);
    await new Promise((r) => setTimeout(r, 320));
    expect(document.querySelector("input")!.getAttribute("aria-label")).toBe("后挂载的搜索框");
    uninstall();
  });
});
