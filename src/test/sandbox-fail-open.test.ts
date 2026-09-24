/**
 * 沙箱开关：**读不到设置时不许静默失效**（第 87 轮）
 *
 * ## 为什么
 *
 * `isSandboxAclEnabled()` 原来在 `getSetting` 抛错时 `return false` + 一句 `console.warn`：
 * 也就是说**用户明确打开的沙箱，在一次读取失败后会静默失效**，而设置面板上的开关**仍然显示"已开启"**。
 * 这与第 86 轮修的洞（`hasUncommittedChanges` 失败被当成"工作区干净"）是同一类：
 * **问不到 ≠ 用户关掉了**。
 *
 * 这条扫描（`tools/audit/scan-fail-open-guards.mjs`）当时报了 15 处"检查失败 ⇒ 返回否定值"，
 * 逐个看下来只有它是**安全开关 + fail-open**（其余多是能力探测：失败 ⇒ "没有这个能力"，属保守方向）。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | SBX-1 | 读成功 ⇒ 返回真实值，并记住它 |
 * | SBX-2 | 之后读失败 ⇒ **沿用上次成功读到的值**（不许因为一次失败就把"开启"变成"关闭"） |
 * | SBX-3 | 从没读到过就失败 ⇒ 返回 false（产品默认），但**必须上报**（用户可见），不许只 warn |
 * | SBX-4 | 结构：catch 里不许只剩 console.warn —— 必须有上报 |
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn(), removeSetting: vi.fn() }));

vi.mock("../core/storage/settings", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
  removeSetting: mocks.removeSetting,
}));

import { isSandboxAclEnabled, __resetSandboxSettingCache, SANDBOX_SETTING_KEY } from "../core/sandbox/sandbox-acl";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

beforeEach(() => {
  __resetSandboxSettingCache();
  resetPersistFailures();
  mocks.getSetting.mockReset();
});

describe("沙箱开关读不到时不许静默失效（第 87 轮）", () => {
  it("SBX-1/2: 读成功后失败 ⇒ 沿用上次的值（开启不会因为一次失败变成关闭）", () => {
    mocks.getSetting.mockReturnValueOnce("true");
    expect(isSandboxAclEnabled(), "读成功 ⇒ true").toBe(true);

    mocks.getSetting.mockImplementationOnce(() => {
      throw new Error("设置镜像未就绪");
    });
    expect(isSandboxAclEnabled(), "一次读失败不许把「开启」降级成「关闭」").toBe(true);
    expect(
      getPersistFailures().map((f) => f.area),
      "而且要让用户看见（横幅），不能只在控制台 warn",
    ).toContain("sandbox.readSetting");

    // 反向：上次读到的是关闭 ⇒ 失败后仍然是关闭
    __resetSandboxSettingCache();
    resetPersistFailures();
    mocks.getSetting.mockReturnValueOnce("false");
    expect(isSandboxAclEnabled()).toBe(false);
    mocks.getSetting.mockImplementationOnce(() => {
      throw new Error("又失败了");
    });
    expect(isSandboxAclEnabled(), "沿用上次的「关闭」").toBe(false);
  });

  it("SBX-3: 从没读到过就失败 ⇒ 按默认关闭，但必须上报", () => {
    mocks.getSetting.mockImplementationOnce(() => {
      throw new Error("首次读取就失败");
    });
    expect(isSandboxAclEnabled(), "没有历史值 ⇒ 产品默认（关闭）").toBe(false);
    const f = getPersistFailures();
    expect(f.map((x) => x.area)).toContain("sandbox.readSetting");
    expect(f[0].kind, "这是动作失败（开关这次没被确认），不是写盘失败").toBe("action");
  });

  it("SBX-4: 结构 —— catch 里必须有上报（不许只剩 console.warn）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs
      .readFileSync(path.join(process.cwd(), "src/core/sandbox/sandbox-acl.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    const start = src.indexOf("export function isSandboxAclEnabled");
    const body = src.slice(start, src.indexOf("export function", start + 10));
    expect(body, "catch 里必须上报").toContain("reportActionFailure");
    expect(body, "不许只 console.warn 了事").not.toMatch(/catch[\s\S]*?console\.warn[\s\S]*?return false;\s*\}/);
    expect(body, "要记住上次成功读到的值").toMatch(/lastKnownSandboxEnabled\s*=/);
    expect(SANDBOX_SETTING_KEY, "用的还是面板那个键").toBe("codem-sandbox-enabled");
  });
});
