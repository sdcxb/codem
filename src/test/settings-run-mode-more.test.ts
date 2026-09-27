/**
 * RUNMODE-1 —— **CLI 模式默认收进「更多」**（第 186 轮）。
 *
 * 用户原话：「因为我不怎么用 CLI 模式了，把设置里的 CLI 模式隐藏吧，
 * 以后 mimo 也改成 api 模式登陆。在运行模式里加一个更多按钮，在更多里面用户可以自己选择 cli，
 * 平常不显示。」
 *
 * ## 为什么用"源码判据"而不是渲染测试
 *
 * 渲染 `SettingsPanel` 要拖进一整套 IPC / 存储 / i18n 夹具，为了三条结构断言不值当；
 * 而这件事的风险恰好是**结构性的**（按钮是不是被条件包住了），源码级判据能精确抓住。
 * ⚠️ 这不是"复刻实现来测实现"（本仓库 `repro-input-history-wrap-guard.test.ts` 就是那个毛病）：
 * 这里读的是**真实文件**，断言的是真实 JSX 结构，改坏了就会红。
 *
 * ## 三条判据对应三个必须同时成立的用户可见行为
 *
 * ① **API 模式按钮无条件可见**（它是现在的主用模式，不能被任何条件藏掉）；
 * ② **CLI 按钮被条件包住**，且条件是「展开了更多 **或** 当前就是 CLI」——
 *    少了后半句，正在用 CLI 的人打开设置只会看到"API 模式已选中"，会以为模式被改掉了；
 * ③ **有「更多」按钮**且带 `aria-expanded`（它是入口，不是第三种模式）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const panel = readFileSync(join(ROOT, "src/components/SettingsPanel.tsx"), "utf8");
const lang = readFileSync(join(ROOT, "src/core/i18n/lang.ts"), "utf8");
const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");

describe("RUNMODE-1：CLI 模式默认收进「更多」", () => {
  it("RUNMODE-1a：「更多」按钮存在、带 aria-expanded、且文案随状态切换", () => {
    expect(panel, "找不到「更多」按钮（class mode-btn--more）").toMatch(/className="mode-btn mode-btn--more"/);
    expect(panel, "「更多」必须带 aria-expanded（读屏要知道它是可展开的入口）").toMatch(/aria-expanded=\{showMoreRunModes\}/);
    expect(panel, "「更多」的文案要随状态切换（更多 / 收起）").toMatch(/S\.settings\.lessOptions\[lang\]\s*:\s*S\.settings\.moreOptions\[lang\]/);
    /* 文案本身要在 i18n 表里（不许硬编码中文） */
    for (const key of ["moreOptions", "lessOptions", "moreOptionsHint"]) {
      expect(lang, `i18n 表缺 ${key}`).toMatch(new RegExp(`${key}:\\s*\\{`));
    }
  });

  it("RUNMODE-1b：CLI 区被「展开 或 当前就是 CLI」控制，且**收起时仍在 DOM 里**", () => {
    /**
     * ⚠️ 第 186 轮中途改过一次实现，这条判据跟着改口径 —— 记下来免得下一次又走回头路：
     *   第一版写的是 `{(showMoreRunModes || settings.mode === "cli") && (<div>…)}`，
     *   也就是**整块从 DOM 里摘掉**。`settings-dead-keys.test.ts` 的 SKEY-D9-1 立刻红了 ——
     *   它按文案找「CLI 模式」按钮，而收起状态下那个按钮根本不存在。
     *   这暴露的是真问题（不是测试娇气）：**"平常不显示"不等于"入口消失"**，
     *   整块卸载会让读屏与自动化都拿不到它，正在用 CLI 的人也无从确认自己的模式。
     *   所以改成"挂载但 `display:none`"，判据也随之从"有没有被 `&&` 包住"
     *   改成"**收起类名有没有正确加上**"——后者才是现在真正的行为。
     */
    const gate = /showMoreRunModes\s*\|\|\s*settings\.mode\s*===\s*"cli"\s*\?\s*""\s*:\s*"mode-options--collapsed"/.exec(panel);
    expect(
      gate,
      'CLI 区的收起条件必须是 `showMoreRunModes || settings.mode === "cli" ? "" : "mode-options--collapsed"` —— ' +
        '只写 showMoreRunModes 会让正在用 CLI 的人打开设置时看不到自己的模式',
    ).toBeTruthy();

    /* CLI 按钮必须落在这个 div **之内**（而不是被条件整块摘掉） */
    const from = panel.indexOf('className={`mode-options mode-options--extra');
    expect(from, "找不到 CLI 区的容器").toBeGreaterThan(-1);
    const cliBtnAt = panel.indexOf("S.settings.cliMode[lang]", from);
    expect(cliBtnAt, "CLI 区的容器里找不到 CLI 模式的渲染").toBeGreaterThan(from);

    /* 收起样式必须真的存在（display:none），否则"收起"只是改了个类名而已 */
    expect(css, "缺 .mode-options--collapsed（收起必须是 display:none）").toMatch(/\.mode-options--collapsed\s*\{[^}]*display:\s*none/);
  });

  it("RUNMODE-1c：API 模式按钮**无条件**可见（它是现在的主用模式）", () => {
    /* API 按钮所在的那一段：从 `.mode-options` 开始到「更多」按钮之前，中间不该有条件包裹 */
    const start = panel.indexOf('<div className="mode-options">');
    const moreAt = panel.indexOf('className="mode-btn mode-btn--more"');
    expect(start, "找不到 .mode-options 容器").toBeGreaterThan(-1);
    expect(moreAt, "找不到「更多」按钮").toBeGreaterThan(start);
    const seg = panel.slice(start, moreAt);
    expect(seg, "API 模式按钮必须无条件渲染").toMatch(/S\.settings\.apiMode\[lang\]/);
    expect(seg, "API 模式按钮前面不该出现 `&&` 条件（它必须无条件可见）").not.toMatch(/\{showMoreRunModes/);
  });

  it("RUNMODE-1d：展开态**不持久化**（「平常不显示」靠的就是这个）", () => {
    /* 只允许 useState 初始 false；不许 setSetting / localStorage 记住它 */
    expect(panel, "showMoreRunModes 的初值必须是 false").toMatch(/useState\(false\)/);
    const decl = /const \[showMoreRunModes[^\]]*\]\s*=\s*useState\(false\)/.test(panel);
    expect(decl, "showMoreRunModes 必须是 useState(false) —— 一旦持久化就不再是「平常不显示」").toBe(true);
    const uses = [...panel.matchAll(/showMoreRunModes/g)].length;
    expect(uses, "showMoreRunModes 至少要出现 3 次（声明 / 切换 / 收起条件），当前 " + uses).toBeGreaterThanOrEqual(3);
  });

  it("RUNMODE-1e：展开区与「更多」按钮的样式在位（不然会读成同一排的第三个模式）", () => {
    expect(css, "缺 .mode-options--extra（展开区要与上一行留出间距）").toMatch(/\.mode-options--extra\s*\{[^}]*margin-top/);
    expect(css, "缺 .mode-btn--more（「更多」应当视觉次级：虚线边 + 次级文字色）").toMatch(/\.mode-btn--more\s*\{[^}]*border-style:\s*dashed/);
    expect(panel, "展开区要用 mode-options--extra").toMatch(/className=\{`mode-options mode-options--extra/);
  });
});
