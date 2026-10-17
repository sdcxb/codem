/**
 * NARROW：工具卡与设置行的**窄容器自适应**（`@container`）。
 *
 * ## 为什么要有这条（对标 + 我们的真实事故）
 *
 * 对标项目（open-claude-ui）把"窄容器"当一等公民：命名容器 + 四阶断点 + 极端防挤压。
 * 我们 `grep @container` 长期是 0，而两次真实事故都是同一类型：`@` 提及候选被 240px
 * 裁到只剩 9px、设置窗塌成 160px 窄条。
 *
 * ## 量的是真渲染（不是"类名在不在"）
 *
 * 探针 `fixtures/narrow-containers-probe.html` 加载**真实 CSS**，把工具卡与设置行放进
 * 320/384/480/576/760 五档宽度的容器里，取 `scrollWidth/clientWidth`、`flex-direction`、
 * `flex-wrap` 与控件实际宽度。断言：
 *
 * - `NARROW-1`：窄档 IN/OUT 段改成竖排（宽档仍横排）；
 * - `NARROW-2/3`：窄档设置行换行、输入框拿到可用宽度、容器不溢出；宽档仍是单行。
 *
 * 注：长 token 的 `overflow-wrap: anywhere` 仍然保留在样式里（防路径/JSON/base64 撑破），
 * 但**没有**对应的判据 —— 实测 `white-space: pre-wrap` 在 Chromium 里已经会为超长单词折行，
 * 那条规则写不写这里都绿，做成判据就是恒真判据（变异自证抓到了这一点，所以没留）。
 *
 * 变异：去掉 `.tool-card` 的 `container-type` ⇒ 1 红；去掉 `.settings-content`
 * 的 `container-type` ⇒ 2/3 红。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { findChromiumBrowser, readFixtureProbes } from "./helpers/browser-probe";

const ROOT = join(__dirname, "..", "..");
const FIXTURE = join(ROOT, "src", "test", "fixtures", "narrow-containers-probe.html");
const BROWSER = findChromiumBrowser();

interface ToolRow {
  width: number;
  cardScroll: number;
  cardClient: number;
  headScroll: number;
  headClient: number;
  headFlexWrap: string;
  ioFlexDirection: string;
  textScroll: number;
  textClient: number;
}
interface SettingsRow {
  width: number;
  containerWidth: number;
  rowFlexWrap: string;
  contentScroll: number;
  contentClient: number;
  groupInputWidth: number;
  rowInputWidth: number;
}
interface ProbeResult {
  widths: number[];
  tool: ToolRow[];
  settings: SettingsRow[];
}

describe.skipIf(!BROWSER)("窄容器自适应（@container）", () => {
  let probe!: ProbeResult;

  beforeAll(async () => {
    if (!BROWSER) return;
    const [raw] = await readFixtureProbes<ProbeResult>(
      [{ fixture: FIXTURE, viewport: [1100, 900], timeoutMs: 30_000 }],
      BROWSER,
    );
    probe = raw;
  }, 90_000);

  const narrowWidths = [320, 384];
  const wideWidth = 760;

  it("NARROW-1: 窄档 IN/OUT 段改成竖排（宽档仍是横排）", () => {
    for (const r of probe.tool.filter((x) => narrowWidths.includes(x.width))) {
      expect(r.ioFlexDirection, `${r.width}px 的工具输出段应当竖排（否则标签吃掉正文宽度）`).toBe("column");
    }
    const wide = probe.tool.find((r) => r.width === wideWidth)!;
    expect(wide.ioFlexDirection, "宽档应当保持横排（改动不许把正常布局也翻掉）").toBe("row");
  });

  it("NARROW-2: 窄档设置行换行且容器不溢出", () => {
    for (const r of probe.settings.filter((x) => x.width <= 480)) {
      expect(r.rowFlexWrap, `${r.width}px 的设置行应当允许换行`).toBe("wrap");
      expect(r.contentScroll, `${r.width}px 的设置内容不得横向溢出`).toBeLessThanOrEqual(r.contentClient + 1);
    }
    const wide = probe.settings.find((r) => r.width === wideWidth)!;
    expect(wide.rowFlexWrap, "宽档设置行不该无谓换行").toBe("nowrap");
  });

  it("NARROW-3: 窄档输入框拿到可用宽度（不被按钮挤成一条）", () => {
    for (const r of probe.settings.filter((x) => x.width <= 480)) {
      const groupRatio = r.groupInputWidth / r.containerWidth;
      expect(groupRatio, `${r.width}px 下 setting-group 输入框只有 ${r.groupInputWidth}px（容器 ${r.containerWidth}px）`).toBeGreaterThan(0.8);
      const rowRatio = r.rowInputWidth / r.containerWidth;
      expect(rowRatio, `${r.width}px 下 sp-row 输入框只有 ${r.rowInputWidth}px（容器 ${r.containerWidth}px）`).toBeGreaterThan(0.5);
    }
  });
});
