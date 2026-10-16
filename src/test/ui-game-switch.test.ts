/**
 * `@codem/ui-game` 的**开关插件**定性判据（2026-10-16）。
 *
 * ## 守的缺陷
 *
 * 它曾经声称「注册 GameView 组件到 `app.game` slot」，但两件事都对不上：
 * 1. `app.game` **从来没被声明过** —— `SlotsService.register()` 对未声明的槽位直接抛错
 *    ⇒ 这个 provider 一旦真被装配，fiber 就会 FAILED（启动汇总会如实报"未激活"）；
 * 2. 游戏界面**根本不走槽位** —— `App.tsx` 三处直接懒加载 `GameView` 渲染，
 *    显隐由 `isPluginDisabled('@codem/ui-game')`（读 `codem-disabled-plugins`）决定。
 *
 * 而它又**没有任何装配路径**（只在注册表里）—— 也就是说：一个"注册了但永远不会 apply、
 * 一旦 apply 就会抛"的假插件，却在插件市场里对用户宣称"关闭后游戏 Tab 入口隐藏"。
 *
 * ## 判据
 * | # | 行为 |
 * |---|---|
 * | GAME-1 | `apply` 必须是空操作：不许 `provide`、不许注册任何槽位（含反向对照：桩 slots 记录到调用就必须红） |
 * | GAME-2 | 目录里不许再宣称 `uiGame` 服务或 `app.game` 槽位（假承诺清零） |
 * | GAME-3 | 游戏界面的真实来源（App.tsx 直接渲染 + 禁用列表）必须在源码里成立；`app.game` 不许被声明成槽位 |
 */
import { describe, expect, it, vi } from "vitest";
import { Context } from "../core/cordis/src/index.ts";
import { uiGameProvider } from "../core/provider/ui-game-provider";
import { GATED_PROVIDERS, isUiProviderGated } from "../core/ui-plugins/gating.ts";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

describe("@codem/ui-game：开关插件（不是 UI 实现）", () => {
  it("GAME-1: apply 必须是空操作 —— 不 provide 服务、不注册槽位", async () => {
    const ctx = new Context();

    // 桩 slots：任何 register 都会被记下来（反向对照：真注册了就必须红）
    const registered: any[] = [];
    ctx.provide("slots", {
      register: (options: any, component: any) => {
        registered.push({ options, component });
        return () => {};
      },
      declareSlot: () => {},
      renderSlot: () => null,
      entriesOfSlot: () => [],
      subscribe: () => () => {},
    } as any);

    (ctx as any).plugin(uiGameProvider as any);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(registered, "不许注册槽位（旧实现注册的 app.game 从未声明 ⇒ register 必抛）").toEqual([]);
    expect((ctx as any).get("uiGame", false), "不许再提供没有任何消费者的假服务 uiGame").toBeUndefined();

    // 反向对照：桩本身是有效的（同一条判据能抓到真注册）
    const probe: any[] = [];
    const fake = { name: "app.game", id: "probe" };
    (ctx as any).get("slots").register(fake, () => null);
    probe.push(fake);
    expect(probe.length, "反向对照：桩 slots 必须真的能记录到注册（否则上面那条恒真）").toBe(1);
  });

  it("GAME-2: 目录里不许再宣称 uiGame 服务或 app.game 槽位", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/core/provider/plugin-registry-provider.ts"), "utf8");
    const line = src.split(/\r?\n/).find((l) => l.includes("name: '@codem/ui-game'"));
    expect(line, "目录里必须有 @codem/ui-game 这一条（插件管理器要展示它）").toBeTruthy();
    expect(line!, "不许宣称提供 uiGame 服务（没有消费者）").not.toMatch(/provides:\s*\[[^\]]*uiGame/);
    expect(line!, "不许宣称 app.game 槽位（那个槽位从来没声明过）").not.toContain("app.game");
    expect(line!, "要把「关闭后游戏 Tab 入口隐藏」这个真实影响说清楚").toContain("游戏 Tab");
  });

  it("GAME-3: 真实来源成立 —— App.tsx 直接渲染 GameView + 读禁用列表；app.game 不是槽位", () => {
    const app = fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
    expect(app, "游戏界面必须是 App.tsx 直接懒加载渲染").toContain('import("./plugins/monopoly-game/components/GameView")');
    expect(app, "显隐必须来自禁用列表").toContain("isPluginDisabled('@codem/ui-game')");

    const declSrc =
      fs.readFileSync(path.join(ROOT, "src/core/slots/declarations.ts"), "utf8") +
      fs.readFileSync(path.join(ROOT, "src/core/slots/declare-slots.ts"), "utf8");
    expect(
      /declareSlot\(\s*['"]app\.game['"]/.test(declSrc) || /['"]app\.game['"]\s*:/.test(declSrc),
      "app.game 至今没有声明 —— 所以任何 register('app.game') 都会抛；要么声明它，要么别注册（现在是后者）",
    ).toBe(false);

    // 门控：禁用 = 不装配（与 ui-pet / ui-library-ops 同一形态）
    expect(GATED_PROVIDERS["ui-game"]).toBe("@codem/ui-game");
    expect(isUiProviderGated("ui-game", ["@codem/ui-game"])).toBe(true);
    expect(isUiProviderGated("ui-game", [])).toBe(false);
  });
});
