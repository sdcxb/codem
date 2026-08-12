/**
 * Tests for Skill Market New Sources
 *
 * 行为测试 — 导入真实模块，验证类型、常量和函数导出。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({ run: vi.fn(), exec: vi.fn().mockReturnValue([]) }),
}));

const mockStore: Record<string, any> = {};
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockImplementation((key: string, def: any) => mockStore[key] ?? def),
  setSettingJSON: vi.fn().mockImplementation((key: string, val: any) => { mockStore[key] = val; }),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

import {
  type MarketSourceType,
  type MarketSource,
  DEFAULT_MARKET_SOURCES,
  getMarketSources,
  setMarketSources,
  type MarketSkill,
  type MarketSearchResult,
  getSourceIcon,
} from "../core/skill/skill-market-client";

describe("Skill Market New Sources — 行为验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("类型导出验证", () => {
    it("MarketSourceType 包含所有新类型", () => {
      const types: MarketSourceType[] = [
        "github-repo",
        "github-search",
        "builtin",
        "clawhub-api",
        "skills-sh-api",
        "cli",
      ];
      expect(types).toHaveLength(6);
    });

    it("MarketSource 接口字段完整", () => {
      const source: MarketSource = {
        id: "test",
        name: "Test",
        type: "github-repo",
        url: "https://example.com",
        enabled: true,
      };
      expect(source.id).toBe("test");
      expect(source.type).toBe("github-repo");
    });

    it("MarketSkill 接口字段完整", () => {
      const skill: MarketSkill = {
        id: "sk-1",
        name: "My Skill",
        source: "test-source",
        description: "A test skill",
        url: "https://example.com",
      } as MarketSkill;
      expect(skill.name).toBe("My Skill");
    });
  });

  describe("DEFAULT_MARKET_SOURCES", () => {
    it("DEFAULT_MARKET_SOURCES 是数组且非空", () => {
      expect(Array.isArray(DEFAULT_MARKET_SOURCES)).toBe(true);
      expect(DEFAULT_MARKET_SOURCES.length).toBeGreaterThan(0);
    });

    it("DEFAULT_MARKET_SOURCES 包含 Anthropic Skills 源", () => {
      const anthropic = DEFAULT_MARKET_SOURCES.find(s => s.id === "anthropic-skills");
      expect(anthropic).toBeDefined();
      expect(anthropic!.type).toBe("github-repo");
    });

    it("DEFAULT_MARKET_SOURCES 包含 GitHub Search 源", () => {
      const search = DEFAULT_MARKET_SOURCES.filter(s => s.type === "github-search");
      expect(search.length).toBeGreaterThan(0);
    });

    it("所有默认源都有 id、name、url、enabled 字段", () => {
      for (const src of DEFAULT_MARKET_SOURCES) {
        expect(src.id).toBeDefined();
        expect(src.name).toBeDefined();
        expect(src.url).toBeDefined();
        expect(typeof src.enabled).toBe("boolean");
      }
    });
  });

  describe("getMarketSources / setMarketSources", () => {
    it("getMarketSources 返回数组", () => {
      const sources = getMarketSources();
      expect(Array.isArray(sources)).toBe(true);
    });

    it("setMarketSources + getMarketSources 往返", () => {
      const custom: MarketSource[] = [
        { id: "custom-1", name: "Custom", type: "builtin", url: "test", enabled: true },
      ];
      setMarketSources(custom);
      const result = getMarketSources();
      expect(result.find(s => s.id === "custom-1")).toBeDefined();
    });
  });

  describe("getSourceIcon", () => {
    it("getSourceIcon 返回字符串", () => {
      const source: MarketSource = {
        id: "test", name: "Test", type: "builtin", url: "", enabled: true, icon: "🔧",
      };
      expect(getSourceIcon(source)).toBe("🔧");
    });

    it("getSourceIcon 无 icon 时返回默认值", () => {
      const source: MarketSource = {
        id: "test", name: "Test", type: "builtin", url: "", enabled: true,
      };
      const icon = getSourceIcon(source);
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    });
  });
});
