/**
 * @codem/ste-zh provider：服务面必须真的读取设置并返回规则段。
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

  it("STE-P1: apply 提供 steZh 服务，启停与规则段一致", () => {
    let service: any = null;
    const dispose = steZhProvider({
      provide: (name: string, value: any) => {
        expect(name).toBe("steZh");
        service = value;
        return () => {};
      },
    } as any);
    expect(service).toBeTruthy();
    expect(service.enabled()).toBe(false);
    expect(service.section()).toBe("");
    service.setEnabled(true);
    expect(service.enabled()).toBe(true);
    expect(service.section()).toContain("汇报规范（STE-ZH");
    if (typeof dispose === "function") dispose();
  });
});
