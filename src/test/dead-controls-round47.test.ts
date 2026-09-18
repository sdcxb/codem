/**
 * 「印出来的控件必须真的能用」（第 47 轮补，UI/UX 审计 P1 的死控件那一类）
 *
 * ## 这一组守什么
 *
 * 审计点出若干"看起来能用、实际是死的"控件。它们的共同形态是：
 * **界面承诺了某件事，而代码里那个承诺没有任何实现** —— 比"这个功能不存在"更糟，
 * 因为用户会以为自己操作错了、或者以为已经生效了。
 *
 * | 组 | 缺陷（改前） |
 * | --- | --- |
 * | `DEAD-1` | 快速搜索对话框印着 `Ctrl+1…9` / `Ctrl+N` / `Ctrl+S`，而键盘处理器只认 Escape/上下/Enter |
 * | `DEAD-2` | `DecisionTray` 的"两步拒绝"（理由输入框 + 「确认拒绝」）里 `setShowRejectInput(true)` **全仓不存在** |
 * | `DEAD-3` | `MessageBubble` 的错误卡片画了"可重试"按钮，回调是空函数 |
 * | `DEAD-4` | `PanelSidebar` 的工作台 `onToggle={() => {}}` + 三个硬编码值（折叠不了、也永远没内容） |
 *
 * ## 为什么用"源码契约"而不是渲染断言
 *
 * 这几处的判据是"**有没有那一行实现**"（例如 `setShowRejectInput(true)` 是否存在、
 * 键盘处理器里有没有 `ctrlKey` 分支），而渲染断言需要把整棵应用树搭起来才能覆盖，
 * 代价与收益不对称。所以这里直接断言**实现的存在与形态**，
 * 并在注释里写明它对应哪个用户可见行为 —— 与本仓库既有的源码契约用例同一种做法。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
const readCode = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

describe("DEAD：印出来的控件必须真的能用", () => {
  it("DEAD-1: 快速搜索印的 Ctrl+数字 / Ctrl+N / Ctrl+S 都有对应处理器", () => {
    const src = readCode("src/components/SearchDialog.tsx");

    // 界面上确实印了这些徽标（前提）
    expect(src, "项目行印着 Ctrl+{n}").toMatch(/Ctrl\+\{index \+ 1\}/);
    expect(src, "操作行印着 Ctrl+N").toContain("Ctrl+N");
    expect(src, "操作行印着 Ctrl+S").toContain("Ctrl+S");

    // 而键盘处理器必须真的认它们（改前只有 Escape / ArrowUp / ArrowDown / Enter）
    expect(src, "必须处理 ctrlKey/metaKey").toMatch(/e\.ctrlKey \|\| e\.metaKey/);
    expect(src, "必须处理数字键（对应 Ctrl+1…9 徽标）").toMatch(/\^\[1-9\]\$/);
    expect(src, 'Ctrl+N 必须触发新建对话').toMatch(/lower === "n"[\s\S]{0,120}onNewSession\(\)/);
    expect(src, 'Ctrl+S 必须触发前往技能').toMatch(/lower === "s"[\s\S]{0,120}onOpenSkills\(\)/);
  });

  it("DEAD-2: DecisionTray 的两步拒绝真的会被触发（输入框不再是死代码）", () => {
    const src = readCode("src/components/DecisionTray.tsx");

    // 界面部分本来就在（输入框 + 文案随状态切换）
    expect(src).toContain("decision-tray-reject-input");
    expect(src, "按钮文案会随状态切成「确认拒绝」").toMatch(/showRejectInput \? "确认拒绝"/);

    // 关键：必须有把它设为 true 的那一步（改前全仓 0 处）
    expect(
      src,
      "必须有 setShowRejectInput(true) —— 否则理由输入框永不出现、rejectReason 永远是空串",
    ).toMatch(/setShowRejectInput\(true\)/);
    expect(src, "而且要先点在第一次、提交在第二次").toMatch(/if \(!showRejectInput\)[\s\S]{0,80}setShowRejectInput\(true\)/);
    expect(src, "提交时必须把理由带下去").toMatch(/onReject\(request\.id, rejectReason \|\| undefined\)/);
  });

  it("DEAD-3: 错误卡片不再画一个按不动的「重试」按钮", () => {
    const src = readCode("src/components/MessageBubble.tsx");
    // ErrorCard 只在 retryable && onRetry 同时成立时才画按钮
    const card = readCode("src/components/ErrorCard.tsx");
    expect(card, "前提：按钮受 retryable && onRetry 双重门控").toMatch(/retryable && onRetry/);

    // 助手错误行没有可用的重试回调 → 不许声称可重试
    expect(
      src,
      "助手错误行必须 retryable={false}（原来写着 retryable 且 onRetry 是空函数）",
    ).toMatch(/isError && !isUser[\s\S]{0,400}retryable=\{false\}/);
    expect(
      /onRetry=\{\(\) => \{[\s\S]{0,80}\}\}/.test(src),
      "不许再留空的重试回调（那会画出可点但没反应的按钮）",
    ).toBe(false);
  });

  it("DEAD-4: 工作台的折叠与文件数据都接上了真实来源", () => {
    const src = readCode("src/components/PanelSidebar.tsx");

    expect(
      /onToggle=\{\(\) => \{\}\}/.test(src),
      "不许再传空的 onToggle（那让折叠按钮成为摆设）",
    ).toBe(false);
    expect(src, "折叠要有真实状态").toContain("workbenchCollapsed");
    expect(src, "文件区块要读真实数据").toContain("FileChangeStorage.listBySession");

    // `activeTools` 仍为空：如实标注"没有响应式数据源"，而不是编一个
    expect(
      src,
      "activeTools 空数组旁边必须写明为什么（没有数据源，不编假数据）",
    ).toMatch(/activeTools=\{\[\]\}[\s\S]{0,600}|没有[\s\S]{0,40}响应式数据源/);
  });
});
