/**
 * 启动屏**不许在"已就绪"之后继续吃点击**（第 233 轮审计 · P2 冷启动）。
 *
 * ## 缺陷形态
 *
 * `.boot-splash` 是 `position: fixed; inset: 0` 的全屏遮罩，只有 `.fading-out`
 * 才 `pointer-events: none`。而"就绪 → 渐隐"之间有 300ms 停顿 + 400ms 过渡
 * ⇒ 应用其实已经可用，用户的第一次点击却落在**盖住的启动屏**上（约 700ms 白点）。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SPLASH-1 | `ready` 状态必须放行点击（CSS 契约里 `.boot-splash.ready` 有 `pointer-events: none`） |
 * | SPLASH-2 | 就绪到完全隐藏的总时长 ≤ 600ms（原 300 + 400 = 700ms） |
 * | SPLASH-3（反向对照）| 未就绪（`initializing`）时遮罩仍必须**盖住**（不许提前放行点击） |
 *
 * 变异自证：删掉 `.boot-splash.ready` 的 `pointer-events` ⇒ SPLASH-1 红；
 * 把 120ms 改回 300ms ⇒ SPLASH-2 红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, act } from "@testing-library/react";
import { BootSplash } from "../components/BootSplash";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src/styles/codem-ui.css"), "utf8");

describe("启动屏：就绪之后必须放行点击", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("SPLASH-1: `.boot-splash.ready` 必须 `pointer-events: none`", () => {
    // 取出 ready 那条规则体（跨行），断言它确实放行点击
    const match = css.match(/\.boot-splash\.ready\s*\{([^}]*)\}/);
    expect(match, "缺少 `.boot-splash.ready` 规则（就绪后仍会吃掉用户的第一次点击）").toBeTruthy();
    expect(match![1], "就绪后必须放行点击").toMatch(/pointer-events:\s*none/);
    // 反向对照：未就绪的基础规则**不许**放行（否则启动屏形同不存在）
    const base = css.match(/\.boot-splash\s*\{([^}]*)\}/);
    expect(base).toBeTruthy();
    expect(base![1], "基础态不许放行点击").not.toMatch(/pointer-events:\s*none/);
  });

  it("SPLASH-2: 就绪 → 完全隐藏 ≤ 600ms（原 300 + 400 = 700ms）", async () => {
    const onComplete = vi.fn();
    render(<BootSplash visible phase="ready" onComplete={onComplete} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    expect(onComplete, "520ms 内必须已经收尾（否则用户还要多等一段白屏）").toHaveBeenCalledTimes(1);
  });

  it("SPLASH-3（反向对照）: 未就绪时遮罩仍在", () => {
    const { container } = render(<BootSplash visible phase="initializing" />);
    const root = container.querySelector(".boot-splash");
    expect(root, "未就绪必须显示启动屏").toBeTruthy();
    expect(root!.className, "未就绪不许带 ready 类（带了就提前放行点击）").not.toContain("ready");
  });
});
