/**
 * ★ 第 185 波（复审 R1-6）：**余额查询失败之后，⏳ 不许永真**，而且必须"如实说"。
 *
 * ## 钉的是什么
 *
 * `ContextMonitor.tsx` 的 `fetchBalances` 把 `setBalanceLoading(false)` 放在**最后一行**，
 * 且整段不在 try 里（只有 deepseek 那一小支有自己的 try/catch）。任何**非**
 * `fetchDeepSeekBalance` 的抛错（这里用"读 provider 列表时属性访问抛错"来注入，
 * 它正是 `getConfiguredProviders()` 那条路的形态）都会跳过复位，而
 * 这个 promise 无人 await ⇒ 面板**永久显示 ⏳**（旧数字还在，用户以为是最新的）。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | CMB-1 | 先成功拿到一次余额（面板正常） |
 * | CMB-2 | 之后一次刷新**抛错** ⇒ ⏳ 必须消失（`finally` 复位），且出现"刚才更新失败"的如实提示 |
 * | CMB-3 | 旧数字**继续显示**（不许因为一次失败就把余额清空） |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

/** 注入开关：`throw` 时让 provider 的 `apiKey` 属性访问抛错（非 fetch 抛错的那一类） */
const probe = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw" }));

vi.mock("../core/storage/settings", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    getSettingJSON: (key: string, fallback: unknown) => {
      if (key === "codem-settings") {
        return {
          providers: [
            probe.mode === "throw"
              ? {
                  id: "deepseek",
                  /**
                   * `name` 抛错：`getConfiguredProviders()` 自己的 try 只包住
                   * `filter`（它读的是 `apiKey` / `id`），而循环里读 `p.name`
                   * 在**它的 try 之外** —— 这正是"非 fetchDeepSeekBalance 的抛错"那条路。
                   */
                  get name(): string {
                    throw new Error("probe: provider name read failed");
                  },
                  apiKey: "sk-x",
                  baseUrl: "https://api.deepseek.com",
                }
              : { id: "deepseek", name: "DeepSeek", apiKey: "sk-x", baseUrl: "https://api.deepseek.com" },
          ],
        };
      }
      return (real.getSettingJSON as (k: string, f: unknown) => unknown)(key, fallback);
    },
  };
});

import { ContextMonitor } from "../components/ContextMonitor";

beforeEach(() => {
  probe.mode = "ok";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ balance_infos: [{ total_balance: "12.34", currency: "CNY" }] }),
  })) as never;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("R1-6：余额刷新的 loading 必须在 finally 里复位", () => {
  it("CMB-2/3: 一次刷新抛错 ⇒ ⏳ 消失 + 如实提示 + 旧数字仍在", async () => {
    const { container, rerender } = render(<ContextMonitor sessionId="s-cmb" visible={true} />);

    // CMB-1：先成功拿一次（面板上有余额）
    await waitFor(() => expect(container.textContent).toContain("12.34"), { timeout: 3000 });
    expect(container.querySelector(".context-balance-loading"), "成功之后不该还在转圈").toBeNull();

    // 让下一次刷新**抛错**（不是单家 provider 的 catch 分支，而是整段逃逸的那种）
    // 先把面板关掉（`visible=false` 时组件 return null）：这样两个 rerender 不会被
    // React 批处理成"visible 没变"，effect 才会真的重跑一次。
    rerender(<ContextMonitor sessionId="s-cmb" visible={false} />);
    await waitFor(() => expect(container.querySelector(".context-balance-section")).toBeNull());
    probe.mode = "throw";
    rerender(<ContextMonitor sessionId="s-cmb" visible={true} />);

    // CMB-2：必须如实提示"刚才更新失败"
    await waitFor(
      () => expect(screen.getByTestId("context-balance-stale")).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(
      container.querySelector(".context-balance-loading"),
      "★ 失败之后 ⏳ 必须消失（改前 setBalanceLoading(false) 被跳过 ⇒ 永久转圈）",
    ).toBeNull();

    // CMB-3：旧数字继续显示（失败不清空 —— 但必须说明它是旧的）
    expect(container.textContent, "旧余额不许被清空").toContain("12.34");
    expect(screen.getByTestId("context-balance-stale").textContent).toMatch(/刚才更新余额失败/);
  });
});
