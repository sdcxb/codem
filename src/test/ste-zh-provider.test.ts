/**
 * @codem/ste-zh provider：服务面必须真的读取三态设置并返回规则段/校验。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let store: Record<string, unknown> = {};
vi.mock("../core/storage/settings", async () => ({
  ...(await import("./settings-mock")).createSettingsMock(),
  getSettingJSON: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  setSettingJSON: (key: string, value: unknown) => {
    store[key] = value;
  },
}));

import { steZhProvider } from "../core/provider/ste-zh-provider";

describe("STE-ZH provider", () => {
  beforeEach(() => {
    store = {};
  });

  it("STE-P1: apply 提供 steZh 服务，模式/规则/校验一致", () => {
    let service: any = null;
    const dispose = steZhProvider({
      provide: (name: string, value: any) => {
        expect(name).toBe("steZh");
        service = value;
        return () => {};
      },
    } as any);
    expect(service).toBeTruthy();
    expect(service.mode()).toBe("off");
    expect(service.section()).toBe("");
    service.setMode("smart");
    expect(service.mode()).toBe("smart");
    expect(service.section({ userMessage: "改一下颜色" })).toContain("STE-ZH 精简");
    expect(service.validate("已验证", [])).toHaveLength(1);
    if (typeof dispose === "function") dispose();
  });
});
