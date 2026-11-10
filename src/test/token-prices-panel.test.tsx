/**
 * 设置页价格行：**增删 provider/model/四价 + 货币符号**（GCOST-SET-1..4）
 *
 * 价格表本身由 `token-prices.test.ts` 钉住；本文件钉「用户在设置里怎么配」：
 *
 * | id | 钉什么 | 变异（改坏）怎么红 |
 * |---|---|---|
 * | GCOST-SET-1 | 增行并填 provider/model/四价 ⇒ 真的写进 codem-context-config.tokenPrices | 只改 state 不落库 ⇒ 红 |
 * | GCOST-SET-2 | 货币符号写到 tokenPriceCurrency | 写死 $ / 不落库 ⇒ 红 |
 * | GCOST-SET-3 | 删行 ⇒ 对应 key 从价格表消失；删光 ⇒ 两个字段都清掉 | 只从界面移除 ⇒ 红 |
 * | GCOST-SET-4 | 未填完 / 非法价格不落库（不按 0 补） | 空值按 0 写入 ⇒ 红 |
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TokenPricesPanel } from "../components/TokenPricesPanel";
import { getSettingJSON } from "../core/storage/settings";

function readConfig(): Record<string, any> | null {
  return getSettingJSON<Record<string, any> | null>("codem-context-config", null);
}

function fill(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

afterEach(() => {
  cleanup();
});

describe("设置 · 群聊成本价格表", () => {
  it("GCOST-SET-1：增行 + 四价 ⇒ 写入 codem-context-config.tokenPrices", () => {
    render(<TokenPricesPanel />);
    expect(screen.getByTestId("token-price-empty")).toBeTruthy();

    fireEvent.click(screen.getByTestId("token-price-add"));
    fill("token-price-provider", "prov-a");
    fill("token-price-model", "model-a");
    fill("token-price-input", "3");
    fill("token-price-output", "15");
    fill("token-price-cache-read", "0.3");
    fill("token-price-cache-write", "3.75");

    const config = readConfig();
    expect(config?.tokenPrices).toEqual({
      "prov-a/model-a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(config?.tokenPriceCurrency).toBe("$");
    expect(screen.getByTestId("token-price-status").getAttribute("data-save-state")).toBe("saved");
  });

  it("GCOST-SET-2：货币符号可配并落库；缺 provider 时用裸 model 作 key", () => {
    render(<TokenPricesPanel />);
    fireEvent.click(screen.getByTestId("token-price-add"));
    /* provider 留空 */
    fill("token-price-model", "model-only");
    fill("token-price-input", "1");
    fill("token-price-output", "2");
    fill("token-price-currency", "¥");

    const config = readConfig();
    expect(config?.tokenPrices).toEqual({ "model-only": { input: 1, output: 2 } });
    expect(config?.tokenPriceCurrency).toBe("¥");
  });

  it("GCOST-SET-3：删行 ⇒ key 消失；删光 ⇒ tokenPrices / tokenPriceCurrency 都清掉", () => {
    render(<TokenPricesPanel />);
    fireEvent.click(screen.getByTestId("token-price-add"));
    fill("token-price-model", "model-a");
    fill("token-price-input", "1");
    fill("token-price-output", "2");
    expect(readConfig()?.tokenPrices).toEqual({ "model-a": { input: 1, output: 2 } });

    fireEvent.click(screen.getByTestId("token-price-remove"));
    const config = readConfig();
    expect(config?.tokenPrices).toBeUndefined();
    expect(config?.tokenPriceCurrency).toBeUndefined();
    expect(screen.getByTestId("token-price-empty")).toBeTruthy();
  });

  it("GCOST-SET-4：未填完 / 非法价格不落库（不按 0 补）", () => {
    render(<TokenPricesPanel />);
    fireEvent.click(screen.getByTestId("token-price-add"));

    /* 只有 model：不能写成 0 价 */
    fill("token-price-model", "model-a");
    expect(readConfig()?.tokenPrices, "没有输入/输出价时不得落库").toBeUndefined();

    /* 只有输入、没有输出：仍不落库 */
    fill("token-price-input", "1");
    expect(readConfig()?.tokenPrices).toBeUndefined();
    expect(screen.getByTestId("token-price-summary").textContent).toContain("还没填完");

    /* 负数 / 非数字不是价格；先填 output 再修 input */
    fill("token-price-input", "-3");
    fill("token-price-output", "2");
    expect(readConfig()?.tokenPrices, "负价不得落库，更不得按 0 处理").toBeUndefined();

    fill("token-price-input", "1.5");
    expect(readConfig()?.tokenPrices).toEqual({ "model-a": { input: 1.5, output: 2 } });
  });

  it("重新挂载后从设置读回（不是只存在内存 state）", () => {
    const first = render(<TokenPricesPanel />);
    fireEvent.click(screen.getByTestId("token-price-add"));
    fill("token-price-model", "model-a");
    fill("token-price-input", "4");
    fill("token-price-output", "8");
    first.unmount();

    render(<TokenPricesPanel />);
    expect((screen.getByTestId("token-price-model") as HTMLInputElement).value).toBe("model-a");
    expect((screen.getByTestId("token-price-input") as HTMLInputElement).value).toBe("4");
    expect((screen.getByTestId("token-price-output") as HTMLInputElement).value).toBe("8");
  });
});
