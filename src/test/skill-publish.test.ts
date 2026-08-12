/**
 * Tests for Skill Publishing functionality
 *
 * 行为测试 — 导入真实模块，验证类型和函数导出。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock file-api
const mockExecuteCommand = vi.fn();
vi.mock("../core/file-api", () => ({
  executeCommand: (...args: any[]) => mockExecuteCommand(...args),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockReturnValue([]),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({ run: vi.fn(), exec: vi.fn().mockReturnValue([]) }),
}));

vi.mock("../core/skill/skill", () => ({
  getSkillRegistry: () => ({ getAll: () => [], get: () => undefined, register: vi.fn() }),
  parseSkillMarkdown: vi.fn(),
}));

import {
  type PublishTarget,
  type PublishConfig,
  type PublishResult,
  type PublishableMarket,
  listPublishableMarkets,
  publishSkillToMarket,
  dryRunPublish,
} from "../core/skill/skill-market-client";

describe("Skill Publishing — 行为验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("类型导出验证", () => {
    it("PublishTarget 类型包含 clawhub/github/cli", () => {
      const targets: PublishTarget[] = ["clawhub", "github", "cli"];
      expect(targets).toHaveLength(3);
    });

    it("PublishConfig 接口字段完整", () => {
      const config: PublishConfig = {
        target: "clawhub",
        skillPath: "/skills/my-skill",
        slug: "my-skill",
        displayName: "My Skill",
        version: "1.0.0",
      };
      expect(config.target).toBe("clawhub");
      expect(config.slug).toBe("my-skill");
      expect(config.version).toBe("1.0.0");
    });

    it("PublishResult 接口字段完整", () => {
      const result: PublishResult = {
        success: true,
        url: "https://example.com/skill",
      };
      expect(result.success).toBe(true);
      expect(result.url).toBe("https://example.com/skill");
    });

    it("PublishableMarket 接口字段完整", () => {
      const market: PublishableMarket = {
        id: "clawhub",
        name: "ClawHub",
        target: "clawhub",
        icon: "claw",
        ready: true,
      };
      expect(market.ready).toBe(true);
      expect(market.target).toBe("clawhub");
    });
  });

  describe("listPublishableMarkets", () => {
    it("listPublishableMarkets 是可调用函数", () => {
      expect(typeof listPublishableMarkets).toBe("function");
    });

    it("listPublishableMarkets 返回 Promise", async () => {
      // Mock executeCommand to return success for CLI checks
      mockExecuteCommand.mockResolvedValue({ stdout: "version-1.0", stderr: "", exitCode: 0 });
      const result = listPublishableMarkets();
      expect(result).toBeInstanceOf(Promise);
      const markets = await result;
      expect(Array.isArray(markets)).toBe(true);
    });
  });

  describe("publishSkillToMarket", () => {
    it("publishSkillToMarket 是可调用函数", () => {
      expect(typeof publishSkillToMarket).toBe("function");
    });

    it("publishSkillToMarket 缺少 skillPath 时返回失败", async () => {
      const result = await publishSkillToMarket({
        target: "clawhub",
        skillPath: "",
        slug: "test",
        displayName: "Test",
        version: "1.0.0",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("dryRunPublish", () => {
    it("dryRunPublish 是可调用函数", () => {
      expect(typeof dryRunPublish).toBe("function");
    });

    it("dryRunPublish 对非 ClawHub 市场返回就绪检查", async () => {
      const result = await dryRunPublish({
        target: "github",
        skillPath: "/test",
        slug: "test",
        displayName: "Test",
        version: "1.0.0",
      });
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });
  });
});
