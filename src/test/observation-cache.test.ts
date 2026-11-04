import { describe, expect, it } from "vitest";
import { ObservationCache } from "../core/llm/observation-cache";

describe("OBS-CACHE：只读搜索结果缓存", () => {
  it("同一键在 TTL 内命中，返回上次输出", () => {
    const cache = new ObservationCache(1_000);
    cache.set("glob::src/**", "a.ts\nb.ts", 1_000);
    expect(cache.get("glob::src/**", 1_500)?.output).toBe("a.ts\nb.ts");
  });

  it("TTL 过期后不命中，并清掉旧项", () => {
    const cache = new ObservationCache(1_000);
    cache.set("glob::x", "old", 1_000);
    expect(cache.get("glob::x", 2_001)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear 后同一键不命中（工作区写操作必须调用）", () => {
    const cache = new ObservationCache(60_000);
    cache.set("grep::TODO", "old", 1_000);
    cache.clear();
    expect(cache.get("grep::TODO", 1_001)).toBeUndefined();
  });
});
